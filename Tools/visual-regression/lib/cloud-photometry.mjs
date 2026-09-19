/**
 * C13-N09 — the HDR pre-tonemap capture rule, as executable code.
 * @purpose Recover linear pre-Reinhard cloud radiance from an 8-bit capture, mask the sun disc, and refuse where the recovery is not defined.
 * @status ACTIVE
 *
 * WHY THIS EXISTS. Campaign 13 v2 §1.3 makes one rule binding on every
 * photometric bar in the plan:
 *
 *   "all photometric statistics are computed on linear, pre-tonemap HDR
 *    values, with the sun disc masked out of every ROI. The march applies its
 *    own Reinhard at ProceduralClouds.wgsl:2645-2646, so any ratio measured
 *    after it is a ratio of the tonemapper."
 *
 * That is not a stylistic preference. A1 wants an edge/interior luminance ratio
 * >= 4.0; A5 wants a base/top ratio in [0.05, 0.35]; A4 wants <= 0.80; G3 wants
 * a >= 3x luminance ratio at sun -2 deg. Reinhard is x/(x+1): it is very nearly
 * linear near zero and asymptotically flat above ~1, so it COMPRESSES exactly
 * the ratios those bars are made of. An A1 measured on display bytes can read
 * 2.6 while the radiance ratio is 12 — the bar would then be failing a renderer
 * that is correct, or passing one that is not, and either way the number is a
 * property of the tonemapper rather than of the clouds.
 *
 * WHAT THE RULE CAN AND CANNOT RECOVER — stated because it bounds every bar
 * built on it. The march composites in display space: after the Reinhard at
 * `:2645-2646` the color is lerped toward the aerial tint (`:2660`, and the
 * physical-LUT path at `:2711`) and then composited over whatever the frame
 * already held. So the inverse below is EXACT only for a pixel whose displayed
 * value is the tone-mapped cloud radiance and nothing else — an opaque cloud
 * pixel at negligible aerial weight. Where aerial or a background term has been
 * mixed in, the recovered value is the radiance whose tone-mapping would have
 * produced the displayed composite, which is a lower bound on the cloud's own
 * radiance. `photometricStats` therefore reports `assumption` in its provenance
 * rather than letting a caller forget which of the two it is holding. A bar
 * that needs the exact value needs a render target read before the composite,
 * which does not exist today and is not in this row.
 *
 * SATURATION IS A REFUSAL, NOT A NUMBER. The inverse of x/(x+1) diverges as the
 * display value approaches 1: at 254/255 it already reports 254x the radiance
 * of a mid-grey, and at 255/255 it is infinite. A saturated pixel carries NO
 * recoverable radiance, so it is excluded and COUNTED. The count is itself
 * evidence — a photometric ROI that is mostly saturated cannot support any of
 * the ratio bars, and a silent mean over inverted 254s would have looked like a
 * measurement.
 *
 * THE TRANSFER FUNCTION IS DECLARED, NEVER ASSUMED. The WebGPU presentation
 * format is `navigator.gpu.getPreferredCanvasFormat()` with a `bgra8unorm`
 * fallback (`WebGPUContext.ts:523`, `:1411`, `:3832`) — a NON-sRGB format, so
 * the byte the shader wrote is its own [0,1) output rather than an sRGB
 * encoding of it, and decoding it as sRGB would apply a gamma the renderer
 * never applied. That is the default here. It is still a premise about a
 * capture path, so it is a named parameter: a caller reading a capture that DID
 * pass through an sRGB encode passes `transfer: "srgb"`, and the choice is
 * recorded in the provenance of every statistic. `cloud-photometry-rule.spec.mjs`
 * pins that the choice changes a ratio, so it cannot be a decoration.
 *
 * @module cloud-photometry
 */

// The rule above is the contract; the implementations live in `lib/metrics`
// so a non-cloud probe can import one statistic without the whole rule.
// These are re-exported bindings, so each name here IS the metrics module's
// own function object rather than a wrapper around it.
export { circularMask, rectRoi } from "./metrics/masks.mjs";
export {
  DEFAULT_CLOUD_EXPOSURE,
  DEFAULT_TRANSFER,
  EXPOSURE_UNIFORM_SLOT,
  REINHARD_OPERATOR_PIN,
  TRANSFER_FUNCTIONS,
  displaySpaceLuminanceMean,
  forwardReinhard,
  inverseReinhard,
  luminance,
} from "./metrics/luminance.mjs";
export {
  DEFAULT_SATURATION_CEILING,
  photometricRatio,
  photometricStats,
} from "./metrics/saturation.mjs";
