#!/usr/bin/env node
/**
 * Probe: polyline appearance/material LOG-DEPTH correctness vs the globe
 * (C2-13 / 376c, NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU).
 *
 * WHAT 376c FIXES: the WebGPU polyline appearance + material pipelines wrote
 * HYPERBOLIC @builtin(frag_depth) while the WebGPU globe writes LOGARITHMIC
 * depth (scene.logarithmicDepthBuffer defaults TRUE). At a far camera the two
 * encodings diverge sharply for the same world point, so a surface-height
 * appearance polyline z-fought / sank into the globe instead of resting on it.
 * 376c adds the csm log-depth recipe to all 6 polyline shaders + a logDepth
 * lane in the 512B camera UB + a LOG_DEPTH pipeline define-flip, so the
 * polyline now writes log depth that matches the globe.
 *
 * VERIFICATION: globe ON (log-depth ON), a surface-height (h=0) CYAN
 * PolylineColorAppearance + a MAGENTA PolylineMaterialAppearance(Glow) draped
 * over the ellipsoid, viewed from a FAR oblique camera. WebGL renders
 * appearance polylines with correct log depth → it is the gold reference. If
 * WebGPU now matches WebGL's colored-pixel count (line rests on the globe, not
 * occluded), the depth encodings align. Also asserts the polyline caches
 * actually built with LOG_DEPTH active.
 *
 * GATE:
 *   - webgl draws the lines (reference)
 *   - webgpu draws the lines, within 15% of webgl (depths aligned)
 *   - both polyline caches report logDepthEnabled === true (define activated)
 *   - no NEW webgpu device errors (the known AtmosphereLUT BGL incompat is filtered)
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-polyline-appearance-logdepth.mjs
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
    // Globe ON — this is the whole point (its log depth is what the polyline
    // must match). Kill sky/atmosphere noise so colored-pixel counting is clean.
    s.globe.show = true;
    s.skyBox.show = false;
    if (s.sun) s.sun.show = false;
    if (s.moon) s.moon.show = false;
    s.skyAtmosphere.show = false;
    s.globe.showGroundAtmosphere = false;
    s.backgroundColor = C.Color.BLACK;
    s.globe.baseColor = C.Color.fromBytes(40, 40, 40); // dark grey globe

    const logDepthOn = s.logarithmicDepthBuffer;

    // Surface-height (h=0) lines draped on the ellipsoid — the depth-mismatch
    // sharp case. A long path so it spans a wide depth range under the oblique
    // far camera.
    const cyanPos = C.Cartesian3.fromDegreesArrayHeights([
      -100.0, 40.0, 0.0, -95.0, 38.0, 0.0, -90.0, 41.0, 0.0, -85.0, 38.0, 0.0,
      -80.0, 40.0, 0.0,
    ]);
    const colorPrim = s.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolylineGeometry({
            positions: cyanPos,
            width: 10.0,
            arcType: C.ArcType.GEODESIC,
            vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(0.0, 1.0, 1.0, 1.0),
            ),
          },
        }),
        appearance: new C.PolylineColorAppearance({ translucent: false }),
        asynchronous: false,
      }),
    );

    const glowPos = C.Cartesian3.fromDegreesArrayHeights([
      -100.0, 36.0, 0.0, -90.0, 34.0, 0.0, -80.0, 36.0, 0.0,
    ]);
    const glowPrim = s.primitives.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolylineGeometry({
            positions: glowPos,
            width: 14.0,
            arcType: C.ArcType.GEODESIC,
            vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
          }),
        }),
        appearance: new C.PolylineMaterialAppearance({
          material: C.Material.fromType("PolylineGlow", {
            color: new C.Color(1.0, 0.0, 1.0, 1.0), // magenta
            glowPower: 0.25,
            taperPower: 1.0,
          }),
          translucent: false,
        }),
        asynchronous: false,
      }),
    );

    // FAR oblique camera framing the line centroid — log depth's precision
    // regime (6000km range) while guaranteeing the front-facing surface lines
    // are on screen. lookAt the centroid so we can't miss the geometry.
    const centroid = C.Cartesian3.fromDegrees(-90.0, 38.0, 0.0);
    v.camera.lookAt(
      centroid,
      new C.HeadingPitchRange(
        C.Math.toRadians(0.0),
        C.Math.toRadians(-30.0),
        6_000_000.0,
      ),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    for (let i = 0; i < 140; i++) {
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
    let cyan = 0,
      magenta = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        g = px[i + 1],
        b = px[i + 2];
      if (b > 180 && g > 180 && r < 90) cyan++;
      if (r > 150 && b > 150 && g < 110) magenta++;
    }

    return {
      renderer: s.context?.rendererType,
      logDepthOn,
      colorReady: colorPrim.ready,
      glowReady: glowPrim.ready,
      cyan,
      magenta,
      // Did the caches build with LOG_DEPTH active?
      colorLogDepth: colorPrim._webgpuPolylineCache?.logDepthEnabled ?? null,
      glowLogDepth: glowPrim._webgpuPolylineMatCache?.logDepthEnabled ?? null,
      width: w,
      height: h,
    };
  });

  const buf = await page.screenshot({ omitBackground: false });
  const out = `Tools/visual-regression/output/polyline-logdepth-${renderer}.png`;
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

  const cyanRatio =
    wgl.render.cyan > 0 ? wgpu.render.cyan / wgl.render.cyan : 0;
  const magRatio =
    wgl.render.magenta > 0 ? wgpu.render.magenta / wgl.render.magenta : 0;

  const checks = [
    ["webgl draws the cyan appearance line (reference)", wgl.render.cyan > 200],
    ["webgl draws the magenta glow line (reference)", wgl.render.magenta > 200],
    [
      "webgpu draws the cyan line over the globe (depth aligned, not occluded)",
      wgpu.render.cyan > 200,
    ],
    [
      "webgpu draws the magenta glow line over the globe",
      wgpu.render.magenta > 200,
    ],
    [
      `webgpu cyan within 15% of webgl (ratio=${cyanRatio.toFixed(3)})`,
      cyanRatio >= 0.85 && cyanRatio <= 1.15,
    ],
    [
      `webgpu magenta within 20% of webgl (ratio=${magRatio.toFixed(3)})`,
      magRatio >= 0.8 && magRatio <= 1.2,
    ],
    [
      "scene log-depth is ON (the regime under test)",
      wgpu.render.logDepthOn === true,
    ],
    [
      "webgpu color cache built with LOG_DEPTH active",
      wgpu.render.colorLogDepth === true,
    ],
    [
      "webgpu glow cache built with LOG_DEPTH active",
      wgpu.render.glowLogDepth === true,
    ],
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
