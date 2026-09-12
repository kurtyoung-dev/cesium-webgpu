// clipping-polygon-rebake-revision-signal.spec.mjs — C-17 / SYNC_1145 item 24
// acceptance. Pure Node, real engine modules, no browser, no GPU:
//
//   node --test Tools/visual-regression/clipping-polygon-rebake-revision-signal.spec.mjs
//
// @purpose Pins that the WebGPU CLIPPING_POLYGONS feature renderer rebakes on every real content change of ClippingPolygonCollection — including an equal-count polygon swap that a vertex/polygon COUNT comparison cannot see — and does not rebake when nothing changed.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// Verified at HEAD before this fix: `ClippingPolygonCollection.update()`
// (`Scene/ClippingPolygonCollection.js:367-402`) clears `this._dirty` INSIDE
// `update`, then unconditionally calls `featureRenderer.update(this,
// frameState)` — no dirty/changed signal reaches the feature renderer at all.
// `WebGPUClippingPolygonCollection.ts`'s `updateWebGPUClippingPolygons`
// compensated by comparing `collection.length` (polygon count) and a summed
// vertex count against the values recorded on the previous bake. That
// comparison aliases on an EQUAL-COUNT edit: remove one polygon and add
// another with the same outer-ring vertex count, and neither total changes,
// so the cached SDF atlas is never rebuilt even though the polygon set is
// now completely different. WebGL has no equivalent cache (1.145 removed the
// WebGL SDF producer entirely — see the deprecation strings at the top of
// `ClippingPolygonCollection.js`), so this was a WebGPU-only staleness bug:
// WebGL re-clips against the live geometry every time; WebGPU kept clipping
// against the removed polygon.
//
// ── THE FIX ──────────────────────────────────────────────────────────────
//
// `ClippingPolygonCollection` gained a monotonic `_revision` counter,
// incremented in `add`/`remove`/`removeAll` alongside the existing `_dirty`
// flag. `updateWebGPUClippingPolygons` now gates its rebake on
// `cache.lastRevision === collection._revision` instead of on vertex/polygon
// counts. A revision bump on every add/remove call cannot alias the way a
// count comparison can: two different content states force two different
// revisions even when their polygon count and vertex totals coincide.
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// The REAL `Scene/ClippingPolygonCollection.js` runs unmodified, driven
// through its real public API (`add`/`remove`/`update`) exactly as a Scene
// would drive it. The REAL `updateWebGPUClippingPolygons` from
// `Renderer/WebGPU/WebGPUClippingPolygonCollection.ts` is registered as the
// feature renderer's `update` slot — the same shape
// `WebGPUFeatureRenderers.ts:784-787` registers in production — so the test
// exercises `ClippingPolygonCollection.update(frameState)`'s real dispatch,
// not just the WebGPU module in isolation. Only the GPU device is faked: a
// minimal `GPUDevice`-shaped stub (constants + counting spies, same idiom as
// `webgpu-snap-framebuffer-lifecycle.spec.mjs`) lets every `device.create*`
// call in the rebake path complete for real and be counted, without ever
// touching a real GPU. `GPUTextureUsage`/`GPUBufferUsage` are polyfilled on
// `globalThis` (Node has no WebGPU globals) with arbitrary distinct bit
// values — nothing under test branches on their actual numeric value, only
// round-trips them into a `usage` field the fake device never reads.
//
// The observable rebake signal is `device.createTexture()` call count: every
// real rebake creates exactly 3 textures (positions, extents, SDF atlas)
// unconditionally once past the early-return gate, so "+3 creates" is a
// direct, deterministic proxy for "a rebake happened" — corroborated by the
// compute-dispatch count (`encoder.beginComputePass()`), which increments by
// exactly 1 per rebake for the same reason.
//
// MUTATION: reverting the gate to `if (false && cache.lastRevision ===
// revision && ...)` (i.e. making the revision check permanently
// unreachable, forcing every call to look like a fresh bake) turns "no
// rebake when nothing changed" red — every call becomes a rebake, which is
// exactly the "signal that always fires is not a fix" failure mode. Applied
// by hand during review (Node has no source-patch facility here); see the
// landing packet for the observed red.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

// WebGPU usage-flag globals: Node has no `GPUTextureUsage`/`GPUBufferUsage`.
// Arbitrary distinct bits — the fake device below never inspects `usage`,
// it only needs the property access at module-evaluation time to succeed.
globalThis.GPUTextureUsage ??= {
  TEXTURE_BINDING: 0x04,
  STORAGE_BINDING: 0x08,
  COPY_DST: 0x02,
};
globalThis.GPUBufferUsage ??= {
  UNIFORM: 0x40,
  COPY_DST: 0x08,
};

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
const { default: FeatureRendererKey } = await importEngine(
  "Renderer/FeatureRendererKey.js",
);
const { updateWebGPUClippingPolygons } = await importEngine(
  "Renderer/WebGPU/WebGPUClippingPolygonCollection.ts",
);

// Polygon A: a small 5-vertex ring.
const positionsA = Cartesian3.fromRadiansArray([
  -1.3194369277314022, 0.6988062530900625, -1.31941, 0.69879,
  -1.3193955980204217, 0.6988091578771254, -1.3193931220959367,
  0.698743632490865, -1.3194358224045408, 0.6987471965556998,
]);

// Polygon B: a DIFFERENT 5-vertex ring (different location, same vertex
// count as A) — the exact equal-count-swap shape the census names. Any
// vertex/polygon COUNT comparison sees A and B as indistinguishable.
const positionsB = Cartesian3.fromRadiansArray([
  0.4194369277314022, 0.2988062530900625, 0.41941, 0.29879, 0.4193955980204217,
  0.2988091578771254, 0.4193931220959367, 0.298743632490865, 0.4194358224045408,
  0.2987471965556998,
]);

function makeFakeDevice(counts) {
  return {
    limits: { maxTextureDimension2D: 8192 },
    createTexture(descriptor) {
      counts.createTexture++;
      return {
        label: descriptor.label,
        destroy() {
          counts.textureDestroy++;
        },
        createView() {
          return { label: `${descriptor.label}-view` };
        },
      };
    },
    createSampler(descriptor) {
      counts.createSampler++;
      return { label: descriptor.label };
    },
    createBindGroupLayout(descriptor) {
      return { label: descriptor.label, entries: descriptor.entries };
    },
    createShaderModule(descriptor) {
      counts.createShaderModule++;
      return { label: descriptor.label };
    },
    createPipelineLayout() {
      return { label: "pipeline-layout" };
    },
    createComputePipeline(descriptor) {
      counts.createComputePipeline++;
      return { label: descriptor.label };
    },
    createBuffer(descriptor) {
      return { size: descriptor.size, destroy() {} };
    },
    createBindGroup() {
      return { label: "bind-group" };
    },
    createCommandEncoder() {
      return {
        beginComputePass() {
          counts.computeDispatches++;
          return {
            setPipeline() {},
            setBindGroup() {},
            dispatchWorkgroups() {},
            end() {},
          };
        },
        finish() {
          return { label: "command-buffer" };
        },
      };
    },
    queue: {
      writeTexture() {
        counts.writeTexture++;
      },
      writeBuffer() {},
      submit() {
        counts.submit++;
      },
    },
  };
}

function makeFrameState() {
  const counts = {
    createTexture: 0,
    textureDestroy: 0,
    createSampler: 0,
    createShaderModule: 0,
    createComputePipeline: 0,
    computeDispatches: 0,
    writeTexture: 0,
    submit: 0,
  };
  const device = makeFakeDevice(counts);
  const featureRenderer = { update: updateWebGPUClippingPolygons };
  const context = {
    getFeatureRenderer: (key) =>
      key === FeatureRendererKey.CLIPPING_POLYGONS
        ? featureRenderer
        : undefined,
    device,
    webgpuComputePipelineCache: undefined,
  };
  return { frameState: { context }, counts };
}

function totalVertexCount(collection) {
  let total = 0;
  for (let i = 0; i < collection.length; i++) {
    total += collection.get(i).length;
  }
  return total;
}

test("first update() rebakes (baseline)", () => {
  const collection = new ClippingPolygonCollection({
    polygons: [new ClippingPolygon({ positions: positionsA })],
  });
  const { frameState, counts } = makeFrameState();

  collection.update(frameState);

  assert.equal(counts.createTexture, 3, "positions + extents + SDF atlas");
  assert.equal(counts.computeDispatches, 1);
  assert.equal(
    collection._webgpuCache.lastRevision,
    collection._revision,
    "cache adopts the collection's current revision after a bake",
  );
});

test("update() with nothing changed does not rebake", () => {
  const collection = new ClippingPolygonCollection({
    polygons: [new ClippingPolygon({ positions: positionsA })],
  });
  const { frameState, counts } = makeFrameState();

  collection.update(frameState);
  assert.equal(counts.createTexture, 3);
  assert.equal(counts.computeDispatches, 1);

  // Repeated update() calls with no add/remove between them — e.g. every
  // frame Scene.render() drives — must not be a rebake. A signal that fires
  // unconditionally would pass the swap test below for the wrong reason.
  collection.update(frameState);
  collection.update(frameState);

  assert.equal(counts.createTexture, 3, "no new textures on unchanged content");
  assert.equal(
    counts.computeDispatches,
    1,
    "no new SDF dispatch on unchanged content",
  );
});

test("equal-count polygon swap still rebakes (the C-17 regression)", () => {
  const polygonA = new ClippingPolygon({ positions: positionsA });
  const collection = new ClippingPolygonCollection({ polygons: [polygonA] });
  const { frameState, counts } = makeFrameState();

  collection.update(frameState);
  assert.equal(counts.createTexture, 3);
  assert.equal(counts.computeDispatches, 1);
  const revisionAfterFirstBake = collection._revision;

  // Remove polygon A, add polygon B — same polygon count, same vertex count,
  // completely different geometry. This is exactly the edit a count-only
  // comparison cannot see.
  collection.remove(polygonA);
  const polygonB = new ClippingPolygon({ positions: positionsB });
  collection.add(polygonB);

  assert.equal(collection.length, 1, "polygon count is unchanged by the swap");
  assert.equal(
    totalVertexCount(collection),
    positionsA.length,
    "total vertex count is unchanged by the swap (positionsA.length === positionsB.length)",
  );
  assert.notEqual(
    collection._revision,
    revisionAfterFirstBake,
    "the revision counter DID change even though length and vertex count did not",
  );

  collection.update(frameState);

  assert.equal(
    counts.createTexture,
    6,
    "a second rebake happened: 3 more textures created (equal-count swap must not alias)",
  );
  assert.equal(counts.computeDispatches, 2, "a second SDF dispatch happened");
  assert.equal(
    collection._webgpuCache.lastRevision,
    collection._revision,
    "cache tracks the post-swap revision",
  );
});

test("a real count change (unequal) also rebakes — no regression on the common case", () => {
  const collection = new ClippingPolygonCollection({
    polygons: [new ClippingPolygon({ positions: positionsA })],
  });
  const { frameState, counts } = makeFrameState();

  collection.update(frameState);
  assert.equal(counts.createTexture, 3);

  collection.add(new ClippingPolygon({ positions: positionsB }));
  collection.update(frameState);

  assert.equal(counts.createTexture, 6, "adding a second polygon rebakes");
  assert.equal(counts.computeDispatches, 2);
});

test("_revision increments exactly once per add/remove/removeAll, never otherwise", () => {
  const polygonA = new ClippingPolygon({ positions: positionsA });
  const collection = new ClippingPolygonCollection({ polygons: [] });
  assert.equal(collection._revision, 0);

  collection.add(polygonA);
  assert.equal(collection._revision, 1);

  // Reading state does not bump the revision.
  void collection.length;
  void collection.get(0);
  assert.equal(collection._revision, 1);

  collection.remove(polygonA);
  assert.equal(collection._revision, 2);

  collection.add(new ClippingPolygon({ positions: positionsB }));
  collection.add(new ClippingPolygon({ positions: positionsA }));
  assert.equal(collection._revision, 4);

  collection.removeAll();
  assert.equal(collection._revision, 5);
});
