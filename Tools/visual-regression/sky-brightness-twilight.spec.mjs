// sky-brightness-twilight.spec.mjs — C12-34
// (NEW-SKY-BRIGHTNESS-ESTIMATOR-NO-TWILIGHT-RANGE).
// @purpose C12-34 acceptance: the SkyBrightness log-luminance estimator separates the twilight bands the old smoothstep collapsed; mutation-tested.
// @status ACTIVE
//
// WHY THIS EXISTS
// ───────────────
// `Scene/SkyBrightness.js`'s sun term used to be `smoothstep(-0.1, 0.4,
// sunAlt)`, which reaches EXACTLY 0 once the sun is below −5.74°. Across
// −18° to −6° — the astronomical and nautical bands, half the twilight
// decade — the star-modulation factor's total span was therefore EXACTLY
// 0.000000: civil twilight, nautical twilight and astronomical night all fed
// the curve the same input, so no choice of the curve's two parameters could
// separate them. C12-34 replaced it with a log-luminance model whose sun term
// is the published zenith twilight-photometry curve.
//
// THE MEASUREMENT TRAP THIS SPEC IS SHAPED AROUND
// ──────────────────────────────────────────────
// The defect is invisible to any aggregate: a faint, wide-band sky change
// moves a band mean by less than its own noise, and the OLD estimator is
// bit-identical to the new one at BOTH ends of the range (deep night and full
// day). An "is it different?" test passes on the broken build. So every claim
// here is BANDED or POINTWISE — named solar elevations, named bands, and the
// exact-equality identities at the ends — never an average over a sweep.
//
// FOUR CLAIMS, EACH WITH A MUTATION
// ─────────────────────────────────
// A green numeric suite proves nothing unless the pre-C12-34 estimator FAILS
// it, so each group's assertions are packaged as a predicate over an
// estimator function, and the mutation tests feed the predicate a
// deliberately broken estimator and require it to throw:
//
//   A. the sun-elevation derivation has ONE home  → mutation: re-inline the
//      removed `scratchCamUp` normalize+dot in `StarFieldMath.ts`.
//   B. the published band boundaries              → mutation: the legacy
//      double-smoothstep sun term.
//   C. continuity/monotonicity across the bands   → mutation: a binary
//      day/night gate.
//   D. the byte-neutral-when-off identities       → mutation: an estimator
//      with an epsilon floor (the classic "it's only 1e-6" regression).
//   E. the moon phase-flux law                    → mutation: linear phase.
//
// Run: node --test Tools/visual-regression/sky-brightness-twilight.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const read = (rel) =>
  fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n?/g, "\n");

const STAR_FIELD_MATH_REL = "packages/engine/Source/Scene/StarFieldMath.ts";
const SKY_BRIGHTNESS_REL = "packages/engine/Source/Scene/SkyBrightness.js";

const starFieldMathTs = read(STAR_FIELD_MATH_REL);
const skyBrightnessJs = read(SKY_BRIGHTNESS_REL);

enableEngineTsResolution();

const engine = (rel) => pathToFileURL(path.join(root, rel)).href;

const {
  DAY_ZENITH_MAGNITUDE,
  FULL_MOON_ZENITH_MAGNITUDE,
  MOON_PHASE_FLUX_EXPONENT,
  NELM_PER_ZENITH_MAGNITUDE,
  NIGHT_ZENITH_MAGNITUDE,
  computeCelestialElevationSine,
  computeSkyBrightness,
  computeSkyBrightnessFromZenithMagnitude,
  computeTwilightZenithMagnitude,
} = await import(engine(SKY_BRIGHTNESS_REL));

const {
  STAR_MODULATION_INFLECTION,
  STAR_MODULATION_STEEPNESS,
  STAR_REFERENCE_LIMITING_MAGNITUDE,
  computeStarBrightnessModulation,
  computeStarDayFade,
} = await import(engine(STAR_FIELD_MATH_REL));

const { ECLIPSE_TWILIGHT_FLOOR } = await import(
  engine("packages/engine/Source/Scene/EclipseState.js")
);

// ─── fixtures ───────────────────────────────────────────────────────────────
//
// A ground camera on the +X axis, so local up is exactly (1, 0, 0) and a
// direction `(sin h, 0, cos h)` has altitude exactly `h`. Nothing here needs
// an ephemeris: the estimator's only geometric input IS this sine.

const EARTH_RADIUS = 6378137.0;
const groundCamera = { x: EARTH_RADIUS, y: 0.0, z: 0.0 };
const cameraAt = (height) => ({ x: EARTH_RADIUS + height, y: 0.0, z: 0.0 });
const directionAtElevation = (degrees) => ({
  x: Math.sin((degrees * Math.PI) / 180.0),
  y: 0.0,
  z: Math.cos((degrees * Math.PI) / 180.0),
});
const ZENITH = { x: 1.0, y: 0.0, z: 0.0 };

/**
 * Solar elevation at which the day sky saturates, degrees. DERIVED from the
 * shipped saturation sine (0.4) rather than transcribed as "23.578" — the
 * rounded literal sits BELOW the edge, so an exact-equality day test written
 * against it fails for a fixture reason and looks like a model defect.
 */
const DAY_SATURATION_DEGREES = (Math.asin(0.4) * 180.0) / Math.PI;

/** The shipped star-modulation curve, evaluated at the shipped constants. */
const modulation = (skyBrightness) =>
  computeStarBrightnessModulation(
    skyBrightness,
    STAR_MODULATION_INFLECTION,
    STAR_MODULATION_STEEPNESS,
  );

/** Naked-eye limiting magnitude implied by a modulation factor. */
const limitingMagnitude = (factor) =>
  STAR_REFERENCE_LIMITING_MAGNITUDE + 2.5 * Math.log10(Math.max(factor, 1e-30));

/**
 * The shipped estimator, curried to the one axis every claim below varies:
 * solar elevation in degrees, moonless, ground camera.
 * @type {(elevationDeg: number) => number}
 */
const shipped = (elevationDeg) =>
  computeSkyBrightness(
    directionAtElevation(elevationDeg),
    undefined,
    0.0,
    groundCamera,
    0.0,
  );

/** Same shape, with the moon overhead at a given illuminated fraction. */
const shippedWithMoon = (elevationDeg, phase) =>
  computeSkyBrightness(
    directionAtElevation(elevationDeg),
    ZENITH,
    phase,
    groundCamera,
    0.0,
  );

// ─── the broken estimators the mutations feed back in ───────────────────────

const smoothstep01 = (t) => t * t * (3.0 - 2.0 * t);
const smoothstep = (edge0, edge1, x) =>
  smoothstep01(Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0))));

/**
 * The EXACT pre-C12-34 estimator (double smoothstep + a flat 4% moon
 * constant with LINEAR phase), reproduced from the replaced source. Not an
 * approximation of the defect — the defect.
 * @param {number} elevationDeg Solar elevation in degrees.
 * @param {number} [moonPhase=0] Moon illuminated fraction, moon overhead.
 * @returns {number} The legacy sky-brightness scalar.
 */
function legacyEstimator(elevationDeg, moonPhase = 0.0) {
  const sunContrib = smoothstep(
    -0.1,
    0.4,
    Math.sin((elevationDeg * Math.PI) / 180.0),
  );
  const moonContrib =
    moonPhase > 0 ? smoothstep(-0.05, 0.15, 1.0) * moonPhase * 0.04 : 0.0;
  const total = sunContrib + moonContrib;
  return total < 1.0 ? total : 1.0;
}

/** A binary day/night gate — continuous nowhere at the horizon. */
const binaryGateEstimator = (elevationDeg) => (elevationDeg >= 0.0 ? 1.0 : 0.0);

/** The shipped estimator with an epsilon floor: every identity becomes "close". */
const epsilonFloorEstimator = (elevationDeg) =>
  Math.min(1.0 - 1e-6, Math.max(1e-6, shipped(elevationDeg)));

/** The shipped model with the moon's phase-flux law reverted to linear. */
function linearPhaseMoonLuminance(phase) {
  const fullMoonAdded =
    Math.pow(
      10.0,
      0.4 * (NIGHT_ZENITH_MAGNITUDE - FULL_MOON_ZENITH_MAGNITUDE),
    ) - 1.0;
  return fullMoonAdded * phase;
}

/** The shipped model's own moon luminance, for the same comparison. */
function shippedMoonLuminance(phase) {
  const fullMoonAdded =
    Math.pow(
      10.0,
      0.4 * (NIGHT_ZENITH_MAGNITUDE - FULL_MOON_ZENITH_MAGNITUDE),
    ) - 1.0;
  return fullMoonAdded * Math.pow(phase, MOON_PHASE_FLUX_EXPONENT);
}

// ════════════════════════════════════════════════════════════════════════════
// A. ONE HOME FOR THE SOLAR-ELEVATION DERIVATION
//
// C15's aurora night-gate is slated to reuse this edge. If a second
// normalize-and-dot exists, the two gates drift the first time either is
// touched — which is exactly how `computeStarDayFade` and the estimator came
// to disagree about what "the sun is up" means in the first place.
// ════════════════════════════════════════════════════════════════════════════

/** Independent reference: normalize the camera position, dot the direction. */
function referenceElevationSine(direction, position) {
  const magnitude = Math.hypot(position.x, position.y, position.z);
  return (
    (direction.x * position.x +
      direction.y * position.y +
      direction.z * position.z) /
    magnitude
  );
}

test("A: the shared helper IS a normalize-and-dot, at every band edge", () => {
  const positions = [
    groundCamera,
    { x: 1.0e6, y: -2.5e6, z: 5.9e6 },
    { x: -4.4e6, y: 4.4e6, z: -1.1e6 },
  ];
  for (const position of positions) {
    for (const degrees of [-18, -12, -6, -2, 0, 10, 23.578, 60, 90]) {
      const direction = directionAtElevation(degrees);
      const actual = computeCelestialElevationSine(direction, position);
      const expected = referenceElevationSine(direction, position);
      assert.ok(
        Math.abs(actual - expected) < 1e-15,
        `elevation sine at ${degrees}° from ${JSON.stringify(position)}: ` +
          `${actual} vs ${expected}`,
      );
    }
  }
  // The one geometry the fixture makes exact: up is +X, so the sine of the
  // altitude IS sin(elevation).
  for (const degrees of [-18, -12, -6, 0, 30]) {
    assert.ok(
      Math.abs(
        computeCelestialElevationSine(
          directionAtElevation(degrees),
          groundCamera,
        ) - Math.sin((degrees * Math.PI) / 180.0),
      ) < 1e-15,
    );
  }
});

test("A: the degenerate cases resolve to `undefined`, not to a number", () => {
  assert.equal(
    computeCelestialElevationSine(undefined, groundCamera),
    undefined,
  );
  assert.equal(computeCelestialElevationSine(ZENITH, undefined), undefined);
  assert.equal(
    computeCelestialElevationSine(ZENITH, { x: 0, y: 0, z: 0 }),
    undefined,
    "a camera at the planet center has no meaningful up",
  );
  assert.equal(
    computeCelestialElevationSine(ZENITH, { x: NaN, y: 0, z: 0 }),
    undefined,
    "a NaN position must not produce a NaN elevation",
  );
  assert.equal(
    computeCelestialElevationSine({ x: NaN, y: 0, z: 0 }, groundCamera),
    undefined,
    "a NaN direction must not produce a NaN elevation",
  );
});

/**
 * The single-home SOURCE claim, as a predicate so the mutation can break it.
 * @param {string} source `StarFieldMath.ts` text.
 */
function assertOneSolarElevationHome(source) {
  assert.match(
    source,
    /import \{[\s\S]*?computeCelestialElevationSine,[\s\S]*?\} from "\.\/SkyBrightness\.js";/,
    "StarFieldMath must import the shared elevation helper",
  );
  assert.match(
    source,
    /const solarAltSin = computeCelestialElevationSine\(/,
    "computeStarDayFade must derive its solar elevation from the shared helper",
  );
  // The removed local derivation, in any spelling: a scratch up-vector, a
  // normalize of the camera position, or a dot against one.
  assert.ok(
    !/scratchCamUp/.test(source),
    "the local `scratchCamUp` normalize+dot is back — that is a SECOND home " +
      "for the solar-elevation derivation",
  );
  assert.ok(
    !/Cartesian3\.normalize\(\s*cameraPositionWC/.test(source),
    "StarFieldMath must not re-normalize the camera position itself",
  );
  assert.ok(
    !/Cartesian3\.dot\(\s*sunDirectionWC/.test(source),
    "StarFieldMath must not re-dot the sun direction against a local up",
  );
}

test("A: `StarFieldMath` reuses the shared helper and keeps no second home", () => {
  assertOneSolarElevationHome(starFieldMathTs);
});

test("A: `SkyBrightness` derives BOTH bodies' elevations through the helper", () => {
  const body = skyBrightnessJs.slice(
    skyBrightnessJs.indexOf("export function computeSkyBrightness("),
  );
  const calls = body.match(/computeCelestialElevationSine\(/g) ?? [];
  assert.equal(
    calls.length,
    2,
    "computeSkyBrightness must call the helper exactly twice (sun, moon)",
  );
  assert.match(
    body,
    /computeCelestialElevationSine\(sunDirWC, cameraPositionWC\)/,
  );
  assert.match(
    body,
    /computeCelestialElevationSine\(moonDirWC, cameraPositionWC\)/,
  );
  // And the module contains exactly ONE elevation dot product — the helper's.
  const dots =
    skyBrightnessJs.match(/directionWC\.x \* \(upX \* invMag\)/g) ?? [];
  assert.equal(dots.length, 1, "the elevation dot product must have one home");
});

test("A: the two star paths react to the SAME elevation number", () => {
  // `computeStarDayFade`'s ramp is [-0.10, +0.05] in sin(altitude). If the two
  // consumers were reading different elevations, these edges would not line up
  // with the estimator's own view of the same sun.
  const fadeAt = (degrees) =>
    computeStarDayFade(directionAtElevation(degrees), groundCamera, 0.0);
  const edgeLow = (Math.asin(-0.1) * 180.0) / Math.PI;
  const edgeHigh = (Math.asin(0.05) * 180.0) / Math.PI;
  assert.equal(fadeAt(edgeLow - 1e-9), 1.0, "fully unfaded below the low edge");
  assert.equal(fadeAt(edgeHigh + 1e-9), 0.0, "fully faded above the high edge");
  // Same helper, same fixture, same number — asserted directly rather than
  // inferred, so a future refactor that gives one path its own "up" fails.
  // (Tolerance because the fixture round-trips through asin/sin, not because
  // the two paths are allowed to disagree: 1e-15 is the round-trip's own
  // error, ~11 orders below the ramp width.)
  assert.ok(
    Math.abs(
      computeCelestialElevationSine(
        directionAtElevation(edgeLow),
        groundCamera,
      ) - -0.1,
    ) < 1e-15,
  );
});

test("MUTATION — re-inlining the local normalize+dot must FAIL the A checks", () => {
  assertOneSolarElevationHome(starFieldMathTs);
  const mutated = starFieldMathTs.replace(
    /const solarAltSin = computeCelestialElevationSine\(\s*sunDirectionWC,\s*cameraPositionWC,\s*\);/,
    "Cartesian3.normalize(cameraPositionWC, scratchCamUp);\n" +
      "    const solarAltSin = Cartesian3.dot(sunDirectionWC, scratchCamUp);",
  );
  assert.notEqual(
    mutated,
    starFieldMathTs,
    "the mutation matched nothing — the call's spelling changed, so the " +
      "single-home check is unfalsifiable until this is re-aimed",
  );
  assert.throws(
    () => assertOneSolarElevationHome(mutated),
    "the single-home check cannot see a re-inlined second derivation",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// B. BAND BOUNDARIES — the published twilight ladder
// ════════════════════════════════════════════════════════════════════════════

/**
 * The band-boundary claim: each twilight band must land in its published
 * naked-eye-limit window, and the windows must not overlap.
 *
 * @param {(elevationDeg: number) => number} estimator Sky-brightness model.
 */
function assertBandBoundaries(estimator) {
  // Published anchors, each independently derived from the NELM chain rather
  // than transcribed: NELM(μ) = 6.5 − 0.5·(21.9 − μ).
  const anchors = [
    { degrees: -6.0, mu: 14.0, label: "end of civil twilight" },
    { degrees: -12.0, mu: 19.7, label: "end of nautical twilight" },
    { degrees: -18.0, mu: NIGHT_ZENITH_MAGNITUDE, label: "astronomical night" },
  ];
  for (const { degrees, mu, label } of anchors) {
    const expectedFactor = Math.pow(
      10.0,
      -0.4 * NELM_PER_ZENITH_MAGNITUDE * (NIGHT_ZENITH_MAGNITUDE - mu),
    );
    const actual = modulation(estimator(degrees));
    assert.ok(
      Math.abs(actual - expectedFactor) < 1e-6,
      `${label} (${degrees}°): factor ${actual}, published chain gives ` +
        `${expectedFactor}`,
    );
  }
  // The bands must be SEPARATED, not merely ordered: each is at least half a
  // magnitude apart from its neighbour, which is what "the estimator can tell
  // them apart" means operationally.
  const civil = modulation(estimator(-6.0));
  const nautical = modulation(estimator(-12.0));
  const astronomical = modulation(estimator(-18.0));
  for (const [lo, hi, name] of [
    [civil, nautical, "civil↔nautical"],
    [nautical, astronomical, "nautical↔astronomical"],
  ]) {
    assert.ok(
      2.5 * Math.log10(hi / lo) > 0.5,
      `${name} are less than 0.5 mag apart (${lo} vs ${hi})`,
    );
  }
  // THE DEFECT METRIC. Across the astronomical + nautical bands the OLD
  // factor's span was exactly 0. Anything that cannot move most of the range
  // here has not fixed C12-34.
  const span = astronomical - civil;
  assert.ok(
    span > 0.9,
    `the −18°→−6° factor span is ${span}; the pre-C12-34 estimator's was 0`,
  );
}

test("B: the published twilight bands land on the published NELM ladder", () => {
  assertBandBoundaries(shipped);
});

test("B: the zenith-magnitude anchors are the published photometry", () => {
  const at = (degrees) =>
    computeTwilightZenithMagnitude(Math.sin((degrees * Math.PI) / 180.0));
  assert.equal(at(-18.0), NIGHT_ZENITH_MAGNITUDE);
  assert.ok(Math.abs(at(-12.0) - 19.7) < 1e-12, `−12° → ${at(-12.0)}`);
  assert.ok(Math.abs(at(-6.0) - 14.0) < 1e-12, `−6° → ${at(-6.0)}`);
  assert.ok(Math.abs(at(0.0) - 8.0) < 1e-12, `horizon → ${at(0.0)}`);
  assert.equal(at(90.0), DAY_ZENITH_MAGNITUDE);
  // Deeper than −18° stays exactly the night level — the sun term contributes
  // nothing at all, which is what makes deep night bit-exact below.
  assert.equal(at(-30.0), NIGHT_ZENITH_MAGNITUDE);
  assert.equal(at(-90.0), NIGHT_ZENITH_MAGNITUDE);
  // ~1 mag per degree through civil+nautical, the classical twilight ladder.
  const perDegree = (at(-12.0) - at(-6.0)) / 6.0;
  assert.ok(perDegree > 0.7 && perDegree < 1.3, `${perDegree} mag/deg`);
});

test("B: the four published off-anchor values, to the digits the doc states", () => {
  // Full moon overhead, astronomical night.
  const fullMoon = shippedWithMoon(-30.0, 1.0);
  assert.ok(Math.abs(fullMoon - 0.0322377) < 5e-7, `B ${fullMoon}`);
  assert.ok(
    Math.abs(modulation(fullMoon) - 0.165959) < 5e-6,
    `factor ${modulation(fullMoon)}`,
  );
  assert.ok(
    Math.abs(limitingMagnitude(modulation(fullMoon)) - 4.55) < 0.01,
    "the published full-moon naked-eye limit is ≈4.5",
  );
  // Mid civil twilight — the queue row's "Venus and one or two first-magnitude
  // stars", which the old estimator answered with exactly 0.
  const civil = shipped(-2.0);
  assert.ok(Math.abs(civil - 0.0418355) < 5e-7, `B ${civil}`);
  assert.ok(Math.abs(modulation(civil) - 0.004175) < 5e-7);
  assert.ok(Math.abs(limitingMagnitude(modulation(civil)) - 0.55) < 0.01);
  // End of civil / end of nautical.
  assert.ok(Math.abs(modulation(shipped(-6.0)) - 0.026303) < 5e-6);
  assert.ok(
    Math.abs(limitingMagnitude(modulation(shipped(-6.0))) - 2.55) < 0.01,
  );
  assert.ok(Math.abs(modulation(shipped(-12.0)) - 0.363078) < 5e-6);
  assert.ok(
    Math.abs(limitingMagnitude(modulation(shipped(-12.0))) - 5.4) < 0.01,
  );
});

test("MUTATION — the legacy double-smoothstep must FAIL the band checks", () => {
  assertBandBoundaries(shipped);
  // Non-vacuity first: the legacy model really does collapse the two deep
  // bands onto one value, which is the whole C12-34 finding.
  assert.equal(
    modulation(legacyEstimator(-18.0)) - modulation(legacyEstimator(-6.0)),
    0,
    "the legacy fixture is wrong — it must have EXACTLY zero span there",
  );
  assert.throws(
    () => assertBandBoundaries(legacyEstimator),
    "the band-boundary checks cannot see a collapsed twilight decade",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// C. CONTINUITY AND MONOTONICITY ACROSS THE BANDS
//
// The row asks for a CONTINUOUS keying off solar elevation, not a gate. A
// discontinuity is a visible pop in a scene with a moving clock, and it is
// exactly what a band-mean metric cannot see.
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {(elevationDeg: number) => number} estimator Sky-brightness model.
 */
function assertContinuousAndMonotone(estimator) {
  const STEP = 0.02;
  let previousBrightness = -Infinity;
  let previousFactor = Infinity;
  let previous = estimator(-90.0);
  for (let degrees = -90.0; degrees <= 90.0 + 1e-9; degrees += STEP) {
    const brightness = estimator(degrees);
    assert.ok(
      Number.isFinite(brightness) && brightness >= 0 && brightness <= 1,
      `sky brightness out of range at ${degrees}°: ${brightness}`,
    );
    assert.ok(
      brightness >= previousBrightness - 1e-12,
      `sky brightness is not monotone at ${degrees}°`,
    );
    // Continuity: no step larger than what a 0.02° move can justify. The
    // steepest shipped segment is the day ramp (μ 8→4 over sin 0→0.4), whose
    // largest per-step move is ~0.0009.
    assert.ok(
      Math.abs(brightness - previous) < 0.01,
      `discontinuity at ${degrees}°: ${previous} → ${brightness}`,
    );
    const factor = modulation(brightness);
    assert.ok(
      factor <= previousFactor + 1e-12,
      `the star factor is not monotone at ${degrees}°`,
    );
    previous = brightness;
    previousBrightness = brightness;
    previousFactor = factor;
  }
}

test("C: the estimator is continuous and monotone from −90° to +90°", () => {
  assertContinuousAndMonotone(shipped);
});

test("C: the OBSERVABLE is seamless at every band edge", () => {
  // Each anchor probed from both sides at 1e-6°, which is finer than any
  // sweep step and therefore catches a kink the sweep would step over. The
  // quantity under test is the STAR FACTOR — what a viewer sees — not the
  // intermediate scalar, for the reason the next test pins.
  for (const degrees of [-18.0, -12.0, -6.0, 0.0, DAY_SATURATION_DEGREES]) {
    const below = modulation(shipped(degrees - 1e-6));
    const above = modulation(shipped(degrees + 1e-6));
    assert.ok(
      Math.abs(above - below) < 1e-6,
      `discontinuity at the ${degrees}° anchor: ${below} → ${above}`,
    );
  }
  // The transfer's own segment join at μ = 8 (star window → daylight ramp).
  const join = computeSkyBrightnessFromZenithMagnitude(8.0);
  assert.ok(
    Math.abs(computeSkyBrightnessFromZenithMagnitude(8.0 - 1e-9) - join) < 1e-8,
  );
  assert.ok(
    Math.abs(computeSkyBrightnessFromZenithMagnitude(8.0 + 1e-9) - join) < 1e-8,
  );
  // And the two ends of the transfer, approached from inside.
  assert.ok(computeSkyBrightnessFromZenithMagnitude(21.9 - 1e-9) < 1e-3);
  assert.ok(computeSkyBrightnessFromZenithMagnitude(4.0 + 1e-9) > 1 - 1e-8);
});

test("C: the scalar's vertical tangent at the night end is BY CONSTRUCTION", () => {
  // FOUND WHILE WRITING THIS SPEC, and worth a named test rather than a
  // loosened bound. The transfer emits `invSmoothstep(1 − factor)/steepness`,
  // and smoothstep's slope is ZERO at t = 0, so its inverse has an INFINITE
  // slope there: the scalar leaves 0 with a vertical tangent at μ = 21.9.
  //
  // Measured across a 2e-6° step at the −18° anchor: the scalar moves
  // 1.02e-5 while the star factor it encodes moves 1.66e-7 — two orders
  // apart. The OBSERVABLE is smooth; only the intermediate coordinate is
  // steep, which is exactly what a pre-image through a flat-slope curve looks
  // like. Nothing today reads `frameState.skyBrightness` except through the
  // curve, so this is a property, not a defect — but a future consumer that
  // reads the scalar DIRECTLY (a night-sky dimming term, C15's aurora gate)
  // must know that its first 1e-5 of range covers the last 1e-7 of the star
  // factor, or it will pop at the end of astronomical twilight.
  const scalarJump = shipped(-18.0 + 1e-6) - shipped(-18.0 - 1e-6);
  const factorJump =
    modulation(shipped(-18.0 - 1e-6)) - modulation(shipped(-18.0 + 1e-6));
  assert.ok(
    scalarJump > 1e-6 && scalarJump < 1e-4,
    `scalar jump at the night end: ${scalarJump}`,
  );
  assert.ok(factorJump < 1e-6, `factor jump at the night end: ${factorJump}`);
  assert.ok(
    scalarJump / factorJump > 10.0,
    "the steep coordinate must be the scalar, not the observable — if the " +
      "factor is the steep one the calibration has been inverted",
  );
  // The other three anchors have no such tangent: both quantities move by
  // comparable, tiny amounts there.
  for (const degrees of [-12.0, -6.0, 0.0]) {
    assert.ok(
      Math.abs(shipped(degrees + 1e-6) - shipped(degrees - 1e-6)) < 1e-6,
      `unexpected steep coordinate at ${degrees}°`,
    );
  }
});

test("MUTATION — a binary day/night gate must FAIL the continuity check", () => {
  assertContinuousAndMonotone(shipped);
  assert.throws(
    () => assertContinuousAndMonotone(binaryGateEstimator),
    "the continuity check cannot see a step function — which is precisely " +
      "the shape C12-34 forbids",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// D. BYTE-NEUTRAL WHEN OFF
//
// Every one of these is `assert.equal` on purpose. "Within 1e-6 of 1.0" is
// not byte-neutral: it multiplies a rendered star field by 0.999999 and the
// off-position identity stops being an identity.
// ════════════════════════════════════════════════════════════════════════════

/**
 * @param {(elevationDeg: number) => number} estimator Sky-brightness model.
 */
function assertOffIdentities(estimator) {
  // 1. Astronomical night, moonless: EXACTLY 0 in, EXACTLY 1 out.
  for (const degrees of [-18.0, -20.0, -45.0, -90.0]) {
    assert.equal(
      estimator(degrees),
      0.0,
      `astronomical night at ${degrees}° must be exactly 0`,
    );
    assert.equal(
      modulation(estimator(degrees)),
      1.0,
      `the star field at ${degrees}° must be exactly undimmed`,
    );
  }
  // 2. Saturated day: EXACTLY 1 in, EXACTLY 0 out — and the S2 totality
  //    product must stay exactly the floor, because the ratified −3.00 mag
  //    reveal is `modulation(1.0 × ECLIPSE_TWILIGHT_FLOOR)`.
  for (const degrees of [DAY_SATURATION_DEGREES, 30.0, 60.0, 90.0]) {
    assert.equal(estimator(degrees), 1.0, `full day at ${degrees}°`);
  }
  assert.equal(
    estimator(90.0) * ECLIPSE_TWILIGHT_FLOOR,
    ECLIPSE_TWILIGHT_FLOOR,
  );
  assert.equal(modulation(estimator(90.0)), 0.0);
}

test("D: the off-position identities are EXACT", () => {
  assertOffIdentities(shipped);
});

test("D: the ratified totality anchors are unmoved", () => {
  // HIGH-sun totality (the strongest suppression case, sun ~82° up) is the
  // anchor the shipped steepness was solved against. It must be bit-stable.
  const highSun = shipped(82.0) * ECLIPSE_TWILIGHT_FLOOR;
  assert.equal(highSun, ECLIPSE_TWILIGHT_FLOOR);
  const factor = modulation(highSun);
  assert.ok(Math.abs(factor - 0.06281) < 5e-5, `factor ${factor}`);
  assert.ok(Math.abs(2.5 * Math.log10(factor) + 3.0) < 0.02);
  // LOW-sun totality moves — deliberately, and in the documented direction.
  const lowSun = shipped(10.0) * ECLIPSE_TWILIGHT_FLOOR;
  assert.ok(Math.abs(shipped(10.0) - 0.4581406) < 5e-7);
  assert.ok(Math.abs(lowSun - 0.016878) < 5e-7, `B_totality ${lowSun}`);
  assert.ok(Math.abs(modulation(lowSun) - 0.664912) < 5e-6);
  assert.ok(
    modulation(lowSun) > factor,
    "a low-sun totality must reveal MORE than a high-sun one",
  );
});

test("D: above the scattering shell the scalar is exactly 0 at any sun", () => {
  // The C11-176 orbital regression: an orbital camera on the day side sees a
  // black sky and real stars. The column factor must zero the whole estimate
  // whatever the twilight model says.
  for (const degrees of [-18.0, -6.0, 0.0, 45.0, 90.0]) {
    assert.equal(
      computeSkyBrightness(
        directionAtElevation(degrees),
        undefined,
        0.0,
        cameraAt(111000.0),
        111000.0,
      ),
      0.0,
      `at the shell boundary with the sun at ${degrees}°`,
    );
    assert.equal(
      computeSkyBrightness(
        directionAtElevation(degrees),
        undefined,
        0.0,
        cameraAt(4.0e5),
        4.0e5,
      ),
      0.0,
      `in orbit with the sun at ${degrees}°`,
    );
  }
  // ...and below 60 km the multiply is exactly 1.0, so an in-atmosphere frame
  // is unchanged by the column law.
  assert.equal(
    computeSkyBrightness(
      directionAtElevation(90.0),
      undefined,
      0.0,
      cameraAt(59999.0),
      59999.0,
    ),
    1.0,
  );
});

test("D: a new moon contributes EXACTLY nothing", () => {
  for (const degrees of [-30.0, -18.0, -12.0, -6.0, 0.0]) {
    assert.equal(
      shippedWithMoon(degrees, 0.0),
      shipped(degrees),
      `a new moon changed the sky at ${degrees}°`,
    );
  }
  // The `−1` in FULL_MOON_ADDED_LUMINANCE is what makes this exact rather
  // than merely small: without it a moonless frame would inherit the night
  // baseline twice.
  assert.equal(shippedWithMoon(-30.0, 0.0), 0.0);
});

test("D: a misconfigured scene resolves to FULL BRIGHT, never to a dim sky", () => {
  // The module's one degenerate-input policy. The log-luminance model's own
  // "no sun" value is the DARK end, so a NaN that fell through would produce
  // a bright, starry midnight in broad daylight.
  const bad = [
    [ZENITH, { x: 0.0, y: 0.0, z: 0.0 }],
    [{ x: NaN, y: 0.0, z: 0.0 }, groundCamera],
    [ZENITH, { x: NaN, y: 0.0, z: 0.0 }],
  ];
  for (const [sun, camera] of bad) {
    assert.equal(
      computeSkyBrightness(sun, undefined, 0.0, camera, 0.0),
      1.0,
      `degenerate input ${JSON.stringify([sun, camera])} must be full bright`,
    );
  }
  assert.equal(
    computeSkyBrightness(ZENITH, undefined, 0.0, undefined, 0.0),
    1.0,
  );
  assert.equal(computeSkyBrightnessFromZenithMagnitude(NaN), 1.0);
  assert.equal(computeTwilightZenithMagnitude(NaN), DAY_ZENITH_MAGNITUDE);
});

test("MUTATION — an epsilon floor must FAIL the off-position identities", () => {
  assertOffIdentities(shipped);
  // Non-vacuity: the mutant is numerically indistinguishable from the shipped
  // model by any tolerance-based test.
  assert.ok(
    Math.abs(epsilonFloorEstimator(-30.0) - shipped(-30.0)) < 1e-5,
    "the mutant must be invisible to a tolerance check, or it proves nothing",
  );
  assert.throws(
    () => assertOffIdentities(epsilonFloorEstimator),
    "the off-position identities are being checked with a tolerance — a " +
      "1e-6 floor would ship and the OFF position would stop being identity",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// E. THE MOON'S PHOTOMETRY
// ════════════════════════════════════════════════════════════════════════════

test("E: a full moon overhead reproduces the published moonlit sky exactly", () => {
  // The sum-in-linear-luminance step must land the combined μ exactly on the
  // published full-moon zenith brightness when the sun contributes nothing.
  const brightness = shippedWithMoon(-30.0, 1.0);
  const expected = computeSkyBrightnessFromZenithMagnitude(
    FULL_MOON_ZENITH_MAGNITUDE,
  );
  assert.ok(
    Math.abs(brightness - expected) < 1e-12,
    `full moon → ${brightness}, published μ=18 → ${expected}`,
  );
});

/**
 * @param {(phase: number) => number} moonLuminance Added-luminance law.
 */
function assertPublishedPhaseFlux(moonLuminance) {
  // The published relation: a quarter moon (illuminated fraction 0.5) delivers
  // ≈8% of full-moon illuminance, not 50%.
  const ratio = moonLuminance(0.5) / moonLuminance(1.0);
  assert.ok(
    Math.abs(ratio - 0.08) < 0.005,
    `quarter-moon flux ratio ${ratio}, published ≈0.08`,
  );
}

test("E: the phase-flux law is the published one, not linear", () => {
  assertPublishedPhaseFlux(shippedMoonLuminance);
  // Monotone in phase, and the shipped estimator agrees with the law.
  let previous = -1;
  for (let i = 0; i <= 100; i++) {
    const phase = i / 100;
    const brightness = shippedWithMoon(-30.0, phase);
    assert.ok(brightness >= previous - 1e-12, `not monotone at p=${phase}`);
    previous = brightness;
  }
  assert.ok(
    modulation(shippedWithMoon(-30.0, 0.5)) >
      modulation(shippedWithMoon(-30.0, 1.0)),
    "a quarter moon must leave more stars than a full moon",
  );
});

test("MUTATION — linear phase scaling must FAIL the phase-flux check", () => {
  assertPublishedPhaseFlux(shippedMoonLuminance);
  assert.throws(
    () => assertPublishedPhaseFlux(linearPhaseMoonLuminance),
    "the phase-flux check cannot tell p from p^3.64 — the old estimator's " +
      "quarter moon was ~6× too bright and this would not catch it",
  );
});

// ════════════════════════════════════════════════════════════════════════════
// F. ONE CURVE, TWO MODULES — the enforced-identity the source promises
// ════════════════════════════════════════════════════════════════════════════

test("F: SkyBrightness's copy of the curve constants matches StarFieldMath", () => {
  const constant = (name) => {
    const match = skyBrightnessJs.match(
      new RegExp(`const ${name} =\\s*(-?[0-9.]+);`),
    );
    assert.ok(match, `${name} not found as a numeric constant`);
    return Number(match[1]);
  };
  assert.equal(constant("STAR_CURVE_INFLECTION"), STAR_MODULATION_INFLECTION);
  assert.equal(constant("STAR_CURVE_STEEPNESS"), STAR_MODULATION_STEEPNESS);
  // The cycle the duplication exists to avoid must still be real, or the
  // duplication should be deleted rather than pinned.
  assert.match(
    starFieldMathTs,
    /from "\.\/SkyBrightness\.js";/,
    "StarFieldMath imports SkyBrightness, so SkyBrightness cannot import back",
  );
  assert.ok(
    !/from "\.\/StarFieldMath/.test(skyBrightnessJs),
    "SkyBrightness must not import StarFieldMath — that is the cycle",
  );
});

test("F: inside the star window the transfer exactly inverts the curve", () => {
  // This is the calibration claim: for every μ where naked-eye stars exist,
  // `modulation(transfer(μ))` IS the NELM-chain visibility factor. If it
  // holds, every published limit above is a consequence rather than a fit.
  for (let mu = 8.0; mu <= NIGHT_ZENITH_MAGNITUDE; mu += 0.1) {
    const expected = Math.pow(
      10.0,
      -0.4 * NELM_PER_ZENITH_MAGNITUDE * (NIGHT_ZENITH_MAGNITUDE - mu),
    );
    const actual = modulation(computeSkyBrightnessFromZenithMagnitude(mu));
    assert.ok(
      Math.abs(actual - expected) < 1e-9,
      `μ=${mu}: transfer∘curve gives ${actual}, NELM chain gives ${expected}`,
    );
  }
  // ...and the window really is [0, 1/steepness], so the daylight segment
  // above μ = 8 cannot leak star light back in.
  assert.equal(modulation(1.0 / STAR_MODULATION_STEEPNESS), 0.0);
  assert.ok(
    computeSkyBrightnessFromZenithMagnitude(8.0) <
      1.0 / STAR_MODULATION_STEEPNESS,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// G. THE DOC CARRIES THE NUMBERS THIS SPEC DERIVES
//
// The C12-34 row exists because two measured consequences were recorded in a
// comment and then drifted out of agreement with the code. Pin the comment to
// the code so that cannot recur.
// ════════════════════════════════════════════════════════════════════════════

test("G: the measured-consequences block states the derived values", () => {
  const block = starFieldMathTs.slice(
    starFieldMathTs.indexOf("The steepness is set by the totality anchor"),
    starFieldMathTs.indexOf("/** Default modulation-curve inflection"),
  );
  assert.ok(block.length > 500, "the derivation block is missing");
  for (const literal of [
    "0.0322377",
    "0.165959",
    "4.55",
    "0.0418355",
    "0.004175",
    "0.026303",
    "0.363078",
    "0.604705",
    "0.098257",
    "0.062810",
    "0.664912",
  ]) {
    assert.ok(
      block.includes(literal),
      `the measured-consequences block must state ${literal}`,
    );
  }
  // The two endpoints that make the curve's range claim checkable: the
  // documented daylight zero, and the statement that the bands stay separated
  // above −6°. A curve with no twilight range satisfies neither.
  assert.match(
    block,
    /\+23\.6 \|\s*0\.000000/,
    "the block must state the daylight endpoint as exactly zero",
  );
  assert.match(
    block,
    /bands are monotone and separated across the full range/,
    "the block must state the band-separation property the range check enforces",
  );
  // And the numbers must still be true.
  assert.ok(Math.abs(modulation(shipped(-15.0)) - 0.604705) < 5e-6);
  assert.ok(Math.abs(modulation(shipped(-9.0)) - 0.098257) < 5e-6);
  const span = modulation(shipped(-18.0)) - modulation(shipped(-6.0));
  assert.ok(Math.abs(span - 0.973697) < 5e-6, `span ${span}`);
  assert.ok(
    Math.abs(modulation(legacyEstimator(-30.0, 1.0)) - 0.018176) < 5e-6,
    "the legacy full-moon value the block quotes",
  );
});

test("G: no shader was touched, so no lockstep pair is owed", () => {
  // C12-34 is a CPU-side estimator change whose output travels on an existing
  // uniform (`u_skyBrightness` / `params.w`). Principle 5 applies to new
  // shader features; this one must not have grown a shader half in either
  // backend, and the four modulation implementations stay byte-identical.
  const expression =
    /let t = clamp\(\(skyBrightness - inflection\) \* steepness, 0\.0, 1\.0\);/;
  for (const rel of [
    "packages/engine/Source/Shaders/WebGPU/CubeMapPanorama.wgsl",
    "packages/engine/Source/Renderer/WebGPU/WebGPUCubeMapPanoramaRenderer.js",
  ]) {
    const source = read(rel);
    assert.match(source, expression, rel);
    assert.ok(
      !/ZENITH_MAGNITUDE|twilight|NELM/i.test(source),
      `${rel} must not have grown a copy of the CPU photometry model`,
    );
  }
  const glsl = read("packages/engine/Source/Shaders/SkyBoxFS.glsl");
  assert.match(
    glsl,
    /float t = clamp\(\(u_skyBrightness - u_starModulation\.x\) \* u_starModulation\.y, 0\.0, 1\.0\);/,
  );
  assert.ok(!/ZENITH_MAGNITUDE|NELM/i.test(glsl));
});
