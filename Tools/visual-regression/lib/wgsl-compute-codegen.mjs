// wgsl-compute-codegen.mjs — types a parsed WGSL compute module and emits
// JavaScript with IEEE f32 / wrapping u32 / i32 semantics.
//
// @purpose Types the declaration tree from wgsl-compute-parser.mjs and emits one JavaScript factory per module, rounding every f32 operation through F (Math.fround, supplied by the runtime), wrapping u32/i32 arithmetic and turning barrier-reaching functions into generators.
// @status ACTIVE
//
// One of three pieces of the WGSL compute executor (see `wgsl-compute-exec.mjs`).
//
// THE EMITTED FACTORY is `(F, H, R, W) => ({ <entry>: function* (B) {...} })`:
// `F` is the f32 rounding function, `H` the runtime helpers (bounds checks,
// texture load/store, vector ops, integer division), `R` the bound resources
// and `W` the workgroup arrays. Every function that can reach a
// `workgroupBarrier()` (directly or through calls) is a generator, the barrier
// is `yield` and the call is `yield*`; other helpers stay plain functions.
//
// TYPES. Literals carry their suffix type (`1u` u32, `1i` i32, `1.0f` f32);
// unsuffixed literals are abstract and concretise to the type they meet, or to
// i32 / f32 in a declaration. Vector arithmetic is f32 only.
//
// FAIL CLOSED. Component assignment (`v.x = ...`), assignment to anything but
// a local or a workgroup-array element, unknown identifiers, calls outside the
// builtin set (`f32/u32/i32` casts, `vecN<T>`, `cos sin sqrt abs floor`,
// `select`, `textureLoad`, `textureStore`, `workgroupBarrier`), type
// mismatches, non-bool conditions, workgroup arrays of other element types,
// uniforms that are not scalar-member structs, resources outside bind group 0
// or of another texture type, and entry parameters other than the three
// invocation-id builtins all throw at generation time.

const SCALARS = new Set(["f32", "u32", "i32", "bool", "AI", "AF"]);
const isAbstract = (t) => t === "AI" || t === "AF";

function vecInfo(type) {
  const m = /^vec([234])<(f32|u32|i32|bool)>$/.exec(type);
  return m ? { n: Number(m[1]), elem: m[2] } : undefined;
}

function concretize(type) {
  return type === "AI" ? "i32" : type === "AF" ? "f32" : type;
}

function convert(code, from, to) {
  if (from === to) {
    return code;
  }
  if (from === "AI" && to === "u32") {
    return `((${code}) >>> 0)`;
  }
  if (from === "AI" && to === "i32") {
    return `((${code}) | 0)`;
  }
  if ((from === "AI" || from === "AF") && to === "f32") {
    return `F(${code})`;
  }
  if (from === "AI" && to === "AF") {
    return code;
  }
  throw new Error(`wgsl-compute-codegen: cannot convert ${from} to ${to}`);
}

function unify(a, b) {
  if (a === b) {
    return a;
  }
  if (isAbstract(a) && !isAbstract(b)) {
    return b;
  }
  if (isAbstract(b) && !isAbstract(a)) {
    return a;
  }
  if (isAbstract(a) && isAbstract(b)) {
    return "AF";
  }
  throw new Error(`wgsl-compute-codegen: type mismatch ${a} vs ${b}`);
}

function scalarOp(op, type, a, b) {
  if (type === "f32") {
    if (["+", "-", "*", "/"].includes(op)) {
      return `F(${a} ${op} ${b})`;
    }
    if (op === "%") {
      return `F(${a} % ${b})`;
    }
  } else if (type === "u32") {
    switch (op) {
      case "+":
      case "-":
        return `((${a} ${op} ${b}) >>> 0)`;
      case "*":
        return `(Math.imul(${a}, ${b}) >>> 0)`;
      case "/":
        return `H.udiv(${a}, ${b})`;
      case "%":
        return `H.umod(${a}, ${b})`;
      case "&":
      case "|":
      case "^":
        return `((${a} ${op} ${b}) >>> 0)`;
      case "<<":
        return `((${a} << (${b} & 31)) >>> 0)`;
      case ">>":
        return `(${a} >>> (${b} & 31))`;
    }
  } else if (type === "i32") {
    switch (op) {
      case "+":
      case "-":
        return `((${a} ${op} ${b}) | 0)`;
      case "*":
        return `Math.imul(${a}, ${b})`;
      case "/":
        return `H.idiv(${a}, ${b})`;
      case "%":
        return `H.imod(${a}, ${b})`;
      case "&":
      case "|":
      case "^":
        return `(${a} ${op} ${b})`;
      case "<<":
        return `(${a} << (${b} & 31))`;
      case ">>":
        return `(${a} >> (${b} & 31))`;
    }
  } else if (type === "AI" || type === "AF") {
    if (["+", "-", "*", "/", "%"].includes(op)) {
      return type === "AI" && op === "/"
        ? `Math.trunc(${a} / ${b})`
        : `(${a} ${op} ${b})`;
    }
    if (type === "AI" && ["&", "|", "^", "<<", ">>"].includes(op)) {
      return `(${a} ${op} ${b})`;
    }
  }
  throw new Error(`wgsl-compute-codegen: operator ${op} on ${type}`);
}

const SWIZZLE = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
const RESOURCE_TYPE =
  /^(texture_2d<f32>|texture_storage_2d<(rgba32float|rg32float),write>)$/;

// ───────────────────────────── code generator ─────────────────────────────

class Generator {
  constructor(decls) {
    this.structs = new Map();
    this.consts = new Map();
    this.resources = new Map();
    this.workgroup = new Map();
    this.functions = new Map();
    for (const d of decls) {
      if (d.kind === "struct") {
        this.structs.set(d.name, d);
      } else if (d.kind === "fn") {
        this.functions.set(d.name, d);
      }
    }
    this.decls = decls;
    this.barrierFns = this.findBarrierFunctions();
  }
  findBarrierFunctions() {
    const calls = new Map();
    const direct = new Set();
    const walk = (node, fn) => {
      if (node === null || typeof node !== "object") {
        return;
      }
      if (Array.isArray(node)) {
        node.forEach((n) => walk(n, fn));
        return;
      }
      if (node.kind === "call") {
        if (node.callee === "workgroupBarrier") {
          direct.add(fn);
        } else if (this.functions.has(node.callee)) {
          calls.get(fn).add(node.callee);
        }
      }
      for (const value of Object.values(node)) {
        walk(value, fn);
      }
    };
    for (const [name, fn] of this.functions) {
      calls.set(name, new Set());
      walk(fn.body, name);
    }
    const result = new Set(direct);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [name, callees] of calls) {
        if (!result.has(name) && [...callees].some((c) => result.has(c))) {
          result.add(name);
          grew = true;
        }
      }
    }
    return result;
  }
  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) {
        return this.scopes[i].get(name);
      }
    }
    return undefined;
  }
  emitModule() {
    const out = [];
    this.scopes = [new Map()];
    for (const d of this.decls) {
      if (d.kind === "const") {
        const e = this.expr(d.init);
        const type = d.type ?? e.type;
        out.push(`const C_${d.name} = ${convert(e.code, e.type, type)};`);
        this.scopes[0].set(d.name, { code: `C_${d.name}`, type });
      } else if (d.kind === "var") {
        if (d.space === "workgroup") {
          const m = /^array<(vec4<f32>|vec2<f32>|f32|u32),(\d+)>$/.exec(d.type);
          if (!m) {
            throw new Error(`wgsl-compute-codegen: workgroup type ${d.type}`);
          }
          this.workgroup.set(d.name, {
            elem: m[1],
            length: Number(m[2]),
            lanes: vecInfo(m[1])?.n,
          });
          this.scopes[0].set(d.name, {
            code: `W.${d.name}`,
            type: `array:${m[1]}:${m[2]}`,
          });
        } else if (d.space === "uniform") {
          if (!this.structs.has(d.type)) {
            throw new Error(`wgsl-compute-codegen: uniform type ${d.type}`);
          }
          this.resources.set(Number(d.attrs.binding[0]), {
            name: d.name,
            kind: "uniform",
            struct: this.structs.get(d.type),
          });
          this.scopes[0].set(d.name, {
            code: `R.${d.name}`,
            type: `struct:${d.type}`,
          });
        } else if (d.space === "private" && RESOURCE_TYPE.test(d.type)) {
          if (d.attrs.group?.[0] !== "0") {
            throw new Error("wgsl-compute-codegen: only bind group 0");
          }
          const storage = d.type.startsWith("texture_storage");
          this.resources.set(Number(d.attrs.binding[0]), {
            name: d.name,
            kind: storage ? "storage" : "sampled",
            format: storage ? RESOURCE_TYPE.exec(d.type)[2] : undefined,
          });
          this.scopes[0].set(d.name, {
            code: `R.${d.name}`,
            type: storage ? "storageTexture" : "texture",
          });
        } else {
          throw new Error(
            `wgsl-compute-codegen: unsupported module var ${d.name}: ${d.type}`,
          );
        }
      }
    }
    for (const fn of this.functions.values()) {
      this.scopes[0].set(fn.name, { code: `f_${fn.name}`, type: "fn" });
    }
    const entries = [];
    for (const fn of this.functions.values()) {
      out.push(this.emitFunction(fn));
      if (fn.attrs.compute) {
        entries.push(fn.name);
      }
    }
    out.push(`return { ${entries.map((n) => `${n}: f_${n}`).join(", ")} };`);
    return out.join("\n");
  }
  emitFunction(fn) {
    const isEntry = fn.attrs.compute !== undefined;
    const gen = isEntry || this.barrierFns.has(fn.name);
    this.scopes.push(new Map());
    this.returnType = fn.ret;
    const params = fn.params.map((p, i) => {
      if (isEntry) {
        const builtin = p.attrs.builtin?.[0];
        if (
          ![
            "local_invocation_id",
            "workgroup_id",
            "global_invocation_id",
          ].includes(builtin) ||
          p.type !== "vec3<u32>"
        ) {
          throw new Error(`wgsl-compute-codegen: entry parameter ${p.name}`);
        }
      }
      this.scopes.at(-1).set(p.name, { code: `p${i}_${p.name}`, type: p.type });
      return isEntry ? p.attrs.builtin[0] : `p${i}_${p.name}`;
    });
    const body = this.block(fn.body, gen);
    this.scopes.pop();
    const signature = isEntry ? "B" : params.join(", ");
    const prologue = isEntry
      ? fn.params
          .map((p, i) => `const p${i}_${p.name} = B.${params[i]};`)
          .join(" ")
      : "";
    return `function${gen ? "*" : ""} f_${fn.name}(${signature}) { ${prologue}\n${body}\n}`;
  }
  block(statements, gen) {
    this.scopes.push(new Map());
    const code = statements.map((s) => this.statement(s, gen)).join("\n");
    this.scopes.pop();
    return code;
  }
  declare(name, type, code) {
    const js = `v_${name}_${this.scopes.length}`;
    this.scopes.at(-1).set(name, { code: js, type });
    return js;
  }
  statement(s, gen) {
    switch (s.kind) {
      case "let":
      case "var": {
        let type = s.type;
        let init;
        if (s.init !== undefined) {
          const e = this.expr(s.init, gen);
          type = type ?? concretize(e.type);
          init = convert(e.code, e.type, type);
        } else {
          init = this.zero(type);
        }
        const js = this.declare(s.name, type);
        return `${s.kind === "let" ? "const" : "let"} ${js} = ${init};`;
      }
      case "assign": {
        const value = this.expr(s.value, gen);
        if (s.target.kind === "id") {
          const v = this.lookup(s.target.name);
          if (!v || !v.code.startsWith("v_")) {
            throw new Error(
              `wgsl-compute-codegen: assignment to ${s.target.name}`,
            );
          }
          return `${v.code} = ${convert(value.code, value.type, v.type)};`;
        }
        if (s.target.kind === "index") {
          const arr = this.expr(s.target.object, gen);
          const m = /^array:(.+):(\d+)$/.exec(arr.type);
          if (!m) {
            throw new Error("wgsl-compute-codegen: indexed assignment target");
          }
          const index = this.expr(s.target.index, gen);
          return `${arr.code}[H.chk(${index.code}, ${m[2]})] = ${convert(value.code, value.type, m[1])};`;
        }
        throw new Error("wgsl-compute-codegen: component assignment");
      }
      case "exprStmt":
        return `${this.expr(s.expr, gen).code};`;
      case "if": {
        const cond = this.expr(s.cond, gen);
        if (cond.type !== "bool") {
          throw new Error("wgsl-compute-codegen: if condition must be bool");
        }
        const otherwise =
          s.otherwise === undefined
            ? ""
            : ` else {\n${this.block(s.otherwise, gen)}\n}`;
        return `if (${cond.code}) {\n${this.block(s.then, gen)}\n}${otherwise}`;
      }
      case "for": {
        this.scopes.push(new Map());
        const init = this.statement(s.init, gen);
        const cond = this.expr(s.cond, gen);
        const update = this.statement(s.update, gen).replace(/;$/, "");
        const body = this.block(s.body, gen);
        this.scopes.pop();
        return `for (${init} ${cond.code}; ${update}) {\n${body}\n}`;
      }
      case "return": {
        if (s.value === undefined) {
          return "return;";
        }
        const e = this.expr(s.value, gen);
        return `return ${convert(e.code, e.type, this.returnType)};`;
      }
      case "block":
        return `{\n${this.block(s.body, gen)}\n}`;
    }
    throw new Error(`wgsl-compute-codegen: statement ${s.kind}`);
  }
  zero(type) {
    const v = vecInfo(type);
    if (v) {
      return `[${new Array(v.n).fill(v.elem === "bool" ? "false" : "0").join(", ")}]`;
    }
    if (type === "bool") {
      return "false";
    }
    if (SCALARS.has(type)) {
      return "0";
    }
    throw new Error(`wgsl-compute-codegen: zero value of ${type}`);
  }
  expr(e, gen) {
    switch (e.kind) {
      case "num": {
        const t = e.text;
        if (t.endsWith("u")) {
          return { code: String(Number(t.slice(0, -1)) >>> 0), type: "u32" };
        }
        if (t.endsWith("i")) {
          return { code: String(Number(t.slice(0, -1)) | 0), type: "i32" };
        }
        if (t.endsWith("f")) {
          return { code: `F(${t.slice(0, -1)})`, type: "f32" };
        }
        return /[.eE]/.test(t)
          ? { code: `(${t})`, type: "AF" }
          : { code: t, type: "AI" };
      }
      case "bool":
        return { code: String(e.value), type: "bool" };
      case "id": {
        const v = this.lookup(e.name);
        if (!v) {
          throw new Error(`wgsl-compute-codegen: unknown identifier ${e.name}`);
        }
        return v;
      }
      case "un": {
        const a = this.expr(e.arg, gen);
        if (e.op === "!") {
          if (a.type !== "bool") {
            throw new Error("wgsl-compute-codegen: ! on non-bool");
          }
          return { code: `(!${a.code})`, type: "bool" };
        }
        if (e.op === "~") {
          if (a.type === "u32") {
            return { code: `((~${a.code}) >>> 0)`, type: "u32" };
          }
          if (a.type === "i32" || a.type === "AI") {
            return { code: `(~${a.code})`, type: a.type };
          }
          throw new Error(`wgsl-compute-codegen: ~ on ${a.type}`);
        }
        const v = vecInfo(a.type);
        if (v && v.elem === "f32") {
          return { code: `H.vneg(${a.code})`, type: a.type };
        }
        if (a.type === "f32" || a.type === "AF" || a.type === "AI") {
          return { code: `(-${a.code})`, type: a.type };
        }
        if (a.type === "i32") {
          return { code: `((-${a.code}) | 0)`, type: "i32" };
        }
        throw new Error(`wgsl-compute-codegen: unary minus on ${a.type}`);
      }
      case "bin":
        return this.binary(e, gen);
      case "member": {
        const o = this.expr(e.object, gen);
        if (o.type.startsWith("struct:")) {
          const struct = this.structs.get(o.type.slice(7));
          const member = struct.members.find((m) => m.name === e.name);
          if (!member) {
            throw new Error(`wgsl-compute-codegen: no member ${e.name}`);
          }
          return { code: `${o.code}.${e.name}`, type: member.type };
        }
        const v = vecInfo(o.type);
        if (!v || !/^[xyzw]{1,4}$|^[rgba]{1,4}$/.test(e.name)) {
          throw new Error(
            `wgsl-compute-codegen: member .${e.name} of ${o.type}`,
          );
        }
        const lanes = [...e.name].map((c) => {
          const lane = SWIZZLE[c];
          if (lane >= v.n) {
            throw new Error(
              `wgsl-compute-codegen: swizzle .${e.name} out of range`,
            );
          }
          return lane;
        });
        if (lanes.length === 1) {
          return { code: `${o.code}[${lanes[0]}]`, type: v.elem };
        }
        return {
          code: `H.swz(${o.code}, [${lanes.join(", ")}])`,
          type: `vec${lanes.length}<${v.elem}>`,
        };
      }
      case "index": {
        const o = this.expr(e.object, gen);
        const index = this.expr(e.index, gen);
        if (!["u32", "i32", "AI"].includes(index.type)) {
          throw new Error("wgsl-compute-codegen: non-integer index");
        }
        const m = /^array:(.+):(\d+)$/.exec(o.type);
        if (m) {
          return {
            code: `${o.code}[H.chk(${index.code}, ${m[2]})]`,
            type: m[1],
          };
        }
        const v = vecInfo(o.type);
        if (v) {
          return {
            code: `${o.code}[H.chk(${index.code}, ${v.n})]`,
            type: v.elem,
          };
        }
        throw new Error(`wgsl-compute-codegen: indexing ${o.type}`);
      }
      case "call":
        return this.call(e, gen);
    }
    throw new Error(`wgsl-compute-codegen: expression ${e.kind}`);
  }
  binary(e, gen) {
    const a = this.expr(e.left, gen);
    const b = this.expr(e.right, gen);
    const op = e.op;
    if (op === "&&" || op === "||") {
      if (a.type !== "bool" || b.type !== "bool") {
        throw new Error(`wgsl-compute-codegen: ${op} on non-bool`);
      }
      return { code: `(${a.code} ${op} ${b.code})`, type: "bool" };
    }
    const va = vecInfo(a.type);
    const vb = vecInfo(b.type);
    if (va || vb) {
      if (!["+", "-", "*", "/"].includes(op)) {
        throw new Error(`wgsl-compute-codegen: vector operator ${op}`);
      }
      const v = va ?? vb;
      if (v.elem !== "f32" || (va && vb && a.type !== b.type)) {
        throw new Error(
          `wgsl-compute-codegen: vector ${a.type} ${op} ${b.type}`,
        );
      }
      const ac = va ? a.code : convert(a.code, a.type, "f32");
      const bc = vb ? b.code : convert(b.code, b.type, "f32");
      const shape = `${va ? "v" : "s"}${vb ? "v" : "s"}`;
      return {
        code: `H.vop(${JSON.stringify(op)}, "${shape}", ${ac}, ${bc})`,
        type: va ? a.type : b.type,
      };
    }
    if (op === "<<" || op === ">>") {
      const left = concretize(a.type) === a.type ? a.type : a.type;
      const shift = convert(b.code, b.type, b.type === "AI" ? "u32" : b.type);
      return { code: scalarOp(op, left, a.code, shift), type: left };
    }
    const type = unify(a.type, b.type);
    const ac = convert(a.code, a.type, type);
    const bc = convert(b.code, b.type, type);
    if (["==", "!=", "<", ">", "<=", ">="].includes(op)) {
      const jsOp = op === "==" ? "===" : op === "!=" ? "!==" : op;
      return { code: `(${ac} ${jsOp} ${bc})`, type: "bool" };
    }
    return { code: scalarOp(op, type, ac, bc), type };
  }
  call(e, gen) {
    const args = () => e.args.map((a) => this.expr(a, gen));
    const v = vecInfo(e.callee);
    if (v) {
      const parts = args();
      const lanes = [];
      for (const p of parts) {
        const pv = vecInfo(p.type);
        if (pv) {
          if (pv.elem !== v.elem) {
            throw new Error(`wgsl-compute-codegen: ${e.callee} from ${p.type}`);
          }
          lanes.push(`...${p.code}`);
        } else {
          lanes.push(convert(p.code, p.type, v.elem));
        }
      }
      if (parts.length === 1 && !vecInfo(parts[0].type)) {
        return {
          code: `new Array(${v.n}).fill(${lanes[0]})`,
          type: e.callee,
        };
      }
      return { code: `H.vlen([${lanes.join(", ")}], ${v.n})`, type: e.callee };
    }
    switch (e.callee) {
      case "f32":
      case "u32":
      case "i32": {
        const [a] = args();
        return { code: this.cast(a, e.callee), type: e.callee };
      }
      case "cos":
      case "sin":
      case "sqrt":
      case "abs":
      case "floor": {
        const [a] = args();
        if (concretize(a.type) !== "f32") {
          throw new Error(`wgsl-compute-codegen: ${e.callee} on ${a.type}`);
        }
        return {
          code: `F(Math.${e.callee}(${convert(a.code, a.type, "f32")}))`,
          type: "f32",
        };
      }
      case "select": {
        const [f, t, c] = args();
        if (c.type !== "bool") {
          throw new Error("wgsl-compute-codegen: select condition");
        }
        const type = unify(f.type, t.type);
        return {
          code: `(${c.code} ? ${convert(t.code, t.type, type)} : ${convert(f.code, f.type, type)})`,
          type,
        };
      }
      case "workgroupBarrier":
        if (!gen) {
          throw new Error("wgsl-compute-codegen: barrier outside a generator");
        }
        return { code: "(yield 0)", type: "void" };
      case "textureLoad": {
        const [tex, coord, level] = args();
        if (tex.type !== "texture" || coord.type !== "vec2<i32>") {
          throw new Error("wgsl-compute-codegen: textureLoad signature");
        }
        return {
          code: `H.tload(${tex.code}, ${coord.code}, ${level.code})`,
          type: "vec4<f32>",
        };
      }
      case "textureStore": {
        const [tex, coord, value] = args();
        if (
          tex.type !== "storageTexture" ||
          coord.type !== "vec2<i32>" ||
          value.type !== "vec4<f32>"
        ) {
          throw new Error("wgsl-compute-codegen: textureStore signature");
        }
        return {
          code: `H.tstore(${tex.code}, ${coord.code}, ${value.code})`,
          type: "void",
        };
      }
    }
    const fn = this.functions.get(e.callee);
    if (!fn) {
      throw new Error(`wgsl-compute-codegen: unsupported call ${e.callee}`);
    }
    if (fn.attrs.compute) {
      throw new Error("wgsl-compute-codegen: calling an entry point");
    }
    const parts = args();
    if (parts.length !== fn.params.length) {
      throw new Error(`wgsl-compute-codegen: arity of ${e.callee}`);
    }
    const code = `f_${e.callee}(${parts.map((p, i) => convert(p.code, p.type, fn.params[i].type)).join(", ")})`;
    if (this.barrierFns.has(e.callee)) {
      if (!gen) {
        throw new Error(
          "wgsl-compute-codegen: barrier call outside a generator",
        );
      }
      return { code: `(yield* ${code})`, type: fn.ret };
    }
    return { code, type: fn.ret };
  }
  cast(a, to) {
    const from = a.type;
    if (from === to) {
      return a.code;
    }
    if (isAbstract(from)) {
      if (to === "f32") {
        return `F(${a.code})`;
      }
      return to === "u32" ? `((${a.code}) >>> 0)` : `((${a.code}) | 0)`;
    }
    if (to === "f32" && (from === "u32" || from === "i32")) {
      return `F(${a.code})`;
    }
    if (to === "u32" && from === "f32") {
      return `H.f2u(${a.code})`;
    }
    if (to === "i32" && from === "f32") {
      return `H.f2i(${a.code})`;
    }
    if (to === "u32" && from === "i32") {
      return `((${a.code}) >>> 0)`;
    }
    if (to === "i32" && from === "u32") {
      return `((${a.code}) | 0)`;
    }
    throw new Error(`wgsl-compute-codegen: cast ${from} to ${to}`);
  }
}

/**
 * Generate the JavaScript for a parsed module.
 *
 * @param {object[]} decls The tree from `parseComputeModule`.
 * @returns {{javascript: string, functions: Map<string, object>, resources: Map<number, object>, workgroup: Map<string, {elem: string, length: number, lanes: number|undefined}>}}
 *   The factory body and the module's interface.
 */
export function generateComputeModule(decls) {
  const generator = new Generator(decls);
  const javascript = generator.emitModule();
  return {
    javascript,
    functions: generator.functions,
    resources: generator.resources,
    workgroup: generator.workgroup,
  };
}
