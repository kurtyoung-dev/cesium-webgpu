// clipping-polygon-texture-backend-claim.spec.mjs — C-13 / SYNC_1145 item 3
// acceptance. Pure Node, real engine modules, no browser, no GPU:
//
//   node --test Tools/visual-regression/clipping-polygon-texture-backend-claim.spec.mjs
//
// @purpose Pins that ClippingPolygonCollection.requestRectangleData asks the active backend before building WebGL clipping textures, so WebGPU builds zero Texture objects while the CPU edge/grid tables still reach a future WGSL twin.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// Upstream 1.145 gave ClippingPolygonCollection a new per-owner bake API
// (`requestRectangleData`) that packs polygon rings, builds a grid, then
// realizes three WebGL Textures for the vector-style ray-cast clipping
// algorithm. `GlobeSurfaceTileProvider.js:841` calls this once per clipped
// globe tile (via `updateTileClippingPolygonData`) and `Model.js:2680` calls
// it once per clipped model. Neither call site, nor `requestRectangleData`
// itself, asked the active backend first — unlike the established sibling
// path, `Core/VectorProvider.js:383`'s `VectorPipeline.packPrimitiveTextures`,
// which claims the bake through the GLOBE_SURFACE feature renderer before
// ever calling `new Texture(...)`.
//
// On this fork WebGPU's clipping-polygon rendering still runs the SDF-atlas
// algorithm (`WebGPUClippingPolygonCollection.ts`, tracked separately as
// C-07/C-06) — there is no WGSL consumer of the polygon-edge/grid tables this
// bake produces. So on WebGPU every clipped tile/model paid for three WebGL
// Texture allocations (VRAM + upload + CPU pack cost) that nothing ever reads.
//
// ── THE FIX ──────────────────────────────────────────────────────────────
//
// `ClippingPolygonCollection.requestRectangleData` now calls
// `VectorPipeline.prepareRendererResources(context, vectorTileData)` — the
// SAME generic backend-claim primitive `packPrimitiveTextures` already uses —
// before `packPolygonTextures`. On WebGPU this resolves the GLOBE_SURFACE
// feature renderer's `prepareVectorTileData`, which (per
// `WebGPUVectorTileResources.ts`) recognizes this bake has no
// `polylineGridCellIndices` (`packVectorTileWords` returns null for
// polygon-only input) and claims ownership as the "nothing to drape"
// placeholder case: NO GPUBuffer, NO GL Texture, just a tiny bookkeeping
// object. WebGL has no GLOBE_SURFACE preparation hook, so the claim declines
// and the WebGL Texture path below runs unchanged. Either way the CPU tables
// computed earlier in the same call (`polygonRings`, `polygonEdgeTexels`,
// `polygonGridCellIndices`) stay on `vectorTileData` for a future WGSL twin.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// The REAL `Scene/ClippingPolygonCollection.js` and `Core/VectorPipeline.js`
// run unmodified against a real `ClippingPolygon`. Only `Renderer/Texture.js`'s
// GL dependency is faked: a minimal WebGL2-shaped `gl` stub (constants +
// counting spies) lets `new Texture(...)` complete for real when the WebGL leg
// is exercised, so `Texture.sizeInBytes` (a real getter, real formula) reports
// real byte counts rather than a hand-picked number. `context.getFeatureRenderer`
// is the only behavior under test's real control surface: absent (WebGL) or
// present-and-claiming (WebGPU).
//
// MULTI-METRIC (CLAUDE.md: never gate a performance claim on one number):
//   - allocation count: `gl.createTexture()` invocations, counted by the stub.
//     Deterministic given fixed input — no noise expected across runs.
//   - GPU bytes: sum of the three real `Texture#sizeInBytes` getters. Also
//     deterministic (pure function of width/height/pixelFormat/pixelDatatype),
//     but reported separately per CLAUDE.md's multi-metric rule rather than
//     inferred from the count.
//
// MUTATION: `if (false && VectorPipeline.prepareRendererResources(...))`
// makes the claim unreachable — the WebGPU leg must then build all three
// textures exactly like WebGL, and the spec must go red. Applied by hand
// during review, not by this file (Node has no source-patch facility here);
// see the landing packet for the observed red.
//
// A second mutation matters: making the REAL hook decline the nothing-to-drape
// case (`if (!words) { return false; }` in WebGPUVectorTileResources.ts) must
// also go red — the last test below is what makes it do so.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const engineSrc = path.resolve(
  import.meta.dirname,
  "../../packages/engine/Source",
);
const importEngine = (relativePath) =>
  import(pathToFileURL(path.join(engineSrc, relativePath)).href);

const { default: ClippingPolygonCollection } = await importEngine(
  "Scene/ClippingPolygonCollection.js",
);
const { default: ClippingPolygon } = await importEngine(
  "Scene/ClippingPolygon.js",
);
const { default: Cartesian3 } = await importEngine("Core/Cartesian3.js");
const { default: Rectangle } = await importEngine("Core/Rectangle.js");
const { default: FeatureRendererKey } = await importEngine(
  "Renderer/FeatureRendererKey.js",
);

// A single small triangle, reused by both legs. Its exact shape does not
// matter — only that it bakes to at least one polygon ring so
// `requestRectangleData` reaches the texture-realization code at all.
const positions = Cartesian3.fromRadiansArray([
  -1.3194369277314022, 0.6988062530900625, -1.31941, 0.69879,
  -1.3193955980204217, 0.6988091578771254, -1.3193931220959367,
  0.698743632490865, -1.3194358224045408, 0.6987471965556998,
]);

function makeCollection() {
  return new ClippingPolygonCollection({
    polygons: [new ClippingPolygon({ positions })],
  });
}

/**
 * Minimal WebGL2-shaped `gl` object. Every constant is an arbitrary distinct
 * number (nothing in Texture.js branches on the ACTUAL numeric value of a GL
 * enum it just round-trips to another `gl.*` call); every method is a no-op
 * spy except `createTexture`, which is counted.
 */
function makeFakeGl(counts) {
  return {
    TEXTURE_2D: 1,
    TEXTURE0: 2,
    UNPACK_COLORSPACE_CONVERSION_WEBGL: 3,
    BROWSER_DEFAULT_WEBGL: 4,
    NONE: 5,
    UNPACK_ALIGNMENT: 6,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 7,
    UNPACK_FLIP_Y_WEBGL: 8,
    TEXTURE_MIN_FILTER: 9,
    TEXTURE_MAG_FILTER: 10,
    TEXTURE_WRAP_S: 11,
    TEXTURE_WRAP_T: 12,
    createTexture() {
      counts.createTexture++;
      return { id: counts.createTexture };
    },
    activeTexture() {},
    bindTexture() {},
    pixelStorei() {},
    texParameteri() {},
    texImage2D() {
      counts.texImage2D++;
    },
    generateMipmap() {},
    deleteTexture() {
      counts.deleteTexture++;
    },
  };
}

/**
 * @param {{claims: boolean}} options `claims: true` simulates a WebGPU
 *   context whose GLOBE_SURFACE feature renderer claims the bake (the
 *   "nothing to drape" placeholder case for polygon-only input); `false`
 *   simulates WebGL, which registers no such feature renderer.
 */
function makeFakeContext({ claims }) {
  const counts = { createTexture: 0, texImage2D: 0, deleteTexture: 0 };
  const context = {
    webgl2: true,
    floatingPointTexture: true,
    limits: { maximumTextureSize: 4096 },
    resourceGeneration: 0,
    _gl: makeFakeGl(counts),
    getFeatureRenderer: claims
      ? (key) =>
          key === FeatureRendererKey.GLOBE_SURFACE
            ? { prepareVectorTileData: () => true }
            : undefined
      : undefined,
  };
  return { context, counts };
}

function totalGpuBytes(data) {
  return [
    data.polygonEdgeTexture,
    data.polygonEdgePrimitiveIndicesTexture,
    data.polygonGridCellIndicesTexture,
  ]
    .filter((t) => t !== undefined)
    .reduce((sum, t) => sum + t.sizeInBytes, 0);
}

test("WebGL (no feature renderer claim) still builds all three clipping textures", () => {
  const { context, counts } = makeFakeContext({ claims: false });
  const data = makeCollection().requestRectangleData(
    Rectangle.MAX_VALUE,
    context,
  );

  assert.equal(
    counts.createTexture,
    3,
    "WebGL must build exactly 3 GL textures (no regression)",
  );
  assert.notEqual(data.polygonEdgeTexture, undefined);
  assert.notEqual(data.polygonEdgePrimitiveIndicesTexture, undefined);
  assert.notEqual(data.polygonGridCellIndicesTexture, undefined);
  assert.ok(
    totalGpuBytes(data) > 0,
    "WebGL leg pays real GPU bytes for the three textures",
  );
});

test("WebGPU (feature renderer claims the bake) builds zero clipping textures", () => {
  const { context, counts } = makeFakeContext({ claims: true });
  const data = makeCollection().requestRectangleData(
    Rectangle.MAX_VALUE,
    context,
  );

  assert.equal(
    counts.createTexture,
    0,
    "WebGPU must construct zero Texture objects per clipped tile/model (C-13)",
  );
  assert.equal(data.polygonEdgeTexture, undefined);
  assert.equal(data.polygonEdgePrimitiveIndicesTexture, undefined);
  assert.equal(data.polygonGridCellIndicesTexture, undefined);
  assert.equal(
    totalGpuBytes(data),
    0,
    "WebGPU leg pays zero GPU bytes for clipping textures",
  );
});

test("WebGPU claim still produces the CPU tables for a future WGSL twin", () => {
  const { context } = makeFakeContext({ claims: true });
  const data = makeCollection().requestRectangleData(
    Rectangle.MAX_VALUE,
    context,
  );

  // The acceptance is "stop building GL textures", not "stop baking" — the
  // CPU edge/grid tables must survive the backend claim untouched so a future
  // WGSL twin can read them.
  assert.ok(data.polygonRings.length > 0);
  assert.notEqual(data.polygonEdgeTexels, undefined);
  assert.notEqual(data.polygonGridCellIndices, undefined);
});

test("no polygons overlapping the rectangle: no textures on either backend (unchanged baseline)", () => {
  const farRectangle = new Rectangle(3.0, 1.3, 3.1, 1.4);
  for (const claims of [false, true]) {
    const { context, counts } = makeFakeContext({ claims });
    const data = makeCollection().requestRectangleData(farRectangle, context);
    assert.equal(counts.createTexture, 0);
    assert.equal(data.polygonEdgeTexture, undefined);
  }
});

test("the REAL WebGPU GLOBE_SURFACE hook claims a polygon-only bake (the premise C-13 rests on)", async () => {
  const { prepareWebGPUVectorTileData } = await importEngine(
    "Renderer/WebGPU/WebGPUVectorTileResources.ts",
  );
  let buffersCreated = 0;
  const device = {
    createBuffer() {
      buffersCreated++;
      return { destroy() {} };
    },
    queue: { writeBuffer() {} },
  };
  // Exactly the shape requestRectangleData hands over: polygon tables only,
  // no polylineGridCellIndices — so packVectorTileWords returns null.
  const polygonOnlyData = {
    polygonRings: [[0, 1, 2]],
    polygonEdgeTexels: new Float32Array(4),
    polygonGridCellIndices: new Float32Array([1, 1, 0]),
    primitiveCount: 1,
  };
  assert.equal(
    prepareWebGPUVectorTileData(
      { device, resourceGeneration: 0 },
      polygonOnlyData,
    ),
    true,
    "the WebGPU hook must CLAIM a polygon-only bake ('nothing to drape' is ownership, not a decline) — if it ever returns false here, requestRectangleData silently falls through and rebuilds the three GL textures C-13 removed",
  );
  assert.equal(
    buffersCreated,
    0,
    "claiming a polygon-only bake must allocate no GPUBuffer",
  );
});
