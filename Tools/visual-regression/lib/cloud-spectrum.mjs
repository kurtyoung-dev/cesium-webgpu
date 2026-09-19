/**
 * Pure spectral + fractal statistics for Campaign 13 cloud probes (O5 Structure).
 * @purpose Radially averaged power-spectrum slope fit and area-perimeter fractal
 *   dimension for cloud-alpha fields, plus a seeded synthetic fBm field generator
 *   for validating the analyzer against a KNOWN answer before it is ever pointed
 *   at a render (C13-N04, O5 gate: target slope -5/3 +/- 0.3, D = 1.35 +/- 0.15).
 * @status ACTIVE
 *
 * No npm dependency, no browser API. The 2-D transform below is a hand-rolled
 * separable DFT (see `dft1d`/`transform2d`), not an FFT — O(N^2) per 1-D pass,
 * O(N^3) for a full square transform. That is deliberate: this module is
 * exercised on the 64-256px synthetic fields the spec builds and on
 * probe-captured cloud-alpha crops at similar scale, where a few million
 * multiply-adds costs low single-digit milliseconds in Node. It would NOT be
 * an appropriate choice for a full-resolution capture frame; that would want
 * a real FFT, which this module intentionally does not implement.
 */

// Re-exported bindings from `lib/metrics/spectral-slope.mjs`, where the
// implementations now live; each name here IS that module's own binding.
export {
  areaPerimeterFractalDimension,
  fitSpectralSlope,
  radialPowerSpectrum,
  syntheticFractionalBrownianField,
} from "./metrics/spectral-slope.mjs";
