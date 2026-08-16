// ocean-tide-datum.spec.mjs — C6-FFT-OCEAN-TIDE-DATUM slice 1: pins the
// bundled EGM2008 grid, the equilibrium TideModel, the AUTO datum derivation,
// the offset composition order, and the exact-zero off-contract.
// @purpose Pins the bundled EGM2008 grid, equilibrium TideModel phase/amplitude physics, geoid-then-tide composition order and the exact-zero off-contract.
// @status ACTIVE
//
// These tests fail if:
//   - the bundled geoid asset is regenerated at a different resolution,
//     encoding or georeferencing without the header being updated with it;
//   - the grid stops reproducing Cesium World Terrain's own measured ocean-lid
//     heights (the evidence that CWT's lid IS the geoid, and therefore the
//     evidence that the 101.6 m plateau was a real defect);
//   - the Love-number diminishing factor is dropped or the solar term is lost
//     (either shows up as an amplitude band failure, ~1.44x and ~0.68x);
//   - the tide stops being phase-locked to the Moon (lunar-only maxima must
//     land ON lunar culmination) or its mean period drifts off the published
//     NOAA M2 constituent;
//   - the spring/neap envelope stops tracking Sun-Moon elongation;
//   - the composition order changes — geoid, then tide x tideExaggeration,
//     then the scene.verticalExaggeration map. The measured lid DOES move under
//     exaggeration (Batch 759 lane 3), so composing the other way re-opens the
//     plateau at scale > 1;
//   - the off-contract stops being EXACTLY zero (a term leaking into the
//     default path);
//   - the WGSL gains a datum/tide uniform. The whole design claim is that RTE
//     absorbs the offset through the existing anchorHigh/anchorLow split, so a
//     new shader input means the claim was wrong and the parity story (a WebGL2
//     FFT fallback inherits the offset for free) no longer holds.
//
// Run: node --test Tools/visual-regression/ocean-tide-datum.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DATUM_FIX_SITE,
  GEOID_REFERENCE_SITES,
  M2_PERIOD_HOURS,
  PUBLISHED_CONSTANTS,
  THRESHOLDS,
  datumFixVerdict,
  decisionFromLanes,
  exaggerationCompositionVerdict,
  findExtrema,
  meanIntervalHours,
  monotoneSegments,
  offContractVerdict,
  refineExtremumSeconds,
  tidePhaseVerdict,
} from "./lib/ocean-tide-datum-model.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);
const readEngine = (p) => fs.readFileSync(enginePath(p), "utf8");
const importEngine = async (p) =>
  await import(pathToFileURL(enginePath(p)).href);

const { default: GeoidUndulationGrid } = await importEngine(
  "Core/GeoidUndulationGrid.js",
);
const { default: TideModel } = await importEngine("Core/TideModel.js");
const { default: VerticalDatum } = await importEngine("Core/VerticalDatum.js");
const { default: Cartesian3 } = await importEngine("Core/Cartesian3.js");
const { default: Cartographic } = await importEngine("Core/Cartographic.js");
const { default: Ellipsoid } = await importEngine("Core/Ellipsoid.js");
const { default: JulianDate } = await importEngine("Core/JulianDate.js");
const { default: EllipsoidTerrainProvider } = await importEngine(
  "Core/EllipsoidTerrainProvider.js",
);
const { computeSeaLevelOffset } = await importEngine(
  "Scene/OceanSurfacePrimitive.js",
);

// ── the bundled asset, loaded off disk (no network, no Resource) ──────────
const ASSET = enginePath(GeoidUndulationGrid.ASSET_PATH);
const assetBytes = fs.readFileSync(ASSET);
const assetBuffer = assetBytes.buffer.slice(
  assetBytes.byteOffset,
  assetBytes.byteOffset + assetBytes.byteLength,
);
const grid = new GeoidUndulationGrid(assetBuffer);
GeoidUndulationGrid.setEgm2008ForTesting(grid);

const ellipsoid = Ellipsoid.WGS84;
const surfaceAt = (lonDeg, latDeg) =>
  ellipsoid.cartographicToCartesian(
    Cartographic.fromDegrees(lonDeg, latDeg, 0),
  );
const EPOCH = JulianDate.fromIso8601("2026-07-03T00:00:00Z");
const at = (seconds) => JulianDate.addSeconds(EPOCH, seconds, new JulianDate());

// ─────────────────────────── the bundled grid ────────────────────────────

test("geoid asset: header, size and georeferencing are the baked contract", () => {
  const view = new DataView(assetBuffer);
  assert.equal(
    view.getUint32(0, true),
    GeoidUndulationGrid.MAGIC,
    'magic "EGM1"',
  );
  assert.equal(view.getUint16(4, true), 1, "version");
  assert.equal(view.getUint16(6, true), 100, "int16 centimetres");
  assert.equal(grid.longitudeCount, 721, "0.5 deg lon nodes, both seams");
  assert.equal(grid.latitudeCount, 361, "0.5 deg lat nodes, pole to pole");
  assert.equal(grid.stepDegrees, 0.5);
  assert.equal(view.getInt32(16, true), -180000000, "west edge");
  assert.equal(view.getInt32(20, true), 90000000, "north edge");
  assert.equal(
    assetBytes.byteLength,
    32 + 721 * 361 * 2,
    "header + int16 payload, no padding",
  );
});

test("geoid asset: values stay inside the EGM2008 physical envelope", () => {
  // EGM2008's global extrema are about -106.9 m (Indian Ocean) and +85.8 m
  // (New Guinea). A decimated grid can only shrink that range, never grow it.
  const values = new Int16Array(assetBuffer, 32, 721 * 361);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] / 100;
    if (v < min) {
      min = v;
    }
    if (v > max) {
      max = v;
    }
  }
  assert.ok(min >= -110 && min <= -100, `global minimum ${min} m`);
  assert.ok(max >= 80 && max <= 110, `global maximum ${max} m`);
});

test("geoid grid reproduces the baked reference values", () => {
  for (const site of GEOID_REFERENCE_SITES) {
    const got = grid.sampleDegrees(site.lonDeg, site.latDeg);
    assert.ok(
      Math.abs(got - site.gridExpectedM) <= 0.02,
      `${site.id}: grid ${got.toFixed(3)} vs baked ${site.gridExpectedM}`,
    );
  }
});

test("geoid grid reproduces the MEASURED Cesium World Terrain ocean lid", () => {
  // This is the load-bearing evidence: an independently baked EGM2008 grid
  // agrees with the terrain provider's own sea surface, measured by
  // probe-ocean-datum.mjs (Batch 759), at every site across 171 m of
  // undulation. It is what turns "CWT's lid correlates with the geoid" into
  // "CWT's lid IS the geoid", and therefore what makes the ellipsoid-0 anchor
  // a DEFECT rather than a different-but-defensible convention.
  let worst = 0;
  let worstId = null;
  let sum2 = 0;
  for (const site of GEOID_REFERENCE_SITES) {
    const d = grid.sampleDegrees(site.lonDeg, site.latDeg) - site.cwtMeasuredM;
    sum2 += d * d;
    if (Math.abs(d) > worst) {
      worst = Math.abs(d);
      worstId = site.id;
    }
  }
  const rms = Math.sqrt(sum2 / GEOID_REFERENCE_SITES.length);
  assert.ok(
    worst <= 1.0,
    `worst site ${worstId} differs by ${worst.toFixed(3)} m`,
  );
  assert.ok(rms <= 0.5, `RMS vs the measured CWT lid is ${rms.toFixed(3)} m`);
});

test("geoid grid: seams wrap, poles clamp, garbage degrades to the west seam", () => {
  const seamW = grid.sampleDegrees(-180, 0);
  const seamE = grid.sampleDegrees(180, 0);
  assert.equal(seamW, seamE, "the duplicated seam column must agree exactly");
  assert.ok(
    Math.abs(grid.sampleDegrees(540, 0) - seamW) < 1e-9,
    "longitude wraps by whole turns",
  );
  assert.ok(
    Math.abs(grid.sampleDegrees(-181, 12.5) - grid.sampleDegrees(179, 12.5)) <
      1e-9,
    "-181 deg is 179 deg",
  );
  assert.equal(
    grid.sampleDegrees(0, 120),
    grid.sampleDegrees(0, 90),
    "latitude clamps at the pole",
  );
  assert.equal(grid.sampleDegrees(0, -120), grid.sampleDegrees(0, -90));
  assert.ok(Number.isFinite(grid.sampleDegrees(NaN, NaN)), "NaN must not leak");
});

test("geoid grid: a malformed header throws instead of returning NaN", () => {
  const header = (patch) => {
    const buf = new ArrayBuffer(32 + 8);
    const v = new DataView(buf);
    v.setUint32(0, GeoidUndulationGrid.MAGIC, true);
    v.setUint16(4, 1, true);
    v.setUint16(6, patch.units ?? 100, true);
    v.setUint32(8, patch.nx ?? 2, true);
    v.setUint32(12, patch.ny ?? 2, true);
    v.setInt32(16, -180000000, true);
    v.setInt32(20, 90000000, true);
    v.setUint32(24, patch.step ?? 500000, true);
    return buf;
  };
  // A well-formed 2x2 must construct — otherwise the negatives below prove
  // nothing about the guard.
  assert.ok(new GeoidUndulationGrid(header({})));
  // Degenerate dimensions previously reached sampleDegrees, clamped x0/y0 to
  // -1, read past the typed array as `undefined` and returned NaN — which the
  // caller would read as "no undulation" and silently re-open the ~100 m defect.
  for (const bad of [
    { nx: 0 },
    { nx: 1 },
    { ny: 0 },
    { ny: 1 },
    { step: 0 },
    { units: 0 },
  ]) {
    assert.throws(
      () => new GeoidUndulationGrid(header(bad)),
      /malformed/,
      `header ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.throws(() => new GeoidUndulationGrid(new ArrayBuffer(8)), /truncated/);
  const wrongMagic = header({});
  new DataView(wrongMagic).setUint32(0, 0xdeadbeef, true);
  assert.throws(() => new GeoidUndulationGrid(wrongMagic), /EGM1/);
});

test("geoid loader: a failed load latches, but an explicit retry clears it", () => {
  // The latch stops the per-frame path re-fetching every frame; without the
  // retry escape one transient network error would re-introduce the ~100 m
  // defect for the rest of the page's life after a single console.error.
  GeoidUndulationGrid.setEgm2008ForTesting(undefined);
  GeoidUndulationGrid.setEgm2008LoadFailedForTesting(true);
  assert.equal(GeoidUndulationGrid.hasEgm2008LoadFailed(), true);
  // Without allowRetry the latch holds and nothing is attempted.
  GeoidUndulationGrid.loadEgm2008Async();
  assert.equal(
    GeoidUndulationGrid.hasEgm2008LoadFailed(),
    true,
    "the per-frame path must not clear the latch",
  );
  // With allowRetry (what GlobeWaterOcean passes on enable / datum change) the
  // latch clears so a fresh attempt can run.
  GeoidUndulationGrid.loadEgm2008Async(true);
  assert.equal(GeoidUndulationGrid.hasEgm2008LoadFailed(), false);
  // Restore the real grid for the remaining tests.
  GeoidUndulationGrid.setEgm2008ForTesting(grid);

  const ocean = readEngine("Scene/GlobeWaterOcean.js");
  assert.ok(
    /loadEgm2008Async\(true\)/.test(ocean),
    "GlobeWaterOcean must request the bounded retry on enable / datum change",
  );
  const primitive = readEngine("Scene/OceanSurfacePrimitive.js");
  assert.ok(
    /GeoidUndulationGrid\.loadEgm2008Async\(\);/.test(primitive),
    "the per-frame path must NOT pass allowRetry",
  );
});

test("geoid grid: radian and degree samplers agree", () => {
  for (const site of GEOID_REFERENCE_SITES) {
    const a = grid.sampleDegrees(site.lonDeg, site.latDeg);
    const b = grid.sample(
      (site.lonDeg * Math.PI) / 180,
      (site.latDeg * Math.PI) / 180,
    );
    assert.ok(Math.abs(a - b) < 1e-9, `${site.id}`);
  }
});

// ──────────────────────────── the tide model ─────────────────────────────

test("TideModel constants are the published values", () => {
  assert.equal(TideModel.LOVE_H2, PUBLISHED_CONSTANTS.LOVE_H2);
  assert.equal(TideModel.LOVE_K2, PUBLISHED_CONSTANTS.LOVE_K2);
  assert.equal(TideModel.GM_MOON, 4.902800076e12, "JPL DE430 lunar GM");
  assert.equal(TideModel.GM_SUN, 1.32712440041e20, "JPL DE430 solar GM");
  assert.equal(TideModel.STANDARD_GRAVITY, 9.80665, "CGPM standard gravity");
  assert.equal(
    TideModel.M2_SPEED_DEGREES_PER_HOUR,
    PUBLISHED_CONSTANTS.M2_SPEED_DEG_PER_HOUR,
    "NOAA CO-OPS M2 speed",
  );
  assert.equal(TideModel.ASTRONOMICAL_UNIT, 149597870700, "IAU 2012 au, exact");
  assert.equal(TideModel.MEAN_LUNAR_DISTANCE, 384400000);
  // 1 + k2 - h2: the tide-gauge (water-relative-to-crust) form. Dropping it
  // over-reads every tide by 1/0.6944 = 1.44x.
  assert.ok(
    Math.abs(TideModel.DIMINISHING_FACTOR - 0.6944) < 1e-9,
    `gamma2 = ${TideModel.DIMINISHING_FACTOR}`,
  );
  assert.ok(
    Math.abs(TideModel.M2_PERIOD_SECONDS / 3600 - M2_PERIOD_HOURS) < 1e-9,
  );
  assert.ok(
    Math.abs(TideModel.M2_PERIOD_SECONDS / 3600 - 12.4206012) < 1e-5,
    "M2 period is 12 h 25.2 min",
  );
});

test("TideModel: the sub-body coefficients match the textbook equilibrium tide", () => {
  // GM r^2 / (g d^3) at the sub-body point, before the Love factor:
  //   Moon 0.357 m, Sun 0.164 m, ratio 0.46 — the classic numbers.
  const r = 6371000.0;
  const dMoon = 384400000.0;
  const dSun = 149597870700.0;
  const g = TideModel.STANDARD_GRAVITY;
  const moon = ((TideModel.GM_MOON / g) * r * r) / (dMoon * dMoon * dMoon);
  const sun = ((TideModel.GM_SUN / g) * r * r) / (dSun * dSun * dSun);
  assert.ok(Math.abs(moon - 0.357) < 0.01, `lunar coefficient ${moon}`);
  assert.ok(Math.abs(sun - 0.164) < 0.01, `solar coefficient ${sun}`);
  assert.ok(Math.abs(sun / moon - 0.46) < 0.02, `solar/lunar ${sun / moon}`);
});

test("TideModel: the permanent (zero-frequency) tide is the classic -0.198 m P2", () => {
  // The permanent tide does NOT average away over a nodal cycle, and it is the
  // one component GAMMA2 gets wrong: the real crust already carries its
  // permanent deformation (the terrain mesh is a survey OF that crust), while
  // the tide-free EGM2008 geoid has had (1 + k2) * zeta_bar REMOVED. So the
  // permanent part is scaled by (1 + k2) and only the time-varying residual by
  // GAMMA2, which nets out to an extra h2 * zeta_bar on top of GAMMA2 * zeta.
  //
  // Derivation is in the module header; the external anchor is the classic
  // -0.198 m coefficient (Melchior 1983; Ekman 1989; IERS Conventions 2010
  // §7.1.1 tide-free / mean-tide conventions).
  const meanRadius = 6371000.0;
  const coefficientAtMeanRadius =
    TideModel.PERMANENT_TIDE_COEFFICIENT * meanRadius * meanRadius;
  assert.ok(
    Math.abs(coefficientAtMeanRadius - -0.198) <= 0.002,
    `permanent-tide coefficient at r = 6371 km is ${coefficientAtMeanRadius.toFixed(6)} m, not the published -0.198 m`,
  );
  // The two declination averages that produce it.
  assert.ok(
    Math.abs(TideModel.MEAN_SOLAR_DECLINATION_LEGENDRE - -0.38133) < 1e-4,
    `<P2(sin delta)> for the Sun = ${TideModel.MEAN_SOLAR_DECLINATION_LEGENDRE}`,
  );
  assert.ok(
    Math.abs(TideModel.MEAN_LUNAR_DECLINATION_LEGENDRE - -0.37673) < 1e-4,
    `<P2(sin delta)> for the Moon = ${TideModel.MEAN_LUNAR_DECLINATION_LEGENDRE}`,
  );

  // Latitude dependence: P2(sin phi) is -1/2 at the equator and +1 at a pole,
  // so zeta_bar flips sign and doubles in magnitude between them.
  const equator = TideModel.permanentTideHeight(surfaceAt(0, 0));
  const pole = TideModel.permanentTideHeight(surfaceAt(0, 90));
  assert.ok(
    Math.abs(equator - 0.09912) < 1e-3,
    `zeta_bar at the equator is ${equator.toFixed(6)} m (expected +0.0991)`,
  );
  assert.ok(
    Math.abs(pole - -0.19691) < 1e-3,
    `zeta_bar at the pole is ${pole.toFixed(6)} m (expected -0.1969)`,
  );
  assert.ok(
    Math.abs(TideModel.permanentTideHeight(surfaceAt(0, -90)) - pole) < 1e-6,
    "zeta_bar is symmetric about the equator",
  );
  assert.equal(TideModel.permanentTideHeight(Cartesian3.ZERO), 0);
  assert.equal(TideModel.permanentTideHeight(undefined), 0);

  // The correction actually applied, h2 * zeta_bar: +6.0 cm equator, -12.0 cm pole.
  assert.ok(Math.abs(TideModel.LOVE_H2 * equator - 0.06024) < 1e-3);
  assert.ok(Math.abs(TideModel.LOVE_H2 * pole - -0.11968) < 1e-3);

  // And it must be WIRED IN, not merely computed: heightM carries it, and it is
  // time-independent (identical at two instants a quarter-day apart).
  const site = surfaceAt(-70.7, 43.07);
  const a = TideModel.evaluate(EPOCH, site, TideModel.createResult());
  const b = TideModel.evaluate(at(21600), site, TideModel.createResult());
  assert.equal(a.permanentRawM, b.permanentRawM, "zeta_bar is zero-frequency");
  assert.ok(
    Math.abs(a.permanentM - TideModel.LOVE_H2 * a.permanentRawM) < 1e-15,
    "permanentM must be h2 * zeta_bar, not gamma2 * zeta_bar",
  );
  assert.ok(
    Math.abs(a.heightM - (a.lunarM + a.solarM + a.permanentM)) < 1e-15,
    "heightM = gamma2*(lunar+solar) + h2*zeta_bar",
  );
  assert.notEqual(a.permanentM, 0, "the correction is applied, not dropped");
});

test("TideModel: 25 h range at true scale is the equilibrium band", () => {
  const site = surfaceAt(DATUM_FIX_SITE.lonDeg, DATUM_FIX_SITE.latDeg);
  const values = [];
  for (let i = 0; i <= 25 * 4; i++) {
    values.push(TideModel.equilibriumHeight(at(i * 900), site));
  }
  const range = Math.max(...values) - Math.min(...values);
  assert.ok(
    range >= THRESHOLDS.TIDE_RANGE_MIN_M &&
      range <= THRESHOLDS.TIDE_RANGE_MAX_M,
    `range ${range.toFixed(4)} m outside [${THRESHOLDS.TIDE_RANGE_MIN_M}, ${THRESHOLDS.TIDE_RANGE_MAX_M}]`,
  );
  // A semidiurnal signal, not a ramp.
  const extrema = findExtrema(values, 900);
  assert.ok(
    extrema.length >= THRESHOLDS.TIDE_EXTREMA_MIN &&
      extrema.length <= THRESHOLDS.TIDE_EXTREMA_MAX,
    `${extrema.length} extrema over 25 h`,
  );
  assert.ok(monotoneSegments(values, extrema).allMonotone, "no jitter");
});

test("TideModel: the lunar term peaks AT lunar culmination", () => {
  // By construction P2(cos psi) is maximal at psi = 0 and psi = pi, i.e. at
  // upper and lower meridian passage. Any separation is a frame or time-base
  // defect, not physics — which is why the tolerance is 5 minutes and not an
  // hour. The equatorial site is used because off-equator the moon's changing
  // declination shifts maximum ALTITUDE off meridian passage by minutes,
  // which would test the instrument rather than the model.
  const site = surfaceAt(-150.0, 0.0);
  const siteDir = Cartesian3.normalize(site, new Cartesian3());
  const moon = new Cartesian3();
  const result = TideModel.createResult();
  const dt = 60;
  const n = 30 * 60;
  const lunar = [];
  const altitude = [];
  for (let i = 0; i < n; i++) {
    const t = at(i * dt);
    lunar.push(TideModel.evaluate(t, site, result).lunarM);
    TideModel.computeMoonPositionFixed(t, moon);
    altitude.push(Cartesian3.dot(Cartesian3.normalize(moon, moon), siteDir));
  }
  const lunarMax = findExtrema(lunar, dt).filter((e) => e.kind === "MAX");
  const culminations = findExtrema(altitude, dt);
  assert.ok(lunarMax.length >= 2, "at least two lunar maxima in 30 h");
  let worstMinutes = 0;
  for (const e of lunarMax) {
    const tMax = refineExtremumSeconds(lunar, e.index, dt);
    let best = Infinity;
    for (const c of culminations) {
      const tc = refineExtremumSeconds(altitude, c.index, dt);
      best = Math.min(best, Math.abs(tc - tMax));
    }
    worstMinutes = Math.max(worstMinutes, best / 60);
  }
  assert.ok(
    worstMinutes <= THRESHOLDS.LUNAR_PHASE_LOCK_MAX_MINUTES,
    `worst lunar-maximum vs culmination separation ${worstMinutes.toFixed(2)} min`,
  );
});

test("TideModel: the mean lunar period IS the published NOAA M2 constituent", () => {
  // Individual transit intervals swing +-0.1 h with the Moon's variable
  // orbital speed; M2 is the MEAN, so the baseline has to be weeks. This is
  // the assertion that separates a real ephemeris from a 12.00 h solar
  // sinusoid or a 12.00 h "close enough" stand-in.
  const site = surfaceAt(-150.0, 0.0);
  const result = TideModel.createResult();
  const dt = 30;
  const n = Math.floor((THRESHOLDS.M2_BASELINE_DAYS * 86400) / dt);
  const maxima = [];
  let m2 = null;
  let m1 = null;
  for (let i = 0; i < n; i++) {
    const v = TideModel.evaluate(at(i * dt), site, result).lunarM;
    if (m1 !== null && m2 !== null && m1 > m2 && m1 >= v) {
      const denom = m2 - 2 * m1 + v;
      const delta = denom === 0 ? 0 : (m2 - v) / (2 * denom);
      maxima.push((i - 1 + delta) * dt);
    }
    m2 = m1;
    m1 = v;
  }
  assert.ok(
    maxima.length > 70,
    `${maxima.length} lunar maxima over the baseline`,
  );
  const mean = meanIntervalHours(maxima);
  assert.ok(
    Math.abs(mean - M2_PERIOD_HOURS) <= THRESHOLDS.M2_MEAN_INTERVAL_TOL_HOURS,
    `mean ${mean.toFixed(5)} h vs published M2 half-period ${M2_PERIOD_HOURS.toFixed(5)} h`,
  );
  // ... and the mean lunar DAY follows, which is the other published anchor.
  assert.ok(
    Math.abs(2 * mean - PUBLISHED_CONSTANTS.MEAN_LUNAR_DAY_HOURS) <= 0.1,
    `mean lunar day ${(2 * mean).toFixed(4)} h`,
  );
});

test("TideModel: springs fall at syzygy and neaps at quadrature", () => {
  // The spring/neap envelope is the one qualitative feature a user can check
  // against a printed tide table without any station data: the biggest ranges
  // are at new and full moon.
  const site = surfaceAt(-150.0, 0.0);
  const moon = new Cartesian3();
  const sun = new Cartesian3();
  const days = 90;
  const ranges = [];
  const elongations = [];
  for (let d = 0; d < days; d++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < 25 * 6; i++) {
      const v = TideModel.equilibriumHeight(at(d * 86400 + i * 600), site);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    ranges.push(hi - lo);
    const noon = at(d * 86400 + 43200);
    TideModel.computeMoonPositionFixed(noon, moon);
    TideModel.computeSunPositionFixed(noon, sun);
    const c =
      Cartesian3.dot(moon, sun) /
      (Cartesian3.magnitude(moon) * Cartesian3.magnitude(sun));
    elongations.push((Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
  }
  const peaks = [];
  const troughs = [];
  for (let i = 1; i < days - 1; i++) {
    if (ranges[i] > ranges[i - 1] && ranges[i] >= ranges[i + 1]) {
      peaks.push(i);
    }
    if (ranges[i] < ranges[i - 1] && ranges[i] <= ranges[i + 1]) {
      troughs.push(i);
    }
  }
  assert.ok(peaks.length >= 4, `${peaks.length} spring peaks in 90 days`);
  for (const d of peaks) {
    const e = elongations[d];
    const off = Math.min(e, Math.abs(180 - e));
    assert.ok(
      off <= THRESHOLDS.SYZYGY_ELONGATION_TOL_DEG,
      `spring on day ${d} at elongation ${e.toFixed(1)} deg`,
    );
  }
  for (const d of troughs) {
    const off = Math.abs(elongations[d] - 90);
    assert.ok(
      off <= THRESHOLDS.SYZYGY_ELONGATION_TOL_DEG,
      `neap on day ${d} at elongation ${elongations[d].toFixed(1)} deg`,
    );
  }
  // Spring/neap beat = half a synodic month.
  const beat = (peaks[peaks.length - 1] - peaks[0]) / (peaks.length - 1);
  assert.ok(
    Math.abs(beat - PUBLISHED_CONSTANTS.SYNODIC_MONTH_DAYS / 2) <= 1.5,
    `spring-to-spring ${beat.toFixed(2)} d vs half a synodic month ${(PUBLISHED_CONSTANTS.SYNODIC_MONTH_DAYS / 2).toFixed(2)} d`,
  );
});

test("TideModel: pure function of (time, position), memo returns identical values", () => {
  const site = surfaceAt(10.0, 20.0);
  const t = at(12345);
  const a = TideModel.equilibriumHeight(t, site);
  const b = TideModel.equilibriumHeight(t, site);
  assert.equal(a, b, "same instant must be bit-identical (memo hit)");
  const c = TideModel.equilibriumHeight(at(12345 + 3600), site);
  assert.notEqual(a, c, "an hour later must differ");
  // Degenerate inputs are exactly zero, never NaN.
  assert.equal(TideModel.equilibriumHeight(t, Cartesian3.ZERO), 0);
  assert.equal(TideModel.equilibriumHeight(undefined, site), 0);
  assert.equal(TideModel.equilibriumHeight(t, undefined), 0);
  const res = TideModel.evaluate(t, site, TideModel.createResult());
  assert.equal(res.valid, true);
  assert.ok(
    Math.abs(res.heightM - (res.lunarM + res.solarM + res.permanentM)) < 1e-15,
  );
  assert.ok(res.moonZenithCosine >= -1 && res.moonZenithCosine <= 1);
  assert.ok(res.moonDistanceM > 3.5e8 && res.moonDistanceM < 4.1e8);
  assert.ok(res.sunDistanceM > 1.4e11 && res.sunDistanceM < 1.6e11);
});

// ─────────────────────── datum derivation + composition ──────────────────

test("VerticalDatum: the AUTO derivation table", () => {
  assert.equal(
    VerticalDatum.fromTerrainProvider(undefined),
    VerticalDatum.ELLIPSOID,
    "no provider -> nothing to agree with",
  );
  assert.equal(
    VerticalDatum.fromTerrainProvider(new EllipsoidTerrainProvider()),
    VerticalDatum.ELLIPSOID,
    "EllipsoidTerrainProvider returns height 0 by construction",
  );
  // Any real terrain provider publishes orthometric heights. Stand-in object:
  // the derivation must not depend on a constructor NAME (minified in release).
  assert.equal(
    VerticalDatum.fromTerrainProvider({ hasWaterMask: true }),
    VerticalDatum.GEOID,
  );
  assert.equal(
    VerticalDatum.resolve(VerticalDatum.ELLIPSOID, { hasWaterMask: true }),
    VerticalDatum.ELLIPSOID,
    "an explicit pin beats the derivation",
  );
  assert.equal(
    VerticalDatum.resolve(VerticalDatum.GEOID, new EllipsoidTerrainProvider()),
    VerticalDatum.GEOID,
  );
  assert.equal(
    VerticalDatum.resolve("nonsense", undefined),
    VerticalDatum.ELLIPSOID,
    "an unrecognised value degrades to AUTO, it does not throw",
  );
  assert.ok(Object.isFrozen(VerticalDatum));
});

function makePrimitive(overrides) {
  return Object.assign(
    {
      _verticalDatum: VerticalDatum.AUTO,
      _tideEnabled: true,
      _tideExaggeration: 1.0,
      _tideCallback: undefined,
      _globe: undefined,
      _geoidRequested: true, // never touch the network from a spec
      _resolvedVerticalDatum: undefined,
      _geoidUndulationM: 0,
      _tideHeightM: 0,
      _anchorHeightM: 0,
    },
    overrides,
  );
}
const frame = (time, scale, relative) => ({
  time,
  verticalExaggeration: scale,
  verticalExaggerationRelativeHeight: relative,
});

test("off-contract: ellipsoid datum + tide off is EXACTLY zero", () => {
  const anchor = surfaceAt(DATUM_FIX_SITE.lonDeg, DATUM_FIX_SITE.latDeg);
  const p = makePrimitive({
    _verticalDatum: VerticalDatum.ELLIPSOID,
    _tideEnabled: false,
  });
  const offset = computeSeaLevelOffset(
    p,
    anchor,
    frame(EPOCH, 1.0, 0.0),
    ellipsoid,
  );
  assert.equal(offset, 0, "offset must be exactly 0, not merely small");
  assert.equal(p._geoidUndulationM, 0);
  assert.equal(p._tideHeightM, 0);
  assert.equal(p._anchorHeightM, 0);
  assert.equal(p._resolvedVerticalDatum, VerticalDatum.ELLIPSOID);
  // ... and stays exactly 0 under exaggeration, because 0 is a fixed point of
  // the exaggeration map at the default relative height.
  assert.equal(
    computeSeaLevelOffset(p, anchor, frame(EPOCH, 3.0, 0.0), ellipsoid),
    0,
  );
  // AUTO over no terrain provider is the same identity.
  const q = makePrimitive({ _tideEnabled: false });
  assert.equal(
    computeSeaLevelOffset(q, anchor, frame(EPOCH, 1.0, 0.0), ellipsoid),
    0,
  );
});

test("off-contract: a zero tide callback contributes exactly zero", () => {
  const anchor = surfaceAt(DATUM_FIX_SITE.lonDeg, DATUM_FIX_SITE.latDeg);
  const p = makePrimitive({
    _verticalDatum: VerticalDatum.ELLIPSOID,
    _tideCallback: () => 0,
  });
  assert.equal(
    computeSeaLevelOffset(p, anchor, frame(EPOCH, 1.0, 0.0), ellipsoid),
    0,
  );
  assert.equal(p._tideHeightM, 0);
  // Non-finite callback returns are treated as 0, never propagated.
  for (const bad of [NaN, Infinity, undefined, null, "1.5"]) {
    const q = makePrimitive({
      _verticalDatum: VerticalDatum.ELLIPSOID,
      _tideCallback: () => bad,
    });
    assert.equal(
      computeSeaLevelOffset(q, anchor, frame(EPOCH, 1.0, 0.0), ellipsoid),
      0,
      `callback returning ${String(bad)}`,
    );
  }
});

test("composition: geoid, then tide x tideExaggeration, then the exaggeration map", () => {
  const anchor = surfaceAt(DATUM_FIX_SITE.lonDeg, DATUM_FIX_SITE.latDeg);
  const carto = ellipsoid.cartesianToCartographic(anchor, new Cartographic());
  const undulation = grid.sample(carto.longitude, carto.latitude);
  const tide = TideModel.equilibriumHeight(EPOCH, anchor);

  // (1) geoid alone.
  const geoidOnly = makePrimitive({
    _verticalDatum: VerticalDatum.GEOID,
    _tideEnabled: false,
  });
  const h0 = computeSeaLevelOffset(
    geoidOnly,
    anchor,
    frame(EPOCH, 1.0, 0.0),
    ellipsoid,
  );
  assert.ok(Math.abs(h0 - undulation) < 1e-12, `geoid term ${h0}`);
  assert.ok(h0 < -95 && h0 > -110, `Sri Lanka undulation ${h0.toFixed(2)} m`);

  // (2) geoid + tide.
  const both = makePrimitive({ _verticalDatum: VerticalDatum.GEOID });
  const h1 = computeSeaLevelOffset(
    both,
    anchor,
    frame(EPOCH, 1.0, 0.0),
    ellipsoid,
  );
  assert.ok(Math.abs(h1 - (undulation + tide)) < 1e-12);
  assert.equal(both._geoidUndulationM, undulation);
  assert.ok(Math.abs(both._tideHeightM - tide) < 1e-15);

  // (3) tideExaggeration scales ONLY the tide term.
  const exaggerated = makePrimitive({
    _verticalDatum: VerticalDatum.GEOID,
    _tideExaggeration: 20.0,
  });
  const h2 = computeSeaLevelOffset(
    exaggerated,
    anchor,
    frame(EPOCH, 1.0, 0.0),
    ellipsoid,
  );
  assert.ok(
    Math.abs(h2 - (undulation + 20.0 * tide)) < 1e-9,
    `tideExaggeration must not touch the datum term (${h2})`,
  );

  // (4) scene.verticalExaggeration is applied LAST, to the total.
  const scaled = makePrimitive({ _verticalDatum: VerticalDatum.GEOID });
  const h3 = computeSeaLevelOffset(
    scaled,
    anchor,
    frame(EPOCH, 3.0, 0.0),
    ellipsoid,
  );
  assert.ok(
    Math.abs(h3 - 3.0 * (undulation + tide)) < 1e-9,
    `exaggeration 3 must give 3x (got ${h3})`,
  );
  const rel = makePrimitive({ _verticalDatum: VerticalDatum.GEOID });
  const h4 = computeSeaLevelOffset(
    rel,
    anchor,
    frame(EPOCH, 3.0, -50.0),
    ellipsoid,
  );
  assert.ok(
    Math.abs(h4 - ((undulation + tide + 50.0) * 3.0 - 50.0)) < 1e-9,
    `(h - rel) * scale + rel (got ${h4})`,
  );
  // A non-finite exaggeration must degrade to identity, not poison the anchor.
  const nan = makePrimitive({ _verticalDatum: VerticalDatum.GEOID });
  const h5 = computeSeaLevelOffset(
    nan,
    anchor,
    frame(EPOCH, NaN, NaN),
    ellipsoid,
  );
  assert.ok(Math.abs(h5 - (undulation + tide)) < 1e-12);
});

test("composition: the geoid term is what closes the measured 101.6 m plateau", () => {
  // The Batch 759 measurement was terrain - anchor = -101.6424 m at this site.
  // With the datum term applied the anchor moves by the undulation, so the
  // residual is the grid's own error against the CWT lid.
  const anchor = surfaceAt(DATUM_FIX_SITE.lonDeg, DATUM_FIX_SITE.latDeg);
  const p = makePrimitive({
    _verticalDatum: VerticalDatum.GEOID,
    _tideEnabled: false,
  });
  const offset = computeSeaLevelOffset(
    p,
    anchor,
    frame(EPOCH, 1.0, 0.0),
    ellipsoid,
  );
  const residual = DATUM_FIX_SITE.baselineOffsetM - offset;
  assert.ok(
    Math.abs(residual) <= THRESHOLDS.DATUM_RESIDUAL_BUDGET_M,
    `residual ${residual.toFixed(3)} m exceeds the ${THRESHOLDS.DATUM_RESIDUAL_BUDGET_M} m budget`,
  );
  assert.ok(
    Math.abs(residual) <= THRESHOLDS.DATUM_RESIDUAL_EXPECTED_M,
    `residual ${residual.toFixed(3)} m is worse than expected at this site`,
  );
});

// ───────────────────────────── source guards ─────────────────────────────

test("the offset is JS-only: no WGSL or renderer change carries it", () => {
  // The design claim (TIDES_FEASIBILITY §2 rank 1) is that RTE absorbs the
  // offset through the EXISTING anchorHigh/anchorLow split, so the shader is
  // untouched and a future WebGL2 FFT fallback inherits the fix for free. A
  // new shader uniform would silently retire that claim.
  const wgsl = fs.readFileSync(
    enginePath("Shaders/WebGPU/Ocean/OceanSurface.wgsl"),
    "utf8",
  );
  for (const token of ["tide", "geoid", "undulation", "datum"]) {
    assert.ok(
      !new RegExp(token, "i").test(wgsl),
      `OceanSurface.wgsl mentions "${token}" — the offset leaked into the shader`,
    );
  }
  const renderer = fs.readFileSync(
    enginePath("Renderer/WebGPU/WebGPUOceanRenderer.ts"),
    "utf8",
  );
  assert.ok(
    /EncodedCartesian3\.fromCartesian\(p\._anchor/.test(renderer),
    "the renderer must still split the primitive's anchor high/low",
  );
  for (const token of ["_tideHeightM", "_geoidUndulationM", "_anchorHeightM"]) {
    assert.ok(
      !renderer.includes(token),
      `WebGPUOceanRenderer.ts reads ${token} — the offset should reach it only through _anchor`,
    );
  }
});

test("the offset is applied after the lattice snap and before the curvature radius", () => {
  const src = readEngine("Scene/OceanSurfacePrimitive.js");
  const snap = src.indexOf("this._uvOffsetY = snapN / L;");
  const offset = src.indexOf("const seaLevelOffset = computeSeaLevelOffset(");
  const radius = src.indexOf(
    "const anchorMag = Cartesian3.magnitude(this._anchor);",
  );
  assert.ok(
    snap > 0 && offset > 0 && radius > 0,
    "all three landmarks present",
  );
  assert.ok(
    snap < offset,
    "the offset must not disturb the world-anchored UV lattice",
  );
  assert.ok(
    offset < radius,
    "the spherical cap radius must be taken from the OFFSET anchor",
  );
});

test("the facades expose the ratified knobs", () => {
  const ocean = readEngine("Scene/GlobeWaterOcean.js");
  for (const prop of [
    "verticalDatum",
    "tideEnabled",
    "tideExaggeration",
    "tideCallback",
    "resolvedVerticalDatum",
    "geoidUndulationMeters",
    "tideHeightMeters",
    "anchorHeightMeters",
  ]) {
    assert.ok(
      new RegExp(`^\\s{2}${prop}: \\{`, "m").test(ocean),
      `GlobeWaterOcean is missing "${prop}"`,
    );
  }
  const water = readEngine("Scene/GlobeWater.js");
  for (const prop of [
    "oceanVerticalDatum",
    "tideEnabled",
    "tideExaggeration",
    "tideCallback",
  ]) {
    assert.ok(
      water.includes(`get ${prop}()`) && water.includes(`set ${prop}(`),
      `GlobeWater is missing "${prop}"`,
    );
  }
});

// ─────────────────────── the probe's verdict functions ───────────────────

test("datumFixVerdict: passes only on a re-measured, improved, visible patch", () => {
  const pass = datumFixVerdict({
    beforeOffsetM: -101.64,
    afterOffsetM: -0.48,
    resolvedDatum: "GEOID",
    geoidUndulationM: -101.16,
    patchVisible: true,
  });
  assert.equal(pass.verdict, "DATUM_FIXED");
  assert.ok(pass.residualFraction < 0.01);

  assert.equal(
    datumFixVerdict({
      beforeOffsetM: -101.64,
      afterOffsetM: -20.0,
      patchVisible: true,
    }).verdict,
    "DATUM_NOT_FIXED",
    "a partial improvement is not a fix",
  );
  assert.equal(
    datumFixVerdict({
      beforeOffsetM: -3.0,
      afterOffsetM: -0.1,
      patchVisible: true,
    }).verdict,
    "DATUM_NOT_FIXED",
    "a baseline that does not reproduce Batch 759 is not anchored",
  );
  assert.equal(
    datumFixVerdict({
      beforeOffsetM: -101.64,
      afterOffsetM: 0.0,
      patchVisible: false,
    }).verdict,
    "DATUM_NOT_FIXED",
    "0 m from an absent patch is not a fix",
  );
  assert.equal(
    datumFixVerdict({ beforeOffsetM: null, afterOffsetM: -0.4 }).verdict,
    "INDETERMINATE",
  );
});

test("tidePhaseVerdict: catches a flat, oversized, drifting or wall-clock tide", () => {
  const dt = 900;
  const n = 101;
  const good = [];
  const model = [];
  for (let i = 0; i < n; i++) {
    const v =
      0.18 * Math.cos((2 * Math.PI * i * dt) / (M2_PERIOD_HOURS * 3600));
    good.push(v);
    model.push(v);
  }
  const ok = tidePhaseVerdict({
    renderedSeries: good,
    modelSeries: model,
    dtSeconds: dt,
    lunarPhaseLockMaxMinutes: 0.4,
    meanM2IntervalHours: M2_PERIOD_HOURS,
    springElongationMaxDeg: 6,
    neapElongationMaxDeg: 9,
  });
  assert.equal(ok.verdict, "TIDE_PHASE_LOCKED", ok.reasons.join("; "));

  const flat = new Array(n).fill(0.0);
  assert.equal(
    tidePhaseVerdict({
      renderedSeries: flat,
      modelSeries: flat,
      dtSeconds: dt,
      lunarPhaseLockMaxMinutes: 0,
      meanM2IntervalHours: M2_PERIOD_HOURS,
    }).verdict,
    "TIDE_PHASE_FAILED",
  );
  const huge = good.map((v) => v * 10);
  assert.equal(
    tidePhaseVerdict({
      renderedSeries: huge,
      modelSeries: huge,
      dtSeconds: dt,
      lunarPhaseLockMaxMinutes: 0,
      meanM2IntervalHours: M2_PERIOD_HOURS,
    }).verdict,
    "TIDE_PHASE_FAILED",
  );
  const solarPeriod = tidePhaseVerdict({
    renderedSeries: good,
    modelSeries: model,
    dtSeconds: dt,
    lunarPhaseLockMaxMinutes: 0,
    meanM2IntervalHours: 12.0,
  });
  assert.equal(
    solarPeriod.verdict,
    "TIDE_PHASE_FAILED",
    "12.00 h is S2, not M2",
  );
  const wallClock = tidePhaseVerdict({
    renderedSeries: good,
    modelSeries: good.map((v) => v + 0.01),
    dtSeconds: dt,
    lunarPhaseLockMaxMinutes: 0,
    meanM2IntervalHours: M2_PERIOD_HOURS,
  });
  assert.equal(
    wallClock.verdict,
    "TIDE_PHASE_FAILED",
    "the rendered tide must equal the model at the pinned scene time",
  );
});

test("exaggerationCompositionVerdict + offContractVerdict + decision", () => {
  assert.equal(
    exaggerationCompositionVerdict({
      anchorHeight1M: -101.2,
      anchorHeightNM: -303.6,
      scale: 3.0,
      relativeHeightM: 0,
    }).verdict,
    "COMPOSES_AS_MODELED",
  );
  assert.equal(
    exaggerationCompositionVerdict({
      anchorHeight1M: -101.2,
      anchorHeightNM: -101.2,
      scale: 3.0,
      relativeHeightM: 0,
    }).verdict,
    "COMPOSITION_MISMATCH",
    "a patch that ignores exaggeration re-opens the plateau at scale > 1",
  );
  // The component terms must stay exaggeration-invariant even when the total
  // looks right — otherwise the map has been folded into a component.
  assert.equal(
    exaggerationCompositionVerdict({
      anchorHeight1M: -101.2,
      anchorHeightNM: -303.6,
      scale: 3.0,
      relativeHeightM: 0,
      geoid1M: -101.2,
      geoidNM: -303.6,
      tide1M: 0.1,
      tideNM: 0.1,
    }).verdict,
    "COMPOSITION_MISMATCH",
  );
  assert.equal(
    exaggerationCompositionVerdict({
      anchorHeight1M: -101.1,
      anchorHeightNM: -303.3,
      scale: 3.0,
      relativeHeightM: 0,
      geoid1M: -101.2,
      geoidNM: -101.2,
      tide1M: 0.1,
      tideNM: 0.1,
    }).verdict,
    "COMPOSES_AS_MODELED",
  );

  assert.equal(
    offContractVerdict({
      tideOffMeters: 0,
      zeroCallbackMeters: 0,
      ellipsoidUndulationMeters: 0,
      identityAnchorMeters: 0,
      identityAnchorGeodeticHeightM: 0,
    }).verdict,
    "OFF_IS_IDENTITY",
  );
  const leak = offContractVerdict({
    tideOffMeters: 1e-12,
    zeroCallbackMeters: 0,
    ellipsoidUndulationMeters: 0,
    identityAnchorMeters: 0,
  });
  assert.equal(leak.verdict, "OFF_LEAKS", "1e-12 is not 0");

  const good = {
    datumFix: { verdict: "DATUM_FIXED" },
    tidePhase: { verdict: "TIDE_PHASE_LOCKED" },
    exaggeration: { verdict: "COMPOSES_AS_MODELED" },
    offContract: { verdict: "OFF_IS_IDENTITY" },
  };
  assert.equal(decisionFromLanes(good).exitCode, 0);
  assert.equal(
    decisionFromLanes({
      ...good,
      offContract: { verdict: "OFF_LEAKS", reasons: [] },
    }).exitCode,
    1,
  );
  assert.equal(decisionFromLanes({}).exitCode, 1);
});

test("model helpers: extrema, refinement, intervals, monotonicity", () => {
  const dt = 60;
  const v = [0, 1, 2, 1, 0, -1, 0, 1, 0];
  const ex = findExtrema(v, dt);
  assert.deepEqual(
    ex.map((e) => `${e.kind}@${e.index}`),
    ["MAX@2", "MIN@5", "MAX@7"],
  );
  assert.equal(findExtrema(v, dt)[0].timeSeconds, 120);
  // A symmetric peak refines to its own sample.
  assert.ok(Math.abs(refineExtremumSeconds([0, 1, 0], 1, 60) - 60) < 1e-9);
  // A skewed peak refines toward the higher neighbour.
  assert.ok(refineExtremumSeconds([0, 1, 0.5], 1, 60) > 60);
  assert.equal(meanIntervalHours([0, 3600, 7200]), 1);
  assert.equal(meanIntervalHours([0]), null);
  assert.ok(monotoneSegments(v, ex).allMonotone);

  // Prominence merging is what makes the monotonicity check non-vacuous: with
  // every wiggle promoted to an extremum, every segment is monotone by
  // construction and a jittering tide term would pass.
  const jitter = [0, 1, 2, 1.5, 1.6, 0, -1, 0, 1, 0];
  assert.equal(findExtrema(jitter, dt).length, 5, "raw: the wiggle counts");
  assert.ok(
    monotoneSegments(jitter, findExtrema(jitter, dt)).allMonotone,
    "raw extrema make the check vacuous — this is the trap",
  );
  const merged = findExtrema(jitter, dt, 0.5);
  assert.equal(merged.length, 3, "the 0.1-tall wiggle is merged away");
  assert.equal(
    monotoneSegments(jitter, merged).allMonotone,
    false,
    "and now the wiggle is visible as a non-monotone segment",
  );
  // A clean series is unaffected by the same prominence floor.
  assert.deepEqual(
    findExtrema(v, dt, 0.5).map((e) => e.index),
    [2, 5, 7],
  );
});
