// C11-195 — pure-Node contracts for the WebGPU model group-0 camera
// dynamic-offset arena.
//
// Two halves:
//
//   1. BEHAVIORAL. `WebGPUModelCameraArena` is a TypeScript module bundled
//      only into the combined engine barrel, so it is bundled here with
//      esbuild (`bundle: true` pulls in its one dependency, the identity-keyed
//      bind-group cache) and imported from a data: URL. Fake GPUDevice /
//      allocator doubles then exercise the offset-alignment, per-frame-reset,
//      view-isolation, and generation-invalidation contracts on the real code.
//
//   2. STRUCTURAL. Source-shape assertions that the four model camera call
//      sites and the two replay loops actually route through the arena and
//      forward its dynamic offsets. A behaviorally perfect arena that one
//      call site bypasses is a WebGPU validation error at runtime, which no
//      pure-Node test can otherwise see.
//
// Run: node --test Tools/visual-regression/model-camera-arena.spec.mjs

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
const deviceResourcesSource = await readSource(
  "Renderer/WebGPU/WebGPUModelDeviceResources.ts",
);
const drawCommandSource = await readSource(
  "Renderer/WebGPU/WebGPUDrawCommand.ts",
);
const captureSource = await readSource(
  "Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.ts",
);
const sceneRendererSource = await readSource(
  "Renderer/WebGPU/WebGPUSceneRenderer.ts",
);
const translucentPassSource = await readSource(
  "Renderer/WebGPU/WebGPUSceneRendererTranslucentPass.ts",
);
const contextSource = await readSource("Renderer/WebGPU/WebGPUContext.ts");

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
 * offsets inside a page, a new page object per `beginFrame`, and a monotonic
 * allocation epoch.
 */
function makeAllocator({ pageCount = 3, pageSize = 1 << 20 } = {}) {
  const pages = [];
  for (let i = 0; i < pageCount; i++) {
    pages.push({ __kind: "page", index: i });
  }
  let pageIndex = -1;
  let offset = 0;
  let epoch = 0;
  return {
    pages,
    beginFrame() {
      pageIndex = (pageIndex + 1) % pages.length;
      offset = 0;
      epoch++;
    },
    allocateAndWrite(data, allocationSize) {
      const size = allocationSize ?? data.byteLength;
      const aligned =
        Math.ceil(offset / MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT) *
        MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT;
      assert.ok(aligned + size <= pageSize, "test allocator page overflow");
      offset = aligned + size;
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
      return { buffer: page, offset: 320 }; // 320 % 256 !== 0
    },
    allocationEpoch: 7,
  };
}

const LAYOUT = { __kind: "layout", label: "Model Camera BGL" };
const cameraBlock = (seed) => {
  const data = new Float32Array(MODEL_CAMERA_UNIFORM_BYTES / 4);
  data[0] = seed;
  return data;
};

// C11-195 (light slice) — group 0 now carries the model/view light block at
// binding 1, so every acquisition supplies one. These camera contracts pin one
// light slice per arena so the camera axis stays isolated; the light's own
// contracts live in model-light-arena.spec.mjs.
function lightSliceFor(arena, device, allocator, seed = 0) {
  const data = new Float32Array(MODEL_LIGHT_UNIFORM_BYTES / 4);
  data[0] = seed;
  return arena.acquireLightSlice(
    device,
    allocator,
    data,
    MODEL_LIGHT_UNIFORM_BYTES,
    "light",
  );
}

function acquire(arena, device, allocator, data, label = "cam", light) {
  return arena.acquire(
    device,
    allocator,
    LAYOUT,
    data,
    MODEL_CAMERA_UNIFORM_BYTES,
    label,
    light ?? lightSliceFor(arena, device, allocator),
    MODEL_LIGHT_UNIFORM_BYTES,
  );
}

// ── Behavioral contracts ────────────────────────────────────────────────────

test("the camera block width matches the RTE CameraUniforms doctrine", () => {
  // mat4 mvpRTE + mat4 mvRTE + mat4 normal + 3 padded vec3 + mat4
  // previousViewProjection (DP-H41 tail) = 320 bytes.
  assert.equal(MODEL_CAMERA_UNIFORM_BYTES, 320);
  assert.equal(MODEL_CAMERA_UNIFORM_BYTES % 16, 0);
  // The layout binds the full struct, so the struct must fit an aligned slot.
  assert.ok(
    MODEL_CAMERA_UNIFORM_BYTES <= MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT * 2,
  );
});

test("every dynamic offset is a multiple of the 256-byte granularity", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  const seen = [];
  for (let i = 0; i < 64; i++) {
    const binding = acquire(arena, device, allocator, cameraBlock(i));
    // [cameraOffset, lightOffset] — ordered by binding index, which is what
    // WebGPU requires of a group with two dynamic bindings.
    assert.equal(binding.dynamicOffsets.length, 2);
    for (const each of binding.dynamicOffsets) {
      assert.equal(each % MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT, 0);
    }
    const offset = binding.dynamicOffsets[0];
    assert.equal(
      offset % MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT,
      0,
      `offset ${offset} is not 256-aligned`,
    );
    seen.push(offset);
  }
  // Distinct views in one frame must never share a slice.
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(arena.getStats().misalignedRejections, 0);
});

test("one bind group serves a whole ring page; offsets carry the variation", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  const bindGroups = new Set();
  for (let i = 0; i < 32; i++) {
    bindGroups.add(acquire(arena, device, allocator, cameraBlock(i)).bindGroup);
  }
  assert.equal(bindGroups.size, 1, "one page must yield one bind group");
  assert.equal(device.created.bindGroups.length, 1);

  const descriptor = device.created.bindGroups[0].descriptor;
  assert.equal(descriptor.layout, LAYOUT);
  // Camera at binding 0, model/view light at binding 1 (C11-195).
  assert.equal(descriptor.entries.length, 2);
  // Each entry addresses its page from 0 with exactly the struct width; the
  // per-draw offsets are what select the slices.
  assert.equal(descriptor.entries[0].binding, 0);
  assert.equal(descriptor.entries[0].resource.offset, 0);
  assert.equal(descriptor.entries[0].resource.size, MODEL_CAMERA_UNIFORM_BYTES);
  assert.equal(descriptor.entries[1].binding, 1);
  assert.equal(descriptor.entries[1].resource.offset, 0);
  assert.equal(descriptor.entries[1].resource.size, MODEL_LIGHT_UNIFORM_BYTES);
});

test("bind-group creation stays flat across a full ring rotation", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator({ pageCount: 3 });

  for (let frame = 1; frame <= 40; frame++) {
    allocator.beginFrame();
    arena.beginFrame(frame, allocator);
    for (let node = 0; node < 8; node++) {
      acquire(arena, device, allocator, cameraBlock(frame * 100 + node));
    }
  }
  // One per page, forever — this is the whole point of the dynamic offset.
  assert.equal(device.created.bindGroups.length, 3);
  assert.equal(arena.getStats().entries, 3);
  assert.equal(arena.getStats().acquisitions, 320);
});

test("per-frame reset: offsets restart and the frame stamp advances", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();

  allocator.beginFrame();
  arena.beginFrame(10, allocator);
  const first = acquire(arena, device, allocator, cameraBlock(1));
  acquire(arena, device, allocator, cameraBlock(2));
  assert.equal(arena.frameNumber, 10);
  assert.equal(arena.getStats().acquisitionsThisFrame, 2);

  allocator.beginFrame();
  arena.beginFrame(11, allocator);
  assert.equal(arena.frameNumber, 11);
  assert.equal(arena.getStats().acquisitionsThisFrame, 0);

  const second = acquire(arena, device, allocator, cameraBlock(1));
  assert.equal(second.dynamicOffsets[0], first.dynamicOffsets[0]);
  // Same offset, DIFFERENT page and epoch — which is exactly why a binding
  // must never be memoized across frames.
  assert.notEqual(second.bindGroup, first.bindGroup);
  assert.notEqual(second.allocationEpoch, first.allocationEpoch);
});

test("beginFrame is idempotent within one frame number", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();

  arena.beginFrame(5, allocator);
  acquire(arena, device, allocator, cameraBlock(1));
  // Every model update calls beginFrame; a second call must not wipe the
  // frame's accounting or drop the page's bind group.
  arena.beginFrame(5, allocator);
  arena.beginFrame(5, allocator);
  acquire(arena, device, allocator, cameraBlock(2));

  assert.equal(arena.getStats().acquisitionsThisFrame, 2);
  assert.equal(device.created.bindGroups.length, 1);
});

test("2D/IDL dual views take distinct offsets on one shared bind group", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(3, allocator);

  const primary = acquire(arena, device, allocator, cameraBlock(1), "primary");
  const idl = acquire(arena, device, allocator, cameraBlock(2), "2D-IDL");

  assert.equal(primary.bindGroup, idl.bindGroup);
  assert.notEqual(
    primary.dynamicOffsets[0],
    idl.dynamicOffsets[0],
    "the wrapped copy must not read the primary view's camera slice",
  );
  assert.notEqual(
    primary.dynamicOffsets,
    idl.dynamicOffsets,
    "the offset arrays must be separate objects",
  );
});

test("capture faces and the main view never share a slice", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(4, allocator);

  // Capture precedes the main render inside one frame: 6 faces x 3 records.
  const captureOffsets = [];
  for (let face = 0; face < 6; face++) {
    for (let record = 0; record < 3; record++) {
      captureOffsets.push(
        acquire(arena, device, allocator, cameraBlock(face), "capture")
          .dynamicOffsets[0],
      );
    }
  }
  const mainOffset = acquire(arena, device, allocator, cameraBlock(99))
    .dynamicOffsets[0];

  assert.equal(new Set(captureOffsets).size, 18);
  assert.ok(!captureOffsets.includes(mainOffset));
  // 19 distinct camera blocks, still one bind group.
  assert.equal(device.created.bindGroups.length, 1);
});

test("a new allocator generation invalidates every cached bind group", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const first = makeAllocator();

  for (let frame = 1; frame <= 6; frame++) {
    first.beginFrame();
    arena.beginFrame(frame, first);
    acquire(arena, device, first, cameraBlock(frame));
  }
  assert.equal(device.created.bindGroups.length, 3);
  assert.equal(arena.getStats().entries, 3);

  // Device recovery rebuilds the context's ring on the same device: the old
  // pages are destroyed, so every cached bind group is dangling.
  const second = makeAllocator();
  second.beginFrame();
  arena.beginFrame(7, second);
  assert.equal(arena.getStats().entries, 0, "stale page entries must be gone");

  acquire(arena, device, second, cameraBlock(7));
  assert.equal(device.created.bindGroups.length, 4);
  assert.equal(
    device.created.bindGroups[3].descriptor.entries[0].resource.buffer,
    second.currentPage,
  );
});

test("invalidate() clears the cache and frees fallback buffers", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);
  acquire(arena, device, allocator, cameraBlock(1));
  // Two fallback acquisitions (no allocator at all). Each mints a private
  // buffer for BOTH group-0 blocks — camera and light.
  acquire(arena, device, null, cameraBlock(2));
  acquire(arena, device, null, cameraBlock(3));
  assert.equal(arena.getStats().fallbackAllocations, 4);
  assert.equal(device.created.buffers.length, 4);

  arena.invalidate();
  assert.equal(arena.getStats().entries, 0);
  assert.equal(arena.frameNumber, -1);
  assert.ok(device.created.buffers.every((b) => b.destroyed));
});

test("no allocator degrades to a private buffer bound at offset 0", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  arena.beginFrame(1, null);

  const binding = acquire(arena, device, null, cameraBlock(1), "fallback cam");
  assert.deepEqual(binding.dynamicOffsets, [0, 0]);
  // One private buffer per group-0 block: the light (allocated first) and the
  // camera.
  assert.equal(device.created.buffers.length, 2);
  assert.equal(device.created.buffers[0].descriptor.size, 864);
  assert.equal(device.created.buffers[1].descriptor.size, 320);
  assert.equal(device.created.writes.length, 2);
  // Dynamic offset 0 is always alignment-legal, so the degraded path is still
  // valid against the `hasDynamicOffset` layout.
  for (const offset of binding.dynamicOffsets) {
    assert.equal(offset % MODEL_CAMERA_DYNAMIC_OFFSET_ALIGNMENT, 0);
  }
});

test("a misaligned ring offset is rejected, never forwarded to setBindGroup", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const bad = makeMisalignedAllocator();
  arena.beginFrame(1, bad);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    const binding = acquire(arena, device, bad, cameraBlock(1));
    assert.deepEqual(binding.dynamicOffsets, [0, 0]);
    for (const entry of device.created.bindGroups[0].descriptor.entries) {
      assert.notEqual(
        entry.resource.buffer,
        bad.page,
        "the misaligned page must not be bound",
      );
    }
  } finally {
    console.error = originalError;
  }
  // Both group-0 blocks were rejected (light first, then camera); the report
  // itself stays once-per-arena.
  assert.equal(arena.getStats().misalignedRejections, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not a multiple of 256/);
});

test("returned offset arrays are safe to share across command variants", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  const binding = acquire(arena, device, allocator, cameraBlock(1));
  const shared = binding.dynamicOffsets;
  // Color / pick / velocity / silhouette / translucent all hold this array;
  // a later acquisition must not mutate it.
  const before = shared.slice();
  acquire(arena, device, allocator, cameraBlock(2));
  acquire(arena, device, allocator, cameraBlock(3));
  assert.deepEqual(shared, before);
});

// ── Structural contracts ────────────────────────────────────────────────────

test("the model camera layout declares a dynamic offset and a min binding size", () => {
  assert.match(
    deviceResourcesSource,
    /makeBindGroupLayout\(device, "Model Camera BGL", \[\s*uniformBuffer\(0, Stage\.VERTEX_FRAGMENT, \{\s*hasDynamicOffset: true,\s*minBindingSize: MODEL_CAMERA_UNIFORM_BYTES,/,
  );
  // The MUTABLE arena is context-owned: its cached bind groups reference pages
  // from one context's uniform ring, and a pooled GPUDevice may back several
  // contexts at once. Only the immutable layout stays on the device-shared
  // resources; constructing the arena there would share page-identity state
  // across contexts.
  assert.match(
    contextSource,
    /this\._modelCameraArena = new WebGPUModelCameraArena\(\)/,
  );
  assert.equal(
    /new WebGPUModelCameraArena\(/.test(deviceResourcesSource),
    false,
    "the device-shared resources must not construct the mutable arena",
  );
  // The renderer resolves the owner through frameState.context — never the
  // device-shared pipeline cache.
  const resolver = rendererSource.slice(
    rendererSource.indexOf("function resolveModelCameraArenaOwner("),
    rendererSource.indexOf("function acquireModelCameraBinding("),
  );
  assert.match(resolver, /frameState\?\.context/);
  assert.match(resolver, /context\?\.modelCameraArena/);
  // Released with the ring it references: both the device-loss cache registry
  // and final context cleanup detach the arena, then invalidate it.
  assert.match(contextSource, /\.register\("modelCameraArena", \(\) => \{/);
  const invalidations = contextSource.match(
    /modelCameraArena\?\.invalidate\(\)/g,
  );
  assert.equal(invalidations.length, 2, "device-loss registry + final cleanup");
});

test("no model camera bind group is built outside the arena", () => {
  // Before C11-195 the renderer created group-0 camera bind groups at four
  // sites. Under a `hasDynamicOffset` layout each of those would have to
  // supply an offset independently; the arena is the single producer instead.
  const directCameraBindGroups = rendererSource.match(
    /layout:\s*pipelineCache\.cameraBGL/g,
  );
  assert.equal(
    directCameraBindGroups,
    null,
    "group-0 camera bind groups must come from WebGPUModelCameraArena",
  );
  const acquisitions = rendererSource.match(/acquireModelCameraBinding\(/g);
  // 1 definition + 4 call sites (capture, 2D/IDL, root, per-node).
  assert.equal(acquisitions.length, 5);
});

test("the persistent per-model / per-node camera buffers are gone", () => {
  for (const symbol of [
    "cameraBuffer2DIdl",
    "cameraBG2DIdl",
    "cache.cameraBuffer",
    "nc.cameraBuffer",
    "cache.cameraBG",
    "nc.cameraBG",
  ]) {
    assert.equal(
      rendererSource.includes(symbol),
      false,
      `${symbol} should no longer exist — its bytes ride the per-frame arena`,
    );
  }
  // The CPU staging arrays are retained: the shadow-cast UB reads the packed
  // model-space RTE eye back out of them.
  assert.match(rendererSource, /packCameraUniforms\(cache\.cameraData,/);
  assert.match(rendererSource, /packCameraUniforms\(nc\.cameraData,/);
});

test("the camera binding is update-scoped, never memoized on a cache", () => {
  assert.match(
    rendererSource,
    /let rootCameraBinding: ModelCameraBinding \| undefined;/,
  );
  assert.equal(
    /cache\.cameraBinding|nc\.cameraBinding/.test(rendererSource),
    false,
    "an arena slice belongs to one allocation epoch and must not persist",
  );
});

test("every model command variant forwards the group-0 dynamic offset", () => {
  const forwards = rendererSource.match(/bindGroupDynamicOffsets:/g);
  // primary args, IDL duplicate, pick shared args, pick metadata, velocity,
  // silhouette, translucent twin.
  assert.ok(
    forwards.length >= 7,
    `expected >= 7 dynamic-offset forwards, saw ${forwards.length}`,
  );
  // The IDL duplicate must swap BOTH the bind group and the offset.
  const idlBlock = rendererSource.slice(
    rendererSource.indexOf(
      "const idlBindGroups = webgpuCmdArgs.bindGroups.slice()",
    ),
    rendererSource.indexOf("commandList.push(idlCmd)"),
  );
  assert.match(idlBlock, /idlDynamicOffsets\[0\] = nodeIdlCameraOffsets/);
  assert.match(idlBlock, /bindGroupDynamicOffsets: idlDynamicOffsets/);
});

test("WebGPUDrawCommand binds and clones dynamic offsets", () => {
  assert.match(
    drawCommandSource,
    /passEncoder\.setBindGroup\(\s*i,\s*resolved \?\? this\.bindGroups\[i\],\s*dynamicOffsets,\s*\)/,
  );
  // A derived command that dropped the offsets would silently bind offset 0,
  // i.e. another model's camera slice.
  assert.match(
    drawCommandSource,
    /bindGroupDynamicOffsets: cloneDynamicOffsets\(/,
  );
  assert.match(
    drawCommandSource,
    /copy\[i\] = entry === undefined \? undefined : entry\.slice\(\)/,
  );
});

test("the indirect-merge run cannot span two different camera offsets", () => {
  // Bind-group IDENTITY used to imply identical bound state. Under the arena
  // two models on the same ring page share one group-0 bind group and differ
  // only in their offset, so identity alone would merge them into one
  // `drawIndexedIndirect` run drawn with the head's camera block.
  const runExtension = sceneRendererSource.slice(
    sceneRendererSource.indexOf("let runEnd = runStart + 1;"),
    sceneRendererSource.indexOf("const runLen = runEnd - runStart;"),
  );
  assert.match(runExtension, /sameBindGroupArray\(next\.bindGroups/);
  assert.match(
    runExtension,
    /sameDynamicOffsetArray\(\s*next\.bindGroupDynamicOffsets/,
  );
  // The merged run must then actually BIND the offsets it matched on.
  assert.match(
    sceneRendererSource,
    /renderPass\.setBindGroup\(g, headBindGroups\[g\], offsets\)/,
  );
  // Value comparison, not reference: sibling commands legitimately hold
  // distinct arrays with the same offset, and refusing to merge those would
  // silently undo the batching win.
  const comparator = sceneRendererSource.slice(
    sceneRendererSource.indexOf("function sameDynamicOffsetArray("),
    sceneRendererSource.indexOf("function sameVertexBufferArray("),
  );
  assert.match(comparator, /if \(ai\[j\] !== bi\[j\]\) return false;/);
});

test("the OIT accumulation pass forwards dynamic offsets", () => {
  // The OIT variant is built against the same pipeline layout as the color
  // pipeline, so group 0 stays a dynamic-offset binding there.
  const accumulate = translucentPassSource.slice(
    translucentPassSource.indexOf("const executeOITCommand ="),
    translucentPassSource.indexOf("for (let vi = 0; vi < cmd.vertexBuffers"),
  );
  assert.match(
    accumulate,
    /bindGroupDynamicOffsets\?: Array<number\[\] \| undefined>/,
  );
  assert.match(
    accumulate,
    /accPass\.setBindGroup\(\s*bi,\s*resolved \?\? cmd\.bindGroups\[bi\],\s*offsets,?\s*\)/,
  );
});

test("the environment capture replay forwards model group-0 offsets", () => {
  const modelReplay = captureSource.slice(
    captureSource.indexOf("for (let i = 0; i < modelCommands.length; i++)"),
    captureSource.indexOf("modelDrawCount++"),
  );
  assert.match(
    modelReplay,
    /bg === 0 && cmd\.bindGroup0DynamicOffsets !== undefined/,
  );
  assert.match(
    rendererSource,
    /bindGroup0DynamicOffsets: cameraBinding\.dynamicOffsets/,
  );
});
