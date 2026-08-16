#!/usr/bin/env node
// probe-skybox-star-modulation.mjs — C11-176 SKYBOX STAR-MAP FADE (WebGPU vs WebGL)
// @purpose C11-176 star-modulation parity + opt-in: backends modulate identically; in-column 30 km lane proves the flag moves pixels; exit 3 if unseen.
// @status ACTIVE
//
// ORIGINAL ROOT CAUSE (2026-07-19 celestial research) — RECORDED, THEN
// CORRECTED. The 2026-07-19 framing was: `AtmosphericConditions.js` ships
// `enableStarBrightnessModulation: true` while the WebGPU renderer documents the
// flag as "Default OFF for WebGL parity"; the WGSL then multiplies star colour by
//     factor = 1 - smoothstep(0, 1, clamp((skyBrightness - inflection) * steepness, 0, 1))
// while "WebGL's SkyBoxFS.glsl is 9 lines and has NO such term" — a WebGPU-only
// dim, i.e. a parity break.
//
// ⚠ THREE OF THAT BLOCK'S CITATIONS WENT STALE AND ONE OF ITS PREMISES WAS
// REVERSED. Refreshed against HEAD 2026-08-07 (all four verified in the bytes):
//
//   1. The default lives at `AtmosphericConditions.js:616`
//      (`enableStarBrightnessModulation: true`), not `:368`. It has moved twice;
//      do not re-cite a line number without re-checking it.
//   2. The `=== true` fail-safe against an ABSENT property is no longer in the
//      WebGPU renderer: it is `CubeMapPanorama.js:511-514`, which ANDs
//      `panorama._isStarMap === true`, `sky.enableStarBrightnessModulation ===
//      true` and `frameState.skyAtmosphereVisible === true`. That third
//      conjunct is a SECOND, independent reason the term can be inert.
//   3. The curve constants are `STAR_MODULATION_INFLECTION = 0.0` and
//      `STAR_MODULATION_STEEPNESS = 23.0` (`StarFieldMath.ts:439,442`), not
//      0.5 / 1.0. At skyBrightness = 1.0 the factor is therefore exactly 0 —
//      the ENTIRE star contribution is removed, not "a 50% dim". This probe no
//      longer restates those numbers: it reads the packed curve back off the
//      panorama's own `_starModulation` uniform.
//   4. PREMISE REVERSED — WebGL now carries the same term. `SkyBoxFS.glsl` has
//      the `u_starModulation` / `u_skyBrightness` block since C12-29 S6 / ruling
//      E3, mirroring the WGSL including the order of operations. "Default ON is
//      a parity break" is therefore no longer the claim; the parity claim is
//      that the two backends modulate IDENTICALLY, and the additive capability
//      claim is that the flag still moves pixels.
//
// WHAT THIS PROBE CAN AND CANNOT SEE. The camera sits at `dist = 5.0e7` m,
// ~43,600 km up. `SkyBrightness.js`'s `computeAtmosphericColumnFactor` fades to
// 0 between 60 km and `ATMOSPHERIC_COLUMN_FADE_END = 111 km`, so `skyBrightness`
// is identically 0 there and the modulation factor is exactly 1.0 REGARDLESS of
// the flag — the OFF and ON legs render the same pixels by construction. That
// is the design (`AtmosphericConditions.js`: the orbital camera is the one that
// must NOT dim), not a bug, and it means:
//
//   * the PARITY arms (WebGPU vs WebGL mean/contrast/density) are fully
//     observable here and still certify;
//   * the OPT-IN arm is NOT observable here. It is gated behind
//     `reachedFailingState` (`skyBrightness > 0.5` — the driving variable, and
//     the predicate `lib/celestial-g1-gate.mjs` adopted), and a run that cannot
//     reach it exits 3 STRUCTURAL rather than manufacturing a FAIL.
//
// 2026-08-07 — THE CAMERA MOVE LANDED, so the second bullet no longer describes
// the whole probe. An IN-COLUMN lane at `IN_COLUMN_HEIGHT_M` = 30 km with
// `skyAtmosphere.show = true` now runs the SAME explicit-OFF vs explicit-ON A/B
// against the SAME 0.85 bar, on a pair where `skyBrightness` saturates and the
// modulation can act; the orbital legs are untouched and keep certifying parity.
// The gate scores whichever arm demonstrates reachability, preferring
// in-column, and still exits 3 when NEITHER can see the subject. Nothing was
// lowered, widened or re-aimed: the 0.85 ratio, the three 0.1 parity bands and
// the `skyBrightness > 0.5` predicate are byte-identical.
//
// ⚠ NOT YET RUN. The three new legs are source-level; their first Edge
// execution is owed, and until it happens the in-column numbers are predictions,
// not baselines. The prediction is explicit so it can be refuted: with the
// column factor at 1.0 and `STAR_MODULATION_STEEPNESS = 23.0`, the ON leg
// should read far below 0.85 of the OFF leg, and `inColumn.reached` must be
// true on BOTH backends — if `skyAtmosphereVisible` comes back false the third
// `CubeMapPanorama.js:511-514` conjunct is the blocker, not the height.
//
// Until this repair the opt-in arm was `gpuOn.meanLum / gpuDefault.meanLum <
// 0.85`, which could never be satisfied for TWO independent reasons — the
// default is now ON, so that comparison is A/A, and skyBrightness is 0, so no
// comparison can dim — and the probe emitted `FAIL ... optIn:false` at exit 1
// over a scene the engine deliberately exempts. The arm now compares the
// EXPLICITLY-ON leg against the EXPLICITLY-OFF leg, so it does not depend on a
// default that has already flipped once.
//
// `probe-celestial-gates.mjs`'s `in-column-star-modulation` lane (camera 30 km,
// sky atmosphere ON) was the ONLY instrument in the fleet satisfying both
// `CubeMapPanorama.js:511-514` conjuncts; the in-column lane added here is the
// second, and it is deliberately the same geometry so the two agree or
// disagree about the same thing. The two are not redundant: celestial-gates
// certifies the modulation's own ENERGY within each backend, this probe
// certifies the OFF/ON capability and cross-backend parity.
//
// It measures CONTRAST, not just mean luminance. A washed-out star field can
// share the same mean as a good one while having far lower variance, so a
// mean-only diff would miss this bug entirely.
//
// It also A/B toggles the flag at RUNTIME on WebGPU, which proves causation
// without needing a source change.
//
// Exit codes: 0 PASS | 1 FAIL | 2 ERROR (a lane did not RUN, or INCOMPLETE) |
// 3 STRUCTURAL (a lane RAN but could not see its subject).
//
// Usage: node Tools/visual-regression/probe-skybox-star-modulation.mjs

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const BASE = "http://localhost:8080";
const OUT_DIR = "Tools/visual-regression/output";

// 30 km — inside `ATMOSPHERIC_COLUMN_FADE_END = 111000` with margin at both
// ends: high enough that the fade has not begun (it starts at 60 km) and low
// enough that `computeAtmosphericColumnFactor` is 1.0. Same value as
// `probe-celestial-gates.mjs`'s `IN_COLUMN_HEIGHT_M`, deliberately, so the two
// instruments certify the same geometry.
const IN_COLUMN_HEIGHT_M = 30000;

const HARD_LIMIT_MS = 260000;
const watchdog = setTimeout(() => {
  console.error("[probe-skybox-star-mod] WATCHDOG FIRED (260s) — forcing exit");
  process.exit(2);
}, HARD_LIMIT_MS);
if (watchdog.unref) watchdog.unref();

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

// Runs in-page. Positions the camera for maximum star modulation, renders,
// and returns both the driving scalar and star-field image statistics.
const MEASURE = async ({ toggleFlag, side, heightM }) => {
  const C = await import("/Build/CesiumUnminified/index.js");
  const viewer = window.viewer;
  const scene = viewer.scene;

  // Fixed clock so the ephemeris (and therefore the sun direction) is
  // deterministic across backends and runs.
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = C.JulianDate.fromIso8601("2026-05-19T18:00:00Z");
  // CRITICAL render-time discipline (root-caused 2026-07-23): a bare
  // scene.render() renders at WALL-CLOCK NOW, while the widget's default
  // render loop renders at the pinned clock — two suns ~90 deg apart
  // interleaving frame-by-frame. Pre-Batch-734 the default loop idled out
  // under requestRenderMode so the bare renders were consistently NOW-timed;
  // 734's cloud frame-demand made the app loop render for real and exposed
  // this. Kill the loop and pass the pinned time to EVERY render.
  viewer.useDefaultRenderLoop = false;
  const T = () => viewer.clock.currentTime;
  scene.backgroundColor = C.Color.BLACK;
  if (scene.globe) scene.globe.show = false; // pure sky, no Earth
  scene.requestRenderMode = false;
  // SECOND CONJUNCT of `CubeMapPanorama.js:511-514`. The modulation term needs
  // `frameState.skyAtmosphereVisible === true` as well as a non-zero
  // `skyBrightness`, and `Scene.js` derives that flag from `skyAtmosphere.show`.
  // The in-column lane is pointless without it; the orbital lanes are unaffected
  // either way because their column factor is 0 regardless. Turning it on for
  // both keeps the two lanes differing in exactly ONE variable — the radius —
  // which is what makes the pair readable as an A/B of reachability.
  //
  // `globe.show = false` does NOT block this: `Scene.js:3813-3816` makes
  // `!globe.show` satisfy the readiness test (refuted as a suspected blocker
  // during the 2026-08-06 sweep of `probe-moon-atmosphere-appearance`).
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;

  // Prime until uniformState.sunDirectionWC is STABLE. The ICRF/earth-
  // orientation data loads ASYNC after the first demanding render; until it
  // settles, the sun's world direction migrates frame-to-frame (fallback
  // rotation -> partially-loaded -> final). Reading it after one render and
  // aiming the camera at that transient produced skyBrightness=0 at measure
  // time (caught 2026-07-23 by reachedFailingState=false after Batch 734's
  // cloud frame-demand changed early-frame timing). Bounded: <=180 frames,
  // stable when 10 consecutive deltas < 1e-9.
  let sunDir;
  {
    let prev = null;
    let stableRun = 0;
    for (let i = 0; i < 180 && stableRun < 10; i++) {
      scene.render(T());
      const cur = C.Cartesian3.clone(scene.context.uniformState.sunDirectionWC);
      if (prev && C.Cartesian3.distance(cur, prev) < 1e-9) stableRun++;
      else stableRun = 0;
      prev = cur;
      await new Promise((r) => requestAnimationFrame(r));
    }
    sunDir = prev;
  }

  // SUNLIT: camera ALONG the sun direction => normalize(positionWC) == sunDir
  //   => sunAlt = dot(sunDir, up) = 1.0 => skyBrightness = 1.0 (max dim).
  // NIGHT:  camera OPPOSITE the sun => sunAlt = -1.0 => skyBrightness = 0
  //   => the star-modulation factor is exactly 1.0 (no dim) by construction,
  //   so ANY residual WebGPU-vs-WebGL gap on this lane is a SECOND cause.
  //
  // THE RADIUS IS THE WHOLE OF THE IN-COLUMN REPAIR. `computeCelestialElevation
  // Sine` takes local up as `normalize(cameraPositionWC)`, so putting the eye on
  // the sun ray makes sin(altitude) exactly 1 at ANY radius — the two lanes
  // therefore share an identical solar geometry and differ only in height.
  // At `dist` (~43,600 km) `computeAtmosphericColumnFactor` zeroes
  // `skyBrightness`; at `heightM` = 30 km the factor is 1.0 and `skyBrightness`
  // saturates. Same construction as `probe-celestial-gates.mjs`'s
  // `in-column-star-modulation` lane, which is the shelf pattern this copies.
  const dist = 5.0e7;
  const axis =
    side === "night" ? C.Cartesian3.negate(sunDir, new C.Cartesian3()) : sunDir;
  let radius = dist;
  if (Number.isFinite(heightM)) {
    const ellipsoid = scene.ellipsoid ?? C.Ellipsoid.WGS84;
    const ray = C.Cartesian3.multiplyByScalar(axis, 1.0e7, new C.Cartesian3());
    const surface = ellipsoid.scaleToGeodeticSurface(ray, new C.Cartesian3());
    radius = C.Cartesian3.magnitude(surface) + heightM;
  }
  const position = C.Cartesian3.multiplyByScalar(
    axis,
    radius,
    new C.Cartesian3(),
  );

  // Aim perpendicular to the sun so neither the sun disc nor Earth is in frame.
  const seed =
    Math.abs(axis.z) < 0.9
      ? new C.Cartesian3(0, 0, 1)
      : new C.Cartesian3(1, 0, 0);
  const perp = C.Cartesian3.normalize(
    C.Cartesian3.cross(axis, seed, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const up = C.Cartesian3.normalize(
    C.Cartesian3.cross(perp, axis, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  scene.camera.setView({
    destination: position,
    orientation: { direction: perp, up },
  });

  const readFlag = () => {
    const ac = scene.globe && scene.globe.atmosphericConditions;
    const sky = ac && ac.skyAtmosphere;
    return sky ? sky.enableStarBrightnessModulation : undefined;
  };
  // The SHIPPED curve, read back off the panorama's own packed uniform
  // (inflection, steepness, enableFlag, cloudCover) rather than restated here.
  // The literals this probe used to carry (0.5 / 1.0) were two re-derivations
  // out of date, and a probe that predicts a dim from a stale copy of the curve
  // is predicting a product that does not exist.
  const readStarModulation = () => {
    const p = scene.skyBox && scene.skyBox._panorama;
    const m = p && p._starModulation;
    return m
      ? { inflection: m.x, steepness: m.y, enable: m.z, cloudCover: m.w }
      : null;
  };
  if (toggleFlag !== undefined) {
    const ac = scene.globe && scene.globe.atmosphericConditions;
    if (ac && ac.skyAtmosphere)
      ac.skyAtmosphere.enableStarBrightnessModulation = toggleFlag;
  }

  for (let i = 0; i < 12; i++) {
    scene.render(T());
    await new Promise((r) => requestAnimationFrame(r));
  }

  // ---- image statistics over the star field ----
  // WebGPU canvas capture rule: the drawing buffer is cleared once the
  // compositor consumes a presented frame, so drawImage must run in the SAME
  // task as a render (no await in between). The default loop used to
  // re-present continuously and masked this.
  scene.render(T());
  const canvas = scene.canvas;
  const w = canvas.width,
    h = canvas.height;
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext("2d");
  ctx.drawImage(canvas, 0, 0);
  const data = ctx.getImageData(0, 0, w, h).data;

  const lums = new Float64Array(w * h);
  let sum = 0,
    starPx = 0,
    satSum = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lums[p] = l;
    sum += l;
    if (l > 8) starPx++;
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b);
    if (mx > 8) satSum += (mx - mn) / mx; // colour saturation of lit pixels
  }
  const n = w * h;
  const mean = sum / n;
  let varSum = 0;
  for (let p = 0; p < n; p++) {
    const d = lums[p] - mean;
    varSum += d * d;
  }
  const stddev = Math.sqrt(varSum / n);

  // Brightest-percentile energy: the part a fade crushes hardest.
  const sorted = Array.from(lums).sort((a, b) => b - a);
  const topN = Math.max(1, Math.floor(n * 0.001)); // top 0.1%
  let topSum = 0;
  for (let i = 0; i < topN; i++) topSum += sorted[i];
  const topMean = topSum / topN;
  const median = sorted[Math.floor(n / 2)];

  return {
    skyBrightness: scene.frameState ? scene.frameState.skyBrightness : null,
    skyAtmosphereVisible: scene.frameState
      ? (scene.frameState.skyAtmosphereVisible ?? null)
      : null,
    flagValue: readFlag(),
    starModulationUniform: readStarModulation(),
    // Read back from the camera, not from the requested `heightM`: a setView
    // that silently failed would otherwise leave the lane label claiming a
    // geometry the frame does not have.
    cameraHeightM: scene.camera?.positionCartographic?.height ?? null,
    rendererType: scene.context.rendererType,
    width: w,
    height: h,
    meanLum: mean,
    stddev, // CONTRAST — the metric a mean-only diff misses
    starPct: (100 * starPx) / n, // density of distinguishable points
    topMean, // brightest 0.1% energy
    median,
    contrastRatio: median > 0.01 ? topMean / median : topMean,
    meanSaturation: starPx > 0 ? satSum / starPx : 0,
  };
};

async function runBackend(
  browser,
  renderer,
  toggleFlag,
  side = "sunlit",
  heightM = null,
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();
  const errs = [];
  page.on("console", (m) => {
    if (m.type() === "error") errs.push(m.text().slice(0, 200));
  });
  try {
    await page.goto(
      `${BASE}/Apps/CesiumViewer/index.html?renderer=${renderer}`,
      {
        waitUntil: "domcontentloaded",
        timeout: 90000,
      },
    );
    await page.waitForFunction(
      () =>
        !!(window.viewer && window.viewer.scene && window.viewer.scene.context),
      null,
      { timeout: 90000 },
    );
    await page.waitForTimeout(5000);
    const stats = await page.evaluate(MEASURE, { toggleFlag, side, heightM });
    await page.screenshot({
      path: path.join(
        OUT_DIR,
        `skybox-stars-${side}-${renderer}${toggleFlag === undefined ? "" : `-mod${toggleFlag ? "ON" : "OFF"}`}${Number.isFinite(heightM) ? `-h${Math.round(heightM)}` : ""}.png`,
      ),
    });
    return {
      ok: true,
      renderer,
      toggleFlag,
      side,
      heightM,
      stats,
      consoleErrors: errs.slice(0, 4),
    };
  } catch (e) {
    return {
      ok: false,
      renderer,
      toggleFlag,
      side,
      heightM,
      error: String((e && e.message) || e).slice(0, 300),
      consoleErrors: errs.slice(0, 4),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let gl, gpu, gpuOff, gpuOn, glNight, gpuNight, colOff, colOn, colGl;
  try {
    gl = await runBackend(browser, "webgl", undefined);
    gpu = await runBackend(browser, "webgpu", undefined); // as shipped
    gpuOff = await runBackend(browser, "webgpu", false); // flag forced OFF
    gpuOn = await runBackend(browser, "webgpu", true); // opt-in still works?
    glNight = await runBackend(browser, "webgl", undefined, "night");
    gpuNight = await runBackend(browser, "webgpu", undefined, "night");
    // IN-COLUMN LANE (30 km). Identical solar geometry to the orbital legs —
    // only the radius differs — so the OFF/ON pair below is the SAME A/B at the
    // SAME 0.85 bar, run where the modulation can actually act.
    colOff = await runBackend(
      browser,
      "webgpu",
      false,
      "sunlit",
      IN_COLUMN_HEIGHT_M,
    );
    colOn = await runBackend(
      browser,
      "webgpu",
      true,
      "sunlit",
      IN_COLUMN_HEIGHT_M,
    );
    // The WebGL reference at the same height: reachability must be shown on
    // BOTH backends before an A/B across them means anything, and since C12-29
    // S6 gave `SkyBoxFS.glsl` the same term, this leg is also what makes the
    // in-column claim a PARITY claim rather than a WebGPU-only one.
    colGl = await runBackend(
      browser,
      "webgl",
      undefined,
      "sunlit",
      IN_COLUMN_HEIGHT_M,
    );
  } finally {
    await browser.close().catch(() => {});
  }

  const S = (x) => (x && x.ok ? x.stats : null);
  const a = S(gl),
    b = S(gpu),
    c = S(gpuOff),
    d = S(gpuOn),
    e = S(glNight),
    f = S(gpuNight),
    g = S(colOff),
    h = S(colOn),
    i = S(colGl);

  const ratio = (x, y) =>
    x != null && y != null && y !== 0 ? r3(x / y) : null;

  // REACHABILITY, ON THE DRIVING VARIABLE. `frameState.skyBrightness` is what
  // `CubeMapPanorama.js` feeds the smoothstep; solar elevation merely correlates
  // with it below 60 km and is fully decoupled from it above 111 km, which is
  // where this camera sits. Both backends must reach it: a one-sided reading
  // would compare a modulated frame against an unmodulated one.
  const reachedFailingState =
    a && b && a.skyBrightness != null && b.skyBrightness != null
      ? a.skyBrightness > 0.5 && b.skyBrightness > 0.5
      : null;

  // IN-COLUMN REACHABILITY — the same predicate on the same driving variable,
  // asserted on the legs that are actually scored (the OFF leg is the baseline
  // of the A/B, the WebGL leg is the parity reference). This is what the camera
  // move exists to satisfy; `reachedFailingState` above stays as the honest
  // report that the ORBITAL legs cannot, by design, reach it.
  const inColumnReached =
    g && i && g.skyBrightness != null && i.skyBrightness != null
      ? g.skyBrightness > 0.5 && i.skyBrightness > 0.5
      : null;
  // The panorama's third conjunct, read off the gated frames rather than
  // assumed from `skyAtmosphere.show = true`.
  const inColumnAtmosphereVisible =
    g && i
      ? g.skyAtmosphereVisible === true && i.skyAtmosphereVisible === true
      : null;

  const verdict = {
    skyBrightness_webgpu: b ? r3(b.skyBrightness) : null,
    skyBrightness_webgl: a ? r3(a.skyBrightness) : null,
    skyAtmosphereVisible_webgpu: b ? b.skyAtmosphereVisible : null,
    reachedFailingState,
    // Derived from the SHIPPED curve read off the panorama uniform, not from a
    // local copy of (inflection, steepness).
    starModulationCurve_webgpu: b ? b.starModulationUniform : null,
    predictedDimFactor: (() => {
      const u = b && b.starModulationUniform;
      if (!b || b.skyBrightness == null || !u) {
        return null;
      }
      const t = Math.min(
        1,
        Math.max(0, (b.skyBrightness - u.inflection) * u.steepness),
      );
      return r3(1 - t * t * (3 - 2 * t));
    })(),
    flagAsShipped: b ? b.flagValue : null,
    asShipped: {
      webgl: a
        ? {
            mean: r3(a.meanLum),
            stddev: r3(a.stddev),
            starPct: r3(a.starPct),
            topMean: r3(a.topMean),
          }
        : null,
      webgpu: b
        ? {
            mean: r3(b.meanLum),
            stddev: r3(b.stddev),
            starPct: r3(b.starPct),
            topMean: r3(b.topMean),
          }
        : null,
      gpuOverGl_mean: ratio(b && b.meanLum, a && a.meanLum),
      gpuOverGl_stddev: ratio(b && b.stddev, a && a.stddev),
      gpuOverGl_topMean: ratio(b && b.topMean, a && a.topMean),
    },
    flagForcedOff: {
      webgpu: c
        ? {
            mean: r3(c.meanLum),
            stddev: r3(c.stddev),
            starPct: r3(c.starPct),
            topMean: r3(c.topMean),
          }
        : null,
      gpuOverGl_mean: ratio(c && c.meanLum, a && a.meanLum),
      gpuOverGl_stddev: ratio(c && c.stddev, a && a.stddev),
      gpuOverGl_topMean: ratio(c && c.topMean, a && a.topMean),
    },
    // CAUSATION — explicitly-OFF against explicitly-ON, so neither side depends
    // on a default. It used to compare OFF against the AS-SHIPPED leg, which
    // silently became an A/A the moment the default flipped to ON. Null rather
    // than false when the scene cannot host the effect.
    causationProven:
      reachedFailingState === true &&
      c &&
      d &&
      c.topMean != null &&
      d.topMean != null &&
      d.topMean > 0
        ? c.topMean / d.topMean > 1.15
        : null,
    // The default's identity is now a REPORTED fact, not the A/B's other half.
    defaultMatchesExplicitOn:
      b && d && b.meanLum > 0
        ? Math.abs(d.meanLum / b.meanLum - 1) < 0.02
        : null,
    // GOVERNING PRINCIPLE CHECK: the default is parity, but the additive
    // capability must remain reachable. Forcing the flag true must still dim
    // RELATIVE TO FORCING IT FALSE.
    optInStillDims: {
      webgpu_modON: d
        ? {
            mean: r3(d.meanLum),
            stddev: r3(d.stddev),
            starPct: r3(d.starPct),
            topMean: r3(d.topMean),
          }
        : null,
      modON_over_modOFF_mean: ratio(d && d.meanLum, c && c.meanLum),
      modON_over_default_mean: ratio(d && d.meanLum, b && b.meanLum),
      capabilityPreserved:
        reachedFailingState === true &&
        d &&
        c &&
        d.meanLum != null &&
        c.meanLum > 0
          ? d.meanLum / c.meanLum < 0.85
          : null,
    },
    // NIGHT-SIDE LANE — maintainer reports the fade on BOTH sides. The star
    // modulation factor is exactly 1.0 here by construction, so any residual
    // gap on this lane is a SECOND, independent cause.
    nightSide: {
      skyBrightness: f ? r3(f.skyBrightness) : null,
      webgl: e
        ? {
            mean: r3(e.meanLum),
            stddev: r3(e.stddev),
            starPct: r3(e.starPct),
            topMean: r3(e.topMean),
          }
        : null,
      webgpu: f
        ? {
            mean: r3(f.meanLum),
            stddev: r3(f.stddev),
            starPct: r3(f.starPct),
            topMean: r3(f.topMean),
          }
        : null,
      gpuOverGl_mean: ratio(f && f.meanLum, e && e.meanLum),
      gpuOverGl_stddev: ratio(f && f.stddev, e && e.stddev),
      gpuOverGl_starPct: ratio(f && f.starPct, e && e.starPct),
      gpuOverGl_topMean: ratio(f && f.topMean, e && e.topMean),
      secondCausePresent:
        e && f && e.meanLum > 0
          ? Math.abs(f.meanLum / e.meanLum - 1) > 0.1
          : null,
    },
    // IN-COLUMN LANE (30 km, sky atmosphere ON) — the repair that lets this
    // probe certify C11-176 instead of correctly declining to. Nothing here is
    // a new bar: `capabilityPreserved` is the SAME `ON/OFF mean < 0.85` test the
    // orbital lane already carried, applied to a pair that can move.
    inColumn: {
      requestedHeightM: IN_COLUMN_HEIGHT_M,
      measuredHeightM_webgpuOff: g ? Math.round(g.cameraHeightM ?? -1) : null,
      measuredHeightM_webgl: i ? Math.round(i.cameraHeightM ?? -1) : null,
      skyBrightness_webgpuOff: g ? r3(g.skyBrightness) : null,
      skyBrightness_webgpuOn: h ? r3(h.skyBrightness) : null,
      skyBrightness_webgl: i ? r3(i.skyBrightness) : null,
      skyAtmosphereVisible: inColumnAtmosphereVisible,
      reached: inColumnReached,
      webgpu_modOFF: g
        ? { mean: r3(g.meanLum), stddev: r3(g.stddev), topMean: r3(g.topMean) }
        : null,
      webgpu_modON: h
        ? { mean: r3(h.meanLum), stddev: r3(h.stddev), topMean: r3(h.topMean) }
        : null,
      webgl: i
        ? { mean: r3(i.meanLum), stddev: r3(i.stddev), topMean: r3(i.topMean) }
        : null,
      modON_over_modOFF_mean: ratio(h && h.meanLum, g && g.meanLum),
      // Parity of the OFF leg against WebGL at the same height. Reported, not
      // gated: the orbital lane owns the parity claim and its bars are the ones
      // that were calibrated.
      offLeg_gpuOverGl_mean: ratio(g && g.meanLum, i && i.meanLum),
      capabilityPreserved:
        inColumnReached === true && g && h && h.meanLum != null && g.meanLum > 0
          ? h.meanLum / g.meanLum < 0.85
          : null,
    },
    // THE GATE, in three tiers.
    //
    // PARITY is observable at this camera and certifies unconditionally. The
    // OPT-IN arm is only observable where the modulation can act at all, so it
    // is scored ONLY when `reachedFailingState` holds; otherwise the run is
    // STRUCTURAL. Precedence follows `lib/celestial-g1-gate.mjs`: a measurable
    // criterion failure outranks blindness (a real defect must not be
    // downgraded), and blindness outranks a clean sheet (a lane that could not
    // see its subject must not report green).
    GATE: (() => {
      if (!a || !b || !c || !d) return "INCOMPLETE";
      const meanOk = Math.abs(b.meanLum / a.meanLum - 1) < 0.1;
      const contrastOk = Math.abs(b.stddev / a.stddev - 1) < 0.1;
      const densityOk = Math.abs(b.starPct / a.starPct - 1) < 0.1;
      if (!(meanOk && contrastOk && densityOk)) {
        return `FAIL — failing predicate(s): ${[
          meanOk ? null : "orbitalMeanParity",
          contrastOk ? null : "orbitalContrastParity",
          densityOk ? null : "orbitalDensityParity",
        ]
          .filter(Boolean)
          .join(", ")}`;
      }
      // OPT-IN ARM. Scored on whichever pair can actually see the modulation,
      // preferring the IN-COLUMN pair. Precedence is unchanged: a measurable
      // criterion failure outranks blindness, blindness outranks a clean sheet.
      // The bar is the same 0.85 in both branches — the camera move changed
      // WHERE it is measured, not WHAT is required.
      const armReached =
        inColumnReached === true
          ? "in-column"
          : reachedFailingState === true
            ? "orbital"
            : null;
      if (armReached === null) {
        return (
          "STRUCTURAL — parity holds, but skyBrightness never exceeded 0.5 on " +
          "EITHER lane: orbital " +
          `(webgl ${r3(a.skyBrightness)}, webgpu ${r3(b.skyBrightness)}) is 0 by ` +
          "design above ATMOSPHERIC_COLUMN_FADE_END, and the 30 km in-column " +
          `lane read (webgl ${i ? r3(i.skyBrightness) : "n/a"}, webgpu ` +
          `${g ? r3(g.skyBrightness) : "n/a"}) with skyAtmosphereVisible ` +
          `${inColumnAtmosphereVisible}. The star-modulation factor is exactly ` +
          "1.0 on both legs by construction, so the OFF/ON A/B cannot " +
          "discriminate. This is NOT a pass and NOT a defect."
        );
      }
      const armOff = armReached === "in-column" ? g : c;
      const armOn = armReached === "in-column" ? h : d;
      const optInOk =
        armOff && armOn && armOff.meanLum > 0
          ? armOn.meanLum / armOff.meanLum < 0.85
          : false;
      return optInOk
        ? `PASS — default at WebGL parity AND opt-in capability preserved (${armReached} arm)`
        : `FAIL — failing predicate(s): optInStillDims (${armReached} arm, ` +
            `ON/OFF mean ${ratio(armOn && armOn.meanLum, armOff && armOff.meanLum)} ` +
            "must be < 0.85)";
    })(),
  };

  const outPath = path.join(OUT_DIR, "skybox-star-modulation.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        verdict,
        gl,
        gpu,
        gpuOff,
        gpuOn,
        glNight,
        gpuNight,
        colOff,
        colOn,
        colGl,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(verdict, null, 2));
  for (const l of [
    gl,
    gpu,
    gpuOff,
    gpuOn,
    glNight,
    gpuNight,
    colOff,
    colOn,
    colGl,
  ])
    if (l && !l.ok)
      console.log(`${l.renderer}(mod=${l.toggleFlag}) FAILED: ${l.error}`);
  console.log(`\n[full report: ${outPath}]`);

  // HARD EXIT CODES (binding probe rule 5, C12-01). The prior version exited 0
  // UNCONDITIONALLY here — even on GATE FAIL — so this gate could never fail a
  // CI/orchestrator run. Fixed: exit 1 on gate FAIL, 0 only on PASS, 2 on a
  // HARNESS error (a lane that never ran, or an INCOMPLETE verdict because a
  // required capture is missing), and — since 2026-08-07 — 3 when a lane RAN
  // but could not see its subject. Conflating those last two is what let the
  // unreachable opt-in arm report as a product FAIL for months.
  const anyLaneFailed = [
    gl,
    gpu,
    gpuOff,
    gpuOn,
    glNight,
    gpuNight,
    colOff,
    colOn,
    colGl,
  ].some((l) => l && !l.ok);
  const gateStr =
    typeof verdict.GATE === "string" ? verdict.GATE : "INCOMPLETE";
  const harnessError = anyLaneFailed || gateStr.startsWith("INCOMPLETE");
  const laneBlind = gateStr.startsWith("STRUCTURAL");
  const exitCode = harnessError
    ? 2
    : laneBlind
      ? 3
      : gateStr.startsWith("PASS")
        ? 0
        : 1;
  console.log(`\nGATE: ${gateStr}\nEXIT: ${exitCode}`);
  clearTimeout(watchdog);
  process.exit(exitCode);
})().catch((e) => {
  console.error("[probe-skybox-star-mod] FATAL", e);
  process.exit(2);
});
