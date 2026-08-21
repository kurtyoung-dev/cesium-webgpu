// C11-22 WebGPU debug depth-plane gate parity contract.
// @purpose Execute both backend gate statements and the debug command so skip/restore remains parity-safe.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/c11-22-debug-depth-plane-gate-parity.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";

const webgpuContextUrl = new URL(
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
  import.meta.url,
);
const sceneUrl = new URL(
  "../../packages/engine/Source/Scene/Scene.js",
  import.meta.url,
);
const cesiumDebugUrl = new URL(
  "../../packages/engine/Source/Scene/CesiumDebug.js",
  import.meta.url,
);

let runWebGPUGate;
let runSceneGate;
let makeSkipDepthPlaneCommand;

function scanBalancedEnd(source, start, stopAtSemicolon) {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  let quote;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      }
      continue;
    }
    if (quote !== undefined) {
      if (character === "\\") {
        index++;
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "(") parentheses++;
    if (character === ")") parentheses--;
    if (character === "[") brackets++;
    if (character === "]") brackets--;
    if (character === "{") braces++;
    if (character === "}") braces--;
    if (
      stopAtSemicolon &&
      character === ";" &&
      parentheses === 0 &&
      brackets === 0 &&
      braces === 0
    ) {
      return index + 1;
    }
    if (!stopAtSemicolon && braces === 0 && index > start) {
      return index + 1;
    }
  }
  assert.fail("source construct did not terminate");
}

function extractStatement(source, anchor) {
  const start = source.indexOf(anchor);
  assert.notEqual(start, -1, `missing statement anchor: ${anchor}`);
  const end = scanBalancedEnd(source, start, true);
  return source.slice(start, end);
}

function extractMethodBody(source, signature) {
  const signatureStart = source.indexOf(signature);
  assert.notEqual(signatureStart, -1, `missing method: ${signature}`);
  const open = source.indexOf("{", signatureStart + signature.length - 1);
  assert.notEqual(open, -1, `missing method body: ${signature}`);
  const end = scanBalancedEnd(source, open, false);
  return source.slice(open + 1, end - 1);
}

before(async () => {
  const [webgpuSource, sceneSource, debugSource] = await Promise.all([
    readFile(webgpuContextUrl, "utf8"),
    readFile(sceneUrl, "utf8"),
    readFile(cesiumDebugUrl, "utf8"),
  ]);

  const webgpuStatement = extractStatement(
    webgpuSource,
    "environmentState.useDepthPlane =",
  );
  // eslint-disable-next-line no-new-func
  runWebGPUGate = new Function(
    "environmentState",
    "scene",
    `"use strict";\n${webgpuStatement}\nreturn environmentState.useDepthPlane;`,
  );

  const sceneStatement = extractStatement(
    sceneSource,
    "const useDepthPlane = (environmentState.useDepthPlane =",
  );
  // eslint-disable-next-line no-new-func
  const executeSceneStatement = new Function(
    "environmentState",
    "clearGlobeDepth",
    "globeTranslucencyState",
    "SceneMode",
    `"use strict";\n${sceneStatement}\nreturn { local: useDepthPlane, published: environmentState.useDepthPlane };`,
  );
  runSceneGate = ({ clearGlobeDepth, mode, translucency, debugSkip }) =>
    executeSceneStatement.call(
      { mode, debugSkipDepthPlane: debugSkip },
      {},
      clearGlobeDepth,
      { useDepthPlane: translucency },
      { SCENE3D: 3 },
    );

  const debugMethodBody = extractMethodBody(
    debugSource,
    "skipDepthPlane(on) {",
  );
  // eslint-disable-next-line no-new-func
  makeSkipDepthPlaneCommand = new Function(
    "scene",
    "console",
    `"use strict"; return function skipDepthPlane(on) {${debugMethodBody}};`,
  );
});

function webgpuGate({ clearGlobeDepth, mode, translucency, debugSkip }) {
  const environmentState = { clearGlobeDepth };
  const published = runWebGPUGate(environmentState, {
    mode,
    debugSkipDepthPlane: debugSkip,
    _globeTranslucencyState: { useDepthPlane: translucency },
  });
  assert.equal(published, environmentState.useDepthPlane);
  return published;
}

test("the executed Scene and WebGPU gates agree over every input axis", () => {
  for (const clearGlobeDepth of [false, true]) {
    for (const mode of [2, 3]) {
      for (const translucency of [false, true]) {
        for (const debugSkip of [undefined, false, true]) {
          const input = { clearGlobeDepth, mode, translucency, debugSkip };
          const expected =
            clearGlobeDepth && mode === 3 && translucency && debugSkip !== true;
          const scene = runSceneGate(input);
          const webgpu = webgpuGate(input);
          assert.equal(scene.local, expected, JSON.stringify(input));
          assert.equal(scene.published, expected, JSON.stringify(input));
          assert.equal(webgpu, expected, JSON.stringify(input));
        }
      }
    }
  }
});

test("the default non-skip path is the unchanged legacy predicate", () => {
  for (const debugSkip of [undefined, false]) {
    for (const clearGlobeDepth of [false, true]) {
      for (const mode of [2, 3]) {
        for (const translucency of [false, true]) {
          const expectedLegacy = clearGlobeDepth && mode === 3 && translucency;
          assert.equal(
            webgpuGate({
              clearGlobeDepth,
              mode,
              translucency,
              debugSkip,
            }),
            expectedLegacy,
          );
        }
      }
    }
  }
});

test("the executed debug command drives depth plane true-false-true", () => {
  const scene = {
    debugSkipDepthPlane: false,
    requestRenderCalls: 0,
    requestRender() {
      this.requestRenderCalls++;
    },
  };
  const messages = [];
  const command = makeSkipDepthPlaneCommand(scene, {
    log(message) {
      messages.push(message);
    },
  });
  const gate = () =>
    webgpuGate({
      clearGlobeDepth: true,
      mode: 3,
      translucency: true,
      debugSkip: scene.debugSkipDepthPlane,
    });

  assert.equal(gate(), true);
  command();
  assert.equal(gate(), false);
  command(false);
  assert.equal(gate(), true);
  assert.equal(scene.requestRenderCalls, 2);
  assert.equal(messages.length, 2);
});
