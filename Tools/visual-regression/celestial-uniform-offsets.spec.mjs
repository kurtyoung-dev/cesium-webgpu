// celestial-uniform-offsets.spec.mjs — BYTE-OFFSET pin for the two celestial
// WebGPU uniform buffers: the star cube map (`CubeMapPanorama`) and the star
// sprite catalogue (`StarField`).
// @purpose Derives WGSL uniform-layout offsets for the star cubemap + sprite buffers from struct source and pins the JS packers' flat indices against them.
// @status ACTIVE
//
// WHY THIS EXISTS
// ---------------
// Both buffers have been GROWN in place, twice each, by add-only tail
// appends (`C4-CUBEMAP-PANORAMA-HDR-DECODE`, `C12-29 S6`, `C12-27`): the
// panorama went 256 -> 288 bytes at Batch 865 and the star buffer's used
// region went 112 -> 144. Every one of those edits had to touch TWO files that
// share no symbol — the WGSL struct (which fixes the offsets) and the JS/TS
// packer (which writes flat `Float32Array` indices) — and nothing in the tree
// checked that they still agree. A packer left writing at the OLD index after
// a struct edit is a SILENT defect: the shader reads a plausible number from
// the wrong slot, the pipeline validates, nothing throws, and the symptom is a
// one-sided appearance bug that reads exactly like a shader-math divergence.
// That is the class G1's `starEnergyRatio` failure was first attributed to
// (2026-08-07, Batch 873); it turned out NOT to be this, and the reason it
// could be excluded quickly is arithmetic like the check below — but the
// arithmetic was being done by hand, in a report, once. This makes it a gate.
//
// WHAT IT CHECKS, and why it is not a text comparison
// ---------------------------------------------------
// The WGSL offsets are DERIVED from the struct source by applying the WGSL
// `uniform` address-space layout rules (WGSL spec §14.4.4: alignments 4/8/16
// for f32 / vec2 / vec3+vec4, mat4x4<f32> = 4 columns of vec4 => align 16,
// size 64; a struct member's offset is round-up(previous end, align)). So a
// reordered, inserted or removed member moves the derived offsets and the
// comparison fails. The JS side is read by locating each field's OWN
// assignment expression — a unique RHS, not a position — and reading the index
// it writes to. Nothing here restates a number that also lives in a comment,
// so a stale comment cannot make it pass.
//
// Both texts are CRLF-normalised before matching (this checkout is CRLF; the
// `REPO-TOOLING-SOURCE-ANCHOR-FRAGILITY` class has cost this fleet several
// cycles).
//
// Run: node --test Tools/visual-regression/celestial-uniform-offsets.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

const PANORAMA_RENDERER =
  "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js";
const PANORAMA_WGSL =
  "packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl";
const STAR_RENDERER =
  "packages/engine/Source/Renderer/WebGPU/WebGPUStarFieldRenderer.ts";
const STAR_WGSL =
  "packages/engine/Source/Shaders/WebGPU/Catalog/StarField.wgsl";

const panoramaRenderer = read(PANORAMA_RENDERER);
const panoramaWgslFile = read(PANORAMA_WGSL);
const starRenderer = read(STAR_RENDERER);
const starWgsl = read(STAR_WGSL);

// ── WGSL uniform-address-space layout (spec §14.4.4) ───────────────────────

/** @type {Record<string, {align:number,size:number}>} */
const WGSL_TYPES = {
  f32: { align: 4, size: 4 },
  i32: { align: 4, size: 4 },
  u32: { align: 4, size: 4 },
  "vec2<f32>": { align: 8, size: 8 },
  // vec3 has size 12 but alignment 16 — the trap that makes an explicit pad
  // member necessary, and the reason `StarField.wgsl` carries `_extPad0/1`.
  "vec3<f32>": { align: 16, size: 12 },
  "vec4<f32>": { align: 16, size: 16 },
  "mat4x4<f32>": { align: 16, size: 64 },
};

const roundUp = (value, multiple) => Math.ceil(value / multiple) * multiple;

/**
 * Extract a named WGSL struct's members, in declaration order, stripping
 * comments so a `//` mention of a type name cannot be parsed as a member.
 *
 * @param {string} source WGSL text.
 * @param {string} name Struct name.
 * @returns {{name:string,type:string}[]}
 */
function parseStruct(source, name) {
  const start = source.indexOf(`struct ${name} {`);
  assert.ok(start >= 0, `struct ${name} not found`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
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
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+)$/.exec(trimmed);
    assert.ok(m, `unparsed struct member in ${name}: "${trimmed}"`);
    members.push({ name: m[1], type: m[2].trim() });
  }
  return members;
}

/**
 * Byte offset of every member, plus the struct's own size, under the WGSL
 * uniform layout rules.
 *
 * @param {{name:string,type:string}[]} members
 * @returns {{offsets:Record<string,number>,size:number,structAlign:number}}
 */
function layout(members) {
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
  return { offsets, size: roundUp(cursor, structAlign), structAlign };
}

/**
 * The flat float index a packer writes a given expression to.
 *
 * The expression is matched VERBATIM as the assignment's right-hand side, so
 * this reads the packer's real intent rather than a comment about it. Regex
 * metacharacters in the expression are escaped.
 *
 * @param {string} source Packer source.
 * @param {string} array Destination array identifier.
 * @param {string} expression Exact RHS text, without the trailing semicolon.
 * @returns {number}
 */
function packIndexOf(source, array, expression) {
  const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${array}\\[(\\d+)\\]\\s*=\\s*${escaped}\\s*;`, "g");
  const hits = [...source.matchAll(re)];
  assert.ok(
    hits.length > 0,
    `no assignment of "${expression}" into ${array}[] — the packer moved`,
  );
  const indices = new Set(hits.map((h) => Number(h[1])));
  assert.equal(
    indices.size,
    1,
    `"${expression}" is written to more than one index: ${[...indices]}`,
  );
  return Number(hits[0][1]);
}

/** The float index a `pack*(…, dst, N)` helper call writes its first float to. */
function helperPackIndexOf(source, callPrefix) {
  const escaped = callPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`${escaped}\\s*,\\s*(\\d+)\\s*\\)`).exec(source);
  assert.ok(m, `helper pack call "${callPrefix}" moved or changed shape`);
  return Number(m[1]);
}

// ── CubeMapPanorama ────────────────────────────────────────────────────────
//
// The PRODUCTION WGSL for this pipeline is the template literal embedded in
// the renderer (the `.wgsl` file is kept byte-equivalent for tooling and debug
// pages). Both are checked, and they are required to agree — an offset pin
// that read only the tooling copy would be pinning a file the GPU never sees.

const PANORAMA_STRUCT = "CubeMapPanoramaUniforms";

/**
 * field -> the packer expression that writes its FIRST float.
 * `params` and the two tail vec4s are keyed on their `.x` component.
 */
const PANORAMA_FIELD_EXPRESSIONS = {
  params: "uniformState.entireFrustum.y",
  starModulation: "starModulation?.x ?? 0.0",
  solarGlare: "solarGlare?.x ?? 0.0",
  solarGlareCurve: "solarGlareCurve?.x ?? 1.0",
};

/** field -> the `pack*` helper call whose offset argument places it. */
const PANORAMA_HELPER_PACKS = {
  projection: "packMatrix4(uniformState.projection, uniformData",
  viewRotation: "packMatrix3As4x4(viewRotation, uniformData",
  panoramaTransform: "packMatrix3As4x4(transform, uniformData",
};

test("CubeMapPanorama: the embedded production WGSL and the .wgsl file agree on the struct", () => {
  const embedded = parseStruct(panoramaRenderer, PANORAMA_STRUCT);
  const standalone = parseStruct(panoramaWgslFile, PANORAMA_STRUCT);
  assert.deepEqual(
    standalone,
    embedded,
    "the tooling .wgsl copy has drifted from the production embedded copy",
  );
});

test("CubeMapPanorama: every JS pack index equals its WGSL byte offset / 4", () => {
  const { offsets, size } = layout(
    parseStruct(panoramaRenderer, PANORAMA_STRUCT),
  );

  for (const [field, call] of Object.entries(PANORAMA_HELPER_PACKS)) {
    assert.ok(field in offsets, `struct member ${field} disappeared`);
    assert.equal(
      helperPackIndexOf(panoramaRenderer, call),
      offsets[field] / 4,
      `${field}: packer writes a different index than the WGSL offset`,
    );
  }

  for (const [field, expression] of Object.entries(
    PANORAMA_FIELD_EXPRESSIONS,
  )) {
    assert.ok(field in offsets, `struct member ${field} disappeared`);
    assert.equal(
      packIndexOf(panoramaRenderer, "uniformData", expression),
      offsets[field] / 4,
      `${field}: packer writes a different index than the WGSL offset`,
    );
  }

  // `params.w` is the sky-brightness scalar the star modulation reads. It is
  // the LAST component of a vec4, so a one-slot drift here is the exact defect
  // shape this file exists for: it would silently swap sky brightness with the
  // modulation curve's inflection.
  assert.equal(
    packIndexOf(
      panoramaRenderer,
      "uniformData",
      "panorama?._skyBrightness ?? 1.0",
    ),
    offsets.params / 4 + 3,
  );
  // ...and `hdr.x` is written by a multi-line ternary, so it is anchored on
  // its own index rather than its RHS text.
  const hdrIndex =
    /uniformData\[(\d+)\] =\s*\n\s*frameState\?\.useHDR === true/.exec(
      panoramaRenderer,
    );
  assert.ok(hdrIndex, "the HDR gamma pack moved or changed shape");
  assert.equal(Number(hdrIndex[1]), offsets.hdr / 4);

  // The allocation must cover the struct and stay 16-aligned. Over-allocation
  // is fine (and deliberate — the tail is headroom for the next add-only
  // append); UNDER-allocation is a validation error at bind time.
  const declared = /const UNIFORM_BUFFER_SIZE = (\d+);/.exec(panoramaRenderer);
  assert.ok(declared, "UNIFORM_BUFFER_SIZE moved");
  const allocated = Number(declared[1]);
  assert.ok(
    allocated >= size,
    `UNIFORM_BUFFER_SIZE ${allocated} is smaller than the struct (${size})`,
  );
  assert.equal(allocated % 16, 0, "uniform buffers must stay 16-aligned");
  assert.match(
    panoramaRenderer,
    /const UNIFORM_FLOAT_COUNT = UNIFORM_BUFFER_SIZE \/ 4;/,
    "the float count must be derived from the byte size, never restated",
  );
});

// ── StarField sprites ──────────────────────────────────────────────────────

const STAR_STRUCT = "Uniforms";

const STAR_FIELD_EXPRESSIONS = {
  pointSize: "angularRadius * Math.abs(proj[0])",
  intensityScale: "effectiveIntensityScale",
  minPointSize: "starField._minPointSize",
  zenithTransmittance: "zenithT.x",
  cameraUpTeme: "scratchCamUpTeme.x",
  solarGlare: "sun.x",
  solarGlareCurve: "glare.angularCore",
};

test("StarField: every TS pack index equals its WGSL byte offset / 4", () => {
  const members = parseStruct(starWgsl, STAR_STRUCT);
  const { offsets, size } = layout(members);

  assert.equal(
    helperPackIndexOf(
      starRenderer,
      "Matrix4.pack(scratchVPNoTranslation, uniformData",
    ),
    offsets.viewProjectionNoTranslation / 4,
  );

  for (const [field, expression] of Object.entries(STAR_FIELD_EXPRESSIONS)) {
    assert.ok(field in offsets, `struct member ${field} disappeared`);
    assert.equal(
      packIndexOf(starRenderer, "uniformData", expression),
      offsets[field] / 4,
      `${field}: packer writes a different index than the WGSL offset`,
    );
  }

  // The two explicit vec3 pads exist ONLY to make the vec3 alignment rule
  // visible in the source. If they are removed the layout does not change
  // (WGSL would insert the same padding) but the packer's literal indices
  // would no longer look derivable — so they are pinned as written, and the
  // packer must be writing zero into them rather than leaving stale data.
  assert.equal(offsets._extPad0 / 4, offsets.zenithTransmittance / 4 + 3);
  assert.equal(offsets._extPad1 / 4, offsets.cameraUpTeme / 4 + 3);

  const declared = /const STAR_UNIFORM_BUFFER_SIZE = (\d+);/.exec(starRenderer);
  assert.ok(declared, "STAR_UNIFORM_BUFFER_SIZE moved");
  const allocated = Number(declared[1]);
  assert.ok(
    allocated >= size,
    `STAR_UNIFORM_BUFFER_SIZE ${allocated} is smaller than the struct (${size})`,
  );
  assert.equal(allocated % 16, 0);
});

// ── The layout model itself has to be able to be wrong ─────────────────────

test("the WGSL layout model reproduces the offsets the shaders document", () => {
  // Both shaders carry their C12-27 tail offsets in comments. Those comments
  // are NOT the source of truth for the tests above (which derive everything),
  // but if the derivation disagreed with them one of the two is wrong and a
  // human needs to look. This is the derivation's own self-check.
  const panorama = layout(parseStruct(panoramaRenderer, PANORAMA_STRUCT));
  assert.equal(panorama.offsets.projection, 0);
  assert.equal(panorama.offsets.viewRotation, 64);
  assert.equal(panorama.offsets.panoramaTransform, 128);
  assert.equal(panorama.offsets.params, 192);
  assert.equal(panorama.offsets.starModulation, 208);
  assert.equal(panorama.offsets.hdr, 224);
  assert.equal(panorama.offsets.solarGlare, 240);
  assert.equal(panorama.offsets.solarGlareCurve, 256);
  assert.equal(panorama.size, 272);

  const star = layout(parseStruct(starWgsl, STAR_STRUCT));
  assert.equal(star.offsets.viewProjectionNoTranslation, 0);
  assert.equal(star.offsets.pointSize, 64);
  assert.equal(star.offsets.intensityScale, 72);
  assert.equal(star.offsets.minPointSize, 76);
  assert.equal(star.offsets.zenithTransmittance, 80);
  assert.equal(star.offsets.cameraUpTeme, 96);
  // The two comments in `StarField.wgsl` say `112..127` and `128..143`.
  assert.equal(star.offsets.solarGlare, 112);
  assert.equal(star.offsets.solarGlareCurve, 128);
  assert.equal(star.size, 144);
});

test("the layout model applies the vec3 alignment rule (negative control)", () => {
  // If this ever passes with 12 instead of 16 the model has silently become a
  // packed-layout model and every offset above would be checked against the
  // wrong arithmetic.
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
