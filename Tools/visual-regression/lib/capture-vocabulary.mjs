// capture-vocabulary.mjs — the capture seam's vocabulary: schema words, state words, defaults, timing bounds and shared patterns.
//
// @purpose Vocabulary piece of capture.mjs: the manifest schema version and kind, the BEFORE/AFTER slots, the MEASURED/UNMEASURED cell states, the renderer ids, the metric-strip provenance and thresholds, the forbidden verdict keys and values, every default budget and timeout, the readiness predicates, requireTimingMs and the patterns the other pieces share.
// @status ACTIVE
//
// WHY A PIECE. The vocabulary moved out of `capture.mjs` when that module
// passed 1,000 lines (DX-KIT-CAPTURE-SEAM-OVER-SIZE). `capture.mjs` re-exports
// every name it exported before, so no importer changed. Six names that were
// file-private there (requireTimingMs, ISO_INSTANT, HEX8, HEX64,
// ABSOLUTE_SCHEME, ORIGIN_REFUSAL_MESSAGE) are exported here for the sibling
// pieces only and are not part of the capture seam's public surface.

import { ProbeRefusal } from "./probe-refusal.mjs";

/** Manifest schema version. `validateManifest` fails closed on anything else. */
export const CAPTURE_MANIFEST_SCHEMA_VERSION = 1;

/** The `kind` discriminator every capture manifest carries. */
export const CAPTURE_MANIFEST_KIND = "capture-manifest";

/** The two legs of a pair, in the order they are captured and rendered. */
export const CAPTURE_SLOTS = Object.freeze(["BEFORE", "AFTER"]);

/**
 * The only two state words a cell or a pair may carry.
 *
 * There is deliberately no third. A capture either happened or it did not, and
 * "it did not" is not a failure — see the module header.
 */
export const CELL_STATES = Object.freeze({
  MEASURED: "MEASURED",
  UNMEASURED: "UNMEASURED",
});

/** Renderer ids a cell may be captured for, matching the rig registry's own set. */
export const CAPTURE_RENDERERS = Object.freeze(["webgl", "webgpu"]);

/**
 * What the cell metric strip is, stated on every cell that carries one.
 *
 * `photometricStats` (`metrics/saturation.mjs:54`) throws without a live
 * `cloud.exposure` uniform and `displaySpaceLuminanceMean`
 * (`metrics/luminance.mjs:117`) is exported explicitly as the thing the
 * photometric rule forbids. A generic rig has no exposure to read, so the
 * strip is Rec. 709 luma over raw display bytes and says so in the manifest —
 * descriptive, never evidential.
 */
export const CELL_METRIC_PROVENANCE =
  "display-bytes; descriptive only, not photometric evidence";

/**
 * Per-channel value above which a pixel counts as non-black.
 *
 * The same 12 `frameStats` (`Tools/lib/png-decode.mjs:206`) has used since it
 * was written, so `nonBlackFraction` here and `nonBlackPct` there answer the
 * same question about the same image.
 */
export const NON_BLACK_CHANNEL_THRESHOLD = 12;

/**
 * Per-channel absolute tolerance handed to `diffImages`.
 *
 * `lib/image-diff.mjs` documents 16 as its own default on 0-255 data, but a
 * default is not a record: this value is passed EXPLICITLY on every call and
 * then written into the manifest, so the number a reader sees is the number
 * the diff used rather than a guess about which default was in force.
 */
export const DEFAULT_PAIR_TOLERANCE = 16;

/** The page whose two canvases are the split-screen comparison's own. */
export const SPLIT_SCREEN_PAGE = "Apps/WebGPUTest/split-screen-comparison.html";

/** Keys whose presence anywhere in a manifest is a verdict leaking in. */
export const FORBIDDEN_MANIFEST_KEYS = Object.freeze([
  "gate",
  "expectedMismatch",
  "thresholds",
]);

/** `GateExpectation` tokens that may never appear as a manifest value. */
export const FORBIDDEN_MANIFEST_VALUES = Object.freeze(["PASS", "FAIL"]);

/** Per-cell work budget when the caller declares none. */
export const DEFAULT_CELL_BUDGET_MS = 180_000;

/** How long one navigation may take before the cell is wedged. */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 120_000;

/**
 * How long ONE resource gets to close before the lifecycle gives up on it.
 *
 * The fleet default (`RESOURCE_CLOSE_DEADLINE_MS`, 90 s since 2026-10-31, 10 s
 * before) is what `runProbe` descriptors get. A capture run holds a browser
 * that has built several WebGPU device contexts, and the Edge leg of
 * 2026-09-18 measured a healthy close of exactly that browser at 3,298 ms and
 * then blew the then 10 s budget on the failure path, where the hard stop
 * exited 2 with the cell's own diagnosis lost. Four times the measured healthy
 * close is margin for a loaded machine without being so long that a genuinely
 * wedged browser is never reported. `options.closeDeadlineMs` overrides it, and
 * the hard-stop grace keeps the fleet's own margin above whatever it becomes.
 * Unlike `runProbe`, the capture seam does not publish a run whose close
 * outlived this deadline; that exemption lives in `probe-lifecycle-run.mjs`.
 */
export const DEFAULT_CLOSE_DEADLINE_MS = 45_000;

/** How long readiness may take before `decideRenderReadyRefusal` is told it timed out. */
export const DEFAULT_READINESS_TIMEOUT_MS = 180_000;

/**
 * How often the readiness predicates are re-read while that budget runs.
 *
 * READINESS IS A POLL, NOT A SAMPLE. `Scene.renderReady`'s own JSDoc
 * (`Scene.js:2707-2717`) prescribes `while (!(globe.tilesLoaded &&
 * scene.renderReady)) { … }`, and the Edge leg of 2026-09-18 measured why: on
 * a served built tree the split-screen page reached `renderReady` at 4,558 ms
 * on WebGL and 6,985 ms on WebGPU, and `tilesLoaded` at 10,043 / 10,325 ms.
 * A single read taken after the rig's ~0.5 s settle therefore refused every
 * WebGPU cell at ~4.8 s — while REPORTING a 180 s budget it had not spent.
 * 250 ms is short enough to cost at most a quarter-second of the settle it
 * precedes and long enough not to spin the page's main thread.
 */
export const DEFAULT_READINESS_POLL_INTERVAL_MS = 250;

/**
 * The largest value any of this module's millisecond budgets may take: 24
 * hours.
 *
 * A STATED CEILING, BECAUSE "POSITIVE" IS NOT ENOUGH. `Infinity` and `NaN`
 * are neither negative nor zero, and both defeat the poll bound derived from
 * a budget (`Math.ceil(Infinity / interval)` is `Infinity`; every comparison
 * against `NaN` is `false`), so a run given either spins until the hard stop
 * kills the process — inside a cell, where the slot loop's checkpoint never
 * reaches it. `Number.isSafeInteger` refuses both, and this ceiling refuses
 * the remaining absurdity: a capture that wants longer than a day is a wedged
 * machine or a typed-in microsecond value, not a slow one, and the honest
 * answer to it is a refusal at the descriptor rather than a timer nobody will
 * be awake for.
 */
export const MAX_TIMING_OPTION_MS = 86_400_000;

/**
 * The hard ceiling on {@link pollReadiness}'s poll count, independent of the
 * budget it derives one from.
 *
 * The derived bound is `ceil(timeoutMs / pollIntervalMs) + 1`, which at the
 * defaults is 721 and at the extremes of the validated range is 86,400,001 —
 * finite, but not a number any caller intends. This is the stated bound the
 * function's JSDoc promises, and it applies whatever arithmetic produced the
 * derived one.
 */
export const MAX_READINESS_POLLS = 100_000;

/** The refusal a timing option that cannot be honoured produces. */
export const TIMING_OPTION_REFUSAL = "capture-timing-option-invalid";

/**
 * Refuse a millisecond budget that is not finite, positive and sane.
 *
 * A NAMED REFUSAL, AND BEFORE ANY BROWSER. Every call site is inside
 * {@link buildCaptureDescriptor} or at the top of {@link pollReadiness}, both
 * of which run before a browser is launched or a page is opened — so an
 * unhonourable budget costs a refusal, not an Edge slot and a hard stop.
 *
 * @param {string} name The option's name, as the caller spells it.
 * @param {unknown} value The value supplied.
 * @param {number} [maximum] The ceiling; {@link MAX_TIMING_OPTION_MS} by default.
 * @returns {number} The value, when it is honourable.
 * @throws {ProbeRefusal} `capture-timing-option-invalid` otherwise.
 */
export function requireTimingMs(name, value, maximum = MAX_TIMING_OPTION_MS) {
  if (Number.isSafeInteger(value) && value >= 1 && value <= maximum) {
    return value;
  }
  const shown =
    typeof value === "string" ? JSON.stringify(value) : String(value);
  throw new ProbeRefusal(
    TIMING_OPTION_REFUSAL,
    `capture ${name} must be a positive safe integer of milliseconds, at least 1 and at most ${maximum}; received ${shown}`,
    { option: name, received: shown, minimum: 1, maximum },
  );
}

/**
 * The predicates a cell waits for, in the order they are reported.
 *
 * `null` from a predicate means "this page has no such subsystem" (a rig that
 * hides the globe reports `tilesLoaded: null`) and satisfies it; only `true`
 * otherwise does. A rig may narrow the set through
 * `options.readinessPredicates`, and the refusal names whichever member was
 * still false when the budget ran out.
 */
export const READINESS_PREDICATES = Object.freeze([
  "renderReady",
  "tilesLoaded",
]);

export const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const HEX8 = /^[0-9a-f]{8}$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const ABSOLUTE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export const ORIGIN_REFUSAL_MESSAGE = Object.freeze({
  "capture-origin-absent":
    "capture requires an explicit BEFORE and AFTER origin; there is no default and an absent origin is never filled in for you",
  "capture-origin-invalid":
    "a capture origin must be an absolute http(s) origin",
});
