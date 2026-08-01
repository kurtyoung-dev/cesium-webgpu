#!/usr/bin/env node
/**
 * Probe: PolylineCollection MIXED materials parity — WebGPU vs WebGL
 * (NS-POLYLINE-COLLECTION-MULTI-MATERIAL).
 *
 * Builds ONE PolylineCollection holding three color-separated horizontal
 * lines so the per-group material loop in WebGPUPolylineRenderer.js is
 * exercised with more than one material type at once:
 *   - SOLID  (Material.ColorType) — RED    line at lat 35.4
 *   - DASH   (PolylineDash)       — CYAN   line at lat 35.0
 *   - GLOW   (PolylineGlow)       — YELLOW line at lat 34.6
 *
 * The suspected bug (parity report §6): every non-Color group renders as a
 * SOLID line on WebGPU — Dash loses its dashes (runsPerRow collapses to ~1
 * vs WebGL's many). We isolate each line by hue and count colored RUNS per
 * row for that hue only. A dashed line yields many runs/row; a solid line
 * yields ~1.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-polyline-multimaterial.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function captureRender(page) {
  return page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.show = false;
    v.scene.skyBox.show = false;
    v.scene.sun.show = false;
    v.scene.moon.show = false;
    v.scene.skyAtmosphere.show = false;
    v.scene.backgroundColor = C.Color.BLACK;

    // Remove any prior PolylineCollection instances.
    const prims = v.scene.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims.get(i);
      if (p && p.constructor && p.constructor.name === "PolylineCollection") {
        prims.remove(p);
      }
    }

    const collection = prims.add(new C.PolylineCollection());

    // SOLID RED — plain Color material.
    collection.add({
      positions: C.Cartesian3.fromDegreesArray([-76.0, 35.4, -72.0, 35.4]),
      width: 12.0,
      material: C.Material.fromType("Color", { color: C.Color.RED }),
    });

    // DASH CYAN — 50% duty bitmask (0x00FF), long cycle so dashes are big.
    collection.add({
      positions: C.Cartesian3.fromDegreesArray([-76.0, 35.0, -72.0, 35.0]),
      width: 12.0,
      material: C.Material.fromType("PolylineDash", {
        color: C.Color.CYAN,
        dashLength: 24.0,
        dashPattern: 255.0,
      }),
    });

    // GLOW YELLOW — glow taper along the line.
    collection.add({
      positions: C.Cartesian3.fromDegreesArray([-76.0, 34.6, -72.0, 34.6]),
      width: 12.0,
      material: C.Material.fromType("PolylineGlow", {
        color: C.Color.YELLOW,
        glowPower: 0.25,
        taperPower: 1.0,
      }),
    });

    // Frame all three lines from straight above.
    const center = C.Cartesian3.fromDegrees(-74.0, 35.0, 0.0);
    v.camera.lookAt(
      center,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-90.0), 700000.0),
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

    // Hue classifiers (threshold 30/255).
    const isRed = (i) => px[i] > 30 && px[i + 1] < 30 && px[i + 2] < 30;
    const isCyan = (i) => px[i] < 30 && px[i + 1] > 30 && px[i + 2] > 30;
    const isYellow = (i) => px[i] > 30 && px[i + 1] > 30 && px[i + 2] < 30;

    // Count colored pixels + colored runs per row + rows-with-color, per hue.
    function measure(classify) {
      let colored = 0;
      let runs = 0;
      let coloredRows = 0;
      for (let y = 0; y < h; y++) {
        let prev = false;
        let rowHas = false;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const c = classify(i);
          if (c) {
            colored++;
            rowHas = true;
            if (!prev) runs++;
          }
          prev = c;
        }
        if (rowHas) coloredRows++;
      }
      return {
        colored,
        runs,
        coloredRows,
        runsPerRow: coloredRows > 0 ? runs / coloredRows : 0,
      };
    }

    return {
      renderer: v.scene.context?.rendererType,
      width: w,
      height: h,
      solid: measure(isRed),
      dash: measure(isCyan),
      glow: measure(isYellow),
    };
  });
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

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90_000 });
  await armWebGPUDevices(page);

  const render = await captureRender(page);
  const buf = await page.screenshot({ omitBackground: false });
  const out = `Tools/visual-regression/output/polyline-multimaterial-${renderer}.png`;
  fs.writeFileSync(out, buf);
  console.log(`  [${renderer}] ${JSON.stringify(render)}`);
  console.log(`    PNG: ${out} (${buf.length} bytes)`);

  const gate = await collectGateErrors(page);
  await browser.close();
  return { render, gate, consoleErrors };
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  const results = {};
  for (const renderer of ["webgl", "webgpu"]) {
    console.log(`\n=== Capturing ${renderer.toUpperCase()} ===`);
    results[renderer] = await captureRenderer(renderer, fs);
    const g = results[renderer].gate;
    console.log(
      `GATE: armed=${g.armedDevices} uncaptured=${g.errors.length} deviceLost=${g.deviceLost || "no"}`,
    );
    if (g.errors.length) console.log("  gate errors:", g.errors.slice(0, 6));
  }

  console.log(`\n=== ANALYSIS (mixed PolylineCollection) ===`);
  const wgl = results.webgl.render;
  const wgpu = results.webgpu.render;
  console.log(
    `[solid] webgl runsPerRow=${wgl.solid.runsPerRow.toFixed(2)} colored=${wgl.solid.colored}  ` +
      `webgpu runsPerRow=${wgpu.solid.runsPerRow.toFixed(2)} colored=${wgpu.solid.colored}`,
  );
  console.log(
    `[dash]  webgl runsPerRow=${wgl.dash.runsPerRow.toFixed(2)} colored=${wgl.dash.colored}  ` +
      `webgpu runsPerRow=${wgpu.dash.runsPerRow.toFixed(2)} colored=${wgpu.dash.colored}`,
  );
  console.log(
    `[glow]  webgl runsPerRow=${wgl.glow.runsPerRow.toFixed(2)} colored=${wgl.glow.colored}  ` +
      `webgpu runsPerRow=${wgpu.glow.runsPerRow.toFixed(2)} colored=${wgpu.glow.colored}`,
  );

  const checks = [];
  // All three lines must render on both backends.
  checks.push(["[solid] webgl draws", wgl.solid.colored > 200]);
  checks.push(["[solid] webgpu draws", wgpu.solid.colored > 200]);
  checks.push(["[dash] webgl draws", wgl.dash.colored > 200]);
  checks.push(["[dash] webgpu draws", wgpu.dash.colored > 200]);
  checks.push(["[glow] webgl draws", wgl.glow.colored > 200]);
  checks.push(["[glow] webgpu draws", wgpu.glow.colored > 200]);

  // The SOLID line should be ~1 run/row on both (sanity anchor).
  checks.push([
    `[solid] webgpu solid ~1 run/row (${wgpu.solid.runsPerRow.toFixed(2)})`,
    wgpu.solid.runsPerRow < 2,
  ]);

  // CORE: the DASH line inside the mixed collection must be DASHED on WebGPU.
  checks.push([
    `[dash] webgl is DASHED (runsPerRow=${wgl.dash.runsPerRow.toFixed(2)} > 2)`,
    wgl.dash.runsPerRow > 2,
  ]);
  checks.push([
    `[dash] webgpu is DASHED in mixed collection (runsPerRow=${wgpu.dash.runsPerRow.toFixed(2)} > 2)`,
    wgpu.dash.runsPerRow > 2,
  ]);
  // Dash run-count parity within ~25% backend-to-backend.
  {
    const r = wgl.dash.runs > 0 ? wgpu.dash.runs / wgl.dash.runs : 0;
    checks.push([
      `[dash] webgpu dash-run count within 25% of webgl (ratio=${r.toFixed(3)})`,
      r >= 0.75 && r <= 1.25,
    ]);
  }

  checks.push([
    `[gate] no uncaptured WebGPU errors`,
    (results.webgpu.gate.errors.length ?? 0) === 0 &&
      !results.webgpu.gate.deviceLost,
  ]);

  let allPass = true;
  for (const [label, ok] of checks) {
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}`);
    if (!ok) allPass = false;
  }
  console.log(`\nRESULT: ${allPass ? "GREEN" : "RED"}`);
  process.exitCode = allPass ? 0 : 1;
})();
