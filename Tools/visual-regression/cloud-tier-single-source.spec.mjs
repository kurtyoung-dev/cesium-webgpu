// cloud-tier-single-source.spec.mjs — the cloud tier table is the ONLY
// producer of every preset-derived cloud uniform.
// @purpose Executes the real preset→uniform seam from Node to prove a tier-table edit reaches the packed float, derives each float's flat index by walking the renderer's packer and cross-checking it against the WGSL struct, and pins every current default byte-identical to the deleted second resolver.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// Editing the cloud tier table moved no pixel.
//
// Two modules each resolved the cloud quality dial. `WebGPUCloudTierPresets.ts`
// held `CLOUD_TIER_PRESETS`, described itself as "the single source of truth",
// and supplied the structural dials (noise source, half-res, temporal, jitter,
// octaves). The renderer held a private `resolveCloudQuality()` carrying its
// OWN `(24,3)/(48,4)/(96,8)` step literals and its OWN copy of the `"auto"`
// altitude bands — and it was THAT copy whose output reached the packed uniform
// the shader reads as `maxSteps`. Three more preset fields (`powderStrength`,
// `isotropicFloor`, `ambientFloor`) had no uniform slot at all. So a maintainer
// could raise tier 3 to 128 primary steps, re-read both docstrings confirming
// the table was authoritative, rebuild, and see a byte-identical frame.
//
// That is the defect class this file exists to make impossible: a table whose
// edits are inert, with documentation asserting the opposite. Nothing here
// reads a comment — the float indices are DERIVED from the packer and
// cross-derived from the WGSL struct, and the propagation assertions EXECUTE
// the engine's real resolver rather than grepping for its shape.
//
// WHAT IS ASSERTED
// ----------------
//  1. PROPAGATION. Mutating a row of `CLOUD_TIER_PRESETS` changes the value
//     that reaches the float the shader reads, for six fields on every tier.
//     The mutation is applied to the real exported table, driven through the
//     real `buildCloudQualityInputs` → `resolveCloudPreset` →
//     `buildCloudQualityBlock` chain, and restored in a `finally`.
//  2. INDEX. Each value's flat float index is derived by WALKING the packer
//     (`data[offset++]`, `offset += <named constant>`, and the two guarded
//     branch arms that must advance equally), then cross-checked against the
//     WGSL `CloudUniforms` struct under the uniform address-space layout rules.
//     The walk's final offset must equal the renderer's own
//     `CLOUD_UNIFORM_FLOATS`, so an appended row cannot desynchronise the
//     allocation from the writes. The two-sided derivation technique is
//     `celestial-uniform-offsets.spec.mjs`'s; this file reuses it and extends
//     it with the sequential-offset walk that packer needs.
//  3. BYTE-IDENTITY. The deleted `resolveCloudQuality`, the deleted
//     `lightSampleScale` expression and the deleted `qualityFlags` assembly are
//     transcribed below as a reference implementation out of
//     `git show 9f3723b0b32be87348553c3535893acdec37aeb3:…` (the file's own last
//     commit there is b7d7d1f5e9f2e5aa1308eb3bedbd07bbb6659210). A wide input
//     sweep asserts the live path reproduces them EXACTLY, with `Object.is` so
//     `NaN` and `-0` compare honestly.
//  4. ONE SPELLING of the `"auto"` altitude bands survives under
//     `packages/engine/Source/Renderer/WebGPU/`, asserted both as a census and
//     as the behavioural coupling between the tier bands and the aerial
//     default's band edge.
//  5. THE AERIAL DEFAULT (`C13-N20`'s promotion clause): an explicit
//     `cloudAerialMode` wins in both directions, only an unset dial consults
//     the predicate, and the predicate's threshold is `disableAltitudeMeters`
//     inclusive — pinned with a NON-default band edge so it is the threshold
//     that is asserted and not the number 100000.
//  6. THE ONE DELIBERATE NON-IDENTITY. Item 3's sweep has exactly one
//     exception: with `cloudAerialMode` unset and the predicate firing, float
//     108 and bit 8 of float 74 now turn on where HEAD left them clear. The
//     exception set is derived from the live predicate rather than restated, so
//     the assertion holds whichever form that predicate takes — and it must be
//     non-empty, so it cannot pass vacuously.
//  7. INERTNESS MUTANTS. Five, each making a fix unreachable in a COPY of the
//     engine module under `os.tmpdir()`, then asserting the property the real
//     module satisfies goes red on the copy.
//
// Run: node --test Tools/visual-regression/cloud-tier-single-source.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// This checkout is CRLF; the REPO-TOOLING-SOURCE-ANCHOR-FRAGILITY class has
// cost this fleet several cycles, so every text read is normalised.
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

const PRESETS_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudTierPresets.ts";
const RENDERER_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts";
const DENSITY_TS =
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";
const CLOUDS_WGSL =
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl";
const WEBGPU_DIR = "packages/engine/Source/Renderer/WebGPU";

const presetsSource = read(PRESETS_TS);
const rendererSource = read(RENDERER_TS);
const wgslSource = read(CLOUDS_WGSL);

// The preset module has no relative imports, which is why Node 22's native
// type stripping can load the `.ts` directly: Node will not resolve a `./x.js`
// specifier to `x.ts`, so a module with any would fail here. Asserted rather
// than assumed, because adding one would silently break every execution below.
assert.equal(
  /^\s*import\s/m.test(presetsSource),
  false,
  "WebGPUCloudTierPresets.ts must stay import-free so the seam is executable from Node",
);

const live = await import(pathToFileURL(path.join(root, PRESETS_TS)).href);

// ── Comment stripping, shared by the walker and the expression extractors ───

/**
 * Remove `//` and block comments, keeping the line count identical so line
 * numbers stay usable. String and template bodies are blanked by default, so a
 * brace or a `//` inside one cannot be mistaken for code; pass `keepStrings`
 * when the text is going to be EXECUTED, where the literals are the meaning.
 *
 * @param {string} text Source text.
 * @param {{keepStrings?: boolean}} [options] Literal handling.
 * @returns {string}
 */
function stripComments(text, { keepStrings = false } = {}) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      while (i < n && text[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") {
          out += "\n";
        }
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (text[i] === "\\") {
          out += keepStrings ? text.slice(i, i + 2) : "  ";
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          out += quote;
          i++;
          break;
        }
        if (keepStrings) {
          out += text[i];
        } else {
          out += text[i] === "\n" ? "\n" : " ";
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Stripped once: the renderer is a quarter of a megabyte and the sweeps below
// consult it tens of thousands of times.
//
// This copy KEEPS its string literals, because the text below gets EXECUTED and
// `cloudAerialMode === "physical"` means nothing once the literal is blanked.
// The packer walk takes the other treatment — its own blanked strip, inside
// `walkPacker` — because the renderer's `console.error` template literals carry
// `${…}` braces a brace-counting block model would otherwise read as blocks.
const rendererCode = stripComments(rendererSource, { keepStrings: true });

// ── Named integer constants, resolved from source rather than restated ──────

/** @type {Record<string, string>} */
const constantExpressions = {};
for (const file of [RENDERER_TS, DENSITY_TS]) {
  const text = stripComments(read(file));
  for (const m of text.matchAll(
    /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*([^;]+);/g,
  )) {
    constantExpressions[m[1]] = m[2].trim();
  }
}

/**
 * Evaluate a named constant whose definition is a sum of integer literals and
 * other named constants. Anything else throws, so a constant that grows a real
 * expression fails loudly instead of being silently mis-resolved.
 *
 * @param {string} name Constant identifier.
 * @param {Set<string>} [seen] Cycle guard.
 * @returns {number}
 */
function evalConstant(name, seen = new Set()) {
  assert.equal(seen.has(name), false, `cyclic constant ${name}`);
  seen.add(name);
  const expr = constantExpressions[name];
  assert.ok(expr !== undefined, `constant ${name} not found in the engine`);
  let total = 0;
  for (const part of expr.split("+").map((p) => p.trim())) {
    if (/^\d+$/.test(part)) {
      total += Number(part);
    } else {
      assert.match(part, /^[A-Z][A-Z0-9_]*$/, `unmodelled term "${part}"`);
      total += evalConstant(part, seen);
    }
  }
  return total;
}

// ── The packer walk ─────────────────────────────────────────────────────────
//
// The cloud packer does NOT write literal indices the way the celestial
// packers do; it runs a single `offset` cursor from 0 through
// `CLOUD_UNIFORM_FLOATS`. So the flat index of a value is derived by walking
// the statements in order:
//
//   • `data[offset++] = <expr>;`            advances 1
//   • `for (let i = 0; i < N; i++) data[offset++] = …`  advances N
//   • `offset += <named constant>;`         advances that constant
//   • `if (…) { … } else { … }`             advances ONCE — both arms are
//     required to advance equally, which is the whole point of the `else`
//     arms (`offset += 16` opposite a 16-iteration matrix copy, and the
//     all-zero encoded-camera fallback opposite the encoded split). A naive
//     line count that adds both arms runs 32 floats long per matrix and
//     silently shifts every later index.

/**
 * Walk the packer and return every `data[offset++]` write with its derived
 * flat float index, plus the final offset.
 *
 * @param {string} source Renderer source text.
 * @returns {{writes: {index:number,line:number,slot:number|null,text:string}[], finalOffset:number}}
 */
function walkPacker(source) {
  const rawLines = source.split("\n");
  const codeLines = stripComments(source).split("\n");
  assert.equal(
    rawLines.length,
    codeLines.length,
    "comment strip changed lines",
  );

  const startIdx = codeLines.findIndex((l) => l.trim() === "let offset = 0;");
  assert.ok(startIdx >= 0, "the packer's `let offset = 0;` anchor moved");
  const endIdx = codeLines.findIndex(
    (l, i) =>
      i > startIdx &&
      l.includes("device.queue.writeBuffer(cache.uniformBuffer"),
  );
  assert.ok(endIdx > startIdx, "the packer's writeBuffer anchor moved");

  let offset = 0;
  let depth = 0;
  /** @type {Map<number, number>} */
  const blockEntryOffset = new Map();
  /** @type {Map<number, number>} */
  const pendingArmAdvance = new Map();
  let elseContinuation = false;
  const writes = [];

  for (let i = startIdx; i <= endIdx; i++) {
    const code = codeLines[i];
    const trimmed = code.trim();
    const opens = (code.match(/\{/g) ?? []).length;
    const closes = (code.match(/\}/g) ?? []).length;
    const isElse = /^\}\s*else\b/.test(trimmed);

    if (isElse) {
      // Close of an arm: bank how far it advanced and rewind for the next one.
      const entry = blockEntryOffset.get(depth) ?? 0;
      pendingArmAdvance.set(depth, offset - entry);
      offset = entry;
      elseContinuation = opens === 0;
    }

    const writeCount = (code.match(/data\[offset\+\+\]/g) ?? []).length;
    if (writeCount > 0) {
      assert.equal(
        opens + closes,
        0,
        `line ${i + 1} mixes a brace with a packed write; the walk's block model cannot see it`,
      );
      const loop = /for\s*\(\s*let\s+\w+\s*=\s*0;\s*\w+\s*<\s*(\d+);/.exec(
        code,
      );
      const repeats = loop ? Number(loop[1]) : 1;
      // A multi-line statement carries its slot comment on the line that ends
      // it, so the statement's terminator is what is read for the cross-check.
      let end = i;
      while (end < endIdx && !codeLines[end].trimEnd().endsWith(";")) {
        end++;
      }
      const slotComment = /\/\/\s*(\d+)\b/.exec(rawLines[end]);
      for (let r = 0; r < repeats; r++) {
        for (let w = 0; w < writeCount; w++) {
          writes.push({
            index: offset,
            line: i + 1,
            slot: slotComment ? Number(slotComment[1]) : null,
            text: rawLines[i].trim(),
          });
          offset++;
        }
      }
    }

    const jump = /offset\s*\+=\s*([A-Za-z_]\w*|\d+)\s*;/.exec(code);
    if (jump) {
      offset += /^\d+$/.test(jump[1]) ? Number(jump[1]) : evalConstant(jump[1]);
    }

    for (let k = 0; k < closes - (isElse ? 1 : 0); k++) {
      const closing = depth;
      depth--;
      if (pendingArmAdvance.has(closing)) {
        const elseAdvance = offset - (blockEntryOffset.get(closing) ?? 0);
        assert.equal(
          elseAdvance,
          pendingArmAdvance.get(closing),
          `the guarded block closing at line ${i + 1} has arms that advance the packer by different amounts`,
        );
        pendingArmAdvance.delete(closing);
      }
    }
    for (let k = 0; k < opens - (isElse ? 1 : 0); k++) {
      depth++;
      if (!elseContinuation) {
        pendingArmAdvance.delete(depth);
      }
      blockEntryOffset.set(depth, offset);
      elseContinuation = false;
    }
    if (isElse && opens > 0) {
      blockEntryOffset.set(depth, offset);
    }
  }

  return { writes, finalOffset: offset };
}

const packerWalk = walkPacker(rendererSource);

/**
 * The derived flat float index of the write whose statement text contains a
 * given expression. The expression is the packer's real intent, not a comment
 * about it, and it must resolve to exactly one index.
 *
 * @param {string} expression Substring of the write statement.
 * @returns {number}
 */
function packedIndexOf(expression) {
  const hits = packerWalk.writes.filter((w) => w.text.includes(expression));
  assert.ok(hits.length > 0, `no packed write of "${expression}" — it moved`);
  const indices = new Set(hits.map((h) => h.index));
  assert.equal(
    indices.size,
    1,
    `"${expression}" is packed at more than one index: ${[...indices]}`,
  );
  return hits[0].index;
}

// ── WGSL uniform address-space layout (spec §14.4.4) ────────────────────────
//
// Lifted from `celestial-uniform-offsets.spec.mjs`, which introduced this
// two-sided derivation for the star cubemap and sprite buffers. Same rules,
// applied to `CloudUniforms`.

/** @type {Record<string, {align:number,size:number}>} */
const WGSL_TYPES = {
  f32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  "vec2<f32>": { align: 8, size: 8 },
  // vec3 has size 12 but alignment 16 — the trap the explicit `_pad*` members
  // in this struct exist to make visible.
  "vec3<f32>": { align: 16, size: 12 },
  "vec4<f32>": { align: 16, size: 16 },
  "mat4x4<f32>": { align: 16, size: 64 },
};

const roundUp = (value, multiple) => Math.ceil(value / multiple) * multiple;

/**
 * Members of a named WGSL struct, in declaration order, comments stripped.
 *
 * @param {string} source WGSL text.
 * @param {string} name Struct name.
 * @returns {{name:string,type:string}[]}
 */
function parseStruct(source, name) {
  const start = source.indexOf(`struct ${name} {`);
  assert.ok(start >= 0, `struct ${name} not found`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n};", open);
  assert.ok(close > open, `struct ${name} is not terminated`);
  const body = source
    .slice(open + 1, close)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").trim())
    .filter((line) => line.length > 0)
    .join(" ");
  const members = [];
  for (const decl of body.split(",")) {
    const trimmed = decl.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const m = /^([A-Za-z_]\w*)\s*:\s*(.+)$/.exec(trimmed);
    assert.ok(m, `unparsed struct member in ${name}: "${trimmed}"`);
    members.push({ name: m[1], type: m[2].trim() });
  }
  return members;
}

/**
 * Byte offset of every member plus the struct's own size.
 *
 * @param {{name:string,type:string}[]} members Parsed members.
 * @returns {{offsets:Record<string,number>,size:number}}
 */
function layout(members) {
  /** @type {Record<string, number>} */
  const offsets = {};
  let cursor = 0;
  let structAlign = 1;
  for (const member of members) {
    const info = WGSL_TYPES[member.type];
    assert.ok(info, `unmodelled WGSL type "${member.type}"`);
    structAlign = Math.max(structAlign, info.align);
    cursor = roundUp(cursor, info.align);
    offsets[member.name] = cursor;
    cursor += info.size;
  }
  return { offsets, size: roundUp(cursor, structAlign) };
}

const cloudStruct = layout(parseStruct(wgslSource, "CloudUniforms"));

// ── Executing the renderer's own expressions ────────────────────────────────
//
// The packer cannot be imported (the renderer pulls in the whole scene graph
// through `./x.js` specifiers Node cannot resolve to `.ts`), so the two places
// where the renderer still decides something are executed as extracted source
// text over a supplied scope. That runs the renderer's REAL expression rather
// than a paraphrase of it: a mutant that changes the text changes the result.

/**
 * The right-hand side of a single `const <name> = …;` in the renderer.
 *
 * @param {string} source Renderer source.
 * @param {string} name Identifier.
 * @returns {string}
 */
function assignmentRhs(name) {
  const key = `const ${name} =`;
  const at = rendererCode.indexOf(key);
  assert.ok(at >= 0, `\`const ${name} =\` moved or changed shape`);
  const semi = rendererCode.indexOf(";", at);
  assert.ok(semi > at, `\`const ${name}\` has no terminator`);
  return rendererCode.slice(at + key.length, semi).trim();
}

const aerialLutOnRhs = assignmentRhs("aerialLutOn");
const ambientLutOnRhs = assignmentRhs("ambientLutOn");

/**
 * The renderer's real `aerialLutOn` expression, compiled once. The predicate
 * is a parameter, which is what lets the tests below substitute it; both the
 * one- and two-argument call shapes are fed, so this pins the WIRING and not
 * the predicate's arity.
 */
// eslint-disable-next-line no-new-func -- the point is to execute the renderer's OWN expression text rather than a paraphrase of it, so a mutant that edits that text changes this result
const aerialLutOnFn = new Function(
  "globeForLut",
  "qualityInputs",
  "cloudPreset",
  "shouldDefaultPhysicalAerial",
  `return (${aerialLutOnRhs});`,
);

/**
 * Evaluate that expression against the live predicate.
 *
 * @param {string|undefined} cloudAerialMode The explicit dial, if any.
 * @param {object} inputs Resolver inputs.
 * @param {object} preset Resolved preset.
 * @returns {boolean}
 */
function evaluateAerialLutOn(cloudAerialMode, inputs, preset) {
  return aerialLutOnFn(
    { cloudAerialMode },
    inputs,
    preset,
    live.shouldDefaultPhysicalAerial,
  );
}

/**
 * The object literal the renderer passes to `buildCloudQualityBlock` as this
 * frame's runtime facts, extracted and compiled once so the per-frame wiring
 * is executed as written rather than paraphrased.
 *
 * @returns {(cache:object, halfResActive:boolean, temporalActive:boolean, config:object) => object}
 */
function compileRuntimeFacts() {
  const call = rendererCode.indexOf("buildCloudQualityBlock(cloudPreset, {");
  assert.ok(call >= 0, "the `buildCloudQualityBlock` call site moved");
  const open = rendererCode.indexOf("{", call);
  let depth = 0;
  let end = -1;
  for (let i = open; i < rendererCode.length; i++) {
    if (rendererCode[i] === "{") {
      depth++;
    } else if (rendererCode[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  assert.ok(end > open, "the runtime-fact object literal is unbalanced");
  // eslint-disable-next-line no-new-func -- same contract: the renderer's real runtime-fact object literal, executed as written
  return new Function(
    "cache",
    "halfResActive",
    "temporalActive",
    "config",
    `return (${rendererCode.slice(open, end + 1)});`,
  );
}

const runtimeFactsFn = compileRuntimeFacts();

/**
 * The renderer's post-tail bit folds: the statements that read the already
 * packed flags float back out of `data` and OR extra bits into it.
 *
 * Anchored on that behaviour rather than on surrounding prose — the slice runs
 * from the first fold to the end of the statement carrying the LAST read-back
 * of that float — so editing a comment cannot move it.
 *
 * @param {number} flagIndex The flags float, derived from the packer walk.
 * @returns {{source: string, start: number}}
 */
function foldBlockSource(flagIndex) {
  const slot = `data[${flagIndex}]`;
  const start = rendererCode.indexOf(`if (aerialLutOn || ambientLutOn) {`);
  assert.ok(start >= 0, "the first LUT-coupling fold moved");
  let last = rendererCode.indexOf(slot, start);
  assert.ok(last > start, `nothing folds into ${slot} after the pack`);
  for (;;) {
    const next = rendererCode.indexOf(slot, last + 1);
    if (next < 0) {
      break;
    }
    last = next;
  }
  const end = rendererCode.indexOf("}", last);
  assert.ok(end > last, "the last fold block is unterminated");
  const source = rendererCode.slice(start, end + 1);
  const opens = (source.match(/\{/g) ?? []).length;
  const closes = (source.match(/\}/g) ?? []).length;
  assert.equal(opens, closes, "the extracted fold slice is unbalanced");
  return { source, start };
}

const JS_KEYWORDS = new Set([
  "if",
  "else",
  "let",
  "const",
  "var",
  "return",
  "true",
  "false",
  "null",
  "undefined",
  "typeof",
  "new",
  "Math",
  "Number",
  "Object",
  "console",
]);

/**
 * Identifiers a block of extracted source READS from its enclosing scope —
 * property names and names it declares itself excluded.
 *
 * @param {string} body Extracted source.
 * @returns {Set<string>}
 */
function freeIdentifiers(body) {
  const declaredHere = new Set();
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    declaredHere.add(m[1]);
  }
  const free = new Set();
  for (const m of body.matchAll(/(\.?)\b([A-Za-z_$][\w$]*)\b/g)) {
    const [, dot, name] = m;
    if (dot === "." || JS_KEYWORDS.has(name) || declaredHere.has(name)) {
      continue;
    }
    free.add(name);
  }
  return free;
}

// ── HEAD reference implementation ───────────────────────────────────────────
//
// Transcribed out of
//   git show 9f3723b0b32be87348553c3535893acdec37aeb3:packages/engine/Source/
//     Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts
// (that file's own last commit there is b7d7d1f5e9f2e5aa1308eb3bedbd07bbb6659210).
// These three fragments are what `C13-N10` deleted. They are the yardstick the
// live path has to reproduce, not a restatement of it.

/**
 * The deleted private resolver, verbatim: its own step table and its own copy
 * of the `"auto"` altitude bands.
 *
 * @param {object} inputs Resolver inputs.
 * @returns {{maxSteps:number,lightSteps:number}}
 */
function headResolveCloudQuality(inputs) {
  // A hand-set step count overrides the preset.
  const raw = inputs.rawCloudQuality;
  if (typeof raw === "number" && raw !== 64) {
    // Light steps scale with sqrt(maxSteps / 64) so a custom value gets a
    // sensible light-march count without a second knob.
    const lightSteps = Math.max(2, Math.round(6 * Math.sqrt(raw / 64)));
    return { maxSteps: raw, lightSteps };
  }
  let preset = inputs.preset ?? "auto";
  if (preset !== "low" && preset !== "medium" && preset !== "high") {
    // Auto + unknown strings → altitude-driven resolution.
    if (inputs.cameraHeightMeters >= inputs.disableAltitudeMeters) {
      preset = "low";
    } else if (inputs.cameraHeightMeters <= inputs.enableAltitudeMeters) {
      preset = "high";
    } else {
      preset = "medium";
    }
  }
  if (preset === "low") {
    return { maxSteps: 24, lightSteps: 3 };
  }
  if (preset === "high") {
    return { maxSteps: 96, lightSteps: 8 };
  }
  return { maxSteps: 48, lightSteps: 4 };
}

/**
 * The deleted inline `lightSampleScale` derivation at float 78 — a second
 * spelling of what `CloudTierPreset.lightSampleScale` already stated.
 *
 * @param {object} preset Resolved preset.
 * @returns {number}
 */
function headLightSampleScale(preset) {
  return preset.noiseSource === live.CloudNoiseSource.LIVE || preset.tier >= 3
    ? 1.0
    : 0.5;
}

/**
 * The deleted inline `qualityFlags` assembly at float 74. HEAD spelled the
 * baked-resident test as `cache.noiseBaked && cache.noise !== null` at the
 * packing site; the live path passes exactly that as `bakedNoiseResident`.
 *
 * @param {object} preset Resolved preset.
 * @param {object} runtime Per-frame facts.
 * @returns {number}
 */
function headQualityFlags(preset, runtime) {
  const noiseBakedBit =
    preset.noiseSource === live.CloudNoiseSource.BAKED &&
    runtime.bakedNoiseResident
      ? live.CLOUD_QF_NOISE_BAKED
      : 0;
  const halfResBit = runtime.halfResActive ? live.CLOUD_QF_HALF_RES : 0;
  const temporalBit = runtime.temporalActive ? live.CLOUD_QF_TEMPORAL : 0;
  const jitterBit = preset.jitterEnabled ? live.CLOUD_QF_JITTER : 0;
  const lightConeBit = preset.lightConeSampling ? live.CLOUD_QF_LIGHT_CONE : 0;
  return (
    noiseBakedBit |
    halfResBit |
    temporalBit |
    jitterBit |
    lightConeBit |
    ((Math.min(7, preset.multiScatterOctaves) & 7) <<
      live.CLOUD_QF_OCTAVES_SHIFT)
  );
}

/**
 * The deleted erosion-floor derivation at float 79.
 *
 * @param {object} config Cloud config.
 * @param {object} preset Resolved preset.
 * @returns {number}
 */
function headErosionStrength(config, preset) {
  return config.cloudErosionStrength ?? (preset.tier <= 1 ? 0.1 : 0.18);
}

/**
 * The deleted aerial-mode derivation at float 108 and bit 8: an explicit
 * `"physical"` and nothing else.
 *
 * @param {string|undefined} cloudAerialMode The explicit dial, if any.
 * @returns {boolean}
 */
function headAerialLutOn(cloudAerialMode) {
  return cloudAerialMode === "physical";
}

// ── The input sweep ─────────────────────────────────────────────────────────

const PRESET_DIALS = [
  undefined,
  "auto",
  "low",
  "medium",
  "high",
  // Unknown strings must fall through to the altitude bands, exactly as the
  // deleted resolver's `!== low && !== medium && !== high` test did — including
  // the case-variant spellings a caller is most likely to get wrong.
  "ultra",
  "",
  "AUTO",
  "Low",
];

const BANDS = [
  // No `atmosphericConditions` at all, so the module's own defaults apply.
  { label: "defaults", clouds: undefined, enable: 50_000, disable: 100_000 },
  {
    label: "custom",
    clouds: {
      volumetricEnableAltitude: 10_000,
      volumetricDisableAltitude: 20_000,
    },
    enable: 10_000,
    disable: 20_000,
  },
  // Inverted: the disable edge BELOW the enable edge. The deleted resolver
  // tested disable first, so the inversion resolves to low everywhere above
  // 50 km; a reordering of the two comparisons would break this row.
  {
    label: "inverted",
    clouds: {
      volumetricEnableAltitude: 200_000,
      volumetricDisableAltitude: 50_000,
    },
    enable: 200_000,
    disable: 50_000,
  },
];

const HEIGHTS = [
  -1000,
  0,
  9_999.9,
  10_000,
  19_999.9,
  20_000,
  49_999.9,
  50_000,
  50_000.1,
  75_000,
  99_999.9,
  100_000,
  100_000.1,
  150_000,
  1e9,
  NaN,
];

const RAW_QUALITIES = [undefined, 64, 0, -0, 1, 32, 128, 1000, NaN];

const RUNTIME_FACTS = [
  { bakedNoiseResident: false, halfResActive: false, temporalActive: false },
  { bakedNoiseResident: true, halfResActive: false, temporalActive: false },
  { bakedNoiseResident: true, halfResActive: true, temporalActive: false },
  { bakedNoiseResident: true, halfResActive: true, temporalActive: true },
];

const AERIAL_MODES = [undefined, "physical", "heuristic", "", "PHYSICAL"];

/**
 * Every (dial, band, height, rawQuality) point, as the duck-typed config the
 * renderer hands the resolver plus the resolved inputs and preset.
 *
 * @returns {{label:string,config:object,inputs:object,preset:object}[]}
 */
function sweepPoints() {
  const points = [];
  for (const dial of PRESET_DIALS) {
    for (const band of BANDS) {
      for (const height of HEIGHTS) {
        for (const raw of RAW_QUALITIES) {
          const config = {
            cloudVolumetricQuality: dial,
            cloudQuality: raw,
            atmosphericConditions: band.clouds
              ? { clouds: band.clouds }
              : undefined,
          };
          const inputs = live.buildCloudQualityInputs(config, height);
          points.push({
            label: `dial=${String(dial)} band=${band.label} h=${height} raw=${String(raw)}`,
            config,
            inputs,
            preset: live.resolveCloudPreset(inputs),
          });
        }
      }
    }
  }
  return points;
}

const SWEEP = sweepPoints();

// ── 1. The walk, and the allocation it must agree with ──────────────────────

test("the packer walk reproduces the renderer's own CLOUD_UNIFORM_FLOATS", () => {
  const declared = evalConstant("CLOUD_UNIFORM_FLOATS");
  assert.equal(
    packerWalk.finalOffset,
    declared,
    "the packer's writes and the buffer allocation have desynchronised: a row was appended to one and not the other",
  );
  // The count is not restated here — it is derived from the constant's own
  // definition — but it must remain a whole number of 16-byte rows, or the
  // uniform buffer is not bindable.
  assert.equal(declared % 4, 0, "the uniform block must stay 16-byte aligned");
});

test("every derived index agrees with the packer's own slot comments", () => {
  // The walk's self-check. The comments are NOT the source of truth for
  // anything below; if the derivation disagrees with them, one of the two is
  // wrong and a human has to look.
  const commented = packerWalk.writes.filter((w) => w.slot !== null);
  assert.ok(
    commented.length > 80,
    `only ${commented.length} packed writes carry a slot comment; the cross-check has lost its sample`,
  );
  const disagreements = commented
    .filter((w) => w.slot !== w.index)
    .map((w) => `line ${w.line}: derived ${w.index}, comment ${w.slot}`);
  assert.deepEqual(disagreements, []);
});

// ── 2. Which float each preset-derived value lands in ───────────────────────

/** block field → (packer expression, WGSL struct member) */
const PACKED_FIELDS = {
  maxSteps: ["qualityBlock.maxSteps", "maxSteps"],
  lightSteps: ["qualityBlock.lightSteps", "lightSteps"],
  qualityFlags: ["qualityBlock.qualityFlags", "qualityFlags"],
  lightSampleScale: ["qualityBlock.lightSampleScale", "lightSampleScale"],
  erosionStrength: ["qualityBlock.erosionStrength", "erosionStrength"],
};

const AERIAL_MODE_EXPRESSION = "aerialLutOn ? 1.0 : 0.0";

/** The tier lighting row, which has no WGSL member yet. */
const TIER_LIGHTING_FIELDS = {
  powderStrength: "qualityBlock.powderStrength",
  isotropicFloor: "qualityBlock.isotropicFloor",
  ambientFloor: "qualityBlock.ambientFloor",
};

test("each preset-derived pack index equals its WGSL CloudUniforms offset", () => {
  for (const [field, [expression, member]] of Object.entries(PACKED_FIELDS)) {
    assert.ok(
      member in cloudStruct.offsets,
      `CloudUniforms member ${member} disappeared`,
    );
    assert.equal(
      packedIndexOf(expression),
      cloudStruct.offsets[member] / 4,
      `${field}: the packer writes a different float than the shader reads`,
    );
  }
  assert.equal(
    packedIndexOf(AERIAL_MODE_EXPRESSION),
    cloudStruct.offsets.aerialLutMode / 4,
    "aerialLutMode: the packer writes a different float than the shader reads",
  );
});

test("the layout model applies the vec3 alignment rule (negative control)", () => {
  // Borrowed from celestial-uniform-offsets.spec.mjs. If this ever passes with
  // 12 instead of 16 the model has become a packed-layout model and every
  // offset above is checked against the wrong arithmetic.
  const { offsets, size } = layout([
    { name: "a", type: "vec3<f32>" },
    { name: "b", type: "f32" },
    { name: "c", type: "vec4<f32>" },
    { name: "d", type: "f32" },
  ]);
  assert.equal(offsets.a, 0);
  assert.equal(offsets.b, 12, "an f32 fills a vec3's tail slot");
  assert.equal(offsets.c, 16, "a vec4 must round up to its 16-byte alignment");
  assert.equal(offsets.d, 32);
  assert.equal(size, 48, "the struct rounds up to its strictest alignment");
});

test("the tier lighting row is written but has no shader consumer yet (C13-N11)", () => {
  // Recorded explicitly rather than skipped: `powderStrength`,
  // `isotropicFloor` and `ambientFloor` now have uniform slots and the packer
  // fills them, but the WGSL struct still ends before them. WebGPU permits a
  // shader struct shorter than the bound buffer, which is exactly why appending
  // the row is byte-identical — and why the row is INERT until C13-N11's
  // shader change lands. When it does, this test flips from "pending" to the
  // same offset comparison the fields above get.
  const structFloats = cloudStruct.size / 4;
  const bufferFloats = evalConstant("CLOUD_UNIFORM_FLOATS");
  assert.ok(
    bufferFloats > structFloats,
    "the tier lighting row has gained a WGSL consumer — move these three fields into PACKED_FIELDS",
  );
  const indices = Object.entries(TIER_LIGHTING_FIELDS).map(([field, expr]) => {
    const index = packedIndexOf(expr);
    assert.ok(
      index >= structFloats,
      `${field} at float ${index} is inside the shader struct but is not a member of it`,
    );
    return index;
  });
  // Contiguous, and followed by the pad that completes the 16-byte row.
  assert.deepEqual(indices, [structFloats, structFloats + 1, structFloats + 2]);
  assert.equal(bufferFloats, structFloats + 4);
});

test("every CLOUD_QF_* bit matches its WGSL twin", () => {
  // The reference implementation below uses the live `CLOUD_QF_*` exports, so
  // a renumbered bit would be invisible to it. It is not invisible here: the
  // shader's own constants are the independent source.
  const wgslBits = {};
  for (const m of wgslSource.matchAll(
    /const\s+QF_([A-Z_]+):\s*u32\s*=\s*(\d+)u/g,
  )) {
    wgslBits[m[1]] = Number(m[2]);
  }
  assert.ok(
    Object.keys(wgslBits).length >= 10,
    "the WGSL QF_ constant block moved",
  );
  for (const [name, value] of Object.entries(wgslBits)) {
    const jsName = `CLOUD_QF_${name}`;
    assert.ok(jsName in live, `${jsName} is missing from the preset module`);
    assert.equal(live[jsName], value, `${jsName} disagrees with the shader`);
  }
});

// ── 3. Propagation: a table edit reaches the packed float ───────────────────

/** preset field → (block field, dial that selects the tier) */
const PROPAGATED_FIELDS = {
  primarySteps: "maxSteps",
  lightSteps: "lightSteps",
  lightSampleScale: "lightSampleScale",
  powderStrength: "powderStrength",
  isotropicFloor: "isotropicFloor",
  ambientFloor: "ambientFloor",
};

const TIER_DIALS = { 1: "low", 2: "medium", 3: "high" };

const NEUTRAL_RUNTIME = {
  bakedNoiseResident: true,
  halfResActive: true,
  temporalActive: true,
  erosionStrengthOverride: undefined,
};

/**
 * Drive one config through the whole live seam.
 *
 * @param {object} config Duck-typed cloud config.
 * @param {number} height Camera height in metres.
 * @param {object} runtime Per-frame facts.
 * @returns {object} The quality block.
 */
function driveBlock(config, height, runtime) {
  const inputs = live.buildCloudQualityInputs(config, height);
  return live.buildCloudQualityBlock(live.resolveCloudPreset(inputs), runtime);
}

test("mutating a tier row changes the value that reaches its packed float", () => {
  // Sentinels chosen so that no field can be satisfied by another field's
  // value or by any default in the table.
  const SENTINELS = {
    primarySteps: 37,
    lightSteps: 11,
    lightSampleScale: 0.734,
    powderStrength: 0.271828,
    isotropicFloor: 0.161803,
    ambientFloor: 0.314159,
  };

  for (const [tierIndex, dial] of Object.entries(TIER_DIALS)) {
    const row = live.CLOUD_TIER_PRESETS[Number(tierIndex)];
    assert.equal(row.tier, Number(tierIndex), "the tier table was reordered");
    for (const [presetField, blockField] of Object.entries(PROPAGATED_FIELDS)) {
      const original = row[presetField];
      const sentinel = SENTINELS[presetField];
      assert.notEqual(
        original,
        sentinel,
        `the sentinel for ${presetField} collides with tier ${tierIndex}'s real value`,
      );
      try {
        row[presetField] = sentinel;
        const block = driveBlock(
          { cloudVolumetricQuality: dial },
          0,
          NEUTRAL_RUNTIME,
        );
        assert.equal(
          block[blockField],
          sentinel,
          `tier ${tierIndex}: editing ${presetField} did not reach ${blockField} — the table is not the producer`,
        );
      } finally {
        row[presetField] = original;
      }
      assert.equal(row[presetField], original, "the table was not restored");
    }
  }
});

test("tier 0's row also feeds the block, though no dial selects it", () => {
  // Tier 0 is the "pass does not run" baseline; `resolveTier` only ever
  // returns 1-3, so the full chain cannot reach it. The block builder still
  // has to read the row rather than a constant, which is what a future
  // "volumetric off" tier would depend on.
  const row = live.CLOUD_TIER_PRESETS[0];
  const original = row.primarySteps;
  try {
    row.primarySteps = 5;
    assert.equal(live.buildCloudQualityBlock(row, NEUTRAL_RUNTIME).maxSteps, 5);
  } finally {
    row.primarySteps = original;
  }
  assert.equal(row.primarySteps, original);
});

test("the packed step counts are floats 44 and 45, not 12 and 13", () => {
  // The campaign plan says slots 12 and 13. Both derivations say otherwise, and
  // they are independent: the packer walk counts 44 writes ahead of the step
  // counts, and the WGSL struct's own layout puts `maxSteps` at byte 176.
  assert.equal(packedIndexOf("qualityBlock.maxSteps"), 44);
  assert.equal(packedIndexOf("qualityBlock.lightSteps"), 45);
  assert.equal(cloudStruct.offsets.maxSteps, 176);
  assert.equal(cloudStruct.offsets.lightSteps, 180);
});

// ── 4. Byte-identity with the deleted resolver ──────────────────────────────

test("every step count reproduces the deleted resolveCloudQuality exactly", () => {
  for (const point of SWEEP) {
    const reference = headResolveCloudQuality(point.inputs);
    const block = live.buildCloudQualityBlock(point.preset, NEUTRAL_RUNTIME);
    if (!Object.is(block.maxSteps, reference.maxSteps)) {
      assert.fail(
        `${point.label}: maxSteps ${block.maxSteps} ≠ HEAD ${reference.maxSteps}`,
      );
    }
    if (!Object.is(block.lightSteps, reference.lightSteps)) {
      assert.fail(
        `${point.label}: lightSteps ${block.lightSteps} ≠ HEAD ${reference.lightSteps}`,
      );
    }
  }
});

test("lightSampleScale reproduces the deleted inline derivation exactly", () => {
  for (const point of SWEEP) {
    const block = live.buildCloudQualityBlock(point.preset, NEUTRAL_RUNTIME);
    const reference = headLightSampleScale(point.preset);
    if (!Object.is(block.lightSampleScale, reference)) {
      assert.fail(
        `${point.label}: lightSampleScale ${block.lightSampleScale} ≠ HEAD ${reference}`,
      );
    }
  }
});

test("qualityFlags and erosionStrength reproduce their deleted assembly exactly", () => {
  for (const point of SWEEP) {
    for (const facts of RUNTIME_FACTS) {
      for (const override of [undefined, 0.42]) {
        const config = { ...point.config, cloudErosionStrength: override };
        // The renderer's own runtime-fact wiring, executed as written.
        const runtime = runtimeFactsFn(
          {
            noiseBaked: facts.bakedNoiseResident,
            noise: facts.bakedNoiseResident ? {} : null,
          },
          facts.halfResActive,
          facts.temporalActive,
          config,
        );
        if (runtime.bakedNoiseResident !== facts.bakedNoiseResident) {
          assert.fail("the renderer's bakedNoiseResident wiring changed shape");
        }
        const block = live.buildCloudQualityBlock(point.preset, runtime);
        const referenceFlags = headQualityFlags(point.preset, facts);
        if (!Object.is(block.qualityFlags, referenceFlags)) {
          assert.fail(
            `${point.label}: qualityFlags ${block.qualityFlags} ≠ HEAD ${referenceFlags}`,
          );
        }
        const referenceErosion = headErosionStrength(config, point.preset);
        if (!Object.is(block.erosionStrength, referenceErosion)) {
          assert.fail(
            `${point.label}: erosionStrength ${block.erosionStrength} ≠ HEAD ${referenceErosion}`,
          );
        }
      }
    }
  }
});

// ── 5. One spelling of the altitude bands ──────────────────────────────────

test("only one module under Renderer/WebGPU compares against the altitude bands", () => {
  const band =
    /cameraHeight\w*\s*(?:>=|<=|>|<)\s*[\w.]*(?:D|d)isableAltitude\w*|cameraHeight\w*\s*(?:>=|<=|>|<)\s*[\w.]*(?:E|e)nableAltitude\w*/g;
  /** @type {Record<string, number>} */
  const census = {};
  for (const entry of fs.readdirSync(path.join(root, WEBGPU_DIR), {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !/\.(ts|js)$/.test(entry.name)) {
      continue;
    }
    const rel = path
      .join(
        path.relative(
          path.join(root, WEBGPU_DIR),
          entry.parentPath ?? entry.path,
        ),
        entry.name,
      )
      .replace(/\\/g, "/");
    const hits = (
      stripComments(read(path.join(WEBGPU_DIR, rel))).match(band) ?? []
    ).length;
    if (hits > 0) {
      census[rel] = hits;
    }
  }
  assert.deepEqual(
    Object.keys(census),
    ["WebGPUCloudTierPresets.ts"],
    "a second module compares the camera height against the cloud altitude bands",
  );
  // Two comparisons, both in `resolveTier`, plus the aerial default's reuse of
  // the SAME disable edge — which is a deliberate sharing, documented at the
  // predicate. A fourth is a duplicate.
  assert.equal(
    census["WebGPUCloudTierPresets.ts"],
    3,
    "the band comparisons in the preset module changed count; a new one is a second spelling unless it is sharing the edge deliberately",
  );
});

test("the aerial default's edge is the same edge the auto bands use", () => {
  // The behavioural form of the same property, and the one that survives a
  // refactor the grep census would miss: wherever the predicate fires under an
  // `"auto"` dial, the camera is at or above the tier bands' own disable edge.
  let fired = 0;
  for (const point of SWEEP) {
    if (point.config.cloudVolumetricQuality !== undefined) {
      continue;
    }
    if (live.shouldDefaultPhysicalAerial(point.inputs, point.preset)) {
      fired++;
      assert.ok(
        point.inputs.cameraHeightMeters >= point.inputs.disableAltitudeMeters,
        `${point.label}: the aerial default fired below the tier bands' disable edge`,
      );
    }
  }
  assert.ok(fired > 0, "the aerial default never fired across the sweep");
});

// ── 6. The aerial-mode default (C13-N20's promotion clause) ─────────────────

test("an explicit cloudAerialMode wins in both directions", () => {
  for (const point of SWEEP.slice(0, 400)) {
    assert.equal(
      evaluateAerialLutOn("physical", point.inputs, point.preset),
      true,
      `${point.label}: an explicit "physical" must turn the LUT path on anywhere`,
    );
    for (const explicit of ["heuristic", "", "PHYSICAL"]) {
      assert.equal(
        evaluateAerialLutOn(explicit, point.inputs, point.preset),
        false,
        `${point.label}: an explicit "${explicit}" must keep the analytic term, even above the band edge`,
      );
    }
  }
});

test("only an unset dial consults the altitude predicate", () => {
  // The predicate is replaced with one that would flip every answer. If any
  // explicit dial still consults it, the substitution shows up.
  const fn = aerialLutOnFn;
  const always = () => true;
  const never = () => false;
  for (const point of SWEEP.slice(0, 400)) {
    for (const explicit of ["physical", "heuristic", "", "PHYSICAL"]) {
      const withAlways = fn(
        { cloudAerialMode: explicit },
        point.inputs,
        point.preset,
        always,
      );
      const withNever = fn(
        { cloudAerialMode: explicit },
        point.inputs,
        point.preset,
        never,
      );
      assert.equal(
        withAlways,
        withNever,
        `${point.label}: an explicit "${explicit}" still consulted the predicate`,
      );
    }
    const unsetAlways = fn({}, point.inputs, point.preset, always);
    const unsetNever = fn({}, point.inputs, point.preset, never);
    assert.equal(unsetAlways, true);
    assert.equal(unsetNever, false);
  }
});

test("the aerial default's threshold is disableAltitudeMeters, inclusive", () => {
  // A NON-default edge, so what is pinned is the threshold and not the number
  // 100000. The `"high"` dial is used because it is the one input that keeps
  // the predicate satisfiable whatever tier coupling it carries.
  for (const edge of [20_000, 100_000, 250_000]) {
    const config = {
      cloudVolumetricQuality: "high",
      atmosphericConditions: {
        clouds: {
          volumetricEnableAltitude: 1_000,
          volumetricDisableAltitude: edge,
        },
      },
    };
    const at = (height) => {
      const inputs = live.buildCloudQualityInputs(config, height);
      return live.shouldDefaultPhysicalAerial(
        inputs,
        live.resolveCloudPreset(inputs),
      );
    };
    assert.equal(at(edge - 1), false, `below ${edge} the default must be off`);
    assert.equal(at(edge), true, `at exactly ${edge} the default must be on`);
    assert.equal(at(edge + 1), true, `above ${edge} the default must be on`);
    // And it is the altitude that decides, not the enable edge or the dial.
    assert.equal(at(edge * 10), true);
  }
});

test("the aerial default is the ONLY deviation from HEAD, and it is real", () => {
  // Item 3's sweep has exactly one exception, and it is derived from the live
  // predicate rather than restated, so this holds whatever form the predicate
  // takes. Everything else must be byte-identical to HEAD.
  let deviations = 0;
  for (const point of SWEEP) {
    for (const mode of AERIAL_MODES) {
      const liveOn = evaluateAerialLutOn(mode, point.inputs, point.preset);
      const headOn = headAerialLutOn(mode);
      if (liveOn === headOn) {
        continue;
      }
      deviations++;
      assert.equal(
        mode,
        undefined,
        `${point.label}: an EXPLICIT "${mode}" diverged from HEAD — only an unset dial may`,
      );
      assert.equal(
        liveOn,
        true,
        `${point.label}: the deviation must be HEAD-off → live-on, never the reverse`,
      );
      assert.equal(
        live.shouldDefaultPhysicalAerial(point.inputs, point.preset),
        true,
        `${point.label}: the deviation came from somewhere other than the predicate`,
      );
    }
  }
  assert.ok(
    deviations > 0,
    "C13-N20's promotion clause never fires anywhere in the sweep — the row's visible change is absent",
  );
});

test("the aerial bit is folded into the flags float AFTER the main assembly", () => {
  const flagIndex = packedIndexOf("qualityBlock.qualityFlags");
  const flagsWrite = rendererCode.indexOf(
    "data[offset++] = qualityBlock.qualityFlags",
  );
  assert.ok(flagsWrite >= 0, "the qualityFlags pack moved");
  const { source: foldSource, start: fold } = foldBlockSource(flagIndex);
  assert.ok(fold > flagsWrite, "the LUT-coupling fold moved ahead of the pack");

  // Execute the renderer's real fold over a buffer seeded with the block's
  // flags, and assert bit 8 tracks `aerialLutOn` and nothing else does. The
  // scope is built from the fold's OWN free identifiers, so a fold that starts
  // reading something new says so instead of throwing a ReferenceError.
  const names = [...freeIdentifiers(foldSource)];
  // eslint-disable-next-line no-new-func -- same contract: the renderer's real bit-fold block, executed as written
  const runFold = new Function(...names, foldSource);
  const floats = evalConstant("CLOUD_UNIFORM_FLOATS");
  for (const aerial of [false, true]) {
    for (const baked of [false, true]) {
      const data = new Float32Array(floats);
      const block = live.buildCloudQualityBlock(live.CLOUD_TIER_PRESETS[2], {
        ...NEUTRAL_RUNTIME,
        bakedNoiseResident: baked,
      });
      data[flagIndex] = block.qualityFlags;
      const scope = {
        data,
        aerialLutOn: aerial,
        ambientLutOn: false,
        multiDeckOn: false,
        highPrecisionOn: false,
        qualityBlock: block,
        ...Object.fromEntries(
          Object.entries(live).filter(([k]) => k.startsWith("CLOUD_QF_")),
        ),
      };
      for (const name of names) {
        assert.ok(
          name in scope,
          `the fold now reads \`${name}\`, which this harness does not model — extend the scope rather than deleting the assertion`,
        );
      }
      runFold(...names.map((name) => scope[name]));

      const bakedBitSet =
        (block.qualityFlags & live.CLOUD_QF_NOISE_BAKED) !== 0;
      assert.equal(bakedBitSet, baked, "bit 0 must track the resident bake");
      // With the ambient, multi-deck and high-precision modes all off, the
      // folds may set exactly two bits: 8 from `aerialLutOn`, and 13 from bit 0.
      const expected =
        block.qualityFlags |
        (aerial ? live.CLOUD_QF_AERIAL_LUT : 0) |
        (bakedBitSet ? live.CLOUD_QF_PLANET_DENSITY : 0);
      assert.equal(
        data[flagIndex],
        expected,
        `the folds changed a bit other than 8 and 13 (aerial=${aerial}, baked=${baked})`,
      );
      assert.equal(
        (data[flagIndex] & live.CLOUD_QF_AERIAL_LUT) !== 0,
        aerial,
        `bit 8 of float ${flagIndex} must track aerialLutOn`,
      );
      // Bit 13 is never set without bit 0 — the dependency the renderer's own
      // comment claims, checked rather than trusted.
      if ((data[flagIndex] & live.CLOUD_QF_PLANET_DENSITY) !== 0) {
        assert.ok(
          bakedBitSet,
          "bit 13 was set without bit 0: the planet-density domain cannot be selected without a resident bake",
        );
      }
    }
  }
  // The aerial mode float and bit 8 are two spellings of one decision, and the
  // ambient mode is a separate dial that must not be entangled with it.
  assert.equal(ambientLutOnRhs.includes("cloudAmbientSource"), true);
  assert.equal(ambientLutOnRhs.includes("cloudAerialMode"), false);
});

test("the bit-folds read only values the renderer declares", () => {
  // A fold that reads an identifier nothing declares is a ReferenceError at
  // runtime and a TS2304 at compile time — and it is invisible to every
  // assertion above, because those execute the fold with a supplied scope.
  const stripped = rendererCode;
  const body = foldBlockSource(
    packedIndexOf("qualityBlock.qualityFlags"),
  ).source;
  /**
   * Whether the renderer binds a name anywhere: a declaration, an entry in a
   * multi-line import list, or a typed parameter.
   *
   * @param {string} name Identifier.
   * @returns {boolean}
   */
  const isBound = (name) =>
    new RegExp(`\\b(?:const|let|var|function)\\s+${name}\\b`).test(stripped) ||
    new RegExp(`^\\s*${name},\\s*$`, "m").test(stripped) ||
    new RegExp(`\\bimport\\s+${name}\\b`).test(stripped) ||
    new RegExp(`[(,]\\s*${name}\\s*:`).test(stripped);

  // Negative control: the predicate has to be ABLE to report a name missing,
  // or the assertion below is decorative. This is the shape the defect took —
  // a fold left reading a local that the refactor deleted.
  assert.equal(isBound("noiseBakedBitThatNeverExisted"), false);

  const undeclared = [...freeIdentifiers(body)].filter((n) => !isBound(n));
  assert.deepEqual(
    undeclared,
    [],
    "the qualityFlags fold reads an identifier the renderer never binds — that is a ReferenceError at runtime and a TS2304 at compile time",
  );
});

// ── 7. Inertness mutants ───────────────────────────────────────────────────

/**
 * Copy the preset module into a fresh directory under `os.tmpdir()`, apply a
 * text mutation, import the copy, hand it to a check, and remove the sandbox.
 *
 * @param {(source:string) => string} mutate Source transform.
 * @param {(mutated:object) => Promise<void>|void} check Assertions.
 * @returns {Promise<void>}
 */
async function withMutant(mutate, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-tier-mutant-"));
  // The sandbox must be under the OS temp root, structurally, not by
  // convention: this spec writes files and a mistake here writes them into a
  // repository.
  assert.ok(
    path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep),
    `the mutant sandbox ${dir} escaped os.tmpdir()`,
  );
  try {
    const file = path.join(dir, "WebGPUCloudTierPresets.ts");
    const mutated = mutate(presetsSource);
    assert.notEqual(mutated, presetsSource, "the mutation did not apply");
    fs.writeFileSync(file, mutated);
    await check(await import(pathToFileURL(file).href));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Replace exactly one occurrence, failing loudly if the anchor moved.
 *
 * @param {string} source Text.
 * @param {string} from Anchor.
 * @param {string} to Replacement.
 * @returns {string}
 */
function replaceOnce(source, from, to) {
  const first = source.indexOf(from);
  assert.ok(first >= 0, `mutation anchor not found: ${from}`);
  assert.equal(
    source.indexOf(from, first + 1),
    -1,
    `mutation anchor is not unique: ${from}`,
  );
  return source.slice(0, first) + to + source.slice(first + from.length);
}

test("MUTANT a: step counts pinned back to the deleted literal table go inert", async () => {
  await withMutant(
    (source) =>
      replaceOnce(
        source,
        "  return CLOUD_TIER_PRESETS[resolveTier(inputs)];",
        [
          "  const mutantTier = resolveTier(inputs);",
          "  const mutantLegacy = [",
          "    [0, 0],",
          "    [24, 3],",
          "    [48, 4],",
          "    [96, 8],",
          "  ][mutantTier];",
          "  return {",
          "    ...CLOUD_TIER_PRESETS[mutantTier],",
          "    primarySteps: mutantLegacy[0],",
          "    lightSteps: mutantLegacy[1],",
          "  };",
        ].join("\n"),
      ),
    (mutant) => {
      const row = mutant.CLOUD_TIER_PRESETS[3];
      row.primarySteps = 128;
      const inputs = mutant.buildCloudQualityInputs(
        { cloudVolumetricQuality: "high" },
        0,
      );
      const block = mutant.buildCloudQualityBlock(
        mutant.resolveCloudPreset(inputs),
        NEUTRAL_RUNTIME,
      );
      assert.equal(
        block.maxSteps,
        96,
        "the mutant was supposed to restore the deleted literal table",
      );
      // The property the real module passes:
      assert.notEqual(
        block.maxSteps,
        128,
        "mutant a did not make the table edit inert",
      );
    },
  );
});

test("MUTANT b: lightSampleScale pinned back to the deleted expression goes inert", async () => {
  await withMutant(
    (source) =>
      replaceOnce(
        source,
        "    lightSampleScale: preset.lightSampleScale,",
        [
          "    lightSampleScale:",
          "      preset.noiseSource === CloudNoiseSource.LIVE || preset.tier >= 3",
          "        ? 1.0",
          "        : 0.5,",
        ].join("\n"),
      ),
    (mutant) => {
      const row = mutant.CLOUD_TIER_PRESETS[2];
      row.lightSampleScale = 0.734;
      const inputs = mutant.buildCloudQualityInputs(
        { cloudVolumetricQuality: "medium" },
        0,
      );
      const block = mutant.buildCloudQualityBlock(
        mutant.resolveCloudPreset(inputs),
        NEUTRAL_RUNTIME,
      );
      assert.equal(block.lightSampleScale, 0.5);
      assert.notEqual(
        block.lightSampleScale,
        0.734,
        "mutant b did not make the preset field inert",
      );
    },
  );
});

test("MUTANT c: the aerial default forced off removes the promotion clause", async () => {
  await withMutant(
    (source) =>
      replaceOnce(
        source,
        "  return inputs.cameraHeightMeters >= inputs.disableAltitudeMeters;",
        "  return false && inputs.cameraHeightMeters >= inputs.disableAltitudeMeters;",
      ),
    (mutant) => {
      const config = {
        cloudVolumetricQuality: "high",
        atmosphericConditions: {
          clouds: {
            volumetricEnableAltitude: 1_000,
            volumetricDisableAltitude: 20_000,
          },
        },
      };
      const inputs = mutant.buildCloudQualityInputs(config, 200_000);
      const preset = mutant.resolveCloudPreset(inputs);
      assert.equal(
        mutant.shouldDefaultPhysicalAerial(inputs, preset),
        false,
        "mutant c did not make the promotion clause unreachable",
      );
      // And with the predicate inert, the renderer's unset-dial branch returns
      // HEAD's answer everywhere — the deviation assertion above goes red.
      assert.equal(
        aerialLutOnFn({}, inputs, preset, mutant.shouldDefaultPhysicalAerial),
        headAerialLutOn(undefined),
      );
    },
  );
});

test("MUTANT d: moving the step-count pack shifts every derived index", () => {
  // The index derivation's own inertness control. If the walk were reading the
  // slot comments rather than counting, inserting a write would not move it.
  const mutated = replaceOnce(
    rendererSource,
    "    data[offset++] = qualityBlock.maxSteps; // 44 maxSteps",
    [
      "    data[offset++] = 0.0; // 44 injected",
      "    data[offset++] = qualityBlock.maxSteps; // 44 maxSteps",
    ].join("\n"),
  );
  const walk = walkPacker(mutated);
  const moved = walk.writes.filter((w) =>
    w.text.includes("qualityBlock.maxSteps"),
  );
  assert.equal(moved.length, 1);
  assert.equal(
    moved[0].index,
    45,
    "the walk did not follow the inserted write",
  );
  assert.equal(
    walk.finalOffset,
    packerWalk.finalOffset + 1,
    "the walk did not notice the buffer overrunning its allocation",
  );
});

test("MUTANT e: a second band comparison is caught by the census", () => {
  // The census's inertness control, run over text rather than the filesystem so
  // no engine file is touched.
  const band =
    /cameraHeight\w*\s*(?:>=|<=|>|<)\s*[\w.]*(?:D|d)isableAltitude\w*|cameraHeight\w*\s*(?:>=|<=|>|<)\s*[\w.]*(?:E|e)nableAltitude\w*/g;
  const before = (stripComments(presetsSource).match(band) ?? []).length;
  assert.equal(before, 3, "the preset module's band-comparison count changed");
  const resurrected = `${presetsSource}\nfunction mutantBands(inputs) {\n  return inputs.cameraHeightMeters >= inputs.disableAltitudeMeters ? 1 : 2;\n}\n`;
  const after = (stripComments(resurrected).match(band) ?? []).length;
  assert.equal(
    after,
    before + 1,
    "the census regex does not see a resurrected band comparison",
  );
});

// ── 8. The tier-lighting pin (seat ruling on lane Manwë's freeze) ──────────
//
// `C13-N10` gave `powderStrength`, `isotropicFloor` and `ambientFloor` uniform
// slots (floats 172-174) and `C13-N11` gives them a shader reader. The values
// the table carried before that were aspirational — written while nothing read
// them — and NONE of the five `powderStrength` values was the 0.5 the shader
// hard-codes at `ProceduralClouds.wgsl:2537`. Wiring the slots while keeping
// them would retune the image inside a plumbing batch; tiers 0 and 1, at powder
// 0, would delete the powder term outright (lane Manwë measured 99.52 %), and
// tier 2's `isotropicFloor` of 0.02 was measured inert across 324 stations.
//
// So all five preset objects are PINNED to the shader's pre-wiring behaviour —
// powder 0.5, both floors 0 — and per-tier tuning is its own row,
// `C13-N11-TUNE`, with an Edge capture. This guard is what makes that pin a
// fact rather than a comment: without it the pin can be reverted and every
// other test in this file stays green, which is exactly what an adversarial
// verifier demonstrated before it was added.

/** The pre-wiring behaviour of the shader, which the pin reproduces exactly. */
const PINNED_TIER_LIGHTING = Object.freeze({
  powderStrength: 0.5,
  isotropicFloor: 0,
  ambientFloor: 0,
});

/**
 * Every preset object that can reach floats 172-174: the four table rows plus
 * the `cloudQuality !== 64` escape hatch, which is a fifth preset literal and
 * would otherwise be the one path that loses the powder term.
 *
 * @param {object} mod The preset module under test.
 * @returns {{label:string, preset:object}[]}
 */
function everyPresetCarryingTierLighting(mod) {
  const rows = mod.CLOUD_TIER_PRESETS.map((preset) => ({
    label: `CLOUD_TIER_PRESETS[${preset.tier}]`,
    preset,
  }));
  // Any value other than 64 takes the escape hatch; 32 is arbitrary among them.
  rows.push({
    label: "resolveCloudPreset escape hatch (cloudQuality !== 64)",
    preset: mod.resolveCloudPreset({
      preset: undefined,
      rawCloudQuality: 32,
      cameraHeightMeters: 1000,
      enableAltitudeMeters: 50000,
      disableAltitudeMeters: 100000,
    }),
  });
  return rows;
}

test("every preset pins the tier-lighting dials to the shader's pre-wiring values", () => {
  const rows = everyPresetCarryingTierLighting(live);
  assert.equal(
    rows.length,
    5,
    "expected four tier rows plus the escape hatch to carry the tier lighting dials",
  );
  for (const { label, preset } of rows) {
    for (const [field, expected] of Object.entries(PINNED_TIER_LIGHTING)) {
      assert.ok(
        Object.is(preset[field], expected),
        `${label}.${field} is ${preset[field]}, not the pinned ${expected}. ` +
          `This batch is plumbing, not retuning: floats 172-174 become live ` +
          `when C13-N11 lands, so a value other than the shader's pre-wiring ` +
          `powder 0.5 / zero floors changes the image. Per-tier tuning is row ` +
          `C13-N11-TUNE, which owes an Edge capture.`,
      );
    }
  }
});

test("the pinned values are what the block actually packs, on every path", () => {
  // The pin is only worth anything if it survives the resolve→block chain, so
  // this asserts the packed block rather than the table a second time.
  for (const dial of ["low", "medium", "high", "auto", undefined]) {
    for (const raw of [undefined, 64, 32]) {
      const inputs = live.buildCloudQualityInputs(
        { cloudVolumetricQuality: dial, cloudQuality: raw },
        1000,
      );
      const block = live.buildCloudQualityBlock(
        live.resolveCloudPreset(inputs),
        {
          bakedNoiseResident: true,
          halfResActive: false,
          temporalActive: false,
          erosionStrengthOverride: undefined,
        },
      );
      const where = `dial=${String(dial)} rawCloudQuality=${String(raw)}`;
      assert.ok(Object.is(block.powderStrength, 0.5), `${where}: float 172`);
      assert.ok(Object.is(block.isotropicFloor, 0), `${where}: float 173`);
      assert.ok(Object.is(block.ambientFloor, 0), `${where}: float 174`);
    }
  }
});

test("MUTANT f: un-pinning any tier-lighting site goes red", async () => {
  // The verifier's M3b: revert all five sites to the aspirational values. The
  // guard above must notice. Run per-site as well, so a single drifted row is
  // caught and not only a wholesale revert.
  const perSite = [
    [
      "tier 0/1 powder back to 0",
      /powderStrength: 0\.5,/,
      "powderStrength: 0,",
    ],
    ["a floor back to 0.02", /isotropicFloor: 0,/, "isotropicFloor: 0.02,"],
    ["a floor back to 0.05", /ambientFloor: 0,/, "ambientFloor: 0.05,"],
  ];
  for (const [label, from, to] of perSite) {
    await withMutant(
      (source) => source.replace(from, to),
      (mutated) => {
        const rows = everyPresetCarryingTierLighting(mutated);
        const drifted = rows.filter(({ preset }) =>
          Object.entries(PINNED_TIER_LIGHTING).some(
            ([field, expected]) => !Object.is(preset[field], expected),
          ),
        );
        assert.ok(
          drifted.length > 0,
          `${label}: the guard did not see the un-pinned site`,
        );
      },
    );
  }
});
