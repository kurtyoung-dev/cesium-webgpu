#!/usr/bin/env node
// Probe-model-taa-msaa — Batch 143 verification.
//
// Loads CesiumMan + enables TAA + MSAA=4. The Model velocity pipeline
// is built with multisample={count:4} (per createVelocityPipeline +
// sampleCount = msaaSamples), but the velocity pass's color attachment
// is the single-sample velocityTexture. If WebGPU validation is strict,
// this triggers "sampleCount mismatch" errors per frame the velocity
// pass runs.
//
// Expected if bug is real:
//   - Multiple device errors mentioning sampleCount mismatch.
// Expected if bug is masked:
//   - 0 device errors (maybe depth-attachment sampleCount is computed
//     differently when depthReadOnly=true).

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
  });
  page.on("pageerror", () => {});
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({ text: ev?.error?.message ?? "" });
    };
  });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;

    // Enable TAA — gates the velocity pass.
    v.scene.taaEnabled = true;
    // MSAA defaults to 4; verify.
    const msaa = v.scene.msaaSamples;

    const _entity = v.entities.add({
      position: C.Cartesian3.fromDegrees(-79.9959, 40.4406, 800),
      model: {
        uri: "/Apps/SampleData/models/CesiumMan/Cesium_Man.glb",
        scale: 5.0,
        minimumPixelSize: 256,
      },
    });

    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(-79.9959, 40.4406 - 0.003, 900),
      orientation: { pitch: C.Math.toRadians(-15) },
    });

    for (let i = 0; i < 600; i++) {
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // Inspect whether velocity commands actually exist on this scene.
    const view = v.scene._view;
    const frustumCommandsList = view?.frustumCommandsList ?? [];
    let velocityCommandsFound = 0;
    let totalCommandsScanned = 0;
    for (const fc of frustumCommandsList) {
      if (!fc) continue;
      const passes = fc.commands;
      const indices = fc.indices;
      for (let p = 0; p < passes.length; p++) {
        const arr = passes[p];
        const cnt = indices[p] ?? 0;
        for (let i = 0; i < cnt; i++) {
          totalCommandsScanned++;
          if (arr[i]?.velocityCommand) velocityCommandsFound++;
        }
      }
    }
    return {
      taaEnabled: v.scene.taaEnabled,
      msaa,
      velocityCommandsFound,
      totalCommandsScanned,
    };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log(
    `[probe-model-taa-msaa] taaEnabled=${result.taaEnabled} msaaSamples=${result.msaa}`,
  );
  console.log(
    `  velocityCommands found: ${result.velocityCommandsFound} / ${result.totalCommandsScanned} scanned`,
  );
  console.log(`Device errors: ${errs.length}`);
  if (errs.length) {
    console.log("First 5 unique errors:");
    const seen = new Set();
    let shown = 0;
    for (const e of errs) {
      const key = (e.text ?? "").slice(0, 120);
      if (!seen.has(key) && shown < 5) {
        seen.add(key);
        console.log(`  - ${(e.text ?? "").slice(0, 280)}`);
        shown++;
      }
    }
  } else {
    console.log("  PASS: 0 device errors with TAA + MSAA + Model");
  }
})();
