// tidal-harmonics.spec.mjs — maintainer ruling T6 ("the tides, when turned on,
// must match the correct tide dates and timings for the globe and align with the
// position and movement of the moon") as executable gates over the harmonic
// tide engine: `Core/TidalArguments.js`, `Core/TidalConstituents.js`,
// `Core/HarmonicTideModel.js`, `Core/TideConstituentGrid.js`.
//
// These tests fail if:
//   - the Doodson/Cartwright fundamental arguments stop reproducing published
//     J2000 mean elements, or their rates stop reproducing the NOAA CO-OPS
//     constituent speeds;
//   - the time-scale bridge breaks. tau is UT1 and the mean longitudes are TT;
//     mixing them is a 69 s error, and forgetting that JulianDate.secondsOfDay
//     runs from NOON is a 180 deg error that leaves the SEMIDIURNAL band looking
//     perfect while inverting every DIURNAL one. Both have dedicated negative
//     controls below;
//   - the harmonic reconstruction stops agreeing with the engine's own
//     geometric ephemeris tide (TideModel) — the two are independent
//     computations of the same physics and only agree if both are right;
//   - the equilibrium high-water bulge stops tracking the sub-lunar point, or
//     stops producing the ANTIPODAL bulge (a one-bulge model passes every
//     period test and is still wrong);
//   - successive high waters stop drifting ~50 min/day;
//   - spring tides stop landing on syzygy and neaps on quadrature, with the
//     moon phases derived from the ephemeris rather than pasted in;
//   - the M2 nodal factor leaves its published 0.963-1.038 band or stops
//     returning to unity at the quadrature nodes;
//   - the baked-atlas format stops round-tripping, or its no-data sentinel
//     stops being distinguishable from data.
//
// SCOPE LIMIT, STATED PLAINLY. Every number here is f64 CPU math. Nothing in it
// validates an f32 shader: the astronomical arguments accumulate past 1e5
// radians before wrapping, which f32 cannot carry, so a WGSL port must reduce
// the arguments on the CPU. There is an explicit f32 lane below that measures
// exactly how much accuracy is lost, so the limit is a measurement rather than
// a caveat.
//
// Run: node --test Tools/visual-regression/tidal-harmonics.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  APRIL_2024_PHASES,
  DEGREES_TO_RADIANS,
  FUNDAMENTAL_RATE_DEGREES_PER_HOUR,
  J2000_ARGUMENT_DEGREES,
  NOAA_SPEED_DEGREES_PER_HOUR,
  PUBLISHED,
  TOLERANCE,
  compareSeries,
  leastSquaresSlope,
  maximumTimes,
  nearestLongitudeError,
  rangeOf,
  ringMaximumLongitudes,
  wrap180,
  wrap360,
} from "./lib/tidal-harmonics-model.mjs";

// The bake tool's REAL encoder and REAL sanity gate — not a copy. The tool
// guards its own `main()` behind an is-entry-point check so this import is
// side-effect free.
import {
  SANITY as BAKE_SANITY,
  encode as bakeEncode,
  sanityCheck as bakeSanityCheck,
} from "../build-eot20-constituent-grid.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const enginePath = (p) => path.join(root, "packages/engine/Source", p);
const readEngine = (p) => fs.readFileSync(enginePath(p), "utf8");
const importEngine = async (p) =>
  await import(pathToFileURL(enginePath(p)).href);

const { default: TidalArguments } = await importEngine(
  "Core/TidalArguments.js",
);
const { default: TidalConstituents } = await importEngine(
  "Core/TidalConstituents.js",
);
const { default: HarmonicTideModel } = await importEngine(
  "Core/HarmonicTideModel.js",
);
const { default: TideConstituentGrid } = await importEngine(
  "Core/TideConstituentGrid.js",
);
const { default: TideModel } = await importEngine("Core/TideModel.js");
const { default: Cartesian3 } = await importEngine("Core/Cartesian3.js");
const { default: Cartographic } = await importEngine("Core/Cartographic.js");
const { default: Ellipsoid } = await importEngine("Core/Ellipsoid.js");
const { default: JulianDate } = await importEngine("Core/JulianDate.js");
const { default: Matrix3 } = await importEngine("Core/Matrix3.js");
const { default: Simon1994PlanetaryPositions } = await importEngine(
  "Core/Simon1994PlanetaryPositions.js",
);
const { default: TimeStandard } = await importEngine("Core/TimeStandard.js");
const { default: Transforms } = await importEngine("Core/Transforms.js");

const RADIANS_TO_DEGREES = 180.0 / Math.PI;
const ellipsoid = Ellipsoid.WGS84;
const iso = (s) => JulianDate.fromIso8601(s);
const after = (epoch, seconds) =>
  JulianDate.addSeconds(epoch, seconds, new JulianDate());

/** Surface position and its GEOCENTRIC latitude — what the degree-2 expansion wants. */
function siteAt(longitudeDegrees, latitudeDegrees) {
  const position = ellipsoid.cartographicToCartesian(
    Cartographic.fromDegrees(longitudeDegrees, latitudeDegrees, 0),
  );
  const geocentricLatitude = Math.asin(
    position.z / Cartesian3.magnitude(position),
  );
  return {
    position: position,
    longitude: longitudeDegrees * DEGREES_TO_RADIANS,
    longitudeDegrees: longitudeDegrees,
    geocentricLatitude: geocentricLatitude,
  };
}

const SITES = [
  siteAt(-150.0, 0.0),
  siteAt(-70.7, 43.07),
  siteAt(20.0, -35.0),
  siteAt(5.0, 62.0),
];

// The one place the spec re-implements anything: the five-line summation loop
// inside HarmonicTideModel.predict, exposed so a PERTURBED arguments object can
// be pushed through the engine's own astronomicalArgument / nodalCorrection.
// The first assertion of every negative control below is that this helper
// reproduces `predict` EXACTLY on unperturbed input, so it cannot silently
// drift into being a second model.
const nodalScratch = TidalConstituents.createNodalResult();
function predictWithArguments(args, station) {
  // Three species accumulators, summed at the end, because that is what
  // `predict` does — a single accumulator differs in the last ULP and the
  // exact-equality assertion below would have to be loosened to a tolerance,
  // which is exactly the loophole a drifting copy would slip through.
  let semidiurnal = 0.0;
  let diurnal = 0.0;
  let longPeriod = 0.0;
  for (let i = 0; i < station.constituents.length; i++) {
    const constituent = station.constituents[i];
    const amplitude = station.amplitudeM[i];
    if (!(amplitude !== 0.0)) {
      continue;
    }
    const nodal = TidalConstituents.nodalCorrection(
      constituent,
      args.node,
      nodalScratch,
    );
    const v = TidalConstituents.astronomicalArgument(constituent, args);
    const term =
      nodal.f * amplitude * Math.cos(v + nodal.u - station.phaseLagRadians[i]);
    if (constituent.species === TidalConstituents.SPECIES_SEMIDIURNAL) {
      semidiurnal += term;
    } else if (constituent.species === TidalConstituents.SPECIES_DIURNAL) {
      diurnal += term;
    } else {
      longPeriod += term;
    }
  }
  return semidiurnal + diurnal + longPeriod;
}

// ───────────────────── fundamental arguments: known answers ────────────────

test("fundamental arguments reproduce the published J2000.0 mean elements", () => {
  // J2000.0 is 2000-01-01 12:00:00 TT, i.e. TAI = TT - 32.184 s. Constructing
  // it in TAI directly is the only way to hit T = 0 exactly; going through a
  // UTC ISO string lands 32.184 s + leap seconds away.
  const j2000 = new JulianDate(
    TidalArguments.J2000_DAY_NUMBER,
    -TidalArguments.TT_MINUS_TAI_SECONDS,
    TimeStandard.TAI,
  );
  const args = TidalArguments.compute(j2000);
  assert.equal(args.valid, true);
  assert.ok(
    Math.abs(args.julianCenturiesTt) < 1e-12,
    `T must be exactly 0 at J2000.0 TT, got ${args.julianCenturiesTt}`,
  );
  for (const [name, expected] of Object.entries(J2000_ARGUMENT_DEGREES)) {
    const got = args[name] * RADIANS_TO_DEGREES;
    assert.ok(
      Math.abs(wrap180(got - expected)) <= TOLERANCE.J2000_ARGUMENT_DEGREES,
      `${name} = ${got.toFixed(6)} deg, published ${expected} deg`,
    );
  }
  // N' is the NEGATED node. Getting this backwards silently reverses every
  // nodal-argument constituent's slow drift.
  assert.ok(
    Math.abs(
      wrap180(
        args.nPrime * RADIANS_TO_DEGREES + args.node * RADIANS_TO_DEGREES,
      ),
    ) < 1e-9,
    "N' must be -Omega",
  );
  assert.deepEqual(
    args.doodson,
    [args.tau, args.s, args.h, args.p, args.nPrime, args.ps],
    "the doodson array must mirror the named fields",
  );
  // Degenerate input is zeroed, not NaN.
  const empty = TidalArguments.compute(undefined);
  assert.equal(empty.valid, false);
  assert.equal(empty.tau, 0);
});

test("a non-finite JulianDate is rejected, not propagated as a NaN tide", () => {
  // `clock.multiplier = NaN; clock.tick()` produces a JulianDate with NaN
  // components through the ordinary public API. A definedness-only guard let it
  // through and returned `valid: true` with every angle NaN, which
  // HarmonicTideModel.predict (which trusts `valid`) turned into
  // `{heightM: NaN, valid: true}` — and a NaN anchor height is a VANISHED ocean
  // patch, not a visibly wrong one. The documented invariant is that `valid`
  // false implies every angle is 0, so it has to hold for NaN too.
  const station = HarmonicTideModel.equilibriumStation(0.3, 0.4);
  const good = iso("2026-07-03T00:00:00Z");
  assert.equal(TidalArguments.compute(good).valid, true);
  assert.ok(Number.isFinite(HarmonicTideModel.predict(good, station).heightM));

  for (const [label, patch] of [
    ["NaN secondsOfDay", { secondsOfDay: NaN }],
    ["NaN dayNumber", { dayNumber: NaN }],
    ["Infinity secondsOfDay", { secondsOfDay: Infinity }],
    ["-Infinity dayNumber", { dayNumber: -Infinity }],
  ]) {
    const broken = Object.assign(
      JulianDate.clone(good, new JulianDate()),
      patch,
    );
    const args = TidalArguments.compute(broken);
    assert.equal(args.valid, false, `${label}: valid`);
    for (const field of ["tau", "s", "h", "p", "nPrime", "ps", "node"]) {
      assert.equal(args[field], 0, `${label}: ${field} must be exactly 0`);
    }
    const result = HarmonicTideModel.predict(broken, station);
    assert.equal(result.valid, false, `${label}: predict valid`);
    assert.equal(result.heightM, 0, `${label}: predict heightM`);
  }
});

test("fundamental-argument rates are the published Doodson rates", () => {
  // Derived from the mean-element polynomials' linear coefficients, NOT
  // tabulated — so this is a test of the polynomials.
  const rates = TidalArguments.RATES_DEGREES_PER_HOUR;
  assert.equal(rates.length, 6);
  const names = ["tau", "s", "h", "p", "N'", "ps"];
  for (let i = 0; i < 6; i++) {
    assert.ok(
      Math.abs(rates[i] - FUNDAMENTAL_RATE_DEGREES_PER_HOUR[i]) <=
        TOLERANCE.RATE_DEGREES_PER_HOUR,
      `${names[i]} rate ${rates[i]} vs published ${FUNDAMENTAL_RATE_DEGREES_PER_HOUR[i]}`,
    );
    assert.ok(
      rates[i] > 0,
      `${names[i]} rate must be positive (Doodson's convention)`,
    );
  }
  // The radians/second mirror must be the same numbers.
  for (let i = 0; i < 6; i++) {
    assert.ok(
      Math.abs(
        TidalArguments.RATES_RADIANS_PER_SECOND[i] -
          (rates[i] * DEGREES_TO_RADIANS) / 3600.0,
      ) < 1e-18,
    );
  }
});

test("tau + s - 180 deg reproduces this engine's own IAU-82 GMST, with no drift", () => {
  // The strongest available external check on the time base: Transforms
  // computes GMST from a completely different published polynomial. A constant
  // offset is the equinox-definition difference and is expected; DRIFT would
  // mean a rate error in the mean-element polynomials or a broken TT/UT1 split.
  const matrix = new Matrix3();
  const offsets = [];
  for (const stamp of [
    "2000-01-01T12:00:00Z",
    "2010-06-15T03:20:00Z",
    "2016-03-01T06:00:00Z",
    "2024-04-08T18:21:00Z",
    "2026-07-03T00:00:00Z",
    "2035-11-19T17:43:00Z",
  ]) {
    const time = iso(stamp);
    Transforms.computeTemeToPseudoFixedMatrix(time, matrix);
    const engineGmst = wrap360(
      Math.atan2(matrix[3], matrix[0]) * RADIANS_TO_DEGREES,
    );
    const args = TidalArguments.compute(time);
    const mine =
      TidalArguments.greenwichMeanSiderealTime(args) * RADIANS_TO_DEGREES;
    const offset = wrap180(mine - engineGmst);
    assert.ok(
      Math.abs(offset) <= TOLERANCE.GMST_OFFSET_DEGREES,
      `${stamp}: GMST differs by ${offset.toFixed(5)} deg`,
    );
    offsets.push(offset);
  }
  const spread = Math.max(...offsets) - Math.min(...offsets);
  assert.ok(
    spread <= TOLERANCE.GMST_DRIFT_DEGREES,
    `the GMST offset drifts by ${spread.toExponential(3)} deg across 35 years — that is a rate error, not a convention difference`,
  );
});

test("the mean sub-lunar longitude identity holds against the real ephemeris", () => {
  // pi - tau IS where the MEAN Moon is. The true Moon departs from it by the
  // classical perturbation budget — equation of centre 6.29 deg, evection
  // 1.27 deg, variation 0.66 deg — plus the reduction to the equator (the
  // ecliptic-to-equatorial longitude difference, up to ~2.5 deg), so roughly
  // 11 deg of headroom before anything is wrong. Measured worst case over 8.2
  // years of 3.6-hour samples: 12.10 deg (2027-07-27), minimum 0.0007 deg.
  // Restoring that departure is exactly what N2/Q1 and the rest of the
  // development do; a model where the two agreed EXACTLY would be one where
  // the "ephemeris" was secretly the mean element.
  const moon = new Cartesian3();
  let worst = 0;
  let smallest = Infinity;
  for (let k = 0; k < 400; k++) {
    const time = after(iso("2026-01-01T00:00:00Z"), k * 53040);
    TideModel.computeMoonPositionFixed(time, moon);
    const trueLongitude = wrap360(
      Math.atan2(moon.y, moon.x) * RADIANS_TO_DEGREES,
    );
    const args = TidalArguments.compute(time);
    const meanLongitude =
      TidalArguments.meanSubLunarLongitude(args) * RADIANS_TO_DEGREES;
    const departure = Math.abs(wrap180(meanLongitude - trueLongitude));
    worst = Math.max(worst, departure);
    smallest = Math.min(smallest, departure);
  }
  assert.ok(
    worst < 14.0,
    `mean sub-lunar longitude departs from the ephemeris by ${worst.toFixed(2)} deg — beyond the lunar perturbation budget`,
  );
  assert.ok(
    worst > 5.0,
    `only ${worst.toFixed(2)} deg of departure — the MEAN moon must not track the TRUE moon this closely, so one of the two is not what it claims`,
  );
  assert.ok(
    smallest < 0.5,
    `the two never came within ${smallest.toFixed(2)} deg — a constant offset would mean a frame or epoch error, not a perturbation`,
  );
  assert.equal(TidalArguments.meanSubLunarLongitude(undefined), 0);
});

// ───────────────────────── the constituent table ───────────────────────────

test("constituent speeds are the NOAA CO-OPS published values", () => {
  assert.equal(TidalConstituents.ALL.length, 10);
  assert.equal(TidalConstituents.PRIMARY.length, 8);
  for (const constituent of TidalConstituents.ALL) {
    const published = NOAA_SPEED_DEGREES_PER_HOUR[constituent.id];
    assert.ok(
      published !== undefined,
      `no published speed for ${constituent.id}`,
    );
    assert.ok(
      Math.abs(constituent.speedDegreesPerHour - published) <=
        TOLERANCE.SPEED_DEGREES_PER_HOUR,
      `${constituent.id}: ${constituent.speedDegreesPerHour.toFixed(8)} vs NOAA ${published}`,
    );
    assert.ok(
      Math.abs(
        constituent.periodSeconds -
          (360.0 / constituent.speedDegreesPerHour) * 3600.0,
      ) < 1e-6,
    );
    assert.equal(constituent.species, constituent.doodson[0]);
  }
  // S2 is exactly the solar day by construction — a floating-point 30.000000001
  // would mean the h and s rates are not exactly complementary.
  assert.ok(
    Math.abs(TidalConstituents.S2.speedDegreesPerHour - 30.0) < 1e-9,
    "S2 must be exactly 30 deg/h",
  );
  // M2 must agree with the constant TideModel already ships.
  assert.ok(
    Math.abs(
      TidalConstituents.M2.speedDegreesPerHour -
        TideModel.M2_SPEED_DEGREES_PER_HOUR,
    ) <= TOLERANCE.SPEED_DEGREES_PER_HOUR,
    "the two modules must not disagree about M2",
  );
});

test("Doodson numbers print as the published table", () => {
  const expected = {
    M2: "255.555",
    S2: "273.555",
    N2: "245.655",
    K2: "275.555",
    K1: "165.555",
    O1: "145.555",
    P1: "163.555",
    Q1: "135.655",
    Mf: "075.555",
    Mm: "065.455",
  };
  for (const constituent of TidalConstituents.ALL) {
    assert.equal(
      TidalConstituents.doodsonNumber(constituent),
      expected[constituent.id],
      constituent.id,
    );
  }
  assert.equal(TidalConstituents.doodsonNumber(undefined), "");
});

test("fromId resolves EVERY constituent in EVERY casing", () => {
  // Regression gate. The lookup map was keyed on the canonical `c.id` while the
  // getter upper-cases its argument, so the two mixed-case ids ("Mf", "Mm")
  // were unreachable under every casing — and the only consumer that notices is
  // TideConstituentGrid's constructor, which throws DeveloperError (outside the
  // debug pragmas, so in release too) on any atlas baked with `--all`. Testing
  // one lowercase id, as this spec originally did, could never see it.
  const missed = [];
  for (const constituent of TidalConstituents.ALL) {
    for (const casing of [
      constituent.id,
      constituent.id.toUpperCase(),
      constituent.id.toLowerCase(),
    ]) {
      if (TidalConstituents.fromId(casing) !== constituent) {
        missed.push(casing);
      }
    }
  }
  assert.deepEqual(
    missed,
    [],
    `fromId failed to resolve: ${missed.join(", ")}`,
  );
  // At least one id must actually BE mixed case, or the gate is vacuous.
  assert.ok(
    TidalConstituents.ALL.some((c) => c.id !== c.id.toUpperCase()),
    "no mixed-case id in the table — this gate has nothing to catch",
  );
  assert.equal(TidalConstituents.fromId("ZZ"), undefined);
  assert.equal(TidalConstituents.fromId(7), undefined);
  assert.equal(TidalConstituents.fromId(undefined), undefined);
});

test("an atlas naming ANY known constituent loads through the real reader", () => {
  // The end-to-end consequence of the fromId defect: `--all` writes literal
  // "Mf"/"Mm" ids, and the reader rejected them. Every id the bake tool can
  // emit must construct.
  for (const constituent of TidalConstituents.ALL) {
    const buffer = buildAtlas({
      ids: ["M2", constituent.id],
      nx: 4,
      ny: 3,
      step: 120,
      fill: () => [1000, 0],
    });
    const grid = new TideConstituentGrid(buffer);
    assert.deepEqual(grid.constituentIds, ["M2", constituent.id]);
  }
});

test("equilibrium amplitudes hold the classic published ratios", () => {
  const a = (id) => TidalConstituents.fromId(id).equilibriumAmplitudeM;
  const near = (got, want, tol, label) =>
    assert.ok(
      Math.abs(got - want) <= tol,
      `${label}: ${got.toFixed(4)} vs published ${want}`,
    );
  near(a("S2") / a("M2"), PUBLISHED.RATIO_S2_M2, 0.005, "S2/M2 (solar/lunar)");
  near(a("N2") / a("M2"), PUBLISHED.RATIO_N2_M2, 0.005, "N2/M2");
  near(a("K2") / a("S2"), PUBLISHED.RATIO_K2_S2, 0.005, "K2/S2");
  near(a("K1") / a("O1"), PUBLISHED.RATIO_K1_O1, 0.005, "K1/O1");
  near(a("P1") / a("K1"), PUBLISHED.RATIO_P1_K1, 0.005, "P1/K1");
  near(a("Q1") / a("O1"), PUBLISHED.RATIO_Q1_O1, 0.005, "Q1/O1");
  // M2 must be the largest; a table sorted or scaled wrong shows up here.
  for (const constituent of TidalConstituents.ALL) {
    assert.ok(
      constituent.equilibriumAmplitudeM <=
        TidalConstituents.M2.equilibriumAmplitudeM,
      `${constituent.id} exceeds M2`,
    );
    assert.ok(constituent.equilibriumAmplitudeM > 0);
  }
});

test("the lunisolar split is reproducible from TideModel's own constants", () => {
  // K1 and K2 are forced by BOTH bodies at one frequency. The declinational
  // forcing scales as (GM/d^3)*sin(I)cos(I) for the diurnal band and
  // (GM/d^3)*sin^2(I) for the semidiurnal one. Recomputing here from
  // TideModel's constants — not from a second copy of them — is what makes the
  // literals in TidalConstituents.js a derivation rather than a guess.
  const meanSinSquaredLunarInclination =
    1.0 -
    (Math.cos(TideModel.OBLIQUITY) ** 2 *
      Math.cos(TideModel.LUNAR_ORBIT_INCLINATION) ** 2 +
      0.5 *
        Math.sin(TideModel.OBLIQUITY) ** 2 *
        Math.sin(TideModel.LUNAR_ORBIT_INCLINATION) ** 2);
  const sinI = Math.sqrt(meanSinSquaredLunarInclination);
  const cosI = Math.sqrt(1.0 - meanSinSquaredLunarInclination);
  const lunar = TideModel.GM_MOON / TideModel.MEAN_LUNAR_DISTANCE ** 3;
  const solar = TideModel.GM_SUN / TideModel.ASTRONOMICAL_UNIT ** 3;
  const diurnalLunar = lunar * sinI * cosI;
  const diurnalSolar =
    solar * Math.sin(TideModel.OBLIQUITY) * Math.cos(TideModel.OBLIQUITY);
  const semidiurnalLunar = lunar * meanSinSquaredLunarInclination;
  const semidiurnalSolar = solar * Math.sin(TideModel.OBLIQUITY) ** 2;

  assert.ok(
    Math.abs(
      TidalConstituents.K1.lunarFraction -
        diurnalLunar / (diurnalLunar + diurnalSolar),
    ) < 0.002,
    `K1 lunar fraction ${TidalConstituents.K1.lunarFraction} vs derived ${(diurnalLunar / (diurnalLunar + diurnalSolar)).toFixed(4)}`,
  );
  assert.ok(
    Math.abs(
      TidalConstituents.K2.lunarFraction -
        semidiurnalLunar / (semidiurnalLunar + semidiurnalSolar),
    ) < 0.002,
    `K2 lunar fraction ${TidalConstituents.K2.lunarFraction} vs derived ${(semidiurnalLunar / (semidiurnalLunar + semidiurnalSolar)).toFixed(4)}`,
  );
  assert.equal(TidalConstituents.M2.lunarFraction, 1.0);
  assert.equal(TidalConstituents.S2.lunarFraction, 0.0);
  assert.equal(TidalConstituents.P1.lunarFraction, 0.0);
  assert.equal(TidalConstituents.K1.origin, TidalConstituents.ORIGIN_LUNISOLAR);
  assert.equal(TidalConstituents.S2.origin, TidalConstituents.ORIGIN_SOLAR);
});

test("species latitude factors have the right shape and the right SIGNS", () => {
  const f = (species, latDegrees) =>
    TidalConstituents.speciesFactor(species, latDegrees * DEGREES_TO_RADIANS);
  // Semidiurnal: peaks at the equator, vanishes at the poles, never negative.
  assert.ok(Math.abs(f(2, 0) - 1) < 1e-12);
  assert.ok(Math.abs(f(2, 90)) < 1e-12);
  assert.ok(Math.abs(f(2, 45) - 0.5) < 1e-12);
  assert.ok(
    Math.abs(f(2, -30) - f(2, 30)) < 1e-12,
    "symmetric about the equator",
  );
  // Diurnal: peaks at 45 deg and CHANGES SIGN across the equator. The sign flip
  // is the diurnal inequality landing on opposite sides of the day in the two
  // hemispheres — an abs() here would be a real, subtle bug.
  assert.ok(Math.abs(f(1, 45) - 1) < 1e-12);
  assert.ok(Math.abs(f(1, 0)) < 1e-12);
  assert.ok(
    f(1, -45) < 0,
    "the diurnal factor must be negative south of the equator",
  );
  assert.ok(Math.abs(f(1, -45) + f(1, 45)) < 1e-12);
  // Long period: (1 - 3 sin^2 phi) / 2, i.e. +1/2 at the equator and -1 at
  // either pole. That is MINUS P2(sin phi); the sign lives here so the
  // amplitude table can stay positive, and it is the branch that was chosen by
  // measurement against the geometric tide, not by preference.
  assert.ok(Math.abs(f(0, 0) - 0.5) < 1e-12);
  assert.ok(Math.abs(f(0, 90) + 1) < 1e-12);
  assert.ok(Math.abs(f(0, -90) + 1) < 1e-12);
  assert.ok(f(0, 0) > 0 && f(0, 90) < 0, "the long-period factor changes sign");
  // It vanishes at the 35.26 deg latitude where P2(sin phi) does.
  assert.ok(
    Math.abs(f(0, Math.asin(Math.sqrt(1 / 3)) * RADIANS_TO_DEGREES)) < 1e-12,
  );
  assert.equal(TidalConstituents.speciesFactor(2, NaN), 0);
});

// ─────────────── the harmonic engine vs the geometric ephemeris ────────────

/**
 * A year of the geometric (TideModel) time-varying tide and the harmonic
 * reconstruction at a site, sampled hourly.
 */
function yearSeries(site, startIso) {
  const epoch = iso(startIso);
  const station = HarmonicTideModel.equilibriumStation(
    site.longitude,
    site.geocentricLatitude,
  );
  const geometric = [];
  const harmonic = [];
  const geometricResult = TideModel.createResult();
  const harmonicResult = HarmonicTideModel.createResult();
  for (let i = 0; i < 365 * 24; i++) {
    const time = after(epoch, i * 3600);
    TideModel.evaluate(time, site.position, geometricResult);
    // The permanent tide is zero-frequency and has no constituent, so it is
    // excluded from BOTH sides rather than being fudged into one.
    geometric.push(geometricResult.lunarM + geometricResult.solarM);
    harmonic.push(
      HarmonicTideModel.predict(time, station, harmonicResult).heightM,
    );
  }
  return { geometric, harmonic, station };
}

test("the harmonic reconstruction agrees with the geometric ephemeris tide", () => {
  // Two independent computations of the same physics: one sums a truncated
  // Doodson development against mean-element polynomials, the other evaluates
  // P2(cos psi) against Simon-1994 Cartesian vectors rotated to ECEF. They only
  // agree if the arguments, the Doodson numbers, the phase offsets, the species
  // factors, the longitude convention AND the time-scale bridge are all right.
  for (const startIso of ["2016-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]) {
    for (const site of SITES) {
      const { geometric, harmonic } = yearSeries(site, startIso);
      const stats = compareSeries(geometric, harmonic);
      const label = `${startIso} lat ${(site.geocentricLatitude * RADIANS_TO_DEGREES).toFixed(1)}`;
      assert.ok(
        stats.correlation >= TOLERANCE.HARMONIC_CORRELATION_MIN,
        `${label}: correlation ${stats.correlation.toFixed(5)}`,
      );
      assert.ok(
        stats.residualFraction <= TOLERANCE.HARMONIC_RESIDUAL_FRACTION_MAX,
        `${label}: demeaned residual ${(100 * stats.residualFraction).toFixed(1)}% of signal RMS`,
      );
      // The amplitudes must match too — a correlation of 1 with half the
      // amplitude would pass the check above and be a broken tide.
      const harmonicStats = compareSeries(harmonic, harmonic);
      assert.ok(
        Math.abs(
          harmonicStats.standardDeviation / stats.standardDeviation - 1,
        ) < 0.1,
        `${label}: harmonic RMS is ${(harmonicStats.standardDeviation / stats.standardDeviation).toFixed(3)}x the geometric one`,
      );
    }
  }
});

test("the equilibrium station and the direct equilibrium call are one code path", () => {
  const site = SITES[1];
  const station = HarmonicTideModel.equilibriumStation(
    site.longitude,
    site.geocentricLatitude,
  );
  const time = iso("2026-07-03T05:00:00Z");
  assert.equal(
    HarmonicTideModel.predict(time, station).heightM,
    HarmonicTideModel.equilibriumHeight(
      time,
      site.longitude,
      site.geocentricLatitude,
    ),
    "the convenience wrapper must be the station path, bit for bit",
  );
  // Amplitudes are non-negative and a negative species factor becomes a
  // half-turn of phase, not a negative amplitude — otherwise a station cannot
  // be compared with or blended against an atlas sample.
  const south = HarmonicTideModel.equilibriumStation(
    0.3,
    -40.0 * DEGREES_TO_RADIANS,
  );
  for (let i = 0; i < south.amplitudeM.length; i++) {
    assert.ok(
      south.amplitudeM[i] >= 0,
      `${south.constituents[i].id} amplitude`,
    );
    assert.ok(
      south.phaseLagRadians[i] >= 0 && south.phaseLagRadians[i] < 2 * Math.PI,
    );
  }
  assert.equal(south.coverage, 1.0);
  assert.equal(south.source, HarmonicTideModel.SOURCE_EQUILIBRIUM);
  // Degenerate inputs are exactly zero, never NaN.
  const bad = HarmonicTideModel.equilibriumStation(NaN, 0.0);
  assert.equal(bad.valid, false);
  assert.equal(HarmonicTideModel.predict(time, bad).heightM, 0);
  assert.equal(HarmonicTideModel.predict(undefined, station).heightM, 0);
  assert.equal(HarmonicTideModel.predict(time, undefined).heightM, 0);
  // The species split must add up.
  const result = HarmonicTideModel.predict(time, station);
  assert.ok(
    Math.abs(
      result.heightM -
        (result.semidiurnalM + result.diurnalM + result.longPeriodM),
    ) < 1e-15,
  );
  assert.ok(result.semidiurnalM !== 0 && result.diurnalM !== 0);
});

test("the spec's summation helper IS HarmonicTideModel.predict", () => {
  // Everything the negative controls below prove depends on this. If the helper
  // and the engine ever diverge, the controls are testing the helper.
  const site = SITES[3];
  const station = HarmonicTideModel.equilibriumStation(
    site.longitude,
    site.geocentricLatitude,
  );
  for (let i = 0; i < 24; i++) {
    const time = after(iso("2026-03-05T00:00:00Z"), i * 3271);
    const args = TidalArguments.compute(time);
    assert.equal(
      predictWithArguments(args, station),
      HarmonicTideModel.predict(time, station).heightM,
      `sample ${i}`,
    );
  }
});

// ───────────────────────── T6: alignment with the Moon ─────────────────────

/**
 * Longitudes of the equilibrium high-water bulges around the equator, and the
 * ephemeris sub-lunar longitude, at one instant.
 */
function bulgeSample(time) {
  const moon = new Cartesian3();
  TideModel.computeMoonPositionFixed(time, moon);
  const subLunarDegrees = wrap360(
    Math.atan2(moon.y, moon.x) * RADIANS_TO_DEGREES,
  );
  const scratchPosition = new Cartesian3();
  const scratchResult = TideModel.createResult();
  const geometric = ringMaximumLongitudes((longitudeDegrees) => {
    ellipsoid.cartographicToCartesian(
      Cartographic.fromDegrees(longitudeDegrees, 0, 0),
      scratchPosition,
    );
    // The LUNAR term alone: the solar bulge would otherwise pull the total's
    // maximum off the Moon by design, and this gate is about the Moon.
    return TideModel.evaluate(time, scratchPosition, scratchResult).lunarM;
  }, 720);
  return { subLunarDegrees, geometric };
}

test("T6: the equilibrium bulge tracks the sub-lunar point, and its ANTIPODE", () => {
  // A model that produced only ONE bulge would pass every period, spring/neap
  // and nodal test in this file. The antipodal assertion is what catches it.
  let worstBulge = 0;
  let worstAntipodal = 0;
  let samples = 0;
  for (let k = 0; k < 120; k++) {
    const time = after(iso("2026-01-01T00:00:00Z"), k * 88400);
    const { subLunarDegrees, geometric } = bulgeSample(time);
    assert.equal(
      geometric.length,
      2,
      `${k}: the lunar equilibrium tide must have exactly two equatorial bulges, found ${geometric.length}`,
    );
    worstBulge = Math.max(
      worstBulge,
      nearestLongitudeError(geometric, subLunarDegrees),
      nearestLongitudeError(geometric, subLunarDegrees + 180.0),
    );
    worstAntipodal = Math.max(
      worstAntipodal,
      Math.abs(Math.abs(wrap180(geometric[0] - geometric[1])) - 180.0),
    );
    samples++;
  }
  assert.equal(samples, 120);
  assert.ok(
    worstBulge <= TOLERANCE.GEOMETRIC_BULGE_DEGREES,
    `worst bulge/sub-lunar separation ${worstBulge.toFixed(4)} deg`,
  );
  assert.ok(
    worstAntipodal <= TOLERANCE.ANTIPODAL_DEGREES,
    `the two bulges are ${(180 + worstAntipodal).toFixed(4)} deg apart, not 180`,
  );
});

test("T6: the HARMONIC lunar subset also tracks the Moon, to its truncation limit", () => {
  // Same gate against the constituent engine. The tolerance is larger and
  // stated: four lunar constituents carry the equation of centre but not
  // evection or variation, so a few degrees of lag/lead is the honest floor.
  const scratchStation = HarmonicTideModel.createStation(
    TidalConstituents.ALL.filter((c) => c.lunarFraction > 0),
  );
  let worst = 0;
  for (let k = 0; k < 120; k++) {
    const time = after(iso("2026-01-01T00:00:00Z"), k * 88400);
    const args = TidalArguments.compute(time);
    const { subLunarDegrees } = bulgeSample(time);
    const harmonic = ringMaximumLongitudes((longitudeDegrees) => {
      HarmonicTideModel.equilibriumStation(
        longitudeDegrees * DEGREES_TO_RADIANS,
        0.0,
        scratchStation,
      );
      // Scale each amplitude by its lunar share so the solar bulge is removed
      // from the lunisolar constituents rather than the whole constituent.
      for (let i = 0; i < scratchStation.constituents.length; i++) {
        scratchStation.amplitudeM[i] *=
          scratchStation.constituents[i].lunarFraction;
      }
      return predictWithArguments(args, scratchStation);
    }, 720);
    assert.equal(
      harmonic.length,
      2,
      `${k}: two bulges, found ${harmonic.length}`,
    );
    worst = Math.max(
      worst,
      nearestLongitudeError(harmonic, subLunarDegrees),
      nearestLongitudeError(harmonic, subLunarDegrees + 180.0),
    );
  }
  assert.ok(
    worst <= TOLERANCE.HARMONIC_BULGE_DEGREES,
    `worst harmonic bulge/sub-lunar separation ${worst.toFixed(3)} deg`,
  );
  assert.ok(
    worst > 0.2,
    `only ${worst.toFixed(3)} deg — a truncated development CANNOT match the true Moon exactly, so this looks like the harmonic ring is secretly the geometric one`,
  );
});

test("T6: successive high waters drift ~50 minutes per day over a long window", () => {
  // The drift is measured as a least-squares slope over 120 days of high
  // waters, not from one interval: individual intervals swing +-0.1 h with the
  // Moon's orbital speed, so a single-interval assertion would be noise.
  const site = SITES[0];
  const epoch = iso("2026-07-03T00:00:00Z");
  const dt = 120;
  const days = 120;
  const scratchResult = TideModel.createResult();
  const values = [];
  for (let i = 0; i < (days * 86400) / dt; i++) {
    TideModel.evaluate(after(epoch, i * dt), site.position, scratchResult);
    values.push(scratchResult.lunarM);
  }
  const highs = maximumTimes(values, dt);
  assert.ok(
    highs.length > 220,
    `${highs.length} high waters over ${days} days`,
  );
  const meanPeriodHours = leastSquaresSlope(highs) / 3600.0;
  assert.ok(
    Math.abs(meanPeriodHours - PUBLISHED.M2_PERIOD_HOURS) < 0.01,
    `mean semidiurnal period ${meanPeriodHours.toFixed(5)} h vs published M2 ${PUBLISHED.M2_PERIOD_HOURS.toFixed(5)} h`,
  );
  const dailyLagMinutes = (2.0 * meanPeriodHours - 24.0) * 60.0;
  assert.ok(
    Math.abs(dailyLagMinutes - PUBLISHED.DAILY_LAG_MINUTES) <=
      TOLERANCE.DAILY_LAG_MINUTES,
    `daily lag ${dailyLagMinutes.toFixed(2)} min vs published ${PUBLISHED.DAILY_LAG_MINUTES.toFixed(2)} min`,
  );
  // 12.00 h — a solar sinusoid, the failure this whole file exists to exclude —
  // would give a lag of exactly 0 and must be far outside the band.
  assert.ok(
    Math.abs(0 - PUBLISHED.DAILY_LAG_MINUTES) > TOLERANCE.DAILY_LAG_MINUTES,
    "the band must exclude a 12.00 h solar tide",
  );
  // And the drift must be a genuine accumulation: the last high water is more
  // than four days of lag away from a pure 12.00 h schedule.
  const drift =
    (highs[highs.length - 1] - highs[0]) / 3600.0 - 12.0 * (highs.length - 1);
  assert.ok(
    drift > 60.0,
    `only ${drift.toFixed(1)} h of accumulated drift against a 12.00 h clock over ${days} days`,
  );
});

// ─────────────────────────── spring / neap ─────────────────────────────────

const eclipticScratchMoon = new Cartesian3();
const eclipticScratchSun = new Cartesian3();
/** Sun-Moon difference in ECLIPTIC longitude — the quantity lunar phase is defined by. */
function phaseAngleDegrees(time) {
  Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
    time,
    eclipticScratchMoon,
  );
  Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
    time,
    eclipticScratchSun,
  );
  const cosObliquity = Math.cos(TideModel.OBLIQUITY);
  const sinObliquity = Math.sin(TideModel.OBLIQUITY);
  const eclipticLongitude = (v) =>
    Math.atan2(v.y * cosObliquity + v.z * sinObliquity, v.x);
  return wrap360(
    (eclipticLongitude(eclipticScratchMoon) -
      eclipticLongitude(eclipticScratchSun)) *
      RADIANS_TO_DEGREES,
  );
}

/** The instants in a window where the phase angle crosses each quarter. */
function findPhases(startIso, days) {
  const start = iso(startIso);
  const dt = 600;
  const found = [];
  let previous = phaseAngleDegrees(start);
  for (let i = 1; i < (days * 86400) / dt; i++) {
    const time = after(start, i * dt);
    const current = phaseAngleDegrees(time);
    for (const target of [0, 90, 180, 270]) {
      const a = wrap180(previous - target);
      const b = wrap180(current - target);
      if (a < 0 && b >= 0 && Math.abs(b - a) < 10) {
        found.push({
          elongationDegrees: target,
          time: after(start, (i - 1 + -a / (b - a)) * dt),
        });
      }
    }
    previous = current;
  }
  return found;
}

test("spring and neap tides land on ephemeris-derived syzygy and quadrature", () => {
  // The phases are DERIVED from the same Simon-1994 ephemeris the tide runs on,
  // then checked against a published almanac so the derivation itself is
  // anchored. The 2024-04-08 new moon is the total solar eclipse.
  const phases = findPhases("2024-03-28T00:00:00Z", 31);
  for (const published of APRIL_2024_PHASES) {
    const match = phases.find(
      (p) => p.elongationDegrees === published.elongationDegrees,
    );
    assert.ok(match, `no ${published.name} found`);
    const errorMinutes =
      Math.abs(JulianDate.secondsDifference(match.time, iso(published.iso))) /
      60.0;
    assert.ok(
      errorMinutes <= TOLERANCE.PHASE_INSTANT_MINUTES,
      `${published.name}: derived ${JulianDate.toIso8601(match.time, 0)} vs published ${published.iso} (${errorMinutes.toFixed(1)} min)`,
    );
  }

  // Daily range at each derived phase instant, at an equatorial site so the
  // semidiurnal band dominates and the spring/neap envelope is unambiguous.
  const site = SITES[0];
  const dailyRange = (centre) => {
    const values = [];
    for (let i = 0; i <= 50; i++) {
      values.push(
        TideModel.equilibriumHeight(
          after(centre, (i - 25) * 1800),
          site.position,
        ),
      );
    }
    return rangeOf(values);
  };
  const rangeAt = {};
  for (const phase of phases) {
    rangeAt[phase.elongationDegrees] = dailyRange(phase.time);
  }
  const springs = [rangeAt[0], rangeAt[180]];
  const neaps = [rangeAt[90], rangeAt[270]];
  for (const spring of springs) {
    for (const neap of neaps) {
      assert.ok(
        spring > neap * 1.8,
        `spring range ${spring.toFixed(4)} m is not comfortably above neap ${neap.toFixed(4)} m`,
      );
    }
  }
  // Published equilibrium figures for reference: spring ~0.55 m, neap ~0.12 m.
  assert.ok(
    Math.min(...springs) > 0.4 && Math.max(...springs) < 0.75,
    `spring ranges ${springs.map((v) => v.toFixed(3)).join(", ")} m outside the equilibrium band`,
  );
  assert.ok(
    Math.max(...neaps) < 0.25,
    `neap ranges ${neaps.map((v) => v.toFixed(3)).join(", ")} m are too large for quadrature`,
  );
  // The spring-to-spring beat is half a synodic month.
  const syzygies = phases
    .filter((p) => p.elongationDegrees === 0 || p.elongationDegrees === 180)
    .map((p) => p.time);
  assert.ok(syzygies.length >= 2);
  const beatDays =
    Math.abs(JulianDate.secondsDifference(syzygies[1], syzygies[0])) / 86400.0;
  assert.ok(
    Math.abs(beatDays - PUBLISHED.SYNODIC_MONTH_DAYS / 2) < 1.0,
    `spring-to-spring ${beatDays.toFixed(2)} d vs half a synodic month ${(PUBLISHED.SYNODIC_MONTH_DAYS / 2).toFixed(2)} d`,
  );
});

// ───────────────────────────── the nodal cycle ─────────────────────────────

test("the M2 nodal factor stays inside its published band and returns to unity", () => {
  const nodal = TidalConstituents.createNodalResult();
  let minimum = Infinity;
  let maximum = -Infinity;
  let minimumNode = 0;
  let maximumNode = 0;
  for (let i = 0; i <= 3600; i++) {
    const node = (i / 3600) * 2 * Math.PI;
    TidalConstituents.nodalCorrection(TidalConstituents.M2, node, nodal);
    if (nodal.f < minimum) {
      minimum = nodal.f;
      minimumNode = i / 10;
    }
    if (nodal.f > maximum) {
      maximum = nodal.f;
      maximumNode = i / 10;
    }
  }
  assert.ok(
    Math.abs(minimum - PUBLISHED.M2_NODAL_FACTOR_MIN) < 0.001,
    `f(M2) minimum ${minimum.toFixed(5)} vs published ${PUBLISHED.M2_NODAL_FACTOR_MIN}`,
  );
  assert.ok(
    Math.abs(maximum - PUBLISHED.M2_NODAL_FACTOR_MAX) < 0.001,
    `f(M2) maximum ${maximum.toFixed(5)} vs published ${PUBLISHED.M2_NODAL_FACTOR_MAX}`,
  );
  assert.ok(
    minimumNode < 1 || minimumNode > 359,
    `minimum at Omega = ${minimumNode} deg, expected 0`,
  );
  assert.ok(
    Math.abs(maximumNode - 180) < 1,
    `maximum at Omega = ${maximumNode} deg, expected 180`,
  );
  // Unity at the quadrature nodes — the "returns near unity at the stated node"
  // property. f = 1.0004 - 0.0373 cos(Omega) + 0.0002 cos(2 Omega) is 1.0002 at
  // both, i.e. within 2e-4 of unity.
  for (const degrees of [90, 270]) {
    TidalConstituents.nodalCorrection(
      TidalConstituents.M2,
      degrees * DEGREES_TO_RADIANS,
      nodal,
    );
    assert.ok(
      Math.abs(nodal.f - 1.0) < 1.0e-3,
      `f(M2) at Omega = ${degrees} deg is ${nodal.f.toFixed(6)}`,
    );
  }
  // u is odd in Omega and vanishes at the syzygy nodes.
  for (const degrees of [0, 180]) {
    TidalConstituents.nodalCorrection(
      TidalConstituents.M2,
      degrees * DEGREES_TO_RADIANS,
      nodal,
    );
    assert.ok(Math.abs(nodal.u) < 1e-12, `u(M2) at Omega = ${degrees} deg`);
  }
  // Purely solar constituents are not modulated by the LUNAR node.
  for (const constituent of [TidalConstituents.S2, TidalConstituents.P1]) {
    TidalConstituents.nodalCorrection(constituent, 1.234, nodal);
    assert.equal(nodal.f, 1.0, `${constituent.id} f`);
    assert.equal(nodal.u, 0.0, `${constituent.id} u`);
  }
  assert.equal(TidalConstituents.nodalCorrection(undefined, 0).f, 1.0);
  assert.equal(
    TidalConstituents.nodalCorrection(TidalConstituents.M2, NaN).f,
    1.0,
  );
});

test("the nodal factor actually cycles over 18.6 years in real time", () => {
  // The table above is a function of Omega. This one proves Omega itself sweeps
  // a full turn in the published 18.61 years, so the modulation appears on the
  // real clock rather than only in a parameter sweep.
  const nodal = TidalConstituents.createNodalResult();
  const samples = [];
  for (let year = 2015; year <= 2035; year++) {
    const args = TidalArguments.compute(iso(`${year}-01-01T00:00:00Z`));
    TidalConstituents.nodalCorrection(TidalConstituents.M2, args.node, nodal);
    samples.push({ year, node: args.node * RADIANS_TO_DEGREES, f: nodal.f });
  }
  // Omega regresses, so consecutive samples decrease modulo 360 by one year's
  // worth of the published rate.
  const expectedStepDegrees =
    365.25 * 24 * TidalArguments.RATES_DEGREES_PER_HOUR[4];
  for (let i = 1; i < samples.length; i++) {
    const step = wrap360(samples[i - 1].node - samples[i].node);
    assert.ok(
      Math.abs(step - expectedStepDegrees) < 0.2,
      `${samples[i].year}: node stepped ${step.toFixed(3)} deg, expected ${expectedStepDegrees.toFixed(3)}`,
    );
  }
  const periodYears = 360.0 / expectedStepDegrees;
  assert.ok(
    Math.abs(periodYears - PUBLISHED.NODAL_PERIOD_YEARS) < 0.02,
    `nodal period ${periodYears.toFixed(4)} y vs published ${PUBLISHED.NODAL_PERIOD_YEARS} y`,
  );
  // And the factor really does sweep its whole band over the sampled window.
  const fs2 = samples.map((s) => s.f);
  assert.ok(
    Math.max(...fs2) - Math.min(...fs2) > 0.07,
    `f(M2) only varied by ${(Math.max(...fs2) - Math.min(...fs2)).toFixed(4)} over 20 years`,
  );
});

// ───────────────────── negative controls: do the gates bite? ───────────────

test("NEGATIVE CONTROL: dropping the nodal correction measurably degrades the fit", () => {
  // Establish the gate first, then break the input and show the SAME gate fails.
  const site = SITES[1];
  const epoch = iso("2016-01-01T00:00:00Z"); // Omega ~ 176 deg, f(M2) ~ 1.038
  const station = HarmonicTideModel.equilibriumStation(
    site.longitude,
    site.geocentricLatitude,
  );
  const geometric = [];
  const withNodal = [];
  const withoutNodal = [];
  const geometricResult = TideModel.createResult();
  const args = TidalArguments.createResult();
  for (let i = 0; i < 365 * 24; i++) {
    const time = after(epoch, i * 3600);
    TideModel.evaluate(time, site.position, geometricResult);
    geometric.push(geometricResult.lunarM + geometricResult.solarM);
    TidalArguments.compute(time, args);
    withNodal.push(predictWithArguments(args, station));
    // Break exactly one thing: pin the node where f = 1 and u = 0 for every
    // constituent, which is what "no nodal correction" means.
    const savedNode = args.node;
    args.node = 90.0 * DEGREES_TO_RADIANS;
    const nodalOff = predictWithArguments(args, station);
    args.node = savedNode;
    withoutNodal.push(nodalOff);
  }
  const good = compareSeries(geometric, withNodal);
  const bad = compareSeries(geometric, withoutNodal);
  assert.ok(
    good.residualFraction <= TOLERANCE.HARMONIC_RESIDUAL_FRACTION_MAX,
    `baseline residual ${(100 * good.residualFraction).toFixed(1)}% must pass first`,
  );
  assert.ok(
    bad.residualFraction > good.residualFraction * 1.4,
    `dropping the nodal correction only moved the residual ${(100 * good.residualFraction).toFixed(1)}% -> ${(100 * bad.residualFraction).toFixed(1)}% — the gate has no teeth`,
  );
  assert.ok(
    bad.residualFraction > TOLERANCE.HARMONIC_RESIDUAL_FRACTION_MAX,
    `the residual gate must FAIL without the nodal correction; it read ${(100 * bad.residualFraction).toFixed(1)}%`,
  );
});

test("NEGATIVE CONTROL: the noon-origin half-turn in tau inverts the diurnal band only", () => {
  // JulianDate.secondsOfDay runs from NOON, so tau carries a +180 deg term.
  // Dropping it is a 180 deg error that DOUBLES to 360 for every semidiurnal
  // constituent — invisible at the equator — while INVERTING every diurnal one.
  // This is the trap that motivated the equator-plus-mid-latitude site set.
  const epoch = iso("2026-01-01T00:00:00Z");
  const perturbTau = (args) => {
    args.tau =
      wrap360(args.tau * RADIANS_TO_DEGREES + 180.0) * DEGREES_TO_RADIANS;
    args.doodson[0] = args.tau;
  };
  const measure = (site, perturb) => {
    const station = HarmonicTideModel.equilibriumStation(
      site.longitude,
      site.geocentricLatitude,
    );
    const geometric = [];
    const harmonic = [];
    const geometricResult = TideModel.createResult();
    const args = TidalArguments.createResult();
    for (let i = 0; i < 60 * 24; i++) {
      const time = after(epoch, i * 3600);
      TideModel.evaluate(time, site.position, geometricResult);
      geometric.push(geometricResult.lunarM + geometricResult.solarM);
      TidalArguments.compute(time, args);
      if (perturb) {
        perturbTau(args);
      }
      harmonic.push(predictWithArguments(args, station));
    }
    return compareSeries(geometric, harmonic);
  };

  const equator = SITES[0];
  const midLatitude = SITES[1];
  // Baseline: both pass.
  assert.ok(
    measure(equator, false).correlation >= TOLERANCE.HARMONIC_CORRELATION_MIN,
  );
  assert.ok(
    measure(midLatitude, false).correlation >=
      TOLERANCE.HARMONIC_CORRELATION_MIN,
  );
  // Perturbed: the equator BARELY notices — which is the danger — while the
  // mid-latitude gate fails outright.
  const brokenEquator = measure(equator, true);
  const brokenMidLatitude = measure(midLatitude, true);
  assert.ok(
    brokenEquator.correlation >= TOLERANCE.HARMONIC_CORRELATION_MIN,
    `the equatorial gate SHOULD survive the half-turn (it read ${brokenEquator.correlation.toFixed(5)}) — that is why it cannot be the only site`,
  );
  assert.ok(
    brokenMidLatitude.correlation < TOLERANCE.HARMONIC_CORRELATION_MIN,
    `the mid-latitude gate must FAIL on the half-turn; it read ${brokenMidLatitude.correlation.toFixed(5)}`,
  );
  assert.ok(
    brokenMidLatitude.correlation < 0.5,
    `a 180 deg tau error should collapse the diurnal band, not shave it (${brokenMidLatitude.correlation.toFixed(5)})`,
  );
});

test("NEGATIVE CONTROL: freezing tau breaks the Moon-alignment gate", () => {
  // If the tide stopped advancing with Earth rotation — a stale uniform, a
  // frozen clock, a wall-clock fallback — the bulge would sit still while the
  // Moon moved. The alignment gate must catch that.
  const frozen = TidalArguments.compute(iso("2026-04-01T00:00:00Z"));
  const station = HarmonicTideModel.createStation(
    TidalConstituents.ALL.filter((c) => c.lunarFraction > 0),
  );
  const args = TidalArguments.createResult();
  let worstLive = 0;
  let worstFrozen = 0;
  for (let k = 0; k < 12; k++) {
    const time = after(iso("2026-04-01T00:00:00Z"), k * 21600);
    const { subLunarDegrees } = bulgeSample(time);
    TidalArguments.compute(time, args);
    const ring = (useFrozenTau) =>
      ringMaximumLongitudes((longitudeDegrees) => {
        HarmonicTideModel.equilibriumStation(
          longitudeDegrees * DEGREES_TO_RADIANS,
          0.0,
          station,
        );
        for (let i = 0; i < station.constituents.length; i++) {
          station.amplitudeM[i] *= station.constituents[i].lunarFraction;
        }
        const savedTau = args.tau;
        if (useFrozenTau) {
          args.tau = frozen.tau;
          args.doodson[0] = frozen.tau;
        }
        const value = predictWithArguments(args, station);
        args.tau = savedTau;
        args.doodson[0] = savedTau;
        return value;
      }, 720);
    worstLive = Math.max(
      worstLive,
      Math.min(
        nearestLongitudeError(ring(false), subLunarDegrees),
        nearestLongitudeError(ring(false), subLunarDegrees + 180.0),
      ),
    );
    worstFrozen = Math.max(
      worstFrozen,
      Math.min(
        nearestLongitudeError(ring(true), subLunarDegrees),
        nearestLongitudeError(ring(true), subLunarDegrees + 180.0),
      ),
    );
  }
  assert.ok(
    worstLive <= TOLERANCE.HARMONIC_BULGE_DEGREES,
    `the live gate must pass first; it read ${worstLive.toFixed(3)} deg`,
  );
  assert.ok(
    worstFrozen > TOLERANCE.HARMONIC_BULGE_DEGREES,
    `a frozen tau must FAIL the alignment gate; it read ${worstFrozen.toFixed(3)} deg`,
  );
  assert.ok(
    worstFrozen > 30.0,
    `three days of frozen Earth rotation should put the bulge tens of degrees off the Moon (${worstFrozen.toFixed(1)} deg)`,
  );
});

// ─────────────────────────── f32 honesty lane ──────────────────────────────

test("f32 CANNOT carry the astronomical argument — measured, not asserted", () => {
  // If any of this is ever ported to WGSL, the arguments must be wrapped on the
  // CPU. This measures the damage of not doing so, so the claim is a number.
  const time = iso("2026-07-03T00:00:00Z");
  const centuries = TidalArguments.compute(time).julianCenturiesTt;
  // The Moon's mean longitude before reduction is ~481268 deg per century.
  const unreducedDegrees = 218.3164477 + 481267.88123421 * centuries;
  const f64 = wrap360(unreducedDegrees);
  const f32 = wrap360(
    Math.fround(
      Math.fround(218.3164477) +
        Math.fround(Math.fround(481267.88123421) * Math.fround(centuries)),
    ),
  );
  const errorDegrees = Math.abs(wrap180(f32 - f64));
  assert.ok(
    errorDegrees > 0.005,
    `f32 reduction error is only ${errorDegrees.toExponential(2)} deg — if this ever gets small, re-derive the guidance rather than deleting it`,
  );
  // Translate to tide phase so the number means something: M2 advances 360 deg
  // per 12.42 h, and the argument is 2s-bearing, so degrees of s map to tide
  // seconds at this rate.
  const tideSeconds =
    (errorDegrees / 360.0) * PUBLISHED.M2_PERIOD_HOURS * 3600.0;
  assert.ok(
    tideSeconds > 0.1,
    `f32 argument error is ${tideSeconds.toFixed(3)} s of tide phase`,
  );
  // The REDUCED argument, by contrast, is fine in f32 — which is exactly the
  // recommendation: reduce on the CPU, upload the wrapped angle.
  const reducedError = Math.abs(wrap180(Math.fround(f64) - f64));
  assert.ok(
    reducedError < 1.0e-4,
    `a pre-reduced argument should survive f32 (${reducedError.toExponential(2)} deg)`,
  );
});

// ───────────────────── the baked-atlas format contract ─────────────────────

const TCG_MAGIC = 0x31474354;
const TCG_HEADER_BYTES = 32;
const TCG_UNITS = 1000;

/** Build a synthetic atlas with the exact byte layout the bake tool writes. */
function buildAtlas(options) {
  const {
    ids = ["M2", "S2", "K1"],
    nx = 9,
    ny = 5,
    step = 45,
    west = -180,
    north = 90,
    units = TCG_UNITS,
    count = undefined,
    magic = TCG_MAGIC,
    version = 1,
    fill,
    truncate = 0,
  } = options ?? {};
  const declared = count ?? ids.length;
  const payloadOffset = TCG_HEADER_BYTES + declared * 4;
  const buffer = new ArrayBuffer(
    payloadOffset + nx * ny * 4 * declared - truncate,
  );
  const view = new DataView(buffer);
  view.setUint32(0, magic, true);
  view.setUint16(4, version, true);
  view.setUint16(6, units, true);
  view.setUint32(8, nx, true);
  view.setUint32(12, ny, true);
  view.setInt32(16, Math.round(west * 1e6), true);
  view.setInt32(20, Math.round(north * 1e6), true);
  view.setUint32(24, Math.round(step * 1e6), true);
  view.setUint16(28, declared, true);
  view.setUint16(30, 0, true);
  const bytes = new Uint8Array(buffer);
  ids.forEach((id, i) => {
    for (let b = 0; b < id.length; b++) {
      bytes[TCG_HEADER_BYTES + i * 4 + b] = id.charCodeAt(b);
    }
  });
  if (fill && truncate === 0) {
    const values = new Int16Array(
      buffer,
      payloadOffset,
      nx * ny * 2 * declared,
    );
    for (let c = 0; c < declared; c++) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const k = (c * nx * ny + j * nx + i) * 2;
          // Object argument, not positional: callers below need different
          // subsets of these and a positional signature leaves unused bindings.
          const cell = fill({
            constituent: c,
            i,
            j,
            longitude: west + i * step,
            latitude: north - j * step,
          });
          values[k] = cell[0];
          values[k + 1] = cell[1];
        }
      }
    }
  }
  return buffer;
}

test("TideConstituentGrid: a synthetic atlas round-trips amplitude and phase", () => {
  const ids = ["M2", "S2", "K1"];
  const nx = 9;
  const ny = 5;
  const step = 45;
  const amplitudeOf = (c) => 0.5 + 0.25 * c;
  const phaseOf = (c, i) => wrap360(30 * c + 40 * i);
  const buffer = buildAtlas({
    ids,
    nx,
    ny,
    step,
    fill: ({ constituent, i }) => {
      const a = amplitudeOf(constituent);
      const g = phaseOf(constituent, i) * DEGREES_TO_RADIANS;
      return [
        Math.round(a * Math.cos(g) * TCG_UNITS),
        Math.round(a * Math.sin(g) * TCG_UNITS),
      ];
    },
  });
  const grid = new TideConstituentGrid(buffer);
  assert.deepEqual(grid.constituentIds, ids);
  assert.deepEqual(
    grid.constituents.map((c) => c.id),
    ids,
  );
  assert.equal(grid.longitudeCount, nx);
  assert.equal(grid.latitudeCount, ny);
  assert.equal(grid.stepDegrees, step);

  const station = grid.createStation();
  assert.equal(station.source, HarmonicTideModel.SOURCE_EOT20);
  // Sample exactly on nodes: the value must come back with only the
  // quantization error, and the PHASE must not have been averaged across a wrap.
  for (let i = 0; i < nx; i++) {
    const longitude = -180 + i * step;
    grid.sampleInto(longitude, 0, station);
    assert.equal(station.valid, true);
    assert.ok(Math.abs(station.coverage - 1) < 1e-12);
    for (let c = 0; c < ids.length; c++) {
      assert.ok(
        Math.abs(station.amplitudeM[c] - amplitudeOf(c)) < 0.002,
        `${ids[c]} at ${longitude}: amplitude ${station.amplitudeM[c]}`,
      );
      const got = station.phaseLagRadians[c] * RADIANS_TO_DEGREES;
      assert.ok(
        Math.abs(wrap180(got - phaseOf(c, i))) < 0.3,
        `${ids[c]} at ${longitude}: phase ${got.toFixed(3)} vs ${phaseOf(c, i)}`,
      );
    }
  }
  // A sampled station drives the SAME predictor as an equilibrium one.
  const result = HarmonicTideModel.predict(
    iso("2026-07-03T00:00:00Z"),
    station,
  );
  assert.equal(result.valid, true);
  assert.ok(Number.isFinite(result.heightM));
  // Seams and poles behave like the geoid grid: wrap in longitude, clamp in
  // latitude, garbage degrades rather than poisoning.
  const a = grid.sampleInto(-180, 12, grid.createStation());
  const b = grid.sampleInto(540, 12, grid.createStation());
  assert.deepEqual(Array.from(a.amplitudeM), Array.from(b.amplitudeM));
  const polar = grid.sampleInto(0, 120, grid.createStation());
  const pole = grid.sampleInto(0, 90, grid.createStation());
  assert.deepEqual(Array.from(polar.amplitudeM), Array.from(pole.amplitudeM));
  const nan = grid.sampleInto(NaN, NaN, grid.createStation());
  assert.ok(Number.isFinite(nan.amplitudeM[0]));
});

test("TideConstituentGrid: the no-data sentinel is data-distinguishable and drives coverage", () => {
  const nx = 9;
  const ny = 5;
  // Land over the whole northern half; ocean south of the equator.
  const buffer = buildAtlas({
    ids: ["M2"],
    nx,
    ny,
    step: 45,
    fill: ({ latitude }) =>
      latitude > 0 ? [TideConstituentGrid.NO_DATA, 0] : [1000, 0],
  });
  const grid = new TideConstituentGrid(buffer);
  const station = grid.createStation();

  grid.sampleInto(0, -45, station);
  assert.equal(station.valid, true);
  assert.ok(
    Math.abs(station.coverage - 1) < 1e-12,
    "open water is full coverage",
  );
  assert.ok(Math.abs(station.amplitudeM[0] - 1.0) < 1e-9);

  grid.sampleInto(0, 45, station);
  assert.equal(
    station.valid,
    false,
    "all-land must be reported, not silently zero",
  );
  assert.equal(station.coverage, 0);
  assert.equal(station.amplitudeM[0], 0);
  assert.equal(
    HarmonicTideModel.predict(iso("2026-07-03T00:00:00Z"), station).heightM,
    0,
  );

  // Straddling the coast (the cell between the lat 45 land row and the lat 0
  // ocean row): partial coverage, and the amplitude is the ocean value rather
  // than a value dragged toward zero by the land nodes.
  grid.sampleInto(0, 22.5, station);
  assert.equal(station.valid, true);
  assert.ok(
    station.coverage > 0.4 && station.coverage < 1.0,
    `coastal coverage ${station.coverage}`,
  );
  assert.ok(
    Math.abs(station.amplitudeM[0] - 1.0) < 1e-9,
    `coastal amplitude ${station.amplitudeM[0]} — land nodes must be dropped, not averaged in as zero`,
  );
});

test("TideConstituentGrid: a malformed header throws instead of returning NaN", () => {
  // Same contract as GeoidUndulationGrid: degenerate dimensions previously
  // reached the sampler, clamped the cell origin to -1, read past the typed
  // array as `undefined` and produced NaN — which the predictor SKIPS, so the
  // tide would silently become zero.
  assert.ok(new TideConstituentGrid(buildAtlas({ nx: 2, ny: 2, step: 180 })));
  for (const bad of [
    { nx: 0 },
    { nx: 1 },
    { ny: 0 },
    { ny: 1 },
    { step: 0 },
    { units: 0 },
  ]) {
    assert.throws(
      () => new TideConstituentGrid(buildAtlas({ nx: 4, ny: 4, ...bad })),
      /malformed/,
      `header ${JSON.stringify(bad)} must be rejected`,
    );
  }
  assert.throws(() => new TideConstituentGrid(new ArrayBuffer(8)), /truncated/);
  assert.throws(
    () => new TideConstituentGrid(buildAtlas({ magic: 0xdeadbeef })),
    /TCG1/,
  );
  assert.throws(
    () => new TideConstituentGrid(buildAtlas({ version: 2 })),
    /version/,
  );
  assert.throws(
    () => new TideConstituentGrid(buildAtlas({ ids: ["M2", "ZZ"] })),
    /TidalConstituents does not define/,
    "an atlas naming an unknown constituent must fail at LOAD, not sample as zero",
  );
  assert.throws(
    () => new TideConstituentGrid(buildAtlas({ truncate: 4 })),
    /required for/,
  );
  // A corrupt constituent COUNT must reach the DeveloperError, not blow up
  // inside `new Uint8Array(buffer, 32, count * 4)` with a raw
  // `RangeError: Invalid typed array length`. The size check has to run before
  // any typed-array view is taken, because `count` is 16 bits of whatever the
  // file says.
  const corrupt = buildAtlas({
    ids: ["M2"],
    nx: 4,
    ny: 3,
    step: 120,
    fill: () => [0, 0],
  });
  new DataView(corrupt).setUint16(28, 40000, true);
  assert.throws(
    () => new TideConstituentGrid(corrupt),
    (error) => {
      assert.ok(
        !(error instanceof RangeError),
        `threw a raw ${error.constructor.name}: ${error.message}`,
      );
      assert.match(error.message, /required for/);
      return true;
    },
  );
});

// ───────────────────────────── source guards ───────────────────────────────

test("the TT / UT1 / noon-origin bridge is present in the source", () => {
  // Whitespace-tolerant CALL-SHAPE assertions: prettier rewraps and esbuild
  // renames locals, so a single-line literal would be a formatting tripwire
  // rather than a behavioural one. Each marker is a long, unique identifier.
  const source = readEngine("Core/TidalArguments.js");
  assert.ok(
    /const\s+secondsTt\s*=\s*time\.secondsOfDay\s*\+\s*TidalArguments\.TT_MINUS_TAI_SECONDS\s*;/.test(
      source,
    ),
    "the mean longitudes must be evaluated in TT, not TAI (a 32.184 s error)",
  );
  assert.ok(
    /ut1SecondsOfJulianDay\s*=\s*[\s\S]{0,120}?JulianDate\.computeTaiMinusUtc\(\s*time\s*\)/.test(
      source,
    ),
    "tau must be evaluated in UT1 (approximated by UTC), not TAI or TT (a 69 s error)",
  );
  assert.ok(
    /\(\s*15\.0\s*\*\s*ut1SecondsOfJulianDay\s*\)\s*\/\s*3600\.0\s*\+\s*180\.0/.test(
      source,
    ),
    "tau must carry the +180 deg noon-origin term — see the negative control above",
  );
  // No wall-clock reads anywhere in the tide chain: T6 requires the scene clock.
  for (const file of [
    "Core/TidalArguments.js",
    "Core/TidalConstituents.js",
    "Core/HarmonicTideModel.js",
    "Core/TideConstituentGrid.js",
  ]) {
    const text = readEngine(file);
    assert.ok(
      !/\bDate\.now\s*\(|\bnew\s+Date\s*\(|performance\.now\s*\(|JulianDate\.now\s*\(/.test(
        text,
      ),
      `${file} reads wall time — the tide must be a pure function of the scene clock`,
    );
  }
});

test("the harmonic modules stay out of the renderer", () => {
  // This slice is Core + Tools only; three other lanes are appending to the
  // scene/renderer files. A stray import here is a merge conflict waiting to
  // happen and a layering violation besides.
  for (const file of [
    "Core/TidalArguments.js",
    "Core/TidalConstituents.js",
    "Core/HarmonicTideModel.js",
    "Core/TideConstituentGrid.js",
  ]) {
    const text = readEngine(file);
    const imports = [
      ...text.matchAll(/^import\s+[\s\S]*?from\s+"([^"]+)";/gm),
    ].map((m) => m[1]);
    for (const specifier of imports) {
      assert.ok(
        specifier.startsWith("./"),
        `${file} imports ${specifier} — Core modules must only import siblings`,
      );
    }
    assert.ok(
      /\nexport default \w+;\n?$/.test(text),
      `${file} must end in an export default (the generated engine barrel requires it)`,
    );
  }
});

// ───────────── the bake tool's own encoder and sanity gate ────────────────

/** Synthetic per-constituent (re, im) grids in the layout `encode` expects. */
function syntheticGrids(ids, nx, ny, step, options) {
  const {
    amplitudeScale = 1,
    constantPhase = false,
    noLand = false,
    allLand = false,
  } = options ?? {};
  const grids = [];
  for (let c = 0; c < ids.length; c++) {
    const re = new Float64Array(nx * ny);
    const im = new Float64Array(nx * ny);
    for (let j = 0; j < ny; j++) {
      const latitude = 90 - j * step;
      for (let i = 0; i < nx; i++) {
        const longitude = -180 + i * step;
        const k = j * nx + i;
        if (allLand || (!noLand && Math.abs(latitude) > 80)) {
          re[k] = NaN;
          im[k] = NaN;
          continue;
        }
        const amplitude =
          amplitudeScale *
          (0.35 + 0.2 * Math.cos((longitude * Math.PI) / 180) + 0.02 * c);
        const g = constantPhase
          ? 0.7
          : ((longitude * 2 + latitude * 3 + 37 * c) * Math.PI) / 180;
        re[k] = amplitude * Math.cos(g);
        im[k] = amplitude * Math.sin(g);
      }
    }
    grids.push({ re, im });
  }
  return grids;
}

test("the bake tool's sanity gate decodes through the SHIPPED reader", () => {
  // The gate previously re-implemented the decode inline, which meant producer
  // and consumer could disagree about header SEMANTICS while the self test kept
  // passing. Importing the real `encode` and `sanityCheck` here means this spec
  // exercises the same two functions a live bake does, and the gate itself
  // constructs a real TideConstituentGrid.
  const ids = ["M2", "S2", "K1"];
  const step = 10;
  const nx = 360 / step + 1;
  const ny = 180 / step + 1;
  const grids = syntheticGrids(ids, nx, ny, step);
  const { buffer } = bakeEncode(ids, grids, nx, ny, -180, 90, step);
  const stats = bakeSanityCheck(buffer, ids, grids, nx, ny, -180, 90, step);
  assert.ok(
    stats.worstNodeError <= BAKE_SANITY.MAX_NODE_ERROR_M,
    `reader/encoder disagreement ${(stats.worstNodeError * 1000).toFixed(3)} mm`,
  );
  assert.ok(stats.checked > 500, `${stats.checked} node samples checked`);
  assert.ok(stats.coverage > BAKE_SANITY.MIN_COVERAGE);
  assert.ok(stats.resultant < BAKE_SANITY.MAX_PHASE_RESULTANT);
});

test("the bake tool's sanity gate rejects each degenerate atlas", () => {
  const ids = ["M2", "S2"];
  const step = 10;
  const nx = 360 / step + 1;
  const ny = 180 / step + 1;
  const bake = (options) => {
    const grids = syntheticGrids(ids, nx, ny, step, options);
    const { buffer } = bakeEncode(ids, grids, nx, ny, -180, 90, step);
    return () => bakeSanityCheck(buffer, ids, grids, nx, ny, -180, 90, step);
  };
  // Baseline passes, so the rejections below mean something.
  assert.ok(bake()().coverage > 0);
  assert.throws(bake({ allLand: true }), /almost entirely no-data/);
  assert.throws(bake({ noLand: true }), /land mask was lost/);
  // A 10x amplitude — precisely the unapplied-scale_factor failure — is caught
  // by the median band.
  assert.throws(bake({ amplitudeScale: 10 }), /median amplitude/);
  assert.throws(bake({ amplitudeScale: 0.001 }), /median amplitude/);
  assert.throws(bake({ constantPhase: true }), /clustered/);
});

test("the bake tool's sanity gate catches producer/consumer header drift", () => {
  // The mutation class the old self test could not see: the payload is fine,
  // the header SEMANTICS are not. Each of these leaves a file that loads and
  // decodes to silently wrong values.
  const ids = ["M2", "S2"];
  const step = 10;
  const nx = 360 / step + 1;
  const ny = 180 / step + 1;
  const grids = syntheticGrids(ids, nx, ny, step);
  const run = (corrupt) => {
    const { buffer } = bakeEncode(ids, grids, nx, ny, -180, 90, step);
    corrupt(buffer);
    return () => bakeSanityCheck(buffer, ids, grids, nx, ny, -180, 90, step);
  };
  assert.ok(
    run(() => {})().coverage > 0,
    "the uncorrupted bake must pass first",
  );
  // units per metre 1000 -> 60 (the shape an offset-by-one write takes)
  assert.throws(
    run((b) => b.writeUInt16LE(60, 6)),
    /disagrees with the encoder/,
  );
  // step written in the wrong units
  assert.throws(
    run((b) => b.writeUInt32LE(Math.round(step * 1e5), 24)),
    /the reader sees step/,
  );
  // west and north edges swapped
  assert.throws(
    run((b) => {
      b.writeInt32LE(90 * 1e6, 16);
      b.writeInt32LE(-180 * 1e6, 20);
    }),
    /disagrees with the encoder/,
  );
});

test("the bake tool documents its source, licence and attribution", () => {
  const tool = fs.readFileSync(
    path.join(root, "Tools/build-eot20-constituent-grid.mjs"),
    "utf8",
  );
  assert.ok(tool.includes("10.17882/79489"), "the SEANOE DOI");
  assert.ok(/CC BY 4\.0/.test(tool), "the licence");
  assert.ok(/Hart-Davis/.test(tool), "the citation");
  assert.ok(
    /ATTRIBUTION\s*=\s*\[/.test(tool),
    "the verbatim attribution string a CC BY bundle must carry",
  );
  assert.ok(
    /essd-13-3869-2021/.test(tool),
    "the ESSD paper DOI the licence statement lives in",
  );
  // The output format constants must agree with the reader, or a bake is
  // unreadable and nothing catches it until runtime.
  assert.ok(/const MAGIC = 0x31474354;/.test(tool));
  assert.ok(/const HEADER_BYTES = 32;/.test(tool));
  assert.ok(/const NO_DATA = -32768;/.test(tool));
  assert.equal(TideConstituentGrid.MAGIC, 0x31474354);
  assert.equal(TideConstituentGrid.HEADER_BYTES, 32);
  assert.equal(TideConstituentGrid.NO_DATA, -32768);
});
