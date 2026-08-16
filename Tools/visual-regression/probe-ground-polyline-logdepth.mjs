#!/usr/bin/env node
/**
 * Probe: GroundPolylinePrimitive classifier LOG-DEPTH reverse
 * (Q18-LOGDEPTH-CONSUMERS / NEW-LOG-DEPTH-REMAINING-CONSUMERS).
 * @purpose Gates the GroundPolyline classifier's log-depth reversal: magenta draped line at a far camera must match WebGL within 25% with the FR cache built
 * @status ACTIVE
 *
 * WHAT THIS FIXES: the WebGPU GroundPolyline classifier FS reconstructs the
 * terrain fragment's eye-space position from the sampled globe-depth texture
 * (windowToEyeCoordinates). The globe log-encodes that depth texture
 * (scene.logarithmicDepthBuffer defaults TRUE) but the classifier was
 * inverse-projecting the raw LOG value as if it were hyperbolic NDC z, so the
 * reconstructed eye point was wildly wrong (~1e12 m). That corrupts the
 * per-fragment width test + plane-distance tests, so at a FAR camera (large
 * frustum = log precision regime) the ground polyline is drawn at the wrong
 * width or culled entirely vs WebGL. The fix reverses the log encode with the
 * globe's ENCODE frustum before reconstructing (mirrors GroundPrimitive
 * Batch-173/185).
 *
 * VERIFICATION: a MAGENTA GroundPolylinePrimitive draped on the ellipsoid,
 * dark globe, sky/atmosphere off, viewed from a FAR oblique camera. WebGL is
 * the gold reference (its classifier reverses log depth correctly). If WebGPU
 * now draws the ground polyline over the globe with a magenta-pixel count
 * within tolerance of WebGL, the eye-space reconstruction is correct.
 *
 * GATE:
 *   - webgl draws the ground line (reference)
 *   - webgpu draws the ground line, within 25% of webgl (recon correct)
 *   - scene log-depth is ON (the regime under test)
 *   - the webgpu ground-polyline cache built (FR ran)
 *   - no NEW webgpu device errors (known AtmosphereLUT BGL incompat filtered)
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-ground-polyline-logdepth.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const ATMO_LUT_RE =
  /AtmosphereLUT|default layout|atmosphereLUT|SkyAtmosphere LUT/;

async function captureRenderer(renderer, fs) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text());
  });
  page.on("pageerror", (e) => errs.push("PAGEERR:" + e.message));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const render = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer,
      s = v.scene;
    s.globe.show = true;
    s.skyBox.show = false;
    if (s.sun) s.sun.show = false;
    if (s.moon) s.moon.show = false;
    s.skyAtmosphere.show = false;
    s.globe.showGroundAtmosphere = false;
    s.backgroundColor = C.Color.BLACK;
    s.globe.baseColor = C.Color.fromBytes(40, 40, 40);

    const logDepthOn = s.logarithmicDepthBuffer;

    await C.GroundPolylinePrimitive.initializeTerrainHeights();

    // A long ground-clamped path — spans a wide depth range under the
    // oblique far camera, so the classifier's eye-recon precision matters.
    const positions = C.Cartesian3.fromDegreesArray([
      -100.0, 40.0, -95.0, 38.0, -90.0, 41.0, -85.0, 38.0, -80.0, 40.0,
    ]);
    const prim = new C.GroundPolylinePrimitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.GroundPolylineGeometry({ positions, width: 12.0 }),
        attributes: {
          color: C.ColorGeometryInstanceAttribute.fromColor(
            new C.Color(1.0, 0.0, 1.0, 1.0), // magenta
          ),
        },
        id: "logdepth-ground-line",
      }),
      appearance: new C.PolylineColorAppearance({ translucent: false }),
      classificationType: C.ClassificationType.BOTH,
      asynchronous: false,
    });
    s.groundPrimitives.add(prim);

    const centroid = C.Cartesian3.fromDegrees(-90.0, 39.0, 0.0);
    v.camera.lookAt(
      centroid,
      new C.HeadingPitchRange(
        C.Math.toRadians(0.0),
        C.Math.toRadians(-30.0),
        6_000_000.0,
      ),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    const start = performance.now();
    while (!prim._ready && performance.now() - start < 12_000) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    for (let i = 0; i < 160; i++) {
      s.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    const canvas = s.canvas,
      w = canvas.width,
      h = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const cx = tmp.getContext("2d");
    cx.drawImage(canvas, 0, 0);
    const px = cx.getImageData(0, 0, w, h).data;
    let magenta = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        g = px[i + 1],
        b = px[i + 2];
      if (r > 150 && b > 150 && g < 110) magenta++;
    }

    const ctx = s.context;
    const fr = ctx.getFeatureRenderer ? ctx.getFeatureRenderer(41) : null;

    return {
      renderer: ctx?.rendererType,
      logDepthOn,
      ready: prim._ready,
      magenta,
      frPresent: !!fr,
      cacheCreated: !!prim._webgpuPolylineCache,
      width: w,
      height: h,
    };
  });

  const buf = await page.screenshot({ omitBackground: false });
  const out = `Tools/visual-regression/output/ground-polyline-logdepth-${renderer}.png`;
  fs.writeFileSync(out, buf);
  await browser.close();
  const newErrs = errs.filter((e) => !ATMO_LUT_RE.test(e));
  return { render, out, newErrs };
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  const wgl = await captureRenderer("webgl", fs);
  const wgpu = await captureRenderer("webgpu", fs);

  console.log("WEBGL :", JSON.stringify(wgl.render));
  console.log("  PNG:", wgl.out);
  console.log("WEBGPU:", JSON.stringify(wgpu.render));
  console.log("  PNG:", wgpu.out);
  if (wgpu.newErrs.length)
    console.log("  webgpu NEW errs:", wgpu.newErrs.slice(0, 4));

  const magRatio =
    wgl.render.magenta > 0 ? wgpu.render.magenta / wgl.render.magenta : 0;

  const checks = [
    ["webgl draws the ground line (reference)", wgl.render.magenta > 200],
    [
      "webgpu draws the ground line over the globe (recon correct, not culled)",
      wgpu.render.magenta > 200,
    ],
    [
      `webgpu magenta within 25% of webgl (ratio=${magRatio.toFixed(3)})`,
      magRatio >= 0.75 && magRatio <= 1.25,
    ],
    [
      "scene log-depth is ON (the regime under test)",
      wgpu.render.logDepthOn === true,
    ],
    ["webgpu ground-polyline FR present", wgpu.render.frPresent === true],
    ["webgpu ground-polyline cache built", wgpu.render.cacheCreated === true],
    [
      "no NEW webgpu device errors (AtmosphereLUT filtered)",
      wgpu.newErrs.length === 0,
    ],
  ];

  let pass = true;
  console.log("\n=== ANALYSIS ===");
  for (const [label, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
    if (!ok) pass = false;
  }
  console.log(`\nRESULT: ${pass ? "GREEN" : "RED"}`);
  process.exitCode = pass ? 0 : 1;
})();
