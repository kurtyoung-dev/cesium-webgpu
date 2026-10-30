// @purpose Pins which full-screen environmental stages run when this frame's post-processed snapshot was and was not copied, including the non-cloud stages the C13-46 narrowing reaches.
// @status ACTIVE

// F16. The C13-46 cloud-lifecycle relocation narrowed
// `executeEnvironmentalEffects` from
//
//   snapshotView = context._postProcessSnapshotView ?? undefined
//
// — a context field that survives from frame to frame and is set when the
// snapshot texture is *allocated* — to
//
//   snapshotView = cloudFrame.displaySnapshotView ?? undefined
//
// — a per-frame value the post-frustum chain populates only after it has
// actually encoded `copyTextureToTexture` from this frame's post-processed
// canvas into that texture.
//
// The narrowing is deliberate and it is *not* cloud-scoped: every full-screen
// environmental stage hangs off the same `composition`, so NPR outlines,
// contact shadows, SSR and volumetric fog are narrowed with it. Astra's
// mask-order spec asserts the cloud half ("copy failure must not feed raw or
// historical color to the late pass"); the non-cloud half was unasserted,
// which is the sign-off this file exists to make checkable.
//
// What is asserted here is the observable stage behaviour, not the shape of
// the expression: which feature renderers the chain asks to execute, and which
// texture identity they are handed. The last test is the inertness control —
// it restores the pre-change fallback and requires the narrowing assertion to
// go red, so the guard cannot pass because the branch is dead.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import FeatureRendererKey from "../../packages/engine/Source/Renderer/FeatureRendererKey.js";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const webgpuDirectory = fileURLToPath(
  new URL("../../packages/engine/Source/Renderer/WebGPU/", import.meta.url),
);
const entryPath = path.join(
  webgpuDirectory,
  "WebGPUSceneRendererEnvironmentalEffects.ts",
);

// Bounded fakes. The compositor's real body allocates a ping texture on a
// GPUDevice, which this spec has no use for: what matters is that a
// composition exists (or does not) and which view each stage is handed. The
// cloud-renderer stub keeps IBL publication and error reporting observable
// without pulling the 5,500-line renderer into the bundle.
const COMPOSITOR_STUB = `
export function beginEnvironmentalEffectsComposition(context, snapshotView) {
  return {
    snapshotView,
    pingView: "ping-view",
    sourceView: snapshotView,
    targetView: "ping-view",
    wrote: false,
  };
}
export function commitEnvironmentalFullscreenStage(state, recorded) {
  if (!recorded) {
    return;
  }
  state.sourceView = state.targetView;
  state.targetView =
    state.sourceView === state.snapshotView ? state.pingView : state.snapshotView;
  state.wrote = true;
}
export function commitEnvironmentalInPlaceStage(state, recorded) {
  state.wrote = state.wrote || recorded;
}
export function presentEnvironmentalEffectsComposition() {
  return true;
}
export function selectEnvironmentalWeatherRoute() {
  return "present-then-canvas";
}
`;

const CLOUD_RENDERER_STUB = `
export function beginCloudFrameAttempt() {
  return null;
}
export function finishNegativeCloudFrameAttempt() {
  return null;
}
export const iblPublications = [];
export function publishCloudIblCoverage(context, config) {
  iblPublications.push(config);
}
export const reportedErrors = [];
export function reportCloudLifecycleError(context, message, error) {
  reportedErrors.push({ contextId: context?.id, message, error });
}
`;

async function loadEnvironmentalEffects(mutate, label) {
  const source = readFileSync(entryPath, "utf8").replaceAll("\r\n", "\n");
  return bundle({
    path: entryPath,
    source,
    real: ["FeatureRendererKey"],
    stubSources: {
      "./WebGPUEnvironmentalEffectsCompositor.js": COMPOSITOR_STUB,
      "./WebGPUProceduralCloudRenderer.js": CLOUD_RENDERER_STUB,
    },
    mutate,
    label,
  });
}

/** Texture identities the chain could hand a stage. Only one is legitimate. */
const SNAPSHOT_VIEW = "post-process-snapshot-view";
const RAW_SCENE_VIEW = "raw-hdr-scene-color-view";
const CANVAS_VIEW = "canvas-view";
const DEPTH_VIEW = "depth-stencil-view";

function makeHarness({ snapshotCopied }) {
  const executions = [];
  const renderers = new Map();
  const record = (name) => ({
    execute: (...args) => {
      executions.push({ name, sourceView: args[2] });
      return true;
    },
  });
  renderers.set(FeatureRendererKey.NPR_OUTLINES, record("npr-outlines"));
  renderers.set(FeatureRendererKey.CONTACT_SHADOWS, record("contact-shadows"));
  renderers.set(FeatureRendererKey.SCREEN_SPACE_REFLECTIONS, record("ssr"));
  renderers.set(FeatureRendererKey.VOLUMETRIC_FOG, {
    update: () => {},
    composite: (...args) => {
      executions.push({ name: "volumetric-fog", sourceView: args[2] });
      return true;
    },
  });
  renderers.set(FeatureRendererKey.WEATHER_PARTICLES, {
    update: () => {},
    render: (...args) => {
      executions.push({ name: "weather", sourceView: args[3] });
      return true;
    },
  });

  const context = {
    id: "ctx-f16-harness",
    _depthStencilView: DEPTH_VIEW,
    _sceneColorView: RAW_SCENE_VIEW,
    currentTextureView: CANVAS_VIEW,
    _postProcessSnapshotView: SNAPSHOT_VIEW,
    currentRenderPassEncoder: null,
    presentationFormat: "bgra8unorm",
    depthFormat: "depth24plus-stencil8",
    consumeVolumetricCloudRequest: () => undefined,
    getFeatureRenderer: (key) => renderers.get(key) ?? null,
    endCurrentRenderPass: () => {},
    resumeDefaultRenderPass: () => "canvas-pass",
    log: () => {},
  };

  const scene = {
    // Every non-cloud full-screen stage is on, so a frame that runs none of
    // them is the narrowing and not a scene that simply asked for nothing.
    _enableSSR: true,
    _enableNPROutlines: true,
    _enableContactShadows: true,
    _enableWeather: true,
    _enableHeatShimmer: false,
    globe: { defaultCloudCollection: undefined },
    _view: {
      gBufferFramebuffer: { normalRoughnessTexture: "normal-roughness-view" },
    },
    _frameState: {
      frameNumber: 7,
      atmosphericConditions: { volumetricFog: { enabled: true } },
    },
  };

  const cloudFrame = Object.freeze({
    plan: Object.freeze({
      frameNumber: 7,
      request: null,
      config: undefined,
      active: false,
      captureRequested: false,
    }),
    renderer: null,
    preparation: null,
    negativeReason: "inactive",
    displaySnapshotView: snapshotCopied ? SNAPSHOT_VIEW : null,
  });

  return { config: { scene, context }, cloudFrame, executions };
}

function namesOf(executions) {
  return executions.map((entry) => entry.name);
}

test("with this frame's snapshot copied, every enabled full-screen stage runs off it", async () => {
  const { executeEnvironmentalEffects } = await loadEnvironmentalEffects();
  const harness = makeHarness({ snapshotCopied: true });
  executeEnvironmentalEffects(harness.config, harness.cloudFrame);

  assert.deepEqual(namesOf(harness.executions), [
    "npr-outlines",
    "contact-shadows",
    "ssr",
    "weather",
    "volumetric-fog",
  ]);
  assert.equal(
    harness.executions[0].sourceView,
    SNAPSHOT_VIEW,
    "the first full-screen stage must sample this frame's post-processed snapshot",
  );
  for (const entry of harness.executions) {
    assert.notEqual(
      entry.sourceView,
      RAW_SCENE_VIEW,
      `${entry.name} must never sample raw HDR scene color`,
    );
  }
});

test("with no snapshot copied this frame, no full-screen stage runs and none reads raw or canvas color", async () => {
  const { executeEnvironmentalEffects } = await loadEnvironmentalEffects();
  const harness = makeHarness({ snapshotCopied: false });
  executeEnvironmentalEffects(harness.config, harness.cloudFrame);

  // The narrowing, stated for the non-cloud stages by name. Skipping is the
  // defensible outcome: the alternative each of these would otherwise get is
  // the previous frame's snapshot contents or a colour-space-mismatched raw
  // HDR read, both of which are wrong output rather than absent output.
  for (const skipped of [
    "npr-outlines",
    "contact-shadows",
    "ssr",
    "volumetric-fog",
  ]) {
    assert.ok(
      !namesOf(harness.executions).includes(skipped),
      `${skipped} must not run without this frame's snapshot`,
    );
  }
  for (const entry of harness.executions) {
    assert.ok(
      entry.sourceView !== RAW_SCENE_VIEW && entry.sourceView !== SNAPSHOT_VIEW,
      `${entry.name} must not be handed a scene-colour source this frame`,
    );
  }
});

test("weather geometry still runs without a snapshot, because it samples no scene colour", async () => {
  // The narrowing must not become "the environmental chain does nothing". A
  // stage that does not sample the snapshot has no reason to be suppressed by
  // its absence, and weather is the stage that proves the chain still ran.
  const { executeEnvironmentalEffects } = await loadEnvironmentalEffects();
  const harness = makeHarness({ snapshotCopied: false });
  executeEnvironmentalEffects(harness.config, harness.cloudFrame);
  assert.deepEqual(namesOf(harness.executions), ["weather"]);
});

test("the narrowing is live: restoring the pre-change fallback puts the stages back", async () => {
  // Inertness control. The mutation makes the narrowing unreachable by
  // restoring exactly the expression C13-46 replaced, so the value can never
  // be absent when a scene-colour view exists. If the guard above still passed
  // under this mutation it would be asserting nothing.
  const { executeEnvironmentalEffects } = await loadEnvironmentalEffects(
    (source) =>
      source.replace(
        "const snapshotView = cloudFrame.displaySnapshotView ?? undefined;",
        "const snapshotView =\n    cloudFrame.displaySnapshotView ??\n    context._sceneColorView ??\n    context.currentTextureView;",
      ),
    "restore the pre-C13-46 snapshot fallback",
  );
  const harness = makeHarness({ snapshotCopied: false });
  executeEnvironmentalEffects(harness.config, harness.cloudFrame);
  assert.deepEqual(
    namesOf(harness.executions),
    ["npr-outlines", "contact-shadows", "ssr", "weather", "volumetric-fog"],
    "the mutant must run the very stages the narrowing suppresses",
  );
  assert.equal(
    harness.executions[0].sourceView,
    RAW_SCENE_VIEW,
    "and must hand them the raw HDR read the narrowing exists to prevent",
  );
});

test("the environmental stage no longer consumes the cloud request", async () => {
  // `resolveCloudFramePlan` consumes the published request once, upstream in
  // the post-frustum chain. A second consumption here would clear a request
  // the chain had already acted on and desynchronise the IBL coverage
  // publication from the deck that is actually rendering.
  const { executeEnvironmentalEffects } = await loadEnvironmentalEffects();
  const harness = makeHarness({ snapshotCopied: true });
  let consumed = 0;
  harness.config.context.consumeVolumetricCloudRequest = () => {
    consumed += 1;
    return undefined;
  };
  executeEnvironmentalEffects(harness.config, harness.cloudFrame);
  assert.equal(
    consumed,
    0,
    "the request is consumed once, by the post-frustum chain, not again here",
  );
});

test("half precision log depth can erase orbital cloud layers while f32 preserves them", () => {
  const near = 0.1,
    far = 1e10,
    layerDepth = 2500;
  const encode = (distance) =>
    Math.log2(distance - near + 1) / Math.log2(far - near + 1);
  const decode = (value) => 2 ** (value * Math.log2(far - near + 1)) - 1 + near;
  let erased = 0;
  for (let distance = 1e7; distance < 1.4e7; distance += 10000) {
    const depth = encode(distance);
    const half = Math.round(depth * 2048) / 2048;
    erased += decode(half) < distance - layerDepth;
    assert(Math.abs(decode(Math.fround(depth)) - distance) < 25);
  }
  assert(
    erased > 100,
    "half-depth orbital clipping must be reproduced by the regression",
  );
});

test("MSAA depth resolve caches independent f16 and f32 pipelines for each device", async () => {
  const depthPath = path.join(webgpuDirectory, "WebGPUDepthResolveMSAA.ts");
  const { getDepthResolvePipeline } = await bundle({
    path: depthPath,
    source: readFileSync(depthPath, "utf8"),
    real: [],
    stubSources: {
      "../../Shaders/WebGPU/PostProcess/DepthResolveMSAA.js":
        'export default "fixture";',
    },
  });
  const previous = globalThis.GPUShaderStage;
  globalThis.GPUShaderStage = { FRAGMENT: 2 };
  try {
    const formats = [];
    const device = {
      createShaderModule: () => ({}),
      createBindGroupLayout: () => ({}),
      createPipelineLayout: () => ({}),
      createRenderPipeline: (descriptor) => {
        formats.push(descriptor.fragment.targets[0].format);
        return {};
      },
    };
    const half = getDepthResolvePipeline(device),
      full = getDepthResolvePipeline(device, "r32float");
    assert.notEqual(half, full);
    assert.equal(getDepthResolvePipeline(device), half);
    assert.equal(getDepthResolvePipeline(device, "r32float"), full);
    assert.deepEqual(formats, ["r16float", "r32float"]);
  } finally {
    globalThis.GPUShaderStage = previous;
  }
});

test("cloud depth allocation is lazy, full precision and owned by target resize/destruction", async () => {
  const targetPath = path.join(webgpuDirectory, "WebGPURenderTarget.ts");
  const { WebGPURenderTarget } = await bundle({
    path: targetPath,
    source: readFileSync(targetPath, "utf8"),
    real: [],
    stubSources: {
      "./WebGPUDepthResolveMSAA.js":
        "export function dispatchDepthResolve(...args){globalThis.__cloudDepthResolveCalls.push(args);}",
    },
  });
  const previousUsage = globalThis.GPUTextureUsage,
    previousCalls = globalThis.__cloudDepthResolveCalls;
  globalThis.GPUTextureUsage = {
    RENDER_ATTACHMENT: 1,
    TEXTURE_BINDING: 2,
    COPY_SRC: 4,
  };
  globalThis.__cloudDepthResolveCalls = [];
  try {
    const textures = [],
      device = {
        createTexture: (descriptor) => {
          const texture = {
            descriptor,
            destroyed: false,
            createView: (options) => ({ texture, options }),
            destroy: () => {
              texture.destroyed = true;
            },
          };
          textures.push(texture);
          return texture;
        },
      };
    const target = new WebGPURenderTarget(device, {
      name: "scene",
      width: 64,
      height: 32,
      sampleCount: 4,
      depthStencilFormat: "depth24plus-stencil8",
      depthSamplable: true,
    });
    assert.equal(
      textures.filter((t) => t.descriptor.format === "r32float").length,
      0,
    );
    const half = target.getDepthSampleableView(),
      precise = target.resolveCloudDepth({});
    assert.equal(precise.texture.descriptor.format, "r32float");
    assert.equal(target.getDepthSampleableView(), half);
    assert.equal(target.resolveCloudDepth({}), precise);
    assert.equal(
      textures.filter((t) => t.descriptor.format === "r32float").length,
      1,
    );
    assert.equal(globalThis.__cloudDepthResolveCalls.at(-1).at(-1), "r32float");
    target.resize(128, 64);
    assert.equal(precise.texture.destroyed, true);
    const resized = target.resolveCloudDepth({});
    assert.notEqual(resized, precise);
    assert.equal(resized.texture.descriptor.size.width, 128);
    target.destroy();
    assert.equal(resized.texture.destroyed, true);
    const single = new WebGPURenderTarget(device, {
      name: "single",
      width: 64,
      height: 32,
      sampleCount: 1,
      depthStencilFormat: "depth24plus-stencil8",
      depthSamplable: true,
    });
    assert.equal(single.resolveCloudDepth({}), single.getDepthSampleableView());
    single.destroy();
  } finally {
    globalThis.GPUTextureUsage = previousUsage;
    globalThis.__cloudDepthResolveCalls = previousCalls;
  }
});

test("cloud composition keeps the prepared precise depth while other effects retain scene depth", async () => {
  const { executeEnvironmentalEffects } = await loadEnvironmentalEffects();
  const harness = makeHarness({ snapshotCopied: true });
  let cloudDepth;
  const plan = { ...harness.cloudFrame.plan, active: true };
  const cloudFrame = {
    ...harness.cloudFrame,
    plan,
    depthView: "precise-cloud-depth",
    negativeReason: null,
    preparation: { kind: "prepared", plan, maskView: null },
    renderer: {
      isPreparedCloudFrame: () => true,
      executePreparedCloudFrame: (...args) => {
        cloudDepth = args[3];
        return true;
      },
    },
  };
  executeEnvironmentalEffects(harness.config, cloudFrame);
  assert.equal(cloudDepth, "precise-cloud-depth");
  assert.equal(harness.config.context._depthStencilView, DEPTH_VIEW);
});

test("cloud upscale validates with unfiltered full-precision scene depth", async () => {
  const { pathToFileURL } = await import("node:url");
  const nagaDirectory = path.resolve(
    webgpuDirectory,
    "../../../../../Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  const shader = readFileSync(
    path.resolve(
      webgpuDirectory,
      "../../Shaders/WebGPU/Environment/CloudUpscale.wgsl",
    ),
    "utf8",
  );
  assert.doesNotMatch(shader, /textureSampleLevel\(sceneDepthTex/);
  assert.doesNotThrow(() => naga.validate_wgsl(shader));
});
