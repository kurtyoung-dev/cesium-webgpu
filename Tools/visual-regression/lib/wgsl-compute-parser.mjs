// wgsl-compute-parser.mjs — tokenizes and parses the compute subset of WGSL
// into a declaration tree for `wgsl-compute-codegen.mjs`.
//
// @purpose Tokenizes and parses the compute subset of WGSL (structs, consts, module vars, functions, let/var, assignment, if/else, for, return, expressions with templates) into a plain declaration tree, throwing on every construct outside that subset.
// @status ACTIVE
//
// One of three pieces of the WGSL compute executor: this parser, the code
// generator (`wgsl-compute-codegen.mjs`) and the runtime that compiles and
// dispatches (`wgsl-compute-exec.mjs`, which documents the whole).
//
// FAIL CLOSED. `while`, `loop`, `switch`, `break`, `continue`, `discard`,
// pointers (`&x`, `*p`), module-scope `var` initialisers, `let` without an
// initialiser and any declaration other than struct/const/var/fn throw here
// with a message naming the construct. Types are kept as normalised text
// (`array<vec4<f32>,256>`), and a `>>` closing two template lists is split.
// The tree is untyped; the code generator owns every type rule.

const TOKEN =
  /\s*(?:(\/\/[^\n]*)|(\d+\.\d*(?:[eE][-+]?\d+)?f?|\.\d+(?:[eE][-+]?\d+)?f?|\d+[eE][-+]?\d+f?|\d+[uif]?)|([A-Za-z_][A-Za-z0-9_]*)|(->|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^~!<>=(){}[\],;:.@]))/y;

function tokenize(source) {
  const tokens = [];
  TOKEN.lastIndex = 0;
  let index = 0;
  while (index < source.length) {
    TOKEN.lastIndex = index;
    const m = TOKEN.exec(source);
    if (m === null) {
      if (/^\s*$/.test(source.slice(index))) {
        break;
      }
      throw new Error(`wgsl-compute-parser: cannot tokenize at ${index}`);
    }
    index = TOKEN.lastIndex;
    if (m[1] !== undefined) {
      continue;
    }
    if (m[2] !== undefined) {
      tokens.push({ kind: "num", text: m[2] });
    } else if (m[3] !== undefined) {
      tokens.push({ kind: "id", text: m[3] });
    } else if (m[4] !== undefined) {
      tokens.push({ kind: "op", text: m[4] });
    }
  }
  tokens.push({ kind: "eof", text: "<eof>" });
  return tokens;
}

function stripBlockComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\r\n/g, "\n");
}

// ─────────────────────────────── parser ───────────────────────────────

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(offset = 0) {
    return this.tokens[this.pos + offset];
  }
  next() {
    return this.tokens[this.pos++];
  }
  is(text) {
    return this.peek().text === text;
  }
  eat(text) {
    if (this.is(text)) {
      this.pos++;
      return true;
    }
    return false;
  }
  expect(text) {
    const t = this.next();
    if (t.text !== text) {
      throw new Error(
        `wgsl-compute-parser: expected '${text}', got '${t.text}'`,
      );
    }
    return t;
  }
  ident() {
    const t = this.next();
    if (t.kind !== "id") {
      throw new Error(
        `wgsl-compute-parser: expected identifier, got '${t.text}'`,
      );
    }
    return t.text;
  }
  // Closes a template list; splits a `>>` token into two `>`.
  closeTemplate() {
    const t = this.peek();
    if (t.text === ">>") {
      t.text = ">";
      return;
    }
    this.expect(">");
  }
  type() {
    const name = this.ident();
    if (!this.is("<")) {
      return name;
    }
    this.next();
    const args = [];
    for (;;) {
      if (this.peek().kind === "num") {
        args.push(this.next().text.replace(/[ui]$/, ""));
      } else {
        args.push(this.type());
      }
      if (!this.eat(",")) {
        break;
      }
    }
    this.closeTemplate();
    return `${name}<${args.join(",")}>`;
  }
  attributes() {
    const attrs = {};
    while (this.eat("@")) {
      const name = this.ident();
      const args = [];
      if (this.eat("(")) {
        while (!this.is(")")) {
          args.push(this.next().text);
          this.eat(",");
        }
        this.expect(")");
      }
      attrs[name] = args;
    }
    return attrs;
  }
  module() {
    const decls = [];
    while (this.peek().kind !== "eof") {
      const attrs = this.attributes();
      const kw = this.ident();
      if (kw === "struct") {
        const name = this.ident();
        this.expect("{");
        const members = [];
        while (!this.eat("}")) {
          this.attributes();
          const member = this.ident();
          this.expect(":");
          members.push({ name: member, type: this.type() });
          this.eat(",");
        }
        this.eat(";");
        decls.push({ kind: "struct", name, members });
      } else if (kw === "const") {
        const name = this.ident();
        const type = this.eat(":") ? this.type() : undefined;
        this.expect("=");
        const init = this.expr();
        this.expect(";");
        decls.push({ kind: "const", name, type, init });
      } else if (kw === "var") {
        let space = "private";
        if (this.eat("<")) {
          space = this.ident();
          if (this.eat(",")) {
            this.ident();
          }
          this.closeTemplate();
        }
        const name = this.ident();
        this.expect(":");
        const type = this.type();
        if (this.is("=")) {
          throw new Error("wgsl-compute-parser: module var initialisers");
        }
        this.expect(";");
        decls.push({ kind: "var", space, name, type, attrs });
      } else if (kw === "fn") {
        const name = this.ident();
        this.expect("(");
        const params = [];
        while (!this.eat(")")) {
          const pattrs = this.attributes();
          const pname = this.ident();
          this.expect(":");
          params.push({ name: pname, type: this.type(), attrs: pattrs });
          this.eat(",");
        }
        const ret = this.eat("->") ? (this.attributes(), this.type()) : "void";
        decls.push({
          kind: "fn",
          name,
          params,
          ret,
          attrs,
          body: this.block(),
        });
      } else {
        throw new Error(`wgsl-compute-parser: unsupported declaration '${kw}'`);
      }
    }
    return decls;
  }
  block() {
    this.expect("{");
    const body = [];
    while (!this.eat("}")) {
      body.push(this.statement());
    }
    return body;
  }
  simpleStatement() {
    const t = this.peek();
    if (t.text === "let" || t.text === "var") {
      this.next();
      const name = this.ident();
      const type = this.eat(":") ? this.type() : undefined;
      const init = this.eat("=") ? this.expr() : undefined;
      if (t.text === "let" && init === undefined) {
        throw new Error("wgsl-compute-parser: let without initialiser");
      }
      return { kind: t.text, name, type, init };
    }
    const target = this.expr();
    if (this.eat("=")) {
      return { kind: "assign", target, value: this.expr() };
    }
    if (target.kind !== "call") {
      throw new Error(
        `wgsl-compute-parser: unsupported statement at '${this.peek().text}'`,
      );
    }
    return { kind: "exprStmt", expr: target };
  }
  statement() {
    const t = this.peek();
    if (t.text === "{") {
      return { kind: "block", body: this.block() };
    }
    if (t.text === "if") {
      this.next();
      const cond = this.expr();
      const then = this.block();
      let otherwise;
      if (this.eat("else")) {
        otherwise = this.is("if") ? [this.statement()] : this.block();
      }
      return { kind: "if", cond, then, otherwise };
    }
    if (t.text === "for") {
      this.next();
      this.expect("(");
      const init = this.simpleStatement();
      this.expect(";");
      const cond = this.expr();
      this.expect(";");
      const update = this.simpleStatement();
      this.expect(")");
      return { kind: "for", init, cond, update, body: this.block() };
    }
    if (t.text === "return") {
      this.next();
      const value = this.is(";") ? undefined : this.expr();
      this.expect(";");
      return { kind: "return", value };
    }
    if (
      ["while", "loop", "switch", "break", "continue", "discard"].includes(
        t.text,
      )
    ) {
      throw new Error(`wgsl-compute-parser: unsupported statement '${t.text}'`);
    }
    const s = this.simpleStatement();
    this.expect(";");
    return s;
  }
  expr() {
    return this.binary(0);
  }
  binary(level) {
    const LEVELS = [
      ["||"],
      ["&&"],
      ["|"],
      ["^"],
      ["&"],
      ["==", "!="],
      ["<", ">", "<=", ">="],
      ["<<", ">>"],
      ["+", "-"],
      ["*", "/", "%"],
    ];
    if (level === LEVELS.length) {
      return this.unary();
    }
    let left = this.binary(level + 1);
    while (LEVELS[level].includes(this.peek().text)) {
      const op = this.next().text;
      left = { kind: "bin", op, left, right: this.binary(level + 1) };
    }
    return left;
  }
  unary() {
    const t = this.peek();
    if (t.text === "-" || t.text === "!" || t.text === "~") {
      this.next();
      return { kind: "un", op: t.text, arg: this.unary() };
    }
    if (t.text === "&" || t.text === "*") {
      throw new Error("wgsl-compute-parser: pointers are unsupported");
    }
    return this.postfix(this.primary());
  }
  primary() {
    const t = this.next();
    if (t.kind === "num") {
      return { kind: "num", text: t.text };
    }
    if (t.text === "(") {
      const e = this.expr();
      this.expect(")");
      return e;
    }
    if (t.text === "true" || t.text === "false") {
      return { kind: "bool", value: t.text === "true" };
    }
    if (t.kind !== "id") {
      throw new Error(`wgsl-compute-parser: unexpected '${t.text}'`);
    }
    let callee = t.text;
    if (/^(vec[234]|array|mat\d x\d)$/.test(callee) && this.is("<")) {
      this.pos--;
      callee = this.type();
    }
    if (this.eat("(")) {
      const args = [];
      while (!this.eat(")")) {
        args.push(this.expr());
        this.eat(",");
      }
      return { kind: "call", callee, args };
    }
    return { kind: "id", name: callee };
  }
  postfix(e) {
    for (;;) {
      if (this.eat(".")) {
        e = { kind: "member", object: e, name: this.ident() };
      } else if (this.eat("[")) {
        const index = this.expr();
        this.expect("]");
        e = { kind: "index", object: e, index };
      } else {
        return e;
      }
    }
  }
}

/**
 * Parse a WGSL compute module.
 *
 * @param {string} source WGSL text.
 * @returns {object[]} Declarations: `{ kind: "struct" | "const" | "var" | "fn", ... }`.
 */
export function parseComputeModule(source) {
  return new Parser(tokenize(stripBlockComments(source))).module();
}
