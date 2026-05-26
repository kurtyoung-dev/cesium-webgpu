#!/usr/bin/env node
// Probe-cesium-man-debug — Batch 141 deep dive on CesiumMan error.
// Capture full error context and check whether the errors are
// startup-only or per-frame.

import { chromium } from "playwright";

const BASE = "http://localhost:8080";

(async () => {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan"],
  });
  const page = await browser.newPage({
    viewport: { width: 800, height: 600 },
  });
  page.on("pageerror", () => {});
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  // Snapshot errors with timestamps so we can see clustering
  await page.evaluate(() => {
    const dev = window.viewer?.scene?.context?._device;
    window.__probeErrors = [];
    window.__startTime = performance.now();
    if (!dev) return;
    dev.onuncapturederror = (ev) => {
      window.__probeErrors.push({
        t: performance.now() - window.__startTime,
        text: ev?.error?.message ?? "",
        frame: window.__frameCounter ?? -1,
      });
    };
  });

  const result = await page.evaluate(async () => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const lon = -79.9959;
    const lat = 40.4406;
    const height = 800;

    const entity = v.entities.add({
      position: C.Cartesian3.fromDegrees(lon, lat, height),
      model: {
        uri: "/Apps/SampleData/models/CesiumMan/Cesium_Man.glb",
        scale: 5.0,
        minimumPixelSize: 256,
      },
    });

    v.camera.setView({
      destination: C.Cartesian3.fromDegrees(lon, lat - 0.003, height + 100),
      orientation: { pitch: C.Math.toRadians(-15) },
    });

    const phases = { early: 0, mid: 0, late: 0 };
    const phaseFrames = { early: [0, 60], mid: [200, 260], late: [500, 560] };
    window.__frameCounter = 0;

    for (let i = 0; i < 600; i++) {
      window.__frameCounter = i;
      v.scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }

    // After all frames, count errors per phase
    const errs = window.__probeErrors;
    for (const e of errs) {
      if (e.frame < 60) phases.early++;
      else if (e.frame < 260) phases.mid++;
      else phases.late++;
    }

    // Find the loaded model primitive
    const scene = v.scene;
    let foundModel = null;
    for (let i = 0; i < scene.primitives.length; i++) {
      const p = scene.primitives.get(i);
      if (p && typeof p.update === "function" && p.constructor.name === "ModelVisualizer") {
        foundModel = "ModelVisualizer";
        break;
      }
    }

    return {
      phases,
      totalErrors: errs.length,
      firstError: errs[0] ?? null,
      lastError: errs[errs.length - 1] ?? null,
      uniqueErrorMessages: Array.from(new Set(errs.map((e) => e.text.slice(0, 120)))),
      primitivesCount: v.scene.primitives.length,
      entitiesCount: v.entities.values.length,
      foundModel,
    };
  });

  await browser.close();
  console.log(JSON.stringify(result, null, 2));
})();
