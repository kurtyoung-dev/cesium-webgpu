#!/usr/bin/env node
// Probe (C9-13 NEW-GLOBE-EFFECTS-PER-VIEW-PREPARED-HANDLE — off-gate oracle):
// @purpose Oracle for the per-frame globe-effects bind-group memo: clipping ON-OFF-ON must carve, restore, and re-carve terrain with zero stale-handle errors
// @status ACTIVE
//
// the per-(context,frame) prepared globe effects bind group memo
// (`_getOrCreateFrameEffectsBindGroup` in WebGPUGlobeSurfaceRenderer.ts) must
// preserve the active/placeholder toggle semantics. A stale memo would leave
// last frame's active effects bytes bound after the feature turns off, or fail
// to re-arm on restore.
//
// This exercises the memo's ACTIVE -> PLACEHOLDER -> ACTIVE transition by
// toggling `globe.clippingPlanes.enabled` on -> off -> on (clipping is the
// term unique to the globe effects gate; enabled clipping carves a hole in the
// terrain, disabled restores it):
//
//   (A) ON     — an enabled clipping plane removes terrain pixels (a visible
//                clipped region appears vs the un-clipped baseline).
//   (B) OFF    — disabling restores the terrain: the OFF frame matches the
//                pre-clip baseline within tolerance (no stale clipped hole,
//                proving the memo swapped back to the placeholder).
//   (C) RESTORE— re-enabling reproduces the ON frame within tolerance (the
//                memo re-armed the active handle; not a frozen placeholder).
//   (D) ZERO console/validation errors across all transitions.
//
// Determinism: requestRenderMode off, clock pinned, fixed camera, per-toggle
// settle. Usage: node Tools/visual-regression/probe-globe-effects-handle-toggle.mjs
// Env: PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(
  `${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true`,
  {
    waitUntil: "networkidle",
  },
);
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;
  v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-15T18:00:00Z");

  const center = C.Cartesian3.fromDegrees(-100, 40, 2_000_000);
  v.camera.setView({ destination: center });

  const oncePostRender = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        resolve();
      });
    });
  const grab = () =>
    new Promise((resolve) => {
      const remove = scene.postRender.addEventListener(() => {
        remove();
        const c = scene.canvas;
        const off = document.createElement("canvas");
        off.width = c.width;
        off.height = c.height;
        const cx = off.getContext("2d");
        cx.drawImage(c, 0, 0);
        resolve({
          data: cx.getImageData(0, 0, c.width, c.height).data,
          w: c.width,
          h: c.height,
        });
      });
    });
  const settle = async (n) => {
    for (let i = 0; i < n; i++) await oncePostRender();
  };

  // Warmup until imagery settles.
  let frames = 0;
  let consecutive = 0;
  for (; frames < 900; frames++) {
    await oncePostRender();
    consecutive = scene.globe.tilesLoaded ? consecutive + 1 : 0;
    if (frames > 300 && consecutive > 60) break;
  }

  // Baseline (no clipping) — the un-clipped terrain.
  const baseline = await grab();

  // A large clipping plane through the view carves out terrain. The globe
  // effects gate keys on `clippingPlanes.length > 0` (matching WebGPU's
  // existing semantics — `.enabled` is honored upstream in the collection's
  // texture update, not by the bind-group gate), so the memo's
  // active -> placeholder -> active transition is driven by ASSIGNING vs
  // REMOVING the collection (length 1 -> 0 -> 1).
  const makePlane = () =>
    new C.ClippingPlane(new C.Cartesian3(1.0, 0.0, 0.0), 0.0);
  const cp = new C.ClippingPlaneCollection({
    planes: [makePlane()],
    edgeWidth: 0.0,
    enabled: true,
    unionClippingRegions: true,
  });
  scene.globe.clippingPlanes = cp;
  await settle(40);
  const imgOn = await grab();

  // OFF — empty the collection (length -> 0): gate falls to the placeholder.
  cp.removeAll();
  await settle(40);
  const imgOff = await grab();

  // RESTORE — re-add a plane (length -> 1): the memo must re-arm the active
  // handle rather than serving the frozen placeholder.
  cp.add(makePlane());
  await settle(40);
  const imgRestore = await grab();

  const n = baseline.w * baseline.h;
  const diff = (a, b) => {
    let d = 0;
    for (let p = 0; p < n; p++) {
      const i = 4 * p;
      if (
        Math.abs(a.data[i] - b.data[i]) > 12 ||
        Math.abs(a.data[i + 1] - b.data[i + 1]) > 12 ||
        Math.abs(a.data[i + 2] - b.data[i + 2]) > 12
      ) {
        d++;
      }
    }
    return d;
  };

  return {
    warmupFrames: frames,
    tilesLoaded: scene.globe.tilesLoaded,
    totalPx: n,
    onVsBaseline: diff(imgOn, baseline), // (A) clipping visibly changes pixels
    offVsBaseline: diff(imgOff, baseline), // (B) OFF restores baseline (small)
    restoreVsOn: diff(imgRestore, imgOn), // (C) RESTORE reproduces ON (small)
  };
});

await browser.close();

const totalScale = out.totalPx / 100;
// ON must differ substantially from the un-clipped baseline.
const aOK = out.onVsBaseline > 5000;
// OFF must return to the baseline: far fewer changed px than the clip carved.
const bOK = out.offVsBaseline < out.onVsBaseline * 0.15;
// RESTORE must reproduce ON: far fewer changed px than the clip carved.
const cOK = out.restoreVsOn < out.onVsBaseline * 0.15;
const dOK = errors.length === 0;

console.log(
  `(A) clipping ON changes ${out.onVsBaseline}/${out.totalPx} px vs baseline (warmup ${out.warmupFrames}, tilesLoaded=${out.tilesLoaded}) (>5000) ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) clipping OFF restores baseline: ${out.offVsBaseline} px vs baseline (< ${Math.round(out.onVsBaseline * 0.15)} = 15% of ON carve) ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) clipping RESTORE reproduces ON: ${out.restoreVsOn} px vs ON (< ${Math.round(out.onVsBaseline * 0.15)}) ${cOK ? "OK" : "FAIL"}`,
);
console.log(`(D) console errors: ${errors.length} ${dOK ? "OK" : "FAIL"}`);
if (!dOK) errors.slice(0, 8).forEach((e) => console.log("   ", e));
void totalScale;

if (aOK && bOK && cOK && dOK) {
  console.log("PASS");
  process.exit(0);
} else {
  console.log("PROBE FAIL");
  process.exit(1);
}
