// @purpose Guards lib/cloud-probe-harness.mjs + cloud-perf-evidence pass resolution: config round-trip through the collection contract across six cloud probes.
// @status ACTIVE

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installCloudProbeHarness } from "./lib/cloud-probe-harness.mjs";
import { resolveCloudPerfPass } from "./lib/cloud-perf-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const probeFiles = [
  "probe-cloud-planetary.mjs",
  "probe-cloud-tour.mjs",
  "probe-cloud-temporal.mjs",
  "probe-cloud-temporal-rte.mjs",
  "probe-cloud-ibl-optout-revision.mjs",
  "probe-cloud-perf.mjs",
];

test("cloud probe configuration round-trips through the collection contract", () => {
  const volumetric = {
    cloudCoverage: 0.5,
    cloudDensity: 0.3,
    cloudQuality: 64,
    cloudWindDirection: { x: 0.7, y: 0.3 },
  };
  globalThis.viewer = {
    scene: {
      requestRenderMode: true,
      context: { rendererType: "webgpu", isWebGPU: true },
      globe: {
        defaultCloudCollection: {
          enableVolumetric: false,
          renderMode: 0,
          volumetric,
        },
      },
    },
  };

  try {
    installCloudProbeHarness();
    const truth = globalThis.__cloudProbe.configure({
      requireWebGPU: true,
      volumetric: {
        cloudCoverage: 0.35,
        cloudDensity: 0.7,
        cloudQuality: 128,
        cloudWindDirection: { x: 0.25, y: -0.5 },
      },
    });

    assert.equal(truth.ok, true);
    assert.equal(truth.requestRenderMode, false);
    assert.equal(truth.enableVolumetric, true);
    assert.deepEqual(truth.config, {
      cloudCoverage: 0.35,
      cloudDensity: 0.7,
      cloudQuality: 128,
      cloudWindDirection: { x: 0.25, y: -0.5 },
    });
  } finally {
    delete globalThis.__cloudProbe;
    delete globalThis.viewer;
  }
});

test("core cloud probes never gate volumetric fields on Globe", () => {
  const staleGlobeGuard = /if\s*\(\s*["']cloud[A-Za-z0-9_]+["']\s+in\s+g\s*\)/g;

  for (const file of probeFiles) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.equal(
      staleGlobeGuard.test(source),
      false,
      `${file} contains a stale Globe cloud-property guard`,
    );
    staleGlobeGuard.lastIndex = 0;
  }
});

test("core cloud probes use the deterministic offline viewer boot", () => {
  for (const file of probeFiles) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.match(
      source,
      /CesiumViewer\/index\.html\?renderer=.*offline=true/,
      `${file} must disable external terrain and imagery requests`,
    );
  }
});

test("manual cloud probes render with their fixed JulianDate", () => {
  for (const file of [
    "probe-cloud-planetary.mjs",
    "probe-cloud-tour.mjs",
    "probe-cloud-temporal.mjs",
    "probe-cloud-temporal-rte.mjs",
  ]) {
    const source = fs.readFileSync(path.join(here, file), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:s|scene)\.render\(\s*\)/,
      `${file} must not silently substitute JulianDate.now()`,
    );
    assert.match(
      source,
      /\b(?:s|scene)\.render\(frameTime\)/,
      `${file} must render the declared fixed time`,
    );
  }
});

test("cloud probe rejects misspelled or removed volumetric fields", () => {
  globalThis.viewer = {
    scene: {
      requestRenderMode: true,
      context: { rendererType: "webgpu", isWebGPU: true },
      globe: {
        defaultCloudCollection: {
          enableVolumetric: false,
          renderMode: 0,
          volumetric: { cloudCoverage: 0.5 },
        },
      },
    },
  };

  try {
    installCloudProbeHarness();
    assert.throws(
      () =>
        globalThis.__cloudProbe.configure({
          requireWebGPU: true,
          volumetric: { cloudCoverge: 0.35 },
        }),
      /unknown CloudVolumetrics property cloudCoverge/,
    );
    assert.equal(
      Object.hasOwn(
        globalThis.viewer.scene.globe.defaultCloudCollection.volumetric,
        "cloudCoverge",
      ),
      false,
    );
  } finally {
    delete globalThis.__cloudProbe;
    delete globalThis.viewer;
  }
});

// ---------------------------------------------------------------------------
// Readiness: pipeline built is not work recorded (C13-N08a)
// ---------------------------------------------------------------------------
//
// WHAT THIS GROUP IS FOR. `awaitProceduralReady` instrumented
// `featureRenderer.execute` and nothing else. Batch 1468 split the cloud
// composite in two and pointed the live scene path at
// `executePreparedCloudFrame`, so the instrumented entry stopped being called
// at all: readiness burned its 180 frames and reported `executeCalls=0` over a
// renderer that was rendering. That error is the whole of the banked
// `baseline-01` failure of 2026-09-09 and is what sent `C13-42d` looking for an
// engine bug. These tests assert the repaired contract by BEHAVIOUR — which
// entry the counters follow, and that a compiled pipeline on its own is not
// readiness — rather than by the shape of the instrumentation.

const HARNESS_PATH = path.join(here, "lib", "cloud-probe-harness.mjs");

/**
 * Import the harness from mutated source. The module has no imports of its own,
 * so the source needs no specifier rewriting before it becomes a data url.
 *
 * @param {Array<[string, string]>} replacements Anchor/replacement pairs.
 * @returns {Promise<object>} The mutated module namespace.
 */
async function importMutatedHarness(replacements = []) {
  // Normalized on the way in: an anchor that only matches under one checkout's
  // line endings reports on the checkout, not on the code.
  let source = fs.readFileSync(HARNESS_PATH, "utf8").replace(/\r\n/gu, "\n");
  for (const [anchor, replacement] of replacements) {
    const occurrences = source.split(anchor).length - 1;
    assert.equal(
      occurrences,
      1,
      `mutation anchor must occur exactly once, found ${occurrences}`,
    );
    source = source.replace(anchor, replacement);
  }
  const url = `data:text/javascript;base64,${Buffer.from(source).toString(
    "base64",
  )}`;
  return import(url);
}

const FRAME_TIME = Object.freeze({ authored: true });

/**
 * Drive `awaitProceduralReady` against a scene whose render step is supplied by
 * the caller, so each test decides which composite entry the composition takes.
 *
 * @param {object} setup Test setup.
 * @param {object} setup.renderer The feature renderer the context resolves.
 * @param {Function} setup.compose Called with the renderer on every rendered frame.
 * @param {number} [setup.cacheReadyAtFrame] Frame at which the renderer cache appears.
 * @param {number} [setup.maxFrames] Readiness frame bound.
 * @param {Function} [setup.install] The harness installer under test.
 * @returns {Promise<object>} `{ outcome, error, renderCalls }`.
 */
async function driveReadiness({
  renderer,
  compose,
  cacheReadyAtFrame = 2,
  maxFrames = 4,
  install = installCloudProbeHarness,
}) {
  // Matches the in-flight CloudUniforms layout: CLOUD_UNIFORM_FLOATS = 148 + 20
  // (CLOUD_DENSITY_PRIMARY_ORIGIN_FLOATS) + 4 (C13-16 CLOUD_GENUS_MORPHOLOGY_FLOATS)
  // + 4 (C13-N10 CLOUD_TIER_LIGHTING_FLOATS, the 172-175 tier lighting row)
  // = 176 floats. [2026-09-12, C13-N10: 172 -> 176. A fixture shorter than the
  // layout it claims to match is a latent out-of-range read the day this
  // harness grows a tail-slot assertion, so it grows with the renderer.]
  const uniformData = new Float32Array(176);
  uniformData[44] = 128;
  uniformData[45] = 8;
  uniformData[74] = 0;
  let renderCalls = 0;
  const context = {
    rendererType: "webgpu",
    isWebGPU: true,
    async getFeatureRendererAsync(key) {
      assert.equal(key, 32);
      return renderer;
    },
  };
  globalThis.viewer = {
    clock: { currentTime: FRAME_TIME },
    scene: {
      context,
      render(frameTime) {
        assert.deepEqual(frameTime, FRAME_TIME);
        renderCalls++;
        compose(renderer);
        if (renderCalls === cacheReadyAtFrame) {
          // The tier-3 shape of a SUCCESSFUL banked run: full resolution, so
          // the half-res and temporal targets are legitimately zero-sized.
          // Anything asserting on those zeros is asserting on the tier.
          context._cloudCache = {
            initialized: true,
            pipeline: {},
            uniformData,
            halfWidth: 0,
            halfHeight: 0,
            temporalWidth: 0,
            temporalHeight: 0,
            temporalPipeline: null,
            frameCounter: 0,
          };
        }
      },
    },
  };
  globalThis.requestAnimationFrame = (callback) => callback();

  try {
    install();
    const outcome = await globalThis.__cloudProbe.awaitProceduralReady({
      featureRendererKey: 32,
      frameTime: FRAME_TIME,
      maxFrames,
    });
    return { outcome, error: null, renderCalls };
  } catch (error) {
    return { outcome: null, error, renderCalls };
  } finally {
    delete globalThis.__cloudProbe;
    delete globalThis.viewer;
    delete globalThis.requestAnimationFrame;
  }
}

/** A renderer shaped like the post-Batch-1468 feature renderer. */
const splitRenderer = (recorded) => ({
  prepareCloudFrameAndEncodeMask: () => ({ kind: "prepared" }),
  executePreparedCloudFrame: () => recorded,
  // Present and never called — exactly as the live registration leaves it.
  execute: () => recorded,
});

/** The composition the scene actually performs: prepare, then composite. */
const composeSplit = (renderer) => {
  const prepared = renderer.prepareCloudFrameAndEncodeMask();
  renderer.executePreparedCloudFrame(prepared);
};

test("readiness follows the composite entry the scene calls, not the wrapper", async () => {
  const { outcome, error } = await driveReadiness({
    renderer: splitRenderer(true),
    compose: composeSplit,
  });

  assert.equal(error, null);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.waitedFrames, 2);
  assert.equal(outcome.preparedFrameCalls, 2);
  assert.equal(outcome.recordedFrames, 2);
  assert.equal(outcome.prepareCalls, 2);
  assert.equal(
    outcome.legacyExecuteCalls,
    0,
    "the wrapper entry is never called by the composition — counting only it was the defect",
  );
  assert.equal(
    outcome.executeCalls,
    2,
    "`executeCalls` keeps its published meaning for the probes that gate on it",
  );
  assert.equal(outcome.maxSteps, 128);
  assert.equal(outcome.pipelineReady, true);
});

test("a built pipeline that records no frame is not ready", async () => {
  // THE DISTINCTION THIS ROW EXISTS FOR. The cache is initialized and the
  // pipeline is built on every frame here; the composite entry is called on
  // every frame too. It just never returns `true`, so no frame was written.
  // Readiness must refuse, and the refusal must say which rung failed.
  const { outcome, error } = await driveReadiness({
    renderer: splitRenderer(false),
    compose: composeSplit,
  });

  assert.equal(outcome, null);
  assert.match(error.message, /recorded no frame in 4 moving frames/u);
  assert.match(
    error.message,
    /"recordedFrames":0/u,
    "the refusal must name the rung that failed",
  );
  assert.match(
    error.message,
    /"preparedFrameCalls":4/u,
    "and must show the composition DID reach the renderer, which is a different bug",
  );
  assert.match(
    error.message,
    /"pipelineReady":true/u,
    "a built pipeline is reported alongside, not instead of, recorded work",
  );
});

test("a composition that never reaches the renderer reads differently again", async () => {
  // Third rung: the renderer is resolvable and its cache initializes, but the
  // scene never composites. `prepareCalls` separates this from the case above,
  // so a zero is diagnosable instead of being one undifferentiated timeout.
  const { outcome, error } = await driveReadiness({
    renderer: splitRenderer(true),
    compose: () => {},
  });

  assert.equal(outcome, null);
  assert.match(error.message, /"prepareCalls":0/u);
  assert.match(error.message, /"preparedFrameCalls":0/u);
  assert.match(error.message, /"recordedFrames":0/u);
});

test("the legacy wrapper entry still counts as recorded work", async () => {
  // Back-compatibility, and not decoration: a probe pinned to an older served
  // build still takes `executeProceduralClouds`, and its readiness must not
  // regress because the split entry became the counted one.
  const { outcome, error } = await driveReadiness({
    renderer: { execute: () => true },
    compose: (renderer) => renderer.execute(),
  });

  assert.equal(error, null);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.legacyExecuteCalls, 2);
  assert.equal(outcome.preparedFrameCalls, 0);
  assert.equal(outcome.recordedFrames, 2);
  assert.equal(outcome.executeCalls, 2);
});

test("a void-returning wrapper entry is still recorded work", async () => {
  // `executeProceduralClouds` was declared `void` when it was written and
  // only later forwarded the split entry's boolean. Demanding `true` off that
  // entry would make readiness permanently unreachable for any probe on the
  // wrapper path — a hard refusal, not a false pass. Only an explicit `false`
  // says the frame was not recorded, and that is asserted here too.
  const drive = (returns) =>
    driveReadiness({
      renderer: { execute: () => returns },
      compose: (renderer) => renderer.execute(),
    });

  const silent = await drive(undefined);
  assert.equal(silent.error, null);
  assert.equal(silent.outcome.ok, true);
  assert.equal(silent.outcome.recordedFrames, 2);

  const refused = await drive(false);
  assert.equal(refused.outcome, null);
  assert.match(refused.error.message, /"recordedFrames":0/u);
  assert.match(refused.error.message, /"legacyExecuteCalls":4/u);
});

test("the renderer is handed back exactly as it was found", async () => {
  // Both exits. A readiness helper that leaves a counting wrapper installed
  // charges every later frame of the run for the instrumentation, and the
  // refusal path is the one that used to be easy to leak.
  for (const recorded of [true, false]) {
    const renderer = splitRenderer(recorded);
    const originals = {
      prepareCloudFrameAndEncodeMask: renderer.prepareCloudFrameAndEncodeMask,
      executePreparedCloudFrame: renderer.executePreparedCloudFrame,
      execute: renderer.execute,
    };
    await driveReadiness({ renderer, compose: composeSplit });
    for (const [method, original] of Object.entries(originals)) {
      assert.equal(
        renderer[method],
        original,
        `${method} was left wrapped after a ${recorded ? "ready" : "refused"} readiness`,
      );
    }
  }
});

test("INERTNESS: uncounted, the split entry times out over a rendering renderer", async () => {
  // Make the repair unreachable while leaving everything else — including the
  // wrapper instrumentation — live. If readiness still passes, these tests are
  // passing on something other than the fix.
  const mutated = await importMutatedHarness([
    [
      "const preparedInstrumented = instrument(",
      "const preparedInstrumented = false && instrument(",
    ],
  ]);

  const { outcome, error } = await driveReadiness({
    renderer: splitRenderer(true),
    compose: composeSplit,
    install: mutated.installCloudProbeHarness,
  });

  assert.equal(
    outcome,
    null,
    "the mutant must NOT reach readiness — otherwise the assertions above prove nothing",
  );
  assert.match(error.message, /recorded no frame in 4 moving frames/u);
  assert.match(error.message, /"preparedFrameCalls":0/u);
});
test("explicit cloud perf pairs cannot degrade to single-artifact passes", () => {
  const resolve = (overrides) =>
    resolveCloudPerfPass({
      currentArtifactValid: true,
      pairId: null,
      comparisonStatus: "not-requested",
      comparisonPassed: null,
      ...overrides,
    });

  assert.equal(resolve({}), true);
  assert.equal(
    resolve({ pairId: "pair-a", comparisonStatus: "missing-companion" }),
    false,
  );
  assert.equal(
    resolve({
      pairId: "pair-a",
      comparisonStatus: "noncomparable-companion",
    }),
    false,
  );
  assert.equal(
    resolve({
      pairId: "pair-a",
      comparisonStatus: "compared",
      comparisonPassed: true,
    }),
    true,
  );
  assert.equal(
    resolve({
      pairId: "pair-a",
      comparisonStatus: "compared",
      comparisonPassed: false,
    }),
    false,
  );
  assert.equal(resolve({ currentArtifactValid: false }), false);
});
