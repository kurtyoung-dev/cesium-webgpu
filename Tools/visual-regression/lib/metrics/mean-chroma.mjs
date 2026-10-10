// mean-chroma.mjs — how far from grey the drawn part of a frame is.
// @purpose Pure RGBA metric: the mean chroma (max channel minus min channel) over a frame's non-black pixels, and the fraction of them with any visible chroma, the "is a saturation-0 grade actually applied" measure.
// @status ACTIVE
//
// A colour grade at saturation 0 maps every pixel to a grey, so a frame it ran
// over has a mean chroma of about zero; the same frame with the grade dropped
// carries the imagery's colour. Black pixels (space, a dead frame) are left out
// so a mostly black frame cannot read as grey. Pure: no I/O and no gate
// decision.

/**
 * @param {{width: number, height: number, data: ArrayLike<number>}} image
 * @param {{blackThreshold?: number, chromaThreshold?: number}} [options] A
 *   pixel is non-black when ANY channel exceeds `blackThreshold` (default 16,
 *   strictly greater), and chromatic when its chroma exceeds `chromaThreshold`
 *   (default 8, strictly greater).
 * @returns {{nonBlackPx: number, meanChroma: number, chromaticFraction: number}}
 *   `meanChroma` and `chromaticFraction` are 0 when no pixel is non-black.
 */
export function meanChroma(image, options = {}) {
  const blackThreshold = options.blackThreshold ?? 16;
  const chromaThreshold = options.chromaThreshold ?? 8;
  const total = image.width * image.height;
  const data = image.data;
  let nonBlack = 0;
  let chromaSum = 0;
  let chromatic = 0;
  for (let p = 0; p < total; p++) {
    const i = 4 * p;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r > blackThreshold || g > blackThreshold || b > blackThreshold) {
      nonBlack++;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      chromaSum += chroma;
      if (chroma > chromaThreshold) {
        chromatic++;
      }
    }
  }
  return {
    nonBlackPx: nonBlack,
    meanChroma: nonBlack === 0 ? 0 : chromaSum / nonBlack,
    chromaticFraction: nonBlack === 0 ? 0 : chromatic / nonBlack,
  };
}
