/**
 * Renderer-mode vocabulary and the precedence rules that decide which backend a
 * Sandcastle page runs on.
 *
 * This module is deliberately a leaf: no React, no DOM, no imports from the
 * settings layer. That keeps the precedence rules unit-testable in plain Node
 * and lets the settings context import the product default from here without a
 * cycle.
 *
 * PRECEDENCE, highest first:
 *   1. the `?renderer=` URL parameter, when it names a known mode
 *   2. the persisted setting (localStorage, via the settings provider)
 *   3. {@link DEFAULT_RENDERER_MODE}
 *
 * A URL selection is intentionally NOT written back to the persisted setting —
 * it applies to the page load that carried it, so a headless sweep or a shared
 * link can pin a backend without silently reconfiguring the visitor's editor.
 * An unrecognized value is ignored rather than fatal: an old or hand-edited link
 * still opens the demo, it just falls through to the stored preference.
 */

/** A renderer selection the app can run. `split` renders both backends side by side. */
export type RendererMode = "webgl" | "webgpu" | "split";

/** Every valid {@link RendererMode}, in the order the toggle presents them. */
export const RENDERER_MODES: readonly RendererMode[] = [
  "webgl",
  "webgpu",
  "split",
];

/**
 * The product default renderer for Sandcastle.
 *
 * This is the single place the out-of-the-box backend is decided — the settings
 * context seeds `initialSettings` from it, the settings provider falls back to
 * it when stored JSON is missing or unrecognized, and the URL/settings
 * resolution below bottoms out here. Changing this one value changes the
 * default everywhere; nothing else hardcodes a mode.
 */
export const DEFAULT_RENDERER_MODE: RendererMode = "webgl";

/** The query-string parameter that overrides the stored renderer setting. */
export const RENDERER_URL_PARAM = "renderer";

/**
 * Narrow an unknown value to a {@link RendererMode}.
 *
 * @param value Candidate value, typically straight off a URL or JSON parse.
 * @returns True when the value is one of the known modes.
 */
export function isRendererMode(value: unknown): value is RendererMode {
  return (
    typeof value === "string" &&
    (RENDERER_MODES as readonly string[]).includes(value)
  );
}

/**
 * Read the raw `?renderer=` value out of a query string.
 *
 * Returns the value verbatim — validation is the caller's job, so the caller
 * can report what was rejected.
 *
 * @param search A `location.search`-shaped string, with or without the leading `?`.
 * @returns The raw parameter value, or null when it is absent.
 */
export function readRendererParam(
  search: string | null | undefined,
): string | null {
  if (typeof search !== "string" || search.length === 0) {
    return null;
  }
  return new URLSearchParams(search).get(RENDERER_URL_PARAM);
}

/**
 * Apply the precedence rules to produce the mode a page should actually run.
 *
 * @param urlValue Raw `?renderer=` value, or null/undefined when absent.
 * @param storedMode The persisted setting, or null/undefined when unavailable.
 * @param onInvalid Called with the raw value when the URL names something that
 *   is not a mode. The value is then ignored and resolution continues.
 * @returns The effective renderer mode.
 */
export function resolveRendererMode(
  urlValue: string | null | undefined,
  storedMode: RendererMode | string | null | undefined,
  onInvalid?: (rawValue: string) => void,
): RendererMode {
  if (typeof urlValue === "string" && urlValue.length > 0) {
    if (isRendererMode(urlValue)) {
      return urlValue;
    }
    onInvalid?.(urlValue);
  }

  if (isRendererMode(storedMode)) {
    return storedMode;
  }

  return DEFAULT_RENDERER_MODE;
}

/**
 * Warn about a URL value that named no known renderer.
 *
 * Split out so both entry points report the same text and the resolution
 * function itself stays free of side effects.
 *
 * @param rawValue The rejected value.
 */
export function warnInvalidRendererParam(rawValue: string): void {
  console.warn(
    `Ignoring unknown ?${RENDERER_URL_PARAM}="${rawValue}". Expected one of: ${RENDERER_MODES.join(", ")}.`,
  );
}

/**
 * Read and validate the renderer override carried by the current page URL.
 *
 * An empty value — `?renderer=` or a valueless `?renderer` — counts as ABSENT,
 * not as an unknown mode, so it resolves to the stored setting in silence. The
 * two readers in this module have to agree on that: `resolveRendererMode`
 * already treats it as absent, and a warning here for a value nobody typed is
 * noise.
 *
 * @param search Optional query string; defaults to the live `location.search`.
 * @returns The overriding mode, or null when the URL carries no usable one.
 */
export function readRendererOverride(search?: string): RendererMode | null {
  const source =
    search ??
    (typeof window === "undefined" ? "" : (window.location?.search ?? ""));
  const raw = readRendererParam(source);
  if (raw === null || raw.length === 0) {
    return null;
  }
  if (!isRendererMode(raw)) {
    warnInvalidRendererParam(raw);
    return null;
  }
  return raw;
}
