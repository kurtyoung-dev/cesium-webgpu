#!/usr/bin/env node
// Probe-khr-extensions — Batch 145 / NEW-GLTF-PIPELINE-SHAPE-AUDIT Item 4.
//
// Loads 6 synthetic glTF test assets, each carrying ONE KHR materials
// extension (clearcoat / specular / anisotropy / iridescence / sheen /
// volume+transmission / transmission+ior). For each:
//   1. Asserts the model loads (parser accepts the extension JSON).
//   2. Asserts the renderer creates pipelines + draws without device
//      errors (FS code path for the extension is reachable).
//   3. Inspects the material UB's KHR-extension slots after upload,
//      confirms the JS pack code wrote the expected factor values at
//      the expected offsets per the Batch 141 byte layout audit.
//
// Pre-Batch-145 these code paths had never been exercised end-to-end
// since their introduction (Batches 105-107). If WGSL parse errors,
// JS pack offset bugs, or shader binding mismatches exist, this probe
// surfaces them.

import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:8080";

const EXTENSIONS = [
  {
    name: "Clearcoat",
    file: "TestKhrClearcoat.gltf",
    expectedFactorSlots: {
      // slots [108-115] per WebGPUModelRenderer.js packMaterialUniforms
      // clearcoatFactor, clearcoatRoughnessFactor, clearcoatNormalScale
      108: 1.0,
      109: 0.05,
      110: 1.0,
    },
  },
  {
    name: "Specular",
    file: "TestKhrSpecular.gltf",
    expectedFactorSlots: {
      // slots [116-119]: specularFactor, specularColorFactor(r,g,b)
      116: 1.0,
      117: 1.0,
      118: 0.7,
      119: 0.3,
    },
  },
  {
    name: "Anisotropy",
    file: "TestKhrAnisotropy.gltf",
    expectedFactorSlots: {
      // slots [124-125]: anisotropyStrength, anisotropyRotation
      124: 0.8,
      125: 1.5707963,
    },
  },
  {
    name: "Iridescence",
    file: "TestKhrIridescence.gltf",
    expectedFactorSlots: {
      // slots [132-135]: iridescenceFactor, iridescenceIor, thickMin, thickMax
      132: 1.0,
      133: 1.5,
      134: 100,
      135: 400,
    },
  },
  {
    name: "Sheen",
    file: "TestKhrSheen.gltf",
    expectedFactorSlots: {
      // slots [140-143]: sheenColorFactor(r,g,b), sheenRoughnessFactor
      140: 1.0,
      141: 0.85,
      142: 0.7,
      143: 0.4,
    },
  },
  {
    name: "Volume",
    file: "TestKhrVolume.gltf",
    expectedFactorSlots: {
      // slots [148-152]: thicknessFactor, attenuationDistance,
      //   attenuationColor(r,g,b)
      148: 2.0,
      149: 5.0,
      150: 0.2,
      151: 0.8,
      152: 0.4,
    },
  },
  {
    name: "Transmission",
    file: "TestKhrTransmission.gltf",
    expectedFactorSlots: {
      // slot [180]: transmissionFactor (per packMaterialUniforms line 615)
      180: 0.95,
    },
  },
];

(async () => {
  const results = [];
  for (const ext of EXTENSIONS) {
    console.log(`\n[probe-khr-extensions] Testing ${ext.name}...`);
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
      async ({ url, expectedSlots }) => {
        const C = await import("/Build/CesiumUnminified/index.js");
        const v = window.viewer;
        const lon = -79.9959;
        const lat = 40.4406;
        const height = 200;

        let model;
        let loadErr = null;
        try {
          const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(
            C.Cartesian3.fromDegrees(lon, lat, height),
          );
          model = await C.Model.fromGltfAsync({
            url: `/${url}`,
            modelMatrix,
            scale: 30.0,
          });
          v.scene.primitives.add(model);
        } catch (e) {
          loadErr = String(e?.message ?? e);
        }

        if (!loadErr) {
          v.camera.setView({
            destination: C.Cartesian3.fromDegrees(
              lon,
              lat - 0.002,
              height + 80,
            ),
            orientation: { pitch: C.Math.toRadians(-25) },
          });
          for (let i = 0; i < 800; i++) {
            v.scene.render();
            await new Promise((r) => requestAnimationFrame(r));
            if (model?.ready) break;
          }
          for (let i = 0; i < 30; i++) {
            v.scene.render();
            await new Promise((r) => requestAnimationFrame(r));
          }
        }

        // Inspect the material UB after upload. The packed material
        // data lives on `model._webgpuCache.primitives[primKey].materialData`
        // per WebGPUModelRenderer.js:1964 + ensurePrimitiveCache. Walk
        // the primitives map for the first one with materialData populated.
        let actualSlots = null;
        let materialBufferSize = null;
        if (model?._webgpuCache?.primitives) {
          const prims = model._webgpuCache.primitives;
          for (const key of Object.keys(prims)) {
            const pc = prims[key];
            if (pc?.materialData) {
              actualSlots = {};
              for (const slot of Object.keys(expectedSlots)) {
                actualSlots[slot] = pc.materialData[Number(slot)];
              }
              materialBufferSize = pc.materialData.byteLength;
              break;
            }
          }
        }

        return {
          loadErr,
          modelReady: !!model?.ready,
          actualSlots,
          materialBufferSize,
        };
      },
      {
        url: `Apps/SampleData/models/TestKHRExtensions/${ext.file}`,
        expectedSlots: ext.expectedFactorSlots,
      },
    );

    const errs = await page.evaluate(() => window.__probeErrors ?? []);
    await browser.close();

    // Compare expected vs actual
    let slotsMatch = true;
    const slotDiffs = [];
    if (diag.actualSlots) {
      for (const slot of Object.keys(ext.expectedFactorSlots)) {
        const expected = ext.expectedFactorSlots[slot];
        const actual = diag.actualSlots[slot];
        const diff = Math.abs((actual ?? 0) - expected);
        if (diff > 1e-3) {
          slotsMatch = false;
          slotDiffs.push(
            `  slot ${slot}: expected ${expected}, got ${actual} (diff ${diff.toFixed(4)})`,
          );
        }
      }
    } else {
      slotsMatch = false;
      slotDiffs.push(
        "  could not inspect material UB (model not ready or cache not found)",
      );
    }

    results.push({
      name: ext.name,
      file: ext.file,
      loadErr: diag.loadErr,
      modelReady: diag.modelReady,
      errorCount: errs.length,
      slotsMatch,
      slotDiffs,
      actualSlots: diag.actualSlots,
      materialBufferSize: diag.materialBufferSize,
      sampleErrors: errs.slice(0, 3).map((e) => (e.text ?? "").slice(0, 180)),
    });

    const status = diag.loadErr
      ? "LOAD-FAIL"
      : errs.length > 0
        ? `${errs.length} DEV-ERRS`
        : !slotsMatch
          ? "SLOT-MISMATCH"
          : "OK";
    console.log(
      `  ${status.padEnd(16)} ${ext.name.padEnd(14)} modelReady=${diag.modelReady} bufSize=${diag.materialBufferSize}`,
    );
    if (diag.loadErr) {
      console.log(`    LOAD-ERR: ${diag.loadErr.slice(0, 200)}`);
    }
    if (errs.length > 0) {
      errs
        .slice(0, 2)
        .forEach((e) =>
          console.log(`    DEV-ERR: ${(e.text ?? "").slice(0, 200)}`),
        );
    }
    if (!slotsMatch) {
      slotDiffs.forEach((d) => console.log(d));
    }
  }

  fs.writeFileSync(
    "Tools/visual-regression/output/khr-extensions-report.json",
    JSON.stringify(results, null, 2),
  );

  console.log("\n[probe-khr-extensions] summary:");
  let totalFails = 0;
  for (const r of results) {
    const status = r.loadErr
      ? "LOAD-FAIL"
      : r.errorCount > 0
        ? `${r.errorCount} DEV-ERRS`
        : !r.slotsMatch
          ? "SLOT-MISMATCH"
          : "OK";
    console.log(`  ${status.padEnd(16)} ${r.name}`);
    if (status !== "OK") totalFails++;
  }
  console.log(
    `\nTotal failures: ${totalFails} / ${results.length}\nReport: Tools/visual-regression/output/khr-extensions-report.json`,
  );
})();
