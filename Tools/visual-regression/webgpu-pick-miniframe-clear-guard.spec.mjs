// C11-13 preservation repair — standalone WebGPU pick mini-frames own an
// independent clear-loop budget.
//
// Run: node --test Tools/visual-regression/webgpu-pick-miniframe-clear-guard.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compileFunction } from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const contextPath = path.resolve(
  here,
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
);
const contextSource = (await readFile(contextPath, "utf8")).replaceAll(
  "\r\n",
  "\n",
);

const METHOD_MARKER = "  beginPickFrame(): void {";
const COUNTER_RESET = "this._clearCallsThisFrame = 0;";
const WARNING_RESET = "this._clearOverflowWarned = false;";
const ENCODER_CREATE =
  "this._currentCommandEncoder = this._device.createCommandEncoder(";

function extractBeginPickFrame(source) {
  const methodStart = source.indexOf(METHOD_MARKER);
  assert.notEqual(methodStart, -1, "beginPickFrame method marker must exist");

  const openBrace = source.indexOf("{", methodStart + METHOD_MARKER.length - 1);
  assert.notEqual(openBrace, -1, "beginPickFrame opening brace must exist");

  let depth = 1;
  let methodEnd = -1;
  for (let index = openBrace + 1; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        methodEnd = index + 1;
        break;
      }
    }
  }
  assert.notEqual(methodEnd, -1, "beginPickFrame closing brace must exist");

  return {
    body: source.slice(openBrace + 1, methodEnd - 1),
    method: source.slice(methodStart, methodEnd),
    methodEnd,
    methodStart,
    openBrace,
  };
}

function occurrences(source, token) {
  return source.split(token).length - 1;
}

function rawBraceDepthAt(source, targetIndex) {
  let depth = 0;
  for (let index = 0; index < targetIndex; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
    }
  }
  return depth;
}

function assessPickMiniFrameClearGuard(source) {
  const { body } = extractBeginPickFrame(source);
  const errors = [];
  const earlyReturn =
    /if\s*\(\s*this\._isDeviceUnavailable\s*\|\|\s*!this\._device\s*\|\|\s*this\._currentCommandEncoder\s*\)\s*\{\s*return;\s*\}/.exec(
      body,
    );

  if (!earlyReturn) {
    errors.push(
      "beginPickFrame must return before mutation when the device is unavailable or an encoder already exists",
    );
    return errors;
  }

  if (occurrences(body, COUNTER_RESET) !== 1) {
    errors.push(
      "beginPickFrame must reset the clear-call counter exactly once",
    );
  }
  if (occurrences(body, WARNING_RESET) !== 1) {
    errors.push(
      "beginPickFrame must reset the overflow-warning latch exactly once",
    );
  }

  const counterReset = body.indexOf(COUNTER_RESET);
  const warningReset = body.indexOf(WARNING_RESET);
  const encoderCreate = body.indexOf(ENCODER_CREATE);
  const guardEnd = earlyReturn.index + earlyReturn[0].length;
  if (encoderCreate === -1) {
    errors.push("beginPickFrame must create its standalone encoder");
  }

  for (const [label, reset] of [
    ["clear-call counter", counterReset],
    ["overflow-warning latch", warningReset],
  ]) {
    if (reset === -1) {
      continue;
    }
    if (reset <= guardEnd) {
      errors.push(
        `${label} reset must follow the idempotent early-return gate`,
      );
    }
    if (encoderCreate !== -1 && reset >= encoderCreate) {
      errors.push(`${label} reset must precede standalone encoder creation`);
    }
    if (rawBraceDepthAt(body, reset) !== 0) {
      errors.push(`${label} reset must be unconditional for a new mini-frame`);
    }
  }

  if (
    counterReset !== -1 &&
    warningReset !== -1 &&
    counterReset >= warningReset
  ) {
    errors.push("the counter reset must precede the warning-latch reset");
  }
  return errors;
}

function replaceOnceInBeginPickFrame(source, search, replacement) {
  const extracted = extractBeginPickFrame(source);
  assert.equal(
    occurrences(extracted.method, search),
    1,
    `mutation target must occur exactly once in beginPickFrame: ${search}`,
  );
  const mutatedMethod = extracted.method.replace(search, replacement);
  const mutant =
    source.slice(0, extracted.methodStart) +
    mutatedMethod +
    source.slice(extracted.methodEnd);
  assert.notEqual(mutant, source, "mutant must change the production source");
  return mutant;
}

test("a fresh standalone pick mini-frame resets both clear-guard fields", () => {
  const { body } = extractBeginPickFrame(contextSource);
  const beginPickFrame = compileFunction(body);
  const calls = {
    createEncoder: 0,
    timestampBegin: 0,
    uniformBegin: 0,
  };
  const context = {
    _activePassTarget: "stale-target",
    _canvasColorTouchedThisFrame: true,
    _canvasDepthTouchedThisFrame: true,
    _clearCallsThisFrame: 51,
    _clearOverflowWarned: true,
    _currentCommandEncoder: null,
    _currentTextureView: null,
    _device: {
      createCommandEncoder(descriptor) {
        calls.createEncoder++;
        return { descriptor, id: calls.createEncoder };
      },
    },
    _isDeviceUnavailable: false,
    _performanceManager: {
      beginTimestampFrame() {
        calls.timestampBegin++;
      },
    },
    _sceneColorResolvePending: false,
    _shadowReceiveUniformRefreshes: ["stale"],
    _shadowReceiveUniformRefreshSet: new Set(["stale"]),
    _uniformAllocator: {
      beginFrame() {
        calls.uniformBegin++;
      },
    },
  };

  beginPickFrame.call(context);
  assert.equal(context._clearCallsThisFrame, 0);
  assert.equal(context._clearOverflowWarned, false);
  assert.equal(
    context._currentCommandEncoder.descriptor.label,
    "Pick Frame Command Encoder",
  );
  assert.deepEqual(calls, {
    createEncoder: 1,
    timestampBegin: 1,
    uniformBegin: 1,
  });

  // WebGPUPickFramebuffer.begin() and the renderer both call beginPickFrame.
  // The second call sees the active encoder and must not erase this frame's
  // accumulated clear count or its one-shot warning state.
  context._clearCallsThisFrame = 7;
  context._clearOverflowWarned = true;
  beginPickFrame.call(context);
  assert.equal(context._clearCallsThisFrame, 7);
  assert.equal(context._clearOverflowWarned, true);
  assert.deepEqual(calls, {
    createEncoder: 1,
    timestampBegin: 1,
    uniformBegin: 1,
  });

  // endFrame() clears the encoder slot. The next pick is a distinct mini-frame
  // and therefore receives a new budget.
  context._currentCommandEncoder = null;
  beginPickFrame.call(context);
  assert.equal(context._clearCallsThisFrame, 0);
  assert.equal(context._clearOverflowWarned, false);
  assert.deepEqual(calls, {
    createEncoder: 2,
    timestampBegin: 2,
    uniformBegin: 2,
  });
});

test("the production source pins reset ordering to the new-mini-frame path", () => {
  assert.deepEqual(assessPickMiniFrameClearGuard(contextSource), []);
});

test("focused mutants prove every clear-guard ordering clause is load-bearing", () => {
  const resetBlock = `    ${COUNTER_RESET}\n` + `    ${WARNING_RESET}\n`;
  const guardStart = "    if (\n      this._isDeviceUnavailable ||";
  const encoderBlock =
    "    this._currentCommandEncoder = this._device.createCommandEncoder({\n" +
    '      label: "Pick Frame Command Encoder",\n' +
    "    });";

  const withoutCounter = replaceOnceInBeginPickFrame(
    contextSource,
    `    ${COUNTER_RESET}\n`,
    "",
  );
  const withoutWarning = replaceOnceInBeginPickFrame(
    contextSource,
    `    ${WARNING_RESET}\n`,
    "",
  );
  let beforeGuard = replaceOnceInBeginPickFrame(contextSource, resetBlock, "");
  beforeGuard = replaceOnceInBeginPickFrame(
    beforeGuard,
    guardStart,
    resetBlock + guardStart,
  );
  let afterEncoder = replaceOnceInBeginPickFrame(contextSource, resetBlock, "");
  afterEncoder = replaceOnceInBeginPickFrame(
    afterEncoder,
    encoderBlock,
    `${encoderBlock}\n${resetBlock.trimEnd()}`,
  );
  const conditionalReset = replaceOnceInBeginPickFrame(
    contextSource,
    resetBlock,
    "    if (this._currentTextureView === null) {\n" +
      `      ${COUNTER_RESET}\n` +
      `      ${WARNING_RESET}\n` +
      "    }\n",
  );
  const withoutEncoderGuard = replaceOnceInBeginPickFrame(
    contextSource,
    "      !this._device ||\n      this._currentCommandEncoder",
    "      !this._device",
  );

  for (const [name, mutant] of [
    ["missing counter reset", withoutCounter],
    ["missing warning reset", withoutWarning],
    ["resets before early return", beforeGuard],
    ["resets after encoder creation", afterEncoder],
    ["conditional resets", conditionalReset],
    ["missing active-encoder guard", withoutEncoderGuard],
  ]) {
    assert.notDeepEqual(
      assessPickMiniFrameClearGuard(mutant),
      [],
      `${name} mutant must be rejected`,
    );
  }
});
