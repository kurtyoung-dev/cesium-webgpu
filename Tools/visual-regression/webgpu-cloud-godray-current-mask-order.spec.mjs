/**
 * PREREGISTRATION — fake-only current-source acceptance. These tests
 * load the named engine exports through engine-stub-bundler; they never create
 * a WebGPU device or a browser surface.
 *
 * 1. actual cloud capture records the mask pass, its main bind group, its
 *    caller-owned encoder and exactly one cloud-uniform write (green).
 * 2. capture-off and a following culled frame publish no current mask (green).
 * 3. capture/getter work does not mutate IBL coverage ownership (green).
 * 4. GodRay binds its real one-texel white fallback at binding 4 (green).
 * 5. A cold capture binds the same-frame early mask at the GodRay consumer,
 *    then consumes the copied post-process snapshot in the late visible pass.
 * 6. An N+1 culled frame clears the N mask before the GodRay consumer.
 * 7. The accepted split chronology rejects an in-memory preparation bypass.
 * 8. Mutating the unique cull reset so it retains maskRenderedThisFrame makes
 *    the unchanged cull-clears predicate throw (green).
 * 9. Mutating GodRay's unique binding-4 fallback to null makes the unchanged
 *    white-fallback predicate throw (green).
 * 10. Replacing or overriding the mask pass pipeline with the visible cloud
 *     pipeline makes the unchanged cloud-pass predicate throw (green).
 *
 * On a built tree, the former product reds remain ordinary positive assertions.
 * Missing generated shader modules skip the dependent tests with a build
 * prerequisite reason; a present but broken module still fails.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";
import { bundle, mutateOrFail } from "./lib/engine-stub-bundler.mjs";

Error.stackTraceLimit = 0;

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(HERE, "../../packages/engine/Source");
const missingGeneratedShaders = ["CloudDensityDomain.js", "ProceduralClouds.js"]
  .map((name) => resolve(ENGINE_SOURCE, "Shaders/WebGPU/Environment", name))
  .filter((shader) => !existsSync(shader));

function test(name, body) {
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

const WEBGPU = resolve(ENGINE_SOURCE, "Renderer/WebGPU");
const POST_CHAIN = resolve(WEBGPU, "WebGPUSceneRendererPostFrustumChain.ts");
const CLOUD = resolve(WEBGPU, "WebGPUProceduralCloudRenderer.ts");
const GOD_RAY = resolve(WEBGPU, "WebGPUGodRayEffect.ts");
const STAGE_COLLECTION = resolve(WEBGPU, "WebGPUPostProcessStageCollection.ts");
const ENVIRONMENTAL = resolve(
  WEBGPU,
  "WebGPUSceneRendererEnvironmentalEffects.ts",
);
const COMPOSITOR = resolve(WEBGPU, "WebGPUEnvironmentalEffectsCompositor.ts");
const SCENE_RENDERER = resolve(WEBGPU, "WebGPUSceneRenderer.ts");
const POST_PROCESS_PIPELINE = resolve(WEBGPU, "WebGPUPostProcessPipeline.ts");
const WEBGPU_CONTEXT = resolve(WEBGPU, "WebGPUContext.ts");
const GRAPHICS_CONTEXT = resolve(ENGINE_SOURCE, "Renderer/GraphicsContext.ts");
const CLOUD_COLLECTION = resolve(ENGINE_SOURCE, "Scene/CloudCollection.js");
const HARNESS = resolve(WEBGPU, "CurrentMaskCharacterizationHarness.ts");

// These are the only current engine modules resolved as implementation rather
// than bundler stubs. The list follows the executed cloud/GodRay paths; only
// the two shader wrappers concatenated at cloud module scope stay real.
const REAL_MASK_PATHS = [
  "WebGPUSceneRendererPostFrustumChain.ts",
  "WebGPUSceneRendererEnvironmentDemand.ts",
  "WebGPUSceneRendererEnvironmentalEffects.ts",
  "WebGPUEnvironmentalEffectsCompositor.ts",
  "WebGPUProceduralCloudRenderer.ts",
  "WebGPUGodRayEffect.ts",
  "WebGPUPostProcessStageCollection.ts",
  "WebGPUBindGroupLayoutHelpers.ts",
  "WebGPUBindGroupCache.ts",
  "WebGPUPostProcessEffects.ts",
  "WebGPUCloudObservability.ts",
  "WebGPUCloudTierPresets.ts",
  "WebGPUCloudDensityDomain.ts",
  "WebGPUCloudNoiseResources.ts",
  "WebGPUDeviceInvalidationBus.ts",
  "WebGPUShaderDefines.ts",
  "WebGPUShaderPreprocessor.ts",
  "WebGPUCloudReconstructionAttachments.ts",
  "WebGPUCloudTemporalHistory.ts",
  "WebGPUCloudShadowFrame.ts",
  "WebGPUCloudShadowBindGroupCache.ts",
  "CloudDensityDomain.js",
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

const REAL_INTEGRATION_PATHS = [
  ...REAL_MASK_PATHS,
  "WebGPUSceneRenderer.ts",
  "WebGPUPostProcessPipeline.ts",
  "WebGPUContext.ts",
  "GraphicsContext.ts",
  "CloudCollection.js",
  "CloudRenderMode.js",
];

// The recorder is deliberately small: it implements only WebGPU calls reached
// by the real current sources and retains object identity rather than emulating
// pixels.  Its receipts are the contract under test.
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

function makeRecordingDevice() {
  installWebGpuConstants();
  const controls = {
    failPassLabel: null,
    failPassError: null,
    failCopyError: null,
    failFinishError: null,
    failSubmitError: null,
    failCreateTexturePredicate: null,
    failCreateTextureError: null,
    destroyPredicate: null,
    destroyError: null,
    onBeginPass: null,
    submittedWorkDoneCalls: 0,
  };
  const receipts = {
    bindGroups: [],
    encoders: [],
    operations: [],
    passes: [],
    writes: [],
    textureWrites: [],
    submits: [],
  };
  let ordinal = 0;
  const record = (operation) =>
    receipts.operations.push({ ordinal: ++ordinal, ...operation });
  const makeDeviceToken = (kind, descriptor = {}) => {
    const value = token(kind, descriptor);
    record({ op: `create-${kind}`, value, descriptor });
    value.createView = (viewDescriptor = {}) => {
      const view = token(`${kind}-view`, {
        texture: value,
        ...viewDescriptor,
      });
      record({
        op: "create-view",
        texture: value,
        view,
        descriptor: viewDescriptor,
      });
      return view;
    };
    value.destroy = () => {
      value.destroyed = true;
      record({ op: "destroy", value });
      if (controls.destroyPredicate?.(value)) {
        throw controls.destroyError;
      }
    };
    return value;
  };
  const queue = {
    writeBuffer(buffer, offset, data, dataOffset, size) {
      const copiedData = data.slice ? data.slice() : data;
      const receipt = { buffer, offset, data: copiedData, dataOffset, size };
      receipts.writes.push(receipt);
      record({ op: "write-buffer", ...receipt });
    },
    writeTexture(destination, data, layout, size) {
      const copiedData = data.slice ? data.slice() : data;
      const receipt = { destination, data: copiedData, layout, size };
      receipts.textureWrites.push(receipt);
      record({ op: "write-texture", ...receipt });
    },
    submit(commandBuffers) {
      if (controls.failSubmitError) {
        throw controls.failSubmitError;
      }
      receipts.submits.push(commandBuffers);
      record({ op: "submit", commandBuffers });
    },
    onSubmittedWorkDone() {
      controls.submittedWorkDoneCalls++;
      return new Promise(() => {});
    },
  };
  const makeEncoder = (descriptor = {}) => {
    const encoder = token("encoder", descriptor);
    encoder.beginRenderPass = (passDescriptor) => {
      if (passDescriptor?.label === controls.failPassLabel) {
        throw controls.failPassError;
      }
      const receipt = { encoder, descriptor: passDescriptor, calls: [] };
      controls.onBeginPass?.(passDescriptor, encoder);
      receipts.passes.push(receipt);
      record({ op: "begin-pass", encoder, pass: receipt });
      return {
        setPipeline(pipeline) {
          receipt.calls.push({ op: "pipeline", pipeline });
          record({ op: "set-pipeline", encoder, pass: receipt, pipeline });
        },
        setBindGroup(index, bindGroup) {
          receipt.calls.push({ op: "bind", index, bindGroup });
          record({
            op: "set-bind-group",
            encoder,
            pass: receipt,
            index,
            bindGroup,
          });
        },
        setVertexBuffer(index, buffer) {
          receipt.calls.push({ op: "vertex", index, buffer });
          record({
            op: "set-vertex-buffer",
            encoder,
            pass: receipt,
            index,
            buffer,
          });
        },
        draw(...args) {
          receipt.calls.push({ op: "draw", args });
          record({ op: "draw", encoder, pass: receipt, args });
        },
        end() {
          receipt.ended = true;
          record({ op: "end-pass", encoder, pass: receipt });
        },
      };
    };
    encoder.copyTextureToTexture = (...args) => {
      if (controls.failCopyError) {
        throw controls.failCopyError;
      }
      receipts.passes.push({ encoder, copy: args });
      record({ op: "copy-texture", encoder, args });
    };
    encoder.finish = () => {
      if (controls.failFinishError) {
        throw controls.failFinishError;
      }
      const commandBuffer = token("command-buffer", { encoder });
      record({ op: "finish", encoder, commandBuffer });
      return commandBuffer;
    };
    receipts.encoders.push(encoder);
    record({ op: "create-encoder", encoder, descriptor });
    return encoder;
  };
  const device = {
    queue,
    limits: { maxTextureDimension2D: 8192 },
    features: new Set(),
    createBuffer: (descriptor) => makeDeviceToken("buffer", descriptor),
    createTexture: (descriptor) => {
      if (controls.failCreateTexturePredicate?.(descriptor)) {
        throw controls.failCreateTextureError;
      }
      return makeDeviceToken("texture", descriptor);
    },
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
    createBindGroup: (descriptor) => {
      const group = makeDeviceToken("bind-group", descriptor);
      receipts.bindGroups.push(group);
      return group;
    },
    createCommandEncoder: makeEncoder,
  };
  return { device, receipts, makeEncoder, controls };
}

function identityMatrix() {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

// The view-projection is the one matrix in this fixture that cannot be the
// identity. `updateGodRaySunUV` divides by clip w to get NDC, and an identity
// matrix pins w at 1 for every point, so a sun 1.5e11 m away projects to a UV
// of 7.5e10 — a number the f32 uniform cannot hold as a screen position at all
// (past 2^24 the ULP exceeds the whole [0,1] uv range), which the caller now
// correctly refuses to build a shaft from. Row 3 here is (0, 0, -1, 0), the
// perspective w of Cesium's own convention: clip w is the sun's distance in
// FRONT of the camera. What this file asserts is pass ordering, not sun
// placement; the projection just has to be a projection.
function perspectiveViewProjection() {
  const m = identityMatrix();
  m[11] = -1;
  m[15] = 0;
  return m;
}

function makeCloudFixture() {
  const recorder = makeRecordingDevice();
  const encoder = recorder.makeEncoder({ label: "caller-frame-encoder" });
  const color = token("color-view");
  const depth = token("depth-view");
  const output = token("output-view");
  const canvasTexture = token("canvas-texture");
  const snapshotTexture = token("snapshot-texture");
  const snapshotView = snapshotTexture.createView({ label: "snapshot-view" });
  const submitCallbacks = new Map();
  let request;
  const requestState = { publishes: 0, consumes: 0 };
  const uniformState = {
    inverseProjection: identityMatrix(),
    inverseView: identityMatrix(),
    view: identityMatrix(),
    projection: identityMatrix(),
    viewProjection: perspectiveViewProjection(),
    // Up and in front of the camera, so it projects on screen under the
    // perspective w above rather than onto the camera plane.
    sunDirectionWC: { x: 0, y: 0.6, z: -0.8 },
    cameraPositionWC: { x: 0, y: 0, z: 6379137 },
  };
  const context = {
    _device: recorder.device,
    device: recorder.device,
    _canvas: { width: 64, height: 48 },
    _canvasFormat: "rgba8unorm",
    _currentCommandEncoder: encoder,
    _sceneColorView: color,
    _depthStencilView: depth,
    currentTextureView: output,
    _postProcessSnapshotTexture: snapshotTexture,
    _postProcessSnapshotView: snapshotView,
    _postProcessSnapshotWidth: 64,
    _postProcessSnapshotHeight: 48,
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
    requestVolumetricClouds(nextRequest) {
      requestState.publishes++;
      request ??= nextRequest;
    },
    get hasVolumetricCloudRequest() {
      return request?.enabled === true;
    },
    consumeVolumetricCloudRequest() {
      requestState.consumes++;
      const consumed = request;
      request = undefined;
      return consumed;
    },
  };
  const frameState = {
    frameNumber: 1,
    context: { uniformState },
    camera: {
      positionWC: { x: 0, y: 0, z: 6379137 },
      positionCartographic: { height: 1000 },
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
    cloudQuality: 128,
  };
  const scene = {
    context,
    godRayEnabled: true,
    godRayCloudAware: true,
    globe: { defaultCloudCollection: { renderMode: 0 } },
    _frameState: frameState,
  };
  context.resumeDefaultRenderPass = () =>
    context._currentCommandEncoder?.beginRenderPass({
      label: "Default resumed pass",
      colorAttachments: [],
    });
  return {
    ...recorder,
    context,
    scene,
    frameState,
    config,
    color,
    depth,
    output,
    canvasTexture,
    snapshotTexture,
    snapshotView,
    encoder,
    submitEncoder(
      targetEncoder = context._currentCommandEncoder,
      submitted = true,
    ) {
      const callbacks = submitCallbacks.get(targetEncoder) ?? [];
      submitCallbacks.delete(targetEncoder);
      for (const callback of callbacks) callback(submitted);
    },
    requestState,
  };
}

function installActualContextContract(engine, fixture) {
  const context = fixture.context;
  delete context.requestVolumetricClouds;
  delete context.hasVolumetricCloudRequest;
  delete context.consumeVolumetricCloudRequest;
  delete context.enqueueAfterCommandEncoderSubmit;
  Object.setPrototypeOf(context, engine.WebGPUContext.prototype);
  context._volumetricCloudRequest = undefined;
  context._afterCommandEncoderSubmitCallbacks = new Map();
  context._commandEncoderSubmitCallbacksDraining = false;
  context._afterFrameSubmitCallbacks = [];
  context._pendingTextureDestroys = [];
  Object.defineProperty(context, "_isDeviceUnavailable", {
    configurable: true,
    value: false,
    writable: true,
  });
  context._currentRenderPassEncoder = null;
  context._activePassTarget = null;
  context._currentTextureView = null;
  context._canvasColorTouchedThisFrame = true;
  context._uniformAllocator = null;
  context._performanceManager = null;
  context._timestampProfiler = null;
  context._submitPendingTextureMipJobs = () => {};
  fixture.frameState.context = context;
  return context;
}

function settleCurrentEncoderWithActualContext(fixture) {
  fixture.context.endFrame();
}

function replaceExactlyOnce(original, before, after, name) {
  const occurrences = original.split(before).length - 1;
  assert.equal(occurrences, 1, `${name} anchor must occur exactly once`);
  return mutateOrFail(original, (text) => text.replace(before, after), name);
}

async function loadHarness({ overrides = [] } = {}) {
  // Reads happen only when a test/harness invokes this function, never at
  // module import time. The explicit allowlist keeps the exercised exports and
  // their needed local engine dependencies current without a broad directory.
  const entry = [
    'import { executePostFrustumChain } from "./WebGPUSceneRendererPostFrustumChain.js";',
    'import { beginCloudFrameAttempt, finishNegativeCloudFrameAttempt, prepareCloudFrameAndEncodeMask, isPreparedCloudFrame, completePreparedCloudMask, executePreparedCloudFrame, cancelPreparedCloudFrame, executeProceduralClouds, getCloudTransmittanceView, setCloudTransmittanceCapture } from "./WebGPUProceduralCloudRenderer.js";',
    'import { executeEnvironmentalEffects } from "./WebGPUSceneRendererEnvironmentalEffects.js";',
    'import { GodRayEffect } from "./WebGPUGodRayEffect.js";',
    'import { configureWebGPUPostProcessPipeline } from "./WebGPUPostProcessStageCollection.js";',
    "export { executePostFrustumChain, executeEnvironmentalEffects, beginCloudFrameAttempt, finishNegativeCloudFrameAttempt, prepareCloudFrameAndEncodeMask, isPreparedCloudFrame, completePreparedCloudMask, executePreparedCloudFrame, cancelPreparedCloudFrame, executeProceduralClouds, getCloudTransmittanceView, setCloudTransmittanceCapture, GodRayEffect, configureWebGPUPostProcessPipeline };",
  ].join("\n");
  return bundle({
    path: HARNESS,
    source: entry,
    real: REAL_MASK_PATHS,
    preseed: [
      POST_CHAIN,
      CLOUD,
      GOD_RAY,
      STAGE_COLLECTION,
      ENVIRONMENTAL,
      COMPOSITOR,
    ],
    overrides,
  });
}

const SCENE_FRAME_STUB_SOURCES = {
  "./WebGPUSceneRendererEnvironmentDemand.js": [
    "export function shouldExecuteWebGPUSceneFrame() { return true; }",
    "export function hasEnvironmentalEffectDemand() { return true; }",
  ].join("\n"),
  "./WebGPUSceneRendererPassRedirect.js": [
    "export function setupSceneFramebufferRenderPass() { globalThis.__maskSceneFrameTrace?.push('setup'); }",
    "export function buildMrtSlot1Attachment() { return undefined; }",
  ].join("\n"),
  "./WebGPUSceneRendererFrameReset.js": [
    "export function resetPerFrameState() { globalThis.__maskSceneFrameTrace?.push('reset'); }",
  ].join("\n"),
  "./WebGPUSceneRendererFrustumLoop.js": [
    "export function executeFrustumLoop(_host, config) { globalThis.__maskSceneFrameTrace?.push(`frustums:${config.scene._view.frustumCommandsList.length}`); }",
  ].join("\n"),
};

async function loadIntegrationHarness({
  overrides = [],
  stubSources = {},
} = {}) {
  const entry = [
    'import { executePostFrustumChain } from "./WebGPUSceneRendererPostFrustumChain.js";',
    'import { executeEnvironmentalEffects } from "./WebGPUSceneRendererEnvironmentalEffects.js";',
    'import { beginCloudFrameAttempt, finishNegativeCloudFrameAttempt, prepareCloudFrameAndEncodeMask, isPreparedCloudFrame, completePreparedCloudMask, executePreparedCloudFrame, cancelPreparedCloudFrame, ensureCloudCache, executeProceduralClouds, getCloudTransmittanceView, setCloudTransmittanceCapture } from "./WebGPUProceduralCloudRenderer.js";',
    'import { GodRayEffect } from "./WebGPUGodRayEffect.js";',
    'import { configureWebGPUPostProcessPipeline } from "./WebGPUPostProcessStageCollection.js";',
    'import { WebGPUSceneRenderer } from "./WebGPUSceneRenderer.js";',
    'import { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";',
    'import { WebGPUContext } from "./WebGPUContext.js";',
    'import CloudCollection from "../../Scene/CloudCollection.js";',
    "export { executePostFrustumChain, executeEnvironmentalEffects, beginCloudFrameAttempt, finishNegativeCloudFrameAttempt, prepareCloudFrameAndEncodeMask, isPreparedCloudFrame, completePreparedCloudMask, executePreparedCloudFrame, cancelPreparedCloudFrame, ensureCloudCache, executeProceduralClouds, getCloudTransmittanceView, setCloudTransmittanceCapture, GodRayEffect, configureWebGPUPostProcessPipeline, WebGPUSceneRenderer, WebGPUPostProcessPipeline, WebGPUContext, CloudCollection };",
  ].join("\n");
  return bundle({
    path: HARNESS,
    source: entry,
    real: REAL_INTEGRATION_PATHS,
    preseed: [
      POST_CHAIN,
      CLOUD,
      GOD_RAY,
      STAGE_COLLECTION,
      ENVIRONMENTAL,
      COMPOSITOR,
      SCENE_RENDERER,
      POST_PROCESS_PIPELINE,
      WEBGPU_CONTEXT,
      GRAPHICS_CONTEXT,
      CLOUD_COLLECTION,
    ],
    overrides,
    stubSources,
  });
}

async function runCapturedCloud(
  engine,
  fixture,
  { capture = true, cull = false } = {},
) {
  configureCloudAwareGodRay(engine, fixture, capture);
  // The real release path intentionally does not allocate on an off request.
  // Prewarm through the same API, then restore off, so fake-only noise seeding
  // has a cache without changing the capture-off contract under observation.
  if (!capture && !fixture.context._cloudCache) {
    engine.setCloudTransmittanceCapture(fixture.context, true);
    engine.setCloudTransmittanceCapture(fixture.context, false);
    assert.equal(fixture.context._cloudCache.maskCaptureEnabled, false);
  }
  seedBakedNoise(fixture);
  fixture.frameState.cullingVolume = cull
    ? { planes: [{ w: -6_400_000 }] }
    : { planes: [] };
  const ran = engine.executeProceduralClouds(
    fixture.context,
    fixture.frameState,
    fixture.color,
    fixture.depth,
    fixture.output,
    fixture.config,
  );
  return { ran, current: engine.getCloudTransmittanceView(fixture.context) };
}

function seedBakedNoise(fixture) {
  const cache = fixture.context._cloudCache;
  if (cache.noiseBaked && cache.noise) return;
  cache.noiseBaked = true;
  cache.noise = {
    shapeSampleView: token("seeded-shape-3d-view"),
    detailSampleView: token("seeded-detail-3d-view"),
    sampler3d: token("seeded-noise-sampler"),
    shapePWSampleView: null,
  };
}

function configureCloudAwareGodRay(engine, fixture, capture) {
  const effect = (fixture.godRayEffect ??= new engine.GodRayEffect());
  if (!effect._device) {
    effect.initialize(fixture.device, 64, 48, "rgba8unorm");
  }
  const noOp = new Proxy(function () {}, {
    get: () => noOp,
    apply: () => undefined,
    set: () => true,
  });
  const pipeline = new Proxy(
    {
      godRayEffect: effect,
    },
    {
      get: (target, key) => (key in target ? target[key] : noOp),
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    },
  );
  const collection = { _webgpuCache: {} };
  const scene = fixture.scene;
  scene.godRayCloudAware = capture;
  engine.configureWebGPUPostProcessPipeline(
    pipeline,
    collection,
    fixture.device,
    "rgba8unorm",
    scene,
  );
  fixture.godRayEffect = effect;
  engine.setCloudTransmittanceCapture(fixture.context, capture);
  return effect;
}

function maskPass(receipts) {
  return receipts.passes.find(
    (pass) =>
      pass.descriptor?.label === "ProceduralClouds transmittance-mask pass",
  );
}

function assertCloudPassPipelineOrder(pass, expectedPipeline, label) {
  const drawIndex = pass.calls.findIndex((call) => call.op === "draw");
  assert.notEqual(drawIndex, -1, `${label} must draw`);
  const callsBeforeDraw = pass.calls.slice(0, drawIndex);
  const pipelineIndex = callsBeforeDraw.findLastIndex(
    (call) => call.op === "pipeline",
  );
  const bindIndex = callsBeforeDraw.findLastIndex(
    (call) => call.op === "bind" && call.index === 0,
  );
  assert.notEqual(pipelineIndex, -1, `${label} must set a pipeline`);
  assert.notEqual(bindIndex, -1, `${label} must bind group zero`);
  assert.equal(
    pass.calls[pipelineIndex].pipeline,
    expectedPipeline,
    `${label} must consume its exact cached pipeline`,
  );
  assert.ok(
    pipelineIndex < bindIndex && bindIndex < drawIndex,
    `${label} must set pipeline before binding group zero before drawing`,
  );
  return pass.calls[bindIndex].bindGroup;
}

function assertCapturedMaskReceipt(fixture, current) {
  const visible = fixture.receipts.passes.find(
    (pass) => pass.descriptor?.label === "ProceduralClouds pass",
  );
  const pass = maskPass(fixture.receipts);
  assert.ok(visible, "real cloud capture must encode the visible cloud pass");
  assert.ok(pass, "real cloud capture must encode the transmittance-mask pass");
  const cache = fixture.context._cloudCache;
  assert.equal(
    visible.encoder,
    fixture.encoder,
    "visible pass must use the caller encoder",
  );
  assert.equal(
    pass.encoder,
    fixture.encoder,
    "mask pass must use the caller encoder",
  );
  assert.equal(
    pass.descriptor.colorAttachments[0].view,
    current,
    "published current mask must be the exact mask-pass attachment view",
  );
  const visibleGroup = assertCloudPassPipelineOrder(
    visible,
    cache.pipeline,
    "visible cloud pass",
  );
  const group = assertCloudPassPipelineOrder(
    pass,
    cache.maskPipeline,
    "cloud mask pass",
  );
  assert.ok(group, "mask pass must bind the real cloud main group");
  assert.equal(
    group,
    visibleGroup,
    "visible and mask passes must share the exact main group",
  );
  const entries = group.descriptor.entries;
  assert.equal(
    entries.find((entry) => entry.binding === 0)?.resource,
    fixture.color,
  );
  assert.equal(
    entries.find((entry) => entry.binding === 1)?.resource,
    fixture.depth,
  );
  const maskDraws = pass.calls.filter((call) => call.op === "draw");
  assert.equal(maskDraws.length, 1, "cloud mask pass must draw exactly once");
  assert.deepEqual(maskDraws[0]?.args, [3]);
  assert.equal(pass.ended, true, "mask pass must end on the caller encoder");
  assert.equal(pass.descriptor.colorAttachments[0].clearValue.r, 1);
  assert.equal(pass.descriptor.colorAttachments[0].loadOp, "clear");
  assert.equal(current.descriptor.texture.descriptor.format, "r8unorm");
  const writes = fixture.receipts.writes.filter(
    (write) => write.buffer === cache.uniformBuffer,
  );
  assert.equal(
    writes.length,
    1,
    "one cloud uniform upload is required per capture",
  );
  assert.equal(
    writes[0].offset,
    0,
    "cloud uniform upload must start at offset zero",
  );
  assert.equal(
    writes[0].data.length,
    cache.uniformData.length,
    "cloud uniform upload must cover the packed uniform count",
  );
  assert.equal(
    fixture.receipts.submits.length,
    0,
    "caller encoder must not be orphan-submitted",
  );
}

async function assertCullClearsCurrent(engine) {
  const fixture = makeCloudFixture();
  const active = await runCapturedCloud(engine, fixture);
  assert.equal(active.ran, true);
  assert.ok(active.current, "successful capture must publish its current mask");
  const beforeCull = {
    passes: fixture.receipts.passes.length,
    cloudUniformWrites: fixture.receipts.writes.filter(
      (write) => write.buffer === fixture.context._cloudCache.uniformBuffer,
    ).length,
  };
  fixture.submitEncoder(fixture.encoder, true);
  fixture.context._currentCommandEncoder = fixture.makeEncoder({
    label: "legacy-cull-next-encoder",
  });
  fixture.frameState.frameNumber++;
  const culled = await runCapturedCloud(engine, fixture, {
    capture: true,
    cull: true,
  });
  assert.equal(
    culled.ran,
    false,
    "outside shell must take the real cull return",
  );
  assert.equal(
    culled.current,
    null,
    "culled frame must not retain the prior current mask",
  );
  assert.equal(
    fixture.receipts.passes.length,
    beforeCull.passes,
    "cull must encode no new pass",
  );
  assert.equal(
    fixture.receipts.writes.filter(
      (write) => write.buffer === fixture.context._cloudCache.uniformBuffer,
    ).length,
    beforeCull.cloudUniformWrites,
    "cull must upload no new cloud uniform",
  );
  assert.equal(
    fixture.context._cloudCache.observability.culledFrames,
    1,
    "cull counter must advance once",
  );
}

function makeCloudFrameRenderer(engine) {
  return {
    prepareCloudFrameAndEncodeMask: engine.prepareCloudFrameAndEncodeMask,
    isPreparedCloudFrame: engine.isPreparedCloudFrame,
    completePreparedCloudMask: engine.completePreparedCloudMask,
    executePreparedCloudFrame: engine.executePreparedCloudFrame,
    cancelPreparedCloudFrame: engine.cancelPreparedCloudFrame,
  };
}

function makeAuthoritativePostProcessPipeline(engine, fixture, stageTrace) {
  const pipeline = Object.create(engine.WebGPUPostProcessPipeline.prototype);
  Object.assign(pipeline, {
    _device: fixture.device,
    _sampler: token("post-process-sampler"),
    _aerialPerspectiveEffect: null,
    _sunBloomEffect: null,
    _sunHaloEffect: null,
    _aoEffect: null,
    _bloomEffect: {
      enabled: true,
      execute(_encoder, sourceView) {
        stageTrace.push("bloom");
        return sourceView;
      },
    },
    _godRayEffect: fixture.godRayEffect,
    _dofEffect: null,
    _autoExposure: null,
    _heatShimmerEffect: null,
    _coldOpticsEffect: null,
    _taaEffect: null,
    _motionBlurEffect: null,
    _tonemapStage: null,
    _colorGradingStage: null,
    _fxaaStage: null,
    _userStages: [],
    _libraryStages: [],
    _customStages: [],
    _pingView: token("post-process-ping-view"),
    _pongView: token("post-process-pong-view"),
    _executeCopyStage(_encoder, sourceView, destinationView) {
      stageTrace.push("copy");
      assert.ok(sourceView);
      assert.equal(destinationView, fixture.output);
    },
  });
  return pipeline;
}

function makeCoordinatorHost(
  engine,
  fixture,
  { beforePost, beforeEnvironment, authoritativePostProcess = false },
) {
  const calls = [];
  const stageTrace = [];
  const effect = fixture.godRayEffect;
  const host = {
    _postProcess: { godRayEffect: effect },
    _sceneFramebuffer: null,
    _ppDebugLogged: true,
    _executeOverlayPass: () => calls.push("overlay"),
    _renderDepthPlane: () => calls.push("depth-plane"),
    _executeGBufferProducer: () => calls.push("gbuffer"),
    _runInvertClassificationComposite: () => calls.push("invert"),
    _runVelocityPass: () => calls.push("velocity"),
    _executeBoundingVolumeDebugPass: () => calls.push("bounds"),
    _ensureSceneColorResolved: () => calls.push("resolve"),
    _runPostProcessing: (config) => {
      calls.push("post");
      if (authoritativePostProcess) {
        engine.WebGPUSceneRenderer.prototype._runPostProcessing.call(
          host,
          config,
        );
      } else {
        effect.execute(
          fixture.context._currentCommandEncoder,
          fixture.color,
          fixture.depth,
          token("godray-sampler"),
        );
      }
      beforePost();
    },
    _executeEnvironmentalEffects: (config, cloudFrame) => {
      calls.push("environment");
      engine.executeEnvironmentalEffects(config, cloudFrame);
      beforeEnvironment();
    },
  };
  if (authoritativePostProcess) {
    fixture.scene.frameState = { useDeferredLighting: false };
    fixture.context.markCanvasContentWritten = () => {
      calls.push("canvas-written");
    };
    fixture.context.log = () => {};
    host._sceneFramebuffer = {
      colorTarget: {
        getColorTextureView: () => fixture.color,
        getColorTexture: () => fixture.canvasTexture,
      },
      velocityView: null,
    };
    host._postProcess = makeAuthoritativePostProcessPipeline(
      engine,
      fixture,
      stageTrace,
    );
    fixture.controls.onBeginPass = (descriptor) => {
      if (descriptor?.label === "GodRay-Generate") {
        stageTrace.push("godray");
      }
    };
  }
  return { host, calls, stageTrace };
}

function runCoordinator(engine, fixture, hooks) {
  const { host, calls, stageTrace } = makeCoordinatorHost(
    engine,
    fixture,
    hooks,
  );
  fixture.context._sceneHasTransmission = true;
  engine.executePostFrustumChain(
    host,
    fixture.context,
    {
      clearGlobeDepth: true,
      scene: fixture.scene,
      context: fixture.context,
      usePostProcess: true,
    },
    [],
  );
  return { calls, stageTrace, context: fixture.context };
}

function consumedGodRayBindingFour(fixture, expectedEncoder, effect) {
  const pass = [...fixture.receipts.passes]
    .reverse()
    .find((candidate) => candidate.descriptor?.label === "GodRay-Generate");
  assert.ok(pass, "GodRay generate pass must be recorded");
  assert.equal(
    pass.encoder,
    expectedEncoder,
    "GodRay generate pass must use the expected encoder",
  );
  const drawIndex = pass.calls.findIndex((call) => call.op === "draw");
  const callsBeforeDraw = pass.calls.slice(0, drawIndex);
  const pipelineIndex = callsBeforeDraw.findLastIndex(
    (call) => call.op === "pipeline",
  );
  const bindIndex = callsBeforeDraw.findLastIndex(
    (call) => call.op === "bind" && call.index === 0,
  );
  assert.equal(pass.calls[pipelineIndex]?.pipeline, effect._generatePipeline);
  assert.ok(
    bindIndex > pipelineIndex,
    "GodRay generate bind must follow its pipeline",
  );
  assert.ok(
    drawIndex > bindIndex,
    "GodRay generate draw must follow its binding",
  );
  assert.deepEqual(
    pass.calls[drawIndex]?.args,
    [3],
    "GodRay generate pass must draw the fullscreen triangle",
  );
  const group = pass.calls[bindIndex]?.bindGroup;
  return group?.descriptor.entries.find((entry) => entry.binding === 4)
    ?.resource;
}

async function observeColdOrder(engine) {
  const fixture = makeCloudFixture();
  const effect = configureCloudAwareGodRay(engine, fixture, true);
  seedBakedNoise(fixture);
  fixture.context._cloudCache.cpuStages.setEnabled(true);
  fixture.context.requestVolumetricClouds(fixture.config);
  fixture.context.getFeatureRendererReadiness = () => ({
    kind: "ready",
    renderer: makeCloudFrameRenderer(engine),
  });
  fixture.context.getFeatureRenderer = () => null;
  let boundAtPost;
  let currentAtPost;
  let currentAfterEnvironment;
  const result = runCoordinator(engine, fixture, {
    beforePost: () => {
      currentAtPost = engine.getCloudTransmittanceView(fixture.context);
      boundAtPost = consumedGodRayBindingFour(fixture, fixture.encoder, effect);
    },
    beforeEnvironment: () => {
      currentAfterEnvironment = engine.getCloudTransmittanceView(
        fixture.context,
      );
    },
  });
  return {
    effect,
    boundAtPost,
    currentAtPost,
    currentAfterEnvironment,
    calls: result.calls,
    fixture,
  };
}

async function observeAuthoritativeColdOrder(engine) {
  const fixture = makeCloudFixture();
  const effect = configureCloudAwareGodRay(engine, fixture, true);
  seedBakedNoise(fixture);
  fixture.context._cloudCache.cpuStages.setEnabled(true);
  fixture.context.requestVolumetricClouds(fixture.config);
  fixture.context.getFeatureRendererReadiness = () => ({
    kind: "ready",
    renderer: makeCloudFrameRenderer(engine),
  });
  fixture.context.getFeatureRenderer = () => null;
  let boundAtPost;
  let currentAtPost;
  let currentAfterEnvironment;
  const result = runCoordinator(engine, fixture, {
    authoritativePostProcess: true,
    beforePost: () => {
      currentAtPost = engine.getCloudTransmittanceView(fixture.context);
      boundAtPost = consumedGodRayBindingFour(fixture, fixture.encoder, effect);
    },
    beforeEnvironment: () => {
      currentAfterEnvironment = engine.getCloudTransmittanceView(
        fixture.context,
      );
    },
  });
  return {
    effect,
    boundAtPost,
    currentAtPost,
    currentAfterEnvironment,
    calls: result.calls,
    stageTrace: result.stageTrace,
    fixture,
  };
}

function assertAuthoritativePostProcessTopology(observation) {
  assertFutureColdTopology(observation);
  assert.deepEqual(
    observation.stageTrace,
    ["bloom", "godray", "copy"],
    "the actual pipeline must invoke GodRay after Bloom and before its final copy",
  );
  assert.deepEqual(
    observation.calls.filter(
      (call) => call === "post" || call === "canvas-written",
    ),
    ["post", "canvas-written"],
    "the actual scene wrapper must publish the pipeline canvas write",
  );
}

async function observeSceneFrameBoundary(engine, segments) {
  const fixture = makeCloudFixture();
  const effect = configureCloudAwareGodRay(engine, fixture, true);
  seedBakedNoise(fixture);
  fixture.context._cloudCache.cpuStages.setEnabled(true);
  fixture.context.requestVolumetricClouds(fixture.config);
  fixture.context.getFeatureRendererReadiness = () => ({
    kind: "ready",
    renderer: makeCloudFrameRenderer(engine),
  });
  fixture.context.getFeatureRenderer = () => null;
  fixture.context.performanceManager = null;
  fixture.scene.camera = {
    ...fixture.frameState.camera,
    position: { z: 6379137 },
  };
  const { host, calls, stageTrace } = makeCoordinatorHost(engine, fixture, {
    authoritativePostProcess: true,
    beforePost: () => {
      consumedGodRayBindingFour(fixture, fixture.encoder, effect);
    },
    beforeEnvironment: () => {},
  });
  Object.assign(host, {
    _width: 64,
    _height: 48,
    _execDebugLogged: true,
    _debugLogged: true,
    _postInitDebugLogged: true,
    _cpuPassProfiler: {
      beginPass: (name) => calls.push(`begin:${name}`),
      endPass: (name) => calls.push(`end:${name}`),
    },
    _ensureResources: () => calls.push("ensure"),
    _dispatchClusteredLighting: () => calls.push("cluster"),
    _beginDepthPlanePass: () => calls.push("depth-plane-begin"),
  });
  const frameTrace = [];
  globalThis.__maskSceneFrameTrace = frameTrace;
  try {
    for (const segment of segments) {
      fixture.scene.mode = segment.sceneMode ?? 3;
      fixture.scene._view = {
        frustumCommandsList: Array.from(
          { length: segment.frustumCount },
          () => ({}),
        ),
      };
      engine.WebGPUSceneRenderer.prototype.executeCommands.call(host, {
        scene: fixture.scene,
        context: fixture.context,
        passState: {},
        backgroundColor: { red: 0, green: 0, blue: 0, alpha: 1 },
        picking: false,
        useGlobeDepthFramebuffer: false,
        clearGlobeDepth: true,
        useOIT: false,
        useDepthPlane: false,
        usePostProcess: true,
        deferComposite: segment.deferComposite,
        sceneFbLoad: segment.sceneFbLoad,
      });
    }
  } finally {
    delete globalThis.__maskSceneFrameTrace;
  }
  return { fixture, calls, stageTrace, frameTrace };
}

function assertSceneFrameBoundaryExactlyOnce(
  observation,
  expectedFrustumTrace,
) {
  assert.deepEqual(
    observation.frameTrace.filter((entry) => entry.startsWith("frustums:")),
    expectedFrustumTrace,
    "each scene segment must execute its complete frustum loop before composition",
  );
  assert.equal(
    observation.calls.filter((call) => call === "post").length,
    1,
    "the production scene boundary must run the post-frustum chain once",
  );
  assert.equal(
    observation.fixture.receipts.passes.filter(
      (pass) =>
        pass.descriptor?.label === "ProceduralClouds transmittance-mask pass",
    ).length,
    1,
    "the production scene boundary must encode exactly one mask",
  );
  assert.equal(
    observation.fixture.receipts.passes.filter(
      (pass) => pass.descriptor?.label === "GodRay-Generate",
    ).length,
    1,
    "the production scene boundary must run GodRay exactly once",
  );
  assert.equal(
    observation.fixture.receipts.passes.filter(
      (pass) => pass.descriptor?.label === "ProceduralClouds pass",
    ).length,
    1,
    "the production scene boundary must encode the late visible pass once",
  );
  assert.equal(
    observation.fixture.receipts.writes.filter(
      (write) =>
        write.buffer === observation.fixture.context._cloudCache.uniformBuffer,
    ).length,
    1,
    "the production scene boundary must retain one main uniform upload",
  );
}

function assertCurrentColdTopology(observation) {
  assertFutureColdTopology(observation);
}

function assertFutureColdTopology(observation) {
  assert.ok(
    observation.currentAtPost,
    "cold frame must publish its early mask",
  );
  assert.equal(
    observation.boundAtPost,
    observation.currentAtPost,
    "GodRay binding 4 must receive the same-frame cloud mask at consumer time",
  );
  assert.deepEqual(
    observation.calls.filter(
      (call) => call === "post" || call === "environment",
    ),
    ["post", "environment"],
    "late visible clouds must run after the GodRay consumer",
  );
  assert.equal(
    observation.currentAfterEnvironment,
    observation.currentAtPost,
    "late visible execution must retain the exact early mask receipt",
  );

  const operations = observation.fixture.receipts.operations;
  const cache = observation.fixture.context._cloudCache;
  const earlyPass = maskPass(observation.fixture.receipts);
  const godRayPass = observation.fixture.receipts.passes.find(
    (pass) => pass.descriptor?.label === "GodRay-Generate",
  );
  const latePass = observation.fixture.receipts.passes.find(
    (pass) => pass.descriptor?.label === "ProceduralClouds pass",
  );
  const operationIndex = (predicate) => operations.findIndex(predicate);
  const uploadIndex = operationIndex(
    (operation) =>
      operation.op === "write-buffer" &&
      operation.buffer === cache.uniformBuffer,
  );
  const earlyDrawIndex = operationIndex(
    (operation) => operation.op === "draw" && operation.pass === earlyPass,
  );
  const godRayDrawIndex = operationIndex(
    (operation) => operation.op === "draw" && operation.pass === godRayPass,
  );
  const copyIndex = operationIndex(
    (operation) => operation.op === "copy-texture",
  );
  const lateDrawIndex = operationIndex(
    (operation) => operation.op === "draw" && operation.pass === latePass,
  );
  assert.ok(
    uploadIndex < earlyDrawIndex &&
      earlyDrawIndex < godRayDrawIndex &&
      godRayDrawIndex < copyIndex &&
      copyIndex < lateDrawIndex,
    "one upload, early mask, GodRay, snapshot copy, and late visible draw must be strictly ordered",
  );
  assert.equal(
    observation.fixture.receipts.writes.filter(
      (write) => write.buffer === cache.uniformBuffer,
    ).length,
    1,
    "the split frame must upload the main uniforms exactly once",
  );
  const timing = cache.cpuStages.snapshot();
  assert.equal(timing.stages.total.samples, 1);
  assert.equal(timing.stages.total.state, "idle");
  assert.equal(timing.invalidTransitions, 0);
  const earlyGroup = assertCloudPassPipelineOrder(
    earlyPass,
    cache.maskPipeline,
    "early mask pass",
  );
  const lateGroup = assertCloudPassPipelineOrder(
    latePass,
    cache.pipeline,
    "late visible pass",
  );
  assert.equal(
    earlyGroup.descriptor.entries.find((entry) => entry.binding === 0)
      ?.resource,
    observation.fixture.color,
    "early mask must consume raw scene color",
  );
  assert.equal(
    lateGroup.descriptor.entries.find((entry) => entry.binding === 0)?.resource,
    observation.fixture.snapshotView,
    "late visible clouds must consume the copied display snapshot",
  );
  for (let binding = 1; binding <= 12; binding++) {
    const lateResource = lateGroup.descriptor.entries.find(
      (entry) => entry.binding === binding,
    )?.resource;
    const earlyResource = earlyGroup.descriptor.entries.find(
      (entry) => entry.binding === binding,
    )?.resource;
    assert.equal(
      lateResource?.buffer ?? lateResource,
      earlyResource?.buffer ?? earlyResource,
      `early and late groups must share non-color binding ${binding}`,
    );
  }
}

async function assertColdLoadingNegative(engine) {
  const fixture = makeCloudFixture();
  const effect = configureCloudAwareGodRay(engine, fixture, true);
  fixture.context._cloudCache.cpuStages.setEnabled(true);
  fixture.context.requestVolumetricClouds(fixture.config);
  fixture.context.requestVolumetricClouds({
    ...fixture.config,
    cloudCoverage: 0.99,
  });
  fixture.context.getFeatureRendererReadiness = () => ({ kind: "loading" });
  fixture.context.getFeatureRenderer = () => null;
  let boundAtPost;
  runCoordinator(engine, fixture, {
    beforePost: () => {
      boundAtPost = consumedGodRayBindingFour(fixture, fixture.encoder, effect);
    },
    beforeEnvironment: () => {},
  });
  assert.equal(fixture.requestState.publishes, 2);
  assert.equal(fixture.requestState.consumes, 1);
  assert.equal(boundAtPost, effect._whiteFallbackView);
  assert.equal(maskPass(fixture.receipts), undefined);
  assert.equal(
    fixture.receipts.passes.some(
      (pass) => pass.descriptor?.label === "ProceduralClouds pass",
    ),
    false,
  );
  assert.equal(
    fixture.receipts.operations.some(
      (operation) => operation.op === "copy-texture",
    ),
    false,
    "a user-only loading outcome has no late fullscreen consumer to snapshot",
  );
  const timing = fixture.context._cloudCache.cpuStages.snapshot();
  assert.equal(timing.stages.total.samples, 1);
  assert.equal(timing.stages.total.state, "idle");
  assert.equal(timing.invalidTransitions, 0);
}

function publishRealCloudCollectionRequest(engine, fixture, config) {
  const collection = Object.create(engine.CloudCollection.prototype);
  Object.defineProperties(collection, {
    show: { value: true, writable: true },
    volumetric: { value: { enabled: true }, writable: true },
  });
  Object.assign(collection, {
    _cloudsRemoved: false,
    _renderMode: 1,
    _resolveVolumetricConfig: () => config,
  });
  const featureUpdates = [];
  Object.defineProperty(fixture.context, "getFeatureRenderer", {
    configurable: true,
    value: () => ({
      update(owner, frameState) {
        featureUpdates.push({ owner, frameState });
      },
    }),
    writable: true,
  });
  collection.update(fixture.frameState);
  assert.equal(featureUpdates.length, 1);
  assert.equal(featureUpdates[0].owner, collection);
}

async function observeRealFirstWinsIblAndLateFrame(engine) {
  const fixture = makeCloudFixture();
  installActualContextContract(engine, fixture);
  const first = {
    ...fixture.config,
    cloudCoverage: 0.25,
    cloudDensity: 0.5,
    cloudContributesIBL: true,
  };
  const second = {
    ...fixture.config,
    cloudCoverage: 0.875,
    cloudDensity: 0.9,
    cloudContributesIBL: true,
  };
  publishRealCloudCollectionRequest(engine, fixture, first);
  publishRealCloudCollectionRequest(engine, fixture, second);
  assert.equal(fixture.context.hasVolumetricCloudRequest, true);
  const effect = configureCloudAwareGodRay(engine, fixture, true);
  seedBakedNoise(fixture);
  fixture.context._cloudCache.cpuStages.setEnabled(true);
  fixture.context.getFeatureRendererReadiness = () => ({
    kind: "ready",
    renderer: makeCloudFrameRenderer(engine),
  });
  fixture.context.getFeatureRenderer = () => null;
  const cache = fixture.context._cloudCache;
  let iblPublicationWrites = 0;
  let iblCoverage = cache.iblCoverage;
  Object.defineProperty(cache, "iblCoverage", {
    configurable: true,
    get: () => iblCoverage,
    set: (value) => {
      iblPublicationWrites++;
      iblCoverage = value;
    },
  });
  let boundAtPost;
  const result = runCoordinator(engine, fixture, {
    authoritativePostProcess: true,
    beforePost: () => {
      boundAtPost = consumedGodRayBindingFour(fixture, fixture.encoder, effect);
    },
    beforeEnvironment: () => {},
  });
  return {
    fixture,
    first,
    second,
    boundAtPost,
    iblPublicationWrites,
    iblCoverage,
    result,
  };
}

function assertRealFirstWinsIblAndLateFrame(observation) {
  const { fixture, first, boundAtPost } = observation;
  assert.equal(fixture.context.hasVolumetricCloudRequest, false);
  assert.equal(
    observation.iblPublicationWrites,
    1,
    "the selected plan must publish IBL exactly once",
  );
  const expectedIbl =
    Math.round(first.cloudCoverage * (0.7 + 0.3 * first.cloudDensity) * 256) /
    256;
  assert.equal(
    observation.iblCoverage,
    expectedIbl,
    "the first real context request must reach actual IBL publication",
  );
  assert.equal(
    fixture.context._cloudCache.uniformData[43],
    first.cloudCoverage,
    "the same first request must reach the actual prepared-frame uniform",
  );
  assert.equal(
    boundAtPost,
    fixture.context._cloudCache.currentMaskReceipt.resource.view,
    "the selected first request must produce the same-frame mask",
  );
  assert.equal(
    fixture.receipts.passes.filter(
      (pass) => pass.descriptor?.label === "ProceduralClouds pass",
    ).length,
    1,
    "the selected first request must reach one late visible pass",
  );
}

async function assertManagedOnlyRequestProducesLateFrame(engine) {
  const fixture = makeCloudFixture();
  installActualContextContract(engine, fixture);
  const managed = {
    ...fixture.config,
    cloudCoverage: 0.625,
    cloudContributesIBL: true,
  };
  fixture.scene.globe.defaultCloudCollection = {
    renderMode: 1,
    volumetric: { enabled: true },
    _resolveVolumetricConfig: () => managed,
  };
  const effect = configureCloudAwareGodRay(engine, fixture, true);
  seedBakedNoise(fixture);
  fixture.context.getFeatureRendererReadiness = () => ({
    kind: "ready",
    renderer: makeCloudFrameRenderer(engine),
  });
  fixture.context.getFeatureRenderer = () => null;
  let boundAtPost;
  runCoordinator(engine, fixture, {
    authoritativePostProcess: true,
    beforePost: () => {
      boundAtPost = consumedGodRayBindingFour(fixture, fixture.encoder, effect);
    },
    beforeEnvironment: () => {},
  });
  assert.equal(fixture.context._cloudCache.uniformData[43], 0.625);
  assert.equal(
    boundAtPost,
    fixture.context._cloudCache.currentMaskReceipt.resource.view,
  );
  assert.equal(
    fixture.receipts.passes.filter(
      (pass) => pass.descriptor?.label === "ProceduralClouds pass",
    ).length,
    1,
  );
}

async function assertOpenLeaseBlocksNextFrameMutation(engine) {
  const fixture = makeCloudFixture();
  configureCloudAwareGodRay(engine, fixture, true);
  seedBakedNoise(fixture);
  const planA = Object.freeze({ frameNumber: fixture.frameState.frameNumber });
  const attemptA = engine.beginCloudFrameAttempt(
    fixture.context,
    fixture.frameState,
    planA,
  );
  const outcomeA = engine.prepareCloudFrameAndEncodeMask(
    fixture.context,
    fixture.frameState,
    attemptA,
    fixture.color,
    fixture.depth,
    fixture.config,
    true,
  );
  assert.equal(outcomeA.kind, "prepared");
  engine.completePreparedCloudMask(outcomeA);
  fixture.submitEncoder(fixture.encoder, true);

  const before = {
    writes: fixture.receipts.writes.length,
    textureWrites: fixture.receipts.textureWrites.length,
    destroys: fixture.receipts.operations.filter(
      (operation) => operation.op === "destroy",
    ).length,
    mask: engine.getCloudTransmittanceView(fixture.context),
  };
  const encoderB = fixture.makeEncoder({ label: "contending-frame-encoder" });
  fixture.context._currentCommandEncoder = encoderB;
  fixture.frameState.frameNumber++;
  const planB = Object.freeze({ frameNumber: fixture.frameState.frameNumber });
  const attemptB = engine.beginCloudFrameAttempt(
    fixture.context,
    fixture.frameState,
    planB,
  );
  const outcomeB = engine.prepareCloudFrameAndEncodeMask(
    fixture.context,
    fixture.frameState,
    attemptB,
    fixture.color,
    fixture.depth,
    { ...fixture.config, cloudCoverage: 0.91 },
    true,
  );
  assert.equal(outcomeB.kind, "negative");
  assert.equal(outcomeB.reason, "preparation-busy");
  assert.equal(fixture.receipts.writes.length, before.writes);
  assert.equal(fixture.receipts.textureWrites.length, before.textureWrites);
  assert.equal(
    fixture.receipts.operations.filter(
      (operation) => operation.op === "destroy",
    ).length,
    before.destroys,
  );
  assert.equal(
    engine.getCloudTransmittanceView(fixture.context),
    before.mask,
    "a contender must not erase the predecessor receipt before owning a lease",
  );
  engine.cancelPreparedCloudFrame(outcomeA);
}

function prepareLifecycleFrame(engine, fixture, config = fixture.config) {
  configureCloudAwareGodRay(engine, fixture, true);
  seedBakedNoise(fixture);
  fixture.context._cloudCache.cpuStages.setEnabled(true);
  const plan = Object.freeze({ frameNumber: fixture.frameState.frameNumber });
  const attempt = engine.beginCloudFrameAttempt(
    fixture.context,
    fixture.frameState,
    plan,
  );
  const outcome = engine.prepareCloudFrameAndEncodeMask(
    fixture.context,
    fixture.frameState,
    attempt,
    fixture.color,
    fixture.depth,
    config,
    true,
  );
  assert.equal(outcome.kind, "prepared");
  return outcome;
}

async function assertActualProducerSuccessorAndReplacementLifetime(engine) {
  const fixture = makeCloudFixture();
  installActualContextContract(engine, fixture);
  const outcome = prepareLifecycleFrame(engine, fixture);
  const oldMaskTexture = fixture.context._cloudCache.maskResourceEpoch.texture;
  engine.completePreparedCloudMask(outcome);
  settleCurrentEncoderWithActualContext(fixture);
  assert.deepEqual(
    fixture.receipts.operations
      .filter((operation) => ["finish", "submit"].includes(operation.op))
      .map((operation) => operation.op),
    ["finish", "submit"],
    "the producer disposition must be finish then queue.submit",
  );
  assert.ok(
    fixture.context._cloudCache.openPreparationLease,
    "the submitted producer must remain leased while late work is future",
  );

  const successor = fixture.makeEncoder({ label: "late-successor" });
  fixture.context._currentCommandEncoder = successor;
  const recorded = engine.executePreparedCloudFrame(
    fixture.context,
    fixture.frameState,
    fixture.snapshotView,
    fixture.depth,
    fixture.output,
    outcome,
  );
  assert.equal(recorded, true);
  assert.ok(
    fixture.context._cloudCache.openPreparationLease,
    "the successor must retain the lease until its exact disposition",
  );
  const blockedAttempt = engine.beginCloudFrameAttempt(
    fixture.context,
    { ...fixture.frameState, frameNumber: fixture.frameState.frameNumber + 1 },
    Object.freeze({ contender: true }),
  );
  const blockedOutcome = engine.prepareCloudFrameAndEncodeMask(
    fixture.context,
    { ...fixture.frameState, frameNumber: fixture.frameState.frameNumber + 1 },
    blockedAttempt,
    fixture.color,
    fixture.depth,
    fixture.config,
    true,
  );
  assert.equal(blockedOutcome.kind, "negative");
  assert.equal(blockedOutcome.reason, "preparation-busy");
  settleCurrentEncoderWithActualContext(fixture);
  assert.equal(fixture.context._cloudCache.openPreparationLease, null);

  fixture.frameState.frameNumber++;
  fixture.context._canvas.width = 80;
  fixture.context._currentCommandEncoder = fixture.makeEncoder({
    label: "extent-replacement",
  });
  const replacement = prepareLifecycleFrame(engine, fixture, {
    ...fixture.config,
    cloudCoverage: 0.75,
  });
  engine.completePreparedCloudMask(replacement);
  engine.cancelPreparedCloudFrame(replacement);
  assert.equal(
    oldMaskTexture.destroyed,
    false,
    "the retired extent must stay alive while replacement work is unsubmitted",
  );
  settleCurrentEncoderWithActualContext(fixture);
  assert.equal(
    oldMaskTexture.destroyed,
    true,
    "the retired extent may be destroyed immediately after its last submit",
  );
  assert.equal(
    fixture.receipts.operations.filter(
      (operation) =>
        operation.op === "destroy" && operation.value === oldMaskTexture,
    ).length,
    1,
  );
  assert.equal(
    fixture.controls.submittedWorkDoneCalls,
    0,
    "enumerated mask lifetime must not wait for GPU completion",
  );

  const priorDeviceMask = fixture.context._cloudCache.maskResourceEpoch.texture;
  const replacementDevice = makeRecordingDevice();
  fixture.context._device = replacementDevice.device;
  fixture.context.device = replacementDevice.device;
  engine.ensureCloudCache(fixture.context);
  assert.equal(
    priorDeviceMask.destroyed,
    true,
    "a settled prior-device cache must retire before new-device use",
  );
  seedBakedNoise(fixture);
  fixture.frameState.frameNumber++;
  fixture.context._currentCommandEncoder = replacementDevice.makeEncoder({
    label: "replacement-device-frame",
  });
  const deviceReplacement = prepareLifecycleFrame(engine, fixture);
  assert.equal(
    fixture.context._cloudCache.device,
    replacementDevice.device,
    "the replacement cache must belong to the live device",
  );
  engine.completePreparedCloudMask(deviceReplacement);
  engine.cancelPreparedCloudFrame(deviceReplacement);
  settleCurrentEncoderWithActualContext(fixture);
  assert.equal(replacementDevice.controls.submittedWorkDoneCalls, 0);
}

async function assertFailedEncoderDispositionSettles(engine, failureKind) {
  const fixture = makeCloudFixture();
  installActualContextContract(engine, fixture);
  const outcome = prepareLifecycleFrame(engine, fixture);
  engine.completePreparedCloudMask(outcome);
  const failure = Object.freeze({ failureKind });
  if (failureKind === "finish") {
    fixture.controls.failFinishError = failure;
  } else {
    fixture.controls.failSubmitError = failure;
  }
  assert.throws(
    () => settleCurrentEncoderWithActualContext(fixture),
    (error) => error === failure,
    `${failureKind} failure must retain the original thrown value`,
  );
  assert.equal(
    fixture.context._cloudCache.openPreparationLease,
    null,
    `${failureKind} failure must false-drain and retire before recovery code`,
  );
  engine.completePreparedCloudMask(outcome);
  engine.cancelPreparedCloudFrame(outcome);
  engine.cancelPreparedCloudFrame(outcome);
  assert.equal(fixture.context._cloudCache.openPreparationLease, null);
  assert.equal(
    engine.executePreparedCloudFrame(
      fixture.context,
      fixture.frameState,
      fixture.snapshotView,
      fixture.depth,
      fixture.output,
      outcome,
    ),
    false,
    "an abandoned producer must reject every future consumer",
  );
  const timing = fixture.context._cloudCache.cpuStages.snapshot();
  assert.equal(timing.stages.total.samples, 1);
  assert.equal(timing.stages.total.state, "idle");
  assert.equal(fixture.controls.submittedWorkDoneCalls, 0);
}

async function assertUnusedFuturesCancelExactlyOnce(engine) {
  const fixture = makeCloudFixture();
  installActualContextContract(engine, fixture);
  const outcome = prepareLifecycleFrame(engine, fixture);
  engine.cancelPreparedCloudFrame(outcome);
  engine.cancelPreparedCloudFrame(outcome);
  assert.ok(
    fixture.context._cloudCache.openPreparationLease,
    "cancellation must still await the producer encoder disposition",
  );
  settleCurrentEncoderWithActualContext(fixture);
  assert.equal(
    fixture.context._cloudCache.openPreparationLease,
    null,
    "cancellation must close both unused futures and retire after submit",
  );
  const timing = fixture.context._cloudCache.cpuStages.snapshot();
  assert.equal(timing.stages.total.samples, 1);
  assert.equal(timing.stages.total.state, "idle");
  assert.equal(fixture.controls.submittedWorkDoneCalls, 0);
}

async function assertSnapshotCopyFailureSettles(engine) {
  const fixture = makeCloudFixture();
  installActualContextContract(engine, fixture);
  const effect = configureCloudAwareGodRay(engine, fixture, true);
  seedBakedNoise(fixture);
  fixture.context._cloudCache.cpuStages.setEnabled(true);
  fixture.context.requestVolumetricClouds(fixture.config);
  fixture.context.getFeatureRendererReadiness = () => ({
    kind: "ready",
    renderer: makeCloudFrameRenderer(engine),
  });
  fixture.context.getFeatureRenderer = () => null;
  const copyError = Object.freeze({ marker: "snapshot-copy-failure" });
  fixture.controls.failCopyError = copyError;
  const observedErrors = [];
  const savedConsoleError = console.error;
  console.error = (...args) => observedErrors.push(args);
  try {
    runCoordinator(engine, fixture, {
      authoritativePostProcess: true,
      beforePost: () => {
        consumedGodRayBindingFour(fixture, fixture.encoder, effect);
      },
      beforeEnvironment: () => {},
    });
  } finally {
    console.error = savedConsoleError;
  }
  assert.ok(
    observedErrors.some((args) => args[1] === copyError),
    "snapshot copy failure must preserve the original error",
  );
  assert.equal(
    fixture.receipts.passes.filter(
      (pass) => pass.descriptor?.label === "ProceduralClouds pass",
    ).length,
    0,
    "copy failure must not feed raw or historical color to the late pass",
  );
  const timing = fixture.context._cloudCache.cpuStages.snapshot();
  assert.equal(timing.stages.total.samples, 1);
  assert.equal(timing.stages.total.state, "idle");
  settleCurrentEncoderWithActualContext(fixture);
  assert.equal(fixture.context._cloudCache.openPreparationLease, null);
}

async function assertDeviceAndExtentFailuresSettle(engine) {
  const missingDevice = makeCloudFixture();
  installActualContextContract(engine, missingDevice);
  engine.ensureCloudCache(missingDevice.context).cpuStages.setEnabled(true);
  missingDevice.context._device = undefined;
  missingDevice.context.device = undefined;
  const plan = Object.freeze({ missingDevice: true });
  const attempt = engine.beginCloudFrameAttempt(
    missingDevice.context,
    missingDevice.frameState,
    plan,
  );
  const negative = engine.prepareCloudFrameAndEncodeMask(
    missingDevice.context,
    missingDevice.frameState,
    attempt,
    missingDevice.color,
    missingDevice.depth,
    missingDevice.config,
    true,
  );
  assert.equal(negative.kind, "negative");
  assert.equal(negative.reason, "missing-device");
  assert.equal(
    missingDevice.context._cloudCache.cpuStages.snapshot().stages.total.samples,
    1,
  );

  await assertAllocationFailureSettles(engine);
}

async function assertAllocationFailureSettles(engine) {
  const allocation = makeCloudFixture();
  installActualContextContract(engine, allocation);
  configureCloudAwareGodRay(engine, allocation, true);
  seedBakedNoise(allocation);
  allocation.context._cloudCache.cpuStages.setEnabled(true);
  const allocationError = Object.freeze({ marker: "mask-allocation-failure" });
  allocation.controls.failCreateTexturePredicate = (descriptor) =>
    descriptor?.label === "ProceduralClouds transmittance mask";
  allocation.controls.failCreateTextureError = allocationError;
  const allocationPlan = Object.freeze({ allocation: true });
  const allocationAttempt = engine.beginCloudFrameAttempt(
    allocation.context,
    allocation.frameState,
    allocationPlan,
  );
  assert.throws(
    () =>
      engine.prepareCloudFrameAndEncodeMask(
        allocation.context,
        allocation.frameState,
        allocationAttempt,
        allocation.color,
        allocation.depth,
        allocation.config,
        true,
      ),
    (error) => error === allocationError,
  );
  const cache = allocation.context._cloudCache;
  const lease = cache.openPreparationLease;
  assert.equal(engine.getCloudTransmittanceView(allocation.context), null);
  assert.equal(cache.currentMaskReceipt, null);
  assert.equal(cache.maskRenderedThisFrame, false);
  assert.equal(allocationAttempt.outcomePublished, false);
  assert.equal(allocationAttempt.originalError, allocationError);
  assert.equal(cache.cpuStages.snapshot().stages.total.samples, 1);
  assert.equal(cache.cpuStages.snapshot().stages.total.state, "idle");
  assert.equal(
    allocation.receipts.passes.filter(
      (pass) =>
        pass.descriptor?.label === "ProceduralClouds transmittance-mask pass",
    ).length,
    0,
    "allocation failure must not record a mask pass",
  );
  assert.equal(
    allocation.receipts.operations.filter(
      (operation) => operation.op === "draw",
    ).length,
    0,
    "allocation failure must not record a mask draw",
  );
  assert.ok(lease, "allocation failure must retain its enrolled lease");
  assert.equal(
    cache.openPreparationLease,
    lease,
    "allocation failure must retain its enrolled lease until disposition",
  );
  assert.equal(lease.producerEncoder, allocation.encoder);
  assert.equal(lease.pendingEncoders.size, 1);
  assert.ok(lease.pendingEncoders.has(allocation.encoder));
  assert.equal(lease.submittedEncoders.size, 0);
  assert.equal(lease.abandonedEncoders.size, 0);
  assert.equal(lease.godRayFutureOpen, false);
  assert.equal(lease.lateVisibleFutureOpen, false);
  assert.equal(lease.usable, true);
  assert.equal(lease.terminal, false);

  const operationCount = allocation.receipts.operations.length;
  allocation.frameState.frameNumber++;
  const contenderAttempt = engine.beginCloudFrameAttempt(
    allocation.context,
    allocation.frameState,
    Object.freeze({ allocationContender: true }),
  );
  const contender = engine.prepareCloudFrameAndEncodeMask(
    allocation.context,
    allocation.frameState,
    contenderAttempt,
    allocation.color,
    allocation.depth,
    allocation.config,
    true,
  );
  assert.equal(contender.kind, "negative");
  assert.equal(contender.reason, "preparation-busy");
  assert.equal(
    allocation.receipts.operations.length,
    operationCount,
    "a preparation-busy contender must not mutate GPU state",
  );

  assert.equal(
    allocation.receipts.operations.filter((operation) =>
      ["finish", "submit"].includes(operation.op),
    ).length,
    0,
  );
  settleCurrentEncoderWithActualContext(allocation);
  assert.deepEqual(
    allocation.receipts.operations
      .filter((operation) => ["finish", "submit"].includes(operation.op))
      .map((operation) => operation.op),
    ["finish", "submit"],
    "the failed producer must finish before its queue submission",
  );
  assert.equal(lease.pendingEncoders.size, 0);
  assert.ok(lease.submittedEncoders.has(allocation.encoder));
  assert.equal(lease.abandonedEncoders.size, 0);
  assert.equal(lease.terminal, true);
  assert.equal(cache.openPreparationLease, null);
  assert.equal(lease.receipt, null);
  assert.equal(cache.currentMaskReceipt, null);
  assert.equal(engine.getCloudTransmittanceView(allocation.context), null);
  assert.equal(allocation.controls.submittedWorkDoneCalls, 0);
}

async function assertPreparationThrowIsTotallySettled(engine) {
  const fixture = makeCloudFixture();
  configureCloudAwareGodRay(engine, fixture, true);
  seedBakedNoise(fixture);
  fixture.context._cloudCache.cpuStages.setEnabled(true);
  fixture.context.requestVolumetricClouds(fixture.config);
  fixture.context.getFeatureRendererReadiness = () => ({
    kind: "ready",
    renderer: makeCloudFrameRenderer(engine),
  });
  fixture.context.getFeatureRenderer = () => null;
  const preparationError = Object.freeze({ marker: "after-upload-failure" });
  fixture.controls.failPassLabel = "ProceduralClouds transmittance-mask pass";
  fixture.controls.failPassError = preparationError;
  const observedErrors = [];
  const savedConsoleError = console.error;
  console.error = (...args) => observedErrors.push(args);
  try {
    runCoordinator(engine, fixture, {
      beforePost: () => {},
      beforeEnvironment: () => {},
    });
  } finally {
    console.error = savedConsoleError;
  }
  assert.ok(
    observedErrors.some((args) => args[1] === preparationError),
    "the coordinator must preserve and report the original thrown value",
  );
  assert.equal(
    fixture.receipts.writes.filter(
      (write) => write.buffer === fixture.context._cloudCache.uniformBuffer,
    ).length,
    1,
    "the injected preparation failure must occur after the actual upload",
  );
  const timing = fixture.context._cloudCache.cpuStages.snapshot();
  assert.equal(timing.stages.total.samples, 1);
  assert.equal(timing.stages.total.state, "idle");
  fixture.submitEncoder(fixture.encoder, true);

  fixture.controls.failPassLabel = null;
  fixture.controls.failPassError = null;
  const nextEncoder = fixture.makeEncoder({ label: "post-failure-frame" });
  fixture.context._currentCommandEncoder = nextEncoder;
  fixture.frameState.frameNumber++;
  fixture.context.requestVolumetricClouds(fixture.config);
  runCoordinator(engine, fixture, {
    beforePost: () => {},
    beforeEnvironment: () => {},
  });
  assert.ok(
    fixture.receipts.passes.some(
      (pass) =>
        pass.encoder === nextEncoder &&
        pass.descriptor?.label === "ProceduralClouds transmittance-mask pass",
    ),
    "a fully settled failed attempt must not strand the next frame",
  );
}

async function assertDestroyThrowRetiresOnce(engine) {
  const first = await observeColdOrder(engine);
  const fixture = first.fixture;
  const oldMaskTexture = fixture.context._cloudCache.maskResourceEpoch.texture;
  fixture.submitEncoder(fixture.encoder, true);

  const resizeEncoder = fixture.makeEncoder({ label: "mask-resize-frame" });
  fixture.context._currentCommandEncoder = resizeEncoder;
  fixture.context._canvas.width = 80;
  fixture.frameState.frameNumber++;
  fixture.context.requestVolumetricClouds(fixture.config);
  const destroyError = Object.freeze({ marker: "native-destroy-failure" });
  fixture.controls.destroyPredicate = (value) => value === oldMaskTexture;
  fixture.controls.destroyError = destroyError;
  runCoordinator(engine, fixture, {
    beforePost: () => {},
    beforeEnvironment: () => {},
  });

  const observedErrors = [];
  const savedConsoleError = console.error;
  console.error = (...args) => observedErrors.push(args);
  try {
    fixture.submitEncoder(resizeEncoder, true);
  } finally {
    console.error = savedConsoleError;
  }
  assert.ok(
    observedErrors.some((args) => args[1] === destroyError),
    "native destroy failure must remain observable with exact identity",
  );
  assert.equal(
    fixture.receipts.operations.filter(
      (operation) =>
        operation.op === "destroy" && operation.value === oldMaskTexture,
    ).length,
    1,
    "a throwing native resource retirement must be attempted exactly once",
  );

  fixture.controls.destroyPredicate = null;
  fixture.controls.destroyError = null;
  const nextEncoder = fixture.makeEncoder({
    label: "post-destroy-error-frame",
  });
  fixture.context._currentCommandEncoder = nextEncoder;
  fixture.frameState.frameNumber++;
  const plan = Object.freeze({ frameNumber: fixture.frameState.frameNumber });
  const attempt = engine.beginCloudFrameAttempt(
    fixture.context,
    fixture.frameState,
    plan,
  );
  const outcome = engine.prepareCloudFrameAndEncodeMask(
    fixture.context,
    fixture.frameState,
    attempt,
    fixture.color,
    fixture.depth,
    fixture.config,
    true,
  );
  assert.equal(
    outcome.kind,
    "prepared",
    "throwing retirement must terminalize before the next preparation",
  );
  engine.completePreparedCloudMask(outcome);
  engine.cancelPreparedCloudFrame(outcome);
  fixture.submitEncoder(nextEncoder, true);
}

async function assertNullFirstInvalidation(engine) {
  const fixture = makeCloudFixture();
  const effect = configureCloudAwareGodRay(engine, fixture, true);
  const stale = token("stale-prior-mask");
  effect.setCloudTransmittanceView(stale);
  fixture.context.getFeatureRendererReadiness = () => ({ kind: "loading" });
  fixture.context.getFeatureRenderer = () => null;
  let boundAtPost;
  runCoordinator(engine, fixture, {
    beforePost: () => {
      boundAtPost = consumedGodRayBindingFour(fixture, fixture.encoder, effect);
    },
    beforeEnvironment: () => {},
  });
  assert.equal(
    boundAtPost,
    effect._whiteFallbackView,
    "inactive frame must null prior GodRay mask before its consumer",
  );
}

async function assertNPlusOneCulledOrder(engine) {
  const first = await observeColdOrder(engine);
  const fixture = first.fixture;
  const priorMask = first.currentAtPost;
  assert.ok(priorMask, "N frame must produce a real prior mask");
  fixture.submitEncoder(fixture.encoder, true);
  const nextEncoder = fixture.makeEncoder({ label: "caller-frame-N-plus-one" });
  fixture.context._currentCommandEncoder = nextEncoder;
  fixture.frameState.frameNumber++;
  fixture.frameState.cullingVolume = { planes: [{ w: -6_400_000 }] };
  fixture.context.requestVolumetricClouds(fixture.config);
  const effect = configureCloudAwareGodRay(engine, fixture, true);
  let boundAtPost;
  let currentAfterCull;
  const result = runCoordinator(engine, fixture, {
    beforePost: () => {
      boundAtPost = consumedGodRayBindingFour(fixture, nextEncoder, effect);
    },
    beforeEnvironment: () => {
      currentAfterCull = engine.getCloudTransmittanceView(fixture.context);
    },
  });
  assert.equal(
    currentAfterCull,
    null,
    "real cull must clear publication after its late execution",
  );
  assert.notEqual(
    boundAtPost,
    priorMask,
    "a culled N+1 frame must not bind the prior N mask at GodRay consumer time",
  );
  assert.equal(
    boundAtPost,
    effect._whiteFallbackView,
    "culled N+1 must consume the exact white fallback",
  );
  assert.deepEqual(
    result.calls.filter((call) => call === "post" || call === "environment"),
    ["post", "environment"],
    "a cold-negative frame retains post-before-environment topology",
  );
  assert.equal(
    fixture.receipts.passes.filter(
      (pass) =>
        pass.encoder === nextEncoder &&
        pass.descriptor?.label === "ProceduralClouds pass",
    ).length,
    0,
    "culled N+1 must not encode a late visible cloud pass",
  );
}

async function assertWhiteFallbackBehavior(engine) {
  const fixture = makeRecordingDevice();
  const effect = new engine.GodRayEffect();
  effect.initialize(fixture.device, 64, 48, "rgba8unorm");
  const encoder = fixture.makeEncoder({ label: "godray-fallback" });
  effect.execute(
    encoder,
    token("source-view"),
    token("depth-view"),
    token("sampler"),
  );
  const bindingFour = consumedGodRayBindingFour(fixture, encoder, effect);
  assert.ok(bindingFour, "generate bind group must have binding 4");
  assert.equal(
    bindingFour,
    effect._whiteFallbackView,
    "binding 4 must use the real white fallback view",
  );
  assert.deepEqual(effect._whiteFallbackTex.descriptor.size, [1, 1, 1]);
  assert.equal(effect._whiteFallbackTex.descriptor.format, "r8unorm");
  assert.equal(
    fixture.receipts.textureWrites.length,
    1,
    "fallback texture must be initialized once",
  );
  assert.deepEqual(
    Array.from(fixture.receipts.textureWrites[0].data),
    [255],
    "white fallback must encode exactly 255",
  );
}

test("actual cloud capture records a mask draw with the main group, current encoder, and exactly one uniform upload", async () => {
  const engine = await loadHarness();
  const fixture = makeCloudFixture();
  const { ran, current } = await runCapturedCloud(engine, fixture);
  assert.equal(ran, true);
  assert.ok(current, "capture must publish the real current mask view");
  assertCapturedMaskReceipt(fixture, current);
});

test("capture-off and culled frames clear the published current cloud mask", async () => {
  const engine = await loadHarness();
  const off = makeCloudFixture();
  const offResult = await runCapturedCloud(engine, off, { capture: false });
  assert.equal(offResult.ran, true);
  assert.equal(
    offResult.current,
    null,
    "capture-off must retain the white fallback path",
  );
  assert.equal(
    maskPass(off.receipts),
    undefined,
    "capture-off must not encode a mask pass",
  );
  assert.equal(
    off.receipts.passes.filter(
      (pass) => pass.descriptor?.label === "ProceduralClouds pass",
    ).length,
    1,
    "capture-off must encode exactly the visible cloud pass",
  );
  await assertCullClearsCurrent(engine);
});

test("cloud IBL publication is isolated from mask capture state", async () => {
  const engine = await loadHarness();
  const fixture = makeCloudFixture();
  const ibl = { coverage: 0.375, owner: "ibl-sentinel", version: 17 };
  fixture.context._cloudCache = {
    iblCoverage: ibl.coverage,
    iblOwner: ibl.owner,
    iblVersion: ibl.version,
  };
  configureCloudAwareGodRay(engine, fixture, true);
  assert.equal(engine.getCloudTransmittanceView(fixture.context), null);
  assert.deepEqual(
    {
      coverage: fixture.context._cloudCache.iblCoverage,
      owner: fixture.context._cloudCache.iblOwner,
      version: fixture.context._cloudCache.iblVersion,
    },
    ibl,
    "mask capture/getter must not claim or rewrite IBL ownership",
  );
});

test("GodRay binds its actual white fallback when no current mask is published", async () => {
  const godRay = await loadHarness();
  await assertWhiteFallbackBehavior(godRay);
});

test("cold capture binds the same-frame early mask before late visible cloud composition", async () => {
  const engine = await loadHarness();
  assertFutureColdTopology(await observeColdOrder(engine));
});

test("a culled N+1 frame cannot expose a stale prior mask at the GodRay consumer", async () => {
  const engine = await loadHarness();
  await assertNPlusOneCulledOrder(engine);
});

test("a user-only loading attempt is first-wins, mask-inert, and closes TOTAL once", async () => {
  const engine = await loadHarness();
  await assertColdLoadingNegative(engine);
});

test("a submitted producer with a late future open blocks next-frame GPU mutation", async () => {
  const engine = await loadHarness();
  await assertOpenLeaseBlocksNextFrameMutation(engine);
});

test("a throw after upload preserves the original value and totally settles the attempt", async () => {
  const engine = await loadHarness();
  await assertPreparationThrowIsTotallySettled(engine);
});

test("a native destroy throw is observable, once-only, and does not strand retirement", async () => {
  const engine = await loadHarness();
  await assertDestroyThrowRetiresOnce(engine);
});

test("the actual scene wrapper and post-process pipeline consume the current mask after Bloom", async () => {
  const engine = await loadIntegrationHarness();
  assertAuthoritativePostProcessTopology(
    await observeAuthoritativeColdOrder(engine),
  );
});

test("the production scene boundary runs multi-frustum and split-2D composition exactly once", async () => {
  const engine = await loadIntegrationHarness({
    stubSources: SCENE_FRAME_STUB_SOURCES,
  });
  const multi = await observeSceneFrameBoundary(engine, [
    { frustumCount: 3, deferComposite: false },
  ]);
  assertSceneFrameBoundaryExactlyOnce(multi, ["frustums:3"]);

  const split = await observeSceneFrameBoundary(engine, [
    {
      frustumCount: 2,
      deferComposite: true,
      sceneFbLoad: false,
      sceneMode: 2,
    },
    {
      frustumCount: 2,
      deferComposite: false,
      sceneFbLoad: true,
      sceneMode: 2,
    },
  ]);
  assertSceneFrameBoundaryExactlyOnce(split, ["frustums:2", "frustums:2"]);
});

test("real CloudCollection requests are context-first-wins for IBL and the prepared late frame", async () => {
  const engine = await loadIntegrationHarness();
  assertRealFirstWinsIblAndLateFrame(
    await observeRealFirstWinsIblAndLateFrame(engine),
  );
  await assertManagedOnlyRequestProducesLateFrame(engine);
});

test("actual finish, submit, successor, replacement, and submit-safe retirement close one lease", async () => {
  const engine = await loadIntegrationHarness();
  await assertActualProducerSuccessorAndReplacementLifetime(engine);
});

test("finish and submit failures false-drain the exact producer and preserve the thrown value", async () => {
  const engine = await loadIntegrationHarness();
  await assertFailedEncoderDispositionSettles(engine, "finish");
  await assertFailedEncoderDispositionSettles(engine, "submit");
  await assertUnusedFuturesCancelExactlyOnce(engine);
});

test("missing device, allocation failure, and snapshot-copy failure totally settle", async () => {
  const engine = await loadIntegrationHarness();
  await assertDeviceAndExtentFailuresSettle(engine);
  await assertSnapshotCopyFailureSettles(engine);
});

test("the authoritative post-process predicate rejects a disabled real pipeline GodRay gate", async () => {
  const engine = await loadIntegrationHarness({
    overrides: [
      {
        basename: "WebGPUPostProcessPipeline.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "    if (this._godRayEffect?.enabled && depth) {",
            "    if (false) {",
            "disable the actual pipeline GodRay gate",
          ),
        label: "disable actual pipeline GodRay gate",
      },
    ],
  });
  await assert.rejects(
    async () =>
      assertAuthoritativePostProcessTopology(
        await observeAuthoritativeColdOrder(engine),
      ),
    /GodRay generate pass must be recorded|actual pipeline must invoke GodRay/,
  );
});

test("the scene-boundary predicates reject per-frustum and first-half composition mutants", async () => {
  const perFrustum = await loadIntegrationHarness({
    stubSources: SCENE_FRAME_STUB_SOURCES,
    overrides: [
      {
        basename: "WebGPUSceneRenderer.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "        executePostFrustumChain(this, context, config, frustumCommandsList);",
            "        for (let mutantIndex = 0; mutantIndex < frustumCommandsList.length; mutantIndex++) executePostFrustumChain(this, context, config, frustumCommandsList);",
            "run the post-frustum chain once per frustum",
          ),
        label: "run post-frustum chain per frustum",
      },
    ],
  });
  await assert.rejects(
    async () =>
      assertSceneFrameBoundaryExactlyOnce(
        await observeSceneFrameBoundary(perFrustum, [
          { frustumCount: 3, deferComposite: false },
        ]),
        ["frustums:3"],
      ),
    /post-frustum chain once/,
  );

  const firstHalf = await loadIntegrationHarness({
    stubSources: SCENE_FRAME_STUB_SOURCES,
    overrides: [
      {
        basename: "WebGPUSceneRenderer.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "    if (!config.deferComposite) {",
            "    if (true) {",
            "compose the first Scene2D half",
          ),
        label: "compose first Scene2D half",
      },
    ],
  });
  await assert.rejects(
    async () =>
      assertSceneFrameBoundaryExactlyOnce(
        await observeSceneFrameBoundary(firstHalf, [
          {
            frustumCount: 2,
            deferComposite: true,
            sceneFbLoad: false,
            sceneMode: 2,
          },
          {
            frustumCount: 2,
            deferComposite: false,
            sceneFbLoad: true,
            sceneMode: 2,
          },
        ]),
        ["frustums:2", "frustums:2"],
      ),
    /post-frustum chain once/,
  );
});

test("the first-wins predicate rejects second-wins and duplicate-IBL publication mutants", async () => {
  const secondWins = await loadIntegrationHarness({
    overrides: [
      {
        basename: "WebGPUContext.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "    if (this._volumetricCloudRequest === undefined) {\n      this._volumetricCloudRequest = config;\n    }",
            "    this._volumetricCloudRequest = config;",
            "replace context first-wins with second-wins",
          ),
        label: "replace context first-wins with second-wins",
      },
    ],
  });
  await assert.rejects(
    async () =>
      assertRealFirstWinsIblAndLateFrame(
        await observeRealFirstWinsIblAndLateFrame(secondWins),
      ),
    /first real context request/,
  );

  const duplicateIbl = await loadIntegrationHarness({
    overrides: [
      {
        basename: "WebGPUSceneRendererEnvironmentalEffects.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "  publishCloudIblCoverage(\n    config.context,\n    plan.active ? plan.config : undefined,\n    config.scene._frameState,\n  );",
            "  publishCloudIblCoverage(\n    config.context,\n    plan.active ? plan.config : undefined,\n    config.scene._frameState,\n  );\n  publishCloudIblCoverage(\n    config.context,\n    plan.active ? plan.config : undefined,\n    config.scene._frameState,\n  );",
            "publish cloud IBL twice",
          ),
        label: "publish cloud IBL twice",
      },
    ],
  });
  await assert.rejects(
    async () =>
      assertRealFirstWinsIblAndLateFrame(
        await observeRealFirstWinsIblAndLateFrame(duplicateIbl),
      ),
    /publish IBL exactly once/,
  );
});

test("copy fallback, duplicate mask, early retirement, and fabricated disposition mutants are rejected", async () => {
  const copyFallback = await loadIntegrationHarness({
    overrides: [
      {
        basename: "WebGPUSceneRendererPostFrustumChain.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            '          reportCloudLifecycleError(\n            context,\n            "Environmental snapshot copy failed.",\n            error,\n          );',
            '          reportCloudLifecycleError(\n            context,\n            "Environmental snapshot copy failed.",\n            error,\n          );\n          copiedSnapshotView = context._sceneColorView;',
            "feed raw color after snapshot copy failure",
          ),
        label: "feed raw color after snapshot copy failure",
      },
    ],
  });
  await assert.rejects(
    () => assertSnapshotCopyFailureSettles(copyFallback),
    /must not feed raw or historical color/,
  );

  const duplicateMask = await loadIntegrationHarness({
    overrides: [
      {
        basename: "WebGPUProceduralCloudRenderer.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "        maskPass.draw(3);",
            "        maskPass.draw(3);\n        maskPass.draw(3);",
            "draw the current mask twice",
          ),
        label: "draw current mask twice",
      },
    ],
  });
  const duplicateFixture = makeCloudFixture();
  const duplicateCapture = await runCapturedCloud(
    duplicateMask,
    duplicateFixture,
  );
  assert.throws(
    () => assertCapturedMaskReceipt(duplicateFixture, duplicateCapture.current),
    /exactly once/,
  );

  const earlyRetirement = await loadIntegrationHarness({
    overrides: [
      {
        basename: "WebGPUProceduralCloudRenderer.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "    lease.pendingEncoders.size !== 0 ||",
            "    false ||",
            "retire while an encoder is pending",
          ),
        label: "retire while encoder pending",
      },
    ],
  });
  await assert.rejects(
    () => assertAllocationFailureSettles(earlyRetirement),
    /retain its enrolled lease/,
  );
  await assert.rejects(
    () => assertActualProducerSuccessorAndReplacementLifetime(earlyRetirement),
    /successor must retain the lease|retired extent must stay alive/,
  );

  const fabricatedDisposition = await loadIntegrationHarness({
    overrides: [
      {
        basename: "WebGPUContext.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "      const commandBuffer = submittedEncoder.finish();\n      this._device.queue.submit([commandBuffer]);",
            "      const commandBuffer = submittedEncoder.finish();\n      this._drainCommandEncoderSubmitCallbacks(submittedEncoder, true);\n      this._device.queue.submit([commandBuffer]);",
            "fabricate submit disposition before queue submission",
          ),
        label: "fabricate disposition before submit",
      },
    ],
  });
  await assert.rejects(
    () =>
      assertFailedEncoderDispositionSettles(fabricatedDisposition, "submit"),
    /false-drain and retire before recovery code/,
  );

  const omittedFutureCancellation = await loadIntegrationHarness({
    overrides: [
      {
        basename: "WebGPUProceduralCloudRenderer.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "function cancelCloudPreparationLease(lease: CloudPreparationLease): void {\n  lease.godRayFutureOpen = false;\n  lease.lateVisibleFutureOpen = false;",
            "function cancelCloudPreparationLease(lease: CloudPreparationLease): void {",
            "omit cancellation of unused cloud futures",
          ),
        label: "omit unused cloud future cancellation",
      },
    ],
  });
  await assert.rejects(
    () => assertUnusedFuturesCancelExactlyOnce(omittedFutureCancellation),
    /close both unused futures/,
  );

  const lateUniformRewrite = await loadIntegrationHarness({
    overrides: [
      {
        basename: "WebGPUProceduralCloudRenderer.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "    recorded = prepared.executeLate(\n      colorTextureView,",
            "    context._device!.queue.writeBuffer(prepared.lease.cache!.uniformBuffer!, 0, prepared.lease.cache!.uniformData);\n    recorded = prepared.executeLate(\n      colorTextureView,",
            "rewrite cloud uniforms during late execution",
          ),
        label: "rewrite uniforms during late execution",
      },
    ],
  });
  await assert.rejects(
    async () =>
      assertAuthoritativePostProcessTopology(
        await observeAuthoritativeColdOrder(lateUniformRewrite),
      ),
    /upload the main uniforms exactly once/,
  );
});

test("same split-order topology must fail when the production readiness branch is bypassed", async () => {
  const current = await loadHarness();
  assertCurrentColdTopology(await observeColdOrder(current));
  const engine = await loadHarness({
    overrides: [
      {
        basename: "WebGPUSceneRendererPostFrustumChain.ts",
        mutate: (original) => {
          return replaceExactlyOnce(
            original,
            '    if (readiness.kind === "ready") {',
            "    if (false) {",
            "bypass the production ready-renderer branch",
          );
        },
        label: "bypass production cloud preparation",
      },
    ],
  });
  await assert.rejects(
    async () => assertCurrentColdTopology(await observeColdOrder(engine)),
    /cold frame must publish its early mask|same-frame cloud mask/,
  );
});

test("same stale-mask predicate must fail when production null-first invalidation is bypassed", async () => {
  const original = await loadHarness();
  await assertNullFirstInvalidation(original);
  const engine = await loadHarness({
    overrides: [
      {
        basename: "WebGPUSceneRendererPostFrustumChain.ts",
        mutate: (original) => {
          return replaceExactlyOnce(
            original,
            "  godRayEffect?.setCloudTransmittanceView(null);",
            "  // mutant retains the previously configured GodRay view",
            "retain the prior GodRay mask",
          );
        },
        label: "bypass null-first mask invalidation",
      },
    ],
  });
  await assert.rejects(
    () => assertNullFirstInvalidation(engine),
    /inactive frame must null prior GodRay mask/,
  );
});

test("same fallback predicate must fail under unique-anchor in-memory GodRay binding-4 fallback mutation", async () => {
  const original = await loadHarness();
  await assertWhiteFallbackBehavior(original);
  const godRay = await loadHarness({
    overrides: [
      {
        basename: "WebGPUGodRayEffect.ts",
        mutate: (original) =>
          replaceExactlyOnce(
            original,
            "resource: this._cloudTransView ?? this._whiteFallbackView!",
            "resource: this._cloudTransView ?? null",
            "replace GodRay binding-4 white fallback",
          ),
        label: "replace GodRay binding-4 white fallback",
      },
    ],
  });
  await assert.rejects(
    () => assertWhiteFallbackBehavior(godRay),
    /generate bind group must have binding 4|binding 4 must use the real white fallback view/,
  );
});

test("same cloud-pass pipeline predicate must fail under unique-anchor in-memory mask-to-visible pipeline mutation", async () => {
  const original = await loadHarness();
  const originalFixture = makeCloudFixture();
  const originalCapture = await runCapturedCloud(original, originalFixture);
  assert.equal(originalCapture.ran, true);
  assertCapturedMaskReceipt(originalFixture, originalCapture.current);

  const engine = await loadHarness({
    overrides: [
      {
        basename: "WebGPUProceduralCloudRenderer.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "maskPass.setPipeline(cache.maskPipeline);",
            "maskPass.setPipeline(cache.pipeline!);",
            "replace the mask pass pipeline with the visible cloud pipeline",
          ),
        label: "replace mask pipeline with visible cloud pipeline",
      },
    ],
  });
  const fixture = makeCloudFixture();
  const capture = await runCapturedCloud(engine, fixture);
  assert.equal(capture.ran, true);
  assert.throws(
    () => assertCapturedMaskReceipt(fixture, capture.current),
    /cloud mask pass must consume its exact cached pipeline/,
  );

  const overridingEngine = await loadHarness({
    overrides: [
      {
        basename: "WebGPUProceduralCloudRenderer.ts",
        mutate: (source) =>
          replaceExactlyOnce(
            source,
            "maskPass.setPipeline(cache.maskPipeline);\n        maskPass.setBindGroup(0, earlyMaskGroup);",
            "maskPass.setPipeline(cache.maskPipeline);\n        maskPass.setPipeline(cache.pipeline!);\n        maskPass.setBindGroup(0, earlyMaskGroup);",
            "override the mask pipeline before its binding and draw",
          ),
        label: "override mask pipeline with visible cloud pipeline",
      },
    ],
  });
  const overridingFixture = makeCloudFixture();
  const overridingCapture = await runCapturedCloud(
    overridingEngine,
    overridingFixture,
  );
  assert.equal(overridingCapture.ran, true);
  assert.throws(
    () =>
      assertCapturedMaskReceipt(overridingFixture, overridingCapture.current),
    /cloud mask pass must consume its exact cached pipeline/,
  );
});
