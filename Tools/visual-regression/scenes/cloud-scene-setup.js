/**
 * C13-N07a — shared setup for the two WebGPU volumetric-cloud scenes in the
 * standing image gate: `cloud-orbital-disc` (the campaign's PRIMARY goal
 * band — an orbital view of a sunlit disc with visible cloud cover) and
 * `cloud-ground-overcast` (a low camera under a high-coverage deck).
 *
 * ONE FILE, TWO SCENES, selected by `params.sceneName` — the same shape as
 * `scenes/subsystem-parity-setup.js`, whose conventions this file follows
 * throughout (isolation, clock pinning, mirror suppression, throw-on-timeout
 * readiness). Read that file's header before changing this one.
 *
 * WHY NO `CloudCollection` PRIMITIVE IS ADDED. `resolveCloudFramePlan`
 * (`Renderer/WebGPU/WebGPUSceneRendererEnvironmentalEffects.ts:128-176`) first
 * checks `context.consumeVolumetricCloudRequest()` (populated by a
 * `CloudCollection` that is in `scene.primitives` and got its own `.update()`
 * called) and, only if that is empty, falls back to reading
 * `scene.globe.defaultCloudCollection` DIRECTLY — `managed.renderMode === 1`
 * (`CloudRenderMode.VOLUMETRIC`) and `managed.volumetric.enabled === true` —
 * and resolves the config from it without ever calling `.update()`. So
 * configuring `scene.globe.defaultCloudCollection` is sufficient by itself;
 * this is also exactly what `lib/cloud-probe-harness.mjs`'s `configure()`
 * does (it never touches `scene.primitives` either).
 *
 * WHY THE GLOBE IS HIDDEN. Both scenes set `scene.globe.show = false`,
 * matching `subsystem-parity-setup.js`'s isolation philosophy: "the captured
 * pixels are DOMINATED by the subsystem under test... a subsystem regression
 * can hide under [terrain/imagery/atmosphere] noise." The volumetric cloud
 * ray-march is independent of `globe.show` (nothing in
 * `WebGPUProceduralCloudRenderer.ts` or the environmental-effects resolver
 * above gates on it), so a `cloudCoverage` near 1.0 still reads as a solid,
 * fully-formed lit sphere/deck — the "disc" is the cloud shell itself. This
 * also keeps both scenes OFFLINE: hiding the globe means this file issues no
 * imagery or terrain request of its own (the shared page's initial default
 * imagery layer, if any, was already requested by an earlier scene in the
 * sweep before this file ever runs — `capture-and-diff.mjs` navigates once
 * and applies every scene to the same page — but this file adds nothing to
 * that).
 *
 * WHY THE MIRROR IS SUPPRESSED. Same reasoning and same mechanism as
 * `subsystem-parity-setup.js`: `split-screen-comparison.html`'s
 * `camera.changed` listener mirrors one viewer's heading/pitch/roll onto the
 * other on the TARGET's next update tick (`syncCameraFromTo`, not
 * synchronous), and `cloud-orbital-disc`'s straight-down nadir pitch
 * (-90 deg) is exactly the orientation where that ENU heading/pitch/roll
 * round trip is ill-conditioned. Both viewers are set to the identical
 * explicit pose below regardless, so the mirror re-applying its own read-back
 * would at worst be a no-op — `viewer.camera.percentageChanged =
 * Number.MAX_VALUE` removes even that possibility rather than relying on it
 * being harmless.
 *
 * WHY THE CLOCK IS PINNED TO A LITERAL ISO STRING. `lib/cloud-tour-
 * fixtures.mjs`'s `utcIsoForLocalSolarHour(lonDegrees, localSolarHour,
 * dateIso)` is the canonical way this repo derives a UTC instant from a
 * stated local-solar-hour intent, but it is a `.mjs` module and this file is
 * compiled with `new Function("params", src)` and executed in the page —
 * there is no import here. The instants below are that function's output,
 * computed offline and pinned as literals, with the arithmetic shown so the
 * literal can be checked by hand:
 *
 *   utcIsoForLocalSolarHour(lonDegrees, localSolarHour, dateIso):
 *     wrappedLon     = ((((lonDegrees + 180) % 360) + 360) % 360) - 180
 *     offsetSeconds  = round((localSolarHour - wrappedLon / 15) * 3600)
 *     result         = dateIso@00:00:00Z + offsetSeconds
 *
 *   cloud-orbital-disc:    lon=0,    hour=12 -> wrappedLon=0,    offset=43200s (12h00m00s) -> 2026-06-21T12:00:00Z
 *   cloud-ground-overcast: lon=-100, hour=15 -> wrappedLon=-100, offset=78000s (21h40m00s) -> 2026-06-21T21:40:00Z
 *
 * `2026-06-21` reuses `cloud-tour-fixtures.mjs`'s `TOUR_EPOCH_DATE` (the June
 * solstice) rather than an arbitrary date, for the same reason that module
 * picked it: a determinate sun. `cloud-orbital-disc` anchors at the equator
 * (lat 0) rather than at the solstice's ~23.4 deg subsolar latitude, trading
 * a few degrees of peak illumination for a literal that does not depend on
 * reproducing Cesium's solar-ephemeris model by hand; at local solar noon on
 * the equator the sun elevation is never below ~66.5 deg on any date, which
 * is enough for a terminator-free lit disc without needing the exact
 * subsolar point.
 *
 * READINESS IS UNDER REPAIR ELSEWHERE — SEE C13-N08a. The authoritative
 * readiness helper, `lib/cloud-probe-harness.mjs`'s `awaitProceduralReady`,
 * is not reachable from a page-context setup file (it is installed via
 * `page.addInitScript`, which `capture-and-diff.mjs` never calls for this
 * suite) and, per `migration_doc/CAMPAIGN_13_V2_CLOUD_QUALITY_2026-09-12.md`
 * row `C13-N08a`, its own readiness definition is itself being repaired: it
 * counts `featureRenderer.execute` calls rather than the entry
 * `WebGPUSceneRendererEnvironmentalEffects.ts:327-329` actually calls. This
 * file's `waitForCloudReady` below is a bounded, best-effort approximation —
 * poll `context._cloudCache` for `initialized` + `pipeline`, then require
 * `frameCounter` to ADVANCE at least once as a proxy for "a frame actually
 * executed" (see the comment on `waitForCloudReady` for why frameCounter was
 * chosen). REVISIT THIS FILE once C13-N08a lands a corrected signal and swap
 * to it.
 *
 * ── BASELINE RECIPE (for the Edge slot that eventually runs this) ──────────
 * This lane holds no browser and cannot capture. When the slot returns:
 *   1. `npm run start:dev` (or the project's usual way of serving
 *      `Apps/WebGPUTest/split-screen-comparison.html` at
 *      http://localhost:8080/) — capture-and-diff.mjs does not start a
 *      server itself, per its own top-of-file usage block.
 *   2. If executing from a built bundle rather than a live dev server
 *      (`--serve-built`-style workflow — see `feedback_serve_built_for_
 *      executors`), assert served md5 == on-disk md5 for the served
 *      `Build/**` output BEFORE capturing, so a stale bundle cannot silently
 *      certify.
 *   3. First establish the two new scenes' baselines (they have none yet, so
 *      every gate reads NON_CERTIFYING/HISTORICAL_BASELINE_MISSING until
 *      this step):
 *      ONE SCENE PER INVOCATION. `--scene` parses as a single value
 *      (`capture-and-diff.mjs:92`, `args.scene = argv[++i]`), so a repeated
 *      flag silently keeps only the LAST name and promotes one baseline
 *      while the executor believes two were banked. Run the block below
 *      TWICE, once per scene name:
 *        node Tools/visual-regression/capture-and-diff.mjs \
 *          --scene <cloud-orbital-disc | cloud-ground-overcast> \
 *          --update --confirm-baseline-promotion \
 *          --update-rationale "C13-N07a: first WebGPU cloud baselines" \
 *          --reviewed-by "<edge executor name>"
 *      This writes/updates:
 *        Tools/visual-regression/baseline/cloud-orbital-disc.webgl.png
 *        Tools/visual-regression/baseline/cloud-orbital-disc.webgpu.png
 *        Tools/visual-regression/baseline/cloud-ground-overcast.webgl.png
 *        Tools/visual-regression/baseline/cloud-ground-overcast.webgpu.png
 *        Tools/visual-regression/baseline/manifest.json (review/provenance
 *          entries for all four images above)
 *      Promotion only proceeds if EVERY scene's `crossBackend` gate is PASS
 *      (`capture-and-diff.mjs:1041-1076`) — this is exactly why
 *      `scenes.json`'s `thresholds.crossBackend` override exists for these
 *      two scenes (see the entries' `expectedMismatch` rationale for the
 *      derivation); do not "fix" a promotion block by loosening it further
 *      without re-reading that rationale first.
 *   4. Re-run WITHOUT `--update` to certify against the now-locked manifest:
 *        node Tools/visual-regression/capture-and-diff.mjs --scene cloud-orbital-disc
 *        node Tools/visual-regression/capture-and-diff.mjs --scene cloud-ground-overcast
 *      Exit code 0 and `output/report.json`'s `summary.status === "PASS"`
 *      confirm the baseline round-trips.
 *   5. Reviewer checklist on the promoted PNGs
 *      (`Tools/visual-regression/baseline/cloud-*.webgpu.png`):
 *        - `cloud-orbital-disc.webgpu.png` shows a filled, terminator-free
 *          lit disc (no visible black gaps punched through the cloud shell —
 *          if there are, `cloudCoverage` is too low for this scene's intent)
 *          with visible cloud structure (not a flat, featureless disc).
 *        - `cloud-ground-overcast.webgpu.png` shows a dense, low overcast
 *          deck filling most of the frame from a near-ground vantage, not an
 *          empty/black frame (an empty frame on both backends would still
 *          cross-backend-PASS under the override, which is exactly the
 *          failure mode `subsystem-parity-setup.js`'s header warns about —
 *          "an empty frame on BOTH backends is a cross-backend PASS").
 *        - Both `*.webgl.png` baselines are the isolated black/near-black
 *          frame (globe hidden, no volumetric cloud on WebGL by documented
 *          design) — if a `*.webgl.png` shows anything else, something
 *          leaked from an earlier scene in the sweep and the isolation logic
 *          in this file needs to be revisited.
 *      Run `node Tools/visual-regression/cloud-scenes-contract.spec.mjs`
 *      once more after any hand-edit to `scenes.json` made during review.
 *
 * Called as `new Function("params", src)(params)` from `applyScene`; returns
 * a Promise the runner awaits before its own settle window.
 */

/* global params */
const Cesium = window.Cesium;
const viewers = [window.webglViewer, window.webgpuViewer].filter(Boolean);

if (viewers.length === 0) {
  throw new Error("cloud-scene-setup: no split-screen viewers exposed");
}

/** Wall-clock budget for the WebGPU cloud cache to allocate + compile. */
const CLOUD_CACHE_READY_BUDGET_MS = 45_000;
/** Wall-clock budget for `frameCounter` to advance once the cache is ready. */
const CLOUD_FRAME_ADVANCE_BUDGET_MS = 10_000;
/** Extra settle after readiness, before the runner's own settle window. */
const SETTLE_AFTER_READY_MS = 2_000;
/**
 * `FeatureRendererKey.PROCEDURAL_CLOUDS` (`Renderer/FeatureRendererKey.js:87`).
 * Hard-coded rather than imported for the same reason every literal in this
 * file is hard-coded: there is no module system inside `new Function`.
 */
const PROCEDURAL_CLOUDS_FEATURE_RENDERER_KEY = 32;

function settle(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Same shape as `subsystem-parity-setup.js`'s `waitUntil` — see its header. */
function waitUntil(predicate, budgetMs) {
  return new Promise((resolve) => {
    const deadline = performance.now() + budgetMs;
    function tick() {
      let held;
      try {
        held = predicate() === true;
      } catch {
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
      `cloud-scene-setup: ${what} did not become ready within ${budgetMs} ms`,
    );
  }
}

/**
 * Reset a `CloudCollection`'s lazily-created `.volumetric` bag to the
 * defaults `CloudVolumetrics`'s own constructor would produce. Necessary
 * because `CloudCollection#volumetric` has no setter (`CloudCollection.js`
 * getter only constructs the instance once and returns the SAME object on
 * every read) and the collection is owned by `Globe`, which persists across
 * the whole page session — without this, whichever scene of this file's TWO
 * scenes ran second would inherit the first scene's overrides for every
 * field it does not itself set, breaking order-independence.
 */
function resetVolumetric(collection) {
  const fresh = new Cesium.CloudVolumetrics();
  const target = collection.volumetric;
  for (const key of Object.keys(fresh)) {
    target[key] = fresh[key];
  }
}

/**
 * Apply this scene's overrides on top of the just-reset defaults, then flip
 * the collection into VOLUMETRIC mode. Throws on an unknown property —
 * mirroring `lib/cloud-probe-harness.mjs`'s `configure()` guard — because a
 * typo'd key here would otherwise silently no-op instead of failing loudly.
 */
function applyVolumetricOverrides(collection, overrides) {
  const target = collection.volumetric;
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in target)) {
      throw new Error(
        `cloud-scene-setup: unknown CloudVolumetrics property "${key}"`,
      );
    }
    target[key] = value;
  }
  // Sets `volumetric.enabled = true` AND `renderMode = VOLUMETRIC`
  // (`CloudCollection.js`'s `enableVolumetric` setter) — the two conditions
  // `resolveCloudFramePlan`'s managed-collection fallback requires.
  collection.enableVolumetric = true;
}

/** Hide — never destroy — every primitive an earlier scene in the sweep left resident. */
function hideForeignPrimitives(scene) {
  for (let i = 0; i < scene.primitives.length; i++) {
    const primitive = scene.primitives.get(i);
    try {
      if ("show" in primitive) primitive.show = false;
    } catch {
      // A primitive with a read-only `show` cannot be hidden; it is still
      // outside the camera in every scene below.
    }
  }
}

/**
 * Put one viewer into the deterministic, cloud-isolated state both scenes
 * share. See the header for why the globe is hidden and the mirror is
 * suppressed.
 */
function isolateViewer(viewer, pinnedTime) {
  const scene = viewer.scene;
  scene.requestRenderMode = false;
  scene.globe.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.fog) scene.fog.enabled = false;
  scene.backgroundColor = Cesium.Color.BLACK;

  viewer.camera.percentageChanged = Number.MAX_VALUE;

  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = Cesium.JulianDate.clone(
    pinnedTime,
    viewer.clock.currentTime,
  );

  hideForeignPrimitives(scene);
}

function setCameraPose(viewer, pose) {
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(pose.lon, pose.lat, pose.height),
    orientation: {
      heading: pose.heading,
      pitch: pose.pitch,
      roll: pose.roll,
    },
  });
}

/**
 * Poll `context._cloudCache` for evidence a frame actually executed, not
 * just that the cache was allocated. See the header's C13-N08a note: this is
 * a stand-in for the harness's `executeCalls > 0` instrumentation, which is
 * unreachable from this file. `frameCounter` increments once per executed
 * cloud frame regardless of quality tier
 * (`WebGPUProceduralCloudRenderer.ts:3742`), so requiring it to change is
 * evidence of real per-frame work, not merely of a pipeline object existing.
 */
async function waitForCloudReady(viewer) {
  const context = viewer.scene.context;
  const isWebGPU = context?.isWebGPU === true;
  if (!isWebGPU) {
    // Documented no-op on WebGL (`CloudCollection.js:87`, `:590-605`):
    // VOLUMETRIC stores the mode but renders nothing extra, so there is
    // nothing to wait for on this viewer.
    return;
  }

  // Best-effort nudge only — NOT required for the poll below to eventually
  // succeed, since the managed-collection fallback is re-evaluated every
  // frame regardless of when the feature renderer module finishes resolving.
  // This just removes async chunk-load latency from the readiness budget.
  if (typeof context.getFeatureRendererAsync === "function") {
    context
      .getFeatureRendererAsync(PROCEDURAL_CLOUDS_FEATURE_RENDERER_KEY)
      ?.catch(() => {});
  }

  const cacheReady = await waitUntil(() => {
    const cache = context._cloudCache;
    return (
      cache !== undefined &&
      cache !== null &&
      cache.initialized === true &&
      cache.pipeline !== null &&
      cache.pipeline !== undefined
    );
  }, CLOUD_CACHE_READY_BUDGET_MS);
  requireReady(
    cacheReady,
    "WebGPU cloud cache initialization",
    CLOUD_CACHE_READY_BUDGET_MS,
  );

  const startCounter = context._cloudCache.frameCounter;
  const advanced = await waitUntil(
    () => context._cloudCache?.frameCounter !== startCounter,
    CLOUD_FRAME_ADVANCE_BUDGET_MS,
  );
  requireReady(
    advanced,
    "WebGPU cloud frameCounter advance past cache initialization",
    CLOUD_FRAME_ADVANCE_BUDGET_MS,
  );

  await settle(SETTLE_AFTER_READY_MS);
}

// ===========================================================================
// Scene table
// ===========================================================================

const SCENE_CONFIGS = {
  "cloud-orbital-disc": {
    pinnedTimeIso: "2026-06-21T12:00:00Z",
    camera: {
      lon: 0,
      lat: 0,
      height: 1.2e7,
      heading: 0,
      pitch: -Cesium.Math.PI_OVER_TWO,
      roll: 0,
    },
    volumetric: {
      cloudType: Cesium.CloudType.CUMULUS,
      cloudCoverage: 0.85,
      cloudDensity: 0.35,
    },
  },
  "cloud-ground-overcast": {
    pinnedTimeIso: "2026-06-21T21:40:00Z",
    camera: {
      lon: -100,
      lat: 40,
      height: 50,
      heading: 0,
      pitch: Cesium.Math.toRadians(25),
      roll: 0,
    },
    volumetric: {
      cloudType: Cesium.CloudType.STRATUS,
      cloudCoverage: 0.97,
      cloudDensity: 0.6,
      cloudLayerBottom: 300.0,
      cloudLayerTop: 1200.0,
    },
  },
};

// ===========================================================================
// Dispatch
// ===========================================================================

const SCENE_NAME = params.sceneName;
const CONFIG = SCENE_CONFIGS[SCENE_NAME];
if (!CONFIG) {
  throw new Error(`cloud-scene-setup: unknown sceneName "${SCENE_NAME}"`);
}
const PINNED_TIME = Cesium.JulianDate.fromIso8601(CONFIG.pinnedTimeIso);

for (const viewer of viewers) {
  isolateViewer(viewer, PINNED_TIME);
  resetVolumetric(viewer.scene.globe.defaultCloudCollection);
  applyVolumetricOverrides(
    viewer.scene.globe.defaultCloudCollection,
    CONFIG.volumetric,
  );
  setCameraPose(viewer, CONFIG.camera);
}

return Promise.all(viewers.map((viewer) => waitForCloudReady(viewer)));
