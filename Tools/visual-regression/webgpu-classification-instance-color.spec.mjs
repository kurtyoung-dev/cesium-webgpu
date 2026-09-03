// webgpu-classification-instance-color.spec.mjs — the colour a WebGPU
// classification primitive shades with must be the primitive's own colour, on
// a per-instance appearance as well as on a material-bearing one.
//
// @purpose Drives the real WebGPU ground-primitive colour packer over a real BatchTable and a real ColorGeometryInstanceAttribute, and requires the four uniform floats the classification fragment shader returns to quantize to the instance colour rather than to the uniform's untouched fallback.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no GPU, no build.
//
// WHAT THIS IS ABOUT
// ------------------
// The WebGPU classifier shades from a uniform. `colorVS` copies uniform floats
// 24-27 into `o.col`, and `dsColorFS` returns `i.col` unchanged on its
// material-type-0 fast path, so those four floats ARE the classification
// colour that reaches the framebuffer.
//
// WebGL reads that colour from two mutually exclusive places. A material-
// bearing appearance keeps it in `appearance.material.uniforms.color`. A
// `PerInstanceColorAppearance` — the appearance `GroundPrimitive` installs by
// default — has no material at all (`PerInstanceColorAppearance.js` sets
// `this.material = undefined`), and `ShadowVolumeAppearanceFS` reads its colour
// through the `PER_INSTANCE_COLOR` varying fed by the instance's
// `ColorGeometryInstanceAttribute`.
//
// The WebGPU packer read only the first of the two. A default GroundPrimitive
// therefore resolved `undefined` and every component fell through to the
// uniform's own per-component fallback — (1, 0, 0, 0.5), opaque-ish red — so
// the classifier painted red regardless of the colour the caller asked for.
//
// WHAT IS ACTUALLY CHECKED
// ------------------------
//   - THE COLOUR REACHES THE SHADING OUTPUT. `packClassificationColor` writes
//     the four floats; the assertions quantize them to 8 bits, which is what a
//     non-HDR framebuffer stores, and compare against the byte triple the
//     caller's `Color` produces. A red fallback fails.
//   - BOTH PER-INSTANCE SOURCES. The batch table (the usual state: the
//     becoming-ready flow releases `geometryInstances` before the first WebGPU
//     command build) AND the raw geometry instances (the pre-ready state).
//   - THE REFERENCE IS PRODUCED, NOT ASSERTED. The batch-table leg stores and
//     reads through a REAL `BatchTable`, so its unscaled `UNSIGNED_BYTE`
//     return range is the engine's answer rather than this spec's belief about
//     it; the attribute is a REAL `ColorGeometryInstanceAttribute`.
//   - THE MATERIAL PATH IS UNCHANGED. A material-bearing appearance still wins.
//   - THE FALLBACK IS UNCHANGED. A primitive carrying neither source still
//     packs the same four floats it packed before.
//   - INERTNESS. The per-instance resolution is made unreachable rather than
//     deleted, and the two per-instance assertions have to go red while the
//     material and fallback assertions stay green.
//
// WHAT IS NOT CHECKED HERE
// ------------------------
// No pixel is measured, and nothing here says the classified FOOTPRINT is
// right. The classifier's shadow volume is clipped only by its own
// rasterization and a depth-is-nonzero test, so an oblique view paints the
// volume's silhouette rather than the draped surface. That is a separate
// defect with a separate reference (WebGL's stencil pass plus its
// `CULL_FRAGMENTS` extent test) and is not in this file's scope.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle, mutateOrFail } from "./lib/engine-stub-bundler.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const engineSource = path.join(root, "packages/engine/Source");
const engineCore = path.join(engineSource, "Core");

const ENTRY_PATH = path.join(
  engineSource,
  "Renderer/WebGPU/WebGPUGroundPrimitiveInstanceColor.ts",
);
const BATCH_TABLE_PATH = path.join(engineSource, "Scene/BatchTable.js");
const COLOR_ATTRIBUTE_PATH = path.join(
  engineCore,
  "ColorGeometryInstanceAttribute.js",
);
const CARTESIAN4_PATH = path.join(engineCore, "Cartesian4.js");
const COLOR_PATH = path.join(engineCore, "Color.js");
const PER_INSTANCE_APPEARANCE_PATH = path.join(
  engineSource,
  "Scene/PerInstanceColorAppearance.js",
);

const readLf = async (file) =>
  (await readFile(file, "utf8")).split("\r\n").join("\n");

const ENTRY_SOURCE = await readLf(ENTRY_PATH);

/**
 * Bundles the colour packer, optionally through a source mutation.
 *
 * Every dependency it takes lives in `Core/`, so the whole directory stays
 * real: stubbing `ComponentDatatype` would replace the datatype comparison
 * that decides the [0, 255] -> [0, 1] scale with a Proxy that compares equal
 * to nothing.
 *
 * @param {Function} [mutate] Source rewrite.
 * @param {string} [label] Name used in the did-it-change assertion.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
function loadPacker(mutate, label) {
  return bundle({
    path: ENTRY_PATH,
    source: ENTRY_SOURCE,
    real: [],
    realDir: engineCore,
    mutate,
    label,
  });
}

/**
 * Loads one engine module with `Core/` kept real and a named allowlist beyond
 * it.
 *
 * @param {string} modulePath Absolute entry path.
 * @param {string[]} real Basenames outside `Core/` to keep real.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
async function loadEngineModule(modulePath, real = []) {
  return bundle({
    path: modulePath,
    source: await readLf(modulePath),
    real,
    realDir: engineCore,
  });
}

const { packClassificationColor, resolveClassificationColor } =
  await loadPacker();
const { default: BatchTable } = await loadEngineModule(BATCH_TABLE_PATH, [
  // The datatype enum decides the batch table's storage width and its unpack
  // path; a Proxy in its place silently selects neither branch.
  "PixelDatatype",
  "WebGLConstants",
]);
const { default: ColorGeometryInstanceAttribute } =
  await loadEngineModule(COLOR_ATTRIBUTE_PATH);
const { default: Cartesian4 } = await loadEngineModule(CARTESIAN4_PATH);
const { default: Color } = await loadEngineModule(COLOR_PATH);
const PER_INSTANCE_APPEARANCE_SOURCE = await readLf(
  PER_INSTANCE_APPEARANCE_PATH,
);

// The classification colour the C15-G7 evidence run requested, and the drape
// WebGL painted with it. Kept as the fixture so a regression is comparable
// against a measured frame rather than against an invented triple.
const REQUESTED = Object.freeze({
  red: 1.0,
  green: 0.02,
  blue: 0.85,
  alpha: 1,
});

// Floats 24-27 of the ground-primitive uniform buffer.
const COLOR_OFFSET = 24;

// The four floats the uniform keeps when nothing resolves.
const FALLBACK_BYTES = Object.freeze([255, 0, 0, 128]);

/**
 * Quantizes packed floats the way an 8-bit colour attachment stores them.
 *
 * @param {Float32Array} data The uniform staging array.
 * @returns {number[]} Four bytes.
 */
function packedBytes(data) {
  return [0, 1, 2, 3].map((i) =>
    Math.round(Math.min(1, Math.max(0, data[COLOR_OFFSET + i])) * 255),
  );
}

/**
 * Packs one primitive's colour into a fresh staging array.
 *
 * @param {object} primitive The classification primitive.
 * @param {Function} pack The packer under test.
 * @returns {number[]} The four quantized bytes.
 */
function packBytes(primitive, pack = packClassificationColor) {
  const data = new Float32Array(COLOR_OFFSET + 4);
  pack(data, COLOR_OFFSET, primitive);
  return packedBytes(data);
}

/**
 * A real `ColorGeometryInstanceAttribute` for the requested colour.
 *
 * @returns {object} The attribute.
 */
function requestedColorAttribute() {
  return ColorGeometryInstanceAttribute.fromColor(
    new Color(REQUESTED.red, REQUESTED.green, REQUESTED.blue, REQUESTED.alpha),
  );
}

/**
 * The byte triple the engine's own float -> byte conversion produces for the
 * requested colour. Derived from the real attribute rather than written out,
 * so a change to that conversion moves the expectation with it.
 *
 * @returns {number[]} Four bytes.
 */
function requestedBytes() {
  return Array.from(requestedColorAttribute().value);
}

/**
 * Builds a primitive whose inner link owns a REAL batch table carrying the
 * requested colour as its per-instance `color` attribute — the shape a
 * `GroundPrimitive` presents once its inner `Primitive` has become ready and
 * released its geometry instances.
 *
 * @param {object} [appearance] Appearance to hang on the outer wrapper.
 * @returns {object} The primitive.
 */
function primitiveWithBatchTable(appearance = { material: undefined }) {
  const attribute = requestedColorAttribute();
  const batchTable = new BatchTable(
    // The two fields `BatchTable`'s constructor reads off a context. Nothing
    // in the read path touches a device.
    { floatingPointTexture: true, limits: { maximumTextureSize: 4096 } },
    [
      {
        functionName: "czm_batchTable_color",
        componentDatatype: attribute.componentDatatype,
        componentsPerAttribute: attribute.componentsPerAttribute,
        normalize: attribute.normalize,
      },
    ],
    1,
  );
  const value = attribute.value;
  batchTable.setBatchedAttribute(
    0,
    0,
    new Cartesian4(value[0], value[1], value[2], value[3]),
  );
  return {
    appearance,
    _primitive: {
      _primitive: {
        _batchTable: batchTable,
        _batchTableAttributeIndices: { color: 0 },
      },
    },
  };
}

/**
 * Builds a primitive that still holds its raw geometry instances — the shape
 * before the inner primitive's batch table exists.
 *
 * @returns {object} The primitive.
 */
function primitiveWithGeometryInstances() {
  return {
    appearance: { material: undefined },
    geometryInstances: [{ attributes: { color: requestedColorAttribute() } }],
  };
}

test("PerInstanceColorAppearance carries no material, so the material lookup alone cannot find its colour", () => {
  assert.match(
    PER_INSTANCE_APPEARANCE_SOURCE,
    /this\.material = undefined;/,
    "PerInstanceColorAppearance no longer declares a material-less " +
      "appearance — the premise this whole file rests on has moved",
  );
});

test("a batch-table-backed per-instance colour reaches the shading output", () => {
  assert.deepEqual(packBytes(primitiveWithBatchTable()), requestedBytes());
});

test("a batch-table-backed per-instance colour is not the fallback", () => {
  assert.notDeepEqual(
    packBytes(primitiveWithBatchTable()),
    FALLBACK_BYTES,
    "the classifier packed its untouched fallback instead of the " +
      "primitive's own colour",
  );
});

test("a pre-ready primitive resolves its colour from the geometry instances", () => {
  assert.deepEqual(
    packBytes(primitiveWithGeometryInstances()),
    requestedBytes(),
  );
});

test("an UNSIGNED_BYTE attribute is scaled into the [0, 1] uniform range", () => {
  const resolved = resolveClassificationColor(primitiveWithBatchTable());
  for (const channel of ["red", "green", "blue", "alpha"]) {
    assert.ok(
      resolved[channel] >= 0 && resolved[channel] <= 1,
      `${channel} left the [0, 1] range: ${resolved[channel]}`,
    );
  }
  assert.equal(resolved.red, 1);
});

test("a material-bearing appearance still wins over the per-instance attribute", () => {
  const primitive = primitiveWithBatchTable({
    material: { uniforms: { color: { red: 0, green: 1, blue: 0, alpha: 1 } } },
  });
  assert.deepEqual(packBytes(primitive), [0, 255, 0, 255]);
});

test("a primitive carrying neither source keeps the documented fallback", () => {
  assert.deepEqual(packBytes({ appearance: undefined }), FALLBACK_BYTES);
});

// ── INERTNESS ───────────────────────────────────────────────────────────────
//
// The per-instance resolution is made unreachable rather than deleted: the
// wrapper walk still compiles and is still called, it just cannot yield a
// link. Both per-instance assertions must go red, and the material and
// fallback assertions must survive — a mutant that broke everything would not
// tell us which behaviour this file actually pins.

const MAKE_PER_INSTANCE_UNREACHABLE = (source) =>
  source.replace(
    "  const chain = wrapperChain(primitive);",
    "  const chain = false && wrapperChain(primitive) ? [] : [];",
  );

test("inertness: an unreachable per-instance resolution fails the per-instance assertions", async () => {
  const { packClassificationColor: inertPack } = await loadPacker(
    (source) =>
      mutateOrFail(
        source,
        MAKE_PER_INSTANCE_UNREACHABLE,
        "per-instance resolution unreachable",
      ),
    "per-instance resolution unreachable",
  );

  assert.deepEqual(
    packBytes(primitiveWithBatchTable(), inertPack),
    FALLBACK_BYTES,
    "the batch-table leg still produced a colour with its resolution " +
      "made unreachable — this file would pass over a reverted fix",
  );
  assert.deepEqual(
    packBytes(primitiveWithGeometryInstances(), inertPack),
    FALLBACK_BYTES,
    "the geometry-instance leg still produced a colour with its " +
      "resolution made unreachable",
  );
});

test("inertness: the material and fallback behaviours survive the mutant", async () => {
  const { packClassificationColor: inertPack } = await loadPacker(
    (source) =>
      mutateOrFail(
        source,
        MAKE_PER_INSTANCE_UNREACHABLE,
        "per-instance resolution unreachable",
      ),
    "per-instance resolution unreachable",
  );

  assert.deepEqual(
    packBytes(
      primitiveWithBatchTable({
        material: {
          uniforms: { color: { red: 0, green: 1, blue: 0, alpha: 1 } },
        },
      }),
      inertPack,
    ),
    [0, 255, 0, 255],
  );
  assert.deepEqual(packBytes({ appearance: undefined }, inertPack), [
    ...FALLBACK_BYTES,
  ]);
});
