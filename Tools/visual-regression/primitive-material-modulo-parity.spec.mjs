// primitive-material-modulo-parity.spec.mjs — the static checker and dash
// shaders must make the same numeric and color decisions as their GLSL forms
// when the modulo dividend crosses zero.
// @purpose Evaluates the modulo expressions parsed out of the three static checker and dash WGSL shaders in f32 against a floored reference that is itself cross-checked against a shipped WGSL artifact, scores the colour decision each one drives, anchors the GLSL side to the real material sources, and proves the instrument red under an absence and an inertness mutant at every site.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, build, device, or mutant file writes.
//
// WHY THIS EXISTS
// ---------------
// GLSL `mod` is the floored modulus. WGSL `%` on floats is the truncated
// remainder — it carries the sign of the dividend. Wherever a fork-written
// WGSL material spells a GLSL `mod` as `%`, the two agree for a non-negative
// dividend and disagree for a negative one, and the disagreement is not a
// small numeric drift: it inverts the colour the material selects.
//
// WHAT IS ACTUALLY CHECKED
// ------------------------
// Nothing is pinned as text. Three expressions are PARSED out of the three
// shaders and evaluated node by node in f32. The floored reference they are
// scored against is not merely asserted: it is cross-checked against the
// floored form the fork already ships in `PrimitiveMatElevContourFlat.wgsl`,
// so a wrong reference here disagrees with a live artifact rather than
// quietly certifying itself. The GLSL side is anchored too — each site names
// the material source it is supposed to match, and the spec confirms that
// source really calls `mod` with the same divisor.
//
// WHAT IS NOT CLAIMED
// -------------------
// That any of the three sites misbehaves at default settings. It does not.
// The checker dividend goes negative only for a negative `repeat` component
// or a negative texture coordinate, and `maskTest` is non-negative for every
// non-negative dash pattern. These are latent divergences in the same class
// as the elevation-contour one, which WAS live because terrain height goes
// below the datum. This says nothing about pixels.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const CHECKER_OPERANDS = [
  -9.75, -8, -7, -3.5, -2, -1.25, -1, 0, 0.25, 1, 2, 3.5, 7, 8, 9.75,
];
const DASH_OPERANDS = [
  -65535, -255.5, -255, -17, -16, -3.5, -2, -1, 0, 0.5, 1, 2, 3, 15, 16, 255,
  65535,
];

// The floored form the fork already ships, used to cross-check the reference
// this spec scores against instead of trusting a transcription of it.
const SHIPPED_FLOORED_FORM = {
  file: "packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatElevContourFlat.wgsl",
  pattern: /let\s+distToContour\s*=([\s\S]*?);/,
  dividend: "input.height",
  divisor: "material.spacing",
};

const SITES = [
  {
    file: "packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatCheckerFlat.wgsl",
    glsl: "packages/engine/Source/Shaders/Materials/CheckerboardMaterial.glsl",
    kind: "checker",
    operands: CHECKER_OPERANDS,
    decision: (value) => value > Math.fround(0.5),
    selected: (decision) => (decision ? "dark" : "light"),
  },
  {
    file: "packages/engine/Source/Shaders/WebGPU/Primitive/PrimitiveMatCheckerLit.wgsl",
    glsl: "packages/engine/Source/Shaders/Materials/CheckerboardMaterial.glsl",
    kind: "checker",
    operands: CHECKER_OPERANDS,
    decision: (value) => value > Math.fround(0.5),
    selected: (decision) => (decision ? "dark" : "light"),
  },
  {
    file: "packages/engine/Source/Shaders/WebGPU/Primitive/PolylineMatDash.wgsl",
    glsl: "packages/engine/Source/Shaders/Materials/PolylineDashMaterial.glsl",
    kind: "dash",
    operands: DASH_OPERANDS,
    decision: (value) => value < Math.fround(1.0),
    selected: (decision) => (decision ? "gap" : "color"),
  },
];

function readSources() {
  return new Map(
    SITES.map((site) => [
      site.file,
      fs.readFileSync(path.join(REPO_ROOT, site.file), "utf8"),
    ]),
  );
}

function stripComments(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function expressionPattern(site) {
  if (site.kind === "checker") {
    return /let\s+checker\s*=([\s\S]*?);/;
  }
  return /let\s+maskTest\s*:[^;]+;[\s\S]*?if\s*\(\s*\(([\s\S]+?)\)\s*<\s*1\.0\s*\)\s*\{/;
}

function extractExpression(site, source) {
  const match = stripComments(source).match(expressionPattern(site));
  assert.ok(match, `no modulo expression found in ${site.file}`);
  return match[1].trim();
}

function replaceExpression(site, source, replacement) {
  let replacements = 0;
  let result;
  if (site.kind === "checker") {
    result = source.replace(
      /(let\s+checker\s*=)[\s\S]*?(;)/,
      (_match, prefix, suffix) => {
        replacements += 1;
        return `${prefix} ${replacement}${suffix}`;
      },
    );
  } else {
    result = source.replace(
      /(let\s+maskTest\s*:[^;]+;[\s\S]*?if\s*\(\s*\()([\s\S]+?)(\)\s*<\s*1\.0\s*\)\s*\{)/,
      (_match, prefix, _expression, suffix) => {
        replacements += 1;
        return `${prefix}${replacement}${suffix}`;
      },
    );
  }
  assert.equal(replacements, 1, `mutation anchor count in ${site.file}`);
  return result;
}

const f32 = Math.fround;

function parseExpression(expression) {
  const tokens = expression
    .replace(/([+\-*/%(),])/g, " $1 ")
    .split(/\s+/)
    .filter(Boolean);
  let index = 0;

  const peek = () => tokens[index];
  const take = (expected) => {
    const token = tokens[index++];
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected ${expected} but found ${String(token)}`);
    }
    return token;
  };

  function primary() {
    const token = peek();
    if (token === "(") {
      take("(");
      const inner = additive();
      take(")");
      return inner;
    }
    if (token === "-") {
      take("-");
      return { kind: "negate", operand: primary() };
    }
    if (token === "floor") {
      take("floor");
      take("(");
      const argument = additive();
      take(")");
      return { kind: "floor", operand: argument };
    }
    take();
    if (/^(?:\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?$/i.test(token)) {
      return { kind: "literal", value: Number.parseFloat(token) };
    }
    if (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(token)) {
      return { kind: "name", name: token };
    }
    throw new Error(`unparsable token ${String(token)}`);
  }

  function multiplicative() {
    let left = primary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const operator = take();
      left = { kind: "binary", operator, left, right: primary() };
    }
    return left;
  }

  function additive() {
    let left = multiplicative();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      left = { kind: "binary", operator, left, right: multiplicative() };
    }
    return left;
  }

  const tree = additive();
  if (index !== tokens.length) {
    throw new Error(`trailing tokens: ${tokens.slice(index).join(" ")}`);
  }
  return tree;
}

function sameTree(left, right) {
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "literal":
      return Object.is(left.value, right.value);
    case "name":
      return left.name === right.name;
    case "negate":
    case "floor":
      return sameTree(left.operand, right.operand);
    case "binary":
      return (
        left.operator === right.operator &&
        sameTree(left.left, right.left) &&
        sameTree(left.right, right.right)
      );
    default:
      throw new Error(`unsupported node ${left.kind}`);
  }
}

function collectModuloForms(node, forms = []) {
  if (node.kind === "binary" && node.operator === "%") {
    forms.push({ dividend: node.left, divisor: node.right });
  }
  if (
    node.kind === "binary" &&
    node.operator === "-" &&
    node.right.kind === "binary" &&
    node.right.operator === "*" &&
    node.right.right.kind === "floor" &&
    node.right.right.operand.kind === "binary" &&
    node.right.right.operand.operator === "/" &&
    sameTree(node.left, node.right.right.operand.left) &&
    sameTree(node.right.left, node.right.right.operand.right)
  ) {
    forms.push({ dividend: node.left, divisor: node.right.left });
  }
  if (node.kind === "binary") {
    collectModuloForms(node.left, forms);
    collectModuloForms(node.right, forms);
  } else if (node.kind === "negate" || node.kind === "floor") {
    collectModuloForms(node.operand, forms);
  }
  return forms;
}

function parsedOperands(tree) {
  const forms = collectModuloForms(tree);
  assert.ok(forms.length > 0, "the parsed expression contains no modulo form");
  const first = forms[0];
  for (const form of forms.slice(1)) {
    assert.ok(
      sameTree(form.dividend, first.dividend) &&
        sameTree(form.divisor, first.divisor),
      "the parsed expression mixes different modulo operands",
    );
  }
  return first;
}

function evaluate(node, dividendNode, dividendValue, bindings = {}) {
  if (dividendNode !== null && sameTree(node, dividendNode)) {
    return f32(dividendValue);
  }
  switch (node.kind) {
    case "literal":
      return f32(node.value);
    case "name":
      if (Object.hasOwn(bindings, node.name)) {
        return f32(bindings[node.name]);
      }
      throw new Error(`unbound operand ${node.name}`);
    case "negate":
      return f32(
        -evaluate(node.operand, dividendNode, dividendValue, bindings),
      );
    case "floor":
      return f32(
        Math.floor(
          evaluate(node.operand, dividendNode, dividendValue, bindings),
        ),
      );
    case "binary": {
      const left = evaluate(node.left, dividendNode, dividendValue, bindings);
      const right = evaluate(node.right, dividendNode, dividendValue, bindings);
      switch (node.operator) {
        case "+":
          return f32(left + right);
        case "-":
          return f32(left - right);
        case "*":
          return f32(left * right);
        case "/":
          return f32(left / right);
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

function flooredModulo(dividend, divisor) {
  const a = f32(dividend);
  const b = f32(divisor);
  const quotient = f32(a / b);
  const floored = f32(Math.floor(quotient));
  const product = f32(b * floored);
  return f32(a - product);
}

function render(node) {
  switch (node.kind) {
    case "literal":
      return Number.isInteger(node.value)
        ? `${node.value.toFixed(1)}`
        : `${node.value}`;
    case "name":
      return node.name;
    case "negate":
      return `(-${render(node.operand)})`;
    case "floor":
      return `floor(${render(node.operand)})`;
    case "binary":
      return `(${render(node.left)} ${node.operator} ${render(node.right)})`;
    default:
      throw new Error(`unsupported node ${node.kind}`);
  }
}

function evaluateSite(site, source) {
  const tree = parseExpression(extractExpression(site, source));
  const { dividend, divisor } = parsedOperands(tree);
  const divisorValue = evaluate(divisor, dividend, Number.NaN);
  assert.ok(
    Number.isFinite(divisorValue) && divisorValue > 0,
    `${site.file} has a non-positive divisor`,
  );
  return site.operands.map((operand) => {
    const observed = evaluate(tree, dividend, operand);
    const expected = flooredModulo(operand, divisorValue);
    return {
      operand,
      observed,
      expected,
      divergence: f32(observed - expected),
      observedDecision: site.decision(observed),
      expectedDecision: site.decision(expected),
    };
  });
}

// Balanced-paren scan for `name(...)`, so a nested call in the arguments
// does not truncate the match the way a regex would.
function callArguments(source, name) {
  const open = source.indexOf(`${name}(`);
  if (open < 0) {
    return null;
  }
  let depth = 0;
  for (let index = open + name.length; index < source.length; index++) {
    const character = source[index];
    if (character === "(") {
      depth++;
    } else if (character === ")") {
      depth--;
      if (depth === 0) {
        const inner = source.slice(open + name.length + 1, index);
        const parts = [];
        let level = 0;
        let start = 0;
        for (let scan = 0; scan < inner.length; scan++) {
          if (inner[scan] === "(") level++;
          else if (inner[scan] === ")") level--;
          else if (inner[scan] === "," && level === 0) {
            parts.push(inner.slice(start, scan));
            start = scan + 1;
          }
        }
        parts.push(inner.slice(start));
        return parts.map((part) => part.trim());
      }
    }
  }
  return null;
}

test("the floored reference agrees with the floored form the fork ships", () => {
  const source = stripComments(
    fs.readFileSync(path.join(REPO_ROOT, SHIPPED_FLOORED_FORM.file), "utf8"),
  );
  const match = source.match(SHIPPED_FLOORED_FORM.pattern);
  assert.ok(match, `no floored form found in ${SHIPPED_FLOORED_FORM.file}`);
  const tree = parseExpression(match[1].trim());
  const { dividend, divisor } = parsedOperands(tree);
  assert.equal(render(dividend), SHIPPED_FLOORED_FORM.dividend);
  assert.equal(render(divisor), SHIPPED_FLOORED_FORM.divisor);
  for (const divisorValue of [2, 3.5, 100]) {
    for (const operand of [...CHECKER_OPERANDS, ...DASH_OPERANDS]) {
      const bindings = { [SHIPPED_FLOORED_FORM.divisor]: divisorValue };
      const shipped = evaluate(tree, dividend, operand, bindings);
      assert.equal(
        shipped,
        flooredModulo(operand, divisorValue),
        `the reference disagrees with ${SHIPPED_FLOORED_FORM.file} at ` +
          `${operand} mod ${divisorValue}`,
      );
    }
  }
});

test("each site's GLSL reference calls mod with the same divisor", () => {
  for (const site of SITES) {
    const glsl = stripComments(
      fs.readFileSync(path.join(REPO_ROOT, site.glsl), "utf8"),
    );
    const args = callArguments(glsl, "mod");
    assert.ok(args, `${site.glsl} contains no mod() call to match`);
    assert.equal(
      args.length,
      2,
      `${site.glsl}: mod() takes two arguments, found ${args.length}`,
    );
    const wgslSource = readSources().get(site.file);
    const { divisor } = parsedOperands(
      parseExpression(extractExpression(site, wgslSource)),
    );
    assert.equal(
      f32(Number.parseFloat(args[1])),
      evaluate(divisor, null, Number.NaN),
      `${site.file} divides by a different number than ${site.glsl}`,
    );
  }
});

test("all three parsed expressions equal floored modulo in f32", () => {
  const sources = readSources();
  for (const site of SITES) {
    for (const sample of evaluateSite(site, sources.get(site.file))) {
      assert.equal(
        sample.observed,
        sample.expected,
        `${site.file}: operand ${sample.operand} has numeric divergence ${sample.divergence}`,
      );
    }
  }
});

test("checker dark/light and dash gap/color decisions match GLSL", () => {
  const sources = readSources();
  for (const site of SITES) {
    for (const sample of evaluateSite(site, sources.get(site.file))) {
      assert.equal(
        sample.observedDecision,
        sample.expectedDecision,
        `${site.file}: operand ${sample.operand} selects ${site.selected(sample.observedDecision)} instead of ${site.selected(sample.expectedDecision)}`,
      );
    }
  }
});

const MUTATIONS = [
  {
    name: "truncated remainder",
    replacement: (dividend, divisor) =>
      `${render(dividend)} % ${render(divisor)}`,
  },
  {
    name: "floored result computed and discarded for truncated remainder",
    replacement: (dividend, divisor) => {
      const a = render(dividend);
      const b = render(divisor);
      const floored = `(${a} - ${b} * floor(${a} / ${b}))`;
      return `(${floored} * 0.0) + (${a} % ${b})`;
    },
  },
];

test("every required in-memory mutant is numerically and visibly red", () => {
  const sources = readSources();
  const survivors = [];
  for (const site of SITES) {
    const source = sources.get(site.file);
    const tree = parseExpression(extractExpression(site, source));
    const { dividend, divisor } = parsedOperands(tree);
    for (const mutation of MUTATIONS) {
      const mutant = replaceExpression(
        site,
        source,
        mutation.replacement(dividend, divisor),
      );
      const samples = evaluateSite(site, mutant);
      const numericRed = samples.some(
        (sample) => !Object.is(sample.observed, sample.expected),
      );
      const decisionRed = samples.some(
        (sample) => sample.observedDecision !== sample.expectedDecision,
      );
      if (!numericRed || !decisionRed) {
        survivors.push(
          `${path.basename(site.file)}: ${mutation.name} (numericRed=${numericRed}, decisionRed=${decisionRed})`,
        );
      }
    }
  }
  assert.deepEqual(
    survivors,
    [],
    "a surviving mutant means the parity gate is not load-bearing",
  );
});
