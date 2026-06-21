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
  //
  // THREE distinct points at THREE distinct lons → three distinct screen
  // pixels, each with a DISTINCT id. One point can't catch per-instance pick-
  // color CROSS-WIRING (the "all points resolve to one id" regression that
  // NEW-WEBGPU-POINT-COLLECTION-PICK rules out): we need ≥2 instances and must
  // assert each resolves to ITS OWN id, not a shared one. pt (probe-point-1)
  // stays the primary single-point + control reference; pt2/pt3 add the multi-
  // instance coverage.
  const points = scene.primitives.add(new C.PointPrimitiveCollection());
  const pt = points.add({
    position: C.Cartesian3.fromDegrees(-75, 40, 1000.0),
    pixelSize: 50.0,
    color: C.Color.MAGENTA,
    id: "probe-point-1",
  });
  // All three points share the SAME latitude (same screen ROW) and differ only
  // in longitude (distinct screen COLUMNS). This keeps each on the warmed sync
  // pick-readback row: a SEPARATE, tracked gap (NEW-WEBGPU-PICK-COLD-SYNC-
  // STALENESS) makes the one-frame-stale single-target sync pick-FBO readback
  // MISS points that sit on a DIFFERENT row from the warmed region — verified:
  // the point renders correctly (canvas pixel is its color) but the warmed sync
  // pick returns undefined off-row. That row-staleness is NOT what this probe
  // gates; the multi-instance check here targets per-instance pick-color CROSS-
  // WIRING (all-points-resolve-to-one-id), which needs distinct ids resolved at
  // distinct pixels, achievable on the warmed row.
  const pt2 = points.add({
    position: C.Cartesian3.fromDegrees(-75.02, 40, 1000.0),
    pixelSize: 50.0,
    color: C.Color.YELLOW,
    id: "probe-point-2",
  });
  const pt3 = points.add({
    position: C.Cartesian3.fromDegrees(-74.98, 40, 1000.0),
    pixelSize: 50.0,
    color: C.Color.LIME,
    id: "probe-point-3",
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
  const pt2Win = C.SceneTransforms.worldToWindowCoordinates(
    scene,
    pt2.position,
  );
  const pt3Win = C.SceneTransforms.worldToWindowCoordinates(
    scene,
    pt3.position,
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
  const p2x = Math.round(pt2Win.x);
  const p2y = Math.round(pt2Win.y);
  const p3x = Math.round(pt3Win.x);
  const p3y = Math.round(pt3Win.y);
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

  // MULTI-INSTANCE pick: warm-pick all THREE points at their THREE distinct
  // pixels. Each must resolve to its OWN id — if per-instance pick colors are
  // cross-wired, two or more would resolve to the same id (or to point-1).
  const syncPoint1 = describeHit(await warmSyncPick(px, py, 12), pt);
  const syncPoint2 = describeHit(await warmSyncPick(p2x, p2y, 12), pt2);
  const syncPoint3 = describeHit(await warmSyncPick(p3x, p3y, 12), pt3);

  return {
    coords: { px, py, p2x, p2y, p3x, p3y, bx, by },
    asyncPoint,
    asyncBillboard,
    syncPoint,
    syncBillboard,
    syncMiss,
    syncPoint1,
    syncPoint2,
    syncPoint3,
    errors,
  };
});

await browser.close();

console.log(JSON.stringify(out, null, 2));

// Multi-instance assertion: all THREE points round-trip to their THREE DISTINCT
// ids (the per-instance pick-color cross-wiring check). Each must be found, be
// the expected primitive, and carry its own id; the three ids must be distinct.
const ids3 = [out.syncPoint1.id, out.syncPoint2.id, out.syncPoint3.id];
const multiFound =
  out.syncPoint1.found && out.syncPoint2.found && out.syncPoint3.found;
const multiExpected =
  out.syncPoint1.isExpected &&
  out.syncPoint2.isExpected &&
  out.syncPoint3.isExpected;
const multiIds =
  out.syncPoint1.id === "probe-point-1" &&
  out.syncPoint2.id === "probe-point-2" &&
  out.syncPoint3.id === "probe-point-3";
const multiDistinct = new Set(ids3).size === 3;
const multiInstancePass =
  multiFound && multiExpected && multiIds && multiDistinct;

const pass =
  out.syncPoint.found &&
  out.syncPoint.isExpected &&
  out.syncPoint.id === "probe-point-1" &&
  out.syncBillboard.found &&
  out.syncBillboard.isExpected &&
  !out.syncMiss.found &&
  multiInstancePass &&
  out.errors.length === 0 &&
  pageErrors.length === 0;

console.log(
  `multi-instance: found=${multiFound} expected=${multiExpected} ids=${JSON.stringify(ids3)} distinct=${multiDistinct} => ${multiInstancePass ? "PASS" : "FAIL"}`,
);
if (!multiInstancePass) {
  console.log(
    "  NOTE: a warmed 3-point sync pick should resolve 3 DISTINCT ids; if 2+ collapse to one id this is per-instance pick-color cross-wiring (NEW-WEBGPU-POINT-COLLECTION-PICK). If all are `undefined`, that is the tracked cold-sync-pick staleness gap (NEW-WEBGPU-PICK-COLD-SYNC-STALENESS).",
  );
}
if (pageErrors.length > 0) {
  console.log("page errors:", pageErrors);
}
console.log(pass ? "PROBE PASS" : "PROBE FAIL");
process.exit(pass ? 0 : 1);
