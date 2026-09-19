// @purpose Verifies restricted WGSL expression parsing distinguishes scalar comparisons from generic constructor calls.
// @status ACTIVE

import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluate,
  laneCount,
  mat4,
  parseExpression,
  tokenize,
  vec,
  vec2,
  vec4,
} from "./lib/wgsl-mini-eval.mjs";

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

// ── The one vector rule ─────────────────────────────────────────────────────
//
// Two batches grew this evaluator on the same night. One added a `vec4` whose
// flattening counted a 2-vector's zero-filled representation as three lanes and
// which outranked a caller-injected constructor; the other added a rounding
// hook that rebuilt every vector as a 3-vector. Each was green on the runner
// its own lane ran. The cases below exercise the arities and the injection in
// single expressions, so neither addition can be reintroduced in isolation.

test("a vector constructor flattens its arguments' lanes and demands its own arity", () => {
  const cases = [
    // The expression that broke: a 2-vector through arithmetic, then two
    // scalars. Counting the representation's third component makes it five.
    [
      "vec4<f32>(uv * 2.0 - 1.0, 1.0, 1.0)",
      { uv: { x: 0.25, y: 0.75 } },
      { x: -0.5, y: 0.5, z: 1.0, w: 1.0 },
      4,
    ],
    [
      "vec4<f32>(a, b)",
      { a: vec2(1.0, 2.0), b: vec2(3.0, 4.0) },
      { x: 1.0, y: 2.0, z: 3.0, w: 4.0 },
      4,
    ],
    [
      "vec4<f32>(a, 4.0)",
      { a: vec(1.0, 2.0, 3.0) },
      { x: 1.0, y: 2.0, z: 3.0, w: 4.0 },
      4,
    ],
    [
      "vec4<f32>(a, 3.0, 4.0)",
      { a: vec2(1.0, 2.0) },
      { x: 1.0, y: 2.0, z: 3.0, w: 4.0 },
      4,
    ],
    [
      "vec4<f32>(1.0, 2.0, 3.0, 4.0)",
      {},
      { x: 1.0, y: 2.0, z: 3.0, w: 4.0 },
      4,
    ],
    ["vec4<f32>(7.0)", {}, { x: 7.0, y: 7.0, z: 7.0, w: 7.0 }, 4],
    [
      "vec4<f32>(vec2<f32>(1.0, 2.0), vec2<f32>(3.0, 4.0))",
      {},
      { x: 1.0, y: 2.0, z: 3.0, w: 4.0 },
      4,
    ],
    [
      "vec4<f32>(vec3<f32>(1.0, 2.0, 3.0), 4.0)",
      {},
      { x: 1.0, y: 2.0, z: 3.0, w: 4.0 },
      4,
    ],
    ["vec3<f32>(vec2<f32>(1.0, 2.0), 3.0)", {}, { x: 1.0, y: 2.0, z: 3.0 }, 3],
    ["vec3<f32>(5.0)", {}, { x: 5.0, y: 5.0, z: 5.0 }, 3],
    ["vec2<f32>(1.0, 2.0)", {}, { x: 1.0, y: 2.0, z: 0.0 }, 2],
    ["vec2<f32>(5.0)", {}, { x: 5.0, y: 5.0, z: 0.0 }, 2],
  ];

  for (const [source, environment, expected, lanes] of cases) {
    const actual = evaluateComplete(source, environment);
    assert.deepEqual(actual, expected, source);
    assert.equal(laneCount(actual), lanes, `${source} lane count`);
  }
});

test("a constructor given the wrong number of lanes names itself and the count", () => {
  const cases = [
    [
      "vec4<f32>(a, 1.0, 1.0)",
      { a: vec(1.0, 2.0, 3.0) },
      "vec4 given 5 components, needs 4",
    ],
    ["vec4<f32>(1.0, 2.0, 3.0)", {}, "vec4 given 3 components, needs 4"],
    [
      "vec4<f32>(a, b, 1.0)",
      { a: vec2(1.0, 2.0), b: vec2(3.0, 4.0) },
      "vec4 given 5 components, needs 4",
    ],
    [
      "vec3<f32>(a)",
      { a: vec4(1.0, 2.0, 3.0, 4.0) },
      "vec3 given 4 components, needs 3",
    ],
    ["vec2<f32>(1.0, 2.0, 3.0)", {}, "vec2 given 3 components, needs 2"],
  ];

  for (const [source, environment, message] of cases) {
    assert.throws(
      () => evaluateComplete(source, environment),
      (error) => error.message === message,
      source,
    );
  }
});

test("a caller-injected constructor outranks the built-in at every arity", () => {
  const calls = [];
  const environment = {
    uv: vec2(0.25, 0.75),
    __functions: {
      vec2: (...args) => {
        calls.push(["vec2", args.length]);
        return { injected: "vec2", args };
      },
      vec3: (...args) => {
        calls.push(["vec3", args.length]);
        return { injected: "vec3", args };
      },
      vec4: (...args) => {
        calls.push(["vec4", args.length]);
        return { injected: "vec4", args };
      },
    },
  };

  const four = evaluateComplete("vec4<f32>(uv, 1.0, 1.0)", environment);
  assert.equal(four.injected, "vec4");
  assert.equal(
    four.args.length,
    3,
    "the injection sees the arguments, not lanes",
  );
  assert.deepEqual(
    { x: four.args[0].x, y: four.args[0].y },
    { x: 0.25, y: 0.75 },
  );
  assert.equal(
    evaluateComplete("vec3<f32>(1.0, 2.0, 3.0)", environment).injected,
    "vec3",
  );
  assert.equal(
    evaluateComplete("vec2<f32>(1.0, 2.0)", environment).injected,
    "vec2",
  );
  assert.deepEqual(calls, [
    ["vec4", 3],
    ["vec3", 3],
    ["vec2", 2],
  ]);
});

test("arithmetic keeps the arity it was handed, and mixing arities throws", () => {
  const environment = {
    two: vec2(1.0, 2.0),
    three: vec(1.0, 2.0, 3.0),
    four: vec4(1.0, 2.0, 3.0, 4.0),
  };

  // A scalar splats to the vector's own arity; the 2-vector's zero-filled
  // third component is NOT a lane the operator may write.
  const scaled = evaluateComplete("two * 2.0 - 1.0", environment);
  assert.deepEqual(scaled, { x: 1.0, y: 3.0, z: 0.0 });
  assert.equal(laneCount(scaled), 2);

  const scaledFour = evaluateComplete("four * 2.0", environment);
  assert.deepEqual(scaledFour, { x: 2.0, y: 4.0, z: 6.0, w: 8.0 });
  assert.equal(laneCount(scaledFour), 4);

  for (const [source, message] of [
    ["two + three", "mixed vec2 and vec3 operands"],
    ["three + four", "mixed vec3 and vec4 operands"],
    ["four - two", "mixed vec4 and vec2 operands"],
  ]) {
    assert.throws(
      () => evaluateComplete(source, environment),
      (error) => error.message === message,
      source,
    );
  }
});

test("the rounding hook keeps every lane it was handed", () => {
  // The matrix product is the one place a 4-vector is produced by arithmetic,
  // so it is where a rounding hook that rebuilds vectors as 3-vectors drops
  // the w lane. Both additions meet here.
  const environment = {
    m: mat4([0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 0.1]),
    v: vec4(1.0, 1.0, 1.0, 1.0),
    __round: Math.fround,
  };

  const product = evaluateComplete("m * v", environment);
  assert.equal(laneCount(product), 4, "the product is still four lanes");
  assert.deepEqual(product, {
    x: Math.fround(0.1),
    y: Math.fround(0.1),
    z: Math.fround(0.1),
    w: Math.fround(0.1),
  });
  assert.equal(evaluateComplete("(m * v).w", environment), Math.fround(0.1));
  assert.equal(evaluateComplete("(m * v)[3]", environment), Math.fround(0.1));
  assert.equal(
    laneCount(evaluateComplete("vec2<f32>(0.1, 0.2)", environment)),
    2,
    "the hook does not widen a 2-vector either",
  );
});

test("a subscript names the arity it ran off the end of", () => {
  const environment = {
    two: vec2(1.0, 2.0),
    three: vec(1.0, 2.0, 3.0),
    four: vec4(1.0, 2.0, 3.0, 4.0),
  };

  assert.equal(evaluateComplete("two[1]", environment), 2.0);
  assert.equal(evaluateComplete("three[2]", environment), 3.0);
  assert.equal(evaluateComplete("four[3]", environment), 4.0);
  for (const [source, message] of [
    ["two[2]", "subscript 2 out of range for a vec2"],
    ["three[3]", "subscript 3 out of range for a vec3"],
  ]) {
    assert.throws(
      () => evaluateComplete(source, environment),
      (error) => error.message === message,
      source,
    );
  }
});

test("a 4-vector's swizzles are views, not components", () => {
  const environment = { four: vec4(1.0, 2.0, 3.0, 4.0) };

  assert.deepEqual(evaluateComplete("four", environment), {
    x: 1.0,
    y: 2.0,
    z: 3.0,
    w: 4.0,
  });
  const xy = evaluateComplete("four.xy", environment);
  assert.deepEqual(xy, { x: 1.0, y: 2.0, z: 0.0 });
  assert.equal(laneCount(xy), 2, "a .xy swizzle is a 2-vector");
  assert.deepEqual(evaluateComplete("four.xyz", environment), {
    x: 1.0,
    y: 2.0,
    z: 3.0,
  });
  assert.deepEqual(
    evaluateComplete("vec4<f32>(four.xy, four.xy)", environment),
    { x: 1.0, y: 2.0, z: 1.0, w: 2.0 },
    "a swizzle contributes the lanes it has",
  );
});

test("a vector constructor refuses a matrix and rounds the lanes it was handed", () => {
  // Both are code this batch ADDED that no case above reads: the matrix
  // refusal, and the rounding of a constructor's own lanes. Made inert —
  // `if (false && isMat4(a))`, and `return constructVector(...)` with no
  // `quantize` — every other case in this file still passes.
  const m = mat4(new Array(16).fill(1));
  for (const [source, message] of [
    ["vec4<f32>(m)", "vec4 cannot be built from a matrix"],
    ["vec3<f32>(m, 1.0, 2.0)", "vec3 cannot be built from a matrix"],
    ["vec2<f32>(1.0, m)", "vec2 cannot be built from a matrix"],
  ]) {
    assert.throws(
      () => evaluateComplete(source, { m }),
      (error) => error.message === message,
      source,
    );
  }

  // A lane that reaches a constructor unrounded is rounded by it, as every
  // other operation's result is.
  const hook = { a: 0.1, __round: Math.fround };
  assert.deepEqual(evaluateComplete("vec4<f32>(a, 1.0, 1.0, 1.0)", hook), {
    x: Math.fround(0.1),
    y: 1.0,
    z: 1.0,
    w: 1.0,
  });
  assert.deepEqual(evaluateComplete("vec2<f32>(a, 2.0)", hook), {
    x: Math.fround(0.1),
    y: 2.0,
    z: 0.0,
  });
});

// ── The same rule inside the builtins ───────────────────────────────────────
//
// The rule above stopped at `BUILTINS`, where `length`, `dot` and `normalize`
// read three fixed components and every scalar builtin answered `NaN` for a
// vector. That left a 4-vector losing its `w` to `length` — the lane loss the
// rounding hook was fixed for — and, once mixing arities became a throw, made
// `normalize(vec2) * vec2` (legal WGSL, and shipped text in
// `Ocean/OceanInitialSpectrum.wgsl`) refuse to evaluate at all, while
// `vec3<f32>(normalize(vec2))` (illegal WGSL) quietly returned a value built
// from the 2-vector's zero filler. The cases below read the numbers, so the
// rule cannot stop at the builtins again.

test("a vector-reading builtin reads the lanes its argument has", () => {
  const environment = {
    two: vec2(3.0, 4.0),
    three: vec(1.0, 2.0, 2.0),
    four: vec4(1.0, 2.0, 3.0, 4.0),
  };

  // `w` reaches the sum: three fixed components answer 3.7416573867739413 and
  // 14 for these two.
  assert.equal(evaluateComplete("length(four)", environment), Math.sqrt(30));
  assert.equal(evaluateComplete("dot(four, four)", environment), 30);
  assert.equal(evaluateComplete("length(two)", environment), 5);
  assert.equal(evaluateComplete("length(three)", environment), 3);
  assert.equal(evaluateComplete("dot(two, two)", environment), 25);
  assert.equal(evaluateComplete("dot(three, three)", environment), 9);

  const unitFour = evaluateComplete("normalize(four)", environment);
  assert.equal(laneCount(unitFour), 4, "a 4-vector normalises to four lanes");
  assert.equal(unitFour.w, 4 / Math.sqrt(30));
  const unitTwo = evaluateComplete("normalize(two)", environment);
  assert.equal(laneCount(unitTwo), 2, "a 2-vector normalises to two lanes");
  assert.deepEqual(unitTwo, { x: 0.6, y: 0.8, z: 0.0 });
});

test("a normalised 2-vector still combines with the vector it came from", () => {
  // Every row here evaluates at the pre-wave base and must keep evaluating: a
  // builtin that answers a 2-vector with a 3-vector turns the arity refusal
  // into a refusal of legal WGSL.
  const scaled = evaluateComplete(
    "normalize(vec2<f32>(1.0, 0.0)) * vec2<f32>(2.0, 3.0)",
    {},
  );
  assert.deepEqual(scaled, { x: 2.0, y: 0.0, z: 0.0 });
  assert.equal(laneCount(scaled), 2);

  const summed = evaluateComplete(
    "normalize(vec2<f32>(3.0, 4.0)) + vec2<f32>(1.0, 1.0)",
    {},
  );
  assert.deepEqual(summed, { x: 1.6, y: 1.8, z: 0.0 });
  assert.equal(laneCount(summed), 2);

  const lifted = evaluateComplete(
    "vec3<f32>(normalize(vec2<f32>(3.0, 4.0)), 1.0)",
    {},
  );
  assert.deepEqual(lifted, { x: 0.6, y: 0.8, z: 1.0 });
  assert.equal(laneCount(lifted), 3);
});

test("a scalar builtin is lifted component-wise over the lanes it is handed", () => {
  const environment = {
    two: vec2(4.0, 9.0),
    three: vec(-1.0, 2.0, 0.5),
    four: vec4(1.0, 2.0, 3.0, 4.0),
  };

  const cases = [
    ["abs(three)", { x: 1.0, y: 2.0, z: 0.5 }, 3],
    ["clamp(three, 0.0, 1.0)", { x: 0.0, y: 1.0, z: 0.5 }, 3],
    ["min(four, 2.0)", { x: 1.0, y: 2.0, z: 2.0, w: 2.0 }, 4],
    // A vector operand used to throw `unsupported operator max` here, because
    // the only vector path `max` had went through an operator table holding
    // `+ - * /`.
    ["max(four, 2.0)", { x: 2.0, y: 2.0, z: 3.0, w: 4.0 }, 4],
    ["max(four, four)", { x: 1.0, y: 2.0, z: 3.0, w: 4.0 }, 4],
    ["sqrt(two)", { x: 2.0, y: 3.0, z: 0.0 }, 2],
    ["pow(two, 2.0)", { x: 16.0, y: 81.0, z: 0.0 }, 2],
    ["smoothstep(0.0, 1.0, three)", { x: 0.0, y: 1.0, z: 0.5 }, 3],
  ];

  for (const [source, expected, lanes] of cases) {
    const actual = evaluateComplete(source, environment);
    assert.deepEqual(actual, expected, source);
    assert.equal(laneCount(actual), lanes, `${source} lane count`);
  }

  // The scalar arguments still take the scalar path, unchanged.
  assert.equal(evaluateComplete("abs(-2.0)", environment), 2.0);
  assert.equal(evaluateComplete("clamp(5.0, 0.0, 1.0)", environment), 1.0);
  assert.equal(evaluateComplete("max(1.0, 2.0)", environment), 2.0);
  assert.equal(evaluateComplete("min(1.0, 2.0)", environment), 1.0);
  assert.equal(evaluateComplete("smoothstep(0.0, 1.0, 0.5)", environment), 0.5);
});

test("a builtin refuses what it cannot read a lane count from", () => {
  const environment = {
    m: mat4(new Array(16).fill(1)),
    two: vec2(1.0, 2.0),
    three: vec(1.0, 2.0, 3.0),
  };

  for (const [source, message] of [
    // Illegal WGSL that the built-in `normalize` used to make look legal by
    // handing a constructor the 2-vector's zero filler as a third lane.
    [
      "vec3<f32>(normalize(vec2<f32>(3.0, 4.0)))",
      "vec3 given 2 components, needs 3",
    ],
    [
      "vec4<f32>(normalize(vec2<f32>(3.0, 4.0)), 1.0)",
      "vec4 given 3 components, needs 4",
    ],
    ["dot(two, three)", "mixed vec2 and vec3 operands"],
    ["max(two, three)", "mixed vec2 and vec3 operands"],
    ["clamp(three, two, 1.0)", "mixed vec3 and vec2 operands"],
    ["length(1.0)", "length takes a vector"],
    ["dot(three, 1.0)", "dot takes a vector"],
    ["normalize(m)", "normalize takes a vector"],
    ["abs(m)", "abs cannot be applied to a matrix"],
    ["max(m, 1.0)", "max cannot be applied to a matrix"],
  ]) {
    assert.throws(
      () => evaluateComplete(source, environment),
      (error) => error.message === message,
      source,
    );
  }
});
