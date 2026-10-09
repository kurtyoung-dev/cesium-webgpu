// ssr-pass-frame.spec.mjs — the screen-space reflections pass covers its whole
// target, unprojects and projects in one screen frame, and refines its hit by
// true bisection.
//
// @purpose Executes the SSR shader's pure helpers from the shipped WGSL and checks them against independent JavaScript references: full-target coverage of the draw, the UV/NDC round trip with and without log depth, and the bisection refinement over a synthetic plane.
// @status ACTIVE
//
// Run: node --test Tools/visual-regression/ssr-pass-frame.spec.mjs
//
// WHAT IT PROVES. Three behaviours of `PostProcess/ScreenSpaceReflections.wgsl`:
//   A. The single three-vertex triangle-list draw writes every pixel of its
//      target, and the UV it interpolates for a pixel is that pixel's own
//      (row 0 is the top).
//   B. `reconstructViewPosition` and `projectToScreen` are exact inverses in
//      that frame, with the log-depth flag off and on, and agree with an
//      independently built perspective projection, not only with each other.
//   C. After a march step detects a hit, the refinement lands within one final
//      refinement step (1/64 of a march step) of the depth crossing, from
//      either side and whichever way the depth difference changes sign.
//
// HOW IT AVOIDS CERTIFYING ITSELF. Every number the shader produces is read out
// of the shipped file by `wgsl-mini-eval`. The references below are not copies
// of the shader's arithmetic: coverage is a barycentric containment test over
// pixel centres, the projection is a perspective matrix built here and
// inverted numerically, the log encoding is the forward map of the shader's
// reverse, and the crossing is the analytic zero of a linear depth difference.
//
// WHAT IT DELIBERATELY DOES NOT PROVE. `vertexMain` (an entry point with a
// builtin input) and `traceRay` (loops and texture fetches) are outside the
// evaluator's subset. That they CALL the helpers is accepted by the Edge leg's
// BEFORE/AFTER pair. The refinement's loop cadence (five depth-sampled steps of
// 1/2 .. 1/32, then one 1/64 step steered by the fifth sample) lives in
// `traceRay`, so group C TRANSCRIBES it in `refine()`; a change to the cadence
// in the shader is not seen here.
//
// INERTNESS. Group M rebuilds each check over a mutated copy of the shader
// text and requires it to fail; its control edits a comment and requires the
// checks to stay green. `SSR_SHADER_PATH` points the whole file at another
// shader, which is how a mutant is run from outside without touching the
// shipped file.
//
// CRLF: this repo checks out with `core.autocrlf=true`; the reader normalises
// line endings before matching.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileFunction,
  mat4,
  stripComments,
  vec4,
} from "./lib/wgsl-mini-eval.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const SHADER_REL =
  "packages/engine/Source/Shaders/WebGPU/PostProcess/ScreenSpaceReflections.wgsl";
const SHADER_PATH = process.env.SSR_SHADER_PATH
  ? path.resolve(process.env.SSR_SHADER_PATH)
  : path.join(ROOT, SHADER_REL);

/**
 * Read a shader with its line endings normalised to LF.
 *
 * @param {string} file Absolute path.
 * @returns {string} The source.
 */
function readShader(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

const SHIPPED = readShader(SHADER_PATH);

// ───────── references (independent of the shader's arithmetic) ───────────────

/**
 * A perspective projection with a [0, 1] depth range, looking down -z, as a
 * column-major array.
 *
 * @param {number} fovY Vertical field of view in radians.
 * @param {number} aspect Width over height.
 * @param {number} near Near distance.
 * @param {number} far Far distance.
 * @returns {number[]} Sixteen column-major elements.
 */
function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  // prettier-ignore
  return [
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far / (near - far), -1,
    0, 0, (near * far) / (near - far), 0,
  ];
}

/**
 * Numerically invert a column-major 4x4 by Gauss-Jordan elimination, so the
 * inverse the shader is handed was not derived from the projection's closed
 * form.
 *
 * @param {number[]} m Sixteen column-major elements.
 * @returns {number[]} The inverse, column-major.
 */
function invert4(m) {
  const a = [];
  for (let r = 0; r < 4; r += 1) {
    const row = [];
    for (let c = 0; c < 4; c += 1) {
      row.push(m[c * 4 + r]);
    }
    for (let c = 0; c < 4; c += 1) {
      row.push(r === c ? 1 : 0);
    }
    a.push(row);
  }
  for (let col = 0; col < 4; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < 4; r += 1) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) {
        pivot = r;
      }
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const d = a[col][col];
    for (let c = 0; c < 8; c += 1) {
      a[col][c] /= d;
    }
    for (let r = 0; r < 4; r += 1) {
      if (r !== col) {
        const k = a[r][col];
        for (let c = 0; c < 8; c += 1) {
          a[r][c] -= k * a[col][c];
        }
      }
    }
  }
  const out = new Array(16);
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      out[c * 4 + r] = a[r][4 + c];
    }
  }
  return out;
}

const NEAR = 0.5;
const FAR = 400;
const PROJECTION = perspective(1.0, 16 / 9, NEAR, FAR);
const INVERSE = invert4(PROJECTION);

/**
 * Where a view-space point lands on screen, from the projection alone: UV with
 * row 0 at the top, and hyperbolic NDC z.
 *
 * @param {{x: number, y: number, z: number}} v View-space point (z < 0).
 * @returns {{u: number, v: number, z: number}} Screen position.
 */
function referenceProject(v) {
  const m = PROJECTION;
  const clip = [0, 1, 2, 3].map(
    (row) => m[row] * v.x + m[4 + row] * v.y + m[8 + row] * v.z + m[12 + row],
  );
  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  return { u: ndcX * 0.5 + 0.5, v: 0.5 - ndcY * 0.5, z: clip[2] / clip[3] };
}

/**
 * The log-encoded depth the renderer writes for a view-space distance: the
 * forward map of the shader's `logDepthReverse`.
 *
 * @param {number} distance Positive distance along the view axis.
 * @returns {number} Log depth in [0, 1].
 */
function logEncode(distance) {
  return Math.log2(distance - NEAR + 1) / Math.log2(FAR - NEAR + 1);
}

// ───────── binding the shipped helpers ───────────────────────────────────────

/**
 * Compile the SSR helpers from a shader source and bind the module-scope
 * uniform they read.
 *
 * @param {string} source Shader text.
 * @param {{logOn?: boolean, round?: (x: number) => number}} [options] Log-depth
 *   flag and an optional f32 rounding hook.
 * @returns {Record<string, Function>} The helpers by name.
 */
function bind(source, options = {}) {
  const src = stripComments(source);
  const globals = {
    ssr: {
      projection: mat4(PROJECTION),
      inverseProjection: mat4(INVERSE),
      flags: vec4(0, options.logOn ? 1 : 0, NEAR, FAR),
    },
    __functions: {},
  };
  if (options.round) {
    globals.__round = options.round;
  }
  const names = [
    "ssrFullScreenCorner",
    "ssrNdcToUV",
    "ssrUVToNdc",
    "logDepthReverse",
    "ssrNdcDepth",
    "reconstructViewPosition",
    "projectToScreen",
    "ssrBisectStep",
  ];
  const out = {};
  for (const name of names) {
    out[name] = compileFunction(src, name, globals);
    globals.__functions[name] = out[name];
  }
  return out;
}

const close = (a, b, tolerance, label) =>
  assert.ok(
    Math.abs(a - b) <= tolerance,
    `${label}: ${a} vs ${b} (tolerance ${tolerance})`,
  );

// ───────── A. coverage ───────────────────────────────────────────────────────

/**
 * Barycentric weights of an NDC point in the triangle (a, b, c).
 *
 * @param {object} a First corner.
 * @param {object} b Second corner.
 * @param {object} c Third corner.
 * @param {number} px NDC x.
 * @param {number} py NDC y.
 * @returns {number[]} Weights for a, b, c.
 */
function barycentric(a, b, c, px, py) {
  const det = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
  assert.ok(Math.abs(det) > 1e-9, "the three corners are not a triangle");
  const l1 = ((px - a.x) * (c.y - a.y) - (c.x - a.x) * (py - a.y)) / det;
  const l2 = ((b.x - a.x) * (py - a.y) - (px - a.x) * (b.y - a.y)) / det;
  return [1 - l1 - l2, l1, l2];
}

/**
 * Check that the three emitted corners cover every pixel of a W x H target and
 * that the UV interpolated across them is each pixel's own.
 *
 * @param {string} source Shader text.
 * @returns {void}
 */
function checkCoverage(source) {
  const h = bind(source);
  const corners = [0, 1, 2].map((i) => h.ssrFullScreenCorner(i));
  const uvs = corners.map((c) => h.ssrNdcToUV(c));
  const [a, b, c] = corners;
  const WIDTH = 16;
  const HEIGHT = 9;
  const slack = 1e-9;
  for (let j = 0; j < HEIGHT; j += 1) {
    for (let i = 0; i < WIDTH; i += 1) {
      const px = ((i + 0.5) / WIDTH) * 2 - 1;
      const py = 1 - ((j + 0.5) / HEIGHT) * 2;
      const w = barycentric(a, b, c, px, py);
      assert.ok(
        w.every((weight) => weight >= -slack),
        `pixel (${i}, ${j}) is outside the drawn triangle`,
      );
      const u = w[0] * uvs[0].x + w[1] * uvs[1].x + w[2] * uvs[2].x;
      const v = w[0] * uvs[0].y + w[1] * uvs[1].y + w[2] * uvs[2].y;
      close(u, (i + 0.5) / WIDTH, 1e-9, `uv.x of pixel (${i}, ${j})`);
      close(v, (j + 0.5) / HEIGHT, 1e-9, `uv.y of pixel (${i}, ${j})`);
    }
  }
  // The four corners of NDC, where the diagonal edge of a too-small triangle
  // would cut, are inside too.
  for (const [px, py] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    assert.ok(
      barycentric(a, b, c, px, py).every((weight) => weight >= -slack),
      `NDC corner (${px}, ${py}) is outside the drawn triangle`,
    );
  }
}

test("A1 the draw writes every pixel and interpolates each pixel's own UV", () => {
  checkCoverage(SHIPPED);
});

test("A2 the top-right half the old corners left unwritten is covered", () => {
  const h = bind(SHIPPED);
  const [a, b, c] = [0, 1, 2].map((i) => h.ssrFullScreenCorner(i));
  // Pixels with u > v lie right of the screen's top-left to bottom-right
  // diagonal; sample a few of them in NDC.
  for (const [px, py] of [
    [0.75, 0.75],
    [0.2, 0.9],
    [0.95, -0.4],
  ]) {
    assert.ok(
      barycentric(a, b, c, px, py).every((weight) => weight >= 0),
      `NDC (${px}, ${py}) is not drawn`,
    );
  }
});

// ───────── B. the screen frame ───────────────────────────────────────────────

const UV_GRID = [];
for (const u of [0, 0.03, 0.25, 0.5, 0.71, 0.97, 1]) {
  for (const v of [0, 0.04, 0.25, 0.5, 0.66, 0.96, 1]) {
    UV_GRID.push([u, v]);
  }
}
const DEPTHS = [0.05, 0.3, 0.5, 0.8, 0.97];

/**
 * Check projecting a reconstructed position returns its UV, with the log flag
 * as given.
 *
 * @param {string} source Shader text.
 * @param {boolean} logOn Log-depth flag.
 * @param {number} tolerance Absolute tolerance on UV.
 * @param {(x: number) => number} [round] Optional f32 hook.
 * @returns {void}
 */
function checkRoundTrip(source, logOn, tolerance, round) {
  const h = bind(source, { logOn, round });
  for (const [u, v] of UV_GRID) {
    for (const depth of DEPTHS) {
      const view = h.reconstructViewPosition({ x: u, y: v }, depth);
      assert.ok(view.z < 0, "reconstructed point is in front of the camera");
      const back = h.projectToScreen(view);
      const where = `(${u}, ${v}, depth ${depth}) logOn=${logOn}`;
      close(back.x, u, tolerance, `u at ${where}`);
      close(back.y, v, tolerance, `v at ${where}`);
    }
  }
}

/**
 * Check against a projection built here: a known view-space point is recovered
 * from its screen position and depth, and projects to that screen position, so
 * the frame agrees with the vertex stage and not only with itself.
 *
 * @param {string} source Shader text.
 * @param {boolean} logOn Log-depth flag.
 * @returns {void}
 */
function checkAgainstProjection(source, logOn) {
  const h = bind(source, { logOn });
  const points = [
    { x: 0, y: 2, z: -5 },
    { x: 0, y: -2, z: -5 },
    { x: 3, y: 0.5, z: -12 },
    { x: -4, y: -1.5, z: -30 },
    { x: 20, y: 9, z: -90 },
    { x: -1, y: 1, z: -2 },
  ];
  for (const p of points) {
    const ref = referenceProject(p);
    const depth = logOn ? logEncode(-p.z) : ref.z;
    const rebuilt = h.reconstructViewPosition({ x: ref.u, y: ref.v }, depth);
    close(rebuilt.x, p.x, 1e-6 * Math.max(1, Math.abs(p.x)), "view x");
    close(rebuilt.y, p.y, 1e-6 * Math.max(1, Math.abs(p.y)), "view y");
    close(rebuilt.z, p.z, 1e-6 * Math.max(1, Math.abs(p.z)), "view z");
    const proj = h.projectToScreen(p);
    close(proj.x, ref.u, 1e-9, "projected u");
    close(proj.y, ref.v, 1e-9, "projected v");
    close(proj.z, ref.z, 1e-9, "projected NDC z");
    if (p.y > 0) {
      assert.ok(proj.y < 0.5, "a point above the axis is in the top half");
    } else if (p.y < 0) {
      assert.ok(proj.y > 0.5, "a point below the axis is in the bottom half");
    }
  }
}

test("B1 reconstruct then project returns the UV, log depth off", () => {
  checkRoundTrip(SHIPPED, false, 1e-9);
});

test("B2 reconstruct then project returns the UV, log depth on", () => {
  checkRoundTrip(SHIPPED, true, 1e-9);
});

test("B3 the round trip holds at f32 rounding", () => {
  checkRoundTrip(SHIPPED, false, 2e-3, Math.fround);
  checkRoundTrip(SHIPPED, true, 2e-3, Math.fround);
});

test("B4 the frame agrees with an independent perspective projection, log off", () => {
  checkAgainstProjection(SHIPPED, false);
});

test("B5 the frame agrees with an independent perspective projection, log on", () => {
  checkAgainstProjection(SHIPPED, true);
});

test("B6 the UV the vertex stage emits is the UV the pass unprojects with", () => {
  const h = bind(SHIPPED);
  // NDC y = +1 is the top row (uv.y = 0); NDC y = -1 the bottom (uv.y = 1).
  const top = h.ssrNdcToUV({ x: 0, y: 1 });
  const bottom = h.ssrNdcToUV({ x: 0, y: -1 });
  close(top.y, 0, 1e-12, "NDC y = +1 maps to uv.y = 0");
  close(bottom.y, 1, 1e-12, "NDC y = -1 maps to uv.y = 1");
  // The unproject of a top-row UV is the NDC y the vertex stage started from.
  const ndc = h.ssrUVToNdc({ x: 0.25, y: 0 });
  close(ndc.y, 1, 1e-12, "uv.y = 0 maps back to NDC y = +1");
  close(ndc.x, -0.5, 1e-12, "uv.x = 0.25 maps back to NDC x = -0.5");
});

// ───────── C. refinement ─────────────────────────────────────────────────────

const scaled = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });

/**
 * Drive the refinement as `traceRay` does. The cadence is transcribed here
 * because the loop and its texture fetches are outside the evaluator's subset.
 * `diffAt` stands for the ray-minus-scene depth difference a texture fetch and
 * an unproject would give at a position.
 *
 * @param {Record<string, Function>} h Bound helpers.
 * @param {{x: number, y: number, z: number}} hitPos Position at the hit step.
 * @param {{x: number, y: number, z: number}} step The march step.
 * @param {number} hitDiff Depth difference at the hit step.
 * @param {(p: object) => number} diffAt Depth difference at a position.
 * @returns {{x: number, y: number, z: number}} The refined position.
 */
function refine(h, hitPos, step, hitDiff, diffAt) {
  let pos = hitPos;
  let half = scaled(step, 0.5);
  let diff = hitDiff;
  for (let r = 0; r < 5; r += 1) {
    pos = h.ssrBisectStep(pos, half, diff, hitDiff);
    half = scaled(half, 0.5);
    diff = diffAt(pos);
  }
  return h.ssrBisectStep(pos, half, diff, hitDiff);
}

/**
 * Check the refined point lies within one final step of the true crossing for
 * crossings across the march step, for either sign of the depth difference's
 * change.
 *
 * @param {string} source Shader text.
 * @returns {void}
 */
function checkRefinement(source) {
  const h = bind(source);
  const step = { x: 0.6, y: -0.3, z: -1.7 };
  const prev = { x: 1.0, y: 2.0, z: -10.0 };
  const hit = { x: prev.x + step.x, y: prev.y + step.y, z: prev.z + step.z };
  const stepLength = Math.hypot(step.x, step.y, step.z);
  const finalStep = stepLength / 64;
  const slack = 1e-9;
  const fractionAlong = (p) =>
    ((p.x - prev.x) * step.x +
      (p.y - prev.y) * step.y +
      (p.z - prev.z) * step.z) /
    (stepLength * stepLength);
  for (const sign of [1, -1]) {
    for (let k = 1; k < 400; k += 1) {
      // Crossing fraction along the step, off the dyadic grid the bisection
      // visits, so no run lands on it exactly.
      const t = (k + 0.37) / 400.37;
      // A planar scene: the signed depth difference is linear in the position,
      // zero at fraction t, and `sign` says which way it changes across it.
      const diffAt = (p) => sign * (fractionAlong(p) - t) * 3.0;
      const hitDiff = diffAt(hit);
      assert.equal(hitDiff > 0, sign > 0, "fixture: hit is on the sign's side");
      const refined = refine(h, hit, step, hitDiff, diffAt);
      const miss = Math.abs(fractionAlong(refined) - t) * stepLength;
      assert.ok(
        miss <= finalStep + slack,
        `sign ${sign}, crossing ${t}: refined point misses by ${miss} > ${finalStep}`,
      );
    }
  }
}

test("C1 the refined hit is within one final step of the crossing, either sign", () => {
  checkRefinement(SHIPPED);
});

test("C2 one step moves back on the hit's side and forward past the crossing", () => {
  const h = bind(SHIPPED);
  const pos = { x: 5, y: 5, z: -5 };
  const half = { x: 1, y: 2, z: -3 };
  const xyz = (v) => [v.x, v.y, v.z];
  assert.deepEqual(xyz(h.ssrBisectStep(pos, half, 0.4, 0.9)), [4, 3, -2]);
  assert.deepEqual(xyz(h.ssrBisectStep(pos, half, -0.4, 0.9)), [6, 7, -8]);
  assert.deepEqual(xyz(h.ssrBisectStep(pos, half, -0.4, -0.9)), [4, 3, -2]);
  assert.deepEqual(xyz(h.ssrBisectStep(pos, half, 0.4, -0.9)), [6, 7, -8]);
});

// ───────── M. inertness: the checks go red on the pre-fix behaviour ──────────

/**
 * Replace one exact fragment of a shader, failing if it is not there exactly
 * once, so a mutant that no longer applies cannot pass for want of a target.
 *
 * @param {string} source Shader text.
 * @param {string} from Fragment to replace.
 * @param {string} to Replacement.
 * @returns {string} The mutated text.
 */
function mutate(source, from, to) {
  const at = source.indexOf(from);
  assert.ok(at >= 0, `mutant target not found: ${from}`);
  assert.equal(
    source.indexOf(from, at + 1),
    -1,
    `mutant target not unique: ${from}`,
  );
  return source.slice(0, at) + to + source.slice(at + from.length);
}

const BISECT_RETURN =
  "return select(pos + halfStep, pos - halfStep, (diff > 0.0) == (hitDiff > 0.0));";

const MUTANTS = {
  // The corners the pass drew before the fix.
  oldCorners: (s) =>
    mutate(
      mutate(
        s,
        "select(-1.0, 3.0, vertexIndex == 1.0)",
        "select(-1.0, 1.0, vertexIndex == 1.0)",
      ),
      "select(-1.0, 3.0, vertexIndex == 2.0)",
      "select(-1.0, 1.0, vertexIndex == 2.0)",
    ),
  // The unproject loses its Y flip while the project keeps it.
  noUnprojectFlip: (s) =>
    mutate(
      s,
      "return vec2<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);",
      "return vec2<f32>(uv.x * 2.0 - 1.0, uv.y * 2.0 - 1.0);",
    ),
  // The project loses its Y flip while the unproject keeps it.
  noProjectFlip: (s) =>
    mutate(
      s,
      "return vec2<f32>(ndc.x * 0.5 + 0.5, 1.0 - (ndc.y * 0.5 + 0.5));",
      "return vec2<f32>(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5);",
    ),
  // The log-depth reverse is unreachable.
  logDepthUnreachable: (s) =>
    mutate(s, "if (ssr.flags.y > 0.5) {", "if (false && ssr.flags.y > 0.5) {"),
  // The one-sided walk: always steps back, or never does.
  alwaysBack: (s) => mutate(s, BISECT_RETURN, "return pos - halfStep;"),
  neverBack: (s) => mutate(s, BISECT_RETURN, "return pos + halfStep;"),
};

test("M0 control: a comment edit leaves every check green", () => {
  const edited = `// comment only\n${SHIPPED}`;
  checkCoverage(edited);
  checkRoundTrip(edited, false, 1e-9);
  checkRoundTrip(edited, true, 1e-9);
  checkAgainstProjection(edited, false);
  checkAgainstProjection(edited, true);
  checkRefinement(edited);
});

test("M1 coverage goes red when the corners are the old ones", () => {
  const source = MUTANTS.oldCorners(SHIPPED);
  assert.throws(() => checkCoverage(source), assert.AssertionError);
});

test("M2 the frame goes red when either side loses the Y flip", () => {
  for (const key of ["noUnprojectFlip", "noProjectFlip"]) {
    const source = MUTANTS[key](SHIPPED);
    assert.throws(
      () => checkRoundTrip(source, false, 1e-9),
      assert.AssertionError,
      key,
    );
    assert.throws(
      () => checkAgainstProjection(source, false),
      assert.AssertionError,
      key,
    );
  }
});

test("M3 the log-on checks go red when the log reverse is unreachable", () => {
  const source = MUTANTS.logDepthUnreachable(SHIPPED);
  assert.throws(
    () => checkAgainstProjection(source, true),
    assert.AssertionError,
  );
  // The flag-off path does not need it.
  checkAgainstProjection(source, false);
});

test("M4 the refinement goes red on a one-sided walk", () => {
  for (const key of ["alwaysBack", "neverBack"]) {
    const source = MUTANTS[key](SHIPPED);
    assert.throws(() => checkRefinement(source), assert.AssertionError, key);
  }
});
