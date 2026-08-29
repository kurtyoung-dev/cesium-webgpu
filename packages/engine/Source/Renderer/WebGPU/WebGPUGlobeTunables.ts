/**
 * Encoding contract for the globe's enable-gated tunable slots.
 *
 * The encoding is shared by three parties that cannot import each other: the
 * CPU packer (`WebGPUGlobeSurfaceTileUB`), the shader (`GlobeTerrain.wgsl`'s
 * six `get*()` helpers), and the Node spec that proves the two agree
 * (`Tools/visual-regression/globe-night-ocean-sentinel.spec.mjs`). A leaf
 * module with no imports is the only shape all three can reach:
 * `WebGPUGlobeSurfaceTypes.ts` declares a `const enum`, which Node's
 * strip-only TypeScript loader refuses, so a spec cannot import from there.
 * Keeping the contract somewhere a spec can execute is what stops the shader
 * law and the CPU law from drifting into re-implemented twins.
 *
 * @module WebGPUGlobeTunables
 */

/**
 * The "no value supplied" marker for the night and ocean tunable slots.
 *
 * `0.0` cannot carry that meaning. `GlobeTerrain.wgsl` substitutes its
 * built-in default for an unset slot, and every one of these tunables has a
 * legitimate zero — `Globe.nightIntensity = 0` is documented as "no emission",
 * a foam threshold of 0 is "foam everywhere" — so an off value written as
 * `0.0` aliases onto default-on and the real zero becomes unreachable. That
 * aliasing is what would make `globe.enableNightLights = false` a visual no-op,
 * which for a feature that ships ON is the only state the toggle has to offer.
 *
 * The marker is negative because each of these tunables is a magnitude over a
 * non-negative domain (intensity, reflectivity, threshold, darkening,
 * exponent, colour channel), so the negative half-line is unreachable from the
 * API and free to carry "unset". The shader tests `< 0.0` rather than
 * `== 0.0`; the CPU writes this constant only where a `0.0` would have meant
 * "unset".
 *
 * With the shipped defaults the CPU writes the real value
 * (`nightIntensity = 2.5`, with the enable ON), so the shader takes the
 * pass-through arm and the emitted value is bit-identical either way.
 * `globe-night-ocean-sentinel.spec.mjs` enumerates every reachable
 * (enable, value) pair.
 */
export const GLOBE_UB_UNSET = -1.0;

/**
 * Resolve one enable-gated slot of `oceanParams` / `nightOceanParams`.
 *
 * The enable is carried by its own argument, never inferred from the value.
 * Expressing "off" by writing the value `0.0` makes off and default-on the
 * same 32 bits, because the shader reads `0.0` as "unset, use my default".
 *
 * `offValue` is the caller's answer to "what does off mean for this tunable",
 * and the two live call sites answer differently on purpose:
 *
 *   - Night lights: off means zero emission. The shader multiplies the
 *     emissive term by this slot, so `0.0` is the disabling value and it
 *     survives `getNightIntensity()` instead of aliasing onto 2.5.
 *   - Enhanced ocean: off means not applicable.
 *     `ShaderDefineHi.ENHANCED_OCEAN` preprocesses the whole consuming branch
 *     out of the module, so no value is being supplied and the slot carries
 *     {@link GLOBE_UB_UNSET}. A hard `0.0` there would zero tunables the
 *     shader is not even compiled to read.
 *
 * A non-finite or non-numeric value on the enabled path is also "unset" — the
 * early-frame case where `Globe.update()` has not populated the tile provider
 * yet, for which the shader default is the right answer.
 *
 * @param enabled Whether the owning feature toggle is on this frame.
 * @param value The raw mirrored value; anything non-finite counts as absent.
 * @param offValue What this tunable means when the feature is off.
 * @returns The float to write into the uniform slot.
 * @private
 */
export function resolveGlobeTunable(
  enabled: boolean,
  value: unknown,
  offValue: number,
): number {
  if (!enabled) {
    return offValue;
  }
  return typeof value === "number" && isFinite(value) ? value : GLOBE_UB_UNSET;
}
