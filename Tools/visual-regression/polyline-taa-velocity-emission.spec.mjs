// polyline-taa-velocity-emission.spec.mjs — browser-free behaviour spec for the
// WebGPU PolylineCollection TAA motion-vector path. Pure Node: no browser, no
// GPU, no build.
//
// @purpose Pins that an animating PolylineCollection with TAA on attaches a velocity draw command on the base-colour shader path, emits none when TAA is off or the material has no velocity entry points, and none at all with no polylines.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT (AR-752 / L2-COL-1) ──────────────────────────────────
//
// `archive/AUDIT_2026_05_02.md` recorded polyline TAA velocity as SHIPPED in
// Batch 148. It was not reachable. The gate that decides whether a polyline
// material has velocity entry points read
//
//     if (materialType !== "polylineColor") { return null; }
//
// but `materialType` at that call site is the collection's PUBLIC
// `Material.type` — "Color", "PolylineDash", "PolylineGlow", "Image", … — while
// `"polylineColor"` is the lowercase SHADER KEY this renderer's own
// `MATERIAL_SHADER_KEYS` maps `Color` ONTO. The two namespaces never intersect,
// so the gate was unconditionally true: the velocity pipeline was never built
// and `cmd.velocityCommand` was never constructed, for any material, on any
// frame. `git log -S` on the gate returns exactly one commit — the one that
// claims to ship it. The measurement is banked as `AR-M38`: over six
// animated frames × six material types the gate was entered 36 times and
// returned null 36 times, with 0 velocity pipelines and 0 velocity commands.
//
// The fix resolves the key before comparing, exactly as the shader-module
// lookup fourteen lines below already did.
//
// ── WHY IT IS TESTED THIS WAY ───────────────────────────────────────────────
//
// The row's acceptance is a GPU number (non-zero texels in the rg16float
// velocity target, then a ghost-smear ratio against WebGL) and that leg is a
// probe the Edge executor runs — `probe-polyline-taa-velocity.mjs`. This spec
// is the browser-free half: it drives the REAL `updateWebGPUPolylines` through
// the shared stub bundler against a recording fake `GPUDevice` and asserts the
// OBSERVABLE emission — whether a velocity draw command exists on the command
// the renderer pushed, what it is built from, and whether a velocity pipeline
// was created. A velocity command that is never constructed cannot paint a
// texel, so this spec is upstream of the probe's number, not a restatement of
// it.
//
// Nothing here greps the source for the fixed expression. A1 would pass on any
// implementation that emits the command and fail on any that does not.
//
// A6 is the inertness mutant: it makes the FIX unreachable rather than absent,
// by short-circuiting the key resolution the fix introduced
// (`(false && selectShaderKey(materialType)) !== "polylineColor"` — always
// true, so the gate closes again) and requires A1's assertion to come back RED
// with the pre-fix count of zero. A7-A9 pin the pure arithmetic of the Edge
// probe named above, which runs on a slot this lane does not have.
//
// ── ROUND 3: EMISSION IS NOT ENOUGH (Batch 1448) ────────────────────────────
//
// With the gate fixed, Éowyn's Edge leg still read the velocity target flat
// zero in three runs — `nonZero: 0` over all 307,200 texels with a maximum
// magnitude of 1.3328e-7. That maximum is the finding: a target cleared to zero
// and never drawn into reads EXACTLY zero, so a non-zero maximum proves the
// velocity FS ran and wrote. 1.3328e-7 is `hypot(2·2^-24, 2^-24)`, one and two
// half-precision denormal ULPs, and it is precisely the residual the FS leaves
// when the two position streams carry the SAME world positions: the current
// clip position goes through the RTE path and the previous one through a full
// mat4 multiply of `high + low` in f32, and those two spellings of one point
// differ by 0.10-0.16 m at that scene's geometry — 6e-8 to 9e-8 NDC at its
// camera. A stepped frame would have read ~1.6e-2, five orders of magnitude
// larger.
//
// So the engine emitted, drew, and correctly wrote ZERO MOTION for a polyline
// that had not moved. What had not moved was the probe's subject: `Viewer` runs
// its own render loop (`CesiumWidget.js:657`, `useDefaultRenderLoop ?? true`,
// rendering on every rAF) and the probe stepped its polyline only before its
// OWN `scene.render()` calls, so the frame that reached the readback was one
// the probe never stepped. A10 and A11 pin the two engine facts that diagnosis
// rests on — the streams differ across a stepped frame and are equal across an
// unstepped one, and the target the pipeline writes is the target the probe
// copies — and A12/A13/A15 pin the instrument changes that make an all-zero
// read attributable rather than vacuous.
//
// CRLF: this repo checks out with `core.autocrlf=true`; the entry source is
// LF-normalised before bundling.
//
// Run: node --test Tools/visual-regression/polyline-taa-velocity-emission.spec.mjs
// Runner home: `npm run test-engine-node`.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "./lib/engine-stub-bundler.mjs";
import {
  countNonZeroVelocityTexels,
  countNonZeroVelocityTexelsInRegion,
  decodeHalf,
  velocityCellFromRead,
  verdictsFor,
} from "./probe-polyline-taa-velocity.mjs";
import Cartesian3 from "../../packages/engine/Source/Core/Cartesian3.js";
import Matrix4 from "../../packages/engine/Source/Core/Matrix4.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const ENGINE_SOURCE = resolve(ROOT, "packages/engine/Source");
const CORE_DIR = resolve(ENGINE_SOURCE, "Core");
const ENTRY = resolve(
  ENGINE_SOURCE,
  "Renderer/WebGPU/WebGPUPolylineRenderer.js",
);
const PROBE = resolve(HERE, "probe-polyline-taa-velocity.mjs");
const SCENE_FRAMEBUFFER = resolve(
  ENGINE_SOURCE,
  "Renderer/WebGPU/WebGPUSceneFramebuffer.ts",
);
// The probe self-runs when it IS the entry point. Under the stub bundler
// `isEntryPoint` is a Proxy and therefore truthy, and `await`ing the Proxy that
// `runProbe` returns would never settle, so the guard is removed before the
// mutation is applied. Nothing asserted here depends on it.
const PROBE_ENTRY_GUARD =
  "if (isEntryPoint(import.meta.url)) {\n" +
  "  process.exitCode = await runProbe(descriptor);\n" +
  "}\n";

// Kept real, each for a reason a Proxy would break:
//   `Core/`            — the packers write into Float32Arrays; a Proxy there
//                        throws on numeric coercion.
//   Pass / SceneMode / BlendOption — frozen enums the command path compares
//                        against; a Proxy compares unequal to every branch.
//   WebGPUShaderDefines — the define mask is built with `|=`; a Proxy throws.
//   WebGPUBuffer       — its `.size` is compared numerically against a required
//                        byte count, and its `.label` is what identifies the
//                        previous-frame stream in A1.
//   WebGPUDrawCommand  — the whole question is "was `cmd.velocityCommand`
//                        constructed", and a Proxy answers yes to every read.
const REAL = [
  "defined",
  "Pass",
  "SceneMode",
  "BlendOption",
  "WebGPUShaderDefines",
  "WebGPUBuffer",
  "WebGPUDrawCommand",
];

// WebGPU's platform globals. The browser supplies these; Node does not, and the
// renderer reads `GPUBufferUsage` directly. The bit values are fixed by spec.
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
}

async function loadRenderer({ mutate, label } = {}) {
  installWebGPUGlobals();
  const source = (await readFile(ENTRY, "utf8")).split("\r\n").join("\n");
  return bundle({
    path: ENTRY,
    source,
    real: REAL,
    realDir: CORE_DIR,
    mutate,
    label,
  });
}

// A fake device that records the pipelines and buffers the real code asks it to
// build. Nothing about a pipeline is supplied by the fixture: the entry point,
// the target format and the label all come out of the renderer's own descriptor.
function recordingDevice() {
  // `writes` carries the BYTES, not just the sizes: the question A10 asks is
  // whether the velocity command's two instance streams differ, and a stream
  // that is the right length and the wrong content emits exactly zero velocity.
  const record = { pipelines: [], buffers: [], writes: [] };
  const device = {
    createBindGroupLayout: (d) => ({
      label: d.label,
      entries: d.entries ?? [],
    }),
    createBindGroup: (d) => ({ label: d.label }),
    createBuffer(d) {
      record.buffers.push({ label: d.label, size: d.size });
      return { label: d.label, size: d.size, destroy() {} };
    },
    createSampler: () => ({}),
    createPipelineLayout: (d) => ({ bindGroupLayouts: d.bindGroupLayouts }),
    createRenderPipeline(d) {
      const pipeline = {
        label: d.label,
        vertexEntryPoint: d.vertex?.entryPoint,
        fragmentEntryPoint: d.fragment?.entryPoint,
        targets: (d.fragment?.targets ?? []).map((t) => t?.format),
        vertexBufferCount: d.vertex?.buffers?.length ?? 0,
        depthWriteEnabled: d.depthStencil?.depthWriteEnabled,
      };
      record.pipelines.push(pipeline);
      return pipeline;
    },
    createShaderModule: (d) => ({ label: d.label }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    queue: {
      // Mirrors `GPUQueue.writeBuffer`'s two shapes: with an ArrayBuffer the
      // offset and size are in BYTES, with a typed array they are in elements.
      // The renderer passes `.buffer`, i.e. the ArrayBuffer form.
      writeBuffer(buffer, bufferOffset, data, dataOffset, size) {
        const source = data instanceof ArrayBuffer ? data : data.buffer;
        const offset =
          data instanceof ArrayBuffer
            ? (dataOffset ?? 0)
            : data.byteOffset + (dataOffset ?? 0);
        const length = size ?? source.byteLength - offset;
        record.writes.push({
          label: buffer?.label,
          bytes: Buffer.from(new Uint8Array(source, offset, length)),
        });
      },
      writeTexture() {},
    },
  };
  return { device, record };
}

// A `PolylineCollection`-shaped fixture. `material.type` carries the PUBLIC
// material type string, which is what the collection puts there and what the
// renderer groups and gates on.
function makeCollection(materialType, { count = 2 } = {}) {
  const material = {
    type: materialType,
    uniforms: { color: { red: 1, green: 0, blue: 0, alpha: 1 } },
  };
  const polylines = [];
  for (let i = 0; i < count; i++) {
    polylines.push({
      show: true,
      width: 4.0,
      loop: false,
      material,
      _color: { red: 1, green: 0, blue: 0, alpha: 1 },
      positions: [
        new Cartesian3(6378137.0 + i * 10.0, 0.0, 0.0),
        new Cartesian3(6378137.0 + i * 10.0, 100000.0, 0.0),
      ],
    });
  }
  return {
    _polylines: polylines,
    modelMatrix: Matrix4.clone(Matrix4.IDENTITY),
    // `PolylineCollection` builds this in its constructor through
    // `createCommandOrdering(renderLayer, renderPriority)`; the command site
    // reads all three fields.
    _commandOrdering: { sortLayer: 50, sortPriority: 0, materialSortId: 0 },
    _boundingVolume: undefined,
    _blendOption: undefined,
    _opaqueRS: undefined,
    _translucentRS: undefined,
  };
}

// Move the far endpoint every frame. A static polyline emits zero velocity BY
// DESIGN, so an unanimated fixture could not tell "the gate is closed" from
// "nothing moved" — which is the confusion that let this defect survive.
function animate(collection, frame) {
  for (const polyline of collection._polylines) {
    polyline.positions[1] = new Cartesian3(
      polyline.positions[1].x,
      100000.0 + frame * 5000.0,
      0.0,
    );
  }
}

function makeContext(device) {
  return {
    device,
    // A null central cache makes `tryResolvePolylinePipeline` create
    // synchronously, so the run is deterministic from the first frame instead
    // of depending on when an async pipeline settles.
    webgpuPipelineCache: null,
    depthFormat: "depth24plus-stencil8",
    scenePipelineFormat: "rgba8unorm",
    pickPipelineFormat: "rgba8unorm",
    _scenePipelineFormatGeneration: 0,
    canvas: { width: 1024, height: 768 },
    drawingBufferWidth: 1024,
    uniformState: {
      view: Matrix4.clone(Matrix4.IDENTITY),
      projection: Matrix4.clone(Matrix4.IDENTITY),
      currentFrustum: { x: 1.0, y: 1.0e8 },
      previousViewProjection: Matrix4.clone(Matrix4.IDENTITY),
    },
  };
}

function makeFrameState(context, frameNumber, taaEnabled) {
  return {
    context,
    camera: { positionWC: new Cartesian3(9000000.0, 0.0, 0.0) },
    mode: 3,
    morphTime: 1.0,
    frameNumber,
    taaEnabled,
    passes: { render: true, pick: false },
    minimumDisableDepthTestDistance: 0.0,
    splitPosition: 0.0,
  };
}

/**
 * Runs `frames` animated frames of one collection and returns what the renderer
 * emitted.
 *
 * @param {object} namespace The bundled renderer namespace.
 * @param {object} options Run options.
 * @param {string} options.materialType Public `Material.type`.
 * @param {boolean} options.taaEnabled Value of `frameState.taaEnabled`.
 * @param {number} [options.frames] Frame count.
 * @param {number} [options.polylineCount] Polylines in the collection.
 * @param {boolean} [options.moving] When false the collection is packed once and
 *   never moved again, which is the state an unmoved polyline is in on every
 *   frame the scene renders without stepping it.
 * @returns {Promise<object>} `{ colorCommands, velocityCommands, record, writesByFrame }`
 */
async function drive(
  namespace,
  { materialType, taaEnabled, frames = 4, polylineCount = 2, moving = true },
) {
  const { device, record } = recordingDevice();
  const context = makeContext(device);
  const collection = makeCollection(materialType, { count: polylineCount });
  const colorCommands = [];
  const velocityCommands = [];
  const writesByFrame = [];
  for (let frame = 0; frame < frames; frame++) {
    animate(collection, moving ? frame : 0);
    const writesBefore = record.writes.length;
    const commandList = [];
    await namespace.updateWebGPUPolylines(
      collection,
      makeFrameState(context, frame, taaEnabled),
      commandList,
    );
    writesByFrame.push(record.writes.slice(writesBefore));
    for (const command of commandList) {
      colorCommands.push(command);
      if (command.velocityCommand !== undefined) {
        velocityCommands.push(command.velocityCommand);
      }
    }
  }
  return { colorCommands, velocityCommands, record, writesByFrame };
}

// The last payload written to a buffer whose label ends the given way, in one
// frame's slice. The labels come from the renderer's own `createVertexBuffer`
// calls, so nothing here names a buffer the renderer does not.
const payload = (frameWrites, suffix) =>
  frameWrites
    .filter((write) => new RegExp(`${suffix}$`).test(String(write.label)))
    .pop()?.bytes;
const currentStream = (frameWrites) => payload(frameWrites, "segments");
const previousStream = (frameWrites) => payload(frameWrites, "prev segments");

const velocityPipelines = (record) =>
  record.pipelines.filter((p) => String(p.label ?? "").includes("velocity"));

// The four material variants whose WGSL has no `vertexVelocityMain` /
// `fragmentVelocityMain`. Emitting velocity for these would bind a pipeline
// whose entry point does not exist.
const NO_VELOCITY_ENTRY_POINTS = [
  "PolylineArrow",
  "PolylineDash",
  "PolylineGlow",
  "PolylineOutline",
];

test("A1 an animating polyline collection with TAA on attaches a velocity draw command built from the current and previous segment streams", async () => {
  const namespace = await loadRenderer();
  const { colorCommands, velocityCommands, record } = await drive(namespace, {
    materialType: "Color",
    taaEnabled: true,
  });

  assert.equal(
    colorCommands.length,
    4,
    "the collection should push one colour command per frame",
  );
  assert.equal(
    velocityCommands.length,
    4,
    "every colour command of an animating TAA-on collection must carry a " +
      "velocity command — with none, the rg16float velocity target receives " +
      "nothing from this collection and TAA reprojects the polyline with the " +
      "camera-only fallback, which is what smears an animating line",
  );

  // The velocity command reads TWO instance streams: this frame's segment
  // buffer at slot 0 and the one-frame-lagged mirror at slot 1. The velocity VS
  // differences them; a single-stream command could only ever emit zero.
  const [velocity] = velocityCommands;
  assert.equal(
    velocity.vertexBuffers.length,
    2,
    "the velocity command binds the current and previous segment buffers",
  );
  assert.match(
    String(velocity.vertexBuffers[0].label),
    /segments$/,
    "slot 0 is the current-frame segment buffer",
  );
  assert.match(
    String(velocity.vertexBuffers[1].label),
    /prev segments$/,
    "slot 1 is the previous-frame mirror the velocity VS differences against",
  );
  assert.equal(
    velocity.instanceCount,
    colorCommands[0].instanceCount,
    "velocity must cover exactly the instances the colour pass drew",
  );

  // The pipeline the command carries is the velocity pipeline, identified by
  // what the renderer itself put in the descriptor.
  const built = velocityPipelines(record);
  assert.equal(
    built.length,
    1,
    `expected one velocity pipeline, saw ${record.pipelines.map((p) => p.label).join(" | ")}`,
  );
  assert.equal(velocity.pipeline, built[0]);
  assert.equal(built[0].vertexEntryPoint, "vertexVelocityMain");
  assert.equal(built[0].fragmentEntryPoint, "fragmentVelocityMain");
  assert.deepEqual(
    built[0].targets,
    ["rg16float"],
    "the velocity pipeline writes the rg16float velocity attachment",
  );
  assert.equal(
    built[0].depthWriteEnabled,
    false,
    "the velocity pass shares scene depth read-only",
  );
  assert.equal(
    built[0].vertexBufferCount,
    2,
    "the velocity pipeline declares both instance streams",
  );
});

test("A2 the same collection with TAA off attaches no velocity command and builds no velocity pipeline", async () => {
  const namespace = await loadRenderer();
  const { colorCommands, velocityCommands, record } = await drive(namespace, {
    materialType: "Color",
    taaEnabled: false,
  });
  assert.equal(colorCommands.length, 4, "the colour pass is unaffected");
  assert.deepEqual(
    velocityCommands,
    [],
    "TAA off must stay zero-cost: no velocity command is attached",
  );
  assert.deepEqual(
    velocityPipelines(record).map((p) => p.label),
    [],
    "TAA off must not compile a velocity pipeline",
  );
});

test("A3 material variants with no velocity entry points still emit no velocity command", async () => {
  const namespace = await loadRenderer();
  for (const materialType of NO_VELOCITY_ENTRY_POINTS) {
    const { colorCommands, velocityCommands, record } = await drive(namespace, {
      materialType,
      taaEnabled: true,
    });
    assert.equal(
      colorCommands.length,
      4,
      `${materialType}: the colour pass still runs`,
    );
    assert.deepEqual(
      velocityCommands,
      [],
      `${materialType}: its WGSL has no vertexVelocityMain, so a velocity ` +
        `command would bind a pipeline whose entry point does not exist`,
    );
    assert.deepEqual(
      velocityPipelines(record).map((p) => p.label),
      [],
      `${materialType}: no velocity pipeline may be compiled`,
    );
  }
});

test("A4 a material with no dedicated shader is drawn by the base module and therefore does emit velocity", async () => {
  // `selectShaderKey` routes anything it does not recognise to "polylineColor",
  // so the colour pass already draws an `Image` polyline with the base module —
  // the one that carries the velocity entry points. Gating velocity on the
  // resolved KEY keeps the two passes agreeing about which module is in play.
  const namespace = await loadRenderer();
  const { velocityCommands, record } = await drive(namespace, {
    materialType: "Image",
    taaEnabled: true,
  });
  assert.equal(
    velocityCommands.length,
    4,
    "an Image-material polyline renders with the base colour shader, so its " +
      "velocity entry points are available to it too",
  );
  assert.equal(velocityPipelines(record).length, 1);
});

test("A5 an empty collection emits nothing at all, with TAA on or off", async () => {
  const namespace = await loadRenderer();
  for (const taaEnabled of [true, false]) {
    const { colorCommands, velocityCommands, record } = await drive(namespace, {
      materialType: "Color",
      taaEnabled,
      polylineCount: 0,
    });
    assert.deepEqual(
      [colorCommands.length, velocityCommands.length],
      [0, 0],
      `taaEnabled=${taaEnabled}: a scene with no polyline must produce no ` +
        `commands, so its capture is unchanged by this work`,
    );
    assert.deepEqual(record.pipelines, []);
  }
});

// ── Inertness mutant ────────────────────────────────────────────────────────
// The fix is the key RESOLUTION inside the gate's condition. Short-circuiting
// it with `false &&` leaves the call in the source but never evaluates it, so
// the condition degenerates to `false !== "polylineColor"` — always true, the
// gate closes for every material, and the emission returns to its pre-fix
// count of zero. The fix is unreachable, not absent.

test("A6 MUTANT — making the shader-key resolution unreachable closes the gate again and A1 goes red", async () => {
  const namespace = await loadRenderer({
    label: "velocity gate shader-key resolution",
    mutate: (source) =>
      source.replace(
        `  if (selectShaderKey(materialType) !== "polylineColor") {`,
        `  if ((false && selectShaderKey(materialType)) !== "polylineColor") {`,
      ),
  });
  const { colorCommands, velocityCommands, record } = await drive(namespace, {
    materialType: "Color",
    taaEnabled: true,
  });

  assert.equal(
    colorCommands.length,
    4,
    "the mutant must leave the colour pass alone, or the mutant is testing " +
      "something other than the gate",
  );
  assert.equal(
    velocityCommands.length,
    0,
    "with the key resolution unreachable the gate is unconditionally true " +
      "again — this is the measured pre-fix state, 0 velocity commands over " +
      "an animated run",
  );
  assert.deepEqual(
    velocityPipelines(record).map((p) => p.label),
    [],
  );
});

// ── The Edge leg's pure arithmetic ──────────────────────────────────────────
// `probe-polyline-taa-velocity.mjs` is the row's acceptance, and it runs on an
// Edge slot this lane does not have. Its decode and verdict logic is pure and
// is pinned here so a wrong half-float decode or an inverted verdict cannot
// reach the seat as a green probe. Importing the probe module does not launch
// anything: its `runProbe` call sits behind `isEntryPoint`.

test("A7 the probe decodes rg16float half-floats correctly", () => {
  // Exact patterns, not round-trips through the same code: 0x0000 zero,
  // 0x3C00 one, 0xBC00 minus one, 0x3555 the nearest half to 1/3, 0x0001 the
  // smallest subnormal, 0x7C00 infinity, 0x7E00 NaN.
  assert.equal(decodeHalf(0x0000), 0);
  assert.equal(decodeHalf(0x3c00), 1);
  assert.equal(decodeHalf(0xbc00), -1);
  assert.ok(Math.abs(decodeHalf(0x3555) - 1 / 3) < 1e-3);
  assert.equal(decodeHalf(0x0001), 2 ** -24);
  assert.equal(decodeHalf(0x7c00), Infinity);
  assert.ok(Number.isNaN(decodeHalf(0x7e00)));
});

test("A8 the probe counts only texels whose motion clears the noise floor", () => {
  // Four texels: still, still-but-quantisation-noise, moving, moving.
  const halves = [
    0x0000,
    0x0000, // (0, 0) — still
    0x0001,
    0x0000, // (2^-24, 0) — below the floor
    0x3c00,
    0x0000, // (1, 0) — moving
    0x0000,
    0xbc00, // (0, -1) — moving
  ];
  const counted = countNonZeroVelocityTexels(halves);
  assert.equal(counted.total, 4);
  assert.equal(
    counted.nonZero,
    2,
    "a quantised-still texel must not be counted as motion — that is exactly " +
      "the false positive that would let a broken velocity path report >0",
  );
  assert.equal(counted.maxMagnitude, 1);
});

// One run's cells in the region-aware shape `velocityCellFromRead` produces.
function cell({ line, control, unavailable = false }) {
  return {
    unavailable,
    frame: { nonZero: line + control, total: 307200, maxMagnitude: 1 },
    line: { nonZero: line, total: 4000, maxMagnitude: line > 0 ? 1 : 0 },
    control: {
      nonZero: control,
      total: 1600,
      maxMagnitude: control > 0 ? 1 : 0,
    },
    regions: { line: { x0: 190, y0: 0, x1: 450, y1: 479 }, control: null },
  };
}

const UNAVAILABLE_READ = { available: false, halves: [], width: 0, height: 0 };

test("A9 the probe's verdicts pass only on the shape the row accepts", () => {
  const passing = {
    animatedColor: cell({ line: 4210, control: 260 }),
    animatedDash: cell({ line: 0, control: 260 }),
    webgpuLinePixels: 5200,
    webglLinePixels: 5000,
    errors: 0,
  };
  const verdictIds = (cells) =>
    Object.fromEntries(verdictsFor(cells).map((v) => [v.id, v.pass]));

  assert.deepEqual(verdictIds(passing), {
    "velocity-emitted": true,
    "velocity-positive-control": true,
    "negative-control-dash": true,
    "ghost-smear-ratio": true,
    "gate-clean": true,
  });

  // The pre-fix state: zero velocity texels must FAIL, or the probe would have
  // certified the defect.
  assert.equal(
    verdictIds({ ...passing, animatedColor: cell({ line: 0, control: 260 }) })[
      "velocity-emitted"
    ],
    false,
  );
  // The gate opening for a material with no velocity entry points must FAIL.
  assert.equal(
    verdictIds({ ...passing, animatedDash: cell({ line: 12, control: 260 }) })[
      "negative-control-dash"
    ],
    false,
  );
  // A smeared line — the symptom the row names — inflates the footprint past
  // the band.
  assert.equal(
    verdictIds({ ...passing, webgpuLinePixels: 9000 })["ghost-smear-ratio"],
    false,
  );
  // So does a footprint that collapsed.
  assert.equal(
    verdictIds({ ...passing, webgpuLinePixels: 2000 })["ghost-smear-ratio"],
    false,
  );
  // A missing denominator is not a pass.
  assert.equal(
    verdictIds({ ...passing, webglLinePixels: 0 })["ghost-smear-ratio"],
    false,
  );
  assert.equal(verdictIds({ ...passing, errors: 1 })["gate-clean"], false);

  // DEFECT (d), Éowyn's job 10. An unavailable read is not a zero: the dash
  // scene's `_velocityTexture` did not exist, the probe measured nothing, and
  // `negative-control-dash` went green off it. It must now be RED, and the
  // positive control must be red with it.
  const blindDash = {
    ...passing,
    animatedDash: cell({ line: 0, control: 0, unavailable: true }),
  };
  assert.equal(
    verdictIds(blindDash)["negative-control-dash"],
    false,
    "a dash cell whose target was never allocated measured nothing, and " +
      "nothing is not a zero",
  );
  assert.equal(verdictIds(blindDash)["velocity-positive-control"], false);
  // A blind COLOUR read must not pass the row either.
  assert.equal(
    verdictIds({
      ...passing,
      animatedColor: cell({ line: 0, control: 0, unavailable: true }),
    })["velocity-emitted"],
    false,
  );
  // The positive control is what makes a zero attributable: if it reads zero
  // too, the readback — not the polyline — is what is being measured.
  assert.equal(
    verdictIds({
      ...passing,
      animatedColor: cell({ line: 4210, control: 0 }),
    })["velocity-positive-control"],
    false,
  );
});

test("A10 the velocity command differences two streams that differ across a stepped frame and agree across an unstepped one", async () => {
  const namespace = await loadRenderer();

  // A moving collection. Frame 0 has no history, so prev is seeded from the
  // current data and velocity is zero BY DESIGN; every later frame must carry
  // the frame before it.
  const moving = await drive(namespace, {
    materialType: "Color",
    taaEnabled: true,
    frames: 4,
  });
  assert.equal(moving.velocityCommands.length, 4);

  const currents = moving.writesByFrame.map(currentStream);
  const previouses = moving.writesByFrame.map(previousStream);
  for (let frame = 0; frame < 4; frame++) {
    assert.ok(
      currents[frame] && previouses[frame],
      `frame ${frame}: both instance streams must be uploaded before the ` +
        `velocity command that reads them at slot 0 and slot 1`,
    );
  }
  assert.ok(
    previouses[0].equals(currents[0]),
    "frame 0 has no history, so prev is seeded from the current data and the " +
      "first frame's velocity is zero by design",
  );
  for (let frame = 1; frame < 4; frame++) {
    assert.ok(
      !previouses[frame].equals(currents[frame]),
      `frame ${frame}: the previous-position stream must DIFFER from the ` +
        `current one after the polyline moved — equal streams make the ` +
        `velocity FS compute a difference of a point with itself, which is ` +
        `zero to within the RTE-versus-mat4 float residual and is exactly ` +
        `what the flat-zero Edge read measured`,
    );
    assert.ok(
      previouses[frame].equals(currents[frame - 1]),
      `frame ${frame}: slot 1 must carry frame ${frame - 1}'s exact bytes — ` +
        `a one-frame lag, not merely "something different"`,
    );
  }

  // The other half of the contract, and the one the diagnosis turns on: a
  // collection that did NOT move between two updates uploads identical
  // streams, so its velocity is zero. The engine is right to write zero there;
  // an instrument that reads such a frame is measuring the wrong frame.
  const still = await drive(namespace, {
    materialType: "Color",
    taaEnabled: true,
    frames: 3,
    moving: false,
  });
  const stillCurrents = still.writesByFrame.map(currentStream);
  const stillPreviouses = still.writesByFrame.map(previousStream);
  for (let frame = 0; frame < 3; frame++) {
    assert.ok(
      stillPreviouses[frame].equals(stillCurrents[frame]),
      `unstepped frame ${frame}: an unmoved polyline uploads the same bytes ` +
        `to both streams, and zero motion is the CORRECT output`,
    );
  }
});

test("A11 the format the velocity pipeline writes is the format the velocity target is allocated in, and the target exists only once the pass has run", async () => {
  const namespace = await loadRenderer();
  const { record } = await drive(namespace, {
    materialType: "Color",
    taaEnabled: true,
  });
  const [pipeline] = velocityPipelines(record);
  assert.ok(pipeline, "the animated run must have built the velocity pipeline");

  // The other end of the same attachment, driven for real rather than read off
  // a comment: `WebGPUSceneRenderer._runVelocityPass` calls this, and nothing
  // else allocates the texture.
  const created = [];
  // TypeScript, so it comes through the same bundler the renderer does. Its one
  // import is the render-target class, which `ensureVelocityTexture` never
  // touches.
  const framebufferSource = (await readFile(SCENE_FRAMEBUFFER, "utf8"))
    .split("\r\n")
    .join("\n");
  const framebufferNamespace = await bundle({
    path: SCENE_FRAMEBUFFER,
    source: framebufferSource,
    real: [],
  });
  const framebuffer = new framebufferNamespace.WebGPUSceneFramebuffer();
  assert.equal(
    framebuffer.velocityView,
    null,
    "a framebuffer that has never run a velocity pass has no velocity target " +
      "— which is why the probe reports an absent target as UNAVAILABLE " +
      "rather than as a zero",
  );
  const fakeDevice = {
    createTexture(descriptor) {
      created.push(descriptor);
      return {
        width: descriptor.size[0],
        height: descriptor.size[1],
        createView: () => ({ label: descriptor.label }),
        destroy() {},
      };
    },
  };
  // `_runVelocityPass` runs after the frame's `update()`, and `update()` is
  // what binds the framebuffer to a device; calling `ensureVelocityTexture`
  // against a device the framebuffer has never seen re-allocates by design.
  framebuffer.update(fakeDevice, 640, 480, false, 1, "rgba8unorm");
  const view = framebuffer.ensureVelocityTexture(fakeDevice, 640, 480);
  assert.ok(view, "the pass must get a view back to attach");
  assert.equal(created.length, 1);
  assert.equal(
    created[0].format,
    pipeline.targets[0],
    "the velocity pipeline writes " +
      pipeline.targets[0] +
      " and the target is allocated as " +
      created[0].format +
      " — a divergence would make every draw a validation error, or worse, " +
      "silently write somewhere the probe does not read",
  );
  assert.equal(created[0].format, "rg16float");
  assert.ok(
    (created[0].usage & GPUTextureUsage.COPY_SRC) !== 0,
    "the probe reads the acceptance number with copyTextureToBuffer, so the " +
      "target must carry COPY_SRC",
  );
  assert.ok((created[0].usage & GPUTextureUsage.RENDER_ATTACHMENT) !== 0);
  assert.equal(
    framebuffer.ensureVelocityTexture(fakeDevice, 640, 480),
    view,
    "the allocation is idempotent at a fixed size — the pass calls this every " +
      "frame, and a re-allocation per frame would hand the probe a different " +
      "texture than the one the frame it measured was drawn into",
  );
  assert.equal(created.length, 1);
  assert.notEqual(
    framebuffer.ensureVelocityTexture(fakeDevice, 800, 600),
    view,
    "and a resize must re-allocate rather than keep writing 640x480",
  );
  assert.equal(created.length, 2);
  assert.equal(created[1].format, "rg16float");
});

test("A12 the probe counts velocity inside one screen rectangle and refuses a rectangle it cannot use", () => {
  // A 4x2 target. Texel (0,0) and (3,1) move; the rest are still.
  const still = [0x0000, 0x0000];
  const moves = [0x3c00, 0x0000];
  const halves = [
    ...moves,
    ...still,
    ...still,
    ...still,
    ...still,
    ...still,
    ...still,
    ...moves,
  ];
  assert.equal(
    countNonZeroVelocityTexelsInRegion(halves, 4, 2, {
      x0: 0,
      y0: 0,
      x1: 1,
      y1: 0,
    }).nonZero,
    1,
    "a rectangle containing one moving texel counts one",
  );
  assert.equal(
    countNonZeroVelocityTexelsInRegion(halves, 4, 2, {
      x0: 1,
      y0: 0,
      x1: 2,
      y1: 0,
    }).nonZero,
    0,
    "and a rectangle containing neither counts none — which is what lets the " +
      "dash cell say the LINE wrote nothing while its control wrote something",
  );
  // Out-of-range corners are clamped, not wrapped: a rectangle that ran off
  // the target would otherwise count texels from the following row.
  assert.equal(
    countNonZeroVelocityTexelsInRegion(halves, 4, 2, {
      x0: -20,
      y0: -20,
      x1: 99,
      y1: 99,
    }).total,
    8,
  );
  assert.equal(
    countNonZeroVelocityTexelsInRegion(halves, 4, 2, null).invalid,
    true,
    "no rectangle is not an empty rectangle",
  );
  assert.equal(
    countNonZeroVelocityTexelsInRegion(halves, 4, 2, {
      x0: 3,
      y0: 0,
      x1: 1,
      y1: 0,
    }).invalid,
    true,
    "an inverted rectangle is a projection that failed, not a measurement",
  );
});

test("A13 the positive control cannot carry the subject's verdict", () => {
  // One synthetic frame in which ONLY the control region moves: 8x1 texels,
  // motion at x=1 (inside the control rectangle) and nowhere else.
  const width = 8;
  const halves = [];
  for (let x = 0; x < width; x++) {
    halves.push(x === 1 ? 0x3c00 : 0x0000, 0x0000);
  }
  const read = {
    available: true,
    halves,
    width,
    height: 1,
    regions: {
      line: { x0: 4, y0: 0, x1: 7, y1: 0 },
      control: { x0: 0, y0: 0, x1: 2, y1: 0 },
    },
  };
  const measured = velocityCellFromRead(read);
  assert.equal(measured.frame.nonZero, 1);
  assert.equal(measured.control.nonZero, 1);
  assert.equal(
    measured.line.nonZero,
    0,
    "a whole-frame count would have read 1 here and passed the row off the " +
      "control's own texels; the region count reads the subject",
  );

  const verdicts = Object.fromEntries(
    verdictsFor({
      animatedColor: measured,
      animatedDash: measured,
      webgpuLinePixels: 5200,
      webglLinePixels: 5000,
      errors: 0,
    }).map((verdict) => [verdict.id, verdict.pass]),
  );
  assert.equal(verdicts["velocity-positive-control"], true);
  assert.equal(
    verdicts["velocity-emitted"],
    false,
    "the control being live is exactly what makes this zero attributable to " +
      "the polyline",
  );
});

test("A14 an unavailable read is carried as unavailable, not flattened into zeros", () => {
  const measured = velocityCellFromRead(UNAVAILABLE_READ);
  assert.equal(measured.unavailable, true);
  assert.equal(measured.line.invalid, true);
  assert.equal(measured.control.invalid, true);
  assert.equal(velocityCellFromRead(undefined).unavailable, true);
});

// ── Inertness mutants ───────────────────────────────────────────────────────

test("A15 MUTANT — making the previous-stream stash unreachable makes every frame's two streams identical and A10 goes red", async () => {
  // The stash is what gives slot 1 a one-frame lag. With the assignment present
  // but never executed, `cache[prevDataKey]` stays undefined, the renderer falls
  // back to `?? segmentData`, and both slots carry this frame's bytes — the
  // engine shape that would have produced Éowyn's flat-zero read on its own.
  const namespace = await loadRenderer({
    label: "previous-segment stash",
    mutate: (source) =>
      source.replace(
        "    cache[prevDataKey] = segmentData;",
        "    if (false) {\n      cache[prevDataKey] = segmentData;\n    }",
      ),
  });
  const { velocityCommands, writesByFrame } = await drive(namespace, {
    materialType: "Color",
    taaEnabled: true,
    frames: 4,
  });
  assert.equal(
    velocityCommands.length,
    4,
    "the mutant must leave EMISSION alone, or it is testing the gate again " +
      "rather than the stream",
  );
  for (let frame = 0; frame < 4; frame++) {
    assert.ok(
      previousStream(writesByFrame[frame]).equals(
        currentStream(writesByFrame[frame]),
      ),
      `frame ${frame}: with the stash unreachable both streams must carry ` +
        `the same bytes — this is the assertion A10 makes fail`,
    );
  }
});

test("A16 MUTANT — making the dash cell's availability and control requirements inert brings the vacuous green back", async () => {
  // Instrument defect (d) in one line. `true ||` leaves both clauses in the
  // source and still evaluates them; they simply cannot change the verdict any
  // more, which is precisely the pre-fix semantics: a dash cell that measured
  // NOTHING scored as a measured zero.
  const source = (await readFile(PROBE, "utf8"))
    .split("\r\n")
    .join("\n")
    .replace(PROBE_ENTRY_GUARD, "");
  assert.ok(
    !source.includes("runProbe(descriptor)"),
    "the entry guard must be gone before bundling, or the import never settles",
  );
  const mutated = await bundle({
    path: PROBE,
    source,
    real: [],
    label: "dash availability and positive-control requirement",
    mutate: (text) =>
      text.replace(
        `      pass:
        dashAvailable &&
        animatedDash.control.nonZero > 0 &&
        animatedDash.line.nonZero === 0,`,
        `      pass:
        (true || dashAvailable) &&
        (true || animatedDash.control.nonZero > 0) &&
        animatedDash.line.nonZero === 0,`,
      ),
  });

  const blind = {
    animatedColor: cell({ line: 4210, control: 260 }),
    animatedDash: cell({ line: 0, control: 0, unavailable: true }),
    webgpuLinePixels: 5200,
    webglLinePixels: 5000,
    errors: 0,
  };
  const mutantVerdict = mutated
    .verdictsFor(blind)
    .find((verdict) => verdict.id === "negative-control-dash");
  assert.equal(
    mutantVerdict.pass,
    true,
    "with the requirements inert the unavailable dash read scores green " +
      "again — that is the defect this change exists to remove",
  );
  const fixedVerdict = verdictsFor(blind).find(
    (verdict) => verdict.id === "negative-control-dash",
  );
  assert.equal(
    fixedVerdict.pass,
    false,
    "and with them live the same read is refused",
  );
});
