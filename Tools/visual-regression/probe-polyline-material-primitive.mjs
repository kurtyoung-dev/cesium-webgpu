#!/usr/bin/env node
/**
 * Probe: polyline `Primitive` + `PolylineMaterialAppearance` parity on WebGPU
 * vs WebGL (NEW-POLYLINE-APPEARANCE-PRIMITIVE-WEBGPU, MATERIAL slice).
 *
 * The COLOR slice landed a polyline `Primitive` + `PolylineColorAppearance`.
 * The MATERIAL slice adds `PolylineMaterialAppearance` with the PolylineDash /
 * PolylineGlow / PolylineArrow / PolylineOutline / plain Color materials. This
 * probe exercises DASH (pass 1) and GLOW (pass 2) on both backends.
 *
 * What it verifies:
 *   PASS 1 (PolylineDash):
 *     - Both backends draw colored pixels (line renders, not 0px).
 *     - The line is DASHED — many colored runs along rows, not a single solid
 *       run per crossing. We count colored runs across all rows; a solid line
 *       yields O(rows-crossed) runs, a dashed line yields several× more. The
 *       run count must be comfortably above the solid-line floor on BOTH
 *       backends, and within ~15% backend-to-backend.
 *   PASS 2 (PolylineGlow):
 *     - Both backends draw a glowing line (colored pixels present), within ~15%.
 *
 * Usage:
 *   PROBE_BASE=http://localhost:8080 node Tools/visual-regression/probe-polyline-material-primitive.mjs
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";

async function captureRender(page, materialName) {
  return page.evaluate(async (materialName) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    v.scene.globe.show = false;
    v.scene.skyBox.show = false;
    v.scene.sun.show = false;
    v.scene.moon.show = false;
    v.scene.skyAtmosphere.show = false;
    v.scene.backgroundColor = C.Color.BLACK;

    // Remove any prior Primitive instances.
    const prims = v.scene.primitives;
    for (let i = prims.length - 1; i >= 0; i--) {
      const p = prims.get(i);
      if (p && p.constructor && p.constructor.name === "Primitive") {
        prims.remove(p);
      }
    }

    // A mostly-horizontal line so dash gaps fall along screen rows.
    const positions = C.Cartesian3.fromDegreesArray([-76.0, 35.0, -72.0, 35.0]);

    let material;
    if (materialName === "PolylineDash") {
      material = C.Material.fromType("PolylineDash", {
        color: C.Color.CYAN,
        // 50% duty bitmask (0x00FF), long cycle so dashes are several px each.
        dashLength: 24.0,
        dashPattern: 255.0,
      });
    } else {
      material = C.Material.fromType("PolylineGlow", {
        color: C.Color.CYAN,
        glowPower: 0.25,
        taperPower: 1.0,
      });
    }

    const primitive = prims.add(
      new C.Primitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.PolylineGeometry({
            positions: positions,
            width: 12.0,
            arcType: C.ArcType.NONE,
            vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT,
          }),
        }),
        appearance: new C.PolylineMaterialAppearance({
          material: material,
          translucent: false,
        }),
        asynchronous: false,
      }),
    );

    // Frame the line from straight above.
    const center = C.Cartesian3.fromDegrees(-74.0, 35.0, 0.0);
    v.camera.lookAt(
      center,
      new C.HeadingPitchRange(0.0, C.Math.toRadians(-90.0), 600000.0),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    let ready = false;
    for (let i = 0; i < 120; i++) {
      v.scene.render();
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

    // "colored" = clearly non-black (the cyan-ish line/glow over a black bg).
    const isColored = (i) => px[i] > 30 || px[i + 1] > 30 || px[i + 2] > 30;

    let colored = 0;
    // Count colored RUNS per row: a run is a maximal horizontal stretch of
    // colored pixels. A solid line crossing a row contributes ~1 run; a dashed
    // line contributes several. Summed over all rows this discriminates dash
    // from solid robustly without needing a separate solid baseline.
    let runs = 0;
    // Rows that contain at least one colored pixel (line vertical extent).
    let coloredRows = 0;
    for (let y = 0; y < h; y++) {
      let prevColored = false;
      let rowHasColor = false;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const c = isColored(i);
        if (c) {
          colored++;
          rowHasColor = true;
          if (!prevColored) {
            runs++;
          }
        }
        prevColored = c;
      }
      if (rowHasColor) coloredRows++;
    }

    return {
      renderer: v.scene.context?.rendererType,
      primitiveReady: ready,
      material: materialName,
      width: w,
      height: h,
      colored,
      runs,
      coloredRows,
      // runs per colored row — ~1.x for a solid line, >>1 for a dashed line.
      runsPerRow: coloredRows > 0 ? runs / coloredRows : 0,
    };
  }, materialName);
}

async function captureRenderer(renderer, materialName, fs) {
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

  const render = await captureRender(page, materialName);
  const buf = await page.screenshot({ omitBackground: false });
  const out = `Tools/visual-regression/output/polyline-material-${renderer}-${materialName}.png`;
  fs.writeFileSync(out, buf);
  console.log(`  [${renderer}/${materialName}] ${JSON.stringify(render)}`);
  console.log(`    PNG: ${out} (${buf.length} bytes)`);

  const gate = await collectGateErrors(page);
  await browser.close();
  return { render, gate, consoleErrors };
}

(async () => {
  const fs = await import("fs");
  fs.mkdirSync("Tools/visual-regression/output", { recursive: true });

  const results = {};
  for (const materialName of ["PolylineDash", "PolylineGlow"]) {
    results[materialName] = {};
    for (const renderer of ["webgl", "webgpu"]) {
      console.log(
        `\n=== Capturing ${renderer.toUpperCase()} / ${materialName} ===`,
      );
      results[materialName][renderer] = await captureRenderer(
        renderer,
        materialName,
        fs,
      );
      const g = results[materialName][renderer].gate;
      console.log(
        `GATE: armed=${g.armedDevices} uncaptured=${g.errors.length} deviceLost=${g.deviceLost || "no"}`,
      );
      if (g.errors.length) console.log("  gate errors:", g.errors.slice(0, 6));
    }
  }

  console.log(`\n=== ANALYSIS ===`);
  const checks = [];

  // ── DASH ──
  {
    const wgl = results.PolylineDash.webgl.render;
    const wgpu = results.PolylineDash.webgpu.render;
    console.log(
      `[PolylineDash] webgl colored=${wgl.colored} runs=${wgl.runs} runsPerRow=${wgl.runsPerRow.toFixed(2)}  ` +
        `webgpu colored=${wgpu.colored} runs=${wgpu.runs} runsPerRow=${wgpu.runsPerRow.toFixed(2)}`,
    );
    checks.push(["[Dash] webgl draws colored pixels", wgl.colored > 200]);
    checks.push(["[Dash] webgpu draws colored pixels", wgpu.colored > 200]);
    // Dash gaps: a solid line is ~1 run/row. Require clearly more than that
    // on BOTH backends (multiple dashes per row).
    checks.push([
      `[Dash] webgl is DASHED (runsPerRow=${wgl.runsPerRow.toFixed(2)} > 2)`,
      wgl.runsPerRow > 2,
    ]);
    checks.push([
      `[Dash] webgpu is DASHED (runsPerRow=${wgpu.runsPerRow.toFixed(2)} > 2)`,
      wgpu.runsPerRow > 2,
    ]);
    // Parity: colored-pixel count within 15%.
    const ratio = wgl.colored > 0 ? wgpu.colored / wgl.colored : 0;
    checks.push([
      `[Dash] webgpu colored within 15% of webgl (ratio=${ratio.toFixed(3)})`,
      ratio >= 0.85 && ratio <= 1.15,
    ]);
    checks.push([
      `[Dash] no uncaptured WebGPU errors`,
      (results.PolylineDash.webgpu.gate.errors.length ?? 0) === 0 &&
        !results.PolylineDash.webgpu.gate.deviceLost,
    ]);
  }

  // ── GLOW ──
  {
    const wgl = results.PolylineGlow.webgl.render;
    const wgpu = results.PolylineGlow.webgpu.render;
    console.log(
      `[PolylineGlow] webgl colored=${wgl.colored}  webgpu colored=${wgpu.colored}`,
    );
    checks.push(["[Glow] webgl draws the glow (reference)", wgl.colored > 200]);
    checks.push(["[Glow] webgpu draws the glow (not 0px)", wgpu.colored > 200]);
    const ratio = wgl.colored > 0 ? wgpu.colored / wgl.colored : 0;
    checks.push([
      `[Glow] webgpu colored within 15% of webgl (ratio=${ratio.toFixed(3)})`,
      ratio >= 0.85 && ratio <= 1.15,
    ]);
    checks.push([
      `[Glow] no uncaptured WebGPU errors`,
      (results.PolylineGlow.webgpu.gate.errors.length ?? 0) === 0 &&
        !results.PolylineGlow.webgpu.gate.deviceLost,
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
