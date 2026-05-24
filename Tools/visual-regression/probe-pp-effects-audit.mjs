#!/usr/bin/env node
// Probe-pp-effects-audit — Batch 98 sibling-of-Batch-95 audit.
//
// Batch 95 found AO was a silent no-op on WebGPU because the FR sync
// wasn't being called. The fix to `WebGPUContext.updateAndClearFramebuffers`
// (calling `postProcess.update(...)`) should have unblocked every
// lazily-initialized PP effect — bloom, DoF, godRay — but only AO was
// specifically verified. This probe applies the same matrix-diff +
// JS-state-dump approach to each remaining effect to surface any that
// is STILL a silent no-op for its own different reason.
//
// What the probe does, for each effect (bloom, dof, godRay):
//   1. Capture A: baseline (effect OFF). Same view, same clock.
//   2. Capture B: effect ON with sensible uniforms.
//   3. Diff A vs B.
//   4. Compare against a same-settings noise floor capture.
//   5. Dump JS-side state (cache flag, effect.enabled, pipeline.hasActiveStages).
//
// Pass criterion: B vs A diff > 3x noise floor AND JS state shows the
// effect is initialized + enabled.

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

// Grand Canyon close camera — confirmed terrain-rendering by Slice 4
// probe. Plenty of depth variation for DoF, plenty of bright pixels
// for bloom, plenty of geometry for godRay sun-blocker.
const VIEW = { lon: -112.1129, lat: 36.0544, height: 8_000 };

async function capture(label, configure) {
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=Vulkan",
      "--use-vulkan",
      "--disable-cache",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const messages = [];
  page.on("console", (m) => messages.push({ t: m.type(), text: m.text() }));
  page.on("pageerror", (e) =>
    messages.push({ t: "pageerror", text: e.message }),
  );

  await page.goto(`${BASE}/Apps/CesiumViewer/index.html?renderer=webgpu`, {
    waitUntil: "networkidle",
  });
  await page.waitForFunction(() => !!window.viewer);

  const diagnostics = await page.evaluate(
    async ({ view, clockUTC, configureSrc }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      const vm = v.baseLayerPicker.viewModel;
      const wgs84 = vm.terrainProviderViewModels.find((t) =>
        String(t.name || "").toLowerCase().includes("wgs84"),
      );
      if (wgs84) vm.selectedTerrain = wgs84;

      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      v.scene.globe.enableLighting = true;

      // Apply per-capture configuration. Stringified so it crosses the
      // Playwright boundary.
      const configFn = new Function("v", "C", configureSrc);
      configFn(v, C);

      v.camera.setView({
        destination: C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
        orientation: {
          heading: C.Math.toRadians(0),
          pitch: C.Math.toRadians(-30),
        },
      });

      for (let i = 0; i < 1200; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }

      // JS-side state dump.
      const ctx = v.scene.context;
      const cache = v.scene.postProcessStages?._webgpuCache ?? null;
      const sceneRenderer = v.scene._alternateSceneRenderer ?? null;
      const pipeline = sceneRenderer?.postProcessPipeline ?? null;

      return {
        rendererType: ctx?.rendererType,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        cache_exists: !!cache,
        cache_aoEnabled: cache?.ambientOcclusionEnabled ?? null,
        cache_aoInit: cache?.aoInitialized ?? null,
        cache_bloomEnabled: cache?.bloomEnabled ?? null,
        cache_bloomInit: cache?.bloomInitialized ?? null,
        cache_dofEnabled: cache?.depthOfFieldEnabled ?? null,
        cache_dofInit: cache?.dofInitialized ?? null,
        cache_godRayEnabled: cache?.godRayEnabled ?? null,
        cache_godRayInit: cache?.godRayInitialized ?? null,
        pipeline_exists: !!pipeline,
        pipeline_hasActiveStages: pipeline?.hasActiveStages ?? null,
        bloom_effect_enabled: pipeline?.bloomEffect?.enabled ?? null,
        ao_effect_enabled: pipeline?.ambientOcclusionEffect?.enabled ?? null,
        dof_effect_enabled: pipeline?.depthOfFieldEffect?.enabled ?? null,
        godRay_effect_enabled: pipeline?.godRayEffect?.enabled ?? null,
      };
    },
    {
      view: VIEW,
      clockUTC: FIXED_CLOCK_UTC,
      configureSrc: configure.toString().replace(/^function[^{]*{/, "").replace(/\}$/, ""),
    },
  );
  console.log(`    diag: ${JSON.stringify(diagnostics)}`);

  await page.waitForTimeout(1000);
  const out = path.join(OUT_DIR, `pp-audit-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();

  const errors = messages.filter(
    (m) => m.t === "error" || m.t === "pageerror",
  );
  return { out, errors, diagnostics };
}

async function diffPngs(a, b) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  const ba = fs.readFileSync(a).toString("base64");
  const bb = fs.readFileSync(b).toString("base64");
  const result = await page.evaluate(
    async ({ ba, bb }) => {
      const decode = async (b64) => {
        const img = new Image();
        img.src = "data:image/png;base64," + b64;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext("2d").drawImage(img, 0, 0);
        return {
          w: img.naturalWidth,
          h: img.naturalHeight,
          data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data,
        };
      };
      const a = await decode(ba);
      const b = await decode(bb);
      if (a.w !== b.w || a.h !== b.h) return { error: "size mismatch" };
      const total = a.w * a.h;
      let mismatch = 0;
      let sum = 0;
      for (let i = 0; i < a.data.length; i += 4) {
        const d =
          Math.abs(a.data[i] - b.data[i]) +
          Math.abs(a.data[i + 1] - b.data[i + 1]) +
          Math.abs(a.data[i + 2] - b.data[i + 2]);
        sum += d;
        if (d > 30) mismatch++;
      }
      return {
        totalPx: total,
        mismatchPx: mismatch,
        mismatchPct: (100 * mismatch) / total,
        meanDelta: sum / total,
      };
    },
    { ba, bb },
  );
  await browser.close();
  return result;
}

// Per-effect configuration closures. Each receives `(v, C)` (viewer
// and Cesium namespace). MUST be self-contained — no closures over
// outer-scope variables, because they're stringified for evaluation.
const CONFIGS = {
  baseline: function (v) {
    const pp = v.scene.postProcessStages;
    if (pp.ambientOcclusion) pp.ambientOcclusion.enabled = false;
    if (pp.bloom) pp.bloom.enabled = false;
    if (pp._depthOfField) pp._depthOfField.enabled = false;
  },
  bloom: function (v) {
    const pp = v.scene.postProcessStages;
    if (pp.ambientOcclusion) pp.ambientOcclusion.enabled = false;
    if (pp._depthOfField) pp._depthOfField.enabled = false;
    if (pp.bloom) {
      pp.bloom.enabled = true;
      if (pp.bloom.uniforms) {
        // Force-aggressive: threshold 0 = every pixel passes the
        // bright-pass, glowOnly true = output is bloom-only (no scene
        // composite), so any working bloom must produce a HUGE visual
        // delta. If we still see ~noise, bloom is broken regardless of
        // JS-state flags.
        pp.bloom.uniforms.brightness = 0.0;
        pp.bloom.uniforms.glowOnly = true;
        pp.bloom.uniforms.sigma = 5.0;
      }
    }
  },
  dof: function (v, C) {
    const pp = v.scene.postProcessStages;
    if (pp.ambientOcclusion) pp.ambientOcclusion.enabled = false;
    if (pp.bloom) pp.bloom.enabled = false;
    // Batch 98 — upstream DoF API: create the stage via
    // PostProcessStageLibrary, add it to the collection, then enable
    // the composite. The fork's WebGPU side now detects the
    // `czm_depth_of_field` composite by name (see
    // `findDepthOfFieldStage` in WebGPUPostProcessStageCollection.ts).
    // Aggressive uniforms: short focalDistance + huge sigma so the
    // bulk of the canyon scene falls outside the focus plane and
    // blurs visibly.
    const stages = v.scene.postProcessStages._stages || [];
    let hasDoF = false;
    for (const s of stages) {
      if (s && s.name === "czm_depth_of_field") {
        hasDoF = true;
        s.enabled = true;
        if (s.uniforms) {
          s.uniforms.focalDistance = 5.0;
          s.uniforms.delta = 1.0;
          s.uniforms.sigma = 10.0;
        }
        break;
      }
    }
    if (!hasDoF) {
      const dof = C.PostProcessStageLibrary.createDepthOfFieldStage();
      dof.enabled = true;
      if (dof.uniforms) {
        dof.uniforms.focalDistance = 5.0;
        dof.uniforms.delta = 1.0;
        dof.uniforms.sigma = 10.0;
      }
      v.scene.postProcessStages.add(dof);
    }
  },
  godRay: function (v) {
    const pp = v.scene.postProcessStages;
    if (pp.ambientOcclusion) pp.ambientOcclusion.enabled = false;
    if (pp.bloom) pp.bloom.enabled = false;
    if (pp._depthOfField) pp._depthOfField.enabled = false;
    // GodRay is a fork addition exposed via scene flag, not the
    // collection (per WebGPUPostProcessStageCollection.ts:209).
    v.scene.godRayEnabled = true;
  },
};

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-pp-effects-audit] capturing per-effect engagement matrix");

  console.log("\n  [baseline-A] all PP off (noise-floor base)");
  const baselineA = await capture("baseline", CONFIGS.baseline);
  console.log("\n  [baseline-B] all PP off (noise-floor pair)");
  const baselineB = await capture("baseline2", CONFIGS.baseline);

  const results = {};
  for (const name of ["bloom", "dof", "godRay"]) {
    console.log(`\n  [${name}] ${name} ON, others OFF`);
    results[name] = await capture(name, CONFIGS[name]);
  }

  console.log("\n[probe-pp-effects-audit] diffs:");

  const noiseDiff = await diffPngs(baselineA.out, baselineB.out);
  const noiseFloor = Math.max(0.3, noiseDiff.mismatchPct * 3);
  console.log(
    `\n  [noise floor] ${noiseDiff.mismatchPct.toFixed(3)}% (3x = ${noiseFloor.toFixed(3)}%)`,
  );

  for (const [name, capture] of Object.entries(results)) {
    const diff = await diffPngs(baselineA.out, capture.out);
    const engaged = diff.mismatchPct > noiseFloor;
    const jsInit =
      capture.diagnostics[`cache_${name === "godRay" ? "godRay" : name}Init`];
    const jsEnabled = capture.diagnostics[`${name}_effect_enabled`];
    console.log(
      `  [${name}] diff=${diff.mismatchPct.toFixed(3)}% jsInit=${jsInit} jsEnabled=${jsEnabled} engaged=${engaged ? "✓" : "✗"}`,
    );
    if (!engaged) {
      console.log(
        `    !! ${name} did NOT engage visually despite (likely) being enabled. Potential silent no-op.`,
      );
    }
  }

  const reportPath = path.join(OUT_DIR, "pp-effects-audit-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        view: VIEW,
        noiseFloor: noiseDiff,
        captures: {
          baselineA: { diag: baselineA.diagnostics, errors: baselineA.errors.length },
          baselineB: { diag: baselineB.diagnostics, errors: baselineB.errors.length },
          ...Object.fromEntries(
            Object.entries(results).map(([k, v]) => [
              k,
              { diag: v.diagnostics, errors: v.errors.length },
            ]),
          ),
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
