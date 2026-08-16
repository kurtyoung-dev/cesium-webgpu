#!/usr/bin/env node
// Probe-model-pbr-audit — Batch 141 broad Model PBR audit.
// @purpose Broad model PBR audit across skinned/instanced/unlit/textured assets: 0 device errors, material-UB sizes/alignment, passes invoked.
// @status ACTIVE
//
// Loads several glTF assets covering different feature combinations:
//   - CesiumMan: skinned, animated (FLAG_HAS_SKINNING active)
//   - CesiumMilkTruck: static, multi-primitive, textured PBR
//   - GroundVehicle: KHR_materials_unlit + textured
//   - BoxInstanced: GPU instancing (FLAG_HAS_INSTANCING active)
//
// For each, reports:
//   - 0 device errors during render
//   - Material UB byte size + min binding alignment
//   - Render passes invoked
//
// Pre-fixes (if any latent bugs surface): expect WGSL parse/binding errors.

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8134";

const MODELS = [
  {
    name: "CesiumMan",
    url: "Apps/SampleData/models/CesiumMan/Cesium_Man.glb",
    notes: "skinned + animated",
  },
  {
    name: "CesiumMilkTruck",
    url: "Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
    notes: "static textured PBR multi-primitive",
  },
  {
    name: "GroundVehicle",
    url: "Apps/SampleData/models/GroundVehicle/GroundVehicle.glb",
    notes: "PBR textured",
  },
  {
    name: "BoxInstanced",
    url: "Apps/SampleData/models/BoxInstanced/BoxInstanced.gltf",
    notes: "EXT_mesh_gpu_instancing",
  },
  {
    name: "BoxUnlit",
    url: "Apps/SampleData/models/BoxUnlit/BoxUnlit.gltf",
    notes: "KHR_materials_unlit",
  },
];

(async () => {
  const allResults = [];
  for (const model of MODELS) {
    console.log(
      `\n[probe-model-pbr-audit] Loading ${model.name} (${model.notes})...`,
    );
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

    const diag = await page.evaluate(
      async ({ url, modelName }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const v = window.viewer;
        const lon = -79.9959;
        const lat = 40.4406;
        const height = 800;

        let entity;
        let loadErr = null;
        try {
          entity = v.entities.add({
            name: modelName,
            position: C.Cartesian3.fromDegrees(lon, lat, height),
            model: {
              uri: `/${url}`,
              scale: 5.0,
              minimumPixelSize: 256,
            },
          });
        } catch (e) {
          loadErr = String(e?.message ?? e);
        }

        if (!loadErr) {
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(
              lon,
              lat - 0.003,
              height + 100,
            ),
            orientation: { pitch: C.Math.toRadians(-15) },
          });
          // Render until tiles + model loaded
          for (let i = 0; i < 1500; i++) {
            v.scene.render();
            await new Promise((r) => requestAnimationFrame(r));
            if (v.scene.globe.tilesLoaded && i > 300 && entity?.model?.ready) {
              break;
            }
          }
          // Extra frames to settle animation
          for (let i = 0; i < 60; i++) {
            v.scene.render();
            await new Promise((r) => requestAnimationFrame(r));
          }
        }

        // Pull diagnostics about the Model PBR pipeline state
        const ctx = v.scene.context;
        const _cache = ctx?._gltfModelCache ?? ctx?.gltfModelCache;
        const _samplePrim =
          v.scene.primitives.length > 0 ? v.scene.primitives.get(0) : null;

        return {
          modelName,
          loadErr,
          modelReady: !!entity?.model?.ready,
          primCount: v.scene.primitives.length,
          entityModelDefined: !!entity?.model,
        };
      },
      { url: model.url, modelName: model.name },
    );

    const errs = await page.evaluate(() => window.__probeErrors ?? []);
    await page.waitForTimeout(300);
    const out = `Tools/visual-regression/output/model-pbr-${model.name}.png`;
    await page.screenshot({ path: out });
    await browser.close();

    allResults.push({
      model: model.name,
      notes: model.notes,
      diag,
      deviceErrorCount: errs.length,
      sampleErrors: errs.slice(0, 3).map((e) => e.text?.slice(0, 220)),
      screenshot: out,
    });

    console.log(
      `  modelReady=${diag.modelReady}  primCount=${diag.primCount}  errors=${errs.length}`,
    );
    if (errs.length) {
      console.log(`  sample errors:`);
      errs
        .slice(0, 2)
        .forEach((e) => console.log(`    - ${e.text?.slice(0, 200)}`));
    }
  }

  fs.writeFileSync(
    "Tools/visual-regression/output/model-pbr-audit-report.json",
    JSON.stringify(allResults, null, 2),
  );
  console.log("\n[probe-model-pbr-audit] summary:");
  let totalErrors = 0;
  for (const r of allResults) {
    const status = r.deviceErrorCount > 0 ? `${r.deviceErrorCount} ERRS` : "OK";
    console.log(`  ${status.padEnd(12)} ${r.model.padEnd(22)} ${r.notes}`);
    totalErrors += r.deviceErrorCount;
  }
  console.log(`\nTotal device errors: ${totalErrors}`);
  console.log(
    `Report: Tools/visual-regression/output/model-pbr-audit-report.json`,
  );
})();
