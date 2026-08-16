#!/usr/bin/env node
// Probe (NEW-RESIDENT-INSTANCE-BUFFER-MGR + NEW-PARTIAL-WRITE-WIRE-BPL verify):
// @purpose Acceptance for resident-instance partial writes: 0 uploads settled, ~1-stride write on one move, moved billboard renders at its new position.
// @status ACTIVE
//
// the billboard renderer's resident-instance partial-write path must
//   (A) upload NOTHING for a settled 1000-billboard collection
//       (0 full rebuilds AND 0 partial writes over 30 static frames),
//   (B) on moving ONE billboard, issue >=1 partial write totalling ~1
//       instance stride (176 B) — NOT a full rebuild, NOT N x stride,
//   (C) still render the billboards (magenta pixel count over threshold),
//   (D) render the moved billboard at its NEW screen position (the mover is
//       cyan; a window around scene.cartesianToCanvasCoordinates(newPos)
//       must contain cyan after the move and none before),
//   (E) produce zero console errors.
//
// Counters read from collection._webgpuCache.instanceManager
// (_fullRebuilds / _partialWrites / _bytesUploaded — debug-pragma
// instrumentation, present in CesiumUnminified).
//
// GEOMETRY NOTE (historical depth-precision envelope): the camera sits ~8 km
// above the billboards. When this probe was written the WebGPU globe +
// collection pipelines wrote standard hyperbolic NDC depth (WebGL used czm
// log depth) — RESOLVED Batches 249-251 (NEW-COLLECTIONS-LOG-DEPTH): log
// depth is live by default and probe-collections-far-camera.mjs covers the
// 220 km envelope. The ~8 km camera here is kept for the probe's original
// purpose (partial-write upload accounting, not depth range). At 220 km a
// 1000 m billboard-above-ground separation is ~0.03 depth-quantization
// steps (0.1*1000/220000^2 vs 2^-24) — an unresolvable tie, and the moved
// billboard loses it on some tiles REGARDLESS of upload strategy (verified:
// a forced full rebuild reproduces the disappearance; WebGL renders it).
// At ~8 km range the same separation is ~30 quantization steps —
// deterministic. Tracked as the collection log-depth parity gap
// (NEW-COLLECTIONS-LOG-DEPTH); revisit this scenario when that lands.
//
// Usage: node Tools/visual-regression/probe-billboard-partial-write.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const STRIDE = 176; // FLOATS_PER_INSTANCE (44) * 4

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
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
  v.clock.shouldAnimate = false;

  const frame = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const grab = () => {
    const c = scene.canvas;
    const off = document.createElement("canvas");
    off.width = c.width;
    off.height = c.height;
    const cx = off.getContext("2d");
    cx.drawImage(c, 0, 0);
    return {
      data: cx.getImageData(0, 0, c.width, c.height).data,
      w: c.width,
      h: c.height,
    };
  };
  const isMagenta = (d, i) => d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 90;
  const isCyan = (d, i) => d[i + 1] > 180 && d[i + 2] > 180 && d[i] < 90;
  const countIn = (img, pred, x0, y0, x1, y1) => {
    let n = 0;
    const xa = Math.max(0, Math.floor(x0));
    const ya = Math.max(0, Math.floor(y0));
    const xb = Math.min(img.w, Math.ceil(x1));
    const yb = Math.min(img.h, Math.ceil(y1));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        if (pred(img.data, 4 * (y * img.w + x))) n++;
      }
    }
    return n;
  };

  // White 16x16 image; per-billboard color tints it.
  const img = document.createElement("canvas");
  img.width = 16;
  img.height = 16;
  const ictx = img.getContext("2d");
  ictx.fillStyle = "#ffffff";
  ictx.fillRect(0, 0, 16, 16);

  // Cluster: 32x32 grid, ~20 m spacing (~620 m blob), 1000 m altitude.
  // Mover destination: ~1.7 km east of the camera center — clearly
  // separated from the cluster on screen, inside the view.
  const LON = -75.0;
  const LAT = 40.0;
  const bbs = scene.primitives.add(new C.BillboardCollection());
  for (let i = 0; i < 1000; i++) {
    bbs.add({
      position: C.Cartesian3.fromDegrees(
        LON + 0.0002 * (i % 32),
        LAT + 0.0002 * Math.floor(i / 32),
        1000.0,
      ),
      image: img,
      color: i === 0 ? C.Color.CYAN : C.Color.MAGENTA,
    });
  }
  scene.morphTo3D(0);
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-74.985, 40.003, 9000.0),
    orientation: { heading: 0.0, pitch: -Math.PI / 2, roll: 0.0 },
  });

  // Warmup: atlas upload, pipeline resolve, image-ready dirty churn.
  // Settle until the manager exists and counters stop moving (cap 240).
  let mgr = null;
  let settled = 0;
  let lastFull = -1;
  let lastPartial = -1;
  let warmupFrames = 0;
  for (; warmupFrames < 240 && settled < 10; warmupFrames++) {
    await frame(1);
    mgr = bbs._webgpuCache?.instanceManager ?? null;
    if (!mgr) continue;
    if (
      mgr._fullRebuilds === lastFull &&
      mgr._partialWrites === lastPartial &&
      bbs._allBillboardsReady
    ) {
      settled++;
    } else {
      settled = 0;
      lastFull = mgr._fullRebuilds;
      lastPartial = mgr._partialWrites;
    }
  }
  if (!mgr) {
    return { fatal: "instanceManager never appeared" };
  }

  // (A) 30 static frames -> no uploads at all.
  const a0 = {
    full: mgr._fullRebuilds,
    partial: mgr._partialWrites,
    bytes: mgr._bytesUploaded,
  };
  await frame(30);
  const staticFullDelta = mgr._fullRebuilds - a0.full;
  const staticPartialDelta = mgr._partialWrites - a0.partial;
  const staticBytesDelta = mgr._bytesUploaded - a0.bytes;

  // (C) + (D-before): render + mover-destination window clean.
  const before = grab();
  const magentaBefore = countIn(before, isMagenta, 0, 0, before.w, before.h);
  const newPos = C.Cartesian3.fromDegrees(-74.965, 40.0, 1000.0);
  const win = scene.cartesianToCanvasCoordinates(newPos);
  const cyanAtNewBefore = win
    ? countIn(before, isCyan, win.x - 25, win.y - 25, win.x + 25, win.y + 25)
    : -1;

  // (B) move ONE billboard -> partial write of ~1 stride, no full rebuild.
  const b0 = {
    full: mgr._fullRebuilds,
    partial: mgr._partialWrites,
    bytes: mgr._bytesUploaded,
  };
  bbs.get(0).position = newPos;
  await frame(1);
  const moveFullDelta1 = mgr._fullRebuilds - b0.full;
  const movePartialDelta1 = mgr._partialWrites - b0.partial;
  const moveBytesDelta1 = mgr._bytesUploaded - b0.bytes;
  await frame(5); // settle — no further uploads expected
  const moveFullDelta = mgr._fullRebuilds - b0.full;
  const movePartialDelta = mgr._partialWrites - b0.partial;
  const moveBytesDelta = mgr._bytesUploaded - b0.bytes;

  // (D-after) the mover renders at the NEW position.
  const after = grab();
  const win2 = scene.cartesianToCanvasCoordinates(newPos) ?? win;
  const cyanAtNewAfter = win2
    ? countIn(after, isCyan, win2.x - 25, win2.y - 25, win2.x + 25, win2.y + 25)
    : -1;
  const magentaAfter = countIn(after, isMagenta, 0, 0, after.w, after.h);

  return {
    warmupFrames,
    warmupFull: a0.full,
    warmupPartial: a0.partial,
    visibleCount: mgr.lastVisibleCount,
    staticFullDelta,
    staticPartialDelta,
    staticBytesDelta,
    moveFullDelta1,
    movePartialDelta1,
    moveBytesDelta1,
    moveFullDelta,
    movePartialDelta,
    moveBytesDelta,
    magentaBefore,
    magentaAfter,
    cyanAtNewBefore,
    cyanAtNewAfter,
    winXY: win2 ? [Math.round(win2.x), Math.round(win2.y)] : null,
  };
});

if (out.fatal) {
  console.log(`FATAL: ${out.fatal}`);
  await browser.close();
  process.exit(1);
}

const aOK = out.staticFullDelta === 0 && out.staticPartialDelta === 0;
const bOK =
  out.moveFullDelta === 0 &&
  out.movePartialDelta1 >= 1 &&
  out.moveBytesDelta1 >= STRIDE &&
  out.moveBytesDelta1 < 3 * STRIDE && // ~1 instance, never N x stride
  out.moveBytesDelta === out.moveBytesDelta1; // settles after one frame
const cOK = out.magentaBefore > 200 && out.magentaAfter > 200;
const dOK = out.cyanAtNewBefore === 0 && out.cyanAtNewAfter > 5;
const eOK = errors.length === 0;

console.log(
  `warmup: ${out.warmupFrames} frames, fullRebuilds=${out.warmupFull}, partialWrites=${out.warmupPartial}, visible=${out.visibleCount}`,
);
console.log(
  `(A) 30 static frames: fullDelta=${out.staticFullDelta} partialDelta=${out.staticPartialDelta} bytesDelta=${out.staticBytesDelta} ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) move 1 of 1000: frame1 partial=${out.movePartialDelta1} bytes=${out.moveBytesDelta1} (stride=${STRIDE}); settled full=${out.moveFullDelta} partial=${out.movePartialDelta} bytes=${out.moveBytesDelta} ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) renders: magenta before=${out.magentaBefore} after=${out.magentaAfter} ${cOK ? "OK" : "FAIL"}`,
);
console.log(
  `(D) mover at new pos ${JSON.stringify(out.winXY)}: cyan before=${out.cyanAtNewBefore} after=${out.cyanAtNewAfter} ${dOK ? "OK" : "FAIL"}`,
);
console.log(`(E) console errors: ${errors.length} ${eOK ? "OK" : "FAIL"}`);
errors.slice(0, 5).forEach((e) => console.log("  ERR:", e.slice(0, 200)));

const pass = aOK && bOK && cOK && dOK && eOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
