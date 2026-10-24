// water-async-pipeline-transition.spec.mjs — verification spec for async water shader compilation and smooth transition.
// @purpose Verifies non-blocking asynchronous compute and render pipeline compilation for OceanRenderer, fallback pipeline retention during ENHANCED_OCEAN toggles in GlobeSurfaceRenderer, and smooth transition ramps. The globe material's water mask (MATERIAL_APPLY) is executed and pinned in globe-classic-ocean-default-parity.spec.mjs section H.
// @status ACTIVE
//
// Tests 1-6 pin the shipped structure (and run the real tier module for the fade, the stash and the Tier 2 decision); test 7 pins the call sites of the async entry resolve and the cached fallback and runs against a copy without them (water-spec-mutants.mjs).
//
// Run: node --test Tools/visual-regression/water-async-pipeline-transition.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import {
  assertCallSiteLive,
  assertInertnessMutantTurnsRed,
  stripUses,
} from "./water-spec-mutants.mjs";

enableEngineTsResolution();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// The tier logic lives in WebGPUGlobeSurfaceOceanTiers.ts; these tests run the real
// module instead of reading its text.
const {
  GlobeOceanTierTransition,
  resolveUnderwaterTier,
  stashResolvedPipelinesAsFallback,
} = await import(
  pathToFileURL(
    path.join(
      root,
      "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceOceanTiers.ts",
    ),
  ).href
);

const globeTypesPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts",
);
const globePipelinesPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfacePipelines.ts",
);
const globeRendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
);
const globeCameraUBPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
);
const globeWgslPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
);
const oceanRendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUOceanRenderer.ts",
);

const globeTypesSrc = fs.readFileSync(globeTypesPath, "utf8");
const globePipelinesSrc = fs.readFileSync(globePipelinesPath, "utf8");
const globeRendererSrc = fs.readFileSync(globeRendererPath, "utf8");
const globeCameraUBSrc = fs.readFileSync(globeCameraUBPath, "utf8");
const globeWgslSrc = fs.readFileSync(globeWgslPath, "utf8");
const oceanRendererSrc = fs.readFileSync(oceanRendererPath, "utf8");

test("1. GlobePipelineEntry and resolveGlobePipelineEntry retain fallbackPipeline during async compile", () => {
  assert.match(
    globeTypesSrc,
    /fallbackPipeline\?:\s*GPURenderPipeline\s*\|\s*null;/,
    "GlobePipelineEntry must carry optional fallbackPipeline",
  );
  assert.match(
    globePipelinesSrc,
    /if\s*\(entry\.fallbackPipeline\)\s*\{\s*return\s+entry\.fallbackPipeline;\s*\}/,
    "resolveGlobePipelineEntry must return entry.fallbackPipeline while pending",
  );
  assert.match(
    globePipelinesSrc,
    /entry\.fallbackPipeline\s*=\s*null;\s*entry\.pending\s*=\s*false;\s*host\._noteEnhancedOceanPipelineResolved\?\.\(entry\);/,
    "resolveGlobePipelineEntry must clear fallbackPipeline and notify host when async compile resolves",
  );
  assert.match(
    globePipelinesSrc,
    /fallbackPipeline:\s*host\._fallbackPipelineCache\?\.get\(cacheKey\)\s*\?\?\s*null/,
    "pipeline selectors must seed fallbackPipeline from host._fallbackPipelineCache",
  );
});

test("2. WebGPUGlobeSurfaceRenderer preserves prior pipelines on _applyEnhancedOceanState and computes smooth deficit ramp", () => {
  assert.match(
    globeRendererSrc,
    /public\s+_fallbackPipelineCache:\s*Map<string,\s*GPURenderPipeline>\s*=\s*new\s+Map\(\);/,
    "Renderer must own _fallbackPipelineCache",
  );
  // The stash runs in the renderer before the cache is wiped, in all three
  // flips (enhanced ocean, underwater optics, and the opt-in water-provider
  // parity variant, water round 6).
  const stashThenClear =
    /stashResolvedPipelinesAsFallback\(\s*this\._pipelineCache,\s*this\._fallbackPipelineCache,?\s*\);[\s\S]*?this\._pipelineCache\.clear\(\);/g;
  assert.equal(
    (globeRendererSrc.match(stashThenClear) ?? []).length,
    3,
    "_applyEnhancedOceanState, _applyUnderwaterOpticsState and _applyWaterProviderParityState must stash resolved pipelines as fallbacks before clearing _pipelineCache",
  );
  // And the stash itself, run on the real function: a resolved pipeline, or a pending
  // entry's own fallback, survives the wipe; an empty cache leaves the fallbacks alone.
  const resolved = { name: "tier1" };
  const prior = { name: "tier0" };
  const fallbacks = new Map([["stale", { name: "stale" }]]);
  stashResolvedPipelinesAsFallback(
    new Map([
      ["a", { pipeline: resolved, fallbackPipeline: null }],
      ["b", { pipeline: null, fallbackPipeline: prior }],
      ["c", { pipeline: null, fallbackPipeline: null }],
    ]),
    fallbacks,
  );
  assert.deepEqual([...fallbacks.keys()], ["a", "b"]);
  assert.equal(fallbacks.get("a"), resolved);
  assert.equal(fallbacks.get("b"), prior);
  stashResolvedPipelinesAsFallback(new Map(), fallbacks);
  assert.deepEqual(
    [...fallbacks.keys()],
    ["a", "b"],
    "the second flip of a compound change must not drop the fallbacks the first one kept",
  );
  assert.match(
    globeRendererSrc,
    /public\s+_getOceanTransitionDeficit\(\):\s*number/,
    "Renderer must expose _getOceanTransitionDeficit()",
  );
  assert.match(
    globeCameraUBSrc,
    /host\._getOceanTransitionDeficit\s*\?\s*host\._getOceanTransitionDeficit\(\)\s*:\s*0/,
    "CameraUB must pack _getOceanTransitionDeficit into camera._pad4 slot",
  );

  // The deficit ramp, read from the shipped GlobeOceanTierTransition on a fake clock
  // rather than from a copy of its formula.
  let nowMs = 1000;
  const transition = new GlobeOceanTierTransition(() => nowMs);
  transition.onEnhancedChanged(true, true);
  assert.equal(transition.deficit, 1.0, "deficit holds at 1.0 while pending");
  const entry = {};
  transition.stamp(entry, true);
  transition.noteResolved(entry);
  const deficitAt = (elapsedMs, frame) => {
    nowMs = 1000 + elapsedMs;
    transition.beginFrame(frame);
    return transition.deficit;
  };
  assert.equal(
    deficitAt(0, 1),
    1.0,
    "deficit starts at 1.0 (0% enhanced offset)",
  );
  assert.equal(deficitAt(300, 2), 0.5, "deficit is 0.5 at midpoint");
  let prev = 1.0;
  for (let ms = 10, frame = 3; ms <= 590; ms += 10, frame++) {
    const cur = deficitAt(ms, frame);
    assert.ok(cur <= prev, `deficit must decrease monotonically at ${ms}ms`);
    prev = cur;
  }
  assert.equal(deficitAt(600, 100), 0.0, "deficit reaches 0.0 at 600ms");
  const stale = {};
  transition.invalidate();
  transition.onEnhancedChanged(false, true);
  transition.stamp(stale, true);
  transition.invalidate();
  transition.noteResolved(stale);
  assert.equal(
    transition.deficit,
    0.0,
    "a resolution from before a cache wipe must not restart the fade",
  );
});

test("3. GlobeTerrain.wgsl applies oceanTransition ramp and masks foamFactor", () => {
  assert.match(
    globeWgslSrc,
    /foamFactor\s*=\s*computeFoam\(waveN,\s*distance\)\s*\*\s*waterMaskValue;/,
    "shared wave block must mask foamFactor by waterMaskValue",
  );
  assert.match(
    globeWgslSrc,
    /let\s+oceanTransition\s*=\s*1\.0\s*-\s*clamp\(camera\.oceanTransitionDeficit,\s*0\.0,\s*1\.0\);/,
    "ENHANCED_OCEAN must derive oceanTransition from camera.oceanTransitionDeficit",
  );
  assert.match(
    globeWgslSrc,
    /let\s+waterOffset\s*=\s*\(blendedBase\s*-\s*baseColor\)\s*\*\s*(?:waterMaskValue|openWaterMask)\s*\*\s*oceanTransition;/,
    "ENHANCED_OCEAN must modulate waterOffset by oceanTransition",
  );
  assert.match(
    globeWgslSrc,
    /color\s*=\s*mix\(color,\s*foamColor,\s*foamFactor\);/,
    "ENHANCED_OCEAN must mix foamColor by foamFactor",
  );
});

test("4. WebGPUOceanRenderer compiles compute and render pipelines asynchronously and ramps warmup over 45 frames", () => {
  assert.match(
    oceanRendererSrc,
    /if\s*\(typeof\s+device\.createComputePipelineAsync\s*===\s*"function"\)/,
    "initializeOceanResources must prefer device.createComputePipelineAsync",
  );
  const asyncComputeCalls =
    oceanRendererSrc.match(/device\.createComputePipelineAsync\(/g) ?? [];
  assert.equal(
    asyncComputeCalls.length,
    6,
    "all 6 FFT ocean compute pipelines must compile via createComputePipelineAsync",
  );
  assert.match(
    oceanRendererSrc,
    /if\s*\(typeof\s+device\.createRenderPipelineAsync\s*===\s*"function"\)/,
    "tryResolveRenderPipeline must prefer createRenderPipelineAsync when central cache is absent",
  );
  assert.match(
    oceanRendererSrc,
    /if\s*\(!renderReady\s*\|\|\s*!cache\.computePipelinesReady\)\s*\{\s*return;\s*\}/,
    "updateWebGPUOcean must gate dispatch and draw emission on both renderReady and computePipelinesReady",
  );
  assert.match(
    oceanRendererSrc,
    /const\s+warmupT\s*=\s*Math\.min\(1\.0,\s*cache\.readyFrames\s*\/\s*45\.0\);/,
    "updateWebGPUOcean must compute a 45-frame warmup ramp after pipelines resolve",
  );
});

test("5. 3-Tier Lazy Async Pipeline: Tier 0 (definesHi=0), Tier 1 (ENHANCED_OCEAN), and Tier 2 (UNDERWATER_OPTICS < +500m) preprocess cleanly and pass Naga", async () => {
  const { preprocess, ShaderDefineHi } = await import("./lib/wgsl-variant.mjs");

  assert.equal(
    ShaderDefineHi.UNDERWATER_OPTICS,
    1 << 6,
    "ShaderDefineHi.UNDERWATER_OPTICS must be pinned to hi-word bit 6",
  );

  // Tier 0: Boot prewarmed classic water (definesHi = 0)
  const tier0 = preprocess(globeWgslSrc, 0, 0);
  assert.ok(
    !tier0.includes("fn computeCoxMunkOrbitalGlint(") &&
      !tier0.includes("fn computeUnderwaterVerticalOpticsAndBenthic("),
    "Tier 0 (definesHi = 0) must strip enhanced surface and underwater helpers for ultra-fast boot compile",
  );

  // Tier 1: Async surface enhanced ocean (definesHi = ENHANCED_OCEAN, camera >= 500 m)
  const tier1 = preprocess(globeWgslSrc, 0, ShaderDefineHi.ENHANCED_OCEAN);
  assert.ok(
    tier1.includes("fn computeCoxMunkOrbitalGlint(") &&
      tier1.includes("fn computePolarSeaIceAndGlacialPlume("),
    "Tier 1 (ENHANCED_OCEAN) must include surface enhanced ocean helpers",
  );
  assert.ok(
    !tier1.includes("let rovHeadlampRestore =") &&
      !tier1.includes("let volumetricGodRays ="),
    "Tier 1 (ENHANCED_OCEAN without UNDERWATER_OPTICS) must strip heavy underwater instructions for orbital/aviation cameras",
  );

  // Tier 2: Lazy async underwater pipeline (definesHi = ENHANCED_OCEAN | UNDERWATER_OPTICS, camera < 500 m)
  const tier2 = preprocess(
    globeWgslSrc,
    0,
    ShaderDefineHi.ENHANCED_OCEAN | ShaderDefineHi.UNDERWATER_OPTICS,
  );
  assert.ok(
    tier2.includes("let meniscusGlow =") &&
      tier2.includes("let volumetricGodRays =") &&
      tier2.includes("let rovHeadlampRestore =") &&
      tier2.includes("let benthicMicroRelief ="),
    "Tier 2 (ENHANCED_OCEAN | UNDERWATER_OPTICS) must include full Subnautica underwater and benthic optics",
  );

  assert.match(
    globeRendererSrc,
    /public\s+_applyUnderwaterOpticsState\(enabled:\s*boolean\):\s*void/,
    "WebGPUGlobeSurfaceRenderer must expose _applyUnderwaterOpticsState for lazy Tier 2 switching",
  );
  // Tier 2 below +500 m, released above +1500 m: the shipped decision, run on the eye.
  assert.equal(resolveUnderwaterTier(true, false, 400, false).wanted, true);
  assert.equal(resolveUnderwaterTier(true, false, 600, false).wanted, false);
  assert.equal(
    resolveUnderwaterTier(true, false, 1400, true).wanted,
    true,
    "an active Tier 2 holds until +1500 m",
  );
  assert.equal(resolveUnderwaterTier(true, false, 1600, true).wanted, false);
  assert.equal(
    resolveUnderwaterTier(false, false, 100, false).wanted,
    false,
    "Tier 2 is never wanted without enhanced ocean",
  );
  assert.match(
    globeRendererSrc,
    /resolveUnderwaterTier\(\s*this\._enhancedOceanEnabled,/,
    "WebGPUGlobeSurfaceRenderer must take the Tier 2 decision from resolveUnderwaterTier",
  );

  const nagaDir = path.join(root, "Tools/shader-pipeline/naga-wasm-tools");
  const naga = await import(
    pathToFileURL(path.join(nagaDir, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDir, "naga_wasm_tools_bg.wasm"),
    ),
  });

  assert.doesNotThrow(() => {
    naga.validate_wgsl(tier0);
    naga.validate_wgsl(tier1);
    naga.validate_wgsl(tier2);
  });
});

test("6. First-render bootstrap fallback pipeline, same-frame fallback preservation, speculative quantized prewarm, and SFU zero-weight guards", () => {
  assert.match(
    globePipelinesSrc,
    /function\s+resolveCachedFallbackPipeline\(/,
    "WebGPUGlobeSurfacePipelines must provide resolveCachedFallbackPipeline for instant Frame-0 rendering while async compilation runs",
  );
  assert.match(
    globePipelinesSrc,
    /host\._centralPipelineCache\.warm\(quantizedDescriptor\);/,
    "WebGPUGlobeSurfacePipelines must speculatively warm quantized (BITS12) counterpart when unquantized ENHANCED_OCEAN pipeline is created",
  );
  // Same-frame compound flips keep their fallbacks: the guard on an empty cache lives in
  // stashResolvedPipelinesAsFallback (run on the real function in test 2), and all
  // three flips go through it.
  assert.equal(
    (
      globeRendererSrc.match(
        /stashResolvedPipelinesAsFallback\(\s*this\._pipelineCache,/g,
      ) ?? []
    ).length,
    3,
    "_applyEnhancedOceanState, _applyUnderwaterOpticsState and _applyWaterProviderParityState must stash through stashResolvedPipelinesAsFallback",
  );
  assert.match(
    globeRendererSrc,
    /public\s+_noteEnhancedOceanFallbackUsed\(\):\s*void/,
    "WebGPUGlobeSurfaceRenderer must expose _noteEnhancedOceanFallbackUsed to arm smooth cross-fade when bootstrap fallback is served",
  );
  assert.match(
    globeWgslSrc,
    /if\s*\(distFade\s*<=\s*1\.0e-4\)\s*\{\s*return\s+0\.0;\s*\}/,
    "computeFoam must early-out when distFade <= 1.0e-4 above 65 km",
  );
  assert.match(
    globeWgslSrc,
    /if\s*\(rawCrest\s*<=\s*1\.0e-4\)\s*\{\s*return\s+0\.0;\s*\}/,
    "computeFoam must early-out when rawCrest <= 1.0e-4 in wave troughs",
  );
  assert.match(
    globeWgslSrc,
    /if\s*\(microSurfaceGate\s*>\s*1\.0e-4\)/,
    "computeEnhancedOcean must guard microSurfaceGate (catsPawGust + surfactantSlick) on zero-weight range",
  );
  assert.match(
    globeWgslSrc,
    /if\s*\(mesoBandWeight\s*>\s*1\.0e-4\)/,
    "computeEnhancedOcean must guard mesoSurfaceMod on mesoBandWeight > 1.0e-4",
  );
});

// Tests 1 and 6 are text pins on definitions; a definition keeps matching after every
// call to it is deleted. These pin the call sites of the async tier fallback and run
// against a copy without them.
test("7. inertness: the selectors resolve through the async entry and the cached fallback, and the checks go red when those calls are removed", () => {
  for (const [name, replacement] of [
    ["resolveGlobePipelineEntry", "null"],
    ["resolveCachedFallbackPipeline", "null"],
  ]) {
    assertInertnessMutantTurnsRed(
      `async tier fallback (${name})`,
      globePipelinesSrc,
      (text) => stripUses(text, name, replacement, { call: true }),
      (text) =>
        assertCallSiteLive(text, name, `async tier fallback (${name})`, {
          call: true,
        }),
    );
  }
});
