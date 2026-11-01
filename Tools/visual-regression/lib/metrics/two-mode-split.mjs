/**
 * Splits one statistic's per-run values, both arms together, into a low mode and a high mode.
 * @purpose Decides whether the repeats of one performance statistic (base and tip together) fall into two clusters too far apart for a band over their medians to mean anything, names the two modes (mean, and for each value its arm and run), and words the reason a reader sees; pure, with no knowledge of which metric the numbers are.
 * @status ACTIVE
 *
 * WHY. The same served build was measured twice on one scene and its GPU frame
 * total came back at about 0.45-0.6 ms on some pages and about 2.3-4.8 ms on
 * others: two arms of one build read 0.525 and 4.51 ms (a band verdict of
 * `over`), and in two other pairs one arm drew both modes. A band over the
 * medians of two repeats cannot tell a changed build from a page that landed
 * in the other mode, so the statistic is not read at all; the modes are
 * reported instead.
 *
 * THE SPLIT. The values of both arms are sorted and cut where two neighbours
 * are furthest apart in ratio. The cut is a real two-mode reading only when
 * the high mode's mean exceeds the low mode's by {@link BIMODAL_MODE_RATIO}
 * and the gap across the cut is wider than the spread inside either mode, so a
 * smooth ramp of values (1, 2, 3, 4.5) is never split.
 *
 * WHAT IT CANNOT TELL. When every value of one arm lies in one mode and every
 * value of the other arm in the other (`armSeparated`), a real change in the
 * build looks the same as a page that drew a different mode per arm; the
 * record says so, the reason names which arm drew which mode, and nothing
 * here decides between the readings: the PF-2 metric keeps a band's `over`
 * whenever the base arm never drew the slow mode.
 *
 * @module Tools/visual-regression/lib/metrics/two-mode-split
 */

/**
 * The fewest values a split is read from. Two repeats per arm is the landing
 * probe's default, so four values is the smallest set that holds a repeat of
 * each arm; with fewer, one slow page cannot be told from a mode.
 */
export const BIMODAL_MIN_VALUES = 4;

/**
 * How far apart the two modes' means must be. On three same-build pairs of
 * E-ID-cv WebGPU frame totals the spread inside a mode (max over min) was at
 * most 2.05 and the ratio between the modes' means at least 8.1; 4 is the
 * geometric mean of the two, rounded.
 */
export const BIMODAL_MODE_RATIO = 4;

const isPositive = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const mean = (values) =>
  values.reduce((sum, entry) => sum + entry.value, 0) / values.length;

/** Max over min of a non-empty list of positive entries. */
const spread = (entries) =>
  Math.max(...entries.map((entry) => entry.value)) /
  Math.min(...entries.map((entry) => entry.value));

/**
 * Split one statistic's values into two modes, or return null.
 *
 * @param {Array<{arm: string, run: number, value: number}>} entries One entry
 *   per run of either arm that produced the statistic.
 * @param {{minValues?: number, modeRatio?: number}} [options]
 * @returns {{low: {mean: number, values: object[]}, high: {mean: number,
 *   values: object[]}, ratio: number, gapRatio: number,
 *   armSeparated: boolean}|null} Null for a set that is too small, holds a
 *   non-positive or non-finite value, or has no cut meeting the rule. The
 *   values of each mode are ascending.
 */
export function splitTwoModes(
  entries,
  { minValues = BIMODAL_MIN_VALUES, modeRatio = BIMODAL_MODE_RATIO } = {},
) {
  if (!Array.isArray(entries) || entries.length < minValues) {
    return null;
  }
  if (!entries.every((entry) => isPositive(entry?.value))) {
    return null;
  }
  const sorted = entries
    .map(({ arm, run, value }) => ({ arm, run, value }))
    .sort((a, b) => a.value - b.value);
  let cut = 0;
  let gapRatio = 0;
  for (let index = 0; index + 1 < sorted.length; index++) {
    const gap = sorted[index + 1].value / sorted[index].value;
    if (gap > gapRatio) {
      gapRatio = gap;
      cut = index + 1;
    }
  }
  const low = sorted.slice(0, cut);
  const high = sorted.slice(cut);
  const ratio = mean(high) / mean(low);
  if (ratio <= modeRatio || gapRatio <= Math.max(spread(low), spread(high))) {
    return null;
  }
  const lowArms = new Set(low.map((entry) => entry.arm));
  return {
    low: { mean: mean(low), values: low },
    high: { mean: mean(high), values: high },
    ratio,
    gapRatio,
    armSeparated: !high.some((entry) => lowArms.has(entry.arm)),
  };
}

/**
 * A figure as a reader wants it: four significant digits at most and never
 * more than four fractional ones.
 *
 * @param {number} value
 * @returns {string}
 */
export function modeFigure(value) {
  return String(Number(Number(value.toPrecision(4)).toFixed(4)));
}

const describeMode = (name, mode) =>
  `${name} mean ${modeFigure(mode.mean)} (${mode.values
    .map((entry) => `${entry.arm} run ${entry.run} ${modeFigure(entry.value)}`)
    .join(", ")})`;

/**
 * The reason a statistic reads as two modes, naming both and which arm drew
 * which.
 *
 * @param {string} statistic Name of the statistic.
 * @param {{low: object, high: object, ratio: number,
 *   armSeparated: boolean}} modes A {@link splitTwoModes} result.
 * @returns {string}
 */
export function describeModes(statistic, modes) {
  return `${statistic} falls into two modes: ${describeMode("low", modes.low)} and ${describeMode("high", modes.high)}, ratio ${modeFigure(modes.ratio)}; ${whoDrewWhich(modes)}`;
}

/**
 * Which arm drew which mode, in words: the arm (or arms) that drew both modes
 * by name, and the mode each other arm stayed in. A split no arm straddles
 * says a real change is not ruled out.
 *
 * @param {{low: {values: Array<{arm: string}>}, high: {values:
 *   Array<{arm: string}>}}} modes A {@link splitTwoModes} result.
 * @returns {string}
 */
export function whoDrewWhich(modes) {
  const armsIn = (mode) => new Set(mode.values.map((entry) => entry.arm));
  const low = armsIn(modes.low);
  const high = armsIn(modes.high);
  const arms = [...new Set([...low, ...high])].sort();
  const both = arms.filter((arm) => low.has(arm) && high.has(arm));
  const only = (arm) =>
    `the ${arm} arm only the ${high.has(arm) ? "high" : "low"} mode`;
  if (both.length === 0) {
    return `each arm drew one mode only (${arms.map(only).join(", ")}), so a real change is not ruled out`;
  }
  const rest = arms.filter((arm) => !both.includes(arm)).map(only);
  const who =
    both.length === arms.length
      ? "every arm drew both modes"
      : `the ${both.join(" and ")} arm drew both modes`;
  return rest.length === 0 ? who : `${who}, ${rest.join(", ")}`;
}
