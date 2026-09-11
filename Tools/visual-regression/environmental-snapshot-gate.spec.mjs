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
