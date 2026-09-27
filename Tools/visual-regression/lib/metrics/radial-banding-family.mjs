/**
 * @purpose Ring-family estimator for disc captures: finds the family's own centre from the frame, measures its band-passed amplitude in luminance units, identifies its radial law and period by a coherent periodogram, and refuses by name when the family lies outside the period band the caller declares.
 * @status ACTIVE
 *
 * WHY THIS EXISTS BESIDE `radialBanding`. The onset ladder in
 * `radial-banding.mjs` reads a family only where the deck is mostly dead: its
 * onsets come from a duty threshold on the raw field, so a frame whose deck
 * renders everywhere yields one run and no ladder. Its `coherence` divides by
 * the per-pixel variance, so the same rings score lower on a denser deck. And
 * it averages annuli about a centre the caller states, which need not be the
 * family's centre. This module asks what those three properties hide: is there
 * a family of concentric rings, where is it centred, what law does its spacing
 * follow, and how large is it in luminance.
 *
 * THE CENTRE IS MEASURED AND ALWAYS REPORTED. The caller states the DISC
 * centre (a rig declares it). The family's centre is taken from the frame: the
 * stated centre, the point the coherent fringe normals point at, and the best
 * cell of a coarse grid are each scored by the band-passed ring amplitude, and
 * the winner is refined by a shrinking pattern search. Every result carries
 * the centre it used beside the stated centre and both estimates, so a
 * measured centre is never mistaken for an assumed one; a centre that ran
 * into the edge of the search is named `CENTRE_AT_SEARCH_BOUNDARY`, and an
 * amplitude read about it is a lower bound, so it never reads ABSENT.
 *
 * THE VISIBLE PERIOD BAND IS THE CALLER'S AND THE ESTIMATOR IS BUILT FROM IT.
 * `visiblePeriodBand.maxPx` sets the detrend (a centred moving average that
 * many pixels wide, so the trend it removes is everything slower than the
 * band) and `minPx` must be resolvable by the radial bins. Beside the visible
 * band the same estimator reads its two neighbours, slower through a detrend
 * three times as wide and faster through quarter-pixel bins. Each band's
 * search reaches past its edges, and a line belongs to the band over whose
 * periods it lies for most of the window, so a family on a band edge is
 * reported by one of them, never by neither.
 *
 * A LINE IS A FAMILY only if it is an interior maximum of its search range,
 * clears `RING_DETECTION_SNR` against its local floor, carries a fitted RMS of
 * at least the ABSENT class, and is carried in phase all round its centre in
 * two frames of azimuth: six of eight octants, and twelve of sixteen sectors
 * with none carrying it against its phase. A plane wave puts a clean line into
 * any annulus mean (its mean about any point oscillates in rho at the wave's
 * period), but only through the two directions per wave where its phase is
 * stationary along the circle, flanked by sidelobes against the line's phase.
 * The octant boundaries lie on the axes and the diagonals, where an
 * axis-aligned grid or plaid and a checkerboard have those directions, so half
 * a stationary lobe lands in every octant and such a lattice is carried in
 * eight of eight. The two frames together decline the six lattice inputs
 * the family spec pins (G17: sinusoidal plaids at 12, 16 and 24 px, a
 * hexagonal lattice at 12 px and a 1-px checkerboard, i.e. the lattices'
 * fundamentals), and only those are claimed. A lattice whose harmonics fall
 * in band, or whose stationary lobes lie in or beside every sector, can still
 * read as a family or a refusal (WHAT IT CANNOT SEE, below). A reduction
 * that carries only octants (the checked-in banked reductions) is judged by
 * the octant frame alone. A visible line that does not survive quarter-pixel
 * binning is the alias of a finer family, not a family.
 *
 * FAMILIES ARE REPORTED BESIDE ANY REFUSAL. Up to three lines are taken from
 * each band, each fitted and removed before the next is looked for, so a
 * second family about the same centre can be found; and once a family is
 * found its fitted rings are removed from the pixels and one further centre
 * is searched, so a second family about another centre can be found. Both
 * have measured limits, below. The further search carries its own
 * `CENTRE_AT_SEARCH_BOUNDARY`: a family measured about a further centre on
 * the search's edge is withheld, never reported as a family, and that search
 * reads INCONCLUSIVE; every family carries its own centre's `boundary`. A
 * family a neighbouring band owns is REFUSED by name ("no rings" and "no
 * rings in the band I can see" are different findings), alongside any
 * visible family, and only within the neighbour's reach: the slower band
 * claims a family only if the window holds three of its cycles, and reports
 * that reach in px.
 *
 * THE LAW IS A POWER OF THE FAMILY RADIUS. The band-passed profile is
 * resampled uniformly in the Box-Cox coordinate `(rho^a - 1) / a` (the natural
 * log at a = 0) for a scan of exponents; the exponent whose periodogram puts
 * the largest share of the power into one line starts the law, which a
 * least-squares fit over the radii the detrend passes then polishes. 1 is a
 * constant period, 2 a period falling as 1/rho, 0 a period growing as rho.
 * Every field quadratic in the angle from a centre is exponent 2 to leading
 * order, which is why depth-like and cone-like laws about one centre cannot be
 * told apart here. A law is NAMED only within a quarter of 0, 1 or 2.
 *
 * WHAT IT CANNOT SEE, as the adversarial verification measured it. "The spec
 * geometry" is the family spec's 720 px disc (window rho 30-230, search
 * 36 px); "the rig" is the 2,048 px orbital rig (rho 40-400, search 48 px).
 * - A second family about the same centre as a strong real one. On the banked
 *   M0 frame plus a linear 9 px family about M0's centre, both are found at a
 *   second-family RMS of 0.045 and from 0.07 up, and not between: at 0.0435
 *   the 9 px line reads SNR 194 and is not counted; at 0.0475 M0's own family
 *   is lost too (its SNR 198.9; no family, INCONCLUSIVE; the same on R0); from
 *   0.05 to 0.06 the 9 px line is read at the wrong law and period (exponent
 *   1.02-1.04, 9.08-9.15 px, SNR 10-18) and M0's SNR falls 25 to 55 times, to
 *   229-451. The failure is not monotonic in amplitude. A 6 px family at
 *   0.0435 leaves M0 at SNR 390. Synthetic pairs whose first law is an exact
 *   power are found at every amplitude tried, so no synthetic case shows it.
 * - A slower family inside the reported reach whose harmonics outrank its
 *   fundamental after the detrend. A 20 %-duty linear family at 50 px is
 *   neither refused nor detected (INCONCLUSIVE; the top line is mislawed,
 *   exponent 2.32-2.42 at 71-77 px). One at 60 px is reported as a visible
 *   linear family at its second harmonic, 29.7 px (SNR 392; PRESENT at RMS
 *   0.06), and nothing is refused: the visible series takes the harmonic first
 *   and stops at the fundamental as the same family, and the slower band's own
 *   window (rho 62-230 on the spec geometry) holds 2.86 of its cycles, under
 *   three. The reach holds only for families whose fundamental leads after the
 *   detrend.
 * - Two families about nearby centres. Two linear 12 px families 6 px apart
 *   come back as one about their midpoint; 9, 12, 18, 24 and 36 px apart the
 *   second is lost (12 px apart, the further search stops 7.4 px from it and
 *   its line fails the sixteen-sector frame there). A family of another period
 *   within one period of a known family's centre is taken as that family's
 *   remainder and discarded: a linear 9 px family 8 or 11 px from a quadratic
 *   one is lost, and 4 px apart the linear family is reported about its own
 *   centre and the quadratic one, found about its own centre, is discarded.
 * - Elliptical rings; the loss starts before an axis ratio of 0.97. On the
 *   spec geometry's textured deck a quadratic family is detected at 0.99, at
 *   0.98 with exponent 2.054 and its period at rhoMin 9 % long, and lost at
 *   0.97, 0.95 and 0.90 (SNR 108, 64, 28). On the rig the silhouette's own
 *   0.9973 reads PRESENT, 0.99 INCONCLUSIVE with the family detected, and 0.95
 *   loses it.
 * - A family centred past the search is not seen. It is named
 *   `CENTRE_AT_SEARCH_BOUNDARY` only when the amplitude maximum lands on the
 *   search edge: on the rig 1 and 4 px past, on the spec geometry 1 px past,
 *   and 4 px past on the untextured deck. Otherwise nothing names it and the
 *   verdict is the deck's band-passed noise against the 0.015 class: on the
 *   textured deck INCONCLUSIVE 4 and 14 px past (0.0157, 0.0151) and on the
 *   rig 12 px past (0.0156), but ABSENT (0.0149) 8 px past.
 * - A ring-free field whose band-passed maximum sits on the search edge reads
 *   INCONCLUSIVE, never ABSENT: 4 of 16 ring-free decks on the rig, at
 *   band-passed 0.0057-0.0071, about 0.4 of the ABSENT class.
 * - Lattices whose harmonics fall in band. The octant and sixteen-sector
 *   frames decline the six G17 inputs (the fundamentals) only. On the spec
 *   geometry's uniform deck a hexagonal lattice built as G17's (three
 *   60-degree waves at A 0.09) reads two families at P 17.32 (at 0 degrees),
 *   a family at P 20 (0-2 degrees) and at every rotation at P 24, PRESENT at
 *   P 30 and 36 at every rotation tried (0.0421, 0.0412), and REFUSED SLOWER
 *   at P 48, 56 and 64 (47.95, 56.36, 65.23 px); only at P 12 and 16 is it
 *   declined at every rotation. Added to banked R3 (registered ABSENT), the
 *   lattice at P 36 reads a family at A 0.09 and PRESENT (0.0490) at A 0.15,
 *   and at P 64 REFUSED SLOWER 63.75 px. Square-wave checkerboards of 8 and
 *   10 px cells at +-0.3 and of 12 and 16 px cells at +-0.25-0.3 read
 *   PRESENT (0.041-0.064) with two families, each the board's (3,1) harmonic
 *   at period 2c/sqrt(10) (5.06, 6.32, 7.59, 10.12 px), carried in 16 of 16
 *   sectors with none against. The aligned plaid plus checkerboard of one
 *   wavelength (four waves at 0, 45, 90 and 135 degrees) reads a family at
 *   P 12, 16 and 24 and REFUSED SLOWER at P 50 and 60 (50.28, 60.16 px): its
 *   azimuthal harmonics are multiples of eight, which average to zero over
 *   every octant and every sixteenth, so no count or uniformity test in these
 *   two frames can decline it.
 * - A family slower than the reported slower reach or finer than 1.25 px.
 *
 * NO VERDICT GATES. `verdict` reports against `RING_AMPLITUDE_CLASSES`, the
 * thresholds the orbital ring legs pre-registered, for the reason
 * `PROVISIONAL_BANDS` gives in the sibling module.
 */

import {
  CENTRE_AT_SEARCH_BOUNDARY,
  SECTORS,
  binSums,
  collectPixels,
  fringeNormalCentre,
  locateCentre,
  octantSums,
  withoutFamily,
} from "./radial-banding-family-centre.mjs";
import {
  CONCENTRIC_SECTORS,
  analyseBand,
  bandSeries,
  boxCox,
  concentricity,
  fitLines,
  fittedValue,
  periodAt,
  sameFamily,
} from "./radial-banding-family-spectrum.mjs";
import { requireFinite } from "./masks.mjs";

export { CENTRE_AT_SEARCH_BOUNDARY };

/**
 * Reporting classes for `bandPassRms` on the orbital full-disc rig, in
 * luminance units, as the ring legs registered them before their arms ran.
 */
export const RING_AMPLITUDE_CLASSES = Object.freeze({
  present: 0.04,
  absent: 0.015,
  basis:
    "pre-registered by the orbital ring legs on the 2048-px full-disc rig, band-passed RMS over rho 40-400 px; they report and do not gate",
});

/**
 * Peak-to-local-median power a line must reach to count as a family. Chosen
 * between the two measured populations `radial-banding.spec.mjs` rebuilds:
 * ring-free fields of every regime, scored about the centre the search picks
 * for them, and planted families at the measured orbital amplitude.
 */
export const RING_DETECTION_SNR = 200;

/**
 * Share of the window over which a line's period must lie in a band for the
 * band to claim it. Below one half on purpose: a family on a band edge splits
 * its window between two bands, and each band's own series must be able to
 * claim it, so an edge family is reported by one of them (the visible band
 * first) rather than by neither.
 */
const SHARE_TO_CLAIM = 0.4;

// A slower family is claimed only when the window it was measured over holds
// this many of its cycles; fewer cannot give a period, so the band's reach is
// reported instead of a guess.
const MIN_CYCLES = 3;

/** Refusal names a result can carry. */
export const RING_FAMILY_REFUSALS = Object.freeze({
  slowerThanBand: "RING_FAMILY_SLOWER_THAN_VISIBLE_BAND",
  fasterThanBand: "RING_FAMILY_FASTER_THAN_VISIBLE_BAND",
});

// The image's own pixel grid puts a line near one pixel into any quarter-pixel
// radial profile of a field with a radial gradient, so the fast neighbour
// stops short of it.
const FASTEST_PERIOD_PX = 1.25;

const NAMED_LAWS = Object.freeze({
  0: "logarithmic",
  1: "linear",
  2: "quadratic",
});

const DEFAULT_EXPONENTS = Object.freeze(
  Array.from({ length: 13 }, (_, index) => index * 0.25),
);

function requirePositive(value, what) {
  const number = requireFinite(value, what);
  if (!(number > 0)) {
    throw new RangeError(`${what} must be positive, received ${number}`);
  }
  return number;
}

/**
 * Resolve and validate the settings every pass shares, and the three bands:
 * the visible one and its slower and faster neighbours.
 */
function resolveFamilySettings(camera, options) {
  const discCentreX = requireFinite(camera?.centreX, "camera.centreX");
  const discCentreY = requireFinite(camera?.centreY, "camera.centreY");
  const discRadiusPixels = requirePositive(
    camera?.discRadiusPixels,
    "camera.discRadiusPixels",
  );
  const minPx = requirePositive(
    camera?.visiblePeriodBand?.minPx,
    "camera.visiblePeriodBand.minPx",
  );
  const maxPx = requirePositive(
    camera?.visiblePeriodBand?.maxPx,
    "camera.visiblePeriodBand.maxPx",
  );
  const binPx = requirePositive(options.binPx ?? 1, "options.binPx");
  const rhoMinPx = requirePositive(options.rhoMinPx ?? 40, "options.rhoMinPx");
  const rhoMaxPx = requirePositive(options.rhoMaxPx ?? 400, "options.rhoMaxPx");
  // Three bins per cycle is the shortest period a binned profile represents
  // without leaning on the Nyquist line, where phase decides the amplitude.
  for (const [holds, message] of [
    [
      maxPx > minPx,
      `visiblePeriodBand.maxPx ${maxPx} must exceed minPx ${minPx}`,
    ],
    [
      minPx >= 3 * binPx,
      `visiblePeriodBand.minPx ${minPx} is below three bins of ${binPx} px; the binning cannot resolve the band it is asked to see`,
    ],
    [
      rhoMaxPx - rhoMinPx >= 2 * maxPx,
      `the rho window ${rhoMinPx}-${rhoMaxPx} px holds fewer than two cycles of the band's longest period ${maxPx} px`,
    ],
  ]) {
    if (!holds) {
      throw new RangeError(message);
    }
  }
  const halfBins = Math.max(1, Math.round((maxPx / binPx - 1) / 2));
  const wideHalfBins = 3 * halfBins + 1;
  const fineBinPx = binPx / 4;
  const fineHalfBins = Math.max(1, Math.round(minPx / fineBinPx / 2));
  // Each band searches past its own edges; which band owns a line is decided
  // afterwards from where its period lies over the window. The visible band's
  // series passes periods up to twice its detrend width, over a longer window
  // than the slower band's, so it measures the near side of the slower band
  // too; the slower band's reach is the longer of the two.
  const slowerFrom = Math.max(rhoMinPx, (wideHalfBins + 1) * binPx);
  const slowerReachPx = Math.min(
    3 * maxPx,
    Math.max(
      Math.min(2 * maxPx, (rhoMaxPx - rhoMinPx) / MIN_CYCLES),
      (rhoMaxPx - slowerFrom) / MIN_CYCLES,
    ),
  );
  const bands = {
    inBand: {
      binPx,
      halfBins,
      from: rhoMinPx,
      to: rhoMaxPx,
      searchMinPx: 2.2 * binPx,
      searchMaxPx: 2 * maxPx,
      passMaxPx: 1.5 * maxPx,
    },
    slower: {
      binPx,
      halfBins: wideHalfBins,
      from: slowerFrom,
      to: rhoMaxPx,
      searchMinPx: 0.75 * maxPx,
      searchMaxPx: Infinity,
      passMaxPx: 3 * maxPx,
      reachPx: slowerReachPx,
    },
    fineVisible: {
      binPx: fineBinPx,
      halfBins: Math.round(((2 * halfBins + 1) * binPx) / fineBinPx / 2),
      from: rhoMinPx,
      to: rhoMaxPx,
    },
    faster: {
      binPx: fineBinPx,
      halfBins: fineHalfBins,
      from: rhoMinPx,
      to: rhoMaxPx,
      searchMinPx: FASTEST_PERIOD_PX,
      searchMaxPx: 1.5 * minPx,
      passMaxPx: minPx,
      reachPx: FASTEST_PERIOD_PX,
    },
  };
  return {
    discCentreX,
    discCentreY,
    discRadiusPixels,
    minPx,
    maxPx,
    binPx,
    fineBinPx,
    rhoMinPx,
    rhoMaxPx,
    bands,
    extentPx: rhoMaxPx + (wideHalfBins + 1) * binPx,
    centreSearchPx: requirePositive(
      options.centreSearchPx ?? 48,
      "options.centreSearchPx",
    ),
    exponents: options.lawExponents ?? DEFAULT_EXPONENTS,
    refineCentre: options.refineCentre ?? true,
  };
}

function lawName(exponent) {
  const nearest = Math.round(exponent);
  return Math.abs(exponent - nearest) <= 0.25
    ? (NAMED_LAWS[nearest] ?? null)
    : null;
}

function requireInside(field, cx, cy, reach, settings) {
  const fromDisc =
    Math.hypot(cx - settings.discCentreX, cy - settings.discCentreY) + reach;
  if (fromDisc > settings.discRadiusPixels + 1e-9) {
    throw new RangeError(
      `the ring profile about (${cx}, ${cy}) reaches ${fromDisc.toFixed(1)} px from the disc centre, past discRadiusPixels ${settings.discRadiusPixels}; shrink rhoMaxPx or the centre search`,
    );
  }
  if (field !== null) {
    const inside = Math.min(cx, cy, field.width - cx, field.height - cy);
    if (reach > inside) {
      throw new RangeError(
        `the ring profile needs ${reach.toFixed(1)} px about (${cx}, ${cy}) and the ${field.width}x${field.height} frame leaves ${inside.toFixed(1)}; ringFamily refuses a partial annulus`,
      );
    }
  }
}

/**
 * Radial sums and counts about one centre, at the profile bin and at a quarter
 * of it, whole and split into octants of azimuth.
 */
function reduce(pixels, cx, cy, settings) {
  const { binPx, fineBinPx, extentPx } = settings;
  const coarse = binSums(pixels, cx, cy, binPx, extentPx);
  const fine = binSums(pixels, cx, cy, fineBinPx, extentPx);
  const octants = octantSums(pixels, cx, cy, binPx, extentPx);
  const fineOctants = octantSums(pixels, cx, cy, fineBinPx, extentPx);
  const sectors = octantSums(pixels, cx, cy, binPx, extentPx, SECTORS);
  const fineSectors = octantSums(pixels, cx, cy, fineBinPx, extentPx, SECTORS);
  const rows = (arrays) => arrays.map((row) => Array.from(row));
  return {
    centreX: cx,
    centreY: cy,
    binPx,
    sums: Array.from(coarse.sums),
    counts: Array.from(coarse.counts),
    fineBinPx,
    fineSums: Array.from(fine.sums),
    fineCounts: Array.from(fine.counts),
    octantSums: rows(octants.sums),
    octantCounts: rows(octants.counts),
    fineOctantSums: rows(fineOctants.sums),
    fineOctantCounts: rows(fineOctants.counts),
    sectorSums: rows(sectors.sums),
    sectorCounts: rows(sectors.counts),
    fineSectorSums: rows(fineSectors.sums),
    fineSectorCounts: rows(fineSectors.counts),
  };
}

function seriesFor(profile, settings, key) {
  const band = settings.bands[key];
  return key === "faster"
    ? bandSeries(profile.fineSums, profile.fineCounts, band)
    : bandSeries(profile.sums, profile.counts, band);
}

/**
 * A reduction's per-sector sums for one band, in the octant frame or the
 * sixteen-sector frame, or `null` when the reduction does not carry them.
 */
function sectorsFor(profile, key, frame) {
  const stem = key === "faster" ? `fine${frame}` : frame.toLowerCase();
  const sums = profile[`${stem}Sums`];
  const counts = profile[`${stem}Counts`];
  return Array.isArray(sums) && Array.isArray(counts) ? { sums, counts } : null;
}

/**
 * One band's lines about one centre, with the per-sector profiles (octants
 * and sixteenths) to judge them.
 * `known` are fitted families already found about this centre; they are
 * removed from the series first, because a strong family's chirp spreads
 * across every frequency and raises the floor a neighbour's line is measured
 * against.
 */
function sideAbout(profile, settings, key, centre, known = []) {
  const band = settings.bands[key];
  const { series } = seriesFor(profile, settings, key);
  const cleared =
    known.length === 0
      ? series
      : Float64Array.from(series, (value, bin) => {
          const rho = (bin + 0.5) * band.binPx;
          return known.reduce(
            (rest, fit) => rest - fittedValue(rho, fit),
            value,
          );
        });
  return {
    centre,
    analysis: analyseBand(
      cleared,
      band,
      settings.exponents,
      RING_DETECTION_SNR / 4,
    ),
    octants: sectorsFor(profile, key, "Octant"),
    sectors: sectorsFor(profile, key, "Sector"),
  };
}

/** The share of the window over which a line's period lies in each band. */
function sharesOf(line, settings) {
  const { rhoMinPx, rhoMaxPx, minPx, maxPx } = settings;
  const shares = { faster: 0, inBand: 0, slower: 0 };
  const steps = Math.max(1, Math.round(rhoMaxPx - rhoMinPx));
  for (let k = 0; k < steps; k++) {
    const rho = rhoMinPx + ((k + 0.5) * (rhoMaxPx - rhoMinPx)) / steps;
    const period = periodAt(rho, line);
    shares[period < minPx ? "faster" : period > maxPx ? "slower" : "inBand"] +=
      1 / steps;
  }
  return shares;
}

function cyclesOver(line, band) {
  return (
    line.frequency *
    (boxCox(band.to, line.exponent) - boxCox(band.from, line.exponent))
  );
}

/**
 * Judge every line of one band's analysis. A line is a family when it is an
 * interior maximum of its search range, clears `RING_DETECTION_SNR` against
 * its local floor, carries a fitted RMS of at least the ABSENT class (a
 * scale-free SNR alone lets any deterministic ripple over a quiet floor
 * through), is carried in phase around its centre in each sector frame the
 * reduction carries, and has an owner: a band its series may report for (the
 * visible band's series reports for itself and the slower band) over whose
 * periods it lies for `SHARE_TO_CLAIM` of the window. A slower owner also needs
 * `MIN_CYCLES` cycles in the window the line was measured over.
 */
function judge(side, key, settings) {
  const band = settings.bands[key];
  const owners = key === "inBand" ? ["inBand", "slower"] : [key];
  return side.analysis.lines.map((line) => {
    const shares = sharesOf(line, settings);
    const cycles = cyclesOver(line, band);
    const ring =
      side.octants === null ? null : concentricity(side.octants, band, line);
    const sixteenths =
      side.sectors === null
        ? null
        : concentricity(side.sectors, band, line, CONCENTRIC_SECTORS);
    const strong =
      line.interior &&
      line.snr >= RING_DETECTION_SNR &&
      line.lineRms >= RING_AMPLITUDE_CLASSES.absent;
    const owner =
      owners.find((candidate) => shares[candidate] >= SHARE_TO_CLAIM) ?? null;
    const inReach = owner !== "slower" || cycles >= MIN_CYCLES;
    return {
      ...line,
      centre: side.centre,
      shares,
      cycles,
      owner,
      concentricity: ring,
      sectorConcentricity: sixteenths,
      isFamily:
        strong &&
        owner !== null &&
        inReach &&
        (ring === null || ring.concentric) &&
        (sixteenths === null || sixteenths.concentric),
    };
  });
}

/**
 * True when a visible-band line is an alias. Binning a family finer than two
 * bins folds it to `|bins/period - round(bins/period)|` cycles per bin,
 * which can land inside the visible band; the same pixels binned at a quarter
 * of a bin resolve the family at its own period and carry nothing at the
 * folded one. A real visible family keeps at least half its amplitude there
 * (the finer bins attenuate it less, not more).
 */
function aliased(line, inSeries, fineSeries, settings) {
  const amplitude = (series, band) => {
    const [a, b] = fitLines(series, band, [{ ...line, harmonics: [1] }])[0]
      .coefficients;
    return Math.hypot(a, b);
  };
  return (
    amplitude(fineSeries, settings.bands.fineVisible) <
    0.5 * amplitude(inSeries, settings.bands.inBand)
  );
}

function describeFamily(line, settings) {
  const { rhoMinPx, rhoMaxPx } = settings;
  return {
    centre: { x: line.centre.x, y: line.centre.y },
    boundary: line.centre.boundary ?? null,
    law: lawName(line.exponent),
    lawExponent: line.exponent,
    lawMargin: line.lawMargin,
    quantum: 1 / line.frequency,
    periodPx: {
      atRhoMin: periodAt(rhoMinPx, line),
      atMid: periodAt(Math.sqrt(rhoMinPx * rhoMaxPx), line),
      atRhoMax: periodAt(rhoMaxPx, line),
    },
    snr: line.snr,
    concentration: line.concentration,
    lineRms: line.lineRms,
    bandCoverage: line.shares.inBand,
    concentricity: line.concentricity,
    sectorConcentricity: line.sectorConcentricity,
    model: {
      exponent: line.exponent,
      frequency: line.frequency,
      harmonics: line.harmonics,
      coefficients: line.coefficients,
      ramp: line.ramp,
    },
  };
}

function summarise(line, settings) {
  if (!line) {
    return null;
  }
  return {
    centre: line.centre,
    exponent: line.exponent,
    periodAtMidPx: periodAt(
      Math.sqrt(settings.rhoMinPx * settings.rhoMaxPx),
      line,
    ),
    snr: line.snr,
    interior: line.interior,
    lineRms: line.lineRms,
    bandCoverage: line.shares.inBand,
    shares: line.shares,
    cycles: line.cycles,
    owner: line.owner,
    concentricOctants: line.concentricity?.inPhase ?? null,
    concentricSectors: line.sectorConcentricity?.inPhase ?? null,
    opposedSectors: line.sectorConcentricity?.opposed ?? null,
    aliasOfFaster: line.aliasOfFaster ?? false,
    detected: line.isFamily && !line.aliasOfFaster,
  };
}

/**
 * The verdict about one centre. An amplitude read about a centre pinned at the
 * search's edge is a lower bound, so it can still say PRESENT but never
 * ABSENT.
 */
function classify(familyCount, refusal, bandPassRms, centre) {
  if (familyCount > 0) {
    return bandPassRms >= RING_AMPLITUDE_CLASSES.present
      ? "PRESENT"
      : "INCONCLUSIVE";
  }
  if (refusal !== null) {
    return "REFUSED";
  }
  return bandPassRms <= RING_AMPLITUDE_CLASSES.absent && !centre.boundary
    ? "ABSENT"
    : "INCONCLUSIVE";
}

/**
 * The pixel pass: radial sums and counts about one centre, at the profile bin
 * and at a quarter of it, whole, per octant and per sixteenth of azimuth, out
 * to the extent the statistics need. Split out so a banked capture can be checked in as its
 * reduction, as `radialProfile` is for the ladder.
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} field Scalar field.
 * @param {{x:number,y:number}} centre Centre to bin about.
 * @param {object} camera See {@link ringFamily}.
 * @param {object} [options] See {@link ringFamily}.
 * @returns {object} The reduction.
 */
export function ringFamilyProfile(field, centre, camera, options = {}) {
  const settings = resolveFamilySettings(camera, options);
  requireInside(field, centre.x, centre.y, settings.extentPx, settings);
  const pixels = collectPixels(field, centre.x, centre.y, settings.extentPx);
  return reduce(pixels, centre.x, centre.y, settings);
}

/**
 * The statistics pass over a {@link ringFamilyProfile} reduction, about the
 * reduction's own centre. A reduction without the quarter-pixel arrays (a
 * checked-in fixture may omit them for size) reports the faster neighbour as
 * `null`: not measured, rather than measured and empty. One without the
 * sixteen-sector arrays (the checked-in banked reductions carry octants only)
 * is judged by the octant frame alone and reports `sectorConcentricity:
 * null`; one without the octant arrays as well reports `concentricity:
 * null` and cannot refuse a line for being carried on one side only.
 *
 * @param {object} profile The reduction.
 * @param {object} camera See {@link ringFamily}.
 * @param {object} [options] See {@link ringFamily}.
 * @param {object} [found] What {@link ringFamily} measured beyond the profile:
 *   `centre` (the centre block), `sides` (neighbour-band analyses about their
 *   own centres), `moreFamilies` (families about a further centre) and
 *   `further` (what the further-centre search found, reported as it is).
 *   Absent, the profile's centre is reported with `source: "profile"` and the
 *   neighbours are analysed about it.
 * @returns {object} The statistics.
 */
export function ringFamilyFromProfile(
  profile,
  camera,
  options = {},
  found = {},
) {
  const settings = resolveFamilySettings(camera, options);
  if (profile.binPx !== settings.binPx) {
    throw new RangeError(
      `the profile was binned at ${profile.binPx} px and the statistics were asked for ${settings.binPx} px`,
    );
  }
  if (profile.sums.length * profile.binPx < settings.extentPx - 1e-9) {
    throw new RangeError(
      `the profile reaches ${profile.sums.length * profile.binPx} px and the statistics need ${settings.extentPx} px`,
    );
  }
  const { minPx, maxPx, rhoMinPx, rhoMaxPx, bands } = settings;
  const here = {
    x: profile.centreX,
    y: profile.centreY,
    boundary: found.centre?.boundary ?? null,
  };
  const inSeries = seriesFor(profile, settings, "inBand");
  const inBand = sideAbout(profile, settings, "inBand", here);
  const inLines = judge(inBand, "inBand", settings);
  const fineSeries = Array.isArray(profile.fineSums)
    ? bandSeries(
        profile.fineSums,
        profile.fineCounts,
        settings.bands.fineVisible,
      ).series
    : null;
  for (const line of inLines) {
    line.aliasOfFaster =
      fineSeries !== null &&
      line.owner === "inBand" &&
      aliased(line, inSeries.series, fineSeries, settings);
  }
  const window = { from: rhoMinPx, to: rhoMaxPx };
  const midRho = Math.sqrt(rhoMinPx * rhoMaxPx);
  const visible = inLines.filter(
    (line) => line.isFamily && line.owner === "inBand" && !line.aliasOfFaster,
  );
  const sideLines = {};
  for (const key of ["slower", "faster"]) {
    const side =
      found.sides?.[key] ??
      (key === "faster" && !Array.isArray(profile.fineSums)
        ? null
        : sideAbout(profile, settings, key, here, visible));
    sideLines[key] = side === null ? null : judge(side, key, settings);
  }
  const fasterFamilies = (sideLines.faster ?? []).filter(
    (line) => line.isFamily,
  );
  const families = visible.map((line) => describeFamily(line, settings));
  families.push(...(found.moreFamilies ?? []));
  // A family another band owns is refused, unless it is a visible family seen
  // again from the other side of a band edge or as its own overtone, or an
  // overtone of a stronger, slower line that is no family itself: a family
  // beyond the band's reach, or a low-duty one, is not refused through its
  // harmonics. Several series can measure one
  // family, so each family keeps its best-measured line. A refusal never
  // hides a visible family: both are reported.
  const everyLine = [
    ...inLines,
    ...(sideLines.slower ?? []),
    ...(sideLines.faster ?? []),
  ];
  const echoes = (line) =>
    everyLine.some(
      (other) =>
        !other.isFamily &&
        other.lineRms > line.lineRms &&
        periodAt(midRho, other) > periodAt(midRho, line) &&
        sameFamily(other, line, window, 2, 2),
    );
  const candidates = [
    ...inLines.filter((line) => line.owner === "slower"),
    ...(sideLines.slower ?? []),
    ...fasterFamilies,
  ]
    .filter((line) => line.isFamily && !echoes(line))
    .filter((line) => !visible.some((known) => sameFamily(known, line, window)))
    .sort((a, b) => b.snr - a.snr);
  const distinct = [];
  for (const line of candidates) {
    if (!distinct.some((kept) => sameFamily(kept, line, window))) {
      distinct.push(line);
    }
  }
  const refused = distinct.reduce(
    (strongest, line) =>
      strongest === null || line.lineRms > strongest.lineRms ? line : strongest,
    null,
  );
  const refusal =
    refused === null
      ? null
      : {
          name:
            refused.owner === "slower"
              ? RING_FAMILY_REFUSALS.slowerThanBand
              : RING_FAMILY_REFUSALS.fasterThanBand,
          periodAtMidPx: periodAt(Math.sqrt(rhoMinPx * rhoMaxPx), refused),
          law: lawName(refused.exponent),
          lawExponent: refused.exponent,
          snr: refused.snr,
          lineRms: refused.lineRms,
          share: refused.shares[refused.owner],
          cycles: refused.cycles,
          band: { minPx, maxPx },
          centre: refused.centre,
          concentricity: refused.concentricity,
          sectorConcentricity: refused.sectorConcentricity,
        };
  const centre = found.centre ?? { ...here, source: "profile" };
  const bandPassRms = inSeries.rms;
  const verdict = classify(families.length, refusal, bandPassRms, centre);
  return {
    centre,
    window: { rhoMinPx, rhoMaxPx, binPx: settings.binPx },
    visiblePeriodBand: {
      minPx,
      maxPx,
      detrendWindowPx: (2 * bands.inBand.halfBins + 1) * settings.binPx,
      fasterReachPx: bands.faster.reachPx,
      slowerReachPx: bands.slower.reachPx,
    },
    bandPassRms,
    detected: families.length > 0,
    familyCount: families.length,
    family: families[0] ?? null,
    families,
    strongestInBandLine: summarise(inLines[0], settings),
    inBandLines: inLines.map((line) => summarise(line, settings)),
    laws: inBand.analysis.laws.map(({ exponent, concentration, snr }) => ({
      exponent,
      concentration,
      snr,
    })),
    neighbours: {
      slower: summarise(sideLines.slower?.[0], settings),
      faster: summarise(sideLines.faster?.[0], settings),
    },
    refusal,
    verdict,
    further: found.further ?? null,
    amplitudeClasses: RING_AMPLITUDE_CLASSES,
    provisional: true,
  };
}

/**
 * Families about one further centre, looked for with the found families'
 * fitted rings removed from the pixels. A family found within one period of a
 * known family's centre is that family's remainder (a law that is not quite a
 * power, its azimuthal modulation, or a pair closer than half a period that
 * no single centre resolves): a second family about the same centre is found
 * in the first profile, not by a further search. A further centre stopped at
 * the edge of the search carries its own `CENTRE_AT_SEARCH_BOUNDARY`: what
 * is measured about it is withheld, never reported as a family, and that
 * search reads INCONCLUSIVE.
 */
function furtherFamilies(first, pixels, sparse, settings, camera, options) {
  const fits = first.families.map((family) => family.model);
  const { x, y } = first.centre;
  const inner = 0.5 * settings.rhoMinPx;
  const cleared = withoutFamily(pixels, x, y, fits, inner);
  const clearedSparse = withoutFamily(sparse, x, y, fits, inner);
  const at = locateCentre(
    cleared,
    clearedSparse,
    settings,
    settings.bands.inBand,
    { x: null, y: null },
  );
  const next = ringFamilyFromProfile(
    reduce(cleared, at.x, at.y, settings),
    camera,
    options,
    { centre: { ...at } },
  );
  const found = next.families.filter(
    (family) =>
      !first.families.some(
        (known) =>
          Math.hypot(known.centre.x - at.x, known.centre.y - at.y) <
          Math.max(3, known.periodPx.atMid),
      ),
  );
  const families = at.boundary === null ? found : [];
  return {
    families,
    search: {
      centre: { x: at.x, y: at.y },
      boundary: at.boundary,
      familyCount: families.length,
      withheld: at.boundary === null ? [] : found,
      remainders: next.families.length - found.length,
      bandPassRms: next.bandPassRms,
      verdict: classify(families.length, null, next.bandPassRms, at),
    },
  };
}

/**
 * Ring-family statistics over a disc capture.
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} field Scalar
 *   field, one value per pixel, row-major, in luminance units.
 * @param {object} camera `centreX`, `centreY` (the DISC centre),
 *   `discRadiusPixels` and `visiblePeriodBand: {minPx, maxPx}`; a rig's `disc`
 *   block carries all four.
 * @param {object} [options] `rhoMinPx` (40), `rhoMaxPx` (400), `binPx` (1),
 *   `centreSearchPx` (48: how far from the disc centre the family centre may
 *   lie), `refineCentre` (true), `lawExponents`.
 * @returns {object} `centre` (the centre used, the stated centre, the
 *   fringe-normal and grid estimates, and `boundary` when the search ran into
 *   its edge), `bandPassRms`, `detected`, `families` (and `family`, the
 *   strongest; each carries its centre's `boundary`), `refusal`, `verdict`,
 *   `further` (the further-centre search once a family is found: its centre,
 *   its own `boundary`, the families it withheld there and its own verdict),
 *   the per-law table and the neighbour bands.
 */
export function ringFamily(field, camera, options = {}) {
  const settings = resolveFamilySettings(camera, options);
  if (field?.data?.length !== field?.width * field?.height) {
    throw new TypeError(
      `field.data must hold width*height values, got ${String(field?.data?.length)}`,
    );
  }
  const { discCentreX, discCentreY, extentPx, centreSearchPx } = settings;
  const reach = extentPx + centreSearchPx;
  requireInside(field, discCentreX, discCentreY, reach, settings);
  const pixels = collectPixels(field, discCentreX, discCentreY, reach);
  const stated = { x: discCentreX, y: discCentreY };
  let centre = { ...stated, source: "stated", boundary: null };
  let search = null;
  if (settings.refineCentre) {
    search = {
      sparse: collectPixels(field, discCentreX, discCentreY, reach, 2),
      fringe: fringeNormalCentre(field, settings),
    };
    centre = locateCentre(
      pixels,
      search.sparse,
      settings,
      settings.bands.inBand,
      search.fringe,
    );
  }
  centre.stated = stated;
  centre.fringeNormal = search?.fringe ?? null;
  centre.offsetFromStatedPx = Math.hypot(
    centre.x - stated.x,
    centre.y - stated.y,
  );
  const profile = reduce(pixels, centre.x, centre.y, settings);
  const first = ringFamilyFromProfile(profile, camera, options, { centre });
  if (search === null) {
    return first;
  }
  if (first.detected) {
    const further = furtherFamilies(
      first,
      pixels,
      search.sparse,
      settings,
      camera,
      options,
    );
    return further.families.length === 0
      ? { ...first, further: further.search }
      : ringFamilyFromProfile(profile, camera, options, {
          centre,
          moreFamilies: further.families,
          further: further.search,
        });
  }
  // Nothing in the band: look for each neighbour's family about ITS centre.
  const sides = {};
  for (const key of ["slower", "faster"]) {
    const at = locateCentre(
      pixels,
      search.sparse,
      settings,
      settings.bands[key],
      search.fringe,
    );
    sides[key] = sideAbout(
      reduce(pixels, at.x, at.y, settings),
      settings,
      key,
      { x: at.x, y: at.y, boundary: at.boundary },
    );
  }
  return ringFamilyFromProfile(profile, camera, options, { centre, sides });
}
