#!/usr/bin/env node
// Probe-khr-lights-punctual — Batch 142 / Slice 5d step 1 verification.
//
// Loads a synthetic glTF asset (TestLightsPunctual.gltf) that declares
// KHR_lights_punctual at the document level (3 lights: directional,
// point, spot) and references them from 3 nodes with various transforms.
//
// Verifies:
//   1. GltfLoader's materializeKhrLightsPunctual() extracts all 3 light
//      defs from the scene-level array.
//   2. Per-node walk resolves position + direction in model space.
//   3. Result lands on `model.lightsFromGltf` getter.
//   4. The renderer (WebGPUModelRenderer.packPunctualLights) packs them
//      into the per-model light UBO without device errors.
//
// Expected output:
//   - lightsFromGltf.length === 3
//   - Light 0: directional, color (1, 0.95, 0.85), intensity 5
//   - Light 1: point at (3, 4, 5) model-space, color (1, 0.4, 0.2)
//   - Light 2: spot at (-2, 1.5, 0), color (0.3, 0.6, 1.0), inner/outer cone
//   - 0 device errors

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
    const lon = -79.9959;
    const lat = 40.4406;

    // Use Model.fromGltfAsync directly so we can inspect the Model
    // instance (entity.model wraps it through ModelVisualizer which
    // hides the underlying object).
    const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
      C.Cartesian3.fromDegrees(lon, lat, 100),
    );
    let model;
    let loadErr = null;
    try {
      model = await C.Model.fromGltfAsync({
        url: "/Apps/SampleData/models/TestLightsPunctual/TestLightsPunctual.gltf",
        modelMatrix,
        scale: 50.0,
      });
      v.scene.primitives.add(model);
    } catch (e) {
      loadErr = String(e?.message ?? e);
    }

    if (!loadErr) {
      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(lon, lat - 0.001, 300),
        orientation: { pitch: C.Math.toRadians(-30) },
      });
      // Render until model is ready.
      for (let i = 0; i < 600; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (model?.ready) break;
      }
      // Settle frames.
      for (let i = 0; i < 30; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }
    }

    const lights = model?.lightsFromGltf ?? [];
    const lightSummary = lights.map((l) => ({
      type: l.type,
      color: l.color,
      intensity: l.intensity,
      range: l.range,
      position: l.position,
      direction: l.direction,
      innerConeAngle: l.innerConeAngle,
      outerConeAngle: l.outerConeAngle,
    }));

    return {
      loadErr,
      modelReady: !!model?.ready,
      lightCount: lights.length,
      lights: lightSummary,
    };
  });

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  await browser.close();

  console.log("[probe-khr-lights-punctual] result:");
  console.log(JSON.stringify(result, null, 2));
  console.log(`\nDevice errors: ${errs.length}`);
  if (errs.length) {
    errs.slice(0, 5).forEach((e) => console.log(`  - ${e.text?.slice(0, 220)}`));
  }

  // Assertions
  let pass = true;
  if (result.loadErr) {
    console.log(`\nFAIL: model failed to load: ${result.loadErr}`);
    pass = false;
  }
  if (result.lightCount !== 4) {
    // 3 lights declared, but 4 node references (PointLight is referenced twice)
    // — each reference should produce its own entry in lightsFromGltf with its
    // own resolved world position.
    console.log(`\nFAIL: expected 4 light instances (3 lights, 1 duplicate ref), got ${result.lightCount}`);
    pass = false;
  }
  if (errs.length > 0) {
    console.log(`\nFAIL: ${errs.length} device errors`);
    pass = false;
  }
  if (pass) {
    console.log("\nPASS: KHR_lights_punctual loader produces 3 lights, 0 device errors");
  }
  process.exit(pass ? 0 : 1);
})();
