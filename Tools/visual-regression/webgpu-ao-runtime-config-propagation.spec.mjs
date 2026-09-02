// webgpu-ao-runtime-config-propagation.spec.mjs — browser-free contract for
// the WebGPU post-process runtime configuration sync. Pure Node: no browser,
// no GPU, no build.
//
// @purpose Drives the real post-process bridge and the real AmbientOcclusionEffect against a recording fake device, and pins that a uniform written after the first enabled frame reaches the AO uniform buffer instead of being swallowed by the first-enable latch.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// On WebGL a `PostProcessStage`'s uniforms are read through its uniform map on
// every draw (`PostProcessStage.js` `createUniformMap` installs one getter per
// name and `getUniformMapFunction` reads `_actualUniforms[name]` at draw time),
// so `ambientOcclusion.uniforms.intensity = 2` is live on the next frame. On
// WebGPU the configuration is baked into uniform buffers when the effect is
// added to the pipeline, and the bridge added the effect exactly once — behind
// an `aoInitialized` latch that is set and never reset. Every uniform write
// after that first enabled frame was therefore inert on WebGPU and live on
// WebGL, for the same public API.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// Nothing here asserts source text. Three bundles are built with esbuild: the
// real bridge (with the real config-sync module and the real landing switch
// kept real), the real `AmbientOcclusionEffect` and the real
// `DepthOfFieldEffect`, with everything else stubbed. A recording fake device
// stands in for the GPU, so the assertion is made against the FLOAT PAYLOAD
// each effect writes into its uniform buffers — the values the pipeline
// actually receives — not against the config object the bridge passed, and not
// against the shape of the code that passed it. Depth of field is here because
// its `updateConfig` was uncalled for the same reason, and it exercises the
// same mechanism.
//
// The leak groups read the same recording. Every caller of `_createUniforms`
// after the first reassigns all four AO buffers, so all four of the previous
// ones must have been destroyed — by `updateConfig`, which released only the
// two whose values changed, and by `resize`, which released none.
//
// Each group then re-imports through a source mutation and requires its
// assertion to go RED. Both mutations are INERTNESS mutations — the code is
// still present and still called, but its effect is unreachable — because a
// guard that only survives deletion proves text presence, not that the branch
// is live. Both run the live group's own predicate and require it to throw, so
// a mutation that failed to make the propagation inert cannot pass by asserting
// something weaker. Every mutation runs through a vacuity check that fails
// loudly if its anchor moved.
//
// CRLF: this repo checks out with `core.autocrlf=true`; the anchors below are
// matched against LF-normalised text.
//
// Run: node --test Tools/visual-regression/webgpu-ao-runtime-config-propagation.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);
const BRIDGE_PATH = resolve(
  engineWebGPU,
  "WebGPUPostProcessStageCollection.ts",
);
const AO_EFFECT_PATH = resolve(engineWebGPU, "WebGPUAmbientOcclusionEffect.ts");
const DOF_EFFECT_PATH = resolve(engineWebGPU, "WebGPUDepthOfFieldEffect.ts");

/**
 * Reads a source file and normalises its line terminators, so anchors in this
 * file match regardless of the checkout's autocrlf setting.
 *
 * @param {string} path Absolute path to read.
 * @returns {Promise<string>} LF-normalised source.
 */
async function readSource(path) {
  return (await readFile(path, "utf8")).split("\r\n").join("\n");
}

// `createUniformBuffer` and `createTexture` read the WebGPU usage-flag globals
// at call time. The bit values are fixed by the specification, and nothing here
// depends on them beyond their being present.
globalThis.GPUBufferUsage ??= { UNIFORM: 0x40, COPY_DST: 0x08 };
globalThis.GPUTextureUsage ??= {
  TEXTURE_BINDING: 0x04,
  RENDER_ATTACHMENT: 0x10,
  COPY_DST: 0x08,
};

/**
 * A fake `GPUDevice` that records every buffer creation, buffer write and
 * buffer destruction. Everything else returns a labelled token: the effect
 * only stores those and hands them back to the same fake.
 *
 * @returns {object} The device and its recording.
 */
function makeRecordingDevice() {
  const created = [];
  const destroyed = [];
  const writes = [];
  const token = (label) => ({ label, createView: () => ({ label }) });
  const device = {
    createBuffer({ label, size, usage }) {
      const buffer = {
        label,
        size,
        usage,
        destroy() {
          destroyed.push(label);
        },
      };
      created.push(buffer);
      return buffer;
    },
    createTexture({ label }) {
      return { label, createView: () => ({ label }), destroy() {} };
    },
    createShaderModule({ label }) {
      return token(label);
    },
    createPipelineLayout({ label }) {
      return token(label);
    },
    createRenderPipeline({ label }) {
      return token(label);
    },
    createBindGroupLayout({ label }) {
      return token(label);
    },
    createBindGroup({ label }) {
      return token(label);
    },
    queue: {
      writeBuffer(buffer, offset, data) {
        // `createUniformBuffer` writes a whole Float32Array at offset 0; the
        // per-frame setters write a subrange through the (buffer, offset,
        // ArrayBuffer, byteOffset, byteLength) overload. Only the first is a
        // configuration payload.
        if (offset === 0 && ArrayBuffer.isView(data)) {
          writes.push({ label: buffer.label, values: Array.from(data) });
        }
      },
      writeTexture() {},
    },
  };
  return { device, created, destroyed, writes };
}

/**
 * The float payload of the most recent full write to a named uniform buffer.
 *
 * @param {Array} writes The recorded writes.
 * @param {string} label The buffer label.
 * @returns {number[]} The payload.
 */
function latestPayload(writes, label) {
  for (let i = writes.length - 1; i >= 0; i--) {
    if (writes[i].label === label) {
      return writes[i].values;
    }
  }
  throw new Error(`no write recorded for ${label}`);
}

// Offsets within `AO-Generate-UB`, from the packing comment above
// `_createUniforms`: params0(intensity, bias, lengthCap, stepCount) |
// params1(directionCount, 1/w, 1/h, randomTexSize) | frustum | params2.
const GENERATE_INTENSITY = 0;
const GENERATE_LENGTH_CAP = 2;
const GENERATE_STEP_COUNT = 3;
const GENERATE_DIRECTION_COUNT = 4;

/**
 * The stage a `PostProcessStageCollection` exposes as `ambientOcclusion`,
 * carrying the uniform bag the bridge reads.
 *
 * @returns {object} The stage.
 */
function makeAmbientOcclusionStage() {
  return {
    enabled: true,
    uniforms: {
      intensity: 2.0,
      bias: 0.1,
      lengthCap: 0.5,
      directionCount: 16,
      stepCount: 32,
    },
  };
}

/**
 * Builds the two bundles and wires a fake pipeline that constructs the REAL
 * `AmbientOcclusionEffect` the way `WebGPUPostProcessPipeline.addAmbientOcclusion`
 * does, then returns a `configure()` the caller can drive frame by frame.
 *
 * @param {object} [options] Options.
 * @param {Function} [options.mutateBridge] Rewrite applied to the bridge source.
 * @param {Function} [options.mutateConfigSync] Rewrite applied to the config-sync source.
 * @param {string} [options.label] Name used in the did-it-change assertion.
 * @returns {Promise<object>} The harness.
 */
async function makeHarness({
  mutateBridge,
  mutateConfigSync,
  depthOfField = false,
  label = "mutation",
} = {}) {
  const effects = await bundle({
    path: AO_EFFECT_PATH,
    source: await readSource(AO_EFFECT_PATH),
    real: [
      "WebGPUBindGroupCache",
      "WebGPUPostProcessEffects",
      "WebGPUBindGroupLayoutHelpers",
    ],
  });
  const bridge = await bundle({
    path: BRIDGE_PATH,
    source: await readSource(BRIDGE_PATH),
    real: ["WebGPUPostProcessConfigSync", "WebGPUAmbientOcclusionEffect"],
    mutate: mutateBridge,
    label,
    overrides: mutateConfigSync
      ? [
          {
            basename: "WebGPUPostProcessConfigSync.ts",
            mutate: mutateConfigSync,
            label,
          },
        ]
      : [],
  });

  const dofEffects = await bundle({
    path: DOF_EFFECT_PATH,
    source: await readSource(DOF_EFFECT_PATH),
    real: [
      "WebGPUBindGroupCache",
      "WebGPUPostProcessEffects",
      "WebGPUBindGroupLayoutHelpers",
    ],
  });

  const recording = makeRecordingDevice();
  let aoEffect = null;
  let dofEffect = null;
  const target = {
    // Mirrors `WebGPUPostProcessPipeline.addAmbientOcclusion`, including its
    // idempotence: the effect is constructed and initialised exactly once.
    addAmbientOcclusion(device, canvasFormat, config, useShaderF16) {
      if (aoEffect) return;
      aoEffect = new effects.AmbientOcclusionEffect(config);
      aoEffect.useShaderF16 = useShaderF16;
      aoEffect.initialize(device, 64, 64, canvasFormat);
    },
    // Mirrors `WebGPUPostProcessPipeline.addDepthOfField` the same way.
    addDepthOfField(device, canvasFormat, config, useShaderF16) {
      if (dofEffect) return;
      dofEffect = new dofEffects.DepthOfFieldEffect(config);
      dofEffect.useShaderF16 = useShaderF16;
      dofEffect.initialize(device, 64, 64, canvasFormat);
    },
  };
  // Everything the bridge touches on the pipeline beyond the AO slot is a
  // no-op: an absent effect reads null, an unknown method is a sink. Only the
  // ambient-occlusion path is real.
  const pipeline = new Proxy(target, {
    get(object, property) {
      if (typeof property === "symbol") return undefined;
      if (property === "ambientOcclusionEffect") return aoEffect;
      if (property === "depthOfFieldEffect") return dofEffect;
      if (property.endsWith("Effect")) return null;
      if (property in object) return object[property];
      return () => undefined;
    },
    set(object, property, value) {
      object[property] = value;
      return true;
    },
  });

  const stage = makeAmbientOcclusionStage();
  // Upstream exposes depth of field only as a named composite inside
  // `_stages`; `findDepthOfFieldStage` locates it by that name.
  const dofStage = {
    name: "czm_depth_of_field",
    enabled: true,
    uniforms: { focalDistance: 50.0, delta: 20.0, sigma: 4.0 },
  };
  const stages = depthOfField ? [dofStage] : [];
  const cache = {
    initialized: true,
    ambientOcclusionEnabled: true,
    aoInitialized: false,
    fxaaEnabled: false,
    bloomEnabled: false,
    depthOfFieldEnabled: depthOfField,
    dofInitialized: false,
    colorGradingEnabled: false,
    godRayEnabled: false,
    sunHaloEnabled: false,
    sunBloomEnabled: false,
    heatShimmerEnabled: false,
    coldOpticsEnabled: false,
    aerialPerspectiveEnabled: false,
    tonemappingEnabled: false,
    tonemapMode: 0,
    aoIntensity: 3.0,
    aoBias: 0.1,
    _userStagesBuilt: true,
    _userStagesCount: stages.length,
    _userStagesRefs: stages.slice(),
  };
  const collection = {
    ambientOcclusion: stage,
    bloom: { enabled: false, uniforms: {} },
    fxaa: { enabled: false, uniforms: {} },
    _stages: stages,
    _webgpuCache: cache,
  };
  // No camera frustum, so `resolvePostProcessFrustum` finds nothing and the
  // per-frame setters leave the configuration payload alone.
  const scene = { postProcessStages: collection };

  return {
    stage,
    cache,
    recording,
    configure() {
      bridge.configureWebGPUPostProcessPipeline(
        pipeline,
        collection,
        recording.device,
        "bgra8unorm",
        scene,
      );
    },
    generatePayload() {
      return latestPayload(recording.writes, "AO-Generate-UB");
    },
    effect() {
      return aoEffect;
    },
    dofStage,
    payload(label) {
      return latestPayload(recording.writes, label);
    },
  };
}

/**
 * Drives one first-enable frame, writes four AO uniforms, drives a second
 * frame, and requires the AO generate uniform buffer to carry the new values.
 *
 * The mutation groups run this same predicate and require it to THROW, so a
 * mutant that failed to make the propagation inert cannot pass by asserting
 * something weaker than the live group asserts.
 *
 * @param {object} harness The harness.
 */
function assertLaterWriteReachesTheEffect(harness) {
  harness.configure();
  harness.stage.uniforms.intensity = 1.25;
  harness.stage.uniforms.lengthCap = 0.75;
  harness.stage.uniforms.directionCount = 4;
  harness.stage.uniforms.stepCount = 8;
  harness.configure();
  const payload = harness.generatePayload();
  assert.equal(payload[GENERATE_INTENSITY], 1.25, "intensity after the write");
  assert.equal(payload[GENERATE_LENGTH_CAP], 0.75, "lengthCap after the write");
  assert.equal(payload[GENERATE_STEP_COUNT], 8, "stepCount after the write");
  assert.equal(
    payload[GENERATE_DIRECTION_COUNT],
    4,
    "directionCount after the write",
  );
}

test("WebGPU AO runtime configuration reaches the effect", async (t) => {
  await t.test(
    "the first enabled frame builds with the live uniforms",
    async () => {
      const harness = await makeHarness();
      harness.configure();
      const payload = harness.generatePayload();
      assert.equal(
        payload[GENERATE_INTENSITY],
        2.0,
        "intensity at first enable",
      );
      assert.equal(
        payload[GENERATE_LENGTH_CAP],
        0.5,
        "lengthCap at first enable",
      );
      assert.equal(
        payload[GENERATE_STEP_COUNT],
        32,
        "stepCount at first enable",
      );
      assert.equal(
        payload[GENERATE_DIRECTION_COUNT],
        16,
        "directionCount at first enable",
      );
    },
  );

  await t.test("a later write reaches the AO uniform buffer", async () => {
    const harness = await makeHarness();
    assertLaterWriteReachesTheEffect(harness);
  });

  await t.test("an unchanged frame pushes nothing", async () => {
    const harness = await makeHarness();
    harness.configure();
    const before = harness.recording.writes.length;
    harness.configure();
    const outcomeAfterSecondFrame = harness.cache._aoConfigOutcome;
    harness.configure();
    assert.equal(
      harness.recording.writes.length,
      before,
      "steady-state frames must not rewrite the uniform buffers",
    );
    // The configure pass runs every frame, so the propagation result must be a
    // record the caller owns rather than a fresh object per frame. Identity
    // across frames is what says so; a helper that returned a new object would
    // fail here while still passing every value assertion above.
    assert.ok(
      outcomeAfterSecondFrame,
      "the propagation outcome record must be held on the cache",
    );
    assert.equal(
      harness.cache._aoConfigOutcome,
      outcomeAfterSecondFrame,
      "the outcome record must be reused across frames, not reallocated",
    );
    assert.equal(
      harness.cache._aoConfigOutcome.changed,
      false,
      "an unchanged frame must report no change",
    );
  });

  await t.test("every replaced uniform buffer is destroyed", async () => {
    const harness = await makeHarness();
    harness.configure();
    const built = harness.recording.created.map((buffer) => buffer.label);
    assert.deepEqual(
      built,
      ["AO-Generate-UB", "AO-BlurH-UB", "AO-BlurV-UB", "AO-Modulate-UB"],
      "the effect builds four uniform buffers",
    );
    harness.stage.uniforms.intensity = 1.25;
    harness.configure();
    assert.deepEqual(
      harness.recording.destroyed.sort(),
      built.slice().sort(),
      "all four replaced buffers must be destroyed, not only the two whose " +
        "values changed",
    );
    assert.equal(
      harness.recording.created.length,
      8,
      "the update recreates all four uniform buffers",
    );
  });

  await t.test(
    "a resize releases the uniform buffers it replaces",
    async () => {
      const harness = await makeHarness();
      harness.configure();
      const built = harness.recording.created.map((buffer) => buffer.label);
      // `resize` re-runs `initialize`, which reassigns all four uniform buffers.
      harness.effect().resize(128, 128);
      assert.deepEqual(
        harness.recording.destroyed.sort(),
        built.slice().sort(),
        "a resize must release the uniform buffers it is about to replace",
      );
    },
  );

  await t.test(
    "depth of field takes a later write through the same mechanism",
    async () => {
      const harness = await makeHarness({ depthOfField: true });
      harness.configure();
      assert.equal(
        harness.payload("DoF-Composite-UB")[0],
        50.0,
        "focalDistance at first enable",
      );
      harness.dofStage.uniforms.focalDistance = 120.0;
      harness.dofStage.uniforms.delta = 35.0;
      harness.dofStage.uniforms.sigma = 6.0;
      harness.configure();
      const composite = harness.payload("DoF-Composite-UB");
      assert.equal(composite[0], 120.0, "focalDistance after the write");
      assert.equal(composite[1], 35.0, "focalRange after the write");
      assert.equal(
        harness.payload("DoF-BlurH-UB")[1],
        6.0,
        "blurSigma after the write",
      );
    },
  );
  await t.test(
    "inertness mutant: an unreachable propagation call goes red",
    async () => {
      // The call site stays, and still runs — its effect argument can never be
      // the effect, so the helper's null guard makes the push unreachable.
      const harness = await makeHarness({
        mutateBridge: (source) =>
          source.replace(
            "      const outcome = propagateConfigIfChanged(\n" +
              "        pipeline.ambientOcclusionEffect,",
            "      const outcome = propagateConfigIfChanged(\n" +
              "        false ? pipeline.ambientOcclusionEffect : null,",
          ),
        label: "unreachable AO propagation call",
      });
      assert.throws(
        () => assertLaterWriteReachesTheEffect(harness),
        assert.AssertionError,
        "with the propagation call unreachable the live group's own " +
          "assertion must fail — if it still passes, this spec is not " +
          "testing the propagation",
      );
    },
  );

  await t.test(
    "inertness mutant: a dirty check that never fires goes red",
    async () => {
      const harness = await makeHarness({
        mutateConfigSync: (source) =>
          source.replace("    changed = true;", "    changed = false;"),
        label: "dirty check that never fires",
      });
      assert.throws(
        () => assertLaterWriteReachesTheEffect(harness),
        assert.AssertionError,
        "with the dirty check inert the live group's own assertion must fail",
      );
    },
  );
});
