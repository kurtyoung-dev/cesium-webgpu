// eye-cartographic-uniforms.spec.mjs — the eye cartographic frame must reach
// WGSL through a live packer, with WGSL's mat3x3 padding law honoured and
// `previousViewProjection` left where it was.
// @purpose Executes the real globe camera-UB tail packer against a real UniformState, derives the WGSL CameraUniforms layout from the shader source, and evaluates upstream's czm_eyeToCartographicDelta GLSL and its three WGSL copies over an altitude sweep in float32 to prove they are the same arithmetic.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no device.
//
// WHY THIS EXISTS
// ---------------
// CesiumJS 1.145 added `czm_eyeCartographic`, `czm_eyeToEnu` and
// `czm_eyeToCartographicDelta`, and the WebGPU fork had none of them. The
// obvious place to add them — `Renderer/WebGPU/WebGPUAutoUniforms.js`, which
// already carries `csm_eyeHeight` — has ZERO importers anywhere in the repo,
// so an entry there writes no bytes into any buffer. This lane therefore put
// the three values on the globe camera UB, which is packed unconditionally,
// per tile, per frame, and read them from `GlobeTerrain.wgsl`.
//
// Two failure modes are silent and this file exists to make them loud:
//
//   - WGSL lays `mat3x3<f32>` out as THREE vec4 columns (twelve floats, a
//     padding lane after every third), where GLSL's `mat3` is nine tight
//     floats. A tight nine-float pack lands column 1 inside column 0's
//     padding lane. Nothing validates it; the shader simply reads a rotation
//     that is not a rotation.
//   - `previousViewProjection` feeds TAA, CSM and motion vectors. The packer
//     writes it positionally and the shader reads it by name, and nothing
//     else connects those two facts.
//
// WHAT IS ACTUALLY CHECKED
// ------------------------
//   - THE INVARIANT, RE-DERIVED. `UniformState.eyeCartographic.z` is the
//     SAME NUMBER as `.eyeHeight`, bit for bit, over a sweep of heights and
//     latitudes — but only on the branch where the camera HAS a cartographic
//     position. On the other branch `_eyeHeight` becomes `-maximumRadius`
//     while `_eyeCartographic` keeps the previous frame's value. The packer
//     must ship a zeroed frame there rather than a stale one.
//   - THE PACKER IS EXECUTED. `writeEyeCartographicTail`'s real body is
//     lifted out of the TypeScript and run against a real `UniformState`
//     built from the real `Transforms` / `Ellipsoid` / `Matrix3`. The
//     rotation is read back through the WGSL layout and required to be
//     orthonormal with determinant 1.
//   - THE STRUCT AND THE PACKER AGREE. The `CameraUniforms` layout is derived
//     from the shader source under the uniform-address-space rules, and the
//     tail's float offsets are required to be the ones the packer's cursor
//     reaches.
//   - THE ARITHMETIC IS THE SAME ARITHMETIC. Both the GLSL builtin and its
//     three WGSL copies are PARSED and EVALUATED over a sweep of altitudes,
//     including a grazing near-horizon case, in float32. A literal in place
//     of a uniform, a reordered term or a dropped factor is a number here,
//     not a spelling.
//   - MUTANTS. The tight-pack mutant, the `previousViewProjection` relocation
//     and the unreachable-call mutant each have to turn one of the above red.
//
// WHAT IS NOT CHECKED HERE
// ------------------------
// No pixel and no GPU. Whether a real driver's `mat3x3` load matches this
// layout is a device fact; `probe-eye-cartographic-frame.mjs` is the leg that
// answers it. The evaluator applies `Math.fround` after every operation,
// which is faithful to WGSL's f32 but not to a driver that contracts a
// multiply-add; the GLSL-vs-WGSL comparison is exact because both sides run
// through the same evaluator, and the f32-vs-f64 figure is reported as the
// noise floor rather than asserted bit-for-bit.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ENGINE_SOURCE = path.join(REPO_ROOT, "packages", "engine", "Source");

const CAMERA_UB_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts";
const TYPES_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceTypes.ts";
const TERRAIN_FILE =
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl";
const CHUNK_FILE =
  "packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_eyeToCartographicDelta.wgsl";
const BUILTINS_FILE = "packages/engine/Source/Renderer/WebGPU/WGSLBuiltins.ts";
const GLSL_FILE =
  "packages/engine/Source/Shaders/Builtin/Functions/eyeToCartographicDelta.glsl";
const DEBUG_REGISTRY_FILE =
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeFragmentDebug.ts";

const read = (relative) =>
  fs
    .readFileSync(path.join(REPO_ROOT, relative), "utf8")
    .replace(/\r\n/g, "\n");

const stripLineComments = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

const stripBlockComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");

// =============================================================================
// Real engine modules. `UniformState` reaches TypeScript that Node's strip-only
// mode cannot load on its own; the resolver hook is what makes the .ts siblings
// resolvable, and it must be installed before the first import.
// =============================================================================

enableEngineTsResolution();

const load = async (relative) =>
  await import(pathToFileURL(path.join(ENGINE_SOURCE, relative)).href);

const { default: Cartesian3 } = await load("Core/Cartesian3.js");
const { default: Cartographic } = await load("Core/Cartographic.js");
const { default: Ellipsoid } = await load("Core/Ellipsoid.js");
const { default: Matrix3 } = await load("Core/Matrix3.js");
const { default: Matrix4 } = await load("Core/Matrix4.js");
const { default: Transforms } = await load("Core/Transforms.js");
const { default: UniformState } = await load("Renderer/UniformState.js");
const UniformStateComputations = await load(
  "Renderer/UniformStateComputations.js",
);

const ellipsoid = Ellipsoid.WGS84;

/**
 * A real `UniformState` with its camera state set through the real
 * `setCamera`, so `eyeCartographic` / `eyeToEnu` / `eyeEllipsoidCurvature`
 * are produced by the engine rather than by this file.
 */
function uniformStateAt(longitude, latitude, height) {
  const state = new UniformState();
  state._ellipsoid = ellipsoid;
  const positionWC = Cartesian3.fromRadians(
    longitude,
    latitude,
    height,
    ellipsoid,
  );
  const inverseView = Transforms.eastNorthUpToFixedFrame(positionWC, ellipsoid);
  const view = Matrix4.inverseTransformation(inverseView, new Matrix4());
  UniformStateComputations.setView(state, view);
  UniformStateComputations.setInverseView(state, inverseView);
  UniformStateComputations.setCamera(state, {
    positionWC,
    directionWC: Cartesian3.negate(
      Cartesian3.normalize(positionWC, new Cartesian3()),
      new Cartesian3(),
    ),
    rightWC: Cartesian3.UNIT_X,
    upWC: Cartesian3.UNIT_Z,
    positionCartographic: Cartographic.fromRadians(longitude, latitude, height),
  });
  return state;
}

// Heights and latitudes a real camera reaches: ground, aircraft, orbit, and
// both poles, plus a below-ellipsoid case.
const HEIGHTS = [0, 1, 250, 1e3, 1e4, 1e5, 1e6, 1e7, -400];
const LATITUDES = [0, 0.4, 1.0, 1.4, 1.5533, -1.2, -1.5533];
const LONGITUDES = [0, 0.7, 1.2, -2.9, 3.1];

// =============================================================================
// Lifting the real packer out of the TypeScript.
//
// The camera-UB module's import graph reaches a TypeScript enum, which Node's
// strip-only mode refuses, so the function is executed rather than imported —
// the same device `globe-contour-pixel-ratio-parity.spec.mjs` uses on the same
// file. The body is plain JavaScript; only the signature carries annotations,
// and the signature is replaced rather than parsed.
// =============================================================================

function functionBody(source, declaration) {
  const text = stripLineComments(stripBlockComments(source));
  const start = text.indexOf(declaration);
  assert.notEqual(start, -1, `no ${declaration} in ${CAMERA_UB_FILE}`);
  const open = text.indexOf("{", text.indexOf(")", start));
  assert.ok(open > start, `${declaration} has no body`);
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "{") {
      depth++;
    } else if (text[index] === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(open + 1, index);
      }
    }
  }
  throw new Error(`unbalanced body for ${declaration}`);
}

function constantFrom(source, name, file) {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  assert.ok(match, `no ${name} in ${file}`);
  return Number.parseInt(match[1], 10);
}

const cameraUbSource = read(CAMERA_UB_FILE);
const typesSource = read(TYPES_FILE);
const terrainSource = read(TERRAIN_FILE);

const CAMERA_UNIFORM_FLOATS = constantFrom(
  typesSource,
  "CAMERA_UNIFORM_FLOATS",
  TYPES_FILE,
);
const EYE_CARTOGRAPHIC_FLOATS = constantFrom(
  cameraUbSource,
  "EYE_CARTOGRAPHIC_FLOATS",
  CAMERA_UB_FILE,
);
const TAIL_DECLARATION = "export function writeEyeCartographicTail(";

/**
 * Compiles the real `writeEyeCartographicTail` body, optionally with one
 * textual mutation applied first, and returns it as a callable.
 */
function liftTailPacker(mutation) {
  let body = functionBody(cameraUbSource, TAIL_DECLARATION);
  if (mutation !== undefined) {
    assert.ok(
      body.includes(mutation.from),
      `the mutation target is not in the packer: ${mutation.from}`,
    );
    body = body.replace(mutation.from, mutation.to);
  }
  // eslint-disable-next-line no-new-func
  return new Function(
    "data",
    "offset",
    "uniformState",
    "EYE_CARTOGRAPHIC_FLOATS",
    "m4Values",
    body,
  );
}

const identity = (value) => value;

function packTail(state, mutation) {
  const data = new Float32Array(CAMERA_UNIFORM_FLOATS);
  const base = CAMERA_UNIFORM_FLOATS - EYE_CARTOGRAPHIC_FLOATS;
  liftTailPacker(mutation)(
    data,
    base,
    state,
    EYE_CARTOGRAPHIC_FLOATS,
    identity,
  );
  return { data, base };
}

/**
 * Reads the rotation back the way the WGSL `mat3x3<f32>` load does: three vec4
 * columns, the fourth lane of each skipped.
 */
function readEnuThroughWgslLayout(data, base) {
  const column = (index) => [
    data[base + 4 + index * 4],
    data[base + 5 + index * 4],
    data[base + 6 + index * 4],
  ];
  return [column(0), column(1), column(2)];
}

function orthonormalityResidual(columns) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.max(
    Math.abs(dot(columns[0], columns[0]) - 1),
    Math.abs(dot(columns[1], columns[1]) - 1),
    Math.abs(dot(columns[2], columns[2]) - 1),
    Math.abs(dot(columns[0], columns[1])),
    Math.abs(dot(columns[0], columns[2])),
    Math.abs(dot(columns[1], columns[2])),
  );
}

function determinantOf(columns) {
  const [a, b, c] = columns;
  return (
    a[0] * (b[1] * c[2] - b[2] * c[1]) -
    b[0] * (a[1] * c[2] - a[2] * c[1]) +
    c[0] * (a[1] * b[2] - a[2] * b[1])
  );
}

// A rotation packed as f32 leaves at most a few ulp of 1.0 on each dot
// product. Re-derived here rather than assumed: the worst residual this sweep
// produces is reported by the test below, and 1e-6 sits four orders of
// magnitude above it while remaining four orders BELOW the O(1) error a
// mis-packed matrix produces. The f64 side is tighter still — 1e-15, about
// four ulp of 1.0, which brackets both this file's own measurement (4.4e-16)
// and the 8.9e-16 the census carried.
const F32_ROTATION_TOLERANCE = 1e-6;
const F64_ROTATION_TOLERANCE = 1e-15;

// =============================================================================
// WGSL uniform-address-space layout, derived rather than assumed.
// =============================================================================

const WGSL_TYPES = new Map([
  ["f32", { size: 4, align: 4 }],
  ["u32", { size: 4, align: 4 }],
  ["i32", { size: 4, align: 4 }],
  ["vec2<f32>", { size: 8, align: 8 }],
  ["vec3<f32>", { size: 12, align: 16 }],
  ["vec4<f32>", { size: 16, align: 16 }],
  ["mat3x3<f32>", { size: 48, align: 16 }],
  ["mat4x4<f32>", { size: 64, align: 16 }],
]);

function structFields(source, name) {
  const match = stripLineComments(source).match(
    new RegExp(`struct\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  assert.ok(match, `no struct ${name}`);
  return match[1]
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(":").map((part) => part.trim());
      assert.equal(parts.length, 2, `unparsable struct member: ${line}`);
      return { name: parts[0], type: parts[1] };
    });
}

function layout(fields) {
  let offset = 0;
  const placed = [];
  for (const field of fields) {
    const shape = WGSL_TYPES.get(field.type);
    assert.ok(shape, `unhandled WGSL type ${field.type}`);
    offset = Math.ceil(offset / shape.align) * shape.align;
    placed.push({ ...field, offset, size: shape.size, align: shape.align });
    offset += shape.size;
  }
  const structAlign = Math.max(...placed.map((entry) => entry.align));
  return { placed, size: Math.ceil(offset / structAlign) * structAlign };
}

function cameraLayout(source = terrainSource) {
  const { placed, size } = layout(structFields(source, "CameraUniforms"));
  const byName = new Map(placed.map((entry) => [entry.name, entry]));
  return { placed, size, byName };
}

// =============================================================================
// A small evaluator for the delta builtin, so the GLSL and its WGSL copies are
// EXECUTED rather than compared as text.
// =============================================================================

const BUILTIN_ARITY = new Map([
  ["cos", 1],
  ["sin", 1],
  ["atan", 2],
  ["length", 1],
  ["vec2", 2],
  ["vec3", 3],
]);

function tokenize(text) {
  const tokens = [];
  const pattern =
    /\s*([A-Za-z_][A-Za-z0-9_]*|[0-9]+\.[0-9]*(?:e-?[0-9]+)?|[0-9]+(?:e-?[0-9]+)?|[-+*/(),;.]|=)/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    tokens.push(match[1]);
  }
  return tokens;
}

/**
 * Parses a `czm_eyeToCartographicDelta` / `csm_eyeToCartographicDelta` body
 * into a statement list plus a return expression.
 *
 * Only the spelling differences between the two languages are normalized —
 * `vec3<f32>(` to `vec3(`, WGSL's `atan2` to GLSL's two-argument `atan`,
 * the declaration keyword, and the uniform names the GLSL reads globally and
 * the WGSL takes as parameters. Nothing that could change a number is touched.
 */
function parseDeltaBody(rawBody) {
  const normalized = stripLineComments(stripBlockComments(rawBody))
    .replace(/vec([234])<f32>/g, "vec$1")
    .replace(/\batan2\b/g, "atan")
    .replace(/\bczm_eyeToEnu\b/g, "eyeToEnu")
    .replace(/\bczm_eyeCartographic\b/g, "eyeCartographic")
    .replace(/\bczm_eyeEllipsoidCurvature\b/g, "eyeEllipsoidCurvature")
    // Declaration keywords: GLSL names the type, WGSL says `let` with an
    // optional annotation.
    .replace(/^\s*(?:vec[234]|float)\s+/gm, "DECL ")
    .replace(/^\s*let\s+/gm, "DECL ")
    .replace(/^(DECL\s+[A-Za-z0-9_]+)\s*:\s*[A-Za-z0-9_<>]+\s*=/gm, "$1 =");

  const statements = [];
  let returnExpression;
  for (const rawStatement of normalized.split(";")) {
    const statement = rawStatement.trim();
    if (statement.length === 0) {
      continue;
    }
    if (statement.startsWith("return")) {
      returnExpression = parseExpression(
        tokenize(statement.slice("return".length)),
      );
      continue;
    }
    const declaration = /^DECL\s+([A-Za-z0-9_]+)\s*=([\s\S]*)$/.exec(statement);
    assert.ok(declaration, `unparsable statement: ${statement}`);
    statements.push({
      name: declaration[1],
      expression: parseExpression(tokenize(declaration[2])),
    });
  }
  assert.ok(returnExpression, "the delta body must return");
  return { statements, returnExpression };
}

function parseExpression(tokens) {
  let index = 0;
  const peek = () => tokens[index];
  const take = (expected) => {
    const token = tokens[index++];
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected ${expected}, found ${String(token)}`);
    }
    return token;
  };

  function primary() {
    const token = take();
    if (token === "(") {
      const inner = additive();
      take(")");
      return postfix(inner);
    }
    if (token === "-") {
      return { kind: "negate", value: primary() };
    }
    if (/^[0-9]/.test(token)) {
      return postfix({ kind: "literal", value: Number.parseFloat(token) });
    }
    if (peek() === "(") {
      take("(");
      const args = [];
      if (peek() !== ")") {
        args.push(additive());
        while (peek() === ",") {
          take(",");
          args.push(additive());
        }
      }
      take(")");
      const arity = BUILTIN_ARITY.get(token);
      assert.ok(arity !== undefined, `unknown builtin ${token}`);
      assert.equal(args.length, arity, `${token} takes ${arity} arguments`);
      return postfix({ kind: "call", name: token, args });
    }
    return postfix({ kind: "name", name: token });
  }

  function postfix(node) {
    let result = node;
    while (peek() === ".") {
      take(".");
      result = { kind: "swizzle", value: result, components: take() };
    }
    return result;
  }

  function multiplicative() {
    let node = primary();
    while (peek() === "*" || peek() === "/") {
      const operator = take();
      node = { kind: operator, left: node, right: primary() };
    }
    return node;
  }

  function additive() {
    let node = multiplicative();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      node = { kind: operator, left: node, right: multiplicative() };
    }
    return node;
  }

  const tree = additive();
  assert.equal(
    index,
    tokens.length,
    `unconsumed tokens: ${tokens.slice(index)}`,
  );
  return tree;
}

const isVector = (value) => Array.isArray(value);

function evaluateNode(node, environment, round) {
  const r = round;
  switch (node.kind) {
    case "literal":
      return r(node.value);
    case "name": {
      const value = environment[node.name];
      assert.ok(value !== undefined, `no binding for ${node.name}`);
      return value;
    }
    case "negate": {
      const value = evaluateNode(node.value, environment, r);
      return isVector(value) ? value.map((c) => r(-c)) : r(-value);
    }
    case "swizzle": {
      const value = evaluateNode(node.value, environment, r);
      const index = { x: 0, y: 1, z: 2, w: 3 };
      if (node.components.length === 1) {
        return value[index[node.components]];
      }
      return [...node.components].map((component) => value[index[component]]);
    }
    case "call": {
      const args = node.args.map((argument) =>
        evaluateNode(argument, environment, r),
      );
      switch (node.name) {
        case "cos":
          return r(Math.cos(args[0]));
        case "sin":
          return r(Math.sin(args[0]));
        case "atan":
          return r(Math.atan2(args[0], args[1]));
        case "length": {
          let sum = 0;
          for (const component of args[0]) {
            sum = r(sum + r(component * component));
          }
          return r(Math.sqrt(sum));
        }
        case "vec2":
        case "vec3":
          return args.map((component) => r(component));
        default:
          throw new Error(`unhandled builtin ${node.name}`);
      }
    }
    case "*":
    case "/":
    case "+":
    case "-": {
      const left = evaluateNode(node.left, environment, r);
      const right = evaluateNode(node.right, environment, r);
      const apply = (a, b) => {
        switch (node.kind) {
          case "*":
            return r(a * b);
          case "/":
            return r(a / b);
          case "+":
            return r(a + b);
          default:
            return r(a - b);
        }
      };
      // The one non-elementwise product in either source: the ENU rotation
      // times the eye-space position. Column-major, evaluated in the order a
      // shader's `m * v` is defined to evaluate it.
      if (left && left.matrix !== undefined) {
        assert.equal(node.kind, "*", "a matrix only multiplies here");
        const m = left.matrix;
        return [0, 1, 2].map((row) =>
          r(
            r(r(m[row] * right[0]) + r(m[3 + row] * right[1])) +
              r(m[6 + row] * right[2]),
          ),
        );
      }
      if (isVector(left) && isVector(right)) {
        return left.map((component, i) => apply(component, right[i]));
      }
      if (isVector(left)) {
        return left.map((component) => apply(component, right));
      }
      if (isVector(right)) {
        return right.map((component) => apply(left, component));
      }
      return apply(left, right);
    }
    default:
      throw new Error(`unhandled node ${node.kind}`);
  }
}

function evaluateDelta(parsed, inputs, round) {
  const environment = { ...inputs };
  for (const statement of parsed.statements) {
    environment[statement.name] = evaluateNode(
      statement.expression,
      environment,
      round,
    );
  }
  return evaluateNode(parsed.returnExpression, environment, round);
}

// --- The three WGSL copies and the GLSL original -----------------------------

function wgslDeltaBody(source, label) {
  const start = source.indexOf("fn csm_eyeToCartographicDelta(");
  assert.notEqual(start, -1, `no csm_eyeToCartographicDelta in ${label}`);
  const open = source.indexOf("{", source.indexOf("-> vec3<f32>", start));
  assert.ok(open > start, `${label}'s delta has no body`);
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
  throw new Error(`unbalanced delta body in ${label}`);
}

function glslDeltaBody(source) {
  const start = source.indexOf(
    "vec3 czm_eyeToCartographicDelta(vec3 positionEC)",
  );
  assert.notEqual(start, -1, "no czm_eyeToCartographicDelta in the GLSL");
  const open = source.indexOf("{", start);
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
  throw new Error("unbalanced GLSL delta body");
}

const glslDelta = parseDeltaBody(glslDeltaBody(read(GLSL_FILE)));
const chunkDelta = parseDeltaBody(wgslDeltaBody(read(CHUNK_FILE), CHUNK_FILE));
const terrainDelta = parseDeltaBody(wgslDeltaBody(terrainSource, TERRAIN_FILE));
const builtinsDelta = parseDeltaBody(
  wgslDeltaBody(read(BUILTINS_FILE), BUILTINS_FILE),
);

/**
 * Inputs for one evaluation: a camera frame from the real `UniformState` and a
 * point expressed as an offset in the camera's own ENU frame, mapped back into
 * eye coordinates through the rotation's transpose (it is orthonormal, so the
 * transpose is the inverse).
 */
function deltaInputs(state, enuOffset, round) {
  const m = state.eyeToEnu;
  const positionEC = [0, 1, 2].map((row) =>
    round(
      m[row * 3] * enuOffset[0] +
        m[row * 3 + 1] * enuOffset[1] +
        m[row * 3 + 2] * enuOffset[2],
    ),
  );
  return {
    positionEC,
    eyeToEnu: { matrix: [...Array(9)].map((_, i) => round(m[i])) },
    eyeCartographic: [
      round(state.eyeCartographic.x),
      round(state.eyeCartographic.y),
      round(state.eyeCartographic.z),
    ],
    eyeEllipsoidCurvature: [
      round(state.eyeEllipsoidCurvature.x),
      round(state.eyeEllipsoidCurvature.y),
    ],
  };
}

/**
 * Offsets, in the camera's ENU frame, from a metre away to the grazing
 * near-horizon case — a point on the ellipsoid at the tangent distance, which
 * is where the GLSL's first-order latitude approximation is worst and where a
 * naive twin diverges first.
 */
function enuOffsetsFor(height) {
  const R = ellipsoid.maximumRadius;
  const h = Math.max(height, 0);
  // Tangent-point distance and its drop below the camera's horizontal plane.
  const horizon = Math.sqrt(Math.max((R + h) * (R + h) - R * R, 0));
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, -1],
    [100, -250, -30],
    [1e4, 1e4, -1e3],
    [horizon * 0.5, 0, -h * 0.5],
    // Grazing: due east at the horizon, and due north at the horizon.
    [horizon, 0, -h],
    [0, horizon, -h],
    [horizon * 0.7071, -horizon * 0.7071, -h],
  ];
}

const f32 = Math.fround;

// =============================================================================
// Tests — C-20
// =============================================================================

test("C-20 `eyeCartographic.z` IS `eyeHeight`, bit for bit, wherever the camera has a cartographic position", () => {
  let checked = 0;
  for (const height of HEIGHTS) {
    for (const latitude of LATITUDES) {
      const state = uniformStateAt(0.7, latitude, height);
      assert.ok(
        Object.is(state.eyeCartographic.z, state.eyeHeight),
        `eyeCartographic.z (${state.eyeCartographic.z}) is not eyeHeight (${state.eyeHeight}) at h=${height}, lat=${latitude}`,
      );
      checked++;
    }
  }
  assert.ok(checked >= 60, "the sweep must actually cover something");
});

test("C-20 the invariant does NOT hold on the branch without a cartographic position, and the packer must not ship that frame", () => {
  // `UniformStateComputations.setCamera` assigns `_eyeHeight` from the
  // ellipsoid's radius there and never touches `_eyeCartographic`, so the
  // cartographic keeps the PREVIOUS frame's value. The census stated the
  // invariant unconditionally; it is conditional, and this is the condition.
  const state = uniformStateAt(0.7, 0.4, 5000);
  const before = Cartesian3.clone(state.eyeCartographic, new Cartesian3());
  UniformStateComputations.setCamera(state, {
    positionWC: Cartesian3.fromRadians(0.7, 0.4, 5000, ellipsoid),
    directionWC: Cartesian3.UNIT_X,
    rightWC: Cartesian3.UNIT_Y,
    upWC: Cartesian3.UNIT_Z,
    positionCartographic: undefined,
  });
  assert.ok(
    Cartesian3.equals(before, state.eyeCartographic),
    "the cartographic must be the stale one for this test to mean anything",
  );
  assert.ok(
    !Object.is(state.eyeCartographic.z, state.eyeHeight),
    "the invariant is supposed to fail on this branch",
  );

  const { data, base } = packTail(state);
  for (let i = 0; i < EYE_CARTOGRAPHIC_FLOATS; i++) {
    assert.equal(
      data[base + i],
      0,
      `float ${base + i} must be zeroed rather than carry a stale frame`,
    );
  }
});

// =============================================================================
// Tests — C-21: the packer, the layout and the padding
// =============================================================================

test("C-21 the packed rotation reads back through the WGSL layout orthonormal with determinant 1", () => {
  let worstOrtho = 0;
  let worstDeterminant = 0;
  for (const height of HEIGHTS) {
    for (const latitude of LATITUDES) {
      for (const longitude of LONGITUDES) {
        const state = uniformStateAt(longitude, latitude, height);
        const { data, base } = packTail(state);
        const columns = readEnuThroughWgslLayout(data, base);
        worstOrtho = Math.max(worstOrtho, orthonormalityResidual(columns));
        worstDeterminant = Math.max(
          worstDeterminant,
          Math.abs(determinantOf(columns) - 1),
        );
      }
    }
  }
  assert.ok(
    worstOrtho < F32_ROTATION_TOLERANCE,
    `worst orthonormality residual ${worstOrtho} exceeds ${F32_ROTATION_TOLERANCE}`,
  );
  assert.ok(
    worstDeterminant < F32_ROTATION_TOLERANCE,
    `worst |det - 1| ${worstDeterminant} exceeds ${F32_ROTATION_TOLERANCE}`,
  );
});

test("C-21 the source rotation is orthonormal to f64 noise before the pack ever sees it", () => {
  let worst = 0;
  for (const height of HEIGHTS) {
    for (const latitude of LATITUDES) {
      const state = uniformStateAt(1.2, latitude, height);
      const m = state.eyeToEnu;
      const columns = [0, 1, 2].map((c) => [
        m[c * 3],
        m[c * 3 + 1],
        m[c * 3 + 2],
      ]);
      worst = Math.max(
        worst,
        orthonormalityResidual(columns),
        Math.abs(Matrix3.determinant(m) - 1),
      );
    }
  }
  assert.ok(
    worst < F64_ROTATION_TOLERANCE,
    `the JS-side rotation residual ${worst} exceeds ${F64_ROTATION_TOLERANCE}`,
  );
});

test("C-21 MUTANT — packing the mat3x3 as nine tight floats turns the rotation into something that is not one", () => {
  // GLSL's `mat3` layout. Column 1's first element lands in column 0's
  // padding lane; every column after it is shifted.
  const mutation = {
    from: "const base = offset + 4 + column * 4;",
    to: "const base = offset + 4 + column * 3;",
  };
  let sawFailure = false;
  for (const latitude of [0.4, 1.0, -1.2]) {
    const state = uniformStateAt(0.7, latitude, 1e4);
    const { data, base } = packTail(state, mutation);
    const columns = readEnuThroughWgslLayout(data, base);
    if (
      orthonormalityResidual(columns) >= F32_ROTATION_TOLERANCE ||
      Math.abs(determinantOf(columns) - 1) >= F32_ROTATION_TOLERANCE
    ) {
      sawFailure = true;
    }
  }
  assert.ok(
    sawFailure,
    "the tight nine-float pack must break the orthonormality check the test above asserts",
  );
});

test("C-21 naga sizes the camera binding at exactly the floats the packer writes", async () => {
  // The layout above is derived by this file. This one is derived by a real
  // WGSL front end: naga reports the binding's `minBindingSize` from the
  // shader text the pipeline actually compiles. If a `mat3x3<f32>` were nine
  // tight floats, the struct would be twelve bytes narrower and this number
  // would not be `CAMERA_UNIFORM_FLOATS * 4`.
  // The ENGINE's own naga build, not `Tools/shader-pipeline/naga-wasm-tools`:
  // the tooling build's reflection omits `minBindingSize`, which is the whole
  // number this test is after.
  const nagaDirectory = path.join(ENGINE_SOURCE, "ThirdParty", "naga-wasm");
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_bg.wasm"),
    ),
  });
  // The shader carries `//>>ifdef` blocks, so raw text is deliberately not
  // valid WGSL. `defaultVariant` runs the ENGINE's preprocessor at
  // `definesHi = 0`, which is the text a default pipeline compiles.
  const { defaultVariant } = await import("./lib/wgsl-variant.mjs");

  const reflection = JSON.parse(
    naga.validate_wgsl(defaultVariant(terrainSource)),
  );
  const camera = reflection.bindings.find((entry) => entry.name === "camera");
  assert.ok(camera, "the globe shader must bind a camera uniform buffer");
  assert.equal(
    camera.minBindingSize,
    CAMERA_UNIFORM_FLOATS * 4,
    "naga's own size for the camera struct must be the width the packer fills",
  );
});

test("C-21 the shader declares eyeToEnu as a mat3x3 and the struct leaves twelve floats for it", () => {
  const { byName } = cameraLayout();
  const enu = byName.get("eyeToEnu");
  assert.ok(enu, "CameraUniforms must declare eyeToEnu");
  assert.equal(enu.type, "mat3x3<f32>");
  assert.equal(enu.size, 48, "a WGSL mat3x3<f32> occupies three vec4 columns");

  const curvature = byName.get("eyeEllipsoidCurvature");
  assert.ok(curvature, "CameraUniforms must declare eyeEllipsoidCurvature");
  assert.equal(
    (curvature.offset - enu.offset) / 4,
    12,
    "twelve floats separate the rotation from the curvature, not nine",
  );
});

// =============================================================================
// Tests — the struct and the packer agree, and D4 holds
// =============================================================================

test("the eye tail lands on the floats the packer's cursor reaches", () => {
  const { byName, size } = cameraLayout();
  const base = CAMERA_UNIFORM_FLOATS - EYE_CARTOGRAPHIC_FLOATS;
  assert.equal(
    byName.get("eyeCartographic").offset / 4,
    base,
    "the shader's first tail field must be where the packer starts writing it",
  );
  assert.equal(
    size / 4,
    CAMERA_UNIFORM_FLOATS,
    "the declared float count must be the struct's real width",
  );

  const state = uniformStateAt(0.7, 0.4, 1e4);
  const { data } = packTail(state);
  assert.equal(data[base], f32(state.eyeCartographic.x));
  assert.equal(data[base + 1], f32(state.eyeCartographic.y));
  assert.equal(data[base + 2], f32(state.eyeCartographic.z));
  assert.equal(
    data[byName.get("eyeEllipsoidCurvature").offset / 4],
    f32(state.eyeEllipsoidCurvature.x),
  );
  assert.equal(
    data[byName.get("eyeEllipsoidCurvature").offset / 4 + 1],
    f32(state.eyeEllipsoidCurvature.y),
  );
});

test("D4 — previousViewProjection is still at floats 100-115 in both the struct and the packer", () => {
  const { byName } = cameraLayout();
  const field = byName.get("previousViewProjection");
  assert.ok(field, "CameraUniforms must still carry previousViewProjection");
  assert.equal(field.type, "mat4x4<f32>");
  assert.equal(
    field.offset / 4,
    100,
    "TAA, CSM and the motion-vector pass read this by name where the packer writes it positionally",
  );
  // And the packer still says so where it writes it.
  assert.match(
    cameraUbSource,
    /previousViewProjection \(mat4x4, 16 floats, offsets 100-115\)/,
    "the packer must still document the offsets it writes",
  );
  assert.match(
    cameraUbSource,
    /const prevVP = uniformState\.previousViewProjection;/,
    "the packer must still source it from UniformState",
  );
});

test("D4 MUTANT — moving previousViewProjection off its floats turns the pin red", () => {
  const mutated = terrainSource.replace(
    "  previousViewProjection: mat4x4<f32>,\n",
    "",
  );
  assert.notEqual(mutated, terrainSource, "the mutation target must exist");
  const relocated = mutated.replace(
    "  eyeCartographic: vec3<f32>,",
    "  previousViewProjection: mat4x4<f32>,\n  eyeCartographic: vec3<f32>,",
  );
  const { byName } = cameraLayout(relocated);
  assert.notEqual(
    byName.get("previousViewProjection").offset / 4,
    100,
    "relocating the field must move it off float 100, or the pin above proves nothing",
  );
});

test("INERTNESS MUTANT — an unreachable tail write leaves the frame zeroed", () => {
  // The failure mode this lane exists to avoid: a registry entry, or any other
  // write that never runs. `WebGPUAutoUniforms.js` has zero importers, so an
  // entry there cannot fail a test like this one; a live packer can.
  const state = uniformStateAt(0.7, 0.4, 1e4);
  const live = packTail(state);
  assert.notEqual(
    live.data[live.base],
    0,
    "the live packer must write a non-zero longitude for this mutant to mean anything",
  );

  const inert = packTail(state, {
    from: "  data[offset] = carto.x;",
    to: "  if (false && true) { data[offset] = carto.x; }",
  });
  assert.equal(
    inert.data[inert.base],
    0,
    "making the write unreachable must leave the slot at zero",
  );

  const inertRotation = packTail(state, {
    from: "  for (let column = 0; column < 3; column++) {",
    to: "  for (let column = 0; false && column < 3; column++) {",
  });
  const columns = readEnuThroughWgslLayout(
    inertRotation.data,
    inertRotation.base,
  );
  assert.equal(
    determinantOf(columns),
    0,
    "an unwritten rotation is the zero matrix, which the shader's certificate reads as not-live",
  );
});

// =============================================================================
// Tests — C-22: the delta builtin
// =============================================================================

test("C-22 the WGSL twin computes the same numbers as the GLSL builtin, in float32, at every altitude including the grazing case", () => {
  let comparisons = 0;
  for (const height of HEIGHTS) {
    for (const latitude of LATITUDES) {
      const state = uniformStateAt(0.7, latitude, height);
      const inputs64Base = deltaInputs(state, [0, 0, 0], identity);
      for (const offset of enuOffsetsFor(height)) {
        const inputs32 = deltaInputs(state, offset, f32);
        const glsl = evaluateDelta(glslDelta, inputs32, f32);
        for (const [label, parsed] of [
          [CHUNK_FILE, chunkDelta],
          [TERRAIN_FILE, terrainDelta],
          [BUILTINS_FILE, builtinsDelta],
        ]) {
          const wgsl = evaluateDelta(parsed, inputs32, f32);
          assert.deepEqual(
            wgsl,
            glsl,
            `${label} diverges from the GLSL at h=${height}, lat=${latitude}, enu=${offset}`,
          );
        }
        comparisons++;
      }
      void inputs64Base;
    }
  }
  assert.ok(comparisons >= 500, `only ${comparisons} comparisons ran`);
});

// f32 keeps 24 mantissa bits, so the gap between neighbours at magnitude `x`
// is `2^-23 * 2^floor(log2 x)`. Every term of this algorithm passes through
// the meridional frame's magnitude (radius + height), so that is the scale its
// rounding error is measured against — NOT the size of the answer, which is a
// near-perfect cancellation at the horizon and would make any relative metric
// meaningless there.
const EPS32 = 2 ** -23;
const ulp32 = (x) =>
  x === 0 ? 0 : EPS32 * 2 ** Math.floor(Math.log2(Math.abs(x)));

test("C-22 the float32 evaluation sits within float32 noise of the exact one — measured against the magnitudes the algorithm passes through", () => {
  let worstHeightUlps = 0;
  let worstAngleUlps = 0;
  let worstCase = null;
  for (const height of HEIGHTS) {
    for (const latitude of LATITUDES) {
      const state = uniformStateAt(0.7, latitude, height);
      const radius =
        1 / state.eyeEllipsoidCurvature.y + state.eyeCartographic.z;
      for (const offset of enuOffsetsFor(height)) {
        const approx = evaluateDelta(
          glslDelta,
          deltaInputs(state, offset, f32),
          f32,
        );
        const exact = evaluateDelta(
          glslDelta,
          deltaInputs(state, offset, identity),
          identity,
        );
        // Height is a length, in the frame's own units.
        const heightUlps =
          Math.abs(approx[2] - exact[2]) / Math.max(ulp32(radius), 1e-30);
        // The two angles come out of `atan2` over frame-scale arguments, so
        // their absolute error is the frame's relative resolution.
        const angleUlps =
          Math.max(
            Math.abs(approx[0] - exact[0]),
            Math.abs(approx[1] - exact[1]),
          ) / EPS32;
        if (heightUlps > worstHeightUlps) {
          worstHeightUlps = heightUlps;
          worstCase = { height, latitude, offset, approx, exact };
        }
        worstAngleUlps = Math.max(worstAngleUlps, angleUlps);
      }
    }
  }
  assert.ok(
    worstHeightUlps <= 16,
    `the delta height drifts ${worstHeightUlps.toFixed(2)} ulp of the meridional frame — worst at ${JSON.stringify(worstCase)}`,
  );
  assert.ok(
    worstAngleUlps <= 16,
    `the delta angles drift ${worstAngleUlps.toFixed(2)} × 2^-23 radians`,
  );
});

test("C-22 the delta gets MORE precise as one zooms in, which is the property it exists for", () => {
  // The bound above is the worst case, at the horizon of a 10,000 km camera.
  // Near the camera the formulation must actually deliver: a 10 km offset has
  // to come back to better than a part in 10^4 of the answer itself, at every
  // altitude. A twin that reintroduced the large-magnitude subtraction the
  // GLSL's comments warn against would fail here while still passing the
  // frame-scale bound.
  let worstRelative = 0;
  for (const height of HEIGHTS) {
    for (const latitude of LATITUDES) {
      const state = uniformStateAt(0.7, latitude, height);
      for (const offset of [
        [1, 0, 0],
        [0, 1, 0],
        [100, -250, -30],
        [1e4, 1e4, -1e3],
      ]) {
        const approx = evaluateDelta(
          glslDelta,
          deltaInputs(state, offset, f32),
          f32,
        );
        const exact = evaluateDelta(
          glslDelta,
          deltaInputs(state, offset, identity),
          identity,
        );
        for (let i = 0; i < 3; i++) {
          if (Math.abs(exact[i]) > 1e-12) {
            worstRelative = Math.max(
              worstRelative,
              Math.abs(approx[i] - exact[i]) / Math.abs(exact[i]),
            );
          }
        }
      }
    }
  }
  assert.ok(
    worstRelative < 1e-4,
    `near-field relative error ${worstRelative} is too large for a delta formulation`,
  );
});

test("C-22 the delta from the camera to the camera is exactly zero", () => {
  // The identity the shader's certificate mode checks on the GPU. It exercises
  // both curvature reciprocals and the eye height, and it is exact rather than
  // approximate, so a packing error in any of the three uniforms shows here.
  for (const height of HEIGHTS) {
    for (const latitude of LATITUDES) {
      const state = uniformStateAt(1.2, latitude, height);
      const inputs = deltaInputs(state, [0, 0, 0], f32);
      const delta = evaluateDelta(chunkDelta, inputs, f32);
      assert.deepEqual(
        delta,
        [0, 0, 0],
        `a camera-to-camera delta must be zero at h=${height}, lat=${latitude}`,
      );
    }
  }
});

test("C-22 the delta's first-order behaviour is the ENU offset it was built from", () => {
  // A sanity law with real content: for a small offset the geodetic delta must
  // reduce to the ENU displacement divided by the local radii. This is what
  // makes the function useful to the model clipping and vector-lookup twins,
  // and it is independent of how the source spells its intermediate terms.
  const state = uniformStateAt(0.7, 0.6, 500);
  const inputs = deltaInputs(state, [12, -7, 3], f32);
  const delta = evaluateDelta(chunkDelta, inputs, f32);
  const primeVertical = 1 / state.eyeEllipsoidCurvature.x;
  const meridional = 1 / state.eyeEllipsoidCurvature.y;
  const height = state.eyeCartographic.z;
  const expectedLongitude =
    12 / ((primeVertical + height) * Math.cos(state.eyeCartographic.y));
  const expectedLatitude = -7 / (meridional + height);
  assert.ok(
    Math.abs(delta[0] - expectedLongitude) < 1e-9,
    `delta longitude ${delta[0]} is not the first-order ${expectedLongitude}`,
  );
  assert.ok(
    Math.abs(delta[1] - expectedLatitude) < 1e-9,
    `delta latitude ${delta[1]} is not the first-order ${expectedLatitude}`,
  );
  assert.ok(
    Math.abs(delta[2] - 3) < 1e-3,
    `delta height ${delta[2]} is not the 3 m the offset carried`,
  );
});

// =============================================================================
// Tests — the wiring is live rather than a registry entry
// =============================================================================

test("the chunk is registered in WGSLBuiltins (dormant today) and inlined in GlobeTerrain, which is what actually reads it", () => {
  // This pins TEXT-SYNC between the three copies of the chunk, NOT liveness.
  // `WGSLBuiltins.ts`'s header calls itself the authoritative source, but its
  // library is never instantiated at runtime: `createDefaultWGSLLibrary()` is
  // called only by `WebGPUShaderCache`'s constructor, `new WebGPUShaderCache(`
  // appears in `Source/` only in a JSDoc example (`WebGPUShaderCache.ts:58`),
  // and `WebGPUContext.ts:673` leaves `_webgpuShaderCache` `null` for the life
  // of the context. So registration here causes nothing to read the chunk —
  // it is belt-and-braces for the day the library gets wired up. Test 18 (the
  // globe binding) is the liveness pin; the delivery rides on the inline copy
  // in `GlobeTerrain.wgsl`.
  const builtins = read(BUILTINS_FILE);
  assert.match(
    builtins,
    /library\.registerCode\(\s*"functions\/csm_eyeToCartographicDelta",/,
  );
  assert.match(
    builtins,
    /EYE_TO_CARTOGRAPHIC_DELTA: "functions\/csm_eyeToCartographicDelta"/,
  );
});

test("the globe shader binds the delta to the camera UB and calls it", () => {
  const stripped = stripLineComments(terrainSource);
  assert.match(
    stripped,
    /fn globe_eyeToCartographicDelta\(positionEC: vec3<f32>\) -> vec3<f32> \{\s*return csm_eyeToCartographicDelta\(\s*positionEC,\s*camera\.eyeToEnu,\s*camera\.eyeCartographic,\s*camera\.eyeEllipsoidCurvature\s*\);\s*\}/,
    "the globe's binding must read all three uniforms off the camera UB",
  );
  assert.ok(
    /globe_eyeToCartographicDelta\(input\.v_positionEC\)/.test(stripped),
    "the fragment stage must evaluate it on a real fragment position",
  );
});

test("the certificate debug mode's sentinel is the one the shader guards", () => {
  const registry = read(DEBUG_REGISTRY_FILE);
  const entry = /name: "eye-carto-frame",\s*sentinel: ([0-9.e]+),/.exec(
    registry,
  );
  assert.ok(entry, "the eye-carto-frame mode must be registered");
  const sentinel = Number.parseFloat(entry[1]);
  assert.equal(sentinel, 28.0e9);
  // The shader's guard is the half-open band the registry's own convention
  // puts around a sentinel.
  const guard = new RegExp(
    `tile\\.time > ${(sentinel - 0.5e9) / 1e9}e9 && tile\\.time < ${
      (sentinel + 0.5e9) / 1e9
    }e9`,
  );
  assert.match(
    stripLineComments(terrainSource),
    guard,
    "GlobeTerrain.wgsl must guard the certificate on the registered sentinel",
  );
  // And no other mode may claim it.
  const sentinels = [...registry.matchAll(/sentinel: ([0-9.e]+),/g)].map((m) =>
    Number.parseFloat(m[1]),
  );
  assert.equal(
    sentinels.filter((value) => value === sentinel).length,
    1,
    "sentinels must stay unique",
  );
});
