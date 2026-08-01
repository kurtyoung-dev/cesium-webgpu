/**
 * Campaign 13 C13-06 — the single RTE/WGS84 frame owner for the cloud beer
 * shadow map and every consumer that reads it.
 *
 * Before this module each consumer of the cloud shadow map carried its own
 * approximation of where the cloud deck is:
 *
 * - the producer projected the camera onto a `6378137` m SPHERE to centre the
 *   sun-view footprint, then intersected two more spheres of the same
 *   equatorial radius for the deck shell. WGS84's polar semi-minor axis is
 *   ~21.4 km shorter, which is several deck thicknesses — at high latitude the
 *   shadow pass marched empty space above the deck the visible march renders,
 *   so the cast shadow silently vanished;
 * - the producer and all three consumers multiplied a full-magnitude ECEF
 *   `vec3<f32>` by an `f32` matrix whose translation column was itself ~6.4e6 m
 *   (`mvp * vec4(position, 1.0)`), which the fork's RTE law forbids.
 *
 * The frame below is computed once per frame in CPU `f64` and is the ONLY
 * source of the shadow projection. Its origin is the camera position — the same
 * origin `CloudUniforms.encodedCameraHigh/Low` (C13-04) and the density origin
 * phases (C13-37) already use, so the shadow producer samples the density field
 * through the identical camera-relative coordinate the visible march uses.
 *
 * Contract:
 *
 * - producer: `invVpRelativeToEye * vec4(ndc, 1)` yields a CAMERA-RELATIVE
 *   column point. Every downstream quantity (shell roots, height fraction,
 *   density coordinates) stays camera-relative;
 * - consumer: `vpRelativeToEye * vec4(fragment - camera, 1)` is algebraically
 *   identical to the absolute `vp * vec4(fragment, 1)` but never forms a
 *   planet-scale `f32` product. Each consumer packs the matrix against ITS OWN
 *   camera, so consumers with different cameras remain consistent;
 * - `writeCloudShadowViewProjection` retains the absolute form for the planar
 *   scene modes, whose fragments have no ECEF camera-relative position. That
 *   branch is byte-identical to the pre-C13-06 matrix.
 *
 * The module is deliberately dependency-free `f64` arithmetic so the Node
 * contract spec can exercise it directly (same pattern as
 * `WebGPUCloudDensityDomain.ts` and `WebGPUCloudTemporalHistory.ts`).
 */

/** WGS84 semi-major axis (m) — the default cloud-shell equatorial radius. */
export const CLOUD_SHADOW_WGS84_A = 6378137.0;

/** WGS84 semi-minor axis (m). The ~21.4 km the spherical producer ignored. */
export const CLOUD_SHADOW_WGS84_B = 6356752.314245179;

/**
 * Newton tolerance for the geodetic surface projection, matching
 * `Ellipsoid.scaleToGeodeticSurface`'s `EPSILON12` convergence test.
 */
const GEODETIC_SURFACE_EPSILON = 1e-12;

/** Iteration ceiling — a permanent loop sentinel (CLAUDE.md). */
const GEODETIC_SURFACE_MAX_ITERATIONS = 32;

/**
 * Below this squared ellipsoid norm the Newton iteration cannot converge and
 * the radial intersection is returned instead. Matches Cesium's
 * `Ellipsoid._centerToleranceSquared` (`CesiumMath.EPSILON1`).
 */
const GEODETIC_SURFACE_CENTER_TOLERANCE_SQUARED = 0.1;

/**
 * The sun-view frame for one cloud-shadow footprint.
 *
 * All fields are CPU `f64`. Nothing here is uploaded directly; the two writers
 * below derive the `f32` matrices consumers receive.
 */
export interface CloudShadowFrame {
  /** False when the camera/sun inputs could not produce a usable frame. */
  valid: boolean;
  /** WGS84 geodetic surface point under the camera (footprint centre, ECEF m). */
  centerX: number;
  centerY: number;
  centerZ: number;
  /** Unit vector pointing TOWARD the sun. */
  sunX: number;
  sunY: number;
  sunZ: number;
  /** Orthonormal sun-view basis rows: right, up, back (back == sun direction). */
  rightX: number;
  rightY: number;
  rightZ: number;
  upX: number;
  upY: number;
  upZ: number;
  backX: number;
  backY: number;
  backZ: number;
  /** Ortho eye, pushed `distance` up the sun ray from the footprint centre. */
  eyeX: number;
  eyeY: number;
  eyeZ: number;
  /** Sun-view ortho half-extent (m) — half the square footprint width. */
  halfExtent: number;
  /** Eye offset along the sun ray (m). */
  distance: number;
  /** Ortho near/far planes (m). */
  near: number;
  far: number;
}

/** Allocate one reusable frame. Callers keep these on their render cache. */
export function createCloudShadowFrame(): CloudShadowFrame {
  return {
    valid: false,
    centerX: 0,
    centerY: 0,
    centerZ: 0,
    sunX: 0,
    sunY: 0,
    sunZ: 1,
    rightX: 1,
    rightY: 0,
    rightZ: 0,
    upX: 0,
    upY: 1,
    upZ: 0,
    backX: 0,
    backY: 0,
    backZ: 1,
    eyeX: 0,
    eyeY: 0,
    eyeZ: 0,
    halfExtent: 1,
    distance: 1,
    near: 1,
    far: 2,
  };
}

/**
 * Project an ECEF point onto the WGS84 (or any biaxial) ellipsoid along its
 * geodetic normal.
 *
 * This is the fixed-point Newton iteration `Ellipsoid.scaleToGeodeticSurface`
 * uses, re-expressed in scalars so no `Cartesian3` is allocated on the frame
 * path. It replaces the producer's `position / |position| * 6378137`, which is
 * a SPHERE projection and therefore up to ~21.4 km off in the radial direction
 * at the poles.
 *
 * Returns the three scale multipliers packed into `out` (x, y, z surface
 * point), or `false` when the input is degenerate (at/near the centre).
 */
export function scaleToGeodeticSurface(
  out: { x: number; y: number; z: number },
  positionX: number,
  positionY: number,
  positionZ: number,
  equatorialRadius: number,
  polarRadius: number,
): boolean {
  const oneOverA = 1.0 / equatorialRadius;
  const oneOverB = 1.0 / polarRadius;
  const oneOverA2 = oneOverA * oneOverA;
  const oneOverB2 = oneOverB * oneOverB;

  // Squared normalized components: (x/a)^2, (y/a)^2, (z/b)^2.
  const x2 = positionX * positionX * oneOverA2;
  const y2 = positionY * positionY * oneOverA2;
  const z2 = positionZ * positionZ * oneOverB2;

  const squaredNorm = x2 + y2 + z2;
  // `ratio` is the RECIPROCAL ellipsoid norm, matching Cesium's
  // `scaleToGeodeticSurface`. Using the norm itself instead makes the initial
  // lambda guess wrong by the square of the norm and the Newton iteration
  // diverges to Infinity for any point more than a few thousand km up.
  const ratio = Math.sqrt(1.0 / squaredNorm);
  if (!Number.isFinite(ratio)) {
    return false;
  }

  // Radial intersection with the ellipsoid; the gradient there stands in for
  // the true surface normal (the magnitude difference is absorbed by lambda).
  const intersectionX = positionX * ratio;
  const intersectionY = positionY * ratio;
  const intersectionZ = positionZ * ratio;
  if (squaredNorm < GEODETIC_SURFACE_CENTER_TOLERANCE_SQUARED) {
    // Too close to the centre for the iteration to converge; the radial
    // intersection is already the answer Cesium returns there.
    out.x = intersectionX;
    out.y = intersectionY;
    out.z = intersectionZ;
    return true;
  }
  const gradientX = intersectionX * oneOverA2 * 2.0;
  const gradientY = intersectionY * oneOverA2 * 2.0;
  const gradientZ = intersectionZ * oneOverB2 * 2.0;
  const gradientMagnitude = Math.hypot(gradientX, gradientY, gradientZ);
  if (gradientMagnitude === 0.0) {
    return false;
  }

  const positionMagnitude = Math.hypot(positionX, positionY, positionZ);
  let lambda = ((1.0 - ratio) * positionMagnitude) / (0.5 * gradientMagnitude);
  let correction = 0.0;
  let func = 0.0;
  let xMultiplier = 1.0;
  let yMultiplier = 1.0;
  let zMultiplier = 1.0;

  for (
    let iteration = 0;
    iteration < GEODETIC_SURFACE_MAX_ITERATIONS;
    iteration++
  ) {
    lambda -= correction;

    xMultiplier = 1.0 / (1.0 + lambda * oneOverA2);
    yMultiplier = 1.0 / (1.0 + lambda * oneOverA2);
    zMultiplier = 1.0 / (1.0 + lambda * oneOverB2);

    const xMultiplier2 = xMultiplier * xMultiplier;
    const yMultiplier2 = yMultiplier * yMultiplier;
    const zMultiplier2 = zMultiplier * zMultiplier;

    func = x2 * xMultiplier2 + y2 * yMultiplier2 + z2 * zMultiplier2 - 1.0;
    if (Math.abs(func) <= GEODETIC_SURFACE_EPSILON) {
      break;
    }

    const denominator =
      x2 * xMultiplier2 * xMultiplier * oneOverA2 +
      y2 * yMultiplier2 * yMultiplier * oneOverA2 +
      z2 * zMultiplier2 * zMultiplier * oneOverB2;
    const derivative = -2.0 * denominator;
    if (derivative === 0.0) {
      return false;
    }
    correction = func / derivative;
  }

  out.x = positionX * xMultiplier;
  out.y = positionY * yMultiplier;
  out.z = positionZ * zMultiplier;
  return true;
}

const scratchSurface = { x: 0, y: 0, z: 0 };

/**
 * Recompute `frame` for this camera/sun/footprint.
 *
 * `halfExtent` is the sun-view ortho half-width in metres (the cascade tiers
 * pass their own). `equatorialRadius`/`polarRadius` are the rendered
 * ellipsoid's axes so a custom ellipsoid stays correct.
 *
 * Returns `false` (and leaves `frame.valid === false`) when the inputs cannot
 * produce a frame; callers must then leave the shadow feature inert rather than
 * uploading a garbage matrix.
 */
export function computeCloudShadowFrame(
  frame: CloudShadowFrame,
  cameraX: number,
  cameraY: number,
  cameraZ: number,
  sunX: number,
  sunY: number,
  sunZ: number,
  halfExtent: number,
  equatorialRadius: number,
  polarRadius: number,
): boolean {
  frame.valid = false;

  const sunLength = Math.hypot(sunX, sunY, sunZ);
  if (!(sunLength > 0.0) || !(halfExtent > 0.0)) {
    return false;
  }
  const sx = sunX / sunLength;
  const sy = sunY / sunLength;
  const sz = sunZ / sunLength;

  if (
    !scaleToGeodeticSurface(
      scratchSurface,
      cameraX,
      cameraY,
      cameraZ,
      equatorialRadius,
      polarRadius,
    )
  ) {
    return false;
  }
  const centerX = scratchSurface.x;
  const centerY = scratchSurface.y;
  const centerZ = scratchSurface.z;

  // Push the ortho eye up the sun ray far enough that the near plane clears the
  // deck top and the far plane passes below the surface.
  const distance = halfExtent * 2.0 + 12000.0;
  const eyeX = centerX + sx * distance;
  const eyeY = centerY + sy * distance;
  const eyeZ = centerZ + sz * distance;

  // Right-handed lookAt along -sunDir. `back` is the eye-space +z axis, which
  // equals the sun direction because forward is -sunDir.
  const fx = -sx;
  const fy = -sy;
  const fz = -sz;
  let upRefX = 0.0;
  let upRefY = 0.0;
  let upRefZ = 1.0;
  if (Math.abs(fz) > 0.99) {
    upRefX = 0.0;
    upRefY = 1.0;
    upRefZ = 0.0;
  }
  let rightX = fy * upRefZ - fz * upRefY;
  let rightY = fz * upRefX - fx * upRefZ;
  let rightZ = fx * upRefY - fy * upRefX;
  const rightLength = Math.hypot(rightX, rightY, rightZ);
  if (!(rightLength > 0.0)) {
    return false;
  }
  rightX /= rightLength;
  rightY /= rightLength;
  rightZ /= rightLength;
  const upX = rightY * fz - rightZ * fy;
  const upY = rightZ * fx - rightX * fz;
  const upZ = rightX * fy - rightY * fx;

  frame.centerX = centerX;
  frame.centerY = centerY;
  frame.centerZ = centerZ;
  frame.sunX = sx;
  frame.sunY = sy;
  frame.sunZ = sz;
  frame.rightX = rightX;
  frame.rightY = rightY;
  frame.rightZ = rightZ;
  frame.upX = upX;
  frame.upY = upY;
  frame.upZ = upZ;
  frame.backX = sx;
  frame.backY = sy;
  frame.backZ = sz;
  frame.eyeX = eyeX;
  frame.eyeY = eyeY;
  frame.eyeZ = eyeZ;
  frame.halfExtent = halfExtent;
  frame.distance = distance;
  frame.near = 1.0;
  frame.far = distance * 2.0;
  frame.valid = true;
  return true;
}

/**
 * Write the world→sun-clip matrix (column-major, 16 floats).
 *
 * Retained for the planar scene modes, whose globe fragments carry no ECEF
 * camera-relative position. Identical to the pre-C13-06 matrix except that the
 * footprint centre is now geodetic.
 */
export function writeCloudShadowViewProjection(
  target: Float32Array,
  targetOffset: number,
  frame: CloudShadowFrame,
): void {
  writeCloudShadowViewProjectionRelativeToEye(
    target,
    targetOffset,
    frame,
    0,
    0,
    0,
  );
}

/**
 * Write `viewProjection * translate(eye)` (column-major, 16 floats).
 *
 * The shader evaluates `matrix * vec4(fragmentWorld - eye, 1.0)`. The large
 * `-R*orthoEye` translation and the caller's eye cancel here in `f64`, so no
 * planet-scale magnitude ever reaches an `f32` matrix entry or an `f32`
 * position operand.
 */
export function writeCloudShadowViewProjectionRelativeToEye(
  target: Float32Array,
  targetOffset: number,
  frame: CloudShadowFrame,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
): void {
  if (!frame.valid) {
    writeIdentity(target, targetOffset);
    return;
  }

  const inverseHalfExtent = 1.0 / frame.halfExtent;
  const inverseFarMinusNear = 1.0 / (frame.far - frame.near);

  // The eye-relative translation column is `P * V * (eye, 1)`. Forming
  // `eye - orthoEye` first keeps every term bounded by the ortho distance plus
  // the camera altitude instead of the ~6.4e6 m ECEF magnitude.
  const dx = eyeX - frame.eyeX;
  const dy = eyeY - frame.eyeY;
  const dz = eyeZ - frame.eyeZ;
  const rightDotD = frame.rightX * dx + frame.rightY * dy + frame.rightZ * dz;
  const upDotD = frame.upX * dx + frame.upY * dy + frame.upZ * dz;
  const backDotD = frame.backX * dx + frame.backY * dy + frame.backZ * dz;

  // Column-major: column c, row r → target[4c + r].
  target[targetOffset + 0] = Math.fround(frame.rightX * inverseHalfExtent);
  target[targetOffset + 1] = Math.fround(frame.upX * inverseHalfExtent);
  target[targetOffset + 2] = Math.fround(-frame.backX * inverseFarMinusNear);
  target[targetOffset + 3] = 0.0;

  target[targetOffset + 4] = Math.fround(frame.rightY * inverseHalfExtent);
  target[targetOffset + 5] = Math.fround(frame.upY * inverseHalfExtent);
  target[targetOffset + 6] = Math.fround(-frame.backY * inverseFarMinusNear);
  target[targetOffset + 7] = 0.0;

  target[targetOffset + 8] = Math.fround(frame.rightZ * inverseHalfExtent);
  target[targetOffset + 9] = Math.fround(frame.upZ * inverseHalfExtent);
  target[targetOffset + 10] = Math.fround(-frame.backZ * inverseFarMinusNear);
  target[targetOffset + 11] = 0.0;

  target[targetOffset + 12] = Math.fround(rightDotD * inverseHalfExtent);
  target[targetOffset + 13] = Math.fround(upDotD * inverseHalfExtent);
  target[targetOffset + 14] = Math.fround(
    -(backDotD + frame.near) * inverseFarMinusNear,
  );
  target[targetOffset + 15] = 1.0;
}

/**
 * Write `translate(-eye) * inverse(viewProjection)` (column-major, 16 floats).
 *
 * The shadow fragment shader evaluates `matrix * vec4(ndc, 1.0)` and receives a
 * CAMERA-RELATIVE column point directly, so it never reconstructs a full-ECEF
 * `f32` position before intersecting the deck shells.
 */
export function writeCloudShadowInverseViewProjectionRelativeToEye(
  target: Float32Array,
  targetOffset: number,
  frame: CloudShadowFrame,
  eyeX: number,
  eyeY: number,
  eyeZ: number,
): void {
  if (!frame.valid) {
    writeIdentity(target, targetOffset);
    return;
  }

  const halfExtent = frame.halfExtent;
  const negativeDepthRange = -(frame.far - frame.near);

  // `orthoEye - eye` plus the near-plane step along `back`: bounded by the
  // ortho distance and the caller's altitude, never by the planet radius.
  const ox = frame.eyeX - eyeX - frame.backX * frame.near;
  const oy = frame.eyeY - eyeY - frame.backY * frame.near;
  const oz = frame.eyeZ - eyeZ - frame.backZ * frame.near;

  target[targetOffset + 0] = Math.fround(frame.rightX * halfExtent);
  target[targetOffset + 1] = Math.fround(frame.rightY * halfExtent);
  target[targetOffset + 2] = Math.fround(frame.rightZ * halfExtent);
  target[targetOffset + 3] = 0.0;

  target[targetOffset + 4] = Math.fround(frame.upX * halfExtent);
  target[targetOffset + 5] = Math.fround(frame.upY * halfExtent);
  target[targetOffset + 6] = Math.fround(frame.upZ * halfExtent);
  target[targetOffset + 7] = 0.0;

  target[targetOffset + 8] = Math.fround(frame.backX * negativeDepthRange);
  target[targetOffset + 9] = Math.fround(frame.backY * negativeDepthRange);
  target[targetOffset + 10] = Math.fround(frame.backZ * negativeDepthRange);
  target[targetOffset + 11] = 0.0;

  target[targetOffset + 12] = Math.fround(ox);
  target[targetOffset + 13] = Math.fround(oy);
  target[targetOffset + 14] = Math.fround(oz);
  target[targetOffset + 15] = 1.0;
}

function writeIdentity(target: Float32Array, targetOffset: number): void {
  for (let i = 0; i < 16; i++) {
    target[targetOffset + i] = i % 5 === 0 ? 1.0 : 0.0;
  }
}
