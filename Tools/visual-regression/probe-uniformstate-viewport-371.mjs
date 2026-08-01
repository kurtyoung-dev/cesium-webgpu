#!/usr/bin/env node
/**
 * Probe: NEW-WEBGPU-UNIFORMSTATE-VIEWPORT (backlog item 371).
 *
 * ROOT CAUSE this verifies: UniformState.viewport is only ever seeded by the
 * WebGL RenderState.applyViewport path (gl.viewport). The WebGPU render path
 * never set it, so uniformState.viewportOrthographic / viewportTransformation
 * stayed at IDENTITY on WebGPU. The fix seeds uniformState.viewport once per
 * frame in WebGPUContext.beginFrame using its context-owned clip convention.
 *
 * This probe asserts, on BOTH backends, that after a render:
 *   - uniformState.viewport.{width,height} == canvas drawingBuffer size
 *   - uniformState.viewportTransformation is NON-identity and matches WebGL
 *     within a tight float epsilon (this matrix is depth-range-agnostic)
 *   - uniformState.viewportOrthographic is NON-identity on WebGPU
 *
 * It ALSO re-runs the polyline-appearance pixel check inline (the original
 * regression surface) to prove the screen-space ribbon still renders.
 *
 * GATE:
 *   - BEFORE fix:  webgpu viewportTransformation == IDENTITY (FAIL / RED)
 *   - AFTER fix:   webgpu viewportTransformation != IDENTITY, matches webgl,
 *                  viewport size == canvas size, no uncaptured WebGPU errors.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-uniformstate-viewport-371.mjs
 */
import { chromium } from "playwright";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

// 4x4 identity, column-major (how Matrix4.toArray emits).
const IDENTITY16 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

async function captureViewportState(page) {
  return page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.show = false;
    v.scene.skyBox.show = false;
    v.scene.sun.show = false;
    v.scene.moon.show = false;
    v.scene.skyAtmosphere.show = false;
    v.scene.backgroundColor = C.Color.BLACK;

    // Add a screen-space polyline (the original regression surface) so the
    // viewport transform is actually exercised by a draw.
    const prims = v.scene.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims.get(i);
      if (p && p.constructor && p.constructor.name === "Primitive") {
        prims.remove(p);
      }
    }
    const positions = C.Cartesian3.fromDegreesArray([
      -75.0, 35.0, -74.0, 36.0, -73.0, 35.0, -72.0, 36.0, -71.0, 35.0,
    ]);
    const primitive = prims.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolylineGeometry({
            positions: positions,
            width: 8.0,
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

    const center = C.Cartesian3.fromDegrees(-73.0, 35.5, 0.0);
    v.camera.lookAt(
      center,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-90.0), 300000.0),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    for (let i = 0; i < 120; i++) {
      v.scene.render();
      await new Promise((res) => requestAnimationFrame(res));
    }

    const us = v.scene.context.uniformState;
    // Read the matrices via the getters that triggered the bug.
    const vt = C.Matrix4.toArray(us.viewportTransformation);
    const vo = C.Matrix4.toArray(us.viewportOrthographic);
    const vp = us.viewport;

    // Cyan-pixel count to confirm the screen-space ribbon still renders.
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
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 2] > 200 && px[i + 1] > 200 && px[i] < 80) cyan++;
    }

    return {
      renderer: v.scene.context?.rendererType,
      canvasWidth: w,
      canvasHeight: h,
      viewport: vp
        ? { x: vp.x, y: vp.y, width: vp.width, height: vp.height }
        : null,
      viewportTransformation: vt,
      viewportOrthographic: vo,
      primitiveReady: !!primitive.ready,
      cyan,
    };
  });
}

async function captureRenderer(renderer) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({
    viewport: { width: 1024, height: 768 },
  });
  const consoleErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push("PAGEERR:" + e.message));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });

  const state = await captureViewportState(page);
  const buf = await page.screenshot({ omitBackground: false });
  const out = `Tools/visual-regression/output/uniformstate-viewport-371-${renderer}.png`;
  const fs = await import("fs");
  fs.writeFileSync(out, buf);
  console.log(
    `  [${renderer}] viewport=${JSON.stringify(state.viewport)} canvas=${state.canvasWidth}x${state.canvasHeight} cyan=${state.cyan}`,
  );
  console.log(
    `    vt=${state.viewportTransformation.map((n) => n.toFixed(2)).join(",")}`,
  );
  console.log(`    PNG: ${out} (${buf.length} bytes)`);

  await browser.close();
  return { state, consoleErrors };
}

function isIdentity(m) {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(m[i] - IDENTITY16[i]) > 1e-6) return false;
  }
  return true;
}

function matricesClose(a, b, eps) {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a[i] - b[i]) > eps) return false;
  }
  return true;
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  const results = {};
  for (const renderer of ["webgl", "webgpu"]) {
    console.log(`\n=== Capturing ${renderer.toUpperCase()} ===`);
    results[renderer] = await captureRenderer(renderer);
    const errs = results[renderer].consoleErrors;
    console.log(`  console errors: ${errs.length}`);
    if (errs.length) console.log("  errors:", errs.slice(0, 6));
  }

  console.log(`\n=== ANALYSIS ===`);
  const wgl = results.webgl.state;
  const wgpu = results.webgpu.state;
  const checks = [];

  // 1. WebGPU viewport rect must equal the canvas drawing buffer.
  checks.push([
    `webgpu viewport == canvas size (${wgpu.viewport?.width}x${wgpu.viewport?.height} vs ${wgpu.canvasWidth}x${wgpu.canvasHeight})`,
    !!wgpu.viewport &&
      wgpu.viewport.width === wgpu.canvasWidth &&
      wgpu.viewport.height === wgpu.canvasHeight,
  ]);

  // 2. WebGPU viewportTransformation must be NON-identity (the core bug).
  checks.push([
    `webgpu viewportTransformation is NON-identity`,
    !isIdentity(wgpu.viewportTransformation),
  ]);

  // 3. WebGPU viewportOrthographic must be NON-identity (depth-range branch).
  checks.push([
    `webgpu viewportOrthographic is NON-identity`,
    !isIdentity(wgpu.viewportOrthographic),
  ]);

  // 4. WebGPU viewportTransformation must MATCH WebGL (depth-range-agnostic).
  checks.push([
    `webgpu viewportTransformation matches webgl (eps 1e-3)`,
    matricesClose(
      wgpu.viewportTransformation,
      wgl.viewportTransformation,
      1e-3,
    ),
  ]);

  // 5. Screen-space ribbon still renders on WebGPU (no regression).
  checks.push([
    `webgpu polyline ribbon still renders (cyan=${wgpu.cyan} > 200)`,
    wgpu.cyan > 200,
  ]);

  // 6. No console errors on WebGPU.
  checks.push([
    `no WebGPU console errors (${results.webgpu.consoleErrors.length})`,
    results.webgpu.consoleErrors.length === 0,
  ]);

  let allPass = true;
  for (const [label, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
    if (!ok) allPass = false;
  }
  console.log(`\nRESULT: ${allPass ? "GREEN" : "RED"}`);
  process.exitCode = allPass ? 0 : 1;
})();
