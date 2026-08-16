#!/usr/bin/env node
/**
 * Probe: per-edge color parity on WebGPU vs WebGL
 * (NEW-EDGE-MATERIALCOLOR-OVERRIDE-WEBGPU, Batch 330).
 * @purpose Per-edge color parity: WebGPU edge WGSL gains a per-edge edgeColor vertex attribute; COLOR_0-blue GLB edges render blue on both backends.
 * @status ACTIVE
 *
 * Before this batch the WebGPU model-edge emitter applied a SINGLE
 * primitive-level `EdgeUniforms.color`, so per-edge / per-lineString
 * `materialColor` overrides AND per-vertex COLOR_0 all collapsed to one
 * color. WebGL carries per-edge color in the `a_edgeColor` vertex
 * attribute (override -> vertex color -> no-override sentinel). This batch
 * adds the WebGPU equivalent: a per-edge `@location(7) edgeColor` vertex
 * attribute fed through the edge instance buffer + the edge WGSL.
 *
 * Two checks:
 *
 *   A) RENDER — load `EdgeVisibilityMaterial.glb` (carries a COLOR_0
 *      attribute = solid BLUE [0,0,1,1] across all 210 vertices) as a
 *      standalone Model with `color = GRAY` and `EDGES_ONLY` mode (surface
 *      suppressed; only the extension edges render). With the fix the edges
 *      sample COLOR_0 -> BLUE; before the fix they rendered the single
 *      uniform color (GRAY model color). Assert the WebGPU edge pixels are
 *      BLUE-dominant (b >> r, b >> g) and match WebGL.
 *
 * The DISTINCT-override path (primitive-level / per-lineString
 * `materialColor`) that the bundled GLBs don't author is covered by the
 * Jasmine spec `WebGPUEdgeVisibilityEmitterSpec.js` (the emitter's internal
 * `extractEdgeGeometry` export isn't on the public Cesium barrel, so it's
 * asserted in-suite rather than in this in-page probe).
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-edge-percolor.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const MODEL_URL =
  "/Specs/Data/Models/glTF-2.0/EdgeVisibility/glTF-Binary/EdgeVisibilityMaterial.glb";

// EdgeDisplayMode: SURFACES_ONLY 0, SURFACES_AND_EDGES 1, EDGES_ONLY 2.
const EDGES_ONLY = 2;

async function captureRender(page, edgesOnly) {
  return page.evaluate(async (edgesOnly) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.show = false;
    v.scene.skyBox.show = false;
    v.scene.sun.show = false;
    v.scene.backgroundColor = C.Color.BLACK;

    const prims = v.scene.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims.get(i);
      if (p && p.constructor && p.constructor.name === "Model") {
        prims.remove(p);
      }
    }

    const origin = C.Cartesian3.fromDegrees(-123.0744619, 44.0503706, 0.0);
    const modelMatrix = C.Transforms.headingPitchRollToFixedFrame(
      origin,
      new C.HeadingPitchRoll(0.0, 0.0, 0.0),
    );
    const model = v.scene.primitives.add(
      await C.Model.fromGltfAsync({
        url: window.__EDGE_MODEL_URL__,
        modelMatrix,
        // Distinctly NON-blue surface color: if the fix is absent the edges
        // would render this GRAY (the single uniform color), not blue.
        color: C.Color.GRAY,
      }),
    );
    model.edgeDisplayMode = edgesOnly;

    await new Promise((resolve) => {
      if (model.ready) resolve();
      else model.readyEvent.addEventListener(() => resolve());
    });

    const center = model.boundingSphere.center;
    const r = model.boundingSphere.radius;
    v.camera.lookAt(
      center,
      new C.HeadingPitchRange(
        C.Math.toRadians(230.0),
        C.Math.toRadians(-20.0),
        r * 4.0,
      ),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    for (let i = 0; i < 90; i++) {
      v.scene.render();
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

    // The model fills the central region; the sky gradient is at the top
    // and the mouse-help panel is top-right. Restrict the scan to a center
    // box (and exclude the very top to drop the sky) so we measure the
    // cylinder's edges, not chrome.
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const half = Math.floor(Math.min(w, h) * 0.32);
    const x0 = Math.max(0, cx - half);
    const x1 = Math.min(w, cx + half);
    const y0 = Math.max(0, cy - half);
    const y1 = Math.min(h, cy + half);

    // Count CHROMATIC edge pixels only (a strong color channel, not the
    // white stars and not pure black sky). An edge pixel here is one whose
    // dominant channel clearly exceeds the others. Classify each by which
    // channel dominates so we can tell "blue edges" (COLOR_0 reached the
    // FS) apart from "gray edges" (the pre-fix single-uniform fallback).
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let chroma = 0; // chromatic (clearly-colored) edge pixels
    let blueDom = 0;
    let grayish = 0; // colored-but-gray (near-equal channels, above black)
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        const rr = px[i];
        const gg = px[i + 1];
        const bb = px[i + 2];
        const mx = Math.max(rr, gg, bb);
        const mn = Math.min(rr, gg, bb);
        if (mx < 30) continue; // background / near-black
        // A "lit, near-gray" pixel (white star / gray surface): channels
        // within 30 of each other.
        if (mx - mn < 30) {
          grayish++;
          continue;
        }
        // Chromatic edge pixel.
        chroma++;
        rSum += rr;
        gSum += gg;
        bSum += bb;
        if (bb >= rr && bb >= gg) blueDom++;
      }
    }
    return {
      renderer: v.scene.context?.rendererType,
      modelReady: model.ready,
      edgeDisplayMode: model.edgeDisplayMode,
      chroma,
      grayish,
      avgChromaRGB: chroma
        ? [
            Math.round(rSum / chroma),
            Math.round(gSum / chroma),
            Math.round(bSum / chroma),
          ]
        : null,
      blueDomPct: chroma ? Number(((blueDom / chroma) * 100).toFixed(1)) : 0,
    };
  }, edgesOnly);
}

async function captureRenderer(renderer, fs) {
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
  await page.addInitScript((url) => {
    window.__EDGE_MODEL_URL__ = url;
  }, MODEL_URL);

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  await armWebGPUDevices(page);

  const render = await captureRender(page, EDGES_ONLY);
  const buf = await page.screenshot({ omitBackground: false });
  const out = `Tools/visual-regression/output/edge-percolor-${renderer}.png`;
  fs.writeFileSync(out, buf);
  console.log(`  [${renderer}] render: ${JSON.stringify(render)}`);
  console.log(`    PNG: ${out} (${buf.length} bytes)`);

  const gate = await collectGateErrors(page);
  await browser.close();
  return { render, gate, consoleErrors };
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  const caps = {};
  for (const renderer of ["webgl", "webgpu"]) {
    console.log(`\n=== Capturing ${renderer.toUpperCase()} ===`);
    caps[renderer] = await captureRenderer(renderer, fs);
    const g = caps[renderer].gate;
    console.log(
      `GATE: armed=${g.armedDevices} uncaptured=${g.errors.length} deviceLost=${g.deviceLost || "no"}`,
    );
    if (g.errors.length) console.log("  gate errors:", g.errors.slice(0, 6));
  }

  console.log(`\n=== ANALYSIS ===`);
  const wgl = caps.webgl.render;
  const wgpu = caps.webgpu.render;
  console.log(
    `webgl  chroma=${wgl.chroma} avgChromaRGB=${JSON.stringify(wgl.avgChromaRGB)} blueDom=${wgl.blueDomPct}%`,
  );
  console.log(
    `webgpu chroma=${wgpu.chroma} avgChromaRGB=${JSON.stringify(wgpu.avgChromaRGB)} blueDom=${wgpu.blueDomPct}%`,
  );

  const blueAvg = (c) =>
    !!c.avgChromaRGB &&
    c.avgChromaRGB[2] >= c.avgChromaRGB[0] + 30 &&
    c.avgChromaRGB[2] >= c.avgChromaRGB[1] + 30;

  const checks = [];
  // 1. WebGPU edges are blue (per-vertex COLOR_0 reached the FS, not the
  //    gray model.color the pre-fix single-uniform path would draw).
  checks.push([
    "webgpu has chromatic blue edges (COLOR_0 reached the edge FS)",
    wgpu.chroma > 200 && wgpu.blueDomPct > 80 && blueAvg(wgpu),
  ]);
  // 2. WebGL agrees — same blue edges (parity reference).
  checks.push([
    "webgl has chromatic blue edges (parity reference)",
    wgl.chroma > 200 && wgl.blueDomPct > 80 && blueAvg(wgl),
  ]);
  // 3. Backends agree: blue is the dominant chroma channel on both.
  checks.push([
    "webgpu blue-edge signature matches webgl (both blue-dominant)",
    blueAvg(wgpu) && blueAvg(wgl),
  ]);
  // 4. Chromatic edge coverage is comparable between backends (within 2x) —
  //    the same wireframe is drawn, not a surface fill on one side.
  checks.push([
    "webgpu chromatic edge coverage comparable to webgl",
    wgl.chroma > 0 &&
      wgpu.chroma / wgl.chroma > 0.5 &&
      wgpu.chroma / wgl.chroma < 2.0,
  ]);
  // 5. No WebGPU device errors.
  checks.push([
    "no uncaptured WebGPU errors",
    (caps.webgpu.gate.errors.length ?? 0) === 0 && !caps.webgpu.gate.deviceLost,
  ]);

  let allPass = true;
  for (const [label, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
    if (!ok) allPass = false;
  }
  console.log(`\nRESULT: ${allPass ? "GREEN" : "RED"}`);
  process.exitCode = allPass ? 0 : 1;
})();
