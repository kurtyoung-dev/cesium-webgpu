#!/usr/bin/env node
// Probe-mrt-validation — Slice 5c-B Sub-C postmortem capture probe.
//
// Purpose: when Sub-C is re-applied (MRT mode flipped on, globe pipeline
// declares 2 targets, render pass adds 2nd attachment, globe shader
// emits FragOutput), the canvas went BLACK and we never saw the actual
// WebGPU validation error in any console. This probe hooks:
//
//   1. `device.onuncapturederror` — fires for every uncaptured GPU
//      validation/out-of-memory error. The renderer's per-call
//      pushErrorScope wrappers don't cover render-pass setup, so when
//      `beginRenderPass` rejects an attachment-count mismatch the error
//      surfaces here.
//   2. `device.lost` promise — fires if the device is forcibly dropped
//      (driver crash, OOM cascade, repeated validation errors).
//   3. `console.error` + `pageerror` — catches Cesium-side throws and
//      our own `[WebGPU:*]` error logs.
//
// Output: a JSON report with timestamped GPU errors per cell, plus the
// canvas screenshot per cell. If the canvas is black AND there's a
// captured validation error in the same cell, the error message tells
// us which of the 6 suspect causes (pipeline cache, null target shape,
// frozen array push, pipeline layout, compute race, MSAA resolve
// shape) actually fired.
//
// Usage:
//   node Tools/visual-regression/probe-mrt-validation.mjs
//   node Tools/visual-regression/probe-mrt-validation.mjs --headed
//
// The probe is BASELINE-AGNOSTIC — it runs against whatever code is
// currently built. After running on baseline (Sub-C reverted) to
// confirm the probe surfaces no errors on healthy code, re-run with
// Sub-C re-applied to capture the actual failure cause.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const HEADED = process.argv.includes("--headed");

// Same view as probe-slice4-verify so we're comparing apples-to-apples
// with the cell pattern that previously went black.
const VIEW = { lon: -112.1129, lat: 36.0544, height: 8_000 };
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

async function captureCell(label, { ao, deferred }) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });

  // Side-channel: messages captured by the harness (console + pageerror).
  const consoleEvents = [];
  page.on("console", (m) =>
    consoleEvents.push({
      kind: "console",
      type: m.type(),
      text: m.text(),
      ts: Date.now(),
    }),
  );
  page.on("pageerror", (e) =>
    consoleEvents.push({
      kind: "pageerror",
      type: "pageerror",
      text: e.message,
      stack: e.stack ?? null,
      ts: Date.now(),
    }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Install device-level hooks BEFORE any of our rendering changes run.
  // We do this from a page.evaluate so the listeners attach in the
  // browser context where `window.viewer.scene.context._device` lives.
  await page.evaluate(() => {
    const v = window.viewer;
    const dev = v?.scene?.context?._device;
    window.__mrtProbeErrors = [];
    if (!dev) {
      window.__mrtProbeErrors.push({
        kind: "harness",
        text: "device not yet acquired at install time",
        ts: Date.now(),
      });
      return;
    }
    // Uncaptured validation / OOM errors. WebGPU spec guarantees these
    // are dispatched async, so by the time we read window.__mrtProbeErrors
    // back in Node, every render-pass mismatch fired during the loop
    // will be present.
    dev.onuncapturederror = (ev) => {
      window.__mrtProbeErrors.push({
        kind: "uncapturederror",
        // Error subclass: GPUValidationError, GPUOutOfMemoryError,
        // GPUInternalError. The toString prefix tells us which.
        errType: ev?.error?.constructor?.name ?? "unknown",
        text: ev?.error?.message ?? String(ev?.error ?? "no message"),
        ts: Date.now(),
      });
    };
    // Device-lost: a 'destroyed' reason is normal at teardown; anything
    // else (unknown, validation cascade) means we tripped a hard limit.
    if (dev.lost && typeof dev.lost.then === "function") {
      dev.lost.then((info) => {
        window.__mrtProbeErrors.push({
          kind: "devicelost",
          reason: info?.reason ?? "unknown",
          text: info?.message ?? "device lost",
          ts: Date.now(),
        });
      });
    }
  });

  const diagnostics = await page.evaluate(
    async ({ view, clockUTC, ao, deferred }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      // Pin clock + camera (same as probe-slice4-verify)
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.scene.deferredLighting = deferred;
      v.scene.globe.enableLighting = true;

      const aoStage = v.scene.postProcessStages?.ambientOcclusion;
      if (aoStage) {
        aoStage.enabled = ao;
        if (aoStage.uniforms) {
          aoStage.uniforms.intensity = 6.0;
          aoStage.uniforms.lengthCap = 0.4;
        }
      }

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-30),
        },
      });

      // Render loop — bail when tiles loaded but always do at least 400
      // frames so producer/consumer/post-process have all had multiple
      // shots at producing validation errors.
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }

      // Snapshot the canvas center pixel via getImageData. If it's
      // {0,0,0,255} we're confirming the "black canvas" failure mode.
      // (Doing it here instead of post-screenshot avoids encoding ambiguity.)
      const canvas = v.canvas;
      let centerPixel = null;
      try {
        // WebGPU canvas can't be re-read with 2D context, so blit through
        // a temp canvas. We only need 1 pixel for the failure-mode signal.
        const tmp = document.createElement("canvas");
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx2d = tmp.getContext("2d");
        ctx2d.drawImage(canvas, 0, 0);
        const cx = (canvas.width / 2) | 0;
        const cy = (canvas.height / 2) | 0;
        const data = ctx2d.getImageData(cx, cy, 1, 1).data;
        centerPixel = { r: data[0], g: data[1], b: data[2], a: data[3] };
      } catch (e) {
        centerPixel = { error: String(e?.message ?? e) };
      }

      // G-buffer / MRT mode diagnostics. These tell us whether the
      // changes we're testing actually engaged (vs. silently no-op'd).
      const ctx = v.scene.context;
      let mrtMode = null;
      try {
        const helpers = await import(
          "/Build/CesiumUnminified/index.js"
        ).then(() => null);
        // The helper module is internal — peek via the globe pipeline
        // cache that imports it. If it landed in the dual bundle it'll
        // be reachable from a renderer that uses it.
        void helpers;
      } catch {}
      const gbView = v.scene._view?.gBufferFramebuffer;
      const gb = {
        exists: !!gbView,
        // Sub-A landed paired textures: confirm both halves are present.
        // Field names match GBufferFramebuffer.js Batch 115a additions.
        hasMSAA: !!gbView?._textureMSAA,
        sampleCount: gbView?._sampleCount ?? null,
        // Resolve-target view should be the single-sample texture; render
        // attachment should be the MSAA one (when sampleCount > 1).
        renderViewExists:
          typeof gbView?.renderAttachmentView === "function"
            ? !!gbView.renderAttachmentView
            : null,
        resolveViewExists:
          typeof gbView?.resolveTargetView === "function"
            ? !!gbView.resolveTargetView
            : null,
      };

      return {
        ao_requested: ao,
        deferred_requested: deferred,
        rendererType: ctx?.rendererType,
        sceneDeferredLighting: v.scene.deferredLighting,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        env_useDeferredLighting:
          v.scene._environmentState?.useDeferredLighting ?? null,
        centerPixel,
        // Black-canvas detector: pure black at center = failure-mode
        // confirmed. Non-black with errors = partial failure (some
        // passes recovered).
        canvasIsBlack:
          centerPixel?.r === 0 &&
          centerPixel?.g === 0 &&
          centerPixel?.b === 0,
        gBuffer: gb,
        mrtMode,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, ao, deferred },
  );

  // Now drain the device-error buffer back to Node-side.
  const deviceErrors = await page.evaluate(() => {
    const out = window.__mrtProbeErrors ?? [];
    return out;
  });

  const out = path.join(OUT_DIR, `mrt-validation-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();

  // Filter console events to error-class only for the summary, but
  // keep full list in the report.
  const consoleErrs = consoleEvents.filter(
    (m) => m.type === "error" || m.type === "warning" || m.kind === "pageerror",
  );

  return {
    label,
    screenshot: out,
    diagnostics,
    deviceErrors,
    consoleErrors: consoleErrs,
    consoleEventCount: consoleEvents.length,
  };
}

function printCellSummary(cell) {
  console.log(`\n  [${cell.label}]`);
  console.log(
    `    canvas pixel @ center: rgba(${cell.diagnostics.centerPixel?.r ?? "?"}, ${
      cell.diagnostics.centerPixel?.g ?? "?"
    }, ${cell.diagnostics.centerPixel?.b ?? "?"}, ${
      cell.diagnostics.centerPixel?.a ?? "?"
    })  ${cell.diagnostics.canvasIsBlack ? "← BLACK (failure mode)" : ""}`,
  );
  console.log(
    `    gbuffer: exists=${cell.diagnostics.gBuffer.exists} hasMSAA=${cell.diagnostics.gBuffer.hasMSAA} sampleCount=${cell.diagnostics.gBuffer.sampleCount}`,
  );
  console.log(
    `    deferred=${cell.diagnostics.sceneDeferredLighting} envFlag=${cell.diagnostics.env_useDeferredLighting}  tilesLoaded=${cell.diagnostics.sceneTilesLoaded}`,
  );
  if (cell.deviceErrors.length === 0) {
    console.log(`    ✓ no WebGPU device errors captured`);
  } else {
    console.log(`    ✗ ${cell.deviceErrors.length} device error(s):`);
    cell.deviceErrors.slice(0, 5).forEach((e, i) => {
      console.log(`      [${i}] ${e.kind}/${e.errType ?? e.reason ?? ""}`);
      const lines = (e.text ?? "").split("\n");
      lines.slice(0, 6).forEach((l) => console.log(`          ${l.trim()}`));
      if (lines.length > 6) {
        console.log(`          … (${lines.length - 6} more lines)`);
      }
    });
    if (cell.deviceErrors.length > 5) {
      console.log(
        `      … (${cell.deviceErrors.length - 5} more errors, see JSON report)`,
      );
    }
  }
  // Pipeline-creation errors come through Cesium's pushErrorScope wrapper
  // which logs to console.error with the prefix
  // `[CesiumJS:webgpu:<id>:pipeline-cache]`. These are NOT caught by
  // `device.onuncapturederror` (the scope swallows them) so the probe
  // surfaces them explicitly. This was the failure mode that broke the
  // original Sub-C dry-run — globe pipeline declared a writable slot 1
  // that the shader didn't emit, and the pipeline silently failed to
  // build, dropping the globe from the canvas.
  const onlyErrors = cell.consoleErrors.filter(
    (e) => e.type === "error" || e.kind === "pageerror",
  );
  if (onlyErrors.length) {
    const pipelineErrs = onlyErrors.filter((e) =>
      (e.text ?? "").includes(":pipeline-cache]"),
    );
    const shaderErrs = onlyErrors.filter((e) =>
      (e.text ?? "").toLowerCase().includes("shadermodule"),
    );
    const otherErrs = onlyErrors.filter(
      (e) =>
        !(e.text ?? "").includes(":pipeline-cache]") &&
        !(e.text ?? "").toLowerCase().includes("shadermodule"),
    );
    console.log(
      `    ✗ ${onlyErrors.length} console.error events (${pipelineErrs.length} pipeline-cache, ${shaderErrs.length} shader, ${otherErrs.length} other):`,
    );
    // Show unique pipeline-cache failures (collapse duplicates — these
    // fire per-tile-per-frame so 300+ is one underlying bug).
    if (pipelineErrs.length) {
      const seen = new Set();
      pipelineErrs.forEach((e) => {
        const key = (e.text ?? "").split(":").slice(2, 4).join(":");
        if (seen.has(key)) return;
        seen.add(key);
        console.log(
          `      pipeline-cache: ${(e.text ?? "").split(":").slice(2).join(":").slice(0, 220)}`,
        );
      });
    }
    if (shaderErrs.length) {
      const seen = new Set();
      shaderErrs.forEach((e) => {
        const firstLine = (e.text ?? "").split("\n")[0];
        if (seen.has(firstLine)) return;
        seen.add(firstLine);
        console.log(`      shader: ${firstLine.slice(0, 220)}`);
      });
    }
    if (otherErrs.length) {
      otherErrs.slice(0, 3).forEach((e) => {
        console.log(
          `      other: ${(e.text ?? "").split("\n")[0].slice(0, 220)}`,
        );
      });
    }
  }
}

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-mrt-validation] capturing 4-cell matrix with GPU error capture");

  const cells = [];
  // Same matrix as probe-slice4-verify so cell labels are comparable.
  cells.push(
    await captureCell("ao-off-def-off", { ao: false, deferred: false }),
  );
  cells.push(
    await captureCell("ao-off-def-on", { ao: false, deferred: true }),
  );
  cells.push(
    await captureCell("ao-on-def-off", { ao: true, deferred: false }),
  );
  cells.push(
    await captureCell("ao-on-def-on", { ao: true, deferred: true }),
  );

  console.log("\n[probe-mrt-validation] per-cell summary:");
  cells.forEach(printCellSummary);

  const totalDeviceErrors = cells.reduce(
    (n, c) => n + c.deviceErrors.length,
    0,
  );
  const blackCells = cells.filter((c) => c.diagnostics.canvasIsBlack);
  console.log(`\n[probe-mrt-validation] aggregate:`);
  console.log(`    cells with black canvas: ${blackCells.length}/4`);
  console.log(`    total device errors: ${totalDeviceErrors}`);
  if (blackCells.length === 4 && totalDeviceErrors === 0) {
    console.log(
      `    !! ALL CELLS BLACK with NO captured errors — failure is silent`,
    );
    console.log(
      `       (likely a render-pass producing valid-but-wrong output;`,
    );
    console.log(
      `        next step: add console logs at pass boundaries or check pipeline cache reuse)`,
    );
  }

  const reportPath = path.join(OUT_DIR, "mrt-validation-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        view: VIEW,
        clock: FIXED_CLOCK_UTC,
        cells,
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
