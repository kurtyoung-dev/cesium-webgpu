/**
 * Query-string start policy for the CesiumViewer application.
 *
 * Two independent decisions live here: which renderer the page starts with,
 * and whether the fork's development chrome is built at all. Both are pure
 * functions over the parsed query object and touch no DOM, so they can be
 * exercised without a browser.
 *
 * @module CesiumViewerStartMode
 */

/**
 * Start modes the application understands.
 *
 * `webgl` and `webgpu` each build one viewer; `split` builds both side by side
 * and is the only mode that adds panes to the page.
 *
 * @type {readonly string[]}
 */
export const START_MODES = Object.freeze(["webgl", "webgpu", "split"]);

/**
 * Mode used when the query string names no renderer.
 *
 * An unqualified start exercises WebGPU. This cannot strand a browser without
 * WebGPU on a blank page: the request reaches the engine as a non-strict
 * explicit request, whose attempt plan is WebGPU followed by WebGL, so an
 * unavailable backend degrades to a working WebGL viewer instead of failing.
 *
 * @type {string}
 */
export const DEFAULT_START_MODE = "webgpu";

/**
 * Resolve the start mode for a parsed query string.
 *
 * An unrecognized `renderer` value resolves to the default rather than
 * throwing. This page is reached by hand-edited URLs, so a typo should still
 * produce a globe.
 *
 * @param {object} [endUserOptions] Parsed CesiumViewer query options.
 * @returns {string} One of {@link START_MODES}.
 */
export function resolveStartMode(endUserOptions) {
  const requested = endUserOptions?.renderer;
  return START_MODES.includes(requested) ? requested : DEFAULT_START_MODE;
}

/**
 * Whether the fork's development chrome should be constructed.
 *
 * Accepts `true` and `1` so the flag reads naturally in both hand-typed and
 * scripted URLs. Every other value — including a bare `devUi` carrying no
 * value — leaves the chrome unbuilt, so the page's default shape is the
 * upstream one and an integrator swapping upstream for this fork sees no new
 * controls.
 *
 * Renderer selection deliberately does not consult this flag: `?renderer=` is
 * an explicit request about the backend, not about the chrome, and tooling
 * depends on it resolving the same way with or without the dev UI.
 *
 * @param {object} [endUserOptions] Parsed CesiumViewer query options.
 * @returns {boolean} True when the toolbar and FPS toggle should be built.
 */
export function isDevUiEnabled(endUserOptions) {
  const value = endUserOptions?.devUi;
  return value === "true" || value === "1";
}
