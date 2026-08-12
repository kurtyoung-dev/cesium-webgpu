/**
 * VR-BASELINE-SCENES-VOXEL-POINTCLOUD-SPLAT (C18-V2) — shared setup for the
 * three subsystem parity scenes: voxels, point clouds, Gaussian splats.
 *
 * Until this file landed, none of the three subsystems had a scene in the
 * continuously-re-run split-screen baseline, so their cross-backend evidence
 * was one-shot probe history (`probe-voxel-parity`, `probe-pointcloud-edl-
 * parity`, `probe-gsplat-parity`) whose newest voxel/point-cloud runs are from
 * 2026-07. This file turns each of those probes' certified scene construction
 * into a re-runnable capture-and-diff scene.
 *
 * ONE FILE, THREE SCENES. `scenes.json` points all three scenes at this file
 * and selects the subsystem through `setupParams.subsystem`; the scene
 * identity hash covers `setupParams`, so the three stay distinct entries in
 * `baseline/manifest.json`. The alternative — three near-identical files —
 * would have duplicated the isolation, clock-pinning and camera-sync
 * suppression below three times, and those are exactly the parts that must not
 * drift between the scenes.
 *
 * WHY EACH SCENE ISOLATES ITSELF RATHER THAN INHERITING PAGE STATE. The runner
 * applies scenes sequentially to ONE page, so whatever an earlier scene added
 * is still resident (the 5K-sphere primitive, the globe, its imagery). Each
 * scene below therefore hides every primitive it does not own, hides the
 * globe/sky/sun/moon/fog, pins the clock and paints an opaque black
 * background. Two consequences that are deliberate:
 *   - the scenes are ORDER-INDEPENDENT. `--scene <name>` on its own produces
 *     the same frame as a full sweep, which is what makes a red diagnosable.
 *   - the captured pixels are DOMINATED by the subsystem under test. A scene
 *     that also renders terrain, imagery and atmosphere measures those too,
 *     and a subsystem regression can hide under their noise.
 *
 * WHY THE PAGE'S CAMERA SYNC IS SUPPRESSED. `split-screen-comparison.html`
 * mirrors camera moves between the two viewers by copying heading/pitch/roll,
 * which is an EAST-NORTH-UP quantity. All three scenes below look at a target
 * from a direction that is very close to the local nadir, where that
 * conversion is ill-conditioned (pitch saturates at -90 deg and heading stops
 * being recoverable), so a mirrored camera can arrive rotated relative to its
 * source. Setting `camera.percentageChanged` above every normalized delta the
 * page's `changed` event can produce stops the mirror from ever firing; each
 * scene then writes the SAME pose to both viewers directly. The mismatch this
 * removes would be an instrument artifact scored as a renderer difference.
 *
 * WHY READINESS FAILURE THROWS. `capture-and-diff.mjs` does not catch a setup
 * rejection, so an unmet readiness budget below aborts the run with exit 99.
 * That is the intended behaviour: an empty frame on BOTH backends is a
 * cross-backend PASS, and a scene that silently failed to build its subject
 * would certify parity by rendering nothing. The budgets are wall clock, not
 * frame counts, because what they wait on (tileset fetch + parse, WASM sort
 * workers, cold pipeline variant compiles) is not denominated in frames.
 *
 * Called as `new Function("params", src)(params)` from `applyScene`; returns a
 * Promise the runner awaits before its own settle window.
 */

/* global params */
// `params` is the formal parameter of the `new Function("params", src)`
// wrapper that capture-and-diff.mjs's applyScene compiles this file into.
const Cesium = window.Cesium;
const viewers = [window.webglViewer, window.webgpuViewer].filter(Boolean);

if (viewers.length === 0) {
  throw new Error("subsystem-parity-setup: no split-screen viewers exposed");
}

/**
 * Readiness budgets, in wall-clock milliseconds. Deliberately constants in
 * this FILE rather than fields of `setupParams`: `setupParams` is hashed into
 * the scene identity that `baseline/manifest.json` pins, so raising a timeout
 * on a slower machine would invalidate every stored baseline even though a
 * timeout cannot change a single rendered pixel.
 */
const VOXEL_READY_BUDGET_MS = 45_000;
const POINT_CLOUD_READY_BUDGET_MS = 60_000;
/**
 * Frames each viewer must render AFTER its root tile is delivered before the
 * voxel scene is scored. Tile delivery proves the traversal consumed the
 * provider; it does not prove the data reached the GPU, and the WebGPU leg
 * still has a megatexture upload and a cold ray-march pipeline compile to do.
 */
const VOXEL_FRAMES_AFTER_DATA = 30;
const SPLAT_CONTENT_BUDGET_MS = 60_000;
const SPLAT_DATA_BUDGET_MS = 60_000;
const SPLAT_SORT_QUIESCE_BUDGET_MS = 20_000;
/** How long the splat sort order must hold still before the scene is scored. */
const SPLAT_SORT_QUIESCE_WINDOW_MS = 400;

/** Extra wall-clock settle after readiness, before the runner's rAF window. */
const SETTLE_AFTER_READY_MS = 2_000;

/** Marker property that separates primitives this file owns from the rest. */
const OWNER_TAG = "__vrSubsystemParityOwner";

function isOwned(primitive) {
  return typeof primitive?.[OWNER_TAG] === "string";
}

function own(primitive, sceneName) {
  primitive[OWNER_TAG] = sceneName;
  return primitive;
}

/**
 * Hide — never destroy — every primitive this file did not add.
 *
 * Removing them would be simpler but is not safe: `scene.primitives` also
 * holds the Viewer's own `DataSourceDisplay` collection, and destroying that
 * breaks the viewer for every later scene. `show = false` is reversible, costs
 * nothing, and treats a collection and a primitive identically.
 */
function hideForeignPrimitives(scene) {
  for (let i = 0; i < scene.primitives.length; i++) {
    const primitive = scene.primitives.get(i);
    if (isOwned(primitive)) continue;
    try {
      if ("show" in primitive) primitive.show = false;
    } catch {
      // A primitive with a read-only `show` cannot be hidden; it is still
      // outside the camera in every scene below.
    }
  }
}

/** Drop content a previous invocation of this file left behind. */
function removeOwnedPrimitives(scene) {
  for (let i = scene.primitives.length - 1; i >= 0; i--) {
    const primitive = scene.primitives.get(i);
    if (isOwned(primitive)) scene.primitives.remove(primitive);
  }
}

/**
 * Put one viewer into the deterministic, subsystem-isolated state every scene
 * below shares. Mirrors what `probe-voxel-parity` / `probe-gsplat-parity`
 * establish before they capture, so a scene here and its probe are looking at
 * the same scene rather than at two different definitions of "isolated".
 */
function isolateViewer(viewer, pinnedTime) {
  const scene = viewer.scene;
  scene.requestRenderMode = false;
  scene.globe.show = false;
  scene.globe.enableLighting = false;
  scene.globe.showGroundAtmosphere = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.fog) scene.fog.enabled = false;
  scene.backgroundColor = Cesium.Color.BLACK;

  // See the header: this is what stops the page mirroring one camera onto the
  // other through an ill-conditioned heading/pitch/roll round trip.
  viewer.camera.percentageChanged = Number.MAX_VALUE;

  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = Cesium.JulianDate.clone(
    pinnedTime,
    viewer.clock.currentTime,
  );

  hideForeignPrimitives(scene);
  removeOwnedPrimitives(scene);
}

function settle(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Drive the page's own render loop until `predicate()` holds, or the budget
 * expires. The viewers render themselves here (`useDefaultRenderLoop` is on in
 * the split-screen page), so this waits rather than calling `scene.render`;
 * driving a second render from outside the loop would double-submit frames.
 */
function waitUntil(predicate, budgetMs) {
  return new Promise((resolve) => {
    const deadline = performance.now() + budgetMs;
    function tick() {
      let held;
      try {
        held = predicate() === true;
      } catch {
        // A readiness field that does not exist yet (an unloaded tileset, a
        // renamed private) reads as "not ready", never as an abort — the
        // budget above is what decides, and it fails loudly.
        held = false;
      }
      if (held) {
        resolve(true);
        return;
      }
      if (performance.now() >= deadline) {
        resolve(false);
        return;
      }
      requestAnimationFrame(tick);
    }
    tick();
  });
}

function requireReady(reached, what, budgetMs) {
  if (reached !== true) {
    throw new Error(
      `subsystem-parity-setup: ${what} did not become ready within ${budgetMs} ms`,
    );
  }
}

// ===========================================================================
// Voxel — procedural BOX-shape VoxelPrimitive
// ===========================================================================

const EARTH_RADIUS = Cesium.Ellipsoid.WGS84.maximumRadius;

/**
 * The asset-free procedural provider the `webgpu-voxel-pick` /`voxel-picking`
 * gallery demos use, with one deliberate change: the per-voxel colour is a
 * pure function of the voxel index instead of `Cesium.Math.setRandomNumberSeed`
 * + `nextRandomNumber`. That seed is PROCESS-GLOBAL mutable state shared with
 * everything else on the page, so a demo pattern that reseeds it per tile is
 * reproducible in a demo and only probably reproducible in a suite that runs
 * seven other scenes first. An index-derived hue is reproducible by
 * construction, which is what a re-run baseline needs.
 *
 * `availableLevels = 1` keeps the volume to its root tile. That is not a
 * simplification for its own sake: `probe-voxel-parity` records that the
 * WebGPU path uploads only the ROOT tile while WebGL runs the full octree
 * traversal plus megatexture, so a multi-level volume would score that known
 * traversal gap instead of the shared BOX-shape ray-march this scene exists to
 * watch.
 *
 * `onTileDelivered` is the scene's backend-neutral readiness signal; see
 * `setUpVoxelScene` for why the primitive's own `ready` flag cannot be used.
 */
function createProceduralBoxProvider(dimension, onTileDelivered) {
  const dimensions = new Cesium.Cartesian3(dimension, dimension, dimension);
  const scratchColor = new Cesium.Color();
  return {
    shape: Cesium.VoxelShapeType.BOX,
    dimensions: dimensions,
    minBounds: Cesium.VoxelShapeType.getMinBounds(
      Cesium.VoxelShapeType.BOX,
    ).clone(),
    maxBounds: Cesium.VoxelShapeType.getMaxBounds(
      Cesium.VoxelShapeType.BOX,
    ).clone(),
    names: ["color"],
    types: [Cesium.MetadataType.VEC4],
    componentTypes: [Cesium.MetadataComponentType.FLOAT32],
    availableLevels: 1,
    globalTransform: Cesium.Matrix4.fromScale(
      new Cesium.Cartesian3(EARTH_RADIUS, EARTH_RADIUS, EARTH_RADIUS),
    ),
    requestData: function (options) {
      if (options.tileLevel >= this.availableLevels) {
        return Promise.reject(
          new Error(`no tiles beyond level ${this.availableLevels - 1}`),
        );
      }
      const channelCount = Cesium.MetadataType.getComponentCount(this.types[0]);
      const voxelCount = dimensions.x * dimensions.y * dimensions.z;
      const data = new Float32Array(voxelCount * channelCount);
      for (let i = 0; i < voxelCount; i++) {
        const color = Cesium.Color.fromHsl(
          (i + 0.5) / voxelCount,
          0.85,
          0.5,
          1.0,
          scratchColor,
        );
        const index = i * channelCount;
        data[index] = color.red;
        data[index + 1] = color.green;
        data[index + 2] = color.blue;
        data[index + 3] = 1.0;
      }
      // Counted only on the served level — the rejection above is a normal
      // part of traversal and is not evidence that anything loaded.
      onTileDelivered();
      return Promise.resolve(Cesium.VoxelContent.fromMetadataArray([data]));
    },
  };
}

/**
 * `probe-voxel-parity`'s pose, verbatim in intent: far enough out that the
 * Earth-scaled box reads as a bounded silhouette against black rather than a
 * full-frame fill, and off-axis so the silhouette shows edges and corners
 * instead of a face-on quad that a mis-placed flat quad could also produce.
 */
const VOXEL_CAMERA_POSITION = new Cesium.Cartesian3(
  EARTH_RADIUS * 6.0,
  EARTH_RADIUS * 4.5,
  EARTH_RADIUS * 4.0,
);

/**
 * Backend-neutral voxel readiness evidence.
 *
 * `VoxelPrimitive.ready` now transitions only after the selected renderer has
 * usable owner resources. The provider below is also owned by this file, and
 * both traversals fetch through
 * `provider.requestData` (`VoxelTraversal.js` on WebGL,
 * `WebGPUVoxelDataUpload.ts` on WebGPU), so a served root tile proves the
 * primitive is traversing and has consumed its data on either backend. Because
 * delivery alone does not prove public lifecycle publication, the gate
 * requires BOTH `.ready` and `VOXEL_FRAMES_AFTER_DATA` post-delivery frames.
 * The budget still throws on failure, so two empty canvases cannot certify.
 */
async function setUpVoxelScene(sceneName, dimension) {
  const deliveredTiles = viewers.map(() => 0);
  const renderedFrames = viewers.map(() => 0);
  const framesAtDelivery = viewers.map(() => null);
  const primitives = [];

  viewers.forEach((viewer, index) => {
    const primitive = new Cesium.VoxelPrimitive({
      provider: createProceduralBoxProvider(dimension, () => {
        deliveredTiles[index]++;
      }),
    });
    primitive.nearestSampling = true;
    primitives[index] = primitive;
    viewer.scene.primitives.add(own(primitive, sceneName));
  });

  const stopCounting = viewers.map((viewer, index) =>
    viewer.scene.postRender.addEventListener(() => {
      renderedFrames[index]++;
    }),
  );

  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.negate(VOXEL_CAMERA_POSITION, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  for (const viewer of viewers) {
    viewer.camera.setView({
      destination: VOXEL_CAMERA_POSITION,
      orientation: { direction: direction, up: Cesium.Cartesian3.UNIT_Z },
    });
  }

  try {
    requireReady(
      await waitUntil(() => {
        for (let index = 0; index < viewers.length; index++) {
          if (deliveredTiles[index] === 0 || primitives[index].ready !== true) {
            return false;
          }
          // Latch the frame number the tile arrived on, so the post-delivery
          // frames are counted from delivery rather than from scene start.
          if (framesAtDelivery[index] === null) {
            framesAtDelivery[index] = renderedFrames[index];
          }
          if (
            renderedFrames[index] - framesAtDelivery[index] <
            VOXEL_FRAMES_AFTER_DATA
          ) {
            return false;
          }
        }
        return true;
      }, VOXEL_READY_BUDGET_MS),
      "voxel public readiness, root tile delivery, and post-delivery frames",
      VOXEL_READY_BUDGET_MS,
    );
  } finally {
    for (const stop of stopCounting) {
      stop();
    }
  }
  await settle(SETTLE_AFTER_READY_MS);
}

// ===========================================================================
// Point cloud — TimeDynamicPointCloud on the DEDICATED renderer path
// ===========================================================================

/**
 * `TimeDynamicPointCloud`, not a PNTS `Cesium3DTileset`, and that choice is
 * the point of the scene. PNTS tilesets route through the Model pipeline,
 * where WebGPU renders fixed 1 px points and eye-dome lighting is silently
 * inert (`PNTS-MODEL-PATH-EDL-INERT`); the dedicated path is the one where
 * attenuation and EDL actually execute on both backends, so it is the one a
 * parity baseline can watch today. When the model path is wired, it earns its
 * own scene rather than replacing this one.
 *
 * Interval boundaries and frame URIs mirror `probe-pointcloud-edl-parity`.
 * Every asset is in-tree under `Apps/SampleData`, so the scene is offline.
 */
const POINT_CLOUD_DATES = [
  "2018-07-19T15:18:00Z",
  "2018-07-19T15:18:00.5Z",
  "2018-07-19T15:18:01Z",
  "2018-07-19T15:18:01.5Z",
  "2018-07-19T15:18:02Z",
  "2018-07-19T15:18:02.5Z",
];

const POINT_CLOUD_URIS = [0, 1, 2, 3, 4].map(
  (index) =>
    `/Apps/SampleData/Cesium3DTiles/PointCloud/PointCloudTimeDynamic/${index}.pnts`,
);

/**
 * The sample's known ECEF location and extent, hard-coded for the same reason
 * the probe hard-codes them: `TimeDynamicPointCloud.boundingSphere` lags the
 * first render by several frames, so framing from it makes the camera — and
 * therefore the captured footprint — a function of load timing, which differs
 * between the two backends.
 */
const POINT_CLOUD_SPHERE = new Cesium.BoundingSphere(
  new Cesium.Cartesian3(1215012.9, -4736312.85, 4081606.1),
  4.1,
);

async function setUpPointCloudScene(sceneName, pinnedTime) {
  // The scene's pinned clock IS its frame selector: `TimeDynamicPointCloud`
  // resolves which `.pnts` to render from the clock, so a pinned time outside
  // the first interval would silently capture a different frame than the one
  // the scene claims to be a baseline for.
  const firstInterval = Cesium.JulianDate.fromIso8601(POINT_CLOUD_DATES[0]);
  if (!Cesium.JulianDate.equals(pinnedTime, firstInterval)) {
    throw new Error(
      `subsystem-parity-setup: point-cloud pinnedTimeIso must be ${POINT_CLOUD_DATES[0]}`,
    );
  }

  const clouds = viewers.map((viewer) => {
    const intervals = Cesium.TimeIntervalCollection.fromIso8601DateArray({
      iso8601Dates: POINT_CLOUD_DATES,
      dataCallback: (interval, index) => ({ uri: POINT_CLOUD_URIS[index] }),
    });
    viewer.clock.startTime = Cesium.JulianDate.fromIso8601(
      POINT_CLOUD_DATES[0],
    );
    viewer.clock.stopTime = Cesium.JulianDate.fromIso8601(
      POINT_CLOUD_DATES[POINT_CLOUD_DATES.length - 1],
    );
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
    viewer.clock.shouldAnimate = false;

    const cloud = new Cesium.TimeDynamicPointCloud({
      intervals: intervals,
      clock: viewer.clock,
      style: new Cesium.Cesium3DTileStyle({ pointSize: 8 }),
      shading: {
        attenuation: true,
        maximumAttenuation: 10,
        eyeDomeLighting: true,
        eyeDomeLightingStrength: 1.0,
        eyeDomeLightingRadius: 2.0,
      },
    });
    viewer.scene.primitives.add(own(cloud, sceneName));
    return cloud;
  });

  frameOnPointCloudSphere();
  requireReady(
    await waitUntil(
      () => clouds.every((cloud) => Cesium.defined(cloud.boundingSphere)),
      POINT_CLOUD_READY_BUDGET_MS,
    ),
    "time-dynamic point cloud",
    POINT_CLOUD_READY_BUDGET_MS,
  );
  // Re-frame once after load: the first frame's arrival can nudge the camera
  // through the viewer's own tracking, and both viewers must end on the pose
  // this function chose, not on whichever one loaded first.
  frameOnPointCloudSphere();
  await settle(SETTLE_AFTER_READY_MS);
}

function frameOnPointCloudSphere() {
  for (const viewer of viewers) {
    viewer.camera.viewBoundingSphere(
      POINT_CLOUD_SPHERE,
      new Cesium.HeadingPitchRange(0.3, -0.25, POINT_CLOUD_SPHERE.radius * 4.0),
    );
    // Bake the world-space pose and drop the bounding-sphere reference frame,
    // so nothing downstream reads the camera in a local frame.
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }
}

// ===========================================================================
// Gaussian splats — the in-tree sh_unit_cube tileset
// ===========================================================================

/**
 * The smaller of the two tilesets the `C15-G` harness gates on: 27 splats,
 * spherical-harmonics degree 3, not georeferenced (its bounding volume sits a
 * few tens of metres from the geocentre, which is why the globe must be hidden
 * rather than merely un-imaged). In-tree under `Specs/Data`, so the scene is
 * offline. Splats over a globe are a different subject — multifrustum depth
 * composition — and that has its own row and its own scene.
 */
const SPLAT_TILESET_URL =
  "/Specs/Data/Cesium3DTiles/GaussianSplats/sh_unit_cube/tileset.json";
const SPLAT_RANGE_SCALE = 2.0;
const SPLAT_PITCH_DEGREES = -30.0;
const SPLAT_HEADING_DEGREES = 0.0;

/**
 * `probe-gsplat-parity`'s backend-neutral sort signature. `_indexesSortSequence`
 * and `_indexesDataGeneration` are the provenance stamps on the published
 * permutation, so a change in either IS a resolved sort on either backend; the
 * WebGPU upload counters ride along where they exist. A splat scene captured
 * while this is still moving cannot reproduce itself between runs, which for a
 * stored baseline is worse than a wrong number — it is a flapping one.
 */
function splatSortSignature(tilesets) {
  return tilesets
    .map((tileset) => {
      const primitive = tileset?.gaussianSplatPrimitive;
      return [
        primitive?._indexesSortSequence ?? -1,
        primitive?._indexesDataGeneration ?? -1,
        primitive?._sortRequestId ?? -1,
        primitive?._indexes?.length ?? -1,
        primitive?._webgpuCache?.providedSortUploads ?? -1,
      ].join("/");
    })
    .join("|");
}

async function setUpSplatScene(sceneName) {
  const tilesets = [];
  for (const viewer of viewers) {
    const tileset = await Cesium.Cesium3DTileset.fromUrl(SPLAT_TILESET_URL, {
      maximumScreenSpaceError: 1,
      cullRequestsWhileMoving: false,
    });
    viewer.scene.primitives.add(own(tileset, sceneName));
    tilesets.push(tileset);
  }

  // ONE sphere frames BOTH cameras. Each viewer owns its own tileset instance,
  // and reading each one's own bounding sphere would make the two poses a
  // function of two independent load states.
  const sphere = tilesets[0].boundingSphere;
  const range = Math.max(sphere.radius * SPLAT_RANGE_SCALE, 10.0);
  for (const viewer of viewers) {
    viewer.camera.lookAt(
      sphere.center,
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(SPLAT_HEADING_DEGREES),
        Cesium.Math.toRadians(SPLAT_PITCH_DEGREES),
        range,
      ),
    );
    viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  requireReady(
    await waitUntil(
      () =>
        tilesets.every(
          (tileset) =>
            tileset.tilesLoaded === true && tileset.root?.contentReady === true,
        ),
      SPLAT_CONTENT_BUDGET_MS,
    ),
    "splat tileset content",
    SPLAT_CONTENT_BUDGET_MS,
  );

  // The splat data commit is a SEPARATE wait from tile content: the shared
  // pipeline decodes the record payload after the tile is "ready", and a
  // capture taken between the two draws an empty canvas on both backends —
  // which the cross-backend gate would score as parity.
  requireReady(
    await waitUntil(
      () =>
        tilesets.every((tileset) => {
          const primitive = tileset.gaussianSplatPrimitive;
          return (
            Cesium.defined(primitive) &&
            primitive._numSplats > 0 &&
            primitive.isStable === true
          );
        }),
      SPLAT_DATA_BUDGET_MS,
    ),
    "splat data commit",
    SPLAT_DATA_BUDGET_MS,
  );

  let signature = splatSortSignature(tilesets);
  let stableSince = performance.now();
  requireReady(
    await waitUntil(() => {
      const next = splatSortSignature(tilesets);
      if (next !== signature) {
        signature = next;
        stableSince = performance.now();
        return false;
      }
      return performance.now() - stableSince >= SPLAT_SORT_QUIESCE_WINDOW_MS;
    }, SPLAT_SORT_QUIESCE_BUDGET_MS),
    "splat sort quiescence",
    SPLAT_SORT_QUIESCE_BUDGET_MS,
  );
  await settle(SETTLE_AFTER_READY_MS);
}

// ===========================================================================
// Dispatch
// ===========================================================================

const SUBSYSTEM = params.subsystem;
const SCENE_NAME = params.sceneName ?? SUBSYSTEM;
const PINNED_TIME = Cesium.JulianDate.fromIso8601(params.pinnedTimeIso);

for (const viewer of viewers) {
  isolateViewer(viewer, PINNED_TIME);
}

if (SUBSYSTEM === "voxel") {
  return setUpVoxelScene(SCENE_NAME, params.voxelDimension);
}
if (SUBSYSTEM === "pointcloud") {
  return setUpPointCloudScene(SCENE_NAME, PINNED_TIME);
}
if (SUBSYSTEM === "gsplat") {
  return setUpSplatScene(SCENE_NAME);
}
throw new Error(`subsystem-parity-setup: unknown subsystem "${SUBSYSTEM}"`);
