// C11-195 (light slice) — pure-Node contracts for the model/view LIGHT half of
// the WebGPU group-0 dynamic-offset arena. Sibling of
// model-camera-arena.spec.mjs, same two halves:
//
//   1. BEHAVIORAL. The real `WebGPUModelCameraArena` is bundled with esbuild
//      and driven by fake GPUDevice / ring-allocator doubles, so the
//      light-slice cardinality, offset alignment, view isolation, and
//      generation-invalidation contracts run against the shipping code.
//
//   2. STRUCTURAL. Source-shape assertions that the renderer packs the block
//      ONCE per model per view instead of once per primitive, that the light
//      left the per-primitive merged group-1 layout / bind group / cache key
//      entirely, and that the WGSL binding moved with it. A behaviorally
//      perfect arena that the renderer still calls per primitive is the exact
//      regression this half of the row exists to remove, and no behavioral
//      test of the arena alone can see it.
//
// Run: node --test Tools/visual-regression/model-light-arena.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = dirname(fileURLToPath(import.meta.url));
const engineRoot = resolve(directory, "../../packages/engine/Source");
const arenaTsPath = resolve(
  engineRoot,
  "Renderer/WebGPU/WebGPUModelCameraArena.ts",
);

const bundle = await build({
  entryPoints: [arenaTsPath],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  logLevel: "silent",
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(
  bundle.outputFiles[0].text,
).toString("base64")}`;
const {
  WebGPUModelCameraArena,
  MODEL_CAMERA_UNIFORM_BYTES,
  MODEL_LIGHT_UNIFORM_BYTES,
  MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT,
} = await import(moduleUrl);

const readSource = async (relative) =>
  (await readFile(resolve(engineRoot, relative), "utf8")).replace(
    /\r\n/g,
    "\n",
  );

const rendererSource = await readSource(
  "Renderer/WebGPU/WebGPUModelRenderer.ts",
);

// This spec's own text, so the anchor-shape control below can assert on it.
const specSource = await readFile(fileURLToPath(import.meta.url), "utf8");

/**
 * The region between two declarations, with the closing anchor searched for
 * AFTER the opening one.
 *
 * A bare `source.indexOf(close)` finds the FIRST occurrence in the file, which
 * may sit above `open` — `slice` then returns "" and every assertion over the
 * region passes vacuously. Both anchors must also be present; a missing one
 * makes `indexOf` return -1, and `slice(start, -1)` silently returns almost the
 * whole file rather than nothing.
 */
const sliceBetween = (source, open, close) => {
  const start = source.indexOf(open);
  assert.ok(start >= 0, `opening anchor \`${open}\` is missing`);
  const end = source.indexOf(close, start + open.length);
  assert.ok(
    end >= 0,
    `closing anchor \`${close}\` is missing after \`${open}\``,
  );
  return source.slice(start, end);
};
const deviceResourcesSource = await readSource(
  "Renderer/WebGPU/WebGPUModelDeviceResources.ts",
);
const pipelineCacheSource = await readSource(
  "Renderer/WebGPU/WebGPUModelPipelineCache.ts",
);
const modelWgslSource = await readSource(
  "Shaders/WebGPU/Model/ModelPBRComplete.wgsl",
);

// ── Test doubles ────────────────────────────────────────────────────────────

/** Minimal GPUDevice recording every resource it is asked to create. */
function makeDevice() {
  const created = { bindGroups: [], buffers: [], writes: [] };
  return {
    created,
    createBindGroup(descriptor) {
      const bindGroup = { __kind: "bindGroup", descriptor };
      created.bindGroups.push(bindGroup);
      return bindGroup;
    },
    createBuffer(descriptor) {
      const buffer = {
        __kind: "buffer",
        descriptor,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      created.buffers.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer(...args) {
        created.writes.push(args);
      },
    },
  };
}

/**
 * Ring-allocator double with the real allocator's contract: 256-aligned bump
 * offsets inside a page, a new page object per `beginFrame`, a monotonic
 * allocation epoch, and a record of every staged payload so a test can prove
 * WHAT reached the GPU, not just how often.
 */
function makeAllocator({ pageCount = 3, pageSize = 1 << 20 } = {}) {
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push({ __kind: "page", index: i });
  }
  let pageIndex = -1;
  let offset = 0;
  let epoch = 0;
  const staged = [];
  return {
    pages,
    staged,
    beginFrame() {
      pageIndex = (pageIndex + 1) % pages.length;
      offset = 0;
      epoch++;
    },
    // Mid-frame overflow, with the real allocator's semantics: a fresh page
    // starts taking allocations inside the SAME frame, and the allocation
    // epoch does NOT advance (WebGPURingBufferAllocator bumps it only in
    // beginFrame), so slices handed out earlier in the frame stay valid.
    overflowToNextPage() {
      pageIndex = (pageIndex + 1) % pages.length;
      offset = 0;
    },
    allocateAndWrite(data, allocationSize) {
      const size = allocationSize ?? data.byteLength;
      const aligned =
        Math.ceil(offset / MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT) *
        MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT;
      assert.ok(aligned + size <= pageSize, "test allocator page overflow");
      offset = aligned + size;
      staged.push({
        page: pages[pageIndex],
        offset: aligned,
        size,
        seed: data.length > 0 ? data[0] : undefined,
      });
      return { buffer: pages[pageIndex], offset: aligned };
    },
    get allocationEpoch() {
      return epoch;
    },
    get currentPage() {
      return pages[pageIndex];
    },
  };
}

/** Allocator that violates the 256-byte alignment contract. */
function makeMisalignedAllocator() {
  const page = { __kind: "bad-page" };
  return {
    page,
    allocateAndWrite() {
      return { buffer: page, offset: 864 }; // 864 % 256 !== 0
    },
    allocationEpoch: 11,
  };
}

const LAYOUT = { __kind: "layout", label: "Model Camera BGL" };

const lightBlock = (seed) => {
  const data = new Float32Array(MODEL_LIGHT_UNIFORM_BYTES / 4);
  data[0] = seed;
  return data;
};
const cameraBlock = (seed) => {
  const data = new Float32Array(MODEL_CAMERA_UNIFORM_BYTES / 4);
  data[0] = seed;
  return data;
};

function acquireLight(arena, device, allocator, seed, label = "light") {
  return arena.acquireLightSlice(
    device,
    allocator,
    lightBlock(seed),
    MODEL_LIGHT_UNIFORM_BYTES,
    label,
  );
}

function acquireCamera(arena, device, allocator, seed, light, label = "cam") {
  return arena.acquire(
    device,
    allocator,
    LAYOUT,
    cameraBlock(seed),
    MODEL_CAMERA_UNIFORM_BYTES,
    label,
    light,
    MODEL_LIGHT_UNIFORM_BYTES,
  );
}

// ── Behavioral contracts ────────────────────────────────────────────────────

test("the light block width matches the packed LightUniforms struct", () => {
  // 64 (sun/ambient/IBL) + 16 (punctual header) + 640 (8 x 20 floats)
  // + 48 (iblReferenceFrameMatrix) + 96 (ENV-PARALLAX proxy) = 864.
  assert.equal(MODEL_LIGHT_UNIFORM_BYTES, 864);
  assert.equal(MODEL_LIGHT_UNIFORM_BYTES % 16, 0);
});

test("one pack per model serves every node and primitive of that model", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  // One model: 1 light acquisition, then a camera block per transformed node,
  // each of which is bound by every primitive of that node.
  const light = acquireLight(arena, device, allocator, 7);
  const bindings = [];
  for (let node = 0; node < 12; node++) {
    bindings.push(acquireCamera(arena, device, allocator, node, light));
  }

  assert.equal(arena.getStats().lightAcquisitions, 1);
  assert.equal(arena.getStats().acquisitions, 12);
  // Every node's binding addresses the SAME light bytes...
  const lightOffsets = new Set(bindings.map((b) => b.dynamicOffsets[1]));
  assert.equal(lightOffsets.size, 1);
  assert.equal([...lightOffsets][0], light.offset);
  // ...while each keeps its own camera slice.
  assert.equal(new Set(bindings.map((b) => b.dynamicOffsets[0])).size, 12);
  // And exactly one 864-byte payload was staged for the model.
  const lightStages = allocator.staged.filter(
    (s) => s.size === MODEL_LIGHT_UNIFORM_BYTES,
  );
  assert.equal(lightStages.length, 1);
});

test("the light offset is 256-aligned so it is a legal dynamic offset", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  for (let model = 0; model < 32; model++) {
    const light = acquireLight(arena, device, allocator, model);
    assert.equal(light.offset % MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT, 0);
    const binding = acquireCamera(arena, device, allocator, model, light);
    assert.equal(binding.dynamicOffsets.length, 2);
    // Ordered by binding index: camera (0) then light (1). A swapped array is
    // a silently wrong render, not a validation error, so it is pinned here.
    assert.equal(binding.dynamicOffsets[1], light.offset);
    assert.equal(
      binding.dynamicOffsets[1] % MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT,
      0,
    );
  }
  assert.equal(arena.getStats().misalignedRejections, 0);
});

test("separate models get separate light slices in one frame", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  const offsets = [];
  for (let model = 0; model < 5; model++) {
    const light = acquireLight(arena, device, allocator, model);
    offsets.push(light.offset);
    acquireCamera(arena, device, allocator, model, light);
  }
  // A shared slice would make every model render with the last model's IBL
  // factors and asset lights.
  assert.equal(new Set(offsets).size, 5);
  // Still one bind group: all of it is one ring page.
  assert.equal(device.created.bindGroups.length, 1);
});

test("capture faces never reuse the main view's light slice", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(4, allocator);

  // Capture runs before the main render inside one frame: one light per face
  // (its punctual positions are relative to THAT face's eye), several camera
  // records per face.
  const faceLightOffsets = [];
  for (let face = 0; face < 6; face++) {
    const faceLight = acquireLight(arena, device, allocator, 100 + face);
    faceLightOffsets.push(faceLight.offset);
    for (let record = 0; record < 3; record++) {
      const binding = acquireCamera(
        arena,
        device,
        allocator,
        face * 10 + record,
        faceLight,
        "capture",
      );
      assert.equal(binding.dynamicOffsets[1], faceLight.offset);
    }
  }
  const mainLight = acquireLight(arena, device, allocator, 999);

  assert.equal(new Set(faceLightOffsets).size, 6);
  assert.ok(!faceLightOffsets.includes(mainLight.offset));
  assert.equal(arena.getStats().lightAcquisitions, 7);
  // 7 light blocks + 18 camera blocks, still one bind group.
  assert.equal(device.created.bindGroups.length, 1);
});

test("bind-group creation stays flat across a full ring rotation", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator({ pageCount: 3 });

  // 40 frames x 4 models x 6 primitives. The pre-C11-195 shape would have
  // packed and uploaded 960 light blocks; this is 160 (one per model-frame).
  for (let frame = 1; frame <= 40; frame++) {
    allocator.beginFrame();
    arena.beginFrame(frame, allocator);
    for (let model = 0; model < 4; model++) {
      const light = acquireLight(arena, device, allocator, model);
      acquireCamera(arena, device, allocator, model, light);
    }
  }
  assert.equal(arena.getStats().lightAcquisitions, 160);
  // One bind group per page, forever — the light did not add a cache axis
  // because both blocks come from the same page.
  assert.equal(device.created.bindGroups.length, 3);
  assert.equal(arena.getStats().entries, 3);
});

test("a camera and a light on different pages key separate bind groups", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  const light = acquireLight(arena, device, allocator, 1);
  acquireCamera(arena, device, allocator, 1, light);
  assert.equal(device.created.bindGroups.length, 1);

  // Mid-frame overflow: the ring hands out a page the light does not live on,
  // in the SAME frame and allocation epoch — the slice is still valid, so the
  // stale-slice guard must not fire. Binding a group built over the OLD page
  // would read another model's bytes, so page identity must be part of the
  // key for BOTH entries.
  allocator.overflowToNextPage();
  acquireCamera(arena, device, allocator, 2, light);
  assert.equal(device.created.bindGroups.length, 2);
  assert.equal(arena.getStats().staleLightSliceRejections, 0);
  const descriptor = device.created.bindGroups[1].descriptor;
  assert.equal(descriptor.entries[1].resource.buffer, light.buffer);
  assert.notEqual(
    descriptor.entries[0].resource.buffer,
    descriptor.entries[1].resource.buffer,
  );
});

test("a light slice from a previous allocation epoch is rejected, not bound", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  const light = acquireLight(arena, device, allocator, 1);

  // A new frame recycles the ring: the slice's page can retain the same
  // GPUBuffer identity and offset while already holding another model/view's
  // bytes. The arena must reject the stale slice and degrade to the zero
  // placeholder instead of leaking those bytes into a draw.
  allocator.beginFrame();
  arena.beginFrame(2, allocator);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let binding;
  try {
    binding = acquireCamera(arena, device, allocator, 2, light);
  } finally {
    console.error = originalError;
  }

  assert.equal(arena.getStats().staleLightSliceRejections, 1);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /stale light slice/);
  assert.equal(binding.dynamicOffsets[1], 0);
  const descriptor =
    device.created.bindGroups[device.created.bindGroups.length - 1].descriptor;
  assert.notEqual(descriptor.entries[1].resource.buffer, light.buffer);
  assert.equal(
    descriptor.entries[1].resource.buffer.descriptor.label,
    "Model light arena zero placeholder",
  );
});

test("per-frame reset zeroes the light accounting", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();

  allocator.beginFrame();
  arena.beginFrame(10, allocator);
  const first = acquireLight(arena, device, allocator, 1);
  acquireLight(arena, device, allocator, 2);
  assert.equal(arena.getStats().lightAcquisitionsThisFrame, 2);

  allocator.beginFrame();
  arena.beginFrame(11, allocator);
  assert.equal(arena.getStats().lightAcquisitionsThisFrame, 0);
  const second = acquireLight(arena, device, allocator, 1);

  // Same offset, DIFFERENT page and epoch. This is why a slice may live only
  // in an update-scoped local: memoizing it on the model cache would bind
  // bytes the ring has already handed to someone else.
  assert.equal(second.offset, first.offset);
  assert.notEqual(second.buffer, first.buffer);
  assert.notEqual(second.allocationEpoch, first.allocationEpoch);
});

test("moving-camera honesty: every frame stages a fresh light block", () => {
  // The block carries CAMERA-RELATIVE punctual positions, a camera-relative
  // proxy center, and the eye->world rotation, so a moving camera changes its
  // bytes every frame. No unchanged-write suppression is claimed or possible
  // here; the win is one pack per MODEL instead of one per PRIMITIVE, not
  // fewer packs over time.
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();

  for (let frame = 1; frame <= 5; frame++) {
    allocator.beginFrame();
    arena.beginFrame(frame, allocator);
    // A moving camera: the packed bytes differ every frame.
    acquireLight(arena, device, allocator, frame * 1.5);
  }

  const lightStages = allocator.staged.filter(
    (s) => s.size === MODEL_LIGHT_UNIFORM_BYTES,
  );
  assert.equal(lightStages.length, 5);
  assert.deepEqual(
    lightStages.map((s) => s.seed),
    [1.5, 3, 4.5, 6, 7.5],
  );
  // Staging is a CPU memcpy into the page; the queue write is the context's
  // single per-page flush, not one call per block.
  assert.equal(device.created.writes.length, 0);
});

test("a new allocator generation invalidates light-bearing bind groups", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const first = makeAllocator();

  for (let frame = 1; frame <= 6; frame++) {
    first.beginFrame();
    arena.beginFrame(frame, first);
    const light = acquireLight(arena, device, first, frame);
    acquireCamera(arena, device, first, frame, light);
  }
  assert.equal(arena.getStats().entries, 3);

  // Device recovery rebuilds the context's ring on the same device: the pages
  // BOTH entries reference are destroyed.
  const second = makeAllocator();
  second.beginFrame();
  arena.beginFrame(7, second);
  assert.equal(arena.getStats().entries, 0);

  const light = acquireLight(arena, device, second, 7);
  acquireCamera(arena, device, second, 7, light);
  const descriptor =
    device.created.bindGroups[device.created.bindGroups.length - 1].descriptor;
  assert.equal(descriptor.entries[0].resource.buffer, second.currentPage);
  assert.equal(descriptor.entries[1].resource.buffer, second.currentPage);
});

test("no allocator degrades the light to a private buffer at offset 0", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  arena.beginFrame(1, null);

  const light = acquireLight(arena, device, null, 1, "fallback light");
  assert.equal(light.offset, 0);
  assert.equal(device.created.buffers.length, 1);
  assert.equal(device.created.buffers[0].descriptor.size, 864);
  assert.equal(device.created.writes.length, 1);

  const binding = acquireCamera(arena, device, null, 1, light);
  assert.deepEqual(binding.dynamicOffsets, [0, 0]);
  arena.invalidate();
  assert.ok(device.created.buffers.every((b) => b.destroyed));
});

test("a misaligned light offset is rejected, never forwarded", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const bad = makeMisalignedAllocator();
  arena.beginFrame(1, bad);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const light = acquireLight(arena, device, bad, 1);
    assert.equal(light.offset, 0);
    assert.notEqual(light.buffer, bad.page, "the misaligned page is unusable");
  } finally {
    console.error = originalError;
  }
  assert.equal(arena.getStats().misalignedRejections, 1);
  assert.match(errors[0], /not a multiple of 256/);
});

test("an acquire with no light slice still produces a valid bind group", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const binding = acquireCamera(arena, device, allocator, 1, null);
    // Zero-filled placeholder: an unlit model is a visible defect, but a bind
    // group missing an entry the layout declares loses the whole frame's
    // command buffer. Reported permanently so it cannot pass unnoticed.
    assert.equal(binding.dynamicOffsets.length, 2);
    assert.equal(binding.dynamicOffsets[1], 0);
    const descriptor = device.created.bindGroups[0].descriptor;
    assert.equal(descriptor.entries.length, 2);
    assert.equal(descriptor.entries[1].binding, 1);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no light slice/);
});

// ── Structural contracts ────────────────────────────────────────────────────

test("the group-0 layout declares the light at binding 1 with a dynamic offset", () => {
  assert.match(
    deviceResourcesSource,
    /uniformBuffer\(1, Stage\.FRAGMENT, \{\s*hasDynamicOffset: true,\s*minBindingSize: MODEL_LIGHT_UNIFORM_BYTES,/,
  );
});

test("the WGSL light binding moved to group 0 with the camera", () => {
  assert.match(
    modelWgslSource,
    /@group\(0\) @binding\(0\) var<uniform> camera: CameraUniforms;\n@group\(0\) @binding\(1\) var<uniform> light: LightUniforms;/,
  );
  assert.equal(
    /@group\(1\) @binding\(1\)/.test(modelWgslSource),
    false,
    "group-1 binding 1 must stay vacant — the layout no longer declares it",
  );
  // The material UBO keeps binding 0 of group 1; renumbering the rest would
  // desynchronize the layout, the WGSL, and every entries[] array.
  assert.match(
    modelWgslSource,
    /@group\(1\) @binding\(0\) var<uniform> material: MaterialUniforms;/,
  );
  assert.match(
    modelWgslSource,
    /@group\(1\) @binding\(2\) var baseColorTexture/,
  );
});

test("the merged group-1 layout no longer declares a light UBO", () => {
  // Both ends of the slice are declarations, not comment text: the KHR loop
  // header is what actually ends the always-present entries array, and it
  // stays put when the prose above it is reworded. The same loop header also
  // appears earlier in the file (inside MATERIAL_DEFINE_MASK), which is why
  // the search has to start from the opening anchor.
  const materialBGL = sliceBetween(
    pipelineCacheSource,
    "function buildMaterialBGL(",
    "for (let i = 0; i < KHR_BINDING_MANIFEST.length; i++) {",
  );
  assert.match(materialBGL, /uniformBuffer\(0, Stage\.VERTEX_FRAGMENT\),/);
  assert.equal(
    /uniformBuffer\(1, Stage\.FRAGMENT\),/.test(materialBGL),
    false,
    "a layout entry with no bind-group entry is a validation error",
  );
});

test("the renderer packs the light once per model, not once per primitive", () => {
  // Exactly two pack sites: the model/view slice and the capture face slice.
  const packs = rendererSource.match(/packLightUniforms\(/g);
  assert.equal(packs.length, 3, "1 definition + 2 call sites");
  assert.match(rendererSource, /packLightUniforms\(cache\.lightData,/);
  assert.match(rendererSource, /packLightUniforms\(captureLightData,/);
  // The per-primitive staging + upload state are gone with the per-primitive
  // buffer they fed.
  for (const symbol of [
    "primCache.lightBuffer",
    "primCache.lightData",
    "primCache.lightUploadState",
    "lightUploadState",
  ]) {
    assert.equal(
      rendererSource.includes(symbol),
      false,
      `${symbol} should no longer exist — the light block is model-level`,
    );
  }
});

test("the light slice is update-scoped, never memoized on a cache", () => {
  assert.match(
    rendererSource,
    /let modelLightSlice: ModelViewLightSlice \| undefined;/,
  );
  assert.equal(
    /cache\.lightSlice|nc\.lightSlice|primCache\.lightSlice/.test(
      rendererSource,
    ),
    false,
    "an arena slice belongs to one allocation epoch and must not persist",
  );
  // The CPU staging array IS model-level and IS retained — that is what makes
  // the pack once-per-model rather than once-per-node.
  assert.match(rendererSource, /lightData\?: Float32Array \| null;/);
});

test("every group-0 acquisition pairs a camera block with the light slice", () => {
  const acquisitions = rendererSource.match(/acquireModelCameraBinding\(/g);
  assert.equal(acquisitions.length, 5, "1 definition + 4 call sites");
  // Root, per-node, and IDL duplicate all pass the model slice; capture passes
  // its own face slice. A site that forgot would bind the zero placeholder.
  const modelSlicePairings = rendererSource.match(/\n\s+modelLightSlice,\n/g);
  assert.equal(modelSlicePairings.length, 3);
  assert.match(rendererSource, /\n\s+captureLightSlice,\n/);
});

test("the merged group-1 bind group and its cache dropped the light", () => {
  const builder = rendererSource.slice(
    rendererSource.indexOf("function buildMergedMaterialBindGroup("),
    rendererSource.indexOf("function defaultIBLEntries("),
  );
  assert.equal(
    /binding: 1,/.test(builder),
    false,
    "group 1 must not emit an entry the layout no longer declares",
  );
  const cacheFn = rendererSource.slice(
    rendererSource.indexOf("function getOrCreateMergedMaterialBindGroup("),
    rendererSource.indexOf("function createMaterialTextures("),
  );
  assert.equal(
    /cached\.lightBuffer === lightBuffer/.test(cacheFn),
    false,
    "a ring slice in this per-primitive key would multiply resident bind " +
      "groups by the ring's page count",
  );
  // The record shape must match the comparison, or the cache silently never
  // hits.
  assert.match(cacheFn, /cached\.materialBuffer === materialBuffer/);
});

test("the capture replay packs its own face light and shares it per face", () => {
  const capture = sliceBetween(
    rendererSource,
    "function getOrCreateModelCaptureCommands(",
    "function createPackedMaterialUploadState(",
  );
  // One lazily-realized slice per model replay (i.e. per face), reused by
  // every record of that face.
  assert.match(capture, /let captureLightSlice: ModelViewLightSlice \| null/);
  assert.match(capture, /if \(!captureLightSlice\) \{/);
  // The record no longer carries an on-screen light buffer to be reused.
  assert.equal(
    /lightBuffer: /.test(capture),
    false,
    "a capture face must never bind the on-screen view's light block",
  );
});

// Both slices above are bounded by declarations. Each one previously ended at a
// COMMENT — `// 12-25: KHR bindings` and a box-drawing section banner — so
// rewording either comment silently emptied the slice and every assertion over
// it passed vacuously. These controls fail if that shape ever comes back.
//
// The renames are deliberately NOT prefixes of the real anchors: a prefix
// rename still matches `indexOf`, so a prefix-based control can pass while the
// anchor is broken.
test("MUTATION: the slice anchors are declarations, and an absent one is caught", () => {
  for (const [source, open, close, label] of [
    [
      pipelineCacheSource,
      "function buildMaterialBGL(",
      "for (let i = 0; i < KHR_BINDING_MANIFEST.length; i++) {",
      "material BGL",
    ],
    [
      rendererSource,
      "function getOrCreateModelCaptureCommands(",
      "function createPackedMaterialUploadState(",
      "capture replay",
    ],
  ]) {
    // The live region must be non-empty, or the assertions over it prove
    // nothing. This is the leg that caught the first re-point of the material
    // BGL anchor, whose closing anchor also occurs ABOVE the opening one.
    const live = sliceBetween(source, open, close);
    assert.ok(
      live.length > 0,
      `${label}: the live slice is empty, so its assertions are vacuous`,
    );

    // The mutation: rename the closing anchor to something that shares no
    // prefix with it. A prefix rename still matches `indexOf`, so a
    // prefix-based control can pass while the anchor is already broken.
    //
    // It has to be the occurrence the slice actually uses. `String.replace`
    // with a string pattern rewrites the FIRST one in the file, which for the
    // material BGL is the copy above the opening anchor — mutating that leaves
    // the real closing anchor in place and the control never bites.
    const at = source.indexOf(close, source.indexOf(open) + open.length);
    const mutated = `${source.slice(0, at)}zzzRelocatedAnchorNoLongerPresent(${source.slice(at + close.length)}`;
    assert.equal(
      mutated.indexOf(close, mutated.indexOf(open) + open.length),
      -1,
      `${label}: the mutation did not actually remove the anchor the slice uses`,
    );
    assert.throws(
      () => sliceBetween(mutated, open, close),
      /closing anchor/,
      `${label}: a missing closing anchor must fail loudly, not silently widen the slice`,
    );
  }
});

test("MUTATION: neither slice is bounded by comment text any more", () => {
  // The two anchors this spec used to depend on. A rewrite shard is free to
  // delete or reword them; nothing here may read them again.
  for (const retired of ["// 12-25: KHR bindings", "// ─── Material Uniform"]) {
    assert.equal(
      specSource.includes(`indexOf("${retired}`),
      false,
      `this spec must not locate a region by the comment \`${retired}\``,
    );
  }
});
