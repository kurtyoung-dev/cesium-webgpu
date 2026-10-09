// velocity-texels.mjs — motion-vector texels read back from an rg16float target.
//
// @purpose Decode IEEE-754 binary16 velocity texels read back from an rg16float motion-vector target and count those whose magnitude clears a stated noise floor, over the whole target or inside one screen rectangle.
// @status ACTIVE
//
// WHY THIS EXISTS. `probe-polyline-taa-velocity.mjs` (AR-752) is the fleet's
// one probe that reads the WebGPU velocity target itself: `copyTextureToBuffer`
// on the scene framebuffer's `rg16float` attachment hands back raw half-floats,
// which neither `DataView` nor a typed array decodes, so the probe decodes them
// in Node rather than asking the page to convert (which would put the
// conversion inside the thing being measured). These functions were exported
// from that probe and pinned by `polyline-taa-velocity-emission.spec.mjs`; the
// probe-kit harvest moves them here so the next motion-vector question (a TAA
// family, a model or point velocity probe) reads velocity with the same
// decoder and the same noise floor instead of a second copy. The probe
// re-exports them, so every existing import keeps resolving.
//
// MOVED VERBATIM. The bodies are byte-for-byte the probe's pre-harvest
// functions, so the emission spec's A7, A8 and A12 cases and the descriptor
// walk keep asserting the same arithmetic.
//
// SELF-CONTAINED. Imports nothing: it reads half-float texels, not RGBA
// frames, so it needs none of `colour-mask.mjs`'s frame checks.

// A half-float whose magnitude is at or below this is treated as "no motion".
// The velocity FS writes an exact `vec2<f32>(0.0)` for fragments it rejects and
// for a first frame with no history, so the floor only has to clear rg16float's
// quantisation of a genuinely still fragment.
export const VELOCITY_NOISE_FLOOR = 1.0e-4;

/**
 * Decodes one IEEE-754 binary16 value from a 16-bit unsigned pattern.
 *
 * `copyTextureToBuffer` on an `rg16float` target hands back raw half-floats,
 * and neither `DataView` nor a typed array reads them, so the probe decodes
 * them itself rather than asking the page to convert (which would put the
 * conversion inside the thing being measured).
 *
 * @param {number} bits The 16-bit pattern.
 * @returns {number} The decoded value.
 */
export function decodeHalf(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) {
    return sign * mantissa * 2 ** -24;
  }
  if (exponent === 0x1f) {
    return mantissa ? Number.NaN : sign * Infinity;
  }
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

/**
 * Counts velocity texels whose motion clears the noise floor.
 *
 * @param {number[]} halves Flat `[r0, g0, r1, g1, …]` half-float patterns.
 * @param {number} [floor] Magnitude at or below which a texel counts as still.
 * @returns {{nonZero: number, total: number, maxMagnitude: number}} The counts.
 */
export function countNonZeroVelocityTexels(
  halves,
  floor = VELOCITY_NOISE_FLOOR,
) {
  let nonZero = 0;
  let maxMagnitude = 0;
  const total = Math.floor(halves.length / 2);
  for (let i = 0; i < total; i++) {
    const vx = decodeHalf(halves[i * 2]);
    const vy = decodeHalf(halves[i * 2 + 1]);
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
      continue;
    }
    const magnitude = Math.hypot(vx, vy);
    if (magnitude > maxMagnitude) {
      maxMagnitude = magnitude;
    }
    if (magnitude > floor) {
      nonZero += 1;
    }
  }
  return { nonZero, total, maxMagnitude };
}

/**
 * Counts velocity texels that clear the noise floor INSIDE one screen rectangle.
 *
 * Whole-frame counting cannot tell the polyline's motion vectors from those of
 * the positive control that shares the frame with it, so every velocity cell is
 * counted twice — once in the subject's rectangle and once in the control's.
 * The rectangle is inclusive on both corners and clamped to the target; an
 * absent or degenerate rectangle returns `invalid: true` rather than a zero
 * that would read like a measurement.
 *
 * @param {number[]} halves Flat `[r0, g0, r1, g1, …]` half-float patterns.
 * @param {number} width Target width in texels.
 * @param {number} height Target height in texels.
 * @param {{x0: number, y0: number, x1: number, y1: number}|null} region The rectangle.
 * @param {number} [floor] Magnitude at or below which a texel counts as still.
 * @returns {{nonZero: number, total: number, maxMagnitude: number, invalid?: boolean}} The counts.
 */
export function countNonZeroVelocityTexelsInRegion(
  halves,
  width,
  height,
  region,
  floor = VELOCITY_NOISE_FLOOR,
) {
  if (
    !region ||
    !Number.isFinite(region.x0) ||
    !Number.isFinite(region.y0) ||
    !Number.isFinite(region.x1) ||
    !Number.isFinite(region.y1) ||
    !(width > 0) ||
    !(height > 0)
  ) {
    return { nonZero: 0, total: 0, maxMagnitude: 0, invalid: true };
  }
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(region.x0)));
  const x1 = Math.max(0, Math.min(width - 1, Math.ceil(region.x1)));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(region.y0)));
  const y1 = Math.max(0, Math.min(height - 1, Math.ceil(region.y1)));
  if (x1 < x0 || y1 < y0) {
    return { nonZero: 0, total: 0, maxMagnitude: 0, invalid: true };
  }
  let nonZero = 0;
  let maxMagnitude = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const index = (y * width + x) * 2;
      if (index + 1 >= halves.length) {
        continue;
      }
      const vx = decodeHalf(halves[index]);
      const vy = decodeHalf(halves[index + 1]);
      total += 1;
      if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
        continue;
      }
      const magnitude = Math.hypot(vx, vy);
      if (magnitude > maxMagnitude) {
        maxMagnitude = magnitude;
      }
      if (magnitude > floor) {
        nonZero += 1;
      }
    }
  }
  return { nonZero, total, maxMagnitude };
}
