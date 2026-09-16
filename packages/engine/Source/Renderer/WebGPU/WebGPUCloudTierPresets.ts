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
 * (uniform floats 44 and 45), not a mirror of anything. `C13-N10` deleted the
 * renderer's second resolver, whose duplicated `(24,3)/(48,4)/(96,8)` literals
 * and duplicated altitude bands meant that editing this table moved no pixel.
 * The values carried across unchanged, so the collapse is byte-identical; the
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
}

/**
 * Tier table, the single source of truth — and, since `C13-N10`, the only
 * source: `primarySteps`, `lightSteps` and `lightSampleScale` are read straight
 * into the packed uniforms, so editing a row here moves the image. The lighting
 * fields `powderStrength`, `isotropicFloor` and `ambientFloor` reach uniform
 * floats 172-174; their shader consumer lands with `C13-N11`, so until then they
 * are carried but unread.
 *
 * Those three are deliberately IDENTICAL on every tier — powder 0.5, both floors
 * 0 — which is the shader's pre-wiring behaviour exactly. They previously carried
 * aspirational per-tier values (powder 0/0/0.4/0.7, floors up to 0.04 and 0.08)
 * that were safe only while nothing read them. Wiring them and keeping those
 * values would retune the image inside a plumbing batch, and the tier-0 and
 * tier-1 zeros would delete the powder term outright. Per-tier tuning is its own
 * row with an Edge capture; see `DEFERRED_WORK.md` under `C13-N11`.
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
    // [2026-09-13, C13-N10] Pinned to the pre-wiring literal; per-tier tuning is
    // a follow-up row with an Edge capture. C13-N11 makes these three floats LIVE
    // for the first time, so any value other than the shader's old hard-coded
    // powder 0.5 / zero floors would retune the image inside a plumbing batch.
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
    // [2026-09-13, C13-N10] Pinned to the pre-wiring literal; per-tier tuning is
    // a follow-up row with an Edge capture. C13-N11 makes these three floats LIVE
    // for the first time, so any value other than the shader's old hard-coded
    // powder 0.5 / zero floors would retune the image inside a plumbing batch.
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
    // [2026-09-13, C13-N10] Pinned to the pre-wiring literal; per-tier tuning is
    // a follow-up row with an Edge capture. C13-N11 makes these three floats LIVE
    // for the first time, so any value other than the shader's old hard-coded
    // powder 0.5 / zero floors would retune the image inside a plumbing batch.
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
    // [2026-09-13, C13-N10] Pinned to the pre-wiring literal; per-tier tuning is
    // a follow-up row with an Edge capture. C13-N11 makes these three floats LIVE
    // for the first time, so any value other than the shader's old hard-coded
    // powder 0.5 / zero floors would retune the image inside a plumbing batch.
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
 */
export function resolveCloudPreset(
  inputs: CloudQualityInputs,
): CloudTierPreset {
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
      // [2026-09-13, C13-N10] Pinned to the pre-wiring literal; per-tier tuning is
      // a follow-up row with an Edge capture. C13-N11 makes these three floats LIVE
      // for the first time, so any value other than the shader's old hard-coded
      // powder 0.5 / zero floors would retune the image inside a plumbing batch.
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
// opted into, and the default render leaves it clear. Bit 8 is no longer that
// shape: since `C13-N20` / `R-2026-09-16-4` the renderer also sets it for an
// UNSET `cloudAerialMode` — undeclared, or the public `"auto"` default — once
// `shouldDefaultPhysicalAerial` fires, which is at or above the band edge. A
// default render above that edge therefore carries bit 8, by intent.
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

// ── The derived quality block ───────────────────────────────────────────────
//
// Everything below was lifted out of `WebGPUProceduralCloudRenderer.ts` by
// `C13-N10` (that file is 5,570 lines; the house rule asks for a decomposition
// slice whenever such a file is functionally touched). It is the whole
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
 * `"auto"` default, which are one state (R-2026-09-16-4).
 *
 * `C13-N20`'s promotion clause: the heuristic aerial term is
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
 * is the L axis, which does not exist yet; when `C13-13` lands the S×L ladder it
 * maps this predicate onto L, and this is the one function it has to change.
 *
 * This is the one part of `C13-N10` that is NOT byte-identical: above the band
 * edge, an `"auto"` frame that asked for no mode now takes the LUT path. That
 * visible change is the row's intent.
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
  /** Uniform float 172 — multi-scatter powder term (`C13-N11` consumer owed). */
  powderStrength: number;
  /** Uniform float 173 — isotropic scattering floor (`C13-N11` consumer owed). */
  isotropicFloor: number;
  /** Uniform float 174 — ambient floor (`C13-N11` consumer owed). */
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
