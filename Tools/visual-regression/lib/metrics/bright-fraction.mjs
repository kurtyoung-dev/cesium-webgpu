// bright-fraction.mjs — the weather fleet's bright-pixel reducer: the share of
// a strided central window whose brightest channel clears a threshold.
// @purpose The weather fleet's shared bright-pixel reducer over decoded RGBA: the fraction of a strided central window whose max(r,g,b) clears a threshold, with the continuous meanMax beside it.
// @status ACTIVE
//
// WHERE IT COMES FROM. Before the probe-kit harvest the reducer existed in two
// copies: `lib/weather-probe-pinning.mjs`'s in-page `brightFraction` (read by
// the channels, edr-mock, wcs and metar legs and by one cloud-shadow probe,
// `probe-cloud-shadows-flagon.mjs`) and `probe-weather-map.mjs`'s own inline
// loop. Both used the same window (the central 60% in each axis), the same
// `max(r,g,b) > threshold` test and the same stride. This module is that
// arithmetic once for Node callers, with a spec (`metrics-weather.spec.mjs`)
// beside it; the map probe's inline loop is gone and the map probe calls it.
//
// THE HARNESS STILL KEEPS ITS OWN COPY. `installWeatherPinHarnessOnPage` ships
// its own in-page method, not this module: the weather capture doctrine
// (`lib/weather-capture-doctrine.mjs`) rebuilds that init script from exactly
// two template substitutions, so shipping this source into the page needs a
// doctrine change first. Two copies therefore remain, the harness's and this
// one. `metrics-weather.spec.mjs` executes the real init script in `node:vm`
// and pins the two equal, so they cannot drift apart without it going red.
//
// SELF-CONTAINED ON PURPOSE. The body references nothing outside itself: no
// module constants, no helper imports. That keeps it shippable as source text
// once the doctrine accepts it, because a Playwright page cannot import a Node
// module (`lib/same-task-capture.mjs` explains the constraint at length).
//
// IDENTICAL FOR EVERY INPUT, NOT ONLY FOR THE USUAL ONES. The harness method
// takes no defaults and folds an absent stride with `?? 3`, so this does
// exactly the same: an absent threshold compares against `undefined` and
// counts nothing, as the harness's copy does. Adding a default here would
// make the two copies disagree on an input no caller passes today, which is
// how a "byte-identical" extraction stops being one.
//
// `meanMax` IS THE CONTINUOUS COMPANION. A threshold count is a step function:
// a deck sitting near the bar reads 0.000 or 1.000 with nothing between. The
// mean of the per-sample max channel moves smoothly across the bar, so a
// straddle is diagnosable from one run's log (`C13-GATE-B-CHANNELS-METRIC-
// SATURATION` records why the fleet keeps it).

/**
 * Bright-pixel fraction over the central window of one decoded frame.
 *
 * @param {{data: ArrayLike<number>, width: number, height: number}} frame
 *   RGBA bytes, row-major, four bytes per pixel.
 * @param {number} threshold A sample counts when `max(r,g,b) > threshold`.
 * @param {number} [step] Sampling stride in both axes, in pixels; 3 when absent.
 * @returns {{frac: number, meanMax: number, samples: number}} `frac` is the
 *   bright share of the samples (0 when there are none), `meanMax` the mean
 *   max channel rounded to two decimals, `samples` the number of pixels read.
 */
export function brightFraction(frame, threshold, step) {
  const { data, width, height } = frame;
  const stride = step ?? 3;
  let bright = 0;
  let sumMax = 0;
  let samples = 0;
  for (let y = Math.floor(height * 0.2); y < height * 0.8; y += stride) {
    for (let x = Math.floor(width * 0.2); x < width * 0.8; x += stride) {
      const i = (y * width + x) * 4;
      const mx = Math.max(data[i], data[i + 1], data[i + 2]);
      if (mx > threshold) {
        bright++;
      }
      sumMax += mx;
      samples++;
    }
  }
  return {
    frac: samples ? bright / samples : 0,
    meanMax: samples ? +(sumMax / samples).toFixed(2) : 0,
    samples,
  };
}
