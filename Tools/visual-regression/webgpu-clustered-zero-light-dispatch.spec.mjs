// @purpose Proves settled zero-light frames avoid redundant params writes and compute passes.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/webgpu-clustered-zero-light-dispatch.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const dispatcherPath = path.resolve(
  here,
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUClusteredLightingDispatcher.ts",
);
const sceneHookPath = path.resolve(
  here,
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUSceneRendererClusteredLighting.ts",
);

const DISPATCH_MARKER = "  dispatch(\n";
const INERT_SKIP_TARGET = "    if (redundantZeroParams) {";

async function loadSources() {
  const [dispatcherSource, sceneHookSource] = await Promise.all([
    readFile(dispatcherPath, "utf8"),
    readFile(sceneHookPath, "utf8"),
  ]);
  return {
    dispatcherSource: dispatcherSource.replaceAll("\r\n", "\n"),
    sceneHookSource: sceneHookSource.replaceAll("\r\n", "\n"),
  };
}

function occurrences(source, token) {
  return source.split(token).length - 1;
}

function extractDispatch(source) {
  const methodStart = source.indexOf(DISPATCH_MARKER);
  assert.notEqual(methodStart, -1, "dispatch method marker must exist");
  const openBrace = source.indexOf("{", methodStart + DISPATCH_MARKER.length);
  assert.notEqual(openBrace, -1, "dispatch opening brace must exist");

  let depth = 1;
  for (let index = openBrace + 1; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return {
          body: source.slice(openBrace + 1, index),
          method: source.slice(methodStart, index + 1),
          methodEnd: index + 1,
          methodStart,
        };
      }
    }
  }
  assert.fail("dispatch closing brace must exist");
}

function compileDispatch(source) {
  return compileFunction(extractDispatch(source).body, ["encoder", "inputs"]);
}

function makeInputs(activeCount = 0, areaCount = 0) {
  return {
    enabled: true,
    lights: Array.from({ length: activeCount }, () => ({})),
    areaLights: Array.from({ length: areaCount }, () => ({})),
    viewportWidth: 800,
    viewportHeight: 600,
    near: 1,
    far: 10000,
    inverseProjection: new Float32Array(16),
    viewMatrix: new Float32Array(16),
  };
}

function makeDispatcherHarness() {
  const calls = { paramsWrites: 0, boundsPasses: 0, assignPasses: 0 };
  const dispatcher = {
    _lastActiveLightCount: 0,
    _lastAreaLightCount: 0,
    _lastWrittenActiveLightCount: 0,
    _lastWrittenAreaLightCount: 0,
    _paramsBuffer: {},
    _paramsData: new Float32Array(8),
    _scratchEyeLights: Array.from({ length: 8 }, () => ({})),
    _device: {
      queue: {
        writeBuffer() {
          calls.paramsWrites++;
        },
      },
    },
    _bounds: {
      storageBuffer: {},
      dispatch() {
        calls.boundsPasses++;
        return true;
      },
    },
    _assign: {
      dispatch() {
        calls.assignPasses++;
      },
    },
    _packEyeSpaceLights(lights) {
      return lights.length;
    },
    _packAreaLights(areaLights) {
      return areaLights.length;
    },
  };
  return { calls, dispatcher };
}

function assertZeroLightContract(dispatch) {
  const settled = makeDispatcherHarness();
  assert.equal(dispatch.call(settled.dispatcher, {}, makeInputs()), 0);
  assert.deepEqual(
    settled.calls,
    { paramsWrites: 0, boundsPasses: 0, assignPasses: 0 },
    "a settled zero-light frame must perform no dispatcher work",
  );

  const punctual = makeDispatcherHarness();
  assert.equal(dispatch.call(punctual.dispatcher, {}, makeInputs(1, 0)), 1);
  const punctualWritesBeforeZero = punctual.calls.paramsWrites;
  assert.equal(dispatch.call(punctual.dispatcher, {}, makeInputs()), 0);
  assert.equal(dispatch.call(punctual.dispatcher, {}, makeInputs()), 0);
  assert.equal(
    punctual.calls.paramsWrites - punctualWritesBeforeZero,
    1,
    "a punctual-light transition must write zero exactly once",
  );
  assert.deepEqual(
    {
      boundsPasses: punctual.calls.boundsPasses,
      assignPasses: punctual.calls.assignPasses,
    },
    { boundsPasses: 1, assignPasses: 1 },
  );

  const area = makeDispatcherHarness();
  assert.equal(dispatch.call(area.dispatcher, {}, makeInputs(0, 1)), 0);
  const areaWritesBeforeZero = area.calls.paramsWrites;
  assert.equal(dispatch.call(area.dispatcher, {}, makeInputs()), 0);
  assert.equal(dispatch.call(area.dispatcher, {}, makeInputs()), 0);
  assert.equal(
    area.calls.paramsWrites - areaWritesBeforeZero,
    1,
    "an area-light transition must write zero exactly once",
  );
  assert.deepEqual(
    {
      boundsPasses: area.calls.boundsPasses,
      assignPasses: area.calls.assignPasses,
    },
    { boundsPasses: 0, assignPasses: 0 },
  );
}

function makeInertSkipMutant(source) {
  const extracted = extractDispatch(source);
  assert.equal(
    occurrences(extracted.method, INERT_SKIP_TARGET),
    1,
    "the skip mutation target must occur exactly once",
  );
  const mutantMethod = extracted.method.replace(
    INERT_SKIP_TARGET,
    "    if (false && redundantZeroParams) {",
  );
  return (
    source.slice(0, extracted.methodStart) +
    mutantMethod +
    source.slice(extracted.methodEnd)
  );
}

test("the extracted dispatcher skips settled zeros and writes each transition once", async () => {
  const { dispatcherSource } = await loadSources();
  assertZeroLightContract(compileDispatch(dispatcherSource));
});

test("the scene hook decides settled zero work before ending the render pass", async () => {
  const { dispatcherSource, sceneHookSource } = await loadSources();
  assert.match(dispatcherSource, /GPUBufferUsage\.COPY_SRC/u);
  const enabledStart = sceneHookSource.indexOf(
    "_disabledClusteredLightingHosts.delete(host);",
  );
  const zeroGuard = sceneHookSource.indexOf(
    "lights.length === 0 &&",
    enabledStart,
  );
  const endRenderPass = sceneHookSource.indexOf(
    "context.endCurrentRenderPass?.();",
    enabledStart,
  );
  assert.notEqual(enabledStart, -1);
  assert.notEqual(zeroGuard, -1);
  assert.notEqual(endRenderPass, -1);
  assert.ok(zeroGuard < endRenderPass);
  assert.match(
    sceneHookSource,
    /lights\.length === 0 &&\s*areaLights\.length === 0 &&\s*dispatcher\.paramsAreAllZero/u,
  );
  assert.match(sceneHookSource, /lights\.length = 0;/u);
  assert.match(sceneHookSource, /areaLights\.length = 0;/u);
  assert.match(
    sceneHookSource,
    /const _clusteredLightingBufferStashes = new WeakMap</u,
  );
});

test("an inert skip mutation is rejected by the zero-light contract", async () => {
  const { dispatcherSource } = await loadSources();
  const mutantSource = makeInertSkipMutant(dispatcherSource);
  const mutantDispatch = compileDispatch(mutantSource);
  const settled = makeDispatcherHarness();
  mutantDispatch.call(settled.dispatcher, {}, makeInputs());
  assert.equal(settled.calls.paramsWrites, 1);
  assert.throws(() => assertZeroLightContract(mutantDispatch), {
    name: "AssertionError",
  });
});
