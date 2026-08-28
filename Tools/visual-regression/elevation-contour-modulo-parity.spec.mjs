// elevation-contour-modulo-parity.spec.mjs — the contour distance the static
// primitive shaders compute must be the same number the fabric's own WGSL port
// computes, on both sides of the datum.
// @purpose Evaluates the contour-distance expression parsed out of the two PrimitiveMatElevContour shaders against the expression parsed out of the ElevationContour fabric's WGSL source, in f32 over an envelope that spans negative heights, and proves the instrument red under four mutations.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no device.
//
// WHY THIS EXISTS
// ---------------
// `Material.ElevationContourType` exists twice in this fork. The fabric carries
// a WGSL port of the GLSL reference, used when a material is translated at
// runtime; the primitive path instead selects one of two hand-written static
// shaders. Both are supposed to compute the same contour distance.
//
// They did not. The GLSL reference uses `mod(height, spacing)`, which is the
// floored modulus and is non-negative for a positive spacing, and the fabric's
// WGSL port spells that out as `height - spacing * floor(height / spacing)`.
// The static shaders used `height % spacing`. In WGSL `%` on floats is the
// truncated remainder — it carries the sign of the dividend — so for any height
// below the ellipsoid it returns a negative distance, and the line test
// `distToContour < dF` is then satisfied by every fragment with a non-zero
// height gradient. The material fills solid instead of drawing lines, and the
// error is invisible above the datum, which is where contour materials are
// usually demonstrated.
//
// WHAT IS ACTUALLY CHECKED
// ------------------------
// No source text is pinned and no expression is transcribed into JavaScript by
// hand. Three expressions are PARSED — one from each static shader and one from
// the fabric string in `Material.js` — and evaluated node by node in f32 over a
// shared envelope. The fabric is the reference because it is a live artifact
// that ships in the same repository; a divergence is scored as a number, not as
// a difference in spelling. The alpha decision the line test makes is then
// evaluated from those numbers, so a regression is reported as "the surface
// fills solid below the datum" rather than as a failed string match.
//
// WHAT IS NOT CHECKED HERE
// ------------------------
// This says nothing about the derived height that feeds the expression (that is
// the elevation-material height-derivation gate), nothing about the screen-space
// derivative `dF`, and nothing about pixels. It also does not claim to explain
// the separately-recorded WebGPU solid-fill observation on an above-datum wall:
// that symptom is above the datum, where the two forms agree.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SHADER_FILES = [
  "packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevContourFlat.wgsl",
  "packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevContourLit.wgsl",
];
const FABRIC_FILE = "packages/engine/Source/Scene/Material.js";

// Heights straddle the datum deliberately: a trench floor, a shoreline, the
// f32 quantum of the derived height itself, and orbital altitude. The spacings
// are the ones a contour demo actually uses.
const ENVELOPE_HEIGHTS = [
  -14248, -11034, -2000.5, -1000, -400, -25, -1, -0.75, -1e-3, 0, 1e-3, 0.75, 1,
  25, 400, 999.5, 1000, 2000, 7137, 20000, 100000,
];
const ENVELOPE_SPACINGS = [1, 50, 100, 500, 2000, 5000];
// A per-pixel height gradient in the range a 20 km wall on a 400 px viewport
// produces, times the default line width.
const ENVELOPE_GRADIENTS = [0.5, 8, 53, 90];

// =============================================================================
// Expression extraction
// =============================================================================

function read(root, relative) {
  return fs
    .readFileSync(path.join(root, relative), "utf8")
    .replace(/\r\n/g, "\n");
}

function stripComments(text) {
  return text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

/**
 * Pulls the right-hand side of the contour-distance assignment out of a static
 * shader. Comments are removed first so a commented-out decoy cannot be the
 * expression that gets scored.
 */
function extractShaderExpression(root, relative) {
  const source = stripComments(read(root, relative));
  const match = source.match(/let\s+distToContour\s*=([\s\S]*?);/);
  assert.ok(match, `no distToContour assignment found in ${relative}`);
  return {
    label: relative,
    text: match[1].trim(),
    heightToken: "input.height",
    spacingToken: "material.spacing",
  };
}

/**
 * Pulls the same expression out of the ElevationContour fabric's WGSL source.
 * The fabric stores WGSL as a concatenated JavaScript string, so the string
 * literal is reassembled before the expression is read out of it.
 */
function extractFabricExpression(root) {
  const source = read(root, FABRIC_FILE);
  const start = source.indexOf("Material.ElevationContourType = ");
  assert.ok(start >= 0, "ElevationContourType was not found in Material.js");
  const end = source.indexOf("Material.ElevationRampType = ", start);
  assert.ok(end > start, "the ElevationContour fabric block has no terminator");
  const block = source.slice(start, end);

  const literals = block.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  const wgsl = literals
    .map((literal) => JSON.parse(literal))
    .join("")
    .replace(/\\n/g, "\n");
  const match = stripComments(wgsl).match(
    /let\s+distanceToContour\s*=([\s\S]*?);/,
  );
  assert.ok(match, "no distanceToContour assignment found in the fabric WGSL");
  return {
    label: `${FABRIC_FILE} (ElevationContour fabric WGSL)`,
    text: match[1].trim(),
    heightToken: "materialInput.height",
    spacingToken: "spacing",
  };
}

// =============================================================================
// A small f32 expression evaluator
// =============================================================================

const f32 = Math.fround;

/**
 * Recursive-descent parser for the subset of WGSL these expressions use:
 * `+ - * / %`, unary minus, parentheses, `floor(...)`, numeric literals, and
 * the two named operands. Anything else throws, so an expression that grows a
 * construct this evaluator cannot score fails loudly instead of being skipped.
 */
function parseExpression(expression) {
  const tokens = expression
    .replace(/([+\-*/%(),])/g, " $1 ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
  let index = 0;

  const peek = () => tokens[index];
  const take = (expected) => {
    const token = tokens[index++];
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected ${expected} but found ${String(token)}`);
    }
    return token;
  };

  function parsePrimary() {
    const token = peek();
    if (token === "(") {
      take("(");
      const inner = parseAdditive();
      take(")");
      return inner;
    }
    if (token === "-") {
      take("-");
      return { kind: "negate", operand: parsePrimary() };
    }
    if (token === "floor") {
      take("floor");
      take("(");
      const argument = parseAdditive();
      take(")");
      return { kind: "floor", operand: argument };
    }
    take();
    if (/^[0-9]/.test(token)) {
      return { kind: "literal", value: Number.parseFloat(token) };
    }
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(token)) {
      return { kind: "name", name: token };
    }
    throw new Error(`unparsable token ${String(token)}`);
  }

  function parseMultiplicative() {
    let left = parsePrimary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const operator = take();
      left = { kind: "binary", operator, left, right: parsePrimary() };
    }
    return left;
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      left = { kind: "binary", operator, left, right: parseMultiplicative() };
    }
    return left;
  }

  const tree = parseAdditive();
  if (index !== tokens.length) {
    throw new Error(
      `trailing tokens after the expression: ${tokens.slice(index).join(" ")}`,
    );
  }
  return tree;
}

function evaluate(node, environment) {
  switch (node.kind) {
    case "literal":
      return f32(node.value);
    case "name": {
      if (!Object.prototype.hasOwnProperty.call(environment, node.name)) {
        throw new Error(`unbound operand ${node.name}`);
      }
      return f32(environment[node.name]);
    }
    case "negate":
      return f32(-evaluate(node.operand, environment));
    case "floor":
      return f32(Math.floor(evaluate(node.operand, environment)));
    case "binary": {
      const left = evaluate(node.left, environment);
      const right = evaluate(node.right, environment);
      switch (node.operator) {
        case "+":
          return f32(left + right);
        case "-":
          return f32(left - right);
        case "*":
          return f32(left * right);
        case "/":
          return f32(left / right);
        // WGSL's float `%` is the truncated remainder, which is what
        // JavaScript's `%` also computes.
        case "%":
          return f32(left % right);
        default:
          throw new Error(`unsupported operator ${node.operator}`);
      }
    }
    default:
      throw new Error(`unsupported node ${node.kind}`);
  }
}

function compile(extracted) {
  const tree = parseExpression(extracted.text);
  return (height, spacing) =>
    evaluate(tree, {
      [extracted.heightToken]: height,
      [extracted.spacingToken]: spacing,
    });
}

// =============================================================================
// Scoring
// =============================================================================

/**
 * Compares one shader expression against the fabric reference across the whole
 * envelope. Returns `null` when they agree bit for bit and the first
 * disagreement otherwise, including the alpha the line test would produce, so
 * the report says what a viewer would have seen.
 */
function show(value) {
  return Object.is(value, -0) ? "-0" : String(value);
}

function compare(shader, reference) {
  let firstNumeric = null;
  for (const spacing of ENVELOPE_SPACINGS) {
    for (const height of ENVELOPE_HEIGHTS) {
      const observed = shader(height, spacing);
      const expected = reference(height, spacing);
      if (Object.is(observed, expected)) {
        continue;
      }
      for (const gradient of ENVELOPE_GRADIENTS) {
        const observedAlpha = observed < gradient ? 1 : 0;
        const expectedAlpha = expected < gradient ? 1 : 0;
        if (observedAlpha !== expectedAlpha) {
          // A visible divergence outranks a numeric one in the report, because
          // it says what a viewer would have seen.
          return (
            `height ${height} m at spacing ${spacing} m: distance ${show(observed)} ` +
            `rather than ${show(expected)}, so with dF ${gradient} the fragment is ` +
            `${observedAlpha === 1 ? "filled" : "cut out"} where the reference ` +
            `${expectedAlpha === 1 ? "fills" : "cuts out"}`
          );
        }
      }
      firstNumeric ??= `height ${height} m at spacing ${spacing} m: distance ${show(observed)} rather than ${show(expected)}`;
    }
  }
  return firstNumeric;
}

/**
 * The share of a height set on which the line test fires. A form that carries
 * the dividend's sign returns a non-positive distance for every negative
 * height, so its below-datum share is exactly 1: the surface fills solid rather
 * than drawing lines. No bar is invented here — the reference's own share is
 * the bar, and the interesting reading is that the below-datum share is not 1.
 */
function fillFraction(shader, heights) {
  let filled = 0;
  let total = 0;
  for (const spacing of ENVELOPE_SPACINGS) {
    for (const height of heights) {
      for (const gradient of ENVELOPE_GRADIENTS) {
        total += 1;
        if (shader(height, spacing) < gradient) {
          filled += 1;
        }
      }
    }
  }
  return filled / total;
}

const BELOW_DATUM = ENVELOPE_HEIGHTS.filter((height) => height < 0);
const ABOVE_DATUM = ENVELOPE_HEIGHTS.filter((height) => height >= 0);

// =============================================================================
// Legs
// =============================================================================

test("the contour distance is non-negative on both sides of the datum", () => {
  const reference = compile(extractFabricExpression(REPO_ROOT));
  for (const relative of SHADER_FILES) {
    const shader = compile(extractShaderExpression(REPO_ROOT, relative));
    for (const spacing of ENVELOPE_SPACINGS) {
      for (const height of ENVELOPE_HEIGHTS) {
        const distance = shader(height, spacing);
        assert.ok(
          distance >= 0 && distance < spacing,
          `${relative}: height ${height} m at spacing ${spacing} m produced ${distance}, outside [0, ${spacing})`,
        );
      }
    }
  }
  for (const spacing of ENVELOPE_SPACINGS) {
    for (const height of ENVELOPE_HEIGHTS) {
      const distance = reference(height, spacing);
      assert.ok(
        distance >= 0 && distance < spacing,
        `the fabric reference itself left [0, ${spacing}) at height ${height} m`,
      );
    }
  }
});

test("both static contour shaders agree with the fabric's own WGSL port", () => {
  const reference = compile(extractFabricExpression(REPO_ROOT));
  for (const relative of SHADER_FILES) {
    const shader = compile(extractShaderExpression(REPO_ROOT, relative));
    assert.equal(
      compare(shader, reference),
      null,
      `${relative} disagrees with the fabric reference`,
    );
  }
});

test("the line test cuts out rather than filling below the datum", () => {
  const reference = compile(extractFabricExpression(REPO_ROOT));
  const referenceBelow = fillFraction(reference, BELOW_DATUM);
  const referenceAbove = fillFraction(reference, ABOVE_DATUM);
  assert.ok(
    referenceBelow < 1,
    `the fabric reference itself fills every below-datum sample (${referenceBelow})`,
  );
  for (const relative of SHADER_FILES) {
    const shader = compile(extractShaderExpression(REPO_ROOT, relative));
    assert.equal(
      fillFraction(shader, BELOW_DATUM),
      referenceBelow,
      `${relative} fills a different below-datum share than the reference`,
    );
    assert.equal(
      fillFraction(shader, ABOVE_DATUM),
      referenceAbove,
      `${relative} fills a different above-datum share than the reference`,
    );
  }
});

// =============================================================================
// Mutation staging
// =============================================================================

function stageSources() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "contour-mod-mutation-"));
  for (const relative of [...SHADER_FILES, FABRIC_FILE]) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(REPO_ROOT, relative), destination);
  }
  return root;
}

function rewriteEveryShader(root, pattern, replacement) {
  for (const relative of SHADER_FILES) {
    const file = path.join(root, relative);
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(pattern, replacement);
    if (after === before) {
      throw new Error(`mutation anchor not found in ${relative}`);
    }
    fs.writeFileSync(file, after);
  }
}

const MUTATIONS = [
  {
    name: "ABSENCE — the shaders go back to the truncated remainder",
    apply: (root) =>
      rewriteEveryShader(
        root,
        /let distToContour =[\s\S]*?;/,
        "let distToContour = input.height % material.spacing;",
      ),
  },
  {
    name: "INERTNESS — the floored form is computed and then discarded",
    apply: (root) =>
      rewriteEveryShader(
        root,
        /let distToContour =[\s\S]*?;/,
        "let distToContour = input.height - 0.0 * material.spacing * " +
          "floor(input.height / material.spacing);",
      ),
  },
  {
    name: "the floor rounds to nearest instead of down",
    apply: (root) =>
      rewriteEveryShader(
        root,
        /floor\(input\.height \/ material\.spacing\)/,
        "floor(input.height / material.spacing + 0.5)",
      ),
  },
  {
    name: "the subtraction is reversed",
    apply: (root) =>
      rewriteEveryShader(
        root,
        /input\.height - material\.spacing \* floor/,
        "material.spacing * floor(input.height / material.spacing) - input.height + 0.0 * floor",
      ),
  },
];

test("every mutation of the contour distance is caught", () => {
  const reference = compile(extractFabricExpression(REPO_ROOT));
  const survivors = [];

  for (const mutation of MUTATIONS) {
    const root = stageSources();
    let killed = false;
    let detail;
    try {
      mutation.apply(root);
      const failures = [];
      for (const relative of SHADER_FILES) {
        try {
          const shader = compile(extractShaderExpression(root, relative));
          const violation = compare(shader, reference);
          if (violation !== null) {
            failures.push(`${path.basename(relative)}: ${violation}`);
          }
        } catch (error) {
          failures.push(`${path.basename(relative)}: ${error.message}`);
        }
      }
      if (failures.length > 0) {
        killed = true;
        detail = failures[0];
      } else {
        detail = "the mutant still matched the reference";
      }
    } catch (error) {
      killed = true;
      detail = `staging failed: ${error.message}`;
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
