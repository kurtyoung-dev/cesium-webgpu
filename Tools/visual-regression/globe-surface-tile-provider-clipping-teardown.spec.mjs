// globe-surface-tile-provider-clipping-teardown.spec.mjs — C-15 / SYNC_1145
// item 22 acceptance. Pure Node, real engine modules, no browser, no GPU:
//
//   node --test Tools/visual-regression/globe-surface-tile-provider-clipping-teardown.spec.mjs
//
// @purpose Pins that GlobeSurfaceTileProvider.destroy() routes its clipping-polygon teardown through ClippingPolygonCollection.setOwner so a backend feature renderer's cached GPU resources are released, with the context itself untouched.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// `GlobeSurfaceTileProvider.js:1391-1396` (verified at this lane's HEAD)
// destroyed `_tileProvider` and `_clippingPlanes`, then did
// `this._clippingPolygons = undefined;` — dropping the reference outright
// instead of calling `ClippingPolygonCollection.setOwner(undefined, this,
// "_clippingPolygons")`, the same helper the `clippingPolygons` SETTER
// already uses at `:599`.
//
// Upstream 1.145 deprecated `ClippingPolygonCollection.destroy()` because the
// collection no longer owns any GPU resources of its own on upstream. On this
// fork it still can: a backend feature renderer (the WebGPU SDF atlas plus
// its positions/extents textures) attaches itself to the collection as
// `collection._featureRenderer`, and `releaseFeatureRendererResources`
// (`ClippingPolygonCollection.js:765-770`) is the only thing that calls
// `.destroy()` on it. That function runs inside `setOwner` — which
// `GlobeSurfaceTileProvider.destroy()` skipped entirely. Every globe/viewer
// destroyed against a surviving device leaked the collection's WebGPU
// resources.
//
// ── THE FIX ──────────────────────────────────────────────────────────────
//
// `destroy()` now calls the exact same
// `ClippingPolygonCollection.setOwner(undefined, this, "_clippingPolygons")`
// the setter uses, so the feature-renderer release path is identical whether
// the collection is swapped out mid-lifetime or torn down at destroy time.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// A REAL `GlobeSurfaceTileProvider` is constructed (fake `terrainProvider` /
// `surfaceShaderSet` / `vectorProvider` objects — `destroy()` never touches
// them; a minimal `imageryLayers` stub whose four events are plain
// `addEventListener() => removeListener` closures, matching the shape the
// constructor reads). A REAL `ClippingPolygonCollection` is attached via the
// real `clippingPolygons` setter. A FAKE feature renderer is then attached
// directly to `collection._featureRenderer` to simulate "a backend already
// claimed this collection's resources this frame" — the exact state a
// WebGPU-rendered globe would be in — without needing a real GPUDevice.
//
// "The feature-renderer cache is empty after globe teardown with the context
// still alive" is asserted two ways: the fake renderer's `destroy` was
// invoked with the SAME collection instance (proving the release path was
// reached, not merely a no-op branch), and `collection._featureRenderer` is
// `undefined` afterward (the cache slot itself is empty). No `GraphicsContext`
// or device object is created or touched anywhere in this file — the release
// is a pure collection-level operation, which is exactly the "context still
// alive" property: destroying one globe does not require destroying, and
// must not depend on, the context it rendered through.
//
// MUTATION: `if (false && ...)` around the `setOwner` call in
// `GlobeSurfaceTileProvider.destroy()` reverts to the old
// `this._clippingPolygons = undefined;`-only behavior — the spec must go red
// (the fake renderer's destroy is never called). Applied by hand during
// review; see the landing packet for the observed red.

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

const { default: GlobeSurfaceTileProvider } = await importEngine(
  "Scene/GlobeSurfaceTileProvider.js",
);
const { default: ClippingPolygonCollection } = await importEngine(
  "Scene/ClippingPolygonCollection.js",
);
const { default: ClippingPolygon } = await importEngine(
  "Scene/ClippingPolygon.js",
);
const { default: Cartesian3 } = await importEngine("Core/Cartesian3.js");

const positions = Cartesian3.fromRadiansArray([
  -1.3194369277314022, 0.6988062530900625, -1.31941, 0.69879,
  -1.3193955980204217, 0.6988091578771254, -1.3193931220959367,
  0.698743632490865, -1.3194358224045408, 0.6987471965556998,
]);

function makeFakeImageryLayers() {
  const fakeEvent = () => ({ addEventListener: () => () => {} });
  return {
    layerAdded: fakeEvent(),
    layerRemoved: fakeEvent(),
    layerMoved: fakeEvent(),
    layerShownOrHidden: fakeEvent(),
  };
}

function makeProvider() {
  return new GlobeSurfaceTileProvider({
    terrainProvider: {},
    imageryLayers: makeFakeImageryLayers(),
    surfaceShaderSet: {},
    vectorProvider: {},
  });
}

test("destroy() releases a backend feature renderer's clipping resources", () => {
  const provider = makeProvider();
  const clippingPolygons = new ClippingPolygonCollection({
    polygons: [new ClippingPolygon({ positions })],
  });
  provider.clippingPolygons = clippingPolygons;
  assert.equal(clippingPolygons._owner, provider);

  let destroyCallCount = 0;
  let destroyedWith;
  clippingPolygons._featureRenderer = {
    destroy(collection) {
      destroyCallCount++;
      destroyedWith = collection;
    },
  };

  provider.destroy();

  assert.equal(
    destroyCallCount,
    1,
    "the feature renderer's destroy() must be invoked exactly once",
  );
  assert.equal(
    destroyedWith,
    clippingPolygons,
    "destroy() must be called with the same collection instance",
  );
  assert.equal(
    clippingPolygons._featureRenderer,
    undefined,
    "the feature-renderer cache slot must be empty after teardown",
  );
  assert.equal(
    provider._clippingPolygons,
    undefined,
    "the provider must drop its own reference too",
  );
});

test("destroy() with no clipping polygons attached is a no-op for this path", () => {
  const provider = makeProvider();
  // No clippingPolygons ever assigned.
  assert.doesNotThrow(() => provider.destroy());
});

test("destroy() with clipping polygons but no feature renderer attached (WebGL) does not throw", () => {
  const provider = makeProvider();
  const clippingPolygons = new ClippingPolygonCollection({
    polygons: [new ClippingPolygon({ positions })],
  });
  provider.clippingPolygons = clippingPolygons;
  // _featureRenderer stays undefined — the WebGL case, where nothing ever
  // claimed the collection.
  assert.doesNotThrow(() => provider.destroy());
  assert.equal(provider._clippingPolygons, undefined);
});
