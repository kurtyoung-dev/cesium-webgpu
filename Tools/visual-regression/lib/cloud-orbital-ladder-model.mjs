/**
 * C13-N04b — the orbital ladder's statistics, as pure functions.
 * @purpose O3 aerial-cap fraction, O4 limb step, O6 decade retention and zoom flicker, O7 limb sample spacing — computed from uniforms and pixels, with each bar's basis stated.
 * @status ACTIVE
 *
 * WHY THE MODEL IS NOT IN THE PROBE. Campaign 13 v2 files `C13-N04b` so that
 * "the instrument exists BEFORE the rows it judges" — `C13-N20` (aerial clamp)
 * is graded on **O3 = 0 measured by C13-N04b, not an eyeballed capture pair**,
 * and `C13-N13` on **O7**. A statistic that lives inside a Playwright probe can
 * only be checked by spending an Edge cycle, which is the same failure
 * `lib/cloud-tour-fixtures.mjs` was split out to avoid. Everything here is
 * arithmetic over numbers the page hands back, so it is checkable in
 * milliseconds and the Edge run is left to do only what needs a GPU.
 *
 * TWO KINDS OF STATISTIC, AND THE DIFFERENCE MATTERS.
 *   - **Derivable** (O3, O7): computed from uniforms and geometry. These are
 *     EXACT — no capture, no threshold on a pixel count, nothing a lighting
 *     change can move. O7 is `chord / steps`; O3 is a comparison of two
 *     distances. A derivable bar cannot be argued with, which is why the plan
 *     says O7 is "derivable from uniforms" and why O3 is "1.0 by construction".
 *   - **Measured** (O4, O6): computed from captured pixels, and therefore
 *     carrying a capture's noise. Each names its ROI and its normalization.
 * A verdict says which kind it is, because a reader who cannot tell a derived
 * number from a measured one cannot tell a real regression from a re-capture.
 *
 * NOTHING HERE PRE-REGISTERS A THRESHOLD THE PLAN DID NOT STATE. The four bars
 * carry the numbers §1.3 gives them (O3 = 0 at h >= 200 km; O4 <= 10 %; O6 >= 90 %
 * per decade and < 5 % RMS; O7 <= 2 km). Where the plan says "derive", this
 * module computes and reports and does NOT invent a pass line — `C13-N47` is
 * the row that lands derived thresholds.
 *
 * @module cloud-orbital-ladder-model
 */

/** WGS84 equatorial radius. A parameter everywhere, never assumed silently. */
export const WGS84_EQUATORIAL_RADIUS_METRES = 6378137;

/**
 * The ladder: one rung per decade from 20 km to 20,000 km, the range §1.3's O6
 * names. 20 km is the top of the in-atmosphere band; 20,000 km is above
 * geostationary, where the whole disc is in frame.
 */
export const ALTITUDE_LADDER_METRES = Object.freeze([
  20_000, 200_000, 2_000_000, 20_000_000,
]);

/**
 * The shader constants O3 is a statement about, read here so the model and the
 * shader can be shown to disagree rather than quietly diverging.
 * `ProceduralClouds.wgsl:2658`: `clamp(midDist / 60000.0 * cloud.aerialStrength,
 * 0.0, 0.85)`.
 */
export const AERIAL_HEURISTIC = Object.freeze({
  hazeScaleMetres: 60_000,
  cap: 0.85,
  citedAs: "ProceduralClouds.wgsl:2658",
});

/** The bars, verbatim from Campaign 13 v2 §1.3. */
export const ORBITAL_BARS = Object.freeze({
  O3: Object.freeze({
    id: "O3",
    statistic: "fraction of cloud pixels at the aerial cap",
    target: 0,
    appliesAboveMetres: 200_000,
    kind: "derivable",
  }),
  O4: Object.freeze({
    id: "O4",
    statistic:
      "max luminance step across any 2-px window within 5 deg of the limb, over the local mean",
    target: 0.1,
    kind: "measured",
  }),
  O6: Object.freeze({
    id: "O6",
    statistic:
      "mean cloud alpha per decade relative to the 20 km rung; RMS per-frame dL over a 10 s zoom",
    retentionTarget: 0.9,
    zoomRmsTarget: 0.05,
    kind: "measured",
  }),
  O7: Object.freeze({
    id: "O7",
    statistic: "metre spacing between fine samples along the limb chord",
    targetMetres: 2_000,
    kind: "derivable",
  }),
});

function finite(value, what) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(
      `${what} must be a finite number, received ${String(value)}`,
    );
  }
  return value;
}

// ── O7 — sampling adequacy along the limb chord ─────────────────────────────

/**
 * Length of the ray that grazes the planet and crosses the cloud deck.
 *
 * A ray tangent to the sphere of radius `R + bottom` re-emerges from the shell
 * of radius `R + top` after `2 * sqrt((R+top)^2 - (R+bottom)^2)`. This is the
 * LONGEST path any primary ray takes through the deck, which is what makes it
 * the right denominator for a sampling-adequacy bar: if the spacing is adequate
 * here it is adequate everywhere.
 *
 * At a 4 km deck top over WGS84 this is 451.8 km, reproducing the figure §1.3
 * quotes ("chord 451 km at a 4 km deck top").
 */
export function limbChordMetres({
  deckTopMetres,
  deckBottomMetres = 0,
  planetRadiusMetres = WGS84_EQUATORIAL_RADIUS_METRES,
}) {
  finite(deckTopMetres, "deckTopMetres");
  finite(deckBottomMetres, "deckBottomMetres");
  finite(planetRadiusMetres, "planetRadiusMetres");
  if (!(deckTopMetres > deckBottomMetres)) {
    throw new RangeError(
      `deckTopMetres ${deckTopMetres} must exceed deckBottomMetres ${deckBottomMetres}`,
    );
  }
  const outer = planetRadiusMetres + deckTopMetres;
  const inner = planetRadiusMetres + deckBottomMetres;
  return 2 * Math.sqrt(outer * outer - inner * inner);
}

/**
 * O7: metres between consecutive primary samples along that chord.
 *
 * `primarySteps` is the live step count — uniform slot 44 (`maxSteps`), which
 * is what the march divides its interval by. Reading it rather than a preset
 * literal is the whole point: `C13-N10` exists because the two disagree today.
 */
export function evaluateO7({
  primarySteps,
  deckTopMetres,
  deckBottomMetres = 0,
  planetRadiusMetres = WGS84_EQUATORIAL_RADIUS_METRES,
  targetMetres = ORBITAL_BARS.O7.targetMetres,
}) {
  finite(primarySteps, "primarySteps");
  if (!(primarySteps >= 1)) {
    throw new RangeError(`primarySteps must be >= 1, received ${primarySteps}`);
  }
  const chordMetres = limbChordMetres({
    deckTopMetres,
    deckBottomMetres,
    planetRadiusMetres,
  });
  const spacingMetres = chordMetres / primarySteps;
  return {
    bar: "O7",
    kind: "derivable",
    chordMetres,
    primarySteps,
    spacingMetres,
    targetMetres,
    pass: spacingMetres <= targetMetres,
    stepsRequired: Math.ceil(chordMetres / targetMetres),
  };
}

// ── O3 — aerial-cap saturation ──────────────────────────────────────────────

/**
 * Range at which the heuristic aerial term reaches its clamp.
 *
 * `aerial = clamp(midDist / 60000 * aerialStrength, 0, 0.85)` saturates once
 * `midDist >= 0.85 * 60000 / aerialStrength` — 51 km at the neutral strength of
 * 1.0. Beyond it every cloud pixel is 85 % horizon tint regardless of range, so
 * range stops reaching the image at all.
 */
export function aerialCapDistanceMetres({
  aerialStrength,
  hazeScaleMetres = AERIAL_HEURISTIC.hazeScaleMetres,
  cap = AERIAL_HEURISTIC.cap,
}) {
  finite(aerialStrength, "aerialStrength");
  if (!(aerialStrength > 0)) {
    // Strength 0 disables the term; nothing ever caps.
    return Number.POSITIVE_INFINITY;
  }
  return (cap * hazeScaleMetres) / aerialStrength;
}

/**
 * The SHORTEST march midpoint distance anywhere on the disc, for a camera at
 * `cameraAltitudeMetres` looking down.
 *
 * The nadir ray is the shortest path to the deck, so its midpoint
 * `h - 0.5 * (top + bottom)` is a lower bound over the whole disc. That is what
 * makes the conclusion below airtight rather than a sample: if even the closest
 * pixel is past the cap, EVERY cloud pixel is, and the capped fraction is
 * exactly 1 — no capture required, and no threshold to argue about.
 */
export function minimumMarchMidDistanceMetres({
  cameraAltitudeMetres,
  deckTopMetres,
  deckBottomMetres = 0,
}) {
  finite(cameraAltitudeMetres, "cameraAltitudeMetres");
  finite(deckTopMetres, "deckTopMetres");
  finite(deckBottomMetres, "deckBottomMetres");
  return cameraAltitudeMetres - 0.5 * (deckTopMetres + deckBottomMetres);
}

/**
 * O3, derived. Returns the capped fraction where it is provable (1 when the
 * nearest pixel is already capped, 0 when the FARTHEST possible midpoint is
 * still short of the cap) and `null` in between, where only a capture can say.
 *
 * Refusing to guess in the middle band is deliberate: `C13-N20`'s acceptance is
 * "O3 = 0 measured by C13-N04b", and a model that interpolated a fraction it
 * could not derive would be handing that row a number nobody measured.
 */
export function evaluateO3({
  cameraAltitudeMetres,
  deckTopMetres,
  deckBottomMetres = 0,
  aerialStrength,
  imageCappedFraction = null,
  appliesAboveMetres = ORBITAL_BARS.O3.appliesAboveMetres,
}) {
  const capDistance = aerialCapDistanceMetres({ aerialStrength });
  const nearest = minimumMarchMidDistanceMetres({
    cameraAltitudeMetres,
    deckTopMetres,
    deckBottomMetres,
  });
  // Only the "everything is capped" side is derivable: the nadir ray is the
  // SHORTEST path on the disc, so if it is past the cap so is every other ray
  // and the fraction is exactly 1. The converse does not follow — a nadir ray
  // short of the cap says nothing about the grazing rays near the limb, which
  // are much longer. Below the threshold the answer is `null` and the image leg
  // is the only evidence. Interpolating here would hand `C13-N20` a number
  // nobody measured.
  const derived = nearest >= capDistance ? 1 : null;
  const applies = cameraAltitudeMetres >= appliesAboveMetres;
  return {
    bar: "O3",
    kind: "derivable",
    cameraAltitudeMetres,
    aerialStrength,
    capDistanceMetres: capDistance,
    nearestMidDistanceMetres: nearest,
    derivedCappedFraction: derived,
    imageCappedFraction,
    applies,
    // A bar that does not apply at this rung is neither passed nor failed.
    pass: !applies
      ? null
      : derived === null
        ? null
        : derived <= ORBITAL_BARS.O3.target,
  };
}

export { imageAerialCapFraction } from "./metrics/region-means.mjs";

// ── O4 — limb integrity ─────────────────────────────────────────────────────

/**
 * O4: the largest 2-px luminance step inside a band, normalized by the band's
 * local mean.
 *
 * `band` is a per-pixel selector the caller builds from the limb geometry (the
 * "within 5 deg of the limb" annulus). Normalizing by the LOCAL mean rather
 * than the frame mean is what makes the 10 % bar meaningful on a limb that is
 * much darker than the disc centre; a frame-normalized step would read as
 * compliant simply because the region is dim.
 *
 * Steps are taken horizontally and vertically. A step is only counted when both
 * of its pixels are in the band, so the band's own edge cannot masquerade as a
 * discontinuity in the image.
 */
export function evaluateO4({
  luminanceField,
  width,
  height,
  band,
  target = ORBITAL_BARS.O4.target,
}) {
  finite(width, "width");
  finite(height, "height");
  let sum = 0;
  let count = 0;
  for (let index = 0; index < width * height; index++) {
    if (band[index] === 1) {
      sum += luminanceField[index];
      count++;
    }
  }
  if (count === 0) {
    return {
      bar: "O4",
      kind: "measured",
      bandPixels: 0,
      localMean: null,
      maxStep: null,
      normalizedStep: null,
      pass: null,
      reason: "the limb band selected no pixels; O4 cannot be evaluated",
    };
  }
  const localMean = sum / count;
  let maxStep = 0;
  let at = null;
  const consider = (ia, ib, x, y) => {
    if (band[ia] !== 1 || band[ib] !== 1) {
      return;
    }
    const step = Math.abs(luminanceField[ia] - luminanceField[ib]);
    if (step > maxStep) {
      maxStep = step;
      at = { x, y };
    }
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      if (x + 1 < width) {
        consider(index, index + 1, x, y);
      }
      if (y + 1 < height) {
        consider(index, index + width, x, y);
      }
    }
  }
  const normalized = localMean === 0 ? null : maxStep / localMean;
  return {
    bar: "O4",
    kind: "measured",
    bandPixels: count,
    localMean,
    maxStep,
    maxStepAt: at,
    normalizedStep: normalized,
    target,
    pass: normalized === null ? null : normalized <= target,
  };
}

/**
 * The "within 5 deg of the limb" annulus, as a pixel selector.
 *
 * THE PLAN'S WORDING IS AMBIGUOUS AND THE TWO READINGS DIFFER BY TWO ORDERS OF
 * MAGNITUDE, so the choice is a parameter rather than a silent decision.
 * §1.3's O4 reads "Max luminance/alpha step across any 2-px window within 5 deg
 * of the limb", and "5 deg" can mean:
 *
 *   - `"surface-arc"` — 5 degrees of PLANETARY arc inward from the tangent
 *     point. Under the near-orthographic projection of an orbital view that
 *     lands at radius `cos(5 deg) * R`, i.e. a band only 0.38 % of the
 *     silhouette radius wide. At a 400-px disc that is 1.5 px — it cannot host
 *     the 2-px window the same sentence asks for, which is evidence against
 *     this reading being the intended one.
 *   - `"view-angle"` (DEFAULT) — 5 degrees of the CAMERA's angular field,
 *     `5 deg * pixelsPerRadian` pixels inward from the silhouette. This is the
 *     reading under which the statistic is computable as written, and it is the
 *     one an image-space "2-px window" implies.
 *
 * The default is `view-angle` and the mode is recorded in the return, so a
 * receipt says which band a number came from. If `C13-29` (O4's owning row)
 * rules for the other reading, it changes one argument and the evidence stays
 * comparable because every banked run names its mode.
 *
 * @param {object} options
 * @param {number} [options.pixelsPerRadian] Required for `view-angle`: the
 *   capture's angular scale, `height / 2 / tan(fovy / 2)`.
 */
export function limbBand({
  width,
  height,
  centreX,
  centreY,
  radiusPixels,
  degrees = 5,
  mode = "view-angle",
  pixelsPerRadian,
}) {
  finite(radiusPixels, "radiusPixels");
  let inner;
  if (mode === "surface-arc") {
    inner = Math.cos((degrees * Math.PI) / 180) * radiusPixels;
  } else if (mode === "view-angle") {
    if (!(pixelsPerRadian > 0) || !Number.isFinite(pixelsPerRadian)) {
      throw new TypeError(
        'limbBand mode "view-angle" requires a positive pixelsPerRadian; without the ' +
          "capture's angular scale, 5 degrees of field of view is not a number of pixels",
      );
    }
    inner = radiusPixels - ((degrees * Math.PI) / 180) * pixelsPerRadian;
  } else {
    throw new TypeError(
      `unknown limb-band mode ${String(mode)}; expected "view-angle" or "surface-arc"`,
    );
  }
  inner = Math.max(0, inner);
  const band = new Uint8Array(width * height);
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - centreX;
      const dy = y + 0.5 - centreY;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r >= inner && r <= radiusPixels) {
        band[y * width + x] = 1;
        count++;
      }
    }
  }
  return {
    band,
    count,
    mode,
    degrees,
    innerRadiusPixels: inner,
    outerRadiusPixels: radiusPixels,
  };
}

// ── O6 — altitude continuity ────────────────────────────────────────────────

/**
 * O6, first clause: mean cloud alpha at each rung relative to the 20 km rung.
 *
 * The reference is the FIRST rung rather than the largest value, because the
 * bar is "retains its 20 km value", and picking the maximum as the denominator
 * would turn a rung that gained coverage into a spurious failure of every
 * other rung.
 */
export function evaluateO6Retention(
  rungs,
  { target = ORBITAL_BARS.O6.retentionTarget } = {},
) {
  if (!Array.isArray(rungs) || rungs.length === 0) {
    throw new TypeError(
      "evaluateO6Retention requires a non-empty array of rungs",
    );
  }
  const reference = rungs[0];
  if (!(reference.meanCloudAlpha > 0)) {
    return {
      bar: "O6",
      kind: "measured",
      pass: null,
      reason:
        `the reference rung at ${reference.altitudeMetres} m has mean cloud alpha ` +
        `${String(reference.meanCloudAlpha)}; with no cloud at the bottom of the ladder ` +
        "there is no retention to measure",
      rungs: [],
    };
  }
  const evaluated = rungs.map((rung) => ({
    altitudeMetres: rung.altitudeMetres,
    meanCloudAlpha: rung.meanCloudAlpha,
    retention: rung.meanCloudAlpha / reference.meanCloudAlpha,
    pass: rung.meanCloudAlpha / reference.meanCloudAlpha >= target,
  }));
  return {
    bar: "O6",
    kind: "measured",
    referenceAltitudeMetres: reference.altitudeMetres,
    target,
    rungs: evaluated,
    pass: evaluated.every((rung) => rung.pass),
    worst: evaluated.reduce((a, b) => (a.retention <= b.retention ? a : b)),
  };
}

/**
 * O6, second clause: RMS of the per-frame change in mean luminance over a zoom,
 * as a fraction of the run's mean.
 *
 * Normalized, because the bar is "< 5 % RMS" and an absolute luminance RMS is
 * not comparable between a bright and a dim leg of the same zoom.
 */
export function evaluateO6ZoomFlicker(
  meanLuminancePerFrame,
  { target = ORBITAL_BARS.O6.zoomRmsTarget } = {},
) {
  if (
    !Array.isArray(meanLuminancePerFrame) ||
    meanLuminancePerFrame.length < 2
  ) {
    throw new TypeError("evaluateO6ZoomFlicker requires at least two frames");
  }
  const mean =
    meanLuminancePerFrame.reduce((a, b) => a + b, 0) /
    meanLuminancePerFrame.length;
  let sumSquares = 0;
  let maxDelta = 0;
  for (let i = 1; i < meanLuminancePerFrame.length; i++) {
    const delta = meanLuminancePerFrame[i] - meanLuminancePerFrame[i - 1];
    sumSquares += delta * delta;
    maxDelta = Math.max(maxDelta, Math.abs(delta));
  }
  const rms = Math.sqrt(sumSquares / (meanLuminancePerFrame.length - 1));
  const normalized = mean === 0 ? null : rms / mean;
  return {
    bar: "O6",
    clause: "zoom-flicker",
    kind: "measured",
    frames: meanLuminancePerFrame.length,
    runMean: mean,
    rms,
    normalizedRms: normalized,
    maxFrameDelta: maxDelta,
    target,
    pass: normalized === null ? null : normalized < target,
  };
}

export { meanCloudAlpha } from "./metrics/region-means.mjs";
