/**
 * @purpose Spectral half of the ring-family estimator: band-passes a radial profile, finds its lines by a Box-Cox periodogram over a scan of radial laws, fits and removes each line so a second family is not hidden in the first one's chirp, measures every line against a local floor that excludes the line's own harmonics, and tests a line's concentricity from per-octant profiles.
 * @status ACTIVE
 *
 * Pure one-dimensional work: every function here takes a radial profile (or
 * one per sector of azimuth) and never touches pixels, so a checked-in
 * reduction is scored by exactly the code that scores a frame.
 *
 * A LINE IS SOUGHT PAST THE BAND'S EDGES. Each band declares a search range
 * wider than the periods it owns, so a family sitting on a band edge is an
 * interior maximum of the periodogram and a family whose period at the
 * window's middle lies outside the band is still found at its own law. Which
 * band a line belongs to is decided afterwards, from the share of the window
 * over which its period lies in each band.
 *
 * LINES ARE REMOVED ONE AT A TIME AND RE-MEASURED WITH THE OTHERS GONE. Two
 * families with different laws about one centre are each a chirp under the
 * other's law, and a chirp raises the local floor the other is measured
 * against. So the strongest line is fitted by least squares (with the
 * harmonics the binning resolves), subtracted, and the search repeated; every
 * line is then re-measured on the profile with all the other lines removed.
 * Lines whose phases never part by more than two cycles across the window
 * under the same law are one family's modulation, not two families.
 */

/** Lines extracted from one band's profile before the search stops. */
export const MAX_LINES = 3;

/** Octants of azimuth a concentric family must be carried in, in phase. */
export const CONCENTRIC_OCTANTS = 6;

/**
 * Sectors of the sixteen-sector frame a concentric family must be carried in,
 * in phase, and the most it may be carried in against its phase.
 */
export const CONCENTRIC_SECTORS = Object.freeze({ required: 12, opposed: 0 });

export function boxCox(rho, exponent) {
  return exponent === 0 ? Math.log(rho) : (rho ** exponent - 1) / exponent;
}
function boxCoxInverse(s, exponent) {
  return exponent === 0 ? Math.exp(s) : (1 + exponent * s) ** (1 / exponent);
}
function boxCoxSlope(rho, exponent) {
  return rho ** (exponent - 1);
}

/** A line's period at one radius, in pixels. */
export function periodAt(rho, line) {
  return 1 / (line.frequency * boxCoxSlope(rho, line.exponent));
}

/**
 * Profile minus its centred moving average over finite entries, `2 * half + 1`
 * bins wide and edge-clamped: everything slower than the window is removed.
 */
export function detrend(values, half) {
  const out = Float64Array.from(values);
  if (half > 0) {
    for (let index = 0; index < values.length; index++) {
      let sum = 0;
      let count = 0;
      const to = Math.min(values.length - 1, index + half);
      for (let k = Math.max(0, index - half); k <= to; k++) {
        sum += Number.isFinite(values[k]) ? values[k] : 0;
        count += Number.isFinite(values[k]) ? 1 : 0;
      }
      out[index] -= count > 0 ? sum / count : NaN;
    }
  }
  return out;
}

export function profileMean(sums, counts) {
  return Float64Array.from(sums, (sum, index) =>
    counts[index] > 0 ? sum / counts[index] : NaN,
  );
}

/** A band's detrended profile and its RMS over the band's window. */
export function bandSeries(sums, counts, band) {
  const series = detrend(profileMean(sums, counts), band.halfBins);
  let sum = 0;
  let used = 0;
  for (let bin = 0; bin < series.length; bin++) {
    const rho = (bin + 0.5) * band.binPx;
    if (rho >= band.from && rho <= band.to && Number.isFinite(series[bin])) {
      sum += series[bin] ** 2;
      used++;
    }
  }
  return { series, rms: used > 0 ? Math.sqrt(sum / used) : 0 };
}

/**
 * Periodogram of a band-passed profile resampled uniformly in one Box-Cox
 * coordinate, over the frequencies whose period at the window's geometric
 * middle lies in the band's search range, plus the cells either side that the
 * local floor is read from.
 */
function lawPeriodogram(series, band, exponent) {
  const { binPx, from, to } = band;
  const sFrom = boxCox(from, exponent);
  const span = boxCox(to, exponent) - sFrom;
  const samples = Math.max(16, 2 * Math.round((to - from) / binPx));
  const values = new Float64Array(samples);
  const hann = new Float64Array(samples);
  let hannSum = 0;
  let hannSquares = 0;
  let weighted = 0;
  for (let k = 0; k < samples; k++) {
    const rho = boxCoxInverse(sFrom + (span * k) / (samples - 1), exponent);
    const position = rho / binPx - 0.5;
    const low = Math.max(0, Math.min(series.length - 2, Math.floor(position)));
    const t = position - low;
    const a = Number.isFinite(series[low]) ? series[low] : 0;
    const b = Number.isFinite(series[low + 1]) ? series[low + 1] : 0;
    values[k] = a * (1 - t) + b * t;
    hann[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (samples - 1));
    hannSum += hann[k];
    hannSquares += hann[k] * hann[k];
    weighted += hann[k] * values[k];
  }
  let energy = 0;
  for (let k = 0; k < samples; k++) {
    values[k] = (values[k] - weighted / hannSum) * hann[k];
    energy += values[k] * values[k];
  }
  const sampleStep = span / (samples - 1);
  const midSlope = boxCoxSlope(Math.sqrt(from * to), exponent);
  const step = 1 / (8 * span);
  const first = 2 / span;
  const cells = Math.floor((1 / (2 * sampleStep) - first) / step) + 1;
  let searchFrom = -1;
  let searchTo = -1;
  for (let cell = 0; cell < cells; cell++) {
    const period = 1 / ((first + cell * step) * midSlope);
    if (period >= band.searchMinPx && period <= band.searchMaxPx) {
      searchFrom = searchFrom < 0 ? cell : searchFrom;
      searchTo = cell;
    }
  }
  const lo = searchFrom < 0 ? 0 : Math.max(0, searchFrom - 96);
  const hi = searchFrom < 0 ? -1 : Math.min(cells - 1, searchTo + 96);
  const frequencies = [];
  const powers = [];
  for (let cell = lo; cell <= hi; cell++) {
    const f = first + cell * step;
    // Rotate a unit phasor rather than calling cos/sin per sample.
    const omega = 2 * Math.PI * f * sampleStep;
    const cw = Math.cos(omega);
    const sw = Math.sin(omega);
    let c = 1;
    let sn = 0;
    let re = 0;
    let im = 0;
    for (let k = 0; k < samples; k++) {
      re += values[k] * c;
      im -= values[k] * sn;
      const next = c * cw - sn * sw;
      sn = c * sw + sn * cw;
      c = next;
    }
    frequencies.push(f);
    powers.push(re * re + im * im);
  }
  return {
    frequencies,
    powers,
    searchFrom: searchFrom - lo,
    searchTo: searchTo - lo,
    energy,
    pureTone: (hannSum * hannSum) / (2 * hannSquares),
    hannSum,
  };
}

/**
 * The strongest line of one periodogram over its search range, or the local
 * maximum within two resolution cells of `near`, measured against its local
 * floor.
 */
function strongestLine(gram, near = null) {
  const { frequencies, powers, searchFrom, searchTo } = gram;
  if (searchFrom < 0 || searchTo - searchFrom < 2) {
    return null;
  }
  const spacing = frequencies[1] - frequencies[0];
  const cellOf = (f) => Math.round((f - frequencies[0]) / spacing);
  let at = -1;
  if (near === null) {
    at = searchFrom;
    for (let index = searchFrom + 1; index <= searchTo; index++) {
      if (powers[index] > powers[at]) {
        at = index;
      }
    }
    // A harmonic can out-power its fundamental in a pulse train, so the lowest
    // sub-multiple carrying at least half the peak's power is the line.
    for (const divisor of [3, 2]) {
      const centre = cellOf(frequencies[at] / divisor);
      let found = -1;
      const to = Math.min(searchTo, centre + 4);
      for (let index = Math.max(searchFrom, centre - 4); index <= to; index++) {
        if (found < 0 || powers[index] > powers[found]) {
          found = index;
        }
      }
      if (found >= 0 && powers[found] >= 0.5 * powers[at]) {
        at = found;
        break;
      }
    }
  } else {
    const centre = cellOf(near);
    const to = Math.min(searchTo, centre + 16);
    for (let index = Math.max(searchFrom, centre - 16); index <= to; index++) {
      if (at < 0 || powers[index] > powers[at]) {
        at = index;
      }
    }
    if (at < 0) {
      return null;
    }
  }
  // The floor is LOCAL: the median power 3 to 12 resolution cells (8 grid
  // steps each) either side of the line. A red background has a steep
  // spectrum that a global median would call a line at its low-frequency
  // end.
  const neighbours = [];
  for (let index = Math.max(0, at - 96); index <= at + 96; index++) {
    if (index < powers.length && Math.abs(index - at) >= 24) {
      neighbours.push(powers[index]);
    }
  }
  const floor = Float64Array.from(neighbours).sort();
  const median = floor.length > 0 ? floor[floor.length >> 1] : 0;
  const peak = powers[at];
  const interior = at > searchFrom && at < searchTo;
  let frequency = frequencies[at];
  if (at > 0 && at < powers.length - 1) {
    const denominator = powers[at - 1] - 2 * peak + powers[at + 1];
    const shift =
      denominator < 0
        ? (0.5 * (powers[at - 1] - powers[at + 1])) / denominator
        : 0;
    frequency += Math.abs(shift) <= 1 ? shift * spacing : 0;
  }
  return {
    frequency,
    interior,
    snr: median > 0 ? peak / median : peak > 0 ? Infinity : 0,
    concentration: gram.energy > 0 ? peak / gram.energy / gram.pureTone : 0,
  };
}

/**
 * Scan the law exponents over one band's series, keep the exponent with the
 * most concentrated line, polish it by a parabola, and measure the line there.
 */
function scanLaws(series, band, exponents) {
  const laws = [];
  for (const exponent of exponents) {
    const line = strongestLine(lawPeriodogram(series, band, exponent));
    if (line !== null) {
      laws.push({ exponent, ...line });
    }
  }
  if (laws.length === 0) {
    return { laws, line: null };
  }
  let at = 0;
  for (let index = 1; index < laws.length; index++) {
    if (laws[index].concentration > laws[at].concentration) {
      at = index;
    }
  }
  let exponent = laws[at].exponent;
  if (at > 0 && at < laws.length - 1) {
    const left = laws[at - 1].concentration;
    const right = laws[at + 1].concentration;
    const denominator = left - 2 * laws[at].concentration + right;
    const shift = denominator < 0 ? (0.5 * (left - right)) / denominator : 0;
    if (Math.abs(shift) <= 1) {
      exponent += shift * (laws[at + 1].exponent - laws[at].exponent);
    }
  }
  const polished =
    exponent === laws[at].exponent
      ? laws[at]
      : (strongestLine(lawPeriodogram(series, band, exponent)) ?? laws[at]);
  let rival = 0;
  for (const law of laws) {
    if (Math.abs(law.exponent - exponent) >= 0.75) {
      rival = Math.max(rival, law.concentration);
    }
  }
  return {
    laws,
    line: {
      ...polished,
      exponent,
      lawMargin: rival > 0 ? polished.concentration / rival : Infinity,
    },
  };
}

/** Harmonics of a line the binning resolves everywhere in the band's window. */
function harmonicsOf(line, band) {
  const shortest = Math.min(periodAt(band.from, line), periodAt(band.to, line));
  return [1, 2, 3].filter((h) => h === 1 || shortest / h >= 2.5 * band.binPx);
}

/** Where a ramped fit's amplitude slope is measured from, clamped to its window. */
function rampAt(rho, ramp) {
  return Math.max(-1, Math.min(1, (rho - ramp.mid) / ramp.half));
}

function basisAt(rho, lines) {
  const row = [1];
  for (const line of lines) {
    const phase = 2 * Math.PI * line.frequency * boxCox(rho, line.exponent);
    for (const h of line.harmonics) {
      const c = Math.cos(h * phase);
      const sn = Math.sin(h * phase);
      row.push(c, sn);
      if (line.ramp) {
        const t = rampAt(rho, line.ramp);
        row.push(t * c, t * sn);
      }
    }
  }
  return row;
}

/** Solve a small dense system by Gaussian elimination with partial pivoting. */
function solve(matrix, rhs, n) {
  const a = Float64Array.from(matrix);
  const b = Float64Array.from(rhs);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row * n + col]) > Math.abs(a[pivot * n + col])) {
        pivot = row;
      }
    }
    if (!(Math.abs(a[pivot * n + col]) > 1e-300)) {
      return null;
    }
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        [a[col * n + k], a[pivot * n + k]] = [a[pivot * n + k], a[col * n + k]];
      }
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    for (let row = col + 1; row < n; row++) {
      const factor = a[row * n + col] / a[col * n + col];
      for (let k = col; k < n; k++) {
        a[row * n + k] -= factor * a[col * n + k];
      }
      b[row] -= factor * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row];
    for (let k = row + 1; k < n; k++) {
      sum -= a[row * n + k] * x[k];
    }
    x[row] = sum / a[row * n + row];
  }
  return x;
}

/**
 * Joint least-squares fit of every line (a sinusoid in its own Box-Cox
 * coordinate, with the harmonics the binning resolves) and a constant, over
 * the band's window. Returns one fit per line: its coefficients, the RMS of
 * its fundamental in the series' units and the fundamental's phase, and (the
 * same for every line of one fit) the variance per bin the lines explain
 * beyond the constant and the variance they leave. A law is judged by the
 * variance it explains, never by the amplitude it fits: a wrong law can fit a
 * larger sinusoid while explaining less of the profile. With
 * `ramped`, each sinusoid also carries an amplitude that changes linearly
 * across the window: a real family's amplitude is not constant in radius,
 * and a constant-amplitude model leaves a residue that raises the floor
 * other lines are measured against once it is subtracted.
 */
export function fitLines(series, band, lines, ramped = false) {
  const ramp = ramped
    ? { mid: (band.from + band.to) / 2, half: (band.to - band.from) / 2 }
    : null;
  const withHarmonics = lines.map((line) => ({
    exponent: line.exponent,
    frequency: line.frequency,
    harmonics: line.harmonics ?? harmonicsOf(line, band),
    ramp,
  }));
  const n = basisAt(band.from, withHarmonics).length;
  const matrix = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  let squares = 0;
  for (let bin = 0; bin < series.length; bin++) {
    const rho = (bin + 0.5) * band.binPx;
    if (rho < band.from || rho > band.to || !Number.isFinite(series[bin])) {
      continue;
    }
    squares += series[bin] * series[bin];
    const row = basisAt(rho, withHarmonics);
    for (let i = 0; i < n; i++) {
      rhs[i] += row[i] * series[bin];
      for (let j = 0; j < n; j++) {
        matrix[i * n + j] += row[i] * row[j];
      }
    }
  }
  const x = solve(matrix, rhs, n) ?? new Float64Array(n);
  const bins = matrix[0];
  const aboutMean = bins > 0 ? squares - (rhs[0] * rhs[0]) / bins : 0;
  let captured = 0;
  for (let i = 0; i < n; i++) {
    captured += x[i] * rhs[i];
  }
  const explained = bins > 0 ? (captured - (rhs[0] * rhs[0]) / bins) / bins : 0;
  const unexplained = bins > 0 ? Math.max(0, aboutMean / bins - explained) : 0;
  let at = 1;
  const perHarmonic = ramp === null ? 2 : 4;
  return withHarmonics.map((line) => {
    const count = perHarmonic * line.harmonics.length;
    const coefficients = Array.from(x.subarray(at, at + count));
    at += count;
    const [a, b] = coefficients;
    return {
      ...line,
      coefficients,
      lineRms: Math.sqrt((a * a + b * b) / 2),
      phase: Math.atan2(-b, a),
      explained,
      unexplained,
    };
  });
}

/** A fitted line's value at one radius, harmonics included, constant excluded. */
export function fittedValue(rho, fit) {
  const phase = 2 * Math.PI * fit.frequency * boxCox(rho, fit.exponent);
  const per = fit.ramp ? 4 : 2;
  const t = fit.ramp ? rampAt(rho, fit.ramp) : 0;
  let value = 0;
  fit.harmonics.forEach((h, index) => {
    const [a, b, c = 0, d = 0] = fit.coefficients.slice(
      per * index,
      per * index + per,
    );
    value +=
      (a + c * t) * Math.cos(h * phase) + (b + d * t) * Math.sin(h * phase);
  });
  return value;
}

/**
 * Polish a line's law and period by maximising the power of its least-squares
 * sinusoid over the window's bins, which weights every radius alike. The
 * periodogram's concentration picks the law from a Hann window in the law's
 * own coordinate, so its weighting over radius shifts with the exponent and
 * biases the exponent it picks by a few hundredths, which is several per cent
 * of period at the window's inner edge. The period is pivoted at the window's
 * arithmetic middle, the centre of that uniform weight, where a change of law
 * and a change of period move the fit independently. The search is local: a
 * 9 by 9 grid over half a resolution cell of period and a tenth of an
 * exponent either way (wider, and the fit's side lobes across a long chirp
 * compete with its peak), then alternating golden sections that shrink.
 *
 * The fit uses only the radii where the line's period is one the band's
 * detrend passes (`band.passMaxPx`). A chirp that crosses out of the band
 * inside the window has been flattened by the detrend there, and fitting its
 * law across that stretch pulls the law toward whatever fits the remnant.
 */
function refineLine(series, band, line) {
  const passing = passingWindow(band, line);
  return passing === null
    ? line
    : refineWithin(series, passing, refineWithin(series, passing, line));
}

/**
 * A line's nearest named law (0, 1 or 2) when it explains the line within the
 * line's noise: a fit at the named exponent, its period re-found, that keeps
 * at least `1 - 1/sqrt(snr)` of the best fit's power. A family of a few
 * cycles constrains its exponent only loosely, and a tilt of a tenth of an
 * exponent moves the period at the window's inner edge by a tenth; a strong
 * family whose law is truly between the named ones keeps its own exponent.
 */
function namedLawWithinNoise(series, band, line) {
  const named = Math.round(line.exponent);
  if (
    ![0, 1, 2].includes(named) ||
    Math.abs(line.exponent - named) > 0.25 ||
    !(line.snr > 1)
  ) {
    return line;
  }
  const window = passingWindow(band, line);
  const mid = (window.from + window.to) / 2;
  const power = (exponent, periodMid) =>
    lawFit(series, window, exponent, periodMid, mid);
  const periodMid = periodAt(mid, line);
  const best = power(line.exponent, periodMid);
  const cycles =
    line.frequency *
    (boxCox(window.to, line.exponent) - boxCox(window.from, line.exponent));
  const span = 0.5 / Math.max(1, cycles);
  let found = { value: -Infinity, period: periodMid };
  for (let j = -24; j <= 24; j++) {
    const period = periodMid * (1 + (span * j) / 24);
    const value = power(named, period);
    if (value > found.value) {
      found = { value, period };
    }
  }
  if (found.value < best * (1 - 1 / Math.sqrt(line.snr))) {
    return line;
  }
  return {
    ...line,
    exponent: named,
    frequency: 1 / (found.period * boxCoxSlope(mid, named)),
  };
}

/**
 * How well one law fits: the variance per bin a single sinusoid of that law
 * and period (at radius `mid`) explains over the window.
 */
function lawFit(series, window, exponent, periodMid, mid) {
  const [fit] = fitLines(series, window, [
    {
      exponent,
      frequency: 1 / (periodMid * boxCoxSlope(mid, exponent)),
      harmonics: [1],
    },
  ]);
  return fit.explained;
}

/** The part of a band's window where a line's period is one the band passes. */
function passingWindow(band, line) {
  let from = Infinity;
  let to = -Infinity;
  for (let rho = band.from; rho <= band.to; rho += band.binPx) {
    if (periodAt(rho, line) <= band.passMaxPx) {
      from = Math.min(from, rho);
      to = Math.max(to, rho);
    }
  }
  if (!(to > from)) {
    return { ...band };
  }
  const window = { ...band, from, to };
  const cycles =
    line.frequency *
    (boxCox(window.to, line.exponent) - boxCox(window.from, line.exponent));
  return cycles >= 2 ? window : { ...band };
}

function refineWithin(series, band, line) {
  const mid = (band.from + band.to) / 2;
  const power = (exponent, periodMid) =>
    lawFit(series, band, exponent, periodMid, mid);
  const golden = (f, lo, hi) => {
    const r = (Math.sqrt(5) - 1) / 2;
    let a = lo;
    let b = hi;
    let c = b - r * (b - a);
    let d = a + r * (b - a);
    let fc = f(c);
    let fd = f(d);
    for (let k = 0; k < 16; k++) {
      if (fc > fd) {
        b = d;
        d = c;
        fd = fc;
        c = b - r * (b - a);
        fc = f(c);
      } else {
        a = c;
        c = d;
        fc = fd;
        d = a + r * (b - a);
        fd = f(d);
      }
    }
    return (a + b) / 2;
  };
  let exponent = line.exponent;
  let periodMid = periodAt(mid, line);
  const cycles =
    line.frequency *
    (boxCox(band.to, line.exponent) - boxCox(band.from, line.exponent));
  let periodSpan = 0.5 / Math.max(1, cycles);
  let exponentSpan = 0.1;
  let best = { value: power(exponent, periodMid), exponent, periodMid };
  for (let i = -4; i <= 4; i++) {
    for (let j = -4; j <= 4; j++) {
      const e = line.exponent + (exponentSpan * i) / 4;
      const period = periodMid * (1 + (periodSpan * j) / 4);
      const value = power(e, period);
      if (value > best.value) {
        best = { value, exponent: e, periodMid: period };
      }
    }
  }
  exponent = best.exponent;
  periodMid = best.periodMid;
  periodSpan /= 4;
  exponentSpan /= 4;
  for (let pass = 0; pass < 6; pass++) {
    const law = exponent;
    const around = periodMid;
    periodMid = golden(
      (value) => power(law, value),
      around * (1 - periodSpan),
      around * (1 + periodSpan),
    );
    const period = periodMid;
    exponent = golden(
      (value) => power(value, period),
      law - exponentSpan,
      law + exponentSpan,
    );
    periodSpan *= 0.6;
    exponentSpan *= 0.6;
  }
  return {
    ...line,
    exponent,
    frequency: 1 / (periodMid * boxCoxSlope(mid, exponent)),
  };
}

/** A fit's harmonics above the fundamental, as a fit of their own. */
function overtonesOf(fit) {
  const per = fit.ramp ? 4 : 2;
  return {
    ...fit,
    harmonics: fit.harmonics.slice(1),
    coefficients: fit.coefficients.slice(per),
  };
}

function withoutFits(series, band, fits) {
  return Float64Array.from(series, (value, bin) => {
    const rho = (bin + 0.5) * band.binPx;
    let model = 0;
    for (const fit of fits) {
      model += fittedValue(rho, fit);
    }
    return value - model;
  });
}

/**
 * True when two lines are one family: laws within half an exponent whose
 * phases never part by more than `cycles` across the window (a modulated
 * family's sidebands), or one is a harmonic of the other up to the eighth (a
 * pulse train's overtones reach the faster band while its fundamental sits in
 * the visible one). With `lowest` above 1, only overtones count: the higher
 * line is a harmonic of the lower one.
 */
export function sameFamily(a, b, window, cycles = 2, lowest = 1) {
  if (Math.abs(a.exponent - b.exponent) >= 0.5) {
    return false;
  }
  const phase = (line, rho) =>
    line.frequency *
    (boxCox(rho, line.exponent) - boxCox(window.from, line.exponent));
  const [low, high] =
    phase(a, window.to) <= phase(b, window.to) ? [a, b] : [b, a];
  for (let h = lowest; h <= 8; h++) {
    let most = 0;
    for (let k = 1; k <= 32; k++) {
      const rho = window.from + ((window.to - window.from) * k) / 32;
      most = Math.max(most, Math.abs(h * phase(low, rho) - phase(high, rho)));
    }
    if (most < cycles) {
      return true;
    }
  }
  return false;
}

/**
 * Every line of one band's series, strongest first: extracted one at a time,
 * re-measured with the others removed, and merged where two are one family.
 *
 * @param {Float64Array} series The band's detrended profile.
 * @param {object} band The band: binning, window and search range.
 * @param {number[]} exponents The law exponents to scan.
 * @param {number} polishSnr A line this far above its floor has its law and
 *   period polished; a weaker one cannot become a family and is left as the
 *   scan found it.
 * @returns {{laws: object[], lines: object[]}} The first scan's per-law table
 *   and the lines, each with its law, frequency, SNR, interior flag, law
 *   margin and fitted fundamental RMS.
 */
export function analyseBand(series, band, exponents, polishSnr) {
  const found = [];
  let laws = [];
  let residual = series;
  for (let n = 0; n < MAX_LINES; n++) {
    const scan = scanLaws(residual, band, exponents);
    if (scan.line === null) {
      break;
    }
    laws = n === 0 ? scan.laws : laws;
    // What an imperfect subtraction leaves of a line already found is found
    // again as a line of the same family; the search stops there. Only a line
    // that could be a family is polished before it is removed: the remnant a
    // strong unpolished line leaves is itself found as a line.
    const line =
      scan.line.snr >= polishSnr
        ? refineLine(residual, band, scan.line)
        : scan.line;
    if (found.some((known) => sameFamily(known, line, band))) {
      break;
    }
    found.push(line);
    residual = withoutFits(residual, band, fitLines(residual, band, [line]));
  }
  // Each line is re-measured on the profile with every other line removed
  // and with its own second and third harmonics removed: at a few cycles per
  // window a pulse train's harmonics fall inside the twelve cells its floor
  // is read from, so a low-duty family would otherwise raise its own floor.
  const joint = fitLines(series, band, found);
  const lines = found.map((line, index) => {
    const own = withoutFits(series, band, [
      ...joint.filter((_, other) => other !== index),
      overtonesOf(joint[index]),
    ]);
    const first = strongestLine(
      lawPeriodogram(own, band, line.exponent),
      line.frequency,
    );
    const start = first === null ? line : { ...line, ...first };
    if (!(start.snr >= polishSnr)) {
      return start;
    }
    const polished = refineLine(own, band, start);
    const near = strongestLine(
      lawPeriodogram(own, band, polished.exponent),
      polished.frequency,
    );
    const measured =
      near === null
        ? polished
        : { ...polished, ...near, frequency: polished.frequency };
    return namedLawWithinNoise(own, band, measured);
  });
  const kept = [];
  for (const line of lines) {
    if (!kept.some((other) => sameFamily(other, line, band))) {
      kept.push(line);
    }
  }
  // The reported amplitude and phase are the constant-amplitude fit's; the
  // model a caller subtracts from another band's series or from the pixels is
  // the ramped one. Within this band the lines are separated with constant
  // amplitudes: a ramp lets two lines that cross in period trade amplitude
  // where they cross.
  const fits = fitLines(series, band, kept);
  const models = fitLines(series, band, kept, true);
  return {
    laws,
    lines: kept.map((line, index) => ({
      ...line,
      harmonics: models[index].harmonics,
      coefficients: models[index].coefficients,
      ramp: models[index].ramp,
      lineRms: fits[index].lineRms,
      phase: fits[index].phase,
    })),
  };
}

/**
 * Whether a line is carried in phase around the whole centre. The band's
 * series is rebuilt from each sector's profile and the line's fundamental
 * fitted there at the law and frequency the full profile found; a sector
 * carries the line when its amplitude is at least a quarter of the full
 * profile's and its phase within 60 degrees of it. Straight stripes, a grid
 * or a checkerboard put a clean line into the annulus mean (the mean of a
 * plane wave about any point oscillates in rho at the wave's period) but only
 * into the sectors that hold the wave's stationary directions. A stationary
 * direction on an octant boundary is shared by the octants either side of it,
 * so an axis-aligned lattice fills all eight; the test is also run in sixteen
 * sectors with a limit on the sectors that carry the line against its phase.
 * That declines the lattice fundamentals the family spec pins, not every
 * lattice: a stationary lobe spanning two or more sixteenths (a longer
 * period, or a checkerboard's (3,1) harmonic) is carried in twelve or more of
 * the sixteen with none against. A hexagonal lattice at 24-36 px fills
 * twelve to fourteen, the rest neither carrying the line nor against it (at
 * 36 px they lag 63-71 degrees, between the carry and veto phases); a
 * checkerboard's (3,1) harmonic fills all sixteen, and a hexagonal lattice
 * fifteen or sixteen from about 48 px. The family module's WHAT IT CANNOT
 * SEE measures these.
 *
 * @param {{sums: number[][], counts: number[][]}} rows Per-sector radial
 *   sums and counts at the band's binning, one row per sector.
 * @param {object} band The band the line was found in.
 * @param {object} line The line (law exponent and frequency).
 * @param {object} [rule] `required` (sectors that must carry the line in
 *   phase) and `opposed` (the most sectors that may carry it against its
 *   phase); the octant frame's rule unless stated.
 * @returns {object} `inPhase` (sectors carrying the line), `opposed`,
 *   `sectors`, `required`, `concentric`, and each sector's relative
 *   amplitude and phase.
 */
export function concentricity(
  rows,
  band,
  line,
  { required = CONCENTRIC_OCTANTS, opposed: allowed = Infinity } = {},
) {
  const full = fitLines(
    bandSeries(
      rows.sums.reduce((sum, row) => sum.map((v, i) => v + row[i])),
      rows.counts.reduce((sum, row) => sum.map((v, i) => v + row[i])),
      band,
    ).series,
    band,
    [line],
  )[0];
  const amplitude = (fit) =>
    Math.hypot(fit.coefficients[0], fit.coefficients[1]);
  const whole = amplitude(full);
  const perSector = [];
  let inPhase = 0;
  let opposed = 0;
  for (let k = 0; k < rows.sums.length; k++) {
    const fit = fitLines(
      bandSeries(rows.sums[k], rows.counts[k], band).series,
      band,
      [line],
    )[0];
    const relative = whole > 0 ? amplitude(fit) / whole : 0;
    const lag = Math.atan2(
      Math.sin(fit.phase - full.phase),
      Math.cos(fit.phase - full.phase),
    );
    const carries = relative >= 0.25 && Math.cos(lag) >= 0.5;
    inPhase += carries ? 1 : 0;
    opposed += relative >= 0.25 && Math.cos(lag) <= -0.5 ? 1 : 0;
    perSector.push({ relative, lagDeg: (lag * 180) / Math.PI, carries });
  }
  return {
    inPhase,
    opposed,
    sectors: rows.sums.length,
    required,
    concentric: inPhase >= required && opposed <= allowed,
    perSector,
  };
}
