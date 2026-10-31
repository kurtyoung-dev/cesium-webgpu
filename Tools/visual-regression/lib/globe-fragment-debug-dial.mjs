/**
 * The vocabulary of the landing stage's `globeFragmentDebug` dial: the WebGPU
 * globe fragment shader's debug modes by name, and the Node-side test of a
 * requested value.
 * @purpose Dial vocabulary piece for lib/landing-cell-stage.mjs: the frozen list of the mode names the WebGPU globe fragment-debug registry publishes (a spec pins it equal to the registry source), the "none" value that clears the mode, and the pure check the stage's Node side refuses a bad value with; the page-side apply stays in the stage because it runs inside the browser.
 * @status ACTIVE
 *
 * WHY A LIST HERE. The registry itself (`__webgpuGlobeFragmentDebugRegistry`)
 * exists only on a WebGPU page of an unminified build, so Node cannot read it
 * when it builds the payload. Refusing an unknown name in Node, before a
 * browser is involved, is how a typo fails loudly instead of rendering the
 * plain frame while the cell reports a debug mode. The list can drift from
 * `Renderer/WebGPU/WebGPUGlobeFragmentDebug.ts`; the stage spec reads that
 * file's `name:` entries and requires the two equal.
 *
 * @module Tools/visual-regression/lib/globe-fragment-debug-dial
 */

/** The value that clears the debug mode. */
export const GLOBE_FRAGMENT_DEBUG_OFF = "none";

/** Every mode name in `GLOBE_FRAGMENT_DEBUG_MODES`, in registry order. */
export const GLOBE_FRAGMENT_DEBUG_MODE_NAMES = Object.freeze([
  "uv",
  "alpha",
  "layer-count",
  "sample0",
  "sample1",
  "tex0-alpha",
  "tex1-alpha",
  "post-composite-color",
  "post-composite-alpha",
  "fade-amount",
  "draped",
  "atmo-color",
  "transmittance",
  "rayleigh-v",
  "mie-v",
  "view-dir",
  "mip4",
  "lod-magnitude",
  "force-red",
  "water-effect-trigger",
  "bypass-none",
  "bypass-underground",
  "bypass-translucency",
  "bypass-drape",
  "bypass-seam-clamp",
  "bypass-glint",
  "bypass-fog",
  "eye-carto-frame",
]);

/**
 * Whether `value` is a name the dial accepts: a registry mode name or `"none"`.
 * Pure.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isGlobeFragmentDebugValue(value) {
  return (
    typeof value === "string" &&
    (value === GLOBE_FRAGMENT_DEBUG_OFF ||
      GLOBE_FRAGMENT_DEBUG_MODE_NAMES.includes(value))
  );
}
