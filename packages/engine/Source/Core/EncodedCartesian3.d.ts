/**
 * Type declarations for EncodedCartesian3.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source
 * (which is imprecise when `checkJs: false`). This gives WebGPU TypeScript
 * callers proper types when accessing `EncodedCartesian3.fromCartesian`,
 * `.encode`, and the `.high` / `.low` instance fields — eliminating the
 * need for `as unknown as` casts at every call site.
 */

import Cartesian3 from "./Cartesian3.js";

/**
 * A fixed-point encoding of a `Cartesian3` with 64-bit floating-point
 * components, split into two `Cartesian3` values that — when converted
 * to 32-bit floating-point and added — approximate the original input.
 * Used for RTE (Relative-To-Eye) vertex data to avoid precision jitter.
 */
declare class EncodedCartesian3 {
  /** The high bits for each component. Bits 0-22 store the whole value. */
  high: Cartesian3;
  /**
   * The low bits for each component. Bits 7-22 store the whole value,
   * and bits 0-6 store the fraction.
   */
  low: Cartesian3;

  constructor();

  /**
   * Encodes a 64-bit floating-point value as two floating-point values
   * that, when converted to 32-bit floating-point and added, approximate
   * the original input.
   *
   * @param value The floating-point value to encode.
   * @param result Optional object onto which to store the result.
   */
  static encode(
    value: number,
    result?: { high: number; low: number },
  ): { high: number; low: number };

  /**
   * Encodes a Cartesian3 with 64-bit float components as two Cartesian3
   * values whose 32-bit sum approximates the original.
   */
  static fromCartesian(
    cartesian: Cartesian3,
    result?: EncodedCartesian3,
  ): EncodedCartesian3;

  /**
   * Encodes the provided cartesian and writes it to an array as
   * `[high.x, high.y, high.z, low.x, low.y, low.z]` starting at `index`.
   * Used for interleaved RTE vertex attribute packing.
   */
  static writeElements(
    cartesian: Cartesian3,
    cartesianArray: number[] | Float32Array | Float64Array,
    index: number,
  ): void;
}

export default EncodedCartesian3;
