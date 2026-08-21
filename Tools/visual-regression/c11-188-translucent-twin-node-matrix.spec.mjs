// C11-188 styled translucent-twin node-matrix contract.
// @purpose Execute the real material packer through both live call sites so the twin differs only by pass class.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/c11-188-translucent-twin-node-matrix.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before } from "node:test";
import { transform } from "esbuild";

const rendererUrl = new URL(
  "../../packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts",
  import.meta.url,
);

let packMaterialUniforms;
let runPrimaryPackCall;
let runTranslucentPackCall;

function matchingDelimiter(source, open, openCharacter, closeCharacter) {
  let depth = 0;
  let quote;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
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
    if (character === openCharacter) depth++;
    if (character === closeCharacter) {
      depth--;
      if (depth === 0) return index;
    }
  }
  assert.fail(`unterminated ${openCharacter}${closeCharacter} construct`);
}

function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing function: ${signature}`);
  const bodyMarker = "\n) {";
  const bodyMarkerStart = source.indexOf(bodyMarker, start + signature.length);
  assert.notEqual(bodyMarkerStart, -1, `missing function body: ${signature}`);
  const open = bodyMarkerStart + bodyMarker.length - 1;
  return source.slice(start, matchingDelimiter(source, open, "{", "}") + 1);
}

function extractCall(source, anchor) {
  assert.equal(
    source.split(anchor).length - 1,
    1,
    `expected one exact call anchor: ${anchor}`,
  );
  const start = source.indexOf(anchor);
  const open = source.indexOf("(", start);
  const close = matchingDelimiter(source, open, "(", ")");
  const semicolon = source.indexOf(";", close + 1);
  assert.match(source.slice(close + 1, semicolon), /^\s*$/u);
  return source.slice(start, semicolon + 1);
}

async function compilePacker(functionSource) {
  const harness = `
const FLAG_HAS_SKINNING = 1;
const MaterialFlags = { HAS_MORPH_TARGETS: 2 };
const Matrix4 = {
  pack(matrix, data, offset) {
    for (let i = 0; i < 16; i++) data[offset + i] = matrix[i];
  },
};
function writeTextureTransform(data, offset) {
  for (let i = 0; i < 12; i++) data[offset + i] = 0;
  data[offset] = 1;
  data[offset + 5] = 1;
  data[offset + 10] = 1;
  return false;
}
${functionSource}
export { packMaterialUniforms };
`;
  const { code } = await transform(harness, {
    loader: "ts",
    format: "cjs",
    target: "es2022",
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", code)(module, module.exports);
  assert.equal(typeof module.exports.packMaterialUniforms, "function");
  return module.exports.packMaterialUniforms;
}

function compileCall(callSource) {
  // eslint-disable-next-line no-new-func
  return new Function(
    "packMaterialUniforms",
    "scope",
    `"use strict";
const {
  primCache,
  primaryMaterialUploadState,
  translucentMaterialUploadState,
  nodeModelMatrix,
  modelMatrix,
  matInfo,
  primHasSkinning,
  primHasMorphTargets,
  pickColor,
  prevNodeModelMatrixForPack,
  cache,
  motionEnabled,
  passClass,
} = scope;
${callSource}`,
  );
}

before(async () => {
  const source = (await readFile(rendererUrl, "utf8")).replaceAll("\r\n", "\n");
  packMaterialUniforms = await compilePacker(
    extractFunction(source, "function packMaterialUniforms("),
  );
  runPrimaryPackCall = compileCall(
    extractCall(
      source,
      "packMaterialUniforms(\n        primCache.materialData,",
    ),
  );
  runTranslucentPackCall = compileCall(
    extractCall(
      source,
      "packMaterialUniforms(\n          primCache.materialDataTranslucent,",
    ),
  );
});

function matrix(seed) {
  return Array.from({ length: 16 }, (_, index) => seed + index + 0.25);
}

function materialInfo() {
  return {
    baseColorFactor: [0.1, 0.2, 0.3, 0.4],
    emissiveFactor: [0.5, 0.6, 0.7],
    metallicFactor: 0.8,
    roughnessFactor: 0.9,
    alphaCutoff: 0.45,
    normalScale: 1.2,
    occlusionStrength: 0.75,
    materialFlags: 0x20,
    specularFactor: [0.2, 0.3, 0.4],
    glossinessFactor: 0.65,
    diffuseFactor: [0.6, 0.7, 0.8, 0.9],
    hasClearcoat: false,
    hasSpecularExt: false,
    hasAnisotropy: false,
    hasIridescence: false,
    hasSheen: false,
    hasVolume: false,
    hasTransmission: false,
  };
}

function storage() {
  const buffer = new ArrayBuffer(192 * Float32Array.BYTES_PER_ELEMENT);
  return {
    data: new Float32Array(buffer),
    words: new Uint32Array(buffer),
  };
}

function executePair({ root, node, previousRoot, previousNode }) {
  const primary = storage();
  const translucent = storage();
  const scope = {
    primCache: {
      materialData: primary.data,
      materialDataTranslucent: translucent.data,
    },
    primaryMaterialUploadState: { currentWords: primary.words },
    translucentMaterialUploadState: { currentWords: translucent.words },
    nodeModelMatrix: node,
    modelMatrix: root,
    matInfo: materialInfo(),
    primHasSkinning: true,
    primHasMorphTargets: true,
    pickColor: { red: 0.2, green: 0.4, blue: 0.6, alpha: 1.0 },
    prevNodeModelMatrixForPack: previousNode,
    cache: { prevModelMatrix: previousRoot },
    motionEnabled: true,
    passClass: 0,
  };
  runPrimaryPackCall(packMaterialUniforms, scope);
  runTranslucentPackCall(packMaterialUniforms, scope);
  return { primary: primary.data, translucent: translucent.data };
}

function differingSlots(left, right) {
  const slots = [];
  for (let index = 0; index < left.length; index++) {
    if (!Object.is(left[index], right[index])) slots.push(index);
  }
  return slots;
}

test("both executed call sites pack current and previous node matrices", () => {
  const cases = [
    {
      name: "identity node",
      root: matrix(0),
      node: matrix(0),
      previousRoot: matrix(20),
      previousNode: matrix(20),
    },
    {
      name: "articulated node",
      root: matrix(100),
      node: matrix(200),
      previousRoot: matrix(300),
      previousNode: matrix(400),
    },
    {
      name: "first visible articulated frame",
      root: matrix(500),
      node: matrix(600),
      previousRoot: matrix(700),
      previousNode: matrix(600),
    },
  ];

  for (const entry of cases) {
    const { primary, translucent } = executePair(entry);
    assert.deepEqual(
      [...primary.slice(0, 16)],
      entry.node,
      `${entry.name}: primary current matrix`,
    );
    assert.deepEqual(
      [...translucent.slice(0, 16)],
      entry.node,
      `${entry.name}: twin current matrix`,
    );
    assert.deepEqual(
      [...primary.slice(156, 172)],
      entry.previousNode,
      `${entry.name}: primary previous matrix`,
    );
    assert.deepEqual(
      [...translucent.slice(156, 172)],
      entry.previousNode,
      `${entry.name}: twin previous matrix`,
    );
  }
});

test("passClass is the only packed difference for an articulated twin", () => {
  const root = matrix(1000);
  const node = matrix(2000);
  const previousRoot = matrix(3000);
  const previousNode = matrix(4000);
  const { primary, translucent } = executePair({
    root,
    node,
    previousRoot,
    previousNode,
  });

  assert.notDeepEqual([...translucent.slice(0, 16)], root);
  assert.notDeepEqual([...translucent.slice(156, 172)], previousRoot);
  assert.deepEqual(differingSlots(primary, translucent), [176]);
  assert.equal(primary[176], 0);
  assert.equal(translucent[176], 1);
});
