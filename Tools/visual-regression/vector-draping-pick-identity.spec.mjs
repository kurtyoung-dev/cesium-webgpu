// vector-draping-pick-identity.spec.mjs — a draped primitive's pick word
// resolves to that primitive. Pure Node: no browser, no GPU, no built bundle.
//
// @purpose C-05: pins that the pick colour a draped BufferPolyline is baked
//   with survives the WebGPU storage-buffer packing and decodes back to the
//   pick object `scene.pick` would hand the caller.
// @status ACTIVE
//
// ── WHAT THE GAP WAS ────────────────────────────────────────────────────────
//
// `scene.pick` over a terrain-draped vector returned the primitive on WebGL and
// the globe, or nothing, on WebGPU. `GlobeTerrain.wgsl::fragmentPickMain` wrote
// `camera.pickColor` unconditionally, and the primitives run
// `WebGPUVectorTileResources.packVectorTileWords` packs had no pick word to
// write instead — the CPU bake had been writing per-primitive pick colours
// since 1.145 (`VectorPipeline._writePickColor`) and nothing on this backend
// read them.
//
// ── WHAT THIS SPEC ASSERTS, AND WHY IT IS NOT A RESTATEMENT OF THE PACKER ───
//
// The observable is an IDENTITY ROUND TRIP, end to end through real modules:
//
//   a real `BufferPolylineCollection` with `allowPicking`
//     → real pick ids from the real `GraphicsContext#createPickId` allocator
//     → the real `VectorPipeline` bake, which writes them as pick colours
//     → the real `packVectorTileWords`, which packs them into the storage buffer
//     → `unpack4x8unorm` + rgba8unorm quantisation, as the pick attachment does
//     → the real `GraphicsContext#getObjectByPickColor`
//     → the SAME pick object the collection registered for that primitive.
//
// Nothing in that chain is modelled except the two steps that are physically a
// GPU's: the shader's unpack (four bytes, low byte first) and the colour
// attachment's quantisation. Every other step executes the shipping module, so
// an inertness mutant anywhere along it fails this file rather than passing it.
//
// The geometric half of the claim — that the fragment covered by primitive k
// resolves k's word and a fragment off every stroke keeps the globe's own
// colour — lives in `vector-layer-draping.spec.mjs` group P, where the two
// backends' shader evaluators already do. Together the two files are
// "`scene.pick` over a draped primitive returns that primitive"; the GPU-side
// proof of the same sentence is `probe-vector-draping.mjs` gate G.
//
// Run: node --test Tools/visual-regression/vector-draping-pick-identity.spec.mjs

import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(directory, "../..");
const engineSource = resolve(repoRoot, "packages/engine/Source");

// ── The real engine modules ─────────────────────────────────────────────────
//
// Bundled by esbuild over `packages/engine/Source` rather than imported
// through Node's strip-only TypeScript loader, which refuses the `enum`
// declarations these modules reach. No stubs and no copies: an on-disk edit to
// any of them is what this spec executes.

const BARREL_SOURCE = [
  'export { GraphicsContext } from "./Renderer/GraphicsContext.js";',
  'export { default as Color } from "./Core/Color.js";',
  'export { default as Cartesian3 } from "./Core/Cartesian3.js";',
  'export { default as Cartesian2 } from "./Core/Cartesian2.js";',
  'export { default as Ellipsoid } from "./Core/Ellipsoid.js";',
  'export { default as Rectangle } from "./Core/Rectangle.js";',
  'export { default as VectorPipeline } from "./Core/VectorPipeline.js";',
  'export { default as SceneMode } from "./Scene/SceneMode.js";',
  'export { default as HeightReference } from "./Scene/HeightReference.js";',
  'export { default as BufferPolylineCollection } from "./Scene/BufferPolylineCollection.js";',
  'export { default as BufferPolylineMaterial } from "./Scene/BufferPolylineMaterial.js";',
  "export {",
  "  packVectorTileWords,",
  "  VECTOR_PRIMITIVE_STRIDE,",
  "  VECTOR_TILE_PRIMITIVES_BASE,",
  "  VECTOR_TILE_PRIMITIVE_COUNT,",
  '} from "./Renderer/WebGPU/WebGPUVectorTileResources.js";',
].join("\n");

const bundled = await build({
  stdin: {
    contents: BARREL_SOURCE,
    resolveDir: engineSource,
    sourcefile: "c05-barrel.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  target: "es2022",
  logLevel: "silent",
  absWorkingDir: repoRoot,
});

const {
  GraphicsContext,
  Color,
  Cartesian3,
  Cartesian2,
  Ellipsoid,
  Rectangle,
  VectorPipeline,
  SceneMode,
  HeightReference,
  BufferPolylineCollection,
  BufferPolylineMaterial,
  packVectorTileWords,
  VECTOR_PRIMITIVE_STRIDE,
  VECTOR_TILE_PRIMITIVES_BASE,
  VECTOR_TILE_PRIMITIVE_COUNT,
} = await import(
  `data:text/javascript;base64,${Buffer.from(
    bundled.outputFiles[0].text,
  ).toString("base64")}`
);

/**
 * The smallest concrete `GraphicsContext` there can be. Its constructor body is
 * empty and registry registration is deferred to `_registerWithRegistry()`, so
 * this subclass inherits the REAL `_pickObjects` map, the REAL `_nextPickColor`
 * allocator and the REAL `createPickId` / `getObjectByPickColor` without a GL
 * or GPU device. No pick behaviour is overridden.
 */
class SpecContext extends GraphicsContext {}

// ── The scene ───────────────────────────────────────────────────────────────

const LONGITUDES = [-105.0, -104.5, -104.0];
const WIDTHS = [4, 9, 16];
const COLORS = [
  [1.0, 0.0, 0.0, 1.0],
  [0.0, 1.0, 0.0, 0.5],
  [0.0, 0.0, 1.0, 1.0],
];

/** A meridian segment, as the draping probe places them. */
function meridian(longitude) {
  const positions = [];
  for (let latitude = 36.0; latitude <= 41.0 + 1e-9; latitude += 0.25) {
    const p = Cartesian3.fromDegrees(longitude, latitude, 0.0);
    positions.push(p.x, p.y, p.z);
  }
  return new Float64Array(positions);
}

/**
 * A collection whose pick ids come from the real allocator on `context`.
 *
 * `allowPicking` is the user-facing opt-in the whole chain hangs off:
 * `BufferPrimitiveCollection#update` calls `_updatePickIds` only when it is
 * set, and without ids every primitive's `_pickId` stays 0 and every pick
 * colour bakes to four zero bytes.
 */
function buildCollection(context, { allowPicking = true } = {}) {
  const collection = new BufferPolylineCollection({
    primitiveCountMax: 8,
    vertexCountMax: 1024,
    allowPicking,
    heightReference: HeightReference.CLAMP_TO_GROUND,
  });
  for (let i = 0; i < LONGITUDES.length; i++) {
    collection.add({
      positions: meridian(LONGITUDES[i]),
      material: new BufferPolylineMaterial({
        color: new Color(...COLORS[i]),
        width: WIDTHS[i],
      }),
    });
  }
  // The real per-frame entry point, not `_updatePickIds` directly: what is
  // being pinned includes that a draped collection — which never draws itself,
  // because `_isRendered` is false for a clamped height reference — still gets
  // its pick ids allocated.
  collection.update({ mode: SceneMode.SCENE3D, context });
  return collection;
}

/** The stage-1 bake, through the real pipeline. */
function bakeCollectionData(collection) {
  return VectorPipeline.packPolylineCollectionData(
    collection,
    Ellipsoid.WGS84,
    undefined,
  );
}

/**
 * The stage-2 tile bake, through the real pipeline, over a rectangle that
 * contains every polyline.
 */
function bakeTile(collection, collectionData) {
  const rectangle = Rectangle.fromDegrees(-106.0, 35.0, -103.0, 42.0);
  const result = {
    show: true,
    minimumTileScreenPixels: 256.0,
    metersPerUv: new Cartesian2(435000.0, 435000.0),
  };
  VectorPipeline.packPolylineSegments(
    collection,
    collectionData,
    rectangle,
    result,
  );
  VectorPipeline.packPolylineGrid(result);
  return result;
}

/**
 * `unpack4x8unorm` followed by the rgba8unorm colour attachment's own
 * quantisation — the two steps between the packed word and the bytes
 * `WebGPUPickFramebuffer` reads back. Everything else in the chain is the real
 * module.
 */
function pickWordToBytes(word) {
  const normalized = [
    (word & 0xff) / 255,
    ((word >>> 8) & 0xff) / 255,
    ((word >>> 16) & 0xff) / 255,
    ((word >>> 24) & 0xff) / 255,
  ];
  return {
    red: Math.round(normalized[0] * 255),
    green: Math.round(normalized[1] * 255),
    blue: Math.round(normalized[2] * 255),
    alpha: Math.round(normalized[3] * 255),
  };
}

/** The pick word the packed buffer holds for one primitive. */
function pickWordAt(words, primitiveIndex) {
  const primitivesBase = words[VECTOR_TILE_PRIMITIVES_BASE];
  return (
    words[primitivesBase + primitiveIndex * VECTOR_PRIMITIVE_STRIDE + 2] >>> 0
  );
}

// ── A: the bake carries real pick ids ───────────────────────────────────────

test("A1: allowPicking gives every primitive a distinct, non-zero pick id", () => {
  const context = new SpecContext();
  const collection = buildCollection(context);
  const data = bakeCollectionData(collection);

  assert.ok(
    data.pickColors instanceof Uint8Array,
    "the bake must carry per-primitive pick colours",
  );
  assert.equal(data.pickColors.length, collection.primitiveCount * 4);

  const seen = new Set();
  for (let i = 0; i < collection.primitiveCount; i++) {
    const bytes = data.pickColors.slice(i * 4, i * 4 + 4);
    const key = Color.bytesToRgba(bytes[0], bytes[1], bytes[2], bytes[3]);
    assert.notEqual(key >>> 0, 0, `primitive ${i} baked a zero pick id`);
    seen.add(key >>> 0);
  }
  assert.equal(
    seen.size,
    collection.primitiveCount,
    "two primitives baked the same pick id",
  );
});

test("A2: without allowPicking every pick colour is four zero bytes", () => {
  // The lower half of the per-primitive opt-in. `GlobeTerrain.wgsl`'s
  // `vectorPickColorOver` reads a zero word as "this primitive did not opt in"
  // and leaves the globe's own answer standing, so this is the state that has
  // to actually be zero rather than merely unregistered.
  const context = new SpecContext();
  const collection = buildCollection(context, { allowPicking: false });
  const data = bakeCollectionData(collection);
  for (const byte of data.pickColors) {
    assert.equal(byte, 0);
  }
  assert.equal(context.pickObjectCount ?? 0, 0);
});

// ── B: the identity round trip ──────────────────────────────────────────────

test("B1: a draped primitive's packed pick word resolves to that primitive", () => {
  const context = new SpecContext();
  const collection = buildCollection(context);
  const collectionData = bakeCollectionData(collection);
  const tile = bakeTile(collection, collectionData);
  const words = packVectorTileWords(tile);

  assert.ok(words instanceof Uint32Array, "the tile must pack to a buffer");
  assert.equal(
    words[VECTOR_TILE_PRIMITIVE_COUNT],
    collection.primitiveCount,
    "every primitive must have a record in the run",
  );

  for (let i = 0; i < collection.primitiveCount; i++) {
    const word = pickWordAt(words, i);
    assert.notEqual(word, 0, `primitive ${i}'s pick word packed as zero`);

    const target = context.getObjectByPickColor(pickWordToBytes(word));
    assert.ok(target, `primitive ${i}'s pick word resolved to nothing`);
    assert.equal(
      target.collection,
      collection,
      `primitive ${i} resolved to another collection`,
    );
    assert.equal(
      target.index,
      i,
      `primitive ${i} resolved to primitive ${target.index}`,
    );
    // The pick object's `primitive` accessor is what `scene.pick` hands the
    // caller, and it must be a live view onto the right polyline.
    assert.equal(
      target.primitive.getMaterial(new BufferPolylineMaterial()).width,
      WIDTHS[i],
    );
  }
});

test("B2: the three primitives resolve to three different objects", () => {
  // A packer that wrote one primitive's word into every record, or that lost
  // the high byte of the key, would still satisfy B1 for primitive 0.
  const context = new SpecContext();
  const collection = buildCollection(context);
  const words = packVectorTileWords(
    bakeTile(collection, bakeCollectionData(collection)),
  );
  const resolved = new Set();
  for (let i = 0; i < collection.primitiveCount; i++) {
    resolved.add(
      context.getObjectByPickColor(pickWordToBytes(pickWordAt(words, i))),
    );
  }
  assert.equal(resolved.size, collection.primitiveCount);
});

test("B3: a pick over the globe resolves to the globe, not to any draped line", () => {
  // The other half of the acceptance: one stroke-width away from the line, the
  // pick pass writes `camera.pickColor` — the id `Globe.beginFrame` registers
  // when `globe.pickable` is set — and that must be a different answer.
  const context = new SpecContext();
  const collection = buildCollection(context);
  const globe = { name: "globe stand-in" };
  const globePickId = context.createPickId({ primitive: globe });
  const words = packVectorTileWords(
    bakeTile(collection, bakeCollectionData(collection)),
  );

  const globeBytes = {
    red: Color.floatToByte(globePickId.color.red),
    green: Color.floatToByte(globePickId.color.green),
    blue: Color.floatToByte(globePickId.color.blue),
    alpha: Color.floatToByte(globePickId.color.alpha),
  };
  assert.equal(context.getObjectByPickColor(globeBytes).primitive, globe);

  for (let i = 0; i < collection.primitiveCount; i++) {
    assert.notDeepEqual(
      pickWordToBytes(pickWordAt(words, i)),
      globeBytes,
      `primitive ${i}'s pick word collides with the globe's`,
    );
  }

  // And the default: with no globe pick id registered the pick pass writes
  // (0,0,0,0), which resolves to nothing — `scene.pick` undefined over terrain,
  // matching WebGL.
  assert.equal(
    context.getObjectByPickColor({ red: 0, green: 0, blue: 0, alpha: 0 }),
    undefined,
  );
});

// ── M: the mutations ────────────────────────────────────────────────────────

test("M1: packing the MATERIAL colour into the pick word is DETECTED", () => {
  // The likeliest silent defect: the two colour words live side by side in the
  // record and both are RGBA8. A material colour resolves to a different
  // object, or to none at all.
  const context = new SpecContext();
  const collection = buildCollection(context);
  const tile = bakeTile(collection, bakeCollectionData(collection));
  const words = packVectorTileWords(tile);
  const primitivesBase = words[VECTOR_TILE_PRIMITIVES_BASE];

  let wrong = 0;
  for (let i = 0; i < collection.primitiveCount; i++) {
    const material =
      words[primitivesBase + i * VECTOR_PRIMITIVE_STRIDE + 1] >>> 0;
    const target = context.getObjectByPickColor(pickWordToBytes(material));
    if (!target || target.index !== i) {
      wrong++;
    }
  }
  assert.equal(
    wrong,
    collection.primitiveCount,
    "a material colour must not resolve to the primitive it belongs to",
  );
});

test("M2: dropping the pick word's high byte is DETECTED", () => {
  // Alpha is the key's HIGH BYTE, not an opacity. A reader that forced it to
  // 255 or dropped it would alias ids that differ only above bit 23 — the
  // 32-bit key contract `GraphicsContext#_pickColorToKey` decodes on the way
  // back. The allocator is positioned so the ids under test straddle 2^24.
  const context = new SpecContext();
  context._nextPickColor[0] = 0x00fffffe;
  const collection = buildCollection(context);
  const words = packVectorTileWords(
    bakeTile(collection, bakeCollectionData(collection)),
  );

  let aliased = 0;
  for (let i = 0; i < collection.primitiveCount; i++) {
    const bytes = pickWordToBytes(pickWordAt(words, i));
    assert.equal(
      context.getObjectByPickColor(bytes).index,
      i,
      `primitive ${i} lost its identity across the 2^24 boundary`,
    );
    const truncated = { ...bytes, alpha: 0 };
    const target = context.getObjectByPickColor(truncated);
    if (!target || target.index !== i) {
      aliased++;
    }
  }
  assert.ok(
    aliased > 0,
    "the fixture must include an id whose high byte is load-bearing",
  );
});
