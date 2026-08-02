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

const rendererTsPath = resolve(
  engineRoot,
  "Renderer/WebGPU/WebGPUModelRenderer.ts",
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

// ── Renderer bundle (dead-device posture) ───────────────────────────────────
//
// `resolveModelCameraArenaOwner` is module-private, so its posture used to be
// reachable only by regex. It is bundled here with two esbuild plugins:
//
//   - `shaderStubPlugin` replaces the build-generated `Source/Shaders/**.js`
//     string modules (they only exist after `gulp build`) with empty strings.
//     The resolver never reads shader text.
//   - `exposeResolverPlugin` appends ONE re-export line to the renderer's own
//     source. The function body under test is the real, unmodified one — the
//     appended `export { ... }` merely binds the existing hoisted declaration.
//
// A source pin below asserts the declaration really is a top-level `function`,
// which is what makes the appended export bind the function under test rather
// than silently resolving to something else.
const shaderStubPlugin = {
  name: "shader-stub",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /\/Shaders\// }, (args) => ({
      path: args.path,
      namespace: "model-arena-shader-stub",
    }));
    pluginBuild.onLoad(
      { filter: /.*/, namespace: "model-arena-shader-stub" },
      () => ({ contents: 'export default "";', loader: "js" }),
    );
  },
};
const exposeResolverPlugin = {
  name: "expose-model-camera-arena-resolver",
  setup(pluginBuild) {
    pluginBuild.onLoad(
      { filter: /WebGPUModelRenderer\.ts$/ },
      async (args) => ({
        contents: `${await readFile(args.path, "utf8")}
export { resolveModelCameraArenaOwner };
`,
        loader: "ts",
        resolveDir: dirname(args.path),
      }),
    );
  },
};
const rendererBundle = await build({
  entryPoints: [rendererTsPath],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  logLevel: "silent",
  plugins: [shaderStubPlugin, exposeResolverPlugin],
});
const { resolveModelCameraArenaOwner } = await import(
  `data:text/javascript;base64,${Buffer.from(
    rendererBundle.outputFiles[0].text,
  ).toString("base64")}`
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
  // Every slice this allocator actually handed out, in call order. The trim
  // contracts below compare the arena's interned tuples against these so an
  // interning bug that returns SOME cached tuple instead of THIS acquisition's
  // pair cannot pass by looking merely self-consistent.
  const handed = [];
  return {
    pages,
    handed,
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
      handed.push({ page: pages[pageIndex], offset: aligned, size });
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

// ── C11-195 allocation-trim contracts (behavioral) ──────────────────────────
//
// The hot path used to mint one two-element offset array AND one template-
// string bind-group key per acquire — per node, per model, per view, per
// frame. Both are retained now. These contracts are strictly stronger than the
// pre-trim ones: everything the pre-trim arena guaranteed (256-alignment,
// distinct slices per view, one bind group per page, safe sharing across
// command variants) is still asserted above and below, and these add the
// steady-state allocation bound plus the anti-aliasing invariants that the
// retention introduces as NEW failure modes.

test("trim: a repeating frame pattern interns its offset tuples", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator({ pageCount: 3 });

  const instances = new Set();
  const valuePairs = new Set();
  let acquisitions = 0;
  for (let frame = 1; frame <= 40; frame++) {
    allocator.beginFrame();
    arena.beginFrame(frame, allocator);
    for (let node = 0; node < 8; node++) {
      const binding = acquire(arena, device, allocator, cameraBlock(node));
      instances.add(binding.dynamicOffsets);
      valuePairs.add(binding.dynamicOffsets.join(","));
      acquisitions++;
    }
  }

  assert.equal(acquisitions, 320);
  // The ring restarts every frame, so 320 acquisitions only ever address 8
  // distinct (cameraOffset, lightOffset) pairs.
  assert.equal(valuePairs.size, 8);
  // MUTATION GUARD — reverting `_offsetTupleFor(...)` to a `[a, b]` literal
  // makes this 320. Nothing else in the suite would notice: every value-level
  // assertion keeps passing while the allocation cost returns.
  assert.equal(
    instances.size,
    8,
    "steady-state acquisition must allocate no new offset arrays",
  );
});

test("trim: tuple identity tracks offset VALUES exactly and never aliases", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator({ pageCount: 3 });

  const bindings = [];
  for (let frame = 1; frame <= 3; frame++) {
    allocator.beginFrame();
    arena.beginFrame(frame, allocator);
    for (let node = 0; node < 6; node++) {
      // `acquire` allocates the light slice first, then the camera block, so
      // the allocator's last two hand-outs are exactly this acquisition's pair.
      const binding = acquire(arena, device, allocator, cameraBlock(node));
      const handed = allocator.handed;
      const light = handed[handed.length - 2];
      const camera = handed[handed.length - 1];
      // MUTATION GUARD — an intern keyed on the wrong value (or a memo that
      // returned the previous acquisition's tuple) would hand back a
      // well-formed but WRONG pair, which every alignment/uniqueness assertion
      // in this file would still accept.
      assert.deepEqual(
        [...binding.dynamicOffsets],
        [camera.offset, light.offset],
        "the tuple must carry THIS acquisition's own ring offsets",
      );
      bindings.push(binding);
    }
  }

  // Interning is an equivalence relation over the offset pair: same instance
  // if and only if same values. Either direction failing is a real defect —
  // "different instance, same values" means the trim silently stopped working,
  // "same instance, different values" means a draw would bind another view's
  // camera slice.
  for (const a of bindings) {
    for (const b of bindings) {
      const sameValues =
        a.dynamicOffsets[0] === b.dynamicOffsets[0] &&
        a.dynamicOffsets[1] === b.dynamicOffsets[1];
      assert.equal(
        a.dynamicOffsets === b.dynamicOffsets,
        sameValues,
        `identity/value mismatch for [${a.dynamicOffsets}] vs [${b.dynamicOffsets}]`,
      );
    }
  }
});

test("trim: a shared tuple is frozen, so a rogue write fails loudly", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  const binding = acquire(arena, device, allocator, cameraBlock(1));
  const snapshot = [...binding.dynamicOffsets];
  assert.ok(Object.isFrozen(binding.dynamicOffsets));
  // Strictly stronger than "a later acquisition does not mutate it": the array
  // is now shared by every command variant AND by every later acquisition with
  // the same offsets, so ANY writer must fail rather than corrupt them all.
  // MUTATION GUARD — dropping `Object.freeze` makes both of these silent.
  assert.throws(() => {
    binding.dynamicOffsets[0] = 999;
  }, TypeError);
  assert.throws(() => {
    binding.dynamicOffsets.push(0);
  }, TypeError);
  assert.deepEqual([...binding.dynamicOffsets], snapshot);

  // The degraded (no-allocator) path returns an interned tuple too.
  const fallback = acquire(arena, device, null, cameraBlock(2));
  assert.ok(Object.isFrozen(fallback.dynamicOffsets));
  assert.deepEqual([...fallback.dynamicOffsets], [0, 0]);
});

test("trim: the memoized bind-group key still separates pages and layouts", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator({ pageCount: 3 });

  // (a) Page identity. Each frame rotates to a different page; the memo must
  // miss on every rotation. MUTATION GUARD — a memo that omitted the camera
  // buffer from its identity tuple would reuse frame 1's bind group (built
  // over a page that is still in flight) for frames 2 and 3.
  for (let frame = 1; frame <= 3; frame++) {
    allocator.beginFrame();
    arena.beginFrame(frame, allocator);
    const binding = acquire(arena, device, allocator, cameraBlock(frame));
    assert.equal(
      binding.bindGroup.descriptor.entries[0].resource.buffer,
      allocator.currentPage,
      `frame ${frame} must bind its OWN ring page`,
    );
  }
  assert.equal(device.created.bindGroups.length, 3);

  // (b) Layout identity, inside ONE frame and ONE page — the case where the
  // memo's fast path is otherwise live. MUTATION GUARD — a memo that compared
  // only the buffers would hand the second layout the first layout's group,
  // which is a WebGPU validation error at setBindGroup time.
  const otherLayout = { __kind: "layout", label: "Model Camera BGL (variant)" };
  allocator.beginFrame();
  arena.beginFrame(4, allocator);
  const alternating = [];
  for (let i = 0; i < 6; i++) {
    const layout = i % 2 === 0 ? LAYOUT : otherLayout;
    alternating.push(
      arena.acquire(
        device,
        allocator,
        layout,
        cameraBlock(i),
        MODEL_CAMERA_UNIFORM_BYTES,
        "cam",
        lightSliceFor(arena, device, allocator),
        MODEL_LIGHT_UNIFORM_BYTES,
      ),
    );
  }
  assert.equal(
    new Set(alternating.map((each) => each.bindGroup)).size,
    2,
    "one bind group per layout, not one shared and not six",
  );
  // Frame 4 rotates back onto page 0, so only the variant layout is a miss.
  assert.equal(device.created.bindGroups.length, 4);
  for (let i = 0; i < alternating.length; i++) {
    assert.equal(
      alternating[i].bindGroup.descriptor.layout,
      i % 2 === 0 ? LAYOUT : otherLayout,
      `acquisition ${i} must carry its own layout`,
    );
  }
});

test("trim: retained acquisition state is dropped with its ring", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();

  const first = makeAllocator();
  first.beginFrame();
  arena.beginFrame(1, first);
  const before = acquire(arena, device, first, cameraBlock(1));

  // Recovery rebuilds the ring: same offsets, brand-new pages.
  const second = makeAllocator();
  second.beginFrame();
  arena.beginFrame(2, second);
  const after = acquire(arena, device, second, cameraBlock(1));

  assert.deepEqual([...after.dynamicOffsets], [...before.dynamicOffsets]);
  // MUTATION GUARD — without `_resetRetainedAcquisitionState()` on the
  // allocator swap the arena keeps handing back the pre-recovery tuple (and
  // keeps the destroyed page + its key string reachable). Identity is the only
  // observable difference, because the VALUES legitimately coincide.
  assert.notEqual(
    after.dynamicOffsets,
    before.dynamicOffsets,
    "a tuple minted against a destroyed page must not be reissued",
  );
  assert.notEqual(after.bindGroup, before.bindGroup);
  assert.equal(
    after.bindGroup.descriptor.entries[0].resource.buffer,
    second.currentPage,
  );

  // `invalidate()` has the same posture as the swap.
  arena.invalidate();
  const third = makeAllocator();
  third.beginFrame();
  arena.beginFrame(3, third);
  const post = acquire(arena, device, third, cameraBlock(1));
  assert.deepEqual([...post.dynamicOffsets], [...before.dynamicOffsets]);
  assert.notEqual(post.dynamicOffsets, after.dynamicOffsets);
});

test("trim: the stale-light-slice epoch guard is unaffected", () => {
  const arena = new WebGPUModelCameraArena();
  const device = makeDevice();
  const allocator = makeAllocator();
  allocator.beginFrame();
  arena.beginFrame(1, allocator);

  // A slice acquired against LAST frame's epoch must never enter a bind group,
  // trim or no trim: the recycled page holds unrelated bytes now.
  const stale = lightSliceFor(arena, device, allocator, 1);
  allocator.beginFrame();
  arena.beginFrame(2, allocator);

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let binding;
  try {
    binding = acquire(arena, device, allocator, cameraBlock(1), "cam", stale);
  } finally {
    console.error = originalError;
  }
  assert.equal(arena.getStats().staleLightSliceRejections, 1);
  // The rejected slice is replaced by the zero block, NOT by the stale page.
  assert.notEqual(
    binding.bindGroup.descriptor.entries[1].resource.buffer,
    stale.buffer,
  );
  assert.equal(binding.dynamicOffsets.length, 2);
  assert.ok(Object.isFrozen(binding.dynamicOffsets));
});

// ── C11-195 dead-device posture (behavioral) ────────────────────────────────
//
// `WebGPUContext.modelCameraArena` returns null EXACTLY while the device is
// unavailable. The resolver used to throw on every null, which turned that
// documented graceful degradation into a hard failure on a device that is
// already gone. Correct posture: skip the draw on a dead device, stay loud
// everywhere else. These are strictly stronger than the old regex pins — the
// old ones only asserted that the resolver mentions `frameState?.context` and
// `context?.modelCameraArena` (still asserted below), which every one of the
// wrong postures would also satisfy.

const deadDeviceContexts = [
  ["destroyed", { modelCameraArena: null, _isDestroyed: true }],
  ["terminally lost", { modelCameraArena: null, _isTerminallyLost: true }],
  [
    "destroyed and lost",
    { modelCameraArena: null, _isDestroyed: true, _isTerminallyLost: true },
  ],
];

test("posture: a null arena on a dead device SKIPS the draw", () => {
  for (const [name, context] of deadDeviceContexts) {
    assert.equal(
      resolveModelCameraArenaOwner({ context }),
      null,
      `${name} must degrade, not throw`,
    );
  }
});

test("posture: a null arena on a HEALTHY device stays loud", () => {
  const loud = [
    ["no lifecycle flags at all", { modelCameraArena: null }],
    [
      "both flags explicitly false",
      { modelCameraArena: null, _isDestroyed: false, _isTerminallyLost: false },
    ],
    // MUTATION GUARD — a posture that widened the skip to "any falsy arena"
    // (or that tested the flags with `!== false` / truthiness on a missing
    // property) would swallow these. A missing arena on a live device is a
    // wiring failure feeding an active draw and must never render nothing
    // silently.
    ["no arena property at all", {}],
    ["undefined arena", { modelCameraArena: undefined }],
    [
      "undefined arena with a dead flag",
      { modelCameraArena: undefined, _isDestroyed: true },
    ],
  ];
  for (const [name, context] of loud) {
    assert.throws(
      () => resolveModelCameraArenaOwner({ context }),
      /Model camera arena is unavailable for an active model draw/,
      `${name} must stay loud`,
    );
  }
  // A frameState with no context at all is the same structural failure.
  for (const frameState of [{}, { context: undefined }, undefined, null]) {
    assert.throws(
      () => resolveModelCameraArenaOwner(frameState),
      /Model camera arena is unavailable for an active model draw/,
    );
  }
});

test("posture: a live arena wins over every lifecycle flag", () => {
  const arena = { __kind: "arena" };
  for (const flags of [
    {},
    { _isDestroyed: true },
    { _isTerminallyLost: true },
    { _isDestroyed: true, _isTerminallyLost: true },
  ]) {
    const context = { modelCameraArena: arena, ...flags };
    assert.equal(resolveModelCameraArenaOwner({ context }), context);
  }
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

test("posture: the resolver is the hoisted declaration the bundle re-exports", () => {
  // Precondition for the behavioral posture tests above: the appended
  // `export { resolveModelCameraArenaOwner }` binds THIS declaration. If the
  // resolver ever became a `const` arrow below its call sites, or moved into a
  // class, the appended export would stop resolving to the tested body — and
  // the posture tests would quietly test nothing.
  assert.match(rendererSource, /\nfunction resolveModelCameraArenaOwner\(/);
  assert.equal(
    /resolveModelCameraArenaOwner\s*=/.test(rendererSource),
    false,
    "the resolver must stay a top-level function declaration",
  );
});

test("posture: the skip predicate matches the arena getter's null condition", () => {
  // The renderer degrades on EXACTLY the states that make the getter return
  // null. Pinning both halves in one place is what keeps them from drifting:
  // if `_isDeviceUnavailable` grows a third term, this fails and forces the
  // renderer's predicate to grow with it — otherwise the new lifecycle state
  // would hit the loud throw instead of the documented degradation.
  const unavailable = contextSource.slice(
    contextSource.indexOf("private get _isDeviceUnavailable()"),
    contextSource.indexOf("get device(): GPUDevice | null"),
  );
  assert.match(
    unavailable,
    /return this\._isDestroyed \|\| this\._isTerminallyLost;/,
  );
  const arenaGetter = contextSource.slice(
    contextSource.indexOf("get modelCameraArena()"),
    contextSource.indexOf("get performanceManager()"),
  );
  assert.match(
    arenaGetter,
    /if \(this\._isDeviceUnavailable\) \{\s*return null;/,
  );
  const resolver = rendererSource.slice(
    rendererSource.indexOf("function resolveModelCameraArenaOwner("),
    rendererSource.indexOf("function acquireModelCameraBinding("),
  );
  assert.match(resolver, /context\._isDestroyed === true/);
  assert.match(resolver, /context\._isTerminallyLost === true/);
  // The loud path is still reachable — the degradation did not replace it.
  assert.match(
    resolver,
    /throw new Error\(\s*"\[CesiumJS:webgpu\] Model camera arena is unavailable for an active model draw\./,
  );
});

test("posture: every arena helper is nullable and every call site guards it", () => {
  // A nullable helper whose result flows unguarded into `.bindGroup` would
  // convert the old loud throw into a TypeError one frame later — strictly
  // worse than what it replaced.
  for (const signature of [
    /function resolveModelCameraArenaOwner\([\s\S]{0,120}?\): ModelRenderContext \| null \{/,
    /function acquireModelCameraBinding\([\s\S]{0,400}?\): ModelCameraBinding \| null \{/,
    /function acquireModelLightSlice\([\s\S]{0,300}?\): ModelViewLightSlice \| null \{/,
    /function prepareModelViewLightSlice\([\s\S]{0,400}?\): ModelViewLightSlice \| null \{/,
  ]) {
    assert.match(rendererSource, signature);
  }

  const guardedCallSites = (name, expected) => {
    const sites = [];
    let from = 0;
    for (;;) {
      const at = rendererSource.indexOf(`${name}(`, from);
      if (at < 0) {
        break;
      }
      from = at + name.length;
      if (rendererSource.slice(Math.max(0, at - 9), at) === "function ") {
        continue; // the definition itself
      }
      sites.push(at);
    }
    assert.equal(sites.length, expected, `${name} call-site count`);
    for (const at of sites) {
      const window = rendererSource.slice(at, at + 700);
      assert.match(
        window,
        /(=== null|!== null|!defined\()/,
        `${name} at index ${at} forwards a possibly-null result unguarded`,
      );
    }
  };
  // capture replay, 2D/IDL duplicate, identity-transform root, per-node.
  guardedCallSites("acquireModelCameraBinding", 4);
  // capture light, and the per-model preparation helper.
  guardedCallSites("acquireModelLightSlice", 2);
  // The two lazy realizations inside updateWebGPUModel.
  guardedCallSites("prepareModelViewLightSlice", 2);
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
