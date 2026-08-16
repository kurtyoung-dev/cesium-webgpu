// Determinism kit for visual-regression probes (Q7-PROBE-DETERMINISM).
// @purpose Probe determinism kit: pinClock, settleTiles, dampSky, nRunMedian — neutralises the four measured sources of run-to-run drift in visual probes.
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
// The kit is split into a browser-side setup string (installed once inside a
// page.evaluate) and node-side statistics helpers.

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
};
`;

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
