// polyline-nearclip-wiring.spec.mjs — the WebGPU polyline near-plane clip law, EXECUTED out of its shipped WGSL.
//
// @purpose Runs the csm_polylineCommon.wgsl near-plane clip helpers (clip core, clipped point, eye-to-window, per-end selection, previous-frame point) and the six collection stages' toScreenSpace through the WGSL evaluator and asserts them against an independent JavaScript transcription of WebGL's PolylineCommon.glsl clipLineSegmentToNearPlane and czm_eyeToWindowCoordinates, in f64 and under per-operation f32 rounding. Group B imports the real WebGPUBufferPolylineRenderer.ts, packs five polylines and asserts the BufferPolyline stage's texCoord, expand direction and usePrevious round-trip to WebGL's values exactly.
// @status ACTIVE
//
// Pure Node, real engine frustum classes, no browser, no GPU:
//   node --test Tools/visual-regression/polyline-nearclip-wiring.spec.mjs
//   npm run test-visual-regression-node        # its registered runner home
//
// WHAT IS ASSERTED, AND WHY IT IS NOT A GREP
// ------------------------------------------
// WebGL clips each polyline segment to the near plane in eye space before it
// divides by clip w: an end behind the camera moves along its own segment onto
// the plane (eye z = -near). The WebGPU vertex stages divided with no such
// clip, so a polyline passing behind the camera drew a wedge from a w < 0
// vertex. The law now lives once, in pure helpers in csm_polylineCommon.wgsl,
// and every number below comes out of that shipped text, read by
// lib/wgsl-mini-eval.mjs.
//
// THE ORACLE is written from PolylineCommon.glsl (clipLineSegmentToNearPlane,
// :1-68) and eyeToWindowCoordinates.glsl, in GLSL operation order, and run
// twice: in f64 and with every operation result through Math.fround (the
// evaluator's own per-operation rounding). It is never derived from the WGSL.
//
// THE BOUNDS are absolute and scale with the input, because the clip cancels
// two values of size |p0| into one of size near: a planet-scale row has a
// clipped x of 0.1875 in f64 and 0.125 in f32 (about 62 px), so only the scaled
// bound is honest there. With m = max(|p0|, |p1|), f32 allows
// 8 * 2^-24 * m and f64 8 * 2^-53 * m; a window coordinate scales by the window
// magnitude. A diagnostic prints how much of each bound was used.
//
// THE GROUPS: P1 the clip core and clipped point against WebGL's flags and p0;
// P2 one clipped point through the chunk's eye-to-window step, every stage's
// toScreenSpace and czm_eyeToWindowCoordinates; P3 no divide by w <= 0; P4 an
// end in front keeps its historical clip position exactly; P5 the previous
// frame point of a clipped end; P6 per-end selection; E the clipped run's
// across-line coordinate, read screen-linear as WebGL reads v_st.t (rasterized
// out of the shipped write/read pair, with its own inertness image ME and E0,
// which reproduces Edge job 15b's measured fade); B the BufferPolyline
// buffer stage's texCoord, expand direction and usePrevious, round-tripped
// through the real repack, the declared vertex layout and the shipped
// bufferPolylineUsePrevious (with its own inertness images MB1-MB4); M
// one-substitution inertness images on a copy of the shipped text (never the
// file).

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";
import {
  compileFunction,
  mat4,
  readConstants,
  stripComments,
  vec,
  vec2,
  vec4,
} from "./lib/wgsl-mini-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const read = (relative) =>
  fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/gu, "\n");

const COLLECTIONS = "packages/engine/Source/Shaders/WebGPU/Collections";
const chunkWgsl = read(
  "packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_polylineCommon.wgsl",
);
const STAGES = [
  "PolylineCollection",
  "PolylineCollectionPick",
  "PolylineArrow",
  "PolylineDash",
  "PolylineGlow",
  "PolylineOutline",
];
const stageWgsl = Object.fromEntries(
  STAGES.map((name) => [name, read(`${COLLECTIONS}/${name}.wgsl`)]),
);

enableEngineTsResolution();

const engineModule = async (relative) =>
  (
    await import(
      pathToFileURL(path.join(root, "packages/engine/Source", relative)).href
    )
  ).default;

const Matrix3 = await engineModule("Core/Matrix3.js");
const Matrix4 = await engineModule("Core/Matrix4.js");
const Cartesian3 = await engineModule("Core/Cartesian3.js");
const PerspectiveFrustum = await engineModule("Core/PerspectiveFrustum.js");
const OrthographicFrustum = await engineModule("Core/OrthographicFrustum.js");
const ClipSpaceConvention = await engineModule("Core/ClipSpaceConvention.js");

// ═══════════════════════════════════════════════════════════════════════
// Precision: the two runs. f64 is the exact-arithmetic run; f32 rounds every
// operation result, which is the evaluator's `__round` hook and the oracle's
// own `R`.
// ═══════════════════════════════════════════════════════════════════════

const F64 = Object.freeze({ name: "f64", round: undefined, eps: 2 ** -53 });
const F32 = Object.freeze({ name: "f32", round: Math.fround, eps: 2 ** -24 });
const PRECISIONS = [F64, F32];
const roundOf = (prec) => prec.round ?? ((x) => x);

/** `8 * eps * magnitude`: the bound every comparison below is held to. */
const bound = (prec, magnitude) => 8 * prec.eps * magnitude;

/**
 * The largest delta / bound seen per precision and group, so a bound that is
 * loose by orders of magnitude shows in the test output instead of hiding.
 */
const MARGINS = new Map();

/**
 * Is a delta inside its bound? Records how much of the bound it used.
 *
 * @param {string} key Precision and group.
 * @param {number} delta The absolute difference.
 * @param {number} limit The bound.
 * @returns {boolean} True when delta <= limit (NaN is outside).
 */
function within(key, delta, limit) {
  const used = limit > 0 ? delta / limit : delta === 0 ? 0 : Infinity;
  if (!(MARGINS.get(key) >= used)) {
    MARGINS.set(key, used);
  }
  return delta <= limit;
}

const maxAbs = (...values) =>
  values.flat().reduce((a, b) => Math.max(a, Math.abs(b)), 0);

// ═══════════════════════════════════════════════════════════════════════
// The subject: helpers out of the shipped chunk, bound to each other.
// ═══════════════════════════════════════════════════════════════════════

const HELPERS = [
  "csm_polylineNearClipT",
  "csm_polylineNearClipPoint",
  "csm_polylineEyeToWindow",
  "csm_polylineClipEnd",
  "csm_polylinePreviousClip",
  "csm_polylineWriteScreenLinear",
  "csm_polylineReadScreenLinear",
];

/**
 * Compile the helpers out of a chunk text, each bound to the others.
 *
 * @param {string} source The chunk WGSL.
 * @param {object} prec F64 or F32.
 * @returns {object} Name to callable.
 */
function makeHelpers(source, prec) {
  const stripped = stripComments(source);
  const globals = {
    ...readConstants(stripped),
    __functions: {},
    ...(prec.round ? { __round: prec.round } : {}),
  };
  for (const name of HELPERS) {
    globals.__functions[name] = compileFunction(stripped, name, globals);
  }
  return globals.__functions;
}

/**
 * Each collection stage's own toScreenSpace, compiled from its file.
 *
 * @param {object} prec F64 or F32.
 * @returns {Object<string, Function>} Stage name to callable.
 */
function makeToScreenSpace(prec) {
  const out = {};
  for (const name of STAGES) {
    out[name] = compileFunction(
      stripComments(stageWgsl[name]),
      "toScreenSpace",
      {
        __functions: {},
        ...(prec.round ? { __round: prec.round } : {}),
      },
    );
  }
  return out;
}

/**
 * One test per precision: the violations function must come back empty over
 * helpers compiled for that precision.
 *
 * @param {string} title The test title.
 * @param {Function} violationsOf (helpers, prec) => string[].
 */
function eachPrecision(title, violationsOf) {
  for (const prec of PRECISIONS) {
    test(`${title} (${prec.name})`, () => {
      assert.deepEqual(violationsOf(makeHelpers(chunkWgsl, prec), prec), []);
    });
  }
}

/**
 * Replace text inside ONE function of a WGSL source and refuse if it did not
 * bite: a mutation image that matched nothing is a green test over unmutated
 * source.
 *
 * @param {string} source The WGSL.
 * @param {string} fnName The function the substitution is confined to.
 * @param {string} from What to replace.
 * @param {string} to The replacement.
 * @returns {string} The mutated WGSL.
 */
function mutateIn(source, fnName, from, to) {
  const start = source.indexOf(`fn ${fnName}(`);
  assert.notEqual(start, -1, `no fn ${fnName} in the source`);
  const next = source.indexOf("\nfn ", start + 1);
  const end = next === -1 ? source.length : next;
  const body = source.slice(start, end);
  const replaced = body.replace(from, to);
  assert.notEqual(replaced, body, `the mutation ${from} matched nothing`);
  return source.slice(0, start) + replaced + source.slice(end);
}

// ═══════════════════════════════════════════════════════════════════════
// The oracle: WebGL's clip and window law, from the GLSL, in operation order.
// ═══════════════════════════════════════════════════════════════════════

const CZM_EPSILON7 = 1.0e-7;

const glslDot = (a, b, R) =>
  R(R(R(a[0] * b[0]) + R(a[1] * b[1])) + R(a[2] * b[2]));
const glslLength = (v, R) => R(Math.sqrt(glslDot(v, v, R)));
const glslNormalize = (v, R) => {
  const length = glslLength(v, R);
  return v.map((lane) => R(lane / length));
};

/**
 * clipLineSegmentToNearPlane (PolylineCommon.glsl :1-68) with
 * czm_currentFrustum.x = near. status: 0 unclipped, 1 clipped, 2 culled.
 *
 * @param {number[]} p0In Segment start, eye space.
 * @param {number[]} p1In Segment end, eye space.
 * @param {number} nearIn The near plane distance.
 * @param {Function} R The per-operation rounding.
 * @returns {{status: number, point: number[], t: number, magnitude: number}}
 */
function oracleClip(p0In, p1In, nearIn, R) {
  const p0 = p0In.map(R);
  const p1 = p1In.map(R);
  const near = R(nearIn);
  const p0ToP1 = [R(p1[0] - p0[0]), R(p1[1] - p0[1]), R(p1[2] - p0[2])];
  const magnitude = glslLength(p0ToP1, R);
  const direction = glslNormalize(p0ToP1, R);
  const endPoint0Distance = R(near + p0[2]);
  const denominator = R(-direction[2]);
  let status = 0;
  let point = p0.slice();
  let t = 0;
  if (endPoint0Distance > 0 && Math.abs(denominator) < R(CZM_EPSILON7)) {
    status = 2;
  } else if (endPoint0Distance > 0) {
    t = R(endPoint0Distance / denominator);
    if (t < 0 || t > magnitude) {
      status = 2;
    } else {
      point = point.map((lane, i) => R(lane + R(t * direction[i])));
      point[2] = Math.min(point[2], -near);
      status = 1;
    }
  }
  return { status, point, t, magnitude };
}

/** Column-major mat4 times a 4-lane array; the evaluator's own convention. */
function matVec(m, v, R) {
  const out = [0, 0, 0, 0];
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[row] += m[column * 4 + row] * v[column];
    }
  }
  return out.map(R);
}

/**
 * czm_eyeToWindowCoordinates (eyeToWindowCoordinates.glsl :28-30).
 *
 * @returns {number[]} `[windowX, windowY, windowZ, clipW]`.
 */
function oracleWindow(pointEC, projection, viewportTransformation, R) {
  const q = matVec(projection, [...pointEC, 1], R);
  const ndc = [R(q[0] / q[3]), R(q[1] / q[3]), R(q[2] / q[3])];
  const win = matVec(viewportTransformation, [...ndc, 1], R);
  return [win[0], win[1], win[2], q[3]];
}

// ═══════════════════════════════════════════════════════════════════════
// Fixtures: ONE frustum, two clip-space conventions, one viewport.
// ═══════════════════════════════════════════════════════════════════════

const VIEWPORT = Object.freeze({ x: 0, y: 0, width: 1024, height: 768 });
const NEAR = 1.0;

const perspective = new PerspectiveFrustum({
  fov: Math.PI / 3,
  aspectRatio: VIEWPORT.width / VIEWPORT.height,
  near: NEAR,
  far: 1.0e7,
});
const orthographic = new OrthographicFrustum({
  width: 2000.0,
  aspectRatio: VIEWPORT.width / VIEWPORT.height,
  near: NEAR,
  far: 1.0e7,
});

const matrixOf = (frustum, convention) =>
  Array.from(frustum.getProjectionMatrix(convention));

const PROJECTIONS = Object.freeze({
  gpu: matrixOf(perspective, ClipSpaceConvention.WEBGPU),
  gl: matrixOf(perspective, ClipSpaceConvention.WEBGL),
  orthoGpu: matrixOf(orthographic, ClipSpaceConvention.WEBGPU),
  viewport: Array.from(
    Matrix4.computeViewportTransformation(VIEWPORT, 0.0, 1.0, new Matrix4()),
  ),
});

/** The matrices as one precision sees them. */
const asPrecision = (matrix, prec) => matrix.map(roundOf(prec));

// ═══════════════════════════════════════════════════════════════════════
// Rows. `status` is the expectation from the brief's table, pinned against
// the oracle first so the oracle is itself checked.
// ═══════════════════════════════════════════════════════════════════════

const row = (name, p0, p1, nearValue, status) => ({
  name,
  p0,
  p1,
  near: nearValue,
  status,
});

// The "nearly parallel" row is also culled by
// t < 0, so it cannot tell the parallel rule from its absence. The two rows after it are
// long enough that t fits inside the segment: |dir.z| = 3.2e-8 is under
// czm_epsilon7 and is culled by the parallel rule alone; |dir.z| = 2e-7 is over
// it and is clipped.
const ROWS = [
  row("crossing", [0, -5, 200], [0, -5, -2000], 1, 1),
  row("p0 in front", [0, -5, -200], [0, -5, -2000], 1, 0),
  row("both behind", [0, -5, 200], [0, -5, 100], 1, 2),
  row("p0 on the plane", [0, -5, -1], [0, -5, -2000], 1, 0),
  row("nearly parallel", [0, 0, 5], [1000, 0, 5.00001], 1, 2),
  row(
    "nearly parallel with t inside the segment",
    [0, 0, 2],
    [1e9, 0, -30],
    1,
    2,
  ),
  row("just outside the parallel limit", [0, 0, 2], [1e9, 0, -198], 1, 1),
  row("t beyond the segment", [0, 0, 10], [0, 0, 5], 1, 2),
  row("moving away", [0, 0, 10], [0, 0, 20], 1, 2),
  row("zero length in front", [3, 4, -20], [3, 4, -20], 1, 0),
  row("100 m", [12.5, -3.25, 40], [-30, 7, -60], 0.5, 1),
  row("10 km", [1234.5, -987.25, 3000], [-4000, 2500, -7000], 1, 1),
  row("planet scale", [3.1e6, -1.2e6, 2.5e6], [-2.9e6, 1.4e6, -3.6e6], 1, 1),
];

const rowMagnitude = (row, R) => maxAbs(row.p0.map(R), row.p1.map(R));

/** A seeded sweep, so a flaky comparison is a reproducible one. */
function sweepRows(count) {
  let seed = 0x2f6e2b1;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const scale = 10 ** (1 + next() * 5);
    const point = () => [
      (next() * 2 - 1) * scale,
      (next() * 2 - 1) * scale,
      (next() * 2 - 1) * scale,
    ];
    rows.push({
      name: `sweep ${i}`,
      p0: point(),
      p1: point(),
      near: [0.1, 1, 2.5][i % 3],
      status: null,
    });
  }
  return rows;
}
const SWEEP = sweepRows(400);

const near = (row) => row.near;
const vec3Of = (lanes, R) => vec(...lanes.map(R));

/** What the subject says for one row: status, t, and the clipped p0. */
function subjectClip(h, row, prec) {
  const R = roundOf(prec);
  const p0 = vec3Of(row.p0, R);
  const p1 = vec3Of(row.p1, R);
  const ts = h.csm_polylineNearClipT(p0, p1, R(near(row)));
  const point = h.csm_polylineNearClipPoint(p0, p1, R(near(row)), ts.x, ts.y);
  return { t: ts.x, status: ts.y, point: [point.x, point.y, point.z] };
}

// ═══════════════════════════════════════════════════════════════════════
// P1 — the clip law
// ═══════════════════════════════════════════════════════════════════════

/**
 * @param {object} h The helpers.
 * @param {object} prec F64 or F32.
 * @param {Array} rows The rows.
 * @returns {string[]} Violations; empty when the helpers behave.
 */
function p1Violations(h, prec, rows = [...ROWS, ...SWEEP]) {
  const R = roundOf(prec);
  const violations = [];
  for (const row of rows) {
    const label = `${prec.name} ${row.name}`;
    const want = oracleClip(row.p0, row.p1, near(row), R);
    const got = subjectClip(h, row, prec);
    const m = rowMagnitude(row, R);
    if (got.status !== want.status) {
      violations.push(
        `${label}: status ${got.status}, WebGL's flags say ${want.status}`,
      );
      continue;
    }
    const p0 = row.p0.map(R);
    if (want.status !== 1) {
      if (!got.point.every((lane, i) => Object.is(lane, p0[i]))) {
        violations.push(
          `${label}: p0 must come back exactly, got (${got.point})`,
        );
      }
      if (want.status === 0 && got.t !== 0) {
        violations.push(`${label}: t must be 0 in front, got ${got.t}`);
      }
      continue;
    }
    got.point.forEach((lane, i) => {
      const delta = Math.abs(lane - want.point[i]);
      if (!within(`${prec.name} P1`, delta, bound(prec, m))) {
        violations.push(
          `${label}: clipped lane ${i} is ${lane}, WebGL's is ${want.point[i]} (delta ${delta} > ${bound(prec, m)})`,
        );
      }
    });
    if (!(got.point[2] <= -R(near(row)))) {
      violations.push(
        `${label}: clipped z ${got.point[2]} is in front of -near ${-near(row)}`,
      );
    }
    if (!within(`${prec.name} P1`, Math.abs(got.t - want.t), bound(prec, m))) {
      violations.push(`${label}: t ${got.t} is not WebGL's ${want.t}`);
    }
  }
  return violations;
}

test("P1 oracle: the transcription reproduces the brief's table, in f64 and f32", () => {
  for (const prec of PRECISIONS) {
    for (const row of ROWS) {
      const want = oracleClip(row.p0, row.p1, near(row), roundOf(prec));
      assert.equal(want.status, row.status, `${prec.name} ${row.name}`);
    }
  }
  // Literal pins that do not depend on any code: the crossing row's t is the
  // distance 201 along the unit direction and its clipped end is (0, -5, -1).
  const crossing = oracleClip([0, -5, 200], [0, -5, -2000], 1, (x) => x);
  assert.ok(Math.abs(crossing.t - 201) < 1e-9, `t ${crossing.t}`);
  assert.deepEqual(
    crossing.point.map((lane) => Math.round(lane * 1e9) / 1e9),
    [0, -5, -1],
  );
});

eachPrecision(
  "P1: status equals WebGL's flags and the clipped end equals its p0 within the scaled bound",
  p1Violations,
);

test("P1: the literal rows, so the oracle is not the only referee", () => {
  const h = makeHelpers(chunkWgsl, F64);
  const crossing = subjectClip(h, ROWS[0], F64);
  assert.equal(crossing.status, 1);
  assert.ok(Math.abs(crossing.t - 201) < 1e-9, `t ${crossing.t}`);
  assert.ok(Math.abs(crossing.point[0]) < 1e-9, `x ${crossing.point[0]}`);
  assert.ok(Math.abs(crossing.point[1] + 5) < 1e-9, `y ${crossing.point[1]}`);
  assert.ok(Math.abs(crossing.point[2] + 1) < 1e-9, `z ${crossing.point[2]}`);
  for (const name of [
    "both behind",
    "nearly parallel",
    "nearly parallel with t inside the segment",
    "t beyond the segment",
    "moving away",
  ]) {
    const row = ROWS.find((r) => r.name === name);
    assert.equal(subjectClip(h, row, F64).status, 2, name);
  }
  for (const name of [
    "p0 in front",
    "p0 on the plane",
    "zero length in front",
  ]) {
    const row = ROWS.find((r) => r.name === name);
    const got = subjectClip(h, row, F64);
    assert.equal(got.status, 0, name);
    assert.equal(got.t, 0, name);
    assert.deepEqual(got.point, row.p0, `${name} must return p0 exactly`);
  }
});

test("P1: the sweep exercises every status, so a one-sided mutant cannot hide in it", () => {
  const seen = new Set();
  for (const row of SWEEP) {
    seen.add(oracleClip(row.p0, row.p1, near(row), (x) => x).status);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2]);
});

// ═══════════════════════════════════════════════════════════════════════
// P2 — window parity
// ═══════════════════════════════════════════════════════════════════════

/** The rows whose end survives the clip (the oracle decides). */
const visibleRows = (prec, rows) =>
  rows.filter(
    (row) => oracleClip(row.p0, row.p1, near(row), roundOf(prec)).status !== 2,
  );

/**
 * @param {object} h The helpers.
 * @param {object} prec F64 or F32.
 * @returns {string[]} Violations.
 */
function p2Violations(h, prec) {
  const R = roundOf(prec);
  const violations = [];
  const gpu = asPrecision(PROJECTIONS.gpu, prec);
  const gl = asPrecision(PROJECTIONS.gl, prec);
  const viewport = asPrecision(PROJECTIONS.viewport, prec);
  const screens = makeToScreenSpace(prec);
  const pmax = maxAbs(gpu);
  for (const row of visibleRows(prec, ROWS)) {
    const label = `${prec.name} ${row.name}`;
    const clippedOracle = oracleClip(row.p0, row.p1, near(row), R);
    const point = clippedOracle.point;
    const want = oracleWindow(point, gl, viewport, R);
    const wm = Math.max(Math.abs(want[0]), Math.abs(want[1]), VIEWPORT.width);

    // (i) the chunk's eye-to-window step.
    const got = h.csm_polylineEyeToWindow(
      vec4(...point, 1),
      mat4(gpu),
      mat4(viewport),
    );
    for (const [lane, value] of [
      ["x", got.x],
      ["y", got.y],
    ]) {
      const expected = want[lane === "x" ? 0 : 1];
      if (
        !within(`${prec.name} P2`, Math.abs(value - expected), bound(prec, wm))
      ) {
        violations.push(
          `${label}: eye-to-window ${lane} ${value} vs WebGL's ${expected} (bound ${bound(prec, wm)})`,
        );
      }
    }
    // Raw WebGPU ndc z equals WebGL's window z under the 0.5 * ndc + 0.5 remap.
    if (
      !within(
        `${prec.name} P2 z`,
        Math.abs(got.z - want[2]),
        bound(prec, Math.max(1, Math.abs(want[2]))),
      )
    ) {
      violations.push(
        `${label}: window z ${got.z} vs WebGL's remapped ${want[2]}`,
      );
    }
    // w is the clip w of the clipped point.
    const clipGpu = matVec(gpu, [...point, 1], R);
    if (
      !within(
        `${prec.name} P2 w`,
        Math.abs(got.w - clipGpu[3]),
        bound(prec, Math.abs(clipGpu[3])),
      )
    ) {
      violations.push(
        `${label}: window w ${got.w} is not the clip w ${clipGpu[3]}`,
      );
    }

    // (ii) every collection stage's toScreenSpace over projection * point.
    for (const stage of STAGES) {
      const screen = screens[stage](
        vec4(...clipGpu),
        vec2(VIEWPORT.width, VIEWPORT.height),
      );
      for (const [lane, value, expected] of [
        ["x", screen.x, want[0]],
        ["y", screen.y, want[1]],
      ]) {
        if (
          !within(
            `${prec.name} P2`,
            Math.abs(value - expected),
            bound(prec, wm),
          )
        ) {
          violations.push(
            `${label}: ${stage} toScreenSpace ${lane} ${value} vs WebGL's ${expected}`,
          );
        }
      }
    }

    // The subject's OWN chain (clip core, then clipped point) lands on the
    // same point, held in clip space where the projection does not amplify the
    // cancellation the bound already accounts for.
    const chain = subjectClip(h, row, prec);
    const chainClip = matVec(gpu, [...chain.point, 1], R);
    const m = rowMagnitude(row, R);
    const scale = m * pmax + maxAbs(clipGpu);
    chainClip.forEach((lane, i) => {
      if (
        !within(
          `${prec.name} P2 chain`,
          Math.abs(lane - clipGpu[i]),
          bound(prec, scale),
        )
      ) {
        violations.push(
          `${label}: the clip chain's clip lane ${i} is ${lane}, the oracle point's is ${clipGpu[i]}`,
        );
      }
    });
  }
  return violations;
}

eachPrecision(
  "P2: one clipped point lands on the same window pixel through the chunk, every stage's toScreenSpace and czm_eyeToWindowCoordinates",
  p2Violations,
);

test("P2: window parity is not vacuous - a different point lands elsewhere", () => {
  const h = makeHelpers(chunkWgsl, F64);
  const gpu = PROJECTIONS.gpu;
  const a = h.csm_polylineEyeToWindow(
    vec4(0, -5, -1, 1),
    mat4(gpu),
    mat4(PROJECTIONS.viewport),
  );
  const b = h.csm_polylineEyeToWindow(
    vec4(0, -5, -2, 1),
    mat4(gpu),
    mat4(PROJECTIONS.viewport),
  );
  assert.ok(Math.abs(a.y - b.y) > 1, `${a.y} vs ${b.y}`);
});

// ═══════════════════════════════════════════════════════════════════════
// P3 / P4 / P6 — per-end selection through csm_polylineClipEnd
// ═══════════════════════════════════════════════════════════════════════

const HISTORICAL = [9, -8, 7, 6];

/** Call csm_polylineClipEnd the way a stage does. */
function clipEnd(h, own, other, nearValue, projection, historical, prec) {
  const R = roundOf(prec);
  return h.csm_polylineClipEnd(
    vec3Of(own, R),
    vec3Of(other, R),
    R(nearValue),
    mat4(projection),
    vec4(...historical.map(R)),
  );
}

const lanesOf = (v) => [v.x, v.y, v.z, v.w];

/**
 * P3: nothing is divided by a w <= 0.
 *
 * @param {object} h The helpers.
 * @param {object} prec F64 or F32.
 * @returns {string[]} Violations.
 */
function p3Violations(h, prec) {
  const R = roundOf(prec);
  const violations = [];
  const cases = [
    ["perspective", asPrecision(PROJECTIONS.gpu, prec), true],
    ["orthographic", asPrecision(PROJECTIONS.orthoGpu, prec), false],
  ];
  for (const [kind, projection, isPerspective] of cases) {
    for (const row of visibleRows(prec, ROWS)) {
      // The historical position is the unclipped projection of the end, as a
      // stage computes it.
      const historical = matVec(projection, [...row.p0.map(R), 1], R);
      const out = lanesOf(
        clipEnd(h, row.p0, row.p1, near(row), projection, historical, prec),
      );
      const label = `${prec.name} ${kind} ${row.name}`;
      const w = out[3];
      if (!(w > 0)) {
        violations.push(`${label}: clip w ${w} is not positive`);
      }
      if (isPerspective && !(w >= near(row) - bound(prec, near(row)))) {
        violations.push(`${label}: clip w ${w} is under near ${near(row)}`);
      }
      if (
        !isPerspective &&
        !within(`${prec.name} P3`, Math.abs(w - 1), bound(prec, 1))
      ) {
        violations.push(`${label}: orthographic clip w ${w} is not 1`);
      }
      const win = h.csm_polylineEyeToWindow(
        vec4(...subjectClip(h, row, prec).point, 1),
        mat4(projection),
        mat4(asPrecision(PROJECTIONS.viewport, prec)),
      );
      if (!(win.w > 0)) {
        violations.push(`${label}: eye-to-window w ${win.w} is not positive`);
      }
    }
  }
  return violations;
}

eachPrecision(
  "P3: no end that is not culled reaches a divide with clip w <= 0, and perspective w >= near",
  p3Violations,
);

/**
 * P4: an end in front keeps its historical clip position EXACTLY.
 *
 * @param {object} h The helpers.
 * @param {object} prec F64 or F32.
 * @returns {string[]} Violations.
 */
function p4Violations(h, prec) {
  const R = roundOf(prec);
  const violations = [];
  const projection = asPrecision(PROJECTIONS.gpu, prec);
  for (const name of [
    "p0 in front",
    "p0 on the plane",
    "zero length in front",
  ]) {
    const row = ROWS.find((r) => r.name === name);
    const label = `${prec.name} ${name}`;
    const clip = subjectClip(h, row, prec);
    if (clip.status !== 0 || clip.t !== 0) {
      violations.push(`${label}: status ${clip.status}, t ${clip.t}`);
    }
    const out = lanesOf(
      clipEnd(h, row.p0, row.p1, near(row), projection, HISTORICAL, prec),
    );
    if (!out.every((lane, i) => Object.is(lane, R(HISTORICAL[i])))) {
      violations.push(`${label}: ${out} is not the historical ${HISTORICAL}`);
    }
  }
  return violations;
}

eachPrecision(
  "P4: an end in front returns its historical clip position exactly",
  p4Violations,
);

const p6 = (name, own, other, kind) => ({ name, own, other, kind });
const P6_ROWS = [
  p6("start behind", [0, -5, 200], [0, -5, -2000], "clip"),
  p6("end behind", [0, -5, 150], [0, -5, -800], "clip"),
  p6(
    "other end of a start-behind segment",
    [0, -5, -2000],
    [0, -5, 200],
    "historical",
  ),
  p6("culled", [0, -5, 200], [0, -5, 100], "culled"),
];

/**
 * P6: per-end selection.
 *
 * @param {object} h The helpers.
 * @param {object} prec F64 or F32.
 * @returns {string[]} Violations.
 */
function p6Violations(h, prec) {
  const R = roundOf(prec);
  const violations = [];
  const projection = asPrecision(PROJECTIONS.gpu, prec);
  const pmax = maxAbs(projection);
  for (const row of P6_ROWS) {
    const label = `${prec.name} ${row.name}`;
    const out = lanesOf(
      clipEnd(h, row.own, row.other, NEAR, projection, HISTORICAL, prec),
    );
    if (row.kind === "historical") {
      if (!out.every((lane, i) => Object.is(lane, R(HISTORICAL[i])))) {
        violations.push(`${label}: ${out} is not the historical ${HISTORICAL}`);
      }
    } else if (row.kind === "culled") {
      if (!out.every((lane, i) => Object.is(lane, [0, 0, 0, 1][i]))) {
        violations.push(`${label}: ${out} is not (0, 0, 0, 1)`);
      }
    } else {
      const clipped = oracleClip(row.own, row.other, NEAR, R);
      if (clipped.status !== 1) {
        violations.push(`${label}: the oracle row is not a crossing`);
        continue;
      }
      const want = matVec(projection, [...clipped.point, 1], R);
      const m = maxAbs(row.own, row.other);
      const scale = m * pmax + maxAbs(want);
      out.forEach((lane, i) => {
        if (
          !within(
            `${prec.name} P6`,
            Math.abs(lane - want[i]),
            bound(prec, scale),
          )
        ) {
          violations.push(
            `${label}: lane ${i} is ${lane}, projection * WebGL's clipped end is ${want[i]}`,
          );
        }
      });
      // The clipped end sits on the near plane: clip w is near.
      if (
        !within(
          `${prec.name} P6 w`,
          Math.abs(out[3] - NEAR),
          bound(prec, scale),
        )
      ) {
        violations.push(`${label}: clip w ${out[3]} is not near ${NEAR}`);
      }
    }
  }
  return violations;
}

eachPrecision(
  "P6: historical in front, projection * clipped end when crossing, (0,0,0,1) when culled",
  p6Violations,
);

// ═══════════════════════════════════════════════════════════════════════
// P5 — the previous-frame point of a clipped end
// ═══════════════════════════════════════════════════════════════════════

/** A previous-frame matrix: the WebGPU projection after a small move. */
const PREVIOUS = (() => {
  const move = Matrix4.fromRotationTranslation(
    Matrix3.fromRotationZ(0.01),
    new Cartesian3(0.5, -0.25, 0.75),
    new Matrix4(),
  );
  return Array.from(
    Matrix4.multiply(
      Matrix4.fromArray(PROJECTIONS.gpu, 0, new Matrix4()),
      move,
      new Matrix4(),
    ),
  );
})();

const P5_ROWS = [
  { name: "start behind", own: [0, -5, 200], other: [0, -5, -2000] },
  { name: "end behind", own: [0, -5, 150], other: [0, -5, -800] },
  { name: "oblique start behind", own: [30, 12, 90], other: [-45, 3, -400] },
  { name: "own in front", own: [0, -5, -200], other: [0, -5, -2000] },
  { name: "zero length in front", own: [3, 4, -20], other: [3, 4, -20] },
  { name: "culled", own: [0, -5, 200], other: [0, -5, 100] },
];

/**
 * P5b: csm_polylinePreviousClip equals M * (the WebGL-clipped world point).
 *
 * @param {object} h The helpers.
 * @param {object} prec F64 or F32.
 * @returns {string[]} Violations.
 */
function p5Violations(h, prec) {
  const R = roundOf(prec);
  const violations = [];
  const previous = asPrecision(PREVIOUS, prec);
  const mmax = maxAbs(previous);
  for (const row of P5_ROWS) {
    const label = `${prec.name} ${row.name}`;
    const own = row.own.map(R);
    const other = row.other.map(R);
    const prevOwn = matVec(previous, [...own, 1], R);
    const prevOther = matVec(previous, [...other, 1], R);
    const ts = h.csm_polylineNearClipT(
      vec3Of(own, R),
      vec3Of(other, R),
      R(NEAR),
    );
    const magnitude = glslLength(
      [R(other[0] - own[0]), R(other[1] - own[1]), R(other[2] - own[2])],
      R,
    );
    const out = lanesOf(
      h.csm_polylinePreviousClip(
        vec4(...prevOwn),
        vec4(...prevOther),
        ts.x,
        R(magnitude),
        ts.y,
      ),
    );
    const oracle = oracleClip(own, other, NEAR, R);
    if (!out.every((lane) => Number.isFinite(lane))) {
      violations.push(`${label}: a non-finite lane leaked: ${out}`);
      continue;
    }
    if (oracle.status === 1) {
      const want = matVec(previous, [...oracle.point, 1], R);
      const m = maxAbs(own, other);
      const scale = m * mmax + maxAbs(want, prevOwn);
      out.forEach((lane, i) => {
        if (
          !within(
            `${prec.name} P5`,
            Math.abs(lane - want[i]),
            bound(prec, scale),
          )
        ) {
          violations.push(
            `${label}: lane ${i} is ${lane}, M * WebGL's clipped end is ${want[i]}`,
          );
        }
      });
    } else if (!out.every((lane, i) => Object.is(lane, prevOwn[i]))) {
      violations.push(`${label}: ${out} is not prevOwn ${prevOwn} exactly`);
    }
  }
  return violations;
}

eachPrecision(
  "P5: the previous point of a clipped end is the previous position of the same world point, and an unclipped end keeps its own",
  p5Violations,
);

test("P5: the previous point actually moves a clipped end (the group is not vacuous)", () => {
  const h = makeHelpers(chunkWgsl, F64);
  const own = [0, -5, 200];
  const other = [0, -5, -2000];
  const prevOwn = matVec(PREVIOUS, [...own, 1], (x) => x);
  const prevOther = matVec(PREVIOUS, [...other, 1], (x) => x);
  const ts = h.csm_polylineNearClipT(vec(...own), vec(...other), NEAR);
  const out = h.csm_polylinePreviousClip(
    vec4(...prevOwn),
    vec4(...prevOther),
    ts.x,
    2200.0 + 0.0000001,
    ts.y,
  );
  assert.ok(Math.abs(out.z - prevOwn[2]) > 1e-3, "a clipped end must move");
});

test("margins: report how much of each bound the shipped helpers used", (t) => {
  for (const [key, used] of [...MARGINS].sort()) {
    t.diagnostic(`${key}: ${used.toExponential(2)} of the bound`);
  }
  assert.ok(MARGINS.size > 0, "no comparison recorded a margin");
});

// ═══════════════════════════════════════════════════════════════════════
// E — the clipped run's across-line coordinate (Edge job 15b, cell N1)
// ═══════════════════════════════════════════════════════════════════════
//
// WebGL writes the across-line coordinate as
// v_st.t = czm_writeNonPerspective(clamp(expandDir, 0.0, 1.0), gl_Position.w)
// (PolylineVS.glsl:98) and reads it back with czm_readNonPerspective(v_st.t,
// gl_FragCoord.w) (PolylineFS.glsl:12): the coordinate is interpolated
// linearly in SCREEN space, whatever the w of the two ends. A colour polyline
// clipped at the near plane therefore draws a band of constant width and full
// colour from the far end to the bottom edge (job 15b: 10 px, mean R 217, on
// every row). The collection stages fade the edge on that coordinate
// (PolylineCollection, Dash and Outline: alpha = 1 - smoothstep(0.8, 1.0,
// |side|), discarded under 0.005), so it must reach the fragment stage
// screen-linear too; the clip gives one end a w of about `near` and the other
// the segment's far distance, which is where perspective interpolation and
// screen-linear interpolation part.
//
// THE MODEL. The quad is the collection stage's: two ends from
// csm_polylineClipEnd and the stage's own toScreenSpace (both out of the
// shipped text), offset by +-halfWidth across the line, each vertex carrying
// its end's clip w, triangulated as vertexMain's index table (0..5 ->
// (isEnd, side) = (0,-1) (1,-1) (1,1) (0,-1) (1,1) (0,1)). Each vertex writes
// csm_polylineWriteScreenLinear(side, w) out of the shipped chunk; the
// rasterizer is WebGPU's default perspective interpolation (attribute =
// sum(b_i a_i / w_i) / sum(b_i / w_i) over the screen barycentrics b_i of the
// pixel centre), rounded to the precision under test; the fragment reads
// csm_polylineReadScreenLinear out of the shipped chunk. THE ORACLE is
// WebGL's law: the screen-linear sum(b_i side_i). The scene is the
// polyline-nearclip rig's red line in eye space: 5 m below the eye, from
// 200 m behind it to 2 km ahead, width 8 at pixel ratio 1 (halfWidth 4.5).
// The fragment stages of Dash, Outline, Arrow and Glow read the same pair
// (Arrow and Glow through st.t); only the chunk's two helpers run here.

const EDGE = Object.freeze({
  own: [0, -5, 200],
  other: [0, -5, -2000],
  halfWidth: 8 * 0.5 + 0.5,
  rows: { first: 390, last: 767 },
  meanAlphaMin: 217 / 255,
  widthMin: 8,
  sideBound: 1.0e-4,
});
const QUAD = [
  [0, -1],
  [1, -1],
  [1, 1],
  [0, -1],
  [1, 1],
  [0, 1],
];

/**
 * The stage's edge alpha law (PolylineCollection.wgsl fragmentMain).
 *
 * @param {number} side The across-line coordinate the fragment reads.
 * @returns {number} The alpha factor.
 */
function edgeAlpha(side) {
  const x = Math.min(Math.max((Math.abs(side) - 0.8) / 0.2, 0), 1);
  return 1 - x * x * (3 - 2 * x);
}

/**
 * Rasterize the clipped quad and read every covered pixel of the rows.
 *
 * @param {object} h The helpers (shipped chunk, or a mutation image).
 * @param {object} prec F64 or F32.
 * @returns {Map<number, {subject: number[], oracle: number[]}>} Per
 *   top-down row, the side each covered pixel reads and WebGL's side.
 */
function rasterizeEdge(h, prec) {
  const R = roundOf(prec);
  const gpu = asPrecision(PROJECTIONS.gpu, prec);
  const toScreen = makeToScreenSpace(prec).PolylineCollection;
  const size = vec2(VIEWPORT.width, VIEWPORT.height);
  const ends = [
    [EDGE.own, EDGE.other],
    [EDGE.other, EDGE.own],
  ].map(([own, other]) => {
    const historical = matVec(gpu, [...own.map(R), 1], R);
    const clip = clipEnd(h, own, other, NEAR, gpu, historical, prec);
    const screen = toScreen(clip, size);
    return { x: screen.x, y: screen.y, w: clip.w };
  });
  const dx = ends[1].x - ends[0].x;
  const dy = ends[1].y - ends[0].y;
  const length = Math.hypot(dx, dy);
  const normal = [-dy / length, dx / length];
  const vertices = QUAD.map(([isEnd, side]) => {
    const end = ends[isEnd];
    const written = h.csm_polylineWriteScreenLinear(R(side), end.w);
    return {
      x: end.x + normal[0] * side * EDGE.halfWidth,
      y: end.y + normal[1] * side * EDGE.halfWidth,
      w: end.w,
      side,
      written: [written.x, written.y],
    };
  });
  const triangles = [vertices.slice(0, 3), vertices.slice(3, 6)];
  const xs = vertices.map((v) => v.x);
  const rows = new Map();
  for (let top = EDGE.rows.first; top <= EDGE.rows.last; top += 1) {
    const y = VIEWPORT.height - top - 0.5;
    const subject = [];
    const oracle = [];
    const left = Math.floor(Math.min(...xs));
    const right = Math.ceil(Math.max(...xs));
    for (let px = left; px <= right; px += 1) {
      const x = px + 0.5;
      for (const tri of triangles) {
        const [a, b, c] = tri;
        const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
        const b0 = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / d;
        const b1 = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / d;
        const bs = [b0, b1, 1 - b0 - b1];
        if (bs.some((v) => v < 0)) {
          continue;
        }
        const weight = tri.reduce((s, v, i) => s + bs[i] / v.w, 0);
        const lane = (k) =>
          R(
            tri.reduce((s, v, i) => s + (bs[i] * v.written[k]) / v.w, 0) /
              weight,
          );
        subject.push(h.csm_polylineReadScreenLinear(vec2(lane(0), lane(1))));
        oracle.push(tri.reduce((s, v, i) => s + bs[i] * v.side, 0));
        break;
      }
    }
    rows.set(top, { subject, oracle });
  }
  return rows;
}

/**
 * Width (covered pixels the stage keeps) and mean alpha of one row.
 *
 * @param {number[]} sides The side each covered pixel reads.
 * @returns {{width: number, meanAlpha: number}} The row's reading.
 */
function rowReading(sides) {
  const kept = sides.map(edgeAlpha).filter((alpha) => alpha >= 0.005);
  const mean = kept.length ? kept.reduce((s, a) => s + a, 0) / kept.length : 0;
  return { width: kept.length, meanAlpha: mean };
}

/**
 * E: every row of the clipped run reads WebGL's screen-linear side, keeps
 * the width of the row at the far end, at least EDGE.widthMin pixels, and
 * a mean alpha of at least WebGL's measured 217 / 255.
 *
 * @param {object} h The helpers.
 * @param {object} prec F64 or F32.
 * @returns {string[]} Violations.
 */
function eViolations(h, prec) {
  const violations = [];
  const rows = rasterizeEdge(h, prec);
  const reference = rowReading(rows.get(EDGE.rows.first).oracle).width;
  for (const [top, { subject, oracle }] of rows) {
    const label = `${prec.name} row ${top}`;
    const worst = subject.reduce(
      (m, side, i) => Math.max(m, Math.abs(side - oracle[i])),
      0,
    );
    if (!within(`${prec.name} E`, worst, EDGE.sideBound)) {
      violations.push(
        `${label}: side off WebGL's screen-linear side by ${worst}`,
      );
    }
    const { width, meanAlpha } = rowReading(subject);
    if (width < EDGE.widthMin || width !== reference) {
      violations.push(`${label}: width ${width} px (far end ${reference})`);
    }
    if (!(meanAlpha >= EDGE.meanAlphaMin)) {
      violations.push(
        `${label}: mean R ${Math.round(255 * meanAlpha)} under 217`,
      );
    }
  }
  return violations;
}

eachPrecision(
  "E: the clipped run keeps a constant width and full colour to the near edge, reading WebGL's screen-linear side",
  eViolations,
);

test("E: the group is not vacuous - every row is covered, one end is clipped, and the two ends' w differ by over 100x", () => {
  for (const prec of PRECISIONS) {
    const h = makeHelpers(chunkWgsl, prec);
    const rows = rasterizeEdge(h, prec);
    assert.equal(rows.size, EDGE.rows.last - EDGE.rows.first + 1);
    for (const [top, { oracle }] of rows) {
      assert.ok(oracle.length >= EDGE.widthMin, `${prec.name} row ${top}`);
    }
    const gpu = asPrecision(PROJECTIONS.gpu, prec);
    const R = roundOf(prec);
    const wOf = (own, other) =>
      clipEnd(
        h,
        own,
        other,
        NEAR,
        gpu,
        matVec(gpu, [...own.map(R), 1], R),
        prec,
      ).w;
    const nearW = wOf(EDGE.own, EDGE.other);
    const farW = wOf(EDGE.other, EDGE.own);
    assert.ok(
      Math.abs(nearW - NEAR) < 1.0e-3,
      `${prec.name} clipped w ${nearW}`,
    );
    assert.ok(farW / nearW > 100, `${prec.name} w ratio ${farW / nearW}`);
  }
});

/**
 * The pre-fix varying: the side written raw and interpolated with
 * perspective, on a copy of the shipped chunk.
 *
 * @returns {string} The mutated chunk text.
 */
const preFixEdgeImage = () =>
  mutateIn(
    chunkWgsl,
    "csm_polylineWriteScreenLinear",
    "vec2<f32>(value * clipW, clipW)",
    "vec2<f32>(value, 1.0)",
  );

test("E0: the pre-fix varying reproduces job 15b's measured fade (mean R 42 / 13 / 2 at y 432 / 480 / 720, 2 px wide at y 720)", (t) => {
  const image = preFixEdgeImage();
  for (const prec of PRECISIONS) {
    const rows = rasterizeEdge(makeHelpers(image, prec), prec);
    const at = (top) => rowReading(rows.get(top).subject);
    const r = (top) => Math.round(255 * at(top).meanAlpha);
    t.diagnostic(
      `${prec.name} pre-fix model: mean R ${r(432)} / ${r(480)} / ${r(576)} / ${r(720)} at y 432 / 480 / 576 / 720; width ${at(432).width} / ${at(720).width} px at y 432 / 720`,
    );
    assert.ok(r(432) >= 30 && r(432) <= 55, `${prec.name} y 432 R ${r(432)}`);
    assert.ok(r(480) >= 8 && r(480) <= 20, `${prec.name} y 480 R ${r(480)}`);
    assert.ok(r(720) <= 5, `${prec.name} y 720 R ${r(720)}`);
    assert.ok(at(720).width <= 4, `${prec.name} y 720 width ${at(720).width}`);
  }
});

test("ME: with the side written raw (the pre-fix varying), E goes RED down to the near edge", () => {
  const image = preFixEdgeImage();
  for (const prec of PRECISIONS) {
    const h = makeHelpers(image, prec);
    const violations = eViolations(h, prec);
    assert.ok(
      violations.some((v) => v.includes("row 720:") && v.includes("mean R")),
      `${prec.name}: the colour clause stayed green at y 720`,
    );
    assert.ok(
      violations.some((v) => v.includes("row 720:") && v.includes("width")),
      `${prec.name}: the width clause stayed green at y 720`,
    );
    assert.ok(
      violations.some((v) => v.includes("screen-linear side")),
      `${prec.name}: the side clause stayed green`,
    );
    // The clip itself is untouched by this image.
    assert.deepEqual(p6Violations(h, prec), []);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M — inertness images
// ═══════════════════════════════════════════════════════════════════════

test("M1: with the clip core's in-front guard always true, P1, P2 and P3 go RED", () => {
  const image = mutateIn(
    chunkWgsl,
    "csm_polylineNearClipT",
    "if (endPoint0Distance <= 0.0) {",
    "if (endPoint0Distance <= 1.0e38) {",
  );
  for (const prec of PRECISIONS) {
    const h = makeHelpers(image, prec);
    const p1 = p1Violations(h, prec);
    assert.ok(
      p1.some((v) => v.includes("crossing")),
      `${prec.name}: P1 stayed green on the crossing row`,
    );
    assert.ok(
      p1.some((v) => v.includes("both behind")),
      `${prec.name}: P1 stayed green on the culled row`,
    );
    assert.ok(
      p2Violations(h, prec).length > 0,
      `${prec.name}: P2 stayed green`,
    );
    assert.ok(
      p3Violations(h, prec).length > 0,
      `${prec.name}: P3 stayed green`,
    );
    // The groups that do not read the clip core stay green, which is what
    // makes M1 about the clip core alone.
    assert.deepEqual(
      p5Violations(h, prec).filter((v) => v.includes("zero length")),
      [],
    );
  }
});

test("M4: with the per-end selection's clipped test unreachable, P6 goes RED on the crossing rows", () => {
  const image = mutateIn(
    chunkWgsl,
    "csm_polylineClipEnd",
    "status == 1.0",
    "status == 7.0",
  );
  for (const prec of PRECISIONS) {
    const h = makeHelpers(image, prec);
    const p6 = p6Violations(h, prec);
    assert.ok(
      p6.some((v) => v.includes("start behind")),
      `${prec.name} start`,
    );
    assert.ok(
      p6.some((v) => v.includes("end behind")),
      `${prec.name} end`,
    );
    // The clip core itself is untouched.
    assert.deepEqual(p1Violations(h, prec, ROWS), []);
  }
});

test("M5: with the previous point's clipped test unreachable, P5 goes RED on the crossing rows", () => {
  const image = mutateIn(
    chunkWgsl,
    "csm_polylinePreviousClip",
    "status == 1.0",
    "status == 7.0",
  );
  for (const prec of PRECISIONS) {
    const h = makeHelpers(image, prec);
    const p5 = p5Violations(h, prec);
    assert.ok(
      p5.some((v) => v.includes("start behind")),
      `${prec.name} start`,
    );
    assert.ok(
      p5.some((v) => v.includes("end behind")),
      `${prec.name} end`,
    );
    assert.deepEqual(p6Violations(h, prec), []);
  }
});

test("M0: a mutation that matches nothing is refused, and one that bites is confined to its function", () => {
  assert.throws(
    () => mutateIn(chunkWgsl, "csm_polylineClipEnd", "no such text", "x"),
    /matched nothing/u,
  );
  assert.throws(
    () => mutateIn(chunkWgsl, "csm_noSuchFunction", "status", "x"),
    /no fn csm_noSuchFunction/u,
  );
  const image = mutateIn(
    chunkWgsl,
    "csm_polylineClipEnd",
    "status == 1.0",
    "status == 7.0",
  );
  const before = chunkWgsl.split("status == 1.0").length;
  const after = image.split("status == 1.0").length;
  assert.equal(
    before - after,
    1,
    "exactly the one occurrence in that function",
  );
});

// ═══════════════════════════════════════════════════════════════════════
// B — the BufferPolyline stage's three inputs, round-tripped
// ═══════════════════════════════════════════════════════════════════════
//
// WebGL hands its vertex stage, per vertex copy (renderBufferPolylineCollection
// .js pack, BufferPolylineMaterialVS.glsl:32-33): copy k (0 then 1) of vertex j
// of a jl-vertex polyline is written at vertex number
// 2 * vertexOffset + 2 * j + k with texCoord = j / (jl - 1) in a Float32Array;
// the stage takes usePrevious = (texCoord == 1.0) and
// expandDir = (gl_VertexID % 2 == 1 ? 1.0 : -1.0). B runs the REAL WebGPU
// repack and layout builder, reads the lanes back through the layout the
// pipeline declares, and asserts exactly (no tolerance) that texCoord, the
// expand direction and usePrevious equal WebGL's triple for all 40 copies of
// five polylines of 2, 3, 4, 5 and 6 vertices.

const RENDERER_TS = path
  .join(
    root,
    "packages/engine/Source/Renderer/WebGPU/WebGPUBufferPolylineRenderer.ts",
  )
  .replaceAll("\\", "/");

/**
 * One-substitution module images of the renderer, selected by `?mutant=NAME`.
 * Each is applied to the in-memory text only; the file is never written.
 */
const RENDERER_MUTANTS = Object.freeze({
  MB1: [
    "cache.showColorWidthAndTexCoordArr[vRecord + 3] = texCoordS;",
    "cache.showColorWidthAndTexCoordArr[vRecord + 3] = texCoordS + (k === 0 ? 0.25 : 0.75);",
  ],
  MB2: ["= k === 0 ? -1.0 : 1.0;", "= 1.0;"],
  MB4: [
    '{ shaderLocation: 9, offset: 20, format: "float32" },',
    '{ shaderLocation: 9, offset: 16, format: "float32" },',
  ],
});

/**
 * Apply a named renderer substitution and refuse if it matched nothing.
 *
 * @param {string} source The renderer's TypeScript.
 * @param {string} name A key of RENDERER_MUTANTS.
 * @returns {string} The mutated text.
 */
function mutateRenderer(source, name) {
  const pair = RENDERER_MUTANTS[name];
  assert.ok(pair, `no renderer mutant ${name}`);
  const replaced = source.replace(pair[0], () => pair[1]);
  assert.notEqual(replaced, source, `the mutation ${name} matched nothing`);
  return replaced;
}

// Transform TypeScript in memory, stub the generated shader-string modules the
// build has not (or has) produced, and give ONE module a test-only export of
// its two internals. Precedent: globe-material-pipeline-format-axis.spec.mjs.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      context.parentURL?.startsWith("file:")
    ) {
      const candidatePath = fileURLToPath(
        new URL(specifier, context.parentURL),
      );
      if (
        !fs.existsSync(candidatePath) &&
        candidatePath
          .replaceAll("\\", "/")
          .includes("/packages/engine/Source/Shaders/")
      ) {
        return {
          url: `data:text/javascript,export default %22%22;#${encodeURIComponent(candidatePath)}`,
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const [bare, query = ""] = url.split("?");
    if (!bare.startsWith("file:") || !bare.endsWith(".ts")) {
      return nextLoad(url, context);
    }
    const file = fileURLToPath(bare);
    let source = fs.readFileSync(file, "utf8");
    if (file.replaceAll("\\", "/") === RENDERER_TS) {
      const mutant = new URLSearchParams(query).get("mutant");
      if (mutant) {
        source = mutateRenderer(source, mutant);
      }
      source +=
        "\nexport { repackPolylineDirty as __repackPolylineDirty, buildPolylinePipeline as __buildPolylinePipeline };\n";
    }
    return {
      format: "module",
      source: stripTypeScriptTypes(source, {
        mode: "transform",
        sourceMap: false,
      }),
      shortCircuit: true,
    };
  },
});

const BufferPolylineCollection = await engineModule(
  "Scene/BufferPolylineCollection.js",
);
const SceneMode = await engineModule("Scene/SceneMode.js");

/**
 * Import the real renderer, optionally as one of its mutant images.
 *
 * @param {string} [mutant] A key of RENDERER_MUTANTS.
 * @returns {Promise<object>} The module namespace with the two test exports.
 */
const loadRenderer = (mutant) =>
  import(pathToFileURL(RENDERER_TS).href + (mutant ? `?mutant=${mutant}` : ""));

const POLYLINE_VERTEX_COUNTS = [2, 3, 4, 5, 6];
const bufferWgsl = stripComments(
  read(`${COLLECTIONS}/BufferPolylineMaterial.wgsl`),
);

/**
 * Compile bufferPolylineUsePrevious out of a BufferPolylineMaterial.wgsl text.
 *
 * @param {string} source The comment-stripped WGSL.
 * @returns {Function} `(texCoord) => boolean`.
 */
const compileUsePrevious = (source) =>
  compileFunction(source, "bufferPolylineUsePrevious", {
    ...readConstants(source),
    __functions: {},
  });

/**
 * Run the pipeline builder and the dirty repack of a renderer image over five
 * polylines, and read each copy's lanes through the declared layout.
 *
 * @param {object} renderer The module namespace from loadRenderer.
 * @returns {{ layoutViolations: string[], copies: object[] }} One entry per
 *   copy: polyline, vertex j, jl, copy k, vertex number, texCoord, side.
 */
function packCopies(renderer) {
  const descriptor = renderer.__buildPolylinePipeline(
    { createPipelineLayout: (d) => d, createRenderPipeline: (d) => d },
    {},
    "rgba8unorm",
    [],
  );
  const slot = descriptor.vertex.buffers[7];
  const attribute = (location) =>
    slot.attributes.find((a) => a.shaderLocation === location);
  const texAttr = attribute(7);
  const sideAttr = attribute(9);
  const layoutViolations = [];
  if (texAttr?.format !== "float32x4") {
    layoutViolations.push(`location 7 is ${texAttr?.format}, not float32x4`);
  }
  if (sideAttr?.format !== "float32") {
    layoutViolations.push(`location 9 is ${sideAttr?.format}, not float32`);
  }
  const stride = slot.arrayStride / 4;
  const texLane = texAttr.offset / 4 + 3;
  const sideLane = sideAttr.offset / 4;

  const total = POLYLINE_VERTEX_COUNTS.reduce((a, b) => a + b, 0);
  const collection = new BufferPolylineCollection({
    primitiveCountMax: POLYLINE_VERTEX_COUNTS.length,
    vertexCountMax: total,
  });
  POLYLINE_VERTEX_COUNTS.forEach((jl, p) => {
    const positions = new Float64Array(jl * 3);
    for (let j = 0; j < jl; j++) {
      positions.set([6378137 + 10 * p, 100 * j, 50 * j], j * 3);
    }
    collection.add({ positions });
  });
  collection._dirtyOffset = 0;
  collection._dirtyCount = collection.primitiveCount;

  const n = 2 * collection.vertexCountMax;
  const f3 = () => new Float32Array(n * 3);
  const cache = {
    positionHighArr: f3(),
    positionLowArr: f3(),
    prevPositionHighArr: f3(),
    prevPositionLowArr: f3(),
    nextPositionHighArr: f3(),
    nextPositionLowArr: f3(),
    pickColorArr: new Uint8Array(n * 4),
    showColorWidthAndTexCoordArr: new Float32Array(n * stride),
    indexArr: new Uint32Array(
      (collection.vertexCountMax - collection.primitiveCount) * 6,
    ),
    pickIds: [],
  };
  let pickKey = 1;
  renderer.__repackPolylineDirty(
    collection,
    cache,
    { createPickId: () => ({ key: pickKey++ }) },
    { mode: SceneMode.SCENE3D },
    false,
  );

  const copies = [];
  let vertexOffset = 0;
  POLYLINE_VERTEX_COUNTS.forEach((jl, p) => {
    for (let j = 0; j < jl; j++) {
      for (let k = 0; k < 2; k++) {
        const vertexNumber = 2 * vertexOffset + 2 * j + k;
        const record = vertexNumber * stride;
        copies.push({
          p,
          j,
          jl,
          k,
          vertexNumber,
          texCoord: cache.showColorWidthAndTexCoordArr[record + texLane],
          side: cache.showColorWidthAndTexCoordArr[record + sideLane],
        });
      }
    }
    vertexOffset += jl;
  });
  return { layoutViolations, copies };
}

/**
 * B1: every copy's texCoord and expand direction equal WebGL's, exactly.
 *
 * @param {{ layoutViolations: string[], copies: object[] }} packed From packCopies.
 * @returns {string[]} The violations.
 */
function b1Violations({ layoutViolations, copies }) {
  const violations = [...layoutViolations];
  for (const c of copies) {
    const label = `polyline ${c.p} vertex ${c.j}/${c.jl} copy ${c.k}`;
    const texCoord = Float32Array.of(c.j / (c.jl - 1))[0];
    if (c.texCoord !== texCoord) {
      violations.push(`${label}: texCoord ${c.texCoord}, WebGL ${texCoord}`);
    }
    const side = c.vertexNumber % 2 === 1 ? 1 : -1;
    if (c.side !== side) {
      violations.push(`${label}: side ${c.side}, WebGL ${side}`);
    }
  }
  return violations;
}

/**
 * B2: usePrevious of every copy's texCoord lane is true at the last vertex only.
 *
 * @param {{ copies: object[] }} packed From packCopies.
 * @param {Function} usePrevious The compiled WGSL helper.
 * @returns {string[]} The violations.
 */
function b2Violations({ copies }, usePrevious) {
  const violations = [];
  for (const c of copies) {
    const expected = c.j === c.jl - 1;
    if (usePrevious(c.texCoord) !== expected) {
      violations.push(
        `polyline ${c.p} vertex ${c.j}/${c.jl} copy ${c.k}: usePrevious(${c.texCoord}) is not ${expected}`,
      );
    }
  }
  return violations;
}

const shippedPacked = packCopies(await loadRenderer());
const shippedUsePrevious = compileUsePrevious(bufferWgsl);

test("B1: the shipped repack hands the stage WebGL's texCoord and expand direction, exactly", () => {
  assert.deepEqual(b1Violations(shippedPacked), []);
});

test("B2: usePrevious of the packed texCoord is true for both copies of the last vertex and nowhere else", () => {
  assert.deepEqual(b2Violations(shippedPacked, shippedUsePrevious), []);
});

test("B: the table is not vacuous - 40 copies, 10 last-vertex, the aliased texCoords present", () => {
  const { copies } = shippedPacked;
  assert.equal(copies.length, 40);
  assert.equal(copies.filter((c) => c.j === c.jl - 1).length, 10);
  assert.equal(shippedUsePrevious(1), true);
  assert.equal(shippedUsePrevious(0.75), false);
  for (const s of [0.25, 0.5, 0.75, 1 / 3, 2 / 3]) {
    const f32 = Float32Array.of(s)[0];
    assert.ok(
      copies.some((c) => c.texCoord === f32),
      `no copy carries texCoord ${s}`,
    );
  }
  assert.equal(copies.filter((c) => c.side === -1).length, 20);
  assert.equal(copies.filter((c) => c.side === 1).length, 20);
});

test("MB1: with the texCoord folded back into the side (round 1), B1 and B2 go RED", async (t) => {
  const packed = packCopies(await loadRenderer("MB1"));
  const b1 = b1Violations(packed);
  const b2 = b2Violations(packed, shippedUsePrevious);
  t.diagnostic(`MB1 violations: B1 ${b1.length}, B2 ${b2.length}`);
  assert.ok(
    b1.some((v) => v.includes("texCoord")),
    "B1 texCoord stayed green",
  );
  assert.ok(b2.length > 0, "B2 stayed green");
});

test("MB2: with the side always +1, B1 goes RED on every first copy", async (t) => {
  const violations = b1Violations(packCopies(await loadRenderer("MB2")));
  t.diagnostic(`MB2 violations: B1 ${violations.length}`);
  const sides = violations.filter((v) => v.includes("side"));
  assert.equal(sides.length, 20);
  assert.ok(sides.every((v) => v.includes("copy 0")));
  assert.equal(violations.length, sides.length, "texCoord went RED too");
});

test("MB3: with usePrevious comparing against 7.0, B2 goes RED at every last vertex", (t) => {
  const image = mutateIn(
    bufferWgsl,
    "bufferPolylineUsePrevious",
    "texCoord == 1.0",
    "texCoord == 7.0",
  );
  const violations = b2Violations(shippedPacked, compileUsePrevious(image));
  t.diagnostic(`MB3 violations: B2 ${violations.length}`);
  assert.equal(violations.length, 10);
  assert.deepEqual(b1Violations(shippedPacked), []);
});

test("MB4: with the side attribute read from the alpha lane, B1 goes RED on the side", async (t) => {
  const violations = b1Violations(packCopies(await loadRenderer("MB4")));
  t.diagnostic(`MB4 violations: B1 ${violations.length}`);
  assert.ok(
    violations.some((v) => v.includes("side")),
    "B1 side stayed green",
  );
});

test("MB0: a renderer mutant that matches nothing is refused", () => {
  assert.throws(
    () => mutateRenderer("export const unrelated = 1;", "MB1"),
    /matched nothing/u,
  );
});
