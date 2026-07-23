/**
 * Campaign 3 v2 — cloud quality-tier presets (the single source of truth for the
 * tiered volumetric-cloud architecture). One `quality` dial → one preset struct.
 *
 * The public dial is `collection.volumetric.cloudVolumetricQuality` (`"low" |
 * "medium" | "high" | "auto"`) plus the power-user
 * `collection.volumetric.cloudQuality` escape hatch; this
 * module maps it (and `"auto"`'s altitude bands) to a {@link CloudTierPreset}.
 * **Tier 0 = the cheap default** (the cloud pass does not run — the default-off
 * WebGL-parity path); Tiers 1–3 are opt-in volumetric (low / high / cinematic).
 *
 * **V1 (inert spine):** only `qualityFlags`@74 is packed from this, and no shader
 * reads `qualityFlags` yet, so every tier renders byte-identically to pre-V1.
 * Feature batches wire each field in turn (V3 noiseSource, V5 multiScatterOctaves,
 * V6 jitter, V9 renderResScale, V10 temporal, V11 profile). `primarySteps` /
 * `lightSteps` MIRROR the legacy `resolveCloudQuality` table (24/3, 48/4, 96/8);
 * the research target counts (32/96/128 …) land per-feature behind their own A/B.
 */

/** Density source — bit 0 of `qualityFlags`. */
export const CloudNoiseSource = Object.freeze({ LIVE: 0, BAKED: 1 });

export interface CloudTierPreset {
  /** 0 = baseline (pass does not run), 1 = low, 2 = high, 3 = cinematic. */
  tier: number;
  primarySteps: number;
  lightSteps: number;
  /** {@link CloudNoiseSource} — LIVE keeps the procedural march, BAKED samples the 3D textures (V3+). */
  noiseSource: number;
  /** Cloud-pass render-target scale (1.0 full, 0.5 half) — consumed at V9. */
  renderResScale: number;
  temporalEnabled: boolean;
  /** Fraction of pixels refreshed per frame under temporal reprojection (V10). */
  temporalUpdateFraction: number;
  jitterEnabled: boolean;
  /** Light-march sample-count scale vs the camera budget (V5). */
  lightSampleScale: number;
  /**
   * Batch 436 (3.6 CLOUD-CONE-LIGHT) — when true, the light march toward the sun
   * uses the Schneider/Nubis 6-tap JITTERED CONE sampling (5 cone taps + 1 long
   * far tap on the cheap `cloudBaseDensity` oracle) instead of the straight N-step
   * march. ~½ the light-march cost at equal visual quality. T1/T2 SET it; T3
   * cinematic + the `cloudQuality` escape hatch keep the straight march (parity).
   */
  lightConeSampling: boolean;
  multiScatterOctaves: number;
  powderStrength: number;
  isotropicFloor: number;
  ambientFloor: number;
  /**
   * Batch 439 (4.7 CLOUD-CURL) — per-tier DEFAULT curl-warp amplitude scaffolding.
   * Held at 0 on EVERY tier so the default render stays byte-identical: curl is
   * opted in solely through `globe.cloudCurlAmplitude` (the renderer packs that
   * field, not this preset value). This field remains as the slot for a future
   * per-tier curl default once the morphology is dialed in.
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
 * Tier table — the single source of truth. NOTE: `primarySteps` / `lightSteps`
 * mirror the legacy `resolveCloudQuality` table for image-identity; the research
 * target counts land per-feature later. The flag / lighting fields ARE the target
 * values — inert until each feature batch consumes them.
 */
export const CLOUD_TIER_PRESETS: CloudTierPreset[] = [
  // T0 Baseline — the cloud pass does not run (default-off). Present for completeness.
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
  // T1 Volumetric-Low
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
  // T2 Volumetric-High
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
    // Batch 439 — held at 0 (parity-default; curl opts in via globe.cloudCurlAmplitude).
    curlAmplitude: 0,
  },
  // T3 Cinematic
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
    // T3 cinematic keeps the STRAIGHT N-step light march (full quality, parity).
    lightConeSampling: false,
    multiScatterOctaves: 3,
    powderStrength: 0.7,
    isotropicFloor: 0.04,
    ambientFloor: 0.08,
    // Batch 439 — held at 0 (parity-default; curl opts in via globe.cloudCurlAmplitude).
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
 * Resolve the active {@link CloudTierPreset}. Power-user escape hatch
 * (`cloudQuality !== 64`): force the LIVE-noise, no-reconstruction, neutral-dials
 * path with the caller's hand-tuned step count + a derived light-step count —
 * preserves today's power-user behavior exactly (bypasses the reconstruction
 * stack). Mirrors `resolveCloudQuality`'s escape-hatch math.
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
      // Escape hatch keeps the STRAIGHT light march (parity with today's power-user path).
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
export const CLOUD_QF_NOISE_BAKED = 1 << 0; // V3
export const CLOUD_QF_HALF_RES = 1 << 1; // V9
export const CLOUD_QF_TEMPORAL = 1 << 2; // V10
export const CLOUD_QF_JITTER = 1 << 3; // V6
export const CLOUD_QF_OCTAVES_SHIFT = 4; // bits 4-6
export const CLOUD_QF_PROFILE_ON = 1 << 7; // V11
// Batch 434 — atmosphere-LUT coupling (add-only). Set by the renderer ONLY when the
// matching globe.cloud* mode is opted in; the default render leaves them clear.
export const CLOUD_QF_AERIAL_LUT = 1 << 8; // 3.3 physical aerial (sky-view + transmittance)
export const CLOUD_QF_AMBIENT_LUT = 1 << 9; // 3.4 sky-LUT cloud ambient (MS sky LUT)
// Batch 436 (3.6 CLOUD-CONE-LIGHT) — add-only. Set by the renderer ONLY when the
// resolved tier's `lightConeSampling` is true (T1 low / T2 medium); T3 cinematic +
// the escape hatch leave it clear → the WGSL takes the verbatim straight light
// march → byte-identical to pre-436.
export const CLOUD_QF_LIGHT_CONE = 1 << 10; // 3.6 cone-sampled light march
// Batch 443 (4.9 CLOUD-MULTIDECK) — add-only. Set by the renderer ONLY when
// globe.cloudMultiDeck is opted in; the default leaves it clear → the WGSL marches
// exactly one shell with cloudLayerBottom/Top + the legacy composite, byte-identical.
export const CLOUD_QF_MULTI_DECK = 1 << 11; // 4.9 multi-deck shell march
// Batch 445 (4.12 CLOUD-RTE) — add-only. C13-04 makes this automatic by default;
// an explicit cloudHighPrecision=false leaves it clear for the legacy A/B path.
export const CLOUD_QF_HIGH_PRECISION = 1 << 12; // 4.12 CLOUD-RTE camera-relative high-precision march
