#!/usr/bin/env node
/**
 * Probe: polyline `Primitive` + `PolylineColorAppearance` parity on WebGPU vs
 * WebGL (NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU, COLOR slice).
 *
 * ROOT CAUSE this verifies: WebGPUPrimitiveShaders.selectWebGPUShader only
 * inspected normal/st -> picked the "basic" shader; the basic vertex packer
 * dropped the polyline attributes (prev/next position + expandAndWidth), so
 * the 4 coincident quad vertices collapsed to one clip point -> degenerate
 * triangles -> 0px. The fix routes PolylineGeometry+PolylineColorAppearance
 * through a dedicated packer + polyline appearance shader that expands the
 * quads into a screen-space ribbon.
 *
 * The probe adds a high-contrast CYAN polyline (width 8) over a
 * PolylineGeometry with PolylineColorAppearance, on the WebGPU viewer
 * (renderer=webgpu) AND the WebGL viewer (renderer=webgl), at a fixed
 * camera/clock that frames the line. Two passes: arcType GEODESIC then NONE.
 * Counts cyan pixels (b>200 && g>200 && r<80) on each.
 *
 * GATE:
 *   - BEFORE fix:  webgpu cyan ~= 0   (reproduces the 0px symptom)
 *                  webgl  cyan  > N   (reference)
 *   - AFTER fix:   webgpuCyan / webglCyan within ~15%
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-polyline-appearance-primitive.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function captureRender(page, arcTypeName) {
  return page.evaluate(async (arcTypeName) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.show = false;
    v.scene.skyBox.show = false;
    v.scene.sun.show = false;
    v.scene.moon.show = false;
    v.scene.skyAtmosphere.show = false;
    v.scene.backgroundColor = C.Color.BLACK;

    // Remove any prior primitives (Primitive instances we added).
    const prims = v.scene.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims.get(i);
      if (p && p.constructor && p.constructor.name === "Primitive") {
        prims.remove(p);
      }
    }

    // A zig-zag line so miters are exercised, in a small lat/lon box.
    const positions = C.Cartesian3.fromDegreesArray([
      -75.0, 35.0, -74.0, 36.0, -73.0, 35.0, -72.0, 36.0, -71.0, 35.0,
    ]);

    const arcType =
      arcTypeName === "NONE" ? C.ArcType.NONE : C.ArcType.GEODESIC;

    const primitive = prims.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolylineGeometry({
            positions: positions,
            width: 8.0,
            arcType: arcType,
            vertexFormat: C.PolylineColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            // High-contrast CYAN (r=0, g=1, b=1).
            color: C.ColorGeometryInstanceAttribute.fromColor(
              new C.Color(0.0, 1.0, 1.0, 1.0),
            ),
          },
        }),
        appearance: new C.PolylineColorAppearance({
          translucent: false,
        }),
        asynchronous: false,
      }),
    );

    // Frame the line from straight above.
    const center = C.Cartesian3.fromDegrees(-73.0, 35.5, 0.0);
    v.camera.lookAt(
      center,
      new C.HeadingPitchRange(
        0.0,
        C.Math.toRadians(-90.0),
        300000.0,
      ),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    let ready = false;
    for (let i = 0; i < 120; i++) {
      v.scene.render();
      // Primitive.ready flips true after the first few async-off renders.
      if (primitive.ready) ready = true;
      await new Promise((res) => requestAnimationFrame(res));
    }

    const canvas = v.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(canvas, 0, 0);
    const px = tctx.getImageData(0, 0, w, h).data;

    let cyan = 0;
    let nonBlack = 0;
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      if (r > 10 || g > 10 || b > 10) nonBlack++;
      if (b > 200 && g > 200 && r < 80) cyan++;
    }

    return {
      renderer: v.scene.context?.rendererType,
      primitiveReady: ready,
      arcType: arcTypeName,
      width: w,
      height: h,
      cyan,
      nonBlack,
    };
  }, arcTypeName);
}

async function captureRenderer(renderer, arcTypeName, fs) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  await armWebGPUDevices(page);

  const render = await captureRender(page, arcTypeName);
  const buf = await page.screenshot({ omitBackground: false });
  const out = `Tools/visual-regression/output/polyline-appearance-${renderer}-${arcTypeName}.png`;
  fs.writeFileSync(out, buf);
  console.log(`  [${renderer}/${arcTypeName}] ${JSON.stringify(render)}`);
  console.log(`    PNG: ${out} (${buf.length} bytes)`);

  const gate = await collectGateErrors(page);
  await browser.close();
  return { render, gate, consoleErrors };
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  const results = {};
  for (const arcTypeName of ["GEODESIC", "NONE"]) {
    results[arcTypeName] = {};
    for (const renderer of ["webgl", "webgpu"]) {
      console.log(`\n=== Capturing ${renderer.toUpperCase()} / ${arcTypeName} ===`);
      results[arcTypeName][renderer] = await captureRenderer(
        renderer,
        arcTypeName,
        fs,
      );
      const g = results[arcTypeName][renderer].gate;
      console.log(
        `GATE: armed=${g.armedDevices} uncaptured=${g.errors.length} deviceLost=${g.deviceLost || "no"}`,
      );
      if (g.errors.length) console.log("  gate errors:", g.errors.slice(0, 6));
    }
  }

  console.log(`\n=== ANALYSIS ===`);
  const checks = [];
  for (const arcTypeName of ["GEODESIC", "NONE"]) {
    const wgl = results[arcTypeName].webgl.render;
    const wgpu = results[arcTypeName].webgpu.render;
    console.log(
      `[${arcTypeName}] webgl cyan=${wgl.cyan}  webgpu cyan=${wgpu.cyan}`,
    );

    // WebGL must draw a meaningful number of cyan pixels (reference).
    checks.push([
      `[${arcTypeName}] webgl draws the cyan line (reference)`,
      wgl.cyan > 200,
    ]);
    // WebGPU must draw cyan (fix landed — not 0px).
    checks.push([
      `[${arcTypeName}] webgpu draws the cyan line (fix landed, not 0px)`,
      wgpu.cyan > 200,
    ]);
    // Parity within ~15%.
    const ratio = wgl.cyan > 0 ? wgpu.cyan / wgl.cyan : 0;
    checks.push([
      `[${arcTypeName}] webgpu cyan within 15% of webgl (ratio=${ratio.toFixed(3)})`,
      ratio >= 0.85 && ratio <= 1.15,
    ]);
    // No WebGPU device errors.
    checks.push([
      `[${arcTypeName}] no uncaptured WebGPU errors`,
      (results[arcTypeName].webgpu.gate.errors.length ?? 0) === 0 &&
        !results[arcTypeName].webgpu.gate.deviceLost,
    ]);
  }

  let allPass = true;
  for (const [label, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
    if (!ok) allPass = false;
  }
  console.log(`\nRESULT: ${allPass ? "GREEN" : "RED"}`);
  process.exitCode = allPass ? 0 : 1;
})();
