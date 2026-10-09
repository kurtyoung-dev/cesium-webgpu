// Determinism kit for visual-regression probes (Q7-PROBE-DETERMINISM).
// @purpose Probe determinism kit: pinClock, settleTiles, dampSky, placeCameraAfterTerrain, nRunMedian — neutralises the measured sources of run-to-run drift in visual probes and refuses a camera that did not stay where the rig put it.
// @status ACTIVE
//
// Globe / post-process probe severities drift run-to-run (the audit measured
// underground 12.28 vs 6.75, translucency 25.49 vs 23.14 on unchanged builds).
// The drift has four independent sources; this kit neutralises each:
//
//   1. UNPINNED CLOCK — the viewer clock starts at wall-clock "now", so the
//      star-field TEME rotation (WebGPUStarFieldRenderer reads frameState.time)
//      and the sun elevation differ on every run. A run captured at 08:00 and
//      one captured at 08:03 render a visibly different sky over the SAME
//      globe. pinClock() freezes shouldAnimate + currentTime to a fixed epoch.
//
//   2. FIXED-FRAME RENDER LOOPS — `for i<240 { render() }` + waitForTimeout
//      grabs a frame mid tile/imagery LOD refinement; two runs straddle the
//      refinement at different points. settleTiles() renders until
//      globe.tilesLoaded has held true for `stableFrames` consecutive frames,
//      a true steady state independent of wall-clock scheduling.
//
//   3. STAR / SKY TWINKLE — even with a pinned clock the star-field + sky
//      atmosphere are a cross-backend residual UNRELATED to what a globe-tint
//      or translucency probe measures; they inflate the metric with signal
//      that has nothing to do with the feature under test. dampSky() hides
//      skyBox / sun / moon / star field / ground atmosphere, leaving the globe.
//
//   4. RESIDUAL SINGLE-RUN NOISE — after 1-3 the metric is near-constant, but
//      tile-LOD tie-breaks can still wobble the last ~1%. nRunMedian() runs a
//      capture N times and reports the median + spread so a gate can key off
//      the median and REPORT the spread instead of tripping on one outlier.
//
//   5. A CAMERA THAT DOES NOT STAY PUT — `camera.setView` places the camera
//      once, but two things move it afterwards. A terrain provider that
//      resolves after the placement replaces the surface under it (the
//      CesiumViewer page hands the Viewer an asynchronous world terrain, and
//      `Scene.setTerrain`'s ready listener is not cancelled when a later
//      base-layer-picker selection sets another provider), and the camera
//      controller's collision step then lifts the camera above whatever
//      terrain is resident. A rig declared at 20 m above the ellipsoid was
//      recorded at 661-670 m with its model out of frame; that reading of the
//      two code paths is why, and the read-back below is what measures it.
//      placeCameraAfterTerrain() places the camera only once the terrain
//      provider has held for `stableFrames` frames, renders until the camera
//      has stopped moving, and reads back where it is;
//      cameraPlacementNow() re-reads it just before a capture, and
//      decideCameraPlacement() refuses in Node when either read-back, or the
//      `view=` the page wrote into its own URL, is off the declared height.
//
// The kit is split into a browser-side setup string (installed once inside a
// page.evaluate) and node-side statistics and decision helpers.

import { acceptedDecision, refusedDecision } from "./probe-refusal.mjs";

// Fixed epoch for pinClock(): a clear-sky solstice morning. Any constant
// works — the point is that it is CONSTANT across runs and backends.
export const DETERMINISTIC_CLOCK_ISO = "2026-06-21T08:00:00Z";

// ---------------------------------------------------------------------------
// Browser-side helpers. Eval this string inside a page.evaluate BEFORE the
// scene setup, then call window.__det.<fn>(...). `C` is the imported Cesium
// namespace (await import("/Build/CesiumUnminified/index.js")).
// ---------------------------------------------------------------------------
export const DET_BROWSER_SETUP = `
window.__det = {
  // Freeze the clock so the star field / sun do not rotate between runs.
  pinClock(C, viewer, scene, iso) {
    scene.requestRenderMode = false;
    viewer.clock.shouldAnimate = false;
    viewer.clock.currentTime = C.JulianDate.fromIso8601(iso || "${DETERMINISTIC_CLOCK_ISO}");
    if (viewer.clock.onTick) {
      // Some widgets advance currentTime on tick even with shouldAnimate off;
      // re-pin on every tick to be safe.
      const pinned = C.JulianDate.clone(viewer.clock.currentTime);
      viewer.clock.onTick.addEventListener(function () {
        viewer.clock.currentTime = C.JulianDate.clone(pinned, viewer.clock.currentTime);
      });
    }
  },

  // Hide every sky / star element so the metric measures only the globe.
  dampSky(scene) {
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.globe.showGroundAtmosphere = false;
    scene.fog.enabled = false;
    // The star field is drawn by the environment renderer; hiding skyBox +
    // sun + moon removes the celestial layer on both backends.
    scene.backgroundColor = scene.backgroundColor || undefined;
  },

  // Render until globe.tilesLoaded has been true for stableFrames CONSECUTIVE
  // frames AND a minimum frame/wall-clock floor has elapsed, or maxFrames run.
  // The floor matters on WebGPU: globe.tilesLoaded flips true as soon as the
  // tile GEOMETRY is resident, but the imagery textures still need real
  // wall-clock time to download + upload, and a tight rAF loop advances frame
  // count faster than the network. Exiting on tilesLoaded alone captured a
  // BLACK globe on WebGPU (measured: pin+damp+settle meanLum 0.03 vs the
  // 240-frame brute-force 9.73). minFrames + minMillis reproduce the old
  // probes' dwell while the tilesLoaded-stability adds the determinism.
  // Returns the frame count actually rendered.
  async settleTiles(scene, opts) {
    const o = opts || {};
    const stableFrames = o.stableFrames || 30;
    const maxFrames = o.maxFrames || 1500;
    const minFrames = o.minFrames || 180;
    const minMillis = o.minMillis || 1500;
    const t0 = performance.now();
    let stable = 0;
    let i = 0;
    for (; i < maxFrames; i++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
      stable = scene.globe.tilesLoaded ? stable + 1 : 0;
      const settled = stable >= stableFrames;
      const enoughFrames = i + 1 >= minFrames;
      const enoughTime = performance.now() - t0 >= minMillis;
      if (settled && enoughFrames && enoughTime) break;
    }
    // A few extra frames after the tiles report loaded lets any one-frame
    // upload / mip generation flush before the screenshot.
    for (let k = 0; k < 8; k++) {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    }
    return i;
  },

  // Place the camera only after the globe's terrain provider has stopped
  // changing, then render until the camera has stopped moving, and read back
  // where it is. camera = {lon, lat, height, heading, pitch, roll} in degrees
  // and metres / radians, the rig's own record. The terrain the caller wants
  // must be set BEFORE this is called: it waits for the provider to hold, it
  // does not choose one. Judge the result with decideCameraPlacement().
  async placeCameraAfterTerrain(C, viewer, camera, opts) {
    const o = opts || {};
    const scene = viewer.scene;
    const stableFrames = o.stableFrames || 30;
    const maxFrames = o.maxFrames || 1500;
    const frame = async () => {
      scene.render();
      await new Promise((r) => requestAnimationFrame(r));
    };
    let provider = scene.globe.terrainProvider;
    let held = 0;
    let terrainFrames = 0;
    while (held < stableFrames && terrainFrames < maxFrames) {
      await frame();
      terrainFrames++;
      const current = scene.globe.terrainProvider;
      held = current !== undefined && current === provider ? held + 1 : 0;
      provider = current;
    }
    const terrainSettled = held >= stableFrames;
    this._placedTerrainProvider = provider;
    viewer.camera.setView({
      destination: C.Cartesian3.fromDegrees(camera.lon, camera.lat, camera.height),
      orientation: {
        heading: camera.heading ?? 0,
        pitch: camera.pitch ?? -Math.PI / 2,
        roll: camera.roll ?? 0,
      },
    });
    const last = C.Cartesian3.clone(viewer.camera.positionWC);
    let still = 0;
    let cameraFrames = 0;
    while (still < stableFrames && cameraFrames < maxFrames) {
      await frame();
      cameraFrames++;
      const moved = C.Cartesian3.distance(viewer.camera.positionWC, last);
      still = moved <= 1e-3 ? still + 1 : 0;
      C.Cartesian3.clone(viewer.camera.positionWC, last);
    }
    return Object.assign(this.cameraPlacementNow(C, viewer), {
      terrainSettled,
      terrainFrames,
      cameraSettled: still >= stableFrames,
      cameraFrames,
    });
  },

  // Where the camera is now, and whether the terrain provider is still the
  // one placeCameraAfterTerrain() placed it over.
  cameraPlacementNow(C, viewer) {
    const carto = viewer.camera.positionCartographic;
    const provider = viewer.scene.globe.terrainProvider;
    return {
      height: carto.height,
      lon: C.Math.toDegrees(carto.longitude),
      lat: C.Math.toDegrees(carto.latitude),
      terrainProvider:
        provider && provider.constructor ? provider.constructor.name : null,
      terrainHeld:
        this._placedTerrainProvider !== undefined &&
        provider === this._placedTerrainProvider,
    };
  },
};
`;

// ---------------------------------------------------------------------------
// Node-side camera-placement decision.
// ---------------------------------------------------------------------------

// How far, in metres, a read-back camera height may sit from the declared one.
export const CAMERA_PLACEMENT_TOLERANCE_M = 1;

/**
 * The camera height the CesiumViewer page wrote into its own URL, or null.
 * The page records `view=lon,lat,height[,heading,pitch,roll]` a second after
 * the camera last changed (`Apps/CesiumViewer/CesiumViewer.js`
 * `setupCameraSave`), so it is a record of where the camera was, written by the
 * page rather than by the probe.
 *
 * @param {string} url The page URL.
 * @returns {number|null} The recorded height in metres.
 */
export function viewHeightFromUrl(url) {
  let view;
  try {
    view = new URL(url).searchParams.get("view");
  } catch {
    return null;
  }
  if (view === null) {
    return null;
  }
  const height = Number(view.split(/[ ,]+/)[2]);
  return Number.isFinite(height) ? height : null;
}

/**
 * Refuse a capture whose camera is not where its rig declared it.
 *
 * @param {object} args Arguments.
 * @param {number} args.declaredHeight The rig's camera height, metres.
 * @param {object} args.placement placeCameraAfterTerrain()'s read-back.
 * @param {object} [args.final] cameraPlacementNow() just before the capture.
 * @param {string} [args.recordedUrl] The page URL at capture time; when given,
 *   its `view=` height must be present and agree too.
 * @param {number} [args.tolerance] Metres.
 * @returns {object} An accepted or refused decision (`lib/probe-refusal.mjs`).
 */
export function decideCameraPlacement({
  declaredHeight,
  placement,
  final,
  recordedUrl,
  tolerance = CAMERA_PLACEMENT_TOLERANCE_M,
}) {
  const details = {
    declaredHeight,
    tolerance,
    placement,
    final: final ?? null,
  };
  if (placement?.terrainSettled !== true) {
    return refusedDecision("camera-terrain-unsettled", details);
  }
  if (placement.cameraSettled !== true) {
    return refusedDecision("camera-unsettled", details);
  }
  const heights = [["placement", placement.height]];
  if (final !== undefined) {
    if (final?.terrainHeld !== true) {
      return refusedDecision("camera-terrain-changed", details);
    }
    heights.push(["final", final.height]);
  }
  if (recordedUrl !== undefined) {
    const recorded = viewHeightFromUrl(recordedUrl);
    if (recorded === null) {
      return refusedDecision("camera-view-unrecorded", {
        ...details,
        recordedUrl,
      });
    }
    heights.push(["view", recorded]);
  }
  for (const [where, height] of heights) {
    if (
      !Number.isFinite(height) ||
      Math.abs(height - declaredHeight) > tolerance
    ) {
      return refusedDecision("camera-height-mismatch", {
        ...details,
        where,
        height,
        recordedUrl: recordedUrl ?? null,
      });
    }
  }
  return acceptedDecision();
}

// ---------------------------------------------------------------------------
// Node-side statistics.
// ---------------------------------------------------------------------------
export function median(nums) {
  if (!nums.length) return NaN;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Median absolute deviation — a robust spread estimate (immune to a single
// outlier the way stddev is not).
export function mad(nums) {
  if (!nums.length) return NaN;
  const med = median(nums);
  return median(nums.map((n) => Math.abs(n - med)));
}

export function spread(nums) {
  if (!nums.length) return NaN;
  return Math.max(...nums) - Math.min(...nums);
}

// Run an async capture N times and summarise. `runOnce()` must return a
// number (the severity metric). Returns { values, median, min, max, mad,
// spread }.
export async function nRunMedian(runOnce, n) {
  const values = [];
  for (let i = 0; i < n; i++) {
    values.push(await runOnce(i));
  }
  return {
    values,
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
    mad: mad(values),
    spread: spread(values),
  };
}

// Convenience: how many runs to take, from the PROBE_RUNS env (default 1 so
// existing single-run behaviour is preserved unless a probe opts in).
export function runCount(fallback = 1) {
  const n = parseInt(process.env.PROBE_RUNS || "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
