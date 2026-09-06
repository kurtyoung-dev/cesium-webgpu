// polyline-command-bounding-volume.spec.mjs — browser-free behaviour spec for
// the bounding volume the WebGPU PolylineCollection renderer puts on the draw
// commands it emits. Pure Node: no browser, no GPU, no build.
//
// @purpose Pins that every WebGPU polyline colour and pick command declares a per-group bounding volume tight enough to bin into ONE frustum, positioned in world space, instead of the volume-less command that bins into every frustum.
// @status ACTIVE
//
// ── WHAT THIS IS ABOUT (AR-754, job 9 leg 5) ────────────────────────────────
//
// Éowyn's first Edge run of `probe-polyline-multimaterial.mjs` measured the
// WebGPU PolylineGlow row at FWHM 4 against WebGL's 3 (ratio 1.333, bar
// [0.8, 1.2]) with a lit-pixel ratio of only 1.171. Fitting the banked PNGs
// settles what that is and what it is NOT:
//
//   - WebGL's cross-line profile is EXACTLY the WebGL glow function
//     `glowPower/d - 2*glowPower` over a 12.50 px quad, centre y 381.190,
//     rms 0.0011 — so the reference is understood, not guessed.
//   - The WebGPU profile fits NO member of that family, at any (width, centre,
//     glowPower): best rms 0.049, forty times worse. So it is neither a taper
//     constant nor a quad-width mismatch. Both of those hypotheses are refuted
//     by measurement.
//   - It fits `1 - (1 - f)^2` — the same f, composited TWICE — at width 12.97
//     (the WebGPU quad is 13.00) and centre 381.195, rms 0.0045. Three
//     composites fit at 0.051; a square root at 0.063.
//
// The correct colour, composited twice. `WebGPUPolylineRenderer` built every
// command with `boundingVolume: collection._boundingVolume`, and
// `PolylineCollection` never defines that property — the only `_boundingVolume*`
// fields in that file are per-polyline. WebGL's polyline command gets a real
// per-bucket union of those (`Scene/PolylineCollection.js:885`). A command with
// no volume takes `View.js:374-378`'s worst-case branch, `commandNear =
// frustum.near` / `commandFar = frustum.far`, and `insertIntoBin`
// (`Scene/View.js:618-649`) then puts it in EVERY frustum of that range. Depth
// clears between frustums but colour does not, so a translucent polyline is
// alpha-composited once per frustum. This repo already records that exact
// failure mode, for the globe, at
// `Scene/GlobeSurfaceTileProviderRendering.js:1428-1436`.
//
// ── WHY IT IS TESTED THIS WAY ───────────────────────────────────────────────
//
// The quantity that decides the defect is "how many frustums does this command
// bin into", and every input to that answer is produced here by real code: the
// commands come from the real `updateWebGPUPolylines` driven over a recording
// fake device, and the near/far span comes from the real
// `BoundingSphere.computePlaneDistances`. Only the six-line bin rule itself is
// transcribed from `View.js:626-640`, because importing `View.js` would drag in
// the whole Scene graph; the transcription is stated here so a reviewer can
// diff it against those lines.
//
// Nothing greps the renderer source. A1 would pass on any implementation that
// declares a volume containing the geometry it draws, and fail on any that does
// not — including one that declares a volume around the wrong place (A2) or a
// uselessly large one (A3).
//
// A6 is the inertness mutant: it does not delete the fix, it makes the
// computed volume UNREACHABLE — the accumulation still runs and
// `finalizeProjectedBoundingVolume` is forced down its `return undefined`
// branch — and requires A1's bin count to come back at the pre-fix value,
// every frustum, with the volume undefined.
//
// The sibling defect this lane fixes in the same patch, the `antialias()`
// helper in PolylineArrow.wgsl / PolylineOutline.wgsl, is WGSL and cannot be
// executed in Node; its acceptance is the Edge probe that measures it directly
// (arrow lit-pixel ratio, outline core presence), whose pre-fix leg is already
// banked as job 9 leg 5.
//
// CRLF: this repo checks out with `core.autocrlf=true`; the entry source is
// LF-normalised before bundling.
//
// Run: node --test Tools/visual-regression/polyline-command-bounding-volume.spec.mjs
// Runner home: `npm run test-engine-node`.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "./lib/engine-stub-bundler.mjs";
import BoundingSphere from "../../packages/engine/Source/Core/BoundingSphere.js";
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
//   `Core/`            — the packers and the volume builder write into
//                        Float32Arrays and Cartesians; a Proxy throws on
//                        numeric coercion.
//   BoundingSphere     — the whole question is what volume the renderer
//                        computes, so it must be the real one.
//   Pass / SceneMode / BlendOption — frozen enums the command path and the
//                        mode-aware volume branch compare against.
//   WebGPUShaderDefines — the define mask is built with `|=`.
//   WebGPUBuffer / WebGPUDrawCommand — the command under inspection.
const REAL = [
  "defined",
  "BoundingSphere",
  "EncodedCartesian3",
  "Pass",
  "SceneMode",
  "BlendOption",
  "WebGPUShaderDefines",
  "WebGPUBuffer",
  "WebGPUDrawCommand",
];

const SCENE3D = 3;

function installGlobals() {
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
  // `BoundingSphere` reaches `buildModuleUrl` through the Core graph, which
  // reads `document.location` at module scope in a browser build.
  globalThis.document ??= { location: { href: "http://localhost/" } };
}

async function loadRenderer({ mutate, label } = {}) {
  installGlobals();
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

// Records only what a device is asked to build. Nothing about the command is
// supplied by the fixture.
function recordingDevice() {
  const record = { buffers: [], pipelines: [] };
  const device = {
    createBindGroupLayout: (d) => ({
      label: d.label,
      entries: d.entries ?? [],
    }),
    createBindGroup: (d) => ({ label: d.label }),
    createBuffer(d) {
      const b = { label: d.label, size: d.size, destroy() {} };
      record.buffers.push(b);
      return b;
    },
    createSampler: () => ({}),
    createPipelineLayout: (d) => ({ bindGroupLayouts: d.bindGroupLayouts }),
    createRenderPipeline(d) {
      const p = { label: d.label, name: d.name };
      record.pipelines.push(p);
      return p;
    },
    createShaderModule: (d) => ({ label: d.label }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    queue: { writeBuffer() {}, writeTexture() {} },
  };
  return { device, record };
}

// One ECEF endpoint pair per row, laid out like the probe's scene: five
// horizontal lines at descending latitudes so each material group occupies its
// own, separable region of space.
const R = 6378137.0;
function endpoints(latitudeDegrees) {
  const toRadians = Math.PI / 180.0;
  const lat = latitudeDegrees * toRadians;
  const at = (lonDegrees) => {
    const lon = lonDegrees * toRadians;
    return new Cartesian3(
      R * Math.cos(lat) * Math.cos(lon),
      R * Math.cos(lat) * Math.sin(lon),
      R * Math.sin(lat),
    );
  };
  return [at(-76.0), at(-72.0)];
}

// `material.type` carries the PUBLIC material type string, which is what the
// collection puts there and what the renderer groups on. Distinct material
// OBJECTS are what split the non-Color types into their own groups.
const ROWS = [
  { name: "solid", type: "Color", width: 12.0, latitude: 35.6 },
  { name: "dash", type: "PolylineDash", width: 12.0, latitude: 35.3 },
  { name: "glow", type: "PolylineGlow", width: 12.0, latitude: 35.0 },
  { name: "arrow", type: "PolylineArrow", width: 24.0, latitude: 34.7 },
  { name: "outline", type: "PolylineOutline", width: 16.0, latitude: 34.4 },
];

function makeCollection(rows = ROWS) {
  const polylines = rows.map((row) => ({
    show: true,
    width: row.width,
    loop: false,
    material: {
      type: row.type,
      uniforms: { color: { red: 1, green: 0, blue: 1, alpha: 1 } },
    },
    _color: { red: 1, green: 0, blue: 1, alpha: 1 },
    // `_pushPolylinePickCommand` asks each polyline for its pick id; the real
    // `Polyline.getPickId` registers a wrapper object and returns its colour.
    getPickId: () => ({
      color: { red: 0.1, green: 0.2, blue: 0.3, alpha: 1.0 },
    }),
    positions: endpoints(row.latitude),
  }));
  return {
    _polylines: polylines,
    modelMatrix: Matrix4.clone(Matrix4.IDENTITY),
    _commandOrdering: { sortLayer: 50, sortPriority: 0, materialSortId: 0 },
    _blendOption: undefined,
    _opaqueRS: undefined,
    _translucentRS: undefined,
  };
}

function makeContext(device) {
  return {
    device,
    // A null central cache makes the pipeline resolve synchronously, so the
    // run is deterministic from the first frame.
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

// The camera the probe uses: 700 km above (-74, 35), looking straight down.
const CAMERA_POSITION = (() => {
  const toRadians = Math.PI / 180.0;
  const lat = 35.0 * toRadians;
  const lon = -74.0 * toRadians;
  const r = R + 700000.0;
  return new Cartesian3(
    r * Math.cos(lat) * Math.cos(lon),
    r * Math.cos(lat) * Math.sin(lon),
    r * Math.sin(lat),
  );
})();
const CAMERA_DIRECTION = Cartesian3.normalize(
  Cartesian3.negate(CAMERA_POSITION, new Cartesian3()),
  new Cartesian3(),
);

function makeFrameState(context, frameNumber, mode = SCENE3D, passes) {
  return {
    context,
    camera: { positionWC: CAMERA_POSITION },
    mode,
    morphTime: mode === SCENE3D ? 1.0 : 0.0,
    mapProjection: {
      ellipsoid: undefined,
      project: (cartographic, result) => {
        // Only reached in non-3D modes, through
        // `SceneTransforms.computeActualEllipsoidPosition`, which this spec
        // stubs at the module boundary; kept for shape.
        return result;
      },
    },
    frameNumber,
    taaEnabled: false,
    passes: passes ?? { render: true, pick: false },
    minimumDisableDepthTestDistance: 0.0,
    splitPosition: 0.0,
  };
}

/**
 * Runs a few frames and returns the commands the renderer pushed.
 *
 * @param {object} namespace Bundled renderer namespace.
 * @param {object} [options] Run options.
 * @returns {Promise<object>} `{ commands, collection, record }`
 */
async function drive(namespace, options = {}) {
  const { mode = SCENE3D, passes, frames = 3, rows = ROWS } = options;
  const { device, record } = recordingDevice();
  const context = makeContext(device);
  const collection = makeCollection(rows);
  let commands = [];
  for (let frame = 0; frame < frames; frame++) {
    const commandList = [];
    await namespace.updateWebGPUPolylines(
      collection,
      makeFrameState(context, frame, mode, passes),
      commandList,
    );
    commands = commandList;
  }
  return { commands, collection, record };
}

// ---------------------------------------------------------------------------
// The binning rule, transcribed from Scene/View.js so a reviewer can diff it.
// Every quantity it consumes is produced by real code.
// ---------------------------------------------------------------------------

// `View.js:374-378`: a command with no bounding volume takes the camera's
// worst-case near and far. `View.js:339-346`: one with a volume takes that
// volume's plane distances.
function commandExtent(command, frustum) {
  const { boundingVolume } = command;
  if (boundingVolume === undefined || boundingVolume === null) {
    return { near: frustum.near, far: frustum.far };
  }
  const interval = boundingVolume.computePlaneDistances(
    CAMERA_POSITION,
    CAMERA_DIRECTION,
  );
  return { near: interval.start, far: interval.stop };
}

// `View.js:626-640`, the loop body of `insertIntoBin` minus the debug and
// derived-command bookkeeping, which do not affect which bins are written.
function binCount(command, frustumCommandsList, frustum) {
  const { near, far } = commandExtent(command, frustum);
  let bins = 0;
  for (const frustumCommands of frustumCommandsList) {
    if (near > frustumCommands.far) {
      continue;
    }
    if (far < frustumCommands.near) {
      break;
    }
    bins++;
    if (command.executeInClosestFrustum) {
      break;
    }
  }
  return bins;
}

// The multi-frustum split Cesium builds from a camera range, at the default
// `farToNearRatio` of 1000. This is the list a volume-less command lands in
// all of.
const FRUSTUM = { near: 1.0, far: 5.0e8 };
const FRUSTUM_COMMANDS_LIST = (() => {
  const list = [];
  const ratio = 1000.0;
  let near = FRUSTUM.near;
  while (near < FRUSTUM.far) {
    const far = Math.min(near * ratio, FRUSTUM.far);
    list.push({ near, far });
    near = far;
  }
  return list;
})();

/** Minimal enclosing radius of a group's own endpoints, about its own centre. */
function minimalRadiusFor(row) {
  const points = endpoints(row.latitude);
  const sphere = BoundingSphere.fromPoints(points);
  return sphere.radius;
}

test("A1 every colour command a five-material collection emits declares a bounding volume tight enough to bin into exactly one frustum", async () => {
  const namespace = await loadRenderer();
  const { commands } = await drive(namespace);

  assert.equal(
    commands.length,
    ROWS.length,
    "one command per material group is the precondition; without it the " +
      "per-group volume assertions below have nothing to separate",
  );
  assert.ok(
    FRUSTUM_COMMANDS_LIST.length >= 3,
    `the split must have several bins for the count to discriminate, got ${FRUSTUM_COMMANDS_LIST.length}`,
  );

  for (const command of commands) {
    assert.notEqual(
      command.boundingVolume,
      undefined,
      "a polyline command with no bounding volume takes View.js's worst-case " +
        "camera near/far and is binned into every frustum, which composites " +
        "its translucent fragments once per frustum",
    );
    assert.equal(
      binCount(command, FRUSTUM_COMMANDS_LIST, FRUSTUM),
      1,
      `expected one frustum, got ${binCount(command, FRUSTUM_COMMANDS_LIST, FRUSTUM)} ` +
        `for a volume at radius ${command.boundingVolume?.radius}`,
    );
  }
});

test("A2 each group's volume is centred on its own polyline, not shared across groups", async () => {
  const namespace = await loadRenderer();
  const { commands } = await drive(namespace);

  const centers = commands.map((command) => command.boundingVolume.center);
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      assert.ok(
        Cartesian3.distance(centers[i], centers[j]) > 1000.0,
        `groups ${i} and ${j} share a centre to within a kilometre — one ` +
          `scratch sphere aliased across every group would report exactly ` +
          `this, and would give four of the five commands the wrong volume`,
      );
    }
  }

  // Each command's volume must actually contain the endpoints of ITS row. The
  // rows are ordered as `ROWS`, which is the order `groupByMaterialType`
  // walks `_polylines`.
  for (let i = 0; i < commands.length; i++) {
    const sphere = commands[i].boundingVolume;
    for (const point of endpoints(ROWS[i].latitude)) {
      assert.ok(
        Cartesian3.distance(sphere.center, point) <= sphere.radius + 1.0,
        `row ${ROWS[i].name}: an endpoint lies outside the volume the command ` +
          `declares, so the near/far span View.js derives from it would clip ` +
          `geometry the command still draws`,
      );
    }
  }
});

test("A3 the declared volume is tight, not a placeholder that spans the scene", async () => {
  const namespace = await loadRenderer();
  const { commands } = await drive(namespace);

  for (let i = 0; i < commands.length; i++) {
    const minimal = minimalRadiusFor(ROWS[i]);
    const declared = commands[i].boundingVolume.radius;
    assert.ok(
      declared <= minimal * 1.35,
      `row ${ROWS[i].name}: declared radius ${declared.toFixed(0)} m is more ` +
        `than 1.35x the minimal enclosing radius ${minimal.toFixed(0)} m — a ` +
        `volume loose enough to straddle frustum splits reintroduces the ` +
        `multi-bin composite this fix removes`,
    );
    assert.ok(
      declared >= minimal * 0.99,
      `row ${ROWS[i].name}: declared radius ${declared.toFixed(0)} m is smaller ` +
        `than the minimal enclosing radius ${minimal.toFixed(0)} m, so the ` +
        `command under-declares the space it draws in`,
    );
  }
});

test("A4 the pick command declares a volume covering every polyline in the collection", async () => {
  const namespace = await loadRenderer();
  const { commands } = await drive(namespace, {
    passes: { render: false, pick: true },
  });

  const pickCommands = commands.filter((command) => command.pickOnly === true);
  assert.equal(pickCommands.length, 1, "one pick command per collection");
  const sphere = pickCommands[0].boundingVolume;
  assert.notEqual(
    sphere,
    undefined,
    "the pick command is binned by the same rule as the colour commands, so " +
      "a volume-less pick command runs in every frustum too",
  );
  for (const row of ROWS) {
    for (const point of endpoints(row.latitude)) {
      assert.ok(
        Cartesian3.distance(sphere.center, point) <= sphere.radius + 1.0,
        `pick volume excludes an endpoint of row ${row.name}, which pick must ` +
          `still be able to hit`,
      );
    }
  }
});

test("A5 the declared volume is world-space: a translated collection modelMatrix moves it by that translation", async () => {
  const namespace = await loadRenderer();
  const { commands: atOrigin } = await drive(namespace);

  // SCENE3D packs the RAW ECEF position, because the MVP already carries the
  // collection model matrix. A command bounding volume is world-space, so a
  // translated collection must report a translated volume: omitting the
  // transform pins the volume where the geometry is NOT, and applying it twice
  // overshoots by the same amount again.
  const shift = new Cartesian3(120000.0, -80000.0, 45000.0);
  const namespaceShifted = await loadRenderer();
  const { device } = recordingDevice();
  const context = makeContext(device);
  const collection = makeCollection();
  collection.modelMatrix = Matrix4.fromTranslation(shift, new Matrix4());
  let shifted = [];
  for (let frame = 0; frame < 3; frame++) {
    const commandList = [];
    await namespaceShifted.updateWebGPUPolylines(
      collection,
      makeFrameState(context, frame),
      commandList,
    );
    shifted = commandList;
  }

  assert.equal(shifted.length, atOrigin.length);
  for (let i = 0; i < shifted.length; i++) {
    const expected = Cartesian3.add(
      atOrigin[i].boundingVolume.center,
      shift,
      new Cartesian3(),
    );
    const actual = shifted[i].boundingVolume.center;
    assert.ok(
      Cartesian3.distance(expected, actual) < 1.0,
      `row ${ROWS[i].name}: expected the volume centre to move with the model ` +
        `matrix, to (${expected.x.toFixed(0)}, ${expected.y.toFixed(0)}, ` +
        `${expected.z.toFixed(0)}); got (${actual.x.toFixed(0)}, ` +
        `${actual.y.toFixed(0)}, ${actual.z.toFixed(0)}). A volume left in ` +
        `model space sits ${Cartesian3.magnitude(shift).toFixed(0)} m away ` +
        `from the geometry it is supposed to bound.`,
    );
    assert.ok(
      Math.abs(
        shifted[i].boundingVolume.radius - atOrigin[i].boundingVolume.radius,
      ) < 1.0,
      "a pure translation must not change the radius",
    );
  }
});

test("A6 INERTNESS MUTANT — with the volume computation unreachable, the commands bin into every frustum again", async () => {
  const namespace = await loadRenderer({
    label: "unreachable-bounding-volume",
    mutate: (source) =>
      source.replace(
        "  if (!isFinite(scratchExtentMin.x)) {",
        "  if (!isFinite(scratchExtentMin.x) || true) {",
      ),
  });
  const { commands } = await drive(namespace);

  assert.equal(commands.length, ROWS.length, "the colour pass still runs");
  for (const command of commands) {
    assert.equal(
      command.boundingVolume,
      undefined,
      "the mutant must actually reach the command site with no volume, or it " +
        "is not exercising the fix",
    );
    assert.equal(
      binCount(command, FRUSTUM_COMMANDS_LIST, FRUSTUM),
      FRUSTUM_COMMANDS_LIST.length,
      "with the fix unreachable, every command is binned into every frustum — " +
        "the pre-fix behaviour that composited the translucent glow more than " +
        "once. A1 asserting 1 is therefore falsifiable.",
    );
  }
});
