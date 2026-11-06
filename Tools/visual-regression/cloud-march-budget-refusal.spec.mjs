// cloud-march-budget-refusal.spec.mjs — a cloud frame whose march does not fit
// the march budget even at one primary step is refused rather than encoded, and
// every frame whose one-step floor fits is unchanged.
// @purpose Executes the real cloud resolver and the real cloud frame preparation under a recording fake device to prove that a frame past the budget's floor resolves to zero primary steps and is refused as "march-budget-exceeded" before it uploads, allocates history or encodes a pass; that the refusal does not stick; that every frame whose floor fits resolves, counts and encodes exactly as the renderer did before the refusal existed; and that each of the two gates made unreachable turns the matching assertion red.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// The march budget reduces a frame that does not fit: primary steps first,
// then the light steps, never below one primary step. A frame whose one-step
// floor still costs more than the budget used to be encoded at that floor
// anyway, over budget. The resolver now reports zero primary steps for such a
// frame and the renderer refuses it. Zero steps must never reach an encoder,
// and the frames either side of the line must not change.
//
// WHAT IS ASSERTED
// ----------------
//  S1. THE RESOLVER. At and past each pinned drawing-buffer threshold the
//      resolver returns zero primary steps with every field but the step
//      counts as asked, and reports the budget applied, a zero cost and an ask
//      over the budget. One pixel under the threshold the floor fits. Across
//      the sweep no resolved preset costs more than the budget, and a preset
//      with one primary step always fits.
//  S2. THE RENDERER. Through the real frame preparation, a canvas past the
//      threshold for the frame's own facts yields a negative outcome with
//      reason "march-budget-exceeded": no write to the cloud uniform buffer,
//      no temporal-history texture, no render pass, a counter record that reads
//      refused with the ask and the budget, a lifetime frame count that moved
//      and an execute serial that did not. The next frame at a fitting canvas
//      prepares normally, so the refusal does not stick. No encoded frame
//      ever carries zero primary steps.
//  S3. IDENTITY WHERE THE FLOOR FITS. For every default tier row and auto
//      band, with the mask pass on and off, multi-deck on and off, at
//      1920x1080, 3840x2160 and 8192x8192, plus frames where the budget is
//      applied and steps still fit, the resolved preset, the budget report, the
//      whole counter record, the uniform upload, the pass labels and the
//      outcome are identical to what the renderer produced before the refusal.
//      Those outputs are recorded in a fixture and compared to the live ones.
//      The only counter the live record adds is marchBudgetRefused, asserted
//      zero on every fitting frame and left out of the equality. Nothing
//      clock-based is recorded: the counter record carries no timing (CPU stage
//      timings live on a separate accumulator that is not read), and the
//      frames run on a fixed scene time.
//  S4. INERTNESS MUTANTS. The renderer with its refusal made unreachable
//      turns S2 red; the resolver with its zero-step branch made unreachable
//      turns S1 red.
//
// NOT ASSERTED HERE: that a device completes a fitting frame, or that a canvas
// past the threshold is creatable on a device (the fake device accepts any
// size). Both belong to the named Edge leg.
//
// Record the fixture (needs git and the tree-ish of the renderer before the
// refusal): CLOUD_REFUSAL_RECORD=1 CLOUD_REFUSAL_BASE_TREE=<tree-ish> node --test Tools/visual-regression/cloud-march-budget-refusal.spec.mjs
// Run: node --test Tools/visual-regression/cloud-march-budget-refusal.spec.mjs

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import { bundle } from "./lib/engine-stub-bundler.mjs";

Error.stackTraceLimit = 0;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const ENGINE_SOURCE = resolve(REPO_ROOT, "packages/engine/Source");
const WEBGPU = resolve(ENGINE_SOURCE, "Renderer/WebGPU");
const FIXTURE = resolve(HERE, "fixtures/cloud-march-budget-refusal-base.json");
const PRESETS_REL =
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts";
const RENDERER_REL =
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts";
const OBSERVABILITY_REL =
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudObservability.ts";
const PRESETS = resolve(REPO_ROOT, PRESETS_REL);
const RENDERER = resolve(REPO_ROOT, RENDERER_REL);

const RECORDING = process.env.CLOUD_REFUSAL_RECORD === "1";
const BASE_TREE = process.env.CLOUD_REFUSAL_BASE_TREE;

const missingGeneratedShaders = ["CloudDensityDomain.js", "ProceduralClouds.js"]
  .map((name) => resolve(ENGINE_SOURCE, "Shaders/WebGPU/Environment", name))
  .filter((shader) => !existsSync(shader));

// The resolver is pure and imports nothing, so its tests need no build. The
// renderer composes the generated shader modules, so its tests skip, with the
// reason, when those are missing; a present but broken module still fails.
function resolverTest(name, body) {
  return nodeTest(name, body);
}
function rendererTest(name, body) {
  return nodeTest(
    name,
    {
      skip:
        missingGeneratedShaders.length > 0
          ? `STRUCTURAL: generated shader prerequisites missing: ${missingGeneratedShaders.join(", ")}; run npx gulp build`
          : false,
    },
    body,
  );
}

// ── Loading the code under test ─────────────────────────────────────────────

function lf(text) {
  return text.split("\r\n").join("\n");
}

function readSource(path) {
  return lf(readFileSync(path, "utf8"));
}

function replaceExactlyOnce(before, after, name) {
  return (text) => {
    const occurrences = text.split(before).length - 1;
    assert.equal(occurrences, 1, `${name} anchor must occur exactly once`);
    return text.replace(before, after);
  };
}

const REFUSAL_GATE =
  "if (cloudMarchBudget.budgetApplied && cloudPreset.primarySteps === 0) {";
const ZERO_STEP_GATE = "if (!(cloudMarchCost(minimum, inputs) <= budget)) {";

/** Renderer with its refusal made unreachable. */
const REFUSAL_UNREACHABLE = {
  basename: "WebGPUProceduralCloudRenderer.ts",
  label: "refusal unreachable",
  mutate: replaceExactlyOnce(
    REFUSAL_GATE,
    `if (false && ${REFUSAL_GATE.slice(4)}`,
    "refusal gate",
  ),
};
/** Resolver with its zero-step branch made unreachable. */
const ZERO_STEP_UNREACHABLE = {
  basename: "WebGPUCloudTierPresets.ts",
  label: "zero-step branch unreachable",
  mutate: replaceExactlyOnce(
    ZERO_STEP_GATE,
    `if (false && ${ZERO_STEP_GATE.slice(4)}`,
    "zero-step gate",
  ),
};

const resolverCache = new Map();
/**
 * The cloud resolver module, optionally with one rewrite applied.
 *
 * @param {object} [mutant] A mutant from above.
 * @returns {Promise<object>} The module namespace.
 */
function loadResolver(mutant) {
  const key = mutant?.label ?? "live";
  if (!resolverCache.has(key)) {
    resolverCache.set(
      key,
      bundle({
        path: PRESETS,
        source: readSource(PRESETS),
        real: [],
        mutate: mutant?.mutate,
        label: mutant?.label,
      }),
    );
  }
  return resolverCache.get(key);
}

// Engine modules resolved as implementation rather than as bundler stubs: the
// ones the cloud frame preparation reaches. Everything else is a Proxy stub.
const REAL_PATHS = [
  "WebGPUProceduralCloudRenderer.ts",
  "WebGPUBindGroupLayoutHelpers.ts",
  "WebGPUBindGroupCache.ts",
  "WebGPUCloudObservability.ts",
  "WebGPUCloudTierPresets.ts",
  "WebGPUCloudDensityDomain.ts",
  "WebGPUCloudNoiseResources.ts",
  "WebGPUDeviceInvalidationBus.ts",
  "WebGPUShaderDefines.ts",
  "WebGPUShaderPreprocessor.ts",
  "WebGPUShaderModuleCache.ts",
  "WebGPUPipelineRequestGuard.ts",
  "WebGPUCloudReconstructionAttachments.ts",
  "WebGPUCloudTemporalHistory.ts",
  "WebGPUCloudShadowFrame.ts",
  "WebGPUCloudShadowBindGroupCache.ts",
  "WebGPUCloudWeatherTransition.ts",
  "CloudWeatherTransition.ts",
  "CloudWeatherTransition.js",
  "JulianDate.js",
  "binarySearch.js",
  "GregorianDate.js",
  "isLeapYear.js",
  "LeapSecond.js",
  "TimeConstants.js",
  "TimeStandard.js",
  "WeatherVerticalField.ts",
  "CloudWeatherVertical.js",
  "WeatherCloudLayers.ts",
  "CloudVolumetrics.js",
  "Check.js",
  "DeveloperError.js",
  "Frozen.js",
  "CloudPopulationWeather.js",
  "CloudPopulationLighting.js",
  "CloudPopulationMarch.js",
  "CloudDeckResolve.js",
  "WebGPUCloudUniformLayout.ts",
  "CloudDensityDomain.js",
  "CloudMarchSampling.js",
  "CloudSolarLighting.js",
  "CloudViewIntegration.js",
  "CloudAerialTransport.js",
  "CloudAirLight.js",
  "CloudRayEllipsoid.js",
  "WebGPUCloudAirLight.ts",
  "WebGPUCloudPrimaryReuse.ts",
  "WebGPUCloudMarchFeatures.ts",
  "WebGPUCloudSpatialOccupancy.ts",
  "WebGPUCloudNoiseBounds.ts",
  "WebGPUCloudWeatherBounds.ts",
  "WebGPUCloudDensityCache.ts",
  "WebGPUCloudDensityCacheProgram.ts",
  "CloudDensityCache.js",
  "CloudLightMarch.js",
  "CloudDirectionalLighting.js",
  "CloudDeepShadow.js",
  "WebGPUCloudDeepShadowCache.ts",
  "CloudDeepShadowCache.js",
  "CloudPrimaryDensity.js",
  "CloudLightingBudget.js",
  "WebGPUCloudLightingBudget.ts",
  "CloudDensitySnapshot.js",
  "CloudWeatherVolumeBounds.js",
  "CloudWeatherOctree.js",
  "OctreeNode.js",
  "BoundingRectangle.js",
  "BoundingSphere.js",
  "CloudSpatialOccupancy.js",
  "CloudNoiseBounds.js",
  "CloudNoiseBoundsQuery.js",
  "CloudPrimaryComposite.js",
  "CloudUpscale.js",
  "CloudTemporalResolve.js",
  "CloudReconstructionAttachments.js",
  "CloudMaterialFlow.js",
  "WebGPUCloudMaterialFlow.ts",
  "CloudDensityFormation.js",
  "CloudDensityMoments.js",
  "ProceduralClouds.js",
  "Cartesian3.js",
  "defined.js",
  "EncodedCartesian3.js",
  "Matrix4.js",
  "OrthographicFrustum.js",
  "OrthographicOffCenterFrustum.js",
  "SceneMode.js",
  "CloudTypeProfile.js",
  "CloudType.js",
  "EclipseCloudResponse.js",
];

const RENDERER_ENTRY = [
  'import { beginCloudFrameAttempt, prepareCloudFrameAndEncodeMask, executePreparedCloudFrame, completePreparedCloudMask, cancelPreparedCloudFrame, ensureCloudCache } from "./WebGPUProceduralCloudRenderer.js";',
  'import { resolveCloudPreset, describeCloudMarchBudget, buildCloudQualityInputs, cloudMarchCost, CLOUD_MARCH_BUDGET_DEFAULT } from "./WebGPUCloudTierPresets.js";',
  "export { beginCloudFrameAttempt, prepareCloudFrameAndEncodeMask, executePreparedCloudFrame, completePreparedCloudMask, cancelPreparedCloudFrame, ensureCloudCache, resolveCloudPreset, describeCloudMarchBudget, buildCloudQualityInputs, cloudMarchCost, CLOUD_MARCH_BUDGET_DEFAULT };",
].join("\n");

const rendererCache = new Map();
/**
 * The cloud renderer bundled with its real dependencies. `overrides` rewrite a
 * real dependency; the record mode replaces whole files with their text from
 * before the refusal.
 *
 * @param {string} key Cache key.
 * @param {object[]} [overrides] Dependency rewrites.
 * @returns {Promise<object>} The module namespace.
 */
function loadRenderer(key, overrides = []) {
  if (!rendererCache.has(key)) {
    rendererCache.set(
      key,
      bundle({
        path: resolve(WEBGPU, "CloudMarchBudgetRefusalEntry.ts"),
        source: RENDERER_ENTRY,
        real: REAL_PATHS,
        preseed: [RENDERER],
        overrides,
      }),
    );
  }
  return rendererCache.get(key);
}

// ── The recording fake device ───────────────────────────────────────────────

let nextId = 0;
function token(kind, descriptor = {}) {
  const value = {
    kind,
    id: `${kind}-${++nextId}`,
    descriptor,
    destroyed: false,
  };
  value.createView = (viewDescriptor = {}) =>
    token(`${kind}-view`, { texture: value, ...viewDescriptor });
  value.destroy = () => {
    value.destroyed = true;
  };
  return value;
}

function installWebGpuConstants() {
  globalThis.GPUBufferUsage ??= {
    COPY_DST: 1,
    UNIFORM: 2,
    VERTEX: 4,
    INDEX: 8,
    STORAGE: 16,
  };
  globalThis.GPUTextureUsage ??= {
    COPY_DST: 1,
    COPY_SRC: 2,
    TEXTURE_BINDING: 4,
    RENDER_ATTACHMENT: 8,
    STORAGE_BINDING: 16,
  };
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
}

/**
 * A device that implements only the calls the cloud frame reaches and keeps
 * object identity rather than emulating pixels. Its receipts are the contract
 * under test. It accepts any texture size: the limit is the device's, not the
 * renderer's.
 *
 * @returns {{device: object, receipts: object, makeEncoder: Function}} The recorder.
 */
function makeRecordingDevice() {
  installWebGpuConstants();
  const receipts = {
    created: [],
    passes: [],
    writes: [],
    textureWrites: [],
    submits: [],
  };
  const makeDeviceToken = (kind, descriptor = {}) => {
    const value = token(kind, descriptor);
    receipts.created.push(value);
    return value;
  };
  const queue = {
    writeBuffer(buffer, offset, data, dataOffset, size) {
      receipts.writes.push({
        buffer,
        offset,
        data: data.slice ? data.slice() : data,
        dataOffset,
        size,
      });
    },
    writeTexture(destination, data, layout, size) {
      receipts.textureWrites.push({
        destination,
        data: data.slice ? data.slice() : data,
        layout,
        size,
      });
    },
    submit(commandBuffers) {
      receipts.submits.push(commandBuffers);
    },
    onSubmittedWorkDone() {
      return new Promise(() => {});
    },
  };
  const makeEncoder = (descriptor = {}) => {
    const encoder = token("encoder", descriptor);
    encoder.beginRenderPass = (passDescriptor) => {
      const receipt = { encoder, descriptor: passDescriptor, calls: [] };
      receipts.passes.push(receipt);
      return {
        setPipeline: (pipeline) =>
          receipt.calls.push({ op: "pipeline", pipeline }),
        setBindGroup: (index, bindGroup) =>
          receipt.calls.push({ op: "bind", index, bindGroup }),
        setVertexBuffer: (index, buffer) =>
          receipt.calls.push({ op: "vertex", index, buffer }),
        draw: (...args) => receipt.calls.push({ op: "draw", args }),
        end: () => {
          receipt.ended = true;
        },
      };
    };
    encoder.copyTextureToTexture = (...args) => {
      receipts.passes.push({ encoder, copy: args });
    };
    encoder.finish = () => token("command-buffer", { encoder });
    return encoder;
  };
  const device = {
    queue,
    limits: { maxTextureDimension2D: 8192 },
    features: new Set(),
    createBuffer: (descriptor) => makeDeviceToken("buffer", descriptor),
    createTexture: (descriptor) => makeDeviceToken("texture", descriptor),
    createSampler: (descriptor) => makeDeviceToken("sampler", descriptor),
    createShaderModule: (descriptor) => makeDeviceToken("shader", descriptor),
    createBindGroupLayout: (descriptor) =>
      makeDeviceToken("layout", descriptor),
    createPipelineLayout: (descriptor) =>
      makeDeviceToken("pipeline-layout", descriptor),
    createRenderPipeline: (descriptor) =>
      makeDeviceToken("pipeline", descriptor),
    createComputePipeline: (descriptor) =>
      makeDeviceToken("compute-pipeline", descriptor),
    createBindGroup: (descriptor) => makeDeviceToken("bind-group", descriptor),
    createCommandEncoder: makeEncoder,
  };
  return { device, receipts, makeEncoder };
}

function identityMatrix() {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// A projection rather than the identity: clip w must be the distance in front
// of the camera for the sun to land on screen.
function perspectiveViewProjection() {
  const m = identityMatrix();
  m[11] = -1;
  m[15] = 0;
  return m;
}

/**
 * One cloud frame's fixture: a fake context carrying the fields the cloud
 * frame preparation reads, a fixed scene time, and the config the frame asks.
 *
 * @param {object} frame The frame description.
 * @returns {object} The fixture.
 */
function makeFixture(frame) {
  const recorder = makeRecordingDevice();
  const encoder = recorder.makeEncoder({ label: "caller-frame-encoder" });
  const color = token("color-view");
  const depth = token("depth-view");
  const output = token("output-view");
  const canvasTexture = token("canvas-texture");
  const snapshotTexture = token("snapshot-texture");
  const snapshotView = snapshotTexture.createView({ label: "snapshot-view" });
  const uniformState = {
    inverseProjection: identityMatrix(),
    inverseView: identityMatrix(),
    view: identityMatrix(),
    projection: identityMatrix(),
    viewProjection: perspectiveViewProjection(),
    sunDirectionWC: { x: 0, y: 0.6, z: -0.8 },
    cameraPositionWC: { x: 0, y: 0, z: 6379137 },
  };
  const submitCallbacks = new Map();
  let request;
  const context = {
    _device: recorder.device,
    device: recorder.device,
    _canvas: { width: frame.width, height: frame.height },
    _canvasFormat: "rgba8unorm",
    webgpuPipelineCache: {
      getPipelineSync: (descriptor) =>
        context._device.createRenderPipeline({
          ...descriptor,
          label: "ProceduralClouds pipeline",
        }),
    },
    _currentCommandEncoder: encoder,
    _sceneColorView: color,
    _depthStencilView: depth,
    currentTextureView: output,
    _postProcessSnapshotTexture: snapshotTexture,
    _postProcessSnapshotView: snapshotView,
    _postProcessSnapshotWidth: frame.width,
    _postProcessSnapshotHeight: frame.height,
    _context: { getCurrentTexture: () => canvasTexture },
    resourceGeneration: 1,
    uniformState,
    withRenderPassTimestamps: (descriptor) => descriptor,
    endCurrentRenderPass: () => {},
    enqueueAfterCommandEncoderSubmit(targetEncoder, callback) {
      if (targetEncoder !== context._currentCommandEncoder) return false;
      const callbacks = submitCallbacks.get(targetEncoder) ?? [];
      callbacks.push(callback);
      submitCallbacks.set(targetEncoder, callbacks);
      return true;
    },
    requestVolumetricClouds(next) {
      request ??= next;
    },
    get hasVolumetricCloudRequest() {
      return request?.enabled === true;
    },
    consumeVolumetricCloudRequest() {
      const consumed = request;
      request = undefined;
      return consumed;
    },
    resumeDefaultRenderPass: () =>
      context._currentCommandEncoder?.beginRenderPass({
        label: "Default resumed pass",
        colorAttachments: [],
      }),
  };
  const frameState = {
    frameNumber: 1,
    context: { uniformState },
    camera: {
      positionWC: { x: 0, y: 0, z: 6379137 },
      positionCartographic: { height: frame.cameraHeight },
      frustum: {},
    },
    mode: 3,
    time: { dayNumber: 0, secondsOfDay: 0 },
    atmosphericConditions: undefined,
  };
  const config = {
    enabled: true,
    showProceduralClouds: true,
    cloudLayerBottom: 1500,
    cloudLayerTop: 4000,
    cloudCoverage: 0.5,
    cloudDensity: 0.3,
    cloudWindDirection: { x: 0.7, y: 0.3 },
    cloudWindSpeed: 15,
    atmosphereLightIntensity: 10,
    cloudType: 0,
    cloudQuality: frame.cloudQuality ?? 64,
    cloudVolumetricQuality: frame.preset,
    cloudMultiDeck: frame.multiDeck === true,
    cloudProgressiveStartup: false,
  };
  return {
    ...recorder,
    context,
    frameState,
    config,
    color,
    depth,
    output,
    encoder,
    // The frame's queue submit, which retires the preparation lease.
    submitEncoder() {
      const callbacks = submitCallbacks.get(encoder) ?? [];
      submitCallbacks.delete(encoder);
      for (const callback of callbacks) callback(true);
    },
  };
}

/** Resident baked noise, as the renderer reads it for the budget's noise weight. */
function seedBakedNoise(fixture) {
  const cache = fixture.context._cloudCache;
  cache.noiseBaked = true;
  cache.noise = {
    shapeSampleView: token("seeded-shape-3d-view"),
    detailSampleView: token("seeded-detail-3d-view"),
    sampler3d: token("seeded-noise-sampler"),
    shapePWSampleView: null,
  };
}

/**
 * Prepares and executes one cloud frame through the same four calls the public
 * driver makes, with the mask pass asked or not, and reads back what a
 * consumer could observe.
 *
 * @param {object} engine The renderer bundle.
 * @param {object} fixture The frame's fixture.
 * @param {boolean} mask Whether the transmittance-mask pass is asked for.
 * @returns {object} The outcome, the execute result and the counters.
 */
function runFrame(engine, fixture, mask) {
  const { context, frameState } = fixture;
  if (context._cloudCache === undefined) {
    engine.ensureCloudCache(context);
    seedBakedNoise(fixture);
  }
  const before = {
    created: fixture.receipts.created.length,
    passes: fixture.receipts.passes.length,
    writes: fixture.receipts.writes.length,
    serial: context._cloudCache.executeSerial,
  };
  const plan = Object.freeze({ frameNumber: frameState.frameNumber });
  const attempt = engine.beginCloudFrameAttempt(context, frameState, plan);
  const outcome = engine.prepareCloudFrameAndEncodeMask(
    context,
    frameState,
    attempt,
    fixture.color,
    fixture.depth,
    fixture.config,
    mask,
  );
  let ran;
  try {
    ran = engine.executePreparedCloudFrame(
      context,
      frameState,
      fixture.color,
      fixture.depth,
      fixture.output,
      outcome,
    );
  } finally {
    engine.completePreparedCloudMask(outcome);
    engine.cancelPreparedCloudFrame(outcome);
    fixture.submitEncoder();
  }
  const cache = context._cloudCache;
  const uniformWrites = fixture.receipts.writes
    .slice(before.writes)
    .filter((write) => write.buffer === cache.uniformBuffer);
  return {
    outcome,
    ran,
    counters: cache.observability,
    uniformWrites,
    created: fixture.receipts.created.slice(before.created),
    passes: fixture.receipts.passes.slice(before.passes),
    executeSerialDelta: cache.executeSerial - before.serial,
  };
}

/** The resolver inputs the renderer builds for a frame description. */
function resolverInputs(engine, frame, overrides = {}) {
  const inputs = engine.buildCloudQualityInputs(
    {
      cloudVolumetricQuality: frame.preset,
      cloudQuality: frame.cloudQuality ?? 64,
    },
    frame.cameraHeight,
  );
  inputs.viewportPixels = frame.width * frame.height;
  inputs.bakedNoiseResident = true;
  inputs.multiDeck = frame.multiDeck === true;
  inputs.transmittanceMaskPass = frame.mask === true;
  return Object.assign(inputs, overrides);
}

// ── The frames and the thresholds ───────────────────────────────────────────

// The default tier rows and the three bands of "auto". "auto" resolves to low
// at or above 100 km, to medium between 50 and 100 km and to high at or below
// 50 km.
const ROWS = [
  { id: "low", preset: "low", cameraHeight: 1000 },
  { id: "medium", preset: "medium", cameraHeight: 1000 },
  { id: "high", preset: "high", cameraHeight: 1000 },
  { id: "auto-far", preset: "auto", cameraHeight: 200_000 },
  { id: "auto-mid", preset: "auto", cameraHeight: 75_000 },
  { id: "auto-near", preset: "auto", cameraHeight: 1_000 },
];

// The smallest drawing buffer, in pixels, at which not even one primary step
// fits the default march budget, as [bakedNoise, multiDeck, maskPass,
// fullResolutionFallback, pixels]. Measured on the resolver and pinned here;
// `pinnedThresholds` re-derives each from the cost law and asserts equality.
// The low and medium rows are the same march; the high row has no
// reduced-resolution target, so it has no fallback column.
const LOW_THRESHOLDS = [
  [0, 0, 0, 0, 1500000001],
  [0, 0, 0, 1, 375000001],
  [0, 0, 1, 0, 300000001],
  [0, 0, 1, 1, 187500001],
  [0, 1, 0, 0, 500000001],
  [0, 1, 0, 1, 125000001],
  [0, 1, 1, 0, 100000001],
  [0, 1, 1, 1, 62500001],
  [1, 0, 0, 0, 3000000001],
  [1, 0, 0, 1, 750000001],
  [1, 0, 1, 0, 600000001],
  [1, 0, 1, 1, 375000001],
  [1, 1, 0, 0, 1000000001],
  [1, 1, 0, 1, 250000001],
  [1, 1, 1, 0, 200000001],
  [1, 1, 1, 1, 125000001],
];
const HIGH_THRESHOLDS = [
  [0, 0, 0, 0, 2250000001],
  [0, 0, 1, 0, 1125000001],
  [0, 1, 0, 0, 750000001],
  [0, 1, 1, 0, 375000001],
  [1, 0, 0, 0, 4500000001],
  [1, 0, 1, 0, 2250000001],
  [1, 1, 0, 0, 1500000001],
  [1, 1, 1, 0, 750000001],
];
const PINNED = [
  ...LOW_THRESHOLDS.map((cell) => ["low", cell]),
  ...LOW_THRESHOLDS.map((cell) => ["medium", cell]),
  ...HIGH_THRESHOLDS.map((cell) => ["high", cell]),
];

/** A drawing buffer of exactly `pixels` pixels, as `width` x ceil(pixels / width). */
function bufferOf(pixels, width = 16384) {
  return { width, height: Math.ceil(pixels / width) };
}

/**
 * The floor of a frame: the cost of one primary step at one light step, under
 * the frame's facts. It is computed from the exported cost law alone, so it
 * does not move when the resolver's zero-step branch is made unreachable.
 *
 * @param {object} engine A module exporting the resolver.
 * @param {object} row A row of {@link ROWS}.
 * @param {object} facts The runtime facts.
 * @param {number} pixels The drawing buffer's pixel count.
 * @returns {number} The cost.
 */
function floorCost(engine, row, facts, pixels) {
  const tiny = resolverInputs(
    engine,
    { ...row, width: 1, height: 1 },
    factsOf(facts),
  );
  const tier = engine.resolveCloudPreset(tiny);
  const inputs = resolverInputs(
    engine,
    { ...row, width: 1, height: 1 },
    {
      ...factsOf(facts),
      viewportPixels: pixels,
    },
  );
  return engine.cloudMarchCost(
    { ...tier, primarySteps: 1, lightSteps: 1 },
    inputs,
  );
}

function factsOf([baked, multiDeck, mask, fullRes]) {
  return {
    bakedNoiseResident: baked === 1,
    multiDeck: multiDeck === 1,
    transmittanceMaskPass: mask === 1,
    fullResolutionFallback: fullRes === 1,
  };
}

/**
 * The smallest pixel count whose floor does not fit, by integer bisection.
 *
 * @returns {number} The threshold.
 */
function thresholdOf(engine, row, facts) {
  const over = (pixels) =>
    floorCost(engine, row, facts, pixels) > engine.CLOUD_MARCH_BUDGET_DEFAULT;
  let low = 0;
  let high = 1e13;
  assert.ok(
    over(high),
    "the floor must exceed the budget for some drawing buffer",
  );
  assert.ok(!over(low), "an empty drawing buffer must fit");
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (over(middle)) high = middle;
    else low = middle;
  }
  return high;
}

// ── S1: the resolver ────────────────────────────────────────────────────────

const STEP_FIELDS = new Set(["primarySteps", "lightSteps"]);

function resolveAt(engine, row, facts, pixels) {
  const inputs = resolverInputs(
    engine,
    { ...row, width: 1, height: 1 },
    {
      ...factsOf(facts),
      viewportPixels: pixels,
    },
  );
  const preset = engine.resolveCloudPreset(inputs);
  return {
    inputs,
    preset,
    report: engine.describeCloudMarchBudget(inputs, preset),
  };
}

/**
 * The resolver's refusal contract over the pinned cells. Throws an
 * AssertionError when any cell breaks it.
 *
 * @param {object} engine A module exporting the resolver and the cost law.
 */
function assertResolverRefusal(engine) {
  const budget = engine.CLOUD_MARCH_BUDGET_DEFAULT;
  let refused = 0;
  let fitted = 0;
  for (const [rowId, cell] of PINNED) {
    const row = ROWS.find((candidate) => candidate.id === rowId);
    const threshold = cell[4];
    const label = `${rowId} ${JSON.stringify(cell.slice(0, 4))}`;
    for (const pixels of [
      threshold - 1,
      threshold,
      threshold * 2,
      threshold * 7,
    ]) {
      const { inputs, preset, report } = resolveAt(engine, row, cell, pixels);
      const where = `${label} @ ${pixels} px`;
      // No resolved preset ever costs more than the budget, and a preset with
      // one primary step always fits.
      assert.ok(
        engine.cloudMarchCost(preset, inputs) <= budget,
        `${where}: the resolved preset must fit the budget`,
      );
      assert.ok(report.cost <= budget, `${where}: the reported cost must fit`);
      if (preset.primarySteps === 1) {
        assert.ok(
          engine.cloudMarchCost(preset, inputs) <= budget,
          `${where}: one primary step must fit`,
        );
      }
      if (pixels < threshold) {
        assert.ok(
          preset.primarySteps >= 1,
          `${where}: the floor fits one step`,
        );
        fitted++;
        continue;
      }
      assert.equal(preset.primarySteps, 0, `${where}: refused with zero steps`);
      for (const key of Object.keys(report.asked)) {
        if (STEP_FIELDS.has(key)) continue;
        assert.deepEqual(
          preset[key],
          report.asked[key],
          `${where}: ${key} must stay as asked`,
        );
      }
      assert.ok(
        preset.lightSteps >= 1 && preset.lightSteps <= report.asked.lightSteps,
        `${where}: the light steps never exceed the ask`,
      );
      assert.equal(report.budgetApplied, true, `${where}: the budget applied`);
      assert.equal(report.cost, 0, `${where}: a refused frame costs nothing`);
      assert.ok(
        report.requestedCost > report.budget,
        `${where}: the ask is over the budget`,
      );
      refused++;
    }
  }
  assert.ok(refused > 100 && fitted > 30, "the sweep reaches both sides");
}

resolverTest("S1: the pinned thresholds are the cost law's", async () => {
  const engine = await loadResolver();
  for (const [rowId, cell] of PINNED) {
    const row = ROWS.find((candidate) => candidate.id === rowId);
    assert.equal(
      thresholdOf(engine, row, cell),
      cell[4],
      `${rowId} ${JSON.stringify(cell.slice(0, 4))}`,
    );
  }
  // Both sides of one threshold, through the resolver itself.
  const row = ROWS[0];
  const cell = LOW_THRESHOLDS[0];
  assert.equal(
    resolveAt(engine, row, cell, cell[4] - 1).preset.primarySteps >= 1,
    true,
  );
  assert.equal(resolveAt(engine, row, cell, cell[4]).preset.primarySteps, 0);
  // The three auto bands resolve to the rows they name.
  for (const [auto, named] of [
    ["auto-far", "low"],
    ["auto-mid", "medium"],
    ["auto-near", "high"],
  ]) {
    const a = ROWS.find((candidate) => candidate.id === auto);
    const n = ROWS.find((candidate) => candidate.id === named);
    const facts = [1, 1, 1, 0];
    assert.deepEqual(
      resolveAt(engine, a, facts, 3e8).preset,
      resolveAt(engine, n, facts, 3e8).preset,
      auto,
    );
  }
});

resolverTest("S1: past the floor the resolver returns zero steps", async () => {
  assertResolverRefusal(await loadResolver());
});

// ── S2: the renderer ────────────────────────────────────────────────────────

// Frames the refusal is driven with: a reduced-resolution row with a temporal
// history, and the full-resolution row, each with the multi-deck march, with
// and without the mask pass. Baked noise is resident (the fixture seeds it).
const REFUSED_FRAMES = [
  { row: ROWS[0], multiDeck: true, mask: true, cell: [1, 1, 1, 0] },
  { row: ROWS[1], multiDeck: true, mask: false, cell: [1, 1, 0, 0] },
  { row: ROWS[2], multiDeck: true, mask: true, cell: [1, 1, 1, 0] },
];

/**
 * The refusal contract through the real frame preparation. Throws an
 * AssertionError when a frame past the floor is encoded, or when the refusal
 * sticks.
 *
 * @param {object} engine The renderer bundle.
 */
function assertRendererRefusal(engine) {
  const resolver = engine;
  for (const { row, multiDeck, mask, cell } of REFUSED_FRAMES) {
    const threshold = thresholdOf(resolver, row, cell);
    const refusedBuffer = bufferOf(threshold);
    const fittingBuffer = {
      width: refusedBuffer.width,
      height: refusedBuffer.height - 1,
    };
    assert.ok(fittingBuffer.width * fittingBuffer.height < threshold);
    assert.ok(refusedBuffer.width * refusedBuffer.height >= threshold);
    const label = `${row.id} multiDeck=${multiDeck} mask=${mask}`;
    const frame = { ...row, ...refusedBuffer, multiDeck, mask };
    const fixture = makeFixture(frame);

    const refused = runFrame(engine, fixture, mask);
    assert.equal(refused.outcome.kind, "negative", `${label}: outcome`);
    assert.equal(
      refused.outcome.reason,
      "march-budget-exceeded",
      `${label}: reason`,
    );
    assert.equal(refused.ran, false, `${label}: nothing ran`);
    assert.equal(
      refused.uniformWrites.length,
      0,
      `${label}: no uniform upload`,
    );
    assert.equal(
      refused.created.filter((item) =>
        /Temporal History/.test(item.descriptor.label ?? ""),
      ).length,
      0,
      `${label}: no temporal-history texture`,
    );
    assert.equal(refused.passes.length, 0, `${label}: no pass encoded`);
    assert.equal(refused.executeSerialDelta, 0, `${label}: execute serial`);
    const c = refused.counters;
    assert.equal(c.marchBudgetRefused, 1, `${label}: refused counter`);
    assert.equal(c.budgetApplied, 1, `${label}: budget applied`);
    assert.equal(c.marchCost, 0, `${label}: cost`);
    assert.ok(
      c.requestedMarchCost > c.marchBudget,
      `${label}: the ask is over the budget`,
    );
    assert.equal(
      c.marchBudget,
      engine.CLOUD_MARCH_BUDGET_DEFAULT,
      `${label}: budget`,
    );
    assert.equal(c.maxSteps, 0, `${label}: no steps`);
    assert.equal(c.frames, 1, `${label}: lifetime frames advanced`);

    // The refusal does not stick: the next frame at a fitting canvas prepares.
    fixture.context._canvas.width = fittingBuffer.width;
    fixture.context._canvas.height = fittingBuffer.height;
    fixture.frameState.frameNumber++;
    const next = runFrame(engine, fixture, mask);
    assert.notEqual(
      next.outcome.reason,
      "march-budget-exceeded",
      `${label}: next frame ${next.outcome.reason}`,
    );
    assert.equal(
      next.outcome.kind,
      "prepared",
      `${label}: next frame prepares (${next.outcome.reason})`,
    );
    assert.equal(
      next.counters.marchBudgetRefused,
      0,
      `${label}: refusal reset`,
    );
    assert.ok(
      next.counters.maxSteps >= 1,
      `${label}: fitting frame marches steps`,
    );
    assert.equal(next.counters.frames, 2, `${label}: lifetime frames`);
    assert.equal(
      next.executeSerialDelta,
      1,
      `${label}: execute serial advanced`,
    );
    assert.equal(next.uniformWrites.length, 1, `${label}: one uniform upload`);
    assert.ok(next.passes.length >= 1, `${label}: passes encoded`);
    const labels = next.passes.map((pass) => pass.descriptor?.label);
    assert.ok(
      labels.includes("ProceduralClouds pass") ||
        labels.includes("ProceduralClouds half-res pass"),
      `${label}: the visible march is encoded`,
    );
    assert.equal(
      labels.includes("ProceduralClouds transmittance-mask pass"),
      mask,
      `${label}: the mask pass is encoded exactly when asked`,
    );
    if (row.id === "low") {
      assert.ok(
        next.created.some((item) =>
          /Temporal History/.test(item.descriptor.label ?? ""),
        ),
        `${label}: the fitting frame allocates the temporal history the refusal skipped`,
      );
    }
  }
}

/**
 * Zero primary steps never reach an encoder: over every frame the spec runs,
 * a frame that encoded any pass carried at least one primary step.
 */
function assertNoZeroStepEncode(record) {
  if (record.passLabels.length > 0) {
    assert.ok(
      record.counters.maxSteps >= 1,
      `${record.id}: encoded with zero steps`,
    );
  }
}

rendererTest(
  "S2: a frame past the floor is refused before it uploads or encodes",
  async () => {
    assertRendererRefusal(await loadRenderer("live"));
  },
);

// ── S3: identity where the floor fits ───────────────────────────────────────

const BUFFERS = [
  [1920, 1080],
  [3840, 2160],
  [8192, 8192],
];

function identityFrames() {
  const frames = [];
  for (const row of ROWS) {
    for (const mask of [false, true]) {
      for (const multiDeck of [false, true]) {
        for (const [width, height] of BUFFERS) {
          frames.push({
            ...row,
            id: `${row.id} mask=${mask} deck=${multiDeck} ${width}x${height}`,
            mask,
            multiDeck,
            width,
            height,
          });
        }
      }
    }
  }
  // Raw cloudQuality: the budget applied, one or more steps still fitting.
  for (const cloudQuality of [128, 256, 1000]) {
    for (const [width, height] of [
      [1920, 1080],
      [8192, 8192],
    ]) {
      for (const mask of [false, true]) {
        frames.push({
          id: `raw ${cloudQuality} mask=${mask} ${width}x${height}`,
          preset: "high",
          cameraHeight: 1000,
          cloudQuality,
          mask,
          multiDeck: false,
          width,
          height,
        });
      }
    }
  }
  return frames;
}

function plainRecord(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * What a consumer can observe of one frame, as plain data. Nothing in it is
 * clock-based.
 *
 * @param {object} engine The renderer bundle.
 * @param {object} frame The frame description.
 * @returns {object} The record.
 */
function recordFrame(engine, frame) {
  const fixture = makeFixture(frame);
  const run = runFrame(engine, fixture, frame.mask);
  const inputs = resolverInputs(engine, frame);
  const preset = engine.resolveCloudPreset(inputs);
  const uniform = run.uniformWrites[0]?.data;
  const counters = {};
  for (const [key, value] of Object.entries(run.counters)) {
    counters[key] = Array.isArray(value) ? Array.from(value) : value;
  }
  return plainRecord({
    id: frame.id,
    outcome: run.outcome.kind,
    reason: run.outcome.reason ?? null,
    ran: run.ran,
    preset,
    budget: engine.describeCloudMarchBudget(inputs, preset),
    counters,
    uniformWrites: run.uniformWrites.length,
    uniformSha256:
      uniform === undefined
        ? null
        : createHash("sha256")
            .update(
              Buffer.from(
                uniform.buffer,
                uniform.byteOffset,
                uniform.byteLength,
              ),
            )
            .digest("hex"),
    passLabels: run.passes.map((pass) => pass.descriptor?.label ?? "copy"),
    createdLabels: run.created.map(
      (item) => `${item.kind}:${item.descriptor?.label ?? ""}`,
    ),
  });
}

function withoutRefusalCounter(record) {
  const { marchBudgetRefused, ...counters } = record.counters;
  return { remaining: { ...record, counters }, marchBudgetRefused };
}

function gitShow(tree, rel) {
  return lf(
    execFileSync("git", ["show", `${tree}:${rel}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );
}

/** Dependency rewrites that replace the three changed files with their earlier text. */
function earlierOverrides(tree) {
  return [
    [RENDERER_REL, "WebGPUProceduralCloudRenderer.ts"],
    [PRESETS_REL, "WebGPUCloudTierPresets.ts"],
    [OBSERVABILITY_REL, "WebGPUCloudObservability.ts"],
  ].map(([rel, basename]) => {
    const text = gitShow(tree, rel);
    return { basename, label: `${basename} earlier text`, mutate: () => text };
  });
}

rendererTest(
  RECORDING
    ? "S3: record the identity fixture from the earlier renderer"
    : "S3: every frame whose floor fits is identical to the earlier renderer",
  async () => {
    const frames = identityFrames();
    if (RECORDING) {
      assert.ok(
        BASE_TREE,
        "CLOUD_REFUSAL_BASE_TREE names the earlier tree-ish",
      );
      const engine = await loadRenderer("earlier", earlierOverrides(BASE_TREE));
      const records = frames.map((frame) => recordFrame(engine, frame));
      const second = frames.map((frame) => recordFrame(engine, frame));
      assert.deepEqual(second, records, "the record is deterministic");
      writeFileSync(
        FIXTURE,
        `${JSON.stringify({ baseTree: BASE_TREE, excludedCounters: ["marchBudgetRefused"], frames: records }, null, 2)}\n`,
      );
      return;
    }
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
    assert.deepEqual(
      fixture.frames.map((record) => record.id),
      frames.map((frame) => frame.id),
      "the fixture records exactly the spec's frames",
    );
    const engine = await loadRenderer("live");
    let applied = 0;
    let steps = 0;
    for (let i = 0; i < frames.length; i++) {
      const live = recordFrame(engine, frames[i]);
      const recorded = fixture.frames[i];
      const { remaining, marchBudgetRefused } = withoutRefusalCounter(live);
      assert.equal(
        marchBudgetRefused,
        0,
        `${live.id}: a fitting frame is not refused`,
      );
      assert.equal(live.outcome, "prepared", `${live.id}: outcome`);
      assertNoZeroStepEncode(live);
      assert.deepEqual(
        remaining,
        withoutRefusalCounter(recorded).remaining,
        live.id,
      );
      if (live.budget.budgetApplied) applied++;
      if (live.budget.budgetApplied && live.preset.primarySteps > 1) steps++;
    }
    assert.ok(applied >= 10, "the sweep includes budgeted frames");
    assert.ok(
      steps >= 5,
      "the sweep includes budgeted frames that still march steps",
    );
  },
);

// ── S4: inertness mutants ───────────────────────────────────────────────────

resolverTest(
  "S4: the resolver's zero-step branch made unreachable turns S1 red",
  async () => {
    const mutant = await loadResolver(ZERO_STEP_UNREACHABLE);
    assert.throws(() => assertResolverRefusal(mutant), assert.AssertionError);
  },
);

rendererTest(
  "S4: the renderer's refusal made unreachable turns S2 red",
  async () => {
    const mutant = await loadRenderer("refusal-unreachable", [
      REFUSAL_UNREACHABLE,
    ]);
    assert.throws(() => assertRendererRefusal(mutant), assert.AssertionError);
  },
);
