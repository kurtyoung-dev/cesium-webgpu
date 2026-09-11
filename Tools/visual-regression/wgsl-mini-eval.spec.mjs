// @purpose Verifies restricted WGSL expression parsing distinguishes scalar comparisons from generic constructor calls.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import { evaluate, parseExpression, tokenize } from "./lib/wgsl-mini-eval.mjs";

function parseComplete(source) {
  const tokens = tokenize(source);
  const parsed = parseExpression(tokens, 0);
  assert.equal(parsed.next, tokens.length, "expression must parse completely");
  return parsed.node;
}

function evaluateComplete(source, environment) {
  return evaluate(parseComplete(source), environment);
}

test("PREREPAIR RED: identifier-left less-than comparisons parse completely and evaluate both outcomes", () => {
  const cases = [
    [
      "cameraAltitude < deckBottom",
      { cameraAltitude: 1000.0, deckBottom: 1500.0 },
      true,
    ],
    [
      "cameraAltitude < deckBottom",
      { cameraAltitude: 2000.0, deckBottom: 1500.0 },
      false,
    ],
    [
      "cameraAltitude<deckBottom",
      { cameraAltitude: 1000.0, deckBottom: 1500.0 },
      true,
    ],
    [
      "cameraAltitude + margin < deckBottom * scale && deckTop > deckBottom",
      {
        cameraAltitude: 1000.0,
        margin: 250.0,
        deckBottom: 750.0,
        scale: 2.0,
        deckTop: 2000.0,
      },
      true,
    ],
    [
      "camera.altitude < deck.bottom",
      { camera: { altitude: 2000.0 }, deck: { bottom: 1500.0 } },
      false,
    ],
  ];

  for (const [source, environment, expected] of cases) {
    assert.equal(evaluateComplete(source, environment), expected, source);
  }
});

test("vec2, vec3, and injected vec4 f32 constructors remain calls", () => {
  const vec2Expression = parseComplete("vec2<f32>(1.0, 2.0)");
  const vec3Expression = parseComplete("vec3<f32>(1.0, 2.0, 3.0)");
  const vec4Expression = parseComplete("vec4<f32>(1.0, 2.0, 3.0, 4.0)");
  let vec4Calls = 0;
  const environment = {
    __functions: {
      vec4: (x, y, z, w) => {
        vec4Calls += 1;
        return { x, y, z, w };
      },
    },
  };

  assert.deepEqual(
    { type: vec2Expression.type, name: vec2Expression.name },
    { type: "call", name: "vec2" },
  );
  assert.deepEqual(
    { type: vec3Expression.type, name: vec3Expression.name },
    { type: "call", name: "vec3" },
  );
  assert.deepEqual(
    { type: vec4Expression.type, name: vec4Expression.name },
    { type: "call", name: "vec4" },
  );
  assert.deepEqual(evaluate(vec2Expression, environment), {
    x: 1.0,
    y: 2.0,
    z: 0.0,
  });
  assert.deepEqual(evaluate(vec3Expression, environment), {
    x: 1.0,
    y: 2.0,
    z: 3.0,
  });
  assert.deepEqual(evaluate(vec4Expression, environment), {
    x: 1.0,
    y: 2.0,
    z: 3.0,
    w: 4.0,
  });
  assert.equal(vec4Calls, 1);
});

test("generic-call-shaped comparison text remains an unsupported call", () => {
  assert.throws(
    () =>
      evaluateComplete("cameraAltitude<deckBottom>(deckTop)", {
        cameraAltitude: 3.0,
        deckBottom: 2.0,
        deckTop: 1.0,
      }),
    /^Error: unsupported call cameraAltitude$/u,
  );
});

test("malformed generic and unfinished comparison expressions throw", () => {
  assert.throws(() => parseComplete("vec3<f32>(1.0"));
  assert.throws(() => parseComplete("cameraAltitude <"));
});
