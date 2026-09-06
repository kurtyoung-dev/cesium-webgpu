// shader-block-interpreter.mjs — executes a narrow slice of WGSL/GLSL.
// @purpose Parses and evaluates the restricted statement grammar the collection shaders' DISABLE_DEPTH_DISTANCE blocks are written in, so a spec can run the real shader control flow browser-free.
// @status ACTIVE
//
// WHY THIS EXISTS. `collection-depth-override-law.spec.mjs` has to answer a
// question about BEHAVIOUR — "what depth value does this shader write, and
// when does it decline to write one" — for shaders it cannot run, because the
// wave forbids launching a browser and no GPU is available to a node spec.
// Asserting the source TEXT instead would certify the edit rather than the
// behaviour, and would survive an `if (false && ...)` mutant unchanged.
//
// So this module executes the block. It is deliberately NOT a WGSL
// implementation: it accepts the exact statement and expression forms those
// blocks use and THROWS on anything else, because a silently-ignored construct
// is how an interpreter starts certifying a program it is not running. The
// grammar is:
//
//   statement   := declaration | assignment | ifChain | block
//   declaration := ("let" | "var" | "float" | "bool" | "int") IDENT "=" expr ";"
//   assignment  := IDENT "=" expr ";"        (IDENT may be dotted: clipPos.z)
//   ifChain     := "if" "(" expr ")" block { "else" "if" "(" expr ")" block }
//                  [ "else" block ]
//   expr        := logical-or over "||", "&&", equality, relational, additive,
//                  multiplicative, unary "-" and "!", parenthesised groups,
//                  numeric literals, dotted identifiers, and the calls
//                  select / min / max / clamp / abs.
//
// Booleans and numbers stay distinct JS types here, matching both languages'
// refusal to coerce between them.

/**
 * Blanks line comments and preprocessor / pragma directives, which are not
 * part of the executable grammar.
 *
 * @param {string} source Block source.
 * @returns {string} Source with comment and directive lines blanked.
 */
export function stripNonCode(source) {
  return source
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("#")) {
        return "";
      }
      return line;
    })
    .join("\n");
}

const TOKEN_PATTERN =
  /\s*(?:(\d+\.\d*|\.\d+|\d+)|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)|(<=|>=|==|!=|&&|\|\||[-+*/<>=!(){},;]))/y;

/**
 * @param {string} source Source to tokenize.
 * @returns {Array<{kind: string, value: string}>} Tokens.
 */
function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    TOKEN_PATTERN.lastIndex = index;
    const match = TOKEN_PATTERN.exec(source);
    if (!match) {
      const rest = source.slice(index).trim();
      if (rest.length === 0) {
        break;
      }
      throw new Error(`unlexable input at: ${rest.slice(0, 40)}`);
    }
    index = TOKEN_PATTERN.lastIndex;
    if (match[1] !== undefined) {
      tokens.push({ kind: "number", value: match[1] });
    } else if (match[2] !== undefined) {
      tokens.push({ kind: "ident", value: match[2] });
    } else {
      tokens.push({ kind: "punct", value: match[3] });
    }
  }
  return tokens;
}

const BINARY_PRECEDENCE = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  "<=": 4,
  ">": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
};

const DECLARATORS = new Set(["let", "var", "float", "bool", "int"]);

/** A recursive-descent parser over the restricted grammar. */
class Parser {
  /** @param {Array<object>} tokens Tokens. */
  constructor(tokens) {
    this.tokens = tokens;
    this.index = 0;
  }

  /** @returns {object|undefined} The current token. */
  peek() {
    return this.tokens[this.index];
  }

  /**
   * @param {string} value Expected punctuation or keyword.
   * @returns {object} The consumed token.
   */
  expect(value) {
    const token = this.peek();
    if (!token || token.value !== value) {
      throw new Error(
        `expected "${value}", got "${token ? token.value : "<eof>"}"`,
      );
    }
    this.index += 1;
    return token;
  }

  /**
   * @param {string} value Punctuation or keyword to consume if present.
   * @returns {boolean} Whether it was consumed.
   */
  eat(value) {
    const token = this.peek();
    if (token && token.value === value) {
      this.index += 1;
      return true;
    }
    return false;
  }

  /** @returns {Array<object>} Statements until end of input. */
  parseProgram() {
    const statements = [];
    while (this.index < this.tokens.length) {
      statements.push(this.parseStatement());
    }
    return statements;
  }

  /** @returns {Array<object>} Statements of a braced block. */
  parseBlock() {
    this.expect("{");
    const statements = [];
    while (!this.eat("}")) {
      if (this.index >= this.tokens.length) {
        throw new Error("unterminated block");
      }
      statements.push(this.parseStatement());
    }
    return statements;
  }

  /** @returns {object} One statement. */
  parseStatement() {
    const token = this.peek();
    if (!token) {
      throw new Error("unexpected end of input");
    }
    if (token.value === "{") {
      return { kind: "block", body: this.parseBlock() };
    }
    if (token.value === "if") {
      this.index += 1;
      this.expect("(");
      const test = this.parseExpression(0);
      this.expect(")");
      const consequent = this.parseBlock();
      let alternate = null;
      if (this.eat("else")) {
        alternate =
          this.peek() && this.peek().value === "if"
            ? [this.parseStatement()]
            : this.parseBlock();
      }
      return { kind: "if", test, consequent, alternate };
    }
    if (token.kind === "ident" && DECLARATORS.has(token.value)) {
      // A declarator introduces a binding only when NAME "=" follows; a bare
      // identifier that happens to share the spelling is an expression.
      const name = this.tokens[this.index + 1];
      const assign = this.tokens[this.index + 2];
      if (name && name.kind === "ident" && assign && assign.value === "=") {
        this.index += 3;
        const value = this.parseExpression(0);
        this.expect(";");
        return { kind: "declare", name: name.value, value };
      }
    }
    if (token.kind === "ident") {
      const next = this.tokens[this.index + 1];
      if (next && next.value === "=") {
        this.index += 2;
        const value = this.parseExpression(0);
        this.expect(";");
        return { kind: "assign", name: token.value, value };
      }
    }
    throw new Error(
      `unsupported statement starting at "${token.value}" — this interpreter refuses constructs it does not execute`,
    );
  }

  /**
   * @param {number} minPrecedence Lowest binding power to accept.
   * @returns {object} An expression node.
   */
  parseExpression(minPrecedence) {
    let left = this.parseUnary();
    for (;;) {
      const token = this.peek();
      if (!token || token.kind !== "punct") {
        break;
      }
      const precedence = BINARY_PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) {
        break;
      }
      this.index += 1;
      const right = this.parseExpression(precedence + 1);
      left = { kind: "binary", operator: token.value, left, right };
    }
    return left;
  }

  /** @returns {object} A unary or primary expression. */
  parseUnary() {
    const token = this.peek();
    if (token && (token.value === "-" || token.value === "!")) {
      this.index += 1;
      return {
        kind: "unary",
        operator: token.value,
        argument: this.parseUnary(),
      };
    }
    return this.parsePrimary();
  }

  /** @returns {object} A primary expression. */
  parsePrimary() {
    const token = this.peek();
    if (!token) {
      throw new Error("unexpected end of expression");
    }
    if (token.value === "(") {
      this.index += 1;
      const inner = this.parseExpression(0);
      this.expect(")");
      return inner;
    }
    if (token.kind === "number") {
      this.index += 1;
      return { kind: "number", value: Number.parseFloat(token.value) };
    }
    if (token.kind === "ident") {
      this.index += 1;
      if (token.value === "true" || token.value === "false") {
        // Both languages spell their boolean literals this way, and an
        // inertness mutant (`if (false && ...)`) is written entirely out of
        // them — an interpreter that cannot read one cannot be mutated.
        return { kind: "boolean", value: token.value === "true" };
      }
      if (this.peek() && this.peek().value === "(") {
        this.index += 1;
        const args = [];
        if (!this.eat(")")) {
          for (;;) {
            args.push(this.parseExpression(0));
            if (this.eat(")")) {
              break;
            }
            this.expect(",");
          }
        }
        return { kind: "call", callee: token.value, args };
      }
      return { kind: "identifier", name: token.value };
    }
    throw new Error(`unexpected token "${token.value}" in expression`);
  }
}

/**
 * @param {object} node Expression node.
 * @param {Map<string, number|boolean>} scope Bindings.
 * @returns {number|boolean} The value.
 */
function evaluate(node, scope) {
  switch (node.kind) {
    case "number":
    case "boolean":
      return node.value;
    case "identifier": {
      if (!scope.has(node.name)) {
        throw new Error(`unbound identifier "${node.name}"`);
      }
      return scope.get(node.name);
    }
    case "unary": {
      const value = evaluate(node.argument, scope);
      return node.operator === "-" ? -value : !value;
    }
    case "binary": {
      // Both source languages short-circuit these two.
      if (node.operator === "&&") {
        return evaluate(node.left, scope) ? evaluate(node.right, scope) : false;
      }
      if (node.operator === "||") {
        return evaluate(node.left, scope) ? true : evaluate(node.right, scope);
      }
      const left = evaluate(node.left, scope);
      const right = evaluate(node.right, scope);
      switch (node.operator) {
        case "+":
          return left + right;
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case ">=":
          return left >= right;
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        default:
          throw new Error(`unsupported operator "${node.operator}"`);
      }
    }
    case "call": {
      const args = node.args.map((argument) => evaluate(argument, scope));
      switch (node.callee) {
        // WGSL orders `select` false-value first. That ordering is load-bearing
        // for the clip guard; reading it backwards would invert the guard.
        case "select":
          return args[2] ? args[1] : args[0];
        case "min":
          return Math.min(args[0], args[1]);
        case "max":
          return Math.max(args[0], args[1]);
        case "abs":
          return Math.abs(args[0]);
        case "clamp":
          return Math.min(Math.max(args[0], args[1]), args[2]);
        default:
          throw new Error(`unsupported call "${node.callee}"`);
      }
    }
    default:
      throw new Error(`unsupported expression kind "${node.kind}"`);
  }
}

/**
 * @param {Array<object>} statements Statements to run.
 * @param {Map<string, number|boolean>} scope Bindings, mutated in place.
 * @returns {void}
 */
function run(statements, scope) {
  for (const statement of statements) {
    switch (statement.kind) {
      case "declare":
      case "assign":
        scope.set(statement.name, evaluate(statement.value, scope));
        break;
      case "block":
        run(statement.body, scope);
        break;
      case "if": {
        if (evaluate(statement.test, scope)) {
          run(statement.consequent, scope);
        } else if (statement.alternate) {
          run(statement.alternate, scope);
        }
        break;
      }
      default:
        throw new Error(`unsupported statement kind "${statement.kind}"`);
    }
  }
}

/**
 * Parses a source block once so a grid sweep does not re-parse per sample.
 *
 * @param {string} source Block source, comments included.
 * @returns {Array<object>} Parsed statements.
 */
export function parseBlock(source) {
  return new Parser(tokenize(stripNonCode(source))).parseProgram();
}

/**
 * Executes a parsed block against one set of inputs.
 *
 * @param {Array<object>} statements Parsed statements.
 * @param {object} inputs Initial bindings, by dotted name.
 * @returns {object} The final bindings, by dotted name.
 */
export function executeBlock(statements, inputs) {
  const scope = new Map(Object.entries(inputs));
  run(statements, scope);
  return Object.fromEntries(scope);
}
