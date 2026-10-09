// buffer-polyline-hairpin-join.spec.mjs — the WebGPU BufferPolyline joint at a 180-degree turn, EXECUTED out of its shipped source.
//
// @purpose Runs bufferPolylineJoin out of BufferPolylineMaterial.wgsl through the WGSL evaluator and asserts it against an independent JavaScript transcription of WebGL's getPolylineWindowCoordinatesEC joint (PolylineCommon.glsl): finite at a hairpin, unchanged and in parity everywhere else.
// @status ACTIVE
//
// Pure Node, real modules, no browser, no GPU:
//   node --test Tools/visual-regression/buffer-polyline-hairpin-join.spec.mjs
//   npm run test-visual-regression-node        # its registered runner home
//
// WHAT IS ASSERTED, AND WHY IT IS NOT A GREP
// ------------------------------------------
// The vertex stage extrudes a polyline vertex along the left normal of a joint
// direction and divides the half width by a cosine. The helper that produces
// both is a pure WGSL function, so every number below comes out of the `.wgsl`
// that ships, read by `lib/wgsl-mini-eval.mjs`. The oracle is a transcription
// of WebGL's law written from the GLSL: the "other" segment's left normal is
// added to this segment's, the sum is normalized unless it is shorter than
// czm_epsilon6 (then this segment's own left normal stands), and the extrusion
// is clamp((width / 2) / |cross(-forward, left)|, 0, 2 * width).
//
// WHAT WAS WRONG: for opposite directions the bisector is normalize(0), which
// is NaN in every lane, so the whole joint vanished on WebGPU while WebGL drew
// the segment's own extrusion at half the width.
//
// WHICH usePrevious THE VERTEX STAGE PASSES: always false. WebGL's
// usePrevious is texCoord == 1.0, the last vertex, and at the last vertex (as
// at the first) the missing neighbour is the other neighbour reflected
// through it, in both renderers' packs, so its two directions agree and it is
// never a hairpin. A reachable 180-degree turn is always an interior vertex,
// where WebGL's usePrevious is false. The usePrevious = true cases below are
// therefore HELPER-CONTRACT checks (the helper still implements WebGL's law
// for both values), not a joint the shader can produce; the label of each
// such violation says so.
//
// THE GROUPS
//   H1  a hairpin (including an f32-rounded pair and a pair just below the
//       epsilon) is finite and equals WebGL's extrusion with usePrevious =
//       false (the reachable case), and with usePrevious = true as a
//       helper-contract check.
//   H2  every other joint is finite, still the pre-fix expressions
//       (normalize(sum), dot of the two left normals), and in parity with
//       WebGL for both values of usePrevious.
//   M   inertness images: the same reader over a one-substitution copy of the
//       shipped text turns H1 or H2 RED, so neither group passes over a helper
//       that has stopped doing its job.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileFunction,
  readConstants,
  stripComments,
  vec2,
} from "./lib/wgsl-mini-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const WGSL_PATH = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Collections/BufferPolylineMaterial.wgsl",
);
const shipped = fs.readFileSync(WGSL_PATH, "utf8").replace(/\r\n/gu, "\n");

/**
 * Compile the join helper out of a WGSL text.
 *
 * @param {string} source The WGSL.
 * @param {object} [extraGlobals] Extra evaluator bindings, e.g. `__round`.
 * @returns {Function} `(dirPrev, dirNext, usePrevious) => {x, y, z}`.
 */
function compileJoin(source, extraGlobals = {}) {
  const stripped = stripComments(source);
  return compileFunction(stripped, "bufferPolylineJoin", {
    ...readConstants(stripped),
    __functions: {},
    ...extraGlobals,
  });
}

/**
 * Apply one textual substitution and refuse if it did not bite: a mutation
 * image that matched nothing is a green test over unmutated source.
 *
 * @param {string} source The WGSL.
 * @param {string|RegExp} from What to replace.
 * @param {string} to The replacement.
 * @returns {string} The mutated WGSL.
 */
function mutate(source, from, to) {
  const out = source.replace(from, to);
  assert.notEqual(out, source, `the mutation ${String(from)} matched nothing`);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
// The oracle: WebGL's joint, from PolylineCommon.glsl, in plain JavaScript.
// Directions are the vertex stage's (prev -> this, this -> next); GLSL's
// directionToPrevWC points the other way, so its `-directionToPrevWC` is
// dirPrev here.
// ═══════════════════════════════════════════════════════════════════════

const CZM_EPSILON6 = 1.0e-6;

/**
 * @param {number[]} dirPrev Unit direction arriving at the vertex.
 * @param {number[]} dirNext Unit direction leaving the vertex.
 * @param {boolean} usePrevious WebGL's texCoord == 1.0 (the last vertex).
 * @param {number} width The pixel width.
 * @returns {{left: number[], expandWidth: number}} WebGL's leftWC and the
 *   extrusion length before the pixel ratio.
 */
function webglJoint(dirPrev, dirNext, usePrevious, width) {
  const thisForward = usePrevious ? dirPrev : dirNext;
  const otherForward = usePrevious ? dirNext : dirPrev;
  const thisLeft = [-thisForward[1], thisForward[0]];
  const otherLeft = [-otherForward[1], otherForward[0]];
  const sum = [thisLeft[0] + otherLeft[0], thisLeft[1] + otherLeft[1]];
  const sumLength = Math.hypot(sum[0], sum[1]);
  const left =
    sumLength < CZM_EPSILON6
      ? thisLeft
      : [sum[0] / sumLength, sum[1] / sumLength];
  const u = [-thisForward[0], -thisForward[1]];
  const sinAngle = Math.abs(u[0] * left[1] - u[1] * left[0]);
  const expandWidth = Math.min(
    Math.max((width * 0.5) / sinAngle, 0),
    width * 2,
  );
  return { left, expandWidth };
}

/**
 * What the vertex stage does with the helper's outputs
 * (BufferPolylineMaterial.wgsl vertexMain): extrude along the left normal of
 * xy by (width / 2) / max(z, 0.1), clamped to 2 * width.
 *
 * @param {{x: number, y: number, z: number}} joint The helper's result.
 * @param {number} width The pixel width.
 * @returns {{left: number[], length: number}} The offset direction and length.
 */
function extrusionOf(joint, width) {
  return {
    left: [-joint.y, joint.x],
    length: Math.min((width * 0.5) / Math.max(joint.z, 0.1), width * 2),
  };
}

const unit = (angle) => [Math.cos(angle), Math.sin(angle)];
const negate = (v) => [-v[0], -v[1]];
const WIDTHS = [10, 3];
const HEADINGS = [0, 0.37, 1.9, -2.6];

/** Hairpins: next is the exact reverse of prev, or reversed to within epsilon. */
function hairpinPairs() {
  const pairs = [];
  pairs.push({ name: "(1,0) back", prev: [1, 0], next: [-1, 0] });
  pairs.push({
    name: "(0.6,0.8) back",
    prev: [0.6, 0.8],
    next: [-0.6, -0.8],
  });
  for (const heading of HEADINGS) {
    const prev = unit(heading);
    pairs.push({ name: `heading ${heading} back`, prev, next: negate(prev) });
  }
  // f32-rounded unit vectors: the reverse differs from the exact negation only
  // at the last bit, so the sum is a few 1e-8, far under the epsilon.
  const prevF32 = unit(0.7).map(Math.fround);
  pairs.push({
    name: "f32-rounded pair",
    prev: prevF32,
    next: negate(prevF32).map(Math.fround),
  });
  // Just under the epsilon: |sum| = 2 sin(delta / 2) with delta = 0.8e-6.
  const delta = 0.8e-6;
  for (const heading of [0, 1.1]) {
    pairs.push({
      name: `just under epsilon at ${heading}`,
      prev: unit(heading),
      next: unit(heading + Math.PI - delta),
    });
  }
  return pairs;
}

/** Joints that are not hairpins, from straight on through a near-reversal. */
function bentPairs() {
  const turns = [
    ["straight", 0],
    ["22 degrees", (22 * Math.PI) / 180],
    ["45 degrees", Math.PI / 4],
    ["90 degrees", Math.PI / 2],
    ["-90 degrees", -Math.PI / 2],
    ["135 degrees", (135 * Math.PI) / 180],
    ["170 degrees", (170 * Math.PI) / 180],
    ["-170 degrees", (-170 * Math.PI) / 180],
    ["179 degrees", (179 * Math.PI) / 180],
    // Just over the epsilon: |sum| = 2 sin(delta / 2) with delta = 1.2e-6.
    ["just over epsilon", Math.PI - 1.2e-6],
  ];
  const pairs = [];
  for (const [label, turn] of turns) {
    for (const heading of HEADINGS) {
      pairs.push({
        name: `${label} at heading ${heading}`,
        prev: unit(heading),
        next: unit(heading + turn),
      });
    }
  }
  return pairs;
}

const close = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
const finite = (joint) =>
  [joint.x, joint.y, joint.z].every((lane) => Number.isFinite(lane));

/**
 * H1 over a given helper. Returns the violations so a mutation image can be
 * required to produce some.
 *
 * @param {Function} join A compiled helper.
 * @returns {string[]} Violations; empty when the helper behaves.
 */
function hairpinViolations(join) {
  const violations = [];
  for (const pair of hairpinPairs()) {
    for (const usePrevious of [false, true]) {
      for (const width of WIDTHS) {
        // usePrevious = true is a helper-contract check: no reachable
        // hairpin passes it (see the header).
        const contract = usePrevious ? " [helper contract]" : "";
        const label = `${pair.name} usePrevious=${usePrevious}${contract} width=${width}`;
        const joint = join(vec2(...pair.prev), vec2(...pair.next), usePrevious);
        if (!finite(joint)) {
          violations.push(
            `${label}: non-finite (${joint.x}, ${joint.y}, ${joint.z})`,
          );
          continue;
        }
        const got = extrusionOf(joint, width);
        const want = webglJoint(pair.prev, pair.next, usePrevious, width);
        if (
          !close(got.left[0], want.left[0], 1e-6) ||
          !close(got.left[1], want.left[1], 1e-6)
        ) {
          violations.push(
            `${label}: direction (${got.left}) is not WebGL's (${want.left})`,
          );
        }
        if (!close(got.length, want.expandWidth, 1e-6 * width)) {
          violations.push(
            `${label}: length ${got.length} is not WebGL's ${want.expandWidth}`,
          );
        }
      }
    }
  }
  return violations;
}

/**
 * H2 over a given helper: finite, the pre-fix expressions, and parity.
 *
 * @param {Function} join A compiled helper.
 * @returns {string[]} Violations; empty when the helper behaves.
 */
function bentViolations(join) {
  const violations = [];
  for (const pair of bentPairs()) {
    const [px, py] = pair.prev;
    const [nx, ny] = pair.next;
    const sumLength = Math.hypot(px + nx, py + ny);
    // The pre-fix expressions, computed here from the inputs:
    // tangent = normalize(dirPrev + dirNext) and
    // z = dot(left(tangent), left(dirPrev)).
    const tangent = [(px + nx) / sumLength, (py + ny) / sumLength];
    const oldZ = -tangent[1] * -py + tangent[0] * px;
    for (const usePrevious of [false, true]) {
      for (const width of WIDTHS) {
        const label = `${pair.name} usePrevious=${usePrevious} width=${width}`;
        const joint = join(vec2(...pair.prev), vec2(...pair.next), usePrevious);
        if (!finite(joint)) {
          violations.push(
            `${label}: non-finite (${joint.x}, ${joint.y}, ${joint.z})`,
          );
          continue;
        }
        if (
          !close(joint.x, tangent[0], 1e-9) ||
          !close(joint.y, tangent[1], 1e-9) ||
          !close(joint.z, oldZ, 1e-9)
        ) {
          violations.push(
            `${label}: (${joint.x}, ${joint.y}, ${joint.z}) is not the unchanged (${tangent}, ${oldZ})`,
          );
        }
        const got = extrusionOf(joint, width);
        const want = webglJoint(pair.prev, pair.next, usePrevious, width);
        if (
          !close(got.left[0], want.left[0], 1e-6) ||
          !close(got.left[1], want.left[1], 1e-6)
        ) {
          violations.push(
            `${label}: direction (${got.left}) is not WebGL's (${want.left})`,
          );
        }
        if (!close(got.length, want.expandWidth, 1e-4 * width)) {
          violations.push(
            `${label}: length ${got.length} is not WebGL's ${want.expandWidth}`,
          );
        }
      }
    }
  }
  return violations;
}

const shippedJoin = compileJoin(shipped);

// ═══════════════════════════════════════════════════════════════════════
// H1 — the hairpin
// ═══════════════════════════════════════════════════════════════════════

test("H1: a 180-degree turn is finite and extrudes as WebGL does", () => {
  assert.deepEqual(hairpinViolations(shippedJoin), []);
});

test("H1: literal pins, so the oracle is itself checked", () => {
  // WebGL, (1,0) then (-1,0): the leaving segment points -x, whose left normal
  // is (0,-1), at half the width; that is the reachable case. The arriving
  // pin (usePrevious = true, left normal (0,1)) is a helper-contract check.
  const leaving = extrusionOf(shippedJoin(vec2(1, 0), vec2(-1, 0), false), 10);
  assert.ok(close(leaving.left[0], 0, 1e-12), `x ${leaving.left[0]}`);
  assert.ok(close(leaving.left[1], -1, 1e-12), `y ${leaving.left[1]}`);
  assert.ok(close(leaving.length, 5, 1e-9), `length ${leaving.length}`);
  const arriving = extrusionOf(shippedJoin(vec2(1, 0), vec2(-1, 0), true), 10);
  assert.ok(close(arriving.left[0], 0, 1e-12), `x ${arriving.left[0]}`);
  assert.ok(close(arriving.left[1], 1, 1e-12), `y ${arriving.left[1]}`);
  assert.ok(close(arriving.length, 5, 1e-9), `length ${arriving.length}`);
});

test("H1: the f32-rounded hairpin is finite when every operation rounds to f32", () => {
  // The GPU rounds every result to f32; bind the evaluator's rounding hook so
  // the epsilon test sees the sum the device sees.
  const rounded = compileJoin(shipped, { __round: Math.fround });
  const prev = unit(0.7).map(Math.fround);
  const next = negate(prev).map(Math.fround);
  for (const usePrevious of [false, true]) {
    const joint = rounded(vec2(...prev), vec2(...next), usePrevious);
    assert.ok(
      finite(joint),
      `usePrevious=${usePrevious}: (${joint.x}, ${joint.y}, ${joint.z})`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════
// H2 — everything else is unchanged and in parity
// ═══════════════════════════════════════════════════════════════════════

test("H2: non-reversed joints keep the pre-fix outputs and match WebGL", () => {
  assert.deepEqual(bentViolations(shippedJoin), []);
});

test("H2: a straight joint extrudes at exactly half the width", () => {
  const joint = shippedJoin(vec2(1, 0), vec2(1, 0), false);
  const got = extrusionOf(joint, 10);
  assert.ok(close(got.left[0], 0, 1e-12));
  assert.ok(close(got.left[1], 1, 1e-12));
  assert.ok(close(got.length, 5, 1e-9));
});

// ═══════════════════════════════════════════════════════════════════════
// M — inertness images
// ═══════════════════════════════════════════════════════════════════════

test("M1: with the hairpin test unreachable, H1 goes RED (non-finite)", () => {
  const image = mutate(
    shipped,
    "let reversed = length(sum) < BUFFER_POLYLINE_EPSILON6;",
    "let reversed = false && length(sum) < BUFFER_POLYLINE_EPSILON6;",
  );
  const violations = hairpinViolations(compileJoin(image));
  assert.ok(violations.length > 0, "H1 stayed green over a dead hairpin test");
  assert.ok(
    violations.some((v) => v.includes("non-finite")),
    `expected a non-finite violation, got ${violations[0]}`,
  );
  // The bent joints do not care, which is what makes M1 about H1 alone.
  assert.deepEqual(bentViolations(compileJoin(image)), []);
});

test("M1b: with the pre-fix body restored outright, H1 goes RED", () => {
  const withTangent = mutate(
    shipped,
    /let tangent = select\(normalize\(sum\), ownDir, reversed\);/u,
    "let tangent = normalize(sum);",
  );
  const image = mutate(
    withTangent,
    /let cosHalfAngle = select\(\s*dot\(([^;]*?)\),\s*1\.0,\s*reversed\);/u,
    "let cosHalfAngle = dot($1);",
  );
  const violations = hairpinViolations(compileJoin(image));
  assert.ok(violations.length > 0, "H1 stayed green over the pre-fix body");
});

test("M2: with the hairpin test always true, H2 goes RED on every turning joint", () => {
  const image = mutate(
    shipped,
    "let reversed = length(sum) < BUFFER_POLYLINE_EPSILON6;",
    "let reversed = length(sum) < 2.1;",
  );
  const violations = bentViolations(compileJoin(image));
  assert.ok(violations.length > 0, "H2 stayed green over an always-true test");
  // Every pair that turns is wrong, not just one: the group would otherwise be
  // a spot check. Only a straight joint legitimately survives, because there
  // the vertex's own direction already is the bisector.
  const broken = new Set(violations.map((v) => v.split(" usePrevious")[0]));
  let turning = 0;
  for (const pair of bentPairs()) {
    const straight =
      Math.hypot(pair.prev[0] - pair.next[0], pair.prev[1] - pair.next[1]) <
      1e-3;
    if (!straight) {
      turning += 1;
      assert.ok(broken.has(pair.name), `${pair.name} survived the mutant`);
    }
  }
  assert.ok(turning > 20, "the matrix must hold many turning joints");
});

test("M3: the mutation helper refuses a substitution that matched nothing", () => {
  assert.throws(
    () => mutate(shipped, "no such text anywhere", "x"),
    /matched nothing/u,
  );
});
