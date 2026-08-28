/**
 * Pure, browser-independent acceptance policy for the dawn sun-disc sweep.
 * @purpose Gate-predicate library for the sun-disc dawn sweep, scoring disc-centre vs disc-annulus luminance and chroma per backend with WebGL as the parity control.
 * @status ACTIVE
 *
 * THE SUBJECT. A maintainer screenshot (2026-08-24) shows a small dark,
 * brownish spot at the centre of the rendered solar disc, inside the bright
 * core, with the sun a few degrees above the horizon. This module owns the
 * arithmetic that decides whether a sweep across sunrise reproduces that: for
 * each sample it forms the ratio of the disc CENTRE's mean luminance to the
 * disc ANNULUS's mean luminance, and the same ratio in chroma.
 *
 * WHY CENTRE-VS-ANNULUS IS THE RIGHT OBSERVABLE. The shipped bake writes a
 * limb-darkened disc whose blend weight is `a0 + a1*mu + a2*mu^2` — exactly
 * 1.0 at the centre and a0 at the limb. A correct composite is therefore
 * BRIGHTEST at the centre whatever the sky behind it is doing, so a ratio at
 * or below 1 is an inversion of the shipped intensity law rather than a
 * judgement about how bright a sun ought to look. The reference ratio for a
 * disc composited over a black sky is derived below from the shipped
 * coefficients themselves, so the instrument does not carry a tuned number
 * standing in for the engine's own statement of the law.
 *
 * WHAT THE WebGL LEG IS, AND IS NOT. The pre-registration is explicit that the
 * FAIL bar is derived from the first WebGL sweep and never from WebGPU. That
 * makes the WebGL leg a PARITY control: it answers "does WebGPU composite the
 * disc the way WebGL does". It is NOT a health reference. The two backends
 * draw this billboard from one shared scene-level resolution and two twin
 * shaders, so a defect in that shared layer appears on both legs and a bar
 * derived from WebGL would then certify agreement rather than correctness.
 * `limbLawReferenceRatio` exists so that case stays legible: it is an
 * engine-internal reference that depends on neither backend.
 *
 * BLINDNESS OUTRANKS EVERYTHING. A sample the lane could not read — no
 * published sun geometry, a disc too small to separate a centre from an
 * annulus, an unpopulated region, a black annulus that cannot form a ratio —
 * routes STRUCTURAL (exit 3), never FAIL. A lane that could not see its
 * subject has no standing to report on it.
 */

import { exitCodeForS5Status } from "./verdict-exit-gate.mjs";

/** Evidence schema this gate reads. */
export const SUN_DISC_DAWN_SCHEMA = "sun-disc-dawn-evidence-v1";

/** The two legs, in the order the probe acquires them. */
export const SUN_DISC_DAWN_RENDERERS = Object.freeze(["webgl", "webgpu"]);

/**
 * The reproduction site, read off the maintainer's saved-view query string.
 * The screenshot truncated the heading/pitch/roll terms, so the probe derives
 * a low-sun pose at this position instead of replaying a partial view.
 */
export const SUN_DISC_DAWN_SITE = Object.freeze({
  longitudeDegrees: 107.5215780802716,
  latitudeDegrees: 35.05292293726632,
  heightMeters: 1175.3399698570242,
});

/** The clock instant the screenshot itself carries. */
export const SUN_DISC_DAWN_REPORTED_INSTANT_ISO = "2026-08-24T23:01:41Z";

/**
 * The dawn sweep.
 *
 * The window is DERIVED, not guessed: evaluating the engine's own
 * `Simon1994PlanetaryPositions` sun position against an east-north-up frame at
 * the site gives -1.89 deg at the start instant and +10.17 deg at the last
 * sample, so thirteen five-minute steps span the pre-registered -2 deg to
 * +10 deg band. The screenshot's own instant sits inside the window at
 * +8.48 deg, which is what "a few degrees above the horizon" was.
 *
 * The probe records the altitude the ENGINE reports at each sample rather than
 * trusting this derivation, and the coverage predicate below scores the
 * recorded values. A window that no longer spans the band is blindness, not a
 * failure of the subject.
 *
 * THOSE TWO NUMBERS ARE FRAME-DEPENDENT, and the derivation above is the
 * TEME-fallback branch. `Simon1994EphemerisProvider.compute` asks
 * `Transforms.computeIcrfToFixedMatrix` for the inertial-to-fixed rotation and
 * falls back to `computeTemeToPseudoFixedMatrix` when the IAU-2006 XYS chunks
 * have not loaded. A lane with no server for those chunks always takes the
 * fallback, which carries Earth rotation but neither precession nor nutation; a
 * browser served from localhost loads them and takes the ICRF branch. At this
 * epoch the two branches differ by the precession accumulated since J2000, and
 * the 2026-08-28 acquisition measured that difference as -0.3592 deg at the
 * first sample drifting to -0.3629 deg at the last, identically on both
 * backends. Re-evaluating the thirteen instants offline reproduces the derived
 * table to 1e-6 deg on the TEME branch and the acquired altitudes to 1e-6 deg
 * on the ICRF branch, so the offset is the transform branch and nothing else -
 * not refraction, which varies strongly across this altitude band, and not a
 * disc-centre versus limb convention, which cannot move a registration.
 *
 * The band below keeps its registered values, because a registered bound is not
 * moved to accommodate an observation. Record only that the +9.5 deg upper
 * requirement carries less margin against the acquired altitudes (0.31 deg)
 * than the branch offset it is blind to, so a sweep that moves this window must
 * re-derive the band on the branch it will actually run under.
 */
export const SUN_DISC_DAWN_SWEEP = Object.freeze({
  startIso: "2026-08-24T22:10:00Z",
  stepMinutes: 5,
  sampleCount: 13,
  requiredLowAltitudeDegrees: -1.5,
  requiredHighAltitudeDegrees: 9.5,
  maximumAltitudeDisagreementDegrees: 0.05,
  minimumScoredSamples: 8,
});

/** Drawing-buffer size both legs are acquired at. */
export const SUN_DISC_DAWN_VIEWPORT = Object.freeze({
  width: 1280,
  height: 720,
});

/**
 * The readiness budget for the globe this sweep is composited against.
 *
 * On WebGPU a globe tile whose pipeline variant is not already resident is not
 * drawn at all in that frame: the surface renderer asks the central cache for a
 * pipeline synchronously, gets null on a miss, and skips the tile, so no
 * `Pass.GLOBE` command is binned until an asynchronous creation lands. WebGL
 * compiles its program at execute time and has no analogue. `tilesLoaded`
 * reports TILE residency and says nothing about pipeline residency, so a settle
 * loop that exits on it captures a globe-less WebGPU frame beside a complete
 * WebGL one - which is what the 2026-08-28 acquisition did. Its published
 * 0.1030 and 0.1048 parity deltas at the two lowest samples are that missing
 * globe, not anything about the sun. The measured cost of one cold variant
 * elsewhere in the fleet is about 1.9 s.
 *
 * The gate is spent ONCE per leg, at the lowest-sun view where the globe fills
 * the frame, because the sweep uses one terrain encoding and therefore one
 * pipeline variant. It is deliberately not spent per sample: with the camera
 * tracking a sun ten degrees up, no globe tile intersects a 3 deg frustum at
 * all, so a per-sample "at least one globe command" test would read an ordinary
 * empty sky as blindness.
 */
export const SUN_DISC_DAWN_READINESS = Object.freeze({
  initialTimeoutMs: 45_000,
  pollMs: 50,
  settleFrames: 8,
});

/**
 * Worst-case wall clock the readiness gate can add to a run, both legs
 * included. The probe sizes its own run watchdog from this rather than from a
 * literal, so the budget cannot quietly outgrow the fuse that bounds it.
 */
export const SUN_DISC_DAWN_READINESS_WORST_CASE_MS =
  SUN_DISC_DAWN_RENDERERS.length * SUN_DISC_DAWN_READINESS.initialTimeoutMs;

/**
 * The vertical field of view the probe forces, in degrees.
 *
 * At the engine default of 60 deg the sun's 0.5327 deg angular diameter lands
 * on a disc roughly 3 px in radius, which cannot carry a centre-versus-annulus
 * measurement at all. At 3 deg the same disc spans about 64 px of radius, so
 * the centre core and the limb annulus are separately resolvable. This is a
 * deliberate departure from the reported scene and the probe discloses it.
 */
export const SUN_DISC_DAWN_FIELD_OF_VIEW_DEGREES = 3;

/**
 * Region geometry, as fractions of the sun's projected limb radius.
 *
 * The centre core stops well inside the limb and the annulus starts well
 * outside the core, so a one- or two-pixel error in the projected centre
 * cannot leak annulus pixels into the core sample or the reverse.
 */
export const SUN_DISC_DAWN_REGIONS = Object.freeze({
  centreOuterFraction: 0.35,
  annulusInnerFraction: 0.7,
  annulusOuterFraction: 1.0,
  minimumRegionPixels: 48,
  minimumLimbPixels: 24,
});

/**
 * The shipped quadratic limb-darkening triple.
 *
 * These are a COPY of `Scene/SolarDiscModel.js`'s
 * `SOLAR_LIMB_DARKENING_A0/A1/A2`, kept here so this module stays free of an
 * engine import. `sun-disc-dawn-gate.spec.mjs` re-reads the engine constants
 * and fails when the copy drifts, so the duplication is checked rather than
 * trusted.
 */
export const SUN_DISC_DAWN_LIMB_COEFFICIENTS = Object.freeze({
  a0: 0.3,
  a1: 0.93,
  a2: -0.23,
});

/** Midpoint-quadrature resolution for the area-weighted limb means. */
export const SUN_DISC_DAWN_LIMB_QUADRATURE_STEPS = 4096;

/**
 * The shipped intensity law at a normalized disc radius.
 *
 * @param {number} x Radius as a fraction of the limb, clamped to [0, 1].
 * @returns {number} `a0 + a1*mu + a2*mu^2`, 1.0 at the centre and a0 at the limb.
 */
export function limbIntensity(x) {
  const clamped = Math.min(1, Math.max(0, x));
  const mu = Math.sqrt(Math.max(0, 1 - clamped * clamped));
  const { a0, a1, a2 } = SUN_DISC_DAWN_LIMB_COEFFICIENTS;
  return a0 + a1 * mu + a2 * mu * mu;
}

/**
 * Area-weighted mean of the intensity law over an annulus.
 *
 * Area-weighted because the probe averages PIXELS, and the pixel count in a
 * ring grows with its radius. An unweighted mean would over-count the core of
 * each region and is not what the measured means converge to.
 *
 * @param {number} innerFraction Inner radius as a fraction of the limb.
 * @param {number} outerFraction Outer radius as a fraction of the limb.
 * @param {number} [steps] Quadrature resolution.
 * @returns {number} The area-weighted mean intensity.
 */
export function meanLimbIntensity(
  innerFraction,
  outerFraction,
  steps = SUN_DISC_DAWN_LIMB_QUADRATURE_STEPS,
) {
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < steps; index++) {
    const x =
      innerFraction + ((index + 0.5) / steps) * (outerFraction - innerFraction);
    numerator += limbIntensity(x) * x;
    denominator += x;
  }
  return denominator > 0 ? numerator / denominator : Number.NaN;
}

/**
 * Centre-over-annulus ratio the shipped law alone predicts, for a disc
 * composited over a black sky.
 *
 * Backend-independent, and the only reference in this module that does not
 * come from a measurement. Over any sky brighter than black the composite
 * ratio falls toward 1 from above; it cannot fall BELOW 1 while the disc is
 * brighter than its background, which is what makes a sub-unity measurement
 * an inversion rather than a dim sun.
 */
export const SUN_DISC_DAWN_LIMB_REFERENCE_RATIO =
  meanLimbIntensity(0, SUN_DISC_DAWN_REGIONS.centreOuterFraction) /
  meanLimbIntensity(
    SUN_DISC_DAWN_REGIONS.annulusInnerFraction,
    SUN_DISC_DAWN_REGIONS.annulusOuterFraction,
  );

/**
 * The FAIL bar.
 *
 * DERIVED-PENDING on this landing: the authoring lane does not run browsers,
 * so no WebGL sweep exists to derive it from, and deriving it from a WebGPU
 * sweep is forbidden by the row's own pre-registration. Every bound is `null`,
 * which the scorer reads as "this family has no standing to pass or fail" and
 * folds to STRUCTURAL — not as "everything passes".
 *
 * A caller may supply a derived bar through `evaluateSunDiscDawnSweep`'s
 * options. That is the path the machine lane takes once the first WebGL sweep
 * exists, and it is the path the spec takes to prove the FAIL branch is live.
 */
export const SUN_DISC_DAWN_BAR = Object.freeze({
  status: "DERIVED-PENDING",
  derivedFrom: "the first WebGL sweep, never a WebGPU sweep",
  minimumCentreAnnulusRatio: null,
  minimumCentreAnnulusChromaRatio: null,
  maximumParityDelta: null,
});

/** Verdict a family carries when its bound has never been derived. */
export const SUN_DISC_DAWN_NOT_PROVEN = "NOT-PROVEN";

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Degrees per radian, so the derivations below carry no bare literal. */
const DEGREES_PER_RADIAN = 180 / Math.PI;

/**
 * Dip of the local horizon below the local horizontal, in degrees.
 *
 * Negative by construction: an observer at height `h` over a body of radius
 * `R` sees the horizon at `-acos(R / (R + h))`. Both terms are published by
 * the probe from the engine's own ellipsoid rather than written here as
 * literals, so this stays a derivation over measured inputs.
 *
 * The site sits on an ellipsoid, so `R` is the geocentric radius under the
 * site while `h` is the geodetic height, and the two are measured along
 * directions that differ by the deviation of the vertical - about 0.18 deg at
 * this latitude. The resulting error in the dip is under 0.002 deg, two orders
 * below the solar semi-diameter it is compared against, and the nearest sample
 * in this sweep sits 0.4 deg from the threshold.
 *
 * @param {number} localEarthRadiusMeters Geocentric radius under the site.
 * @param {number} heightMeters Site height above the ellipsoid.
 * @returns {number|null} The dip in degrees, or null when a term is unreadable.
 */
export function horizonDipDegrees(localEarthRadiusMeters, heightMeters) {
  if (
    !finitePositive(localEarthRadiusMeters) ||
    !finiteNonNegative(heightMeters)
  ) {
    return null;
  }
  const ratio =
    localEarthRadiusMeters / (localEarthRadiusMeters + heightMeters);
  return -Math.acos(Math.min(1, Math.max(-1, ratio))) * DEGREES_PER_RADIAN;
}

/**
 * Whether the WHOLE solar disc clears the local horizon at one sample.
 *
 * The bar is "fully above", not "centre above", because the measurement regions
 * lie INSIDE the disc - the core out to 0.35 of the limb radius and the annulus
 * from 0.7 to 1.0. A disc the Earth has bitten into fills part of that annulus
 * with globe pixels rather than sky, so the sun's own semi-diameter is
 * subtracted before the comparison. Against the 2026-08-28 acquisition the
 * predicate reproduces the pixels exactly: the two samples whose WebGL frames
 * carry globe inside the disc window are the two samples it excludes.
 *
 * @param {object} observed One sample's observation record.
 * @returns {boolean|null} True when the whole disc clears the horizon; null when unreadable.
 */
export function sunAboveLocalHorizon(observed) {
  const altitude = observed?.sunAltitudeDegrees;
  const semiDiameter = observed?.solarAngularRadiusDegrees;
  const dip = horizonDipDegrees(
    observed?.localEarthRadiusMeters,
    observed?.siteHeightMeters,
  );
  if (
    !Number.isFinite(altitude) ||
    !finiteNonNegative(semiDiameter) ||
    dip === null
  ) {
    return null;
  }
  return altitude - semiDiameter >= dip;
}

/**
 * Centre-over-annulus luminance ratio for one sample.
 *
 * @param {object} sample One acquired sample record.
 * @returns {number|null} The ratio, or null when it cannot be formed.
 */
export function centreAnnulusRatio(sample) {
  const centre = sample?.regions?.centre?.meanLuminance;
  const annulus = sample?.regions?.annulus?.meanLuminance;
  if (!finiteNonNegative(centre) || !finitePositive(annulus)) {
    return null;
  }
  return centre / annulus;
}

/**
 * Centre-over-annulus CHROMA ratio for one sample.
 *
 * The reported artifact is brownish, not merely dark, so the instrument
 * measures the hue shift as well as the dimming: each region's blue-over-red
 * mean is formed, and the centre's is expressed as a fraction of the annulus's.
 * A centre that has lost blue relative to its own limb drives this below 1.
 *
 * @param {object} sample One acquired sample record.
 * @returns {number|null} The ratio, or null when it cannot be formed.
 */
export function centreAnnulusChromaRatio(sample) {
  const centre = sample?.regions?.centre;
  const annulus = sample?.regions?.annulus;
  if (
    !finitePositive(centre?.meanR) ||
    !finiteNonNegative(centre?.meanB) ||
    !finitePositive(annulus?.meanR) ||
    !finitePositive(annulus?.meanB)
  ) {
    return null;
  }
  const centreBlueOverRed = centre.meanB / centre.meanR;
  const annulusBlueOverRed = annulus.meanB / annulus.meanR;
  if (!finitePositive(annulusBlueOverRed)) {
    return null;
  }
  return centreBlueOverRed / annulusBlueOverRed;
}

/**
 * Whether one sample carries a solar disc the lane is expected to measure.
 *
 * The sweep deliberately opens below the local horizon, where the disc the
 * instrument measures is behind the Earth. Such a sample is not blindness and
 * not a failure; it is a sample with no subject in it, and it is excluded from
 * scoring rather than scored as a ratio of sky against sky.
 *
 * THE ENGINE'S OWN VISIBILITY FLAG IS NOT THAT TEST, AND CANNOT BE.
 * `Scene.updateEnvironment` culls the sun only when its SIX-SOLAR-RADII glow
 * bounding sphere lies entirely inside the Earth occluder's horizon cone, which
 * is a far deeper condition than the disc being occulted. The 2026-08-28
 * acquisition measured `isSunVisible === true` on all thirteen samples of both
 * legs, including the two below the horizon - so a predicate resting on that
 * flag alone scores a below-horizon sample as sky over sky, which is precisely
 * the outcome this function's own prose says it prevents. The flag is retained
 * as a necessary term, because a culled sun genuinely has no disc, and the
 * geometric horizon test is added as the sufficient one.
 *
 * @param {object} sample One acquired sample record.
 * @returns {boolean} True when the sample should be scored.
 */
export function sampleIsScored(sample) {
  return (
    sample?.observed?.sunVisible === true &&
    sunAboveLocalHorizon(sample?.observed) === true
  );
}

/**
 * Reasons one sample cannot be read.
 *
 * @param {string} renderer Backend label.
 * @param {number} index Sample index.
 * @param {object} sample The sample record.
 * @returns {string[]} Structural reasons; empty when the sample is readable.
 */
export function sampleStructuralReasons(renderer, index, sample) {
  const where = `${renderer}:sample${index}`;
  if (sample === null || typeof sample !== "object") {
    return [`${where}:absent`];
  }
  const reasons = [];
  for (const reason of Array.isArray(sample.reasons) ? sample.reasons : []) {
    reasons.push(`${where}:${String(reason)}`);
  }
  const observed = sample.observed;
  if (observed === null || typeof observed !== "object") {
    reasons.push(`${where}:observation-absent`);
    return reasons;
  }
  if (!Number.isFinite(observed.sunAltitudeDegrees)) {
    reasons.push(`${where}:altitude-unreadable`);
  }
  if (observed.skyAtmosphereVisible !== true) {
    reasons.push(`${where}:sky-atmosphere-hidden`);
  }
  if (typeof observed.sunVisible !== "boolean") {
    reasons.push(`${where}:sun-visibility-unreadable`);
  }
  // Without these the horizon test silently degenerates to the engine's own
  // cull flag, which is the defect the predicate above exists to close. An
  // acquisition that does not publish them is unreadable, not permissive.
  if (sunAboveLocalHorizon(observed) === null) {
    reasons.push(`${where}:horizon-geometry-unreadable`);
  }
  // The disc is composited over whatever the frame already holds, so a leg that
  // never got its globe on screen is measuring a different scene from the leg
  // that did. Read on EVERY sample, scored or not: the excluded low samples are
  // exactly the ones whose frames the globe should fill.
  if (observed.globeReady !== true) {
    reasons.push(`${where}:globe-not-ready`);
  }
  if (
    observed.frame?.width !== SUN_DISC_DAWN_VIEWPORT.width ||
    observed.frame?.height !== SUN_DISC_DAWN_VIEWPORT.height
  ) {
    reasons.push(`${where}:frame-dimensions`);
  }
  // Everything below describes a DISC. A sample the engine culled has none,
  // so demanding one there would convert an ordinary pre-sunrise frame into
  // blindness and take the whole sweep down with it.
  if (!sampleIsScored(sample)) {
    return reasons;
  }
  if (observed.geometryValid !== true) {
    reasons.push(`${where}:sun-geometry-invalid`);
  }
  if (
    !finitePositive(observed.limbPx) ||
    observed.limbPx < SUN_DISC_DAWN_REGIONS.minimumLimbPixels
  ) {
    reasons.push(`${where}:limb-below-resolution`);
  }
  for (const region of ["centre", "annulus"]) {
    const record = sample.regions?.[region];
    if (record === null || typeof record !== "object") {
      reasons.push(`${where}:${region}-region-absent`);
      continue;
    }
    if (
      !Number.isInteger(record.pixels) ||
      record.pixels < SUN_DISC_DAWN_REGIONS.minimumRegionPixels
    ) {
      reasons.push(`${where}:${region}-region-underpopulated`);
    }
    for (const channel of ["meanR", "meanG", "meanB", "meanLuminance"]) {
      if (!finiteNonNegative(record[channel])) {
        reasons.push(`${where}:${region}-${channel}-unreadable`);
      }
    }
  }
  if (
    sample.regions?.annulus &&
    !finitePositive(sample.regions.annulus.meanLuminance)
  ) {
    reasons.push(`${where}:annulus-black`);
  }
  return reasons;
}

function sweepStructuralReasons(evidence) {
  const reasons = [];
  const samples = evidence?.samples;
  if (samples === null || typeof samples !== "object") {
    return ["sweep:samples-absent"];
  }
  for (const renderer of SUN_DISC_DAWN_RENDERERS) {
    const leg = samples[renderer];
    if (!Array.isArray(leg)) {
      reasons.push(`sweep:${renderer}:leg-absent`);
      continue;
    }
    if (leg.length !== SUN_DISC_DAWN_SWEEP.sampleCount) {
      reasons.push(`sweep:${renderer}:sample-count`);
    }
    leg.forEach((sample, index) => {
      if (sample === null || typeof sample !== "object") {
        reasons.push(`sweep:${renderer}:sample${index}:absent`);
        return;
      }
      if (sample.index !== index) {
        reasons.push(`sweep:${renderer}:sample${index}:index-mismatch`);
      }
    });
  }
  return reasons;
}

function altitudes(leg) {
  return leg.map((sample) => sample?.observed?.sunAltitudeDegrees);
}

function coverageReasons(evidence) {
  const reasons = [];
  for (const renderer of SUN_DISC_DAWN_RENDERERS) {
    const leg = evidence.samples[renderer];
    const recorded = altitudes(leg);
    for (let index = 1; index < recorded.length; index++) {
      if (!(recorded[index] > recorded[index - 1])) {
        reasons.push(`sweep:${renderer}:altitude-not-monotone`);
        break;
      }
    }
    const lowest = Math.min(...recorded);
    const highest = Math.max(...recorded);
    if (
      !(lowest <= SUN_DISC_DAWN_SWEEP.requiredLowAltitudeDegrees) ||
      !(highest >= SUN_DISC_DAWN_SWEEP.requiredHighAltitudeDegrees)
    ) {
      reasons.push(`sweep:${renderer}:altitude-coverage`);
    }
  }
  const [first, second] = SUN_DISC_DAWN_RENDERERS;
  const left = altitudes(evidence.samples[first]);
  const right = altitudes(evidence.samples[second]);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const delta = Math.abs(left[index] - right[index]);
    if (!(delta <= SUN_DISC_DAWN_SWEEP.maximumAltitudeDisagreementDegrees)) {
      reasons.push(`sweep:altitude-disagreement:sample${index}`);
      break;
    }
  }

  // The two legs must agree about WHICH samples carry a disc. If they do not,
  // the parity family would be comparing a measured disc against an empty sky
  // and reporting the difference as a ratio delta. That disagreement is itself
  // a parity finding, so it is surfaced rather than absorbed.
  const leftScored = evidence.samples[first].map(sampleIsScored);
  const rightScored = evidence.samples[second].map(sampleIsScored);
  for (
    let index = 0;
    index < Math.min(leftScored.length, rightScored.length);
    index++
  ) {
    if (leftScored[index] !== rightScored[index]) {
      reasons.push(`sweep:visibility-disagreement:sample${index}`);
      break;
    }
  }
  for (const renderer of SUN_DISC_DAWN_RENDERERS) {
    const scored = evidence.samples[renderer].filter(sampleIsScored).length;
    if (scored < SUN_DISC_DAWN_SWEEP.minimumScoredSamples) {
      reasons.push(`sweep:${renderer}:too-few-scored-samples`);
    }
  }
  return reasons;
}

function scoreMinimumFamily(id, subject, observations, bound) {
  const readable = observations.filter((entry) => entry.value !== null);
  const worst = readable.reduce(
    (lowest, entry) =>
      lowest === null || entry.value < lowest.value ? entry : lowest,
    null,
  );
  if (worst === null) {
    return {
      id,
      subject,
      verdict: SUN_DISC_DAWN_NOT_PROVEN,
      reason: `${id}:no-readable-samples`,
      observed: null,
      bound: bound ?? null,
      samples: observations,
    };
  }
  if (bound === null || bound === undefined) {
    return {
      id,
      subject,
      verdict: SUN_DISC_DAWN_NOT_PROVEN,
      reason: "bar:derived-pending",
      observed: worst,
      bound: null,
      samples: observations,
    };
  }
  const pass = worst.value >= bound;
  return {
    id,
    subject,
    verdict: pass ? "PASS" : "FAIL",
    reason: pass ? "at or above the derived bar" : `${id}:below-bar`,
    observed: worst,
    bound,
    samples: observations,
  };
}

function scoreMaximumFamily(id, subject, observations, bound) {
  const readable = observations.filter((entry) => entry.value !== null);
  const worst = readable.reduce(
    (highest, entry) =>
      highest === null || entry.value > highest.value ? entry : highest,
    null,
  );
  if (worst === null) {
    return {
      id,
      subject,
      verdict: SUN_DISC_DAWN_NOT_PROVEN,
      reason: `${id}:no-readable-samples`,
      observed: null,
      bound: bound ?? null,
      samples: observations,
    };
  }
  if (bound === null || bound === undefined) {
    return {
      id,
      subject,
      verdict: SUN_DISC_DAWN_NOT_PROVEN,
      reason: "bar:derived-pending",
      observed: worst,
      bound: null,
      samples: observations,
    };
  }
  const pass = worst.value <= bound;
  return {
    id,
    subject,
    verdict: pass ? "PASS" : "FAIL",
    reason: pass ? "at or below the derived bar" : `${id}:above-bar`,
    observed: worst,
    bound,
    samples: observations,
  };
}

/**
 * Score one acquired dawn sweep.
 *
 * @param {object} evidence The probe's acquisition record.
 * @param {object} [options] Scoring options.
 * @param {object} [options.bar] A derived bar replacing {@link SUN_DISC_DAWN_BAR}.
 * @returns {object} The verdict, its exit code, the families and the reasons.
 */
export function evaluateSunDiscDawnSweep(evidence, options = {}) {
  const bar = options.bar ?? SUN_DISC_DAWN_BAR;
  const structural = sweepStructuralReasons(evidence);
  // The shape check runs first and alone: the per-sample and coverage readers
  // index into the two legs, so running them over a malformed evidence object
  // would throw where the whole point is to REPORT that it is malformed.
  if (structural.length === 0) {
    for (const renderer of SUN_DISC_DAWN_RENDERERS) {
      evidence.samples[renderer].forEach((sample, index) => {
        structural.push(...sampleStructuralReasons(renderer, index, sample));
      });
    }
    structural.push(...coverageReasons(evidence));
  }

  // A lane that could not see its subject does not get to score it. Scoring a
  // sweep with an unreadable sample in it still produces a number, and a
  // number is indistinguishable from a measurement once it reaches an
  // artifact — which is how a blind lane comes to publish a verdict.
  const scoreable = structural.length === 0;
  const measurements = scoreable ? buildMeasurements(evidence) : {};
  const families = scoreable ? scoreFamilies(measurements, bar) : [];
  return foldVerdict({ bar, structural, families, measurements });
}

function buildMeasurements(evidence) {
  const measurements = {};
  for (const renderer of SUN_DISC_DAWN_RENDERERS) {
    measurements[renderer] = evidence.samples[renderer].map((sample) => {
      const scored = sampleIsScored(sample);
      // Publish every term `scored` was formed from. A row that says only
      // "scored: true" cannot be audited from the artifact, and the 2026-08-28
      // acquisition is exactly that: thirteen rows all scored, none carrying
      // the visibility the flag was read from.
      return {
        index: sample.index,
        requestedIso: sample.requestedIso,
        sunAltitudeDegrees: sample.observed.sunAltitudeDegrees,
        sunVisible: sample.observed.sunVisible ?? null,
        sunAboveLocalHorizon: sunAboveLocalHorizon(sample.observed),
        solarAngularRadiusDegrees:
          sample.observed.solarAngularRadiusDegrees ?? null,
        horizonDipDegrees: horizonDipDegrees(
          sample.observed.localEarthRadiusMeters,
          sample.observed.siteHeightMeters,
        ),
        geometryValid: sample.observed.geometryValid ?? null,
        globeReady: sample.observed.globeReady ?? null,
        globeCommands: sample.observed.globeCommands ?? null,
        icrfFrameResolved: sample.observed.icrfFrameResolved ?? null,
        scored,
        centreAnnulusRatio: scored ? centreAnnulusRatio(sample) : null,
        centreAnnulusChromaRatio: scored
          ? centreAnnulusChromaRatio(sample)
          : null,
        centreLuminance: sample.regions?.centre?.meanLuminance ?? null,
        annulusLuminance: sample.regions?.annulus?.meanLuminance ?? null,
        extinction: sample.observed.extinction ?? null,
      };
    });
  }
  return measurements;
}

function scoreFamilies(measurements, bar) {
  const families = [];
  for (const renderer of SUN_DISC_DAWN_RENDERERS) {
    families.push(
      scoreMinimumFamily(
        `ratio:${renderer}`,
        "disc-centre over disc-annulus luminance",
        measurements[renderer].map((entry) => ({
          index: entry.index,
          sunAltitudeDegrees: entry.sunAltitudeDegrees,
          value: entry.centreAnnulusRatio,
        })),
        bar.minimumCentreAnnulusRatio,
      ),
    );
    families.push(
      scoreMinimumFamily(
        `chroma:${renderer}`,
        "disc-centre over disc-annulus blue-over-red",
        measurements[renderer].map((entry) => ({
          index: entry.index,
          sunAltitudeDegrees: entry.sunAltitudeDegrees,
          value: entry.centreAnnulusChromaRatio,
        })),
        bar.minimumCentreAnnulusChromaRatio,
      ),
    );
  }

  const [control, subject] = SUN_DISC_DAWN_RENDERERS;
  families.push(
    scoreMaximumFamily(
      "parity",
      `${subject} minus ${control} centre-annulus ratio`,
      measurements[subject].map((entry, index) => {
        const other = measurements[control][index];
        const value =
          entry.centreAnnulusRatio === null || other.centreAnnulusRatio === null
            ? null
            : Math.abs(entry.centreAnnulusRatio - other.centreAnnulusRatio);
        return {
          index: entry.index,
          sunAltitudeDegrees: entry.sunAltitudeDegrees,
          value,
        };
      }),
      bar.maximumParityDelta,
    ),
  );
  return families;
}

function foldVerdict({ bar, structural, families, measurements }) {
  const failures = families
    .filter((family) => family.verdict === "FAIL")
    .map((family) => family.reason);
  const unproven = families.filter(
    (family) => family.verdict === SUN_DISC_DAWN_NOT_PROVEN,
  );
  // The single precedence site. Blindness outranks a verdict, and a family
  // whose bound was never derived is a third kind of blindness rather than a
  // pass — an un-barred instrument has no standing to certify anything.
  const blind =
    structural.length > 0 || families.length === 0 || unproven.length > 0;
  const status = blind ? "STRUCTURAL" : failures.length > 0 ? "FAIL" : "PASS";
  return {
    schema: SUN_DISC_DAWN_SCHEMA,
    bar: {
      status: bar.status ?? "DERIVED-PENDING",
      minimumCentreAnnulusRatio: bar.minimumCentreAnnulusRatio ?? null,
      minimumCentreAnnulusChromaRatio:
        bar.minimumCentreAnnulusChromaRatio ?? null,
      maximumParityDelta: bar.maximumParityDelta ?? null,
    },
    limbLawReferenceRatio: SUN_DISC_DAWN_LIMB_REFERENCE_RATIO,
    families,
    measurements,
    structural,
    failures,
    unproven: unproven.map((family) => family.id),
    status,
    exitCode: exitCodeForS5Status(status),
  };
}
