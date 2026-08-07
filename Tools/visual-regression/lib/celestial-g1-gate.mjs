// celestial-g1-gate.mjs — pure verdict logic for the Campaign-12 G1 celestial
// gate (C12-G1F2 repair).
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

import { srgbToLinear } from "./celestial-metrics.mjs";

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

/** Minimum WebGPU/WebGL M1 point-source count ratio. */
export const M1_COUNT_RATIO_MIN = 0.9;

/** Minimum WebGPU/WebGL M3 median-chroma ratio. */
export const M3_CHROMA_RATIO_MIN = 0.85;

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
 * A capture mode where BOTH backends census zero point sources cannot express
 * a count ratio: 0/0 is not parity and not a defect, it is an instrument that
 * cannot see its subject. Such a mode is reported STRUCTURAL rather than
 * folded into PASS/FAIL.
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
  const def = modes[certifyingMode] ?? {};

  // THE BLINDNESS RULE APPLIES TO THE CERTIFYING MODE TOO.
  //
  // Every criterion below is measured on `default`, and each one reads a ratio
  // that `ratio()` returns null for when the WebGL denominator is 0. `null >=
  // 0.9` and `inBand(null)` are both false, so a mode where BOTH backends
  // censused zero sources would have produced four confident FALSE criteria and
  // exit 1 — a PHANTOM DEFECT over a scene in which the subject cannot be
  // observed at all, which is precisely the verdict this module's own doctrine
  // (see EXIT_CODE) forbids. The secondary count modes have been routed to
  // STRUCTURAL since the repair landed; the certifying mode was not, so the one
  // mode whose blindness voids the WHOLE lane was the one mode not covered.
  //
  // One-sided blindness is untouched: `modeIsBlind` ANDs the zeros, so a lane
  // where WebGL censuses 55 and WebGPU censuses 0 still scores, still fails, and
  // still names the criterion.
  const certifyingModeBlind = modeIsBlind(def);

  const criteria = certifyingModeBlind
    ? {}
    : {
        [`${camel(certifyingMode)}_m1CountRatio_ge_0_90`]:
          def.m1CountRatio >= M1_COUNT_RATIO_MIN,
        [`${camel(certifyingMode)}_m2a_in_band`]: inBand(def.m2aRatio),
        [`${camel(certifyingMode)}_m2b_in_band`]: inBand(def.m2bRatio),
        [`${camel(certifyingMode)}_m3Chroma_ge_0_85`]:
          def.m3ChromaRatio >= M3_CHROMA_RATIO_MIN,
        // M2e — the pedestal discriminator. Absolute bound; see
        // SKY_FLOOR_ABS_TOLERANCE. Certifies only here, where the background is
        // black by construction and the quantization derivation therefore holds.
        [`${camel(certifyingMode)}_m2e_skyFloor_within_quantization`]:
          skyFloorAgrees(def.webglSkyFloor, def.webgpuSkyFloor),
      };

  const structuralModes = [];
  if (certifyingModeBlind) {
    structuralModes.push(certifyingMode);
  }
  for (const mode of lane.countModes ?? []) {
    if (mode === certifyingMode) {
      continue;
    }
    if (modeIsBlind(modes[mode])) {
      structuralModes.push(mode);
      continue;
    }
    criteria[`${camel(mode)}_m1CountRatio_ge_0_90`] =
      modes[mode]?.m1CountRatio >= M1_COUNT_RATIO_MIN;
  }

  return {
    ...lane,
    certifyingMode,
    certifyingModeBlind,
    criteria,
    structuralModes,
    framingReached: computeFramingReached(lane.skyBrightness),
    // `{}.every(Boolean)` is vacuously true, so the blind case has to be
    // excluded explicitly or an empty criteria set would read as a clean sheet.
    pass: !certifyingModeBlind && Object.values(criteria).every(Boolean),
  };
}

/**
 * Evaluate the in-atmospheric-column lane — the one that genuinely exercises
 * C11-176.
 *
 * The certifying quantity is the modulation's OWN energy, `mean(OFF) -
 * mean(ON)`, measured within each backend and then compared across backends.
 * Differencing inside a backend cancels the sky-atmosphere shell (which is
 * identical in both legs, since the flag only reaches the star panorama), so a
 * shell-parity gap cannot masquerade as — or mask — a star-modulation gap.
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
          ? `orbital-cubemap-parity:${mode} — both backends censused 0 sources in the CERTIFYING mode; this lane certified nothing`
          : `orbital-cubemap-parity:${mode} — both backends censused 0 sources`,
      );
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
      ...(lane.certifyingModeBlind === undefined
        ? {}
        : {
            certifyingMode: lane.certifyingMode,
            certifyingModeBlind: lane.certifyingModeBlind,
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
    failures: result.failures,
    structural: result.structural,
    lanes: {
      "orbital-cubemap-parity": laneSummary(result.lanes?.cubemapParity),
      "in-column-star-modulation": laneSummary(result.lanes?.starModulation),
    },
  };
}
