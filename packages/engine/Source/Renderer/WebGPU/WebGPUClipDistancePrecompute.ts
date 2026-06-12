/**
 * Precomputes the per-frame `dPrime` scalars that let the vertex shader
 * test clipping plane equations against eye-relative positions instead
 * of model-space positions. This is the CPU half of WGF-1 (hardware
 * clip distances) — see `migration_doc/PHASE_5_MODERN_WEBGPU_DESIGN.md`
 * § WGF-1.
 *
 * ─── The math ────────────────────────────────────────────────────────
 *
 * A clipping plane equation is `dot(n, p) + d = 0` where `n` is the
 * normal in the same coordinate frame as `p` and `d` is the signed
 * distance from the origin. The fragment-discard path computes
 * `dot(n, positionMC) + d` per fragment, which works but pays a
 * texture sample + scalar dot per fragment.
 *
 * Hardware clip distances need a per-vertex value that the rasterizer
 * compares against zero. We want to compute `dot(n, positionEye) + dPrime`
 * in the vertex shader, where `positionEye = positionMC - cameraMC`
 * (RTE eye-relative). Substituting:
 *
 *   dot(n, positionEye) + dPrime
 *     = dot(n, positionMC - cameraMC) + dPrime
 *     = dot(n, positionMC) - dot(n, cameraMC) + dPrime
 *
 * For this to equal `dot(n, positionMC) + d` (the original test):
 *
 *   dPrime = d + dot(n, cameraMC)
 *
 * Compute `dot(n, cameraMC)` on the CPU in FP64 (where the camera
 * position has full precision), add the original `d`, then store
 * `dPrime` as FP32 for the shader. At Earth radius (~6.4e6 m) FP32
 * stores `dPrime` with ~0.4 m absolute precision — fine for any
 * realistic clipping plane (sub-meter clip-near-feature is rare and
 * not currently a Cesium use case).
 *
 * ─── Why this lives in its own module ─────────────────────────────────
 *
 * It's small, has no other dependencies, is unit-testable in isolation,
 * and the WGF-1 design notes specifically called out the need for
 * "debug-build assertion that dPrime round-trips correctly." Keeping
 * the helper isolated makes that assertion straightforward to add and
 * keeps the existing renderer code thin.
 *
 * @private
 * @module WebGPUClipDistancePrecompute
 */

/// <reference types="@webgpu/types" />

/**
 * Maximum number of clipping planes the hardware path supports. 8 is
 * the floor across Vulkan / Metal / D3D12 — every adapter that grants
 * `clip-distances` supports at least 8 clip distances per vertex.
 *
 * If a `ClippingPlaneCollection` carries more than 8 planes, the
 * hardware path takes only the first 8 and the existing fragment-side
 * discard path handles the overflow. The two paths compose because the
 * fragment discard is a strict superset of the rasterizer clip.
 */
export const MAX_HARDWARE_CLIP_PLANES = 8;

/**
 * Layout of the precomputed (normal, dPrime) block in the EffectsUniforms
 * UBO. Each plane occupies one vec4: `(n.x, n.y, n.z, dPrime)`. The vertex
 * shader reads this directly to compute `dot(n, eyeRelativePos) + dPrime`
 * without touching the clipping plane texture (which stays fragment-only
 * for the edge-highlight feature).
 *
 * Stored as `array<vec4<f32>, 8>` so it occupies exactly 128 bytes.
 */
export const CLIP_DPRIME_FLOAT_COUNT = 8 * 4; // 8 planes × vec4
export const CLIP_DPRIME_BYTES = CLIP_DPRIME_FLOAT_COUNT * 4;

/**
 * Sentinel value written to the `dPrime` slot of unused clipping plane
 * entries. Must be **finite** — the WebGPU `clip_distances` builtin
 * inherits Vulkan / Metal semantics where non-finite values produce
 * undefined behavior (Metal's MSL backend in particular clamps NaN/Inf
 * and may silently cull primitives that would otherwise pass). We use a
 * very large positive value (1e30) so the rasterizer's `>= 0` test
 * trivially passes for unused slots without going non-finite. The paired
 * normal vector is `(0,0,0)`, so `dot(0, p) + 1e30 = 1e30` regardless of
 * the vertex position.
 */
export const CLIP_DISTANCE_INACTIVE_SENTINEL = 1e30;

/**
 * Tolerance for the debug round-trip assertion. The reconstructed
 * `dot(n, p) + d` should match the precomputed `dot(n, p_eye) + dPrime`
 * within a few ULPs at FP32; we use 1e-2 m as a generous tolerance
 * that catches the off-by-one packer bugs (which would manifest as
 * meters of drift) without false-positiving on legitimate FP32 noise.
 */
const DPRIME_ROUND_TRIP_TOLERANCE_METERS = 1e-2;

/** Minimal interface for a ClippingPlaneCollection-like object. */
interface ClipPlaneCollectionLike {
  length: number;
  get(
    index: number,
  ):
    | { normal: { x: number; y: number; z: number }; distance: number }
    | undefined;
}

/**
 * Compute the dPrime values for up to `MAX_HARDWARE_CLIP_PLANES` of
 * the supplied collection, given the unencoded camera position the
 * vertex shader's RTE pair was built against.
 *
 * The output array is always exactly `MAX_HARDWARE_CLIP_PLANES` long;
 * unused slots are filled with `+Infinity` so the vertex shader's
 * `clip_distances[i] >= 0` test always passes (no clip) for those
 * slots.
 *
 * Note: this is called on the per-frame hot path. The implementation
 * is allocation-free — the caller passes in the destination
 * `Float32Array` (typically a slice of the effects UBO scratch
 * buffer).
 *
 * @param collection ClippingPlaneCollection (Cesium upstream type)
 * @param cameraInPlaneSpace
 *   The camera position in the same coordinate frame the plane
 *   equations were authored in. For globe terrain that's the world
 *   position (`uniformState.cameraPosition`); for a model with a
 *   non-identity model matrix it would be `inverseModel × cameraWorld`.
 * @param out
 *   Destination — must be at least `CLIP_DPRIME_FLOAT_COUNT` long.
 *   Slots beyond `collection.length` (or beyond
 *   `MAX_HARDWARE_CLIP_PLANES`) are written with `+Infinity`.
 */
/**
 * Pack the per-plane `(normal.xyz, dPrime)` quad for every plane in the
 * collection (up to `MAX_HARDWARE_CLIP_PLANES`). The output is laid out
 * as a flat `array<vec4<f32>, 8>` — 8 entries × 4 floats each = 32 floats.
 *
 * Slots beyond `collection.length` carry `(0, 0, 0, +Infinity)` so the
 * rasterizer's `clip_distances[i] >= 0` test trivially passes for them
 * (no clip).
 */
export function computeClipPlaneDPrimes(
  collection: ClipPlaneCollectionLike | null | undefined,
  cameraInPlaneSpace: { x: number; y: number; z: number } | null | undefined,
  out: Float32Array,
): void {
  // Empty / null path: every plane is "no clip".
  if (!collection || !cameraInPlaneSpace || collection.length === 0) {
    for (let i = 0; i < MAX_HARDWARE_CLIP_PLANES; i++) {
      const base = i * 4;
      out[base + 0] = 0;
      out[base + 1] = 0;
      out[base + 2] = 0;
      out[base + 3] = CLIP_DISTANCE_INACTIVE_SENTINEL;
    }
    return;
  }

  const cx = cameraInPlaneSpace.x;
  const cy = cameraInPlaneSpace.y;
  const cz = cameraInPlaneSpace.z;
  const planeCount = Math.min(collection.length, MAX_HARDWARE_CLIP_PLANES);

  for (let i = 0; i < planeCount; i++) {
    const plane = collection.get(i);
    const base = i * 4;
    if (!plane || !plane.normal) {
      out[base + 0] = 0;
      out[base + 1] = 0;
      out[base + 2] = 0;
      out[base + 3] = CLIP_DISTANCE_INACTIVE_SENTINEL;
      continue;
    }
    // FP64 precomputation: at Earth radius the normal-camera dot
    // product is order ~6e6 and the plane's `distance` is order
    // ~1e2 to ~1e6. Both fit comfortably in FP64 mantissa with no
    // precision loss; the FP32 store at the end loses ~0.4 m which
    // is below typical clipping tolerance.
    const nx: number = plane.normal.x;
    const ny: number = plane.normal.y;
    const nz: number = plane.normal.z;
    const d: number = plane.distance;
    out[base + 0] = nx;
    out[base + 1] = ny;
    out[base + 2] = nz;
    out[base + 3] = d + (nx * cx + ny * cy + nz * cz);
  }

  // Fill remaining slots with `(0,0,0,+Infinity)` so the rasterizer
  // never clips against them.
  for (let i = planeCount; i < MAX_HARDWARE_CLIP_PLANES; i++) {
    const base = i * 4;
    out[base + 0] = 0;
    out[base + 1] = 0;
    out[base + 2] = 0;
    out[base + 3] = CLIP_DISTANCE_INACTIVE_SENTINEL;
  }
}

/**
 * Debug-only round-trip assertion: for each plane in the collection,
 * verify that the precomputed `dPrime` reconstructs the original
 * model-space distance test within `DPRIME_ROUND_TRIP_TOLERANCE_METERS`
 * for the supplied test position.
 *
 * The standard test is `dist = dot(n, positionMC) + d`. The hardware
 * path computes `distHW = dot(n, positionMC - cameraMC) + dPrime
 *                    = dot(n, positionMC) - dot(n, cameraMC) + dPrime`.
 * For these to agree, `dPrime - dot(n, cameraMC) === d`, i.e. the
 * `dPrime = d + dot(n, cameraMC)` formula above. This assertion
 * exercises that algebraic identity end-to-end, so any future bug in
 * the packer (swapped slots, wrong sign, byte-offset drift) gets
 * caught at the call site instead of three frames later in a visual
 * regression.
 *
 * Wrap calls in `//>>includeStart('debug', pragmas.debug);` blocks at
 * the call site so this strips out of release builds.
 *
 * @param collection ClippingPlaneCollection
 * @param cameraInPlaneSpace Camera position used to compute dPrime
 * @param dPrimes The precomputed dPrime array
 * @param testPositionMC A test position to validate against (e.g., a
 *   tile center, or the camera position itself which makes the test
 *   trivially `dPrime - dot(n, camera) === d`)
 * @param label  Identifier for the error message
 */
export function assertClipPlaneDPrimeRoundTrip(
  collection: ClipPlaneCollectionLike | null | undefined,
  cameraInPlaneSpace: { x: number; y: number; z: number } | null | undefined,
  packedQuads: Float32Array,
  testPositionMC: { x: number; y: number; z: number },
  label: string,
): void {
  if (!collection || !cameraInPlaneSpace || collection.length === 0) {
    return;
  }
  const cx = cameraInPlaneSpace.x;
  const cy = cameraInPlaneSpace.y;
  const cz = cameraInPlaneSpace.z;
  const px = testPositionMC.x;
  const py = testPositionMC.y;
  const pz = testPositionMC.z;
  const planeCount = Math.min(collection.length, MAX_HARDWARE_CLIP_PLANES);

  for (let i = 0; i < planeCount; i++) {
    const plane = collection.get(i);
    if (!plane || !plane.normal) {
      continue;
    }
    const nx: number = plane.normal.x;
    const ny: number = plane.normal.y;
    const nz: number = plane.normal.z;
    const d: number = plane.distance;
    const base = i * 4;
    const dPrime = packedQuads[base + 3];

    // Original test: dot(n, p) + d
    const original = nx * px + ny * py + nz * pz + d;

    // Hardware test: dot(n, p - camera) + dPrime
    const ex = px - cx;
    const ey = py - cy;
    const ez = pz - cz;
    const hardware = nx * ex + ny * ey + nz * ez + dPrime;

    const drift = Math.abs(original - hardware);
    if (drift > DPRIME_ROUND_TRIP_TOLERANCE_METERS) {
      throw new Error(
        `[WebGPU:WGF-1] ${label}: clip plane ${i} dPrime round-trip drift ${drift.toExponential(3)} m ` +
          `exceeds ${DPRIME_ROUND_TRIP_TOLERANCE_METERS} m tolerance. ` +
          `original=${original} hardware=${hardware} ` +
          `n=(${nx},${ny},${nz}) d=${d} dPrime=${dPrime}. ` +
          `This usually means the dPrime packer wrote to the wrong slot or used the wrong camera frame.`,
      );
    }
  }
}
