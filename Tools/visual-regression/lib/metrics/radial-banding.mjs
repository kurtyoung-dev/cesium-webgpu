/**
 * @purpose Concentric-banding statistics over a disc capture — onset ladder in ln(eye-axis depth) and in cos(incidence), duty cycle per annulus, and the presence/darkness terms a banding number must be read beside.
 * @status ACTIVE
 *
 * WHAT THIS MEASURES, AND WHAT IT CANNOT. `coherence` answers one question:
 * how much of the field's variance, over a disc whose geometry the caller
 * states, is carried by a NON-SMOOTH function of screen radius alone. A family
 * of concentric arcs scores high; a smooth limb-darkening ramp scores near
 * zero because the radial trend is removed first; noise with no radial
 * structure scores near zero because averaging an annulus destroys it.
 *
 * `coherence` ALONE CAN NEVER BE AN ACCEPTANCE. An all-black frame scores
 * exactly 0 — it is the same answer a perfectly ring-free render gives, and
 * the mechanism this metric was built to watch (a depth-comparison clamp that
 * ANNIHILATES rays) fails toward black. A blurred render also scores low,
 * because blur removes the arcs' edges along with everything else. Any row
 * that closes on this number closes on a conjunction: banding DOWN, cloud
 * presence UP, the spectral slope IN BAND, and the innermost annulus
 * rendering something at all. `radialBandingConjunction` below is that shape,
 * and `presence`/`darkFraction`/`innerAnnulusPeak` are returned here so the
 * conjunction has its terms from one pass over the pixels.
 *
 * THE GEOMETRY IS THE CALLER'S, AND A MISSING PIECE THROWS. Centre, disc
 * radius, focal length, altitude, planet radius and the deck all come from the
 * capture's own camera block. There is no default: a metric that guessed a
 * centre or a radius would silently measure a different annulus on every rung
 * of an altitude sweep and report the numbers as comparable. A disc that is
 * not wholly inside the frame is refused for the same reason — a partial
 * annulus is an area-weighted average over whatever corner of the disc the
 * viewport happened to keep.
 *
 * `discRadiusPixels` IS THE MEASURED DOMAIN, NOT THE GEOMETRY, and two
 * consequences follow that a caller has to know.
 *
 *   1. **STATE A RADIUS INSIDE THE SMALLEST SILHOUETTE.** Nothing here derives
 *      the radius, and the planet is an oblate spheroid: at an orbital camera
 *      the equatorial and polar silhouettes differ by several pixels, so a
 *      radius taken from the equator puts a hard planet/space EDGE inside the
 *      measured disc wherever the globe is actually drawn. The 21-bin detrend
 *      removes smooth radial structure and cannot remove an edge, so that edge
 *      reads as banding — on the orbital rig's geometry, several times the RED
 *      band on a frame built ring-free by construction. `rigs/
 *      orbital-fulldisc-6608km-imagery.mjs` carries the worked case.
 *   2. **WHEN THE SILHOUETTE LEAVES THE FRAME, STATE AN IN-FRAME SUB-DISC.**
 *      The refusal above is about the DOMAIN, and every geometric quantity —
 *      `eyeAxisDepthMetres`, `cosIncidenceAt`, the ln-depth window — is derived
 *      from `focalPixels`, the altitude and the planet radius, never from
 *      `discRadiusPixels`. So a low-altitude rung whose disc overflows the
 *      viewport is measured by stating a smaller, in-frame radius: the ladder
 *      stays in the same physical coordinate and only the annulus set shrinks.
 *      A partial annulus is still refused; a deliberately smaller full one is
 *      the supported route, and the rung's own `discRadiusPixels` should be
 *      recorded beside it so a reader knows which was used.
 *
 * THE BAND COUNT IS A PARAMETER, NOT A PROPERTY. The same family reads a
 * different number of bands under every binning and threshold choice, so
 * `bandCount` is returned WITH the threshold that produced it and nothing
 * should be asserted about the count alone. The onset LADDER is the property:
 * where each band starts, expressed in a coordinate, and how regular the
 * spacing is in that coordinate.
 *
 * `coherence` COUNTS ANY SHARP RADIAL FEATURE, NOT ONLY A PERIODIC FAMILY, and
 * that is the number's real limit. ONE hard radial edge — an atmosphere limb
 * ring over the outer few per cent of the disc, an ocean/land albedo step, a
 * cloud-deck boundary — supplies variance the moving average cannot capture
 * and reads high, while smooth structure (limb darkening at any exponent, a
 * terminator, a specular glint, latitude bands) reads near zero. What
 * separates a family from an edge is the LADDER, not the coherence: an edge
 * gives `bandCount` 1 and `lnZSpacingMean` null, because a single onset has no
 * spacing. Read the three together and the distinction is mechanical; read
 * `coherence` alone over a drawn planet and it is not. (Sigismond, H4,
 * 2026-09-19. It is latent rather than live on the blacked-out acceptance rig,
 * whose clouds-OFF frame measures a mean in-disc luminance of about 1e-6.)
 *
 * NO VERDICT. `PROVISIONAL_BANDS` may be reported; it may not gate. The bands
 * were read off one capture family and there is no measured noise floor for
 * them: consecutive frames of a still cloud scene in this renderer are
 * byte-identical, so a repeat-frame floor is vacuous and a real one needs
 * independent re-launches banked with the adapter string and the bundle hash.
 */

import { luminance } from "./luminance.mjs";
import { requireFinite } from "./masks.mjs";

/** Byte level above which a pixel counts as lit: one 8-bit step clear of black. */
export const DEFAULT_LIT_THRESHOLD = 3 / 255;

/** Annulus level above which a radial bin counts as inside a band. */
export const DEFAULT_ONSET_LEVEL = 0.02;

/**
 * Provisional reporting bands. NOT a gate — `R-2026-09-17-10` reserves
 * verdicts for invariants, and these came off one capture family with no
 * measured floor beneath them.
 */
export const PROVISIONAL_BANDS = Object.freeze({
  red: 0.02,
  green: 0.006,
  basis:
    "read off one orbital capture family; no independent re-launch floor exists, so these report and do not gate",
  // THE ONLY FLOOR THAT EXISTS, MEASURED. Asked directly whether 0.006 is
  // derived from data, the answer is no — it is a defensible CHOICE, and this
  // field is what it was chosen against. The repeat-frame floor is vacuous:
  // consecutive frames of a still cloud scene in this renderer are
  // byte-identical, so it is exactly 0. The seeded fBm control at the
  // acceptance geometry, six seeds, spans 1.803e-3 to 2.673e-3 (measured
  // 2026-09-19 at the spec's 1/8 control scale; `radial-banding.spec.mjs`
  // case 2b re-derives it). GREEN therefore sits 2.2x above the worst clean
  // seed and RED 7.5x above it — outside the clean spread, not inside it, but
  // a multiple of a six-sample spread is not a noise floor. A real floor needs
  // >= 5 independent re-launches banked with the adapter string and the bundle
  // hash, which is what `C13-N60` names.
  controlSpread: Object.freeze({
    low: 1.80311e-3,
    high: 2.673321e-3,
    seeds: 6,
    scale: "1/8 of the 2048-px acceptance geometry",
  }),
});

function requireInteger(value, what) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(
      `${what} must be a positive integer, received ${String(value)}`,
    );
  }
  return value;
}

/**
 * The shell radii and the nadir render windows a camera block implies.
 *
 * `lnWindowNadirAny` is the interval, in ln(eye-axis depth), between the
 * globe's own surface and the outer shell's entry along the nadir ray — the
 * span within which a recovered depth still leaves the deck something to
 * march. `lnWindowNadirFullDeck` is the narrower span within which a FULL deck
 * crossing survives. Both are computed from the camera rather than carried as
 * constants, because both move with the deck and the altitude.
 *
 * @param {object} camera Camera block; see {@link radialBanding}.
 * @returns {object} Derived geometry, all in metres except the two ln spans.
 */
export function discGeometry(camera) {
  const planetRadiusMetres = requireFinite(
    camera?.planetRadiusMetres,
    "camera.planetRadiusMetres",
  );
  const altitudeMetres = requireFinite(
    camera?.altitudeMetres,
    "camera.altitudeMetres",
  );
  const deckTopMetres = requireFinite(camera?.deck?.top, "camera.deck.top");
  const deckBottomMetres = requireFinite(
    camera?.deck?.bottom,
    "camera.deck.bottom",
  );
  if (!(deckTopMetres > deckBottomMetres)) {
    throw new RangeError(
      `camera.deck.top ${deckTopMetres} must exceed camera.deck.bottom ${deckBottomMetres}`,
    );
  }
  if (!(altitudeMetres > deckTopMetres)) {
    throw new RangeError(
      `radialBanding measures a disc from outside the deck; altitude ${altitudeMetres} is not above deck top ${deckTopMetres}`,
    );
  }
  return {
    planetRadiusMetres,
    altitudeMetres,
    deckTopMetres,
    deckBottomMetres,
    cameraDistanceMetres: planetRadiusMetres + altitudeMetres,
    outerShellRadiusMetres: planetRadiusMetres + deckTopMetres,
    innerShellRadiusMetres: planetRadiusMetres + deckBottomMetres,
    lnWindowNadirAny: Math.log(
      altitudeMetres / (altitudeMetres - deckTopMetres),
    ),
    lnWindowNadirFullDeck: Math.log(
      altitudeMetres / (altitudeMetres - deckBottomMetres),
    ),
  };
}

/**
 * Eye-axis depth, in metres, at which a pixel's ray first meets a shell.
 *
 * The camera looks along its own forward axis at the planet centre, so a pixel
 * `radiusPixels` from the disc centre carries a ray at `atan(r / focalPixels)`
 * off that axis. `t` solves `|C + t d| = shellRadius` for the NEAR root, and
 * the returned value is `t cos(theta)` — the projection onto the forward axis,
 * which is the quantity a logarithmic depth buffer stores and the quantity the
 * march's own `logDepthToEyeDistance` inverse produces.
 *
 * @param {number} radiusPixels Distance from the disc centre, in pixels.
 * @param {object} camera Camera block.
 * @param {number} shellRadiusMetres Radius of the shell from the planet centre.
 * @returns {number|null} Eye-axis depth, or null when the ray misses the shell.
 */
export function eyeAxisDepthMetres(radiusPixels, camera, shellRadiusMetres) {
  const focalPixels = requireFinite(camera?.focalPixels, "camera.focalPixels");
  const { cameraDistanceMetres } = discGeometry(camera);
  const theta = Math.atan(radiusPixels / focalPixels);
  const perpendicular = cameraDistanceMetres * Math.sin(theta);
  if (!(perpendicular < shellRadiusMetres)) {
    return null;
  }
  const along =
    cameraDistanceMetres * Math.cos(theta) -
    Math.sqrt(
      shellRadiusMetres * shellRadiusMetres - perpendicular * perpendicular,
    );
  return along * Math.cos(theta);
}

/**
 * Cosine of the incidence angle where a pixel's ray enters the outer shell.
 *
 * 1 at the sub-satellite point, 0 where the ray grazes. This is the coordinate
 * a periodogram over screen radius naturally lands in, and the one in which
 * the banked orbital family is NOT periodic — which is why it is reported
 * beside the ln-depth ladder rather than instead of it.
 *
 * @param {number} radiusPixels Distance from the disc centre, in pixels.
 * @param {object} camera Camera block.
 * @returns {number|null} cos(incidence), or null past the grazing ray.
 */
export function cosIncidenceAt(radiusPixels, camera) {
  const focalPixels = requireFinite(camera?.focalPixels, "camera.focalPixels");
  const { cameraDistanceMetres, outerShellRadiusMetres } = discGeometry(camera);
  const theta = Math.atan(radiusPixels / focalPixels);
  const sine =
    (cameraDistanceMetres * Math.sin(theta)) / outerShellRadiusMetres;
  if (!(sine < 1)) {
    return null;
  }
  return Math.sqrt(1 - sine * sine);
}

/**
 * A scalar luminance field from a decoded RGBA image, normalized to [0, 1].
 *
 * @param {{width:number,height:number,data:ArrayLike<number>,channels?:number}} image Decoded image.
 * @returns {{width:number,height:number,data:Float64Array}} The field.
 */
export function luminanceField(image) {
  requireInteger(image?.width, "image.width");
  requireInteger(image?.height, "image.height");
  const channels = image.channels ?? 4;
  const { width, height } = image;
  if (image.data?.length !== width * height * channels) {
    throw new TypeError(
      `image.data must hold width*height*channels values, got ${String(image.data?.length)}`,
    );
  }
  const data = new Float64Array(width * height);
  for (let pixel = 0; pixel < data.length; pixel++) {
    const offset = pixel * channels;
    data[pixel] =
      luminance(
        image.data[offset],
        image.data[offset + 1],
        image.data[offset + 2],
      ) / 255;
  }
  return { width, height, data };
}

/**
 * The cloud-only field: |luminance(on) - luminance(off)| per pixel.
 *
 * Present so a caller can score the same quantity the campaign's other cloud
 * statistics score, on the same two images, without a second luminance
 * convention entering the packet.
 *
 * @param {object} onImage Decoded clouds-ON image.
 * @param {object} offImage Decoded clouds-OFF image, same dimensions.
 * @returns {{width:number,height:number,data:Float64Array}} The field.
 */
export function cloudContributionField(onImage, offImage) {
  const on = luminanceField(onImage);
  const off = luminanceField(offImage);
  if (on.width !== off.width || on.height !== off.height) {
    throw new RangeError(
      `on ${on.width}x${on.height} and off ${off.width}x${off.height} must have the same dimensions`,
    );
  }
  const data = new Float64Array(on.data.length);
  for (let pixel = 0; pixel < data.length; pixel++) {
    data[pixel] = Math.abs(on.data[pixel] - off.data[pixel]);
  }
  return { width: on.width, height: on.height, data };
}

/** Centred moving average over a profile, window `2*half+1` bins, edge-clamped. */
function movingAverage(profile, half) {
  const out = new Float64Array(profile.length);
  for (let bin = 0; bin < profile.length; bin++) {
    let sum = 0;
    let count = 0;
    for (let k = bin - half; k <= bin + half; k++) {
      if (k < 0 || k >= profile.length) {
        continue;
      }
      sum += profile[k];
      count++;
    }
    out[bin] = sum / count;
  }
  return out;
}

/** Mean and coefficient of variation of a sample, or nulls below two samples. */
function meanAndCv(values) {
  if (values.length < 2) {
    return { count: values.length, mean: null, cv: null };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    (values.length - 1);
  return {
    count: values.length,
    mean,
    cv: mean === 0 ? null : Math.sqrt(variance) / Math.abs(mean),
  };
}

/** Consecutive absolute differences of a series. */
function spacings(series) {
  return series.slice(1).map((value, index) => Math.abs(value - series[index]));
}

/**
 * Peak frequency of a detrended radial profile resampled uniformly in
 * cos(incidence), in cycles per unit cos.
 *
 * Evaluated on a frequency grid finer than the record's own Rayleigh
 * resolution and refined parabolically, because the disc spans barely one unit
 * of cos and a bin-resolution answer could not distinguish a family at 20
 * cycles from one at 21.
 */
function dominantFrequency(samples, spanInCos, maxCycles) {
  if (samples.length < 8 || !(spanInCos > 0)) {
    return null;
  }
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  const centred = samples.map((value) => value - mean);
  const step = 1 / (16 * spanInCos);
  const ceiling = Math.min(maxCycles, samples.length / (2 * spanInCos));
  let bestPower = -1;
  let bestFrequency = null;
  const powers = [];
  const frequencies = [];
  for (let frequency = step; frequency <= ceiling; frequency += step) {
    let re = 0;
    let im = 0;
    for (let index = 0; index < centred.length; index++) {
      const phase =
        2 * Math.PI * frequency * (spanInCos * (index / (centred.length - 1)));
      re += centred[index] * Math.cos(phase);
      im += centred[index] * Math.sin(phase);
    }
    const power = re * re + im * im;
    powers.push(power);
    frequencies.push(frequency);
    if (power > bestPower) {
      bestPower = power;
      bestFrequency = frequency;
    }
  }
  const at = frequencies.indexOf(bestFrequency);
  if (at > 0 && at < powers.length - 1) {
    const left = powers[at - 1];
    const centre = powers[at];
    const right = powers[at + 1];
    const denominator = left - 2 * centre + right;
    if (denominator !== 0) {
      const shift = (0.5 * (left - right)) / denominator;
      if (Math.abs(shift) <= 1) {
        return bestFrequency + shift * step;
      }
    }
  }
  return bestFrequency;
}

/**
 * Validate the camera against a frame and return the settings both halves use.
 *
 * Shared by {@link radialProfile} and {@link radialBandingFromProfile} so the
 * refusals cannot drift between the pixel pass and the statistics pass.
 */
function resolveSettings(camera, options, frame) {
  const centreX = requireFinite(camera?.centreX, "camera.centreX");
  const centreY = requireFinite(camera?.centreY, "camera.centreY");
  const discRadiusPixels = requireFinite(
    camera?.discRadiusPixels,
    "camera.discRadiusPixels",
  );
  requireFinite(camera?.focalPixels, "camera.focalPixels");
  const geometry = discGeometry(camera);
  if (!(discRadiusPixels > 0)) {
    throw new RangeError(
      `camera.discRadiusPixels must be positive, received ${discRadiusPixels}`,
    );
  }
  if (frame !== null) {
    // A disc that leaves the frame cannot be measured: every annulus past the
    // edge is an average over whichever sector survived the crop, and the
    // number that comes back covers a different region at every rung. This is
    // the defect the predecessor `rings.mjs` shipped with.
    const insideBy = Math.min(
      centreX,
      centreY,
      frame.width - centreX,
      frame.height - centreY,
    );
    if (discRadiusPixels > insideBy) {
      throw new RangeError(
        `camera.discRadiusPixels ${discRadiusPixels} leaves the ${frame.width}x${frame.height} frame ` +
          `(the disc centred at (${centreX}, ${centreY}) fits ${insideBy} px); ` +
          "radialBanding refuses a partial annulus",
      );
    }
  }
  const bins = requireInteger(
    options.bins ?? Math.max(32, Math.round(discRadiusPixels)),
    "options.bins",
  );
  return {
    centreX,
    centreY,
    discRadiusPixels,
    geometry,
    bins,
    annulusBins: requireInteger(
      options.annulusBins ?? 10,
      "options.annulusBins",
    ),
    litThreshold: options.litThreshold ?? DEFAULT_LIT_THRESHOLD,
    onsetLevel: options.onsetLevel ?? DEFAULT_ONSET_LEVEL,
    detrendBins: options.detrendBins ?? Math.max(3, Math.round(bins / 48)),
  };
}

/**
 * The pixel pass: reduce a disc to per-annulus sums and disc-wide totals.
 *
 * Split out from the statistics so a banked capture can be pinned as a small
 * checked-in profile rather than as a two-megabyte PNG in a gitignored output
 * tree. Everything downstream of this function reads only the returned
 * numbers, so a golden profile exercises the real statistics on real banked
 * pixels with no capture present.
 *
 * `sumOfSquares` is carried because the variance the coherence ratio divides
 * by is a per-pixel quantity that no per-annulus mean can reconstruct.
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} field Scalar field.
 * @param {object} camera Camera block; see {@link radialBanding}.
 * @param {object} [options] Same options {@link radialBanding} takes.
 * @returns {object} The reduction.
 */
export function radialProfile(field, camera, options = {}) {
  requireInteger(field?.width, "field.width");
  requireInteger(field?.height, "field.height");
  const { width, height } = field;
  if (field.data?.length !== width * height) {
    throw new TypeError(
      `field.data must hold width*height values, got ${String(field.data?.length)}`,
    );
  }
  const settings = resolveSettings(camera, options, { width, height });
  const {
    centreX,
    centreY,
    discRadiusPixels,
    bins,
    annulusBins,
    litThreshold,
  } = settings;

  const counts = new Float64Array(bins);
  const sums = new Float64Array(bins);
  const lit = new Float64Array(bins);
  const annulusCounts = new Float64Array(annulusBins);
  const annulusLit = new Float64Array(annulusBins);
  const annulusPeaks = new Float64Array(annulusBins);

  let discPixels = 0;
  let darkPixels = 0;
  let litPixels = 0;
  let sum = 0;
  let litSum = 0;
  let sumOfSquares = 0;

  const yStart = Math.max(0, Math.floor(centreY - discRadiusPixels));
  const yEnd = Math.min(height - 1, Math.ceil(centreY + discRadiusPixels));
  const xStart = Math.max(0, Math.floor(centreX - discRadiusPixels));
  const xEnd = Math.min(width - 1, Math.ceil(centreX + discRadiusPixels));
  for (let y = yStart; y <= yEnd; y++) {
    const dy = y + 0.5 - centreY;
    for (let x = xStart; x <= xEnd; x++) {
      const dx = x + 0.5 - centreX;
      const radius = Math.hypot(dx, dy);
      if (radius > discRadiusPixels) {
        continue;
      }
      const value = field.data[y * width + x];
      const fraction = radius / discRadiusPixels;
      const bin = Math.min(bins - 1, Math.floor(fraction * bins));
      const annulus = Math.min(
        annulusBins - 1,
        Math.floor(fraction * annulusBins),
      );
      discPixels++;
      sum += value;
      sumOfSquares += value * value;
      counts[bin] += 1;
      sums[bin] += value;
      annulusCounts[annulus] += 1;
      if (value > annulusPeaks[annulus]) {
        annulusPeaks[annulus] = value;
      }
      if (value === 0) {
        darkPixels++;
      }
      if (value > litThreshold) {
        litPixels++;
        litSum += value;
        lit[bin] += 1;
        annulusLit[annulus] += 1;
      }
    }
  }
  if (discPixels === 0) {
    throw new RangeError("the disc selected no pixels");
  }
  return {
    bins,
    annulusBins,
    litThreshold,
    counts: Array.from(counts),
    sums: Array.from(sums),
    lit: Array.from(lit),
    annulusCounts: Array.from(annulusCounts),
    annulusLit: Array.from(annulusLit),
    annulusPeaks: Array.from(annulusPeaks),
    discPixels,
    darkPixels,
    litPixels,
    sum,
    litSum,
    sumOfSquares,
  };
}

/**
 * The statistics pass: everything {@link radialBanding} reports, from a
 * {@link radialProfile} reduction.
 *
 * @param {object} profile A {@link radialProfile} result.
 * @param {object} camera Camera block; see {@link radialBanding}.
 * @param {object} [options] Same options {@link radialBanding} takes.
 * @returns {object} The statistics.
 */
export function radialBandingFromProfile(profile, camera, options = {}) {
  const settings = resolveSettings(
    camera,
    { ...options, bins: profile.bins },
    null,
  );
  const {
    centreX,
    centreY,
    discRadiusPixels,
    geometry,
    bins,
    onsetLevel,
    detrendBins,
  } = settings;
  const litThreshold = profile.litThreshold;
  const {
    counts,
    sums,
    lit,
    annulusCounts,
    annulusLit,
    annulusPeaks,
    discPixels,
    darkPixels,
    litPixels,
    sum,
    litSum,
    sumOfSquares,
  } = profile;

  const profileMean = new Float64Array(bins);
  const profileDuty = new Float64Array(bins);
  for (let bin = 0; bin < bins; bin++) {
    profileMean[bin] = counts[bin] > 0 ? sums[bin] / counts[bin] : 0;
    profileDuty[bin] = counts[bin] > 0 ? lit[bin] / counts[bin] : 0;
  }

  // The detrend is what separates "a family of arcs" from "the disc is
  // brighter in the middle". Removing it must turn a smooth ramp from a
  // near-zero score into a near-one score; that is the inertness image.
  let trend = new Float64Array(bins);
  if (detrendBins > 1) {
    trend = movingAverage(profileMean, Math.max(1, Math.round(detrendBins)));
  }

  const discMean = sum / discPixels;
  let radialVariance = 0;
  for (let bin = 0; bin < bins; bin++) {
    if (counts[bin] === 0) {
      continue;
    }
    radialVariance += counts[bin] * (profileMean[bin] - trend[bin]) ** 2;
  }
  radialVariance /= discPixels;
  const totalVariance = Math.max(
    0,
    sumOfSquares / discPixels - discMean * discMean,
  );
  // A field with no variance at all — an all-black frame is the case that
  // matters — has no banding to report and no denominator to divide by.
  const coherence = totalVariance > 0 ? radialVariance / totalVariance : 0;
  const annulusPeak = annulusPeaks;

  // Band onsets: the inner edge of every contiguous run of annuli whose lit
  // fraction clears `onsetLevel`. A run's START is the property; how many runs
  // there are depends on the level and is reported WITH it.
  const onsetsPx = [];
  let inside = false;
  for (let bin = 0; bin < bins; bin++) {
    const above = profileDuty[bin] > onsetLevel;
    if (above && !inside) {
      onsetsPx.push(((bin + 0.5) / bins) * discRadiusPixels);
    }
    inside = above;
  }

  const onsetsLnZ = [];
  const onsetsCosI = [];
  for (const radius of onsetsPx) {
    const depth = eyeAxisDepthMetres(
      radius,
      camera,
      geometry.outerShellRadiusMetres,
    );
    const cosI = cosIncidenceAt(radius, camera);
    if (depth !== null && depth > 0) {
      onsetsLnZ.push(Math.log(depth));
    }
    if (cosI !== null) {
      onsetsCosI.push(cosI);
    }
  }
  const lnZ = meanAndCv(spacings(onsetsLnZ));
  const cosI = meanAndCv(spacings(onsetsCosI));

  // Resample the detrended profile uniformly in cos(incidence) for the
  // periodogram, because a periodogram over screen radius answers a question
  // about the projection rather than about the scene.
  const cosAtOuterEdge = cosIncidenceAt(discRadiusPixels, camera) ?? 0;
  const spanInCos = 1 - cosAtOuterEdge;
  const resampled = [];
  const resampleCount = Math.min(2048, bins);
  for (let index = 0; index < resampleCount; index++) {
    const targetCos = 1 - (spanInCos * index) / (resampleCount - 1);
    // Invert cos(incidence) -> radius: sin(theta) = sqrt(1-c^2) * Ro / D.
    const sineTheta =
      (Math.sqrt(Math.max(0, 1 - targetCos * targetCos)) *
        geometry.outerShellRadiusMetres) /
      geometry.cameraDistanceMetres;
    const theta = Math.asin(Math.min(1, sineTheta));
    const radius = Math.tan(theta) * camera.focalPixels;
    const bin = Math.min(
      bins - 1,
      Math.max(0, Math.floor((radius / discRadiusPixels) * bins)),
    );
    resampled.push(profileMean[bin] - trend[bin]);
  }
  const dominantCyclesPerUnitCos = dominantFrequency(
    resampled,
    spanInCos,
    options.maxCyclesPerUnitCos ?? 400,
  );

  const dutyByAnnulus = Array.from(annulusLit, (value, index) =>
    annulusCounts[index] > 0 ? value / annulusCounts[index] : 0,
  );
  let innerLit = 0;
  let innerCount = 0;
  for (let bin = 0; bin < bins; bin++) {
    const fraction = (bin + 0.5) / bins;
    if (fraction >= 0.1 && fraction <= 0.5) {
      innerLit += lit[bin];
      innerCount += counts[bin];
    }
  }
  const dutyFull = litPixels / discPixels;
  const dutyInner = innerCount > 0 ? innerLit / innerCount : 0;

  // The render window, per annulus and then area-weighted: the span in
  // ln(eye-axis depth) between the globe's own surface and the outer shell's
  // entry. Under a quantiser biased SHORT, the fraction of the disc that
  // renders at all is that span divided by one quantum, so the quantum can be
  // read off the duty cycle without touching a threshold on a spacing. It
  // grows toward the limb, which is why the nadir value alone is not the right
  // divisor for a disc-wide duty.
  let windowWeighted = 0;
  let windowWeight = 0;
  for (let bin = 0; bin < bins; bin++) {
    if (counts[bin] === 0) {
      continue;
    }
    const radius = ((bin + 0.5) / bins) * discRadiusPixels;
    const outer = eyeAxisDepthMetres(
      radius,
      camera,
      geometry.outerShellRadiusMetres,
    );
    const surface = eyeAxisDepthMetres(
      radius,
      camera,
      geometry.planetRadiusMetres,
    );
    if (outer === null || surface === null || !(outer > 0) || !(surface > 0)) {
      continue;
    }
    windowWeighted += counts[bin] * Math.log(surface / outer);
    windowWeight += counts[bin];
  }
  const meanRenderWindowLnZ =
    windowWeight > 0 ? windowWeighted / windowWeight : null;

  return {
    // Geometry the caller stated, echoed so a receipt is self-describing.
    geometry: {
      ...geometry,
      centreX,
      centreY,
      discRadiusPixels,
      focalPixels: camera.focalPixels,
      discPixels,
      bins,
      detrendBins,
      litThreshold,
      onsetLevel,
    },

    coherence,
    onsetsPx,
    onsetsLnZ,
    onsetsCosI,
    lnZSpacingMean: lnZ.mean,
    lnZSpacingCv: lnZ.cv,
    cosISpacingMean: cosI.mean,
    cosISpacingCv: cosI.cv,
    dominantCyclesPerUnitCos,
    bandCount: onsetsPx.length,
    bandCountThreshold: onsetLevel,

    dutyByAnnulus,
    dutyFull,
    dutyInner,
    darkFraction: darkPixels / discPixels,
    innerAnnulusDuty: dutyByAnnulus[0],
    innerAnnulusPeak: annulusPeak[0],

    // The presence terms. A banding number read without these is the failure
    // mode the module docstring names.
    presence: {
      cloudFraction: dutyFull,
      meanValue: discMean,
      meanLitValue: litPixels > 0 ? litSum / litPixels : 0,
      peakValue: Math.max(...annulusPeak),
    },

    // TWO ESTIMATES OF ONE CONSTANT, from two independent features of the same
    // image: how far apart the band onsets are in ln(eye-axis depth), and how
    // much of the disc renders at all. They are reported side by side with
    // their ratio because agreement between them is evidence about the
    // MECHANISM, while either alone is one reduction of one picture.
    //
    // `qFromDuty` divides the AREA-WEIGHTED render window by the disc-wide
    // duty; it is the one to read. The two nadir-window forms are kept beside
    // it because the nadir window is the number a reader reaches for first and
    // it is the wrong divisor for a disc-wide duty by a factor of about two —
    // recording both is cheaper than re-deriving why every time.
    meanRenderWindowLnZ,
    qFromSpacing: lnZ.mean,
    qFromDuty:
      meanRenderWindowLnZ !== null && dutyFull > 0
        ? meanRenderWindowLnZ / dutyFull
        : null,
    qFromDutyNadirAny:
      dutyFull > 0 ? geometry.lnWindowNadirAny / dutyFull : null,
    qFromDutyNadirFullDeck:
      dutyFull > 0 ? geometry.lnWindowNadirFullDeck / dutyFull : null,
    qAgreementRatio:
      meanRenderWindowLnZ !== null && dutyFull > 0 && lnZ.mean
        ? meanRenderWindowLnZ / dutyFull / lnZ.mean
        : null,

    provisionalBands: PROVISIONAL_BANDS,
  };
}

/**
 * Concentric-banding statistics over a disc.
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} field Scalar
 *   field, one value per pixel, row-major. Build it with
 *   {@link luminanceField} or {@link cloudContributionField}.
 * @param {object} camera Camera block: `centreX`, `centreY`,
 *   `discRadiusPixels`, `focalPixels`, `altitudeMetres`, `planetRadiusMetres`
 *   and `deck: {bottom, top}`. Every field is required; a capture manifest
 *   written by the cloud probes carries all of them.
 * @param {object} [options] `bins`, `litThreshold`, `onsetLevel`,
 *   `detrendBins`, `annulusBins`, `maxCyclesPerUnitCos`.
 * @returns {object} The statistics; see the module docstring for what may and
 *   may not be concluded from `coherence`.
 */
export function radialBanding(field, camera, options = {}) {
  return radialBandingFromProfile(
    radialProfile(field, camera, options),
    camera,
    options,
  );
}

/**
 * The four-part conjunction a ring-removal claim has to satisfy, plus the
 * blank-frame sentinel.
 *
 * Every clause is reported separately and `satisfied` is `null` — never
 * `false` — when a clause's input was not supplied, because a clause nobody
 * measured is not a failure. Nothing here is a gate: it is the shape a row's
 * acceptance takes, computed so a reviewer reads one table instead of four.
 *
 * @param {object} parts
 * @param {object} parts.measure `radialBanding` over the capture under test.
 * @param {object} parts.control `radialBanding` over a ring-free control at
 *   the same geometry — the seeded fBm field is the deterministic one.
 * @param {object} [parts.baseline] `radialBanding` over the pre-fix capture,
 *   so "presence up" and "samples up" have a direction.
 * @param {number} [parts.spectralSlope] O5's fitted slope over the capture.
 * @param {number} [parts.slopeTarget] Slope the campaign states, default -5/3.
 * @param {number} [parts.slopeTolerance] Half-width, default 0.3.
 * @param {number} [parts.realisedPrimarySamples] Live count from the renderer.
 * @param {number} [parts.baselinePrimarySamples] Same count before the fix.
 * @returns {object} `{ clauses, satisfied, provisional }`.
 */
export function radialBandingConjunction(parts) {
  const {
    measure,
    control,
    baseline = null,
    spectralSlope = null,
    slopeTarget = -5 / 3,
    slopeTolerance = 0.3,
    realisedPrimarySamples = null,
    baselinePrimarySamples = null,
  } = parts ?? {};
  if (!measure || !control) {
    throw new TypeError(
      "radialBandingConjunction requires both a measure and a ring-free control",
    );
  }

  const clauses = [
    {
      id: "banding-down",
      statement:
        "radial banding has fallen to the ring-free control at this geometry",
      value: { measure: measure.coherence, control: control.coherence },
      satisfied: measure.coherence <= control.coherence,
    },
    {
      id: "presence-up",
      statement:
        "cloud-covered pixel fraction and mean cloud contribution have not fallen",
      value: {
        cloudFraction: measure.presence.cloudFraction,
        meanLitValue: measure.presence.meanLitValue,
        baselineCloudFraction: baseline?.presence?.cloudFraction ?? null,
        baselineMeanLitValue: baseline?.presence?.meanLitValue ?? null,
      },
      satisfied:
        baseline === null
          ? null
          : measure.presence.cloudFraction >= baseline.presence.cloudFraction &&
            measure.presence.meanLitValue >= baseline.presence.meanLitValue,
    },
    {
      id: "slope-in-band",
      statement: `the spectral slope is ${slopeTarget.toFixed(3)} +/- ${slopeTolerance}`,
      value: { spectralSlope, slopeTarget, slopeTolerance },
      satisfied:
        spectralSlope === null
          ? null
          : Math.abs(spectralSlope - slopeTarget) <= slopeTolerance,
    },
    {
      id: "samples-up",
      statement:
        "the realised primary sample count has risen at the orbital rung",
      value: { realisedPrimarySamples, baselinePrimarySamples },
      satisfied:
        realisedPrimarySamples === null || baselinePrimarySamples === null
          ? null
          : realisedPrimarySamples > baselinePrimarySamples,
    },
    {
      id: "inner-annulus-renders",
      statement:
        "the innermost annulus (r/R < 0.1) renders something: non-zero duty and non-zero peak",
      value: {
        innerAnnulusDuty: measure.innerAnnulusDuty,
        innerAnnulusPeak: measure.innerAnnulusPeak,
      },
      satisfied: measure.innerAnnulusDuty > 0 && measure.innerAnnulusPeak > 0,
    },
  ];

  const anyUnmeasured = clauses.some((clause) => clause.satisfied === null);
  return {
    clauses,
    satisfied: anyUnmeasured
      ? null
      : clauses.every((clause) => clause.satisfied),
    // Never a gate: the banding clause's own band is provisional and the
    // presence clauses need a baseline captured on the same tree.
    provisional: true,
  };
}
