// buffer-primitive-collection-feature-renderer-teardown.spec.mjs — C-16 /
// SYNC_1145 item 23 acceptance. Pure Node, real engine modules, no browser,
// no GPU:
//
//   node --test Tools/visual-regression/buffer-primitive-collection-feature-renderer-teardown.spec.mjs
//
// @purpose Pins that BufferPrimitiveCollection.destroy() releases the backend feature renderer's cached resources for the collection, so a grow-then-destroy cycle returns the collection's WebGPU resource count to baseline instead of leaking it.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// `BufferPrimitiveCollection.js:373-388` (verified at this lane's HEAD)
// destroyed `_customPickObjects`, the pick ids, and `_renderContext` (the
// WebGL-only render path's resources) — with NO feature-renderer release. On
// WebGPU, `BufferPolylineCollection.update()` / `BufferPointCollection
// .update()` / `BufferPolygonCollection.update()` each delegate to a real,
// ALREADY-CORRECT feature renderer (`WebGPUFeatureRenderers.ts` registers
// `{update, destroy}` for BUFFER_POINT_COLLECTION / BUFFER_POLYLINE_COLLECTION
// / BUFFER_POLYGON_COLLECTION) but never cached the resolved renderer
// anywhere `destroy()` could find it, so `destroy()` had nothing to call.
//
// This is the SAME shape as fifteen other collections in `Scene/` (grep
// `this\._featureRenderer\s*=` — `BillboardCollection`, `PolylineCollection`,
// `PointPrimitiveCollection`, `LabelCollection`, `CloudCollection`, …), all of
// which cache `this._featureRenderer = fr;` in `update()` and release it in
// `destroy()` with `if (defined(this._featureRenderer) &&
// defined(this._featureRenderer.destroy)) { this._featureRenderer.destroy(this); }`.
// `BufferPolygonCollection.js` even already had a documented analog for its
// nested outline collection (`_outlineFeatureRenderer`, `:178-187`,
// "mirrors the `_featureRenderer` pattern used by other collections") — the
// base class just never had the field the comment refers to.
//
// Independently verified (not merely assumed) buffer count for a polyline
// collection: `Renderer/WebGPU/WebGPUBufferPolylineRenderer.ts`'s
// `PolylineCache` interface (`:79-123`) declares 10 `GPUBuffer` fields
// (paramsUBO, positionHigh/Low, prevPositionHigh/Low, nextPositionHigh/Low,
// pickColor, showColorWidthAndTexCoord, indexBuffer) plus 1 more
// (`cameraUBO`) inherited from the shared `SharedCache` interface
// (`WebGPUBufferPrimitiveRenderer.ts:178-179`) = 11 real `GPUBuffer` handles
// per collection — confirming the census's "≈11" figure by direct interface
// count. `destroyWebGPUBufferPolylineCollection` (`:849-869`) already
// destroys all 11 correctly; it was simply unreachable dead code because
// nothing called `.destroy(collection)` on the registered feature renderer.
//
// ── THE FIX ──────────────────────────────────────────────────────────────
//
// `BufferPrimitiveCollection` gained a `_featureRenderer` field (mirroring
// the fifteen-collection convention) and a release call in `destroy()`
// before the WebGL `_renderContext` teardown. Each of the three subclasses'
// `update()` now caches `this._featureRenderer = fr;` right where it already
// resolves `fr` for its own `fr.update(this, frameState)` dispatch.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// A REAL `BufferPolylineCollection` (and, separately, `BufferPointCollection`
// and `BufferPolygonCollection`) is constructed. A FAKE feature renderer
// simulates a backend's resource bookkeeping: `update()` grows a shared
// counter to a fixed "buffers per collection" size (modeling a real
// WebGPU cache being built), `destroy()` shrinks it back — exactly the
// contract `WebGPUFeatureRenderers.ts` registers. `frameState.context
// .getFeatureRenderer` is stubbed to hand back this fake for the
// collection's own key, so the REAL `update()`/`destroy()` control flow
// (unmodified beyond this lane's fix) is what drives the counter, not the
// test asserting on source shape.
//
// The acceptance ("buffer count returns to baseline after grow-then-destroy")
// is asserted generically — the fake's buffer size is independent per test,
// never hard-coded to "11" — because the fix is about the CALLING CONTRACT
// (destroy() reaches the feature renderer at all), not about a specific
// backend's resource count.
//
// MUTATION: `if (false && defined(this._featureRenderer) && …)` around the
// release call in `BufferPrimitiveCollection.destroy()` reverts to "never
// releases" — the spec must go red (buffer count stays grown after destroy).
// Applied by hand during review; see the landing packet for the observed red.

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

const { default: BufferPolylineCollection } = await importEngine(
  "Scene/BufferPolylineCollection.js",
);
const { default: BufferPointCollection } = await importEngine(
  "Scene/BufferPointCollection.js",
);
const { default: BufferPolygonCollection } = await importEngine(
  "Scene/BufferPolygonCollection.js",
);
const { default: FeatureRendererKey } = await importEngine(
  "Renderer/FeatureRendererKey.js",
);
const { default: SceneMode } = await importEngine("Scene/SceneMode.js");

/**
 * A fake feature renderer standing in for a real WebGPU collection renderer
 * (e.g. WebGPUFeatureRenderers.ts's BUFFER_POLYLINE_COLLECTION registration).
 * `update` grows a shared counter by `buffersPerCollection` the FIRST time it
 * sees a given collection instance (idempotent across repeated frames, like
 * a real cache); `destroy` shrinks it back by the same amount.
 */
function makeFakeFeatureRenderer(buffersPerCollection) {
  let bufferCount = 0;
  const built = new Set();
  return {
    bufferCountRef: () => bufferCount,
    fr: {
      update(collection) {
        if (!built.has(collection)) {
          built.add(collection);
          bufferCount += buffersPerCollection;
        }
      },
      destroy(collection) {
        if (built.has(collection)) {
          built.delete(collection);
          bufferCount -= buffersPerCollection;
        }
      },
    },
  };
}

function makeFrameState(key, fr) {
  return {
    mode: SceneMode.SCENE3D,
    passes: { render: true, pick: false },
    context: {
      getFeatureRenderer(candidateKey) {
        return candidateKey === key ? fr : undefined;
      },
    },
  };
}

test("BufferPolylineCollection: grow-then-destroy returns buffer count to baseline", () => {
  const { bufferCountRef, fr } = makeFakeFeatureRenderer(11);
  const collection = new BufferPolylineCollection();
  const frameState = makeFrameState(
    FeatureRendererKey.BUFFER_POLYLINE_COLLECTION,
    fr,
  );

  assert.equal(bufferCountRef(), 0, "baseline before any update");

  collection.update(frameState);
  assert.equal(
    bufferCountRef(),
    11,
    "one collection's worth of buffers exists after the first update",
  );
  assert.equal(
    collection._featureRenderer,
    fr,
    "update() must cache the resolved feature renderer (C-16)",
  );

  // A second update in a later frame must not double-allocate (the fake
  // models a real cache's idempotence; this also proves destroy() is what
  // frees the count, not merely calling update() again).
  collection.update(frameState);
  assert.equal(bufferCountRef(), 11);

  collection.destroy();
  assert.equal(
    bufferCountRef(),
    0,
    "buffer count must return to baseline after destroy() (C-16)",
  );
  assert.equal(
    collection._featureRenderer,
    undefined,
    "the feature-renderer cache slot must be cleared",
  );
});

test("BufferPointCollection: grow-then-destroy returns buffer count to baseline", () => {
  const { bufferCountRef, fr } = makeFakeFeatureRenderer(4);
  const collection = new BufferPointCollection();
  const frameState = makeFrameState(
    FeatureRendererKey.BUFFER_POINT_COLLECTION,
    fr,
  );

  collection.update(frameState);
  assert.equal(bufferCountRef(), 4);

  collection.destroy();
  assert.equal(bufferCountRef(), 0);
});

test("BufferPolygonCollection: grow-then-destroy returns buffer count to baseline (fill renderer only, no outlines)", () => {
  const { bufferCountRef, fr } = makeFakeFeatureRenderer(6);
  const collection = new BufferPolygonCollection();
  const frameState = makeFrameState(
    FeatureRendererKey.BUFFER_POLYGON_COLLECTION,
    fr,
  );

  collection.update(frameState);
  assert.equal(bufferCountRef(), 6);

  collection.destroy();
  assert.equal(
    bufferCountRef(),
    0,
    "the collection's OWN fill feature renderer must be released, distinct from _outlineFeatureRenderer",
  );
});

test("WebGL path (no feature renderer registered) never populates _featureRenderer, and destroy() does not throw", () => {
  const collection = new BufferPolylineCollection();
  const frameState = {
    mode: SceneMode.SCENE3D,
    passes: { render: true, pick: false },
    context: { getFeatureRenderer: () => undefined },
  };

  // renderPolylines (the real WebGL path) will be reached; it needs a real
  // GL context to fully succeed, so this only asserts the feature-renderer
  // slot stays empty up to the point of failure, then that destroy() itself
  // (independent of _renderContext state) never throws.
  try {
    collection.update(frameState);
  } catch {
    // Expected: no real GL context. Irrelevant to what this test checks.
  }
  assert.equal(collection._featureRenderer, undefined);
  assert.doesNotThrow(() => collection.destroy());
});
