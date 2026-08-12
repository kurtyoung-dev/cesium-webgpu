// C11-13 — device-free executable and structural policy for camera-inside
// WebGPU voxel proxy rendering.
//
// Run: node --test Tools/visual-regression/voxel-inside-camera-policy.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, "../..");
const engineSource = resolve(root, "packages/engine/Source");
const rendererPath = resolve(
  engineSource,
  "Renderer/WebGPU/WebGPUVoxelRenderer.ts",
);
const renderer = (await readFile(rendererPath, "utf8")).replace(/\r\n/g, "\n");

// Build the real production helpers with their exact Core math dependencies.
// No GPU resource is created; WebGPU globals only satisfy imported type/value
// modules that mention constants outside the exercised functions.
const bundle = await build({
  stdin: {
    contents: `
      export {
        computeVoxelProxyFirstIndex,
        createVoxelProxyIndices,
        updateVoxelProxyCommandFirstIndices,
      } from "./Renderer/WebGPU/WebGPUVoxelRenderer.js";
      export { default as Cartesian3 } from "./Core/Cartesian3.js";
      export { default as Matrix4 } from "./Core/Matrix4.js";
    `,
    resolveDir: engineSource,
    loader: "js",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  write: false,
  logLevel: "silent",
});

globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
globalThis.GPUBufferUsage = { VERTEX: 1, COPY_DST: 2, UNIFORM: 4 };
globalThis.GPUTextureUsage = {
  TEXTURE_BINDING: 1,
  COPY_DST: 2,
  RENDER_ATTACHMENT: 4,
};

const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  bundle.outputFiles[0].text,
).toString("base64")}`;
const {
  Cartesian3,
  Matrix4,
  computeVoxelProxyFirstIndex,
  createVoxelProxyIndices,
  updateVoxelProxyCommandFirstIndices,
} = await import(moduleUrl);

const originalIndices = [
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3, 0, 3,
  7, 0, 7, 4, 1, 5, 6, 1, 6, 2,
];

function worldPoint(model, proxyPoint) {
  return Matrix4.multiplyByPoint(model, proxyPoint, new Cartesian3());
}

function select(model, cameraWorld, result = new Cartesian3()) {
  return computeVoxelProxyFirstIndex(model, cameraWorld, result);
}

function functionSlice(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`function ${nextName}(`, start + 1);
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${name} must precede ${nextName}`);
  return source.slice(start, end);
}

function assessRendererPolicy(source) {
  const failures = [];
  const indexLiteral = source.match(
    /const VOXEL_PROXY_ORIGINAL_INDICES = \[([\s\S]*?)\]\s+as const;/,
  );
  const parsedPrefix = indexLiteral
    ? Array.from(indexLiteral[1].matchAll(/\d+/g), (match) => Number(match[0]))
    : [];
  if (parsedPrefix.join(",") !== originalIndices.join(",")) {
    failures.push("historical index prefix changed");
  }

  const builder = functionSlice(
    source,
    "createVoxelProxyIndices",
    "createBoxGeometry",
  );
  if (
    !/indices\[VOXEL_PROXY_REVERSED_FIRST_INDEX \+ i\] =\s*VOXEL_PROXY_ORIGINAL_INDICES\[i\]/.test(
      builder,
    ) ||
    !/indices\[VOXEL_PROXY_REVERSED_FIRST_INDEX \+ i \+ 1\] =\s*VOXEL_PROXY_ORIGINAL_INDICES\[i \+ 2\]/.test(
      builder,
    ) ||
    !/indices\[VOXEL_PROXY_REVERSED_FIRST_INDEX \+ i \+ 2\] =\s*VOXEL_PROXY_ORIGINAL_INDICES\[i \+ 1\]/.test(
      builder,
    )
  ) {
    failures.push("reversed triangle suffix changed");
  }

  const constructors =
    source.match(/new WebGPUDrawCommand\(\{[\s\S]*?\n\s*\}\);/g) ?? [];
  if (constructors.length !== 4) {
    failures.push("voxel command cardinality changed");
  }
  for (const constructor of constructors) {
    if (
      !/indexBuffer: cache\.indexBuffer,/.test(constructor) ||
      !/indexFormat: "uint16",/.test(constructor) ||
      !/indexCount: VOXEL_PROXY_INDEX_COUNT,/.test(constructor)
    ) {
      failures.push("voxel command lost explicit uint16/count contract");
    }
  }

  const selector = functionSlice(
    source,
    "computeVoxelProxyFirstIndex",
    "packVoxelSampleFrame",
  );
  for (const [label, pattern] of [
    ["epsilon constant", /VOXEL_PROXY_INSIDE_EPSILON/],
    ["finite x", /Number\.isFinite\(x\)/],
    ["finite y", /Number\.isFinite\(y\)/],
    ["finite z", /Number\.isFinite\(z\)/],
    ["inclusive x", /Math\.abs\(x\) <= limit/],
    ["inclusive y", /Math\.abs\(y\) <= limit/],
    ["inclusive z", /Math\.abs\(z\) <= limit/],
    ["finite determinant", /Number\.isFinite\(determinant\)/],
    ["mirrored determinant", /determinant < 0\.0/],
    ["inside/mirror XOR", /cameraInside !== modelMirrored/],
  ]) {
    if (!pattern.test(selector)) {
      failures.push(`selector lost ${label}`);
    }
  }
  if (/new Matrix[34]\(|new Cartesian3\(/.test(selector)) {
    failures.push("selector allocates per frame");
  }

  const synchronizeCommands = functionSlice(
    source,
    "updateVoxelProxyCommandFirstIndices",
    "updateWebGPUVoxelPrimitive",
  );
  for (const [label, pattern] of [
    ["color", /colorCommand\.firstIndex = firstIndex/],
    ["velocity", /velocityCommand\.firstIndex = firstIndex/],
    ["object pick", /commands\.pickCommand\.firstIndex = firstIndex/],
    ["cell pick", /commands\.pickVoxelCommand\.firstIndex = firstIndex/],
  ]) {
    if (!pattern.test(synchronizeCommands)) {
      failures.push(`command synchronization lost ${label}`);
    }
  }

  const update = functionSlice(
    source,
    "updateWebGPUVoxelPrimitive",
    "attachVoxelCellPickCommand",
  );
  const velocityAttach = update.indexOf("attachVoxelVelocityCommand(");
  const objectPick = update.indexOf("if (!cache.pickCommand)");
  const cellPickAttach = update.indexOf("attachVoxelCellPickCommand(");
  const synchronize = update.indexOf("updateVoxelProxyCommandFirstIndices(");
  if (
    velocityAttach < 0 ||
    objectPick <= velocityAttach ||
    cellPickAttach <= objectPick ||
    synchronize <= cellPickAttach
  ) {
    failures.push("command synchronization moved before a lazy attachment");
  }
  if (
    !/computeVoxelProxyFirstIndex\(\s*modelMatrix,\s*camWorld,\s*scratchVoxelProxyCamera,/.test(
      update,
    )
  ) {
    failures.push("selector no longer consumes the exact effective model");
  }
  if (/const invModel =|new Matrix4\(\)|new Cartesian3\(\)/.test(update)) {
    failures.push("update restored camera-selection allocation churn");
  }
  return failures;
}

test("proxy index buffer preserves the old prefix and exactly reverses each triangle", () => {
  const indices = createVoxelProxyIndices();
  assert.ok(indices instanceof Uint16Array);
  assert.equal(indices.length, 72);
  assert.deepEqual(Array.from(indices.slice(0, 36)), originalIndices);
  for (let i = 0; i < 36; i += 3) {
    assert.deepEqual(Array.from(indices.slice(36 + i, 36 + i + 3)), [
      originalIndices[i],
      originalIndices[i + 2],
      originalIndices[i + 1],
    ]);
  }
});

test("camera selection is finite, epsilon-inclusive, transform-correct, and mirrored-XOR", () => {
  const limit = 0.5 + 1.0e-7;
  for (const point of [
    Cartesian3.ZERO,
    new Cartesian3(limit, 0, 0),
    new Cartesian3(-limit, 0, 0),
    new Cartesian3(0, limit, 0),
    new Cartesian3(0, -limit, 0),
    new Cartesian3(0, 0, limit),
    new Cartesian3(0, 0, -limit),
  ]) {
    assert.equal(select(Matrix4.IDENTITY, point), 36);
  }
  assert.equal(
    select(Matrix4.IDENTITY, new Cartesian3(limit + 1.0e-10, 0, 0)),
    0,
  );

  const sheared = new Matrix4(
    2,
    0.5,
    0,
    10,
    0,
    3,
    0.25,
    -4,
    0,
    0,
    4,
    7,
    0,
    0,
    0,
    1,
  );
  const inside = new Cartesian3(0.4, -0.3, 0.2);
  const outside = new Cartesian3(0.6, -0.3, 0.2);
  const recovered = new Cartesian3();
  assert.equal(select(sheared, worldPoint(sheared, inside), recovered), 36);
  assert.ok(Cartesian3.equalsEpsilon(recovered, inside, 1.0e-14, 1.0e-14));
  assert.equal(select(sheared, worldPoint(sheared, outside), recovered), 0);
  assert.ok(Cartesian3.equalsEpsilon(recovered, outside, 1.0e-14, 1.0e-14));

  const translated = Matrix4.fromTranslation(
    new Cartesian3(10, -20, 30),
    new Matrix4(),
  );
  const mirrored = Matrix4.multiplyByScale(
    translated,
    new Cartesian3(-2, 3, 4),
    new Matrix4(),
  );
  const doubleMirrored = Matrix4.multiplyByScale(
    translated,
    new Cartesian3(-2, -3, 4),
    new Matrix4(),
  );
  assert.equal(select(mirrored, worldPoint(mirrored, Cartesian3.ZERO)), 0);
  assert.equal(select(mirrored, worldPoint(mirrored, outside)), 36);
  assert.equal(
    select(doubleMirrored, worldPoint(doubleMirrored, Cartesian3.ZERO)),
    36,
  );
  assert.equal(select(doubleMirrored, worldPoint(doubleMirrored, outside)), 0);

  for (const camera of [
    new Cartesian3(Number.NaN, 0, 0),
    new Cartesian3(0, Number.POSITIVE_INFINITY, 0),
    new Cartesian3(0, 0, Number.NEGATIVE_INFINITY),
  ]) {
    const result = new Cartesian3(1, 1, 1);
    assert.equal(select(Matrix4.IDENTITY, camera, result), 0);
    assert.deepEqual(result, Cartesian3.ZERO);
  }

  const zeroScale = Matrix4.fromScale(new Cartesian3(0, 1, 1), new Matrix4());
  assert.equal(select(zeroScale, Cartesian3.ZERO), 0);
  const nonFiniteModel = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
  nonFiniteModel[0] = Number.NaN;
  assert.equal(select(nonFiniteModel, Cartesian3.ZERO), 0);
});

test("all live command variants transition together, including lazy variants", () => {
  const color = { firstIndex: -1 };
  const objectPick = { firstIndex: -1 };
  const commands = {
    command: color,
    pickCommand: objectPick,
    pickVoxelCommand: null,
  };
  updateVoxelProxyCommandFirstIndices(commands, 0);
  assert.equal(color.firstIndex, 0);
  assert.equal(objectPick.firstIndex, 0);

  const velocity = { firstIndex: -1 };
  const cellPick = { firstIndex: -1 };
  color.velocityCommand = velocity;
  commands.pickVoxelCommand = cellPick;
  updateVoxelProxyCommandFirstIndices(commands, 36);
  assert.deepEqual(
    [color, objectPick, cellPick, velocity].map(
      (command) => command.firstIndex,
    ),
    [36, 36, 36, 36],
  );
  updateVoxelProxyCommandFirstIndices(commands, 0);
  assert.deepEqual(
    [color, objectPick, cellPick, velocity].map(
      (command) => command.firstIndex,
    ),
    [0, 0, 0, 0],
  );
});

test("camera-inside helpers remain strict-TypeScript clean in isolation", () => {
  const constants = renderer.slice(
    renderer.indexOf("const VOXEL_PROXY_HALF_EXTENT"),
    renderer.indexOf("// VOXEL-SHAPEUV-CONVENTION scratches"),
  );
  const selector = functionSlice(
    renderer,
    "computeVoxelProxyFirstIndex",
    "packVoxelSampleFrame",
  );
  const indices = renderer.slice(
    renderer.indexOf("const VOXEL_PROXY_ORIGINAL_INDICES"),
    renderer.indexOf("function createBoxGeometry("),
  );
  const commands = renderer.slice(
    renderer.indexOf("interface VoxelProxyIndexedCommand"),
    renderer.indexOf("function updateWebGPUVoxelPrimitive("),
  );
  const virtualSource = `
    declare class Cartesian3 {
      x: number;
      y: number;
      z: number;
      static readonly ZERO: Cartesian3;
      static clone(value: Cartesian3, result: Cartesian3): Cartesian3;
    }
    declare class Matrix3 extends Array<number> {
      static determinant(matrix: Matrix3): number;
    }
    declare class Matrix4 extends Array<number> {
      static getMatrix3(matrix: Matrix4, result: Matrix3): Matrix3;
      static inverse(matrix: Matrix4, result: Matrix4): Matrix4;
      static multiplyByPoint(
        matrix: Matrix4,
        point: Cartesian3,
        result: Cartesian3,
      ): Cartesian3;
    }
    declare const scratchVoxelProxyInverseModel: Matrix4;
    declare const scratchVoxelProxyLinear: Matrix3;
    ${constants}
    ${selector}
    ${indices}
    ${commands}
  `;
  const virtualName = resolve(
    root,
    "c11-13-voxel-camera-inside-slice.ts",
  ).replaceAll("\\", "/");
  const isVirtual = (fileName) =>
    fileName.replaceAll("\\", "/").toLowerCase() === virtualName.toLowerCase();
  const options = {
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.fileExists = (fileName) => isVirtual(fileName) || fileExists(fileName);
  host.readFile = (fileName) =>
    isVirtual(fileName) ? virtualSource : readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    isVirtual(fileName)
      ? ts.createSourceFile(
          virtualName,
          virtualSource,
          languageVersion,
          true,
          ts.ScriptKind.TS,
        )
      : getSourceFile(fileName, languageVersion, onError, shouldCreate);
  const program = ts.createProgram([virtualName], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(
    diagnostics.map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    ),
    [],
  );
});

test("renderer structurally pins format, winding law, scratch reuse, and lazy order", () => {
  assert.deepEqual(assessRendererPolicy(renderer), []);
});

test("static policy rejects representative winding, format, selector, and lazy-command mutants", () => {
  const mutants = [
    renderer.replace("0, 1, 2, 0, 2, 3", "0, 2, 1, 0, 2, 3"),
    renderer.replace(
      "VOXEL_PROXY_ORIGINAL_INDICES[i + 2];",
      "VOXEL_PROXY_ORIGINAL_INDICES[i + 1];",
    ),
    renderer.replace('      indexFormat: "uint16",\n', ""),
    renderer.replace(
      "cameraInside !== modelMirrored",
      "cameraInside && modelMirrored",
    ),
    renderer.replace(
      "const determinantFinite = Number.isFinite(determinant);",
      "const determinantFinite = true;",
    ),
    renderer.replace("Math.abs(x) <= limit", "Math.abs(x) < limit"),
    renderer.replace("commands.pickVoxelCommand.firstIndex = firstIndex;", ""),
    renderer.replace(
      "\n  updateVoxelProxyCommandFirstIndices(\n",
      "\n  void (\n",
    ),
  ];
  for (const [index, mutant] of mutants.entries()) {
    assert.notEqual(
      mutant,
      renderer,
      `mutant ${index + 1} must alter the source`,
    );
    assert.ok(
      assessRendererPolicy(mutant).length > 0,
      `mutant ${index + 1} must be rejected`,
    );
  }
});
