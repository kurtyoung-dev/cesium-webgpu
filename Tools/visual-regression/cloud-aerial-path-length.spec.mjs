// C13-N20 — planetary aerial perspective: haze is the AIR COLUMN, not the range.
// @purpose C13-N20: executes cloudAirColumnMeters/cloudAerialFraction straight out of ProceduralClouds.wgsl; pins the legacy calibration point, the orbital non-saturation that bar O3 is about, monotonicity, the near-horizontal guard, the reach-the-image assertion on the composited output, and six mutants.
// @status ACTIVE
//
// PREMISE THIS FILE PINS, RE-DERIVED AT THE TREE 2026-09-12.
// `ProceduralClouds.wgsl` hazed distant clouds with
// `clamp(midDist / 60000.0 * aerialStrength, 0.0, 0.85)` — haze as a linear
// function of RANGE against a 60 km horizon scale. From any orbital camera
// `midDist` is hundreds of kilometres for every pixel, so every cloud pixel
// clamped to the 0.85 cap and the whole disc rendered as flat maximally-hazed
// tint. That is bar O3 ("fraction of cloud pixels at the aerial cap; 0 at
// h >= 200 km") reading 1.0 BY CONSTRUCTION, which is what this row replaces.
//
// WHAT IS ASSERTED, AND WHY IN THIS FORM.
//
// The law is EXECUTED out of the shipped WGSL through `lib/wgsl-mini-eval.mjs`,
// not transcribed into JavaScript here. A spec that reimplements a shader's
// arithmetic certifies the reimplementation: every number below came from the
// text that ships, so a change to the shader moves these numbers.
//
// The GEOMETRY the law is fed is derived INDEPENDENTLY, from spherical
// trigonometry in this file, and is deliberately NOT the shader's ellipsoid
// solve: the chord length and the altitude rate at the cloud are computed from
// the sine rule on a sphere of mean radius, so the stations are a statement
// about the world rather than a restatement of the renderer. A mean sphere
// under-states nothing that matters here — O3 is a saturation question and the
// oblateness correction is ~0.3 %, three orders below the margins asserted.
//
// REACH THE IMAGE. Section 5a evaluates the blend weight the shipped composite
// actually passes and asserts on the COMPOSITED value, so a mutant that stops
// using the fraction changes a number rather than only a text match. Added after
// adversarial verification refuted the original file on exactly that gap.
//
// WHAT IS NOT ASSERTED. Absolute radiance, tone mapping, and the LUT branch's
// inscatter are not this file's job. Rendered O3 on a real frame is
// `probe-cloud-orbital-ladder.mjs` (C13-N04b, lane L6) on the browser; the Edge
// leg recipe is in this batch's landing packet. What is pinned here is the
// property that makes that measurement come out right, and the property the
// legacy expression provably failed.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  compileFunction,
  evaluate,
  parseExpression,
  readConstants,
  stripComments,
  tokenize,
  vec,
} from "./lib/wgsl-mini-eval.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const CLOUD_WGSL_PATH =
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl";
const shippedSource = fs.readFileSync(path.join(root, CLOUD_WGSL_PATH), "utf8");

/**
 * Compile the two aerial functions out of a WGSL source string.
 *
 * `exp` is supplied through `__functions` rather than added to the evaluator's
 * builtin table, so this spec cannot widen the shared evaluator for every other
 * caller as a side effect of its own needs.
 *
 * @param {string} source WGSL source text.
 * @returns {{column: Function, fraction: Function, constants: object}} Callables.
 */
function compileAerial(source) {
  const src = stripComments(source);
  const constants = readConstants(src);
  const functions = { exp: Math.exp };
  const globals = { ...constants, __functions: functions };
  const column = compileFunction(src, "cloudAirColumnMeters", globals);
  functions.cloudAirColumnMeters = column;
  const fraction = compileFunction(src, "cloudAerialFraction", globals);
  return { column, fraction, constants };
}

const shipped = compileAerial(shippedSource);
const CAP = shipped.constants.CLOUD_AERIAL_MAX;
const SCALE_HEIGHT = shipped.constants.CLOUD_AIR_SCALE_HEIGHT_M;
const EXTINCTION = shipped.constants.CLOUD_AERIAL_EXTINCTION_PER_M;

// ── Independent geometry ─────────────────────────────────────────────────────

/** Mean Earth radius, metres. Not read from the shader. */
const MEAN_RADIUS_M = 6371000;
/** Midpoint of the default deck, `cloudLayerBottom` 1500 to `cloudLayerTop` 4000. */
const DECK_MID_M = 2750;
/** The O6 orbital decades at which bar O3 is specified (h >= 200 km). */
const ORBITAL_ALTITUDES_M = [200e3, 2000e3, 20000e3];

/**
 * Straight-line distance from a point on the cloud shell to a camera on a
 * concentric shell, given the view-zenith angle AT THE CLOUD.
 *
 * Sine rule on the triangle (Earth centre, cloud point, camera):
 * `(R+hc)^2 = (R+hm)^2 + 2 L (R+hm) mu + L^2`, solved for the positive root.
 *
 * @param {number} cloudAltitude Cloud altitude, metres.
 * @param {number} cameraAltitude Camera altitude, metres.
 * @param {number} mu Cosine of the view-zenith angle at the cloud.
 * @returns {number} Chord length, metres.
 */
function chordToCamera(cloudAltitude, cameraAltitude, mu) {
  const a = MEAN_RADIUS_M + cloudAltitude;
  const b = MEAN_RADIUS_M + cameraAltitude;
  return -a * mu + Math.sqrt(a * a * mu * mu + b * b - a * a);
}

/**
 * Evaluate a compiled `cloudAerialFraction` at one station.
 *
 * The shader takes two vectors and dots them; the station supplies a pair whose
 * dot product is the intended `mu`, so the call exercises the shipped signature
 * rather than a scalar shortcut around it.
 *
 * @param {Function} fraction Compiled `cloudAerialFraction`.
 * @param {number} zenithDegrees View-zenith angle at the cloud.
 * @param {number} cameraAltitude Camera altitude, metres.
 * @param {number} [strength] `cloud.aerialStrength`.
 * @param {number} [cloudAltitude] Cloud altitude, metres.
 * @returns {number} Haze fraction.
 */
function fractionAt(
  fraction,
  zenithDegrees,
  cameraAltitude,
  strength = 1,
  cloudAltitude = DECK_MID_M,
) {
  const mu = Math.cos((zenithDegrees * Math.PI) / 180);
  const length = chordToCamera(cloudAltitude, cameraAltitude, mu);
  const sin = Math.sqrt(Math.max(1 - mu * mu, 0));
  return fraction(
    cloudAltitude,
    vec(sin, 0, mu),
    vec(0, 0, 1),
    length,
    strength,
  );
}

/** The expression this row replaced, reconstructed for the "what would have failed" leg. */
function legacyFractionAt(zenithDegrees, cameraAltitude, strength = 1) {
  const mu = Math.cos((zenithDegrees * Math.PI) / 180);
  const length = chordToCamera(DECK_MID_M, cameraAltitude, mu);
  return Math.min(Math.max((length / 60000) * strength, 0), 0.85);
}

// ── 1. The law is read from the shipped source, not from this file ───────────

test("the range-keyed aerial term is gone from the shipped shader", () => {
  // Comments are stripped first: this file and the shader both QUOTE the
  // replaced expression in prose, and an assertion that a comment can satisfy
  // is not an assertion about code.
  const code = stripComments(shippedSource);
  assert.doesNotMatch(
    code,
    /midDist\s*\/\s*60000\.0/,
    "the legacy `midDist / 60000.0` aerial ramp must not survive C13-N20",
  );
  assert.match(
    code,
    /let aerial = cloudAerialFraction\(/,
    "the march must take its haze fraction from the path-length model",
  );
});

test("the model's three constants are declared in the shader, not here", () => {
  assert.equal(typeof SCALE_HEIGHT, "number");
  assert.equal(typeof EXTINCTION, "number");
  assert.equal(typeof CAP, "number");
  // The cap is KEPT so bar O3 stays falsifiable: with no cap, "pixels at the
  // cap" is trivially 0 and the gate cannot fail, which RULING-2026-08-06 R3
  // forbids. Its value is unchanged from the expression this row replaced.
  assert.equal(CAP, 0.85);
  // A scale height in the lower-atmosphere range, and an extinction between the
  // pure-Rayleigh floor at 550 nm (~1.2e-5/m) and a thick-haze value.
  assert.ok(SCALE_HEIGHT > 7000 && SCALE_HEIGHT < 9000, `H = ${SCALE_HEIGHT}`);
  assert.ok(EXTINCTION > 1.1e-5 && EXTINCTION < 1e-4, `k = ${EXTINCTION}`);
});

// ── 2. The legacy calibration point survives ─────────────────────────────────

test("a horizontal sea-level 60 km path still returns exactly the cap", () => {
  // This is the one point the old ramp was calibrated at — where it first
  // reached 0.85 — so the near-field ground look is carried over rather than
  // re-tuned. mu = 0 exactly, which also exercises the near-horizontal guard.
  const horizontal = shipped.fraction(0, vec(1, 0, 0), vec(0, 0, 1), 60000, 1);
  assert.ok(
    Math.abs(horizontal - CAP) < 1e-6,
    `60 km horizontal at sea level gave ${horizontal}, expected the cap ${CAP}`,
  );
});

test("the column of a horizontal sea-level path is its own length", () => {
  // rho(0) = 1, so a horizontal path at sea level carries exactly its length in
  // sea-level-equivalent air. Anything else means the guard branch is wrong.
  for (const length of [1000, 60000, 250000]) {
    const column = shipped.column(0, 0, length);
    assert.ok(
      Math.abs(column - length) < 1e-6 * length,
      `horizontal column at sea level was ${column} for ${length} m`,
    );
  }
});

// ── 3. Bar O3's premise — the orbital disc no longer saturates ───────────────

/**
 * The acceptance predicate, expressed once so the mutation group runs the SAME
 * predicate the passing case runs.
 *
 * Returns the highest view-zenith angle, in degrees, at which the disc is still
 * strictly below the cap. The bar is a statement about THAT angle: a model that
 * saturates the mid-disc returns something small, and the legacy expression
 * returns nothing at all because it saturates at nadir.
 *
 * @param {Function} fraction Compiled `cloudAerialFraction`.
 * @param {number} cameraAltitude Camera altitude, metres.
 * @returns {number} Onset angle in degrees, or 0 when even nadir saturates.
 */
function saturationOnsetDegrees(fraction, cameraAltitude) {
  let low = 0;
  let high = 89.9;
  if (fractionAt(fraction, 0, cameraAltitude) >= CAP - 1e-9) {
    return 0;
  }
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) / 2;
    if (fractionAt(fraction, mid, cameraAltitude) >= CAP - 1e-9) {
      high = mid;
    } else {
      low = mid;
    }
  }
  return high;
}

test("no orbital cloud pixel is at the aerial cap out to 75 deg view-zenith", () => {
  // 75 deg at the cloud covers all but the outermost ~2 % of the projected
  // disc's radius, so this is the bulk-of-the-disc statement bar O3 is about.
  for (const altitude of ORBITAL_ALTITUDES_M) {
    for (const zenith of [0, 15, 30, 45, 60, 75]) {
      const value = fractionAt(shipped.fraction, zenith, altitude);
      assert.ok(
        value < CAP - 0.05,
        `h=${altitude / 1000} km theta=${zenith} deg gave ${value.toFixed(4)}, ` +
          `which is at or near the cap ${CAP}`,
      );
    }
  }
});

test("the legacy expression was at the cap at every one of those stations", () => {
  // RULING-2026-08-06 R3: a derived bar has to state what value WOULD have
  // failed. This is it — the term this row replaced returns the cap at nadir
  // from 200 km, so O3 read 1.0 by construction rather than by measurement.
  for (const altitude of ORBITAL_ALTITUDES_M) {
    for (const zenith of [0, 15, 30, 45, 60, 75]) {
      assert.equal(
        legacyFractionAt(zenith, altitude),
        0.85,
        `the legacy ramp should saturate at h=${altitude / 1000} km, ` +
          `theta=${zenith} deg`,
      );
    }
  }
});

test("bar O3: no saturated pixel outside the limb annulus O4 owns", () => {
  // BAR O3, AS RULED 2026-09-13: "0 saturated pixels OUTSIDE the limb annulus
  // O4 owns", at h >= 200 km. This is a measured premise correction, not a
  // widened threshold.
  //
  // WHY THE ORIGINAL WORDING COULD NOT BE MET. O3 read "0 pixels at the aerial
  // cap", full stop — and that is not reachable by ANY physical path-length
  // model, ours or anyone's. A ray reaching a 2.75 km deck at 89 deg
  // view-zenith crosses ~336 km of sea-level-equivalent air. That path is
  // genuinely opaque under any extinction in the clear-air range, pure Rayleigh
  // included, so a model reporting the limb as unsaturated would be WRONG. The
  // limb is opaque in the world, and the bar has to say so.
  //
  // WHAT THE BAR STILL CATCHES, which is the whole point of correcting it
  // rather than dropping it: the defect this row fixes was the ENTIRE DISC
  // saturating by construction, nadir included. That is what the onset angle
  // measures, and the legacy expression fails it at every station (see the test
  // below). The corrected bar is strictly falsifiable — a model that hazes the
  // mid-disc drives the onset down and fails here.
  //
  // WHICH ANGULAR MEASURE O4's "5 DEGREES" IS, AND WHY IT HAD TO BE SETTLED.
  // O4 is "max luminance/alpha step across any 2-px window within 5 degrees of
  // the limb" (CAMPAIGN_13_V2_CLOUD_QUALITY_2026-09-12.md section 1.3, the O4
  // row). Its statistic is a 2-PIXEL window, so O4 is an image-space bar and its
  // 5 degrees is an image-space angle: the NADIR ANGLE AT THE CAMERA, not the
  // view-zenith angle at the cloud. The two diverge enormously near the limb —
  // the sine rule compresses the last several degrees of view-zenith into a
  // fraction of a degree of nadir angle — so picking the wrong one changes the
  // verdict rather than the precision. This test converts the measured onset
  // into O4's own measure before comparing, instead of bounding the view-zenith
  // angle by a number nobody pre-registered.
  //
  // RECORDED SO THE CHOICE IS AUDITABLE RATHER THAN SILENT: on the other
  // reading — O4's 5 degrees taken as view-zenith at the cloud — the onset at
  // 84.12 degrees sits 5.88 degrees from the limb, i.e. 0.88 degrees OUTSIDE the
  // annulus, and the shipped model would FAIL. The packet states that
  // consequence and what would have to change to meet it. Leg 3b measures the
  // bar on rendered frames under whichever reading the seat confirms.
  const O4_ANNULUS_DEGREES = 5;
  /** Nadir angle at the camera for a cloud point at a given view-zenith. */
  const nadirAngleDegrees = (cameraAltitude, zenithDegrees) =>
    (Math.asin(
      ((MEAN_RADIUS_M + DECK_MID_M) *
        Math.sin((zenithDegrees * Math.PI) / 180)) /
        (MEAN_RADIUS_M + cameraAltitude),
    ) *
      180) /
    Math.PI;
  for (const altitude of ORBITAL_ALTITUDES_M) {
    const onset = saturationOnsetDegrees(shipped.fraction, altitude);
    const insideLimb =
      nadirAngleDegrees(altitude, 90) - nadirAngleDegrees(altitude, onset);
    assert.ok(
      insideLimb <= O4_ANNULUS_DEGREES,
      `h=${altitude / 1000} km: saturation starts ${insideLimb.toFixed(3)} deg ` +
        `inside the limb in O4's image-space measure (view-zenith onset ` +
        `${onset.toFixed(2)} deg), which is outside O4's ${O4_ANNULUS_DEGREES} deg annulus`,
    );
    // The bar must also not be vacuous: an onset of 0 — the whole disc
    // saturating, which is exactly the defect this row fixes — has to FAIL it.
    const wholeDisc =
      nadirAngleDegrees(altitude, 90) - nadirAngleDegrees(altitude, 0);
    assert.ok(
      wholeDisc > O4_ANNULUS_DEGREES,
      `at h=${altitude / 1000} km a nadir-to-limb span of ${wholeDisc.toFixed(2)} deg ` +
        `is inside O4's annulus, so this bar could not fail here`,
    );
  }
});

test("the saturated set is a view-zenith set, not an altitude set", () => {
  // The projection-free statement of what bar O3 actually gets, and the one to
  // quote: the saturated pixels are EXACTLY those whose view-zenith angle at the
  // cloud exceeds one altitude-independent onset. That invariance is the whole
  // content of a column model — the air on a path does not care how far away the
  // camera is, only how steeply the path crosses the atmosphere.
  const onsets = ORBITAL_ALTITUDES_M.map((h) =>
    saturationOnsetDegrees(shipped.fraction, h),
  );
  for (const onset of onsets) {
    assert.ok(
      Math.abs(onset - onsets[0]) < 0.01,
      `onset moved with camera altitude: ` +
        onsets.map((o) => o.toFixed(3)).join(", "),
    );
  }
});

test("how big that annulus looks depends on the projection, and both are pinned", () => {
  // CAUTION FOR ANYONE QUOTING A PERCENTAGE. "Fraction of cloud pixels at the
  // cap" is NOT projection-free, and the two natural measures disagree by an
  // order of magnitude at low orbit. A cloud point at view-zenith theta maps to
  // a nadir angle alpha at the camera by the sine rule,
  // sin(alpha) = (R+hm)*sin(theta)/(R+hc); image radius goes as sin(alpha) under
  // an equal-sine measure and as tan(alpha) under a rectilinear camera, and tan
  // diverges exactly where this annulus lives.
  //
  // Under the equal-sine measure the annulus is the same ~1 % at every decade;
  // under a rectilinear camera framing the WHOLE disc it is ~15 % at 200 km,
  // falling to ~1 % by 20,000 km. Note what the 200 km figure assumes — reaching
  // the deck's geometric horizon from 200 km needs a field of view over 150
  // degrees, which is not a frame anyone renders. The honest headline is the
  // previous test's invariant; a percentage is quotable ONLY with its projection
  // and altitude attached.
  const onset = saturationOnsetDegrees(shipped.fraction, 200e3);
  const nadirAngle = (cameraAltitude, zenithDegrees) =>
    Math.asin(
      ((MEAN_RADIUS_M + DECK_MID_M) *
        Math.sin((zenithDegrees * Math.PI) / 180)) /
        (MEAN_RADIUS_M + cameraAltitude),
    );
  const measured = ORBITAL_ALTITUDES_M.map((h) => {
    const inner = nadirAngle(h, onset);
    const outer = nadirAngle(h, 90);
    return {
      km: h / 1000,
      sine: 1 - Math.sin(inner) ** 2 / Math.sin(outer) ** 2,
      rectilinear: 1 - Math.tan(inner) ** 2 / Math.tan(outer) ** 2,
    };
  });
  // The equal-sine measure is altitude-invariant, which is why it is the one
  // that can be stated as a single number at all.
  for (const row of measured) {
    assert.ok(
      Math.abs(row.sine - measured[0].sine) < 1e-6,
      `the equal-sine annulus should not move with altitude: ` +
        JSON.stringify(measured),
    );
  }
  assert.ok(
    measured[0].sine > 0.005 && measured[0].sine < 0.02,
    `equal-sine annulus ${measured[0].sine}`,
  );
  // The rectilinear measure is NOT invariant and shrinks with altitude. Pinned
  // so nobody quotes the invariant number for a rectilinear frame.
  assert.ok(
    measured[0].rectilinear > 3 * measured[measured.length - 1].rectilinear,
    `the rectilinear annulus must shrink with altitude: ` +
      JSON.stringify(measured),
  );
  // Both measures stay a small minority of the disc at every decade — that is
  // the claim distinguishing this row's result from the legacy 100 %.
  for (const row of measured) {
    assert.ok(
      row.sine < 0.2 && row.rectilinear < 0.2,
      `annulus is not a minority of the disc: ${JSON.stringify(row)}`,
    );
  }
});

test("the haze fraction is altitude-independent above the atmosphere", () => {
  // The physical signature of a column model rather than a range model: once
  // the camera is above essentially all the air, lifting it further adds no
  // haze, because there is no more air to add. A range-keyed term does the
  // opposite and hazes more the further away the camera goes.
  const nadir = ORBITAL_ALTITUDES_M.map((h) =>
    fractionAt(shipped.fraction, 0, h),
  );
  for (const value of nadir) {
    assert.ok(
      Math.abs(value - nadir[0]) < 1e-6,
      `nadir haze moved with camera altitude: ${nadir.join(", ")}`,
    );
  }
  // And it is a real, visible amount of haze, not a disabled term.
  assert.ok(nadir[0] > 0.05 && nadir[0] < 0.5, `nadir haze ${nadir[0]}`);
});

// ── 4. Monotone with distance — the row's second acceptance clause ───────────

test("haze is non-decreasing in path length at a fixed altitude and angle", () => {
  for (const zenith of [0, 30, 60, 85]) {
    const mu = Math.cos((zenith * Math.PI) / 180);
    const sin = Math.sqrt(Math.max(1 - mu * mu, 0));
    let previous = -1;
    for (const length of [0, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8]) {
      const value = shipped.fraction(
        DECK_MID_M,
        vec(sin, 0, mu),
        vec(0, 0, 1),
        length,
        1,
      );
      assert.ok(
        value >= previous - 1e-12,
        `haze fell from ${previous} to ${value} at theta=${zenith}, L=${length}`,
      );
      previous = value;
    }
  }
});

test("a higher cloud is hazed less than a lower one on the same path", () => {
  // rho0 falls with altitude, so the same geometry through thinner air must
  // haze less. This is the clause that makes a multi-deck scene read correctly.
  const previousByAltitude = [0, 2000, 4000, 8000, 12000].map((h) =>
    fractionAt(shipped.fraction, 60, 400e3, 1, h),
  );
  for (let i = 1; i < previousByAltitude.length; i++) {
    assert.ok(
      previousByAltitude[i] < previousByAltitude[i - 1],
      `haze did not fall with cloud altitude: ${previousByAltitude.join(", ")}`,
    );
  }
});

// ── 5. Numerics — the guard, the bounds, and no NaN anywhere ─────────────────

test("the near-horizontal series and the closed form agree across the guard", () => {
  // The guard exists because (1 - exp(-x))/x divides two quantities that both
  // go to zero. Continuity across it is the assertion that the series is the
  // right series and the threshold is in the right place.
  const length = 1e5;
  const epsilon = SCALE_HEIGHT * 1e-3;
  for (const sign of [1, -1]) {
    const muInside = (sign * epsilon * 0.999) / length;
    const muOutside = (sign * epsilon * 1.001) / length;
    const inside = shipped.column(DECK_MID_M, muInside, length);
    const outside = shipped.column(DECK_MID_M, muOutside, length);
    assert.ok(
      Math.abs(inside - outside) < 1e-4 * Math.abs(inside),
      `discontinuity across the guard: ${inside} vs ${outside}`,
    );
  }
});

test("the fraction stays inside [0, cap] and finite over a wide sweep", () => {
  // Raw inputs, not stations: every (altitude, mu, length, strength) the shader
  // could be handed, including the geometrically impossible ones a numerically
  // degenerate frame can produce. A long DESCENDING path is the case that used
  // to overflow `exp` and reach the caller as NaN; the sea-level bound in
  // `cloudAirColumnMeters` is what makes this pass.
  let checked = 0;
  for (const cloudAltitude of [0, 2750, 12000, 80000]) {
    for (const mu of [-1, -0.5, -1e-8, 0, 1e-8, 0.05, 0.5, 1]) {
      for (const length of [0, 1, 6e4, 1e6, 1e8, 4e7]) {
        for (const strength of [0, 0.5, 1, 4, -1]) {
          const sin = Math.sqrt(Math.max(1 - mu * mu, 0));
          const value = shipped.fraction(
            cloudAltitude,
            vec(sin, 0, mu),
            vec(0, 0, 1),
            length,
            strength,
          );
          assert.ok(
            Number.isFinite(value) && value >= 0 && value <= CAP,
            `hm=${cloudAltitude} mu=${mu} L=${length} s=${strength} ` +
              `gave ${value}`,
          );
          checked += 1;
        }
      }
    }
  }
  assert.equal(checked, 4 * 8 * 6 * 5);
});

test("every orbital station used above closes as real geometry", () => {
  // The stations elsewhere in this file come from spherical trigonometry, and a
  // NaN chord would make an assertion vacuous rather than failing it. This is
  // the guard on the spec's own inputs.
  for (const altitude of ORBITAL_ALTITUDES_M) {
    for (const zenith of [0, 15, 30, 45, 60, 75, 80, 85, 89]) {
      const mu = Math.cos((zenith * Math.PI) / 180);
      const length = chordToCamera(DECK_MID_M, altitude, mu);
      assert.ok(
        Number.isFinite(length) && length > 0,
        `station h=${altitude} theta=${zenith} has no chord (${length})`,
      );
    }
  }
});

test("aerialStrength 0 disables the term exactly", () => {
  for (const zenith of [0, 45, 89]) {
    assert.equal(fractionAt(shipped.fraction, zenith, 400e3, 0), 0);
  }
});

// ── 5a. REACH THE IMAGE — the fraction must govern the composite ─────────────
//
// ADDED 2026-09-13 after adversarial verification (Saradoc) REFUTED the original
// file on exactly this gap. Every test above executes `cloudAerialFraction` in
// ISOLATION, and the structural test only checks that the call `let aerial =
// cloudAerialFraction(...)` appears. So the row's own defect — restoring
// `mix(toneMapped, cloud.aerialColor, 0.85)` at the composite, which puts the
// whole disc back at the cap — could be reintroduced with the function, the
// call and every numeric test left intact, and the file stayed 20/20 GREEN.
// A spec that pins a call site and a function's behaviour has not shown that
// the value reaches a pixel.
//
// The fix is the shape C13-N21's test already had: PARSE the blend weight the
// shipped composite actually passes, EVALUATE it, and assert on the OUTPUT. A
// mutant that stops using `aerial` changes the number these tests produce, not
// merely the text they match.

/**
 * Extract the blend weight the heuristic composite passes to `mix`.
 *
 * Returns the third argument of `mix(toneMapped, cloud.aerialColor, <weight>)`
 * as source text. That expression — not the presence of a call site elsewhere —
 * is what decides the rendered haze on the default path.
 *
 * @param {string} source WGSL source text.
 * @returns {string} The weight expression.
 */
function heuristicCompositeWeight(source) {
  const match = stripComments(source).match(
    /hazed = mix\(\s*toneMapped\s*,\s*cloud\.aerialColor\s*,\s*([^;)]+)\)/,
  );
  assert.notEqual(
    match,
    null,
    "the heuristic aerial composite could not be located — this spec is stale",
  );
  return match[1].trim();
}

/**
 * Composite haze exactly as the shipped march does, for one station.
 *
 * `toneMapped` and `aerialColor` are stand-ins: what is under test is the
 * WEIGHT, so the two endpoints are fixed and any change in the result is a
 * change in how much haze the composite applies.
 *
 * @param {string} source WGSL source text.
 * @param {Function} fraction Compiled `cloudAerialFraction`.
 * @param {number} zenithDegrees View-zenith angle at the cloud.
 * @param {number} cameraAltitude Camera altitude, metres.
 * @returns {number} Composited luminance in [0, 1], 1 = unhazed cloud.
 */
function compositedHaze(source, fraction, zenithDegrees, cameraAltitude) {
  const weightText = heuristicCompositeWeight(source);
  const aerial = fractionAt(fraction, zenithDegrees, cameraAltitude);
  // Evaluate the shipped weight expression with the station's `aerial` bound.
  // A literal weight ignores the binding entirely — which is the whole point.
  const weight = evaluate(parseExpression(tokenize(weightText), 0).node, {
    aerial,
    __functions: { exp: Math.exp },
  });
  const CLOUD = 1;
  const HAZE = 0;
  return CLOUD * (1 - weight) + HAZE * weight;
}

test("the haze fraction governs the heuristic composite, measured on the output", () => {
  // The composite must pass the COMPUTED fraction, so the composited value moves
  // between an orbital nadir view and a near-limb one. Under the legacy literal
  // both stations composite identically at the cap, which is the defect.
  const nadir = compositedHaze(shippedSource, shipped.fraction, 0, 200e3);
  const limb = compositedHaze(shippedSource, shipped.fraction, 89, 200e3);
  assert.ok(
    nadir - limb > 0.5,
    `the orbital nadir composite (${nadir.toFixed(4)}) must retain far more ` +
      `cloud than the limb (${limb.toFixed(4)}); the weight is not reaching ` +
      `the composite`,
  );
  // And the nadir composite must be nowhere near the cap — bar O3's premise,
  // stated on the composited output rather than on the fraction alone.
  assert.ok(
    nadir > 0.75,
    `orbital nadir composites to ${nadir.toFixed(4)}; the legacy cap would give ` +
      `${(1 - CAP).toFixed(4)}`,
  );
});

test("MUTANT 0 — the row's own defect restored at the composite is caught", () => {
  // THE REFUTING MUTANT, now covered: leave `cloudAirColumnMeters`,
  // `cloudAerialFraction` and the `let aerial = ...` call site completely
  // intact, and change only the composite to pass the historical cap. Every
  // isolated-function test in this file still passes under it — which is why it
  // survived — so the predicate below is the one that has to reject it.
  const mutated = shippedSource.replace(
    /hazed = mix\(\s*toneMapped\s*,\s*cloud\.aerialColor\s*,\s*aerial\s*\)/,
    "hazed = mix(toneMapped, cloud.aerialColor, 0.85)",
  );
  assert.notEqual(
    mutated,
    shippedSource,
    "the composite mutation matched nothing — this spec is stale",
  );
  // The call site and both functions survive the mutation, so a text-shaped
  // check cannot tell the difference. Assert that explicitly, so nobody
  // "simplifies" this test back into a grep.
  assert.match(stripComments(mutated), /let aerial = cloudAerialFraction\(/);
  const inert = compileAerial(mutated);
  const nadir = compositedHaze(mutated, inert.fraction, 0, 200e3);
  const limb = compositedHaze(mutated, inert.fraction, 89, 200e3);
  assert.equal(
    nadir,
    limb,
    "with a literal weight the composite must be station-independent",
  );
  assert.throws(() => {
    assert.ok(nadir - limb > 0.5, `nadir ${nadir} limb ${limb}`);
  }, "the reach-the-image predicate must REJECT the restored defect");
  assert.throws(() => {
    assert.ok(nadir > 0.75, `nadir ${nadir}`);
  }, "the O3 premise predicate must REJECT the restored defect");
});

test("MUTANT 0b — the LUT composite must read the same weight", () => {
  // The physical-mode branch reuses `aerial` as its own blend weight, so the
  // same defect can be reintroduced there alone. Pinned structurally because
  // that branch's endpoints are LUT samples this file does not model — stated
  // rather than silently skipped.
  const code = stripComments(shippedSource);
  assert.match(
    code,
    /hazed = mix\(toneMapped, farTarget, aerial\)/,
    "the physical aerial branch must blend on the computed fraction too",
  );
  const mutated = code.replace(
    /hazed = mix\(toneMapped, farTarget, aerial\)/,
    "hazed = mix(toneMapped, farTarget, 0.85)",
  );
  assert.notEqual(mutated, code, "the LUT composite mutation matched nothing");
  assert.doesNotMatch(mutated, /hazed = mix\(toneMapped, farTarget, aerial\)/);
});

// ── 6. Mutation — every assertion above must be load bearing ─────────────────

/**
 * Apply a source mutation, recompile from the mutated text, and hand back the
 * callables. A mutation that does not change the text throws, so a stale
 * pattern cannot quietly produce a vacuous "mutant passes" result.
 *
 * @param {RegExp|string} pattern Text to replace.
 * @param {string} replacement Replacement text.
 * @returns {{column: Function, fraction: Function, constants: object}} Callables.
 */
function mutate(pattern, replacement) {
  const mutated = shippedSource.replace(pattern, replacement);
  assert.notEqual(
    mutated,
    shippedSource,
    `mutation pattern ${pattern} matched nothing — the spec is stale`,
  );
  return compileAerial(mutated);
}

test("MUTANT 1 — column reverted to range re-saturates the orbital disc", () => {
  // The inertness image for the whole row: make the path-length model
  // unreachable by feeding `cloudAerialFraction` the RANGE it used to be given,
  // and the O3 predicate must go red at every orbital decade.
  const inert = mutate(
    /let column = cloudAirColumnMeters\([\s\S]*?\);/,
    "let column = max(pathLength, 0.0);",
  );
  for (const altitude of ORBITAL_ALTITUDES_M) {
    assert.equal(
      saturationOnsetDegrees(inert.fraction, altitude),
      0,
      `with the column model inert, h=${altitude / 1000} km must saturate at nadir`,
    );
  }
  // And the predicate the passing case uses must reject it.
  assert.throws(() => {
    const value = fractionAt(inert.fraction, 0, 200e3);
    assert.ok(value < CAP - 0.05, `nadir gave ${value}`);
  });
});

test("MUTANT 2 — removing the near-horizontal guard breaks continuity", () => {
  const unguarded = mutate("if (abs(x) < 1e-3) {", "if (abs(x) < 0.0) {");
  const value = unguarded.column(0, 0, 60000);
  assert.ok(
    !Number.isFinite(value) || Math.abs(value - 60000) > 1,
    `the unguarded closed form should not reproduce the horizontal column, got ${value}`,
  );
});

test("MUTANT 3 — removing the cap makes bar O3 unable to fail", () => {
  // Principle: the cap is not decoration. Without it "pixels at the cap" is
  // vacuous, which is the failure mode R3 names. With the clamp widened, the
  // limb no longer reports as saturated and the onset search finds nothing.
  const uncapped = mutate(
    "return clamp(1.0 - exp(-opticalDepth), 0.0, CLOUD_AERIAL_MAX);",
    "return clamp(1.0 - exp(-opticalDepth), 0.0, 1.0);",
  );
  const limb = fractionAt(uncapped.fraction, 89, 200e3);
  assert.ok(
    limb > CAP,
    `without the cap the limb should exceed ${CAP}, got ${limb}`,
  );
  assert.equal(
    saturationOnsetDegrees(shipped.fraction, 200e3) > 80,
    true,
    "the shipped model must still report a limb-only saturated set",
  );
});

test("MUTANT 4 — a flat density profile loses the altitude response", () => {
  // rho0 is what makes a high cloud hazier-than-nothing and a low cloud hazy.
  // Flatten it and the per-altitude ordering assertion must go red.
  const flat = mutate(
    /let rho0 = exp\(-h0 \/ CLOUD_AIR_SCALE_HEIGHT_M\);/,
    "let rho0 = 1.0;",
  );
  const values = [0, 4000, 12000].map((h) =>
    fractionAt(flat.fraction, 60, 400e3, 1, h),
  );
  assert.ok(
    Math.abs(values[0] - values[2]) < 1e-9,
    `a flat profile should erase the altitude response, got ${values.join(", ")}`,
  );
});
