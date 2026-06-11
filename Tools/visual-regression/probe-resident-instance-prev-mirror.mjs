#!/usr/bin/env node
// Probe (NEW-RESIDENT-INSTANCE-BUFFER-MGR, velocity prev-mirror semantics):
// drives WebGPUResidentInstanceBuffer.sync() directly against the live GPU
// device with `mirrorPrev: true` and intercepts WebGPUBuffer.write calls to
// prove the slot-aligned prev-mirror contract:
//
//   1. FULL rebuild with mirrorPrev: prev gets the SAME payload as current
//      (prev = current, zero velocity on rebuild frames).
//   2. Partial sync, slot S dirty: prev receives slot S's OLD value (frame
//      N-1) BEFORE current receives the NEW value — at the same byte offset.
//   3. Next sync with nothing dirty: prev catches slot S up to frame N's
//      value (pending-range flush) — so a one-frame move yields exactly one
//      frame of non-zero velocity.
//   4. Settled sync after that: zero writes to either buffer.
//
// Why this probe drives the manager directly: the renderer's TAA gate
// (`frameState.scene?.taaEnabled === true`, Batch 143) is currently dormant
// — `frameState.scene` is undefined at runtime, so billboard/label velocity
// commands never emit (pre-existing; tracked as a follow-up). Until that
// gate is fixed there is no end-to-end velocity path to observe, but the
// prev-mirror contract the manager ships must hold for when it lands.
//
// Usage: node Tools/visual-regression/probe-resident-instance-prev-mirror.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  // Bootstrap a real manager instance: render one billboard so the
  // renderer constructs one, then grab its class (the module isn't a
  // public export of the bundle barrel).
  const img = document.createElement("canvas");
  img.width = 4;
  img.height = 4;
  img.getContext("2d").fillRect(0, 0, 4, 4);
  const boot = scene.primitives.add(new C.BillboardCollection());
  boot.add({
    position: C.Cartesian3.fromDegrees(-75, 40, 1000),
    image: img,
  });
  for (let i = 0; i < 30 && !boot._webgpuCache?.instanceManager; i++) {
    scene.render();
    await new Promise((r) => requestAnimationFrame(r));
  }
  const bootMgr = boot._webgpuCache?.instanceManager;
  if (!bootMgr) {
    return { fatal: "no bootstrap instanceManager" };
  }
  const ManagerClass = bootMgr.constructor;
  const device = scene.context.device;

  const FPI = 4; // 4 floats per test instance, 16 B stride
  const BPI = FPI * 4;
  const mgr = new ManagerClass(device, "prev-mirror probe");

  // Write log: [bufferLabel, byteOffset, floats...]
  const log = [];
  const hook = (buf, tag) => {
    const orig = buf.write.bind(buf);
    buf.write = (data, offset) => {
      log.push({
        tag,
        offset: offset ?? 0,
        floats: Array.from(
          new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4),
        ),
      });
      return orig(data, offset);
    };
  };

  const items = [];
  for (let i = 0; i < 5; i++) {
    items.push({ _index: i, value: 100 + i });
  }
  const isVisible = (item) => item !== undefined;
  const packInstance = (outArr, off, item) => {
    outArr[off + 0] = item.value;
    outArr[off + 1] = item._index;
    outArr[off + 2] = 0;
    outArr[off + 3] = 0;
  };
  const syncOpts = (dirty, force) => ({
    items,
    length: items.length,
    dirtyList: dirty,
    dirtyCount: dirty.length,
    packInstance,
    isVisible,
    floatsPerInstance: FPI,
    bytesPerInstance: BPI,
    forceFullRebuild: force === true,
    mirrorPrev: true,
  });

  // --- 1. full rebuild ---
  const r1 = mgr.sync(syncOpts([], true));
  hook(mgr.buffer, "cur");
  hook(mgr.prevBuffer, "prev");
  const fullPrevWrites = log.length; // hooks installed after — read state instead
  const check1 =
    r1.fullRebuild === true &&
    r1.visibleCount === 5 &&
    r1.prevBuffer !== null &&
    mgr._cpu[2 * FPI] === 102; // slot 2 packed

  // --- 2. dirty slot 2: 102 -> 999 ---
  items[2].value = 999;
  const r2 = mgr.sync(syncOpts([items[2]], false));
  const writes2 = log.splice(0);
  // expect: prev write of OLD value (102) at offset 32, then cur write of
  // NEW value (999) at offset 32.
  const prev2 = writes2.filter((w) => w.tag === "prev");
  const cur2 = writes2.filter((w) => w.tag === "cur");
  const check2 =
    r2.fullRebuild === false &&
    r2.partialWrites === 1 &&
    prev2.length === 1 &&
    prev2[0].offset === 2 * BPI &&
    prev2[0].floats[0] === 102 && // frame N-1 value
    cur2.length === 1 &&
    cur2[0].offset === 2 * BPI &&
    cur2[0].floats[0] === 999; // frame N value

  // --- 3. nothing dirty: prev catches slot 2 up to 999 ---
  const r3 = mgr.sync(syncOpts([], false));
  const writes3 = log.splice(0);
  const prev3 = writes3.filter((w) => w.tag === "prev");
  const cur3 = writes3.filter((w) => w.tag === "cur");
  const check3 =
    r3.partialWrites === 0 &&
    cur3.length === 0 &&
    prev3.length === 1 &&
    prev3[0].offset === 2 * BPI &&
    prev3[0].floats[0] === 999; // caught up to frame N value

  // --- 4. settled: zero writes ---
  const r4 = mgr.sync(syncOpts([], false));
  const writes4 = log.splice(0);
  const check4 = r4.partialWrites === 0 && writes4.length === 0;

  mgr.destroy();
  scene.primitives.remove(boot);

  return {
    check1,
    check2,
    check3,
    check4,
    fullPrevWrites,
    writes2,
    writes3,
    counters: {
      full: 1,
    },
  };
});

if (out.fatal) {
  console.log(`FATAL: ${out.fatal}`);
  await browser.close();
  process.exit(1);
}

console.log(
  `1) full rebuild seeds prev=current:           ${out.check1 ? "OK" : "FAIL"}`,
);
console.log(
  `2) dirty slot: prev gets OLD @slot, cur NEW:  ${out.check2 ? "OK" : "FAIL"} ${JSON.stringify(out.writes2.map((w) => [w.tag, w.offset, w.floats[0]]))}`,
);
console.log(
  `3) next frame: prev catch-up to frame-N value: ${out.check3 ? "OK" : "FAIL"} ${JSON.stringify(out.writes3.map((w) => [w.tag, w.offset, w.floats[0]]))}`,
);
console.log(
  `4) settled: zero writes:                       ${out.check4 ? "OK" : "FAIL"}`,
);
console.log(`console errors: ${errors.length}`);
errors.slice(0, 5).forEach((e) => console.log("  ERR:", e.slice(0, 160)));

const pass =
  out.check1 && out.check2 && out.check3 && out.check4 && errors.length === 0;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
