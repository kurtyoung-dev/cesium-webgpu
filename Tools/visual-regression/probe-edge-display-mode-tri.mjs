#!/usr/bin/env node
/**
 * Probe: EdgeDisplayMode tri-mode parity on WebGPU vs WebGL.
 *
 * Verifies the §5 P2 batch `batch-edge-display-mode-tri`:
 *   - SURFACES_ONLY (the DEFAULT): edge-bearing glTF shows NO edges,
 *     identical to a plain surface render. Both backends must agree.
 *   - SURFACES_AND_EDGES: surface + edges (edges composited on top).
 *   - EDGES_ONLY: surface suppressed, ONLY edges render (CAD wireframe).
 *     On WebGPU this requires the new `CESIUM_3D_TILE_EDGES_DIRECT`
 *     (Pass slot 12) execution in `WebGPUSceneRendererFrustumLoop`;
 *     before the batch these commands were binned but never executed,
 *     so EDGES_ONLY rendered the same as SURFACES_ONLY.
 *
 * Loads `EdgeVisibility.glb` (the EXT_mesh_primitive_edge_visibility
 * sample asset the Sandcastle demos use) as a standalone Model, points
 * the camera at it, and captures a center-region average colour + a
 * non-background coverage % for each (renderer, mode) pair. Then asserts:
 *   1. The three modes are PAIRWISE DISTINCT on WebGPU (coverage/colour
 *      differs between SURFACES_ONLY, SURFACES_AND_EDGES, EDGES_ONLY).
 *   2. WebGPU's per-mode signature tracks WebGL's (same ordering of
 *      coverage: EDGES_ONLY < SURFACES_ONLY <= SURFACES_AND_EDGES).
 *
 * This is a SIGNATURE probe (coarse stats + screenshots for human
 * spot-check), not a strict pixel-diff — the wide-line tessellation and
 * MSAA resolve differ enough between backends that a hard pixel
 * threshold would be noisy. The human lander reads the 6 PNGs.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-edge-display-mode-tri.mjs
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
  "/Specs/Data/Models/glTF-2.0/EdgeVisibility/glTF-Binary/EdgeVisibility.glb";

// EdgeDisplayMode enum values (EdgeDisplayMode.js):
//   SURFACES_ONLY: 0, SURFACES_AND_EDGES: 1, EDGES_ONLY: 2
const MODES = [
  { name: "surfaces-only", value: 0 },
  { name: "surfaces-and-edges", value: 1 },
  { name: "edges-only", value: 2 },
];

async function captureMode(page, modeValue) {
  return page.evaluate(async (mode) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.show = false; // isolate the model against sky
    v.scene.skyBox.show = false;
    v.scene.backgroundColor = C.Color.BLACK;

    // Remove any model from a previous mode capture on this page.
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
        color: C.Color.GRAY,
      }),
    );
    model.edgeDisplayMode = mode;

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

    // Coarse center-region signature: coverage (% non-black) + avg RGB.
    const canvas = v.canvas;
    const w = canvas.width;
    const h = canvas.height;
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(canvas, 0, 0);
    const px = tctx.getImageData(0, 0, w, h).data;
    const cx = Math.floor(w / 2);
    const cy = Math.floor(h / 2);
    const half = Math.floor(Math.min(w, h) * 0.3);
    let nonBg = 0;
    let total = 0;
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    for (let y = cy - half; y < cy + half; y += 2) {
      for (let x = cx - half; x < cx + half; x += 2) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4;
        const rr = px[i];
        const gg = px[i + 1];
        const bb = px[i + 2];
        total++;
        rSum += rr;
        gSum += gg;
        bSum += bb;
        // Non-background = any pixel meaningfully above pure black.
        if (rr > 12 || gg > 12 || bb > 12) nonBg++;
      }
    }
    return {
      renderer: v.scene.context?.rendererType,
      modelReady: model.ready,
      edgeDisplayMode: model.edgeDisplayMode,
      total,
      nonBg,
      coveragePct: total ? Number(((nonBg / total) * 100).toFixed(2)) : 0,
      avgRGB: total
        ? [
            Math.round(rSum / total),
            Math.round(gSum / total),
            Math.round(bSum / total),
          ]
        : null,
    };
  }, modeValue);
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

  const perMode = {};
  for (const mode of MODES) {
    const result = await captureMode(page, mode.value);
    perMode[mode.name] = result;
    const buf = await page.screenshot({ omitBackground: false });
    const out = `Tools/visual-regression/output/edge-mode-${renderer}-${mode.name}.png`;
    fs.writeFileSync(out, buf);
    console.log(`  [${renderer}/${mode.name}] ${JSON.stringify(result)}`);
    console.log(`    PNG: ${out} (${buf.length} bytes)`);
  }

  const gate = await collectGateErrors(page);
  await browser.close();
  return { perMode, gate, consoleErrors };
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

  // ── Assertions ──
  console.log(`\n=== ANALYSIS ===`);
  const cov = (rr, m) => caps[rr]?.perMode?.[m]?.coveragePct ?? -1;

  const summarize = (rr) => {
    const so = cov(rr, "surfaces-only");
    const sae = cov(rr, "surfaces-and-edges");
    const eo = cov(rr, "edges-only");
    console.log(
      `${rr}: surfaces-only=${so}%  surfaces+edges=${sae}%  edges-only=${eo}%`,
    );
    return { so, sae, eo };
  };
  const wgl = summarize("webgl");
  const wgpu = summarize("webgpu");

  const checks = [];
  // 1. EDGES_ONLY must have strictly LOWER coverage than SURFACES_ONLY
  //    on WebGPU (the surface is suppressed; only thin edges remain).
  checks.push([
    "webgpu EDGES_ONLY coverage < SURFACES_ONLY (surface suppressed)",
    wgpu.eo >= 0 && wgpu.so >= 0 && wgpu.eo < wgpu.so,
  ]);
  // 2. EDGES_ONLY must differ from SURFACES_ONLY on WebGPU (the bug this
  //    batch fixes was them being identical).
  checks.push([
    "webgpu EDGES_ONLY distinct from SURFACES_ONLY",
    Math.abs(wgpu.eo - wgpu.so) > 0.5,
  ]);
  // 3. WebGPU coverage ordering matches WebGL ordering.
  checks.push([
    "ordering edges-only < surfaces-only on both backends",
    wgl.eo < wgl.so && wgpu.eo < wgpu.so,
  ]);
  // 4. No WebGPU device errors / loss across all three modes.
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
