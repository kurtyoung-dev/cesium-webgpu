/**
 * Cloud quality-tier presets, the single source of truth for the tiered
 * volumetric-cloud architecture. One `quality` dial resolves to one preset
 * struct.
 *
 * The public dial is `collection.volumetric.cloudVolumetricQuality` (`"low" |
 * "medium" | "high" | "auto"`) plus the power-user
 * `collection.volumetric.cloudQuality` escape hatch; this module maps it, and
 * `"auto"`'s altitude bands, to a {@link CloudTierPreset}. Tier 0 is the cheap
 * default: the cloud pass does not run and the WebGL-parity path renders
 * instead. Tiers 1 to 3 are opt-in volumetric — low, high and cinematic.
 *
 * `primarySteps` and `lightSteps` are the LIVE source of the packed step counts
 * (uniform floats 44 and 45), not a mirror of anything. The renderer holds no
 * second resolver of its own, so editing a row here is what moves the image —
 * keep it that way: a duplicated `(24,3)/(48,4)/(96,8)` ladder or a duplicated
 * set of altitude bands elsewhere would silently make this table inert. The
 * higher step counts the research suggests are adopted one feature at a time,
 * each behind its own comparison.
 *
 * This module also owns the derived quality block the renderer packs —
 * {@link buildCloudQualityInputs} and {@link buildCloudQualityBlock} — so every
 * preset-derived uniform has exactly one producer, and so the whole seam can be
 * exercised from Node without a device.
 */

/** Density source — bit 0 of `qualityFlags`. */
export const CloudNoiseSource = Object.freeze({ LIVE: 0, BAKED: 1 });

export interface CloudTierPreset {
  /** 0 = baseline (pass does not run), 1 = low, 2 = high, 3 = cinematic. */
  tier: number;
  primarySteps: number;
  lightSteps: number;
  /**
   * {@link CloudNoiseSource} — `LIVE` keeps the procedural march, `BAKED`
   * samples the 3D textures.
   */
  noiseSource: number;
  /** Cloud-pass render-target scale: 1.0 full, 0.5 half. */
  renderResScale: number;
  temporalEnabled: boolean;
  /** Fraction of pixels refreshed per frame under temporal reprojection. */
  temporalUpdateFraction: number;
  jitterEnabled: boolean;
  /** Light-march sample-count scale relative to the camera budget. */
  lightSampleScale: number;
  /**
   * When true, the light march toward the sun uses six-tap jittered cone
   * sampling — five cone taps plus one long far tap on the cheap
   * `cloudBaseDensity` oracle — instead of the straight N-step march, for
   * roughly half the light-march cost at equal visual quality. Tiers 1 and 2
   * set it; tier 3 and the `cloudQuality` escape hatch keep the straight march.
   *
   * Reference: Andrew Schneider, "Nubis: Authoring Real-Time Volumetric
   * Cloudscapes with the Decima Engine" (SIGGRAPH 2017).
   */
  lightConeSampling: boolean;
  multiScatterOctaves: number;
  powderStrength: number;
  isotropicFloor: number;
  ambientFloor: number;
  /**
   * Per-tier default curl-warp amplitude. Held at 0 on every tier so the
   * default render is unchanged: curl is opted into solely through
   * `globe.cloudCurlAmplitude`, which the renderer packs in place of this
   * value. The field is the slot for a per-tier curl default once the
   * morphology is settled.
   */
  curlAmplitude: number;
}

export interface CloudQualityInputs {
  /** `globe.cloudVolumetricQuality` */
  preset: string | undefined;
  /** `globe.cloudQuality` — power-user escape hatch when ≠ 64. */
  rawCloudQuality: number | undefined;
  cameraHeightMeters: number;
  enableAltitudeMeters: number;
  disableAltitudeMeters: number;
  /**
   * Debug builds only: a {@link CloudRealizationOverride} applied after the
   * tier decision. `undefined` and `null` both mean none. Production builds
   * strip every reader, so a value set here there changes nothing.
   */
  realizationOverride?: CloudRealizationOverride | null;
  /**
   * Drawing-buffer pixels the cloud pass covers at full resolution; the march
   * budget scales it by the preset's `renderResScale`. Absent, the budget
   * costs {@link CLOUD_MARCH_REFERENCE_PIXELS}.
   */
  viewportPixels?: number;
  /**
   * Whether the baked noise volumes are resident this frame. Without them the
   * march samples live noise, so the budget costs an absent or false value as
   * live noise whatever the preset asked for.
   */
  bakedNoiseResident?: boolean;
  /** `cloudMultiDeck`: the march runs once per deck. */
  multiDeck?: boolean;
  /**
   * True when the reduced-resolution target a preset asks for could not
   * allocate and the frame marches every canvas pixel instead, so the budget
   * costs the whole canvas.
   */
  fullResolutionFallback?: boolean;
  /**
   * Whether the frame also encodes the transmittance-mask pass (cloud-aware
   * god rays), which re-runs the primary march over every canvas pixel on the
   * same step counts.
   */
  transmittanceMaskPass?: boolean;
  /**
   * The device's march budget, in the units of {@link cloudMarchCost}. Absent
   * or not a positive finite number, {@link CLOUD_MARCH_BUDGET_DEFAULT} applies.
   */
  marchBudget?: number;
}

/**
 * A measurement dial that varies one axis of the resolved march at a time
 * without leaving the path the public dials chose. The escape hatch cannot do
 * this: any `cloudQuality` other than 64 also swaps the noise source, the
 * jitter and the density domain. Every field is optional, and an absent field
 * leaves its axis as resolved.
 */
export interface CloudRealizationOverride {
  /** Primary march steps; rounded, then clamped to 1..{@link CLOUD_OVERRIDE_MAX_PRIMARY_STEPS}. */
  primarySteps?: number;
  /**
   * Light march steps; rounded, then clamped to 1..{@link CLOUD_OVERRIDE_MAX_LIGHT_STEPS}.
   * This is the uploaded count: the straight light march takes it times
   * `lightSampleScale`, and the cone light march (bit 10, tiers 1 and 2) never
   * reads it.
   */
  lightSteps?: number;
  /** `CLOUD_QF_*` bits to set; only {@link CLOUD_QF_OVERRIDABLE} bits apply. */
  qualityFlagsSet?: number;
  /** `CLOUD_QF_*` bits to clear, applied after the set; same restriction. */
  qualityFlagsClear?: number;
}

/**
 * What a frame was asked to march beside what it marched. The two differ only
 * where a clamp, a restricted bit or an absent resource moved the ask. The
 * realised values are the ones uploaded; how the shader spends the light count
 * is described on {@link CloudRealizationOverride.lightSteps}.
 */
export interface CloudRealizationReport {
  requestedPrimarySteps: number;
  primarySteps: number;
  requestedLightSteps: number;
  lightSteps: number;
  requestedQualityFlags: number;
  qualityFlags: number;
}

/**
 * The caps keep the override from raising the per-pixel workload above the
 * larger of 128 × 8 and what the dials already resolved. On the tier path that
 * bound is 128 × 8, a third above the cinematic tier's 96 × 8; on the escape
 * hatch an override of one count keeps the other's raw-derived value. The caps
 * are per pixel and blind to the noise source, so they are not what keeps a
 * frame finishable: the march budget is, and it applies after them.
 */
export const CLOUD_OVERRIDE_MAX_PRIMARY_STEPS = 128;
export const CLOUD_OVERRIDE_MAX_LIGHT_STEPS = 8;

/**
 * Tier table, and the only source: `primarySteps`, `lightSteps` and
 * `lightSampleScale` are read straight into the packed uniforms, so editing a
 * row here moves the image. The lighting fields `powderStrength`,
 * `isotropicFloor` and `ambientFloor` reach uniform floats 172-174; they are
 * carried but unread until the shader's lighting consumer lands.
 *
 * Those three are deliberately IDENTICAL on every tier — powder 0.5, both floors
 * 0 — which is the shader's pre-wiring behaviour exactly. Aspirational per-tier
 * values (powder 0/0/0.4/0.7, floors up to 0.04 and 0.08) are safe only while
 * nothing reads them: adopting them at the moment the consumer lands would
 * retune the image inside a plumbing change, and the tier-0 and tier-1 zeros
 * would delete the powder term outright. Per-tier tuning is its own tracked
 * follow-up, gated on a capture.
 */
export const CLOUD_TIER_PRESETS: CloudTierPreset[] = [
  // Tier 0, baseline: the cloud pass does not run. Present for completeness.
  {
    tier: 0,
    primarySteps: 0,
    lightSteps: 0,
    noiseSource: CloudNoiseSource.LIVE,
    renderResScale: 1.0,
    temporalEnabled: false,
    temporalUpdateFraction: 0,
    jitterEnabled: false,
    lightSampleScale: 1.0,
    lightConeSampling: false,
    multiScatterOctaves: 0,
    // Pinned to the pre-wiring literal until the per-tier values are tuned
    // against a capture. The shader reads these three floats for the first time
    // once its lighting consumer lands, so any value other than the old
    // hard-coded powder 0.5 / zero floors would retune the image here.
    powderStrength: 0.5,
    isotropicFloor: 0,
    ambientFloor: 0,
    curlAmplitude: 0,
  },
  // Tier 1, volumetric low.
  {
    tier: 1,
    primarySteps: 24,
    lightSteps: 3,
    noiseSource: CloudNoiseSource.BAKED,
    renderResScale: 0.5,
    temporalEnabled: true,
    temporalUpdateFraction: 1 / 16,
    jitterEnabled: true,
    lightSampleScale: 0.5,
    lightConeSampling: true,
    multiScatterOctaves: 2,
    // Pinned to the pre-wiring literal until the per-tier values are tuned
    // against a capture. The shader reads these three floats for the first time
    // once its lighting consumer lands, so any value other than the old
    // hard-coded powder 0.5 / zero floors would retune the image here.
    powderStrength: 0.5,
    isotropicFloor: 0,
    ambientFloor: 0,
    curlAmplitude: 0,
  },
  // Tier 2, volumetric high.
  {
    tier: 2,
    primarySteps: 48,
    lightSteps: 4,
    noiseSource: CloudNoiseSource.BAKED,
    renderResScale: 0.5,
    temporalEnabled: true,
    temporalUpdateFraction: 1 / 8,
    jitterEnabled: true,
    lightSampleScale: 0.5,
    lightConeSampling: true,
    multiScatterOctaves: 3,
    // Pinned to the pre-wiring literal until the per-tier values are tuned
    // against a capture. The shader reads these three floats for the first time
    // once its lighting consumer lands, so any value other than the old
    // hard-coded powder 0.5 / zero floors would retune the image here.
    powderStrength: 0.5,
    isotropicFloor: 0,
    ambientFloor: 0,
    // Held at 0; curl is opted into through globe.cloudCurlAmplitude.
    curlAmplitude: 0,
  },
  // Tier 3, cinematic.
  {
    tier: 3,
    primarySteps: 96,
    lightSteps: 8,
    noiseSource: CloudNoiseSource.BAKED,
    renderResScale: 1.0,
    temporalEnabled: false,
    temporalUpdateFraction: 0,
    jitterEnabled: true,
    lightSampleScale: 1.0,
    // Cinematic keeps the straight N-step light march for full quality.
    lightConeSampling: false,
    multiScatterOctaves: 3,
    // Pinned to the pre-wiring literal until the per-tier values are tuned
    // against a capture. The shader reads these three floats for the first time
    // once its lighting consumer lands, so any value other than the old
    // hard-coded powder 0.5 / zero floors would retune the image here.
    powderStrength: 0.5,
    isotropicFloor: 0,
    ambientFloor: 0,
    // Held at 0; curl is opted into through globe.cloudCurlAmplitude.
    curlAmplitude: 0,
  },
];

/** Map the dial (+ "auto" altitude bands) to a tier index 1–3. */
function resolveTier(inputs: CloudQualityInputs): number {
  const preset = inputs.preset ?? "auto";
  if (preset === "low") return 1;
  if (preset === "medium") return 2;
  if (preset === "high") return 3;
  // auto / unknown → altitude bands. This is the ONLY spelling of the bands:
  // far = low, near = high, between = medium.
  if (inputs.cameraHeightMeters >= inputs.disableAltitudeMeters) return 1;
  if (inputs.cameraHeightMeters <= inputs.enableAltitudeMeters) return 3;
  return 2;
}

/**
 * Resolve the active {@link CloudTierPreset}. Under the power-user escape
 * hatch (`cloudQuality !== 64`) the result is the live-noise,
 * no-reconstruction, neutral-dials path with the caller's hand-tuned step count
 * and a light-step count derived from it, which bypasses the reconstruction
 * stack. The `6 * sqrt(raw / 64)` light-step arithmetic carried over from the
 * deleted `resolveCloudQuality` unchanged and now lives here only.
 *
 * Whatever the dials and the realization override ask for, the result is held
 * to the march budget last (see {@link cloudMarchCost}): an ask inside it is
 * returned unchanged, and one outside it loses primary steps, then light
 * steps, and nothing else. {@link describeCloudMarchBudget} reports the ask.
 */
export function resolveCloudPreset(
  inputs: CloudQualityInputs,
): CloudTierPreset {
  return applyCloudMarchBudget(resolveAskedPreset(inputs), inputs);
}

/** The preset the dials and any realization override ask for. */
function resolveAskedPreset(inputs: CloudQualityInputs): CloudTierPreset {
  const preset = resolveDialPreset(inputs);
  //>>includeStart('debug', pragmas.debug);
  // The override resolves here, after the tier or escape decision, so it moves
  // only the step counts of the path the dials chose: the noise source, the
  // density domain and every other field stay as resolved.
  const override = inputs.realizationOverride;
  if (override !== undefined && override !== null) {
    return {
      ...preset,
      primarySteps: overrideSteps(
        override.primarySteps,
        preset.primarySteps,
        CLOUD_OVERRIDE_MAX_PRIMARY_STEPS,
      ),
      lightSteps: overrideSteps(
        override.lightSteps,
        preset.lightSteps,
        CLOUD_OVERRIDE_MAX_LIGHT_STEPS,
      ),
    };
  }
  //>>includeEnd('debug');
  return preset;
}

/** The preset the public dials select, before any realization override. */
function resolveDialPreset(inputs: CloudQualityInputs): CloudTierPreset {
  const raw = inputs.rawCloudQuality;
  if (typeof raw === "number" && raw !== 64) {
    const lightSteps = Math.max(2, Math.round(6 * Math.sqrt(raw / 64)));
    return {
      tier: 1,
      primarySteps: raw,
      lightSteps,
      noiseSource: CloudNoiseSource.LIVE,
      renderResScale: 1.0,
      temporalEnabled: false,
      temporalUpdateFraction: 0,
      jitterEnabled: false,
      lightSampleScale: 1.0,
      // The escape hatch keeps the straight light march.
      lightConeSampling: false,
      multiScatterOctaves: 3,
      // Pinned to the pre-wiring literal until the per-tier values are tuned
      // against a capture. The shader reads these three floats for the first time
      // once its lighting consumer lands, so any value other than the old
      // hard-coded powder 0.5 / zero floors would retune the image here.
      powderStrength: 0.5,
      isotropicFloor: 0,
      ambientFloor: 0,
      curlAmplitude: 0,
    };
  }
  return CLOUD_TIER_PRESETS[resolveTier(inputs)];
}

// `qualityFlags`@74 bit layout (read by WGSL via `u32(cloud.qualityFlags)`).
// Bits may be added but never renumbered: the WGSL mirrors these positions.
export const CLOUD_QF_NOISE_BAKED = 1 << 0;
export const CLOUD_QF_HALF_RES = 1 << 1;
export const CLOUD_QF_TEMPORAL = 1 << 2;
export const CLOUD_QF_JITTER = 1 << 3; // per-pixel ray sample phase
export const CLOUD_QF_OCTAVES_SHIFT = 4; // bits 4-6
export const CLOUD_QF_PROFILE_ON = 1 << 7;
// Atmosphere-LUT coupling. Bit 9 is set only when `cloudAmbientSource` is
// opted into, and the default render leaves it clear. Bit 8 is not that shape:
// the renderer also sets it for an UNSET `cloudAerialMode` — undeclared, or the
// public `"auto"` default — once `shouldDefaultPhysicalAerial` fires, which is
// at or above the band edge. A default render above that edge therefore carries
// bit 8, by intent.
export const CLOUD_QF_AERIAL_LUT = 1 << 8; // physical aerial: sky-view + transmittance
export const CLOUD_QF_AMBIENT_LUT = 1 << 9; // sky-LUT cloud ambient
// Set by the renderer only when the resolved tier's `lightConeSampling` is
// true, which is tiers 1 and 2. Tier 3 and the escape hatch leave it clear, and
// the WGSL then takes the straight light march.
export const CLOUD_QF_LIGHT_CONE = 1 << 10; // cone-sampled light march
// Set by the renderer only when globe.cloudMultiDeck is opted into. Left clear,
// the WGSL marches exactly one shell with cloudLayerBottom/Top and the single-
// shell composite.
export const CLOUD_QF_MULTI_DECK = 1 << 11; // multi-deck shell march
// Camera-relative high-precision march, on by default; an explicit
// cloudHighPrecision=false leaves it clear for the single-precision path.
export const CLOUD_QF_HIGH_PRECISION = 1 << 12;
// Planet-anchored, camera-relative baked-density domain. Set only when the
// baked noise resource is realized; the live-noise fallback keeps its own
// coordinate path. This is an internal rollout bit, not a public quality or
// appearance toggle.
export const CLOUD_QF_PLANET_DENSITY = 1 << 13;

// ── The realization override ────────────────────────────────────────────────

/**
 * The bits the override may set or clear: the march-realization axes. Bits 1
 * and 2 describe which passes run, and bits 8, 9 and 11 select resources their
 * own modes allocate, so flipping any of them would desynchronise the shader
 * from the frame rather than vary the march; the octave field is a count, not
 * a flag, and bit 7 has no reader.
 */
export const CLOUD_QF_OVERRIDABLE =
  CLOUD_QF_NOISE_BAKED |
  CLOUD_QF_JITTER |
  CLOUD_QF_LIGHT_CONE |
  CLOUD_QF_HIGH_PRECISION |
  CLOUD_QF_PLANET_DENSITY;

/**
 * Bits whose SET needs the baked noise volumes resident. Setting them on a
 * frame without the bake would sample textures that were never filled, so the
 * set is refused there and the report shows it.
 */
const CLOUD_QF_NEEDS_BAKED_NOISE =
  CLOUD_QF_NOISE_BAKED | CLOUD_QF_PLANET_DENSITY;

function overrideSteps(
  asked: number | undefined,
  resolved: number,
  max: number,
): number {
  if (asked === undefined || !Number.isFinite(asked)) {
    return resolved;
  }
  const steps = Math.round(asked);
  return steps < 1 ? resolved : Math.min(max, steps);
}

function flagMask(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value >>> 0 : 0;
}

/**
 * Apply a realization override's flag half to a frame's fully assembled
 * `qualityFlags` word, and report the ask beside the result.
 *
 * `preset` is the already-overridden preset from {@link resolveCloudPreset},
 * so its step counts are the realised ones. `qualityFlags` must be the final
 * word, after every renderer-side fold: the override is the last writer, which
 * is what lets clearing bit 0 leave bit 13 exactly as it was.
 *
 * @param preset The resolved preset.
 * @param qualityFlags The frame's final `qualityFlags` word before the override.
 * @param override The override to apply.
 * @param bakedNoiseResident Whether the baked noise volumes are resident.
 * @param asked The preset before the march budget, whose step counts are the
 * ask when the override names none; the resolved preset when omitted.
 * @returns {CloudRealizationReport}
 */
export function resolveCloudRealization(
  preset: CloudTierPreset,
  qualityFlags: number,
  override: CloudRealizationOverride,
  bakedNoiseResident: boolean,
  asked: CloudTierPreset = preset,
): CloudRealizationReport {
  const base = qualityFlags >>> 0;
  const askedSet = flagMask(override.qualityFlagsSet);
  const askedClear = flagMask(override.qualityFlagsClear);
  let realised = base;
  if (askedSet !== 0 || askedClear !== 0) {
    const settable = bakedNoiseResident
      ? CLOUD_QF_OVERRIDABLE
      : CLOUD_QF_OVERRIDABLE & ~CLOUD_QF_NEEDS_BAKED_NOISE;
    realised =
      ((base | (askedSet & settable)) &
        ~(askedClear & CLOUD_QF_OVERRIDABLE)) >>>
      0;
  }
  return {
    requestedPrimarySteps: override.primarySteps ?? asked.primarySteps,
    primarySteps: preset.primarySteps,
    requestedLightSteps: override.lightSteps ?? asked.lightSteps,
    lightSteps: preset.lightSteps,
    requestedQualityFlags: ((base | askedSet) & ~askedClear) >>> 0,
    qualityFlags: realised,
  };
}

// ── The march budget ────────────────────────────────────────────────────────
//
// A frame's march cost is
//
//   marchPixels × marches × 3·trunc(primarySteps) × lightTaps × noiseWeight
//
// where `marchPixels` is the viewport scaled by the preset's `renderResScale`
// (the whole viewport when that target fell back), plus the whole viewport
// again when the transmittance-mask pass re-runs the march; `marches` is 3 on
// the multi-deck march and 1 otherwise; `3·steps` is the march loop's sentinel
// (the most intervals one ray can take, coarse skips and fine steps together);
// `lightTaps` is what the light march takes per interval (six on the cone
// march, otherwise the shader's own `max(1, trunc(lightSteps ×
// lightSampleScale))`); and `noiseWeight` is 1 for resident baked noise and 2
// for live noise. Counts are read as the shader reads them, after the f32
// upload. Jitter, erosion and the density domain are not costed, because no
// measurement separates them. Whether the compiler drops the mask pass's unused
// light march is unmeasured, so that pass is costed as a full march.
//
// Costing light taps as a product with the steps under-costs an interval's own
// density sample when the ask has few taps, so a budgeted frame also runs no
// more primary steps than the most a frame has been measured to finish.
//
// The budget is deliberately a cost ceiling, not a clamp on any one dial: the
// same step count is safe or not depending on the canvas and the noise source.

/** Intervals per primary step: the march loop's `steps * 3` sentinel. */
export const CLOUD_MARCH_INTERVALS_PER_STEP = 3;
/** Shells the multi-deck march runs, each on the full primary step count. */
export const CLOUD_MULTI_DECK_MARCHES = 3;
/** Light taps the cone march takes per interval, whatever `lightSteps` says. */
export const CLOUD_LIGHT_CONE_TAPS = 6;
/** The viewport costed when the caller names none: the renderer's fallback. */
export const CLOUD_MARCH_REFERENCE_PIXELS = 1920 * 1080;
/**
 * The most primary steps a budgeted frame runs: the largest count measured to
 * complete on the measured device (raw `cloudQuality` 128 on a 2048² canvas).
 * An ask inside the budget is not held to it.
 */
export const CLOUD_MARCH_MAX_FITTED_PRIMARY_STEPS = 128;

/**
 * Cost of a live-noise interval relative to a baked one. On the measured
 * device the cinematic 96 × 8 march on a 2048² canvas completed with baked
 * noise and hung the GPU with live noise, every other flag and count equal, so
 * the noise source alone decides between the two. The weight and
 * {@link CLOUD_MARCH_BUDGET_DEFAULT} are chosen together so the two frames sit
 * on either side of the budget with the same margin; 2 is the smallest integer
 * weight that gives each a margin of at least 1.39. It is a margin, not a
 * measured cost ratio.
 */
export const CLOUD_MARCH_LIVE_NOISE_WEIGHT = 2;

/**
 * The default march budget, in the units of {@link cloudMarchCost}, for a
 * device with no measured budget of its own. The completed baked frame above
 * costs 9.66e9 and the hung live-noise one 1.93e10; the budget is their
 * geometric mean rounded down, 1.35e10. Raw `cloudQuality` 256 at 2048², which
 * also hung, costs 7.7e10. At 1080p the cinematic tier fits with live noise as
 * well as baked. Its baked march fits up to 5,859,375 canvas pixels and is
 * reduced above that (3840 × 2160 runs 67 steps), because no baked frame above
 * the completed one has been measured.
 */
export const CLOUD_MARCH_BUDGET_DEFAULT = 1.35e10;

/**
 * What the march budget did to a frame: the ask, whether a step count moved,
 * and the cost of each side. {@link describeCloudMarchBudget} produces it.
 */
export interface CloudMarchBudgetReport {
  /** The preset the dials and any realization override asked for. */
  asked: CloudTierPreset;
  /** True when the budget moved a step count of the ask. */
  budgetApplied: boolean;
  /** The budget the frame was held to. */
  budget: number;
  /** Cost of the ask; `Infinity` when its primary count has no finite bound. */
  requestedCost: number;
  /** Cost of the resolved preset. */
  cost: number;
}

/**
 * The most intervals one ray's march can take for a primary step count. The
 * shader truncates the uploaded f32 count to an integer, and a count at or
 * below zero never enters the loop.
 *
 * @param primarySteps The uploaded primary step count.
 * @param multiDeck Whether the multi-deck march runs.
 * @returns {number} `Infinity` when the count has no finite bound.
 */
export function cloudMarchIntervals(
  primarySteps: number,
  multiDeck: boolean | undefined,
): number {
  // The f32 upload can round a fraction just below an integer up to it.
  const steps = Math.trunc(Math.fround(primarySteps));
  if (Number.isNaN(steps) || steps === Infinity) {
    return Infinity;
  }
  if (steps <= 0) {
    return 0;
  }
  const marches = multiDeck === true ? CLOUD_MULTI_DECK_MARCHES : 1;
  return marches * CLOUD_MARCH_INTERVALS_PER_STEP * steps;
}

/** Whether a frame's light march is the cone march, as the frame will run it. */
function cloudMarchUsesCone(
  preset: CloudTierPreset,
  inputs: CloudQualityInputs,
): boolean {
  let cone = preset.lightConeSampling;
  //>>includeStart('debug', pragmas.debug);
  const flags = inputs.realizationOverride;
  if (flags !== undefined && flags !== null) {
    cone =
      (cone || (flagMask(flags.qualityFlagsSet) & CLOUD_QF_LIGHT_CONE) !== 0) &&
      (flagMask(flags.qualityFlagsClear) & CLOUD_QF_LIGHT_CONE) === 0;
  }
  //>>includeEnd('debug');
  return cone;
}

/** Light taps per interval: the cone's fixed count, or the straight march's. */
function cloudLightTaps(preset: CloudTierPreset, cone: boolean): number {
  if (cone) {
    return CLOUD_LIGHT_CONE_TAPS;
  }
  // Both factors are uploaded as f32 and multiplied in f32.
  const taps = Math.trunc(
    Math.fround(
      Math.fround(preset.lightSteps) * Math.fround(preset.lightSampleScale),
    ),
  );
  return Number.isFinite(taps) ? Math.max(1, taps) : Infinity;
}

/** Marched pixels times the noise weight the frame will run with. */
function cloudMarchPixelCost(
  preset: CloudTierPreset,
  inputs: CloudQualityInputs,
): number {
  const viewport = inputs.viewportPixels;
  const pixels =
    typeof viewport === "number" && Number.isFinite(viewport) && viewport >= 0
      ? viewport
      : CLOUD_MARCH_REFERENCE_PIXELS;
  const scale = preset.renderResScale;
  const reduced =
    scale > 0 && scale < 1 && inputs.fullResolutionFallback !== true;
  const mask = inputs.transmittanceMaskPass === true ? pixels : 0;
  const marched = (reduced ? pixels * scale * scale : pixels) + mask;
  const resident = inputs.bakedNoiseResident === true;
  let baked = preset.noiseSource === CloudNoiseSource.BAKED && resident;
  //>>includeStart('debug', pragmas.debug);
  // Bit 0 as the override leaves it: a set needs the bake, and a clear wins.
  const flags = inputs.realizationOverride;
  if (flags !== undefined && flags !== null) {
    const set = flagMask(flags.qualityFlagsSet);
    const clear = flagMask(flags.qualityFlagsClear);
    baked =
      (baked || ((set & CLOUD_QF_NOISE_BAKED) !== 0 && resident)) &&
      (clear & CLOUD_QF_NOISE_BAKED) === 0;
  }
  //>>includeEnd('debug');
  const weight = baked ? 1 : CLOUD_MARCH_LIVE_NOISE_WEIGHT;
  return marched * weight;
}

/**
 * The march cost of a preset under a frame's inputs; the formula heads this
 * section.
 *
 * @param preset The preset to cost.
 * @param inputs The frame's resolver inputs.
 * @returns {number} `Infinity` when the primary count has no finite bound.
 */
export function cloudMarchCost(
  preset: CloudTierPreset,
  inputs: CloudQualityInputs,
): number {
  const intervals = cloudMarchIntervals(preset.primarySteps, inputs.multiDeck);
  const pixelCost = cloudMarchPixelCost(preset, inputs);
  if (intervals === 0 || pixelCost === 0) {
    return 0;
  }
  const taps = cloudLightTaps(preset, cloudMarchUsesCone(preset, inputs));
  return intervals * taps * pixelCost;
}

function cloudMarchBudgetOf(inputs: CloudQualityInputs): number {
  const budget = inputs.marchBudget;
  return typeof budget === "number" && Number.isFinite(budget) && budget > 0
    ? budget
    : CLOUD_MARCH_BUDGET_DEFAULT;
}

/**
 * Hold an asked preset to the march budget: the ask itself when it fits, or
 * the fitted preset when it does not. {@link resolveCloudPreset} applies it to
 * what the dials ask for; the renderer applies it again, to the same ask, when
 * a resource gate changes what the frame marches.
 *
 * @param asked The preset the dials and any realization override asked for.
 * @param inputs The frame's resolver inputs.
 * @returns {CloudTierPreset}
 */
export function applyCloudMarchBudget(
  asked: CloudTierPreset,
  inputs: CloudQualityInputs,
): CloudTierPreset {
  const budget = cloudMarchBudgetOf(inputs);
  // NaN compares false, so an ask with no finite bound is over budget too.
  const overBudget = !(cloudMarchCost(asked, inputs) <= budget);
  if (overBudget) {
    return fitCloudMarchBudget(asked, inputs, budget);
  }
  return asked;
}

/** The count the shader runs for an uploaded one, or the floor when unbounded. */
function boundedStepCount(steps: number): number {
  const uploaded = Math.fround(steps);
  return Number.isFinite(uploaded) ? steps : 1;
}

/**
 * The largest primary step count that fits at the asked light count, no more
 * than the ask and no more than {@link CLOUD_MARCH_MAX_FITTED_PRIMARY_STEPS},
 * and only when not even one fits, the largest light count at one primary
 * step. A count with no finite bound resolves to the floor of one step rather
 * than to whatever the budget could afford. The noise source, the flags and
 * every other field stay as asked. The floor is one step of each.
 */
function fitCloudMarchBudget(
  asked: CloudTierPreset,
  inputs: CloudQualityInputs,
  budget: number,
): CloudTierPreset {
  // Positive here: a frame with no marched pixels costs nothing and is never
  // over budget.
  const perStep =
    cloudMarchIntervals(1, inputs.multiDeck) *
    cloudMarchPixelCost(asked, inputs);
  const cone = cloudMarchUsesCone(asked, inputs);
  const askedLight = boundedStepCount(asked.lightSteps);
  const taps = cloudLightTaps({ ...asked, lightSteps: askedLight }, cone);
  let primarySteps = Math.min(
    Math.trunc(Math.fround(boundedStepCount(asked.primarySteps))),
    Math.floor(budget / (perStep * taps)),
    CLOUD_MARCH_MAX_FITTED_PRIMARY_STEPS,
  );
  // The quotient can round up across an integer; step back if it did.
  if (primarySteps * perStep * taps > budget) {
    primarySteps -= 1;
  }
  if (primarySteps >= 1) {
    return { ...asked, primarySteps, lightSteps: askedLight };
  }
  let lightSteps = askedLight;
  if (!cone) {
    const tapsFit = Math.max(1, Math.floor(budget / perStep));
    const scale = asked.lightSampleScale;
    const fit = scale > 0 ? Math.max(1, Math.floor(tapsFit / scale)) : 1;
    if (!(lightSteps <= fit)) {
      lightSteps = fit;
    }
  }
  return { ...asked, primarySteps: 1, lightSteps };
}

/**
 * Report the march budget beside the preset {@link resolveCloudPreset}
 * resolved from the same inputs: the ask, whether the budget moved it, and
 * the cost of each.
 *
 * @param inputs The frame's resolver inputs.
 * @param preset The preset {@link resolveCloudPreset} returned for `inputs`.
 * @returns {CloudMarchBudgetReport}
 */
export function describeCloudMarchBudget(
  inputs: CloudQualityInputs,
  preset: CloudTierPreset,
): CloudMarchBudgetReport {
  const asked = resolveAskedPreset(inputs);
  return {
    asked,
    budgetApplied:
      !Object.is(asked.primarySteps, preset.primarySteps) ||
      !Object.is(asked.lightSteps, preset.lightSteps),
    budget: cloudMarchBudgetOf(inputs),
    requestedCost: cloudMarchCost(asked, inputs),
    cost: cloudMarchCost(preset, inputs),
  };
}

// ── The derived quality block ───────────────────────────────────────────────
//
// Everything below lives here rather than in `WebGPUProceduralCloudRenderer.ts`
// (that file is over 5,000 lines; the house rule asks for a decomposition slice
// whenever such a file is functionally touched). It is the whole
// preset → packed-uniform seam: pure, device-free, and therefore assertable
// from Node. The renderer keeps the packing loop and writes these values into
// the `CloudUniforms` floats named in each field's doc comment.

/**
 * The subset of the cloud configuration object the resolver reads. Declared
 * structurally rather than by importing `Globe` or `CloudVolumetrics`, because
 * the renderer is handed a duck-typed config and this module must stay
 * backend-neutral and importable without the engine's scene graph.
 */
export interface CloudQualityConfigLike {
  cloudVolumetricQuality?: string;
  cloudQuality?: number;
  cloudErosionStrength?: number;
  cloudAerialMode?: string;
  atmosphericConditions?: {
    clouds?: {
      volumetricEnableAltitude?: number;
      volumetricDisableAltitude?: number;
    };
  };
}

/** `"auto"` enable-altitude default in metres, when the scene declares none. */
export const CLOUD_AUTO_ENABLE_ALTITUDE_METERS = 50_000;
/** `"auto"` disable-altitude default in metres, when the scene declares none. */
export const CLOUD_AUTO_DISABLE_ALTITUDE_METERS = 100_000;

/**
 * Gather the resolver's inputs from the frame's config and camera height. The
 * altitude defaults are the ones `AtmosphericConditions` publishes; a scene
 * that declares its own bands overrides them.
 *
 * @param config The duck-typed cloud configuration for this frame.
 * @param cameraHeightMeters CPU-f64 geodetic camera height, in metres.
 * @returns {CloudQualityInputs}
 */
export function buildCloudQualityInputs(
  config: CloudQualityConfigLike,
  cameraHeightMeters: number,
): CloudQualityInputs {
  const clouds = config.atmosphericConditions?.clouds;
  return {
    preset: config.cloudVolumetricQuality,
    rawCloudQuality: config.cloudQuality,
    cameraHeightMeters,
    enableAltitudeMeters:
      clouds?.volumetricEnableAltitude ?? CLOUD_AUTO_ENABLE_ALTITUDE_METERS,
    disableAltitudeMeters:
      clouds?.volumetricDisableAltitude ?? CLOUD_AUTO_DISABLE_ALTITUDE_METERS,
  };
}

/**
 * Whether the physical aerial LUT path is the DEFAULT for this frame, absent an
 * explicit `cloudAerialMode` — the dial either undeclared or left at the public
 * `"auto"` default, which are one state.
 *
 * Why the promotion exists: the heuristic aerial term is
 * `clamp(midDist / 60000, 0, 0.85)`, and above the band edge every pixel
 * is far past 60 km, so the heuristic is pinned at its 0.85 cap for the whole
 * frame — a flat haze wash instead of a range-correct path length. The sky-view
 * and transmittance LUTs give the correct term there, so they are the default.
 *
 * The band edge is `disableAltitudeMeters`, the same threshold `resolveTier`
 * uses, so the two cannot disagree about where "orbital" starts.
 *
 * This predicate keys on ALTITUDE ONLY, deliberately. An earlier form also
 * required a spatial tier of 2 or more; that inverts the pairing the campaign
 * plan's §2.3 asks for — a camera at 300 km should run cheap pixels with correct
 * physics, not the reverse — and under `"auto"` it was unreachable, because the
 * auto bands map "at or above the disable altitude" to tier 1. Lighting fidelity
 * is the L axis, which does not exist yet; whoever lands the S×L ladder maps this
 * predicate onto L, and this is the one function they have to change.
 *
 * This predicate is deliberately VISIBLE above the band edge: an `"auto"` frame
 * that asked for no mode takes the LUT path rather than the heuristic one.
 *
 * @param inputs The resolver inputs for this frame.
 * @returns {boolean} True when the physical path is the default.
 */
export function shouldDefaultPhysicalAerial(
  inputs: CloudQualityInputs,
): boolean {
  return inputs.cameraHeightMeters >= inputs.disableAltitudeMeters;
}

/**
 * Per-frame facts the tier cannot know: whether the resources its preset asked
 * for actually allocated, plus the caller's explicit overrides.
 */
export interface CloudQualityRuntime {
  /** The baked noise volumes are resident AND their bake succeeded. */
  bakedNoiseResident: boolean;
  /** The half-resolution target and pipelines allocated and are running. */
  halfResActive: boolean;
  /** Temporal history allocated and reprojection is running this frame. */
  temporalActive: boolean;
  /** `config.cloudErosionStrength`, when the user set one. */
  erosionStrengthOverride: number | undefined;
}

/**
 * Every preset-derived value the renderer packs, with the `CloudUniforms` float
 * each one lands in. One producer per field: nothing here is recomputed at the
 * packing site.
 */
export interface CloudQualityBlock {
  /** The resolved preset the rest of the block derives from. */
  preset: CloudTierPreset;
  /** Uniform float 44 — primary ray-march step budget. */
  maxSteps: number;
  /** Uniform float 45 — light-march step budget. */
  lightSteps: number;
  /** Uniform float 74 — the `CLOUD_QF_*` bitfield. */
  qualityFlags: number;
  /** Uniform float 78 — light-march step-count and cone-radius scale. */
  lightSampleScale: number;
  /** Uniform float 79 — mean-preserving erosion floor. */
  erosionStrength: number;
  /** Uniform float 172 — multi-scatter powder term; shader consumer owed. */
  powderStrength: number;
  /** Uniform float 173 — isotropic scattering floor; shader consumer owed. */
  isotropicFloor: number;
  /** Uniform float 174 — ambient floor; shader consumer owed. */
  ambientFloor: number;
}

/**
 * Derive every uniform value that follows from the resolved preset. Takes the
 * preset rather than the inputs because the caller needs it earlier — the
 * half-resolution and temporal gates read `renderResScale` and
 * `temporalEnabled` to decide the runtime facts this function then consumes —
 * and resolving twice would reintroduce a second producer.
 *
 * @param preset The resolved preset, from {@link resolveCloudPreset}.
 * @param runtime This frame's allocation outcomes and explicit overrides.
 * @returns {CloudQualityBlock}
 */
export function buildCloudQualityBlock(
  preset: CloudTierPreset,
  runtime: CloudQualityRuntime,
): CloudQualityBlock {
  // Bit 0 selects the baked 3D-texture core, and it is set only when the tier
  // asks for it and the bake succeeded; with no baked noise resident the bit
  // stays clear and the shader marches live noise instead.
  const noiseBakedBit =
    preset.noiseSource === CloudNoiseSource.BAKED && runtime.bakedNoiseResident
      ? CLOUD_QF_NOISE_BAKED
      : 0;
  // Bit 1 marks the half-resolution path and is set only when that path is
  // actually running, meaning the tier asked for it and the target and
  // pipelines allocated. The shader keys its premultiplied-emit and jitter
  // branch on this bit, and the full-resolution tiers leave it clear.
  const halfResBit = runtime.halfResActive ? CLOUD_QF_HALF_RES : 0;
  // Bit 2 marks active temporal accumulation. The march emits identically
  // either way, since temporal adds a separate resolve pass rather than a march
  // branch; the bit exists so the flags stay consistent with the tier presets
  // and with what any reader of the field would expect.
  const temporalBit = runtime.temporalActive ? CLOUD_QF_TEMPORAL : 0;
  // Bit 3 carries the tier's jitter contract: the lower tiers animate the
  // per-pixel interleaved-gradient-noise phase only while temporal accumulation
  // is active, the cinematic tier gets deterministic frame-zero spatial noise,
  // and the hand-tuned escape preset leaves jitter off and keeps exact midpoint
  // sampling.
  const jitterBit = preset.jitterEnabled ? CLOUD_QF_JITTER : 0;
  // Bit 10 selects the cone-sampled light march, which the lower tiers use. The
  // cinematic tier and the escape hatch leave it clear and take the straight
  // light march.
  const lightConeBit = preset.lightConeSampling ? CLOUD_QF_LIGHT_CONE : 0;

  return {
    preset,
    maxSteps: preset.primarySteps,
    lightSteps: preset.lightSteps,
    qualityFlags:
      noiseBakedBit |
      halfResBit |
      temporalBit |
      jitterBit |
      lightConeBit |
      ((Math.min(7, preset.multiScatterOctaves) & 7) << CLOUD_QF_OCTAVES_SHIFT),
    lightSampleScale: preset.lightSampleScale,
    // An explicit override wins; otherwise the tier decides, low tiers being
    // fibrous at 0.10 and the higher tiers puffy at 0.18.
    erosionStrength:
      runtime.erosionStrengthOverride ?? (preset.tier <= 1 ? 0.1 : 0.18),
    powderStrength: preset.powderStrength,
    isotropicFloor: preset.isotropicFloor,
    ambientFloor: preset.ambientFloor,
  };
}
