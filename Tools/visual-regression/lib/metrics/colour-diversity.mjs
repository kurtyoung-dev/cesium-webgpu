// colour-diversity.mjs — how much of a frame is drawn, and how many distinct colours it drew with.
// @purpose Pure RGBA metric: the non-black fraction of a frame and the number of distinct 4-bit-per-channel colour buckets among its non-black pixels, the "a textured globe, not a flat clear colour" measure.
// @status ACTIVE
//
// WHY NOT `png-decode.mjs`'s `frameStats`. `frameStats` answers a neighbouring
// question with two differences that matter to the limits built on this one:
// it samples every 97th pixel for its colour census, and it counts black pixels
// into that census. `probe-globe-bindgroup-cache` (buckets > 100) and
// `probe-globe-default-limits` (buckets > 150, where a composited NaturalEarthII
// globe measured ~300 and the pre-imagery failure ~80) calibrated their floors
// on the EXHAUSTIVE census over non-black pixels only. A 1/97 sample of a
// 1024x768 frame sees ~8,100 pixels and cannot be read against a floor
// measured over all ~786,000, so this is a separate metric rather than a
// re-reading of that one.
//
// The body is the loop both probes carried inside `page.evaluate`, moved to
// Node; `metrics-globe-extraction.spec.mjs` holds it to that original source.
// Pure: no I/O and no gate decision.

/**
 * @param {{width: number, height: number, data: ArrayLike<number>}} image
 * @param {{blackThreshold?: number}} [options] A pixel is non-black when ANY
 *   channel exceeds `blackThreshold` (default 16, strictly greater).
 * @returns {{nonBlackPx: number, nonBlackFraction: number, colourBuckets: number}}
 *   `colourBuckets` counts distinct `(r >> 4, g >> 4, b >> 4)` triples among the
 *   non-black pixels.
 */
export function colourDiversity(image, options = {}) {
  const threshold = options.blackThreshold ?? 16;
  const total = image.width * image.height;
  const data = image.data;
  let nonBlack = 0;
  const buckets = new Set();
  for (let p = 0; p < total; p++) {
    const i = 4 * p;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > threshold || g > threshold || b > threshold) {
      nonBlack++;
      buckets.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }
  return {
    nonBlackPx: nonBlack,
    nonBlackFraction: nonBlack / total,
    colourBuckets: buckets.size,
  };
}
