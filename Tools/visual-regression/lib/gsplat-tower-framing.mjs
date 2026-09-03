// gsplat-tower-framing.mjs — pure C15-G7 tower/terrain camera-framing math.
// @purpose Derive the camera range that keeps the tower splat anchor and its terrain-reference anchor inside the same frustum from their real geodetic separation, and decide whether a captured tower silhouette clears the pre-registered pixel floor.
// @status ACTIVE
//
// The probe's tower and its terrain-reference point are separated almost
// entirely by ALTITUDE, not by the ground-classification footprint. Measured
// against the real `tower/tileset.json` asset: the tower's own
// bounding-sphere radius is 38.47 m, its geodetic height above its own
// ellipsoid-surface projection is 2851.95 m, and the bounding sphere built
// from the tower, that projection, and the footprint polygon's four corners
// has a radius of 1428.00 m -- 37.1x the tower's own radius, not the ~1.77x
// a footprint-corner-only sphere would produce. That smaller ratio only
// holds if the tileset sits at ellipsoid height 0, which this asset does
// not. The footprint corners (`halfWidth * sqrt(2)`, about 68 m from the
// terrain point) contribute a small fraction of the 1428 m; the 2851.95 m
// altitude term dominates it.
//
// The camera's look-at target is therefore the true midpoint between the
// tower's own bounding-sphere center and its terrain-reference point --
// not a bounding sphere whose radius happens to be dominated by that same
// altitude gap -- and the range is derived directly from that altitude
// separation and the camera's live vertical field of view, so both anchors
// project inside the frustum by construction rather than as an accident of
// an unrelated formula. `marginFraction` caps how much of the vertical
// half-angle the farther anchor is allowed to occupy; a value below 1
// leaves headroom for the footprint corners and floating-point slack.
//
// This module's arithmetic is pure numbers -- it reads no Cesium types. The
// probe cannot import it into the function Playwright's `page.evaluate`
// serializes (no closure over outer module bindings survives that boundary;
// see the probe's own header), so `marginFraction` travels into the page as
// data and the one-line range formula is duplicated verbatim there.
// `evaluateGsplatClassificationDepth` closes that gap on every real run: it
// recomputes the expected range from the recorded
// verticalSeparationMeters/fovYRadians/marginFraction telemetry via
// `computeTowerTerrainRange` and raises a structural failure if the page's
// actual range does not match, so this function has a live production
// consumer, not only its own spec.
//
// WHAT THIS FIX DOES NOT CLAIM. Restoring both anchors to the frustum (this
// module, plus the probe's target change) is a proven, Node-verifiable
// geometric fact. Whether the tower silhouette clears the pre-registered
// `minimumTowerMaskPixels` floor once this framing renders for real is a
// rendering fact only the Edge probe re-run can establish -- the floor
// guard below exists precisely so a shortfall REFUSES (STRUCTURAL) rather
// than silently passing or misreporting a product FAIL.

export const TOWER_FRAMING_CONFIG = Object.freeze({
  // Fraction of the vertical half field-of-view the farther of the two
  // anchors (tower or terrain-reference) is allowed to occupy. Kept below 1
  // so the frustum boundary is never approached exactly; at this asset's
  // geometry 0.85 leaves the tower -- the anchor closer to the frustum edge
  // under the probe's -20 degree pitch -- about 8-9 degrees of margin.
  marginFraction: 0.85,
  // Pre-registered floor: below this many rendered tower-silhouette pixels,
  // the splat-overlap positive legs cannot be exercised meaningfully, so the
  // run must refuse (STRUCTURAL) rather than let a near-empty mask read as
  // either a pass or a genuine product FAIL. This is independent of the
  // noise-derived signal floor already checked elsewhere (that one guards
  // against measurement noise swamping a real signal; this one guards
  // against a technically-nonzero mask that still isn't "the tower filling a
  // useful fraction of the capture").
  minimumTowerMaskPixels: 100,
});

/**
 * Camera range (world units) that keeps two anchors separated by
 * `verticalSeparationMeters` -- symmetrically placed around the look-at
 * target -- inside a frustum with vertical field of view `fovYRadians`,
 * using at most `marginFraction` of the vertical half-angle.
 *
 * @param {number} verticalSeparationMeters World-space distance between the
 *   two anchors (here: the tower's bounding-sphere center and its
 *   terrain-reference point).
 * @param {number} fovYRadians The camera's live vertical field of view.
 * @param {number} [marginFraction] Fraction of the vertical half-angle the
 *   farther anchor may occupy.
 * @returns {number} Camera range, in the same units as the separation.
 */
export function computeTowerTerrainRange(
  verticalSeparationMeters,
  fovYRadians,
  marginFraction = TOWER_FRAMING_CONFIG.marginFraction,
) {
  if (
    !Number.isFinite(verticalSeparationMeters) ||
    verticalSeparationMeters <= 0
  ) {
    throw new RangeError(
      `verticalSeparationMeters must be a positive finite number, got ${verticalSeparationMeters}`,
    );
  }
  if (
    !Number.isFinite(fovYRadians) ||
    fovYRadians <= 0 ||
    fovYRadians >= Math.PI
  ) {
    throw new RangeError(
      `fovYRadians must be a finite number in (0, PI), got ${fovYRadians}`,
    );
  }
  if (
    !Number.isFinite(marginFraction) ||
    marginFraction <= 0 ||
    marginFraction > 1
  ) {
    throw new RangeError(
      `marginFraction must be a finite number in (0, 1], got ${marginFraction}`,
    );
  }
  const halfFovY = fovYRadians / 2;
  return verticalSeparationMeters / 2 / (marginFraction * Math.tan(halfFovY));
}

/**
 * Decide whether a captured tower mask clears the pre-registered pixel
 * floor. Below the floor, the caller must refuse (STRUCTURAL) rather than
 * evaluate the splat-overlap positive legs against a mask too small to carry
 * a meaningful verdict either way.
 *
 * @param {number} towerMaskPixels Measured tower-silhouette pixel count.
 * @param {number} [floor] Pre-registered minimum pixel count.
 * @returns {{ok: boolean, floor: number, reason: (string|null)}} `reason` is
 *   the STRUCTURAL reason token to record when `ok` is false, `null` when
 *   the floor is cleared.
 */
export function evaluateTowerMaskFloor(
  towerMaskPixels,
  floor = TOWER_FRAMING_CONFIG.minimumTowerMaskPixels,
) {
  const ok = Number.isInteger(towerMaskPixels) && towerMaskPixels >= floor;
  return {
    ok,
    floor,
    reason: ok ? null : "tower-mask:below-framing-floor",
  };
}

export default {
  TOWER_FRAMING_CONFIG,
  computeTowerTerrainRange,
  evaluateTowerMaskFloor,
};
