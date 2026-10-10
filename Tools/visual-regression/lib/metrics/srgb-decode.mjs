// srgb-decode.mjs — was a known gray decoded from sRGB once, not at all, or twice?
// @purpose Pure metric over two region means of a known-gray patch (the default SDR path and a treated path): the single-decode expectation 255*(g/255)^2.2, the double-decode value 255*(g/255)^4.84, and whether the treated mean matches one decode, differs from no decode, and differs from two.
// @status ACTIVE
//
// WHERE IT CAME FROM. `probe-globe-hdr-gamma` (GLOBE-HDR-GAMMA) drapes the
// globe with a two-tone tile of known sRGB grays and compares the region mean
// on the SDR path, where the globe's gamma step is a no-op, with the mean on
// the HDR canvas-output path, where it must decode sRGB to linear exactly once.
// The probe's own header names the three outcomes this module separates: the
// fix present (one decode), the fix missing (HDR mean equals SDR mean), and
// the fix applied twice (the exponent squared-ish, 2.2 x 2.2 = 4.84). The
// arithmetic here is the probe's, moved out of its verdict block unchanged, so
// the probe and any later HDR probe read the same three numbers.
//
// Pure: no I/O. The tolerances are the probe's and are parameters here, not
// verdicts; the caller decides what a failing clause means.

/**
 * @param {number} gray A display byte, 0..255.
 * @returns {number} `255 * (gray / 255) ** 2.2`.
 */
export function singleDecode(gray) {
  return 255 * Math.pow(gray / 255, 2.2);
}

/**
 * @param {number} gray A display byte, 0..255.
 * @returns {number} `255 * (gray / 255) ** 4.84`.
 */
export function doubleDecode(gray) {
  return 255 * Math.pow(gray / 255, 4.84);
}

/**
 * Separate one decode from none and from two.
 *
 * @param {{sdrMean: number, treatedMean: number}} means
 * @param {{singleTolerance?: number, missingFloor?: number, doubleFloor?: number}} [options]
 *   Defaults are the probe's: within 10 of one decode, at least 20 away from
 *   the SDR mean, at least 15 away from the double decode.
 * @returns {{expectedSingle: number, doubleWouldBe: number, single: boolean,
 *   notMissing: boolean, notDouble: boolean, ok: boolean}}
 */
export function classifyDecode({ sdrMean, treatedMean }, options = {}) {
  const singleTolerance = options.singleTolerance ?? 10;
  const missingFloor = options.missingFloor ?? 20;
  const doubleFloor = options.doubleFloor ?? 15;
  const expectedSingle = singleDecode(sdrMean);
  const single = Math.abs(treatedMean - expectedSingle) <= singleTolerance;
  const notMissing = Math.abs(treatedMean - sdrMean) >= missingFloor;
  const doubleWouldBe = doubleDecode(sdrMean);
  const notDouble = Math.abs(treatedMean - doubleWouldBe) >= doubleFloor;
  return {
    expectedSingle,
    doubleWouldBe,
    single,
    notMissing,
    notDouble,
    ok: single && notMissing && notDouble,
  };
}
