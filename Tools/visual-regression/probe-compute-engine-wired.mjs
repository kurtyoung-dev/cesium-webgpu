#!/usr/bin/env node
// probe-compute-engine-wired — item 370 (NEW-WEBGPU-COMPUTE-ENGINE-WIRING).
//
// Before this batch WebGPUContext never instantiated a WebGPUComputeEngine, so
// every WebGPUPerformanceManager.dispatchCompute() (atmosphere LUT bake,
// frustum cull, sort, Hi-Z, ...) early-returned as a silent no-op. The lazy
// `context.computeEngine` getter now lights those paths up.
//
// 370 has NO visible output by design: ENABLE_SKY_INSCATTER_LUT is false, so
// the sky FS stays on the analytic ray-march path and does NOT sample the LUT
// — the bake now RUNS (exercising the compute dispatch) but is visually inert.
// So verification = (A) the engine is instantiated via the production path,
// (B) the now-running dispatch throws ZERO errors, (C) the sky band is
// unchanged (renders a normal non-black blue).
//
// Usage: node Tools/visual-regression/probe-compute-engine-wired.mjs
// Env:   PROBE_BASE (default http://localhost:8080)

import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, "output");
mkdirSync(OUT, { recursive: true });
const BASE = process.env.PROBE_BASE || "http://localhost:8080";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERR:" + e.message));
await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
  waitUntil: "networkidle",
});
await page.waitForFunction(() => !!window.viewer);

const out = await page.evaluate(async () => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const v = window.viewer,
    s = v.scene;
  s.requestRenderMode = false;
  // Sky atmosphere ON (default) so the atmosphere-LUT dispatch path runs;
  // globe ON; aim at the limb so a clear sky band is in frame.
  s.skyAtmosphere.show = true;
  // Nadir from 15,000 km — the whole globe disc + atmosphere ring fills the
  // frame (vs the earlier framing that pointed into empty space).
  s.camera.setView({
    destination: C.Cartesian3.fromDegrees(0, 0, 15_000_000),
    orientation: { heading: 0, pitch: C.Math.toRadians(-90), roll: 0 },
  });
  const frame = () =>
    new Promise((r) => {
      s.requestRender();
      s.render();
      requestAnimationFrame(r);
    });
  // Run enough frames that the sky-atmosphere renderer dispatches the LUT bake
  // through the production path (which reads context.computeEngine).
  for (let i = 0; i < 80; i++) await frame();

  const ctx = s.context;
  const ce = ctx.computeEngine;
  const engineWired = ce !== null && ce !== undefined;

  // Capture the top-of-frame sky band (a clear sky region above the limb).
  return new Promise((resolve) => {
    const remove = s.postRender.addEventListener(() => {
      remove();
      const c = s.canvas;
      const off = document.createElement("canvas");
      off.width = c.width;
      off.height = c.height;
      const cx = off.getContext("2d");
      cx.drawImage(c, 0, 0);
      const d = cx.getImageData(0, 0, c.width, c.height).data;
      // Count bright pixels (globe disc + atmosphere) — confirms the scene
      // renders normally and the now-running compute dispatch didn't blank it.
      let bright = 0,
        n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] + d[i + 1] + d[i + 2] > 90) bright++;
        n++;
      }
      resolve({
        engineWired,
        rendererType: ctx.rendererType,
        brightFrac: bright / n,
        png: off.toDataURL("image/png"),
      });
    });
    s.requestRender();
    s.render();
  });
});

writeFileSync(
  join(OUT, "compute-engine-wired.png"),
  Buffer.from(out.png.split(",")[1], "base64"),
);

// 370 has no visible output (sky stays analytic), so this probe asserts only
// the wiring + clean dispatch; the "didn't-break globe/atmosphere" guard is
// the established probe-camera-track.mjs (orbit->ground WebGL-vs-WebGPU sweep),
// which exercises the atmosphere-LUT dispatch path across waypoints.
console.log(`renderer: ${out.rendererType}`);
console.log(`(A) context.computeEngine wired: ${out.engineWired ? "OK" : "FAIL"}`);
console.log(`(B) console errors (dispatch runs clean): ${errors.length} ${errors.length === 0 ? "OK" : "FAIL"}`);
errors.slice(0, 5).forEach((e) => console.log("  ERR:", e.slice(0, 160)));

const pass = out.engineWired && errors.length === 0;
console.log(pass ? "PASS" : "FAIL");
await browser.close();
process.exit(pass ? 0 : 1);
