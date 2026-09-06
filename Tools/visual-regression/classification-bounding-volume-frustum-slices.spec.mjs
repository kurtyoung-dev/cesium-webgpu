// classification-bounding-volume-frustum-slices.spec.mjs — a WebGPU
// classification command must carry the same mode-appropriate bounding volume
// its WebGL counterpart carries, in every scene mode, so it is drawn once
// rather than once per frustum slice.
//
// @purpose Drives the real View.createPotentiallyVisibleSet, the real Scene.isVisible and the real GroundPolylinePrimitive queue path over the real WebGPU classification bounding-volume selection, and requires the slice count, the frustum-list length, the per-frame classification draw count and the blend fold they imply to match the single-draw values on every scene mode.
// @status ACTIVE
//
// Pure Node (`node --test`). No browser, no GPU, no build.
//
// WHAT THIS IS ABOUT
// ------------------
// `View.createPotentiallyVisibleSet` treats a command with no bounding volume
// as spanning the camera's entire near..far (`Scene/View.js:374-388`). That has
// two consequences, not one:
//
//   - `insertIntoBin` puts the command in EVERY frustum slice its range
//     overlaps, so it executes once per slice;
//   - the same branch folds the camera's whole range into the near/far
//     accumulators `updateFrustums` divides, so the missing volume also
//     GROWS the slice count. In SCENE2D the divisor is
//     `scene.nearToFarDistance2D` (`Scene/View.js:575-583`), so one omitted
//     volume turns a one-slice frame into a thirteen-slice one at a
//     whole-globe 2D camera.
//
// A translucent classification drawn N times over black composites to
// `1 - (1 - a)^N` of its colour instead of `a` — the double-blend the ledger
// measured at 0.748 for a = 0.5 (`DEFERRED_WORK.md:6439`).
//
// WHAT IS ACTUALLY CHECKED
// ------------------------
//   - THE SELECTION, on the three primitive shapes that reach the two WebGPU
//     classification renderers, in all four scene modes. A `GroundPrimitive`
//     owns `_boundingVolumes` / `_boundingVolumes2D`; a directly constructed
//     `ClassificationPrimitive` and a `GroundPolylinePrimitive` own neither and
//     keep their volumes on the inner `Primitive`.
//   - THE CONSEQUENCE, through the REAL `View.prototype.createPotentiallyVisibleSet`
//     and the REAL `Scene.prototype.isVisible`. Four metrics per case, each with
//     its own bar: the `debugOverlappingFrustums` popcount, `frustumCommandsList.length`,
//     the number of bin slots the command actually occupies, and the blend fold
//     that draw count produces for an alpha-0.5 classification over black.
//   - THE CULL HALF. Supplying a volume enables culling that was previously
//     moot, so a bounded command outside the culling volume must not be binned
//     and one inside must be — asserted in both directions, and against the
//     unbounded command that must stay visible either way.
//   - THE ORDERING, through the REAL `GroundPolylinePrimitive` queue path and
//     the REAL `Primitive._updateBoundingVolumes`: the feature renderer must
//     see refreshed sphere arrays at the moment it is dispatched.
//   - THE WEBGL PATH IS UNCHANGED. With no feature renderer registered, the
//     queue path still puts the mode's sphere and the caller's `cull` on the
//     command it pushes.
//   - INERTNESS, twice. The selection is made unreachable (`if (false && …)`)
//     rather than deleted, and separately the hoisted refresh is; each has to
//     take its own assertions red.
//
// WHAT IS NOT CHECKED HERE
// ------------------------
// No pixel is measured. The blend fold below is arithmetic over the draw count
// this spec measures, not a captured frame; the measured mean channel value is
// the Edge leg's job (`probe-classification-frustum-slices.mjs`), whose band
// is a translucent/opaque RATIO — the shape
// `probe-ellipsoidprim-translucent.mjs` established and the shape
// `DEFERRED_WORK.md:6439` records — not an absolute channel mean.
//
// Neither renderer call site is executed: `createWebGPUGroundPrimitiveCommands`
// and `createWebGPUGroundPolylineCommands` need a `GPUDevice`. This file proves
// the selection they call is correct, that its output produces the required
// distribution, and that the queue path hands them refreshed spheres; that they
// call it is the Edge leg's assertion.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundle } from "./lib/engine-stub-bundler.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const engineSource = path.join(root, "packages/engine/Source");
const engineCore = path.join(engineSource, "Core");

const readLf = async (file) =>
  (await readFile(file, "utf8")).split("\r\n").join("\n");

// ---------------------------------------------------------------------------
// Bundle 1 — the selection plus the machinery whose behaviour it changes.
// One entry, so `View`, `Scene`, the Core volumes and the selection all share
// a single module graph and a volume built here is the same class the culling
// volume tests.
// ---------------------------------------------------------------------------

const PVS_ENTRY_PATH = path.join(engineSource, "Scene/__classifyBvSpec.js");

const PVS_ENTRY_SOURCE = `
export { default as View } from "./View.js";
export { default as Scene } from "./Scene.js";
export { default as SceneMode } from "./SceneMode.js";
export { default as Pass } from "../Renderer/Pass.js";
export { selectClassificationBoundingVolume } from "../Renderer/WebGPU/WebGPUClassificationBoundingVolume.js";
export { default as BoundingSphere } from "../Core/BoundingSphere.js";
export { default as OrientedBoundingBox } from "../Core/OrientedBoundingBox.js";
export { default as Cartesian3 } from "../Core/Cartesian3.js";
export { default as PerspectiveFrustum } from "../Core/PerspectiveFrustum.js";
export { default as OrthographicOffCenterFrustum } from "../Core/OrthographicOffCenterFrustum.js";
`;

const PVS_REAL = [
  "View",
  "Scene",
  "SceneMode",
  "FrustumCommands",
  "Pass",
  "ClearCommand",
  "ShadowMap",
  "EnvironmentFrustumDemand",
  "WebGPUClassificationBoundingVolume",
];

/**
 * Bundles the selection together with the PVS machinery, optionally through a
 * rewrite of the selection module.
 *
 * @param {Array} [overrides] `{basename, mutate, label}` rewrites.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
function loadPvs(overrides = []) {
  return bundle({
    path: PVS_ENTRY_PATH,
    source: PVS_ENTRY_SOURCE,
    real: PVS_REAL,
    realDir: engineCore,
    overrides,
  });
}

const pvs = await loadPvs();

const {
  View,
  Scene,
  SceneMode,
  Pass,
  selectClassificationBoundingVolume,
  BoundingSphere,
  OrientedBoundingBox,
  Cartesian3,
  PerspectiveFrustum,
  OrthographicOffCenterFrustum,
} = pvs;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A sub-degree polygon draped ~350 km below a nadir camera — the geometry the
// Batch 174 evidence run used, so the slice numbers below are comparable with
// the ones that batch recorded.
const SURFACE_DISTANCE = 350000.0;
const SURFACE_RADIUS = 40000.0;

/**
 * A distinct bounding sphere, so a wrong pick is visible as the wrong object
 * rather than as an equal value.
 *
 * @param {number} tag Distinguishing offset.
 * @returns {object} The sphere.
 */
function sphere(tag) {
  return new BoundingSphere(
    new Cartesian3(tag, tag, -SURFACE_DISTANCE),
    SURFACE_RADIUS,
  );
}

/**
 * The `GroundPrimitive` shape: mode-partitioned arrays it builds itself.
 *
 * @returns {object} The primitive-shaped fixture.
 */
function groundPrimitiveShape() {
  return {
    _boundingVolumes: [
      OrientedBoundingBox.fromPoints([
        new Cartesian3(-1, -1, -SURFACE_DISTANCE),
        new Cartesian3(1, 1, -SURFACE_DISTANCE + 1),
      ]),
    ],
    _boundingVolumes2D: [sphere(2)],
    // Present, and deliberately different, so a fall-through to the inner
    // primitive would be visible rather than silently right.
    _primitive: innerPrimitiveShape(),
  };
}

/**
 * The four arrays `Primitive._updateBoundingVolumes` maintains.
 *
 * @returns {object} The inner-primitive-shaped fixture.
 */
function innerPrimitiveShape() {
  return {
    _boundingSphereWC: [sphere(10)],
    _boundingSphereCV: [sphere(20)],
    _boundingSphere2D: [sphere(30)],
    _boundingSphereMorph: [sphere(40)],
  };
}

/**
 * The `ClassificationPrimitive` / `GroundPolylinePrimitive` shape: no volume
 * fields of its own, volumes on the inner `Primitive`.
 *
 * @returns {object} The primitive-shaped fixture.
 */
function innerVolumeShape() {
  return { _primitive: innerPrimitiveShape() };
}

const ALL_MODES = [
  ["SCENE3D", () => SceneMode.SCENE3D],
  ["COLUMBUS_VIEW", () => SceneMode.COLUMBUS_VIEW],
  ["SCENE2D", () => SceneMode.SCENE2D],
  ["MORPHING", () => SceneMode.MORPHING],
];

// ---------------------------------------------------------------------------
// Group A — the selection
// ---------------------------------------------------------------------------

test("AR-715: a ClassificationPrimitive is bounded in every scene mode", () => {
  const primitive = innerVolumeShape();
  const { _primitive: inner } = primitive;
  const expected = new Map([
    [SceneMode.SCENE3D, inner._boundingSphereWC[0]],
    [SceneMode.COLUMBUS_VIEW, inner._boundingSphereCV[0]],
    [SceneMode.SCENE2D, inner._boundingSphere2D[0]],
    [SceneMode.MORPHING, inner._boundingSphereMorph[0]],
  ]);
  for (const [name, mode] of ALL_MODES) {
    assert.equal(
      selectClassificationBoundingVolume(primitive, mode()),
      expected.get(mode()),
      `${name}: a directly constructed ClassificationPrimitive must be given ` +
        `the same inner-Primitive sphere WebGL gives it ` +
        `(ClassificationPrimitive.js:1336-1348)`,
    );
  }
});

test("AR-714: a GroundPrimitive is bounded in every scene mode", () => {
  const primitive = groundPrimitiveShape();
  assert.equal(
    selectClassificationBoundingVolume(primitive, SceneMode.SCENE3D),
    primitive._boundingVolumes[0],
    "SCENE3D takes the world-space oriented box (GroundPrimitive.js:925-930)",
  );
  for (const [name, mode] of ALL_MODES.slice(1)) {
    assert.equal(
      selectClassificationBoundingVolume(primitive, mode()),
      primitive._boundingVolumes2D[0],
      `${name}: every non-3D mode takes the projected sphere, which is what ` +
        `WebGL's else branch hands the same primitive`,
    );
  }
});

test("AR-716: a GroundPolylinePrimitive is bounded in every scene mode", () => {
  const primitive = innerVolumeShape();
  for (const [name, mode] of ALL_MODES) {
    assert.notEqual(
      selectClassificationBoundingVolume(primitive, mode()),
      undefined,
      `${name}: every clamped-to-ground polyline command must carry a volume`,
    );
  }
});

test("a primitive with no volumes yet stays unbounded rather than guessing", () => {
  for (const [name, mode] of ALL_MODES) {
    assert.equal(
      selectClassificationBoundingVolume({ _primitive: {} }, mode()),
      undefined,
      `${name}: an un-combined primitive keeps the historical no-cull path`,
    );
    assert.equal(
      selectClassificationBoundingVolume(undefined, mode()),
      undefined,
      `${name}: a missing primitive must not throw`,
    );
  }
});

// ---------------------------------------------------------------------------
// Group B — the consequence, through the real PVS
// ---------------------------------------------------------------------------

/**
 * Counts the set bits of the `debugOverlappingFrustums` mask, which is how
 * many slices `insertIntoBin` put the command in (`Scene/View.js:642-643`).
 *
 * @param {number} mask The mask.
 * @returns {number} The slice count.
 */
function sliceCount(mask) {
  let count = 0;
  let bits = mask >>> 0;
  while (bits !== 0) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

/**
 * The fraction of its own colour an alpha-`a` translucent command composites
 * to over black after `draws` source-alpha blends. One draw gives `a`; two
 * give the 0.748-shaped double blend the ledger measured.
 *
 * @param {number} draws Draw count.
 * @param {number} alpha Source alpha.
 * @returns {number} The composited fraction.
 */
function blendFold(draws, alpha) {
  return 1 - Math.pow(1 - alpha, draws);
}

const SINGLE_BLEND_BAND = [0.34, 0.62];

/**
 * A camera shaped like the one the mode uses, with the frustum kinds Cesium
 * installs for it.
 *
 * @param {number} mode The scene mode.
 * @returns {object} The camera.
 */
function cameraFor(mode) {
  const height = mode === SceneMode.SCENE2D ? 2.0e7 : 1.0e7;
  const frustum =
    mode === SceneMode.SCENE2D
      ? new OrthographicOffCenterFrustum({
          left: -1.0e7,
          right: 1.0e7,
          bottom: -5.0e6,
          top: 5.0e6,
          near: 0.1,
          far: 1.0e10,
        })
      : new PerspectiveFrustum({
          fov: Math.PI / 3,
          aspectRatio: 1.0,
          near: 0.1,
          far: 1.0e10,
        });
  return {
    positionWC: new Cartesian3(0.0, 0.0, 0.0),
    directionWC: new Cartesian3(0.0, 0.0, -1.0),
    upWC: new Cartesian3(0.0, 1.0, 0.0),
    position: new Cartesian3(0.0, 0.0, height),
    frustum,
  };
}

/**
 * Runs the REAL potentially-visible-set walk over one classification command
 * and reports the four metrics the row's acceptance names.
 *
 * @param {object} options Run options.
 * @param {number} options.mode The scene mode.
 * @param {object} [options.boundingVolume] The command's volume.
 * @returns {object} `{slices, listLength, draws, fold, binned}`.
 */
function runPvs({ mode, boundingVolume }) {
  const camera = cameraFor(mode);
  const command = {
    pass: Pass.TERRAIN_CLASSIFICATION,
    boundingVolume,
    // The pairing the renderers use: cull follows the volume, so an unbounded
    // command keeps the historical no-cull behaviour.
    cull: boundingVolume !== undefined,
    castShadows: false,
    receiveShadows: false,
    occlude: true,
    debugOverlappingFrustums: 0,
  };

  const view = Object.create(View.prototype);
  view.frustumCommandsList = [];
  view._commandExtents = [];
  view._shadowCasters = [];
  view._shadowCasterSeen = new Set();

  const scene = {
    mode,
    camera,
    debugShowFrustums: true,
    farToNearRatio: 1000.0,
    logarithmicDepthFarToNearRatio: 1.0e9,
    nearToFarDistance2D: 1.75e6,
    _computeCommandList: [],
    _overlayCommandList: [],
    // The real predicate, so the cull assertions below are the engine's
    // answer rather than this file's belief about it.
    isVisible: Scene.prototype.isVisible,
    updateDerivedCommands() {},
    frameState: {
      mode,
      camera,
      commandList: [command],
      useLogDepth: false,
      cullingVolume: camera.frustum.computeCullingVolume(
        camera.positionWC,
        camera.directionWC,
        camera.upWC,
      ),
      occluder: undefined,
      frustumSplits: [],
      shadowState: { shadowsEnabled: false, prePvsCasterCommands: [] },
    },
  };

  view.createPotentiallyVisibleSet(scene);

  let draws = 0;
  for (const frustumCommands of view.frustumCommandsList) {
    const used = frustumCommands.indices[Pass.TERRAIN_CLASSIFICATION];
    for (let i = 0; i < used; i++) {
      if (
        frustumCommands.commands[Pass.TERRAIN_CLASSIFICATION][i] === command
      ) {
        draws++;
      }
    }
  }

  return {
    slices: sliceCount(command.debugOverlappingFrustums),
    listLength: view.frustumCommandsList.length,
    draws,
    fold: blendFold(draws, 0.5),
    binned: draws > 0,
  };
}

// Each mode is asserted against the numbers the real walk produces without a
// volume, so the bar is the defect's own size rather than a chosen constant.
const CONSEQUENCE_CASES = [
  ["SCENE3D", () => SceneMode.SCENE3D, () => sphere(10)],
  ["COLUMBUS_VIEW", () => SceneMode.COLUMBUS_VIEW, () => sphere(20)],
  ["SCENE2D", () => SceneMode.SCENE2D, () => sphere(30)],
  ["MORPHING", () => SceneMode.MORPHING, () => sphere(40)],
];

for (const [name, mode, volume] of CONSEQUENCE_CASES) {
  test(`${name}: a bounded classification command is drawn exactly once`, () => {
    const unbounded = runPvs({ mode: mode(), boundingVolume: undefined });
    const bounded = runPvs({ mode: mode(), boundingVolume: volume() });

    // Metric 1 — slice count. Deterministic: the mask is a pure function of
    // the command extent and the frustum splits, with no timing input.
    assert.ok(
      unbounded.slices > 1,
      `${name}: without a volume the command must land in more than one ` +
        `slice, or this case cannot demonstrate anything (saw ` +
        `${unbounded.slices})`,
    );
    assert.equal(
      bounded.slices,
      1,
      `${name}: a bounded command belongs to exactly the slice containing ` +
        `its surface`,
    );

    // Metric 2 — the frustum list itself. Deterministic for the same reason,
    // and the half a slice-count fix can leave behind: the widened range grows
    // the list even where the command is later binned once.
    assert.ok(
      unbounded.listLength > 1,
      `${name}: the unbounded command widens the near/far accumulators and ` +
        `so grows the slice count itself (saw ${unbounded.listLength})`,
    );
    assert.equal(
      bounded.listLength,
      1,
      `${name}: with a volume the scene needs one slice, not ` +
        `${unbounded.listLength}`,
    );

    // Metric 3 — the per-frame classification draw count. Deterministic; equal
    // to the slice count here because the command is not
    // `executeInClosestFrustum`.
    assert.equal(
      bounded.draws,
      1,
      `${name}: the classification executes once per frame`,
    );
    assert.ok(
      unbounded.draws > 1,
      `${name}: the defect executes it ${unbounded.draws} times`,
    );

    // Metric 4 — the blend the draw count folds to for an alpha-0.5
    // translucent classification over black. Exact arithmetic over metric 3,
    // so it carries metric 3's determinism; the MEASURED channel value is the
    // Edge leg's, and its band is this one.
    assert.ok(
      bounded.fold >= SINGLE_BLEND_BAND[0] &&
        bounded.fold <= SINGLE_BLEND_BAND[1],
      `${name}: one draw composites to ${bounded.fold}, which must sit in ` +
        `the ledger's single-blend band ${SINGLE_BLEND_BAND.join("..")}`,
    );
    assert.ok(
      unbounded.fold > SINGLE_BLEND_BAND[1],
      `${name}: ${unbounded.draws} draws composite to ${unbounded.fold}, ` +
        `above the single-blend band — the double-blend the ledger measured ` +
        `at 0.748`,
    );
  });
}

test("SCENE2D pays the largest slice penalty, as the row predicts", () => {
  const unbounded = runPvs({
    mode: SceneMode.SCENE2D,
    boundingVolume: undefined,
  });
  const unbounded3D = runPvs({
    mode: SceneMode.SCENE3D,
    boundingVolume: undefined,
  });
  assert.ok(
    unbounded.slices > unbounded3D.slices,
    `SCENE2D divides the accumulated range by nearToFarDistance2D, so the ` +
      `omission costs more slices there (${unbounded.slices}) than under the ` +
      `logarithmic 3D split (${unbounded3D.slices}) — the in-code claim that ` +
      `2D distribution is moot is the inverse of the truth`,
  );
});

// ---------------------------------------------------------------------------
// Group C — the cull half (the Batch-167 trap)
// ---------------------------------------------------------------------------

test("AR-716 cull: a volume outside the frustum is culled, one inside is not", () => {
  const inside = sphere(10);
  // Behind the camera, which looks down -Z from the origin.
  const outside = new BoundingSphere(
    new Cartesian3(0.0, 0.0, SURFACE_DISTANCE),
    SURFACE_RADIUS,
  );

  const boundedInside = runPvs({
    mode: SceneMode.SCENE3D,
    boundingVolume: inside,
  });
  const boundedOutside = runPvs({
    mode: SceneMode.SCENE3D,
    boundingVolume: outside,
  });
  const unbounded = runPvs({
    mode: SceneMode.SCENE3D,
    boundingVolume: undefined,
  });

  assert.equal(
    boundedInside.binned,
    true,
    "a polyline inside the culling volume is still drawn",
  );
  assert.equal(
    boundedOutside.binned,
    false,
    "a polyline outside the culling volume is not drawn — supplying a volume " +
      "turns on culling that was previously moot, and that is the half a " +
      "slice-count fix can change by accident",
  );
  assert.equal(
    unbounded.binned,
    true,
    "an unbounded command stays visible: Scene.isVisible short-circuits when " +
      "the volume is absent, so nothing is culled against nothing",
  );
});

test("the engine's own predicate is what the cull half turns on", () => {
  // Both directions of `Scene.isVisible`'s short-circuit
  // (`Scene/Scene.js:3979-3981`), because the whole cull half rests on it:
  // while the volume is absent the `cull` flag cannot matter, and the moment
  // one is supplied it does.
  const outside = new BoundingSphere(
    new Cartesian3(0.0, 0.0, SURFACE_DISTANCE),
    SURFACE_RADIUS,
  );
  const camera = cameraFor(SceneMode.SCENE3D);
  const cullingVolume = camera.frustum.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC,
  );
  const isVisible = Scene.prototype.isVisible;

  assert.equal(
    isVisible.call({}, cullingVolume, {
      boundingVolume: undefined,
      cull: true,
      occlude: true,
    }),
    true,
    "with no volume the predicate returns visible whatever `cull` says — " +
      "which is why the pre-fix command's `cull: true` default was moot",
  );
  assert.equal(
    isVisible.call({}, cullingVolume, {
      boundingVolume: outside,
      cull: true,
      occlude: true,
    }),
    false,
    "supplying the volume is what switches the culling on",
  );
  assert.equal(
    isVisible.call({}, cullingVolume, {
      boundingVolume: outside,
      cull: false,
      occlude: true,
    }),
    true,
    "and `cull: false` still opts out, so the renderers' " +
      "`cull: defined(volume)` pairing keeps the historical behaviour where " +
      "no volume resolves",
  );
});

// ---------------------------------------------------------------------------
// Group D — the ordering, through the real GroundPolylinePrimitive queue path
// ---------------------------------------------------------------------------

const GPP_PATH = path.join(engineSource, "Scene/GroundPolylinePrimitive.js");
const GPP_SOURCE = await readLf(GPP_PATH);

// The hoisted refresh, verbatim. `mutateOrFail` inside `bundle` fails loudly
// if this anchor moves, so the inertness leg cannot pass vacuously.
const HOISTED_REFRESH =
  "  Primitive._updateBoundingVolumes(primitive, frameState, modelMatrix); // Expected to be identity - GroundPrimitives don't support other model matrices";

/**
 * Widens the module-private queue function so the spec can drive it, and
 * re-exports the Core and Scene values the fixtures need from the same graph.
 *
 * @param {string} source Module source.
 * @returns {string} The widened source.
 */
function exposeQueuePath(source) {
  return `${source}
export { updateAndQueueCommands as __updateAndQueueCommands };
export { selectClassificationBoundingVolume as __select } from "../Renderer/WebGPU/WebGPUClassificationBoundingVolume.js";
export { default as __ClassificationType } from "./ClassificationType.js";
export { default as __Matrix4 } from "../Core/Matrix4.js";
export { default as __BoundingSphere } from "../Core/BoundingSphere.js";
export { default as __Cartesian3 } from "../Core/Cartesian3.js";
export { default as __SceneMode } from "./SceneMode.js";
`;
}

/**
 * Bundles the real queue path with the real `Primitive` helpers behind it.
 *
 * @param {Function} [inert] Rewrite applied before the export is appended.
 * @param {string} [label] Name for the did-it-change assertion.
 * @returns {Promise<Record<string, unknown>>} The module namespace.
 */
function loadQueuePath(inert, label) {
  return bundle({
    path: GPP_PATH,
    source: GPP_SOURCE,
    real: [
      // The refresh under test lives in `PrimitiveCommandHelpers` and reaches
      // the queue path through `Primitive._updateBoundingVolumes`; a Proxy in
      // either place would make the ordering unobservable.
      "Primitive",
      "PrimitiveCommandHelpers",
      "SceneMode",
      "ClassificationType",
      "FeatureRendererKey",
      "Pass",
      // The selection under test, kept in THIS graph so the volume WebGL's own
      // queue path writes and the volume the selection returns are the same
      // object rather than two copies from two bundles.
      "WebGPUClassificationBoundingVolume",
    ],
    realDir: engineCore,
    preseed: [
      path.join(engineSource, "Scene/Primitive.js"),
      path.join(engineSource, "Scene/PrimitiveCommandHelpers.js"),
    ],
    mutate: (source) => exposeQueuePath(inert ? inert(source) : source),
    label: label ?? "expose the ground-polyline queue path",
  });
}

/**
 * A ground-polyline-shaped primitive whose inner arrays start unrefreshed, so
 * the only way the feature renderer can see them populated is the hoisted call.
 *
 * @param {object} namespace The bundle namespace.
 * @returns {object} `{primitive, seen}`.
 */
function queueFixture(namespace) {
  const {
    __BoundingSphere: Sphere,
    __Cartesian3: Vec3,
    __Matrix4: Mat4,
  } = namespace;
  const inner = {
    // What geometry combination leaves behind, and what the refresh reads.
    _boundingSpheres: [new Sphere(new Vec3(1.0, 2.0, 3.0), 500.0)],
    _boundingSphereCV: [new Sphere(new Vec3(4.0, 5.0, 6.0), 500.0)],
    // What the refresh produces. Empty until it runs.
    _boundingSphereWC: [],
    _boundingSphere2D: [],
    _boundingSphereMorph: [],
    _modelMatrix: new Mat4(),
    appearance: {},
    allowPicking: false,
  };
  return { primitive: { _primitive: inner }, inner };
}

/**
 * Dispatches the real queue path with a recording feature renderer.
 *
 * @param {object} namespace The bundle namespace.
 * @param {number} mode The scene mode.
 * @returns {object} What the feature renderer saw when it was called.
 */
function dispatchWithFeatureRenderer(namespace, mode) {
  const { primitive } = queueFixture(namespace);
  const seen = {};
  const featureRenderer = {
    createCommands(dispatched) {
      const { _primitive: inner } = dispatched;
      seen.worldSpheres = inner._boundingSphereWC.length;
      seen.spheres2D = inner._boundingSphere2D.length;
      seen.morphSpheres = inner._boundingSphereMorph.length;
      return { colorCommands: [{ tag: "from the feature renderer" }] };
    },
  };
  const frameState = {
    mode,
    scene3DOnly: false,
    invertClassification: false,
    passes: { render: true, pick: false },
    commandList: [],
    context: { getFeatureRenderer: () => featureRenderer },
  };
  namespace.__updateAndQueueCommands(
    primitive,
    frameState,
    [],
    [],
    namespace.__Matrix4.IDENTITY,
    true,
    false,
  );
  seen.queued = frameState.commandList.length;
  return seen;
}

test("AR-716 ordering: the feature renderer is dispatched with refreshed spheres", async () => {
  const namespace = await loadQueuePath();
  for (const mode of [
    namespace.__SceneMode.SCENE3D,
    namespace.__SceneMode.SCENE2D,
    namespace.__SceneMode.MORPHING,
  ]) {
    const seen = dispatchWithFeatureRenderer(namespace, mode);
    assert.equal(
      seen.worldSpheres,
      1,
      "the WebGPU renderer reads the inner Primitive's spheres, so they must " +
        "already be refreshed when it is dispatched",
    );
    assert.equal(seen.spheres2D, 1, "the 2D spheres too");
    assert.equal(seen.morphSpheres, 1, "and the morph spheres");
    assert.equal(seen.queued, 1, "the renderer's command is still queued");
  }
});

/**
 * A colour command shaped the way the WebGL queue path expects: it redirects
 * to `derivedCommands.color2D` outside SCENE3D and to `colorMorph` during a
 * morph, and it queues `derivedCommands.tileset` alongside for any
 * classification type that is not TERRAIN-only. Each of those is itself
 * redirected, so each carries its own derived pair.
 *
 * @returns {object} The command tree.
 */
function webglColorCommand() {
  const derived = () => ({ derivedCommands: { color2D: {}, colorMorph: {} } });
  return {
    derivedCommands: {
      color2D: {},
      colorMorph: {},
      tileset: derived(),
    },
  };
}

/**
 * The command WebGL actually writes for a mode, given the redirect in
 * `GroundPolylinePrimitive.js:789-793`.
 *
 * @param {object} namespace The bundle namespace.
 * @param {object} command The colour command tree.
 * @param {number} mode The scene mode.
 * @returns {object} The written command.
 */
function webglWrittenCommand(namespace, command, mode) {
  const { __SceneMode: Mode } = namespace;
  if (mode === Mode.MORPHING) {
    return command.derivedCommands.colorMorph;
  }
  if (mode !== Mode.SCENE3D) {
    return command.derivedCommands.color2D;
  }
  return command;
}

/**
 * Runs the REAL WebGL queue path with no feature renderer registered and
 * returns what it did.
 *
 * @param {object} namespace The bundle namespace.
 * @param {number} mode The scene mode.
 * @returns {object} `{primitive, inner, command, written, commandList}`.
 */
function runWebglQueuePath(namespace, mode) {
  const { primitive, inner } = queueFixture(namespace);
  const command = webglColorCommand();
  const frameState = {
    mode,
    scene3DOnly: false,
    invertClassification: false,
    passes: { render: true, pick: false },
    commandList: [],
    context: { getFeatureRenderer: () => undefined },
  };
  namespace.__updateAndQueueCommands(
    primitive,
    frameState,
    [command],
    [],
    namespace.__Matrix4.IDENTITY,
    true,
    false,
  );
  return {
    primitive,
    inner,
    command,
    written: webglWrittenCommand(namespace, command, mode),
    commandList: frameState.commandList,
  };
}

test("the WebGL queue path is unchanged when no feature renderer is registered", async () => {
  const namespace = await loadQueuePath();
  const { inner, written, commandList } = runWebglQueuePath(
    namespace,
    namespace.__SceneMode.SCENE3D,
  );
  assert.equal(
    commandList[0],
    written,
    "SCENE3D still queues the undelegated command itself",
  );
  // Non-vacuity guard. Without it, a fixture whose spheres were never refreshed
  // makes the next assertion `undefined === undefined` and the test certifies
  // an empty primitive. The M2 inertness mutant (the hoisted refresh made
  // unreachable) is what exposed the hole: this test stayed green under it while
  // WebGL had in fact lost its volume too.
  assert.equal(
    inner._boundingSphereWC.length,
    1,
    "the refresh must have produced a world-space sphere, or the comparison " +
      "below compares nothing with nothing",
  );
  assert.equal(
    written.boundingVolume,
    inner._boundingSphereWC[0],
    "with the mode's world-space sphere on it (GroundPolylinePrimitive.js:796)",
  );
  assert.equal(written.cull, true, "and the caller's cull flag (:797)");
  // The 3D-Tile classification command is queued alongside and carries the
  // same volume, so the hoist did not disturb the second half of the loop.
  const tileset = written.derivedCommands.tileset;
  assert.equal(commandList[1], tileset, "the 3D-Tile command is still queued");
  assert.equal(tileset.boundingVolume, inner._boundingSphereWC[0]);
});

test("the selection returns the volume WebGL's own queue path writes", async () => {
  // The reference is PRODUCED, not restated: it is whatever the real
  // `GroundPolylinePrimitive` queue path — WebGL's four-way chain at
  // `:862-874`, applied at `:796` — puts on the command for that mode. Both
  // come from one module graph, so this compares objects, not values.
  const namespace = await loadQueuePath();
  for (const [name, mode] of [
    ["SCENE3D", namespace.__SceneMode.SCENE3D],
    ["COLUMBUS_VIEW", namespace.__SceneMode.COLUMBUS_VIEW],
    ["SCENE2D", namespace.__SceneMode.SCENE2D],
    ["MORPHING", namespace.__SceneMode.MORPHING],
  ]) {
    const { primitive, written } = runWebglQueuePath(namespace, mode);
    assert.notEqual(
      written.boundingVolume,
      undefined,
      `${name}: WebGL wrote no reference volume, so this comparison would be ` +
        `vacuous — the fixture no longer resembles a ready primitive`,
    );
    assert.equal(
      namespace.__select(primitive, mode),
      written.boundingVolume,
      `${name}: the WebGPU classification command would carry a different ` +
        `bounding volume than the WebGL command for the same primitive`,
    );
  }
});

// ---------------------------------------------------------------------------
// Group E — inertness
// ---------------------------------------------------------------------------

// The selection's two returns, made unreachable rather than removed.
const INERT_SELECTION = (source) =>
  source
    .replace(
      "  return firstVolume(\n    sceneMode === SceneMode.SCENE3D",
      "  if (false) return firstVolume(\n    sceneMode === SceneMode.SCENE3D",
    )
    .replace(
      "function selectInnerPrimitiveSphere(primitive, sceneMode) {\n  const inner = primitive._primitive;",
      "function selectInnerPrimitiveSphere(primitive, sceneMode) {\n  if (!(false && primitive)) {\n    return undefined;\n  }\n  const inner = primitive._primitive;",
    );

test("inertness: an unreachable selection restores the pre-fix slice counts", async () => {
  const inert = await loadPvs([
    {
      basename: "WebGPUClassificationBoundingVolume.js",
      mutate: INERT_SELECTION,
      label: "make the classification bounding-volume selection unreachable",
    },
  ]);
  for (const [name, mode] of ALL_MODES) {
    assert.equal(
      inert.selectClassificationBoundingVolume(innerVolumeShape(), mode()),
      undefined,
      `${name}: with the fix unreachable the selection yields nothing again`,
    );
    assert.equal(
      inert.selectClassificationBoundingVolume(groundPrimitiveShape(), mode()),
      undefined,
      `${name}: for the GroundPrimitive shape too`,
    );
  }
});

test("inertness: an unreachable refresh strands the feature renderer again", async () => {
  const namespace = await loadQueuePath(
    (source) =>
      source.replace(
        HOISTED_REFRESH,
        "  if (false && Primitive._updateBoundingVolumes(primitive, frameState, modelMatrix)) {\n    // unreachable\n  }",
      ),
    "make the hoisted bounding-volume refresh unreachable",
  );
  const seen = dispatchWithFeatureRenderer(
    namespace,
    namespace.__SceneMode.SCENE2D,
  );
  assert.equal(
    seen.worldSpheres,
    0,
    "with the refresh unreachable the renderer is handed empty arrays, which " +
      "is exactly the pre-fix state that left every ground-polyline command " +
      "unbounded",
  );
  assert.equal(seen.spheres2D, 0, "and no 2D spheres");
});
