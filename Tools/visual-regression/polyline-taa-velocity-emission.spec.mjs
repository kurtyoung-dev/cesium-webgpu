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
  decodeHalf,
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
  const record = { pipelines: [], buffers: [] };
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
    queue: { writeBuffer() {}, writeTexture() {} },
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
 * @returns {Promise<object>} `{ colorCommands, velocityCommands, record, last }`
 */
async function drive(
  namespace,
  { materialType, taaEnabled, frames = 4, polylineCount = 2 },
) {
  const { device, record } = recordingDevice();
  const context = makeContext(device);
  const collection = makeCollection(materialType, { count: polylineCount });
  const colorCommands = [];
  const velocityCommands = [];
  for (let frame = 0; frame < frames; frame++) {
    animate(collection, frame);
    const commandList = [];
    await namespace.updateWebGPUPolylines(
      collection,
      makeFrameState(context, frame, taaEnabled),
      commandList,
    );
    for (const command of commandList) {
      colorCommands.push(command);
      if (command.velocityCommand !== undefined) {
        velocityCommands.push(command.velocityCommand);
      }
    }
  }
  return { colorCommands, velocityCommands, record };
}

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

test("A9 the probe's verdicts pass only on the shape the row accepts", () => {
  const passing = {
    animatedColor: { nonZero: 4210 },
    animatedDash: { nonZero: 0 },
    webgpuLinePixels: 5200,
    webglLinePixels: 5000,
    errors: 0,
  };
  const verdictIds = (cells) =>
    Object.fromEntries(verdictsFor(cells).map((v) => [v.id, v.pass]));

  assert.deepEqual(verdictIds(passing), {
    "velocity-emitted": true,
    "negative-control-dash": true,
    "ghost-smear-ratio": true,
    "gate-clean": true,
  });

  // The pre-fix state: zero velocity texels must FAIL, or the probe would have
  // certified the defect.
  assert.equal(
    verdictIds({ ...passing, animatedColor: { nonZero: 0 } })[
      "velocity-emitted"
    ],
    false,
  );
  // The gate opening for a material with no velocity entry points must FAIL.
  assert.equal(
    verdictIds({ ...passing, animatedDash: { nonZero: 12 } })[
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
});
