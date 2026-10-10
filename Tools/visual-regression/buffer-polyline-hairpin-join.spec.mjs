// buffer-polyline-hairpin-join.spec.mjs — the polyline window-space joint at a 180-degree turn, EXECUTED out of its shipped source.
//
// @purpose Runs csm_polylineJoin out of csm_polylineCommon.wgsl (the joint of WebGL's getPolylineWindowCoordinatesEC, now the one joint every WebGPU polyline stage including BufferPolyline uses) through the WGSL evaluator and asserts it against an independent JavaScript transcription of PolylineCommon.glsl: finite at a hairpin and in parity with WebGL everywhere else.
// @status ACTIVE
//
// Pure Node, real modules, no browser, no GPU:
//   node --test Tools/visual-regression/buffer-polyline-hairpin-join.spec.mjs
//   npm run test-visual-regression-node        # its registered runner home
//
// WHAT IS ASSERTED, AND WHY IT IS NOT A GREP
// ------------------------------------------
// The joint is a pure WGSL function, so every number below comes out of the
// .wgsl that ships, read by lib/wgsl-mini-eval.mjs. The oracle is a
// transcription of WebGL's law written from the GLSL: the "other" segment's
// left normal is added to this segment's, the sum is normalized unless it is
// shorter than czm_epsilon6 (then this segment's own left normal stands), and
// the extrusion is clamp((width / 2) / |cross(-forward, left)|, 0, 2 * width).
// A position that coincides with its previous or next position skips all of it
// and takes its own segment's left normal at half the width.
//
// WHAT WAS WRONG: for opposite directions the bisector is normalize(0), which
// is NaN in every lane, so the whole joint vanished on WebGPU while WebGL drew
// the segment's own extrusion at half the width.
//
// FW-03b moved the joint out of BufferPolylineMaterial.wgsl (where it was the
// private helper bufferPolylineJoin) into csm_polylineCommon.wgsl as
// csm_polylineJoin, so BufferPolyline now runs WebGL's whole window-coordinate
// law. This spec was re-pointed with it: the former half that pinned the
// pre-fix WGSL expressions is retired by design (that helper no longer
// exists), and what remains is parity with WebGL.
//
// THE GROUPS
//   H1  a hairpin (including an f32-rounded pair and a pair just below the
//       epsilon) is finite and equals WebGL's own-segment fallback, for both
//       values of usePrevious.
//   H2  every other joint, from straight on through a near-reversal, is
//       finite and equals WebGL's joint, for both values of usePrevious.
//   H3  a coincident position takes its own segment's left normal at half the
//       width whatever the other segment is, and nothing leaks from it.
//   M   inertness images: the same reader over a one-substitution copy of the
//       shipped text turns H1, H2 or H3 RED, so no group passes over a helper
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
  "packages/engine/Source/Shaders/WebGPU/chunks/functions/csm_polylineCommon.wgsl",
);
const shipped = fs.readFileSync(WGSL_PATH, "utf8").replace(/\r\n/gu, "\n");

/**
 * Compile the joint out of a WGSL text.
 *
 * @param {string} source The WGSL.
 * @param {object} [extraGlobals] Extra evaluator bindings, e.g. `__round`.
 * @returns {Function} `(thisForward, otherForward, width, coincident) => {x, y, z}`.
 */
function compileJoin(source, extraGlobals = {}) {
  const stripped = stripComments(source);
  return compileFunction(stripped, "csm_polylineJoin", {
    ...readConstants(stripped),
    __functions: {},
    ...extraGlobals,
  });
}

/**
 * Call the joint the way the window-coordinate law does, from the vertex's
 * travel directions: the direction to the previous position is the reverse of
 * the direction that arrived, the direction to the next is the one that leaves.
 * `usePrevious` (WebGL's texCoord == 1.0) makes the arriving segment this
 * vertex's own.
 *
 * @param {Function} join A compiled joint.
 * @param {number[]} dirPrev Unit direction arriving at the vertex.
 * @param {number[]} dirNext Unit direction leaving the vertex.
 * @param {boolean} usePrevious WebGL's usePrevious.
 * @param {number} width The CSS-pixel width.
 * @param {boolean} [coincident] The position coincides with a neighbour.
 * @returns {{x: number, y: number, z: number}} (leftWC.xy, expandWidth).
 */
function callJoin(
  join,
  dirPrev,
  dirNext,
  usePrevious,
  width,
  coincident = false,
) {
  const dirToPrev = negate(dirPrev);
  const dirToNext = dirNext;
  const thisForward = usePrevious ? negate(dirToPrev) : dirToNext;
  const otherForward = usePrevious ? dirToNext : negate(dirToPrev);
  return join(vec2(...thisForward), vec2(...otherForward), width, coincident);
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
 * The joint's outputs as an offset direction and a length (before the pixel
 * ratio): leftWC in xy, the extrusion half-width in z.
 *
 * @param {{x: number, y: number, z: number}} joint The helper's result.
 * @returns {{left: number[], length: number}} The offset direction and length.
 */
function extrusionOf(joint) {
  return { left: [joint.x, joint.y], length: joint.z };
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
        const label = `${pair.name} usePrevious=${usePrevious} width=${width}`;
        const joint = callJoin(join, pair.prev, pair.next, usePrevious, width);
        if (!finite(joint)) {
          violations.push(
            `${label}: non-finite (${joint.x}, ${joint.y}, ${joint.z})`,
          );
          continue;
        }
        const got = extrusionOf(joint);
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
 * H2 over a given helper: finite and in parity with WebGL.
 *
 * @param {Function} join A compiled helper.
 * @returns {string[]} Violations; empty when the helper behaves.
 */
function bentViolations(join) {
  const violations = [];
  for (const pair of bentPairs()) {
    for (const usePrevious of [false, true]) {
      for (const width of WIDTHS) {
        const label = `${pair.name} usePrevious=${usePrevious} width=${width}`;
        const joint = callJoin(join, pair.prev, pair.next, usePrevious, width);
        if (!finite(joint)) {
          violations.push(
            `${label}: non-finite (${joint.x}, ${joint.y}, ${joint.z})`,
          );
          continue;
        }
        const got = extrusionOf(joint);
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

/**
 * H3 over a given helper: a coincident position takes its own segment's left
 * normal at half the width, whatever the other segment is, even a garbage one.
 *
 * @param {Function} join A compiled helper.
 * @returns {string[]} Violations; empty when the helper behaves.
 */
function coincidentViolations(join) {
  const violations = [];
  const garbage = vec2(Number.NaN, Number.NaN);
  for (const pair of [...hairpinPairs(), ...bentPairs()]) {
    for (const usePrevious of [false, true]) {
      for (const width of WIDTHS) {
        const label = `${pair.name} usePrevious=${usePrevious} width=${width}`;
        const thisForward = usePrevious ? pair.prev : pair.next;
        const joint = join(vec2(...thisForward), garbage, width, true);
        if (!finite(joint)) {
          violations.push(
            `${label}: non-finite (${joint.x}, ${joint.y}, ${joint.z})`,
          );
          continue;
        }
        // GLSL: leftWC = thisSegmentLeftWC, expandWidth = width * 0.5.
        if (
          !close(joint.x, -thisForward[1], 1e-12) ||
          !close(joint.y, thisForward[0], 1e-12) ||
          !close(joint.z, width * 0.5, 1e-12)
        ) {
          violations.push(
            `${label}: (${joint.x}, ${joint.y}, ${joint.z}) is not this segment's left at half the width`,
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
  // is (0,-1); at the last vertex the arriving segment (1,0) has left normal
  // (0,1). Both at half the width.
  const leaving = extrusionOf(
    callJoin(shippedJoin, [1, 0], [-1, 0], false, 10),
  );
  assert.ok(close(leaving.left[0], 0, 1e-12), `x ${leaving.left[0]}`);
  assert.ok(close(leaving.left[1], -1, 1e-12), `y ${leaving.left[1]}`);
  assert.ok(close(leaving.length, 5, 1e-9), `length ${leaving.length}`);
  const arriving = extrusionOf(
    callJoin(shippedJoin, [1, 0], [-1, 0], true, 10),
  );
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
    const joint = callJoin(rounded, prev, next, usePrevious, 10);
    assert.ok(
      finite(joint),
      `usePrevious=${usePrevious}: (${joint.x}, ${joint.y}, ${joint.z})`,
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════
// H2 — everything else is in parity with WebGL
// ═══════════════════════════════════════════════════════════════════════

test("H2: joints from straight on through a near-reversal match WebGL", () => {
  assert.deepEqual(bentViolations(shippedJoin), []);
});

test("H2: a straight joint extrudes at exactly half the width", () => {
  const got = extrusionOf(callJoin(shippedJoin, [1, 0], [1, 0], false, 10));
  assert.ok(close(got.left[0], 0, 1e-12));
  assert.ok(close(got.left[1], 1, 1e-12));
  assert.ok(close(got.length, 5, 1e-9));
});

test("H2: a near-reversal is clamped to twice the width, as WebGL clamps it", () => {
  // |sum| = 1.2e-6 is just over czm_epsilon6, so the bisector stands and its
  // sine is vanishing: half the width over a tiny sine clamps to 2 * width.
  const got = extrusionOf(
    callJoin(shippedJoin, [1, 0], unit(Math.PI - 1.2e-6), false, 10),
  );
  assert.ok(close(got.length, 20, 1e-9), `length ${got.length}`);
});

// ═══════════════════════════════════════════════════════════════════════
// H3 — a coincident position
// ═══════════════════════════════════════════════════════════════════════

test("H3: a coincident position takes its own left normal at half the width", () => {
  assert.deepEqual(coincidentViolations(shippedJoin), []);
});

// ═══════════════════════════════════════════════════════════════════════
// M — inertness images
// ═══════════════════════════════════════════════════════════════════════

test("M1: with the hairpin test unreachable, H1 goes RED (non-finite)", () => {
  const image = mutate(
    shipped,
    "leftSumLength < CSM_POLYLINE_EPSILON6",
    "leftSumLength < -1.0",
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

test("M2: with the hairpin test always true, H2 goes RED on every turning joint", () => {
  const image = mutate(
    shipped,
    "leftSumLength < CSM_POLYLINE_EPSILON6",
    "leftSumLength < 2.1",
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

test("M3: with the coincident arm unreachable, H3 goes RED", () => {
  const image = mutate(
    shipped,
    "if (coincident) {",
    "if (false && coincident) {",
  );
  const violations = coincidentViolations(compileJoin(image));
  assert.ok(
    violations.length > 0,
    "H3 stayed green over a dead coincident arm",
  );
  assert.deepEqual(hairpinViolations(compileJoin(image)), []);
});

test("M4: the mutation helper refuses a substitution that matched nothing", () => {
  assert.throws(
    () => mutate(shipped, "no such text anywhere", "x"),
    /matched nothing/u,
  );
});
