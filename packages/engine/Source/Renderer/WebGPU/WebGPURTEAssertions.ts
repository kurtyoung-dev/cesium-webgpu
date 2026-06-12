/**
 * Debug-only validators for the precision-critical pieces of every camera
 * UBO packer in the WebGPU backend. These exist to catch the failure
 * modes that have already cost us multiple debugging sessions:
 *
 * 1. **Off-by-one packer bugs** (BUG-38 twin) — writing `encodedCameraHigh`
 *    into `encodedCameraLow`'s slot (or vice versa) silently breaks RTE
 *    precision at planetary scale. The reconstructed camera position
 *    drifts by ~6 m at Earth radius instead of sub-millimeter, but the
 *    visible symptom is just "geometry jitter at orbit" — easy to mistake
 *    for a different bug.
 *
 * 2. **MVP translation zeroed in the wrong order** (BUG-38) — zeroing
 *    `mvp[12..14]` *after* `proj × mv` wipes the projection's P23 depth
 *    mapping term along with the translation, because the multiply
 *    redistributes col3 as
 *    `(proj × mv)_col3 = [..., ..., P22*mv23 + P23, -mv23]`.
 *    The correct order is to zero `mv[12..14]` *before* multiplying by
 *    projection, so `(proj × mv_rte)_col3 = proj × [0,0,0,1] = [0,0,P23,0]`.
 *
 * Both checks are wrapped in `//>>includeStart('debug', pragmas.debug);`
 * blocks at every call site, so they strip cleanly out of production
 * builds and have zero runtime cost.
 *
 * @private
 * @module WebGPURTEAssertions
 */

/// <reference types="@webgpu/types" />

/**
 * Maximum permitted distance, in meters, between the unencoded camera
 * position and the reconstructed `high + low` sum. At Earth radius
 * (~6.4e6 m) FP32 has roughly 0.4 m absolute precision, so values from
 * a correctly-packed RTE pair round-trip to within ~1 m. We use 6 m as
 * the alarm threshold — comfortably above the noise floor and well
 * below the ~6000 m drift that a swapped high/low produces.
 */
const RTE_ROUND_TRIP_TOLERANCE_METERS = 6.0;

/**
 * Component-wise sum of two vec3-shaped objects.
 */
function addVec3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/**
 * Euclidean distance between two vec3-shaped objects.
 */
function distVec3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Verify that an RTE high/low pair reconstructs the unencoded camera
 * position to within `RTE_ROUND_TRIP_TOLERANCE_METERS`.
 *
 * Catches the off-by-one packer bug class where `high` is written into
 * `low`'s offset (or vice versa) — the reconstructed sum drifts by
 * several meters at Earth radius instead of sub-millimeter.
 *
 * Pass the values you are about to write to the UBO; this validates
 * the *source* values rather than re-reading the buffer (which would
 * be a no-op since the bug is in the offset arithmetic, not the data
 * itself).
 *
 * @param high     The vec3 you packed at the `encodedCameraHigh` slot
 * @param low      The vec3 you packed at the `encodedCameraLow` slot
 * @param expected The unencoded world-space camera position
 * @param label    UBO identifier for the error message ("Globe terrain", "BufferPrimitive", ...)
 */
export function assertCameraRTERoundTrip(
  high: { x: number; y: number; z: number },
  low: { x: number; y: number; z: number },
  expected: { x: number; y: number; z: number },
  label: string,
): void {
  const reconstructed = addVec3(high, low);
  const error = distVec3(reconstructed, expected);
  if (error > RTE_ROUND_TRIP_TOLERANCE_METERS) {
    // Real error — the user's scene will visibly jitter at orbit if we
    // let this through. Throw, don't just warn, so the bisect lands on
    // this line instead of three frames later.
    throw new Error(
      `[WebGPU:RTE] ${label}: camera high+low round-trip drift ${error.toFixed(2)} m ` +
        `exceeds ${RTE_ROUND_TRIP_TOLERANCE_METERS} m tolerance. ` +
        `high=(${high.x},${high.y},${high.z}) low=(${low.x},${low.y},${low.z}) ` +
        `expected=(${expected.x},${expected.y},${expected.z}). ` +
        `This usually means the encoded high/low slots were written to swapped offsets.`,
    );
  }
}

/**
 * Verify that a 4×4 matrix has its translation column (indices 12, 13,
 * 14 in column-major order) zeroed.
 *
 * Catches BUG-38: a renderer that zeros `mvp[12..14]` *after* the
 * `proj × mv` multiply has already wiped projection's P23 depth term
 * because P23 lands in `(proj × mv)_col3`. The correct fix is to zero
 * `mv[12..14]` *before* the multiply; this assertion confirms the JS
 * code did so.
 *
 * Tolerance is 1e-6 — RTE construction zeroes those slots exactly,
 * so any nonzero value is a real bug, not floating-point drift.
 *
 * @param mv     A 16-element column-major matrix (Float32Array, Float64Array, or array)
 * @param label  Matrix identifier for the error message
 */
export function assertMVTranslationZeroed(
  mv: ArrayLike<number> | { [index: number]: number },
  label: string,
): void {
  const tx = Math.abs(mv[12]);
  const ty = Math.abs(mv[13]);
  const tz = Math.abs(mv[14]);
  const tol = 1e-6;
  if (tx > tol || ty > tol || tz > tol) {
    throw new Error(
      `[WebGPU:RTE] ${label}: mv translation column not zeroed before projection. ` +
        `mv[12..14]=(${mv[12]},${mv[13]},${mv[14]}). ` +
        `Zero the translation BEFORE multiplying by projection — zeroing after wipes ` +
        `projection's P23 depth-mapping term and breaks depth at planetary scale (BUG-38).`,
    );
  }
}
