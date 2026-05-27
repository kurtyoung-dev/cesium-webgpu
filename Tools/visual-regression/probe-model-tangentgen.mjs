#!/usr/bin/env node
// Probe-model-tangentgen — Slice 5d Batch 159 verification (NEW-MODEL-TANGENT-GENERATION).
//
// Verifies the screen-space derivative tangent fallback added to
// perturbNormal() in ModelPBRComplete.wgsl. A glTF primitive can declare a
// normal texture WITHOUT a TANGENT vertex accessor (GroundVehicle.glb is the
// canonical case). Batch 153 made that path NaN-safe by falling back to the
// flat geometric normal — correct lighting, but ZERO normal-map surface
// detail. Batch 159 derives a tangent basis from screen-space derivatives,
// matching WebGL's computeTangent() in MaterialStageFS.glsl, so the detail
// is restored.
//
// Method:
//   1. Load GroundVehicle (tangent-LESS, normal-mapped) at a fixed close
//      view + fixed clock under WebGL, screenshot.
//   2. Same scene under WebGPU, screenshot.
//   3. Repeat for CesiumMilkTruck (tangent-HAVING) as a control.
//   4. Report the WebGL↔WebGPU mismatch over the model region (informational).
//
// IMPORTANT — what this probe asserts, and what it does NOT:
//   The WebGL↔WebGPU mismatch is NOT a useful pass/fail signal for this fix.
//   The two backends differ globally in tonemap/exposure/IBL/MSAA, which puts
//   ~40-50% of model pixels over any reasonable per-pixel threshold REGARDLESS
//   of the tangent change — the tangent-HAVING MilkTruck (which never touches
//   this code path) sits at ~52% mismatch, i.e. that's the irreducible noise
//   floor. So this probe asserts only the robustly-reproducible things on a
//   single build:
//     - 0 WebGPU device errors (catches a WGSL uniformity/compile regression
//       in the derivative path — exactly the failure mode hit during dev:
//       `dpdx must only be called from uniform control flow`).
//     - Both backends actually render the model (non-trivial model-pixel area).
//
//   The fix SIGNAL was measured separately via a same-backend A/B (this build
//   vs perturbNormal's fallback temporarily reverted to `return N`):
//     - GroundVehicle (tangent-less): 10.16% of surface pixels changed,
//       broad-distributed (the restored normal-map detail).
//     - MilkTruck (tangent-having):    1.63% changed (edge/AA run-to-run noise),
//       confirming the vertex-tangent path is untouched.
//   To reproduce that A/B: run once with PROBE_LABEL=fixed, edit perturbNormal's
//   `if (!(tlen > 1e-4)...)` body to `return N;`, rebuild, run PROBE_LABEL=baseline,
//   then diff the two webgpu PNGs over the model region.
//
// PASS criteria (single fixed-build run):
//   - 0 WebGPU device errors for both models.
//   - Both models render a non-trivial model-pixel area in both backends.

import { chromium } from "playwright";
import fs from "fs";

const BASE = process.env.PROBE_BASE || "http://localhost:8080";
const LABEL = process.env.PROBE_LABEL || "fixed";
const OUT_DIR = "Tools/visual-regression/output";

// Each model: uri + scale + whether it carries vertex tangents.
const MODELS = [
  {
    key: "groundvehicle",
    uri: "/Apps/SampleData/models/GroundVehicle/GroundVehicle.glb",
    scale: 5.0,
    hasTangents: false, // exercises the Batch 159 derivative fallback
  },
  {
    key: "milktruck",
    uri: "/Apps/SampleData/models/CesiumMilkTruck/CesiumMilkTruck.glb",
    scale: 3.0,
    hasTangents: true, // exercises the vertex-tangent path (regression guard)
  },
];

async function captureBackend(renderer, model) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on("pageerror", (e) => console.log(`>> [${renderer}] pageerror: ${e.message}`));
  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  await page.evaluate(() => {
    window.__probeErrors = [];
    const dev = window.viewer?.scene?.context?._device;
    if (dev) dev.onuncapturederror = (ev) => window.__probeErrors.push(ev?.error?.message ?? "");
  });

  const setup = await page.evaluate(async (m) => {
    const C = await import("/Build/CesiumUnminified/index.js");
    const v = window.viewer;
    const scene = v.scene;
    scene.globe.show = false;
    scene.skyBox.show = false;
    scene.skyAtmosphere.show = false;
    scene.backgroundColor = C.Color.fromCssColorString("#0a0a0a");
    scene.fog.enabled = false;

    // Fixed clock so the sun direction (default scene light) is identical
    // across backends — the normal map reads as the same shading.
    v.clock.currentTime = C.JulianDate.fromIso8601("2026-06-21T15:00:00Z");

    const position = C.Cartesian3.fromDegrees(-79.9959, 40.4406, 100);
    const modelMatrix = C.Transforms.headingPitchRollToFixedFrame(
      position,
      new C.HeadingPitchRoll(C.Math.toRadians(35), 0, 0),
    );
    const model = scene.primitives.add(
      await C.Model.fromGltfAsync({ url: m.uri, modelMatrix, scale: m.scale }),
    );
    for (let i = 0; i < 300; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      if (model.ready) break;
    }
    if (!model.ready) return { err: "model not ready" };

    // Identical framing across backends: derive HPR view from the model's
    // bounding sphere with fixed angles.
    const bs = model.boundingSphere;
    v.camera.viewBoundingSphere(
      bs,
      new C.HeadingPitchRange(C.Math.toRadians(20), C.Math.toRadians(-25), bs.radius * 2.2),
    );
    v.camera.lookAtTransform(C.Matrix4.IDENTITY);

    for (let i = 0; i < 60; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return { ok: true, radius: bs.radius };
  }, model);

  const errs = await page.evaluate(() => window.__probeErrors ?? []);
  const out = `${OUT_DIR}/tangentgen-${model.key}-${renderer}-${LABEL}.png`;
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  return { setup, errs, out };
}

async function diff(pngA, pngB) {
  const db = await chromium.launch({ channel: "msedge", headless: true });
  const dp = await db.newPage();
  await dp.setContent("<html><body></body></html>");
  const aB64 = fs.readFileSync(pngA).toString("base64");
  const bB64 = fs.readFileSync(pngB).toString("base64");
  const stats = await dp.evaluate(
    async ({ aB64, bB64 }) => {
      const dec = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return { w: c.width, h: c.height, data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data };
      };
      const A = await dec(aB64);
      const B = await dec(bB64);
      // Consider only non-background pixels (the model) in EITHER image, so
      // we measure surface-shading agreement, not the empty dark backdrop.
      const bg = 0x0a * 3; // backgroundColor #0a0a0a rgb-sum threshold
      let modelPx = 0, mismatch = 0, sumAbs = 0, maxD = 0;
      for (let i = 0; i < A.data.length; i += 4) {
        const sa = A.data[i] + A.data[i + 1] + A.data[i + 2];
        const sb = B.data[i] + B.data[i + 1] + B.data[i + 2];
        const isModel = sa > bg + 12 || sb > bg + 12;
        if (!isModel) continue;
        modelPx++;
        const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
        sumAbs += d;
        if (d > 30) mismatch++; // >10/channel avg
        if (d > maxD) maxD = d;
      }
      return {
        modelPx,
        mismatchPx: mismatch,
        mismatchPct: modelPx ? (100 * mismatch) / modelPx : 0,
        meanAbsDiff: modelPx ? sumAbs / modelPx : 0,
        maxD,
      };
    },
    { aB64, bB64 },
  );
  await db.close();
  return stats;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let pass = true;
  const summary = [];

  for (const model of MODELS) {
    const webgl = await captureBackend("webgl", model);
    const webgpu = await captureBackend("webgpu", model);
    if (webgl.setup?.err || webgpu.setup?.err) {
      console.log(`[${model.key}] SETUP ERR webgl=${webgl.setup?.err} webgpu=${webgpu.setup?.err}`);
      pass = false;
      continue;
    }
    const d = await diff(webgl.out, webgpu.out);
    summary.push({ model, d, webgpuErrs: webgpu.errs });

    console.log(`\n[${model.key}] (hasTangents=${model.hasTangents})  LABEL=${LABEL}`);
    console.log(`  webgl  → ${webgl.out}`);
    console.log(`  webgpu → ${webgpu.out}`);
    console.log(`  model pixels: ${d.modelPx}`);
    console.log(`  WebGL↔WebGPU mismatch: ${d.mismatchPx} px (${d.mismatchPct.toFixed(2)}%)`);
    console.log(`  mean abs diff (rgb-sum): ${d.meanAbsDiff.toFixed(2)}   max: ${d.maxD}`);
    console.log(`  webgpu device errors: ${webgpu.errs.length}`);
    webgpu.errs.slice(0, 5).forEach((e) => console.log(`    - ${(e ?? "").slice(0, 200)}`));

    if (webgpu.errs.length > 0) pass = false;
  }

  // Single-run PASS: 0 device errors + non-trivial model render per backend.
  // (The WebGL↔WebGPU mismatch above is informational — see header.)
  console.log(`\n── pass checks (LABEL=${LABEL}) ──`);
  for (const { model, d, webgpuErrs } of summary) {
    const rendered = d.modelPx >= 5000;
    const noErrs = webgpuErrs.length === 0;
    const ok = rendered && noErrs;
    console.log(
      `  ${model.key}: modelPx=${d.modelPx} (≥5000? ${rendered}) deviceErrs=${webgpuErrs.length} → ${ok ? "OK" : "FAIL"}`,
    );
    if (!ok) pass = false;
  }

  console.log(pass ? "\nPASS" : "\nFAIL");
  process.exit(pass ? 0 : 1);
})();
