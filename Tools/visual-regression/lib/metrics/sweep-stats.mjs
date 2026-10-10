// sweep-stats.mjs — summary statistics over one sweep of per-location values,
// and the per-location paired difference of two sweeps.
// @purpose Population mean, standard deviation and range of a sweep of per-location metric values, and the summed absolute per-location difference of two sweeps, rounded exactly as the weather gates score them.
// @status ACTIVE
//
// WHERE IT COMES FROM. The weather legs that sweep a camera across longitudes
// each carried a private `stats()`: `probe-weather-channels.mjs` and
// `probe-weather-metar.mjs` (mean, stddev, range, four decimals),
// `probe-weather-edr-mock.mjs` and `probe-weather-wcs.mjs` (mean and range,
// four decimals) and `probe-weather-map.mjs` (all three, unrounded). The
// rounding is not cosmetic: channels gate 3 compares a ROUNDED rich stddev
// against a rounded neutral stddev plus 0.01, so a copy that rounded
// differently could flip a verdict at the fifth decimal. The rounding is
// therefore a parameter, and `digits: null` reproduces the unrounded form.
//
// THE VARIANCE IS THE POPULATION VARIANCE over the UNROUNDED mean, exactly as
// every private copy computed it; only the three returned numbers round.

/**
 * @param {number} value
 * @param {number|null} digits
 * @returns {number}
 */
function rounded(value, digits) {
  return digits === null ? value : +value.toFixed(digits);
}

/**
 * Summary statistics of one sweep.
 *
 * @param {number[]} values Per-location metric values, in sweep order.
 * @param {{digits?: number|null}} [options] Decimal places for the returned
 *   numbers (4 by default); `null` returns them unrounded.
 * @returns {{mean: number, stddev: number, range: number}}
 * @throws {RangeError} For an empty sweep, which has no mean to report.
 */
export function sweepStats(values, options = {}) {
  const digits = options.digits === undefined ? 4 : options.digits;
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError("sweepStats needs a non-empty array of values");
  }
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return {
    mean: rounded(mean, digits),
    stddev: rounded(Math.sqrt(variance), digits),
    range: rounded(Math.max(...values) - Math.min(...values), digits),
  };
}

/**
 * Per-location difference of two sweeps taken over the same locations, and
 * the sum of its absolute values — the quantity metar gate 4 scores.
 *
 * @param {number[]} treated The sweep with the effect under test on.
 * @param {number[]} baseline The same locations with it off.
 * @param {{digits?: number|null}} [options] Decimal places for `absSum` (4 by
 *   default); the per-location deltas are never rounded.
 * @returns {{deltas: number[], absSum: number}} `deltas[i]` is
 *   `treated[i] - baseline[i]`.
 * @throws {RangeError} When the sweeps differ in length, since a delta would
 *   then pair two different locations.
 */
export function sweepDeltas(treated, baseline, options = {}) {
  const digits = options.digits === undefined ? 4 : options.digits;
  if (
    !Array.isArray(treated) ||
    !Array.isArray(baseline) ||
    treated.length !== baseline.length
  ) {
    throw new RangeError(
      "sweepDeltas needs two arrays of the same length, one value per location",
    );
  }
  const deltas = treated.map((value, i) => value - baseline[i]);
  const absSum = deltas.reduce((a, d) => a + Math.abs(d), 0);
  return { deltas, absSum: rounded(absSum, digits) };
}
