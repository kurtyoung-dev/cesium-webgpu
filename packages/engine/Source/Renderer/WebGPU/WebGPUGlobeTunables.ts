/**
 * CLT-B2 — the encoding contract for the globe's enable-gated tunable slots.
 *
 * WHY THIS IS ITS OWN MODULE. The encoding below is shared by three parties
 * that cannot import each other: the CPU packer
 * (`WebGPUGlobeSurfaceTileUB`), the shader (`GlobeTerrain.wgsl`'s six
 * `get*()` helpers), and the Node spec that proves the two agree
 * (`Tools/visual-regression/globe-night-ocean-sentinel.spec.mjs`). A leaf
 * module with no imports is the only shape all three can reach:
 * `WebGPUGlobeSurfaceTypes.ts` declares a `const enum`, which Node's
 * strip-only TypeScript loader refuses, so a spec cannot import from there.
 * Putting the contract in a file that a spec CAN execute is what keeps the
 * shader law and the CPU law from drifting into a re-implemented twin.
 *
 * @module WebGPUGlobeTunables
 */

/**
 * The "no value supplied" marker for the night/ocean tunable slots.
 *
 * WHAT IT REPLACES. `oceanParams` and `nightOceanParams` used to carry "unset"
 * as literal `0.0`, and `GlobeTerrain.wgsl` read `0.0` as "substitute my
 * built-in default". Every one of those tunables has a LEGITIMATE zero
 * (`Globe.nightIntensity = 0` is documented as "no emission"; a foam threshold
 * of 0 is "foam everywhere"), so the off value ALIASED onto default-on and the
 * zero was unreachable. That is what made `globe.enableNightLights = false` a
 * visual no-op on WebGPU and C11-159's ratified "default OFF, keep the toggle"
 * vacuous as written.
 *
 * WHY NEGATIVE. Every one of these tunables is a magnitude with a non-negative
 * domain (intensity, reflectivity, threshold, darkening, exponent, colour
 * channel), so the negative half-line is unreachable from the API and is free
 * to carry "unset". The shader tests `< 0.0` instead of `== 0.0`; the CPU
 * writes this constant only where it previously wrote a `0.0` that MEANT
 * "unset".
 *
 * DEFAULT-PATH IDENTITY. With the shipped defaults the CPU wrote — and still
 * writes — the real value (`nightIntensity = 2.5`), so the shader takes the
 * pass-through arm under both the old and the new law and the emitted value is
 * bit-identical. `globe-night-ocean-sentinel.spec.mjs` enumerates every
 * reachable (enable, value) pair against both laws.
 */
export const GLOBE_UB_UNSET = -1.0;

/**
 * Resolve one enable-gated slot of `oceanParams` / `nightOceanParams`.
 *
 * The enable is carried by its OWN argument, never inferred from the value.
 * That is the whole point: the pre-CLT-B2 packer expressed "off" by writing the
 * value `0.0`, and the shader read `0.0` as "unset, use my default", so off and
 * default-on were the same 32 bits.
 *
 * `offValue` is the caller's answer to "what does OFF mean for THIS tunable",
 * and the two live call sites answer differently on purpose:
 *
 *   - Night lights — OFF means ZERO EMISSION. The shader multiplies the
 *     emissive term by this slot, so `0.0` is the disabling value, and since
 *     CLT-B2 it survives `getNightIntensity()` instead of aliasing onto 2.5.
 *   - Enhanced ocean — OFF means NOT APPLICABLE. `ShaderDefineHi.ENHANCED_OCEAN`
 *     preprocesses the whole consuming branch out of the module, so there is no
 *     value being supplied and the slot carries {@link GLOBE_UB_UNSET}. Writing
 *     a hard `0.0` there would newly zero tunables the shader is not even
 *     compiled to read — a behaviour change with no user asking for it.
 *
 * A non-finite or non-numeric value on the ON path is also "unset" — that is
 * the early-frame case where `Globe.update()` has not populated the tile
 * provider yet, and the shader default is the historically correct answer.
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
