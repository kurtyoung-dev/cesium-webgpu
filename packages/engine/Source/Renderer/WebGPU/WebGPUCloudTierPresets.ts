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
 * `primarySteps` and `lightSteps` mirror the legacy `resolveCloudQuality` table
 * (24/3, 48/4, 96/8), which is what keeps the tiers image-identical to it. The
 * higher step counts the research suggests are adopted one feature at a time,
 * each behind its own comparison.
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
 * Tier table, the single source of truth. `primarySteps` and `lightSteps`
 * mirror the legacy `resolveCloudQuality` table for image identity. The flag
 * and lighting fields already carry their target values, and several remain
 * inert until the feature that reads them is wired.
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
    powderStrength: 0,
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
    powderStrength: 0,
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
    powderStrength: 0.4,
    isotropicFloor: 0.02,
    ambientFloor: 0.05,
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
    powderStrength: 0.7,
    isotropicFloor: 0.04,
    ambientFloor: 0.08,
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
  // auto / unknown → altitude bands (mirrors resolveCloudQuality): far = low,
  // near = high, between = medium.
  if (inputs.cameraHeightMeters >= inputs.disableAltitudeMeters) return 1;
  if (inputs.cameraHeightMeters <= inputs.enableAltitudeMeters) return 3;
  return 2;
}

/**
 * Resolve the active {@link CloudTierPreset}. Under the power-user escape
 * hatch (`cloudQuality !== 64`) the result is the live-noise,
 * no-reconstruction, neutral-dials path with the caller's hand-tuned step count
 * and a light-step count derived from it, which bypasses the reconstruction
 * stack. Mirrors `resolveCloudQuality`'s escape-hatch arithmetic.
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
      powderStrength: 0,
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
// Atmosphere-LUT coupling. Set by the renderer only when the matching
// globe.cloud* mode is opted into; the default render leaves them clear.
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
