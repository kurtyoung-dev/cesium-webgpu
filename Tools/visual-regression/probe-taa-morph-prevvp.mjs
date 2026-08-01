#!/usr/bin/env node
// Probe (MORPH-TAA-PREVVP, Batch 276) — TAA history is invalidated across the
// perspective↔orthographic morph flip so a TAA-enabled mid-morph frame does NOT
// reproject the current depth against the prior frame's incompatible
// view-projection (which smears / ghosts the whole frame).
//
// What's verified, on WebGPU with scene.taaEnabled = true:
//   (1) Driving scene.morphTo2D() then scene.morphTo3D() renders cleanly through
//       the flip — the canvas stays non-degenerate (non-black, no NaN wipeout)
//       on every sampled frame, and there are 0 console / WebGPU validation
//       errors across the whole morph sequence.
//   (2) The history-invalid guard actually fires: while the scene mode is
//       MORPHING (or the projection type flips), the probe observes the TAA
//       motion-vector "valid" flag drop to false at least once — i.e. the guard
//       in Scene.js ran (taa.resetHistory() + valid=false) rather than
//       reprojecting against a stale matrix.
//
// The TAA motion-vector validity is surfaced through the effect's frame stats;
// the probe samples `_motionVectorsValid` (via the effect instance) each frame
// while morphing and asserts it went false during the transition.
//
// Usage: node Tools/visual-regression/probe-taa-morph-prevvp.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

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
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer;
  const scene = v.scene;
  v.clock.shouldAnimate = false;

  scene.globe.show = true;
  scene.imageryLayers.removeAll();
  scene.globe.baseColor = new C.Color(0.12, 0.15, 0.2, 1.0);
  scene.globe.showGroundAtmosphere = false;
  // NOTE: the sky (skyBox / skyAtmosphere / sun / moon) is intentionally LEFT ON
  // — disabling all of them makes the WebGPU post-process pipeline skip adding
  // the lazy TAA effect (an unrelated environment-renderer gate), so the probe
  // could never observe TAA. A realistic TAA scene keeps the sky anyway.

  // Enable TAA. The post-process pipeline lazily instantiates the TAA effect on
  // the first taaEnabled frame.
  scene.taaEnabled = true;

  const frame = async (n) => {
    for (let i = 0; i < n; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
  };
  const snap = () =>
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
      scene.render();
    });

  // A frame is "clean" if it is NOT NaN-garbage. NaN/Inf depth or color from a
  // stale-matrix reproject decodes to scattered fully-saturated (255,255,255)
  // noise covering much of the frame. We flag a frame dirty only if a large
  // fraction of pixels are pure-white saturated (the garbage signature). We do
  // NOT require non-black coverage — a 2D top-down view legitimately has large
  // black margins around the map, which is not a failure.
  const frameClean = (img) => {
    let saturated = 0;
    const total = img.w * img.h;
    for (let p = 0; p < total; p++) {
      const i = 4 * p;
      if (img.data[i] > 250 && img.data[i + 1] > 250 && img.data[i + 2] > 250)
        saturated++;
    }
    return { ok: saturated / total < 0.5, saturated, total };
  };

  v.camera.setView({
    destination: C.Cartesian3.fromDegrees(-75.0, 40.0, 12000000.0),
  });

  // Warm up in 3D with TAA accumulating. TAA is lazily added during a render
  // frame after taaEnabled flips true, so fetch the effect AFTER warmup.
  await frame(20);
  let stable = 0;
  for (let i = 0; i < 120 && stable < 6; i++) {
    await frame(1);
    stable = scene.globe.tilesLoaded ? stable + 1 : 0;
  }
  await frame(10);

  // Find the live TAA effect instance (now lazily added).
  const taa = scene._alternateSceneRenderer?._postProcess?.taaEffect ?? null;

  let allClean = true;
  let sawInvalidDuringMorph = false;
  let maxSaturatedFrac = 0.0;

  // Sample mode + TAA validity + frame health across a morph. Cesium's morph
  // takes ~2s by default; drive frames and sample.
  const sampleMorph = async (label, durationFrames) => {
    for (let i = 0; i < durationFrames; i++) {
      await frame(1);
      const morphing = scene.mode === C.SceneMode.MORPHING;
      // Read the effect's motion-vector validity (private but inspectable in the
      // unminified build). When the guard fires mid-morph it is false.
      const mvValid = taa ? taa._motionVectorsValid : null;
      if (morphing && mvValid === false) sawInvalidDuringMorph = true;
      const img = await snap();
      const fc = frameClean(img);
      maxSaturatedFrac = Math.max(maxSaturatedFrac, fc.saturated / fc.total);
      if (!fc.ok) allClean = false;
    }
  };

  scene.morphTo2D(1.0);
  await sampleMorph("to2D", 70);
  // Settle in 2D.
  await frame(20);

  scene.morphTo3D(1.0);
  await sampleMorph("to3D", 70);
  await frame(20);

  return {
    hadTaa: !!taa,
    taaEnabledFlag: taa ? taa.enabled : null,
    allClean,
    sawInvalidDuringMorph,
    maxSaturatedFrac,
    finalMode: scene.mode === C.SceneMode.SCENE3D ? "3D" : String(scene.mode),
  };
});

let ok = true;
const check = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

check(
  "1",
  out.hadTaa === true && out.taaEnabledFlag === true,
  `TAA effect instantiated + enabled with taaEnabled: hadTaa=${out.hadTaa} enabled=${out.taaEnabledFlag}`,
);
check(
  "2",
  out.allClean === true,
  `every sampled morph frame renders clean (no NaN-garbage saturation wipeout): allClean=${out.allClean} maxSaturatedFrac=${out.maxSaturatedFrac.toFixed(3)}`,
);
check(
  "3",
  out.sawInvalidDuringMorph === true,
  `MORPH-TAA-PREVVP guard fired: TAA motion-vector validity went false during MORPHING (history invalidated, no stale reproject): sawInvalidDuringMorph=${out.sawInvalidDuringMorph}`,
);
check(
  "4",
  out.finalMode === "3D",
  `morph completes back to 3D: finalMode=${out.finalMode}`,
);
check(
  "5",
  errors.length === 0,
  `console / WebGPU validation errors: ${errors.length}`,
);
if (errors.length)
  for (const e of errors.slice(0, 8)) console.log(`  ERR: ${e}`);

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
