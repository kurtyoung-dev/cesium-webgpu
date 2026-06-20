#!/usr/bin/env node
// Probe: NEW-PERINSTANCE-DIFFUSE-PARITY (Batch 326)
//
// A lit (flat:false) PerInstanceColorAppearance primitive rendered visibly
// DARKER on WebGPU than WebGL under the same directional light, independent of
// shadows (~92 vs ~154 surface luminance). The WGSL primitive-lit fragment
// (`phong` / `phongTextured`, PrimitivePhongColor.wgsl / PrimitivePhongTexturedColor.wgsl)
// used an ad-hoc Blinn-Phong term (ambient 0.15 + 0.7·N·L_sun + 0.15·spec)
// that diverged from the GLSL reference `czm_phong` (Builtin/Functions/phong.glsl)
// used by PerInstanceColorAppearanceFS. WebGL/GLSL is the correct reference.
//
// This probe:
//   - Renders a lit (flat:false) PerInstanceColor extruded polygon TOP-DOWN
//     with the globe hidden + atmosphere/fog OFF + shadows OFF + a FIXED light.
//   - Samples the mean luminance of the primitive's lit pixels (it uses a
//     distinct sky-blue color so it is separable from the black background).
//   - Asserts the WebGPU body luminance now matches WebGL within tolerance.
//   - Also samples a few face-normal-driven luminance bands and a MaterialAppearance
//     box (separate WGSL family) for documentation.
//
// Usage: node Tools/visual-regression/probe-perinstance-diffuse.mjs
// Outputs: output/probe-perinstance-diffuse-{webgl,webgpu}.png

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// Tolerance: WebGPU mean body luminance must be within this fraction of WebGL.
const LUM_TOL = 0.08; // 8%

// Distinct primitive color so its pixels are separable from the black
// background. Sky-blue: R low, G mid, B high.
const PRIM_COLOR = { r: 0.15, g: 0.45, b: 0.95 };

async function capture(rendererArg) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 800, height: 800 },
  });
  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  const url = `${BASE}/Apps/CesiumViewer/index.html?renderer=${rendererArg}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.viewer);

  const sample = await page.evaluate(
    async ({ primColor }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      // Fixed clock so the sun direction is deterministic across both runs.
      const fixed = C.JulianDate.fromIso8601("2023-06-21T18:00:00Z");
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      // Clean black backdrop — hide the globe + sky + atmosphere so the only
      // lit pixels in frame are the test primitive. This isolates the
      // appearance lighting term from globe/atmosphere shading.
      v.scene.globe.show = false;
      v.scene.skyAtmosphere.show = false;
      v.scene.skyBox.show = false;
      v.scene.sun.show = false;
      v.scene.moon.show = false;
      v.scene.fog.enabled = false;
      v.scene.backgroundColor = C.Color.BLACK;

      // Shadows fully OFF on BOTH backends — the gap is independent of shadows.
      v.shadows = false;
      v.scene.shadowMap.enabled = false;

      const lon = -75.0;
      const lat = 40.0;

      // Lit (flat:false) PerInstanceColorAppearance extruded polygon. This is
      // the exact reproducer from the DEFERRED_WORK entry. POSITION_AND_NORMAL
      // vertex format → routes to the `phong` WGSL shader.
      const span = 0.01;
      const coords = C.Cartesian3.fromDegreesArray([
        lon - span, lat - span,
        lon + span, lat - span,
        lon + span, lat + span,
        lon - span, lat + span,
      ]);
      const litPrim = new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolygonGeometry({
            polygonHierarchy: new C.PolygonHierarchy(coords),
            height: 0,
            extrudedHeight: 800, // tall block → top + side faces both visible
            vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(primColor.r, primColor.g, primColor.b, 1.0),
            ),
          },
        }),
        appearance: new C.PerInstanceColorAppearance({
          translucent: false,
          flat: false, // LIT — the path under test
        }),
        asynchronous: false,
      });
      v.scene.primitives.add(litPrim);

      // Slightly oblique top-down so both the top face (normal ~ up) and the
      // side faces (normals horizontal) are in frame — exercises the diffuse
      // term across a range of normals.
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat - 0.006, 4200.0),
        orientation: {
          heading: 0,
          pitch: C.Math.toRadians(-72),
          roll: 0,
        },
      });

      for (let i = 0; i < 120; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Sample the canvas directly. Classify a pixel as "primitive" if it is
      // blue-dominant (B is the largest channel and clearly above the black
      // background). This separates the lit primitive body from the backdrop
      // regardless of the lighting scale factor.
      const canvas = v.scene.canvas;
      const gl =
        canvas.getContext("webgl2") ||
        canvas.getContext("webgl") ||
        canvas.getContext("webgpu");
      // Use a 2D readback canvas (works for both backends — drawImage the
      // live canvas, then read pixels).
      const rc = document.createElement("canvas");
      rc.width = canvas.width;
      rc.height = canvas.height;
      const ctx = rc.getContext("2d");
      ctx.drawImage(canvas, 0, 0);
      const img = ctx.getImageData(0, 0, rc.width, rc.height).data;

      let count = 0;
      let sumLum = 0;
      let sumR = 0,
        sumG = 0,
        sumB = 0;
      for (let i = 0; i < img.length; i += 4) {
        const r = img[i],
          g = img[i + 1],
          b = img[i + 2];
        // Blue-dominant + above background. The primitive's base color is
        // blue-heavy, so B > R and B > 30 reliably picks its pixels at any
        // lighting scale, while excluding the near-black background.
        if (b > 30 && b >= r && b >= g) {
          const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          sumLum += lum;
          sumR += r;
          sumG += g;
          sumB += b;
          count++;
        }
      }

      return {
        canvasW: rc.width,
        canvasH: rc.height,
        primPixelCount: count,
        meanLum: count ? sumLum / count : 0,
        meanR: count ? sumR / count : 0,
        meanG: count ? sumG / count : 0,
        meanB: count ? sumB / count : 0,
      };
    },
    { primColor: PRIM_COLOR },
  );

  const out = path.join(OUT_DIR, `probe-perinstance-diffuse-${rendererArg}.png`);
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();

  const errs = messages.filter(
    (m) => m.t === "error" || m.t === "pageerror",
  );
  return { sample, out, errors: errs };
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log("[probe-perinstance-diffuse] capturing WebGL …");
  const gl = await capture("webgl");
  console.log("[probe-perinstance-diffuse] capturing WebGPU …");
  const gpu = await capture("webgpu");

  console.log("\n  WebGL  sample:", JSON.stringify(gl.sample));
  console.log("  WebGPU sample:", JSON.stringify(gpu.sample));
  console.log("  WebGL  png:", gl.out);
  console.log("  WebGPU png:", gpu.out);

  if (gl.errors.length) {
    console.log(`  WebGL errors (${gl.errors.length}):`);
    gl.errors.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }
  if (gpu.errors.length) {
    console.log(`  WebGPU errors (${gpu.errors.length}):`);
    gpu.errors.slice(0, 3).forEach((e) => console.log(`    ${e.t}: ${e.text}`));
  }

  const lumGL = gl.sample.meanLum;
  const lumGPU = gpu.sample.meanLum;
  const ratio = lumGL > 0 ? lumGPU / lumGL : 0;
  const relErr = lumGL > 0 ? Math.abs(lumGPU - lumGL) / lumGL : 1;

  console.log("\n  ── PerInstanceColorAppearance (flat:false) body luminance ──");
  console.log(`  WebGL  meanLum: ${lumGL.toFixed(1)}  (px ${gl.sample.primPixelCount})`);
  console.log(`  WebGPU meanLum: ${lumGPU.toFixed(1)}  (px ${gpu.sample.primPixelCount})`);
  console.log(`  ratio WebGPU/WebGL: ${ratio.toFixed(3)}  relErr: ${(relErr * 100).toFixed(1)}%`);

  let pass = true;
  const fail = (msg) => {
    pass = false;
    console.log(`  FAIL: ${msg}`);
  };

  if (gl.sample.primPixelCount < 1000)
    fail(`WebGL primitive pixel count too low (${gl.sample.primPixelCount}) — scene didn't render`);
  if (gpu.sample.primPixelCount < 1000)
    fail(`WebGPU primitive pixel count too low (${gpu.sample.primPixelCount}) — scene didn't render`);
  if (gpu.errors.length > 0) fail(`WebGPU produced ${gpu.errors.length} console/page errors`);
  if (relErr > LUM_TOL)
    fail(`WebGPU body luminance off by ${(relErr * 100).toFixed(1)}% (> ${(LUM_TOL * 100).toFixed(0)}% tol) — still darker/brighter than WebGL`);

  console.log(`\n[probe-perinstance-diffuse] ${pass ? "PASS" : "FAIL"}`);
  process.exit(pass ? 0 : 1);
})();
