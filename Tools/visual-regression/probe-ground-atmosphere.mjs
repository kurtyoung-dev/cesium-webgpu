#!/usr/bin/env node
// Probe (Batch 239 — NEW-GROUNDATMOSPHERE-RENDERER-DEAD deletion verify):
// the separate-pass WebGPUGroundAtmosphereRenderer + FeatureRendererKey 29
// registration + Globe.js beginFrame call were DELETED (the UB it packed was
// never bound by any pipeline). The LIVE ground-atmosphere path is shaded
// inside GlobeTerrain.wgsl (csm_computeGroundAtmosphereScattering +
// WebGPUAtmosphereLUT, params via the globe camera/tile UBs). This probe
// asserts the deletion left that live path intact:
//
//   (A) RENDERS — with `globe.showGroundAtmosphere = true` and
//       skyAtmosphere HIDDEN (so limb glow can't masquerade as ground
//       atmosphere), the lit globe renders non-black pixels.
//   (B) CONTRIBUTES — toggling showGroundAtmosphere OFF in the same
//       session (tiles already settled, clock pinned) changes a
//       substantial number of globe pixels: the in-shader ground
//       atmosphere veil is live, not a silent no-op.
//   (C) RETIRED KEY — getFeatureRenderer(GROUND_ATMOSPHERE = 29) returns
//       nothing (no renderer registered on the retired slot).
//   (D) ZERO console errors (incl. WebGPU validation errors).
//
// Determinism: requestRenderMode disabled (CesiumViewer default is true —
// the loop would stall and postRender would never fire), clock pinned to a
// fixed JulianDate with the viewed hemisphere lit, readback inside
// scene.postRender (a WebGPU canvas clears its texture on present).
//
// Usage: node Tools/visual-regression/probe-ground-atmosphere.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

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
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;

  scene.requestRenderMode = false;
  v.clock.shouldAnimate = false;
  // Pin to a time when (-100, 40) is in daylight (18:00 UTC ~ local noon
  // at 90°W) so dynamic atmosphere lighting has a lit hemisphere.
  v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-15T18:00:00Z");

  scene.globe.showGroundAtmosphere = true;
  // Isolate ground atmosphere: the limb glow against space is
  // skyAtmosphere — hide it so every atmosphere pixel we count is the
  // in-GlobeTerrain ground-atmosphere path.
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = false;
  }

  // 18 Mm — well into the ground-atmosphere fade ramp (same framing as
  // probe-atmosphere-toggle.mjs).
  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-100, 40, 18_000_000),
  });

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

  // Warmup: render until imagery settles so the ON/OFF diff below isn't
  // contaminated by tile refinement. NOTE: `tilesLoaded` goes true on
  // WebGPU ~frame 60 while imagery upload/reprojection is still in
  // flight (the surface reads black for ~200 more frames — verified
  // during Batch 239 probe bring-up), so require BOTH a 300-frame floor
  // AND 60 consecutive tilesLoaded frames.
  let frames = 0;
  let consecutiveLoaded = 0;
  for (; frames < 900; frames++) {
    await oncePostRender();
    consecutiveLoaded = scene.globe.tilesLoaded ? consecutiveLoaded + 1 : 0;
    if (frames > 300 && consecutiveLoaded > 60) break;
  }
  const imgOn = await grab();

  scene.globe.showGroundAtmosphere = false;
  // The toggle flips shader defines -> tile pipeline rebuild; give it a
  // generous settle before the OFF capture.
  for (let i = 0; i < 30; i++) {
    await oncePostRender();
  }
  const imgOff = await grab();

  const n = imgOn.w * imgOn.h;
  let nonBlackOn = 0;
  let diffPx = 0;
  for (let p = 0; p < n; p++) {
    const i = 4 * p;
    const r = imgOn.data[i];
    const g = imgOn.data[i + 1];
    const b = imgOn.data[i + 2];
    if (r + g + b > 45) {
      nonBlackOn++;
    }
    if (
      Math.abs(r - imgOff.data[i]) > 12 ||
      Math.abs(g - imgOff.data[i + 1]) > 12 ||
      Math.abs(b - imgOff.data[i + 2]) > 12
    ) {
      diffPx++;
    }
  }

  // Retired slot: FeatureRendererKey.GROUND_ATMOSPHERE (29) must have no
  // registered renderer after the Batch 239 deletion.
  const context = scene.frameState.context;
  const retiredFR =
    typeof context.getFeatureRenderer === "function"
      ? context.getFeatureRenderer(29)
      : "no-getter";

  return {
    warmupFrames: frames,
    tilesLoaded: scene.globe.tilesLoaded,
    totalPx: n,
    nonBlackOn,
    diffPx,
    retiredFRType: retiredFR === null ? "null" : typeof retiredFR,
  };
});

const aOK = out.nonBlackOn > 20000;
const bOK = out.diffPx > 1500;
const cOK = out.retiredFRType === "undefined" || out.retiredFRType === "null";
const dOK = errors.length === 0;

console.log(
  `(A) renders: ${out.nonBlackOn}/${out.totalPx} non-black px with groundAtmosphere ON, skyAtmosphere hidden (warmup ${out.warmupFrames} frames, tilesLoaded=${out.tilesLoaded}) (threshold 20000) ${aOK ? "OK" : "FAIL"}`,
);
console.log(
  `(B) contributes: ON vs OFF diff ${out.diffPx} px (threshold 1500) ${bOK ? "OK" : "FAIL"}`,
);
console.log(
  `(C) retired key 29: getFeatureRenderer(29) -> ${out.retiredFRType} ${cOK ? "OK" : "FAIL"}`,
);
console.log(`(D) console errors: ${errors.length} ${dOK ? "OK" : "FAIL"}`);
errors.slice(0, 8).forEach((e) => console.log("  ERR:", e.slice(0, 250)));

const pass = aOK && bOK && cOK && dOK;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
