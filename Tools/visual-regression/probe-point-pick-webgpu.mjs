// Point-primitive pick gate (NEW-WEBGPU-POINT-COLLECTION-PICK, Batch 323).
//
// Does scene.pick / scene.pickAsync at a point's screen position return that
// PointPrimitive (with its id) on WebGPU? This is the regression gate that
// proves the WebGPU point-pick consumer resolves — the producer half (pickOnly
// command, per-instance pick colors, pick pipeline in
// WebGPUPointPrimitiveRenderer.js) AND the consumer half (FORK-34 pickOnly
// dispatch in WebGPUSceneRendererPickPass.ts that routes the point pickOnly
// command into the single-target pick FBO, plus the pickObjectsFromPixels
// readback) are both wired. A side-by-side BILLBOARD is the known-working
// reference path; this probe asserts point pick is at parity with it.
//
// Architectural note on the synchronous pick path: WebGPU readback is async,
// so scene.pick() (the SYNCHRONOUS API) returns the PREVIOUS frame's pick-FBO
// pixels via WebGPUPickFramebuffer.end() (one-frame-stale by design). The very
// first sync pick on a fresh pick FBO therefore returns undefined for ANY
// primitive type (billboard included) until the readback cache primes — this
// is NOT a point-specific defect. The probe warms the sync path across several
// frames (mirroring how real mouse handlers pick) before asserting, and uses
// pickAsync as the immediate-result control.
//
// Checks (all on WebGPU):
//   (1) SYNC POINT HIT  — warmed scene.pick over the point returns it + id.
//   (2) SYNC BILLBOARD  — same warmed sync pick over the billboard control.
//   (3) ASYNC HITS      — pickAsync over point + billboard (immediate path).
//   (4) MISS CONTROL    — warmed sync pick at empty space returns undefined.
//   (5) 0 console/WebGPU validation errors.
//
// Usage: node Tools/visual-regression/probe-point-pick-webgpu.mjs
// Env:   PROBE_BASE (default http://localhost:8080), PROBE_RENDERER (webgpu)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const RENDERER = process.env.PROBE_RENDERER || "webgpu";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message.slice(0, 200)));
page.on("console", (m) => {
  if (m.type() === "error") pageErrors.push(m.text().slice(0, 200));
});

await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${RENDERER}`, {
  waitUntil: "networkidle",
  timeout: 90000,
});
await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  const errors = [];
  const dev = scene.context?._device;
  if (dev) {
    dev.onuncapturederror = (ev) =>
      errors.push(String(ev?.error?.message).slice(0, 250));
  }

  // Deterministic background: hide globe/sky/sun/moon so the point is the
  // only pickable thing on screen.
  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;

  // Raw PointPrimitiveCollection added directly to scene.primitives — the
  // exact reproduction from the DEFERRED_WORK entry.
  const points = scene.primitives.add(new C.PointPrimitiveCollection());
  const pt = points.add({
    position: C.Cartesian3.fromDegrees(-75, 40, 1000.0),
    pixelSize: 50.0,
    color: C.Color.MAGENTA,
    id: "probe-point-1",
  });

  // Side-by-side billboard control — the WORKING reference path. Placed at a
  // different lon so its screen pixel is distinct from the point.
  const img = document.createElement("canvas");
  img.width = 32;
  img.height = 32;
  const g2d = img.getContext("2d");
  g2d.fillStyle = "#00ff00";
  g2d.fillRect(0, 0, 32, 32);
  const bbs = scene.primitives.add(new C.BillboardCollection());
  const bb = bbs.add({
    position: C.Cartesian3.fromDegrees(-74.99, 40, 1000.0),
    image: img,
    color: C.Color.CYAN,
    id: "probe-billboard-1",
  });

  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-75, 40, 20000.0),
    orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
  });

  const renderN = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  await renderN(90);

  // Project the point + billboard world positions to screen pixels so we
  // click exactly on each.
  const ptWin = C.SceneTransforms.worldToWindowCoordinates(
    scene,
    pt.position,
  );
  const bbWin = C.SceneTransforms.worldToWindowCoordinates(
    scene,
    bb.position,
  );

  // SYNCHRONOUS scene.pick — the exact API the bug report targets.
  const doPickSync = (x, y) => scene.pick(new C.Cartesian2(x, y), 9, 9);
  // ASYNC pickAsync — the reliable readback path (control).
  const doPickAsync = async (x, y) =>
    scene.pickAsync
      ? scene.pickAsync(new C.Cartesian2(x, y), 9, 9)
      : scene.pick(new C.Cartesian2(x, y), 9, 9);

  const describeHit = (hit, expected) => {
    if (hit === undefined || hit === null) return { found: false };
    return {
      found: true,
      isExpected:
        hit === expected ||
        hit.primitive === expected ||
        hit?.target === expected,
      id: hit?.id,
      ctor: hit?.constructor?.name,
    };
  };

  // The synchronous pick returns the PREVIOUS frame's readback (WebGPU
  // readback is async). Warm it up: repeatedly sync-pick the SAME pixel
  // across several rendered frames so the one-frame-stale cache fills.
  const warmSyncPick = async (x, y, n) => {
    let last;
    for (let i = 0; i < n; i++) {
      last = doPickSync(x, y);
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return last;
  };

  const px = Math.round(ptWin.x);
  const py = Math.round(ptWin.y);
  const bx = Math.round(bbWin.x);
  const by = Math.round(bbWin.y);

  // ASYNC picks (reliable control).
  await doPickAsync(px, py);
  await renderN(6);
  const asyncPoint = describeHit(await doPickAsync(px, py), pt);
  const asyncBillboard = describeHit(await doPickAsync(bx, by), bb);

  // SYNC picks (the targeted API).
  const syncPoint = describeHit(await warmSyncPick(px, py, 12), pt);
  const syncBillboard = describeHit(await warmSyncPick(bx, by, 12), bb);
  const syncMiss = describeHit(await warmSyncPick(20, 20, 12), pt);

  return {
    coords: { px, py, bx, by },
    asyncPoint,
    asyncBillboard,
    syncPoint,
    syncBillboard,
    syncMiss,
    errors,
  };
});

await browser.close();

console.log(JSON.stringify(out, null, 2));

const pass =
  out.syncPoint.found &&
  out.syncPoint.isExpected &&
  out.syncPoint.id === "probe-point-1" &&
  out.syncBillboard.found &&
  out.syncBillboard.isExpected &&
  !out.syncMiss.found &&
  out.errors.length === 0 &&
  pageErrors.length === 0;

if (pageErrors.length > 0) {
  console.log("page errors:", pageErrors);
}
console.log(pass ? "PROBE PASS" : "PROBE FAIL");
process.exit(pass ? 0 : 1);
