// @purpose Pins that cloud-frame failures in the post-frustum chain and the environmental stage are reported through the context-carrying reporter, so a multi-context session can tell which context failed.
// @status ACTIVE

// F21. The C13-46 lifecycle relocation added seven failure sites across
// `WebGPUSceneRendererPostFrustumChain.ts` and
// `WebGPUSceneRendererEnvironmentalEffects.ts`, and each was a bare
// `console.error(message, error)` with no context identity — one of them
// replacing a `context.log?.("warn", …)` that had one. Principle 3 requires
// renderer diagnostics to carry the context id: `[CesiumJS:webgpu:ctx-…]` is
// how a split-screen or multi-view session attributes a failure to a context.
//
// These sites are real errors that produce broken output — a frame with no
// clouds, or with every full-screen environmental stage skipped — so they are
// deliberately NOT pragma-wrapped and must still reach the console in a
// production build. The resolution is therefore routing, not suppression: they
// go through the chain's shared `reportCloudLifecycleError`, which builds the
// context-tagged prefix and passes the thrown value through unstringified so a
// stack (or a non-Error throw's identity) survives.
//
// What is asserted is observable: on a failure, the chain hands the failing
// context and the original thrown value to the reporter, and emits no
// untagged console output of its own. Each assertion is paired with an
// inertness mutant that restores the bare `console.error` and must go red.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle } from "./lib/engine-stub-bundler.mjs";

const webgpuDirectory = fileURLToPath(
  new URL("../../packages/engine/Source/Renderer/WebGPU/", import.meta.url),
);

const CONTEXT_ID = "ctx-f21-harness-0123";

// The reporter stub records the context it was handed rather than the string
// it would have printed: the point of F21 is that the context reaches the
// reporter at all. The real reporter's prefix format is exercised by the
// mask-order spec, which asserts identity of the second console argument on
// the renderer's own destroy path.
const CLOUD_RENDERER_STUB = `
export const reported = [];
export function reportCloudLifecycleError(context, message, error) {
  reported.push({ contextId: context?.id, message, error });
}
export function invalidateCloudFrameMask() {}
export function beginCloudFrameAttempt() {
  return null;
}
export function finishNegativeCloudFrameAttempt() {
  return null;
}
export function publishCloudIblCoverage() {}
`;

const ENVIRONMENTAL_EFFECTS_STUB = `
export function resolveCloudFramePlan() {
  return Object.freeze({
    frameNumber: 1,
    request: null,
    config: undefined,
    active: false,
    captureRequested: false,
  });
}
export function beginResolvedCloudFrameAttempt() {
  return null;
}
export function finishResolvedCloudFrameAttempt() {
  return null;
}
export function isPreparedCloudFrameOutcome() {
  return false;
}
export function publishResolvedCloudFrameIbl() {}
`;

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
export function commitEnvironmentalFullscreenStage() {}
export function commitEnvironmentalInPlaceStage() {}
export function presentEnvironmentalEffectsComposition() {
  return true;
}
export function selectEnvironmentalWeatherRoute() {
  return "present-then-canvas";
}
`;

async function loadModule(basename, options) {
  const entryPath = path.join(webgpuDirectory, basename);
  const source = readFileSync(entryPath, "utf8").replaceAll("\r\n", "\n");
  // The bundler hands back the entry module's namespace only, so the stub's
  // recorder is re-exported through it.
  const withRecorder = `${source}\nexport { reported } from "./WebGPUProceduralCloudRenderer.js";\n`;
  return bundle({ path: entryPath, source: withRecorder, ...options });
}

function loadPostFrustumChain(mutate, label) {
  return loadModule("WebGPUSceneRendererPostFrustumChain.ts", {
    real: ["FeatureRendererKey", "WebGPUSceneRendererEnvironmentDemand"],
    stubSources: {
      "./WebGPUProceduralCloudRenderer.js": CLOUD_RENDERER_STUB,
      "./WebGPUSceneRendererEnvironmentalEffects.js":
        ENVIRONMENTAL_EFFECTS_STUB,
    },
    mutate,
    label,
  });
}

function loadEnvironmentalEffects(mutate, label) {
  return loadModule("WebGPUSceneRendererEnvironmentalEffects.ts", {
    real: ["FeatureRendererKey"],
    stubSources: {
      "./WebGPUProceduralCloudRenderer.js": CLOUD_RENDERER_STUB,
      "./WebGPUEnvironmentalEffectsCompositor.js": COMPOSITOR_STUB,
    },
    mutate,
    label,
  });
}

/** Captures anything the chain writes straight to the console. */
function withCapturedConsole(run) {
  const untagged = [];
  const savedError = console.error;
  const savedWarn = console.warn;
  console.error = (...args) => untagged.push(args);
  console.warn = (...args) => untagged.push(args);
  try {
    run();
  } finally {
    console.error = savedError;
    console.warn = savedWarn;
  }
  return untagged;
}

function makePostFrustumHarness(copyError) {
  const encoder = {
    copyTextureToTexture() {
      throw copyError;
    },
  };
  const context = {
    id: CONTEXT_ID,
    _currentCommandEncoder: encoder,
    _postProcessSnapshotTexture: { label: "snapshot" },
    _postProcessSnapshotView: "snapshot-view",
    _postProcessSnapshotWidth: 64,
    _postProcessSnapshotHeight: 32,
    _context: { getCurrentTexture: () => ({ label: "canvas" }) },
    _sceneHasTransmission: true,
    hasVolumetricCloudRequest: false,
    endCurrentRenderPass() {},
  };
  const scene = {
    // SSR alone keeps the snapshot demand alive with no cloud plan at all, so
    // the only failure the frame can produce is the copy itself.
    _enableSSR: true,
    globe: {},
    _frameState: { frameNumber: 1, atmosphericConditions: {} },
  };
  const host = {
    _postProcess: null,
    _sceneFramebuffer: null,
    _ppDebugLogged: true,
    _executeOverlayPass() {},
    _renderDepthPlane() {},
    _executeGBufferProducer() {},
    _runInvertClassificationComposite() {},
    _runVelocityPass() {},
    _executeBoundingVolumeDebugPass() {},
    _ensureSceneColorResolved() {},
    _runPostProcessing() {},
    _executeEnvironmentalEffects() {},
  };
  return {
    host,
    context,
    config: { scene, context, clearGlobeDepth: true, usePostProcess: true },
  };
}

function makeEnvironmentalHarness(configError) {
  const context = {
    id: CONTEXT_ID,
    _depthStencilView: "depth-view",
    _sceneColorView: "raw-scene-view",
    currentTextureView: "canvas-view",
    currentRenderPassEncoder: null,
    presentationFormat: "bgra8unorm",
    depthFormat: "depth24plus-stencil8",
    consumeVolumetricCloudRequest: () => undefined,
    getFeatureRenderer: () => null,
    endCurrentRenderPass() {},
    resumeDefaultRenderPass: () => "canvas-pass",
    log() {},
  };
  const scene = {
    globe: {
      defaultCloudCollection: {
        renderMode: 1,
        volumetric: { enabled: true },
        _resolveVolumetricConfig() {
          throw configError;
        },
      },
    },
    _frameState: { frameNumber: 1, atmosphericConditions: {} },
  };
  return { config: { scene, context } };
}

test("a failed snapshot copy is reported against the failing context, not the bare console", async () => {
  const chain = await loadPostFrustumChain();
  const copyError = Object.freeze({ marker: "snapshot-copy-failure" });
  const harness = makePostFrustumHarness(copyError);
  const untagged = withCapturedConsole(() => {
    chain.executePostFrustumChain(
      harness.host,
      harness.context,
      harness.config,
      [],
    );
  });

  const reported = chain.reported ?? [];
  assert.equal(reported.length, 1, "exactly one failure must be reported");
  assert.equal(
    reported[0].contextId,
    CONTEXT_ID,
    "the reporter must receive the context that failed",
  );
  assert.equal(
    reported[0].error,
    copyError,
    "the original thrown value must survive by identity",
  );
  assert.deepEqual(
    untagged,
    [],
    "nothing may reach the console without a context tag",
  );
});

test("restoring the untagged snapshot-copy report is caught", async () => {
  // Inertness control for the post-frustum site.
  const chain = await loadPostFrustumChain(
    (source) =>
      source.replace(
        [
          "          reportCloudLifecycleError(",
          "            context,",
          '            "Environmental snapshot copy failed.",',
          "            error,",
          "          );",
        ].join("\n"),
        '          console.error("Environmental snapshot copy failed", error);',
      ),
    "restore the untagged snapshot-copy console.error",
  );
  const copyError = Object.freeze({ marker: "snapshot-copy-failure" });
  const harness = makePostFrustumHarness(copyError);
  const untagged = withCapturedConsole(() => {
    chain.executePostFrustumChain(
      harness.host,
      harness.context,
      harness.config,
      [],
    );
  });
  assert.equal(
    (chain.reported ?? []).length,
    0,
    "the mutant must bypass the reporter",
  );
  assert.equal(
    untagged.length,
    1,
    "the mutant must write straight to the console, which is what F21 removes",
  );
});

test("a failed managed cloud config resolution is reported against the failing context", async () => {
  const effects = await loadEnvironmentalEffects();
  const configError = Object.freeze({ marker: "managed-config-failure" });
  const harness = makeEnvironmentalHarness(configError);
  const untagged = withCapturedConsole(() => {
    effects.resolveCloudFramePlan(harness.config, false);
  });

  const reported = effects.reported ?? [];
  assert.equal(reported.length, 1);
  assert.equal(reported[0].contextId, CONTEXT_ID);
  assert.equal(reported[0].error, configError);
  assert.deepEqual(untagged, []);
});

test("restoring the untagged managed-config report is caught", async () => {
  // Inertness control for the environmental site.
  const effects = await loadEnvironmentalEffects(
    (source) =>
      source.replace(
        [
          "        reportCloudLifecycleError(",
          "          context,",
          '          "Managed cloud configuration resolution failed.",',
          "          error,",
          "        );",
        ].join("\n"),
        '        console.error("Managed cloud configuration resolution failed", error);',
      ),
    "restore the untagged managed-config console.error",
  );
  const configError = Object.freeze({ marker: "managed-config-failure" });
  const harness = makeEnvironmentalHarness(configError);
  const untagged = withCapturedConsole(() => {
    effects.resolveCloudFramePlan(harness.config, false);
  });
  assert.equal((effects.reported ?? []).length, 0);
  assert.equal(untagged.length, 1);
});
