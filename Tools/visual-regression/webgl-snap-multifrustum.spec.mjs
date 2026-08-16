// @purpose Source pins for WebGL Scene.snap occluders in DerivedCommand/Scene/SceneRenderer: depth-only reuse, zero color write, blending off, depthMask.
// @status ACTIVE

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sceneRoot = resolve(here, "../../packages/engine/Source/Scene");
const read = (name) => readFileSync(resolve(sceneRoot, name), "utf8");
const squash = (source) => source.replace(/\s+/g, " ");

const derivedCommandSource = read("DerivedCommand.js");
const sceneSource = read("Scene.js");
const sceneRendererSource = read("SceneRenderer.js");

function getFunctionBody(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found`);
  const end = source.indexOf(nextSignature, start);
  assert.notEqual(end, -1, `${nextSignature} not found after ${signature}`);
  return source.slice(start, end);
}

function assertOccluderShaderContract(source) {
  const body = getFunctionBody(
    source,
    "function getSnapOccluderShaderProgram(",
    "function getSnapOccluderRenderState(",
  );
  const normalized = squash(body);
  assert.match(
    normalized,
    /const depthOnlyShaderProgram = getDepthOnlyShaderProgram\( context, shaderProgram, \);/,
  );
  assert.match(normalized, /depthOnlyShaderProgram, "snapOccluder",/);
  assert.match(body, /czm_snap_occluder_main\(\);/);
  assert.match(body, /\$\{outputColorVariable\} = vec4\(0\.0\);/);
}

function assertOccluderStateContract(source) {
  const body = getFunctionBody(
    source,
    "function getSnapOccluderRenderState(",
    "function getSnapShaderProgram(",
  );
  const normalized = squash(body);
  assert.match(normalized, /rs\.blending\.enabled = false;/);
  assert.match(normalized, /rs\.depthMask = true;/);
  for (const channel of ["red", "green", "blue", "alpha"]) {
    assert.match(normalized, new RegExp(`${channel}: true`));
  }
}

test("WebGL snapless occluders reuse depth-only semantics and write zero", () => {
  assertOccluderShaderContract(derivedCommandSource);
  assertOccluderStateContract(derivedCommandSource);

  const factory = getFunctionBody(
    derivedCommandSource,
    "DerivedCommand.createSnapOccluderDerivedCommand = function (",
    "function replaceDefine(",
  );
  assert.match(
    squash(factory),
    /if \(command\.renderState\?\.depthTest\?\.enabled !== true\) \{ return result; \}/,
    "a command that cannot establish depth must retain the color-masked fallback",
  );
  assert.match(factory, /DrawCommand\.shallowClone\(/);
  assert.match(factory, /getSnapOccluderShaderProgram\(/);
  assert.match(factory, /getSnapOccluderRenderState\(/);
  assert.doesNotMatch(
    factory,
    /createCommandEncoder|beginRenderPass|queue\.submit|readPixels/,
  );
});

test("the occluder variant is lazy and selected only for snapless WebGL commands", () => {
  const sceneNormalized = squash(sceneSource);
  assert.match(
    sceneNormalized,
    /let needsUpdateForSnap = false; if \(frameState\.passes\.snap\) \{.*const snapDerivedCommands = useLogDepth && defined\(derivedCommands\.logDepth\?\.command\) \? derivedCommands\.logDepth\.command\.derivedCommands : derivedCommands;/,
  );
  assert.match(
    sceneNormalized,
    /needsUpdateForSnap = \(defined\(command\.snapId\) && !defined\(snapDerivedCommands\.snapping\)\) \|\| \(!defined\(command\.snapId\) && !command\.pickOnly && !defined\(snapDerivedCommands\.snappingOccluder\)\);/,
  );
  assert.match(
    sceneNormalized,
    /if \(frameState\.passes\.snap && !defined\(command\.snapId\)\) \{ derivedCommands\.snappingOccluder = DerivedCommand\.createSnapOccluderDerivedCommand\(/,
  );

  const snapBranch = getFunctionBody(
    sceneRendererSource,
    "if (frameState.passes.snap) {",
    "frameState.pickingMetadata",
  );
  const normalized = squash(snapBranch);
  assert.match(
    normalized,
    /defined\(command\.snapId\) && defined\(command\.derivedCommands\.snapping\)/,
  );
  assert.match(
    normalized,
    /!defined\(command\.snapId\) && defined\(command\.derivedCommands\.snappingOccluder\?\.occluderCommand\)/,
  );
  assert.match(
    normalized,
    /command = command\.derivedCommands\.snappingOccluder\.occluderCommand; command\.execute\(context, passState\);/,
  );
  assert.match(
    normalized,
    /else if \(defined\(command\.derivedCommands\.depth\)\)/,
    "unsupported legacy commands must retain the old depth-only fallback",
  );
});

function drawPixel(state, depth, payload, writesColor = true) {
  if (depth > state.depth) {
    return;
  }
  state.depth = depth;
  if (writesColor) {
    state.payload = payload;
  }
}

function beginFrustumSlice(state) {
  state.depth = 1.0;
}

test("far payload is erased by a nearer snapless winner without another pass", () => {
  const state = { depth: 1.0, payload: 0 };

  beginFrustumSlice(state);
  drawPixel(state, 0.5, 17); // Far slice snap target.
  assert.equal(state.payload, 17);

  beginFrustumSlice(state); // Cesium clears depth but loads payload color.
  drawPixel(state, 0.25, 0); // Near slice snapless occluder.
  assert.equal(state.payload, 0);
});

test("same-slice depth ordering remains independent of command order", () => {
  const occluderFirst = { depth: 1.0, payload: 29 };
  drawPixel(occluderFirst, 0.2, 0);
  drawPixel(occluderFirst, 0.4, 31);
  assert.equal(occluderFirst.payload, 0);

  const targetFirst = { depth: 1.0, payload: 29 };
  drawPixel(targetFirst, 0.4, 31);
  drawPixel(targetFirst, 0.2, 0);
  assert.equal(targetFirst.payload, 0);

  const nearerTarget = { depth: 1.0, payload: 29 };
  drawPixel(nearerTarget, 0.2, 31);
  drawPixel(nearerTarget, 0.4, 0);
  assert.equal(nearerTarget.payload, 31);
});

test("mutation oracle rejects a missing, masked, or nonzero occluder write", () => {
  function requireErasure(payload, writesColor) {
    const state = { depth: 1.0, payload: 41 };
    drawPixel(state, 0.25, payload, writesColor);
    assert.equal(state.payload, 0);
  }

  requireErasure(0, true);
  for (const mutant of [
    () => requireErasure(0, false),
    () => requireErasure(1, true),
    () => requireErasure(41, true),
  ]) {
    assert.throws(mutant, /Expected values to be strictly equal/);
  }

  for (const mutant of [
    derivedCommandSource.replace(
      "${outputColorVariable} = vec4(0.0);",
      "${outputColorVariable} = vec4(1.0);",
    ),
    derivedCommandSource.replace("red: true,", "red: false,"),
  ]) {
    assert.throws(() => {
      assertOccluderShaderContract(mutant);
      assertOccluderStateContract(mutant);
    }, /input did not match|Expected values to be strictly unequal/);
  }

  const missingDepthWinnerGuard = derivedCommandSource.replace(
    "if (command.renderState?.depthTest?.enabled !== true) {",
    "if (false) {",
  );
  assert.throws(() => {
    const factory = getFunctionBody(
      missingDepthWinnerGuard,
      "DerivedCommand.createSnapOccluderDerivedCommand = function (",
      "function replaceDefine(",
    );
    assert.match(
      squash(factory),
      /if \(command\.renderState\?\.depthTest\?\.enabled !== true\) \{ return result; \}/,
    );
  }, /input did not match/);
});
