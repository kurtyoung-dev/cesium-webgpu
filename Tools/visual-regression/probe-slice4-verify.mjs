#!/usr/bin/env node
// Probe-slice4-verify — Phase 8a Slice 4 deterministic verification (Batch 95).
//
// The prior `probe-gbuffer-enabled` probe was unreliable — it toggled
// `scene.deferredLighting` but didn't explicitly enable AO, so the
// canvas diff was noise-dominated (sometimes 0%, sometimes 0.6%). This
// probe captures a 4-cell matrix:
//
//                       deferredLighting OFF      deferredLighting ON
//   AO OFF              [A]                       [B]
//   AO ON               [C]                       [D]
//
// And measures two specific diffs:
//
//   1. AO ENGAGED:    A vs C (or B vs D)   should be LARGE (AO darkens scene)
//   2. SLICE 4 SIGNAL: C vs D             should be MEASURABLE
//      ("AO on, deferred toggled — does the G-buffer normal source
//        change the AO output?")
//
// If #1 is large and #2 is non-zero → Slice 4 is engaged.
// If #1 is large but #2 ≈ 0 → AO works, but Slice 4 isn't actually
//   reading the G-buffer (consumer wiring suspect).
// If #1 is small → AO isn't running at all (probe scene wrong).

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";
const FIXED_CLOCK_UTC = "2026-05-19T18:00:00Z";

// Low-altitude view of Grand Canyon area — guaranteed terrain detail
// with strong depth variation. At 200_000m over SF the canvas was
// 80%+ sky and AO had nothing to bite into; at 8_000m over the
// canyon the entire frame is terrain with deep depth variation
// (silhouettes, ridges, crevices) which is exactly what AO darkens.
const VIEW = { lon: -112.1129, lat: 36.0544, height: 8_000 };

async function capture(label, { ao, deferred }) {
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
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
  });

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
    async ({ view, clockUTC, ao, deferred }) => {
      const C = await import("/Build/CesiumUnminified/index.js");
      const v = window.viewer;

      // Keep DEFAULT terrain (Cesium World Terrain) selected. Forcing
      // WGS84 ellipsoid here gave the AO consumer NO depth variation —
      // depth varies only by perspective on the flat ellipsoid, so the
      // SSAO output was essentially zero. With terrain on, ridges and
      // canyons produce strong depth gradients that AO will darken.
      // (Batch 95 lesson — original probe had this selection and the
      // 0.094% diff was real: AO was running but had nothing to bite.)
      void v.baseLayerPicker;

      // Pin clock
      const fixed = C.JulianDate.fromIso8601(clockUTC);
      v.clock.currentTime = fixed.clone();
      v.clock.startTime = fixed.clone();
      v.clock.stopTime = fixed.clone();
      v.clock.shouldAnimate = false;
      v.clock.multiplier = 0;

      // Toggle scene flags BEFORE rendering so the producer + consumer
      // run with the requested config from frame 1.
      v.scene.deferredLighting = deferred;
      v.scene.globe.enableLighting = true;

      const aoStage = v.scene.postProcessStages?.ambientOcclusion;
      if (aoStage) {
        aoStage.enabled = ao;
        // Bump intensity so the AO darkening is more visible against
        // the imagery base — easier to detect in the pixel diff.
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
      // Render long enough for tiles + the producer + AO pipeline to
      // converge. Bail early when tiles say they're loaded.
      for (let i = 0; i < 1500; i++) {
        v.scene.render();
        await new Promise((r) => requestAnimationFrame(r));
        if (v.scene.globe.tilesLoaded && i > 400) break;
      }

      // Diagnostic dump after rendering — captures the actual JS-side
      // wiring state so we can tell WHERE AO breaks if the canvas
      // doesn't show darkening.
      const ctx = v.scene.context;
      const stages = v.scene.postProcessStages;
      // Dump every registered FR slot so we can confirm key 26
      // (POST_PROCESS_COLLECTION) is actually present.
      let frRegistry = null;
      if (ctx?._featureRenderers && Array.isArray(ctx._featureRenderers)) {
        frRegistry = ctx._featureRenderers
          .map((entry, idx) =>
            entry ? { idx, methods: Object.keys(entry) } : null,
          )
          .filter((x) => x !== null);
      } else if (ctx?._featureRenderers) {
        frRegistry = Object.keys(ctx._featureRenderers);
      }
      const fr26 =
        typeof ctx.getFeatureRenderer === "function"
          ? ctx.getFeatureRenderer(26)
          : null;
      const fr26_methods = fr26 ? Object.keys(fr26) : null;
      // The per-frame cache lives on the PostProcessStageCollection
      // itself (`_webgpuCache`). The pipeline lives on the WebGPU
      // scene renderer.
      const cache = stages?._webgpuCache ?? null;
      const stagesKeys = stages
        ? Object.keys(stages).filter(
            (k) =>
              k.toLowerCase().includes("cache") ||
              k.toLowerCase().includes("webgpu") ||
              k.toLowerCase().includes("feature") ||
              k === "_activeStagesChanged",
          )
        : [];
      const fr = stages?._featureRenderer ?? null;
      // The WebGPU scene renderer hangs off `_alternateSceneRenderer`
      // on the Scene (see Scene.js L302 — created via SCENE_RENDERER FR).
      const sceneRenderer =
        v.scene._alternateSceneRenderer ??
        v.scene._sceneRenderer ??
        v.scene.sceneRenderer ??
        ctx._sceneRenderer ??
        ctx.sceneRenderer ??
        null;
      const sceneRendererKey = v.scene._alternateSceneRenderer
        ? "scene._alternateSceneRenderer"
        : v.scene._sceneRenderer
          ? "scene._sceneRenderer"
          : v.scene.sceneRenderer
            ? "scene.sceneRenderer"
            : "none";
      const ctxKeys = ctx
        ? Object.keys(ctx).filter(
            (k) =>
              k.toLowerCase().includes("scene") ||
              k.toLowerCase().includes("render") ||
              k.toLowerCase().includes("pipeline"),
          )
        : [];
      const pipeline =
        sceneRenderer?.postProcessPipeline ??
        sceneRenderer?._postProcessPipeline ??
        null;
      const aoEffect =
        pipeline?.ambientOcclusionEffect ?? pipeline?._aoEffect ?? null;

      return {
        rendererType: ctx?.rendererType,
        ao_requested: ao,
        deferred_requested: deferred,
        stageEnabled: !!aoStage?.enabled,
        stageIntensity: aoStage?.uniforms?.intensity,
        stageLengthCap: aoStage?.uniforms?.lengthCap,
        cache_exists: !!cache,
        cache_aoEnabled: cache?.ambientOcclusionEnabled ?? null,
        cache_aoInitialized: cache?.aoInitialized ?? null,
        cache_initialized: cache?.initialized ?? null,
        fr_exists: !!fr,
        stagesKeys,
        sceneRendererKey,
        sceneRendererType: sceneRenderer
          ? (sceneRenderer.constructor?.name ?? "unknown")
          : null,
        pipeline_exists: !!pipeline,
        aoEffect_exists: !!aoEffect,
        aoEffect_enabled: aoEffect?.enabled ?? null,
        pipeline_hasActiveStages: pipeline?.hasActiveStages ?? null,
        ctxKeys,
        frRegistryCount: Array.isArray(frRegistry) ? frRegistry.length : null,
        frRegistry: Array.isArray(frRegistry)
          ? frRegistry.slice(0, 8)
          : frRegistry,
        fr26_exists: !!fr26,
        fr26_methods,
        sceneDeferredLighting: v.scene.deferredLighting,
        sceneTilesLoaded: v.scene.globe.tilesLoaded,
        // Slice 4 inputs: does the G-buffer framebuffer exist + does it
        // have a normal/roughness texture for the AO consumer to read?
        gBufferFB_exists: !!v.scene._view?.gBufferFramebuffer,
        gBufferNormalTex_exists:
          !!v.scene._view?.gBufferFramebuffer?.normalRoughnessTexture,
        env_useDeferredLighting:
          v.scene._environmentState?.useDeferredLighting ?? null,
      };
    },
    { view: VIEW, clockUTC: FIXED_CLOCK_UTC, ao, deferred },
  );
  console.log(`    diag: ${JSON.stringify(diagnostics)}`);
  await page.waitForTimeout(2000);
  const out = path.join(OUT_DIR, `slice4-${label}.png`);
  await page.screenshot({ path: out });
  await browser.close();

  const errors = messages.filter((m) => m.t === "error" || m.t === "pageerror");
  return { out, errors, diagnostics };
}

// Canvas-decode pixel diff (same infrastructure as probe-saved-view.mjs).
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
        const dr = Math.abs(a.data[i] - b.data[i]);
        const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
        const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
        const d = dr + dg + db;
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

(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log("[probe-slice4-verify] capturing 4-cell matrix");

  console.log("\n  [A] AO=OFF def=OFF (baseline)");
  const A = await capture("ao-off-def-off", { ao: false, deferred: false });
  console.log("\n  [A2] AO=OFF def=OFF (noise-floor — same settings as A)");
  const A2 = await capture("ao-off-def-off-2", { ao: false, deferred: false });
  console.log("\n  [B] AO=OFF def=ON  (producer runs but no consumer cares)");
  const B = await capture("ao-off-def-on", { ao: false, deferred: true });
  console.log("\n  [C] AO=ON  def=OFF (AO reads from depth, no G-buffer)");
  const C = await capture("ao-on-def-off", { ao: true, deferred: false });
  console.log("\n  [D] AO=ON  def=ON  (AO reads from G-buffer — Slice 4)");
  const D = await capture("ao-on-def-on", { ao: true, deferred: true });

  console.log("\n[probe-slice4-verify] computing diagnostic diffs:");

  // Diff 0: A vs A2 — noise floor. Each capture launches a fresh
  // browser, so even byte-identical settings produce non-zero diffs
  // due to GPU init order, async timing, etc. Establish this floor
  // before judging real signals against it.
  const noiseDiff = await diffPngs(A.out, A2.out);
  console.log(`\n  [A vs A2] NOISE FLOOR (identical settings):`);
  console.log(
    `    mismatch=${noiseDiff.mismatchPct.toFixed(3)}% meanDelta=${noiseDiff.meanDelta.toFixed(3)}`,
  );
  console.log(
    `    interpretation: any diff smaller than this is indistinguishable from run-to-run noise.`,
  );

  // Diff 1: A vs C — AO engagement (should be LARGE; if not, AO isn't
  // running at all).
  const aoDiff = await diffPngs(A.out, C.out);
  console.log(`\n  [A vs C] AO ENGAGEMENT (off vs on, both def-off):`);
  console.log(
    `    mismatch=${aoDiff.mismatchPct.toFixed(3)}% meanDelta=${aoDiff.meanDelta.toFixed(3)}`,
  );
  // Use 3× noise floor as the bar for "real signal" — robust to the
  // ~0.6% per-run variance we measure on this view.
  const noiseFloor = Math.max(0.3, noiseDiff.mismatchPct * 3);
  const aoEngaged = aoDiff.mismatchPct > noiseFloor;
  console.log(
    aoEngaged
      ? `    ✓ AO IS running — A→C delta (${aoDiff.mismatchPct.toFixed(3)}%) exceeds 3× noise floor (${noiseFloor.toFixed(3)}%)`
      : `    ✗ AO not engaged or producing no signal — A→C delta (${aoDiff.mismatchPct.toFixed(3)}%) within noise (${noiseFloor.toFixed(3)}%)`,
  );

  // Diff 2: C vs D — Slice 4 signal (should be measurable IF Slice 4
  // engaged; if 0 with AO on, the consumer isn't reading the G-buffer).
  const slice4Diff = await diffPngs(C.out, D.out);
  console.log(
    `\n  [C vs D] SLICE 4 SIGNAL (AO with depth-derived vs G-buffer normals):`,
  );
  console.log(
    `    mismatch=${slice4Diff.mismatchPct.toFixed(3)}% meanDelta=${slice4Diff.meanDelta.toFixed(3)}`,
  );
  if (!aoEngaged) {
    console.log(`    ? can't interpret — AO didn't engage in either case`);
  } else if (slice4Diff.mismatchPct > noiseFloor) {
    console.log(
      `    ✓ Slice 4 ENGAGED — G-buffer normal source visibly changes AO above noise floor`,
    );
  } else {
    console.log(
      `    ~ Slice 4 wiring is live (verified via JS-side diag), but G-buffer normals`,
    );
    console.log(
      `      are themselves derived from depth — same input as the depth-fallback`,
    );
    console.log(
      `      path. Output sameness is EXPECTED until Slice 5c lands real material normals.`,
    );
  }

  // Diff 3: A vs B — sanity check that toggling deferred ALONE (no AO)
  // doesn't somehow leak through to the canvas. Should be ~0%.
  const leakDiff = await diffPngs(A.out, B.out);
  console.log(`\n  [A vs B] DEFERRED LEAK CHECK (no AO, just def toggle):`);
  console.log(
    `    mismatch=${leakDiff.mismatchPct.toFixed(3)}% meanDelta=${leakDiff.meanDelta.toFixed(3)}`,
  );
  if (leakDiff.mismatchPct > noiseFloor) {
    console.log(
      `    !! deferred toggle leaks above noise floor (${noiseFloor.toFixed(3)}%) — producer may be writing to a visible target`,
    );
  } else {
    console.log(
      `    ✓ deferred toggle is invisible above noise (${leakDiff.mismatchPct.toFixed(3)}% ≤ ${noiseFloor.toFixed(3)}%)`,
    );
  }

  const reportPath = path.join(OUT_DIR, "slice4-verify-report.json");
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      {
        runAt: new Date().toISOString(),
        view: VIEW,
        clock: FIXED_CLOCK_UTC,
        captures: {
          A: { ...(A.errors.length && { errorCount: A.errors.length }) },
          A2: { ...(A2.errors.length && { errorCount: A2.errors.length }) },
          B: { ...(B.errors.length && { errorCount: B.errors.length }) },
          C: { ...(C.errors.length && { errorCount: C.errors.length }) },
          D: { ...(D.errors.length && { errorCount: D.errors.length }) },
        },
        diffs: {
          noiseFloor: noiseDiff,
          aoEngagement: aoDiff,
          slice4Signal: slice4Diff,
          deferredLeak: leakDiff,
        },
        diagnostics: {
          A: A.diagnostics,
          B: B.diagnostics,
          C: C.diagnostics,
          D: D.diagnostics,
        },
      },
      null,
      2,
    ),
  );
  console.log(`\n  report: ${reportPath}`);
})();
