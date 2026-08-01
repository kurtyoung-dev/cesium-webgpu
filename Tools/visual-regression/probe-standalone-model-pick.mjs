#!/usr/bin/env node
// Probe (PARITY-STANDALONE-MODEL-PICK): scene.pick() over a standalone
// Model.fromGltfAsync added DIRECTLY to scene.primitives (NOT via an Entity's
// ModelGraphics) must return a defined pick whose .primitive === the model
// (or .detail.model === the model) on BOTH WebGL and WebGPU. A pick OFF the
// model must return undefined on both.
//
// Background: webgpu-model-pick demo picks entity.model successfully, but the
// direct-scene.primitives path was reported to return undefined on WebGPU
// (the clipping run saw 0 hits for a Model.fromGltfAsync). This probe verifies
// the gap and, after the fix, confirms parity.
//
// Usage: node Tools/visual-regression/probe-standalone-model-pick.mjs

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTDIR = path.join(__dirname, "output");
fs.mkdirSync(OUTDIR, { recursive: true });

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const LON = -75.0;
const LAT = 40.0;
const MODEL_SCALE = 800.0;
const CAM_HEIGHT = 8000.0;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--enable-unsafe-webgpu"],
});

async function runLeg(renderer) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
  });
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const out = await page.evaluate(
    async ({ LON, LAT, MODEL_SCALE, CAM_HEIGHT }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;
      const scene = v.scene;
      scene.globe.depthTestAgainstTerrain = false;

      const origin = C.Cartesian3.fromDegrees(LON, LAT, 0.0);
      const modelMatrix = C.Transforms.eastNorthUpToFixedFrame(origin);
      let model;
      try {
        model = await C.Model.fromGltfAsync({
          url: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
          modelMatrix,
          scale: MODEL_SCALE,
        });
        scene.primitives.add(model);
      } catch (e) {
        return { fatal: `model load failed: ${e}` };
      }

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(LON, LAT, CAM_HEIGHT),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });

      let modelReady = false;
      for (let i = 0; i < 220; i++) {
        scene.render();
        if (model.ready) modelReady = true;
        await new Promise((r) => requestAnimationFrame(r));
      }

      const center = new C.Cartesian2(
        Math.floor(scene.canvas.clientWidth / 2),
        Math.floor(scene.canvas.clientHeight / 2),
      );
      // A pixel near the corner where the model is not present.
      const offModel = new C.Cartesian2(20, 20);

      function describePick(p) {
        if (!p) return { defined: false };
        return {
          defined: true,
          isModelPrimitive: p.primitive === model,
          hasDetailModel: !!(p.detail && p.detail.model === model),
          primType:
            p.primitive && p.primitive.constructor
              ? p.primitive.constructor.name
              : typeof p.primitive,
        };
      }

      // Pick over the model — sample a few frames (WebGPU pick is async-warmed).
      const centerSamples = [];
      let bestCenter = null;
      for (let i = 0; i < 8; i++) {
        let picked;
        try {
          picked = scene.pick(center);
        } catch (e) {
          picked = null;
        }
        const d = describePick(picked);
        centerSamples.push(d);
        if (d.defined && (d.isModelPrimitive || d.hasDetailModel)) {
          bestCenter = d;
        }
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      // Pick off the model.
      let offResult = null;
      for (let i = 0; i < 4; i++) {
        let picked;
        try {
          picked = scene.pick(offModel);
        } catch (e) {
          picked = null;
        }
        offResult = describePick(picked);
        scene.render();
        await new Promise((r) => requestAnimationFrame(r));
      }

      return {
        rendererType: scene.context?.rendererType,
        modelReady,
        centerSamples,
        bestCenter,
        offResult,
      };
    },
    { LON, LAT, MODEL_SCALE, CAM_HEIGHT },
  );

  // Screenshot for visual confirmation.
  await page
    .screenshot({
      path: path.join(OUTDIR, `standalone-model-pick-${renderer}.png`),
    })
    .catch(() => {});

  await page.close();
  return { ...out, errors };
}

const webgl = await runLeg("webgl");
const webgpu = await runLeg("webgpu");
await browser.close();

function printLeg(name, leg) {
  console.log(`\n=== ${name} (${leg.rendererType}) ===`);
  if (leg.fatal) {
    console.log(`  FATAL: ${leg.fatal}`);
    return;
  }
  console.log(`modelReady: ${leg.modelReady}`);
  console.log(`center samples:`);
  (leg.centerSamples ?? []).forEach((s, i) =>
    console.log(
      `  frame ${i}: defined=${s.defined} isModelPrimitive=${s.isModelPrimitive} hasDetailModel=${s.hasDetailModel} primType=${s.primType}`,
    ),
  );
  console.log(`bestCenter: ${JSON.stringify(leg.bestCenter)}`);
  console.log(`offResult: ${JSON.stringify(leg.offResult)}`);
  console.log(`console errors: ${leg.errors.length}`);
  leg.errors.slice(0, 6).forEach((e) => console.log("   ERR:", e));
}
printLeg("WebGL", webgl);
printLeg("WebGPU", webgpu);

const failures = [];
if (webgl.fatal) failures.push(`WebGL fatal: ${webgl.fatal}`);
if (webgpu.fatal) failures.push(`WebGPU fatal: ${webgpu.fatal}`);

function hitModel(leg) {
  return !!(
    leg.bestCenter &&
    (leg.bestCenter.isModelPrimitive || leg.bestCenter.hasDetailModel)
  );
}
function offClean(leg) {
  // Off-model pick must NOT return the model.
  return !(
    leg.offResult &&
    (leg.offResult.isModelPrimitive || leg.offResult.hasDetailModel)
  );
}

if (!hitModel(webgl))
  failures.push("WebGL: center pick did NOT return the standalone model");
if (!hitModel(webgpu))
  failures.push("WebGPU: center pick did NOT return the standalone model");
if (!offClean(webgl)) failures.push("WebGL: off-model pick returned the model");
if (!offClean(webgpu))
  failures.push("WebGPU: off-model pick returned the model");
if (webgl.errors?.length)
  failures.push(`WebGL console errors: ${webgl.errors.length}`);
if (webgpu.errors?.length)
  failures.push(`WebGPU console errors: ${webgpu.errors.length}`);

console.log("");
if (failures.length === 0) {
  console.log(
    "PROBE PASS: standalone Model.fromGltfAsync picks on both backends",
  );
  process.exit(0);
} else {
  console.log("PROBE FAIL:");
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
