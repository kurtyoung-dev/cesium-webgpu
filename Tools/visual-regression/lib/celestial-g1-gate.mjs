// celestial-g1-gate.mjs — pure verdict logic for the Campaign-12 G1 celestial
// gate (C12-G1F2 repair).
// @purpose Pure verdict logic for the C12 G1 gate after six recorded repairs: per-backend non-vacuity, doubly-blind certifying mode voids the lane as STRUCTURAL.
// @status ACTIVE
//
// WHY THIS FILE EXISTS
// --------------------
// `probe-celestial-gates.mjs` launches a browser at module scope, so its gate
// arithmetic could never be executed by `node --test`. Every G1 defect the
// C12-G1F2 diagnosis found was in the arithmetic, not in the pixels:
//
//   1. `m2aRatio` is a RATIO OF RATIOS — (sigma_gpu/mu_gpu)/(sigma_gl/mu_gl).
//      When it failed, neither factor was printed, so a pedestal/mean shift and
//      a sigma excess were indistinguishable. Both factors are now first-class.
//   2. M2e (the robust sky floor — "the single most direct discriminator for a
//      veil/pedestal mechanism", `celestial-metrics.mjs`) was computed, written
//      to JSON, and gated by NOTHING. It now certifies.
//   3. The gate asserted `sunElevationDeg >= 25` — a PROXY. The star-modulation
//      term the gate exists to protect is driven by `frameState.skyBrightness`,
//      which is identically 0 at the orbital camera G1 uses. The gate could not
//      reach its own failure state and still reported a verdict.
//
// TWO MORE, FOUND BY AUDIT OF THE REPAIR ITSELF (2026-08-07). Both are the same
// mistake in opposite directions — a blindness rule applied at the wrong scope:
//
//   4. The star-modulation non-vacuity control ANDed the two backends, so a
//      term live on ONE backend and inert on the other — the C11-176 shape
//      verbatim — was DOWNGRADED from FAIL to STRUCTURAL, whose printed
//      headline reads "this is NOT a pass and NOT a defect". Non-vacuity is now
//      per backend: BOTH dead is STRUCTURAL, ONE dead is a FAIL.
//   5. The blindness rule was applied only to the SECONDARY count modes, never
//      to the CERTIFYING `default` mode, whose four null ratios would have
//      produced a confident exit 1 over a scene where no source was censused on
//      either backend — a phantom defect. A doubly-blind certifying mode is now
//      STRUCTURAL, and it voids the whole lane rather than the one criterion.
//
// Keeping the arithmetic here — pure, browser-free, importable — is what lets
// `celestial-g1-gate.spec.mjs` construct the plausible WRONG implementation of
// each rule and prove the spec rejects it.
//
// SIXTH REPAIR — THE PRE-DR-01 STAR THRESHOLDS (2026-08-07, CO-3).
// `PROBE-CELESTIAL-GATES-PRE-DR01-STAR-THRESHOLDS`. Lane A's criteria were all
// built on the M1 point-source COUNT. Batch 833 (C12-11 / DR-01) made
// `SkyBox.defaultVariant = TYCHO_T5_DIFFUSE`, whose faces census 0 resolved
// sources BY CONSTRUCTION, and the sprite catalogue's shipped exposure peaks
// below the census floor in this framing — so all three modes read 0/0 and the
// lane went STRUCTURAL on a healthy scene. The counts are not repairable by
// lowering the floor (explicitly forbidden: it would put candidates back inside
// the diffuse band's 8-bit range and re-create the brightness count the census
// replaced). Following Batch 848's re-scope of `probe-stars-catalog.mjs`, the
// COUNT is replaced per mode by what that mode actually owns after the seam:
//
//   cubemap-only : the DR-01 seam itself — zero resolved sources is now the
//                  ASSERTION, not the blindness — plus a not-blank positive
//                  control so a black frame cannot satisfy it.
//   sprites-only : lit-pixel extent parity, cross-backend pixel agreement
//                  (measured BIT-IDENTICAL at Batch 873) and chroma sampled
//                  over the brightest sprite pixels.
//   default      : the second-order metrics that never needed a census
//                  (M2a/M2b/M2e) plus lit-extent parity.
//
// `modeIsBlind` (the count-based predicate) is retained, exported and pinned:
// it is the pre-DR-01 rule this repair superseded, and keeping it visible is
// what makes the supersession auditable rather than a silent deletion.

import { srgbToLinear } from "./celestial-metrics.mjs";
import { DR01_LIVE_MAX_RESOLVED_SOURCES } from "./celestial-source-split.mjs";

/**
 * Absolute agreement bound for the M2e robust sky floor, in LINEAR light.
 *
 * DERIVED FROM QUANTIZATION, NOT FROM ANY MEASUREMENT. Both backends render the
 * same bare star field over a black background into an 8-bit sRGB canvas. The
 * smallest representable non-black pedestal is one code value, so two backends
 * that agree on the floor to better than one code value are indistinguishable
 * by the instrument, and anything larger is a real pedestal. `srgbToLinear` is
 * in its linear segment there, so the bound is exactly (1/255)/12.92.
 *
 * Do NOT retune this to whatever the current run happens to measure — that is
 * how a gate stops being able to fail. If a run exceeds it, the pedestal is
 * real.
 *
 * @type {number} ~3.035e-4
 */
export const SKY_FLOOR_ABS_TOLERANCE = srgbToLinear(1 / 255);

/**
 * The predicate that says the C11-176 star-modulation path is actually live.
 *
 * This is `probe-skybox-star-modulation.mjs`'s own reachability predicate
 * (`reachedFailingState: skyBrightness > 0.5`). It is the variable that DRIVES
 * the defect — `CubeMapPanorama.updateStarModulation` feeds
 * `frameState.skyBrightness` straight into the shader's smoothstep — as opposed
 * to solar elevation, which merely correlates with it below 60 km and is
 * completely decoupled from it above 111 km.
 *
 * @type {number}
 */
export const STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD = 0.5;

/** Symmetric parity band shared by every ratio criterion. */
export const PARITY_BAND = Object.freeze({ lo: 0.85, hi: 1.15 });

/**
 * Minimum WebGPU/WebGL M1 point-source count ratio.
 *
 * RETAINED, NOT CONSUMED BY LANE A SINCE THE DR-01 RE-SCOPE. Every Lane-A mode
 * censuses 0/0 at HEAD by construction (see the header), so a ratio over these
 * counts is 0/0 rather than parity. The constant stays exported because the
 * count is still REPORTED — a cube map that regains resolved sources must be
 * visible — and because the spec pins the supersession.
 *
 * @type {number}
 */
export const M1_COUNT_RATIO_MIN = 0.9;

/** Minimum WebGPU/WebGL M3 median-chroma ratio. */
export const M3_CHROMA_RATIO_MIN = 0.85;

/**
 * Maximum WebGPU-vs-WebGL differing-pixel FRACTION allowed on the shared-code
 * `sprites-only` pass.
 *
 * ⚠ FIRST-PASS DERIVED, NOT MEASURED AT HEAD. Batch 873 measured the two
 * committed `sprites-only` PNGs as sharing a SHA-256 — i.e. differing pixels
 * exactly 0 — on this machine's Edge. The gate does not bind on 0, because a
 * single adapter-dependent rounding difference in a shared shader is not the
 * defect this criterion exists to catch; 5e-4 of a 1000x640 crop is 320 pixels,
 * which is 320x the measured value and still three orders of magnitude below a
 * one-sided regression. Re-derive from the first Edge run: if the measured
 * fraction is 0, this stays; if it is non-zero, the CAUSE is the finding, not
 * the bound.
 *
 * @type {number}
 */
export const SPRITE_DIFFERING_FRACTION_MAX = 5e-4;

/**
 * Maximum per-channel 8-bit delta allowed between the two backends on the
 * `sprites-only` pass. Two code values: one for a legitimate rounding
 * difference at the quantization boundary, one of headroom. A real one-sided
 * regression moves the star cores by tens of code values.
 *
 * ⚠ FIRST-PASS DERIVED (measured 0 at Batch 873, same caveat as above).
 *
 * @type {number}
 */
export const SPRITE_MAX_CHANNEL_DELTA = 2;

/**
 * Minimum ABSOLUTE mean-luminance swing between modulation OFF and ON that
 * proves the star-modulation term is engaged rather than silently inert.
 *
 * DERIVED, NOT TUNED, and deliberately absolute rather than relative. A
 * relative floor ("the mean must move by N%") is a floor on the STAR
 * contribution divided by the SKY contribution — so a brighter atmosphere
 * shell, which this lane requires in order to reach the failure state at all,
 * would push the lane structural for a reason that has nothing to do with the
 * modulation term. The bar here is instead the instrument's own resolution: one
 * 8-bit code value in linear light, the same quantity M2e is bounded by. Over a
 * 1000x640 crop the mean's own quantization noise is smaller than that by
 * ~sqrt(640000) ≈ 800x, so this is a conservative floor that a live term clears
 * easily and a dead one cannot clear at all.
 *
 * The shipped curve (`STAR_MODULATION_INFLECTION = 0`, `STEEPNESS = 23`) drives
 * the star factor to exactly 0 at `skyBrightness = 1`, i.e. a live lane removes
 * the ENTIRE star contribution — orders of magnitude above this bar.
 */
export const MODULATION_ENGAGED_MIN_ABS_DELTA = SKY_FLOOR_ABS_TOLERANCE;

/**
 * Verdict exit codes. 3 = STRUCTURAL is the project's "this leg cannot see its
 * subject" code — never 0 (false green) and never 1 (phantom defect).
 */
export const EXIT_CODE = Object.freeze({
  PASS: 0,
  FAIL: 1,
  ERROR: 2,
  STRUCTURAL: 3,
});

/**
 * @param {number} a
 * @param {number} b
 * @returns {number|null} a/b, or null when either side is unusable.
 */
export function ratio(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;
}

/**
 * @param {number|null} x
 * @param {{lo:number,hi:number}} [band]
 * @returns {boolean} false for null/NaN without an explicit guard at call sites.
 */
export function inBand(x, band = PARITY_BAND) {
  return x >= band.lo && x <= band.hi;
}

/**
 * Does the captured scene actually reach the star-modulation failure state?
 *
 * @param {{webgl:number|null,webgpu:number|null}} skyBrightness
 * @returns {boolean} true only when BOTH backends are above the threshold.
 */
export function computeFramingReached(skyBrightness) {
  const gl = skyBrightness?.webgl;
  const gpu = skyBrightness?.webgpu;
  return (
    Number.isFinite(gl) &&
    Number.isFinite(gpu) &&
    gl > STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD &&
    gpu > STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD
  );
}

/**
 * M2e certification: absolute, not a ratio. A ratio of two near-zero floors is
 * numerically meaningless (and 0/0 is the case the recorded runs actually hit);
 * the physical statement is "these two black backgrounds agree to within the
 * quantization step".
 *
 * @param {number} glFloor linear-light robust sky floor, WebGL
 * @param {number} gpuFloor linear-light robust sky floor, WebGPU
 * @returns {boolean}
 */
export function skyFloorAgrees(glFloor, gpuFloor) {
  if (!Number.isFinite(glFloor) || !Number.isFinite(gpuFloor)) {
    return false;
  }
  return Math.abs(gpuFloor - glFloor) <= SKY_FLOOR_ABS_TOLERANCE;
}

/**
 * The cubemap lane's CERTIFYING capture mode. Every criterion that folds into
 * the lane's verdict is measured on this mode; the entries in `countModes` are
 * secondary source splits that only add an M1 count check.
 *
 * Kept here rather than only in the probe because the blindness rule below has
 * to apply to the certifying mode as well, and a rule that only the caller
 * knows the subject of is a rule the spec cannot pin.
 *
 * @type {string}
 */
export const CUBEMAP_CERTIFYING_MODE = "default";

/**
 * PRE-DR-01 blindness predicate — SUPERSEDED for Lane A by {@link modeIsBlank},
 * retained and pinned so the supersession is auditable.
 *
 * A capture mode where BOTH backends census zero point sources cannot express
 * a count ratio: 0/0 is not parity and not a defect, it is an instrument that
 * cannot see its subject. That reasoning is still correct — what changed is
 * that after DR-01 a zero census is the EXPECTED reading of a healthy diffuse
 * cube map, so routing Lane A on this predicate declares a correct scene blind.
 * {@link evaluateCubemapParityLane} therefore asserts the seam directly and
 * decides blindness from lit-pixel extent instead.
 *
 * The two zero conditions are ANDed deliberately. A mode blind on ONE backend
 * is the real defect shape (one renderer censusing nothing while the other
 * censuses a full field), and it must stay a FAIL — see
 * `celestial-g1-gate.spec.mjs`, which pins both halves.
 *
 * @param {{webglM1Count:number,webgpuM1Count:number}} mode
 * @returns {boolean}
 */
export function modeIsBlind(mode) {
  return (mode?.webglM1Count ?? 0) === 0 && (mode?.webgpuM1Count ?? 0) === 0;
}

/**
 * POST-DR-01 blindness predicate: a mode where BOTH backends drew no lit pixel
 * at all. That, and not a zero census, is the state in which Lane A cannot see
 * its subject — a black frame satisfies "no resolved sources", "no chroma" and
 * "the backends agree" simultaneously, which is a false green in three
 * criteria at once.
 *
 * Same polarity as {@link modeIsBlind}: BOTH sides dark is blindness, ONE side
 * dark is the defect (and is caught by the lit-pixel ratio criterion, which
 * goes to 0 or null and fails).
 *
 * The bar is exactly zero — an existence claim, not a fitted floor.
 *
 * @param {{webglLitPixels:number,webgpuLitPixels:number}} mode
 * @returns {boolean}
 */
export function modeIsBlank(mode) {
  return (
    (mode?.webglLitPixels ?? 0) === 0 && (mode?.webgpuLitPixels ?? 0) === 0
  );
}

/**
 * What each Lane-A capture mode is allowed to certify after the DR-01 seam.
 * The probe passes one of these per mode; the lane builds a different criterion
 * set for each, because the three modes no longer measure the same thing.
 */
export const MODE_ROLE = Object.freeze({
  /** cube map + sprites — the shipped sky. Second-order metrics only. */
  COMPOSITE: "composite",
  /** cube map alone — diffuse Milky Way light, zero resolved sources. */
  DIFFUSE: "diffuse",
  /** sprites alone over black — the resolved-star owner under DR-01. */
  SPRITES: "sprites",
});

/**
 * `cubemap-only` -> `cubemapOnly`, so criterion names survive the repair
 * unchanged and old reports stay greppable.
 * @param {string} mode
 * @returns {string}
 */
function camel(mode) {
  return mode.replaceAll(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Evaluate the orbital bare-star-field lane. This lane measures CUBEMAP AND
 * SPRITE PARITY over a black background — it does NOT reach the C11-176
 * star-modulation state (the camera sits ~43,600 km up, far above
 * `ATMOSPHERIC_COLUMN_FADE_END = 111 km`, so `skyBrightness` is 0 by
 * construction, and G1 additionally disables the sky atmosphere that
 * `CubeMapPanorama.js` requires). Its `framingReached` is reported so that fact
 * is visible, but it is not required — the in-column lane owns that subject.
 *
 * @param {object} lane
 * @returns {{criteria:Object<string,boolean>,structuralModes:string[],framingReached:boolean,pass:boolean}}
 */
export function evaluateCubemapParityLane(lane) {
  const modes = lane.perMode ?? {};
  const certifyingMode = lane.certifyingMode ?? CUBEMAP_CERTIFYING_MODE;
  const roles = lane.modeRoles ?? {};
  const def = modes[certifyingMode] ?? {};

  // THE BLINDNESS RULE APPLIES TO THE CERTIFYING MODE TOO.
  //
  // Every certifying criterion below reads a ratio that `ratio()` returns null
  // for when the WebGL denominator is 0. `inBand(null)` is false, so a mode in
  // which neither backend drew anything would produce confident FALSE criteria
  // and exit 1 — a PHANTOM DEFECT over a scene in which the subject cannot be
  // observed at all, which is precisely the verdict this module's own doctrine
  // (see EXIT_CODE) forbids.
  //
  // POST-DR-01 the predicate is `modeIsBlank`, not `modeIsBlind`: after Batch
  // 833 a zero census is what a HEALTHY diffuse cube map reads, so routing on
  // the count declares a correct scene blind (and, worse, lets a black frame
  // satisfy the seam assertion below). One-sided darkness is untouched — the
  // zeros are ANDed, so a mode where WebGL lights 40,000 pixels and WebGPU
  // lights none still scores, still fails, and still names its criterion.
  const certifyingModeBlank = modeIsBlank(def);
  // Reported, never routed on: the pre-DR-01 reading of the same mode.
  const certifyingModeBlind = modeIsBlind(def);

  const criteria = {};
  const structuralModes = [];
  const structuralNotes = [];

  if (certifyingModeBlank) {
    structuralModes.push(certifyingMode);
  } else {
    Object.assign(criteria, compositeCriteria(camel(certifyingMode), def));
  }

  for (const mode of lane.countModes ?? []) {
    if (mode === certifyingMode) {
      continue;
    }
    const m = modes[mode];
    if (modeIsBlank(m)) {
      structuralModes.push(mode);
      continue;
    }
    const role = roles[mode] ?? MODE_ROLE.COMPOSITE;
    if (role === MODE_ROLE.DIFFUSE) {
      Object.assign(criteria, diffuseCriteria(camel(mode), m));
    } else if (role === MODE_ROLE.SPRITES) {
      const { criteria: c, structural } = spriteCriteria(camel(mode), m);
      Object.assign(criteria, c);
      structuralNotes.push(...structural.map((s) => `${mode} — ${s}`));
    } else {
      Object.assign(criteria, compositeCriteria(camel(mode), m));
    }
  }

  return {
    ...lane,
    certifyingMode,
    certifyingModeBlank,
    certifyingModeBlind,
    criteria,
    structuralModes,
    structuralNotes,
    framingReached: computeFramingReached(lane.skyBrightness),
    // `{}.every(Boolean)` is vacuously true, so the blank case has to be
    // excluded explicitly or an empty criteria set would read as a clean sheet.
    pass: !certifyingModeBlank && Object.values(criteria).every(Boolean),
  };
}

/**
 * Criteria for a mode that carries the composite sky (cube map + sprites).
 *
 * These are exactly the metrics that never needed a point census: the two
 * second-order ratios G1's headline names, the absolute pedestal discriminator,
 * and lit-pixel extent parity — which is what now catches the one-sided
 * darkness the M1 count ratio used to catch.
 *
 * @param {string} name camel-cased mode name for the criterion keys
 * @param {object} m the mode's cross-backend measurements
 * @returns {Object<string,boolean>}
 */
function compositeCriteria(name, m) {
  return {
    [`${name}_m2a_in_band`]: inBand(m.m2aRatio),
    [`${name}_m2b_in_band`]: inBand(m.m2bRatio),
    // M2e — the pedestal discriminator. Absolute bound; see
    // SKY_FLOOR_ABS_TOLERANCE.
    [`${name}_m2e_skyFloor_within_quantization`]: skyFloorAgrees(
      m.webglSkyFloor,
      m.webgpuSkyFloor,
    ),
    [`${name}_litPixelRatio_in_band`]: inBand(m.litPixelRatio),
  };
}

/**
 * Criteria for the `cubemap-only` mode after DR-01.
 *
 * THE ZERO IS THE ASSERTION. DR-01 gives the diffuse bake exactly one job —
 * degree-scale Milky Way light, no resolved stars — and
 * `DR01_LIMITS.diffuseMaxPointSources` is 0 offline. Asserting the same thing
 * on the live frame turns the reading that made this mode structural into the
 * strongest statement the mode can make: a re-bake that reintroduces resolved
 * sources, or a default variant flipped back to the un-blurred faces, fails
 * here. The tolerance matches `probe-stars-catalog.mjs`'s sibling check (G).
 *
 * The peak-luminance agreement is the positive control that keeps the zero
 * honest: a black frame also censuses zero. `modeIsBlank` already routes a
 * doubly-black mode to STRUCTURAL; this catches the one-sided case and any
 * pedestal between the two backends' diffuse bands.
 *
 * @param {string} name
 * @param {object} m
 * @returns {Object<string,boolean>}
 */
function diffuseCriteria(name, m) {
  const glCount = m.webglM1Count ?? 0;
  const gpuCount = m.webgpuM1Count ?? 0;
  return {
    [`${name}_dr01_resolvedSources_le_${DR01_LIVE_MAX_RESOLVED_SOURCES}`]:
      Number.isFinite(glCount) &&
      Number.isFinite(gpuCount) &&
      glCount <= DR01_LIVE_MAX_RESOLVED_SOURCES &&
      gpuCount <= DR01_LIVE_MAX_RESOLVED_SOURCES,
    [`${name}_litPixelRatio_in_band`]: inBand(m.litPixelRatio),
    [`${name}_peakLuminance_within_quantization`]:
      Number.isFinite(m.webglPeakLuminance) &&
      Number.isFinite(m.webgpuPeakLuminance) &&
      Math.abs(m.webgpuPeakLuminance - m.webglPeakLuminance) <=
        SKY_FLOOR_ABS_TOLERANCE,
  };
}

/**
 * Criteria for the `sprites-only` mode after DR-01.
 *
 * The sprite catalogue is SHARED CODE (`StarFieldMath.ts` feeds a
 * character-identical WGSL/GLSL pair), so the honest parity claim is per-pixel
 * agreement rather than a count of things the census can no longer resolve.
 * Batch 873 measured the two committed captures BIT-IDENTICAL; the bounded form
 * is what binds, and `bitIdentical` travels in the report.
 *
 * Chroma is re-pointed from "HSV saturation at the M1 detections" (an empty set
 * post-DR-01) to "HSV saturation over the brightest sprite pixels", which is
 * well defined precisely because this mode switches the cube map off. When the
 * WebGL reference has no chroma to compare against, the criterion is DROPPED
 * and reported structural rather than scored — `ratio()` returns null on a zero
 * denominator and `null >= 0.85` is a confident false.
 *
 * @param {string} name
 * @param {object} m
 * @returns {{criteria:Object<string,boolean>,structural:string[]}}
 */
function spriteCriteria(name, m) {
  const criteria = {
    [`${name}_litPixelRatio_in_band`]: inBand(m.litPixelRatio),
    [`${name}_maxChannelDelta_le_${SPRITE_MAX_CHANNEL_DELTA}`]:
      Number.isFinite(m.maxChannelDelta) &&
      m.maxChannelDelta <= SPRITE_MAX_CHANNEL_DELTA,
    [`${name}_differingFraction_within_bound`]:
      Number.isFinite(m.differingFraction) &&
      m.differingFraction <= SPRITE_DIFFERING_FRACTION_MAX,
  };
  const structural = [];
  const chromaMeasurable =
    Number.isFinite(m.webglChromaSamples) &&
    m.webglChromaSamples > 0 &&
    Number.isFinite(m.webglMedianSaturation) &&
    m.webglMedianSaturation > 0;
  if (chromaMeasurable) {
    criteria[`${name}_chromaRatio_ge_0_85`] =
      m.m3ChromaRatio >= M3_CHROMA_RATIO_MIN;
  } else {
    structural.push(
      "the WebGL reference produced no chroma to compare against, so the " +
        "sprite colour criterion could not be evaluated (0/0 is not a defect)",
    );
  }
  return { criteria, structural };
}

/**
 * Evaluate the in-atmospheric-column lane — the one that genuinely exercises
 * C11-176.
 *
 * The certifying quantity is the modulation's OWN energy, `mean(OFF) -
 * mean(ON)`, measured within each backend and then compared across backends.
 * Differencing inside a backend cancels the shell's additive emitted colour,
 * since the flag only reaches the star panorama. It does NOT cancel the
 * shell's alpha, which multiplies the panorama behind it: where the two
 * backends' shells differ in coverage, the surviving star energy differs
 * before any modulation is applied, and this lane's ratio then measures that
 * difference rather than the modulation term. Do not read the ratio as a
 * star-modulation number until the shell-extent alpha canonicity question is
 * decided.
 *
 * @param {object} lane
 * @returns {object}
 */
export function evaluateStarModulationLane(lane) {
  const on = lane.perMode?.["modulation-on"] ?? {};
  const off = lane.perMode?.["modulation-off"] ?? {};
  const framingReached = computeFramingReached(lane.skyBrightness);

  const energy = (backend) => {
    const meanOn = on[`${backend}Mean`];
    const meanOff = off[`${backend}Mean`];
    if (!Number.isFinite(meanOn) || !Number.isFinite(meanOff)) {
      return { delta: null, relative: null };
    }
    const delta = meanOff - meanOn;
    return {
      delta,
      // Reported only. See MODULATION_ENGAGED_MIN_ABS_DELTA for why the
      // engagement bar is absolute rather than this.
      relativeDIAGNOSTIC: meanOff > 0 ? Math.abs(delta) / meanOff : null,
    };
  };
  const glEnergy = energy("webgl");
  const gpuEnergy = energy("webgpu");

  // NON-VACUITY IS PER BACKEND, AND THE TWO CASES ARE NOT THE SAME CASE.
  //
  // A term that moved nothing on EITHER backend means the lane could not see
  // its subject: STRUCTURAL. A term that moved pixels on ONE backend and not
  // the other IS the C11-176 defect this lane was rebuilt to catch — a
  // star-brightness modulation live on one renderer and inert on the other —
  // and it must reach `failures[]`.
  //
  // ANDing the two ENGAGED conditions (the pre-repair shape) collapses those
  // two cases into one and downgrades the defect to STRUCTURAL, whose printed
  // headline asserts "this is NOT a pass and NOT a defect". Contrast
  // `modeIsBlind`, which ANDs the two ZERO conditions and therefore has the
  // correct polarity: blindness needs BOTH sides dead.
  const glMeasured = Number.isFinite(glEnergy.delta);
  const gpuMeasured = Number.isFinite(gpuEnergy.delta);
  const glModulationEngaged =
    glMeasured && Math.abs(glEnergy.delta) >= MODULATION_ENGAGED_MIN_ABS_DELTA;
  const gpuModulationEngaged =
    gpuMeasured &&
    Math.abs(gpuEnergy.delta) >= MODULATION_ENGAGED_MIN_ABS_DELTA;
  const modulationEngaged = glModulationEngaged && gpuModulationEngaged;
  const modulationBlind = !glModulationEngaged && !gpuModulationEngaged;
  // A capture that produced no usable mean on a backend is an instrument
  // failure, not a one-sided defect: there is no measurement to disagree with.
  const modulationUnmeasured = !glMeasured || !gpuMeasured;

  const starEnergyRatio = ratio(gpuEnergy.delta, glEnergy.delta);

  // A lane that cannot reach the failure state, or whose modulation term never
  // moved a pixel ON EITHER BACKEND, has not measured its subject. Both are
  // STRUCTURAL — the criteria below would otherwise report a confident green
  // over nothing.
  const structural = !framingReached || modulationUnmeasured || modulationBlind;

  const criteria = {
    // Named separately from the ratio so a one-sided dead term is REPORTED as
    // what it is. `starEnergyRatio` also catches it (0 and null are both out of
    // band), but a bare out-of-band ratio does not say which side went inert.
    modulationEngaged_on_both_backends: modulationEngaged,
    starEnergyRatio_in_band: inBand(starEnergyRatio),
    modulationOn_meanLumRatio_in_band: inBand(on.meanLumRatio),
    modulationOn_stddevRatio_in_band: inBand(on.stddevRatio),
  };

  return {
    ...lane,
    framingReached,
    modulationEngaged,
    glModulationEngaged,
    gpuModulationEngaged,
    modulationBlind,
    modulationUnmeasured,
    structural,
    glEnergy,
    gpuEnergy,
    starEnergyRatio,
    criteria,
    pass: !structural && Object.values(criteria).every(Boolean),
  };
}

/**
 * Fold the two lanes into one verdict.
 *
 * Precedence: a genuine criterion failure in a lane that CAN see its subject
 * outranks a structural lane (a real defect must not be downgraded), and a
 * structural lane outranks a clean sheet (a blind gate must not report green).
 *
 * @param {{cubemapParity:object,starModulation:object}} evaluated
 * @returns {{verdict:string,exitCode:number,failures:string[],structural:string[]}}
 */
export function foldG1Verdict(evaluated) {
  const failures = [];
  const structural = [];

  const cp = evaluated.cubemapParity;
  if (cp) {
    for (const [name, ok] of Object.entries(cp.criteria)) {
      if (!ok) {
        failures.push(`orbital-cubemap-parity:${name}`);
      }
    }
    const certifyingMode = cp.certifyingMode ?? CUBEMAP_CERTIFYING_MODE;
    for (const mode of cp.structuralModes) {
      structural.push(
        mode === certifyingMode
          ? `orbital-cubemap-parity:${mode} — both backends drew NO lit pixel in the CERTIFYING mode; this lane certified nothing`
          : `orbital-cubemap-parity:${mode} — both backends drew NO lit pixel`,
      );
    }
    for (const note of cp.structuralNotes ?? []) {
      structural.push(`orbital-cubemap-parity:${note}`);
    }
  }

  const sm = evaluated.starModulation;
  if (!sm) {
    structural.push(
      "in-column-star-modulation — lane absent; G1 cannot certify C11-176",
    );
  } else if (sm.structural) {
    structural.push(
      !sm.framingReached
        ? "in-column-star-modulation — skyBrightness never exceeded the star-modulation threshold"
        : sm.modulationUnmeasured
          ? "in-column-star-modulation — the OFF/ON mean could not be measured on at least one backend"
          : "in-column-star-modulation — modulation term never moved a pixel on EITHER backend",
    );
  } else {
    for (const [name, ok] of Object.entries(sm.criteria)) {
      if (!ok) {
        failures.push(`in-column-star-modulation:${name}`);
      }
    }
  }

  let verdict = "PASS";
  let exitCode = EXIT_CODE.PASS;
  if (failures.length > 0) {
    verdict = "FAIL";
    exitCode = EXIT_CODE.FAIL;
  } else if (structural.length > 0) {
    verdict = "STRUCTURAL";
    exitCode = EXIT_CODE.STRUCTURAL;
  }
  return { verdict, exitCode, failures, structural };
}

/**
 * Build the PRINTED summary.
 *
 * `m2aRatio` divides sigma by mu, so on its own it can never say whether a
 * failure came from a mean/pedestal shift or from a contrast excess. Both
 * factors travel WITH it here — that omission is the entire reason C12-G1F2
 * existed as an unattributable row.
 *
 * @param {object} result
 * @returns {object}
 */
export function buildG1Summary(result) {
  const laneSummary = (lane) => {
    if (!lane) {
      return null;
    }
    return {
      role: lane.role,
      framingReached: lane.framingReached,
      skyBrightness: lane.skyBrightness,
      sunElevationDeg: lane.sunElevationDeg,
      ...(lane.certifyingModeBlank === undefined
        ? {}
        : {
            certifyingMode: lane.certifyingMode,
            certifyingModeBlank: lane.certifyingModeBlank,
            // The PRE-DR-01 reading of the same mode, reported so a reader can
            // see that "0 resolved sources" is now the expected state rather
            // than the blindness it used to be.
            certifyingModeBlind_PRE_DR01_DIAGNOSTIC:
              lane.certifyingModeBlind ?? null,
          }),
      ...(lane.modulationEngaged === undefined
        ? {}
        : {
            modulationEngaged: lane.modulationEngaged,
            // PER-BACKEND, because the aggregate cannot distinguish "neither
            // side moved" (blindness) from "one side went inert" (the defect).
            glModulationEngaged: lane.glModulationEngaged,
            gpuModulationEngaged: lane.gpuModulationEngaged,
            starEnergyRatio: lane.starEnergyRatio,
          }),
      criteria: lane.criteria,
      perMode: Object.fromEntries(
        Object.entries(lane.perMode ?? {}).map(([mode, m]) => [
          mode,
          {
            m1CountRatio: m.m1CountRatio ?? null,
            m2aRatio: m.m2aRatio ?? null,
            // ATTRIBUTION FACTORS — m2aRatio is (sigma/mu)_gpu / (sigma/mu)_gl.
            // Without these two a failure cannot be attributed.
            meanLumRatio: m.meanLumRatio ?? null,
            stddevRatio: m.stddevRatio ?? null,
            m2bRatio: m.m2bRatio ?? null,
            m3ChromaRatio: m.m3ChromaRatio ?? null,
            webgl_m1Count: m.webglM1Count ?? null,
            webgpu_m1Count: m.webgpuM1Count ?? null,
            // POST-DR-01 Lane-A instruments. `m1Count` above is retained and
            // reported but no longer certifies — see the module header.
            litPixelRatio: m.litPixelRatio ?? null,
            webgl_litPixels: m.webglLitPixels ?? null,
            webgpu_litPixels: m.webgpuLitPixels ?? null,
            webgl_peakLuminance: m.webglPeakLuminance ?? null,
            webgpu_peakLuminance: m.webgpuPeakLuminance ?? null,
            differingPixels: m.differingPixels ?? null,
            differingFraction: m.differingFraction ?? null,
            maxChannelDelta: m.maxChannelDelta ?? null,
            bitIdentical: m.bitIdentical ?? null,
            webgl_medianSaturation: m.webglMedianSaturation ?? null,
            webgpu_medianSaturation: m.webgpuMedianSaturation ?? null,
            webgl_chromaSamples: m.webglChromaSamples ?? null,
            webgl_skyFloor: m.webglSkyFloor ?? null,
            webgpu_skyFloor: m.webgpuSkyFloor ?? null,
            skyFloorAbsDelta:
              Number.isFinite(m.webglSkyFloor) &&
              Number.isFinite(m.webgpuSkyFloor)
                ? Math.abs(m.webgpuSkyFloor - m.webglSkyFloor)
                : null,
          },
        ]),
      ),
    };
  };

  return {
    gate: "G1",
    verdict: result.verdict,
    exitCode: result.exitCode,
    skyFloorAbsTolerance: SKY_FLOOR_ABS_TOLERANCE,
    starModulationSkyBrightnessThreshold:
      STAR_MODULATION_SKY_BRIGHTNESS_THRESHOLD,
    dr01LiveMaxResolvedSources: DR01_LIVE_MAX_RESOLVED_SOURCES,
    spriteDifferingFractionMax: SPRITE_DIFFERING_FRACTION_MAX,
    spriteMaxChannelDelta: SPRITE_MAX_CHANNEL_DELTA,
    failures: result.failures,
    structural: result.structural,
    lanes: {
      "orbital-cubemap-parity": laneSummary(result.lanes?.cubemapParity),
      "in-column-star-modulation": laneSummary(result.lanes?.starModulation),
    },
  };
}
