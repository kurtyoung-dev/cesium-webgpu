/**
 * Type declarations for Cartesian3.js.
 *
 * Co-located `.d.ts` overrides TypeScript's inference from the JS source.
 * Gives WebGPU TypeScript callers proper types for Cartesian3 construction,
 * static vector math methods, and the frozen constants (ZERO, UNIT_X, etc.).
 */

/**
 * A 3D Cartesian point — basis for all Cesium positions (ECEF, local
 * tangent plane, eye-space, etc.). Mutable instance with `x`, `y`, `z`
 * fields; most math operations take a `result` parameter to avoid
 * allocation.
 */
declare class Cartesian3 {
  /** The X component. */
  x: number;
  /** The Y component. */
  y: number;
  /** The Z component. */
  z: number;

  constructor(x?: number, y?: number, z?: number);

  // ─── Instance methods ─────────────────────────────────────────────────
  clone(result?: Cartesian3): Cartesian3;
  equals(right?: Cartesian3): boolean;
  equalsEpsilon(
    right?: Cartesian3,
    relativeEpsilon?: number,
    absoluteEpsilon?: number,
  ): boolean;
  toString(): string;

  // ─── Pack/unpack ─────────────────────────────────────────────────────
  static readonly packedLength: 3;
  static pack(
    value: Cartesian3,
    array: number[],
    startingIndex?: number,
  ): number[];
  static unpack(
    array: number[],
    startingIndex?: number,
    result?: Cartesian3,
  ): Cartesian3;
  static packArray(
    array: Cartesian3[],
    result?: number[] | Float32Array | Float64Array,
  ): number[] | Float32Array | Float64Array;
  static unpackArray(
    array: ArrayLike<number>,
    result?: Cartesian3[],
  ): Cartesian3[];
  static fromArray(
    array: ArrayLike<number>,
    startingIndex?: number,
    result?: Cartesian3,
  ): Cartesian3;

  // ─── Factories ───────────────────────────────────────────────────────
  static fromSpherical(
    spherical: { clock: number; cone: number; magnitude?: number },
    result?: Cartesian3,
  ): Cartesian3;
  static fromElements(
    x: number,
    y: number,
    z: number,
    result?: Cartesian3,
  ): Cartesian3;
  static clone(cartesian: Cartesian3, result?: Cartesian3): Cartesian3;
  static fromCartesian4(
    cartesian: { x: number; y: number; z: number; w: number },
    result?: Cartesian3,
  ): Cartesian3;
  static fromDegrees(
    longitude: number,
    latitude: number,
    height?: number,
    ellipsoid?: unknown,
    result?: Cartesian3,
  ): Cartesian3;
  static fromRadians(
    longitude: number,
    latitude: number,
    height?: number,
    ellipsoid?: unknown,
    result?: Cartesian3,
  ): Cartesian3;
  static fromDegreesArray(
    coordinates: number[],
    ellipsoid?: unknown,
    result?: Cartesian3[],
  ): Cartesian3[];
  static fromRadiansArray(
    coordinates: number[],
    ellipsoid?: unknown,
    result?: Cartesian3[],
  ): Cartesian3[];
  static fromDegreesArrayHeights(
    coordinates: number[],
    ellipsoid?: unknown,
    result?: Cartesian3[],
  ): Cartesian3[];
  static fromRadiansArrayHeights(
    coordinates: number[],
    ellipsoid?: unknown,
    result?: Cartesian3[],
  ): Cartesian3[];

  // ─── Component-wise operations ───────────────────────────────────────
  static maximumComponent(cartesian: Cartesian3): number;
  static minimumComponent(cartesian: Cartesian3): number;
  static minimumByComponent(
    first: Cartesian3,
    second: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static maximumByComponent(
    first: Cartesian3,
    second: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static clamp(
    value: Cartesian3,
    min: Cartesian3,
    max: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;

  // ─── Scalar results ──────────────────────────────────────────────────
  static magnitudeSquared(cartesian: Cartesian3): number;
  static magnitude(cartesian: Cartesian3): number;
  static distance(left: Cartesian3, right: Cartesian3): number;
  static distanceSquared(left: Cartesian3, right: Cartesian3): number;
  static dot(left: Cartesian3, right: Cartesian3): number;
  static angleBetween(left: Cartesian3, right: Cartesian3): number;

  // ─── Vector results ──────────────────────────────────────────────────
  static normalize(cartesian: Cartesian3, result: Cartesian3): Cartesian3;
  static multiplyComponents(
    left: Cartesian3,
    right: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static divideComponents(
    left: Cartesian3,
    right: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static add(
    left: Cartesian3,
    right: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static subtract(
    left: Cartesian3,
    right: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static multiplyByScalar(
    cartesian: Cartesian3,
    scalar: number,
    result: Cartesian3,
  ): Cartesian3;
  static divideByScalar(
    cartesian: Cartesian3,
    scalar: number,
    result: Cartesian3,
  ): Cartesian3;
  static negate(cartesian: Cartesian3, result: Cartesian3): Cartesian3;
  static abs(cartesian: Cartesian3, result: Cartesian3): Cartesian3;
  static lerp(
    start: Cartesian3,
    end: Cartesian3,
    t: number,
    result: Cartesian3,
  ): Cartesian3;
  static mostOrthogonalAxis(
    cartesian: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static projectVector(
    a: Cartesian3,
    b: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static cross(
    left: Cartesian3,
    right: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;
  static midpoint(
    left: Cartesian3,
    right: Cartesian3,
    result: Cartesian3,
  ): Cartesian3;

  // ─── Equality ────────────────────────────────────────────────────────
  static equals(left?: Cartesian3, right?: Cartesian3): boolean;
  static equalsArray(
    cartesian: Cartesian3,
    array: number[],
    offset: number,
  ): boolean;
  static equalsEpsilon(
    left?: Cartesian3,
    right?: Cartesian3,
    relativeEpsilon?: number,
    absoluteEpsilon?: number,
  ): boolean;

  // ─── Frozen constants ────────────────────────────────────────────────
  static readonly ZERO: Cartesian3;
  static readonly ONE: Cartesian3;
  static readonly UNIT_X: Cartesian3;
  static readonly UNIT_Y: Cartesian3;
  static readonly UNIT_Z: Cartesian3;
}

export default Cartesian3;
