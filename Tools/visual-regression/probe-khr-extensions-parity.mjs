/**
 * KHR material-extension parity probe — Batch 207+ (wave0).
 *
 * Loads each KHR material-extension test model on BOTH backends, renders ~60
 * frames, captures the canvas, and records for each (model, renderer):
 *   (a) renders        — model.ready AND non-black pixels present
 *   (b) gpuErrors      — WebGPU uncaptured/scoped device errors via the gate
 *   (c) renderErrorDom — WebGL/WebGPU "An error occurred while rendering"
 *                        error panel (cesium-widget-errorPanel) present in DOM,
 *                        which is how a shader COMPILE FAILURE surfaces
 *                        (e.g. the WebGL KHR_materials_anisotropy FS bug).
 *
 * The known WebGL anisotropy compile failure is the motivating case: a "fix"
 * that renders pixels but still shows the error panel is NOT clean.
 *
 * Each model is loaded in a FRESH page (fresh viewer + fresh device) so a fault
 * on one model can't poison the gate state of the next.
 *
 * Usage: node Tools/visual-regression/probe-khr-extensions-parity.mjs
 *   PROBE_BASE     (default http://localhost:8134)
 *   PROBE_RENDERER (optional: "webgpu" | "webgl" — default runs both)
 */
import { chromium } from "playwright";
import {
  errorGateInit,
  armWebGPUDevices,
  collectGateErrors,
  attachConsoleErrorGate,
} from "../lib/webgpu-error-gate.mjs";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";
const ONLY = process.env.PROBE_RENDERER; // optional single-backend
const OUT = "Tools/visual-regression/output";

const MODELS = [
  "Clearcoat",
  "Sheen",
  "Specular",
  "Volume",
  "Transmission",
  "Iridescence",
];
const urlFor = (name) =>
  `/Apps/SampleData/models/TestKHRExtensions/TestKhr${name}.gltf`;

/** Capture one (model, renderer) in a fresh page. */
async function captureOne(renderer, name) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  const consoleFaults = attachConsoleErrorGate(page);
  await page.addInitScript(errorGateInit);
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
    timeout: 90000,
  });
  await page.waitForFunction(() => !!window.viewer, { timeout: 90000 });

  // Arm the WebGPU gate as early as the device exists (before draws).
  await armWebGPUDevices(page);

  const info = await page.evaluate(async (modelUrl) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    // Clean background so model pixels are unambiguous.
    scene.globe.show = false;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.backgroundColor = C.Color.BLACK;

    let loadError = null;
    let model = null;
    try {
      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
        C.Cartesian3.fromDegrees(-75, 40, 0),
      );
      model = await C.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix,
        scale: 1.0,
      });
      scene.primitives.add(model);
    } catch (e) {
      loadError = String(e && e.message ? e.message : e);
    }

    if (model) {
      for (let i = 0; i < 600 && !model.ready; i++) {
        try {
          scene.render();
        } catch (e) {
          loadError = `render-throw: ${String(e && e.message ? e.message : e)}`;
          break;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (model.ready && model.boundingSphere) {
        v.camera.viewBoundingSphere(
          model.boundingSphere,
          new C.HeadingPitchRange(
            0.3,
            -0.35,
            model.boundingSphere.radius * 3.0,
          ),
        );
        v.camera.lookAtTransform(C.Matrix4.IDENTITY);
      }
      for (let i = 0; i < 60; i++) {
        try {
          scene.render();
        } catch (e) {
          loadError =
            loadError ||
            `render-throw: ${String(e && e.message ? e.message : e)}`;
          break;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    }

    return {
      ready: !!(model && model.ready),
      loadError,
    };
  }, urlFor(name));

  // Re-arm (device may have been created lazily) + let async faults flush.
  await armWebGPUDevices(page);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 200)));
  const gate = await collectGateErrors(page);

  // Detect the "An error occurred while rendering" panel (shader compile fail).
  const renderErrorDom = await page.evaluate(() => {
    const panel = document.querySelector(".cesium-widget-errorPanel");
    if (!panel) {
      return null;
    }
    const header = panel.querySelector(".cesium-widget-errorPanel-header");
    const body = panel.querySelector(".cesium-widget-errorPanel-scroll");
    return {
      header: header ? header.textContent.trim() : "(no header)",
      body: body ? body.textContent.trim().slice(0, 600) : "(no body)",
    };
  });

  // Screenshot the canvas + decode for a non-black pixel count.
  await page.evaluate(() => {
    window.viewer.scene.canvas.setAttribute("data-khr", "1");
  });
  const png = await page
    .locator('canvas[data-khr="1"]')
    .screenshot({ type: "png" });
  const stats = await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const off = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = off.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let nonBlack = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] + d[i + 1] + d[i + 2] > 18) {
        nonBlack++;
      }
    }
    return { w: bmp.width, h: bmp.height, total: d.length / 4, nonBlack };
  }, Buffer.from(png).toString("base64"));

  const pngPath = `${OUT}/khr-${name.toLowerCase()}-${renderer}.png`;
  fs.writeFileSync(pngPath, png);

  await browser.close();

  return {
    model: name,
    renderer,
    ready: info.ready,
    loadError: info.loadError,
    nonBlack: stats.nonBlack,
    nonBlackPct: +((100 * stats.nonBlack) / stats.total).toFixed(2),
    gpuErrors: gate.errors,
    deviceLost: gate.deviceLost,
    armedDevices: gate.armedDevices,
    consoleFaults: consoleFaults.slice(0, 6),
    renderErrorDom,
    pngPath,
  };
}

const renderers = ONLY ? [ONLY] : ["webgpu", "webgl"];
const results = [];
for (const r of renderers) {
  for (const m of MODELS) {
    process.stderr.write(`[probe] ${r} / ${m} ...\n`);

    const res = await captureOne(r, m);
    results.push(res);
    process.stderr.write(
      `[probe]   ready=${res.ready} nonBlack=${res.nonBlack} (${res.nonBlackPct}%) ` +
        `gpuErr=${res.gpuErrors.length} domErr=${!!res.renderErrorDom}\n`,
    );
  }
}

// Verdict per (model,renderer): clean = ready, non-trivial pixels, no GPU
// error, no device loss, no render-error panel, no load error.
const summary = results.map((res) => {
  const clean =
    res.ready &&
    res.nonBlack > 50 &&
    res.gpuErrors.length === 0 &&
    !res.deviceLost &&
    !res.renderErrorDom &&
    !res.loadError;
  return {
    model: res.model,
    renderer: res.renderer,
    clean,
    ready: res.ready,
    nonBlack: res.nonBlack,
    nonBlackPct: res.nonBlackPct,
    gpuErrors: res.gpuErrors,
    deviceLost: res.deviceLost,
    renderErrorDom: res.renderErrorDom,
    loadError: res.loadError,
    consoleFaults: res.consoleFaults,
    pngPath: res.pngPath,
  };
});

fs.writeFileSync(
  `${OUT}/khr-extensions-parity-report.json`,
  JSON.stringify(summary, null, 2),
);

console.log(JSON.stringify(summary, null, 2));

const failures = summary.filter((s) => !s.clean);
if (failures.length === 0) {
  console.log("KHR PARITY PASS — all extensions render clean on both backends");
} else {
  console.log(
    `KHR PARITY FAIL — ${failures.length} broken:\n` +
      failures
        .map(
          (f) =>
            `  ${f.model}/${f.renderer}: ` +
            (f.renderErrorDom
              ? `RENDER-ERROR-PANEL("${f.renderErrorDom.header}")`
              : f.loadError
                ? `LOAD-ERROR(${f.loadError})`
                : f.gpuErrors.length
                  ? `GPU-ERROR(${f.gpuErrors[0]})`
                  : f.deviceLost
                    ? `DEVICE-LOST(${f.deviceLost})`
                    : !f.ready
                      ? "NOT-READY"
                      : `BLACK(nonBlack=${f.nonBlack})`),
        )
        .join("\n"),
  );
}
process.exit(failures.length === 0 ? 0 : 1);
