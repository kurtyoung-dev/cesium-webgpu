/**
 * C13-16 — the MARCH TRANSFER model. Maintainer ruling R3 (2026-08-06,
 * `migration_doc/DEFERRED_WORK.md#RULING-2026-08-06`).
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 *
 * `lib/cloud-genus-morphology-model.mjs` is the CPU twin of the morphology
 * ARITHMETIC and measures the FIELD: `fibreElongation` samples
 * `genusFibreFactor` alone and recovers 5.743 / 4.543 / 1.964 / 1.000 for
 * CIRRUS / CIRROSTRATUS / CIRROCUMULUS / CUMULUS against authored aspects
 * 9 / 5 / 2 / 1. `probe-cloud-genus-morphology.mjs --phase=direction` measures
 * the INTEGRATED IMAGE and recovered 1.178 / 0.978 / 0.905 / 0.971. Both are
 * correct; they measure different quantities. Gates C, D and E were predicted
 * from the first and scored against the second, which is why all three fail as
 * ONE phenomenon.
 *
 * This module predicts the second. It reconstructs, in Node, the chain that
 * stands between the anisotropic domain and a canvas pixel:
 *
 *   1. a perspective ray per pixel from the probe's camera (nadir, 250 km,
 *      1024x768, Cesium's 60 deg HORIZONTAL fov -> 46.83 deg fovy),
 *   2. its entry/exit against the SHIPPED single shell (1500..4000 m — the
 *      renderer's `cloudLayerBottom`/`cloudLayerTop` defaults, which the probe
 *      does NOT override, so every genus marches the same 2500 m slab),
 *   3. `maxSteps` fine samples along that segment (32 at the probe's
 *      `directionQuality`),
 *   4. at each sample the SHIPPED LIVE density chain — `fbmNoise` base,
 *      `cloudEffectiveCoverage` threshold, `heightGradientFor`, the subtractive
 *      Worley erosion weighted by `genusErosionHeightWeight`, and the
 *      `genusFibreFactor` carve,
 *   5. the march's own saturating transfer, `alpha = 1 - exp(-tau)`, which is
 *      EXACTLY what the shader's per-sample `(1 - sampleTransmittance) *
 *      transmittance` accumulation sums to when the scattered colour is
 *      constant across the column,
 *   6. the probe's OWN estimator (r < 0.5 with linear interpolation between
 *      bracketing lags, 16 parallel lines, `maxLag = sampleCount / 3`),
 *      re-implemented here at the same pixel scale so the numbers are directly
 *      comparable rather than merely both "some correlation statistic".
 *
 * WHAT IS DELIBERATELY OMITTED, AND WHY THE OMISSION IS SAFE FOR THIS METRIC
 *
 *   - The light march, multi-scatter octaves, silver lining, sky/ground ambient
 *     and the HG phase. These modulate the scattered COLOUR per sample. The
 *     metric is a ratio of correlation half-lengths of a zero-mean-removed,
 *     variance-normalised field, so any spatially-slow multiplicative gain
 *     cancels. What does NOT cancel is any structure the light march itself
 *     imprints at the metric's scale — see LIMITATIONS.
 *   - The adaptive coarse/fine march. `ProceduralClouds.wgsl:2237-2241` states
 *     the fine comb is the same grid as the old fixed march and "preserves the
 *     image"; the coarse phase only skips empty space.
 *   - Tone mapping and 8-bit quantisation. Exposed as `clipLevel` /
 *     `radianceScale` so the sensitivity can be measured rather than assumed;
 *     the estimator is invariant to `radianceScale` alone.
 *
 * THE NOISE IS DISTRIBUTION-FAITHFUL, NOT BIT-FAITHFUL, for the reason the
 * genus twin already records: `hash3` / `hash33` evaluate in f32 on a GPU and
 * partly in f64 in Node. Everything measured here is therefore STRUCTURAL — a
 * ratio of correlation lengths — never a sample value.
 *
 * The morphology functions are IMPORTED from `cloud-genus-morphology-model.mjs`
 * rather than restated, so this module cannot drift from the shipped table or
 * from the twin the spec fleet already pins.
 *
 * ── R7 (2026-08-07): THE MODEL IS ALSO THE DESIGN INSTRUMENT ────────────────
 *
 * Maintainer ruling R7 chose OPTION 3 — fix the dilution with a
 * genus-conditioned base-field variance budget — and required candidate budgets
 * to be evaluated HERE, with predicted elongation AND opacity numbers, before
 * any shader edit. The candidate levers are `baseVarianceBudget`,
 * `budgetDownWeight`, `budgetPivotQuantile`, plus the `erosionScale`
 * ATTRIBUTION lever, and the scoring entry point is
 * {@link scoreBudgetCandidate}.
 *
 * NONE OF IT IS A SHIPPED PATH, and the sweep is the reason: no candidate
 * satisfies R7's four conditions while leaving the tour fixture's coverage floor
 * intact. Two nonlinearities stand downstream of the budget and neither is
 * visible from the base field:
 *
 *   1. the COVERAGE GATE `smoothstep(1 - cEff, 1, base)`, which makes a
 *      mean-preserving mix of the raw fBm NOT mean-preserving in what the march
 *      integrates. Curable — pivot on {@link gateMeanQuantile} instead of on the
 *      field mean — but only with a pivot that TRACKS `cEff`; a single authored
 *      constant is refuted by measurement (the required quantile runs 0.605 at
 *      cEff 0.43 to 0.485 at cEff 1.0).
 *   2. the SUBTRACTIVE EROSION's zero clamp `max(base * gradient - erosion, 0)`,
 *      which is convex, so reducing the base's variance reduces the mass that
 *      survives it. At the `northatlantic-cirrus-fibratus` fixture's coverage
 *      0.45 the mean erosion EXCEEDS the mean gated density, so that deck exists
 *      only as the base field's upper tail — exactly what a variance budget
 *      removes. NOT curable inside this mechanism: `erosionScale` 0 turns the
 *      same budget from -47.5% into +5.7% at that fixture, which is the
 *      attribution, executed rather than argued.
 *
 * `TOUR_CIRRUS_FIXTURE` is imported from the shipped fixture table so the second
 * configuration cannot drift, and the two opacity statistics
 * ({@link meanColumnOpacity}, {@link columnOpacityExceedance}) are separate
 * because the fixture's gate is a TAIL count, not a mean.
 *
 * ── U2 (2026-08-07): THE UNBLOCKERS, EVALUATED — AND THE STOP LIFTS ─────────
 *
 * The R7 sweep above ended by naming two unblockers. Both are now levers here
 * and both have been swept. THE STOP LIFTS, but only for the PAIR:
 *
 *   `carveBeforeErosion`  U2-REORDER. The genus fibre carve multiplies the
 *                         density BEFORE the subtractive erosion instead of
 *                         after it: `max(gate*gradient*fibre - erosion, 0)`
 *                         rather than `max(gate*gradient - erosion, 0)*fibre`.
 *                         Alone, at ZERO budget, it moves CIRRUS 1.232 -> 1.541
 *                         and costs -15.2% / -26.9% opacity. Pointwise it can
 *                         only remove mass, so it is not free.
 *   `erosionCompensation` U2-COMPENSATION. A genus-conditioned shallowing of the
 *                         erosion DEPTH, on `genusErosionHeightWeight`'s own
 *                         argument. Alone it is a strong mass lever and a weak
 *                         elongation lever - which is exactly what the reorder
 *                         needs, because the reorder is the reverse.
 *
 * THE PAIR IS WHY IT WORKS. Batch 896's blocker was an exchange rate: the
 * erosion's mass leverage is ~2.2x stronger at the tour fixture than at the gate
 * configuration, so compensating the floor overshot the opacity bar. The
 * REORDER's mass LOSS carries almost the same ratio (-26.9 / -15.2 = 1.77), so
 * the two nearly cancel at every coverage at once: at zero budget,
 * `erosionCompensation` 0.667 lands -0.2% at the gate configuration and +0.2% at
 * the fixture SIMULTANEOUSLY. That is the coincidence the whole result rests on,
 * and it is a measurement, not a design intention.
 *
 * `erosionMode` is a third lever and a finding rather than a candidate: the LIVE
 * route this model reproduces erodes SUBTRACTIVELY while the BAKED route uses a
 * `remap` the renderer's own uniform table calls "mean-preserving". Aligning
 * LIVE to BAKED is NOT byte-neutral (it moves the default CUMULUS lane and adds
 * +6.4% opacity) and does not reach the gates, so it is not the answer - but the
 * two shipped routes disagreeing about the composition R7's budget fights is
 * worth having in an executable form.
 *
 * {@link U2_CANDIDATE} is the recommended operating point. `budgetPivotQuantile`
 * is deliberately NOT part of it: at the much smaller budget weight the pair
 * needs (0.24 against 0.45), the exact per-coverage pivot buys 3.6 points of
 * fixture tail and the design passes without it, so the R7 unblocker "ship a
 * `cloudGateMean(cEff)` response" is a refinement and no longer a prerequisite.
 */

import CloudType from "../../../packages/engine/Source/Scene/CloudType.js";
import {
  CLOUD_COVERAGE_ANCHOR,
  CLOUD_COVERAGE_EXPONENT,
  CLOUD_DENSITY_WORLD_TO_NOISE,
  cloudEffectiveCoverage,
} from "../../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudDensityDomain.ts";
import {
  CloudTypeProfile,
  genusErosionHeightWeight,
  genusFibreFactor,
  worleyF1,
} from "./cloud-genus-morphology-model.mjs";
import { fixtureById } from "./cloud-tour-fixtures.mjs";

const f32 = Math.fround;

// THE COVERAGE RESPONSE AND THE WORLD->NOISE SCALE ARE IMPORTED, NOT COPIED.
//
// They were local literals plus a local re-statement of `cloudEffectiveCoverage`
// until 2026-08-07. The engine ships all four as an importable CPU twin
// (`WebGPUCloudDensityDomain.ts`), a sibling model in this same fleet
// (`fog-cheap-coverage-model.mjs`) already imports it, and the copy had already
// drifted in ROUNDING — the shipped twin rounds `anchor`, `c / anchor` and the
// `pow` result to f32 the way WGSL evaluates them, the copy did not. Re-deriving
// `CLOUD_COVERAGE_ANCHOR` or `CLOUD_COVERAGE_EXPONENT` in the product (which
// `CLOUD-LOW-COVERAGE-CUTOFF` already did once) would have left this model
// answering R3's transfer-curve question about a coverage gate the engine no
// longer ships, with nothing in the spec able to notice.
//
// Re-exported under the historical names so the spec and any consumer keep one
// import site; `cloud-march-transfer.spec.mjs` asserts these ARE the engine's
// own bindings rather than equal-valued copies.
export {
  cloudEffectiveCoverage,
  CLOUD_COVERAGE_ANCHOR as COVERAGE_ANCHOR,
  CLOUD_COVERAGE_EXPONENT as COVERAGE_EXPONENT,
  CLOUD_DENSITY_WORLD_TO_NOISE as WORLD_TO_NOISE,
};
const WORLD_TO_NOISE = CLOUD_DENSITY_WORLD_TO_NOISE;

/** `WGS84_EQUATORIAL_RADIUS` as the renderer packs `planetRadius`. */
export const PLANET_RADIUS = 6378137.0;
/** `absorptionCoeff`, hard-coded at WebGPUProceduralCloudRenderer.ts:1982. */
export const ABSORPTION_COEFF = 0.04;

/**
 * The probe's camera and canvas, and the renderer defaults the probe does not
 * override. Every value here is read off a shipped artifact — the provenance is
 * in the comment beside it — so a change in the product surfaces as a spec
 * failure rather than as a silently stale constant.
 */
export const PROBE_GEOMETRY = Object.freeze({
  canvasWidth: 1024, // manifest-direction.json `canvasSize`
  canvasHeight: 768,
  cameraHeightMeters: 250_000.0, // probe `CAMERA_HEIGHT`
  fovDegrees: 60.0, // Camera.js:211 — HORIZONTAL, aspect > 1
  shellBottomMeters: 1500.0, // renderer `cloudLayerBottom` default
  shellTopMeters: 4000.0, // renderer `cloudLayerTop` default
});

/**
 * The march + density inputs the probe's `direction` phase runs with.
 */
export const PROBE_MARCH = Object.freeze({
  steps: 32, // `directionQuality: 32` through resolveCloudQuality's escape hatch
  coverage: 0.8, // probe `baseVolumetric.cloudCoverage`
  densityMultiplier: 0.5, // probe `cloudDensity`
  puffSize: 0.45, // renderer `cloudPuffSize` default (LIVE path ignores it)
  anvilBias: 0.0,
});

/**
 * The probe's estimator geometry, taken from the measured run rather than
 * guessed: `contributionBbox` was the FULL frame on all five lanes, so
 * `halfExtent = min(1024, 768) * 0.5 * 0.8 = 307.2`,
 * `sampleCount = min(256, floor(2 * halfExtent)) = 256`,
 * `maxLag = floor(256 / 3) = 85`, and the 16 line offsets span
 * `+/- halfExtent * 0.85 = +/- 261.12` px.
 */
export const PROBE_ESTIMATOR = Object.freeze({
  halfExtent: 307.2,
  sampleCount: 256,
  lineCount: 16,
  lineSpreadFactor: 0.85,
});

/** The measured ground truth this model has to reproduce. */
export const MEASURED_SCREEN_ELONGATION = Object.freeze({
  CUMULUS: Object.freeze({
    cloudType: CloudType.CUMULUS,
    alongLength: 3.5925374949768836,
    acrossLength: 3.6995948332536472,
    elongation: 0.9710624154530427,
  }),
  CIRRUS: Object.freeze({
    cloudType: CloudType.CIRRUS,
    alongLength: 7.676733508288986,
    acrossLength: 6.51479166538404,
    elongation: 1.178354412939842,
  }),
  CIRROSTRATUS: Object.freeze({
    cloudType: CloudType.CIRROSTRATUS,
    alongLength: 7.208795101194443,
    acrossLength: 7.370006421532012,
    elongation: 0.9781260271542535,
  }),
  CIRROCUMULUS: Object.freeze({
    cloudType: CloudType.CIRROCUMULUS,
    alongLength: 6.930084844936492,
    acrossLength: 7.661269984772423,
    elongation: 0.9045608441825914,
  }),
});

/**
 * The `northatlantic-cirrus-fibratus` tour fixture's march inputs, read from the
 * SHIPPED fixture table rather than restated. This is the configuration
 * checklist item 6's `minChangedFraction` floor is scored at, and it is NOT the
 * configuration gates C/D/E are scored at — coverage 0.45 against the direction
 * probe's 0.8, and an 8-11 km deck against the renderer's default 1.5-4 km. R7's
 * opacity constraint has to hold at BOTH, which is the whole reason this is
 * imported here.
 */
export const TOUR_CIRRUS_FIXTURE = Object.freeze({
  id: "northatlantic-cirrus-fibratus",
  coverage: fixtureById("northatlantic-cirrus-fibratus").volumetric
    .cloudCoverage,
  densityMultiplier: fixtureById("northatlantic-cirrus-fibratus").volumetric
    .cloudDensity,
  geometry: Object.freeze({
    shellBottomMeters: fixtureById("northatlantic-cirrus-fibratus").volumetric
      .cloudLayerBottom,
    shellTopMeters: fixtureById("northatlantic-cirrus-fibratus").volumetric
      .cloudLayerTop,
  }),
  /** The authored floor the row records as the collision risk. */
  minChangedFraction: fixtureById("northatlantic-cirrus-fibratus").gate
    .minChangedFraction,
});

/**
 * The exact mean of `fbmNoise`: five octaves of amplitude 0.5 * 0.5^i over a
 * `valueNoise` whose own mean is exactly 0.5 (a trilinear-smoothstep blend of
 * uniform hashes with weights summing to 1). Derived, not measured:
 * `(0.5 + 0.25 + 0.125 + 0.0625 + 0.03125) * 0.5 = 0.484375`.
 */
export const BASE_FIELD_MEAN = 0.484375;

/**
 * How the subtractive detail erosion composes with the density it erodes.
 *
 * `subtractive` is the LIVE route this model reproduces (`legacyCloudDensity`:
 * `density -= worley * 0.18 * w(h); density = max(density, 0)`).
 * `remap` is the BAKED route's spelling (`cloudDensityFromMacro`:
 * `clamp(remap(density, erosionLo, 1, 0, 1), 0, 1)`), which the renderer's
 * uniform table calls the "V4 mean-preserving erosion floor".
 *
 * BOTH ARE SHIPPED, on different routes. That is a finding in its own right:
 * the composition R7's variance budget collides with is not one thing.
 */
export const EROSION_SUBTRACTIVE = "subtractive";
export const EROSION_REMAP = "remap";

/**
 * R7 CANDIDATE — how much of the budget is spent pulling a sample DOWN.
 *
 * 1 is the symmetric budget: the coverage-gated base is pulled toward the pivot
 * from both sides, which is the only setting that is mean-NEUTRAL in the gate.
 * 0 is the one-sided budget: holes are filled and peaks are left alone, which
 * ADDS mass and therefore cannot threaten a coverage floor.
 *
 * It is one continuous lever rather than two modes because the measured
 * trade-off between the two failure surfaces (gate-configuration opacity and
 * the tour fixture's floor) is a CURVE along this axis, and a frontier stated as
 * two isolated points invites the reply "you did not look in between".
 *
 * NOT A SHIPPED PATH. Nothing in `ProceduralClouds.wgsl` implements any of this;
 * `cloud-march-transfer.spec.mjs` asserts that negatively so the candidate
 * cannot quietly become a twin of code that does not exist.
 */
export const BUDGET_DOWN_WEIGHT_SYMMETRIC = 1;
export const BUDGET_DOWN_WEIGHT_UP_ONLY = 0;

/**
 * R7 CANDIDATE — the genus conditioner.
 *
 * The budget is spent in proportion to how much ANISOTROPIC structure a genus
 * actually has to reveal: `strength` says how deeply the fibre carve bites, and
 * `1 - 1/aspect` says how directional the carved domain is. Both factors are
 * exactly 0 on the identity row (`strength` 0, `anisotropy` 1), so a default
 * CUMULUS render takes the same early return the shipped morphology chain
 * already takes and stays byte-identical.
 *
 * The alternative conditioner — `strength` alone, reachable here with
 * `useAspect: false` so the comparison is pinnable rather than asserted in prose
 * — was measured and REJECTED: it hands CIRROCUMULUS (strength 0.45) a larger
 * budget than CIRROSTRATUS (0.40) while CIRROCUMULUS's aspect 2 gives it almost
 * no streak signal to reveal, so gate E's cirrostratus->cirrocumulus step lands
 * closer to its 1.1 bar at the same effective weight.
 *
 * @param {object} row `{strength, anisotropy, shear}` from CloudTypeProfile.
 * @param {number} budget The candidate's single scalar.
 * @param {object} [options] `{useAspect}`; false selects the rejected
 *   strength-only conditioner.
 * @returns {number} The per-sample mix weight, in [0, 1].
 */
export function baseVarianceBudgetWeight(row, budget, options = {}) {
  const { useAspect = true } = options;
  const strength = clamp(row.strength, 0, 1);
  const aspect = Math.max(row.anisotropy, 1);
  const directionality = useAspect ? 1 - 1 / aspect : 1;
  return clamp(budget * strength * directionality, 0, 1);
}

function fract(value) {
  return f32(value - Math.floor(value));
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function smoothstep(edge0, edge1, x) {
  const t = clamp(f32((x - edge0) / (edge1 - edge0)), 0, 1);
  return f32(t * t * f32(3 - 2 * t));
}

/** ProceduralClouds.wgsl `hash3`. */
function hash3(px, py, pz) {
  let qx = fract(f32(px * 0.1031));
  let qy = fract(f32(py * 0.1031));
  let qz = fract(f32(pz * 0.1031));
  const d = f32(
    f32(qx * f32(qz + 31.32)) +
      f32(qy * f32(qy + 31.32)) +
      f32(qz * f32(qx + 31.32)),
  );
  qx = f32(qx + d);
  qy = f32(qy + d);
  qz = f32(qz + d);
  return fract(f32(f32(qx + qy) * qz));
}

/** ProceduralClouds.wgsl `valueNoise`. */
export function valueNoise(px, py, pz) {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = f32(px - ix);
  const fy = f32(py - iy);
  const fz = f32(pz - iz);
  const ux = f32(fx * fx * f32(3 - 2 * fx));
  const uy = f32(fy * fy * f32(3 - 2 * fy));
  const uz = f32(fz * fz * f32(3 - 2 * fz));
  const lerp = (a, b, t) => f32(a + (b - a) * t);
  const c000 = hash3(ix, iy, iz);
  const c100 = hash3(ix + 1, iy, iz);
  const c010 = hash3(ix, iy + 1, iz);
  const c110 = hash3(ix + 1, iy + 1, iz);
  const c001 = hash3(ix, iy, iz + 1);
  const c101 = hash3(ix + 1, iy, iz + 1);
  const c011 = hash3(ix, iy + 1, iz + 1);
  const c111 = hash3(ix + 1, iy + 1, iz + 1);
  return lerp(
    lerp(lerp(c000, c100, ux), lerp(c010, c110, ux), uy),
    lerp(lerp(c001, c101, ux), lerp(c011, c111, ux), uy),
    uz,
  );
}

/** ProceduralClouds.wgsl `fbmNoise` — 5 octaves, +0.13 z drift per octave. */
export function fbmNoise(px, py, pz) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  // Only z drifts; the shader's `pos += vec3(0, 0, 0.13)` leaves x and y alone.
  let z = pz;
  for (let i = 0; i < 5; i++) {
    value = f32(
      value +
        f32(
          amplitude *
            valueNoise(
              f32(px * frequency),
              f32(py * frequency),
              f32(z * frequency),
            ),
        ),
    );
    frequency = f32(frequency * 2);
    amplitude = f32(amplitude * 0.5);
    z = f32(z + 0.13);
  }
  return value;
}

/** ProceduralClouds.wgsl `heightGradientFor`. */
export function heightGradientFor(h, shape, anvil) {
  if (shape < 0.5) {
    return f32(smoothstep(0.0, 0.08, h) * smoothstep(1.0, 0.92, h));
  }
  if (shape < 1.5) {
    return f32(smoothstep(0.0, 0.15, h) * smoothstep(1.0, 0.7, h));
  }
  const base = smoothstep(0.0, 0.12, h);
  const anvilTop = smoothstep(
    1.0,
    f32(0.85 + (0.6 - 0.85) * clamp(anvil, 0, 1)),
    h,
  );
  return f32(base * anvilTop);
}

/**
 * The per-genus march inputs the renderer derives from the SHIPPED profile
 * table — not restated here, read from `CloudTypeProfile` so the model tracks
 * the product.
 *
 * @param {number} cloudType A {@link CloudType} genus.
 * @returns {object} `{row, profileShape, profileDensityScale, profileExtinction}`.
 */
export function genusMarchParameters(cloudType) {
  const profile = CloudTypeProfile.get(cloudType);
  const cumulus = CloudTypeProfile.get(CloudType.CUMULUS);
  return {
    row: CloudTypeProfile.getFibreMorphology(cloudType),
    profileShape: profile.shape,
    profileDensityScale:
      cumulus.baseDensity > 0 ? profile.baseDensity / cumulus.baseDensity : 1,
    profileExtinction:
      cumulus.extinction > 0 ? profile.extinction / cumulus.extinction : 1,
  };
}

/**
 * ProceduralClouds.wgsl `legacyCloudDensity`, LIVE branch (the probe's escape
 * hatch forces `noiseSource: LIVE`, so the baked texture branch is dead here),
 * with the weather map off (`weatherMapEnabled` 0 -> densityScale 1,
 * baseShiftFrac 0, perGenusShape = profileShape) and wind speed 0.
 *
 * @param {number[]} sp Noise-space sample position.
 * @param {number} h Shell height fraction.
 * @param {object} p Model parameters.
 * @returns {number} Density, including the density and profile multipliers.
 */
export function marchedDensity(sp, h, p) {
  let density = fbmNoise(sp[0], sp[1], sp[2]);
  if (p.includeBaseField === false) {
    // MUTATION lane: replace the isotropic base with its own mean so the fibre
    // carve is the only structure left. Not a product path.
    density = BASE_FIELD_MEAN;
  }
  const threshold = f32(1 - p.effectiveCoverage);
  density = smoothstep(threshold, 1.0, density);
  if (p.budgetWeight > 0) {
    // R7 CANDIDATE — the genus-conditioned base-field variance budget, applied
    // to the COVERAGE-GATED base rather than to the raw fBm. Applying it to the
    // raw field was measured and is strictly worse: the gate is where the
    // nonlinearity is, so a mix that is mean-preserving in the fBm is not
    // mean-preserving in what the march integrates.
    const pivot = smoothstep(threshold, 1.0, p.budgetPivotQuantile);
    const weight =
      pivot < density
        ? f32(p.budgetWeight * p.budgetDownWeight)
        : p.budgetWeight;
    density = f32(density + (pivot - density) * weight);
  }
  const heightGradient = heightGradientFor(h, p.profileShape, p.anvilBias);
  density = f32(density * heightGradient);
  let fibre = 1;
  if (p.includeFibre !== false) {
    // `fibreFrequencyScale` is a WHAT-IF lever, not a product path. Because
    // `genusFibreFactor` builds its domain as `vec3(along/aspect, sp.y*0.35,
    // acr) * FIBRE_DOMAIN_FREQUENCY`, pre-scaling `sp` by k is exactly
    // equivalent to authoring `FIBRE_DOMAIN_FREQUENCY = 3.0 * k` — including
    // the shear term, which is also linear in the horizontal coordinate. It is
    // spelled this way so the shipped `genusFibreFactor` stays the single
    // definition of the carve rather than being forked for a study.
    const k = p.fibreFrequencyScale;
    const scaled =
      k === 1 ? sp : [f32(sp[0] * k), f32(sp[1] * k), f32(sp[2] * k)];
    const row = k === 1 ? p.row : { ...p.row, shear: f32(p.row.shear * k) };
    fibre = genusFibreFactor(scaled, h, row, p.windDirection);
  }
  // U2-REORDER (candidate) — WHERE the genus fibre carve multiplies in.
  //
  // SHIPPED: `max(gate * gradient - erosion, 0) * fibre`. The carve is one link
  // of the `mammatus x species x feature` factor chain, applied to the density
  // that has ALREADY survived the subtractive erosion's zero clamp.
  //
  // REORDERED: `max(gate * gradient * fibre - erosion, 0)`. The carve is moved
  // ahead of the clamp, so a filament GAP has to clear the erosion floor after
  // being carved rather than before. Pointwise the reorder can only REMOVE mass
  // — `f * max(x - e, 0) = max(f*x - f*e, 0) >= max(f*x - e, 0)` for f in [0,1]
  // — so it is not a free lunch, and how much it removes versus how much streak
  // contrast it buys is the whole question.
  //
  // The genus gate is STRUCTURAL, not a branch: `genusFibreFactor` early-returns
  // exactly 1.0 at `strength` 0, and `x * 1` is exact in f32, so both spellings
  // collapse to the same arithmetic on every non-fibrous genus. The other three
  // morphology links stay where they are.
  if (p.carveBeforeErosion) {
    density = f32(density * fibre);
  }
  if (p.includeErosion !== false) {
    const worleyDetail = worleyF1(
      f32(sp[0] * 5),
      f32(sp[1] * 5),
      f32(sp[2] * 5),
    );
    const erosionLo = f32(
      f32(f32(worleyDetail * 0.18) * p.erosionDepthScale) *
        genusErosionHeightWeight(h, p.row.strength),
    );
    if (p.erosionMode === EROSION_REMAP) {
      // The BAKED route's spelling, `cloudDensityFromMacro`:
      // `clamp(remap(density, erosionLo, 1, 0, 1), 0, 1)` = `(d - lo)/(1 - lo)`.
      // The renderer calls it the "V4 mean-preserving erosion floor" (uniform
      // slot 79) precisely because it RESCALES the survivors instead of
      // translating everything down, so the zero clamp only bites where
      // `d < lo`. The LIVE route this model reproduces uses the SUBTRACTIVE
      // spelling instead — the two shipped routes disagree about the very
      // composition R7's budget is fighting, which is why this is a lever and
      // not a rewrite.
      density = clamp(f32(f32(density - erosionLo) / f32(1 - erosionLo)), 0, 1);
    } else {
      density = f32(density - erosionLo);
      density = Math.max(density, 0);
    }
  }
  const trailingFibre = p.carveBeforeErosion ? 1 : fibre;
  return f32(
    f32(f32(density * p.densityMultiplier) * p.profileDensityScale) *
      trailingFibre,
  );
}

/**
 * Optical depth of ONE pixel's column, i.e. the quantity the march integrates.
 *
 * @param {number} screenX Pixel offset from the frame centre, +right.
 * @param {number} screenY Pixel offset from the frame centre, +down.
 * @param {object} p Model parameters (see {@link buildModelParameters}).
 * @returns {number} `tau`; the image value is `1 - exp(-tau)`.
 */
export function columnOpticalDepth(screenX, screenY, p) {
  // Screen -> world ray. Local frame at lon 90 / lat 0: up is ECEF +Y, screen
  // right is ECEF -X and screen up is ECEF +Z (verified against the probe's own
  // `projectedWindAzimuthDeg`, which reported wind (1,0) at screen azimuth 0 and
  // wind (0,1) at 90). Sign conventions cannot move a correlation LENGTH; they
  // are kept faithful so the fallstreak shear keeps its downwind sense.
  const u = (screenX / (p.canvasWidth / 2)) * p.tanHalfFovX;
  const v = (-screenY / (p.canvasHeight / 2)) * p.tanHalfFovY;
  // forward = (0,-1,0); right = (-1,0,0); up = (0,0,1).
  let dx = -u;
  let dy = -1;
  let dz = v;
  const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
  dx *= inverseLength;
  dy *= inverseLength;
  dz *= inverseLength;

  const originY = PLANET_RADIUS + p.cameraHeightMeters;
  const outer = PLANET_RADIUS + p.shellTopMeters;
  const inner = PLANET_RADIUS + p.shellBottomMeters;
  // Ray-sphere from (0, originY, 0). b = dot(o, d) = originY * dy.
  const b = originY * dy;
  const originSquared = originY * originY;
  const hit = (radius) => {
    const disc = b * b - (originSquared - radius * radius);
    if (disc < 0) {
      return null;
    }
    const root = Math.sqrt(disc);
    const near = -b - root;
    const far = -b + root;
    return { near, far };
  };
  const outerHit = hit(outer);
  if (outerHit === null || outerHit.far <= 0) {
    return 0;
  }
  const innerHit = hit(inner);
  const tStart = Math.max(outerHit.near, 0);
  const tEnd =
    innerHit !== null && innerHit.near > tStart ? innerHit.near : outerHit.far;
  if (!(tEnd > tStart)) {
    return 0;
  }

  const fineStep = (tEnd - tStart) / p.steps;
  const thickness = p.shellTopMeters - p.shellBottomMeters;
  let tau = 0;
  const sp = [0, 0, 0];
  for (let k = 0; k < p.steps; k++) {
    const t = tStart + k * fineStep;
    const wx = dx * t;
    const wy = originY + dy * t;
    const wz = dz * t;
    const radius = Math.sqrt(wx * wx + wy * wy + wz * wz);
    const h = clamp(
      (radius - PLANET_RADIUS - p.shellBottomMeters) / thickness,
      0,
      1,
    );
    sp[0] = f32(wx * WORLD_TO_NOISE);
    sp[1] = f32(wy * WORLD_TO_NOISE);
    sp[2] = f32(wz * WORLD_TO_NOISE);
    const density = marchedDensity(sp, h, p);
    if (density > 0) {
      tau += density * fineStep * p.absorption;
    }
  }
  return tau;
}

/**
 * Assemble the full parameter block. Everything defaults to the SHIPPED value;
 * an override is how a what-if (a different authored aspect, a different step
 * count, a mutation) is expressed.
 *
 * @param {object} [overrides] Field-by-field overrides.
 * @returns {object} The parameter block the model functions consume.
 */
export function buildModelParameters(overrides = {}) {
  const cloudType = overrides.cloudType ?? CloudType.CIRRUS;
  const genus = genusMarchParameters(cloudType);
  const row = overrides.row ?? genus.row;
  const geometry = { ...PROBE_GEOMETRY, ...(overrides.geometry ?? {}) };
  const fovX = (geometry.fovDegrees * Math.PI) / 180;
  const aspect = geometry.canvasWidth / geometry.canvasHeight;
  const fovY =
    aspect <= 1 ? fovX : 2 * Math.atan(Math.tan(fovX * 0.5) / aspect);
  const p = {
    cloudType,
    row,
    profileShape: overrides.profileShape ?? genus.profileShape,
    profileDensityScale:
      overrides.profileDensityScale ?? genus.profileDensityScale,
    profileExtinction: overrides.profileExtinction ?? genus.profileExtinction,
    coverage: overrides.coverage ?? PROBE_MARCH.coverage,
    densityMultiplier:
      overrides.densityMultiplier ?? PROBE_MARCH.densityMultiplier,
    anvilBias: overrides.anvilBias ?? PROBE_MARCH.anvilBias,
    steps: overrides.steps ?? PROBE_MARCH.steps,
    windDirection: overrides.windDirection ?? [1, 0],
    includeBaseField: overrides.includeBaseField ?? true,
    includeErosion: overrides.includeErosion ?? true,
    includeFibre: overrides.includeFibre ?? true,
    fibreFrequencyScale: overrides.fibreFrequencyScale ?? 1,
    // R7 CANDIDATE levers + the attribution lever. All three are inert at their
    // defaults: `erosionScale` 1 multiplies by exactly 1 and `baseVarianceBudget`
    // 0 takes the same early-out the shipped chain has no branch for at all.
    baseVarianceBudget: overrides.baseVarianceBudget ?? 0,
    budgetDownWeight:
      overrides.budgetDownWeight ?? BUDGET_DOWN_WEIGHT_SYMMETRIC,
    erosionScale: overrides.erosionScale ?? 1,
    erosionCompensation: overrides.erosionCompensation ?? 0,
    erosionMode: overrides.erosionMode ?? EROSION_SUBTRACTIVE,
    carveBeforeErosion: overrides.carveBeforeErosion ?? false,
    saturate: overrides.saturate ?? true,
    radianceScale: overrides.radianceScale ?? 255,
    clipLevel: overrides.clipLevel ?? Infinity,
    ...geometry,
    tanHalfFovX: Math.tan(fovX * 0.5),
    tanHalfFovY: Math.tan(fovY * 0.5),
  };
  p.absorption =
    ABSORPTION_COEFF *
    (p.profileExtinction > 0 ? p.profileExtinction : 1) *
    (overrides.absorptionScale ?? 1);
  p.effectiveCoverage = cloudEffectiveCoverage(p.coverage);
  // U2-COMPENSATION (candidate) — a GENUS-CONDITIONED shallowing of the
  // subtractive erosion, on the same argument `genusErosionHeightWeight` already
  // makes: an ice deck is not shredded by convective entrainment, so a fibrous
  // genus should not carry a cumuliform erosion DEPTH either. Conditioned on
  // `strength` alone, exactly like the shipped height weight it rides beside, so
  // it is identity on every non-fibrous genus by construction.
  //
  // `erosionScale` stays as the RAW global attribution lever — it is what the
  // Batch-896 clamp attribution is scored with, and it must keep moving CUMULUS
  // so that "turn the erosion off entirely" remains expressible. The two
  // multiply; only `erosionCompensation` is a candidate design.
  p.erosionDepthScale = f32(
    p.erosionScale *
      f32(1 - p.erosionCompensation * clamp(p.row.strength, 0, 1)),
  );
  p.budgetUseAspect = overrides.budgetUseAspect ?? true;
  p.budgetWeight = baseVarianceBudgetWeight(p.row, p.baseVarianceBudget, {
    useAspect: p.budgetUseAspect,
  });
  // The pivot that makes the budget mean-NEUTRAL in the gate: the base-field
  // quantile whose gate value equals the gate's own mean at THIS effective
  // coverage. Measured from the shipped `fbmNoise`, never authored. An override
  // is how the "what if a single constant were shipped instead" study is run,
  // and that study is the one that refutes the constant.
  p.budgetPivotQuantile =
    overrides.budgetPivotQuantile ??
    (p.budgetWeight > 0 ? gateMeanQuantile(p.effectiveCoverage) : 0);
  return p;
}

/**
 * Monte-Carlo mean of the COVERAGE GATE over the shipped `fbmNoise`, i.e.
 * `E[smoothstep(1 - cEff, 1, fbmNoise)]`.
 *
 * This is the quantity a mean-preserving variance budget has to pivot on, and
 * it is a property of the base field's DISTRIBUTION, not of any authored
 * constant. It is measured here on a fixed lattice (deterministic, no RNG) so a
 * change to `fbmNoise` moves it and the spec notices.
 *
 * @param {number} effectiveCoverage The gate's `cEff`.
 * @param {object} [options] `{columns, layers}` sampling geometry.
 * @returns {number} The gate's mean.
 */
const GATE_MEAN_CACHE = new Map();
const GATE_QUANTILE_CACHE = new Map();

export function gateMean(effectiveCoverage, options = {}) {
  const { columns = 60, layers = 12 } = options;
  const key = `${effectiveCoverage}|${columns}|${layers}`;
  const cached = GATE_MEAN_CACHE.get(key);
  if (cached !== undefined) {
    return cached;
  }
  const threshold = f32(1 - effectiveCoverage);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < columns; i++) {
    for (let j = 0; j < columns; j++) {
      for (let k = 0; k < layers; k++) {
        // Irrational-ish strides so the lattice never lands on the noise's own
        // integer cell boundaries, and a y span inside the shell's own range.
        const x = f32((i / columns) * 37.0 + 0.137);
        const y = f32((k / layers) * 3.0 + 1.7);
        const z = f32((j / columns) * 37.0 + 0.911);
        sum += smoothstep(threshold, 1.0, fbmNoise(x, y, z));
        count++;
      }
    }
  }
  const mean = sum / count;
  GATE_MEAN_CACHE.set(key, mean);
  return mean;
}

/**
 * Invert {@link gateMean}: the base-field value `q` for which
 * `smoothstep(1 - cEff, 1, q)` equals the gate's own mean.
 *
 * Blending the gate toward `smoothstep(1 - cEff, 1, q)` is then mean-neutral in
 * the gate at ANY weight — which is exactly the property a "variance budget, not
 * a density reduction" needs, and exactly the property a single authored
 * constant cannot have: the required `q` moves from 0.605 at cEff 0.43 to 0.485
 * at cEff 1.0.
 *
 * @param {number} effectiveCoverage The gate's `cEff`.
 * @returns {number} The mean-neutral pivot quantile.
 */
export function gateMeanQuantile(effectiveCoverage) {
  const cached = GATE_QUANTILE_CACHE.get(effectiveCoverage);
  if (cached !== undefined) {
    return cached;
  }
  const target = gateMean(effectiveCoverage);
  const threshold = f32(1 - effectiveCoverage);
  let low = 0;
  let high = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (low + high) * 0.5;
    if (smoothstep(threshold, 1.0, mid) < target) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const quantile = (low + high) * 0.5;
  GATE_QUANTILE_CACHE.set(effectiveCoverage, quantile);
  return quantile;
}

/**
 * Metres of ground covered by one canvas pixel at the shell mid-height — the
 * conversion that turns a noise-space correlation length into the pixel units
 * the probe reports.
 *
 * @param {object} p A parameter block.
 * @returns {number} Metres per pixel.
 */
export function metersPerPixel(p) {
  const midHeight = (p.shellBottomMeters + p.shellTopMeters) * 0.5;
  const distance = p.cameraHeightMeters - midHeight;
  return (2 * distance * p.tanHalfFovX) / p.canvasWidth;
}

/** The image value of one pixel: the march's saturating transfer, then the canvas clip. */
export function pixelValue(screenX, screenY, p) {
  const tau = columnOpticalDepth(screenX, screenY, p);
  const alpha = p.saturate ? 1 - Math.exp(-tau) : tau;
  return Math.min(p.radianceScale * alpha, p.clipLevel);
}

/**
 * The probe's `halfLength`, verbatim in behaviour: first lag whose normalised
 * autocorrelation drops below 0.5, linearly interpolated between the bracketing
 * lags; a flat line reports saturation at `maxLag`.
 *
 * @param {Float64Array} samples One sample line.
 * @param {number} maxLag Largest lag examined.
 * @returns {{length: number, saturated: boolean}} Half-length in samples.
 */
export function halfLength(samples, maxLag) {
  const n = samples.length;
  let mean = 0;
  for (let i = 0; i < n; i++) {
    mean += samples[i];
  }
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    variance += (samples[i] - mean) ** 2;
  }
  variance /= n;
  if (variance <= 1e-9) {
    return { length: maxLag, saturated: true };
  }
  let previous = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++) {
      sum += (samples[i] - mean) * (samples[i + lag] - mean);
    }
    const r = sum / ((n - lag) * variance);
    if (r < 0.5) {
      const t = (previous - 0.5) / Math.max(previous - r, 1e-9);
      return { length: lag - 1 + t, saturated: false };
    }
    previous = r;
  }
  return { length: maxLag, saturated: true };
}

/**
 * Mean correlation half-length of the modelled image along a screen direction,
 * on the probe's own line geometry.
 *
 * @param {number} directionDeg Screen azimuth, degrees, y down.
 * @param {object} p A parameter block.
 * @param {object} [estimator] Estimator geometry; defaults to the probe's.
 * @returns {{length: number, accepted: number, saturated: number}} The mean.
 */
export function directionalLength(directionDeg, p, estimator = {}) {
  const {
    halfExtent = PROBE_ESTIMATOR.halfExtent,
    sampleCount = PROBE_ESTIMATOR.sampleCount,
    lineCount = PROBE_ESTIMATOR.lineCount,
    lineSpreadFactor = PROBE_ESTIMATOR.lineSpreadFactor,
  } = estimator;
  const maxLag = Math.max(8, Math.floor(sampleCount / 3));
  const radians = (directionDeg * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);
  const px = -uy;
  const py = ux;
  let total = 0;
  let accepted = 0;
  let saturated = 0;
  for (let line = 0; line < lineCount; line++) {
    const offset =
      (line / (lineCount - 1) - 0.5) * 2 * halfExtent * lineSpreadFactor;
    const startX = px * offset - (ux * sampleCount) / 2;
    const startY = py * offset - (uy * sampleCount) / 2;
    const samples = new Float64Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      samples[i] = pixelValue(startX + ux * i, startY + uy * i, p);
    }
    const measured = halfLength(samples, maxLag);
    total += measured.length;
    accepted++;
    if (measured.saturated) {
      saturated++;
    }
  }
  return { length: total / accepted, accepted, saturated };
}

/**
 * The model's answer to gate C/D/E's question: the along/across elongation of
 * the INTEGRATED IMAGE, plus the azimuth scan whose argmax gate D reads.
 *
 * @param {object} [overrides] Passed to {@link buildModelParameters}.
 * @param {object} [options] `{alongDeg, estimator, scanStepDeg, scan}`.
 * @returns {object} `{alongLength, acrossLength, elongation, argmaxDeg, scan}`.
 */
export function screenAnisotropy(overrides = {}, options = {}) {
  const p = buildModelParameters(overrides);
  const {
    alongDeg = 0,
    estimator = {},
    scanStepDeg = 15,
    scan = false,
  } = options;
  const along = directionalLength(alongDeg, p, estimator);
  const across = directionalLength(alongDeg + 90, p, estimator);
  const result = {
    alongDeg,
    alongLength: along.length,
    acrossLength: across.length,
    elongation: along.length / Math.max(across.length, 1e-6),
    saturatedLines: along.saturated + across.saturated,
    metersPerPixel: metersPerPixel(p),
  };
  if (scan) {
    const entries = [];
    for (let deg = 0; deg < 180; deg += scanStepDeg) {
      entries.push({
        deg,
        length: directionalLength(deg, p, estimator).length,
      });
    }
    result.scan = entries;
    result.argmaxDeg = entries.reduce((best, entry) =>
      entry.length > best.length ? entry : best,
    ).deg;
  }
  return result;
}

/**
 * The transfer curve R3 asks for: authored aspect -> on-screen elongation, with
 * every other input held at the CIRRUS row's shipped values.
 *
 * @param {number[]} aspects Authored `anisotropy` values to evaluate.
 * @param {object} [overrides] Passed through; `row.anisotropy` is replaced.
 * @param {object} [options] Passed to {@link screenAnisotropy}.
 * @returns {object[]} `[{aspect, alongLength, acrossLength, elongation}]`.
 */
export function transferCurve(aspects, overrides = {}, options = {}) {
  const base = buildModelParameters(overrides);
  return aspects.map((aspect) => {
    const measured = screenAnisotropy(
      { ...overrides, row: { ...base.row, anisotropy: aspect } },
      options,
    );
    return { aspect, ...measured };
  });
}

/**
 * Invert the curve: the authored aspect required to reach a target on-screen
 * elongation. Returns `reachable: false` rather than an extrapolated number
 * when the curve never gets there — the whole point of R3 is to find out
 * WHETHER it can, so an extrapolation would beg the question.
 *
 * @param {object[]} curve Output of {@link transferCurve}, ascending in aspect.
 * @param {number} targetElongation The gate's floor.
 * @returns {object} `{reachable, aspect, why}`.
 */
export function invertTransfer(curve, targetElongation) {
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1];
    const b = curve[i];
    if (a.elongation < targetElongation && b.elongation >= targetElongation) {
      const t =
        (targetElongation - a.elongation) /
        Math.max(b.elongation - a.elongation, 1e-12);
      return {
        reachable: true,
        aspect: a.aspect + t * (b.aspect - a.aspect),
        bracket: [a.aspect, b.aspect],
      };
    }
  }
  if (
    curve.length > 0 &&
    curve[curve.length - 1].elongation >= targetElongation
  ) {
    return { reachable: true, aspect: curve[0].aspect, bracket: null };
  }
  const best = curve.reduce(
    (top, entry) => (entry.elongation > top.elongation ? entry : top),
    curve[0],
  );
  return {
    reachable: false,
    aspect: null,
    why:
      `the curve tops out at elongation ${best.elongation.toFixed(3)} ` +
      `at aspect ${best.aspect}, below the ${targetElongation} target`,
    ceiling: best,
  };
}

/**
 * The grid the two opacity statistics are evaluated on. Coarse and wide rather
 * than dense and central: a dense central patch lands wherever the base fBm
 * happens to be, which is the trap the `medianTau` helper in the spec already
 * avoids.
 */
export const OPACITY_GRID = Object.freeze({ half: 10, pitchPixels: 24 });

/**
 * MEAN column opacity, `E[1 - exp(-tau)]` over {@link OPACITY_GRID}.
 *
 * This is the statistic R7's "within a few percent of shipped" constraint is
 * written against, and the same one the strength lever was priced in
 * (0.199 -> 0.166, -17%).
 *
 * @param {object} [overrides] Passed to {@link buildModelParameters}.
 * @param {object} [grid] `{half, pitchPixels}`.
 * @returns {number} Mean alpha.
 */
export function meanColumnOpacity(overrides = {}, grid = {}) {
  const p = buildModelParameters(overrides);
  const { half = OPACITY_GRID.half, pitchPixels = OPACITY_GRID.pitchPixels } =
    grid;
  let sum = 0;
  let count = 0;
  for (let y = -half; y <= half; y++) {
    for (let x = -half; x <= half; x++) {
      sum +=
        1 - Math.exp(-columnOpticalDepth(x * pitchPixels, y * pitchPixels, p));
      count++;
    }
  }
  return sum / count;
}

/**
 * TAIL statistic: the fraction of columns whose alpha exceeds `threshold`.
 *
 * The mean is the wrong proxy for checklist item 6. `probe-cloud-tour.mjs`
 * scores `changedFraction` — the fraction of PIXELS whose OFF/ON channel-sum
 * delta exceeds `CHANGED_PIXEL_THRESHOLD` (18, i.e. ~6 counts per channel), so
 * over a bright background it counts columns above alpha ~0.04. At the tour
 * fixture's coverage the cirrus deck's recorded ground value is 0.0028, i.e.
 * almost every column is BELOW the detection threshold and the gate is scored on
 * the field's upper tail — which is precisely the part of the distribution a
 * variance budget removes. Only the RELATIVE change is transferable: this model
 * marches a nadir column at the direction probe's camera and omits colour, so
 * the absolute fraction here is not comparable with 0.0028.
 *
 * @param {object} [overrides] Passed to {@link buildModelParameters}.
 * @param {number} [threshold] Alpha above which a column counts as "changed".
 * @param {object} [grid] `{half, pitchPixels}`.
 * @returns {number} Exceedance fraction.
 */
export function columnOpacityExceedance(
  overrides = {},
  threshold = 0.04,
  grid = {},
) {
  const p = buildModelParameters(overrides);
  const { half = 20, pitchPixels = OPACITY_GRID.pitchPixels } = grid;
  let hits = 0;
  let count = 0;
  for (let y = -half; y <= half; y++) {
    for (let x = -half; x <= half; x++) {
      const alpha =
        1 - Math.exp(-columnOpticalDepth(x * pitchPixels, y * pitchPixels, p));
      if (alpha > threshold) {
        hits++;
      }
      count++;
    }
  }
  return hits / count;
}

/**
 * U2 — the recommended operating point, and the thing a maintainer signs off.
 *
 * Chosen on MARGIN AGAINST THE MODEL'S OWN VALIDATED BAND, not on balance. The
 * five-lane validation records the model over-reading CIRRUS by 0.054 and pins
 * the thin lanes to 0.1, so a candidate whose predicted elongation is 1.65
 * predicts a MEASURED value of 1.60 with a band that straddles gate C's floor —
 * a coin flip, and not something to spend an Edge run on. This point predicts
 * 1.733, i.e. a residual-corrected 1.679 with the whole +/-0.1 band above 1.6.
 *
 * The balanced point (`baseVarianceBudget` 0.45, `erosionCompensation` 0.667)
 * is cheaper on opacity — +4.8% / -5.8% against this point's +4.4% / -10.2% —
 * and was rejected for exactly that band reason. Both are on the frontier the
 * spec pins; the trade between the two opacity surfaces still runs about 1:1.7.
 *
 * NOT SHIPPED. This is a model record so the numbers a sign-off would rest on
 * are executable rather than transcribed.
 */
export const U2_CANDIDATE = Object.freeze({
  carveBeforeErosion: true,
  baseVarianceBudget: 0.55,
  budgetDownWeight: 0.25,
  erosionCompensation: 0.6,
});

/**
 * The tour fixture's march inputs in the shape {@link buildModelParameters}
 * consumes. Derived from `TOUR_CIRRUS_FIXTURE`, which is itself read from the
 * shipped fixture table.
 */
export const FIXTURE_MARCH_INPUTS = Object.freeze({
  cloudType: CloudType.CIRRUS,
  coverage: TOUR_CIRRUS_FIXTURE.coverage,
  densityMultiplier: TOUR_CIRRUS_FIXTURE.densityMultiplier,
  geometry: TOUR_CIRRUS_FIXTURE.geometry,
});

let BUDGET_BASELINES;
function budgetBaselines() {
  if (BUDGET_BASELINES === undefined) {
    BUDGET_BASELINES = {
      probeBase: meanColumnOpacity({ cloudType: CloudType.CIRRUS }),
      fixtureBase: meanColumnOpacity(FIXTURE_MARCH_INPUTS),
      tailBase: columnOpacityExceedance(FIXTURE_MARCH_INPUTS),
    };
  }
  return BUDGET_BASELINES;
}

/**
 * Score ONE candidate budget against every bar R7 names, in one call.
 *
 * Returns the row of the frontier table: gate C's two numbers, gate E's two
 * ordering steps, gate D's argmax and its margin over the best out-of-window
 * lobe, and the opacity delta at BOTH configurations — the direction probe's
 * (where the gates are scored) and the tour fixture's (where the floor is).
 *
 * @param {object} [overrides] Candidate levers, e.g. `{baseVarianceBudget}`.
 * @param {object} [options] `{scanStepDeg, scan}`; `scan: false` skips gate D's
 *   azimuth scan, which is six times the cost of one lane.
 * @returns {object} The frontier row.
 */
export function scoreBudgetCandidate(overrides = {}, options = {}) {
  const { scanStepDeg = 15, scan = true } = options;
  const elongation = {};
  for (const name of ["CUMULUS", "CIRRUS", "CIRROSTRATUS", "CIRROCUMULUS"]) {
    elongation[name] = screenAnisotropy({
      cloudType: CloudType[name],
      ...overrides,
    }).elongation;
  }
  let argmaxDeg = null;
  let argmaxMargin = null;
  if (scan) {
    const rotated = screenAnisotropy(
      { cloudType: CloudType.CIRRUS, windDirection: [0, 1], ...overrides },
      { alongDeg: 90, scan: true, scanStepDeg },
    );
    const inWindow = (deg) => deg >= 60 && deg <= 120;
    const peak = rotated.scan.find((entry) => entry.deg === 90).length;
    const rival = Math.max(
      ...rotated.scan
        .filter((entry) => !inWindow(entry.deg))
        .map((entry) => entry.length),
    );
    argmaxDeg = rotated.argmaxDeg;
    argmaxMargin = peak / rival;
  }
  const probe = meanColumnOpacity({
    cloudType: CloudType.CIRRUS,
    ...overrides,
  });
  const fixture = meanColumnOpacity({ ...FIXTURE_MARCH_INPUTS, ...overrides });
  const tail = columnOpacityExceedance({
    ...FIXTURE_MARCH_INPUTS,
    ...overrides,
  });
  const { probeBase, fixtureBase, tailBase } = budgetBaselines();
  return {
    elongation,
    cirrus: elongation.CIRRUS,
    cirrusOverCumulus: elongation.CIRRUS / elongation.CUMULUS,
    stepCirrusCirrostratus: elongation.CIRRUS / elongation.CIRROSTRATUS,
    stepCirrostratusCirrocumulus:
      elongation.CIRROSTRATUS / elongation.CIRROCUMULUS,
    argmaxDeg,
    argmaxMargin,
    probeOpacityDelta: (probe - probeBase) / probeBase,
    fixtureOpacityDelta: (fixture - fixtureBase) / fixtureBase,
    fixtureTailDelta: (tail - tailBase) / tailBase,
  };
}

export { CloudType, CloudTypeProfile };
