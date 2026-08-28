#!/usr/bin/env node
// @purpose Derivation gate for the WebGPU elevation-material vertex height: executes the real
//          TypeScript camera-uniform writers, evaluates the live WGSL height expression in f32
//          over a two-body geodetic grid, and proves the instrument red under nine mutations.
// @status ACTIVE
//
// WHY THIS EXISTS. The six PrimitiveMatElev* shaders once derived vertex height as
// `length(positionHigh + positionLow) - 6371000.0`: a spherical radius taken from a bare double
// sum, wrong by up to about 21 km on WGS84, blind to the model matrix, and unable to follow a
// non-Earth datum. The replacement reconstructs the world position from the relative-to-eye
// delta and derives height in scaled-ellipsoid space. Both halves of that change live in
// different languages, so an assertion on either half alone proves nothing about the pair.
//
// WHAT IS ACTUALLY CHECKED. No source text is pinned. The producer functions are extracted from
// the TypeScript by AST and transpiled, so the bytes that run are the bytes that ship. The shader
// expression is parsed out of the .wgsl with comments stripped and evaluated node by node in f32,
// so a reversed sum, a swapped swizzle, or a commented-out decoy is caught by the number it
// produces rather than by the shape of the line that produced it. Every mutation leg below has to
// move a number or fail evaluation.
//
// WHAT IS NOT CHECKED HERE. This is a browser-free algebraic gate. It does not compile WGSL, does
// not create a device, and does not look at a pixel. Pixel confirmation of the rendered ramp is
// owed separately.
//
// The exploratory harness under Tools/visual-regression/output/a6-elevation-height/ seeded the
// approach; the parser, the layout calculator, the envelope and the mutation legs here were
// written independently against the files themselves.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import Ellipsoid from "../../packages/engine/Source/Core/Ellipsoid.js";
import EncodedCartesian3 from "../../packages/engine/Source/Core/EncodedCartesian3.js";
import Matrix3 from "../../packages/engine/Source/Core/Matrix3.js";
import Matrix4 from "../../packages/engine/Source/Core/Matrix4.js";
import Transforms from "../../packages/engine/Source/Core/Transforms.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const PRODUCER_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUPrimitiveCommands.ts";

const SHADER_FILES = [
  "RampFlat",
  "RampLit",
  "BandFlat",
  "BandLit",
  "ContourFlat",
  "ContourLit",
].map(
  (name) =>
    `packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElev${name}.wgsl`,
);

const FLAT_SHADERS = SHADER_FILES.filter((file) => file.endsWith("Flat.wgsl"));
const LIT_SHADERS = SHADER_FILES.filter((file) => file.endsWith("Lit.wgsl"));

// The declared envelope. Heights run from a continental depression to low orbit; camera
// separations span three decades because relative-to-eye precision degrades with viewing
// distance, not with altitude. Half-degree latitudes are needed because the residual is a smooth
// function of latitude whose peak sits well away from both the equator and the poles.
const ENVELOPE_HEIGHTS_METERS = [-1000, 0, 25, 1000, 9000, 100000, 500000];
const ENVELOPE_CAMERA_SEPARATIONS_METERS = [1000, 25000, 1000000];
const ENVELOPE_LATITUDE_STEP_DEGREES = 0.5;
const ENVELOPE_LONGITUDES_DEGREES = [
  -180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150, 179.5,
];
const ENVELOPE_BOUND_METERS = 4.0;
// The residual is a signed bias, not white noise: it peaks roughly between 45 and 61 degrees of
// latitude and averages out toward zero on a grid sampled only at the equator and the poles. A
// mean over the mid-latitude band is the statistic that can see it.
const MID_LATITUDE_BAND_DEGREES = [40, 65];
const MID_LATITUDE_MEAN_BOUND_METERS = 1.0;
// Model-matrix invariance is asserted where relative-to-eye noise stays small enough to be
// distinguishable from a real transform defect. At a 1,000 km camera separation the f32 noise
// floor alone exceeds a metre, so invariance uses the near-camera legs.
const INVARIANCE_SEPARATIONS_METERS = [1000, 25000];
const INVARIANCE_TOLERANCE_METERS = 1.0;

// A triaxial non-Earth body. WGS84 alone cannot discriminate a wrong-datum producer, because the
// shader's hardcoded fallback constants coincide with WGS84's real inverse radii.
const MOON_RADII_METERS = Object.freeze({
  x: 1738100.0,
  y: 1736000.0,
  z: 1734600.0,
});

const f32 = Math.fround;

// =============================================================================
// Producer extraction
// =============================================================================

const PRODUCER_FUNCTIONS = new Set([
  "assertUniformDataCapacity",
  "writeEllipsoidOneOverRadiiTail",
  "writeModelToWorldPositionTail",
  "writeRTEUniformsFlat",
]);

const PRODUCER_CONSTANT_PATTERN =
  /const\s+((?:FLAT|LIT|PICK)_[A-Z0-9_]*(?:OFFSET|BYTES))\s*=\s*(\d+)/;

// Sentinel stamped across the shared flat head by the stand-in below. The head's own contents are
// the engine Jasmine spec's subject; what matters here is that the appended tail lands after the
// head and leaves every one of its floats alone.
const HEAD_SENTINEL = -8191.5;

/**
 * Extracts the camera-uniform writers from the TypeScript by AST, transpiles them, and imports
 * the result. Importing the whole module is impossible in an unbuilt tree: it pulls in generated
 * shader siblings that exist only after a build.
 */
async function loadProducer(root) {
  const source = fs
    .readFileSync(path.join(root, PRODUCER_FILE), "utf8")
    .replace(/\r\n/g, "\n");
  const sourceFile = ts.createSourceFile(
    "WebGPUPrimitiveCommands.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const fragments = [];
  const exported = new Set();
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      PRODUCER_FUNCTIONS.has(statement.name.text)
    ) {
      fragments.push(
        source.slice(statement.getStart(sourceFile), statement.end),
      );
      exported.add(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      const text = source.slice(statement.getStart(sourceFile), statement.end);
      const match = text.match(PRODUCER_CONSTANT_PATTERN);
      if (match) {
        fragments.push(`const ${match[1]} = ${match[2]};`);
        exported.add(match[1]);
      }
    }
  }

  for (const name of PRODUCER_FUNCTIONS) {
    assert.ok(
      exported.has(name),
      `producer function ${name} was not found in ${PRODUCER_FILE}`,
    );
  }

  const prelude = [
    "const defined = (value) => value !== undefined && value !== null;",
    "class DeveloperError extends Error {}",
    "const pragmas = { debug: true };",
    "let headCalls = [];",
    "export const takeHeadCalls = () => { const calls = headCalls; headCalls = []; return calls; };",
    // Stand-in for the shared flat head: records the capacity the caller demanded and stamps a
    // sentinel across the head's floats, so an overlapping tail write shows up as a changed byte.
    "function writeRTEUniformsFlatHead(ud, rte, uniformState) {",
    "  headCalls.push({ length: ud.length });",
    `  for (let i = 0; i < PICK_CAMERA_BYTES / 4; ++i) { ud[i] = ${HEAD_SENTINEL}; }`,
    "}",
  ].join("\n");

  const moduleText = `${prelude}\n${fragments.join("\n")}\nexport { ${[
    ...exported,
  ].join(", ")} };\n`;

  const transpiled = ts.transpileModule(moduleText, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  }).outputText;

  const file = path.join(
    os.tmpdir(),
    `elev-producer-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`,
  );
  fs.writeFileSync(file, transpiled);
  try {
    return await import(`file:///${file.replaceAll("\\", "/")}`);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      // A leftover temp module in the OS temp directory is harmless.
    }
  }
}

// =============================================================================
// WGSL parsing and evaluation
// =============================================================================

function normalize(text) {
  return text.replace(/\r\n/g, "\n");
}

function stripComments(text) {
  return normalize(text)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ");
}

const TOKEN_PATTERN =
  /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*|\d+\.?\d*(?:[eE][+-]?\d+)?|>=|<=|==|!=|&&|\|\||[()+\-*/,<>]/g;

function tokenize(text) {
  return text.match(TOKEN_PATTERN) ?? [];
}

/** Parses one WGSL expression into a tree, so the grid does not re-tokenize per sample. */
function parseExpression(tokens) {
  let index = 0;
  const peek = () => tokens[index];
  const take = (expected) => {
    if (expected !== undefined && tokens[index] !== expected) {
      throw new Error(`expected ${expected}, found ${tokens[index]}`);
    }
    return tokens[index++];
  };

  function argumentList() {
    while (peek() !== "(" && index < tokens.length) {
      take();
    }
    take("(");
    const args = [];
    if (peek() !== ")") {
      args.push(expression());
      while (peek() === ",") {
        take(",");
        if (peek() === ")") {
          break;
        }
        args.push(expression());
      }
    }
    take(")");
    return args;
  }

  function primary() {
    const token = peek();
    if (token === "(") {
      take("(");
      const inner = expression();
      take(")");
      return inner;
    }
    if (token === "-") {
      take("-");
      return { kind: "negate", operand: primary() };
    }
    if (/^\d/.test(token)) {
      return { kind: "literal", value: f32(parseFloat(take())) };
    }
    const name = take();
    if (name === "length") {
      return { kind: "length", operand: argumentList()[0] };
    }
    if (name === "select") {
      const args = argumentList();
      return {
        kind: "select",
        whenFalse: args[0],
        whenTrue: args[1],
        condition: args[2],
      };
    }
    if (/^mat3x3/.test(name)) {
      return { kind: "matrix3", columns: argumentList() };
    }
    if (/^vec[234]/.test(name)) {
      return { kind: "vector", components: argumentList() };
    }
    if (peek() === "(" || peek() === "<") {
      throw new Error(`unsupported call in derivation: ${name}`);
    }
    return { kind: "identifier", name: name };
  }

  function product() {
    let left = primary();
    while (peek() === "*" || peek() === "/") {
      const operator = take();
      left = {
        kind: "binary",
        operator: operator,
        left: left,
        right: primary(),
      };
    }
    return left;
  }

  function sum() {
    let left = product();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      left = {
        kind: "binary",
        operator: operator,
        left: left,
        right: product(),
      };
    }
    return left;
  }

  function comparison() {
    let left = sum();
    while ([">", "<", ">=", "<=", "==", "!="].includes(peek())) {
      const operator = take();
      left = { kind: "compare", operator: operator, left: left, right: sum() };
    }
    return left;
  }

  function conjunction() {
    let left = comparison();
    while (peek() === "&&" || peek() === "||") {
      const operator = take();
      left = {
        kind: "logical",
        operator: operator,
        left: left,
        right: comparison(),
      };
    }
    return left;
  }

  function expression() {
    return conjunction();
  }

  const tree = expression();
  if (index !== tokens.length) {
    throw new Error(
      `trailing tokens after expression: ${tokens.slice(index).join(" ")}`,
    );
  }
  return tree;
}

const SWIZZLE_INDEX = { x: 0, y: 1, z: 2, w: 3 };

function resolveIdentifier(name, environment) {
  if (name in environment) {
    return environment[name];
  }
  const split = name.lastIndexOf(".");
  if (split > 0) {
    const suffix = name.slice(split + 1);
    if (/^[xyzw]{1,4}$/.test(suffix)) {
      const base = environment[name.slice(0, split)];
      if (Array.isArray(base)) {
        const selected = [...suffix].map((component) => {
          const value = base[SWIZZLE_INDEX[component]];
          if (value === undefined) {
            throw new Error(`swizzle ${name} reads past the source vector`);
          }
          return value;
        });
        return selected.length === 1 ? selected[0] : selected;
      }
    }
  }
  throw new Error(`unknown identifier ${name}`);
}

function componentsOf(value) {
  return Array.isArray(value) ? value : [value, value, value];
}

function applyBinary(left, right, apply) {
  if (typeof left === "number" && typeof right === "number") {
    return f32(apply(left, right));
  }
  const a = componentsOf(left);
  const b = componentsOf(right);
  const width = Math.max(a.length, b.length);
  const result = [];
  for (let i = 0; i < width; ++i) {
    result.push(f32(apply(a[i % a.length], b[i % b.length])));
  }
  return result;
}

function evaluate(node, environment) {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "identifier":
      return resolveIdentifier(node.name, environment);
    case "negate": {
      const operand = evaluate(node.operand, environment);
      return typeof operand === "number"
        ? f32(-operand)
        : operand.map((component) => f32(-component));
    }
    case "length": {
      const components = componentsOf(evaluate(node.operand, environment));
      let total = 0;
      for (const component of components) {
        total = f32(total + f32(component * component));
      }
      return f32(Math.sqrt(total));
    }
    case "select":
      return evaluate(node.condition, environment)
        ? evaluate(node.whenTrue, environment)
        : evaluate(node.whenFalse, environment);
    case "matrix3":
      return {
        columns: node.columns.map((column) =>
          componentsOf(evaluate(column, environment)),
        ),
      };
    case "vector": {
      const flat = [];
      for (const component of node.components) {
        const value = evaluate(component, environment);
        if (Array.isArray(value)) {
          flat.push(...value);
        } else {
          flat.push(value);
        }
      }
      return flat.length === 1 ? [flat[0], flat[0], flat[0]] : flat;
    }
    case "binary": {
      const left = evaluate(node.left, environment);
      const right = evaluate(node.right, environment);
      if (left !== null && typeof left === "object" && !Array.isArray(left)) {
        if (node.operator !== "*") {
          throw new Error(`unsupported matrix operator ${node.operator}`);
        }
        const vector = componentsOf(right);
        return [0, 1, 2].map((row) => {
          let total = 0;
          for (let column = 0; column < 3; ++column) {
            total = f32(
              total + f32(left.columns[column][row] * vector[column]),
            );
          }
          return total;
        });
      }
      return applyBinary(
        left,
        right,
        node.operator === "*"
          ? (a, b) => a * b
          : node.operator === "/"
            ? (a, b) => a / b
            : node.operator === "+"
              ? (a, b) => a + b
              : (a, b) => a - b,
      );
    }
    case "compare": {
      const left = evaluate(node.left, environment);
      const right = evaluate(node.right, environment);
      const a = typeof left === "number" ? left : left[0];
      const b = typeof right === "number" ? right : right[0];
      switch (node.operator) {
        case ">":
          return a > b;
        case "<":
          return a < b;
        case ">=":
          return a >= b;
        case "<=":
          return a <= b;
        case "==":
          return a === b;
        default:
          return a !== b;
      }
    }
    case "logical": {
      const left = Boolean(evaluate(node.left, environment));
      return node.operator === "&&"
        ? left && Boolean(evaluate(node.right, environment))
        : left || Boolean(evaluate(node.right, environment));
    }
    default:
      throw new Error(`unsupported node ${node.kind}`);
  }
}

// The derivation is located by its bindings, not by its text, so a reverted or rewritten block is
// still found and still evaluated rather than silently skipped.
const DERIVATION_PATTERN =
  /let\s+(?:modelMatrix3|worldPos)[\s\S]*?output\.height\s*=[^;]*;/;

/** Parses one shader's live height derivation together with its module constants. */
function parseShader(root, file) {
  const stripped = stripComments(
    fs.readFileSync(path.join(root, file), "utf8"),
  );

  const constants = Object.create(null);
  const constantPattern =
    /const\s+([A-Za-z_][A-Za-z0-9_]*)\s*:[^=]+=\s*([\s\S]*?);/g;
  let constantMatch;
  while ((constantMatch = constantPattern.exec(stripped)) !== null) {
    try {
      constants[constantMatch[1]] = evaluate(
        parseExpression(tokenize(constantMatch[2])),
        constants,
      );
    } catch {
      // Module constants the derivation never reads are outside this gate's scope.
    }
  }

  const block = stripped.match(DERIVATION_PATTERN);
  if (block === null) {
    throw new Error(`no height derivation found in ${file}`);
  }

  const statements = [];
  for (const raw of block[0].split(";")) {
    const text = raw.trim();
    if (text.length === 0) {
      continue;
    }
    const binding = text.match(
      /^(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/,
    );
    if (binding !== null) {
      statements.push({
        target: binding[1],
        tree: parseExpression(tokenize(binding[2])),
      });
      continue;
    }
    const output = text.match(/^output\.height\s*=\s*([\s\S]*)$/);
    if (output !== null) {
      statements.push({
        target: null,
        tree: parseExpression(tokenize(output[1])),
      });
      continue;
    }
    throw new Error(`unsupported statement in ${file}: ${text}`);
  }

  assert.ok(
    statements.some((statement) => statement.target === null),
    `no output.height assignment parsed from ${file}`,
  );
  return {
    file: file,
    constants: constants,
    statements: statements,
    layout: computeStructLayout(root, file, "CameraUniforms"),
  };
}

function evaluateHeight(shader, inputs) {
  const environment = Object.assign(
    Object.create(null),
    shader.constants,
    inputs,
  );
  let height;
  for (const statement of shader.statements) {
    const value = evaluate(statement.tree, environment);
    if (statement.target === null) {
      height = value;
    } else {
      environment[statement.target] = value;
    }
  }
  return typeof height === "number" ? height : componentsOf(height)[0];
}

// =============================================================================
// WGSL uniform-struct layout
// =============================================================================

const WGSL_TYPE_LAYOUT = {
  f32: { size: 4, align: 4 },
  i32: { size: 4, align: 4 },
  u32: { size: 4, align: 4 },
  "vec2<f32>": { size: 8, align: 8 },
  "vec3<f32>": { size: 12, align: 16 },
  "vec4<f32>": { size: 16, align: 16 },
  "mat3x3<f32>": { size: 48, align: 16 },
  "mat4x4<f32>": { size: 64, align: 16 },
};

/** Computes uniform-address-space byte offsets for a WGSL struct declaration. */
function computeStructLayout(root, file, structName) {
  const stripped = stripComments(
    fs.readFileSync(path.join(root, file), "utf8"),
  );
  const body = stripped.match(
    new RegExp(`struct\\s+${structName}\\s*\\{([\\s\\S]*?)\\}`),
  );
  assert.ok(body !== null, `struct ${structName} not found in ${file}`);

  const offsets = Object.create(null);
  let cursor = 0;
  let maxAlign = 1;
  for (const raw of body[1].split(",")) {
    const text = raw.trim();
    if (text.length === 0) {
      continue;
    }
    const field = text.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/);
    assert.ok(field !== null, `unparsable field in ${structName}: ${text}`);
    const type = field[2].replace(/\s+/g, "");
    const layout = WGSL_TYPE_LAYOUT[type];
    assert.ok(layout !== undefined, `unsupported WGSL type ${type} in ${file}`);
    cursor = Math.ceil(cursor / layout.align) * layout.align;
    offsets[field[1]] = cursor;
    cursor += layout.size;
    maxAlign = Math.max(maxAlign, layout.align);
  }
  return { offsets: offsets, size: Math.ceil(cursor / maxAlign) * maxAlign };
}

// =============================================================================
// Grid execution
// =============================================================================

const scratchInverse = new Matrix4();
const scratchMatrix3 = new Matrix3();
const scratchWorld = new Cartesian3();
const scratchCameraWorld = new Cartesian3();
const scratchModel = new Cartesian3();
const scratchCameraModel = new Cartesian3();
const scratchEncodedVertex = new EncodedCartesian3();
const scratchEncodedCamera = new EncodedCartesian3();
const scratchEncodedCameraWorld = new EncodedCartesian3();

function toF32Triple(cartesian) {
  return [f32(cartesian.x), f32(cartesian.y), f32(cartesian.z)];
}

/**
 * Builds the shader-visible environment for one vertex by running the real producer writer and
 * reading the uniform floats back at the offsets the producer itself declares. Nothing is
 * hand-copied between the two languages.
 */
function buildShaderInputs(
  producer,
  uniformData,
  cameraLayout,
  ellipsoid,
  modelMatrix3,
  sample,
) {
  uniformData.fill(0.0);
  producer.writeRTEUniformsFlat(
    uniformData,
    {
      modelMatrix3: modelMatrix3,
      camWorldHigh: sample.encodedCameraWorld.high,
      camWorldLow: sample.encodedCameraWorld.low,
    },
    { ellipsoid: ellipsoid },
  );

  // Every `camera.*` value the shader can see is read back at the offset the shader's own struct
  // declaration puts it at, never at an offset restated here. A producer that writes the right
  // numbers to the wrong floats therefore reaches the derivation as the wrong field.
  const environment = Object.create(null);
  for (const [field, byteOffset] of Object.entries(cameraLayout.offsets)) {
    const index = byteOffset / 4;
    environment[`camera.${field}`] = [
      f32(uniformData[index]),
      f32(uniformData[index + 1]),
      f32(uniformData[index + 2]),
      f32(uniformData[index + 3]),
    ];
  }

  const vertexHigh = sample.vertexHigh;
  const vertexLow = sample.vertexLow;
  const cameraHigh = sample.cameraHigh;
  const cameraLow = sample.cameraLow;
  // `translateRelativeToEye` sits outside the parsed block, so its result is supplied directly
  // from the encoded model-space pair, together with the head fields it consumes.
  environment.posRTE = [
    ...[0, 1, 2].map((i) =>
      f32(
        f32(vertexHigh[i] - cameraHigh[i]) + f32(vertexLow[i] - cameraLow[i]),
      ),
    ),
    1.0,
  ];
  environment["input.positionHigh"] = vertexHigh;
  environment["input.positionLow"] = vertexLow;
  environment["camera.encodedCameraHigh"] = cameraHigh;
  environment["camera.encodedCameraLow"] = cameraLow;
  return environment;
}

function makeSample(
  ellipsoid,
  inverseModel,
  longitude,
  latitude,
  height,
  separation,
) {
  Cartesian3.fromDegrees(longitude, latitude, height, ellipsoid, scratchWorld);
  Cartesian3.fromDegrees(
    longitude,
    latitude,
    height + separation,
    ellipsoid,
    scratchCameraWorld,
  );
  Matrix4.multiplyByPoint(inverseModel, scratchWorld, scratchModel);
  Matrix4.multiplyByPoint(inverseModel, scratchCameraWorld, scratchCameraModel);
  EncodedCartesian3.fromCartesian(scratchModel, scratchEncodedVertex);
  EncodedCartesian3.fromCartesian(scratchCameraModel, scratchEncodedCamera);
  EncodedCartesian3.fromCartesian(
    scratchCameraWorld,
    scratchEncodedCameraWorld,
  );
  return {
    reference: ellipsoid.cartesianToCartographic(scratchWorld).height,
    vertexHigh: toF32Triple(scratchEncodedVertex.high),
    vertexLow: toF32Triple(scratchEncodedVertex.low),
    cameraHigh: toF32Triple(scratchEncodedCamera.high),
    cameraLow: toF32Triple(scratchEncodedCamera.low),
    encodedCameraWorld: scratchEncodedCameraWorld,
  };
}

function latitudesFrom(step) {
  const values = [];
  for (let index = 1; ; ++index) {
    const value = Number((-90 + step * index).toFixed(6));
    if (value >= 90) {
      break;
    }
    values.push(value);
  }
  return values;
}

function bodies() {
  return [
    ["WGS84", Ellipsoid.WGS84],
    [
      "MOON",
      new Ellipsoid(
        MOON_RADII_METERS.x,
        MOON_RADII_METERS.y,
        MOON_RADII_METERS.z,
      ),
    ],
  ];
}

function modelMatrices() {
  return [
    ["IDENTITY", Matrix4.clone(Matrix4.IDENTITY, new Matrix4())],
    [
      "ENU",
      Transforms.eastNorthUpToFixedFrame(
        Cartesian3.fromDegrees(-95.0, 40.0, 200000.0),
      ),
    ],
    [
      "TRANSLATION",
      Matrix4.fromTranslation(new Cartesian3(6378137.0, 0.0, 0.0)),
    ],
    [
      "ENU_UNIFORM_SCALE",
      Matrix4.multiply(
        Transforms.eastNorthUpToFixedFrame(
          Cartesian3.fromDegrees(12.0, -60.0, 5000.0),
        ),
        Matrix4.fromScale(new Cartesian3(3.0, 3.0, 3.0), new Matrix4()),
        new Matrix4(),
      ),
    ],
  ];
}

/**
 * Sweeps one grid and returns the residual statistics the assertions read. When `shaders` holds
 * more than one parsed shader, every shader must produce the identical f32 height for every
 * sample, which is how a single-file divergence is caught numerically.
 */
function sweep(producer, shaders, options) {
  const uniformData = new Float32Array(producer.FLAT_CAMERA_BYTES / 4);
  // The flat layout is the one the flat writer above fills, and every elevation shader names its
  // appended fields identically, so one flat struct describes the environment for all six.
  const flatShader = shaders.find((shader) =>
    shader.file.endsWith("Flat.wgsl"),
  );
  const cameraLayout = (flatShader ?? shaders[0]).layout;

  let worstAbsolute = 0;
  let worstArgument = null;
  let midSum = 0;
  let midCount = 0;
  let samples = 0;
  const perModel = new Map();

  for (const [bodyName, ellipsoid] of options.bodies) {
    for (const [modelName, modelMatrix] of options.models) {
      const inverseModel = Matrix4.inverse(modelMatrix, scratchInverse);
      const modelMatrix3 = Matrix4.getMatrix3(modelMatrix, scratchMatrix3);
      const heightsByKey = new Map();
      for (const latitude of options.latitudes) {
        for (const longitude of options.longitudes) {
          for (const height of options.heights) {
            for (const separation of options.separations) {
              const sample = makeSample(
                ellipsoid,
                inverseModel,
                longitude,
                latitude,
                height,
                separation,
              );
              const inputs = buildShaderInputs(
                producer,
                uniformData,
                cameraLayout,
                ellipsoid,
                modelMatrix3,
                sample,
              );

              let derived;
              for (const shader of shaders) {
                const value = evaluateHeight(shader, inputs);
                if (derived === undefined) {
                  derived = value;
                } else if (!Object.is(value, derived)) {
                  return {
                    failure: `derivations disagree between ${shaders[0].file} and ${shader.file}: ${derived} vs ${value}`,
                  };
                }
              }
              if (!Number.isFinite(derived)) {
                return {
                  failure: `non-finite height at ${bodyName}/${modelName} lat ${latitude} lon ${longitude} height ${height}`,
                };
              }

              samples += 1;
              const error = derived - sample.reference;
              if (Math.abs(error) > worstAbsolute) {
                worstAbsolute = Math.abs(error);
                worstArgument = {
                  body: bodyName,
                  model: modelName,
                  latitude: latitude,
                  longitude: longitude,
                  height: height,
                  separation: separation,
                };
              }
              const absoluteLatitude = Math.abs(latitude);
              if (
                absoluteLatitude >= MID_LATITUDE_BAND_DEGREES[0] &&
                absoluteLatitude <= MID_LATITUDE_BAND_DEGREES[1]
              ) {
                midSum += error;
                midCount += 1;
              }
              if (options.collectPerModel === true) {
                heightsByKey.set(
                  `${latitude}|${longitude}|${height}|${separation}`,
                  derived,
                );
              }
            }
          }
        }
      }
      if (options.collectPerModel === true) {
        perModel.set(`${bodyName}/${modelName}`, heightsByKey);
      }
    }
  }

  return {
    failure: null,
    samples: samples,
    worstAbsolute: worstAbsolute,
    worstArgument: worstArgument,
    midCount: midCount,
    midMean: midCount === 0 ? Number.NaN : midSum / midCount,
    perModel: perModel,
  };
}

function envelopeOptions() {
  return {
    bodies: bodies(),
    models: [modelMatrices()[0]],
    latitudes: latitudesFrom(ENVELOPE_LATITUDE_STEP_DEGREES),
    longitudes: ENVELOPE_LONGITUDES_DEGREES,
    heights: ENVELOPE_HEIGHTS_METERS,
    separations: ENVELOPE_CAMERA_SEPARATIONS_METERS,
  };
}

// The screening grid is the one every mutation leg runs on: coarse in latitude but wide across
// bodies and model matrices, because that is the axis most mutants need in order to show.
function screeningOptions() {
  return {
    bodies: bodies(),
    models: modelMatrices(),
    latitudes: latitudesFrom(6),
    longitudes: [-150, -60, 0, 71.3, 150],
    heights: [-1000, 25, 9000, 500000],
    separations: [1000, 250000],
  };
}

// =============================================================================
// Mutation staging
// =============================================================================

const STAGED_FILES = [PRODUCER_FILE, ...SHADER_FILES];

function stageSources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "elev-mutation-"));
  for (const relative of STAGED_FILES) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relative), destination);
  }
  return root;
}

function rewrite(root, relative, pattern, replacement) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before) {
    throw new Error(`mutation anchor not found in ${relative}`);
  }
  fs.writeFileSync(file, after);
}

function rewriteEveryShader(root, transform) {
  for (const relative of SHADER_FILES) {
    const file = path.join(root, relative);
    const before = fs.readFileSync(file, "utf8");
    const after = transform(before, relative);
    if (after === before) {
      throw new Error(`mutation anchor not found in ${relative}`);
    }
    fs.writeFileSync(file, after);
  }
}

const MUTATIONS = [
  {
    name: "producer swaps the ellipsoid X and Z inverse radii",
    apply: (root) =>
      rewrite(
        root,
        PRODUCER_FILE,
        /ud\[offset \+ 0\] = supplied \? oneOverRadii\.x/,
        "ud[offset + 0] = supplied ? oneOverRadii.z",
      ),
  },
  {
    name: "producer publishes oneOverRadiiSquared",
    apply: (root) =>
      rewrite(
        root,
        PRODUCER_FILE,
        /\? ellipsoid\.oneOverRadii\b/,
        "? ellipsoid.oneOverRadiiSquared",
      ),
  },
  {
    name: "producer makes the supplied predicate inert, forcing the shader onto its WGS84 fallback",
    apply: (root) =>
      rewrite(
        root,
        PRODUCER_FILE,
        /const supplied =\s*\r?\n\s*defined\(oneOverRadii\)/,
        "const supplied =\r\n    false && defined(oneOverRadii)",
      ),
  },
  {
    name: "producer zeroes the first component of every model column",
    apply: (root) =>
      rewrite(
        root,
        PRODUCER_FILE,
        /ud\[destinationOffset \+ 0\] = matrix\[sourceOffset \+ 0\];/,
        "ud[destinationOffset + 0] = 0.0;",
      ),
  },
  {
    name: "producer packs the model columns row-major",
    apply: (root) =>
      rewrite(
        root,
        PRODUCER_FILE,
        /const sourceOffset = column \* 3;/,
        "const sourceOffset = column;",
      ),
  },
  {
    name: "shaders revert to the bare high-plus-low sum behind a decoy comment",
    apply: (root) =>
      rewriteEveryShader(root, (source) => {
        const block = source.match(
          / {4}let modelMatrix3[\s\S]*?output\.height = select\(0\.0, derivedHeight, heightIsFinite\);/,
        );
        if (block === null) {
          throw new Error("decoy anchor not found");
        }
        return source.replace(
          block[0],
          `    /* ${block[0]} */\r\n` +
            "    let worldPos = input.positionLow + input.positionHigh;\r\n" +
            "    output.height = length(worldPos) - 6371000.0;",
        );
      }),
  },
  {
    name: "shaders drop the model rotation from the world reconstruction",
    apply: (root) =>
      rewriteEveryShader(root, (source) =>
        source.replaceAll("modelMatrix3 * posRTE.xyz", "posRTE.xyz"),
      ),
  },
  {
    name: "one shader diverges onto the hardcoded WGS84 fallback",
    apply: (root) =>
      rewrite(
        root,
        SHADER_FILES[0],
        /camera\.ellipsoidOneOverRadii\.xyz/,
        "WGS84_ONE_OVER_RADII",
      ),
  },
  {
    name: "shaders swizzle the encoded world camera high word",
    apply: (root) =>
      rewriteEveryShader(root, (source) =>
        source.replaceAll(
          "camera.encodedCameraWorldHigh.xyz",
          "camera.encodedCameraWorldHigh.zyx",
        ),
      ),
  },
];

// =============================================================================
// Tests
// =============================================================================

const producer = await loadProducer(REPO_ROOT);
const shaders = SHADER_FILES.map((file) => parseShader(REPO_ROOT, file));

test("the six elevation shaders derive one identical height for every sampled vertex", () => {
  const result = sweep(producer, shaders, screeningOptions());
  assert.equal(result.failure, null);
  assert.ok(
    result.samples > 5000,
    `screening grid was too small: ${result.samples}`,
  );
});

test("the WGSL camera structs place the appended fields where the producer says they are", () => {
  for (const file of FLAT_SHADERS) {
    const layout = computeStructLayout(REPO_ROOT, file, "CameraUniforms");
    assert.equal(
      layout.size,
      producer.FLAT_CAMERA_BYTES,
      `flat size in ${file}`,
    );
    assert.equal(
      layout.offsets.ellipsoidOneOverRadii / 4,
      producer.FLAT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
    );
    assert.equal(
      layout.offsets.modelMatrixColumn0 / 4,
      producer.FLAT_MODEL_MATRIX_COLUMN_0_OFFSET,
    );
    assert.equal(
      layout.offsets.modelMatrixColumn1 / 4,
      producer.FLAT_MODEL_MATRIX_COLUMN_0_OFFSET + 4,
    );
    assert.equal(
      layout.offsets.modelMatrixColumn2 / 4,
      producer.FLAT_MODEL_MATRIX_COLUMN_0_OFFSET + 8,
    );
    assert.equal(
      layout.offsets.encodedCameraWorldHigh / 4,
      producer.FLAT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
    );
    assert.equal(
      layout.offsets.encodedCameraWorldLow / 4,
      producer.FLAT_ENCODED_CAMERA_WORLD_LOW_OFFSET,
    );
  }

  for (const file of LIT_SHADERS) {
    const layout = computeStructLayout(REPO_ROOT, file, "CameraUniforms");
    assert.equal(layout.size, producer.LIT_CAMERA_BYTES, `lit size in ${file}`);
    assert.equal(layout.offsets.logDepth / 4, producer.LIT_LOG_DEPTH_OFFSET);
    assert.equal(
      layout.offsets.ellipsoidOneOverRadii / 4,
      producer.LIT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
    );
    assert.equal(
      layout.offsets.modelMatrixColumn0 / 4,
      producer.LIT_MODEL_MATRIX_COLUMN_0_OFFSET,
    );
    assert.equal(
      layout.offsets.encodedCameraWorldHigh / 4,
      producer.LIT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
    );
    assert.equal(
      layout.offsets.encodedCameraWorldLow / 4,
      producer.LIT_ENCODED_CAMERA_WORLD_LOW_OFFSET,
    );
  }

  // Pick shaders bind only the shared head, so the head has to end exactly where the appended
  // elevation tail begins; anything else means a pick draw reads uninitialized uniform bytes.
  assert.equal(
    producer.PICK_CAMERA_BYTES,
    producer.FLAT_ELLIPSOID_ONE_OVER_RADII_OFFSET * 4,
  );
});

test("the flat writer appends the tail after the shared head without disturbing or overrunning it", () => {
  const floats = producer.FLAT_CAMERA_BYTES / 4;
  const data = new Float32Array(floats + 12);
  const modelMatrix3 = Matrix3.fromRowMajorArray(
    [2.0, 3.0, 5.0, 7.0, 11.0, 13.0, 17.0, 19.0, 23.0],
    new Matrix3(),
  );
  producer.takeHeadCalls();
  producer.writeRTEUniformsFlat(
    data,
    {
      modelMatrix3: modelMatrix3,
      camWorldHigh: new Cartesian3(65536.0, -131072.0, 196608.0),
      camWorldLow: new Cartesian3(1.25, -2.5, 3.75),
    },
    { ellipsoid: { oneOverRadii: new Cartesian3(0.125, 0.25, 0.5) } },
  );

  assert.equal(producer.takeHeadCalls().length, 1);
  for (let index = 0; index < producer.PICK_CAMERA_BYTES / 4; ++index) {
    assert.equal(
      data[index],
      HEAD_SENTINEL,
      `tail overwrote head float ${index}`,
    );
  }
  assert.deepEqual(
    Array.from(
      data.subarray(
        producer.FLAT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
        producer.FLAT_MODEL_MATRIX_COLUMN_0_OFFSET,
      ),
    ),
    [0.125, 0.25, 0.5, 1.0],
  );
  // Column-major: each 16-byte uniform slot carries one matrix column, so the first three floats
  // are the transform's first column and not its first row.
  assert.deepEqual(
    Array.from(
      data.subarray(
        producer.FLAT_MODEL_MATRIX_COLUMN_0_OFFSET,
        producer.FLAT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
      ),
    ),
    [2.0, 7.0, 17.0, 0.0, 3.0, 11.0, 19.0, 0.0, 5.0, 13.0, 23.0, 0.0],
  );
  assert.deepEqual(
    Array.from(
      data.subarray(producer.FLAT_ENCODED_CAMERA_WORLD_HIGH_OFFSET, floats),
    ),
    [65536.0, -131072.0, 196608.0, 0.0, 1.25, -2.5, 3.75, 0.0],
  );
  for (let index = floats; index < data.length; ++index) {
    assert.equal(
      data[index],
      0,
      `writer ran past the declared layout at float ${index}`,
    );
  }
});

test("an ellipsoid the producer cannot trust is published as a fallback request, not as a degenerate body", () => {
  const data = new Float32Array(producer.FLAT_CAMERA_BYTES / 4);
  const offset = producer.FLAT_ELLIPSOID_ONE_OVER_RADII_OFFSET;
  for (const uniformState of [
    undefined,
    {},
    { ellipsoid: {} },
    { ellipsoid: { oneOverRadii: new Cartesian3(0.0, 1.0, 1.0) } },
    { ellipsoid: { oneOverRadii: new Cartesian3(Number.NaN, 1.0, 1.0) } },
    { ellipsoid: { oneOverRadii: new Cartesian3(-1.0, 1.0, 1.0) } },
  ]) {
    data.fill(0.0);
    producer.writeEllipsoidOneOverRadiiTail(data, offset, uniformState);
    assert.deepEqual(
      Array.from(data.subarray(offset, offset + 4)),
      [0, 0, 0, 0],
    );
  }

  data.fill(0.0);
  producer.writeEllipsoidOneOverRadiiTail(data, offset, {
    ellipsoid: Ellipsoid.WGS84,
  });
  assert.equal(data[offset + 3], 1.0);
  assert.ok(data[offset] > 0.0 && data[offset + 2] > 0.0);
});

test("the flat writer refuses a destination that cannot hold the declared layout", () => {
  assert.throws(() =>
    producer.writeRTEUniformsFlat(
      new Float32Array(producer.PICK_CAMERA_BYTES / 4),
      {
        modelMatrix3: Matrix4.getMatrix3(Matrix4.IDENTITY, new Matrix3()),
        camWorldHigh: Cartesian3.ZERO,
        camWorldLow: Cartesian3.ZERO,
      },
      { ellipsoid: Ellipsoid.WGS84 },
    ),
  );
});

test("the derived height holds the declared envelope on WGS84 and on a triaxial non-Earth body", () => {
  const result = sweep(producer, [shaders[0]], envelopeOptions());
  assert.equal(result.failure, null);
  assert.ok(
    result.samples >= 180000,
    `envelope grid was too small: ${result.samples}`,
  );
  assert.ok(
    result.worstAbsolute < ENVELOPE_BOUND_METERS,
    `worst residual ${result.worstAbsolute.toFixed(4)} m at ${JSON.stringify(
      result.worstArgument,
    )}`,
  );
  assert.ok(result.midCount > 0, "the mid-latitude band collected no samples");
  assert.ok(
    Math.abs(result.midMean) < MID_LATITUDE_MEAN_BOUND_METERS,
    `mid-latitude signed mean ${result.midMean.toFixed(4)} m`,
  );
  console.log(
    `envelope: ${result.samples} samples, worst ${result.worstAbsolute.toFixed(
      4,
    )} m, mid-latitude signed mean ${result.midMean.toFixed(4)} m`,
  );
});

test("the derivation is invariant to the model matrix within the f32 noise floor", () => {
  const result = sweep(producer, [shaders[0]], {
    bodies: bodies(),
    models: modelMatrices(),
    latitudes: latitudesFrom(3),
    longitudes: [-150, -60, 0, 71.3, 150],
    heights: [-1000, 25, 9000, 500000],
    separations: INVARIANCE_SEPARATIONS_METERS,
    collectPerModel: true,
  });
  assert.equal(result.failure, null);

  for (const [bodyName] of bodies()) {
    const reference = result.perModel.get(`${bodyName}/IDENTITY`);
    assert.ok(reference !== undefined, `${bodyName} identity leg is missing`);
    for (const [key, heights] of result.perModel) {
      if (!key.startsWith(`${bodyName}/`)) {
        continue;
      }
      let worst = 0;
      for (const [sampleKey, value] of heights) {
        worst = Math.max(worst, Math.abs(value - reference.get(sampleKey)));
      }
      assert.ok(
        worst <= INVARIANCE_TOLERANCE_METERS,
        `${key} deviates from identity by ${worst.toFixed(4)} m`,
      );
    }
  }
});

test("every mutation of the producer or the shaders is caught by evaluation", async () => {
  const baseline = sweep(producer, shaders, screeningOptions());
  assert.equal(baseline.failure, null);

  const survivors = [];
  for (const mutation of MUTATIONS) {
    const root = stageSources();
    let killed = false;
    let detail;
    try {
      mutation.apply(root);
      const mutantProducer = await loadProducer(root);
      const mutantShaders = SHADER_FILES.map((file) => parseShader(root, file));
      const result = sweep(mutantProducer, mutantShaders, screeningOptions());
      if (result.failure !== null) {
        killed = true;
        detail = result.failure;
      } else if (
        Math.abs(result.worstAbsolute - baseline.worstAbsolute) > 0.01 ||
        Math.abs(result.midMean - baseline.midMean) > 0.01
      ) {
        killed = true;
        detail = `worst ${result.worstAbsolute.toFixed(
          3,
        )} m, mid-latitude mean ${result.midMean.toFixed(3)} m`;
      } else {
        detail = `worst ${result.worstAbsolute.toFixed(4)} m (unmoved)`;
      }
    } catch (error) {
      killed = true;
      detail = `evaluation failed: ${error.message}`;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    console.log(
      `${killed ? "KILLED  " : "SURVIVED"}  ${mutation.name}  --  ${detail}`,
    );
    if (!killed) {
      survivors.push(mutation.name);
    }
  }

  assert.deepEqual(
    survivors,
    [],
    "a surviving mutant means this gate is not load-bearing",
  );
});
