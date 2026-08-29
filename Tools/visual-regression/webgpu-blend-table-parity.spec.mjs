// webgpu-blend-table-parity.spec.mjs — Cesium's named WebGL blend
// states must translate exactly to their WebGPU equivalents.
//
// @purpose Runs the real lifted WebGPU blend translation from RenderStateToPipelineVariant.ts over every named Scene/BlendingState.js state and compares it against an independently written WebGL-enum-to-GPU oracle, so a blend factor or equation that translates differently on WebGPU than the WebGL state declares fails here.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, build, or GPU device is required.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ENGINE_SOURCE = path.join(REPO_ROOT, "packages", "engine", "Source");
const VARIANT_FILE =
  "packages/engine/Source/Renderer/WebGPU/RenderStateToPipelineVariant.ts";
const OUTPUT_RELATIVE = "Tools/visual-regression/output";
async function engine(relative) {
  return import(pathToFileURL(path.join(ENGINE_SOURCE, relative)).href);
}
const BlendingState = (await engine("Scene/BlendingState.js")).default;
// =============================================================================
// Lift the real WebGPU translation functions from TypeScript
// =============================================================================
function read(relative) {
  return fs
    .readFileSync(path.join(REPO_ROOT, relative), "utf8")
    .replace(/\r\n/g, "\n");
}
function liftFunctionBody(source, name, file) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `no function ${name} in ${file}`);
  const open = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") {
      depth++;
    } else if (source[index] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  throw new Error(`unbalanced body for ${name} in ${file}`);
}
async function importLifted(variant) {
  const outputDirectory = path.join(REPO_ROOT, OUTPUT_RELATIVE);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(outputDirectory, "webgpu-blend-table-"),
  );
  const file = path.join(directory, "lifted-blend-table.mjs");
  const body = (name) => liftFunctionBody(variant, name, VARIANT_FILE);
  const typescript = [
    `function glBlendFactorToGPU(factor) {${body("glBlendFactorToGPU")}}`,
    `function glBlendEquationToGPU(eq) {${body("glBlendEquationToGPU")}}`,
    `export function renderStateToBlendState(renderState) {${body("renderStateToBlendState")}}`,
    "",
  ].join("\n");
  fs.writeFileSync(
    file,
    esbuild.transformSync(typescript, {
      loader: "ts",
      format: "esm",
    }).code,
  );
  const module = await import(pathToFileURL(file).href);
  return { module, directory };
}
function discard(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}
// =============================================================================
// Independent WebGL-to-WebGPU oracle
// =============================================================================
const GPU_OPERATION_BY_WEBGL_VALUE = new Map([
  [0x8006, "add"],
  [0x800a, "subtract"],
  [0x800b, "reverse-subtract"],
  [0x8007, "min"],
  [0x8008, "max"],
]);
const GPU_FACTOR_BY_WEBGL_VALUE = new Map([
  [0, "zero"],
  [1, "one"],
  [0x0300, "src"],
  [0x0301, "one-minus-src"],
  [0x0302, "src-alpha"],
  [0x0303, "one-minus-src-alpha"],
  [0x0304, "dst-alpha"],
  [0x0305, "one-minus-dst-alpha"],
  [0x0306, "dst"],
  [0x0307, "one-minus-dst"],
  [0x0308, "src-alpha-saturated"],
  [0x8001, "constant"],
  [0x8002, "one-minus-constant"],
  [0x8003, "constant"],
  [0x8004, "one-minus-constant"],
]);
const WEBGL_BLEND_TABLE = Object.freeze({
  DISABLED: Object.freeze({
    enabled: false,
  }),
  ALPHA_BLEND: Object.freeze({
    enabled: true,
    equationRgb: 0x8006,
    equationAlpha: 0x8006,
    functionSourceRgb: 0x0302,
    functionSourceAlpha: 1,
    functionDestinationRgb: 0x0303,
    functionDestinationAlpha: 0x0303,
  }),
  PRE_MULTIPLIED_ALPHA_BLEND: Object.freeze({
    enabled: true,
    equationRgb: 0x8006,
    equationAlpha: 0x8006,
    functionSourceRgb: 1,
    functionSourceAlpha: 1,
    functionDestinationRgb: 0x0303,
    functionDestinationAlpha: 0x0303,
  }),
  ADDITIVE_BLEND: Object.freeze({
    enabled: true,
    equationRgb: 0x8006,
    equationAlpha: 0x8006,
    functionSourceRgb: 0x0302,
    functionSourceAlpha: 1,
    functionDestinationRgb: 1,
    functionDestinationAlpha: 1,
  }),
});
// MUTANT INSTRUCTION: In a scratch copy of WEBGL_BLEND_TABLE, swap only
// ADDITIVE_BLEND.functionSourceRgb and functionDestinationRgb; exactly the
// ADDITIVE_BLEND parity assertion below must turn red.
function mapWebGLValue(table, value, kind, stateName) {
  if (!table.has(value)) {
    const formatted =
      typeof value === "number" ? `0x${value.toString(16)}` : String(value);
    throw new Error(`${stateName}: unmapped WebGL ${kind} ${formatted}`);
  }
  return table.get(value);
}
function expectedGPUBlendState(stateName) {
  const blending = WEBGL_BLEND_TABLE[stateName];
  if (!blending.enabled) {
    return undefined;
  }
  return {
    color: {
      srcFactor: mapWebGLValue(
        GPU_FACTOR_BY_WEBGL_VALUE,
        blending.functionSourceRgb,
        "source RGB factor",
        stateName,
      ),
      dstFactor: mapWebGLValue(
        GPU_FACTOR_BY_WEBGL_VALUE,
        blending.functionDestinationRgb,
        "destination RGB factor",
        stateName,
      ),
      operation: mapWebGLValue(
        GPU_OPERATION_BY_WEBGL_VALUE,
        blending.equationRgb,
        "RGB equation",
        stateName,
      ),
    },
    alpha: {
      srcFactor: mapWebGLValue(
        GPU_FACTOR_BY_WEBGL_VALUE,
        blending.functionSourceAlpha,
        "source alpha factor",
        stateName,
      ),
      dstFactor: mapWebGLValue(
        GPU_FACTOR_BY_WEBGL_VALUE,
        blending.functionDestinationAlpha,
        "destination alpha factor",
        stateName,
      ),
      operation: mapWebGLValue(
        GPU_OPERATION_BY_WEBGL_VALUE,
        blending.equationAlpha,
        "alpha equation",
        stateName,
      ),
    },
  };
}
// =============================================================================
// Tests
// =============================================================================
test("every exported BlendingState has exact WebGPU blend-table parity", async (t) => {
  const exportedStateNames = Object.keys(BlendingState).sort();
  const oracleStateNames = Object.keys(WEBGL_BLEND_TABLE).sort();
  assert.deepEqual(
    exportedStateNames,
    oracleStateNames,
    "the oracle must cover every exported named blending state",
  );
  const { module, directory } = await importLifted(read(VARIANT_FILE));
  try {
    for (const stateName of exportedStateNames) {
      await t.test(stateName, () => {
        const actual = module.renderStateToBlendState({
          blending: BlendingState[stateName],
        });
        const expected = expectedGPUBlendState(stateName);
        assert.deepEqual(
          actual,
          expected,
          `${stateName} must translate exactly from its WebGL enum values`,
        );
      });
    }
  } finally {
    discard(directory);
  }
});
