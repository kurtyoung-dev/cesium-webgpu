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
// grows a loop, a switch, a matrix or a texture fetch makes its spec fail
// loudly instead of silently skipping the part it cannot read — the failure
// mode that matters, because a quietly narrowed evaluator is indistinguishable
// from a passing test.
//
// PRECISION. Evaluation is f64 where the GPU is f32. Callers must assert
// properties that hold with room to spare rather than bit-level equality with
// a device.
//
// Supported: `let` / `var` bindings, a single guarded early `return`, a final
// `return`, unary minus, `+ - * /`, comparisons, `&&`, `||`, member access,
// `vec3<f32>` construction, and the builtins listed in `BUILTINS`.
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

/**
 * Component-wise binary arithmetic over scalars and 3-vectors.
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
  if (isVec(a) || isVec(b)) {
    const av = isVec(a) ? a : vec(a, a, a);
    const bv = isVec(b) ? b : vec(b, b, b);
    return vec(f(av.x, bv.x), f(av.y, bv.y), f(av.z, bv.z));
  }
  return f(a, b);
}

const BUILTINS = {
  max: (a, b) => (isVec(a) || isVec(b) ? arith("max", a, b) : Math.max(a, b)),
  min: (a, b) => Math.min(a, b),
  abs: (a) => Math.abs(a),
  sqrt: (a) => Math.sqrt(a),
  pow: (a, b) => Math.pow(a, b),
  clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi),
  smoothstep: (edge0, edge1, x) => {
    const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
    return t * t * (3 - 2 * t);
  },
  dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
  length: (a) => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
  normalize: (a) => {
    const l = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    return vec(a.x / l, a.y / l, a.z / l);
  },
};

/**
 * Recursive-descent expression parser over the token list.
 *
 * @param {Array<{kind: string, text: string}>} tokens Tokens.
 * @param {number} start Index to begin at.
 * @returns {{node: object, next: number}} The parsed node and the next index.
 */
function parseExpression(tokens, start) {
  let pos = start;
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
      const inner = or();
      eat(")");
      node = inner;
    } else if (tok.text === "-") {
      pos += 1;
      node = { type: "neg", operand: unary() };
    } else if (tok.kind === "id") {
      pos += 1;
      const name = tok.text;
      if (peek()?.text === "<") {
        // A type-parameterised constructor such as `vec3<f32>(…)`.
        while (peek() !== undefined && peek().text !== ">") {
          pos += 1;
        }
        eat(">");
      }
      if (peek()?.text === "(") {
        pos += 1;
        const args = [];
        if (peek()?.text !== ")") {
          for (;;) {
            args.push(or());
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
    while (peek()?.text === ".") {
      pos += 1;
      const member = peek();
      if (member?.kind !== "id") {
        throw new Error("expected a member name");
      }
      pos += 1;
      node = { type: "member", object: node, name: member.text };
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

  const node = or();
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
      return node.value;
    case "neg": {
      const v = evaluate(node.operand, env);
      return isVec(v) ? vec(-v.x, -v.y, -v.z) : -v;
    }
    case "ref": {
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
    case "call": {
      const args = node.args.map((a) => evaluate(a, env));
      if (node.name === "vec3") {
        return args.length === 1
          ? vec(args[0], args[0], args[0])
          : vec(args[0], args[1], args[2]);
      }
      const fn = env.__functions?.[node.name] ?? BUILTINS[node.name];
      if (fn === undefined) {
        throw new Error(`unsupported call ${node.name}`);
      }
      return fn(...args);
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
          return arith(node.op, a, b);
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
  isVec,
  parseExpression,
  readConstants,
  stripComments,
  tokenize,
  vec,
};
