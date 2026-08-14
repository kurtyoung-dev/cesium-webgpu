import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const sceneSource = readFileSync(
  "packages/engine/Source/Scene/Scene.js",
  "utf8",
);
const viewportSource = readFileSync(
  "packages/engine/Source/Scene/ViewportExecutor.js",
  "utf8",
);
const rendererSource = readFileSync(
  "packages/engine/Source/Renderer/WebGPU/WebGPUSceneRenderer.ts",
  "utf8",
);

const expectedPhases = [
  "sceneUpdate",
  "frameState",
  "contextBegin",
  "sceneEnvironmentUpdate",
  "visibilityCommandPrep",
  "primitiveTraversal",
  "computeShadows",
  "rendererOverhead",
  "frameFinalize",
  "contextEndSubmit",
  "afterRenderCreditTrace",
].sort();

function section(source, startAnchor, endAnchor) {
  const start = source.indexOf(startAnchor);
  assert.ok(start >= 0, `missing start anchor: ${startAnchor}`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  assert.ok(end > start, `missing end anchor: ${endAnchor}`);
  return source.slice(start, end);
}

function assertOrdered(source, anchors) {
  let cursor = -1;
  for (const anchor of anchors) {
    const next = source.indexOf(anchor, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order anchor: ${anchor}`);
    cursor = next;
  }
}

function loadUpdateAndRenderPrimitives() {
  const phaseHelper = section(
    viewportSource,
    "function setCpuScenePhase(scene, phase)",
    "function updateShadowMaps(scene)",
  );
  const shadowHelper = section(
    viewportSource,
    "function updateShadowMaps(scene)",
    "function updateAndRenderPrimitives(",
  );
  const primitiveHelper = section(
    viewportSource,
    "function updateAndRenderPrimitives(",
    "const scratchEyeTranslation",
  );
  return runInNewContext(
    `"use strict";\n${phaseHelper}\n${shadowHelper}\n${primitiveHelper}\nupdateAndRenderPrimitives;`,
    {
      defined: (value) => value !== undefined && value !== null,
      updateDebugFrustumPlanes() {},
    },
  );
}

test("Scene integration exposes exactly the eleven coarse phase names", () => {
  const combined = `${sceneSource}\n${viewportSource}`;
  const actual = [
    ...combined.matchAll(/setCpuScenePhase\([^,]+,\s*"([^"]+)"\)/g),
  ].map((match) => match[1]);
  assert.match(
    sceneSource,
    /beginCpuSceneFrame\([\s\S]*expectedFrameNumber[\s\S]*"sceneUpdate"/,
  );
  actual.push("sceneUpdate");

  assert.deepEqual([...new Set(actual)].sort(), expectedPhases);
  assert.match(
    rendererSource,
    /beginCpuSceneFrame\([\s\S]*initialPhase:\s*CpuScenePhaseName/,
  );
  assert.match(
    rendererSource,
    /setCpuScenePhase\([\s\S]*phase:\s*CpuScenePhaseName/,
  );
});

test("Scene phase cursor follows the exclusive outer-frame order", () => {
  const privateRender = section(
    sceneSource,
    "function render(scene) {",
    "const cpuAccountingSceneGuard",
  );
  assertOrdered(privateRender, [
    'setCpuScenePhase(scene, "frameState")',
    "scene.updateFrameState()",
    'setCpuScenePhase(scene, "contextBegin")',
    "context.beginFrame()",
    'setCpuScenePhase(scene, "sceneEnvironmentUpdate")',
    "scene.updateEnvironment()",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
    "scene.updateAndExecuteCommands(passState, backgroundColor)",
    'setCpuScenePhase(scene, "frameFinalize")',
    "scene.resolveFramebuffers(passState)",
    'setCpuScenePhase(scene, "contextEndSubmit")',
    "context.endFrame()",
  ]);

  const publicRender = section(
    sceneSource,
    "  render(time) {",
    "  createView(camera, viewport, options) {",
  );
  assertOrdered(publicRender, [
    "tryAndCatchError(this, render)",
    'setCpuScenePhase(this, "afterRenderCreditTrace")',
    "callAfterRenderFunctions(this)",
    "frameState.creditDisplay.endFrame()",
    "_samplePerformanceTrace(",
  ]);
});

test("primitive, shadow, and visibility boundaries execute in order", () => {
  const updateAndRenderPrimitives = loadUpdateAndRenderPrimitives();
  const events = [];
  const renderer = {
    setCpuScenePhase(frameNumber, phase) {
      events.push(`phase:${frameNumber}:${phase}`);
      return true;
    },
  };
  const frameState = {
    _cpuSceneProfileRenderer: renderer,
    _cpuSceneProfileFrameNumber: 17,
    context: {
      beginEnvironmentMapUpdateCollection() {
        return true;
      },
      endEnvironmentMapUpdateCollection() {
        events.push("end-environment-collection");
      },
      drainEnvironmentMapUpdates(includeNormal) {
        events.push(`drain-environment:${includeNormal}`);
      },
      flushShadowReceiveUniformRefreshes() {
        events.push("flush");
      },
    },
    passes: {},
    shadowMaps: [],
    shadowState: {
      shadowsEnabled: false,
      lightShadowsEnabled: false,
    },
  };
  const scene = {
    _frameState: frameState,
    frameState,
    _groundPrimitives: {
      update() {
        events.push("ground");
      },
    },
    _primitives: {
      update() {
        events.push("primitives");
      },
    },
    _enableEdgeVisibility: false,
    debugShowFrustumPlanes: false,
    _debugShowFrustumPlanes: false,
    _globe: {
      render() {
        events.push("globe");
      },
    },
  };

  updateAndRenderPrimitives(scene);
  assert.deepEqual(events, [
    "phase:17:primitiveTraversal",
    "ground",
    "primitives",
    "end-environment-collection",
    "phase:17:computeShadows",
    "drain-environment:true",
    "phase:17:primitiveTraversal",
    "phase:17:computeShadows",
    "flush",
    "phase:17:primitiveTraversal",
    "globe",
  ]);
});

test("split 2D and WebVR retain repeated phase attribution", () => {
  const split2D = section(
    viewportSource,
    "function execute2DViewportCommands(scene, passState)",
    "function executeCommandsInViewport(firstViewport, scene, passState)",
  );
  assert.match(
    split2D,
    /executeCommandsInViewport\(true, scene, passState\)[\s\S]*executeCommandsInViewport\(false, scene, passState\)/,
  );

  const viewport = section(
    viewportSource,
    "function executeCommandsInViewport(firstViewport, scene, passState)",
    "function beginSecondaryViewportSegment(firstViewport, scene)",
  );
  assertOrdered(viewport, [
    "updateAndRenderPrimitives(",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
    "view.createPotentiallyVisibleSet(scene)",
    'setCpuScenePhase(scene, "computeShadows")',
    "executeComputeCommands(scene)",
    'setCpuScenePhase(scene, "rendererOverhead")',
    "executeCommands(scene, passState)",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
  ]);

  const webVr = section(
    viewportSource,
    "function executeWebVRCommands(scene, passState)",
    "const scratch2DViewportCartographic",
  );
  assertOrdered(webVr, [
    "updateAndRenderPrimitives(scene)",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
    "view.createPotentiallyVisibleSet(scene)",
    'setCpuScenePhase(scene, "computeShadows")',
    "executeComputeCommands(scene)",
    'setCpuScenePhase(scene, "rendererOverhead")',
    "executeCommands(scene, passState)",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
    'setCpuScenePhase(scene, "rendererOverhead")',
    "executeCommands(scene, passState)",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
  ]);

  const secondaryBoundary = section(
    viewportSource,
    "function beginSecondaryViewportSegment(firstViewport, scene)",
    "function collectPrePvsShadowCasters(",
  );
  assertOrdered(secondaryBoundary, [
    'setCpuScenePhase(scene, "contextEndSubmit")',
    "scene.frameState.context.beginSecondaryViewport?.()",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
  ]);
});

test("same-Scene reentry fail-closes independently of the frame token", () => {
  const publicRender = section(
    sceneSource,
    "  render(time) {",
    "  createView(camera, viewport, options) {",
  );
  const wrapper = section(
    sceneSource,
    "function renderSceneWithCpuAccounting(scene, time, renderer)",
    "function tryAndCatchError",
  );

  assertOrdered(publicRender, [
    "cpuAccountingSceneGuard.get(this)",
    "cpuAccountingState?.active === true",
    "cpuAccountingState.reentered = true",
    "cpuFrameRenderer?.cpuPassProfilingEnabled === true",
    'typeof cpuFrameRenderer.beginCpuSceneFrame === "function"',
    "renderSceneWithCpuAccounting(this, time, cpuFrameRenderer)",
  ]);
  assert.match(sceneSource, /const cpuAccountingSceneGuard = new WeakMap\(\)/);
  assertOrdered(wrapper, [
    "cpuAccountingSceneGuard.get(scene)",
    "accountingState.active = true",
    "accountingState.reentered = false",
    "scene._renderError.addEventListener",
    '"sceneUpdate"',
    "renderSceneForCpuAccounting.call(scene, time)",
    "!accountingState.reentered",
    "renderer.recordSceneFrameCpu(",
    "renderer.cancelCpuSceneFrame(expectedFrameNumber)",
    "accountingState.active = false",
  ]);
  assert.match(
    wrapper,
    /_cpuSceneProfileFrameNumber = expectedFrameNumber[\s\S]*recordSceneFrameCpu\([\s\S]*expectedFrameNumber/,
  );
});
