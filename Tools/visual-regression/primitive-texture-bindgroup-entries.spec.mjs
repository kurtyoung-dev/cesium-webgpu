// primitive-texture-bindgroup-entries.spec.mjs — browser-free behaviour spec
// for the per-instance-color (non-material) textured primitive path. Pure Node:
// no browser, no GPU, no build.
//
// @purpose Pins that the non-material textured primitive path supplies one bind-group entry per "Texture BGL" layout entry, samples an opaque-white placeholder, and never selects a lit shader for a flat appearance.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
//
// `frustum-dev` on WebGPU took a GPU validation error on every frame:
//
//   Number of entries (2) did not match the expected number of entries (3)
//   for [BindGroupLayoutInternal "Texture BGL"]
//   … [Invalid BindGroup (unlabeled)] … SetBindGroup(2, …)
//
// `"Texture BGL"` declares three entries — a sampler and TWO texture slots, so
// single- and dual-texture shaders can share one layout — while the
// non-material builder supplied only two. WebGPU requires a bind group to
// supply exactly one entry per layout entry, so `createBindGroup` produced an
// invalid bind group and `CommandEncoder.finish()` then failed on the whole
// scene frame: nothing in the frame drew.
//
// Two further things had to be true before the frustum LOOKED right, not just
// stopped erroring. Both textured per-instance-color shaders shade
// `texColor * input.color`, and the placeholder they sampled was a 64×64 grey
// checkerboard — so the primitive was multiplied by a checkerboard. And the
// shader was selected from raw attribute presence, which lit a primitive whose
// appearance had asked for flat shading (`FrustumGeometry` allocates normals
// and st for every vertex format, so a `POSITION_ONLY` frustum still arrives
// carrying both).
//
// ── HOW THIS IS TESTED ──────────────────────────────────────────────────────
//
// `WebGPUPrimitiveCommands.ts` runs for real through the shared stub-dependency
// bundler (`lib/engine-stub-bundler.mjs`). Kept REAL: `Core/` (the RTE maths
// writes into `Float32Array`s, and a Proxy there throws on numeric coercion),
// `WebGPUBindGroupLayoutHelpers` (it BUILDS the layout entries this spec reads
// back — a stub here would let the harness invent the very layout under test),
// `WebGPUPrimitiveShaders` (it makes the shader choice under test) and
// `WebGPUTexture` (it forwards the placeholder bytes to `queue.writeTexture`).
// Everything else is an inert Proxy.
//
// The fixture is a fake `GPUDevice` that records the descriptors the real code
// passes to `createBindGroupLayout`, `createBindGroup`, `createRenderPipeline`
// and `queue.writeTexture`, and returns the SAME object for a layout each time
// so a bind group can be matched to its layout by identity rather than by
// label. Nothing about the layout is supplied by the fixture: its entries come
// out of the engine's own `makeBindGroupLayout` call.
//
// A1-A3 pin the behaviour on the current source. A4-A6 are the inertness
// mutants (Principle 10): each makes one half of the fix unreachable on a COPY
// of the source (the files on disk are never touched) and requires the matching
// assertion to fail.
//
// CRLF: this repo checks out with `core.autocrlf=true`; sources are
// LF-normalised before bundling and before anchor matching.
//
// Run: node --test Tools/visual-regression/primitive-texture-bindgroup-entries.spec.mjs

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bundle } from "./lib/engine-stub-bundler.mjs";
import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import Matrix4 from "../../packages/engine/Source/Core/Matrix4.js";

const directory = dirname(fileURLToPath(import.meta.url));
const ENGINE_SOURCE = resolve(directory, "../../packages/engine/Source");
const CORE_DIR = resolve(ENGINE_SOURCE, "Core");
const ENTRY_PATH = resolve(
  ENGINE_SOURCE,
  "Renderer/WebGPU/WebGPUPrimitiveCommands.ts",
);
const SHADERS_PATH = resolve(
  ENGINE_SOURCE,
  "Renderer/WebGPU/WebGPUPrimitiveShaders.js",
);

// Kept real for the reasons in the header. `Pass`, `SceneMode` and `ShadowMode`
// are frozen enums the command path compares against; a Proxy would compare
// unequal to every branch and silently steer the run.
const REAL = [
  "defined",
  "WebGPUBindGroupLayoutHelpers",
  "WebGPUPrimitiveShaders",
  "WebGPUTexture",
  "Pass",
  "SceneMode",
  "ShadowMode",
];

// WebGPU's platform globals. The browser supplies these; Node does not, and the
// command path reads `GPUShaderStage` and `GPUBufferUsage` directly. The bit
// values are fixed by the WebGPU specification.
function installWebGPUGlobals() {
  globalThis.GPUShaderStage ??= { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
  globalThis.GPUBufferUsage ??= {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
  globalThis.GPUTextureUsage ??= {
    COPY_SRC: 0x01,
    COPY_DST: 0x02,
    TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08,
    RENDER_ATTACHMENT: 0x10,
  };
  if (!globalThis.navigator?.gpu) {
    Object.defineProperty(globalThis, "navigator", {
      value: { gpu: { getPreferredCanvasFormat: () => "bgra8unorm" } },
      configurable: true,
      writable: true,
    });
  }
}

async function readLF(path) {
  return (await readFile(path, "utf8")).split("\r\n").join("\n");
}

async function loadCommands({ mutate, label, overrides } = {}) {
  installWebGPUGlobals();
  return bundle({
    path: ENTRY_PATH,
    source: await readLF(ENTRY_PATH),
    real: REAL,
    realDir: CORE_DIR,
    mutate,
    label,
    overrides,
    preseed: [SHADERS_PATH],
  });
}

// A fake device that records what the real code asks it to build. Layout
// objects are returned by identity so a bind group's `layout` field IS the
// layout object the engine created, not a label that could collide.
function recordingDevice() {
  const record = {
    layouts: [],
    bindGroups: [],
    pipelines: [],
    pipelineLayouts: [],
    textureWrites: [],
  };
  const device = {
    createBindGroupLayout(descriptor) {
      const layout = {
        label: descriptor.label,
        entries: descriptor.entries ?? [],
      };
      record.layouts.push(layout);
      return layout;
    },
    createBindGroup(descriptor) {
      const bindGroup = {
        label: descriptor.label,
        layout: descriptor.layout,
        entries: descriptor.entries ?? [],
      };
      record.bindGroups.push(bindGroup);
      return bindGroup;
    },
    createBuffer: (descriptor) => ({ label: descriptor.label }),
    createSampler: () => ({ sampler: true }),
    createPipelineLayout(descriptor) {
      record.pipelineLayouts.push({ label: descriptor.label });
      return { bindGroupLayouts: descriptor.bindGroupLayouts };
    },
    createRenderPipeline(descriptor) {
      record.pipelines.push({
        label: descriptor.label,
        vertexStride: descriptor.vertex?.buffers?.[0]?.arrayStride,
      });
      return { label: descriptor.label };
    },
    createShaderModule: (descriptor) => ({ label: descriptor.label }),
    createTexture: (descriptor) => ({
      label: descriptor.label,
      createView: () => ({ view: descriptor.label }),
      destroy() {},
    }),
    queue: {
      writeBuffer() {},
      writeTexture(destination, data, layout, size) {
        record.textureWrites.push({ data: Array.from(data), size });
      },
    },
  };
  return { device, record };
}

// A minimal geometry in the shape `extractPositionData` reads: RTE-split
// positions, plus whichever of normal/st the case needs.
function geometry({ normal, st }) {
  const vertexCount = 3;
  const attributes = {
    position3DHigh: {
      values: new Float32Array(vertexCount * 3),
      componentsPerAttribute: 3,
    },
    position3DLow: {
      values: new Float32Array(vertexCount * 3),
      componentsPerAttribute: 3,
    },
  };
  if (normal) {
    attributes.normal = {
      values: new Float32Array(vertexCount * 3),
      componentsPerAttribute: 3,
    };
  }
  if (st) {
    attributes.st = {
      values: new Float32Array(vertexCount * 2),
      componentsPerAttribute: 2,
    };
  }
  return {
    attributes,
    indices: new Uint16Array([0, 1, 2]),
    primitiveType: 4,
  };
}

function drive(namespace, { attributes, flat }) {
  const { device, record } = recordingDevice();
  const identity = Matrix4.clone(Matrix4.IDENTITY);
  const context = {
    device,
    scenePipelineFormat: "rgba8unorm",
    pickPipelineFormat: "rgba8unorm",
    _scenePipelineFormatGeneration: 0,
    uniformState: {
      view: Matrix4.clone(Matrix4.IDENTITY),
      projection: Matrix4.clone(Matrix4.IDENTITY),
    },
  };
  const frameState = {
    context,
    camera: { positionWC: new Cartesian3(1.0, 2.0, 3.0) },
    mode: 3,
  };
  const primitive = {
    _geometries: [geometry(attributes)],
    modelMatrix: identity,
    _allowPicking: false,
    _pickIds: [],
  };
  let threw;
  try {
    namespace.createWebGPUCommands(
      primitive,
      { flat },
      undefined,
      true,
      false,
      [],
      [],
      frameState,
    );
  } catch (error) {
    threw = error;
  }
  return { ...record, threw };
}

const bindings = (entries) =>
  entries.map((entry) => entry.binding).sort((a, b) => a - b);

function textureLayout(record) {
  const found = record.layouts.filter((l) => l.label === "Texture BGL");
  assert.equal(
    found.length,
    1,
    `expected exactly one "Texture BGL" layout, saw ${record.layouts
      .map((l) => l.label)
      .join(", ")}`,
  );
  return found[0];
}

// The assertion under test in A1 and A4: every bind group the path builds
// supplies one entry per entry of the layout it was built against. This is the
// rule WebGPU itself validates; a shortfall invalidates the bind group and,
// through it, the frame's command buffer.
function assertEveryBindGroupMatchesItsLayout(record) {
  assert.ok(
    record.bindGroups.length > 0,
    `no bind group was created${record.threw ? ` — the run threw: ${record.threw.message}` : ""}`,
  );
  for (const bindGroup of record.bindGroups) {
    const layout = bindGroup.layout;
    assert.ok(
      layout && Array.isArray(layout.entries),
      `bind group ${bindGroup.label ?? "(unlabeled)"} names a layout this fixture did not create`,
    );
    assert.deepEqual(
      bindings(bindGroup.entries),
      bindings(layout.entries),
      `bind group ${bindGroup.label ?? "(unlabeled)"} supplies bindings ` +
        `[${bindings(bindGroup.entries)}] for layout "${layout.label}" which ` +
        `declares [${bindings(layout.entries)}] — WebGPU rejects the bind group`,
    );
  }
}

// The textured non-material path, reached by a geometry carrying st.
const TEXTURED = { attributes: { normal: false, st: true }, flat: false };
// The `frustum-dev` shape: a flat appearance over geometry that carries both
// normals and st because FrustumGeometry emits them regardless of vertex format.
const FLAT_FRUSTUM = { attributes: { normal: true, st: true }, flat: true };

test("A1 every bind group on the textured non-material path supplies one entry per layout entry", async () => {
  const namespace = await loadCommands();
  const record = drive(namespace, TEXTURED);
  assert.equal(record.threw, undefined, String(record.threw?.stack ?? ""));

  const layout = textureLayout(record);
  assert.deepEqual(
    bindings(layout.entries),
    [0, 1, 2],
    "the engine's own Texture BGL is expected to declare a sampler and two texture slots",
  );
  assertEveryBindGroupMatchesItsLayout(record);

  const textureBindGroup = record.bindGroups.find((b) => b.layout === layout);
  assert.ok(textureBindGroup, "no bind group was built for Texture BGL");
  assert.ok(
    typeof textureBindGroup.label === "string" &&
      textureBindGroup.label.length > 0,
    "the texture bind group must carry a label — an unlabeled bind group " +
      "reaches the validation message as [Invalid BindGroup (unlabeled)]",
  );

  // Binding indices alone are not the whole of WebGPU's rule: it also validates
  // each resource against its layout entry's TYPE, so a bind group that put the
  // sampler at binding 2 would satisfy the count and still be rejected. The
  // layout declares two texture slots, and the secondary is meant to hold the
  // same placeholder view as the primary.
  const entryAt = (binding) =>
    textureBindGroup.entries.find((e) => e.binding === binding);
  assert.equal(
    entryAt(2).resource,
    entryAt(1).resource,
    "binding 2 must hold the same texture view as binding 1 — the layout's " +
      "secondary slot is a texture, not a second sampler",
  );
  assert.notEqual(
    entryAt(2).resource,
    entryAt(0).resource,
    "binding 2 must not hold the sampler",
  );
});

test("A2 a flat appearance selects an unlit shader even when the geometry carries normals", async () => {
  const namespace = await loadCommands();
  const record = drive(namespace, FLAT_FRUSTUM);
  assert.equal(record.threw, undefined, String(record.threw?.stack ?? ""));

  // The pipeline layout is labelled with the shader the path selected, and the
  // vertex stride is that shader's own layout — 12 floats for basicTextured
  // (position high/low, uv, colour) against 15 for phongTextured, which also
  // uploads a normal it would only need in order to light the primitive.
  const labels = record.pipelineLayouts.map((p) => p.label).join(" | ");
  assert.equal(
    labels,
    "Primitive PL basicTextured",
    "a flat appearance must not be shaded by a Phong variant",
  );
  assert.deepEqual(
    [...new Set(record.pipelines.map((p) => p.vertexStride))],
    [12 * 4],
    "the uploaded vertex has no normal for a flat appearance",
  );
  assertEveryBindGroupMatchesItsLayout(record);
});

test("A2b the lit selection is unchanged when the appearance does not ask for flat shading", async () => {
  installWebGPUGlobals();
  const shaders = await bundle({
    path: SHADERS_PATH,
    source: await readLF(SHADERS_PATH),
    real: ["defined"],
    realDir: CORE_DIR,
  });
  const attributes = geometry({ normal: true, st: true }).attributes;
  assert.equal(
    shaders.selectWebGPUShader(attributes).type,
    "phongTextured",
    "a lit appearance over normals + st still selects the Phong textured shader",
  );
  assert.equal(
    shaders.selectWebGPUShader(attributes, { flat: false }).type,
    "phongTextured",
  );
  assert.equal(
    shaders.selectWebGPUShader(attributes, { flat: true }).type,
    "basicTextured",
  );
  assert.equal(
    shaders.selectWebGPUShader(geometry({ normal: true, st: false }).attributes)
      .type,
    "phong",
  );
  assert.equal(
    shaders.selectWebGPUShader(
      geometry({ normal: true, st: false }).attributes,
      {
        flat: true,
      },
    ).type,
    "basic",
  );
});

test("A3 the placeholder the textured non-material path samples is one opaque white texel", async () => {
  const namespace = await loadCommands();
  const record = drive(namespace, TEXTURED);
  assert.equal(record.threw, undefined, String(record.threw?.stack ?? ""));

  assert.equal(
    record.textureWrites.length,
    1,
    "expected exactly one placeholder texture upload on this path",
  );
  const [write] = record.textureWrites;
  assert.deepEqual(
    write.data,
    [255, 255, 255, 255],
    "both textured per-instance-color shaders compute `texColor * input.color`, " +
      "so any placeholder but opaque white tints every fragment of every " +
      "primitive on this path",
  );
  assert.deepEqual(
    [write.size.width, write.size.height],
    [1, 1],
    "the placeholder is a single texel",
  );
});

// ── Inertness mutants ───────────────────────────────────────────────────────
// Each rewrites a COPY of the source so one half of the fix is present but
// unreachable, and requires the matching assertion above to fail.

test("A4 MUTANT — dropping the third bind-group entry brings the entry-count mismatch back", async () => {
  const namespace = await loadCommands({
    label: "texture bind group binding 2 entry",
    mutate: (source) =>
      source.replace(
        "          { binding: 2, resource: cache.defaultTexture.view },\n",
        "          ...(false\n            ? [{ binding: 2, resource: cache.defaultTexture.view }]\n            : []),\n",
      ),
  });
  const record = drive(namespace, TEXTURED);
  assert.throws(
    () => assertEveryBindGroupMatchesItsLayout(record),
    /supplies bindings \[0,1\] for layout "Texture BGL" which declares \[0,1,2\]/,
  );
});

test("A5 MUTANT — leaving the placeholder unwritten breaks the opaque-white assertion", async () => {
  const namespace = await loadCommands({
    label: "opaque white placeholder upload",
    mutate: (source) =>
      source.replace(
        '        "PrimitiveFallbackWhite",\n      );\n      cache.defaultTexture.write(new Uint8Array([255, 255, 255, 255]));',
        '        "PrimitiveFallbackWhite",\n      );\n      if (false) {\n        cache.defaultTexture.write(new Uint8Array([255, 255, 255, 255]));\n      }',
      ),
  });
  const record = drive(namespace, TEXTURED);
  assert.equal(
    record.textureWrites.length,
    0,
    "the mutant is supposed to make the placeholder upload unreachable",
  );
});

test("A6 MUTANT — making the flat check inert lets a flat appearance be lit again", async () => {
  installWebGPUGlobals();
  const shaders = await bundle({
    path: SHADERS_PATH,
    source: await readLF(SHADERS_PATH),
    real: ["defined"],
    realDir: CORE_DIR,
    label: "flat suppression of the lit variants",
    mutate: (source) =>
      source.replace(
        "  const isFlat = defined(options) && options.flat === true;",
        "  const isFlat = false && defined(options) && options.flat === true;",
      ),
  });
  const attributes = geometry({ normal: true, st: true }).attributes;
  assert.equal(
    shaders.selectWebGPUShader(attributes, { flat: true }).type,
    "phongTextured",
    "the mutant is supposed to restore the attribute-only selection",
  );
});
