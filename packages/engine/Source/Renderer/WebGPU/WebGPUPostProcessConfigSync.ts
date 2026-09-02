/// <reference types="@webgpu/types" />
/**
 * Runtime configuration sync for the WebGPU post-process effects.
 *
 * A `PostProcessStage`'s uniforms are a live object: on WebGL the stage's
 * uniform map holds a getter per name and every draw reads the current value,
 * so `stage.uniforms.intensity = 2` takes effect on the next frame. The WebGPU
 * effects instead bake their configuration into uniform buffers when the effect
 * is added to the pipeline. Without a per-frame comparison the configuration is
 * latched at first enable and every later write is silently inert.
 *
 * This module owns the mechanism for the effects that carry an `updateConfig`
 * method: read the stage's uniforms into a stable record, compare it against
 * the record last applied, and push the difference exactly once. Reading into
 * caller-owned records keeps the steady state free of per-frame allocation, and
 * sharing one reader between the first-enable path and the propagation path
 * keeps a single definition of what each uniform means.
 *
 * @module WebGPUPostProcessConfigSync
 */

import {
  WEBGPU_AO_FULL_SAMPLE_PATTERN,
  type AOAlgorithm,
  type AmbientOcclusionConfig,
} from "./WebGPUAmbientOcclusionEffect.js";
import type { DepthOfFieldConfig } from "./WebGPUDepthOfFieldEffect.js";

/**
 * Narrows a polymorphic `PostProcessStage` uniform value to a number for the
 * dominant numeric-scalar reads (intensity, sigma, threshold, etc.). Returns
 * the default when the uniform is undefined or carries a non-numeric value —
 * the AO algorithm discriminator is the lone string-typed uniform and has its
 * own narrowing path at the read site. The pattern matches
 * `Cesium.defaultValue(value, default)` semantics.
 *
 * @param {number|string|boolean|undefined} v The uniform value.
 * @param {number} d The default.
 * @returns {number} The narrowed value.
 */
export function numU(
  v: number | string | boolean | undefined,
  d: number,
): number {
  return typeof v === "number" ? v : d;
}

/** The AO fields the bridge sources from the stage's uniforms. */
export type AmbientOcclusionConfigValues = Required<
  Omit<AmbientOcclusionConfig, "blurSigma">
>;

/** The DoF fields the bridge sources from the composite stage's uniforms. */
export type DepthOfFieldConfigValues = Required<DepthOfFieldConfig>;

/** A post-process effect that accepts a runtime configuration update. */
export interface ConfigurableEffect<TConfig> {
  updateConfig(config: Partial<TConfig>): void;
}

/** Minimal structural view of a stage carrying a uniform bag. */
interface UniformBearingStage {
  uniforms?: Record<string, number | string | boolean | undefined>;
}

/**
 * The AO configuration fields, written as an exhaustive set so the compiler
 * rejects a list that drifts from `AmbientOcclusionConfigValues`: a missing
 * field is a required-property error and a stale one an excess-property error.
 * `propagateConfigIfChanged` runs on every configure pass, so it walks this
 * hoisted list instead of calling `Object.keys` on the record it just read.
 */
const AMBIENT_OCCLUSION_CONFIG_KEY_SET: Record<
  keyof AmbientOcclusionConfigValues,
  true
> = {
  algorithm: true,
  intensity: true,
  bias: true,
  lengthCap: true,
  stepCount: true,
  directionCount: true,
  ambientOcclusionOnly: true,
  giIntensity: true,
  sliceCount: true,
  ssgiStepCount: true,
  radiusPixels: true,
  maxWorldRadius: true,
  thicknessMin: true,
  thicknessK: true,
  luminanceClamp: true,
  expFactor: true,
  aoWeight: true,
  ssgiDebugMode: true,
};

/** The AO configuration fields, in a list allocated once at module load. */
export const AMBIENT_OCCLUSION_CONFIG_KEYS: readonly string[] = Object.keys(
  AMBIENT_OCCLUSION_CONFIG_KEY_SET,
);

/** The DoF configuration fields, under the same exhaustiveness constraint. */
const DEPTH_OF_FIELD_CONFIG_KEY_SET: Record<
  keyof DepthOfFieldConfigValues,
  true
> = {
  focalDistance: true,
  focalRange: true,
  blurSigma: true,
};

/** The DoF configuration fields, in a list allocated once at module load. */
export const DEPTH_OF_FIELD_CONFIG_KEYS: readonly string[] = Object.keys(
  DEPTH_OF_FIELD_CONFIG_KEY_SET,
);

/** Shared empty list for effects that have no build-only fields. */
const NO_BUILD_ONLY_KEYS: readonly string[] = [];

/**
 * Fields that select pipelines or the uniform packing when the effect is
 * built, so they cannot be pushed through `updateConfig`. `algorithm` chooses
 * the generation shader, the blur layout and the whole uniform packing in
 * `AmbientOcclusionEffect`; changing it needs a rebuild, not a buffer write.
 */
export const AMBIENT_OCCLUSION_BUILD_ONLY_KEYS: readonly string[] = [
  "algorithm",
];

/**
 * Reads the ambient-occlusion stage's uniforms into `out` and returns it.
 *
 * The defaults match `PostProcessStageLibrary.createAmbientOcclusionStage`,
 * whose composite exposes `intensity`, `bias`, `lengthCap`, `directionCount`,
 * `stepCount` and `ambientOcclusionOnly`. The remaining fields are fork
 * extensions consumed only by the screen-space global-illumination algorithm.
 *
 * @param {object} [stage] The ambient-occlusion composite stage.
 * @param {object} out The record to fill.
 * @returns {object} The filled record.
 */
export function readAmbientOcclusionConfigInto(
  stage: UniformBearingStage | undefined | null,
  out: AmbientOcclusionConfigValues,
): AmbientOcclusionConfigValues {
  const uniforms = stage?.uniforms;
  // The algorithm discriminator is the lone string-typed AO uniform; narrow it
  // to the supported literal union rather than passing it through `numU`.
  // "gtao" and "ssgi" are explicit opt-ins: missing or unknown values retain
  // the "hbao" default.
  const rawAlgorithm = uniforms?.algorithm;
  out.algorithm =
    rawAlgorithm === "gtao" ||
    rawAlgorithm === "hbao" ||
    rawAlgorithm === "ssgi"
      ? (rawAlgorithm as AOAlgorithm)
      : "hbao";
  out.intensity = numU(uniforms?.intensity, 3.0);
  out.bias = numU(uniforms?.bias, 0.1);
  out.lengthCap = numU(uniforms?.lengthCap, 0.26);
  // Keep the bridge and the shader loop policy on the same landing switch. The
  // false branch preserves the historical stepSize read and 4x4 defaults.
  out.stepCount = WEBGPU_AO_FULL_SAMPLE_PATTERN
    ? numU(uniforms?.stepCount, 32)
    : numU(uniforms?.stepSize, 4);
  out.directionCount = numU(
    uniforms?.directionCount,
    WEBGPU_AO_FULL_SAMPLE_PATTERN ? 8 : 4,
  );
  out.ambientOcclusionOnly = Boolean(uniforms?.ambientOcclusionOnly ?? false);
  // Screen-space global illumination parameters; ignored unless the selected
  // algorithm is "ssgi".
  out.giIntensity = numU(uniforms?.giIntensity, 1.0);
  out.sliceCount = numU(uniforms?.sliceCount, 2);
  out.ssgiStepCount = numU(uniforms?.ssgiStepCount, 8);
  out.radiusPixels = numU(uniforms?.radiusPixels, 32.0);
  out.maxWorldRadius = numU(uniforms?.maxWorldRadius, 500.0);
  out.thicknessMin = numU(uniforms?.thicknessMin, 1.0);
  out.thicknessK = numU(uniforms?.thicknessK, 0.005);
  out.luminanceClamp = numU(uniforms?.luminanceClamp, 7.0);
  out.expFactor = numU(uniforms?.expFactor, 2.0);
  out.aoWeight = numU(uniforms?.aoWeight, 1.0);
  out.ssgiDebugMode = numU(uniforms?.ssgiDebugMode, 0);
  return out;
}

/**
 * Reads the depth-of-field composite stage's uniforms into `out`.
 *
 * Upstream's DoF composite names its blur width `delta` and its blur sigma
 * `sigma`; the WebGPU effect calls them `focalRange` and `blurSigma`.
 *
 * @param {object} [stage] The depth-of-field composite stage.
 * @param {object} out The record to fill.
 * @returns {object} The filled record.
 */
export function readDepthOfFieldConfigInto(
  stage: UniformBearingStage | undefined | null,
  out: DepthOfFieldConfigValues,
): DepthOfFieldConfigValues {
  const uniforms = stage?.uniforms;
  out.focalDistance = numU(uniforms?.focalDistance, 50.0);
  out.focalRange = numU(uniforms?.delta, 20.0);
  out.blurSigma = numU(uniforms?.sigma, 4.0);
  return out;
}

/** What one propagation attempt did. */
export interface ConfigPropagationOutcome {
  /** True when a difference was found and pushed to the effect. */
  changed: boolean;
  /**
   * The first build-only field whose value differs from the applied record, or
   * null. Such a field cannot be pushed, so the caller reports it rather than
   * letting the write disappear.
   */
  buildOnlyChanged: string | null;
}

/**
 * Pushes `next` to `effect` when it differs from `applied`, then copies `next`
 * into `applied` so the following comparison runs against what the effect
 * holds.
 *
 * Build-only keys are compared but never pushed, and never copied into
 * `applied` — leaving them copied would silence the report after the first
 * frame. Every other key is pushed together rather than only the fields that
 * differ, so the effect's configuration always equals the record read from the
 * stage.
 *
 * The configure pass calls this once per enabled effect per frame, so the
 * unchanged path must not allocate: `keys` is a list hoisted to module scope
 * rather than an `Object.keys` call, and `out` is a caller-owned record rather
 * than a fresh result object. The pushed update is the one allocation left, and
 * it is built only on a frame that actually changes something; `updateConfig`
 * copies the fields out with `Object.assign` and does not retain the object.
 *
 * @param {object} [effect] The effect, or null when it does not exist yet.
 * @param {object} next The freshly read record.
 * @param {object} applied The record last applied to the effect; mutated here.
 * @param {string[]} keys The fields to compare, hoisted by the caller.
 * @param {object} out The outcome record to fill; owned by the caller.
 * @param {string[]} [buildOnlyKeys] Keys needing a rebuild rather than a write.
 * @returns {object} `out`, describing what this attempt did.
 */
export function propagateConfigIfChanged<
  TValues extends Record<string, number | string | boolean>,
>(
  effect: ConfigurableEffect<TValues> | null | undefined,
  next: TValues,
  applied: TValues,
  keys: readonly string[],
  out: ConfigPropagationOutcome,
  buildOnlyKeys: readonly string[] = NO_BUILD_ONLY_KEYS,
): ConfigPropagationOutcome {
  out.changed = false;
  out.buildOnlyChanged = null;
  if (!effect) {
    return out;
  }
  const appliedRecord = applied as Record<string, number | string | boolean>;
  let changed = false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (next[key] === appliedRecord[key]) {
      continue;
    }
    if (buildOnlyKeys.includes(key)) {
      out.buildOnlyChanged = out.buildOnlyChanged ?? key;
      continue;
    }
    changed = true;
  }
  if (changed) {
    const update: Record<string, number | string | boolean> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (buildOnlyKeys.includes(key)) {
        continue;
      }
      update[key] = next[key];
      appliedRecord[key] = next[key];
    }
    effect.updateConfig(update as Partial<TValues>);
  }
  out.changed = changed;
  return out;
}
