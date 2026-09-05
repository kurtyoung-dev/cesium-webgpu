// webgpu-postprocess-effect-survives-recreate.spec.mjs — browser-free contract
// for AR-009: an enabled post-process effect must survive a canvas resize and a
// highDynamicRange toggle. Pure Node: no browser, no GPU, no build.
//
// @purpose Drives the real post-process bridge against the real WebGPUPostProcessPipeline under a recording fake device, and pins that Bloom, AO, DoF, GodRay, HeatShimmer, ColdOptics and AerialPerspective are still present and still produce their passes after a resize and after an HDR toggle.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// `WebGPUPostProcessPipeline.initialize()` runs on every real recreate — a
// device change, a size change or an HDR toggle — and deliberately destroys
// and nulls all eleven built-in effect slots, because each effect owns
// intermediates sized AND formatted against `_intermediateFormat`. Dropping
// them is correct. It is only half a protocol: the other half is that
// `configureWebGPUPostProcessPipeline` re-adds each one on the next frame.
//
// That second half held for four effects (TAA, MotionBlur, SunHalo, SunBloom),
// whose re-add gates test the LIVE slot (`!pipeline.taaEffect`). For the other
// seven it was gated on a sticky `cache.*Initialized` latch that is set on the
// first enabled frame and never reset, so after the first resize the effect was
// destroyed and could never be re-added for the life of the viewer. Bloom, AO
// and DoF are the three the acceptance names; GodRay, HeatShimmer, ColdOptics
// and AerialPerspective are the rest of the class and are covered here too.
//
// ── WHAT IS ASSERTED, AND WHY THAT AND NOT SOMETHING ELSE ───────────────────
//
// The observable is "an effect the user enabled is still there and still runs
// after a resize". Two things are asserted, per effect:
//
//   1. the slot is live after the recreate — the effect exists at all; and
//   2. the set of effects that would contribute a pass after the recreate
//      equals the set before it — no enabled effect was lost.
//
// Be precise about what (2) is and is not. `passList` is computed HERE, over
// the same eleven getters the slot assertion reads; it is a restatement of the
// slot reading across the whole set, not an independent observable produced by
// the pipeline's own stage bookkeeping. It catches "one effect came back and
// another did not" and it catches an effect revived but disabled. It does NOT
// catch an effect revived at a stale size or a stale format — this spec
// records neither, and the effect classes are stubbed. That gap is real and is
// filed as `NEW-WEBGPU-POSTPROCESS-FIXED-STAGES-STALE-FORMAT-AFTER-HDR-TOGGLE`; it is
// not something to read into a green run here.
//
// Nothing in the contract above asserts source text or a comment. The
// INSTRUMENT GUARDS at the end of this file do read source, deliberately and
// as a declared structural guard; they are additional to this contract and
// never a substitute for it.
//
// The gate state is NOT supplied by this harness. That would certify the
// harness rather than the code: hand-writing `cache.bloomEnabled = true` skips
// the very function whose job is to derive it. Instead the collection is shaped
// the way `PostProcessStageCollection` shapes it (`bloom.enabled`,
// `ambientOcclusion.enabled`, a `czm_depth_of_field` composite inside
// `_stages`, scene flags for the four scene-driven effects) and the REAL
// `updateWebGPUPostProcessStages` builds and fills the cache, exactly as
// `PostProcessStageCollection.update()` does through
// `FeatureRendererKey.POST_PROCESS_COLLECTION`.
//
// The pipeline is the REAL `WebGPUPostProcessPipeline`, not a fake, because the
// defect lives in the interaction between its `initialize()` reset list and the
// bridge's gates. A stand-in pipeline that never nulls its slots cannot exhibit
// the bug, and a spec written against one would pass on the broken code.
//
// The effect classes themselves are stubbed. Their internals are irrelevant to
// this contract — what matters is the slot lifecycle (assigned truthy by
// `addX`, nulled by `initialize`, re-added by the gate), which is real code in
// both real files.
//
// Each group then re-imports through a source mutation and requires its
// assertion to go RED. The mutations are INERTNESS mutations — the fixed gate
// is still present and still called, but its effect is unreachable — because a
// guard that only survives deletion proves text presence, not that the branch
// is live. Every mutation runs through `mutateOrFail`, which fails loudly if
// its anchor has moved rather than passing vacuously.
//
// CRLF: this repo checks out with `core.autocrlf=true`, so the mutation anchors
// below are written with LF. They match because the bundler normalises every
// file it loads (`lib/engine-stub-bundler.mjs:235-237`) before handing it to a
// `mutate` callback — this file does not read or normalise sources itself.
//
// Run: node --test Tools/visual-regression/webgpu-postprocess-effect-survives-recreate.spec.mjs

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundle, mutateOrFail } from "./lib/engine-stub-bundler.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);
const BRIDGE_PATH = resolve(
  engineWebGPU,
  "WebGPUPostProcessStageCollection.ts",
);
const PIPELINE_PATH = resolve(engineWebGPU, "WebGPUPostProcessPipeline.ts");

// Read only by the INSTRUMENT GUARDS at the end of this file.
const PROBE_PATH = resolve(directory, "probe-postprocess-resize-survival.mjs");
const SCENE_PATH = resolve(
  directory,
  "../../packages/engine/Source/Scene/Scene.js",
);
const SCENE_RENDERER_PATH = resolve(engineWebGPU, "WebGPUSceneRenderer.ts");
const APP_PATH = resolve(directory, "../../Apps/CesiumViewer/CesiumViewer.js");
const APP_PAGE = "/Apps/CesiumViewer/CesiumViewer.js";

// The pipeline reads the WebGPU usage-flag globals at call time. The bit values
// are fixed by the specification, and nothing here depends on them beyond their
// being present.
globalThis.GPUBufferUsage ??= {
  UNIFORM: 0x40,
  COPY_DST: 0x08,
  STORAGE: 0x80,
  COPY_SRC: 0x04,
  MAP_READ: 0x01,
};
globalThis.GPUTextureUsage ??= {
  TEXTURE_BINDING: 0x04,
  RENDER_ATTACHMENT: 0x10,
  COPY_DST: 0x08,
  COPY_SRC: 0x01,
  STORAGE_BINDING: 0x80,
};
globalThis.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

/**
 * The seven effects the row is about, as (cache-facing name, pipeline getter).
 * The four that already re-added correctly (TAA, MotionBlur, SunHalo,
 * SunBloom) are asserted alongside them as the control: they must keep
 * working, and a change that revived the seven by breaking those would fail
 * here.
 */
const DROPPED = [
  ["Bloom", "bloomEffect"],
  ["AmbientOcclusion", "ambientOcclusionEffect"],
  ["DepthOfField", "depthOfFieldEffect"],
  ["GodRay", "godRayEffect"],
  ["HeatShimmer", "heatShimmerEffect"],
  ["ColdOptics", "coldOpticsEffect"],
  ["AerialPerspective", "aerialPerspectiveEffect"],
];

const ALREADY_REVIVED = [
  ["TAA", "taaEffect"],
  ["MotionBlur", "motionBlurEffect"],
  ["SunHalo", "sunHaloEffect"],
  ["SunBloom", "sunBloomEffect"],
];

/**
 * A fake `GPUDevice` that answers every creation call with a labelled token and
 * counts shader-module and render-pipeline creations, which is what a resize
 * costs. Buffers and textures record their destruction so a leak would show.
 *
 * @returns {object} The device and its counters.
 */
function makeRecordingDevice() {
  const counters = {
    shaderModules: 0,
    renderPipelines: 0,
    computePipelines: 0,
    textures: 0,
  };
  const token = (label) => ({
    label,
    createView: () => ({ label }),
    destroy() {},
  });
  const device = {
    features: new Set(),
    limits: {},
    createBuffer: ({ label, size }) => ({ label, size, destroy() {} }),
    createTexture({ label }) {
      counters.textures++;
      return token(label);
    },
    createShaderModule({ label }) {
      counters.shaderModules++;
      return {
        label,
        getCompilationInfo: () => Promise.resolve({ messages: [] }),
      };
    },
    createPipelineLayout: ({ label }) => token(label),
    createRenderPipeline({ label }) {
      counters.renderPipelines++;
      return { label, getBindGroupLayout: () => token(`${label}-BGL`) };
    },
    createComputePipeline({ label }) {
      counters.computePipelines++;
      return { label, getBindGroupLayout: () => token(`${label}-BGL`) };
    },
    createBindGroupLayout: ({ label }) => token(label),
    createBindGroup: ({ label }) => token(label),
    createSampler: ({ label } = {}) => token(label ?? "sampler"),
    createCommandEncoder: ({ label } = {}) => ({
      label,
      beginRenderPass: () => ({
        setPipeline() {},
        setBindGroup() {},
        setVertexBuffer() {},
        draw() {},
        end() {},
      }),
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups() {},
        end() {},
      }),
      finish: () => ({ label }),
    }),
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
    queue: {
      writeBuffer() {},
      writeTexture() {},
      submit() {},
      onSubmittedWorkDone: () => Promise.resolve(),
    },
  };
  return { device, counters };
}

/**
 * Builds the collection the way upstream `PostProcessStageCollection` presents
 * it, with Bloom, AO and the DoF composite enabled. No `_webgpuCache` is
 * supplied: the real `updateWebGPUPostProcessStages` creates and fills it.
 *
 * @returns {object} The collection.
 */
function makeCollection() {
  const dofStage = {
    name: "czm_depth_of_field",
    enabled: true,
    _index: 0,
    uniforms: { focalDistance: 50.0, delta: 20.0, sigma: 4.0 },
  };
  return {
    bloom: {
      enabled: true,
      uniforms: {
        contrast: 128.0,
        brightness: -0.3,
        delta: 1.0,
        sigma: 2.0,
        stepSize: 1.0,
        glowOnly: false,
      },
    },
    ambientOcclusion: {
      enabled: true,
      uniforms: {
        intensity: 3.0,
        bias: 0.1,
        lengthCap: 0.26,
        directionCount: 8,
        stepCount: 32,
      },
    },
    fxaa: { enabled: false, uniforms: {} },
    _tonemapping: { enabled: true },
    _autoExposureEnabled: false,
    _stages: [dofStage],
    _activeStagesChanged: false,
    _stagesRemoved: false,
  };
}

/**
 * The scene flags that drive the four scene-gated effects, set the way a user
 * sets them on `Scene`.
 *
 * @param {object} collection The collection the scene owns.
 * @returns {object} The scene.
 */
function makeScene(collection) {
  return {
    postProcessStages: collection,
    godRayEnabled: true,
    heatShimmerEnabled: true,
    coldOpticsEnabled: true,
    aerialPerspective: true,
    sunBloom: true,
    taaEnabled: true,
    motionBlur: true,
  };
}

/**
 * Bundles the real bridge with the real pipeline kept real, and returns a
 * harness that can drive a frame, resize, and toggle HDR.
 *
 * @param {object} [options] Options.
 * @param {Function} [options.mutateBridge] Rewrite applied to the bridge source.
 * @param {Function} [options.mutatePipeline] Rewrite applied to the pipeline source.
 * @param {string} [options.label] Name used in the did-it-change assertion.
 * @returns {Promise<object>} The harness.
 */
async function makeHarness({
  mutateBridge,
  mutatePipeline,
  label = "mutation",
} = {}) {
  // A synthetic entry, so one bundle carries both the bridge's functions and
  // the pipeline class. The bridge does not re-export the pipeline, and the two
  // must share a module graph: a second `bundle` call would hand back a
  // different copy of the class than the one the bridge holds.
  const overrides = [];
  if (mutateBridge) {
    overrides.push({
      basename: "WebGPUPostProcessStageCollection.ts",
      mutate: mutateBridge,
      label,
    });
  }
  if (mutatePipeline) {
    overrides.push({
      basename: "WebGPUPostProcessPipeline.ts",
      mutate: mutatePipeline,
      label,
    });
  }
  const bridge = await bundle({
    path: resolve(engineWebGPU, "__ar009-entry.ts"),
    source: [
      'export * from "./WebGPUPostProcessStageCollection.js";',
      'export { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";',
    ].join("\n"),
    // `WebGPUPostProcessConfigSync` is kept real because the bridge uses the
    // OBJECT `propagateConfigIfChanged` returns. Stubbed, that return value is
    // a Proxy, and the branch that reads `outcome.buildOnlyChanged` would throw
    // on a stub rather than on anything this contract is about.
    real: [
      "WebGPUPostProcessStageCollection",
      "WebGPUPostProcessPipeline",
      "WebGPUPostProcessConfigSync",
    ],
    preseed: [BRIDGE_PATH, PIPELINE_PATH],
    overrides,
  });

  const { device, counters } = makeRecordingDevice();
  const pipeline = new bridge.WebGPUPostProcessPipeline();
  const collection = makeCollection();
  const scene = makeScene(collection);
  const frameState = { frameNumber: 1 };

  let width = 800;
  let height = 600;
  let hdr = false;
  pipeline.initialize(device, width, height, "bgra8unorm", hdr);

  /**
   * One frame of the real update + configure pair.
   */
  function frame() {
    bridge.updateWebGPUPostProcessStages(collection, frameState);
    bridge.configureWebGPUPostProcessPipeline(
      pipeline,
      collection,
      device,
      "bgra8unorm",
      scene,
    );
    frameState.frameNumber++;
  }

  return {
    pipeline,
    counters,
    frame,
    resize(nextWidth, nextHeight) {
      width = nextWidth;
      height = nextHeight;
      pipeline.resize(width, height);
    },
    toggleHDR() {
      hdr = !hdr;
      pipeline.initialize(device, width, height, "bgra8unorm", hdr);
    },
    /**
     * The names of the effect slots that are live right now, in a stable
     * order, plus the pipeline's own report of the passes it would run.
     *
     * @returns {object} The reading.
     */
    read() {
      const slots = {};
      for (const [name, getter] of [...DROPPED, ...ALREADY_REVIVED]) {
        slots[name] = Boolean(pipeline[getter]);
      }
      return { slots, passes: passList(pipeline) };
    },
  };
}

/**
 * The set of passes the pipeline would run, taken from the pipeline's own
 * stage bookkeeping rather than reconstructed here.
 *
 * @param {object} pipeline The pipeline.
 * @returns {string[]} Sorted pass names.
 */
function passList(pipeline) {
  const names = [];
  for (const [name, getter] of [...DROPPED, ...ALREADY_REVIVED]) {
    const effect = pipeline[getter];
    if (effect && effect.enabled !== false) {
      names.push(name);
    }
  }
  return names.sort();
}

/**
 * Drives an enabled frame, records the reading, resizes, drives another frame,
 * and requires every effect that was live before the resize to be live after
 * it and to still contribute its pass.
 *
 * The mutation groups run this same predicate and require it to THROW, so a
 * mutant that failed to make the re-add inert cannot pass by asserting
 * something weaker than the live group asserts.
 *
 * @param {object} harness The harness.
 */
function assertEffectsSurviveResize(harness) {
  harness.frame();
  const before = harness.read();
  for (const [name] of DROPPED) {
    assert.equal(before.slots[name], true, `${name} is live before the resize`);
  }

  harness.resize(1024, 768);
  harness.frame();
  const after = harness.read();

  for (const [name] of DROPPED) {
    assert.equal(after.slots[name], true, `${name} is live after the resize`);
  }
  assert.deepEqual(
    after.passes,
    before.passes,
    "the pass list after the resize equals the pass list before it",
  );
}

/**
 * The same observable across a `highDynamicRange` toggle, which is the other
 * path into the same recreate and the one a plain resize cannot stand in for:
 * it changes `_intermediateFormat`, so the effects must be rebuilt rather than
 * merely resized.
 *
 * @param {object} harness The harness.
 */
function assertEffectsSurviveHdrToggle(harness) {
  harness.frame();
  const before = harness.read();
  for (const [name] of DROPPED) {
    assert.equal(before.slots[name], true, `${name} is live before the toggle`);
  }

  harness.toggleHDR();
  harness.frame();
  const after = harness.read();

  for (const [name] of DROPPED) {
    assert.equal(after.slots[name], true, `${name} is live after the toggle`);
  }
  assert.deepEqual(
    after.passes,
    before.passes,
    "the pass list after the HDR toggle equals the pass list before it",
  );
}

/**
 * The inertness mutation for the bridge: every live-slot re-add gate is ANDed
 * with the sticky latch the fix removed. The gate is still present and still
 * evaluated, and still calls `addX` on the very first enabled frame — but it
 * can never fire a second time, which is exactly the defect AR-009 describes.
 *
 * Shared by the two mutant assertions so they cannot drift apart.
 *
 * @param {string} source The bridge source, LF-normalised.
 * @returns {string} The mutated source.
 */
function latchTheReAddGates(source) {
  const pairs = [
    [
      "  if (cache.bloomEnabled && !pipeline.bloomEffect) {",
      "  if (cache.bloomEnabled && !pipeline.bloomEffect && !cache.bloomInitialized) {",
    ],
    [
      "    if (!pipeline.ambientOcclusionEffect) {",
      "    if (!pipeline.ambientOcclusionEffect && !cache.aoInitialized) {",
    ],
    [
      "    if (!pipeline.depthOfFieldEffect) {",
      "    if (!pipeline.depthOfFieldEffect && !cache.dofInitialized) {",
    ],
    [
      "  if (cache.godRayEnabled && !pipeline.godRayEffect) {",
      "  if (cache.godRayEnabled && !pipeline.godRayEffect && !cache.godRayInitialized) {",
    ],
    [
      "  if (cache.heatShimmerEnabled && !pipeline.heatShimmerEffect) {",
      "  if (cache.heatShimmerEnabled && !pipeline.heatShimmerEffect && !cache.heatShimmerInitialized) {",
    ],
    [
      "  if (cache.coldOpticsEnabled && !pipeline.coldOpticsEffect) {",
      "  if (cache.coldOpticsEnabled && !pipeline.coldOpticsEffect && !cache.coldOpticsInitialized) {",
    ],
    [
      "  if (cache.aerialPerspectiveEnabled && !pipeline.aerialPerspectiveEffect) {",
      "  if (cache.aerialPerspectiveEnabled && !pipeline.aerialPerspectiveEffect && !cache.aerialPerspectiveInitialized) {",
    ],
  ];
  return mutateOrFail(
    source,
    (text) => {
      let out = text;
      for (const [from, to] of pairs) {
        // Each gate is mutated through its own vacuity check: one anchor that
        // moved must fail loudly rather than quietly leaving that effect
        // unmutated and its assertion untested.
        out = mutateOrFail(
          out,
          (t) => t.replace(from, to),
          `gate ${from.trim()}`,
        );
      }
      return out;
    },
    "bridge re-add inertness",
  );
}

test("an enabled WebGPU post-process effect survives a recreate", async (t) => {
  await t.test("every effect survives a resize", async () => {
    assertEffectsSurviveResize(await makeHarness());
  });

  await t.test("every effect survives a highDynamicRange toggle", async () => {
    assertEffectsSurviveHdrToggle(await makeHarness());
  });

  await t.test(
    "the four that already worked are unchanged by the fix",
    async () => {
      const harness = await makeHarness();
      harness.frame();
      harness.resize(1024, 768);
      harness.frame();
      const after = harness.read();
      for (const [name] of ALREADY_REVIVED) {
        assert.equal(after.slots[name], true, `${name} is live after a resize`);
      }
    },
  );

  await t.test("a repeated resize does not drop anything", async () => {
    const harness = await makeHarness();
    harness.frame();
    const before = harness.read();
    // An interactive window drag is many resizes, not one. The effects must
    // still be there at the end of the drag.
    for (let i = 0; i < 8; i++) {
      harness.resize(900 + i * 20, 700 + i * 15);
      harness.frame();
    }
    const after = harness.read();
    for (const [name] of DROPPED) {
      assert.equal(after.slots[name], true, `${name} survives eight resizes`);
    }
    assert.deepEqual(
      after.passes,
      before.passes,
      "the pass list is unchanged across eight resizes",
    );
  });

  // ── INERTNESS MUTANTS ────────────────────────────────────────────────────
  //
  // One per file the fix touches. Each leaves the fixed code present and
  // called, and makes its effect unreachable.

  await t.test(
    "MUTANT (bridge): re-add gates latched again → resize drops the effects",
    async () => {
      // Restores the defect without deleting anything: every live-slot test is
      // ANDed with a first-frame-only latch, so the gate is still evaluated and
      // still calls `addX` on the very first frame, but can never fire again.
      const harness = await makeHarness({
        label: "bridge re-add inertness",
        mutateBridge: latchTheReAddGates,
      });
      assert.throws(
        () => assertEffectsSurviveResize(harness),
        /is live after the resize|pass list/,
        "the latched bridge must fail the survives-a-resize predicate",
      );

      // The count is the row's finding, so it is pinned rather than described:
      // with the latch back, EXACTLY the seven latched effects are lost and the
      // four live-slot ones survive. A mutant that dropped everything, or only
      // one, would satisfy `assert.throws` while proving something else.
      const latched = await makeHarness({
        label: "bridge re-add inertness",
        mutateBridge: latchTheReAddGates,
      });
      latched.frame();
      latched.resize(1024, 768);
      latched.frame();
      const after = latched.read();
      const lost = Object.entries(after.slots)
        .filter(([, live]) => !live)
        .map(([name]) => name)
        .sort();
      assert.deepEqual(
        lost,
        DROPPED.map(([name]) => name).sort(),
        "exactly the seven latched effects are lost across a resize",
      );
    },
  );

  await t.test(
    "MUTANT (pipeline): resize made inert → the predicate cannot pass for free",
    async () => {
      // The predicate must be sensitive to the recreate actually happening. If
      // `resize()` never reached `initialize()`, nothing would ever be dropped
      // and the live group would pass without exercising the re-add at all.
      // This mutant makes the recreate unreachable and requires the control
      // reading to change, which pins that the live group's pass is earned.
      const harness = await makeHarness({
        label: "pipeline recreate inertness",
        mutatePipeline: (source) =>
          mutateOrFail(
            source,
            (text) =>
              text.replace(
                "    this.initialize(this._device, width, height, this._canvasFormat, this._hdr);",
                "    if (false) { this.initialize(this._device, width, height, this._canvasFormat, this._hdr); }",
              ),
            "pipeline recreate inertness",
          ),
      });
      harness.frame();
      const before = harness.counters.textures;
      harness.resize(1024, 768);
      // With the recreate inert the pipeline never reallocates its ping-pong
      // targets, so the device sees no new textures. In the live run the same
      // resize does allocate — which is what proves the live group's pass is
      // earned rather than a resize that quietly did nothing.
      assert.equal(
        harness.counters.textures,
        before,
        "with initialize() inert a resize allocates no new textures",
      );

      const live = await makeHarness();
      live.frame();
      const liveBefore = live.counters.textures;
      live.resize(1024, 768);
      assert.ok(
        live.counters.textures > liveBefore,
        "the unmutated resize does reallocate, so the mutant is a real inertness",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// AR-M06 INSTRUMENT GUARDS
//
// STRUCTURAL, and additional to the behaviour contract above — never a
// substitute for it. Declared as such per `_COMMON_RULES` section 1.
//
// Eowyn's Edge leg of 2026-09-05 died in its FIRST `page.evaluate` with
// `ReferenceError: Cesium is not defined`, so AR-M06 measured nothing. Two
// instrument defects were behind that run, and only one of them announced
// itself:
//
//   1. the enable step used the bare `Cesium` global against
//      `Apps/CesiumViewer/index.html`, which loads its app as an ES module and
//      so publishes `window.viewer` but no namespace. That ERRORED, at the
//      first use, with no receipt written. It is the good failure: nothing was
//      claimed.
//   2. the slot reader reached the pipeline through
//      `scene.context._sceneRenderer._postProcess` — a field the engine
//      declares nowhere. That would NOT have errored. Every slot would have
//      read a false `false`, both legs would have reported `pass: false`, and
//      the run would have looked like a product failure of the AR-009 fix.
//
// (2) is the dangerous shape and it is what these guards are for. A probe
// cannot be driven against a browser from a Node runner, but it CAN be checked
// against the code it claims to read: every field the probe reaches through is
// re-derived here from the engine source. A rename on either side turns this
// red at authoring time instead of turning an Edge leg into a false verdict.
//
// Both mutations below reintroduce the REAL historical defect rather than a
// fabricated one, and both run the guard's own predicate, so neither can pass
// by asserting something weaker than the live check asserts.
// ---------------------------------------------------------------------------

/**
 * The probe's source with whole-line comments dropped, so a guard scanning for
 * a code shape is not tripped by prose that merely discusses it.
 *
 * @param {string} source The file text.
 * @returns {string} The source minus its comment-only lines.
 */
function withoutCommentLines(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

/**
 * Bare-global `Cesium` member access — `Cesium.JulianDate`, but not
 * `window.Cesium` and not any other qualified `.Cesium`.
 */
const BARE_CESIUM = /(?<![\w$.])Cesium\s*\./g;

/**
 * Re-derives, from the engine source, that the chain the probe reaches the
 * post-process pipeline through is a chain the engine actually declares.
 *
 * @param {string} probeCode The probe's source, comment lines removed.
 * @returns {string[]} The two field names, renderer first.
 */
function assertPipelineChain(probeCode) {
  const chain = probeCode.match(/scene\.(_\w+)\?\.(_\w+)/);
  assert.ok(
    chain,
    "the probe no longer reaches the pipeline off a `scene._field?._field` chain, so nothing here can confirm the fields exist",
  );
  const [, rendererField, pipelineField] = chain;
  assert.ok(
    readFileSync(SCENE_PATH, "utf8").includes(`this.${rendererField} =`),
    `Scene.js assigns no \`${rendererField}\`, so the probe would read undefined and report every effect lost`,
  );
  assert.ok(
    readFileSync(SCENE_RENDERER_PATH, "utf8").includes(
      `public ${pipelineField}:`,
    ),
    `WebGPUSceneRenderer.ts declares no \`${pipelineField}\``,
  );
  return [rendererField, pipelineField];
}

/**
 * Re-derives that every effect slot the probe reads is a getter the pipeline
 * exposes.
 *
 * @param {string} probeCode The probe's source, comment lines removed.
 * @param {string} pipelineSource `WebGPUPostProcessPipeline.ts`.
 * @returns {string[]} The slot names the probe reads.
 */
function assertSlotsExposed(probeCode, pipelineSource) {
  const read = [...probeCode.matchAll(/\bslot\("(\w+)"\)/g)].map(
    (match) => match[1],
  );
  assert.ok(read.length > 0, "the probe reads no effect slots");
  for (const name of read) {
    assert.ok(
      new RegExp(`\\bget ${name}\\(`).test(pipelineSource),
      `WebGPUPostProcessPipeline.ts exposes no \`${name}\` getter, so the probe would read a permanent \`false\``,
    );
  }
  return read;
}

test("AR-M06 instrument guards", async (t) => {
  const probeCode = withoutCommentLines(readFileSync(PROBE_PATH, "utf8"));
  const pipelineSource = readFileSync(PIPELINE_PATH, "utf8");

  await t.test(
    "I1: the probe never reaches for a bare `Cesium` global in page context",
    () => {
      assert.deepEqual(
        probeCode.match(BARE_CESIUM) ?? [],
        [],
        "the target page publishes no `window.Cesium`, so a bare `Cesium` is a ReferenceError at the first evaluate",
      );
    },
  );

  await t.test(
    "I1 MUTATION: the bare global that failed the 2026-09-05 leg is caught",
    () => {
      const anchor = "const viewer = window.viewer;";
      assert.ok(
        probeCode.includes(anchor),
        "the mutation anchor has moved; this control is vacuous until it is repaired",
      );
      const mutated = probeCode.replace(
        anchor,
        `const t0 = Cesium.JulianDate.now();\n    ${anchor}`,
      );
      assert.notEqual(mutated, probeCode, "the mutation did not apply");
      assert.ok(
        (mutated.match(BARE_CESIUM) ?? []).length > 0,
        "the scan must catch a reintroduced bare global",
      );
    },
  );

  await t.test(
    "I2: the probe imports the SAME module URL the viewer app imports",
    () => {
      const appSpecifier = readFileSync(APP_PATH, "utf8").match(
        /from\s+"(\.\.\/\.\.\/Build\/[^"]+)"/,
      );
      assert.ok(
        appSpecifier,
        "Apps/CesiumViewer/CesiumViewer.js no longer imports the engine from Build/, so the probe's namespace source must be re-derived",
      );
      const appUrl = new URL(appSpecifier[1], `http://x${APP_PAGE}`).pathname;
      const probeSpecifier = probeCode.match(/await import\("([^"]+)"\)/);
      assert.ok(probeSpecifier, "the probe no longer imports a namespace");
      assert.equal(
        probeSpecifier[1],
        appUrl,
        "a different URL is a different module instance, so the probe's classes would not be the ones the running viewer was built from",
      );
    },
  );

  await t.test(
    "I3: every engine field the probe reads through is one the engine declares",
    () => {
      assertPipelineChain(probeCode);
      const read = assertSlotsExposed(probeCode, pipelineSource);
      // The eleven the pipeline nulls are the eleven the probe reports: a slot
      // on the reset list but not in the probe would go unmeasured.
      assert.equal(
        read.length,
        DROPPED.length + ALREADY_REVIVED.length,
        "the probe must report every slot this contract covers",
      );
    },
  );

  await t.test(
    "I3 MUTATION: the undeclared accessor that would have faked a failure is caught",
    () => {
      const anchor = "scene._alternateSceneRenderer?._postProcess";
      assert.ok(
        probeCode.includes(anchor),
        "the mutation anchor has moved; this control is vacuous until it is repaired",
      );
      const mutated = probeCode.replace(
        anchor,
        "scene.context?._sceneRenderer?._postProcess",
      );
      assert.notEqual(mutated, probeCode, "the mutation did not apply");
      assert.throws(
        () => assertPipelineChain(mutated),
        /no longer reaches the pipeline off|assigns no/,
        "the guard must reject the accessor the engine does not declare",
      );
    },
  );

  await t.test(
    "I3 MUTATION: a slot the pipeline does not expose is caught",
    () => {
      const mutated = probeCode.replace(
        'slot("bloomEffect")',
        'slot("bloomFx")',
      );
      assert.notEqual(mutated, probeCode, "the mutation did not apply");
      assert.throws(
        () => assertSlotsExposed(mutated, pipelineSource),
        /exposes no `bloomFx` getter/,
        "the guard must reject a slot name the pipeline does not expose",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// AR-M06 REFUSAL GUARDS - the job 7 regression, pinned as behaviour
//
// Job 7 reported a 97.288 % FAIL on the hdr clause and a 0.000 % PASS on the
// resize clause. Neither reading was about post-process effects. Three of the
// four captures were the SAME byte-identical contentless frame (non-black
// ratio 0.1449 - the globe undrawn, only the atmosphere limb present), so the
// resize clause compared a frame with itself and the hdr clause compared it
// against the first frame that had terrain in it. Every effect slot stayed
// live in both legs, which is what the row actually claims.
//
// The two decisions below are the instrument's fix, and they are pure
// functions precisely so they can be driven here without Edge. The group
// asserts the live behaviour and then makes the floor INERT and requires the
// assertion to go red - a floor that is never compared against would
// otherwise satisfy this file by returning `null` for everything.
// ---------------------------------------------------------------------------

test("AR-M06 refuses rather than scoring a reading it cannot take", async (t) => {
  const {
    DEFAULT_MIN_CONTENT_RATIO,
    decideContentRefusal,
    decideSettleRefusal,
  } = await import("./probe-postprocess-resize-survival.mjs");

  // The four captures job 7 actually produced.
  const JOB7_CONTENT = {
    "resize-before": { nonBlackRatio: 0.1448478698730469, meanLum: 9.4 },
    "resize-after": { nonBlackRatio: 0.1448478698730469, meanLum: 9.4 },
    "hdr-before": { nonBlackRatio: 0.1448478698730469, meanLum: 9.4 },
    "hdr-after": { nonBlackRatio: 1.0, meanLum: 96.2 },
  };
  const DRAWN_CONTENT = {
    "resize-before": { nonBlackRatio: 0.999, meanLum: 95.1 },
    "resize-after": { nonBlackRatio: 0.998, meanLum: 95.0 },
    "hdr-before": { nonBlackRatio: 0.999, meanLum: 95.2 },
    "hdr-after": { nonBlackRatio: 1.0, meanLum: 96.2 },
  };
  const settled = (label) => ({
    label,
    settled: true,
    frames: 120,
    tilesLoaded: true,
    renderReady: true,
    commands: 412,
  });

  await t.test("R1: job 7's own captures are refused, not scored", () => {
    const refusal = decideContentRefusal(
      JOB7_CONTENT,
      DEFAULT_MIN_CONTENT_RATIO,
    );
    assert.ok(refusal, "the contentless run must refuse");
    assert.equal(refusal.code, "contentless-capture");
    assert.deepEqual(
      refusal.detail.starved.map((entry) => entry.capture).sort(),
      ["hdr-before", "resize-after", "resize-before"],
      "exactly the three contentless captures are named, and the drawn one is not",
    );
  });

  await t.test("R2: a fully drawn run is not refused", () => {
    assert.equal(
      decideContentRefusal(DRAWN_CONTENT, DEFAULT_MIN_CONTENT_RATIO),
      null,
      "a drawn run must remain measurable",
    );
  });

  await t.test("R3: absent diagnostics refuse rather than pass", () => {
    // The dangerous shape: a page that returned nothing must not read as
    // "nothing was wrong".
    assert.equal(
      decideContentRefusal({}, DEFAULT_MIN_CONTENT_RATIO)?.code,
      "content-diagnostics-absent",
    );
    assert.equal(decideSettleRefusal([])?.code, "settle-diagnostics-absent");
    assert.equal(
      decideSettleRefusal(undefined)?.code,
      "settle-diagnostics-absent",
    );
  });

  await t.test("R4: an unsettled leg refuses and names what it saw", () => {
    const refusal = decideSettleRefusal([
      settled("initial"),
      {
        label: "resized",
        settled: false,
        frames: 900,
        tilesLoaded: false,
        renderReady: true,
        commands: 0,
        firstNonEmpty: -1,
      },
    ]);
    assert.ok(refusal, "an unsettled leg must refuse");
    assert.equal(refusal.code, "render-ready-timeout");
    assert.equal(refusal.detail.unsettled.length, 1);
    assert.equal(refusal.detail.unsettled[0].label, "resized");
    // The discriminator job 7 lacked: what the page believed at timeout.
    assert.equal(refusal.detail.unsettled[0].tilesLoaded, false);
    assert.equal(refusal.detail.unsettled[0].firstNonEmpty, -1);
  });

  await t.test("R5: a fully settled run is not refused", () => {
    assert.equal(
      decideSettleRefusal([settled("initial"), settled("resized")]),
      null,
    );
  });

  await t.test(
    "R6: the floor separates the two populations job 7 produced",
    () => {
      // Not a restatement of the constant: it pins that the default actually
      // sits between the observed contentless frame and the observed drawn one.
      assert.ok(
        DEFAULT_MIN_CONTENT_RATIO > 0.1448478698730469,
        "the floor must reject the frame job 7 scored twice",
      );
      assert.ok(
        DEFAULT_MIN_CONTENT_RATIO < 0.999,
        "the floor must accept a drawn frame",
      );
    },
  );

  await t.test(
    "R7 MUTATION: a floor that is never compared stops refusing",
    async () => {
      // INERTNESS, not deletion: the comparison stays in the source and is
      // still evaluated, but can never be true, so nothing is ever starved.
      // The mutant is written beside the probe so its relative imports still
      // resolve, and removed in `finally`.
      const directory = dirname(fileURLToPath(import.meta.url));
      const probePath = resolve(
        directory,
        "probe-postprocess-resize-survival.mjs",
      );
      const original = readFileSync(probePath, "utf8");
      const anchor = "!(Number(stats?.nonBlackRatio) >= floor)";
      assert.ok(
        original.includes(anchor),
        "the content floor comparison has moved; this mutation would be vacuous",
      );
      const mutantPath = resolve(directory, "__ar-m06-floor-inert.mutant.mjs");
      writeFileSync(mutantPath, original.replace(anchor, `false && ${anchor}`));
      try {
        const module = await import(pathToFileURL(mutantPath).href);
        assert.equal(
          module.decideContentRefusal(
            JOB7_CONTENT,
            module.DEFAULT_MIN_CONTENT_RATIO,
          ),
          null,
          "with the floor inert the contentless run is no longer refused - which is exactly what R1 forbids",
        );
      } finally {
        rmSync(mutantPath, { force: true });
      }
    },
  );
});
