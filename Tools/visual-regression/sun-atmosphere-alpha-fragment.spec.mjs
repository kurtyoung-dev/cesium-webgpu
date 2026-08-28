// Behaviorally executes the ordered Sun fragment assignments in both backends.
// This is deliberately stricter than a source-token check: every color write
// is interpreted, so a retained multiply followed by an overwrite is visible.
//
// Run: node --test Tools/visual-regression/sun-atmosphere-alpha-fragment.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const engineSource = path.join(root, "packages/engine/Source");
const engineOverlay = process.env.CESIUM_ENGINE_SOURCE_OVERLAY
  ? path.resolve(process.env.CESIUM_ENGINE_SOURCE_OVERLAY)
  : undefined;

function readEngine(relativePath) {
  if (engineOverlay) {
    const candidate = path.join(engineOverlay, relativePath);
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }
  return fs.readFileSync(path.join(engineSource, relativePath), "utf8");
}

function stripShaderComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function extractShaderFunctionBody(source, signature) {
  const uncommented = stripShaderComments(source);
  const signatureIndex = uncommented.indexOf(signature);
  assert.ok(signatureIndex >= 0, `missing shader entry point ${signature}`);
  const openBrace = uncommented.indexOf("{", signatureIndex);
  assert.ok(openBrace > signatureIndex, `missing body for ${signature}`);
  let depth = 0;
  for (let i = openBrace; i < uncommented.length; i++) {
    if (uncommented[i] === "{") {
      depth++;
    } else if (uncommented[i] === "}") {
      depth--;
      if (depth === 0) {
        return uncommented.slice(openBrace + 1, i);
      }
    }
  }
  assert.fail(`unterminated body for ${signature}`);
}

function copyShaderValue(value) {
  return Array.isArray(value) ? [...value] : value;
}

function shaderBinary(operator, left, right) {
  const leftVector = Array.isArray(left);
  const rightVector = Array.isArray(right);
  if (leftVector && rightVector) {
    assert.equal(left.length, right.length, "shader vector width mismatch");
  }
  const width = leftVector ? left.length : rightVector ? right.length : 0;
  const apply = (a, b) => {
    if (operator === "+") {
      return a + b;
    }
    if (operator === "-") {
      return a - b;
    }
    if (operator === "*") {
      return a * b;
    }
    if (operator === "/") {
      return a / b;
    }
    assert.fail(`unsupported shader operator ${operator}`);
  };
  if (width === 0) {
    return apply(left, right);
  }
  return Array.from({ length: width }, (_, i) =>
    apply(leftVector ? left[i] : left, rightVector ? right[i] : right),
  );
}

function tokenizeShaderExpression(source) {
  const expression = source.trim();
  const pattern =
    /\s*((?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|[()+\-*/,])/gy;
  const tokens = [];
  let index = 0;
  while (index < expression.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(expression);
    assert.ok(
      match && match.index === index,
      `unsupported shader expression near ${expression.slice(index)}`,
    );
    tokens.push(match[1]);
    index = pattern.lastIndex;
  }
  return tokens;
}

function evaluateShaderExpression(source, scope) {
  const tokens = tokenizeShaderExpression(source);
  let index = 0;
  const peek = () => tokens[index];
  const take = () => tokens[index++];

  const parsePrimary = () => {
    const token = take();
    assert.ok(token, `incomplete shader expression ${source}`);
    if (token === "(") {
      const value = parseSum();
      assert.equal(take(), ")", `unclosed shader expression ${source}`);
      return value;
    }
    if (/^(?:\d|\.)/.test(token)) {
      return Number(token);
    }
    if (peek() === "(") {
      take();
      const args = [];
      if (peek() !== ")") {
        do {
          args.push(parseSum());
          if (peek() !== ",") {
            break;
          }
          take();
        } while (peek() !== ")");
      }
      assert.equal(take(), ")", `unclosed shader call ${source}`);
      if (token === "vec3f") {
        assert.equal(args.length, 1, "vec3f scalar constructor expected");
        assert.equal(typeof args[0], "number");
        return [args[0], args[0], args[0]];
      }
      if (token === "pow") {
        assert.equal(args.length, 2, "pow requires two arguments");
        const left = args[0];
        const right = args[1];
        const leftVector = Array.isArray(left);
        const rightVector = Array.isArray(right);
        const width = leftVector ? left.length : rightVector ? right.length : 0;
        if (width === 0) {
          return Math.pow(left, right);
        }
        return Array.from({ length: width }, (_, i) =>
          Math.pow(leftVector ? left[i] : left, rightVector ? right[i] : right),
        );
      }
      assert.fail(`unsupported shader call ${token}`);
    }
    assert.notEqual(scope[token], undefined, `unknown shader value ${token}`);
    return copyShaderValue(scope[token]);
  };

  const parseUnary = () => {
    if (peek() === "+") {
      take();
      return parseUnary();
    }
    if (peek() === "-") {
      take();
      return shaderBinary("*", -1.0, parseUnary());
    }
    return parsePrimary();
  };

  const parseProduct = () => {
    let value = parseUnary();
    while (peek() === "*" || peek() === "/") {
      const operator = take();
      value = shaderBinary(operator, value, parseUnary());
    }
    return value;
  };

  const parseSum = () => {
    let value = parseProduct();
    while (peek() === "+" || peek() === "-") {
      const operator = take();
      value = shaderBinary(operator, value, parseProduct());
    }
    return value;
  };

  const value = parseSum();
  assert.equal(index, tokens.length, `unconsumed shader expression ${source}`);
  return value;
}

function shaderScope(color, uniforms, webGpu) {
  const prefix = webGpu ? "u." : "u_";
  return {
    color,
    "color.rgb": color.slice(0, 3),
    "color.a": color[3],
    [`${prefix}discRadiance`]: uniforms.discRadiance,
    [`${prefix}${webGpu ? "extinction" : "atmosphereExtinction"}`]:
      uniforms.extinction,
    [`${prefix}atmosphereAlpha`]: uniforms.atmosphereAlpha,
    [`${prefix}eclipseAlpha`]: uniforms.eclipseAlpha,
    [`${prefix}gamma`]: uniforms.gamma,
    "out_FragColor.rgb": color.slice(0, 3),
    "out_FragColor.a": color[3],
  };
}

function assignShaderChannel(color, channel, operator, value) {
  const current = channel === "rgb" ? color.slice(0, 3) : color[3];
  const next =
    operator === "=" ? value : shaderBinary(operator[0], current, value);
  if (channel === "rgb") {
    assert.ok(Array.isArray(next) && next.length === 3, "RGB must stay vec3");
    color.splice(0, 3, ...next);
  } else {
    assert.equal(typeof next, "number", "alpha must stay scalar");
    color[3] = next;
  }
}

function executeWebGlSunFragment(sampled, uniforms) {
  const body = extractShaderFunctionBody(
    readEngine("Shaders/SunFS.glsl"),
    "void main()",
  );
  let color;
  let output;
  for (const rawStatement of body.split(";")) {
    const statement = rawStatement.trim();
    if (/\bvec4\s+color\s*=\s*texture\s*\(/.test(statement)) {
      color = [...sampled];
      continue;
    }
    const assignment = statement.match(
      /\bout_FragColor(?:\.(rgb|a))?\s*(\*=|\/=|\+=|-=|=)\s*([\s\S]+)$/,
    );
    if (assignment) {
      const [, channel, operator, expression] = assignment;
      assert.ok(color, "WebGL fragment must sample before writing output");
      if (!channel) {
        assert.equal(operator, "=", "whole output only supports assignment");
        if (expression.trim() === "czm_gammaCorrect(color)") {
          output = [...color];
        } else {
          const value = evaluateShaderExpression(
            expression,
            shaderScope(output ?? color, uniforms, false),
          );
          assert.ok(
            Array.isArray(value) && value.length === 4,
            "WebGL output must stay vec4",
          );
          output = value;
        }
      } else {
        assert.ok(
          output,
          "WebGL output must be initialized before channel writes",
        );
        const value = evaluateShaderExpression(
          expression,
          shaderScope(output, uniforms, false),
        );
        assignShaderChannel(output, channel, operator, value);
      }
      continue;
    }
    assert.ok(
      !statement.includes("out_FragColor"),
      `unsupported WebGL output statement: ${statement}`,
    );
  }
  assert.ok(output, "WebGL fragment did not produce a color");
  return output;
}

function splitShaderArguments(source) {
  const args = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "(") {
      depth++;
    } else if (source[i] === ")") {
      depth--;
    } else if (source[i] === "," && depth === 0) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  assert.equal(depth, 0, `unbalanced shader constructor ${source}`);
  args.push(source.slice(start).trim());
  return args;
}

function executeWebGpuSunFragment(sampled, uniforms) {
  const body = extractShaderFunctionBody(
    readEngine("Renderer/WebGPU/WebGPUEnvironmentRenderer.js"),
    "@fragment fn fs(",
  );
  let color;
  for (const rawStatement of body.split(";")) {
    const statement = rawStatement.trim();
    if (/\breturn\s+color\b/.test(statement)) {
      continue;
    }
    const assignments = [
      ...statement.matchAll(/\b(?:var\s+)?color\s*=\s*([\s\S]+)$/g),
    ];
    if (assignments.length === 1) {
      const expression = assignments[0][1].trim();
      if (expression.startsWith("textureSample(")) {
        assert.equal(color, undefined, "WebGPU fragment sampled twice");
        color = [...sampled];
        continue;
      }
      assert.ok(color, "WebGPU fragment must sample before transforming color");
      const constructor = expression.match(/^vec4f\(([\s\S]*)\)$/);
      assert.ok(
        constructor,
        `unsupported WebGPU color expression: ${expression}`,
      );
      const args = splitShaderArguments(constructor[1]);
      assert.equal(args.length, 2, "WebGPU vec4f must use vec3 plus alpha");
      const scope = shaderScope(color, uniforms, true);
      const rgb = evaluateShaderExpression(args[0], scope);
      const alpha = evaluateShaderExpression(args[1], scope);
      assert.ok(
        Array.isArray(rgb) && rgb.length === 3,
        "WebGPU RGB must stay vec3",
      );
      assert.equal(typeof alpha, "number", "WebGPU alpha must stay scalar");
      color = [...rgb, alpha];
      continue;
    }
    assert.equal(
      assignments.length,
      0,
      `multiple WebGPU color assignments in one statement: ${statement}`,
    );
    assert.ok(
      !/\bcolor(?:\.|\s*[+*/-]?=)/.test(statement),
      `unsupported WebGPU color statement: ${statement}`,
    );
  }
  assert.ok(color, "WebGPU fragment did not produce a color");
  return color;
}

const fragmentCases = [0.25, 0.5, 1.0].map((atmosphereAlpha) => ({
  sampled: [0.25, 0.5, 0.75, 0.75],
  background: [0.14, 0.42, 0.81],
  uniforms: {
    discRadiance: 1.6,
    extinction: [0.4, 0.2, 0.1],
    atmosphereAlpha,
    eclipseAlpha: 0.8,
    gamma: 1.0,
  },
}));

function expectedSunFragment(sampled, uniforms) {
  return [
    sampled[0] * uniforms.discRadiance * uniforms.extinction[0],
    sampled[1] * uniforms.discRadiance * uniforms.extinction[1],
    sampled[2] * uniforms.discRadiance * uniforms.extinction[2],
    sampled[3] * uniforms.atmosphereAlpha * uniforms.eclipseAlpha,
  ];
}

function sourceOver(color, background) {
  return color
    .slice(0, 3)
    .map(
      (channel, index) =>
        channel * color[3] + background[index] * (1.0 - color[3]),
    );
}

function assertFragmentLaw(executeFragment, backend) {
  for (const sample of fragmentCases) {
    const expected = expectedSunFragment(sample.sampled, sample.uniforms);
    const actual = executeFragment(sample.sampled, sample.uniforms);
    assert.deepEqual(
      actual.slice(0, 3),
      expected.slice(0, 3),
      `${backend} atmosphere alpha must not alter RGB`,
    );
    assert.equal(
      actual[3],
      expected[3],
      `${backend} atmosphere alpha must multiply alpha exactly once`,
    );
    assert.deepEqual(
      sourceOver(actual, sample.background),
      sourceOver(expected, sample.background),
      `${backend} source-over composite must follow the co-fade law`,
    );
  }
}

test("atmospheric alpha WebGL fragment executes one alpha-only source-over co-fade", () => {
  assertFragmentLaw(executeWebGlSunFragment, "WebGL");
});

test("atmospheric alpha WebGPU fragment executes one alpha-only source-over co-fade", () => {
  assertFragmentLaw(executeWebGpuSunFragment, "WebGPU");
});

test("atmospheric alpha twin fragments stay behaviorally identical", () => {
  for (const sample of fragmentCases) {
    assert.deepEqual(
      executeWebGlSunFragment(sample.sampled, sample.uniforms),
      executeWebGpuSunFragment(sample.sampled, sample.uniforms),
    );
  }
});
