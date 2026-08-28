// model-metadata-variant-key.spec.mjs — the model pipeline cache key must carry
// the generated-chunk CLASS axis, not just the material identity.
// @purpose Pins that two metadata (or customShader) classes at one material identity build distinct model pipeline keys, that the fold is byte-identical when no generated chunk applies, and that the fold is live rather than inert.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no build, no adapter.
//
// WHY THIS EXISTS
// ---------------
// A model pipeline is identified by more than its material. Two primitives of a
// single model can share an alpha mode, a face orientation and a material define
// mask and still need different compiled modules, because the metadata and
// customShader chunks prepended to the shader are generated per class: the
// metadata chunk declares a struct named for the real metadata class with its
// offsets and scales baked in, and the customShader chunk carries the inlined
// user body with its uniforms.
//
// The shader MODULE cache already separated those variants — it folds both class
// hashes into the module key. The PIPELINE maps did not. So the second class to
// arrive on a model whose material identity already had a pipeline was served
// the first class's pipeline, and with it the first class's module.
//
// This is the aliasing shape the fork treats as unreportable, because it RAISES
// the cache hit rate: nothing fails, no counter drops, and the wrong pipeline is
// simply served. It is also broad — every model pipeline map keys through the
// same function, so the display, depth-write, silhouette, pick, snap, hover,
// velocity, classification and capture maps were all affected. Only the
// metadata-pick map escaped, because it folds its own picked-property hash at
// its call site.
//
// WHAT IT PINS
// ------------
//   A. THE FOLD DISCRIMINATES. Same material identity, different class hash =>
//      different keys, on both the metadata and the customShader axis.
//   B. THE FOLD IS FREE BY DEFAULT. For a primitive with no generated chunk the
//      key is returned EXACTLY as the pre-fix form produced it — same value and
//      same JavaScript type, so a numeric key does not silently become a string
//      and change Map identity for every model in the scene.
//   C. THE FOLD IS LIVE. The discrimination contract is re-run against two
//      mutants of the fold's own source and must FAIL against both: an ABSENCE
//      mutant that drops the suffix, and an INERTNESS mutant that still computes
//      both hashes and then discards them. A spec that survives its inert mutant
//      has asserted nothing about the code being reached.
//   D. THE FOLD IS THE ONLY HOME. The pipeline cache must delegate to it rather
//      than spelling the axis inline, and every pipeline map must key through
//      the one method that applies it.
//
// Run: node --test Tools/visual-regression/model-metadata-variant-key.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const engineWebGPU = path.join(root, "packages/engine/Source/Renderer/WebGPU");

// Anchors below are written with LF; the working tree is CRLF on Windows.
const readSource = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const leafSource = readSource(
  path.join(engineWebGPU, "WebGPUModelMetadataVariantKey.ts"),
);
const cacheSource = readSource(
  path.join(engineWebGPU, "WebGPUModelPipelineCache.ts"),
);

// The leaf imports the real define registry. Rewiring that ONE specifier to an
// absolute URL lets a mutated copy be imported from a data: URL while still
// loading the genuine bit values, so a mutant cannot pass by getting the masks
// wrong in its own favour.
const DEFINES_SPECIFIER = '"./WebGPUShaderDefines.js"';
const definesUrl = pathToFileURL(
  path.join(engineWebGPU, "WebGPUShaderDefines.ts"),
).href;

async function importLeafSource(source) {
  const rewired = source.replace(DEFINES_SPECIFIER, JSON.stringify(definesUrl));
  assert.notEqual(
    rewired,
    source,
    "the ShaderDefines import specifier moved; the rewire is a no-op",
  );
  const { code } = await transform(rewired, {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
  );
}

const real = await importLeafSource(leafSource);
const {
  buildModelMetadataVariantKey,
  MODEL_METADATA_CLASS_DEFINE_MASK,
  MODEL_CUSTOM_SHADER_CLASS_DEFINE_MASK,
} = real;

// The historical form, written out so byte-identity is checked against the real
// pre-fix expression rather than against the new code's own opinion of it.
const preFixKey = (key, slotMode) => (slotMode === 2 ? `${key}:m34` : key);

// The single line the mutants below rewrite.
const RETURN_LINE =
  "  return `${transportKey}#${metadataHash}#${customShaderHash}`;";

/**
 * The discrimination contract, as a function of the fold, so the identical
 * assertions run against the real fold and against its mutants.
 */
function runFoldContract(fold) {
  const metadataMd = MODEL_METADATA_CLASS_DEFINE_MASK;
  const customMd = MODEL_CUSTOM_SHADER_CLASS_DEFINE_MASK;

  // Two primitives of ONE model: identical material identity, identical
  // topology, identical transport — and different metadata classes. Before the
  // fold these produced the same key and shared one pipeline and one module.
  const classA = fold(41, metadataMd, 0, 0xaaaaaaaa, 0);
  const classB = fold(41, metadataMd, 0, 0xbbbbbbbb, 0);
  assert.notEqual(
    classA,
    classB,
    "two metadata classes at one material identity must not share a pipeline key",
  );

  // The same on the customShader axis.
  assert.notEqual(
    fold(41, customMd, 0, 0, 0x11111111),
    fold(41, customMd, 0, 0, 0x22222222),
    "two customShader classes at one material identity must not share a key",
  );

  // And the two axes are independent: a metadata class must not be able to
  // impersonate a customShader class.
  assert.notEqual(
    fold(41, metadataMd | customMd, 0, 1, 0),
    fold(41, metadataMd | customMd, 0, 0, 1),
    "the metadata and customShader class axes must not collapse into each other",
  );

  // Determinism: the same inputs always produce the same key.
  assert.equal(
    fold(41, metadataMd, 0, 0xaaaaaaaa, 0),
    classA,
    "the key must be deterministic for identical inputs",
  );
}

/** Assert `re` matches `source`, and that it STOPS matching a mutated copy. */
function pinWithMutant(source, re, mutate, label) {
  assert.match(source, re, `missing: ${label}`);
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutation was a no-op for: ${label}`);
  assert.doesNotMatch(
    mutated,
    re,
    `the check for "${label}" does not actually detect its own mutant`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// A. The fold discriminates
// ─────────────────────────────────────────────────────────────────────────────

test("A1 the gate masks are the bits that admit a generated chunk", () => {
  // 1<<18 metadata, 1<<19 property textures, 1<<20 property tables.
  assert.equal(
    MODEL_METADATA_CLASS_DEFINE_MASK,
    (1 << 18) | (1 << 19) | (1 << 20),
  );
  // 1<<23 customShader fragment, 1<<24 customShader vertex.
  assert.equal(MODEL_CUSTOM_SHADER_CLASS_DEFINE_MASK, (1 << 23) | (1 << 24));
  // Every gating bit must sit below bit 29, or it would not survive the
  // pipeline cache's own `md << 3` packing and could not reach this fold.
  const all =
    MODEL_METADATA_CLASS_DEFINE_MASK | MODEL_CUSTOM_SHADER_CLASS_DEFINE_MASK;
  assert.equal(all & ~0x1fffffff, 0);
});

test("A2 the discrimination contract holds", () => {
  runFoldContract(buildModelMetadataVariantKey);
});

test("A3 the MAT transport still discriminates, and composes with the class", () => {
  const md = MODEL_METADATA_CLASS_DEFINE_MASK;
  // Plain metadata vs the widened MAT3/MAT4 transport, same class.
  assert.notEqual(
    buildModelMetadataVariantKey(41, md, 0, 7, 0),
    buildModelMetadataVariantKey(41, md, 2, 7, 0),
    "the MAT transport must remain a distinct variant",
  );
  // The historical suffix is still present and still precedes the class.
  assert.match(
    String(buildModelMetadataVariantKey(41, md, 2, 7, 0)),
    /:m34#/,
    "the transport suffix must still be applied before the class hashes",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// B. The fold is free by default
// ─────────────────────────────────────────────────────────────────────────────

test("B1 a primitive with no generated chunk keeps the exact pre-fix key", () => {
  for (const slotMode of [0, 1, 2]) {
    for (const key of [0, 41, 4096, "41:tri"]) {
      // Hashes are deliberately NON-ZERO here: a primitive with no generated
      // chunk must have them gated away, not merely happen to have none.
      const folded = buildModelMetadataVariantKey(
        key,
        0,
        slotMode,
        0xdeadbeef,
        0xfeedface,
      );
      const expected = preFixKey(key, slotMode);
      assert.equal(folded, expected, `value changed for ${key}/${slotMode}`);
      assert.equal(
        typeof folded,
        typeof expected,
        `TYPE changed for ${key}/${slotMode}; Map identity would change`,
      );
    }
  }
});

test("B2 a metadata primitive whose class hash is zero is also unchanged", () => {
  const md = MODEL_METADATA_CLASS_DEFINE_MASK;
  assert.equal(buildModelMetadataVariantKey(41, md, 0, 0, 0), 41);
  assert.equal(typeof buildModelMetadataVariantKey(41, md, 0, 0, 0), "number");
});

// ─────────────────────────────────────────────────────────────────────────────
// C. The fold is live — the contract must fail against its own mutants
// ─────────────────────────────────────────────────────────────────────────────

test("C0 the mutation anchor is present exactly once", () => {
  assert.equal(
    leafSource.split(RETURN_LINE).length - 1,
    1,
    "the fold's return line moved; both mutants below would be no-ops",
  );
});

test("C1 an ABSENCE mutant (suffix dropped) fails the contract", async () => {
  const mutated = leafSource.replace(RETURN_LINE, "  return transportKey;");
  assert.notEqual(mutated, leafSource);
  const { buildModelMetadataVariantKey: absent } =
    await importLeafSource(mutated);
  assert.throws(
    () => runFoldContract(absent),
    /must not share/,
    "the contract passes with the class suffix dropped, so it tests nothing",
  );
});

test("C2 an INERTNESS mutant (hashes computed, then discarded) fails", async () => {
  // Both hashes are still computed, still gated, still correct. Only the RESULT
  // is discarded. This is the mutant a source-text grep for the hash names
  // cannot tell apart from the real fold.
  const inert = [
    "  void metadataHash;",
    "  void customShaderHash;",
    "  return transportKey;",
  ].join("\n");
  const mutated = leafSource.replace(RETURN_LINE, inert);
  assert.notEqual(mutated, leafSource);
  assert.match(
    mutated,
    /const metadataHash =/,
    "the inert mutant must still COMPUTE the hashes, or it is just C1",
  );
  const { buildModelMetadataVariantKey: dead } =
    await importLeafSource(mutated);
  assert.throws(
    () => runFoldContract(dead),
    /must not share/,
    "the contract passes when the computed hashes are discarded",
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// D. One enforceable home
// ─────────────────────────────────────────────────────────────────────────────

test("D1 the pipeline cache delegates to the fold", () => {
  pinWithMutant(
    cacheSource,
    /return buildModelMetadataVariantKey\(\n\s*key,\n\s*md,\n\s*this\._metadataSlotMode\(md\),\n\s*this\._metadataClassHash,\n\s*this\._customShaderClassHash,\n\s*\)/,
    (s) =>
      s.replace(
        "      this._metadataClassHash,\n      this._customShaderClassHash,\n",
        "",
      ),
    "_metadataVariantKey forwards both class hashes to the home",
  );
  assert.match(
    cacheSource,
    /import \{ buildModelMetadataVariantKey \} from "\.\/WebGPUModelMetadataVariantKey\.js";/,
    "the cache must import the home",
  );
});

test("D2 the cache never builds the variant suffix inline", () => {
  // Comments may still discuss `:m34`; no expression may construct it.
  assert.doesNotMatch(
    cacheSource.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ""),
    /\$\{[^}]*\}:m34/,
    "the cache builds the transport suffix inline instead of via the home",
  );
});

test("D3 every pipeline map keys through the one method that folds", () => {
  const uses = cacheSource.match(/this\._metadataVariantKey\(/g) ?? [];
  const assignments =
    cacheSource.match(/const key = this\._metadataVariantKey\(/g) ?? [];
  assert.ok(
    uses.length >= 13,
    `expected at least the thirteen keyed pipeline maps, saw ${uses.length}`,
  );
  assert.equal(
    assignments.length,
    uses.length,
    "a call to _metadataVariantKey does not produce the key it is keyed by",
  );
});
