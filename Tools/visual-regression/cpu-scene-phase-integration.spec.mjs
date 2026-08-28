// @purpose Pins the CPU scene-phase list agreement across Scene.js, ViewportExecutor.js and WebGPUSceneRenderer.ts (vm-executed source integration check).
// @status ACTIVE

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

// ViewportExecutor.js is module-scoped functions, and its signatures move:
// parameters get added and Prettier rewraps them, and the module-level consts
// that used to end a region get refactored away. Slicing on a literal
// signature or on "whatever declaration follows" made this spec measure the
// shape of that churn instead of the phase order it exists to pin. Address a
// region by the only thing that is stable - the function's own name - and
// bound it at the next top-level declaration.
function topLevelFunction(source, name) {
  const marker = `\nfunction ${name}(`;
  const first = source.indexOf(marker);
  assert.ok(first >= 0, `missing top-level function: ${name}`);
  assert.equal(
    source.indexOf(marker, first + marker.length),
    -1,
    `duplicate top-level function: ${name}`,
  );
  const start = first + 1;
  const next = source.indexOf("\nfunction ", start);
  return next < 0 ? source.slice(start) : source.slice(start, next);
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
  // setCpuScenePhase delegates to the frame-state form, so the executed
  // region needs both halves of that pair.
  const phaseHelper = [
    topLevelFunction(viewportSource, "setCpuScenePhase"),
    topLevelFunction(viewportSource, "setCpuScenePhaseForFrameState"),
  ].join("\n");
  const shadowHelper = topLevelFunction(viewportSource, "updateShadowMaps");
  const primitiveHelper = topLevelFunction(
    viewportSource,
    "updateAndRenderPrimitives",
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
  const split2D = topLevelFunction(viewportSource, "execute2DViewportCommands");
  // The viewport call is an injected seam now, so call order alone no longer
  // says which function runs. Pin the default binding as well: absent an
  // override the seam must be the real viewport executor, and the
  // first-viewport call must still precede the second.
  assert.match(
    split2D,
    /function execute2DViewportCommands\([\s\S]*viewportExecutor = executeCommandsInViewport,/,
  );
  assert.match(
    split2D,
    /viewportExecutor\(true, scene, passState\)[\s\S]*viewportExecutor\(false, scene, passState\)/,
  );

  const viewport = topLevelFunction(
    viewportSource,
    "executeCommandsInViewport",
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

  const webVr = topLevelFunction(viewportSource, "executeWebVRCommands");
  // Same injected seam as the 2D path, pinned the same way.
  assert.match(
    webVr,
    /function executeWebVRCommands\([\s\S]*commandExecutor = executeCommands,/,
  );
  assertOrdered(webVr, [
    "updateAndRenderPrimitives(scene)",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
    "view.createPotentiallyVisibleSet(scene)",
    'setCpuScenePhase(scene, "computeShadows")',
    "executeComputeCommands(scene)",
    'setCpuScenePhase(scene, "rendererOverhead")',
    "commandExecutor(scene, passState)",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
    'setCpuScenePhase(scene, "rendererOverhead")',
    "commandExecutor(scene, passState)",
    'setCpuScenePhase(scene, "visibilityCommandPrep")',
  ]);

  const secondaryBoundary = topLevelFunction(
    viewportSource,
    "beginSecondaryViewportSegment",
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
