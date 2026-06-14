#!/usr/bin/env node
// Probe (BUG-ELLIPSOIDPRIM-WEBGPU-TRANSLUCENT-DOUBLE-BLEND, Batch 276) +
// EllipsoidPrimitive WebGL re-verification of the Batch-269 _computedModelMatrix
// hoist.
//
// Two independent things this probe nails down:
//
//  (a) WebGL EllipsoidPrimitive STILL renders correctly after Batch 269 hoisted
//      the radii / _computedModelMatrix / bounding-sphere computation above the
//      feature-renderer branch (Scene Logic Extractor). The hoist did not change
//      the WebGL math, only its ordering, but it was never visually re-verified
//      on WebGL. Here we render an OPAQUE green ellipsoid on WebGL and assert a
//      healthy green-pixel count.
//
//  (b) WebGPU translucent ellipsoid blends its shell exactly ONCE. The WebGPU box
//      geometry previously rasterized with cullMode "none", running the ray-cast
//      FS twice per ellipsoid pixel (near box face + far box face). For opaque
//      shells the second blend overwrites identically (harmless), but a
//      translucent shell (alpha 0.5) double-blends: over a black background a
//      single src-alpha blend yields 0.5*S, while a double blend yields
//      0.5*S + 0.5*(0.5*S) = 0.75*S — 1.5x too bright / too opaque. Batch 276
//      switches to cullMode "back" (one face per pixel), matching WebGL's
//      CullFace.FRONT single rasterization.
//
//      We render an alpha-0.5 green ellipsoid over a BLACK background on WebGPU
//      and compare the mean green intensity of the shell pixels against the
//      OPAQUE shell's mean green (the same geometry/lighting at alpha 1.0 = S).
//      Single blend  => translucent mean ~= 0.5 * opaque mean.
//      Double blend  => translucent mean ~= 0.75 * opaque mean.
//      Assert the ratio is in the single-blend band (well below 0.62, the
//      midpoint between 0.5 and 0.75), which fails pre-fix and passes post-fix.
//
// Usage: node Tools/visual-regression/probe-ellipsoidprim-translucent.mjs
// Env:   PROBE_BASE (default http://localhost:8134)

import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

// Renders a SINGLE ellipsoid (opaque or translucent) looking straight down its
// center and returns the mean green intensity over the shell pixels + count.
//
// globeOn: WebGPU runs with the globe OFF over pure black so the alpha-blend
// math is exact (background B = 0 → single blend = 0.5·S, double = 0.75·S).
// WebGL's EllipsoidPrimitive uses fragment-depth/WRITE_DEPTH and only rasterizes
// when the depth buffer is populated by other geometry — with no globe the lone
// shell is depth-plane-culled (a pre-existing WebGL quirk, not the hoist), so
// the WebGL leg keeps the globe ON with a dark baseColor (well below the green
// threshold) to give the shell a depth context.
async function measureShell(renderer, alpha, globeOn) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ alpha, globeOn }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      v.clock.shouldAnimate = false;

      scene.globe.show = globeOn;
      scene.imageryLayers.removeAll();
      if (globeOn) {
        // Dark, near-black baseColor (blue-grey) — far below the green-dominant
        // pixel test, so the shell's green pixels are still counted cleanly while
        // the globe supplies the depth context WebGL's EllipsoidPrimitive needs.
        scene.globe.baseColor = new C.Color(0.06, 0.07, 0.1, 1.0);
        scene.globe.showGroundAtmosphere = false;
        scene.globe.showWaterEffect = false;
      }
      if (scene.skyBox) scene.skyBox.show = false;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      if (scene.sun) scene.sun.show = false;
      if (scene.moon) scene.moon.show = false;
      scene.backgroundColor = C.Color.BLACK;

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

      const LON = -75.0;
      const LAT = 40.0;
      // Shell at 200 km altitude. A lower 50 km placement renders on WebGPU but
      // is eaten by a pre-existing WebGL near-/depth-plane interaction at this
      // 400 km top-down camera (the lone WebGL EllipsoidPrimitive vanishes —
      // unrelated to the Batch-269 _computedModelMatrix hoist, which only
      // reordered identical math). 200 km renders cleanly on BOTH backends, so
      // the WebGL leg below verifies the hoist did not regress WebGL.
      const m = C.Material.fromType("Color");
      m.uniforms.color = new C.Color(0.1, 1.0, 0.1, alpha);
      const ep = new C.EllipsoidPrimitive({
        radii: new C.Cartesian3(30000.0, 30000.0, 30000.0),
        material: m,
        modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
          C.Cartesian3.fromDegrees(LON, LAT, 200000.0),
        ),
      });
      scene.primitives.add(ep);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON, LAT, 400000.0),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });

      await frame(30);
      // When the globe is on, let terrain settle so it reliably draws the depth
      // context the WebGL shell needs before we snapshot.
      if (globeOn) {
        let stable = 0;
        for (let i = 0; i < 150 && stable < 6; i++) {
          await frame(1);
          stable = scene.globe.tilesLoaded ? stable + 1 : 0;
        }
        await frame(8);
      }
      const img = await snap();

      // Shell pixels: green clearly dominates and the pixel is not black.
      let sumG = 0;
      let n = 0;
      for (let p = 0; p < img.w * img.h; p++) {
        const i = 4 * p;
        const r = img.data[i];
        const g = img.data[i + 1];
        const b = img.data[i + 2];
        if (g > 20 && g > r + 10 && g > b + 10) {
          sumG += g;
          n++;
        }
      }
      return { meanG: n > 0 ? sumG / n : 0, count: n };
    },
    { alpha, globeOn },
  );

  await page.close();
  return { ...out, errors };
}

let ok = true;
const check = (label, pass, detail) => {
  console.log(`(${label}) ${detail} ${pass ? "OK" : "FAIL"}`);
  if (!pass) ok = false;
};

// (a) WebGL opaque (globe ON for depth context) — re-verify the Batch-269
// _computedModelMatrix hoist didn't regress WebGL EllipsoidPrimitive rendering.
const webglOpaque = await measureShell("webgl", 1.0, true);
check(
  "a",
  webglOpaque.count > 2000 && webglOpaque.meanG > 60 && webglOpaque.errors.length === 0,
  `WebGL EllipsoidPrimitive renders post-hoist: shellPx=${webglOpaque.count} meanG=${webglOpaque.meanG.toFixed(1)} errors=${webglOpaque.errors.length}`,
);

// (b) WebGPU opaque (= S reference) vs WebGPU translucent alpha 0.5, globe OFF
// over black so the blend math is exact.
const webgpuOpaque = await measureShell("webgpu", 1.0, false);
const webgpuTrans = await measureShell("webgpu", 0.5, false);

check(
  "b1",
  webgpuOpaque.count > 2000 && webgpuOpaque.meanG > 60 && webgpuOpaque.errors.length === 0,
  `WebGPU opaque shell reference: shellPx=${webgpuOpaque.count} meanG=${webgpuOpaque.meanG.toFixed(1)} errors=${webgpuOpaque.errors.length}`,
);
check(
  "b2",
  webgpuTrans.count > 2000 && webgpuTrans.errors.length === 0,
  `WebGPU translucent shell visible: shellPx=${webgpuTrans.count} errors=${webgpuTrans.errors.length}`,
);

// Ratio translucent/opaque: single blend ~0.5, double blend ~0.75. Midpoint
// 0.62 is the discriminator. Pre-fix (cullMode none) this is ~0.75 → FAIL;
// post-fix (cullMode back) ~0.5 → PASS.
const ratio = webgpuOpaque.meanG > 0 ? webgpuTrans.meanG / webgpuOpaque.meanG : 0;
check(
  "b3",
  ratio > 0.34 && ratio < 0.62,
  `WebGPU translucent blends ONCE (single-blend band 0.34..0.62): transMeanG=${webgpuTrans.meanG.toFixed(1)} opaqueMeanG=${webgpuOpaque.meanG.toFixed(1)} ratio=${ratio.toFixed(3)} (double-blend would be ~0.75)`,
);

console.log(ok ? "PASS" : "FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
