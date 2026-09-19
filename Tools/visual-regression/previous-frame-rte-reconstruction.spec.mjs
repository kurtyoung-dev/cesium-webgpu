// previous-frame-rte-reconstruction.spec.mjs — the previous-frame position a
// velocity vertex stage projects is reconstructed relative to the previous eye,
// by the same arithmetic the current frame uses.
// @purpose Executes each velocity stage's previous- and current-frame position reconstruction straight out of the shipped WGSL, in f32, and measures the two properties that make a still primitive emit no velocity: the two reconstructions agree bit for bit on a history-reset frame, and the previous one is eye-relative rather than a full-magnitude world position.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// Every WebGPU velocity vertex stage computed the CURRENT clip position
// exactly — differencing a high/low position split against the encoded camera
// split, then multiplying a translation-free matrix — and the PREVIOUS one by
// summing `high + low` into a full-magnitude f32 world position and multiplying
// a full-magnitude world-space matrix. Seven sites did it, in six shader files
// and one renderer whose WGSL is a template literal.
//
// The consequence is not a rounding curiosity. The velocity target carries
// `current - previous`, so a reconstruction that differs from the current one
// by the f32 quantum at Earth radius puts that difference into the motion
// vector of a primitive that never moved, and the temporal resolve reprojects
// its history from the wrong place.
//
// WHAT IS ASSERTED, AND WHY IN THIS FORM
// --------------------------------------
//  1. THE RESET-FRAME IDENTITY. `UniformState.update` resets the previous
//     camera record to the current one whenever the active View's temporal
//     history is incompatible — first frame, teleport, morph, scene-mode or
//     projection change (`Renderer/UniformState.js:897-905`). On such a frame
//     the previous matrix and the previous camera split ARE the current ones,
//     so a correct previous-frame path must produce a position bit-identical to
//     the current one and the velocity must be exactly zero. That is not a
//     contrived condition invented for a test: it is a state the engine itself
//     constructs, and it is the state the Edge leg measures. Asserted with
//     `Object.is` per component, over a sample set that includes a pole, the
//     antimeridian and negative coordinates.
//
//  2. THE RECONSTRUCTION IS EYE-RELATIVE. The previous expression, evaluated in
//     f32 against a camera 1 km from the subject, lands within a centimetre of
//     the eye-relative position the split encodes. The pre-fix form cannot: it
//     forms the absolute position first, and half an ulp of 6.4e6 is a quarter
//     of a metre.
//
//  3. THE PREVIOUS MATRIX IS THE ONE BEING MULTIPLIED. The operand each site
//     contributes is found by locating the multiply by the previous
//     relative-to-eye matrix and reading its `vec4` argument, not by trusting a
//     binding name. A site that reverts to multiplying the world-space
//     `previousViewProjection` stops being found at all, which is a failure.
//
//  4. THE READER IS NOT VACUOUS. Each previous expression must actually
//     reference the previous encoded camera lanes; an expression that
//     references neither would satisfy (1) trivially if a future edit made both
//     sides constant.
//
// HOW IT EXECUTES SHIPPED TEXT. `lib/wgsl-mini-eval.mjs` parses and evaluates
// the arithmetic subset of WGSL, so every number below comes from the text that
// ships rather than from a transcription of it. Two things make it usable here:
// the evaluator's `__round` hook, which lands every intermediate on the nearest
// f32 as the pipeline does — without it an f64 reader reproduces `high + low`
// exactly and reports the defect as absent — and a small statement runner for
// the one helper that carries a guarded assignment, which the shared
// `compileFunction` deliberately refuses. The runner fails closed: a construct
// it cannot read throws rather than being skipped.
//
// MUTANTS. For every site, a copy of the shipped text — held in memory, never
// written to disk — replaces the previous encoded-camera operands with zero.
// That is exactly the arithmetic the pre-fix text performed, written in a shape
// this reader can still parse: a mutant that merely deleted the line would make
// the reader throw, and a throw cannot distinguish "the fix is load bearing"
// from "the mutant is unreadable". Each mutant must push the reconstruction
// error above a tenth of a metre, and the velocity measurement above the Edge
// leg's BEFORE bar of 5.0e-4 NDC at the ranges where a user would see it.
//
// Run: node --test Tools/visual-regression/previous-frame-rte-reconstruction.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import EncodedCartesian3 from "../../packages/engine/Source/Core/EncodedCartesian3.js";
import Matrix4 from "../../packages/engine/Source/Core/Matrix4.js";
import PerspectiveFrustum from "../../packages/engine/Source/Core/PerspectiveFrustum.js";
import {
  compileFunction,
  evaluate,
  parseExpression,
  stripComments,
  tokenize,
  vec,
} from "./lib/wgsl-mini-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// This checkout is CRLF; every text read is normalised before any offset
// arithmetic, because the REPO-TOOLING-SOURCE-ANCHOR-FRAGILITY class has cost
// this fleet several cycles.
const readSource = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

const f32 = Math.fround;

// ── Reading one site's arithmetic out of the shipped text ───────────────────

/**
 * Normalise a WGSL expression into the evaluator's grammar.
 *
 * The only difference that matters is the trailing comma WGSL permits in an
 * argument list and the evaluator does not. Removing it is syntax, not
 * semantics; widening the shared grammar for it would be.
 *
 * @param {string} text Expression text.
 * @returns {string} The same expression, parseable.
 */
function normalizeExpression(text) {
  return text.trim().replace(/,(\s*[)\]])/g, "$1");
}

/**
 * Text of the expression bound to `let NAME = …;` or `var NAME = …;`.
 *
 * @param {string} source Comment-stripped WGSL.
 * @param {string} name Binding name.
 * @returns {string} The initialiser expression.
 */
function bindingExpression(source, name) {
  const re = new RegExp(`\\b(?:let|var)\\s+${name}\\s*(?::[^=;]+)?=`);
  const at = source.search(re);
  assert.ok(at >= 0, `no binding named ${name}`);
  const from = source.indexOf("=", at) + 1;
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === ";" && depth === 0) {
      return normalizeExpression(source.slice(from, i));
    }
  }
  throw new Error(`unterminated binding ${name}`);
}

/**
 * Split an argument list on its LAST top-level comma and return the head.
 *
 * The position operand of a `vec4<f32>(X, 1.0)` may itself contain commas, so
 * the split has to be the last one at depth zero rather than the first.
 *
 * @param {string} args Text between the parentheses.
 * @returns {string} Everything before the last top-level comma.
 */
function headArgument(args) {
  let depth = 0;
  let lastComma = -1;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i];
    if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) lastComma = i;
  }
  return normalizeExpression(lastComma >= 0 ? args.slice(0, lastComma) : args);
}

/**
 * The position operand of `<uniform>.<matrixField> * <operand>`.
 *
 * Found by the multiply rather than by a binding name, so the assertion also
 * pins WHICH matrix consumes the position: a site that went back to the
 * world-space matrix stops matching and the caller's lookup fails, which is the
 * outcome wanted.
 *
 * Two operand shapes occur in the tree and both are read here: a `vec4`
 * constructed at the multiply, whose head argument is the position; and a bare
 * identifier bound earlier, which is resolved through its binding.
 *
 * @param {string} source Comment-stripped WGSL.
 * @param {string} matrixField The uniform field name.
 * @param {number} [from] Index to search from, for a file with two sites.
 * @returns {{text: string, end: number}} The operand expression and the index
 *   just past the multiply, so a caller can find the next site.
 */
function positionOperandOf(source, matrixField, from = 0) {
  const re = new RegExp(`\\b[A-Za-z_][A-Za-z0-9_]*\\.${matrixField}\\s*\\*`);
  const found = source.slice(from).search(re);
  assert.ok(found >= 0, `no multiply by .${matrixField}`);
  const at = from + found;
  const star = source.indexOf("*", at);
  // Read the operand as the text up to the end of the statement, then decide
  // its shape. Anchoring on the next "(" instead would walk into whatever
  // parenthesis happened to come next when the operand is a bare identifier —
  // which is how this reader first returned a neighbouring expression.
  let depth = 0;
  let end = source.length;
  for (let i = star + 1; i < source.length; i += 1) {
    const c = source[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === ";" && depth === 0) {
      end = i;
      break;
    }
  }
  const operand = normalizeExpression(source.slice(star + 1, end));
  const call = /^vec4(?:<[^>]*>)?\s*\(/.exec(operand);
  if (call !== null) {
    const open = operand.indexOf("(", call[0].length - 1);
    let callDepth = 0;
    let close = -1;
    for (let i = open; i < operand.length; i += 1) {
      if (operand[i] === "(") callDepth += 1;
      else if (operand[i] === ")") {
        callDepth -= 1;
        if (callDepth === 0) {
          close = i;
          break;
        }
      }
    }
    assert.ok(close > open, `unterminated vec4 after .${matrixField}`);
    const head = headArgument(operand.slice(open + 1, close));
    return {
      text: /^[A-Za-z_][A-Za-z0-9_]*$/.test(head)
        ? bindingExpression(source, head)
        : head,
      end,
    };
  }
  return {
    text: /^[A-Za-z_][A-Za-z0-9_]*$/.test(operand)
      ? bindingExpression(source, operand)
      : operand,
    end,
  };
}

// ── Evaluating it in f32 ────────────────────────────────────────────────────

/**
 * Run the statement subset of a WGSL function body.
 *
 * `compileFunction` in the shared library supports a guarded early RETURN and
 * nothing else inside an `if`, which is the right conservative default for it.
 * One helper here — the point primitive's two-argument `translateRelativeToEye`
 * — carries a guarded ASSIGNMENT instead, a device NaN workaround. Rather than
 * widen the shared grammar for every consumer, this runner handles the two
 * extra statement shapes locally and throws on anything else.
 *
 * @param {string} body Function body text, comments stripped.
 * @param {object} env Bindings, including `__round` and `__functions`.
 * @returns {number|object} The returned value.
 */
/**
 * The condition text of an `if (...) { ... }` statement, by paren matching.
 *
 * @param {string} statement The statement text.
 * @returns {string|undefined} The condition, or undefined if there is none.
 */
function conditionOf(statement) {
  const open = statement.indexOf("(");
  if (open < 0) {
    return undefined;
  }
  let depth = 0;
  for (let i = open; i < statement.length; i += 1) {
    if (statement[i] === "(") depth += 1;
    else if (statement[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        return statement.slice(open + 1, i);
      }
    }
  }
  return undefined;
}

/**
 * Split a function body into statements, respecting nesting.
 *
 * A `;` inside a braced block ends an inner statement, not an outer one, so a
 * naive split on `;` tears a guard in half and the runner then refuses text it
 * can in fact read.
 *
 * @param {string} body Function body text.
 * @returns {string[]} The statements, in order.
 */
function splitStatements(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c === "(" || c === "[" || c === "{") {
      depth += 1;
    } else if (c === ")" || c === "]") {
      depth -= 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        out.push(body.slice(start, i + 1).trim());
        start = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = body.slice(start).trim();
  if (tail.length > 0) {
    out.push(tail);
  }
  return out.filter((s) => s.length > 0);
}

function runBody(body, env) {
  const result = runStatements(body, env);
  if (!result.returned) {
    throw new Error("body fell through without returning");
  }
  return result.value;
}

/**
 * Execute the statement subset, reporting whether a `return` was reached.
 *
 * @param {string} body Statement text.
 * @param {object} env Bindings, mutated in place.
 * @returns {{returned: boolean, value?: number|object}} The outcome.
 */
function runStatements(body, env) {
  for (const statement of splitStatements(body)) {
    const ret = /^return\s+([\s\S]+)$/.exec(statement);
    if (ret !== null) {
      return {
        returned: true,
        value: evalExpression(normalizeExpression(ret[1]), env),
      };
    }
    const guard = statement.startsWith("if")
      ? conditionOf(statement)
      : undefined;
    if (guard !== undefined) {
      const taken = evalExpression(normalizeExpression(guard), env);
      assert.equal(
        typeof taken,
        "boolean",
        "a guard condition must evaluate to a boolean",
      );
      if (taken === true) {
        // The guard is a device workaround that canonicalises an already-zero
        // high difference, and it FIRES for a camera close enough to share a
        // position's encoding cell — which is most of this fixture. Execute it
        // rather than refuse it: what matters is that both frames run the same
        // statements, and skipping it on one side would manufacture the very
        // asymmetry under test.
        const open = statement.indexOf("{");
        runStatements(
          statement.slice(open + 1, statement.lastIndexOf("}")),
          env,
        );
      }
      continue;
    }
    const bind =
      /^(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=([\s\S]+)$/.exec(
        statement,
      );
    if (bind !== null) {
      env[bind[1]] = evalExpression(normalizeExpression(bind[2]), env);
      continue;
    }
    const assign = /^([A-Za-z_][A-Za-z0-9_]*)\s*=([\s\S]+)$/.exec(statement);
    if (assign !== null) {
      env[assign[1]] = evalExpression(normalizeExpression(assign[2]), env);
      continue;
    }
    throw new Error(`unsupported statement: ${statement}`);
  }
  return { returned: false };
}

/**
 * Evaluate one WGSL expression in f32 with the given bindings.
 *
 * @param {string} text Expression text.
 * @param {object} env Bindings.
 * @returns {number|object|boolean} The value.
 */
function evalExpression(text, env) {
  return evaluate(parseExpression(tokenize(text), 0).node, env);
}

/**
 * Build the evaluation environment: f32 rounding, and the constructors and
 * helpers the sites call.
 *
 * @param {object} bindings Named values the expression references.
 * @param {object} [functions] Extra callables, by WGSL name.
 * @returns {object} The environment.
 */
function environment(bindings, functions = {}) {
  const env = {
    __round: f32,
    __functions: {
      // A `vec4` at every site here is `(xyz, 1.0)`; the reconstruction under
      // measurement is the xyz part.
      vec4: (...args) =>
        typeof args[0] === "object" ? args[0] : vec(args[0], args[1], args[2]),
      ...functions,
    },
  };
  return Object.assign(env, bindings);
}

// ── The sample set and the ground truth ─────────────────────────────────────

/**
 * Split a position the way the vertex buffer carries it, and record what that
 * split ENCODES — the exact f64 sum of the two f32 lanes.
 *
 * The application's f64 Cartesian is NOT the ground truth: the GPU never sees
 * it, and the split's own representation error is shared by the current frame,
 * so it cancels in the velocity difference. What does not cancel is a
 * reconstruction that disagrees with its own split.
 *
 * @param {Cartesian3} position World position.
 * @returns {{high: object, low: object, exact: object}} The lanes and the sum.
 */
function splitPosition(position) {
  const encoded = EncodedCartesian3.fromCartesian(
    position,
    new EncodedCartesian3(),
  );
  const high = vec(
    f32(encoded.high.x),
    f32(encoded.high.y),
    f32(encoded.high.z),
  );
  const low = vec(f32(encoded.low.x), f32(encoded.low.y), f32(encoded.low.z));
  return {
    high,
    low,
    exact: vec(high.x + low.x, high.y + low.y, high.z + low.z),
  };
}

const SAMPLES = [
  ["equator-prime", new Cartesian3(6378137.0, 0.0, 0.0)],
  ["mid-latitude", new Cartesian3(4517590.879, 2223852.654, 3806111.202)],
  ["north-pole", new Cartesian3(0.0, 0.0, 6356752.314245179)],
  ["antimeridian", new Cartesian3(-6378137.0, 0.0, 0.0)],
  ["south-mid", new Cartesian3(-2223852.654, -4517590.879, -3806111.202)],
];

/** Camera 1 km above the subject along its own radius. */
function cameraFor(position) {
  return Cartesian3.multiplyByScalar(
    Cartesian3.normalize(position, new Cartesian3()),
    Cartesian3.magnitude(position) + 1000.0,
    new Cartesian3(),
  );
}

const componentError = (got, want) =>
  Math.max(
    Math.abs(got.x - want.x),
    Math.abs(got.y - want.y),
    Math.abs(got.z - want.z),
  );

export { bindingExpression, positionOperandOf, runBody, splitPosition };

// ── Projecting a reconstruction, so the error can be read in pixels ─────────
//
// Only the 4x4 multiply below is written here; the POSITION it consumes comes
// out of the shipped shader text. It is modelled the way the device performs
// it — f32 coefficients, f32 operations — and BOTH frames go through it,
// because what the velocity target carries is the difference of two device
// projections and not either one's distance from an exact answer. The second
// error source lives inside this multiply: at planetary magnitude the
// world-space form cancels the view translation against the position where f32
// has no bits left for the difference, and that loss is larger than the
// reconstruction's own.

const VIEWPORT = Object.freeze({ width: 1024, height: 768 });

/** Column-major 4x4 times (v, 1), every operation rounded to an f32. */
function projectF32(matrix, v) {
  const m = Array.from(matrix, f32);
  const c = [f32(v.x), f32(v.y), f32(v.z)];
  const out = [0, 0, 0, 0];
  for (let row = 0; row < 4; row += 1) {
    let acc = f32(m[row] * c[0]);
    acc = f32(acc + f32(m[4 + row] * c[1]));
    acc = f32(acc + f32(m[8 + row] * c[2]));
    out[row] = f32(acc + m[12 + row]);
  }
  return [f32(out[0] / out[3]), f32(out[1] / out[3])];
}

/** Magnitude of the NDC difference the velocity target would carry. */
function ndcMagnitude(got, want) {
  return Math.hypot(got[0] - want[0], got[1] - want[1]);
}

/** Normalised-device error expressed in pixels of the stated viewport. */
function pixelError(got, want) {
  return Math.max(
    Math.abs(got[0] - want[0]) * 0.5 * VIEWPORT.width,
    Math.abs(got[1] - want[1]) * 0.5 * VIEWPORT.height,
  );
}

/**
 * A camera looking straight down at the subject from `distance`, laterally
 * offset by `offsetFactor x distance` so the subject can be placed at the
 * screen centre or away from it.
 *
 * The defect is measurable at BOTH stations — the dominant term is the f32
 * cancellation inside `R_V . worldPos + t` at planetary magnitude, a 3-vector
 * that is generally not parallel to the view axis and so does not vanish on
 * it. The off-axis station reads the SMALLER of the two, which is why the
 * Edge leg uses it: a bar met at the harder station is met at either.
 *
 * @param {Cartesian3} subject The still primitive's position.
 * @param {number} distance Metres from the subject.
 * @param {number} [offsetFactor] Lateral offset as a fraction of distance.
 * @returns {object} The eye and both projection matrices.
 */
function cameraFrameAt(subject, distance, offsetFactor = -0.35) {
  const up = Cartesian3.normalize(subject, new Cartesian3());
  const east = Cartesian3.normalize(
    Cartesian3.cross(new Cartesian3(0, 0, 1), up, new Cartesian3()),
    new Cartesian3(),
  );
  const centre = Cartesian3.add(
    subject,
    Cartesian3.multiplyByScalar(
      east,
      offsetFactor * distance,
      new Cartesian3(),
    ),
    new Cartesian3(),
  );
  const eye = Cartesian3.add(
    centre,
    Cartesian3.multiplyByScalar(up, distance, new Cartesian3()),
    new Cartesian3(),
  );
  const direction = Cartesian3.negate(up, new Cartesian3());
  const view = Matrix4.computeView(
    eye,
    direction,
    Cartesian3.cross(east, direction, new Cartesian3()),
    east,
    new Matrix4(),
  );
  const frustum = new PerspectiveFrustum({
    fov: Math.PI / 3,
    aspectRatio: VIEWPORT.width / VIEWPORT.height,
    near: Math.max(1.0, distance * 0.01),
    far: 5.0e7,
  });
  const projection = frustum.projectionMatrix;
  const viewRelativeToEye = Matrix4.clone(view, new Matrix4());
  viewRelativeToEye[12] = 0.0;
  viewRelativeToEye[13] = 0.0;
  viewRelativeToEye[14] = 0.0;
  return {
    eye,
    viewProjection: Matrix4.multiply(projection, view, new Matrix4()),
    viewProjectionRelativeToEye: Matrix4.multiply(
      projection,
      viewRelativeToEye,
      new Matrix4(),
    ),
  };
}

/**
 * Bind whatever the stage's own statements bind, up to the operand.
 *
 * Two sites difference the split into locals before the multiply instead of
 * inline, so their operand cannot be read without running the statements that
 * produced those locals. Statements this runner cannot read — the quad
 * expansion, the output writes, the early-out on a hidden primitive — are
 * SKIPPED rather than refused, because they cannot contribute to the operand;
 * if one of them did, the operand's identifier would be unbound and the
 * evaluation throws, which is the fail-closed outcome wanted.
 *
 * @param {string} body The stage body.
 * @param {number} end Index of the operand's own statement.
 * @param {object} env Bindings, mutated in place.
 * @returns {void}
 */
function bindPrefix(body, end, env, fixture) {
  for (const statement of splitStatements(body.slice(0, end))) {
    const declared = /^(?:let|var)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(statement);
    if (declared !== null && fixture.has(declared[1])) {
      // The fixture supplies this one. The stage's own initialiser would
      // overwrite it with the placeholder the shipped path later fills from a
      // vertex attribute or a storage buffer this reader cannot provide.
      continue;
    }
    try {
      runStatements(statement, env);
    } catch {
      // Unreadable here means irrelevant here; see above.
    }
  }
}

/**
 * The operand's text together with everything it reaches: the bindings of the
 * identifiers it names, and the bodies of the helpers it calls.
 *
 * An operand may be eye-relative one level down — `prevHighDiff + prevLowDiff`,
 * or a call to a helper that does the differencing — so asserting on the
 * operand's own characters alone would report a correct site as broken.
 *
 * @param {string} source The whole shader text.
 * @param {string} body The stage body.
 * @param {string} text The operand text.
 * @param {string[]} helperNames Helpers the site declares.
 * @returns {string} The operand and its reachable text.
 */
function operandProvenance(source, body, text, helperNames) {
  const parts = [text];
  for (const name of new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])) {
    if (helperNames.includes(name)) {
      parts.push(functionBody(source, name));
      continue;
    }
    try {
      parts.push(bindingExpression(body, name));
    } catch {
      // Not a local binding; nothing to reach.
    }
  }
  return parts.join(String.fromCharCode(10));
}

// ── The seven sites ─────────────────────────────────────────────────────────

// One row per velocity site. `stage` names the function whose body is read, so
// a matrix multiply elsewhere in the file cannot stand in for the velocity
// one. `previous` / `current` are the uniform FIELDS whose multiply identifies
// each operand; the operand itself is whatever the shipped text passes them.
const SITES = [
  {
    id: "billboard",
    file: "packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollection.wgsl",
    stage: "vertexVelocityMain",
    previous: "previousMvpRelativeToEye",
    current: "mvpRelativeToEye",
    helpers: ["translateRelativeToEye"],
    bind: (P, C, prev) =>
      prev
        ? { prevPosHigh: P.high, prevPosLow: P.low }
        : { posHigh: P.high, posLow: P.low },
  },
  {
    id: "billboard-sdf",
    file: "packages/engine/Source/Shaders/WebGPU/Collections/BillboardCollectionSDF.wgsl",
    stage: "vertexVelocityMain",
    previous: "previousMvpRelativeToEye",
    current: "mvpRelativeToEye",
    helpers: ["translateRelativeToEye"],
    bind: (P, C, prev) =>
      prev
        ? { prevPosHigh: P.high, prevPosLow: P.low }
        : { posHigh: P.high, posLow: P.low },
  },
  {
    id: "point",
    file: "packages/engine/Source/Shaders/WebGPU/Collections/PointPrimitiveColor.wgsl",
    stage: "vertexVelocityMain",
    previous: "previousMvpRelativeToEye",
    current: "mvpRelativeToEye",
    // Both helpers read the camera globals and carry the device NaN guard, so
    // they are run through the statement runner rather than compiled.
    guardedHelpers: [
      "translateRelativeToEye",
      "translateRelativeToEyePrevious",
    ],
    bind: (P, C, prev) =>
      prev
        ? { prevPosHigh: P.high, prevPosLow: P.low }
        : { posHigh: P.high, posLow: P.low },
  },
  {
    id: "polyline-start",
    file: "packages/engine/Source/Shaders/WebGPU/Collections/PolylineCollection.wgsl",
    stage: "vertexVelocityMain",
    previous: "previousMvpRelativeToEye",
    current: "mvpRelativeToEye",
    helpers: ["translateRelativeToEye"],
    bind: (P) => ({
      input: {
        prevStartPosHighAndWidth: { xyz: P.high },
        prevStartPosLow: { xyz: P.low },
        startPosHighAndWidth: { xyz: P.high },
        startPosLow: { xyz: P.low },
      },
    }),
  },
  {
    id: "polyline-end",
    file: "packages/engine/Source/Shaders/WebGPU/Collections/PolylineCollection.wgsl",
    stage: "vertexVelocityMain",
    previous: "previousMvpRelativeToEye",
    current: "mvpRelativeToEye",
    helpers: ["translateRelativeToEye"],
    occurrence: 1,
    bind: (P) => ({
      input: {
        prevEndPosHighAndMiter: { xyz: P.high },
        prevEndPosLow: { xyz: P.low },
        endPosHighAndMiter: { xyz: P.high },
        endPosLow: { xyz: P.low },
      },
    }),
  },
  {
    id: "compute-instance",
    file: "packages/engine/Source/Shaders/WebGPU/Compute/ComputeInstanceRender.wgsl",
    stage: "vertexVelocityMain",
    previous: "previousMvpRelativeToEye",
    current: "mvpRelativeToEye",
    bind: (P, C, prev) =>
      prev
        ? { prev: { positionHigh: P.high, positionLow: P.low } }
        : { inst: { positionHigh: P.high, positionLow: P.low } },
  },
  {
    id: "cloud-collection",
    file: "packages/engine/Source/Renderer/WebGPU/WebGPUCloudRenderer.ts",
    stage: "vertexVelocityMain",
    previous: "previousModelViewProjectionRTE",
    current: "modelViewProjectionRTE",
    bind: (P, C, prev) =>
      prev
        ? { input: { prevPositionHigh: P.high, prevPositionLow: P.low } }
        : { input: { positionHigh: P.high, positionLow: P.low } },
  },
  {
    id: "model",
    file: "packages/engine/Source/Shaders/WebGPU/Model/ModelPBRComplete.wgsl",
    // The model's velocity outputs are written by the main vertex stage.
    stage: "vertexMain",
    previous: "previousMvpRelativeToEye",
    current: "mvpRelativeToEye",
    bind: (P, C, prev) =>
      prev
        ? {
            prevInstTransHigh: P.high,
            prevInstTransLow: P.low,
            prevPositionMC: vec(0, 0, 0),
          }
        : {
            instTransHigh: P.high,
            instTransLow: P.low,
            positionMC: vec(0, 0, 0),
          },
  },
];

/** The text of one function body, by brace matching on its declaration. */
function functionBody(source, name) {
  const at = source.search(new RegExp(`\\bfn\\s+${name}\\s*\\(`));
  assert.ok(at >= 0, `no function ${name}`);
  const open = source.indexOf("{", source.indexOf(")", at));
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error(`unterminated body for ${name}`);
}

/**
 * The camera uniform object each site's expressions read, for one frame.
 *
 * Every spelling any of the seven files uses is bound, so a site that renames
 * a lane fails on an unbound identifier rather than silently reading another
 * frame's value.
 *
 * @param {{high: object, low: object}} split The frame's encoded camera.
 * @param {boolean} previous Bind the previous-frame lane names too.
 * @returns {object} The uniform object.
 */
function cameraUniform(split, previous) {
  const lanes = previous
    ? {
        previousEncodedCameraHigh: split.high,
        previousEncodedCameraLow: split.low,
        previousEncodedCameraPositionMCHigh: split.high,
        previousEncodedCameraPositionMCLow: split.low,
      }
    : {
        encodedCameraHigh: split.high,
        encodedCameraLow: split.low,
        encodedCameraPositionMCHigh: split.high,
        encodedCameraPositionMCLow: split.low,
      };
  return lanes;
}

/**
 * Evaluate one site's position operand for one frame, in f32.
 *
 * @param {object} site A row of `SITES`.
 * @param {string} source The comment-stripped shader text.
 * @param {{high: object, low: object}} position The subject's split.
 * @param {{high: object, low: object}} camera The frame's camera split.
 * @param {boolean} previous Previous frame rather than current.
 * @returns {{value: object, text: string}} The value and the text it came from.
 */
function evaluateOperand(site, source, position, camera, previous) {
  const body = functionBody(source, site.stage);
  const field = previous ? site.previous : site.current;
  let found = positionOperandOf(body, field);
  for (let n = 0; n < (site.occurrence ?? 0); n += 1) {
    found = positionOperandOf(body, field, found.end);
  }
  const bindings = site.bind(position, camera, previous);
  const functions = {};
  for (const name of site.helpers ?? []) {
    functions[name] = compileFunction(source, name, {
      __round: f32,
      __functions: {
        vec4: (...args) =>
          typeof args[0] === "object"
            ? args[0]
            : vec(args[0], args[1], args[2]),
      },
    });
  }
  for (const name of site.guardedHelpers ?? []) {
    const helperBody = functionBody(source, name);
    const params = /\(([\s\S]*?)\)\s*->/
      .exec(
        source.slice(source.search(new RegExp(`\\bfn\\s+${name}\\s*\\(`))),
      )[1]
      .split(",")
      .map((p) => p.split(":")[0].trim())
      .filter((p) => p.length > 0);
    functions[name] = (...args) => {
      const inner = environment(
        { camera: cameraUniform(camera, previous) },
        functions,
      );
      params.forEach((p, index) => {
        inner[p] = args[index];
      });
      return runBody(helperBody, inner);
    };
  }
  const env = environment(
    { ...bindings, camera: cameraUniform(camera, previous) },
    functions,
  );
  bindPrefix(body, found.end, env, new Set(Object.keys(bindings)));
  return { value: evalExpression(found.text, env), text: found.text };
}

/** The shipped text of a site's file, comment-stripped. */
const sourceOf = (site) => stripComments(readSource(site.file));

/**
 * The same text with the previous encoded-camera lanes replaced by zero, which
 * is the arithmetic the pre-fix sites performed, in a shape this reader can
 * still parse. A mutant that deletes the line makes the reader THROW, and a
 * throw cannot distinguish a load-bearing fix from an unreadable mutant.
 *
 * @param {string} source The shipped text.
 * @returns {string} The mutated text.
 */
function summedWorldMutant(source) {
  return source.replace(
    /camera\.previousEncodedCamera(?:PositionMC)?(?:High|Low)/g,
    "vec3<f32>(0.0, 0.0, 0.0)",
  );
}

test("every velocity stage multiplies a previous relative-to-eye matrix, and its operand names the previous eye", () => {
  for (const site of SITES) {
    const source = sourceOf(site);
    const body = functionBody(source, site.stage);
    let found = positionOperandOf(body, site.previous);
    for (let n = 0; n < (site.occurrence ?? 0); n += 1) {
      found = positionOperandOf(body, site.previous, found.end);
    }
    // The reference is often one level down: some sites difference the split
    // into locals before the multiply, others pass it to a helper, so the
    // bindings and helper bodies the operand reaches count as its text.
    const reachable = operandProvenance(source, body, found.text, [
      ...(site.helpers ?? []),
      ...(site.guardedHelpers ?? []),
    ]);
    assert.match(
      reachable,
      /previousEncodedCamera/,
      `${site.id}: the previous-frame operand does not reference the previous encoded camera, so it cannot be relative to the previous eye`,
    );
  }
});

test("on a history-reset frame every site reconstructs the previous position bit-identically to the current one", () => {
  for (const site of SITES) {
    const source = sourceOf(site);
    for (const [label, position] of SAMPLES) {
      const P = splitPosition(position);
      const C = splitPosition(cameraFor(position));
      const previous = evaluateOperand(site, source, P, C, true);
      const current = evaluateOperand(site, source, P, C, false);
      for (const axis of ["x", "y", "z"]) {
        assert.ok(
          Object.is(previous.value[axis], current.value[axis]),
          `${site.id} at ${label}: previous ${axis}=${previous.value[axis]} is not bitwise the current ${current.value[axis]}, so a still primitive emits velocity on a reset frame`,
        );
      }
    }
  }
});

test("the previous reconstruction is eye-relative, and the pre-fix arithmetic is what makes it planetary", () => {
  const shipped = [];
  const mutated = [];
  for (const site of SITES) {
    const source = sourceOf(site);
    const mutantSource = summedWorldMutant(source);
    assert.notEqual(
      mutantSource,
      source,
      `${site.id}: the mutant changed nothing, so it proves nothing`,
    );
    for (const [label, position] of SAMPLES) {
      const P = splitPosition(position);
      const C = splitPosition(cameraFor(position));
      const exact = vec(
        P.exact.x - C.exact.x,
        P.exact.y - C.exact.y,
        P.exact.z - C.exact.z,
      );
      const value = evaluateOperand(site, source, P, C, true).value;
      shipped.push([`${site.id}/${label}`, componentError(value, exact)]);
      const mutantValue = evaluateOperand(site, mutantSource, P, C, true).value;
      mutated.push([
        `${site.id}/${label}`,
        componentError(mutantValue, P.exact),
      ]);
    }
  }
  const worstShipped = Math.max(...shipped.map(([, e]) => e));
  const worstMutant = Math.max(...mutated.map(([, e]) => e));
  console.log(
    `previous-frame reconstruction, f32, ${SITES.length} sites x ${SAMPLES.length} positions:\n` +
      `  shipped: worst ${worstShipped.toExponential(3)} m against the eye-relative position the split encodes\n` +
      `  camera lanes zeroed: worst ${worstMutant.toFixed(4)} m against the absolute position the split encodes`,
  );
  assert.ok(
    worstShipped <= 1.0e-2,
    `the shipped reconstruction is off by ${worstShipped} m, which is not eye-relative`,
  );
  assert.ok(
    worstMutant >= 0.1,
    `the mutant's worst error is only ${worstMutant} m, so this measurement cannot tell the two forms apart`,
  );
});

test("through the real matrices, the pre-fix form puts velocity on a still primitive and the shipped form puts none", () => {
  const site = SITES[0];
  const source = sourceOf(site);
  const mutantSource = summedWorldMutant(source);
  const rows = [];
  for (const offsetFactor of [0, -0.35]) {
    for (const distance of [100, 150, 300, 1000, 10000]) {
      const subject = SAMPLES[1][1];
      const frame = cameraFrameAt(subject, distance, offsetFactor);
      const P = splitPosition(subject);
      const C = splitPosition(frame.eye);
      // What the velocity stage writes is `curNdc - prevNdc`, with BOTH clip
      // positions produced by the device in f32 from f32 matrix coefficients.
      // Differencing each arm against an f64 reference instead measures each
      // arm's absolute error, which is a different and much smaller quantity:
      // it drops the current frame's own rounding, which the subtraction does
      // NOT cancel when the two arms run different matrices, and it understates
      // the defect, by two orders of magnitude on a centred fixture.
      const current = projectF32(
        frame.viewProjectionRelativeToEye,
        evaluateOperand(site, source, P, C, false).value,
      );
      const shipped = projectF32(
        frame.viewProjectionRelativeToEye,
        evaluateOperand(site, source, P, C, true).value,
      );
      const prefix = projectF32(
        frame.viewProjection,
        evaluateOperand(site, mutantSource, P, C, true).value,
      );
      rows.push([
        offsetFactor,
        distance,
        ndcMagnitude(shipped, current),
        ndcMagnitude(prefix, current),
        pixelError(prefix, current),
      ]);
    }
  }
  console.log(
    `a still primitive's velocity on a history-reset frame, 1024x768, 60 degree field of view:\n` +
      rows
        .map(
          ([o, d, s, m, px]) =>
            `  ${o === 0 ? "centred " : "off-axis"} ${String(d).padStart(6)} m   shipped ${s.toExponential(2)} NDC   pre-fix ${m.toExponential(3)} NDC (${px.toFixed(3)} px)`,
        )
        .join("\n"),
  );
  for (const [offsetFactor, distance, shipped, prefix] of rows) {
    assert.equal(
      shipped,
      0,
      `at ${distance} m the shipped form moves a still primitive by ${shipped} NDC on a reset frame`,
    );
    if (distance <= 300 && offsetFactor !== 0) {
      // 5.0e-4 is the Edge leg's BEFORE bar, and it is asserted at the
      // OFF-AXIS station only. How much of the pre-fix error reaches the
      // screen depends on where the camera's world translation lands in the
      // view basis and on the subject's own NDC position, so the centred
      // figure is fixture-dependent — it is reported above, and on this
      // fixture it falls below the bar. Off-axis is reliably above it.
      assert.ok(
        prefix > 5.0e-4,
        `at ${distance} m off-axis the pre-fix form moves a still primitive by only ${prefix} NDC, below the Edge leg's BEFORE bar`,
      );
    }
  }
});
