// @purpose Executes the model camera packer and the model vertex stage's velocity block out of their own shipped source, and requires the previous-frame clip position to be the current-frame expression with previous-frame operands.
// @status ACTIVE
//
// WHY THIS EXISTS. The model velocity stage used to compute the current clip
// position relative to the eye and the previous one from a full-magnitude f32
// world position times a world-space matrix. `posHigh + posLow` rounds at the
// f32 ulp of an Earth radius, so a static primitive under a static camera
// emitted non-zero velocity. The repair gives `CameraUniforms` a previous
// relative-to-eye matrix and a previous encoded camera split, and makes the
// previous-frame expression the same expression as the current one.
//
// WHAT IS ASSERTED, AND WHY IT IS NOT A TRANSCRIPTION.
//
//   1. LAYOUT, derived twice. Every field's float offset is derived once by
//      walking `packCameraUniforms`'s writes in the real renderer source and
//      once from the real WGSL struct text under the WGSL uniform address-space
//      layout rules. The two derivations must agree, and the struct's size must
//      equal the arena's own byte constant. Neither number is written here.
//      (`cloud-tier-single-source.spec.mjs` items 2 and 3 are the technique;
//      `model-camera-arena.spec.mjs` is the model-side precedent.)
//
//   2. THE PACKER IS EXECUTED, not described. `WebGPUModelRenderer.ts` cannot
//      be imported from Node — it pulls in generated `Shaders/**/*.js` modules
//      that exist only after a build — so the packer's text is extracted and
//      run through `new Function` with the real `Matrix4` / `EncodedCartesian3`
//      and stub uniform state. Every number asserted below came out of the
//      function that ships.
//
//   3. THE SHADER IS EXECUTED, not grepped. The vertex stage's current-frame
//      and previous-frame clip-position statements are read out of the WGSL and
//      run through a small fail-closed evaluator in f32. Asserting that the two
//      clip positions are equal for a static scene is a statement about
//      behaviour; asserting that the file contains the word
//      `previousMvpRelativeToEye` would only be a statement about text. The
//      inertness mutants for both defect sites change these numbers.
//
// PRECISION. The evaluator rounds to f32 after every operation, matching WGSL's
// f32 arithmetic for `+`, `-` and `*`. The static-scene assertions are exact
// equalities rather than tolerances on purpose: when the previous-frame
// operands are bitwise equal to the current-frame ones, the two expressions are
// the same operations on the same inputs, so any inequality at all means the
// expressions differ.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// Mutation-image hooks. Each reads the shipped file by default; an inertness
// mutant points one of them at a COPY of that file with the fix made
// unreachable, and the assertions below must go red. Nothing in CI sets them.
// (`cloud-api-enum-reachability.spec.mjs` uses the same affordance.)
const OVERRIDES = {
  "packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl":
    process.env.MODEL_RTE_SHADER,
  "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts":
    process.env.MODEL_RTE_RENDERER,
};

const read = (relativePath) =>
  fs.readFileSync(
    OVERRIDES[relativePath]
      ? path.resolve(OVERRIDES[relativePath])
      : path.join(root, relativePath),
    "utf8",
  );

const RENDERER_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUModelRenderer.ts";
const ARENA_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUModelCameraArena.ts";
const LOG_DEPTH_TS = "packages/engine/Source/Renderer/WebGPU/WebGPULogDepth.ts";
const MODEL_WGSL =
  "packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl";

const rendererSource = read(RENDERER_TS);
const arenaSource = read(ARENA_TS);
const logDepthSource = read(LOG_DEPTH_TS);
const shaderSource = read(MODEL_WGSL);

const { default: Matrix4 } = await import(
  pathToFileURL(path.join(root, "packages/engine/Source/Core/Matrix4.js")).href
);
const { default: Cartesian3 } = await import(
  pathToFileURL(path.join(root, "packages/engine/Source/Core/Cartesian3.js"))
    .href
);
const { default: EncodedCartesian3 } = await import(
  pathToFileURL(
    path.join(root, "packages/engine/Source/Core/EncodedCartesian3.js"),
  ).href
);

// ── Source utilities ────────────────────────────────────────────────────────

/** Strip `//` line comments, leaving string literals alone (there are none). */
function stripLineComments(text) {
  return text.replace(/\/\/[^\n]*/g, "");
}

/** Read `export const NAME = <integer>;` out of a TypeScript source. */
function namedInteger(source, name, label) {
  const match = new RegExp(
    `\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*(-?\\d+)\\s*;`,
  ).exec(source);
  assert.ok(match, `${label}: ${name} not found`);
  return Number(match[1]);
}

/**
 * The text of a brace-delimited body starting at the first `{` at or after
 * `from`, excluding the outer braces.
 */
function braceBody(source, from) {
  const open = source.indexOf("{", from);
  assert.ok(open >= 0, "no opening brace");
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        return { body: source.slice(open + 1, i), end: i + 1 };
      }
    }
  }
  throw new Error("unterminated brace body");
}

// ── 1a. The WGSL side of the layout derivation ──────────────────────────────
//
// WGSL uniform address-space layout, spec §14.4.4. `vec3<f32>` has size 12 and
// alignment 16 — the trap the explicit `_pad*` members exist to make visible.

const WGSL_TYPES = {
  f32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  "vec2<f32>": { align: 8, size: 8 },
  "vec3<f32>": { align: 16, size: 12 },
  "vec4<f32>": { align: 16, size: 16 },
  "mat3x3<f32>": { align: 16, size: 48 },
  "mat4x4<f32>": { align: 16, size: 64 },
};

const roundUp = (value, multiple) => Math.ceil(value / multiple) * multiple;

function parseStruct(source, name) {
  const start = source.indexOf(`struct ${name} {`);
  assert.ok(start >= 0, `struct ${name} not found`);
  const { body } = braceBody(source, start);
  const members = [];
  for (const decl of stripLineComments(body).split(",")) {
    const trimmed = decl.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const m = /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(trimmed);
    assert.ok(m, `unparsed struct member in ${name}: "${trimmed}"`);
    members.push({ name: m[1], type: m[2].trim() });
  }
  return members;
}

function layout(members) {
  const offsets = {};
  let cursor = 0;
  let structAlign = 1;
  for (const member of members) {
    const info = WGSL_TYPES[member.type];
    assert.ok(info, `unmodelled WGSL type "${member.type}"`);
    structAlign = Math.max(structAlign, info.align);
    cursor = roundUp(cursor, info.align);
    offsets[member.name] = cursor;
    cursor += info.size;
  }
  return { offsets, size: roundUp(cursor, structAlign) };
}

const cameraMembers = parseStruct(shaderSource, "CameraUniforms");
const cameraStruct = layout(cameraMembers);
const wgslFloat = (name) => {
  const byteOffset = cameraStruct.offsets[name];
  assert.ok(byteOffset !== undefined, `CameraUniforms has no member ${name}`);
  assert.equal(byteOffset % 4, 0, `${name} is not float-aligned`);
  return byteOffset / 4;
};

// ── 1b. The packer side of the layout derivation ────────────────────────────

const packerText = (() => {
  const start = rendererSource.indexOf("function packCameraUniforms(");
  assert.ok(start >= 0, "packCameraUniforms not found");
  const { body, end } = braceBody(rendererSource, start);
  return { signatureAndBody: rendererSource.slice(start, end), body };
})();

const packerCode = stripLineComments(packerText.body);

/** Float index of `Matrix4.pack(<source>, data, N)`. */
function matrixPackOffset(sourceName) {
  const m = new RegExp(
    `Matrix4\\.pack\\(\\s*${sourceName}\\s*,\\s*data\\s*,\\s*(\\d+)\\s*\\)`,
  ).exec(packerCode);
  assert.ok(m, `packer has no Matrix4.pack from ${sourceName}`);
  return Number(m[1]);
}

/** Float index of the single `data[N] = <rhsFragment>...` assignment. */
function scalarWriteOffset(rhsFragment) {
  const escaped = rhsFragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [
    ...packerCode.matchAll(
      new RegExp(`data\\[(\\d+)\\]\\s*=\\s*${escaped}`, "g"),
    ),
  ];
  assert.equal(
    matches.length,
    1,
    `expected exactly one packer write of ${rhsFragment}, found ${matches.length}`,
  );
  return Number(matches[0][1]);
}

/** Every float index the packer writes, expanding 16-float matrix packs. */
function writtenFloatIndices() {
  const written = new Set();
  for (const m of packerCode.matchAll(
    /Matrix4\.pack\(\s*[\w.]+\s*,\s*data\s*,\s*(\d+)\s*\)/g,
  )) {
    const base = Number(m[1]);
    for (let i = 0; i < 16; i++) {
      written.add(base + i);
    }
  }
  for (const m of packerCode.matchAll(/data\[(\d+)\]\s*=/g)) {
    written.add(Number(m[1]));
  }
  // The log-depth lanes are written by a helper whose indices are named
  // constants in its own module.
  for (const name of [
    "CAMERA_LOG_FACTOR_FLOAT",
    "CAMERA_LOG_NEAR_FLOAT",
    "CAMERA_LOG_FAR_FLOAT",
  ]) {
    written.add(namedInteger(logDepthSource, name, "WebGPULogDepth"));
  }
  return written;
}

const packerOffsets = {
  mvpRelativeToEye: matrixPackOffset("scratchMVPRTE"),
  modelViewRelativeToEye: matrixPackOffset("scratchMVRTE"),
  normalMatrix: matrixPackOffset("scratchNormal"),
  encodedCameraPositionMCHigh: scalarWriteOffset("scratchEncodedCamera.high.x"),
  logDepthFactor: namedInteger(
    logDepthSource,
    "CAMERA_LOG_FACTOR_FLOAT",
    "WebGPULogDepth",
  ),
  encodedCameraPositionMCLow: scalarWriteOffset("scratchEncodedCamera.low.x"),
  logDepthNear: namedInteger(
    logDepthSource,
    "CAMERA_LOG_NEAR_FLOAT",
    "WebGPULogDepth",
  ),
  cameraPositionWC: scalarWriteOffset("camWC.x"),
  logDepthFar: namedInteger(
    logDepthSource,
    "CAMERA_LOG_FAR_FLOAT",
    "WebGPULogDepth",
  ),
  previousMvpRelativeToEye: matrixPackOffset("scratchPrevMVPRTE"),
  previousEncodedCameraPositionMCHigh: scalarWriteOffset(
    "scratchPrevEncodedCamera.high.x",
  ),
  previousEncodedCameraPositionMCLow: scalarWriteOffset(
    "scratchPrevEncodedCamera.low.x",
  ),
  previousViewProjection: matrixPackOffset("prevVP"),
  hdrControl: scalarWriteOffset("frameState.useHDR"),
};

const MODEL_CAMERA_UNIFORM_BYTES = namedInteger(
  arenaSource,
  "MODEL_CAMERA_UNIFORM_BYTES",
  "WebGPUModelCameraArena",
);
const MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT = namedInteger(
  arenaSource,
  "MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT",
  "WebGPUModelCameraArena",
);
const CAMERA_FLOATS = MODEL_CAMERA_UNIFORM_BYTES / 4;

test("every camera field's float offset derives identically from the packer and from the WGSL struct", () => {
  for (const [name, packerFloat] of Object.entries(packerOffsets)) {
    assert.equal(
      packerFloat,
      wgslFloat(name),
      `${name}: packer writes float ${packerFloat}, WGSL places it at float ${wgslFloat(name)}`,
    );
  }
});

test("the struct's declared size is the arena's byte constant, and the last field ends there", () => {
  assert.equal(cameraStruct.size, MODEL_CAMERA_UNIFORM_BYTES);
  assert.equal(
    cameraStruct.size % 16,
    0,
    "uniform struct must stay 16-aligned",
  );

  // `hdrControl` is the tail member; the struct ends exactly one vec4 past it.
  const last = cameraMembers[cameraMembers.length - 1];
  assert.equal(last.name, "hdrControl");
  assert.equal(
    wgslFloat(last.name) + WGSL_TYPES[last.type].size / 4,
    CAMERA_FLOATS,
  );

  // The arena's per-slice footprint must not change: the block still fits the
  // same 256-aligned stride it did before the previous-frame lanes were added.
  assert.ok(
    MODEL_CAMERA_UNIFORM_BYTES <= MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT * 2,
    `${MODEL_CAMERA_UNIFORM_BYTES} bytes no longer fits a ${MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT * 2}-byte aligned slot`,
  );
});

test("the packer covers every float up to the HDR lane, and every declared pad is zeroed", () => {
  const written = writtenFloatIndices();
  const hdrFloat = wgslFloat("hdrControl");
  for (let i = 0; i <= hdrFloat; i++) {
    assert.ok(written.has(i), `packer never writes float ${i}`);
  }
  for (const index of written) {
    assert.ok(
      index <= hdrFloat,
      `packer writes float ${index}, past the struct`,
    );
  }
  for (const member of cameraMembers) {
    if (!/^_pad\d+$/.test(member.name)) {
      continue;
    }
    const float = wgslFloat(member.name);
    assert.match(
      packerCode,
      new RegExp(`data\\[${float}\\]\\s*=\\s*0(\\.0)?\\s*;`),
      `${member.name} at float ${float} is never explicitly zeroed by the packer`,
    );
  }
});

// ── 2. Executing the real packer ────────────────────────────────────────────
//
// The signature's parameter names are read out of the source and the type
// annotations dropped; the body is used verbatim.

const compiledPacker = (() => {
  const signature = /function packCameraUniforms\(([\s\S]*?)\)\s*\{/.exec(
    packerText.signatureAndBody,
  );
  assert.ok(signature, "could not read the packer signature");
  const parameterNames = signature[1]
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const m = /^([A-Za-z_]\w*)\s*:/.exec(p);
      assert.ok(m, `unparsed packer parameter "${p}"`);
      return m[1];
    });
  assert.deepEqual(parameterNames, [
    "data",
    "frameState",
    "modelMatrix",
    "previousModelMatrix",
  ]);

  // Everything the body reaches for that is not a parameter or a local.
  const scratchNames = [
    ...new Set([...packerCode.matchAll(/\bscratch\w+/g)].map((m) => m[0])),
  ];
  const scratches = scratchNames.map((name) =>
    name.includes("Camera") && !name.includes("Encoded")
      ? new Cartesian3()
      : name.includes("Encoded")
        ? new EncodedCartesian3()
        : new Matrix4(),
  );

  // A faithful stand-in for the log-depth helper: it writes the same three
  // lanes the real one does, from the same named constants, so a lane collision
  // with the new previous-frame fields would surface here.
  const packCameraLogDepthLanes = (data, floatBase, uniformState) => {
    if (!uniformState) {
      return;
    }
    const frustum = uniformState.currentFrustum;
    data[floatBase + packerOffsets.logDepthFactor] =
      uniformState.oneOverLog2FarDepthFromNearPlusOne ?? 0.0;
    data[floatBase + packerOffsets.logDepthNear] = frustum?.x ?? 0.0;
    data[floatBase + packerOffsets.logDepthFar] = frustum?.y ?? 0.0;
  };

  // Executing the shipped packer text is the whole point of this file: the
  // module cannot be imported, and describing it instead of running it would
  // certify the description.
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    "Matrix4",
    "Cartesian3",
    "EncodedCartesian3",
    "packCameraLogDepthLanes",
    ...scratchNames,
    `"use strict";
     function packCameraUniforms(${parameterNames.join(", ")}) {${packerText.body}}
     return packCameraUniforms;`,
  );
  return factory(
    Matrix4,
    Cartesian3,
    EncodedCartesian3,
    packCameraLogDepthLanes,
    ...scratches,
  );
})();

/** A view matrix for a camera at `eye` with the given rotation rows. */
function viewFor(rotation, eye) {
  // t = -R * eye, the relation the previous-frame composition depends on.
  const view = Matrix4.clone(rotation, new Matrix4());
  const t = Matrix4.multiplyByPointAsVector(rotation, eye, new Cartesian3());
  view[12] = -t.x;
  view[13] = -t.y;
  view[14] = -t.z;
  return view;
}

const ROTATION = Matrix4.fromColumnMajorArray([
  0.36, 0.48, -0.8, 0.0, -0.8, 0.6, 0.0, 0.0, 0.48, 0.64, 0.6, 0.0, 0.0, 0.0,
  0.0, 1.0,
]);
// A different orthonormal rotation, for the cases that need the relative-to-eye
// matrix itself to move.
const ROTATED = Matrix4.fromColumnMajorArray([
  0.6, 0.8, 0.0, 0.0, -0.8, 0.6, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0,
  1.0,
]);
const PROJECTION = Matrix4.fromColumnMajorArray([
  1.5, 0, 0, 0, 0, 2.0, 0, 0, 0, 0, -1.0000002, -1, 0, 0, -0.2, 0,
]);
const EYE = new Cartesian3(6378137.0 + 1200.0, 250000.0, -90000.0);
const MOVED_EYE = new Cartesian3(6378137.0 + 1210.0, 250090.0, -90040.0);

/** `projection × (view with its translation column zeroed)`. */
function viewProjectionRelativeToEye(projection, view) {
  const rte = Matrix4.clone(view, new Matrix4());
  rte[12] = 0.0;
  rte[13] = 0.0;
  rte[14] = 0.0;
  return Matrix4.multiply(projection, rte, new Matrix4());
}

function makeUniformState({ eye, previousEye, previousViewProjectionRTE }) {
  const view = viewFor(ROTATION, eye);
  return {
    view,
    projection: PROJECTION,
    cameraPosition: eye,
    previousCameraPosition: previousEye,
    previousViewProjectionRelativeToEye: previousViewProjectionRTE,
    previousViewProjection: Matrix4.multiply(PROJECTION, view, new Matrix4()),
    currentFrustum: { x: 1.0, y: 1.0e7 },
    oneOverLog2FarDepthFromNearPlusOne: 0.0431,
  };
}

function pack({
  eye,
  previousEye,
  previousViewProjectionRTE,
  model,
  previousModel,
}) {
  const uniformState = makeUniformState({
    eye,
    previousEye,
    previousViewProjectionRTE,
  });
  const data = new Float32Array(CAMERA_FLOATS);
  compiledPacker(
    data,
    { context: { uniformState }, useHDR: false },
    model,
    previousModel,
  );
  return data;
}

const IDENTITY_MODEL = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
const MOVED_MODEL = Matrix4.fromColumnMajorArray([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 900.0, -400.0, 250.0, 1,
]);

const slice = (data, name, count) => {
  const base = wgslFloat(name);
  return Array.from(data.slice(base, base + count));
};
const currentMatrix = (d) => slice(d, "mvpRelativeToEye", 16);
const previousMatrix = (d) => slice(d, "previousMvpRelativeToEye", 16);
const currentSplit = (d) => [
  ...slice(d, "encodedCameraPositionMCHigh", 3),
  ...slice(d, "encodedCameraPositionMCLow", 3),
];
const previousSplit = (d) => [
  ...slice(d, "previousEncodedCameraPositionMCHigh", 3),
  ...slice(d, "previousEncodedCameraPositionMCLow", 3),
];

const STATIC_PREV_VP_RTE = viewProjectionRelativeToEye(
  PROJECTION,
  viewFor(ROTATION, EYE),
);

test("a static camera and a static model pack previous-frame lanes equal to the current ones", () => {
  for (const model of [IDENTITY_MODEL, MOVED_MODEL]) {
    const data = pack({
      eye: EYE,
      previousEye: EYE,
      previousViewProjectionRTE: STATIC_PREV_VP_RTE,
      model,
      previousModel: model,
    });
    assert.deepEqual(previousMatrix(data), currentMatrix(data));
    assert.deepEqual(previousSplit(data), currentSplit(data));
  }
});

// A relative-to-eye matrix carries only the rotation half of a camera or model
// transform — that is what makes it relative to the eye — so a pure
// translation moves the encoded split and leaves the matrix alone, and a
// rotation moves the matrix. Both halves are asserted so neither the matrix
// lanes nor the split lanes can pass the static case vacuously.

test("a translated camera moves the previous split while the relative-to-eye matrix stays put", () => {
  const data = pack({
    eye: MOVED_EYE,
    previousEye: EYE,
    previousViewProjectionRTE: STATIC_PREV_VP_RTE,
    model: IDENTITY_MODEL,
    previousModel: IDENTITY_MODEL,
  });
  assert.notDeepEqual(previousSplit(data), currentSplit(data));
  assert.deepEqual(previousMatrix(data), currentMatrix(data));
});

test("a rotated camera moves the previous relative-to-eye matrix", () => {
  const data = pack({
    eye: EYE,
    previousEye: EYE,
    previousViewProjectionRTE: viewProjectionRelativeToEye(
      PROJECTION,
      viewFor(ROTATED, EYE),
    ),
    model: IDENTITY_MODEL,
    previousModel: IDENTITY_MODEL,
  });
  assert.notDeepEqual(previousMatrix(data), currentMatrix(data));
});

test("a translated model matrix moves the previous split", () => {
  const data = pack({
    eye: EYE,
    previousEye: EYE,
    previousViewProjectionRTE: STATIC_PREV_VP_RTE,
    model: MOVED_MODEL,
    previousModel: IDENTITY_MODEL,
  });
  assert.notDeepEqual(previousSplit(data), currentSplit(data));
});

test("a rotated model matrix moves the previous relative-to-eye matrix", () => {
  const data = pack({
    eye: EYE,
    previousEye: EYE,
    previousViewProjectionRTE: STATIC_PREV_VP_RTE,
    model: IDENTITY_MODEL,
    previousModel: ROTATED,
  });
  assert.notDeepEqual(previousMatrix(data), currentMatrix(data));
});

test("the previous-frame lanes hold UniformState's values rather than a recomputation", () => {
  const perturbed = Matrix4.clone(STATIC_PREV_VP_RTE, new Matrix4());
  perturbed[5] += 0.125;
  const baseline = pack({
    eye: EYE,
    previousEye: EYE,
    previousViewProjectionRTE: STATIC_PREV_VP_RTE,
    model: IDENTITY_MODEL,
    previousModel: IDENTITY_MODEL,
  });
  const followed = pack({
    eye: EYE,
    previousEye: EYE,
    previousViewProjectionRTE: perturbed,
    model: IDENTITY_MODEL,
    previousModel: IDENTITY_MODEL,
  });
  assert.notDeepEqual(previousMatrix(followed), previousMatrix(baseline));
  assert.deepEqual(
    previousMatrix(followed),
    Array.from(Matrix4.pack(perturbed, new Float32Array(16), 0)),
    "the previous matrix must be UniformState's VP_RTE composed with an identity model",
  );
  // Moving only the previous camera moves only the previous split.
  const movedEyeOnly = pack({
    eye: EYE,
    previousEye: MOVED_EYE,
    previousViewProjectionRTE: STATIC_PREV_VP_RTE,
    model: IDENTITY_MODEL,
    previousModel: IDENTITY_MODEL,
  });
  assert.deepEqual(currentSplit(movedEyeOnly), currentSplit(baseline));
  assert.notDeepEqual(previousSplit(movedEyeOnly), previousSplit(baseline));
});

test("a missing previous camera state falls back without producing NaN", () => {
  const uniformState = makeUniformState({
    eye: EYE,
    previousEye: undefined,
    previousViewProjectionRTE: undefined,
  });
  uniformState.previousViewProjection = undefined;
  const data = new Float32Array(CAMERA_FLOATS);
  compiledPacker(
    data,
    { context: { uniformState }, useHDR: false },
    IDENTITY_MODEL,
    IDENTITY_MODEL,
  );
  for (let i = 0; i < data.length; i++) {
    assert.ok(Number.isFinite(data[i]), `float ${i} is not finite`);
  }
  assert.deepEqual(
    previousMatrix(data),
    Array.from(Matrix4.pack(Matrix4.IDENTITY, new Float32Array(16), 0)),
  );
  assert.deepEqual(previousSplit(data), [0, 0, 0, 0, 0, 0]);
});

// ── 3. Executing the shader's velocity block ────────────────────────────────
//
// A deliberately small, fail-closed WGSL statement evaluator. It supports only
// what the two blocks below use — `let` / `var` bindings, assignment, one
// `if (hasFlag(...)) { ... }`, member and index access, the `vecN<f32>` and
// `mat3x3<f32>` constructors, and `+ - *` — and throws on anything else, so a
// shader that outgrows it fails loudly instead of being silently skipped.
// Arithmetic rounds to f32 after every operation.

const f32 = Math.fround;

const isVec = (v) => Array.isArray(v) && typeof v[0] === "number";
const isMat = (v) => Array.isArray(v) && Array.isArray(v[0]);

function tokenize(text) {
  const tokens = [];
  const re = /\s+|([A-Za-z_]\w*)|(\d+\.?\d*(?:[eE][-+]?\d+)?[uf]?)|(\S)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) {
      tokens.push({ kind: "id", text: m[1] });
    } else if (m[2] !== undefined) {
      tokens.push({ kind: "num", text: m[2] });
    } else if (m[3] !== undefined) {
      tokens.push({ kind: "punct", text: m[3] });
    }
  }
  return tokens;
}

function elementwise(op, a, b) {
  const f = { "+": (x, y) => x + y, "-": (x, y) => x - y }[op];
  if (isVec(a) && isVec(b)) {
    assert.equal(a.length, b.length, "vector width mismatch");
    return a.map((x, i) => f32(f(x, b[i])));
  }
  if (typeof a === "number" && typeof b === "number") {
    return f32(f(a, b));
  }
  throw new Error(`unsupported operands for ${op}`);
}

function multiply(a, b) {
  if (isMat(a) && isVec(b)) {
    assert.equal(a.length, b.length, "matrix/vector width mismatch");
    const rows = a[0].length;
    const out = new Array(rows).fill(0);
    for (let r = 0; r < rows; r++) {
      let acc = 0;
      for (let c = 0; c < a.length; c++) {
        acc = f32(acc + f32(a[c][r] * b[c]));
      }
      out[r] = acc;
    }
    return out;
  }
  if (typeof a === "number" && isVec(b)) {
    return b.map((x) => f32(a * x));
  }
  if (isVec(a) && typeof b === "number") {
    return a.map((x) => f32(x * b));
  }
  if (typeof a === "number" && typeof b === "number") {
    return f32(a * b);
  }
  throw new Error("unsupported operands for *");
}

const SWIZZLES = { x: 0, y: 1, z: 2, w: 3 };

function evaluateTokens(tokens, env) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (text) => {
    const t = tokens[pos];
    assert.ok(t && t.text === text, `expected "${text}"`);
    pos++;
    return t;
  };

  function primary() {
    const t = peek();
    assert.ok(t, "unexpected end of expression");
    if (t.kind === "num") {
      pos++;
      return f32(parseFloat(t.text));
    }
    if (t.text === "(") {
      pos++;
      const value = additive();
      take(")");
      return value;
    }
    if (t.text === "-") {
      pos++;
      const value = primary();
      return isVec(value) ? value.map((x) => f32(-x)) : f32(-value);
    }
    assert.equal(t.kind, "id", `unsupported token "${t.text}"`);
    pos++;
    const name = t.text;
    // `vecN<f32>(...)` / `mat3x3<f32>(...)` constructors.
    if (peek()?.text === "<") {
      take("<");
      take("f32");
      take(">");
      const args = callArguments();
      return construct(name, args);
    }
    if (peek()?.text === "(") {
      const args = callArguments();
      assert.equal(name, "hasFlag", `unsupported call "${name}"`);
      return (args[0] & args[1]) !== 0;
    }
    assert.ok(name in env, `unbound identifier "${name}"`);
    return postfix(env[name]);
  }

  function callArguments() {
    take("(");
    const args = [];
    if (peek()?.text !== ")") {
      args.push(additive());
      while (peek()?.text === ",") {
        pos++;
        args.push(additive());
      }
    }
    take(")");
    return args;
  }

  function construct(name, args) {
    const flat = [];
    for (const a of args) {
      if (isVec(a)) {
        flat.push(...a);
      } else {
        assert.equal(typeof a, "number", `bad ${name} argument`);
        flat.push(a);
      }
    }
    const width = { vec2: 2, vec3: 3, vec4: 4 }[name];
    if (width !== undefined) {
      if (flat.length === 1) {
        return new Array(width).fill(f32(flat[0]));
      }
      assert.equal(flat.length, width, `${name} arity`);
      return flat.map(f32);
    }
    if (name === "mat3x3") {
      assert.equal(args.length, 3, "mat3x3 arity");
      return args.map((column) => column.map(f32));
    }
    throw new Error(`unsupported constructor "${name}"`);
  }

  function postfix(value) {
    let current = value;
    for (;;) {
      if (peek()?.text === ".") {
        pos++;
        const field = tokens[pos++];
        assert.ok(field && field.kind === "id", "expected a member name");
        const key = field.text;
        if (/^[xyzw]+$/.test(key) && isVec(current)) {
          const source = current;
          current =
            key.length === 1
              ? source[SWIZZLES[key]]
              : [...key].map((c) => source[SWIZZLES[c]]);
        } else {
          assert.ok(
            current !== null && typeof current === "object" && key in current,
            `no member "${key}"`,
          );
          current = current[key];
        }
        continue;
      }
      if (peek()?.text === "[") {
        pos++;
        const index = additive();
        take("]");
        current = current[index];
        continue;
      }
      return current;
    }
  }

  function multiplicative() {
    let left = primary();
    while (peek()?.text === "*") {
      pos++;
      left = multiply(left, primary());
    }
    return left;
  }

  function additive() {
    let left = multiplicative();
    for (;;) {
      const op = peek()?.text;
      if (op !== "+" && op !== "-") {
        return left;
      }
      pos++;
      left = elementwise(op, left, multiplicative());
    }
  }

  const value = additive();
  assert.equal(pos, tokens.length, "expression did not parse completely");
  return value;
}

/** Split a statement list on top-level `;` and `{ }` blocks. */
function splitStatements(code) {
  const statements = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "{" || c === "[") {
      depth++;
    } else if (c === ")" || c === "]") {
      depth--;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        statements.push(code.slice(start, i + 1).trim());
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      statements.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  assert.equal(code.slice(start).trim(), "", "trailing text after statements");
  return statements.filter((s) => s.length > 0);
}

function runStatements(code, env) {
  for (const statement of splitStatements(code)) {
    if (statement.startsWith("if")) {
      const open = statement.indexOf("(");
      const conditionEnd = matchingParen(statement, open);
      const condition = statement.slice(open + 1, conditionEnd);
      const taken = evaluateTokens(tokenize(condition), env);
      assert.equal(typeof taken, "boolean", "if condition is not a boolean");
      if (taken) {
        const body = statement.slice(
          statement.indexOf("{", conditionEnd) + 1,
          statement.lastIndexOf("}"),
        );
        runStatements(body, env);
      }
      continue;
    }
    const m =
      /^(?:(let|var)\s+)?([A-Za-z_][\w.]*)\s*(?::\s*[\w<>]+\s*)?=([\s\S]*)$/.exec(
        statement,
      );
    assert.ok(m, `unsupported statement: "${statement}"`);
    const target = m[2];
    const value = evaluateTokens(tokenize(m[3]), env);
    if (target.includes(".")) {
      const [object, field] = target.split(".");
      assert.ok(object in env, `unbound assignment target "${object}"`);
      env[object][field] = value;
    } else {
      env[target] = value;
    }
  }
  return env;
}

function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") {
      depth++;
    } else if (text[i] === ")") {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  throw new Error("unbalanced parentheses");
}

// ── Extracting the two blocks from the shader ───────────────────────────────

function vertexBody(source) {
  const start = source.indexOf("@vertex fn vertexMain(");
  assert.ok(start >= 0, "vertexMain not found");
  return stripLineComments(braceBody(source, start).body);
}

/** The statement beginning at `marker`, up to and including its `;`. */
function statementAt(code, marker, from = 0) {
  const start = code.indexOf(marker, from);
  assert.ok(start >= 0, `statement "${marker}" not found`);
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[") {
      depth++;
    } else if (c === ")" || c === "]") {
      depth--;
    } else if (c === ";" && depth === 0) {
      return code.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated statement "${marker}"`);
}

/** The `if (...) { ... }` block whose header starts at `from`. */
function ifBlockAt(code, from) {
  const start = code.indexOf("if (hasFlag(", from);
  assert.ok(start >= 0, "instancing branch not found");
  const { end } = braceBody(code, start);
  return code.slice(start, end);
}

/**
 * The current-frame clip statements and the previous-frame clip region, read
 * out of the shipped vertex stage.
 *
 * The previous-frame region deliberately runs from the end of the previous
 * skinning block to the end of the `output.previousClipPos` assignment, so it
 * captures BOTH defect sites — the instance-translation recombination and the
 * clip-position expression — whatever shape they are in.
 */
function velocityRegions(source) {
  const code = vertexBody(source);
  const currentInstancing = ifBlockAt(code, code.indexOf("var instTransHigh"));
  const currentRte = statementAt(code, "let rte =");
  const currentClip = statementAt(code, "output.currentClipPosForVelocity =");

  const previousClipIndex = code.indexOf("output.previousClipPos");
  assert.ok(previousClipIndex >= 0, "previous clip assignment not found");
  const previousSkinning = code.lastIndexOf(
    "if (hasFlag(material.materialFlags, FLAG_HAS_SKINNING))",
    previousClipIndex,
  );
  assert.ok(previousSkinning >= 0, "previous skinning block not found");
  const skinningEnd = braceBody(code, previousSkinning).end;
  const previousEnd =
    previousClipIndex +
    statementAt(code, "output.previousClipPos", previousClipIndex).length;

  return {
    current: `${currentInstancing}\n${currentRte}\n${currentClip}`,
    previous: code.slice(skinningEnd, previousEnd),
  };
}

// ── The static-scene scenario ───────────────────────────────────────────────

const INSTANCE_LINEAR = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const LOCAL_POSITION = [1.25, -0.5, 2.0];

function splitFloats(value) {
  // The same high/low split `EncodedCartesian3` produces, so the instance
  // translation the shader differences is the one the CPU would upload.
  const encoded = EncodedCartesian3.fromCartesian(
    new Cartesian3(value[0], value[1], value[2]),
    new EncodedCartesian3(),
  );
  return {
    high: [encoded.high.x, encoded.high.y, encoded.high.z, 0],
    low: [encoded.low.x, encoded.low.y, encoded.low.z, 0],
  };
}

function velocityEnvironment(packed, instanceWorld) {
  const split = splitFloats(instanceWorld);
  const inst = {
    linear: INSTANCE_LINEAR,
    translationHigh: split.high,
    translationLow: split.low,
  };
  const mat = (name) => {
    const base = wgslFloat(name);
    return [0, 1, 2, 3].map((c) =>
      [0, 1, 2, 3].map((r) => packed[base + c * 4 + r]),
    );
  };
  const vec3At = (name) => {
    const base = wgslFloat(name);
    return [packed[base], packed[base + 1], packed[base + 2]];
  };
  return {
    material: {
      materialFlags: namedWgslFlag("FLAG_HAS_INSTANCING"),
      modelMatrix: mat("mvpRelativeToEye"),
      previousModelMatrix: mat("mvpRelativeToEye"),
    },
    camera: {
      mvpRelativeToEye: mat("mvpRelativeToEye"),
      previousMvpRelativeToEye: mat("previousMvpRelativeToEye"),
      previousViewProjection: mat("previousViewProjection"),
      encodedCameraPositionMCHigh: vec3At("encodedCameraPositionMCHigh"),
      encodedCameraPositionMCLow: vec3At("encodedCameraPositionMCLow"),
      previousEncodedCameraPositionMCHigh: vec3At(
        "previousEncodedCameraPositionMCHigh",
      ),
      previousEncodedCameraPositionMCLow: vec3At(
        "previousEncodedCameraPositionMCLow",
      ),
    },
    input: { instanceIndex: 0 },
    instanceTransforms: [inst],
    previousInstanceTransforms: [inst],
    positionMC: LOCAL_POSITION.slice(),
    prevPositionMC: LOCAL_POSITION.slice(),
    normalMC: [0, 0, 1],
    tangentMC: [1, 0, 0, 1],
    FLAG_HAS_INSTANCING: namedWgslFlag("FLAG_HAS_INSTANCING"),
    output: {},
  };
}

function namedWgslFlag(name) {
  const m = new RegExp(`const\\s+${name}\\s*:\\s*u32\\s*=\\s*(\\d+)u`).exec(
    shaderSource,
  );
  assert.ok(m, `${name} not found in the shader`);
  return Number(m[1]);
}

/**
 * Run both clip-position blocks of `source` over a static instanced primitive
 * and return the two clip positions.
 */
function clipPositions(source, packed, instanceWorld) {
  const regions = velocityRegions(source);
  const env = velocityEnvironment(packed, instanceWorld);
  runStatements(regions.current, env);
  runStatements(regions.previous, env);
  assert.ok(env.output.currentClipPosForVelocity, "no current clip position");
  assert.ok(env.output.previousClipPos, "no previous clip position");
  return {
    current: env.output.currentClipPosForVelocity,
    previous: env.output.previousClipPos,
  };
}

const INSTANCE_WORLD = [6378137.0 + 431.5, 1234567.25, -987654.125];

const STATIC_PACK = pack({
  eye: EYE,
  previousEye: EYE,
  previousViewProjectionRTE: STATIC_PREV_VP_RTE,
  model: IDENTITY_MODEL,
  previousModel: IDENTITY_MODEL,
});

test("a static instanced primitive under a static camera emits exactly zero velocity", () => {
  const { current, previous } = clipPositions(
    shaderSource,
    STATIC_PACK,
    INSTANCE_WORLD,
  );
  assert.deepEqual(
    previous,
    current,
    `previous clip ${JSON.stringify(previous)} must equal current clip ${JSON.stringify(current)}`,
  );
});

test("a moved camera moves the previous clip position, so the static case is not vacuous", () => {
  const moved = pack({
    eye: MOVED_EYE,
    previousEye: EYE,
    previousViewProjectionRTE: STATIC_PREV_VP_RTE,
    model: IDENTITY_MODEL,
    previousModel: IDENTITY_MODEL,
  });
  const { current, previous } = clipPositions(
    shaderSource,
    moved,
    INSTANCE_WORLD,
  );
  assert.notDeepEqual(previous, current);
});

export { clipPositions, pack, velocityRegions, STATIC_PACK, INSTANCE_WORLD };
