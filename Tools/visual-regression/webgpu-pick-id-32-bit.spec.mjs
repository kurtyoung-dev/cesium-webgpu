// webgpu-pick-id-32-bit.spec.mjs — the pick key is 32 bits at every site that
// encodes or decodes it. Pure Node: no browser, no GPU, no built bundle.
//
// @purpose AR-751: pins that PickId's WebGPU encoding, GraphicsContext's
//   byte-object decode branch and FeatureIdResolve.wgsl's GPU decode all carry
//   the pick key's FULL 32 bits, so two ids differing only above bit 23 stay
//   distinct and an id that is a multiple of 2^24 is not read back as 0.
// @status ACTIVE
//
// ── WHAT THE DEFECT WAS ─────────────────────────────────────────────────────
//
// `GraphicsContext#createPickId` allocates a monotonic uint32 key and packs it
// into `Color.fromRgba(key)` — four little-endian bytes, alpha being the key's
// HIGH byte, not an opacity. Every WebGPU pick producer writes all four
// channels (`WebGPUComputeInstanceRenderer.ts` says so in as many words:
// "Forcing alpha to 1.0 would corrupt the decoded key"), the pick pass clears
// to (0,0,0,0), and `WebGPUPickFramebuffer` has always rebuilt the key with
// `Color.bytesToRgba(r, g, b, a)` — 32 bits, all along. (Most pick pipelines
// declare `targets: [{ format }]`, blend-stripped, so the four bytes land
// byte-exact; two do not — see NEW-WEBGPU-PICK-TARGET-BLEND in DEFERRED_WORK.)
//
// Three sites disagreed with that decoder:
//
//   1. `PickId.normalizedRgba` wrote alpha as the constant 1.0, so its encoding
//      of key K read back as `K | 0xff000000`.
//   2. `GraphicsContext#_pickColorToKey`'s byte-object branch composed only
//      `red | green<<8 | blue<<16`, truncating every key to 24 bits.
//   3. `FeatureIdResolve.wgsl`'s `decodeFeatureId` read r, g, b only, so the
//      feature-id recolor pass aliased ids that differ only above bit 23 and
//      resolved every multiple of 2^24 to id 0, which it paints as background.
//
// ── WHAT THIS SPEC ASSERTS, AND HOW IT AVOIDS CERTIFYING ITSELF ─────────────
//
// The observable is a ROUND TRIP: a key allocated by the real allocator, encoded
// the way a real producer encodes it, decoded the way each real decoder decodes
// it, must come back as the same key and resolve to the same registered object.
//
//   * The key never comes from this file. `GraphicsContext#_nextPickColor` is
//     the real allocator and is advanced through its own Uint32Array so the
//     NEXT `createPickId` lands on the key under test — the allocation path a
//     long-lived session reaches by counting. Nothing hand-builds a `PickId`.
//   * The encoding never comes from this file either. Bytes are taken from the
//     `PickId` the allocator produced, quantised the way an rgba8unorm colour
//     attachment quantises a float fragment output (`Math.round(x * 255)`).
//   * The engine modules are the REAL ones, bundled by esbuild with its own
//     default resolution over `packages/engine/Source` — no stubs, no copies —
//     so an on-disk inertness mutant in either JS/TS site is what this spec
//     executes.
//   * The WGSL decode is EXECUTED, not grepped. Node has no WGSL evaluator (see
//     the note below), so the shader's own `decodeFeatureId` return expressions
//     are lifted out of the real `.wgsl` file and translated by a TOTAL
//     tokeniser that throws on any token it does not recognise. The arithmetic
//     that runs is the shader's arithmetic, and a shader this translator cannot
//     read fails loudly rather than passing silently.
//
// ── THE WGSL LEG'S LIMIT, STATED ────────────────────────────────────────────
//
// This repository has no WGSL execution path in Node (`WebGPUNagaTranspiler` /
// `WebGPUShaderTranslator` translate shader source, they do not evaluate it,
// and there is no Dawn/naga binding in the tree). The GPU-side proof of the
// same claim is the Edge probe `probe-feature-id-texture.mjs`, whose
// `bit24-alias` and `multiple-of-2^24` scenes are the behavioural leg; the
// translation below is the browser-free approximation of it, and the D-group
// agreement guard is the structural backstop that keeps the three sites from
// drifting apart again.
//
// Run: node --test Tools/visual-regression/webgpu-pick-id-32-bit.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import {
  KEY_SPAN_PLAN,
  buildKeySpanCell,
  differsOnlyAboveBit23,
  expectedRecolor,
} from "./probe-feature-id-texture.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(directory, "../..");
const engineSource = resolve(repoRoot, "packages/engine/Source");
const GRAPHICS_CONTEXT_PATH = resolve(
  engineSource,
  "Renderer/GraphicsContext.ts",
);
const FEATURE_ID_RESOLVE_PATH = resolve(
  engineSource,
  "Shaders/WebGPU/PostProcess/FeatureIdResolve.wgsl",
);

/**
 * Reads a source file and normalises its line terminators, so anchors match
 * regardless of the checkout's autocrlf setting.
 *
 * @param {string} path Absolute path to read.
 * @returns {Promise<string>} LF-normalised source.
 */
async function readSource(path) {
  return (await readFile(path, "utf8")).split("\r\n").join("\n");
}

// ── The real engine modules ─────────────────────────────────────────────────

const BARREL_SOURCE = [
  'export { GraphicsContext } from "./GraphicsContext.js";',
  'export { default as PickId } from "./PickId.js";',
  'export { default as Color } from "../Core/Color.js";',
  // Group E drives the probe's staging plan through the REAL primitive that
  // allocates a pick id in the field, rather than through a model of it.
  'export { default as PointPrimitiveCollection } from "../Scene/PointPrimitiveCollection.js";',
  'export { default as Cartesian3 } from "../Core/Cartesian3.js";',
].join("\n");

const bundled = await build({
  stdin: {
    contents: BARREL_SOURCE,
    resolveDir: dirname(GRAPHICS_CONTEXT_PATH),
    sourcefile: "ar751-barrel.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  logLevel: "silent",
  absWorkingDir: repoRoot,
});
const { GraphicsContext, PickId, Color, PointPrimitiveCollection, Cartesian3 } =
  await import(
    `data:text/javascript;base64,${Buffer.from(
      bundled.outputFiles[0].text,
    ).toString("base64")}`
  );

/**
 * The smallest concrete `GraphicsContext` there can be. `GraphicsContext`'s own
 * constructor body is empty and registration (which is what verifies the
 * abstract surface) is deferred to `_registerWithRegistry()`, which a subclass
 * calls when it is ready — so this subclass inherits the REAL `_pickObjects`,
 * `_pickKinds` and `_nextPickColor` field initialisers and the REAL
 * `createPickId` / `getObjectByPickColor` without needing a GL or GPU device.
 * No pick behaviour is overridden here.
 */
class SpecContext extends GraphicsContext {}

/**
 * Allocates the NEXT pick id through the real allocator, positioned so that it
 * lands exactly on `key`. The allocator is `_nextPickColor`, a Uint32Array that
 * `createPickId` pre-increments; seeding it with `key - 1` is the same state a
 * session reaches by allocating `key - 1` ids, which is how a key above 2^24 is
 * reached in the field.
 *
 * @param {object} context The spec context.
 * @param {number} key The key the next allocation must produce.
 * @param {object} target The object to register.
 * @returns {object} The real `PickId`.
 */
function allocatePickIdAt(context, key, target) {
  context._nextPickColor[0] = key - 1;
  const pickId = context.createPickId(target);
  assert.equal(
    pickId.key >>> 0,
    key >>> 0,
    `the allocator did not produce 0x${key.toString(16)}`,
  );
  assert.ok(pickId instanceof PickId, "createPickId returned a foreign object");
  return pickId;
}

/**
 * Quantises a normalized float fragment output the way an rgba8unorm colour
 * attachment does, which is what the pick target is.
 *
 * @param {Float32Array} normalizedRgba The producer's fragment output.
 * @returns {{red: number, green: number, blue: number, alpha: number}} Bytes.
 */
function rasterize(normalizedRgba) {
  return {
    red: Math.round(normalizedRgba[0] * 255),
    green: Math.round(normalizedRgba[1] * 255),
    blue: Math.round(normalizedRgba[2] * 255),
    alpha: Math.round(normalizedRgba[3] * 255),
  };
}

// The key set. Every entry is reachable by counting from 1; the point of the
// set is that four of them are indistinguishable from another entry under a
// 24-bit decode.
const KEYS = {
  // The queue row's named round trip.
  named: 0x01020304,
  // A pair differing ONLY above bit 23 — a 24-bit decode aliases them.
  lowOfPair: 0x00000101,
  highOfPair: 0x01000101,
  // A multiple of 2^24: a 24-bit decode reads it back as 0, which every
  // consumer treats as "nothing drawn".
  multipleOf2Pow24: 0x01000000,
  // Ordinary, below 2^24 — must be unaffected by the widening.
  ordinary: 0x0000002a,
  // The top of the range, where a naive `<< 24` would go negative.
  highAlpha: 0xff020304,
};

// ── A: the encoding a PickId actually produces ──────────────────────────────

test("A1: PickId's WebGPU encoding round-trips every key, including above bit 23", () => {
  const context = new SpecContext();
  for (const [name, key] of Object.entries(KEYS)) {
    const pickId = allocatePickIdAt(context, key, { name });
    const bytes = rasterize(pickId.normalizedRgba);
    const decoded = Color.bytesToRgba(
      bytes.red,
      bytes.green,
      bytes.blue,
      bytes.alpha,
    );
    assert.equal(
      decoded >>> 0,
      key >>> 0,
      `${name}: PickId encoded 0x${key.toString(16)} as bytes that read back ` +
        `as 0x${(decoded >>> 0).toString(16)}`,
    );
  }
});

test("A2: PickId's encoding is byte-identical to the Color the same key produces", () => {
  // `PickId.color` (`Color.fromRgba(key)`, the WebGL carrier) and
  // `PickId.normalizedRgba` (the WebGPU carrier) are two encodings of ONE key.
  // A producer that reads either must land on the same four bytes.
  const context = new SpecContext();
  for (const [name, key] of Object.entries(KEYS)) {
    const pickId = allocatePickIdAt(context, key, { name });
    const fromNormalized = rasterize(pickId.normalizedRgba);
    const fromColor = {
      red: Color.floatToByte(pickId.color.red),
      green: Color.floatToByte(pickId.color.green),
      blue: Color.floatToByte(pickId.color.blue),
      alpha: Color.floatToByte(pickId.color.alpha),
    };
    assert.deepEqual(
      fromNormalized,
      fromColor,
      `${name}: the two carriers of one key disagree`,
    );
  }
});

test("A3: two ids differing only above bit 23 encode to different bytes", () => {
  const context = new SpecContext();
  const low = allocatePickIdAt(context, KEYS.lowOfPair, { which: "low" });
  const high = allocatePickIdAt(context, KEYS.highOfPair, { which: "high" });
  assert.notDeepEqual(
    rasterize(low.normalizedRgba),
    rasterize(high.normalizedRgba),
    "0x00000101 and 0x01000101 encode to the same four bytes",
  );
});

// ── B: the byte-object decode branch ───────────────────────────────────────

test("B1: the byte-object branch resolves the object a PickId was allocated for", () => {
  const context = new SpecContext();
  for (const [name, key] of Object.entries(KEYS)) {
    const target = { name };
    const pickId = allocatePickIdAt(context, key, target);
    const bytes = rasterize(pickId.normalizedRgba);
    assert.equal(
      context.getObjectByPickColor(bytes),
      target,
      `${name}: the byte-object branch lost 0x${key.toString(16)}`,
    );
  }
});

test("B2: the byte-object branch round-trips 0x01020304 to 0x01020304", () => {
  // The queue row's named clause, asserted through the public surface: a key
  // whose HIGH byte is 0x01 must resolve to its own object and to nothing else.
  const context = new SpecContext();
  const target = { name: "named" };
  const pickId = allocatePickIdAt(context, KEYS.named, target);
  const bytes = rasterize(pickId.normalizedRgba);
  assert.equal(context.getObjectByPickColor(bytes), target);
  // Under the 24-bit decode this key resolved as 0x00020304 — which must NOT
  // be what the byte-object branch answers with.
  const truncated = { name: "truncated" };
  allocatePickIdAt(context, KEYS.named & 0x00ffffff, truncated);
  assert.notEqual(
    context.getObjectByPickColor(bytes),
    truncated,
    "0x01020304 still resolves to the object registered at 0x00020304",
  );
});

test("B3: ids differing only above bit 23 resolve to their own objects", () => {
  const context = new SpecContext();
  const lowTarget = { which: "low" };
  const highTarget = { which: "high" };
  const low = allocatePickIdAt(context, KEYS.lowOfPair, lowTarget);
  const high = allocatePickIdAt(context, KEYS.highOfPair, highTarget);
  assert.equal(
    context.getObjectByPickColor(rasterize(low.normalizedRgba)),
    lowTarget,
  );
  assert.equal(
    context.getObjectByPickColor(rasterize(high.normalizedRgba)),
    highTarget,
  );
});

test("B4: the byte-object branch never answers with a negative key", () => {
  // `(alpha & 0xff) << 24` is a negative int32 for alpha >= 0x80. Keys come from
  // a Uint32Array, so a signed result matches nothing — the `>>> 0` is
  // load-bearing, not cosmetic.
  const context = new SpecContext();
  const target = { name: "highAlpha" };
  const pickId = allocatePickIdAt(context, KEYS.highAlpha, target);
  assert.equal(
    context.getObjectByPickColor(rasterize(pickId.normalizedRgba)),
    target,
    "a key with alpha >= 0x80 did not resolve",
  );
});

test("B5: the uint32 branch is untouched — the WebGL calling convention still passes the key through", () => {
  // `PickFramebuffer.js` and `SnapFramebuffer.js` (the WebGL readers) pass a
  // NUMBER. That branch must remain an identity, or the WebGL captures move.
  const context = new SpecContext();
  for (const [name, key] of Object.entries(KEYS)) {
    const target = { name };
    allocatePickIdAt(context, key, target);
    assert.equal(
      context.getObjectByPickColor(key >>> 0),
      target,
      `${name}: the uint32 branch stopped being an identity`,
    );
  }
});

test("B6: a cleared pick target still resolves to nothing", () => {
  // The pick FBO clears to (0,0,0,0) and ids start at 1, so key 0 must stay
  // unregistered under BOTH conventions.
  const context = new SpecContext();
  allocatePickIdAt(context, KEYS.ordinary, { name: "ordinary" });
  assert.equal(
    context.getObjectByPickColor({ red: 0, green: 0, blue: 0, alpha: 0 }),
    undefined,
  );
  assert.equal(context.getObjectByPickColor(0), undefined);
});

// ── C: the shader's own decode, executed ───────────────────────────────────

const FEATURE_ID_RESOLVE_SOURCE = await readSource(FEATURE_ID_RESOLVE_PATH);

/**
 * Extracts the body of one WGSL function by brace matching. Throws if the
 * function is absent or unbalanced, so a renamed or restructured shader is a
 * loud failure rather than a silently empty assertion.
 *
 * @param {string} source The shader source.
 * @param {string} name The function name.
 * @returns {string} The body text between the outermost braces.
 */
export function extractWgslFunctionBody(source, name) {
  const stripped = source.replace(/\/\/[^\n]*/g, "");
  const signature = new RegExp(`\\bfn\\s+${name}\\s*\\(`);
  const start = stripped.search(signature);
  assert.notEqual(start, -1, `shader has no fn ${name}`);
  const open = stripped.indexOf("{", start);
  assert.notEqual(open, -1, `fn ${name} has no body`);
  let depth = 0;
  for (let i = open; i < stripped.length; i++) {
    if (stripped[i] === "{") {
      depth++;
    } else if (stripped[i] === "}") {
      depth--;
      if (depth === 0) {
        return stripped.slice(open + 1, i);
      }
    }
  }
  throw new Error(`fn ${name} has an unbalanced body`);
}

// The complete token vocabulary of `decodeFeatureId`. Anything outside it is a
// translation failure, not a pass — that is what makes this total.
const WGSL_TOKEN =
  /\s+|[A-Za-z_][A-Za-z0-9_]*|0[xX][0-9a-fA-F]+u?|\d+\.\d+|\d+u?|<<|>>|[|&^~+\-*/(),.]/y;
const WGSL_IDENTIFIERS = new Set(["u32", "round", "c", "r", "g", "b", "a"]);

/**
 * Translates one WGSL integer expression into an equivalent JS expression.
 * Total by construction: the tokeniser must consume the whole string and every
 * identifier must be in the vocabulary, so an expression using anything this
 * translator does not model throws instead of being approximated.
 *
 * @param {string} expression The WGSL expression text.
 * @param {Set<string>} [extraVocabulary] Additional identifiers a caller models.
 *   Group F passes the recolor's locals; omitting it leaves the decode groups'
 *   vocabulary — and therefore C5's totality control — exactly as it was.
 * @returns {string} The JS expression text.
 */
export function translateWgslIntegerExpression(expression, extraVocabulary) {
  const vocabulary = extraVocabulary
    ? new Set([...WGSL_IDENTIFIERS, ...extraVocabulary])
    : WGSL_IDENTIFIERS;
  WGSL_TOKEN.lastIndex = 0;
  let index = 0;
  while (index < expression.length) {
    WGSL_TOKEN.lastIndex = index;
    const match = WGSL_TOKEN.exec(expression);
    if (!match) {
      throw new Error(
        `untranslatable WGSL at offset ${index}: ${expression.slice(index, index + 24)}`,
      );
    }
    const token = match[0];
    if (/^[A-Za-z_]/.test(token) && !vocabulary.has(token)) {
      throw new Error(`unknown WGSL identifier '${token}'`);
    }
    index = WGSL_TOKEN.lastIndex;
  }
  return expression
    .replace(/\bu32\s*\(\s*round\s*\(/g, "Math.round((")
    .replace(/\b(0[xX][0-9a-fA-F]+|\d+)u\b/g, "$1");
}

/**
 * Builds an executable JS twin of the shader's `decodeFeatureId` from the real
 * shader text: its `let` bindings and its `return` expressions, translated and
 * evaluated. Every return the function contains is returned separately so a
 * mutant that leaves an unreachable correct return behind is still caught by
 * the reachable one.
 *
 * @param {string} body The function body.
 * @returns {Array<Function>} One evaluator per `return` in the body.
 */
export function compileDecodeFeatureId(body) {
  const bindings = [
    ...body.matchAll(/\blet\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);/g),
  ].map(
    ([, name, expression]) =>
      `const ${name} = ${translateWgslIntegerExpression(expression)};`,
  );
  const returns = [...body.matchAll(/\breturn\s+([^;]+);/g)].map(
    ([, expression]) => translateWgslIntegerExpression(expression),
  );
  assert.ok(returns.length > 0, "decodeFeatureId has no return expression");
  return returns.map(
    (expression) =>
      // eslint-disable-next-line no-new-func
      new Function(
        "c",
        `${bindings.join("\n")}\nreturn (${expression}) >>> 0;`,
      ),
  );
}

const DECODERS = compileDecodeFeatureId(
  extractWgslFunctionBody(FEATURE_ID_RESOLVE_SOURCE, "decodeFeatureId"),
);

/**
 * The logical RGBA sample the pick target holds for a given key, as
 * `textureLoad` hands it to the shader.
 *
 * @param {number} key The pick key.
 * @returns {{r: number, g: number, b: number, a: number}} The sample.
 */
function sampleFor(key) {
  return {
    r: (key & 0xff) / 255,
    g: ((key >>> 8) & 0xff) / 255,
    b: ((key >>> 16) & 0xff) / 255,
    a: ((key >>> 24) & 0xff) / 255,
  };
}

test("C1: every reachable shader decode round-trips the full 32-bit key", () => {
  for (const decode of DECODERS) {
    for (const [name, key] of Object.entries(KEYS)) {
      assert.equal(
        decode(sampleFor(key)),
        key >>> 0,
        `${name}: the shader decoded 0x${key.toString(16)} as ` +
          `0x${decode(sampleFor(key)).toString(16)}`,
      );
    }
  }
});

test("C2: a multiple of 2^24 does not decode to the background id", () => {
  // id 0 is what the shader paints black. 0x01000000 samples as (0,0,0,1), so a
  // decode that ignores alpha reports it as "nothing drawn".
  for (const decode of DECODERS) {
    assert.notEqual(
      decode(sampleFor(KEYS.multipleOf2Pow24)),
      0,
      "0x01000000 decodes to the background id and would render black",
    );
  }
});

test("C3: two ids differing only above bit 23 decode to different ids", () => {
  for (const decode of DECODERS) {
    assert.notEqual(
      decode(sampleFor(KEYS.lowOfPair)),
      decode(sampleFor(KEYS.highOfPair)),
      "the shader aliases 0x00000101 and 0x01000101 onto one recolor",
    );
  }
});

test("C4: the cleared pick target still decodes to the background id", () => {
  for (const decode of DECODERS) {
    assert.equal(
      decode({ r: 0, g: 0, b: 0, a: 0 }),
      0,
      "a cleared pick target no longer reads as 'nothing drawn'",
    );
  }
});

test("C5: the translator is total — an unmodelled shader expression throws", () => {
  // The negative control for C1-C4. If the translator quietly approximated an
  // expression it does not model, those tests would certify the approximation
  // rather than the shader.
  assert.throws(
    () => translateWgslIntegerExpression("dot(c, vec4<f32>(1.0))"),
    /unknown WGSL identifier 'dot'/,
  );
  assert.throws(
    () =>
      extractWgslFunctionBody("fn other() { return 0u; }", "decodeFeatureId"),
    /shader has no fn decodeFeatureId/,
  );
});

// ── D: the three sites agree on one byte width ─────────────────────────────
//
// The commissioned structural guard (`_COMMON_RULES.md` §1), ADDITIONAL to the
// behaviour above, not a substitute for it. Two of the three widths are derived
// behaviourally — by perturbing one key byte at a time and observing which
// sites notice — so re-narrowing any one site is caught here even if someone
// deletes the tests above.

const PICK_KEY_BITS = 32;

// The lowest key the allocator ever hands out. Every probe below perturbs ONE
// byte of it, so each byte is tested against a key that is genuinely allocable.
const PROBE_BASE_KEY = 0x00000001;

/**
 * Derives how many key bits a site actually carries, by setting the key's byte
 * `n` and asking whether the site's observable changed. The highest byte the
 * site responds to sets its width; a site that ignores byte 3 reports 24.
 *
 * @param {Function} observe Maps a key to some observable value.
 * @returns {number} The site's key width in bits.
 */
function derivedKeyBits(observe) {
  const baseline = JSON.stringify(observe(PROBE_BASE_KEY));
  let widest = 0;
  for (let byte = 0; byte < 4; byte++) {
    const perturbed = (PROBE_BASE_KEY | (0x80 << (byte * 8))) >>> 0;
    if (JSON.stringify(observe(perturbed)) !== baseline) {
      widest = (byte + 1) * 8;
    }
  }
  return widest;
}

/**
 * The encoding a real `PickId` produces for `key`, as bytes.
 *
 * @param {number} key The key to encode.
 * @returns {object} The four bytes.
 */
function encodedBytesFor(key) {
  return rasterize(allocatePickIdAt(new SpecContext(), key, {}).normalizedRgba);
}

/**
 * Whether the byte-object decode branch collapses `key`'s encoding onto the
 * object registered at `PROBE_BASE_KEY`. True at the base key by definition;
 * true at a perturbed key ONLY if the branch ignores the byte that changed.
 *
 * @param {number} key The key whose encoding is offered to the branch.
 * @returns {boolean} Whether the branch answered with the base key's object.
 */
function collapsesOntoBaseKey(key) {
  const registry = new SpecContext();
  const target = {};
  allocatePickIdAt(registry, PROBE_BASE_KEY, target);
  return registry.getObjectByPickColor(encodedBytesFor(key)) === target;
}

test("D1: PickId's encoding carries 32 key bits", () => {
  assert.equal(
    derivedKeyBits((key) => encodedBytesFor(key)),
    PICK_KEY_BITS,
  );
});

test("D2: the byte-object decode branch carries 32 key bits", () => {
  assert.equal(derivedKeyBits(collapsesOntoBaseKey), PICK_KEY_BITS);
});

test("D3: the shader decode carries 32 key bits", () => {
  for (const decode of DECODERS) {
    assert.equal(
      derivedKeyBits((key) => decode(sampleFor(key))),
      PICK_KEY_BITS,
    );
  }
});

test("D4: the three sites agree, and agree with the CPU pick decoder", () => {
  // `WebGPUPickFramebuffer` folds all four bytes with `Color.bytesToRgba`. That
  // is the authority the other three must match; this pins the agreement so the
  // next edit to any one site cannot silently re-narrow it alone.
  const widths = new Set();
  widths.add(derivedKeyBits((key) => encodedBytesFor(key)));
  widths.add(derivedKeyBits(collapsesOntoBaseKey));
  for (const decode of DECODERS) {
    widths.add(derivedKeyBits((key) => decode(sampleFor(key))));
  }
  widths.add(
    derivedKeyBits((key) =>
      Color.bytesToRgba(
        key & 0xff,
        (key >>> 8) & 0xff,
        (key >>> 16) & 0xff,
        (key >>> 24) & 0xff,
      ),
    ),
  );
  assert.deepEqual(
    [...widths],
    [PICK_KEY_BITS],
    `the pick key's width is not agreed across its sites: ${[...widths].join(", ")}`,
  );
});

test("D5: the derivation is honest — a deliberately 24-bit site reports 24", () => {
  // The negative control for D1-D4. Without it, a derivation that always
  // returned 32 (or always returned the same number) would look like agreement.
  assert.equal(
    derivedKeyBits((key) => (key & 0x00ffffff) >>> 0),
    24,
  );
  assert.equal(
    derivedKeyBits((key) => (key >>> 0) & 0xff),
    8,
  );
});

// ── E: the probe's staging precondition, checkable without a browser ────────
//
// The 2026-09-05 Edge leg of this row came back REFUSED (`alias-pair-not-staged`,
// observed keys 0x3 / 0x4), not red: `probe-feature-id-texture.mjs` staged its
// alias pair by seeding `_nextPickColor` and then PICKING each point, but on
// WebGPU a pick RECTANGLE does not choose which ids are materialized — any pick
// pass runs `buildPickInstanceData` over every point in every collection
// (WebGPUPointPrimitiveRenderer.js:263-303) and `Scene.pick` updates every
// primitive regardless of where the rectangle falls. The probe's own full-canvas
// warm pick therefore allocated all three staged points, in creation order,
// before the first seed was ever written.
//
// The repair allocates through `PointPrimitive.getPickId` immediately after each
// seed, with nothing in between. This group is the Node-side proof of that
// precondition: it drives the probe's exported `KEY_SPAN_PLAN` through the REAL
// `GraphicsContext` allocator and the REAL `PointPrimitiveCollection` /
// `PointPrimitive.getPickId` path — a model of neither — and it fires the
// refusal, so the guard is known to bite rather than assumed to.

const PROBE_SOURCE = await readSource(
  resolve(directory, "probe-feature-id-texture.mjs"),
);

/**
 * The body of the probe's `stageKeySpan` page closure, by brace matching from
 * its `page.evaluate` call. Throws if the function is renamed or restructured,
 * so E5 cannot pass over a probe it failed to find.
 *
 * @param {string} source The probe source.
 * @returns {string} The closure body.
 */
function extractStageKeySpanBody(source) {
  const start = source.indexOf("async function stageKeySpan(page) {");
  assert.notEqual(start, -1, "the probe has no stageKeySpan");
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") {
      depth++;
    } else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return source.slice(open + 1, i);
      }
    }
  }
  throw new Error("stageKeySpan has an unbalanced body");
}

/**
 * Three points in three collections, the shape the key-span cell stages.
 *
 * @returns {Array<object>} The three point primitives, in creation order.
 */
function stagedPoints() {
  return [-0.06, 0.0, 0.06].map((dLon, i) => {
    const collection = new PointPrimitiveCollection();
    return collection.add({
      position: Cartesian3.fromDegrees(-75 + dLon, 39.94, 1000.0),
      pixelSize: 60,
      id: `probe-feature-id-span-${i}`,
    });
  });
}

/**
 * Compiles the probe's OWN `stage` closure out of `stageKeySpan` and returns it
 * as a callable. The spec then executes the probe's staging code rather than a
 * copy of it, which is what makes E1/E3 sensitive to an inert probe: a
 * `stage` body wrapped in `if (false && …)` allocates nothing and E1 goes red,
 * where a source-text guard would still have passed.
 *
 * Throws if the closure is renamed or restructured, so this cannot silently
 * degrade into asserting nothing.
 *
 * @param {string} source The probe source.
 * @returns {Function} `(context, primitive, step) => void`.
 */
export function compileProbeStage(source) {
  const body = extractStageKeySpanBody(source);
  const start = body.indexOf("const stage = (primitive, step) => {");
  assert.notEqual(start, -1, "the probe's stageKeySpan has no `stage` closure");
  const open = body.indexOf("{", body.indexOf("=>", start));
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "{") {
      depth++;
    } else if (body[i] === "}") {
      depth--;
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function(
          "context",
          "primitive",
          "step",
          body.slice(open + 1, i),
        );
      }
    }
  }
  throw new Error("the probe's `stage` closure has an unbalanced body");
}

const probeStage = compileProbeStage(PROBE_SOURCE);

/**
 * The repaired staging, executed through the probe's own `stage` closure: seed
 * the real allocator, then allocate through the real factory, with nothing
 * between the seed and the allocation.
 *
 * @param {object} context The spec context.
 * @param {Array<object>} points The three staged points.
 */
function stageInPlanOrder(context, points) {
  const steps = [
    KEY_SPAN_PLAN.alias0,
    KEY_SPAN_PLAN.alias1,
    KEY_SPAN_PLAN.multiple,
  ];
  points.forEach((point, i) => {
    probeStage(context, point, steps[i]);
  });
}

/**
 * The key a staged point actually received, read back from the real registry —
 * the same lookup `stageKeySpan`'s `keyOf` performs in the page.
 *
 * @param {object} context The spec context.
 * @param {object} point The staged point.
 * @returns {number|null} The key, or null when the point never registered.
 */
function stagedKeyOf(context, point) {
  for (const [key, target] of context._pickObjects) {
    if (target === point || target?.primitive === point) {
      return key >>> 0;
    }
  }
  return null;
}

/**
 * The span object `buildKeySpanCell` consumes, built from real readbacks.
 *
 * @param {object} context The spec context.
 * @param {Array<object>} points The three staged points.
 * @returns {object} The span.
 */
function spanFrom(context, points) {
  const [alias0, alias1, multiple] = points.map((point) => ({
    key: stagedKeyOf(context, point),
    x: 0,
    y: 0,
  }));
  return {
    alias0,
    alias1,
    multiple,
    planned: {
      alias0: KEY_SPAN_PLAN.alias0.key,
      alias1: KEY_SPAN_PLAN.alias1.key,
      multiple: KEY_SPAN_PLAN.multiple.key,
    },
  };
}

/**
 * Recolors that satisfy every colour assertion in the cell, so a refusal in this
 * group is always about the STAGING and never about the colours.
 *
 * @param {object} span The staged span.
 * @returns {object} The recolor readback the cell consumes.
 */
function satisfyingColors(span) {
  return {
    resolved: true,
    alias0Color: expectedRecolor(span.alias0.key),
    alias1Color: expectedRecolor(span.alias1.key),
    multipleColor: expectedRecolor(span.multiple.key),
  };
}

test("E1: the probe's staging plan lands its three keys on the real allocator", () => {
  const context = new SpecContext();
  const points = stagedPoints();
  stageInPlanOrder(context, points);
  const span = spanFrom(context, points);

  assert.equal(span.alias0.key, KEY_SPAN_PLAN.alias0.key);
  assert.equal(span.alias1.key, KEY_SPAN_PLAN.alias1.key);
  assert.equal(span.multiple.key, KEY_SPAN_PLAN.multiple.key);

  // The three shapes AR-751's acceptance names.
  assert.ok(
    differsOnlyAboveBit23(span.alias0.key, span.alias1.key),
    "the alias pair does not differ only above bit 23",
  );
  assert.equal(span.multiple.key & 0x00ffffff, 0);
  assert.notEqual(span.multiple.key >>> 24, 0);

  // And the cell accepts them — a correctly staged run does not refuse.
  const cell = buildKeySpanCell(span, satisfyingColors(span));
  assert.equal(cell.cell, "key-span");
  assert.ok(cell.aliasPairDistinct && cell.multipleNonBlack);
  assert.ok(cell.alias0MatchesFullKey && cell.alias1MatchesFullKey);
});

test("E2: the canary fires — the staging miss the Edge leg observed still REFUSES", () => {
  // Reproduce the defect exactly. A pick pass materializes all three points in
  // creation order BEFORE any seed is written, which is what a full-canvas warm
  // pick does: `buildPickInstanceData` walks the collection and calls
  // `getPickId` on every point, so this loop is that pass's allocation order.
  const context = new SpecContext();
  const points = stagedPoints();
  for (const point of points) {
    point.getPickId(context);
  }
  // The seeds are then written too late — `getPickId` memoizes on `_pickId`.
  stageInPlanOrder(context, points);

  const span = spanFrom(context, points);
  assert.deepEqual(
    [span.alias0.key, span.alias1.key, span.multiple.key],
    [1, 2, 3],
    "the reproduction did not allocate in creation order",
  );

  assert.throws(
    () => buildKeySpanCell(span, satisfyingColors(span)),
    (error) => {
      assert.ok(
        error instanceof ProbeRefusal,
        "an unstaged pair must REFUSE, not throw an ordinary error",
      );
      assert.equal(error.reason, "alias-pair-not-staged");
      // The refusal names the observed keys and the plan they missed.
      assert.equal(error.details.alias0, 1);
      assert.equal(error.details.alias1, 2);
      assert.equal(error.details.planned.alias0, KEY_SPAN_PLAN.alias0.key);
      return true;
    },
  );
});

test("E3: once staged, a later full-canvas pick cannot move the keys", () => {
  // The repair's actual claim. After staging, model the warm pick that broke the
  // 2026-09-05 run — the same `getPickId` sweep over every point — plus a crowd
  // of neighbouring primitives allocating. The staged keys must not move,
  // because `PointPrimitive.getPickId` memoizes (PointPrimitive.js:454-466).
  const context = new SpecContext();
  const points = stagedPoints();
  stageInPlanOrder(context, points);

  const neighbours = new PointPrimitiveCollection();
  for (let i = 0; i < 8; i++) {
    neighbours
      .add({ position: Cartesian3.fromDegrees(-76 + i * 0.01, 39.9, 10.0) })
      .getPickId(context);
  }
  for (const point of points) {
    point.getPickId(context);
  }

  const span = spanFrom(context, points);
  assert.equal(span.alias0.key, KEY_SPAN_PLAN.alias0.key);
  assert.equal(span.alias1.key, KEY_SPAN_PLAN.alias1.key);
  assert.equal(span.multiple.key, KEY_SPAN_PLAN.multiple.key);
  assert.doesNotThrow(() => buildKeySpanCell(span, satisfyingColors(span)));
});

test("E4: the plan's seeds are the allocator's pre-increment, not an assumption", () => {
  // `createPickId` does `_nextPickColor[0]++` and then reads it
  // (GraphicsContext.ts:1641-1642). If that ever became a post-increment every
  // staged key would be off by one and E1 would drift silently; pin the relation
  // against the real allocator rather than restating the arithmetic.
  for (const step of Object.values(KEY_SPAN_PLAN)) {
    assert.equal(step.seed, step.key - 1);
    const context = new SpecContext();
    context._nextPickColor[0] = step.seed;
    assert.equal(
      context.createPickId({ marker: step.key }).key >>> 0,
      step.key,
    );
  }
});

test("E5: STRUCTURAL — the probe stages by allocation, with no pick in between", () => {
  // E1-E4 execute the probe's own `stage` closure, so an inert staging is caught
  // there. What they CANNOT see is the surrounding page code — the picks and
  // renders around the staging need `window` and a live `Scene`. This is the
  // commissioned structural guard over exactly that remaining gap, and it is
  // stated as such rather than dressed up as a behaviour assertion: it pins the
  // ORDER of the phases around the closure E1-E4 execute.
  //
  // The 2026-09-05 refusal was caused by a pick standing between the seed and
  // the allocation, and by the warm pick preceding the staging. Both come back
  // as failures here.
  const stageBody = extractStageKeySpanBody(PROBE_SOURCE);
  const seedIndex = stageBody.indexOf("context._nextPickColor[0] = step.seed;");
  const allocateIndex = stageBody.indexOf("primitive.getPickId(context);");
  assert.notEqual(
    seedIndex,
    -1,
    "the probe no longer seeds the real allocator",
  );
  assert.notEqual(
    allocateIndex,
    -1,
    "the probe no longer allocates through the real getPickId factory",
  );
  assert.ok(
    seedIndex < allocateIndex,
    "the probe seeds AFTER allocating, so the seed cannot take effect",
  );
  assert.equal(
    stageBody.slice(seedIndex, allocateIndex).includes("doPick"),
    false,
    "a pick stands between the seed and the allocation — the 2026-09-05 defect",
  );
  // And the three staged points are allocated before the warm pick runs at all.
  assert.ok(
    stageBody.indexOf("stage(multiple, plan.multiple);") <
      stageBody.indexOf("await doPick(warmX, warmY"),
    "the warm pick runs before staging completes, which is what stole the ids",
  );
});

// ── F: the recolor itself, executed from the real shader text ──────────────
//
// The second cause AR-751's first Edge leg could not reach. Widening
// `decodeFeatureId` (group C) makes the shader read the FULL key, but the colour
// it emits is the LOW three bytes of `id * 2654435761u`, and multiplication mod
// 2^32 propagates carries only UPWARD — the low 24 bits of the product depend
// solely on the low 24 bits of `id`. Under a bare multiply, therefore:
//
//   * two ids differing only above bit 23 recolor to the SAME triple, and
//   * every multiple of 2^24 recolors to (0,0,0), i.e. background,
//
// which are the row's two symptoms exactly, surviving a correct decode. The
// probe could not see this: its CPU twin `expectedRecolor` mirrored the same
// collapse, so `alias0MatchesFullKey` agreed while `aliasPairDistinct` did not,
// and the staging refusal aborted the run before either was computed.
//
// The shader now applies an xorshift finalizer. This group executes the hash out
// of the real shader source — not a restatement of it — and carries the negative
// control that the un-finalized form collapses, so the assertion is known to be
// sensitive to the finalizer rather than merely passing beside it.

const RECOLOR_VOCABULARY = new Set(["id", "hashed", "h"]);

/**
 * Rewrites a translated expression so it evaluates with WGSL's u32 semantics
 * rather than JavaScript's number semantics. Two operators diverge above 2^31
 * and BOTH appear in the recolor:
 *
 *   * `*` — WGSL multiplies mod 2^32; JS multiplies as a double and loses the
 *     low bits once the product exceeds 2^53. `Math.imul` is the mod-2^32 form.
 *   * `>>` — WGSL shifts a u32 logically; JS `>>` coerces to int32 and sign
 *     extends, so any hash with bit 31 set folds in the wrong bits.
 *
 * Getting either wrong would make this group certify a twin that disagrees with
 * the shader precisely in the range AR-751 is about, so the rewrite is explicit
 * and refuses anything it does not model.
 *
 * @param {string} js The translated JS expression.
 * @returns {string} The expression with u32 operator semantics.
 */
function asU32Arithmetic(js) {
  const logical = js.replace(/>>(?!>)/g, ">>>");
  const factors = logical.split("*");
  if (factors.length === 1) {
    return logical;
  }
  assert.equal(
    factors.length,
    2,
    `unmodelled chained multiply in recolor expression: ${js}`,
  );
  return `Math.imul(${factors[0]}, ${factors[1]})`;
}

/**
 * Compiles the recolor hash out of `fragmentMain`'s real source: every `let`
 * binding between the id and the colour bytes, translated and chained. Throws if
 * the shader renames or restructures them, so a drifted shader is a loud failure
 * rather than a silently stale twin.
 *
 * @param {string} source The shader source.
 * @returns {Function} `(id) => h`, the finalized hash as the shader computes it.
 */
export function compileRecolorHash(source) {
  const body = extractWgslFunctionBody(source, "fragmentMain");
  const bindings = [...body.matchAll(/\blet\s+(hashed|h)\s*=\s*([^;]+);/g)].map(
    ([, name, expression]) =>
      `const ${name} = (${asU32Arithmetic(
        translateWgslIntegerExpression(expression, RECOLOR_VOCABULARY),
      )}) >>> 0;`,
  );
  assert.equal(
    bindings.length,
    2,
    "fragmentMain no longer binds exactly `hashed` and `h` — the recolor was restructured",
  );
  // eslint-disable-next-line no-new-func
  return new Function("id", `${bindings.join("\n")}\nreturn h >>> 0;`);
}

const recolorHash = compileRecolorHash(FEATURE_ID_RESOLVE_SOURCE);

/**
 * The colour the shader emits for a hash, as its three byte extractions read.
 *
 * @param {number} h The finalized hash.
 * @returns {Array<number>} The [r, g, b] bytes.
 */
function bytesOf(h) {
  return [h & 0xff, (h >>> 8) & 0xff, (h >>> 16) & 0xff];
}

const RECOLOR_KEYS = [
  KEYS.named,
  KEYS.lowOfPair,
  KEYS.highOfPair,
  KEYS.multipleOf2Pow24,
  KEYS.ordinary,
  KEYS.highAlpha,
  KEY_SPAN_PLAN.alias0.key,
  KEY_SPAN_PLAN.alias1.key,
  KEY_SPAN_PLAN.multiple.key,
];

test("F1: the shader's byte extraction is the low three bytes of the hash", () => {
  // Executed above; this pins the three extractions the executed hash feeds, so
  // F2-F4's conclusions cover the whole recolor and not just its first half.
  const body = extractWgslFunctionBody(
    FEATURE_ID_RESOLVE_SOURCE,
    "fragmentMain",
  );
  for (const expression of [
    "let hr = f32(h & 0xFFu) / 255.0;",
    "let hg = f32((h >> 8u) & 0xFFu) / 255.0;",
    "let hb = f32((h >> 16u) & 0xFFu) / 255.0;",
  ]) {
    assert.ok(
      body.includes(expression.replace("let ", "").replace(";", "")),
      `fragmentMain no longer contains ${expression}`,
    );
  }
});

test("F2: two ids differing only above bit 23 recolor to DIFFERENT triples", () => {
  // The row's first visual clause, over the shader's own arithmetic.
  for (const [low, high] of [
    [KEYS.lowOfPair, KEYS.highOfPair],
    [KEY_SPAN_PLAN.alias0.key, KEY_SPAN_PLAN.alias1.key],
    [KEYS.ordinary, (KEYS.ordinary + 0xff000000) >>> 0],
  ]) {
    assert.ok(
      differsOnlyAboveBit23(low, high),
      "the pair under test does not differ only above bit 23",
    );
    assert.notDeepEqual(
      bytesOf(recolorHash(low)),
      bytesOf(recolorHash(high)),
      `0x${low.toString(16)} and 0x${high.toString(16)} still recolor identically`,
    );
  }
});

test("F3: a multiple of 2^24 recolors NON-BLACK", () => {
  // The row's second visual clause. `0x01000000` is the key it names.
  for (const key of [
    KEYS.multipleOf2Pow24,
    KEY_SPAN_PLAN.multiple.key,
    0x02000000,
    0xff000000,
  ]) {
    assert.equal(
      key & 0x00ffffff,
      0,
      "the key under test is not a multiple of 2^24",
    );
    const rgb = bytesOf(recolorHash(key));
    assert.ok(
      rgb.some((channel) => channel !== 0),
      `0x${key.toString(16)} still recolors to background: ${rgb.join(",")}`,
    );
  }
});

test("F4: the probe's CPU twin reproduces the shader's recolor exactly", () => {
  // What kept the collapse invisible was a twin that mirrored it. Pin the twin to
  // the shader text so the probe's `alias0MatchesFullKey` cannot agree with a
  // shader that disagrees with the row.
  for (const key of RECOLOR_KEYS) {
    assert.deepEqual(
      expectedRecolor(key),
      bytesOf(recolorHash(key)),
      `the twin disagrees with the shader at 0x${key.toString(16)}`,
    );
  }
  // Nothing drawn stays black under both.
  assert.deepEqual(expectedRecolor(0), [0, 0, 0]);
});

test("F5: the negative control — without the finalizer the collapse comes back", () => {
  // Proves F2-F4 are sensitive to the finalizer rather than passing beside it.
  // This is the bare multiply the shader carried before AR-751's follow-up.
  const unfinalized = (id) => Math.imul(id >>> 0, 2654435761) >>> 0;
  assert.deepEqual(
    bytesOf(unfinalized(KEYS.lowOfPair)),
    bytesOf(unfinalized(KEYS.highOfPair)),
    "the un-finalized hash was expected to collapse the alias pair",
  );
  assert.deepEqual(
    bytesOf(unfinalized(KEYS.multipleOf2Pow24)),
    [0, 0, 0],
    "the un-finalized hash was expected to paint a multiple of 2^24 as background",
  );
  // And the real shader is NOT that function.
  assert.notDeepEqual(
    bytesOf(recolorHash(KEYS.highOfPair)),
    bytesOf(unfinalized(KEYS.highOfPair)),
    "the shader still computes the un-finalized hash",
  );
});

test("F6: the recolor compiler is total — a restructured shader throws", () => {
  // The negative control for the extraction itself, matching C5's role.
  assert.throws(
    () =>
      compileRecolorHash(
        "fn fragmentMain() { let hashed = id * 2654435761u; }",
      ),
    /no longer binds exactly/,
  );
  assert.throws(
    () => translateWgslIntegerExpression("dot(h, h)", RECOLOR_VOCABULARY),
    /unknown WGSL identifier 'dot'/,
  );
  assert.throws(
    () => asU32Arithmetic("id * 3 * 5"),
    /unmodelled chained multiply/,
  );
});

test("F7: the twin uses u32 arithmetic, which is what makes F4 meaningful", () => {
  // The negative control for `asU32Arithmetic`. Each naive reading agrees with
  // the shader over most of the key space and diverges only in the range this
  // row is about, so each control also asserts the precondition that makes it
  // discriminating — otherwise a later key-set edit could quietly defuse it.

  // A float multiply loses the low bits once the product passes 2^53.
  const bigKey = KEYS.highAlpha;
  assert.ok(
    bigKey * 2654435761 > Number.MAX_SAFE_INTEGER,
    "the multiply control no longer exceeds 2^53, so it cannot discriminate",
  );
  const naiveMultiply =
    ((bigKey * 2654435761) ^ ((bigKey * 2654435761) >>> 16)) >>> 0;
  assert.notEqual(
    recolorHash(bigKey),
    naiveMultiply,
    "a float multiply would have matched the shader",
  );

  // A signed shift sign-extends only when the hash has bit 31 set.
  const signKey = KEYS.multipleOf2Pow24;
  const hashed = Math.imul(signKey, 2654435761) >>> 0;
  assert.ok(
    (hashed & 0x80000000) !== 0,
    "the shift control's hash no longer has bit 31 set, so it cannot discriminate",
  );
  assert.notEqual(
    recolorHash(signKey),
    (hashed ^ (hashed >> 16)) >>> 0,
    "a signed shift would have matched the shader",
  );
});
