// seam-pole-structure.mjs — the statistics a dateline/pole seam gate reads off
// column means, azimuthal sector means and a centre pixel block.
// @purpose Frame-relative seam statistics: the centre adjacent-column step against the frame's own step distribution, the two halves' brightness balance, the azimuthal spread of sector means and the hottest centre pixel against the ring.
// @status ACTIVE
//
// WHERE IT COMES FROM. `probe-weather-seam-poles.mjs` (C13-07) reduces each
// capture in the page to three arrays — the mean max-channel of every column
// in a central band, twelve azimuthal sector means around the frame centre,
// and a 9x9 block of max-channel values at the centre — and then read four
// statistics off them in Node with private inline code. Those four are this
// module. The in-page reducers stay in the probe: the weather capture
// doctrine (`lib/weather-capture-doctrine.mjs`) binds in-page reducers by name.
//
// EVERY STATISTIC IS RELATIVE TO THE SAME FRAME. That is what lets the gate
// survive the pinning pass that moved every absolute luminance: the centre
// step is compared with the frame's own p95, one half with the other, one
// sector with the ring mean. Nothing here carries a threshold; the probe
// keeps its bars, and this module only computes what they are applied to.

/**
 * @param {number[]} values
 * @returns {number}
 */
function meanOf(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The adjacent-column step distribution of a row of column means, split into
 * the centre band (where the projected meridian lands) and the rest.
 *
 * With `n` steps the centre band is `steps[mid - half, mid + half)` where
 * `mid = floor(n / 2)` and `half = floor(n * centreFraction)`; `p95` is the
 * element at `floor(0.95 * m)` of the other `m` steps sorted ascending.
 *
 * @param {number[]} columns Column means, left to right.
 * @param {{centreFraction?: number}} [options] Half-width of the centre band
 *   as a fraction of the step count (0.04, an 8% band, by default).
 * @returns {{centreMax: number, p95: number, steps: number}}
 * @throws {RangeError} When the centre band or the rest would be empty, since
 *   a maximum of nothing reads -Infinity and a percentile of nothing reads
 *   undefined, and either would be scored as if it were a number.
 */
export function columnStepStats(columns, options = {}) {
  const centreFraction = options.centreFraction ?? 0.04;
  const steps = [];
  for (let i = 1; i < columns.length; i++) {
    steps.push(Math.abs(columns[i] - columns[i - 1]));
  }
  const mid = Math.floor(steps.length / 2);
  const half = Math.floor(steps.length * centreFraction);
  const centre = steps.slice(mid - half, mid + half);
  const rest = steps
    .slice(0, mid - half)
    .concat(steps.slice(mid + half))
    .sort((a, b) => a - b);
  if (centre.length === 0 || rest.length === 0) {
    throw new RangeError(
      `columnStepStats: ${columns.length} column(s) leave the centre band or the rest empty`,
    );
  }
  return {
    centreMax: Math.max(...centre),
    p95: rest[Math.floor(rest.length * 0.95)],
    steps: steps.length,
  };
}

/**
 * Mean of each half of a row of column means, and the ratio of the brighter
 * half to the dimmer one (the dimmer floored at 1 so a black half cannot
 * divide by zero).
 *
 * @param {number[]} columns Column means, left to right.
 * @returns {{left: number, right: number, ratio: number}}
 * @throws {RangeError} For fewer than two columns, which have no two halves.
 */
export function halfBalance(columns) {
  if (!Array.isArray(columns) || columns.length < 2) {
    throw new RangeError("halfBalance needs at least two column means");
  }
  const mid = Math.floor(columns.length / 2);
  const left = meanOf(columns.slice(0, mid));
  const right = meanOf(columns.slice(mid));
  return {
    left,
    right,
    ratio: Math.max(left, right) / Math.max(1, Math.min(left, right)),
  };
}

/**
 * Azimuthal spread of a ring of sector means: their mean and the largest
 * absolute deviation of any sector from it.
 *
 * @param {number[]} sectors Sector means around the ring.
 * @returns {{mean: number, maxDev: number}}
 * @throws {RangeError} For an empty ring.
 */
export function ringSpread(sectors) {
  if (!Array.isArray(sectors) || sectors.length === 0) {
    throw new RangeError("ringSpread needs at least one sector mean");
  }
  const mean = meanOf(sectors);
  return {
    mean,
    maxDev: Math.max(...sectors.map((value) => Math.abs(value - mean))),
  };
}

/**
 * The hottest value of a centre pixel block and its multiple of the ring
 * floor `max(ringMean, floor)`.
 *
 * @param {number[]} block Centre-block values.
 * @param {number} ringMean The surrounding ring's mean.
 * @param {{floor?: number}} [options] Lower bound on the ring mean used as
 *   the reference (20 by default), so a near-black ring does not make any
 *   faint centre look hot.
 * @returns {{centreMax: number, reference: number, multiple: number}}
 * @throws {RangeError} For an empty block.
 */
export function centreHotSpot(block, ringMean, options = {}) {
  if (!Array.isArray(block) || block.length === 0) {
    throw new RangeError("centreHotSpot needs a non-empty centre block");
  }
  const floor = options.floor ?? 20;
  const centreMax = Math.max(...block);
  const reference = Math.max(ringMean, floor);
  return { centreMax, reference, multiple: centreMax / reference };
}
