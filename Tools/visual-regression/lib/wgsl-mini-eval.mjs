// wgsl-mini-eval.mjs — a small evaluator for a restricted subset of WGSL, so
// a shader law can be EXECUTED out of its own source rather than transcribed
// into a spec and asserted against itself.
//
// @purpose Parses and evaluates the arithmetic subset of WGSL (let bindings, one guarded return, scalar and vec3 arithmetic, a fixed builtin set) so specs can run a shader function straight from the shipped source.
// @status ACTIVE
//
// WHY THIS EXISTS. A spec that reimplements a shader's arithmetic in
// JavaScript and then asserts properties of the reimplementation certifies the
// reimplementation. Every property such a spec reports stays green when the
// shader changes underneath it. This module removes that gap for the subset of
// shader code that is pure arithmetic: the caller names a function in the WGSL
// source, gets back a callable, and every number it produces came from the text
// that ships.
//
// FAIL CLOSED. Anything outside the supported subset throws. A shader that
// grows a loop, a switch, a matrix product or a texture fetch makes its spec
// fail loudly instead of silently skipping the part it cannot read — the failure
// mode that matters, because a quietly narrowed evaluator is indistinguishable
// from a passing test.
//
// PRECISION. Evaluation is f64 where the GPU is f32. Callers must assert
// properties that hold with room to spare rather than bit-level equality with
// a device. A caller whose law IS the rounding binds `__round` in the globals
// object — `Math.fround` is the f32 case — and every literal, arithmetic
// result, negation and builtin return then lands on the nearest representable
// value, as it does in the pipeline. Unbound, the hook costs one property read
// and changes nothing.
//
// Supported: `let` / `var` bindings, guarded early `return`s, a final
// `return`, unary minus, `+ - * /`, comparisons, `&&`, `||`, the conditional
// operator `c ? a : b`, member access, `vec2<f32>`, `vec3<f32>` and
// `vec4<f32>` construction, `m[column][row]` subscripting of a `mat4` or a
// vector, `matrix * vec4`, and the builtins listed in `BUILTINS`.
//
// ONE RULE FOR VECTORS. Every vector value carries a LANE COUNT, and every
// rule that reads a vector — construction, arithmetic, subscripting, the
// rounding hook, the builtins — reads that count and nothing else. A scalar
// builtin is lifted component-wise over the lanes it is handed, and the three
// whose subject is a vector (`dot`, `length`, `normalize`) read the lanes
// their argument has rather than three fixed components. A constructor flattens
// its arguments' lanes in order and demands exactly its own arity, as WGSL
// does, so `vec4(vec2, f32, f32)` is four lanes while `vec4(vec3, f32, f32)`
// throws naming the constructor and the count it got. Arithmetic between two
// vectors of different arities throws rather than inventing a lane. A `vec2`
// is still REPRESENTED as a 3-vector with a zero third component so `length`
// and the component-wise operators need no special case, but its lane count is
// two — the distinction a constructor must see and a representation alone
// cannot carry.
//
// ONE RULE FOR CALLS. A callable the caller bound in `__functions` always
// wins — over a vector constructor exactly as over a builtin. Callers inject
// `vec4` to get their own 4-vector type out of a shader expression, and a
// built-in constructor that silently outranked the injection would hand them
// a value of the wrong type from an expression they thought they controlled.
//
// WHY THE CONDITIONAL OPERATOR IS HERE. A shader inertness image works by
// putting the pre-fix text back on a copy of the source and re-running the same
// reader over it. Without `?:` and `select`, a reverted GLSL ternary or WGSL
// `select` made the reader THROW, so the image went red by parser failure
// rather than by a measured value - which cannot distinguish "the fix is load
// bearing" from "the mutant is unreadable". Both spellings evaluate now, so a
// mutation image reports the number the reverted shader would produce.
//
// A deliberately small interpreter for the subset the glint functions use:
// `let` bindings, one guarded early return, arithmetic, member access, and the
// handful of builtins below. Anything outside the subset throws rather than
// being silently skipped, so a shader change that outgrows the evaluator
// surfaces as a failure instead of a vacuous pass.

const PUNCT = [
  "<=",
  ">=",
  "==",
  "!=",
  "&&",
  "||",
  "->",
  "+",
  "-",
  "*",
  "/",
  "(",
  ")",
  ",",
  ";",
  "{",
  "}",
  "<",
  ">",
  "=",
  ".",
  ":",
  "?",
  "[",
  "]",
];

/**
 * Split WGSL source into identifier / number / punctuation tokens.
 *
 * @param {string} src WGSL text with comments already removed.
 * @returns {Array<{kind: string, text: string}>} The tokens.
 */
function tokenize(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) {
        j += 1;
      }
      tokens.push({ kind: "id", text: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const match = /^[0-9]*\.?[0-9]+(?:[eE][+-]?[0-9]+)?/.exec(src.slice(i));
      if (match === null) {
        throw new Error(`unparsable number at ${i}`);
      }
      tokens.push({ kind: "num", text: match[0] });
      i += match[0].length;
      continue;
    }
    const at = i;
    const punct = PUNCT.find((p) => src.startsWith(p, at));
    if (punct === undefined) {
      throw new Error(`unexpected character ${JSON.stringify(ch)} at ${i}`);
    }
    tokens.push({ kind: "punct", text: punct });
    i += punct.length;
  }
  return tokens;
}

/**
 * Remove `//` line comments so they cannot reach the tokenizer.
 *
 * @param {string} src WGSL text.
 * @returns {string} The stripped text.
 */
function stripComments(src) {
  return src
    .split("\n")
    .map((line) => {
      const at = line.indexOf("//");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

const isVec = (v) => typeof v === "object" && v !== null && "x" in v;
const vec = (x, y, z) => ({ x, y, z });

// The lane count is carried out of band, so a vector's ENUMERABLE shape is
// unchanged and a caller that deep-compares a result sees no extra key. Only a
// 2-vector needs the marker: a 3-vector and a 4-vector are told apart by
// whether they carry `w`.
const LANES = "__lanes";

/**
 * A 2-vector: represented as a 3-vector with a zero third component so
 * `length` and the component-wise operators read it with no special case, and
 * tagged with its real arity so a constructor counts two lanes, not three.
 *
 * @param {number} x Component.
 * @param {number} y Component.
 * @returns {object} The 2-vector.
 */
const vec2 = (x, y) => Object.defineProperty(vec(x, y, 0), LANES, { value: 2 });

/**
 * How many lanes a vector value carries.
 *
 * Every vector rule in this module asks here and nowhere else, which is what
 * keeps the rules consistent with one another. A value the caller built by
 * hand is read by the components it actually has, so `{ x, y }` is two lanes.
 *
 * @param {object} v A vector value.
 * @returns {number} Two, three or four.
 */
function laneCount(v) {
  const declared = v[LANES];
  if (typeof declared === "number") {
    return declared;
  }
  if ("w" in v) {
    return 4;
  }
  return "z" in v ? 3 : 2;
}

/**
 * A vector's lanes in order, with no lane it does not have.
 *
 * @param {object} v A vector value.
 * @returns {number[]} The components.
 */
function laneValues(v) {
  return [v.x, v.y, v.z, v.w].slice(0, laneCount(v));
}

/**
 * Build a vector of a given arity from its lanes.
 *
 * @param {number} size Two, three or four.
 * @param {number[]} lanes Exactly `size` components.
 * @returns {object} The vector.
 */
function makeVector(size, lanes) {
  if (size === 4) {
    return vec4(lanes[0], lanes[1], lanes[2], lanes[3]);
  }
  if (size === 3) {
    return vec(lanes[0], lanes[1], lanes[2]);
  }
  return vec2(lanes[0], lanes[1]);
}

/**
 * A 4-vector. Distinct from `vec` so nothing that already reads a 3-vector
 * changes shape: `isVec4` is what selects the 4-lane paths, and a `vec4` that
 * reached 3-lane arithmetic would silently lose its `w`, which is the defect
 * class this evaluator exists to catch.
 *
 * The swizzles are real properties because member access is a plain
 * `obj[name]` lookup, but NON-ENUMERABLE ones: a swizzle is a view of the
 * four lanes, not a fifth and a sixth component, and a caller that
 * deep-compares a result against `{ x, y, z, w }` must not see them.
 *
 * @param {number} x Component.
 * @param {number} y Component.
 * @param {number} z Component.
 * @param {number} w Component.
 * @returns {object} The 4-vector.
 */
const vec4 = (x, y, z, w) =>
  Object.defineProperties(
    { x, y, z, w },
    {
      xy: {
        get: () => vec2(x, y),
      },
      xyz: {
        get: () => vec(x, y, z),
      },
    },
  );

const isVec4 = (v) => isVec(v) && laneCount(v) === 4;

/**
 * A 4x4 matrix in WGSL/`Matrix4` column-major order, so `m[column][row]`
 * indexes it the way both the shader and `Core/Matrix4.js` do.
 *
 * @param {number[]} columnMajor Sixteen elements.
 * @returns {object} The matrix.
 */
const mat4 = (columnMajor) => {
  if (!Array.isArray(columnMajor) || columnMajor.length !== 16) {
    throw new Error("mat4 takes sixteen column-major elements");
  }
  return { __mat4: columnMajor.slice() };
};

const isMat4 = (v) =>
  typeof v === "object" && v !== null && Array.isArray(v.__mat4);

/**
 * `matrix * vector` in the WGSL sense: columns scaled by the vector's
 * components and summed.
 *
 * @param {object} m The matrix.
 * @param {object} v A 4-vector.
 * @returns {object} The transformed 4-vector.
 */
function mat4TimesVec4(m, v) {
  const e = m.__mat4;
  const out = [0, 0, 0, 0];
  const components = [v.x, v.y, v.z, v.w];
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[row] += e[column * 4 + row] * components[column];
    }
  }
  return vec4(out[0], out[1], out[2], out[3]);
}

const VECTOR_ARITY = { vec2: 2, vec3: 3, vec4: 4 };

/**
 * WGSL's vector constructor, for every arity, as one rule: flatten the
 * arguments' lanes in order and demand exactly the constructor's own arity.
 *
 * A single scalar splats, as it does in WGSL. Anything else that does not come
 * to the right number of lanes throws NAMING the constructor and the count it
 * was given, because the two ways to get this wrong — feeding a 3-vector where
 * a 2-vector was meant, and feeding one lane too few — are indistinguishable
 * from the resulting value alone.
 *
 * @param {string} name The constructor's WGSL name, for the message.
 * @param {number} size Two, three or four.
 * @param {Array<number|object>} args The evaluated arguments.
 * @returns {object} The vector.
 */
function constructVector(name, size, args) {
  const lanes = [];
  for (const a of args) {
    if (isMat4(a)) {
      throw new Error(`${name} cannot be built from a matrix`);
    }
    if (isVec(a)) {
      lanes.push(...laneValues(a));
    } else {
      lanes.push(a);
    }
  }
  if (lanes.length === 1) {
    return makeVector(size, new Array(size).fill(lanes[0]));
  }
  if (lanes.length !== size) {
    throw new Error(`${name} given ${lanes.length} components, needs ${size}`);
  }
  return makeVector(size, lanes);
}

/**
 * Component-wise binary arithmetic over scalars and vectors of any arity.
 *
 * @param {string} op One of `+ - * /`.
 * @param {number|object} a Left operand.
 * @param {number|object} b Right operand.
 * @returns {number|object} The result.
 */
function arith(op, a, b) {
  const f = {
    "+": (x, y) => x + y,
    "-": (x, y) => x - y,
    "*": (x, y) => x * y,
    "/": (x, y) => x / y,
  }[op];
  if (f === undefined) {
    throw new Error(`unsupported operator ${op}`);
  }
  if (isMat4(a) || isMat4(b)) {
    // Only `matrix * vector` is in the subset. Anything else — a matrix
    // product, a matrix sum — throws rather than being approximated.
    if (op !== "*" || !isMat4(a) || !isVec4(b)) {
      throw new Error("only matrix * vec4 is supported");
    }
    return mat4TimesVec4(a, b);
  }
  if (isVec(a) || isVec(b)) {
    // Two vectors of different arities have no defined lane mapping, so they
    // throw instead of one being padded with a lane the shader never wrote. A
    // scalar splats to whatever arity the vector operand carries.
    if (isVec(a) && isVec(b) && laneCount(a) !== laneCount(b)) {
      throw new Error(
        `mixed vec${laneCount(a)} and vec${laneCount(b)} operands`,
      );
    }
    const size = laneCount(isVec(a) ? a : b);
    const left = isVec(a) ? laneValues(a) : new Array(size).fill(a);
    const right = isVec(b) ? laneValues(b) : new Array(size).fill(b);
    return makeVector(
      size,
      left.map((component, lane) => f(component, right[lane])),
    );
  }
  return f(a, b);
}

/**
 * Lift a scalar builtin to the component-wise form WGSL and GLSL both give it.
 *
 * The rule is `arith`'s, so the two agree with each other: a scalar argument
 * splats to the vector arguments' arity, two vector arguments of different
 * arities throw rather than one being padded with a lane the shader never
 * wrote, and the result carries the arity it was handed. Before this a vector
 * reaching a scalar builtin read components that are not there and answered
 * `NaN` — a silent number, which is the failure mode this module exists to
 * refuse.
 *
 * @param {string} name The builtin's WGSL name, for the message.
 * @param {Function} scalar The scalar implementation, applied per lane.
 * @returns {Function} The component-wise builtin.
 */
function componentWise(name, scalar) {
  return (...args) => {
    if (args.some(isMat4)) {
      throw new Error(`${name} cannot be applied to a matrix`);
    }
    const vectors = args.filter(isVec);
    if (vectors.length === 0) {
      return scalar(...args);
    }
    const size = laneCount(vectors[0]);
    for (const other of vectors) {
      if (laneCount(other) !== size) {
        throw new Error(`mixed vec${size} and vec${laneCount(other)} operands`);
      }
    }
    const lanes = args.map((a) =>
      isVec(a) ? laneValues(a) : new Array(size).fill(a),
    );
    return makeVector(
      size,
      Array.from({ length: size }, (ignored, lane) =>
        scalar(...lanes.map((argument) => argument[lane])),
      ),
    );
  };
}

/**
 * A vector argument's lanes, for a builtin whose subject IS a vector.
 *
 * WGSL gives `length` a scalar overload that no consumer of this module uses,
 * so a scalar — or a matrix, or anything else carrying no components —
 * reaching one of these is a shader the evaluator has outgrown. It throws
 * naming the builtin rather than reading lanes that are not there and
 * answering `NaN`.
 *
 * @param {string} name The builtin's WGSL name, for the message.
 * @param {object} v The argument.
 * @returns {number[]} Its lanes.
 */
function vectorLanes(name, v) {
  if (!isVec(v)) {
    throw new Error(`${name} takes a vector`);
  }
  return laneValues(v);
}

const BUILTINS = {
  // Every builtin that can be handed a vector reads its lane count, exactly as
  // construction, arithmetic, subscripting and the rounding hook do. The
  // scalar ones are lifted component-wise, which is what both shading
  // languages do with them; the three whose subject is a vector read their
  // lanes below.
  max: componentWise("max", Math.max),
  min: componentWise("min", Math.min),
  abs: componentWise("abs", Math.abs),
  sqrt: componentWise("sqrt", Math.sqrt),
  log2: componentWise("log2", Math.log2),
  // `exp2`, `ceil` and `floor` are the three the sampling laws need and the
  // three this table shipped without: with `exp2` missing, the renderer's own
  // `logDepthToEyeDistance` parsed and then threw, so no depth inverse and no
  // step law in this engine could be EXECUTED out of its own source.
  exp2: componentWise("exp2", (v) => 2 ** v),
  ceil: componentWise("ceil", Math.ceil),
  floor: componentWise("floor", Math.floor),
  pow: componentWise("pow", Math.pow),
  clamp: componentWise("clamp", (v, lo, hi) => Math.min(Math.max(v, lo), hi)),
  smoothstep: componentWise("smoothstep", (edge0, edge1, x) => {
    const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
    return t * t * (3 - 2 * t);
  }),
  // The vector-reading builtins obey the one rule too: they read the lane
  // count, not three fixed components. Before this, `length` and `dot` dropped
  // a 4-vector's `w` silently — the same lane loss `quantize` was fixed for —
  // and `normalize` answered a 2-vector with a 3-vector, so its result could
  // neither be constructed from nor combined with the vector it came from.
  dot: (a, b) => {
    const left = vectorLanes("dot", a);
    const right = vectorLanes("dot", b);
    if (left.length !== right.length) {
      throw new Error(
        `mixed vec${left.length} and vec${right.length} operands`,
      );
    }
    return left.reduce((sum, c, lane) => sum + c * right[lane], 0);
  },
  length: (a) =>
    Math.sqrt(vectorLanes("length", a).reduce((s, c) => s + c * c, 0)),
  normalize: (a) => {
    const lanes = vectorLanes("normalize", a);
    const l = Math.sqrt(lanes.reduce((s, c) => s + c * c, 0));
    return makeVector(
      lanes.length,
      lanes.map((c) => c / l),
    );
  },
  // WGSL argument order: the FALSE value first, then the true value, then the
  // condition. The GLSL twin of the same law is written `c ? a : b`, which the
  // parser lowers to the same node, so one reader executes both spellings.
  select: (falseValue, trueValue, condition) =>
    condition ? trueValue : falseValue,
  // THE SCALAR CONVERSIONS ARE NOT LIFTED, DELIBERATELY. `f32(v)` and `i32(v)`
  // are type constructors, and WGSL has no vector overload of either — the
  // vector spelling is `vec3<f32>(…)`, which the constructor path above
  // already handles. Lifting them component-wise would accept source the
  // compiler rejects, which is the quietly-widened-reader failure this module
  // exists to refuse, so they throw on a vector instead.
  //
  // `f32` is the identity on the VALUE and defers to the environment's
  // rounding hook exactly as every other builtin does: with no `__round`
  // bound, evaluation stays f64 and `f32(x)` is a no-op; with `Math.fround`
  // bound, it lands on the nearest f32, which is what the conversion means on
  // a device. `i32` truncates toward zero, as WGSL's does.
  f32: (value) => {
    if (isVec(value) || isMat4(value)) {
      throw new Error("f32 takes a scalar; the vector spelling is vec<N><f32>");
    }
    return Number(value);
  },
  i32: (value) => {
    if (isVec(value) || isMat4(value)) {
      throw new Error("i32 takes a scalar; the vector spelling is vec<N><i32>");
    }
    return Math.trunc(value);
  },
};

/**
 * Apply the environment's optional per-operation rounding hook.
 *
 * Evaluation is f64 by default, which is the right default for a law whose
 * subject is a ratio or a threshold. It is the WRONG default for a law whose
 * subject IS the rounding: a shader that reconstructs a planet-scale position
 * by summing a high/low split loses half a metre to the f32 quantum, and an
 * f64 reader reproduces that sum exactly and reports no error at all. Binding
 * `__round` to `Math.fround` lands every intermediate on the nearest f32, which
 * is what the GPU pipeline does, so the reader measures the quantisation
 * instead of erasing it. With no hook bound nothing changes for any caller.
 *
 * @param {number|object|boolean} value The value an operation produced.
 * @param {object} env Name to value bindings, possibly carrying `__round`.
 * @returns {number|object|boolean} The value, rounded when the hook is bound.
 */
function quantize(value, env) {
  const round = env.__round;
  if (typeof round !== "function") {
    return value;
  }
  if (isVec(value)) {
    return makeVector(laneCount(value), laneValues(value).map(round));
  }
  return typeof value === "number" ? round(value) : value;
}

/**
 * Recursive-descent expression parser over the token list.
 *
 * @param {Array<{kind: string, text: string}>} tokens Tokens.
 * @param {number} start Index to begin at.
 * @returns {{node: object, next: number}} The parsed node and the next index.
 */
function parseExpression(tokens, start) {
  let pos = start;
  // Forward reference: `primary` parses parenthesised and argument
  // sub-expressions, and both may contain a conditional, which is defined below
  // it. Assigned once, before any parsing happens.
  let ternary;
  const peek = () => tokens[pos];
  const eat = (text) => {
    if (tokens[pos]?.text !== text) {
      throw new Error(`expected ${text}, found ${tokens[pos]?.text}`);
    }
    pos += 1;
  };

  function primary() {
    const tok = peek();
    if (tok === undefined) {
      throw new Error("unexpected end of expression");
    }
    let node;
    if (tok.kind === "num") {
      pos += 1;
      node = { type: "num", value: Number(tok.text) };
    } else if (tok.text === "(") {
      pos += 1;
      const inner = ternary();
      eat(")");
      node = inner;
    } else if (tok.text === "-") {
      pos += 1;
      node = { type: "neg", operand: unary() };
    } else if (tok.kind === "id") {
      pos += 1;
      const name = tok.text;
      if (
        peek()?.text === "<" &&
        tokens[pos + 1]?.kind === "id" &&
        tokens[pos + 2]?.text === ">" &&
        tokens[pos + 3]?.text === "("
      ) {
        // A type-parameterised constructor such as `vec3<f32>(…)`.
        pos += 3;
      }
      if (peek()?.text === "(") {
        pos += 1;
        const args = [];
        if (peek()?.text !== ")") {
          for (;;) {
            args.push(ternary());
            if (peek()?.text === ",") {
              pos += 1;
              continue;
            }
            break;
          }
        }
        eat(")");
        node = { type: "call", name, args };
      } else {
        node = { type: "ref", name };
      }
    } else {
      throw new Error(`unexpected token ${tok.text}`);
    }
    // Member access and subscripting chain freely: `projection[1][1]`,
    // `camera.projection[3][3]`, `clip.xyz`.
    for (;;) {
      if (peek()?.text === ".") {
        pos += 1;
        const member = peek();
        if (member?.kind !== "id") {
          throw new Error("expected a member name");
        }
        pos += 1;
        node = { type: "member", object: node, name: member.text };
        continue;
      }
      if (peek()?.text === "[") {
        pos += 1;
        const subscript = ternary();
        eat("]");
        node = { type: "index", object: node, subscript };
        continue;
      }
      break;
    }
    return node;
  }

  function unary() {
    if (peek()?.text === "-") {
      pos += 1;
      return { type: "neg", operand: unary() };
    }
    return primary();
  }

  function binary(next, ops) {
    let left = next();
    while (peek() !== undefined && ops.includes(peek().text)) {
      const op = peek().text;
      pos += 1;
      left = { type: "bin", op, left, right: next() };
    }
    return left;
  }

  const mul = () => binary(unary, ["*", "/"]);
  const add = () => binary(mul, ["+", "-"]);
  const cmp = () => binary(add, ["<=", ">=", "<", ">", "==", "!="]);
  const and = () => binary(cmp, ["&&"]);
  const or = () => binary(and, ["||"]);

  // Right-associative, lowest precedence, same shape as GLSL's `?:`. `select`
  // is its WGSL spelling and arrives through `BUILTINS` as an ordinary call.
  function conditional() {
    const test = or();
    if (peek()?.text !== "?") {
      return test;
    }
    pos += 1;
    const consequent = conditional();
    eat(":");
    const alternate = conditional();
    return { type: "cond", test, consequent, alternate };
  }
  ternary = conditional;

  const node = conditional();
  return { node, next: pos };
}

/**
 * Evaluate a parsed node against an environment.
 *
 * @param {object} node The node.
 * @param {object} env Name to value bindings.
 * @returns {number|object|boolean} The value.
 */
function evaluate(node, env) {
  switch (node.type) {
    case "num":
      return quantize(node.value, env);
    case "neg": {
      const v = evaluate(node.operand, env);
      return quantize(isVec(v) ? vec(-v.x, -v.y, -v.z) : -v, env);
    }
    case "ref": {
      // The boolean literals, so an `if (false && …)` inertness mutant reads as
      // a MEASURED value rather than as a parser error — the distinction the
      // conditional operator was added for.
      if (node.name === "true") {
        return true;
      }
      if (node.name === "false") {
        return false;
      }
      if (!(node.name in env)) {
        throw new Error(`unbound identifier ${node.name}`);
      }
      return env[node.name];
    }
    case "member": {
      const obj = evaluate(node.object, env);
      if (obj === null || typeof obj !== "object" || !(node.name in obj)) {
        throw new Error(`no member ${node.name}`);
      }
      return obj[node.name];
    }
    case "index": {
      const obj = evaluate(node.object, env);
      const at = evaluate(node.subscript, env);
      if (!Number.isInteger(at) || at < 0 || at > 3) {
        throw new Error(`subscript ${at} out of range`);
      }
      if (isMat4(obj)) {
        const e = obj.__mat4;
        return vec4(e[at * 4], e[at * 4 + 1], e[at * 4 + 2], e[at * 4 + 3]);
      }
      if (isVec(obj)) {
        const lanes = laneValues(obj);
        if (at >= lanes.length) {
          throw new Error(
            `subscript ${at} out of range for a vec${lanes.length}`,
          );
        }
        return lanes[at];
      }
      throw new Error("only a matrix or a vector can be subscripted");
    }
    case "cond": {
      const test = evaluate(node.test, env);
      return test
        ? evaluate(node.consequent, env)
        : evaluate(node.alternate, env);
    }
    case "call": {
      const args = node.args.map((a) => evaluate(a, env));
      // A callable the caller bound outranks everything this module supplies,
      // so a spec that injects `vec4` to get its own 4-vector type out of a
      // shader expression keeps getting it. Only when nothing is bound under
      // the name does the built-in constructor run.
      const injected = env.__functions?.[node.name];
      if (injected !== undefined) {
        return quantize(injected(...args), env);
      }
      const size = VECTOR_ARITY[node.name];
      if (size !== undefined) {
        return quantize(constructVector(node.name, size, args), env);
      }
      const fn = BUILTINS[node.name];
      if (fn === undefined) {
        throw new Error(`unsupported call ${node.name}`);
      }
      return quantize(fn(...args), env);
    }
    case "bin": {
      const a = evaluate(node.left, env);
      const b = evaluate(node.right, env);
      switch (node.op) {
        case "<=":
          return a <= b;
        case ">=":
          return a >= b;
        case "<":
          return a < b;
        case ">":
          return a > b;
        case "==":
          return a === b;
        case "!=":
          return a !== b;
        case "&&":
          return Boolean(a) && Boolean(b);
        case "||":
          return Boolean(a) || Boolean(b);
        default:
          return quantize(arith(node.op, a, b), env);
      }
    }
    default:
      throw new Error(`unsupported node ${node.type}`);
  }
}

/**
 * Throw unless a parser expectation holds. The evaluator fails closed: a
 * construct it cannot read must surface, never be skipped.
 *
 * @param {boolean} condition The expectation.
 * @param {string} message What was expected.
 * @returns {void}
 */
function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * Extract the body text of the named WGSL function by brace matching.
 *
 * @param {string} src WGSL source.
 * @param {string} name Function name.
 * @returns {{params: string[], body: string}} Parameter names and body text.
 */
function extractFunction(src, name) {
  const header = new RegExp(`\\bfn\\s+${name}\\s*\\(`);
  const at = src.search(header);
  if (at < 0) {
    throw new Error(`function ${name} not found`);
  }
  const openParen = src.indexOf("(", at);
  let depth = 0;
  let i = openParen;
  for (; i < src.length; i += 1) {
    if (src[i] === "(") {
      depth += 1;
    } else if (src[i] === ")") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  const paramText = src.slice(openParen + 1, i);
  const params = paramText
    .split(",")
    .map((p) => p.split(":")[0].trim())
    .filter((p) => p.length > 0);
  const openBrace = src.indexOf("{", i);
  depth = 0;
  let j = openBrace;
  for (; j < src.length; j += 1) {
    if (src[j] === "{") {
      depth += 1;
    } else if (src[j] === "}") {
      depth -= 1;
      if (depth === 0) {
        break;
      }
    }
  }
  return { params, body: src.slice(openBrace + 1, j) };
}

/**
 * Compile a WGSL function into a callable JavaScript function.
 *
 * @param {string} src WGSL source with comments stripped.
 * @param {string} name Function name.
 * @param {object} globals Module-scope bindings, including `__functions`.
 * @returns {Function} The callable.
 */
function compileFunction(src, name, globals) {
  const { params, body } = extractFunction(src, name);
  return function (...args) {
    const env = Object.create(globals);
    params.forEach((p, index) => {
      env[p] = args[index];
    });
    const tokens = tokenize(body);
    let pos = 0;
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok.text === "let" || tok.text === "var") {
        const ident = tokens[pos + 1];
        expect(ident.kind === "id", "expected a binding name");
        let cursor = pos + 2;
        if (tokens[cursor]?.text === ":") {
          while (tokens[cursor].text !== "=") {
            cursor += 1;
          }
        }
        expect(tokens[cursor].text === "=", "expected an = in a binding");
        const parsed = parseExpression(tokens, cursor + 1);
        env[ident.text] = evaluate(parsed.node, env);
        expect(
          tokens[parsed.next].text === ";",
          "expected a ; after a binding",
        );
        pos = parsed.next + 1;
        continue;
      }
      if (tok.text === "return") {
        const parsed = parseExpression(tokens, pos + 1);
        return evaluate(parsed.node, env);
      }
      if (tok.text === "if") {
        expect(tokens[pos + 1].text === "(", "expected ( after if");
        const cond = parseExpression(tokens, pos + 2);
        expect(tokens[cond.next].text === ")", "expected ) after a condition");
        expect(
          tokens[cond.next + 1].text === "{",
          "expected { after a condition",
        );
        // Locate the matching close brace.
        let depth = 0;
        let k = cond.next + 1;
        for (; k < tokens.length; k += 1) {
          if (tokens[k].text === "{") {
            depth += 1;
          } else if (tokens[k].text === "}") {
            depth -= 1;
            if (depth === 0) {
              break;
            }
          }
        }
        if (evaluate(cond.node, env) === true) {
          const inner = tokens.slice(cond.next + 2, k);
          expect(
            inner[0].text === "return",
            "only a guarded return is supported",
          );
          const parsed = parseExpression(inner, 1);
          return evaluate(parsed.node, env);
        }
        pos = k + 1;
        continue;
      }
      throw new Error(`unsupported statement starting at ${tok.text}`);
    }
    throw new Error(`${name} fell through without returning`);
  };
}

/**
 * Read every module-scope `const NAME: TYPE = VALUE;` out of the WGSL.
 *
 * @param {string} src WGSL source with comments stripped.
 * @returns {object} Name to value bindings.
 */
function readConstants(src) {
  const out = {};
  const re =
    /^const\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z0-9_<>]+)\s*=\s*([^;]+);/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, name, , valueText] = m;
    const tokens = tokenize(valueText);
    out[name] = evaluate(parseExpression(tokens, 0).node, {});
  }
  return out;
}

export {
  BUILTINS,
  compileFunction,
  evaluate,
  extractFunction,
  isMat4,
  isVec,
  isVec4,
  laneCount,
  laneValues,
  mat4,
  parseExpression,
  readConstants,
  stripComments,
  tokenize,
  vec,
  vec2,
  vec4,
};
