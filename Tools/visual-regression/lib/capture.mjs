// capture.mjs — DX-104, the capture seam: a rig in, a BEFORE/AFTER pair out.
//
// @purpose Captures one or more rigs over BEFORE and AFTER origins on both renderers in a single browser run, emitting the capture manifest, the diff heat-maps, the metric strip and the receipt.
// @status ACTIVE
//
// WHY THIS EXISTS. CLAUDE.md Principle 8 tells every rendering fix to build a
// probe, and names `probe-saved-view.mjs` as the template to copy. That file
// opens with `const BASE = "http://localhost:8080"` (`:16`), so every probe
// copied from it inherits a hard-coded origin, a private browser lifecycle and
// a private diff. `DX-01` already moved the browser lifecycle into
// `probe-runtime.mjs`; this module moves the rest, so "copy the template"
// becomes "declare a rig" and the origin becomes an argument the caller must
// supply. There is no default origin here, at all: an absent origin is the
// refusal `capture-origin-absent`. A default is exactly the thing this row
// exists to stop propagating, and `runProbe` still has one
// (`probe-runtime.mjs:905`, `http://localhost:${options.port}`) — which is why
// this module composes the runtime's PIECES (`launchEdge`, `captureElement`,
// the three deciders, `assembleReceipt`, `withEdgeSlot`) and never calls
// `runProbe` itself.
//
// BEFORE AND AFTER IN ONE RUN. A "before" capture taken on Monday and an
// "after" capture taken on Wednesday differ by the fix, by two driver states,
// by two Bing tile vintages and by whatever else moved in between. The pair is
// only comparable if it is taken in one process, through one browser, against
// two origins that are both up at the same moment — so `origins` is a required
// `{BEFORE, AFTER}` map and both legs of every cell run back to back. Two
// `--serve-built` servers on two ports is the intended deployment.
//
// EVERY MEASUREMENT IS TAKEN IN NODE, AFTER THE BROWSER HAS CLOSED. Principle
// 8 says "canvas-decode diff (no Node PNG dep needed)", which predates
// `Tools/lib/png-decode.mjs`. That decoder exists now, so the browser's only
// job here is to produce PNG bytes; the diff, the heat-map and the metric
// strip are computed from those bytes by pure functions a spec can drive with
// no browser at all.
//
// ONE BROWSER, OWNED BY THE LIFECYCLE. `fleetExemption`
// (`probe-fleet-contract.mjs:1141`) returns LAUNCHER_LIBRARY for every file
// directly under a `lib/`, and `launchesBrowserByBehaviour` (`:1125`) needs
// both a `playwright` import and an `<ident>.launch(` — this file has neither,
// because it delegates to `launchEdge`. So the fleet contract will never
// select it, and the watchdog rule has to hold without a guard enforcing it.
// A `finally` close alone does NOT hold it: it runs on the ordinary path and
// on the throw path, and on neither of the paths the watchdog exists for. So
// the Edge slot is taken through `scope.withEdgeSlot` and the browser through
// `scope.withResource({kind: "browser"})`, which is what puts the browser in
// the list `withProbeLifecycle` closes when the orderly deadline fires and
// proves closed before it reports quiescence. The run is bounded by that
// derived deadline rather than by a private `setTimeout(process.exit)` — a
// library must never call `process.exit`.
//
// THE MANIFEST CARRIES NO VERDICT. A rig may declare `gate`,
// `expectedMismatch` or `thresholds`; none of them reach the manifest, and
// `validateManifest` reports their presence as a violation. That is what makes
// "no pass/fail token on the contact sheet" (`R-2026-09-17-10`) structural
// rather than a promise: the page's only input cannot express a judgement.
// `UNMEASURED` is first-class — it is the word `visual-gate-policy.mjs:106`
// already uses for "never measured in this metric" — and a rig that declares
// `page: null` produces UNMEASURED cells rather than failing the run.

import fs from "node:fs";
import path from "node:path";

import { diffImages } from "./image-diff.mjs";
import { luminance } from "./metrics/luminance.mjs";
import { structureSimilarityRgba } from "./metrics/structure-similarity.mjs";
import { withEdgeSlot } from "./probe-edge-slot.mjs";
import { withProbeLifecycle } from "./probe-lifecycle.mjs";
import {
  HARD_STOP_GRACE_MS,
  LAUNCH_BUDGET_MS,
  MAX_TIMER_DELAY_MS,
  PREFLIGHT_BUDGET_MS,
  RESOURCE_CLOSE_DEADLINE_MS,
  RUN_SETTLEMENT_MARGIN_MS,
} from "./probe-lifecycle-run.mjs";
import {
  ProbeRefusal,
  acceptedDecision,
  refusedDecision,
  throwForDecision,
} from "./probe-refusal.mjs";
import {
  REQUIRED_SERVED_ARTIFACTS,
  RUN_OUTCOMES,
  assembleReceipt,
  buildIncidentRecord,
  captureElement,
  decideOriginRefusal,
  decideRenderReadyRefusal,
  decideServedBuildRefusal,
  launchEdge,
  normalizeJson,
  sha256,
} from "./probe-runtime.mjs";
import { isRelativePosixPath } from "./relative-path.mjs";
import { replayKeyFor, validateRig } from "./rig-registry.mjs";
import { preflightServedBuildArtifacts } from "./served-build-preflight.mjs";
import { decodePng } from "../../lib/png-decode.mjs";
import { encodeRgbaPng } from "../../lib/png-rgba.mjs";

// ---------------------------------------------------------------------------
// 1. The vocabulary
// ---------------------------------------------------------------------------

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
 * The fleet default (`RESOURCE_CLOSE_DEADLINE_MS`, 10 s) is tuned for a probe
 * holding one page. A capture run holds a browser that has built several
 * WebGPU device contexts, and the Edge leg of 2026-09-18 measured a healthy
 * close of exactly that browser at 3,298 ms and then blew the 10 s budget on
 * the failure path, where the hard stop exited 2 with the cell's own diagnosis
 * lost. Four times the measured healthy close is margin for a loaded machine
 * without being so long that a genuinely wedged browser is never reported.
 * `options.closeDeadlineMs` overrides it, and the hard-stop grace keeps the
 * fleet's own margin above whatever it becomes.
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
function requireTimingMs(name, value, maximum = MAX_TIMING_OPTION_MS) {
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

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX8 = /^[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ABSOLUTE_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

const ORIGIN_REFUSAL_MESSAGE = Object.freeze({
  "capture-origin-absent":
    "capture requires an explicit BEFORE and AFTER origin; there is no default and an absent origin is never filled in for you",
  "capture-origin-invalid":
    "a capture origin must be an absolute http(s) origin",
});

// ---------------------------------------------------------------------------
// 2. A rig's page, and the url it becomes on a caller's origin
// ---------------------------------------------------------------------------

/**
 * Normalise the two forms a rig may declare its page in.
 *
 * `validateRig` (`rig-registry.mjs:163`) requires exactly one of `page` or
 * `url`, and the two forms differ in a way that matters here: at the time of
 * writing 25 rigs declare an origin-RELATIVE `page`, 10 declare an ABSOLUTE
 * `url` on `http://localhost:8080`, and 4 declare `page: null`. Passing an
 * absolute `url` through to the browser would re-introduce the very literal
 * this row exists to retire — the AFTER leg would silently be captured from
 * the BEFORE server. So the declared origin is stripped off and recorded, and
 * only the path survives to be re-based onto the caller's origin.
 *
 * The form is decided by the VALUE's scheme, not by the field's name, so a rig
 * that spells a relative path under `url` still resolves correctly.
 *
 * @param {object} rig A rig record.
 * @returns {{kind: "relative", path: string}
 *   | {kind: "absolute", path: string, declaredOrigin: string}
 *   | {kind: "none", reason: string}} The resolved page.
 */
export function resolveRigPage(rig) {
  const record = rig ?? {};
  const hasPage = Object.hasOwn(record, "page");
  const hasUrl = Object.hasOwn(record, "url");
  if (hasPage === hasUrl) {
    return Object.freeze({
      kind: "none",
      reason: hasPage
        ? "rig declares both page and url — exactly one is required"
        : "rig declares neither page nor url — exactly one is required",
    });
  }

  const field = hasPage ? "page" : "url";
  const declared = hasPage ? record.page : record.url;
  if (declared === null) {
    return Object.freeze({
      kind: "none",
      reason: `rig declares ${field}: null — no page exists for this rig yet`,
    });
  }
  if (typeof declared !== "string" || declared.length === 0) {
    return Object.freeze({
      kind: "none",
      reason: `rig ${field} must be a non-empty string or null, got ${typeof declared}`,
    });
  }

  if (!ABSOLUTE_SCHEME.test(declared)) {
    return Object.freeze({
      kind: "relative",
      path: stripLeadingSlashes(declared),
    });
  }

  let parsed;
  try {
    parsed = new URL(declared);
  } catch {
    return Object.freeze({
      kind: "none",
      reason: `rig ${field} looks absolute but is not a url: ${declared}`,
    });
  }
  // The declared origin is REPORTED, never returned as part of `path`. A
  // `path` that still carried its own scheme would win over the base in
  // `new URL(path, base)` and the re-basing below would be a no-op.
  return Object.freeze({
    kind: "absolute",
    path: `${stripLeadingSlashes(parsed.pathname)}${parsed.search}${parsed.hash}`,
    declaredOrigin: parsed.origin,
  });
}

function stripLeadingSlashes(value) {
  return String(value).replace(/^\/+/, "");
}

/**
 * Turn a declared origin into a base a relative path can be resolved against.
 *
 * @param {unknown} origin The caller's origin.
 * @returns {string} The origin with a trailing slash.
 * @throws {ProbeRefusal} `capture-origin-absent` or `capture-origin-invalid`.
 */
function requireOriginBase(origin) {
  if (typeof origin !== "string" || origin.trim().length === 0) {
    throw new ProbeRefusal(
      "capture-origin-absent",
      ORIGIN_REFUSAL_MESSAGE["capture-origin-absent"],
      { origin: origin ?? null },
    );
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ProbeRefusal(
      "capture-origin-invalid",
      ORIGIN_REFUSAL_MESSAGE["capture-origin-invalid"],
      { origin },
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProbeRefusal(
      "capture-origin-invalid",
      ORIGIN_REFUSAL_MESSAGE["capture-origin-invalid"],
      { origin, protocol: parsed.protocol },
    );
  }
  return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
}

/**
 * The absolute url one cell fetches: the rig's path, re-based onto the
 * caller's origin.
 *
 * @param {object} options Inputs.
 * @param {object} options.rig The rig.
 * @param {string} options.origin The origin this leg is captured from.
 * @returns {string} The absolute url.
 * @throws {ProbeRefusal} `capture-rig-has-no-page` for a rig with no page, or
 *   an origin refusal for an absent or unusable origin.
 */
export function captureUrlFor({ rig, origin }) {
  const page = resolveRigPage(rig);
  if (page.kind === "none") {
    throw new ProbeRefusal(
      "capture-rig-has-no-page",
      `rig ${rig?.id ?? "(unnamed)"} cannot be captured: ${page.reason}`,
      { rig: rig?.id ?? null, reason: page.reason },
    );
  }
  return new URL(page.path, requireOriginBase(origin)).href;
}

// ---------------------------------------------------------------------------
// 3. Origins — required, verbatim, never defaulted
// ---------------------------------------------------------------------------

/**
 * Resolve the BEFORE and AFTER origins a run was given.
 *
 * Both are REQUIRED. There is no fallback, no `options.port`, and no
 * `http://localhost:8080`; absence is the refusal `capture-origin-absent`.
 * An accepted result carries the caller's own strings VERBATIM rather than the
 * parsed forms, because the manifest records what was asked for, and a
 * silently normalised origin is a different fact from the one the caller
 * stated.
 *
 * @param {object} options Options carrying `origins`.
 * @param {{BEFORE?: string, AFTER?: string}} [options.origins] The two origins.
 * @returns {{ok: true, origins: {BEFORE: string, AFTER: string}}
 *   | {ok: false, reason: string, details: object}} The resolution.
 */
export function resolveCaptureOrigins(options = {}) {
  const declared = options?.origins;
  if (declared === null || typeof declared !== "object") {
    return Object.freeze({
      ok: false,
      reason: "capture-origin-absent",
      details: Object.freeze({
        missing: [...CAPTURE_SLOTS],
        declared: declared ?? null,
      }),
    });
  }

  const missing = [];
  const invalid = [];
  for (const slot of CAPTURE_SLOTS) {
    const value = declared[slot];
    if (typeof value !== "string" || value.trim().length === 0) {
      missing.push(slot);
      continue;
    }
    try {
      requireOriginBase(value);
    } catch (error) {
      invalid.push({ slot, value, reason: error?.reason ?? "unknown" });
    }
  }
  if (missing.length > 0) {
    return Object.freeze({
      ok: false,
      reason: "capture-origin-absent",
      details: Object.freeze({ missing }),
    });
  }
  if (invalid.length > 0) {
    return Object.freeze({
      ok: false,
      reason: "capture-origin-invalid",
      details: Object.freeze({ invalid }),
    });
  }
  return Object.freeze({
    ok: true,
    origins: Object.freeze({
      BEFORE: declared.BEFORE,
      AFTER: declared.AFTER,
    }),
  });
}

// ---------------------------------------------------------------------------
// 4. The descriptor — the whole plan, before a browser exists
// ---------------------------------------------------------------------------

function trackedByFor(rig) {
  const declared = rig?.expectedMismatch;
  if (!Array.isArray(declared)) {
    return null;
  }
  for (const entry of declared) {
    if (typeof entry?.trackedBy === "string" && entry.trackedBy.length > 0) {
      return entry.trackedBy;
    }
  }
  return null;
}

function selectorFor(page, renderer, options) {
  if (page.kind !== "none" && page.path.startsWith(SPLIT_SCREEN_PAGE)) {
    // The tag the readiness step installs on each viewer's canvas, matching
    // what `capture-and-diff.mjs:508-517` already does: the page carries an
    // FPS overlay canvas too, so a bare `canvas` selector is ambiguous there.
    return `canvas[data-vr-tag="${renderer}"]`;
  }
  return options?.selector ?? "canvas";
}

function cellUrlFor(rig, page, renderer, origin) {
  const url = new URL(captureUrlFor({ rig, origin }));
  if (!page.path.startsWith(SPLIT_SCREEN_PAGE)) {
    // A single-viewer page picks its backend from the query the fork's own
    // `ContextFactory` reads; the split-screen page builds both and needs no
    // hint, so it is left exactly as the rig declared it.
    url.searchParams.set("renderer", renderer);
  }
  return url.href;
}

/**
 * Plan every cell and every pair of a run, with no I/O and no browser.
 *
 * @param {object|object[]} rig One rig, or the set of rigs to capture. A set is
 *   what makes a manifest's `rigs` array more than one entry long; the
 *   singular form is the common case and is normalised to a one-element set.
 * @param {{BEFORE: string, AFTER: string}} origins The two origins.
 * @param {object} [options] Options.
 * @param {string} [options.captureId] Slug for the default capture root.
 * @param {string} [options.captureRoot] Repo-relative POSIX capture root.
 * @param {string} [options.repositoryRoot] Absolute repository root.
 * @param {string} [options.selector] Element selector for non-split-screen rigs.
 * @param {number} [options.tolerance] Per-channel diff tolerance.
 * @param {string[]} [options.launchArgs] Edge flags instead of the runtime default.
 * @param {Function} [options.cellWork] The per-cell body; the injection seam.
 * @returns {object} The frozen plan.
 */
export function buildCaptureDescriptor(rig, origins, options = {}) {
  const rigs = Array.isArray(rig) ? [...rig] : [rig];
  if (rigs.length === 0) {
    throw new TypeError("buildCaptureDescriptor requires at least one rig");
  }

  const resolved = resolveCaptureOrigins({ ...options, origins });
  if (resolved.ok !== true) {
    throw new ProbeRefusal(
      resolved.reason,
      ORIGIN_REFUSAL_MESSAGE[resolved.reason],
      resolved.details,
    );
  }

  const violations = rigs.flatMap((one) => validateRig(one));
  if (violations.length > 0) {
    throw new TypeError(
      `buildCaptureDescriptor: ${violations.length} rig violation(s): ${violations.join("; ")}`,
    );
  }

  // EVERY TIMING OPTION, NOT JUST THE ONE THAT HAD A BUG. Before this block
  // only `closeDeadlineMs` was checked, so `readinessTimeoutMs: Infinity`,
  // `: NaN` and `readinessPollIntervalMs: NaN` each reached `pollReadiness`
  // and spun it without bound — the poll loop's own guard is derived from the
  // very numbers that were never validated. They are all refused here, at the
  // descriptor, which is the first thing `capture()` builds and is therefore
  // before the preflight, before the Edge slot and before any browser.
  // The close deadline's own ceiling is the sane maximum LESS the margin its
  // derived grace adds on top of it: a close budget that only just fits would
  // otherwise derive a grace that does not, and refusing the grace for a value
  // the caller never typed is a confusing way to say "your close deadline is
  // too big".
  const hardStopMarginMs = HARD_STOP_GRACE_MS - RESOURCE_CLOSE_DEADLINE_MS;
  const resolvedCloseDeadlineMs = requireTimingMs(
    "closeDeadlineMs",
    options.closeDeadlineMs ?? DEFAULT_CLOSE_DEADLINE_MS,
    MAX_TIMING_OPTION_MS - hardStopMarginMs,
  );
  const resolvedNavigationTimeoutMs = requireTimingMs(
    "navigationTimeoutMs",
    options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
  );
  const resolvedReadinessTimeoutMs = requireTimingMs(
    "readinessTimeoutMs",
    options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
  );
  const resolvedReadinessPollIntervalMs = requireTimingMs(
    "readinessPollIntervalMs",
    options.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS,
  );
  const resolvedCellBudgetMs = requireTimingMs(
    "cellBudgetMs",
    options.cellBudgetMs ?? DEFAULT_CELL_BUDGET_MS,
  );
  const resolvedHardStopGraceMs = requireTimingMs(
    "hardStopGraceMs",
    options.hardStopGraceMs ?? resolvedCloseDeadlineMs + hardStopMarginMs,
  );

  const captureRoot = resolveCaptureRoot(options);
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const outputDirectory = path.resolve(
    repositoryRoot,
    ...captureRoot.split("/"),
  );
  const tolerance = options.tolerance ?? DEFAULT_PAIR_TOLERANCE;

  const cells = [];
  const pairs = [];
  const summaries = [];
  const renderers = new Set();

  for (const one of rigs) {
    const page = resolveRigPage(one);
    const rigRenderers = one.renderers.filter((renderer) =>
      CAPTURE_RENDERERS.includes(renderer),
    );
    summaries.push(
      Object.freeze({
        id: one.id,
        replayKey: replayKeyFor(one),
        description: one.description ?? "",
        viewport: Object.freeze({
          width: one.viewport.width,
          height: one.viewport.height,
        }),
        renderers: Object.freeze([...rigRenderers]),
      }),
    );

    for (const renderer of rigRenderers) {
      renderers.add(renderer);
      for (const slot of CAPTURE_SLOTS) {
        const measurable = page.kind !== "none";
        cells.push(
          Object.freeze({
            key: `${one.id}|${renderer}|${slot}`,
            rigId: one.id,
            renderer,
            slot,
            state: measurable ? CELL_STATES.MEASURED : CELL_STATES.UNMEASURED,
            reason: measurable ? null : page.reason,
            trackedBy: measurable ? null : trackedByFor(one),
            origin: resolved.origins[slot],
            declaredOrigin:
              page.kind === "absolute" ? page.declaredOrigin : null,
            url: measurable
              ? cellUrlFor(one, page, renderer, resolved.origins[slot])
              : null,
            pageKind:
              measurable && page.path.startsWith(SPLIT_SCREEN_PAGE)
                ? "split-screen"
                : "single-viewer",
            selector: selectorFor(page, renderer, options),
            viewport: Object.freeze({
              width: one.viewport.width,
              height: one.viewport.height,
            }),
            readiness: one.readiness,
            readinessPredicates: Object.freeze([
              ...(options.readinessPredicates ?? READINESS_PREDICATES),
            ]),
            navigationTimeoutMs: resolvedNavigationTimeoutMs,
            readinessTimeoutMs: resolvedReadinessTimeoutMs,
            readinessPollIntervalMs: resolvedReadinessPollIntervalMs,
            image: measurable ? `${one.id}/${renderer}/${slot}.png` : null,
            captureName: slot,
            outputDirectory: path.join(outputDirectory, one.id, renderer),
            outputPath: path.join(
              outputDirectory,
              one.id,
              renderer,
              `${slot}.png`,
            ),
          }),
        );
      }
      pairs.push(
        Object.freeze({
          key: `${one.id}|${renderer}`,
          rigId: one.id,
          renderer,
          diffImage: `${one.id}/${renderer}/DIFF.png`,
          diffPath: path.join(outputDirectory, one.id, renderer, "DIFF.png"),
          tolerance,
        }),
      );
    }
  }

  const descriptor = {
    schemaVersion: CAPTURE_MANIFEST_SCHEMA_VERSION,
    captureId: options.captureId ?? path.posix.basename(captureRoot),
    captureRoot,
    repositoryRoot,
    outputDirectory,
    origins: resolved.origins,
    slots: Object.freeze([...CAPTURE_SLOTS]),
    renderers: Object.freeze(
      CAPTURE_RENDERERS.filter((renderer) => renderers.has(renderer)),
    ),
    rigs: Object.freeze(summaries),
    cells: Object.freeze(cells),
    pairs: Object.freeze(pairs),
    tolerance,
    launchArgs: options.launchArgs
      ? Object.freeze([...options.launchArgs])
      : null,
    headed: options.headed === true,
    servedBuild: options.servedBuild !== false,
    requiredArtifacts: Object.freeze([
      ...(options.servedArtifacts ?? REQUIRED_SERVED_ARTIFACTS),
    ]),
    cellBudgetMs: resolvedCellBudgetMs,
    // Both budgets are the CAPTURE's, not the fleet's — see
    // `DEFAULT_CLOSE_DEADLINE_MS`. The grace keeps the fleet's own margin
    // (`HARD_STOP_GRACE_MS - RESOURCE_CLOSE_DEADLINE_MS`, the Edge-slot close
    // timeout plus a second) above whatever the close deadline becomes, so a
    // raised close budget cannot silently move the hard stop below it.
    closeDeadlineMs: resolvedCloseDeadlineMs,
    hardStopGraceMs: resolvedHardStopGraceMs,
    incidentName: "capture-incident.json",
    // `cells` is a DESCRIPTOR field, the way `runProbe`'s own `cells` is
    // (`probe-runtime.mjs:836` takes `{argv, now, chromium, preflight, launch,
    // writeFile, repositoryRoot, lifecycle, lifecycleDependencies}` as
    // `dependencies` and reads the cell body off the descriptor). Both seams
    // exist; they are simply in two different places, and this one is here.
    cellWork: options.cellWork ?? defaultCellWork,
    slotOwner:
      options.slotOwner ??
      `capture:${options.captureId ?? path.posix.basename(captureRoot)}`,
    edgeSlotLockPath: path.join(
      repositoryRoot,
      "Tools",
      "visual-regression",
      "output",
      ".edge-slot.lock",
    ),
    manifestName: "capture-manifest.json",
    receiptPath: options.receiptPath ?? "capture-report.json",
  };
  descriptor.deadlineMs = deriveCaptureDeadline(descriptor, options);
  return Object.freeze(descriptor);
}

function resolveCaptureRoot(options) {
  if (
    typeof options.captureRoot === "string" &&
    options.captureRoot.length > 0
  ) {
    return options.captureRoot.split("\\").join("/").replace(/\/+$/, "");
  }
  if (typeof options.captureId === "string" && options.captureId.length > 0) {
    return `Tools/visual-regression/output/capture/${options.captureId}`;
  }
  throw new TypeError(
    "buildCaptureDescriptor requires options.captureId or options.captureRoot; a capture that names itself by accident cannot be banked",
  );
}

/**
 * The whole-run orderly deadline, composed from the parts this module owns.
 *
 * Same shape and the same constants as `deriveLifecycleDeadline`
 * (`probe-lifecycle-run.mjs`), re-composed for this module's run shape: one
 * preflight PER ORIGIN, exactly ONE browser for the whole run, and one work
 * budget per MEASURED cell. `BigInt` so an implausible budget produces a
 * refusable range error rather than a silently saturated timer.
 *
 * @param {object} descriptor A capture descriptor.
 * @param {object} [options] Options; `cellBudgetMs` overrides the descriptor's.
 * @returns {number} The deadline in milliseconds.
 */
export function deriveCaptureDeadline(descriptor, options = {}) {
  const budget = options.cellBudgetMs ?? descriptor.cellBudgetMs;
  if (!Number.isSafeInteger(budget) || budget < 1) {
    throw new TypeError(
      "capture cellBudgetMs must be a positive safe integer of milliseconds",
    );
  }
  const measured = descriptor.cells.filter(
    (cell) => cell.state === CELL_STATES.MEASURED,
  ).length;
  const required =
    BigInt(PREFLIGHT_BUDGET_MS) * BigInt(descriptor.slots.length) +
    BigInt(LAUNCH_BUDGET_MS) +
    BigInt(measured) * BigInt(budget) +
    BigInt(RUN_SETTLEMENT_MARGIN_MS);
  if (required > BigInt(MAX_TIMER_DELAY_MS)) {
    throw new RangeError(
      "capture deadline exceeds the supported timer delay; capture fewer rigs per run",
    );
  }
  return Number(required);
}

// ---------------------------------------------------------------------------
// 5. Refusals — composed from the runtime's deciders, never re-implemented
// ---------------------------------------------------------------------------

/**
 * Every refusal a capture can decide, in the order it can decide them.
 *
 * The served-build, navigated-origin and render-ready questions are answered
 * by `decideServedBuildRefusal`, `decideOriginRefusal` and
 * `decideRenderReadyRefusal` from the runtime — this function composes them and
 * adds only what the runtime has no equivalent for: the required origins, and
 * whether the rig set is well formed. A rig that declares `page: null` is NOT a
 * refusal: it produces UNMEASURED cells and the rest of the run proceeds.
 *
 * @param {object} inputs Inputs.
 * @param {object|object[]} inputs.rig The rig or rig set.
 * @param {{BEFORE?: string, AFTER?: string}} inputs.origins The two origins.
 * @param {object} [inputs.preflight] Preflight results keyed by slot.
 * @param {boolean} [inputs.servedBuild] Whether the served-build assertion is enforced.
 * @param {string[]} [inputs.requiredArtifacts] Artifacts the preflight must have matched.
 * @param {object} [inputs.navigation] `{requestedOrigin, actualUrl, label}` after a navigation.
 * @param {object} [inputs.readiness] `{renderReady, elapsedMs, timeoutMs}` after a settle.
 * @returns {object} An accepted or refusing decision.
 */
export function decideCaptureRefusal({
  rig,
  origins,
  preflight,
  servedBuild = true,
  requiredArtifacts,
  navigation,
  readiness,
}) {
  const resolved = resolveCaptureOrigins({ origins });
  if (resolved.ok !== true) {
    return refusedDecision(resolved.reason, resolved.details);
  }

  const rigs = Array.isArray(rig) ? rig : [rig];
  if (rigs.length === 0) {
    return refusedDecision("capture-rig-absent", { rigs: 0 });
  }
  const violations = rigs.flatMap((one) => validateRig(one));
  if (violations.length > 0) {
    return refusedDecision("capture-rig-invalid", { violations });
  }

  const waived = servedBuild !== true;
  for (const slot of CAPTURE_SLOTS) {
    const decision = decideServedBuildRefusal(
      waived ? null : (preflight?.[slot] ?? null),
      { requiredArtifacts, waived },
    );
    if (decision.refuse === true) {
      return refusedDecision(decision.reason, {
        ...(decision.details ?? {}),
        slot,
        origin: resolved.origins[slot],
      });
    }
    if (waived) {
      break;
    }
  }

  if (navigation) {
    const decision = decideOriginRefusal(navigation);
    if (decision.refuse === true) {
      return decision;
    }
  }
  if (readiness) {
    const decision = decideRenderReadyRefusal(readiness);
    if (decision.refuse === true) {
      return decision;
    }
  }
  return acceptedDecision();
}

// ---------------------------------------------------------------------------
// 6. Metrics — pure, over decoded bytes, after the browser has closed
// ---------------------------------------------------------------------------

/**
 * The per-cell metric strip.
 *
 * @param {{data: ArrayLike<number>}|ArrayLike<number>} rgba Decoded RGBA, or a
 *   decoded image carrying it.
 * @param {{width: number, height: number}} dimensions The image's dimensions.
 * @returns {{rawByteLumaMean: number, nonBlackFraction: number, provenance: string}} The strip.
 */
export function cellMetrics(rgba, { width, height }) {
  const data = rgba?.data ?? rgba;
  const pixels = width * height;
  if (!Number.isInteger(pixels) || pixels <= 0) {
    throw new TypeError(
      `cellMetrics needs positive integer dimensions, got ${width}x${height}`,
    );
  }
  if (data?.length !== pixels * 4) {
    throw new TypeError(
      `cellMetrics: ${width}x${height} needs ${pixels * 4} rgba bytes, got ${data?.length}`,
    );
  }
  let lumaSum = 0;
  let nonBlack = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    lumaSum += luminance(r, g, b);
    if (
      r > NON_BLACK_CHANNEL_THRESHOLD ||
      g > NON_BLACK_CHANNEL_THRESHOLD ||
      b > NON_BLACK_CHANNEL_THRESHOLD
    ) {
      nonBlack++;
    }
  }
  return {
    rawByteLumaMean: lumaSum / pixels,
    nonBlackFraction: nonBlack / pixels,
    provenance: CELL_METRIC_PROVENANCE,
  };
}

/**
 * The per-pair metric strip and the heat-map buffer that goes beside it.
 *
 * `mismatchPct` is the PERCENT `diffImages` returns, passed through untouched —
 * deliberately not the 0-1 ratio `compareCaptures` returns, so the two can
 * never be silently interchanged.
 *
 * @param {{width: number, height: number, data: ArrayLike<number>}} before BEFORE leg.
 * @param {{width: number, height: number, data: ArrayLike<number>}} after AFTER leg.
 * @param {{tolerance?: number, windowSize?: number}} [options] Options.
 * @returns {{mismatchPct: number|null, changedPx: number, bbox: object|null,
 *   tolerance: number, diffRgba: Uint8ClampedArray, mssim: number, windows: number}} The pair.
 */
export function pairMetrics(before, after, options = {}) {
  const tolerance = options.tolerance ?? DEFAULT_PAIR_TOLERANCE;
  const { mismatchPct, changedPx, bbox, diffRgba } = diffImages(before, after, {
    tolerance,
  });
  const { mssim, windows } = structureSimilarityRgba(before, after, {
    ...(options.windowSize === undefined
      ? {}
      : { windowSize: options.windowSize }),
  });
  return { mismatchPct, changedPx, bbox, tolerance, diffRgba, mssim, windows };
}

// ---------------------------------------------------------------------------
// 7. The manifest — the one document the contact sheet reads
// ---------------------------------------------------------------------------

/**
 * Assemble the capture manifest from a plan and what the run produced.
 *
 * @param {object} inputs Inputs.
 * @param {object} inputs.descriptor The plan.
 * @param {Map<string, object>|object} inputs.cells Cell records by cell key.
 * @param {Map<string, object>|object} inputs.pairs Pair records by pair key.
 * @param {string} inputs.receiptPath The receipt, relative to the manifest.
 * @param {string} inputs.generatedAt ISO-8601 UTC instant.
 * @param {"enforced"|"waived"} inputs.servedBuildAssertion The assertion's state.
 * @returns {object} The manifest.
 */
export function buildCaptureManifest({
  descriptor,
  cells,
  pairs,
  receiptPath,
  generatedAt,
  servedBuildAssertion,
}) {
  const cellAt = (key) =>
    cells instanceof Map ? cells.get(key) : cells?.[key];
  const pairAt = (key) =>
    pairs instanceof Map ? pairs.get(key) : pairs?.[key];

  return {
    schemaVersion: CAPTURE_MANIFEST_SCHEMA_VERSION,
    kind: CAPTURE_MANIFEST_KIND,
    generatedAt,
    captureRoot: descriptor.captureRoot,
    origins: { ...descriptor.origins },
    servedBuildAssertion,
    receipt: receiptPath,
    slots: [...descriptor.slots],
    renderers: [...descriptor.renderers],
    rigs: descriptor.rigs.map((summary) => {
      const rigCells = {};
      const rigPairs = {};
      for (const renderer of summary.renderers) {
        rigCells[renderer] = {};
        for (const slot of descriptor.slots) {
          rigCells[renderer][slot] =
            cellAt(`${summary.id}|${renderer}|${slot}`) ??
            unmeasuredCell("no cell record was produced for this slot");
        }
        rigPairs[renderer] =
          pairAt(`${summary.id}|${renderer}`) ??
          unmeasuredPair("no pair record was produced for this renderer");
      }
      return {
        id: summary.id,
        replayKey: summary.replayKey,
        description: summary.description,
        viewport: { ...summary.viewport },
        cells: rigCells,
        pairs: rigPairs,
      };
    }),
  };
}

function unmeasuredCell(reason, trackedBy = null) {
  return {
    state: CELL_STATES.UNMEASURED,
    image: null,
    reason,
    trackedBy,
    metrics: null,
  };
}

function unmeasuredPair(reason) {
  return {
    state: CELL_STATES.UNMEASURED,
    diffImage: null,
    mismatchPct: null,
    changedPx: null,
    bbox: null,
    tolerance: null,
    metrics: null,
    reason,
  };
}

// The manifest's path predicate is `lib/relative-path.mjs`'s, not a copy of
// it. The copy that used to stand here tested `ABSOLUTE_SCHEME`, which
// requires `://` — so `C:/ESCAPED/x.png` had no scheme to match and validated
// clean HERE while the contact sheet's reader refused it. Two fail-closed
// readers of the same manifest disagreeing about what a relative path is is
// the defect, not a style difference. `ABSOLUTE_SCHEME` stays above for
// `resolveRigPage`, where "is this a url to parse" really is the question.

function scanForVerdicts(value, trail, violations) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForVerdicts(entry, `${trail}[${index}]`, violations),
    );
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_MANIFEST_KEYS.includes(key)) {
        violations.push(
          `${trail}.${key}: verdict vocabulary may not enter a capture manifest`,
        );
      }
      scanForVerdicts(entry, `${trail}.${key}`, violations);
    }
    return;
  }
  if (typeof value === "string" && FORBIDDEN_MANIFEST_VALUES.includes(value)) {
    violations.push(
      `${trail}: "${value}" is a GateExpectation token and may not appear in a capture manifest`,
    );
  }
}

/**
 * Validate a capture manifest. Fails CLOSED: an unrecognised shape is a
 * violation rather than a silent pass, the discipline `validateRig` already
 * uses.
 *
 * @param {object} manifest The manifest.
 * @returns {string[]} Violations; empty when the manifest is sound.
 */
export function validateManifest(manifest) {
  const violations = [];
  const need = (condition, message) => {
    if (!condition) {
      violations.push(message);
    }
  };

  if (manifest === null || typeof manifest !== "object") {
    return ["manifest must be an object"];
  }

  need(
    manifest.schemaVersion === CAPTURE_MANIFEST_SCHEMA_VERSION,
    `schemaVersion must be ${CAPTURE_MANIFEST_SCHEMA_VERSION}, got ${JSON.stringify(manifest.schemaVersion)}`,
  );
  need(
    manifest.kind === CAPTURE_MANIFEST_KIND,
    `kind must be "${CAPTURE_MANIFEST_KIND}", got ${JSON.stringify(manifest.kind)}`,
  );
  need(
    ISO_INSTANT.test(String(manifest.generatedAt)),
    "generatedAt must be an ISO-8601 UTC instant with milliseconds",
  );
  need(
    isRelativePosixPath(manifest.captureRoot),
    "captureRoot must be a relative POSIX path",
  );
  need(
    isRelativePosixPath(manifest.receipt),
    "receipt must be a relative POSIX path",
  );
  need(
    manifest.servedBuildAssertion === "enforced" ||
      manifest.servedBuildAssertion === "waived",
    'servedBuildAssertion must be "enforced" or "waived"',
  );
  for (const slot of CAPTURE_SLOTS) {
    need(
      typeof manifest.origins?.[slot] === "string" &&
        manifest.origins[slot].length > 0,
      `origins.${slot} is required and is never defaulted`,
    );
  }
  need(
    Array.isArray(manifest.slots) &&
      manifest.slots.length === CAPTURE_SLOTS.length &&
      manifest.slots.every((slot, index) => slot === CAPTURE_SLOTS[index]),
    `slots must be exactly ${JSON.stringify(CAPTURE_SLOTS)}`,
  );
  need(
    Array.isArray(manifest.renderers) &&
      manifest.renderers.length > 0 &&
      manifest.renderers.every((renderer) =>
        CAPTURE_RENDERERS.includes(renderer),
      ),
    `renderers must be a non-empty subset of ${JSON.stringify(CAPTURE_RENDERERS)}`,
  );

  const known = new Set([
    "schemaVersion",
    "kind",
    "generatedAt",
    "captureRoot",
    "origins",
    "servedBuildAssertion",
    "receipt",
    "slots",
    "renderers",
    "rigs",
  ]);
  for (const key of Object.keys(manifest)) {
    need(known.has(key), `unknown top-level key ${key}`);
  }

  if (!Array.isArray(manifest.rigs) || manifest.rigs.length === 0) {
    violations.push("rigs must be a non-empty array");
  } else {
    for (const rig of manifest.rigs) {
      validateManifestRig(rig, manifest, violations);
    }
  }

  scanForVerdicts(manifest, "manifest", violations);
  return violations;
}

function validateManifestRig(rig, manifest, violations) {
  const id = rig?.id ?? "(unnamed)";
  const need = (condition, message) => {
    if (!condition) {
      violations.push(`${id}: ${message}`);
    }
  };

  need(typeof rig?.id === "string" && rig.id.length > 0, "missing id");
  need(HEX8.test(String(rig?.replayKey)), "replayKey must be 8 lowercase hex");
  need(typeof rig?.description === "string", "description must be a string");
  need(
    Number.isFinite(rig?.viewport?.width) && rig.viewport.width > 0,
    "viewport.width must be positive",
  );
  need(
    Number.isFinite(rig?.viewport?.height) && rig.viewport.height > 0,
    "viewport.height must be positive",
  );

  const renderers = Object.keys(rig?.cells ?? {});
  need(renderers.length > 0, "cells must name at least one renderer");
  for (const renderer of renderers) {
    need(
      CAPTURE_RENDERERS.includes(renderer),
      `unknown renderer ${renderer} in cells`,
    );
    for (const slot of CAPTURE_SLOTS) {
      validateManifestCell(
        rig.cells[renderer]?.[slot],
        `${id}.${renderer}.${slot}`,
        violations,
      );
    }
    validateManifestPair(
      rig.pairs?.[renderer],
      `${id}.${renderer}`,
      violations,
    );
  }
  need(
    Object.keys(rig?.pairs ?? {}).every((renderer) =>
      renderers.includes(renderer),
    ),
    "pairs name a renderer that has no cells",
  );
}

function validateManifestCell(cell, trail, violations) {
  const need = (condition, message) => {
    if (!condition) {
      violations.push(`${trail}: ${message}`);
    }
  };
  if (cell === null || typeof cell !== "object") {
    violations.push(`${trail}: missing cell`);
    return;
  }
  if (cell.state === CELL_STATES.UNMEASURED) {
    need(cell.image === null, "an UNMEASURED cell has image null");
    need(
      typeof cell.reason === "string" && cell.reason.length > 0,
      "an UNMEASURED cell states its reason",
    );
    need(
      cell.trackedBy === null || typeof cell.trackedBy === "string",
      "trackedBy must be a string or null",
    );
    need(cell.metrics === null, "an UNMEASURED cell has metrics null");
    return;
  }
  if (cell.state !== CELL_STATES.MEASURED) {
    violations.push(
      `${trail}: state must be MEASURED or UNMEASURED, got ${JSON.stringify(cell.state)}`,
    );
    return;
  }
  need(
    isRelativePosixPath(cell.image),
    "image must be a relative POSIX path beside the manifest",
  );
  need(
    Number.isInteger(cell.width) && cell.width > 0,
    "width must be a positive integer",
  );
  need(
    Number.isInteger(cell.height) && cell.height > 0,
    "height must be a positive integer",
  );
  need(
    Number.isInteger(cell.byteLength) && cell.byteLength > 0,
    "byteLength must be a positive integer",
  );
  need(HEX64.test(String(cell.sha256)), "sha256 must be 64 lowercase hex");
  need(
    typeof cell.url === "string" && cell.url.length > 0,
    "url records what was fetched",
  );
  need(
    ISO_INSTANT.test(String(cell.capturedAt)),
    "capturedAt must be an ISO-8601 UTC instant",
  );
  need(
    Number.isFinite(cell.metrics?.rawByteLumaMean),
    "metrics.rawByteLumaMean must be finite",
  );
  need(
    Number.isFinite(cell.metrics?.nonBlackFraction) &&
      cell.metrics.nonBlackFraction >= 0 &&
      cell.metrics.nonBlackFraction <= 1,
    "metrics.nonBlackFraction must be in [0,1]",
  );
  need(
    cell.metrics?.provenance === CELL_METRIC_PROVENANCE,
    "metrics.provenance must state what the strip is",
  );
}

function validateManifestPair(pair, trail, violations) {
  const need = (condition, message) => {
    if (!condition) {
      violations.push(`${trail}: ${message}`);
    }
  };
  if (pair === null || typeof pair !== "object") {
    violations.push(`${trail}: missing pair`);
    return;
  }
  if (pair.state === CELL_STATES.UNMEASURED) {
    for (const key of [
      "diffImage",
      "mismatchPct",
      "changedPx",
      "bbox",
      "tolerance",
      "metrics",
    ]) {
      need(pair[key] === null, `an UNMEASURED pair has ${key} null`);
    }
    need(
      typeof pair.reason === "string" && pair.reason.length > 0,
      "an UNMEASURED pair states its reason",
    );
    return;
  }
  if (pair.state !== CELL_STATES.MEASURED) {
    violations.push(
      `${trail}: state must be MEASURED or UNMEASURED, got ${JSON.stringify(pair.state)}`,
    );
    return;
  }
  need(
    isRelativePosixPath(pair.diffImage),
    "diffImage must be a relative POSIX path beside the manifest",
  );
  need(
    pair.mismatchPct === null ||
      (Number.isFinite(pair.mismatchPct) &&
        pair.mismatchPct >= 0 &&
        pair.mismatchPct <= 100),
    "mismatchPct must be a percent in [0,100] or null",
  );
  need(
    Number.isInteger(pair.changedPx) && pair.changedPx >= 0,
    "changedPx must be a non-negative integer",
  );
  need(
    pair.bbox === null ||
      ["x0", "y0", "x1", "y1"].every((key) => Number.isInteger(pair.bbox[key])),
    "bbox must be null or four integers",
  );
  need(Number.isFinite(pair.tolerance), "tolerance records what the diff used");
  need(Number.isFinite(pair.metrics?.mssim), "metrics.mssim must be finite");
  need(
    Number.isInteger(pair.metrics?.windows) && pair.metrics.windows > 0,
    "metrics.windows must be a positive integer",
  );
}

// ---------------------------------------------------------------------------
// 8. The run
// ---------------------------------------------------------------------------

/**
 * Bring one cell's page up and screenshot its element. The default
 * `descriptor.cellWork`; a spec replaces it wholesale.
 *
 * @param {object} cell One planned cell.
 * @param {object} context Run context.
 * @param {object} context.browser The live browser.
 * @param {Function} context.now Clock; also what the readiness wait measures with.
 * @param {object} [context.scope] The lifecycle slot scope. When present the
 *   browser context is registered as a tracked resource parented to the
 *   browser, so a watchdog close proves it closed instead of assuming the
 *   browser took it down.
 * @returns {Promise<object>} `{buffer, url, capturedAt, ...}`.
 */
export async function defaultCellWork(cell, { browser, now, scope }) {
  const work = async (context) => {
    const page = await context.newPage();
    await page.goto(cell.url, {
      waitUntil: "load",
      timeout: cell.navigationTimeoutMs,
    });
    throwForDecision(
      decideOriginRefusal({
        requestedOrigin: cell.origin,
        actualUrl: page.url(),
        label: cell.key,
      }),
      `cell ${cell.key} navigated off the origin it was pointed at`,
    );

    const readiness = await waitForCellReadiness(page, cell, now);
    throwForDecision(
      decideCellReadinessRefusal(readiness),
      `cell ${cell.key} was not ready to capture: ${describeReadiness(readiness)}`,
    );

    const captured = await captureElement({
      page,
      selector: cell.selector,
      name: cell.captureName,
      outputDirectory: cell.outputDirectory,
    });
    return {
      buffer: captured.buffer,
      byteLength: captured.byteLength,
      sha256: captured.sha256,
      matchCount: captured.matchCount,
      url: page.url(),
      capturedAt: new Date(now()).toISOString(),
      readiness: summariseCellReadiness(readiness),
    };
  };

  const newContext = () =>
    browser.newContext({ viewport: { ...cell.viewport } });
  if (scope === undefined || scope === null) {
    const context = await newContext();
    try {
      return await work(context);
    } finally {
      await context.close();
    }
  }

  // A browser context has no `isConnected()` of its own, so closure is
  // observed from the close resolving — and from the cascade, when the
  // browser resource closes first and marks its children closed.
  let closed = false;
  return scope.withResource(
    {
      kind: "context",
      label: `capture context ${cell.key}`,
      parent: browser,
      acquire: newContext,
      close: async (context) => {
        await context.close();
        closed = true;
      },
      isClosed: () => closed,
    },
    work,
  );
}

/**
 * Whether one readiness predicate is satisfied. `null` is "this page has no
 * such subsystem" and satisfies; `undefined` is "the page did not answer" and
 * does not.
 *
 * @param {unknown} value The observed value.
 * @returns {boolean} Whether it counts as ready.
 */
function readinessSatisfied(value) {
  return value === true || value === null;
}

/**
 * One predicate's observed value, preserving the `null`/`undefined`
 * distinction that {@link readinessSatisfied} turns on.
 *
 * @param {object|null|undefined} observed The observation.
 * @param {string} name The predicate.
 * @returns {unknown} The value, or `undefined` when there is no observation.
 */
function readAt(observed, name) {
  if (observed === null || typeof observed !== "object") {
    return undefined;
  }
  return observed[name];
}

/**
 * Re-read the readiness predicates until they all hold, the budget runs out,
 * or the poll count derived from the budget is exhausted.
 *
 * Pure but for its three injected seams, so the whole late-ready behaviour is
 * spec-drivable without a browser: `sample` returns one observation, `now` is
 * the clock, `sleep` is the wait between polls.
 *
 * THE POLL COUNT IS BOUNDED AS WELL AS THE CLOCK, AND BOTH BUDGETS ARE
 * VALIDATED FIRST. A spec (or a stopped debugger) whose clock does not advance
 * must still terminate, and "spin forever against a frozen clock" is not a
 * failure mode worth shipping to find out about. The derived bound is not
 * sufficient on its own: it is arithmetic on `timeoutMs` and `pollIntervalMs`,
 * so `Infinity` derives `Infinity` and `NaN` derives a bound no comparison can
 * ever satisfy. Both arguments therefore go through
 * {@link requireTimingMs} — a named refusal, before the first sample — and the
 * derived bound is additionally capped at {@link MAX_READINESS_POLLS}.
 *
 * `elapsedMs` MAY EXCEED `timeoutMs`, BY UP TO ONE POLL, BY DESIGN. The budget
 * is tested AFTER a sample returns, because a sample in flight cannot be
 * abandoned: one `page.evaluate` round trip against a loaded machine measured
 * ~700 ms on the Edge leg, so a 3,000 ms budget reported 4,289 ms spent. The
 * overshoot is bounded by exactly one sample, and both numbers are reported —
 * see the receipt's `elapsedMsAfterFinalPoll`, whose name says which of the
 * two it is.
 *
 * @param {object} options Options.
 * @param {() => Promise<object>} options.sample Reads one observation.
 * @param {() => number} options.now Clock, in milliseconds.
 * @param {(ms: number) => Promise<void>} options.sleep Waits between polls.
 * @param {number} options.timeoutMs Whole-poll budget.
 * @param {number} options.pollIntervalMs Gap between polls.
 * @param {string[]} [options.predicates] Defaults to {@link READINESS_PREDICATES}.
 * @returns {Promise<{ready: boolean, polls: number, elapsedMs: number,
 *   timeoutMs: number, unmet: string[], lastUnmet: string[],
 *   observed: object|null}>} The outcome. `lastUnmet` is the unmet set from
 *   the last poll that had one — on a cell that became ready it is what the
 *   poll before the successful one was still waiting for, and `[]` when the
 *   first sample already held.
 * @throws {ProbeRefusal} `capture-timing-option-invalid` for a budget or an
 *   interval that is not a positive safe integer within the sane maximum.
 */
export async function pollReadiness({
  sample,
  now,
  sleep,
  timeoutMs,
  pollIntervalMs,
  predicates = READINESS_PREDICATES,
}) {
  requireTimingMs("readinessTimeoutMs", timeoutMs);
  requireTimingMs("readinessPollIntervalMs", pollIntervalMs);
  const started = now();
  const interval = Math.max(1, pollIntervalMs);
  // The DERIVED bound is arithmetic on two caller-supplied numbers, so it is
  // only as sound as they are. `requireTimingMs` above has already refused an
  // unsound pair — this second line is the one that holds if that refusal is
  // ever removed or bypassed, because an unrepresentable derived bound falls
  // back to the STATED one rather than to a comparison nothing satisfies.
  const derived = Math.ceil(timeoutMs / interval) + 1;
  const maxPolls = Number.isSafeInteger(derived)
    ? Math.min(MAX_READINESS_POLLS, Math.max(1, derived))
    : MAX_READINESS_POLLS;
  let polls = 0;
  let lastUnmet = [];

  for (;;) {
    const observed = await sample();
    polls += 1;
    // Read the property, never `?? undefined`: `null` is a MEANINGFUL answer
    // here ("this page has no globe to wait for") and the nullish coalescing
    // that looks harmless collapses it into the absent case.
    const unmet = predicates.filter(
      (name) => !readinessSatisfied(readAt(observed, name)),
    );
    const elapsedMs = now() - started;
    if (unmet.length === 0) {
      return {
        ready: true,
        polls,
        elapsedMs,
        timeoutMs,
        unmet,
        lastUnmet,
        observed,
      };
    }
    lastUnmet = unmet;
    if (elapsedMs >= timeoutMs || polls >= maxPolls) {
      return {
        ready: false,
        polls,
        elapsedMs,
        timeoutMs,
        unmet,
        lastUnmet,
        observed,
      };
    }
    await sleep(Math.min(interval, Math.max(1, timeoutMs - elapsedMs)));
  }
}

/**
 * A one-line diagnosis of a readiness outcome, for the refusal's message.
 *
 * @param {object} readiness A {@link waitForCellReadiness} result.
 * @returns {string} The diagnosis.
 */
export function describeReadiness(readiness) {
  const unmet = (readiness?.unmet ?? []).join(", ") || "none";
  const observed = JSON.stringify(readiness?.observed ?? null);
  return `unmet ${unmet} after ${readiness?.polls ?? 0} polls over ${readiness?.elapsedMs ?? 0} ms of a ${readiness?.timeoutMs ?? 0} ms budget (phase ${readiness?.phase ?? "unknown"}, last observed ${observed})`;
}

/**
 * The refusal a cell that never became ready produces.
 *
 * The runtime's `decideRenderReadyRefusal` still answers the `renderReady`
 * question — this composes it rather than re-implementing it — and the capture
 * layer adds what the runtime has no way to know: WHICH predicate was still
 * false, what was last observed, and how many polls over how long. A timeout
 * is a REFUSAL (exit 3), never a skipped cell: an UNMEASURED cell in the
 * manifest means "this rig declares no page for this renderer", and a scene
 * that simply needed longer must not be recorded as if the renderer were
 * missing.
 *
 * @param {object} readiness A {@link waitForCellReadiness} result.
 * @returns {object} An accepted or refusing decision.
 */
export function decideCellReadinessRefusal(readiness) {
  if (readiness?.ready === true) {
    return acceptedDecision();
  }
  const runtime = decideRenderReadyRefusal({
    renderReady: readiness?.observed?.renderReady,
    elapsedMs: readiness?.elapsedMs,
    timeoutMs: readiness?.timeoutMs,
  });
  return refusedDecision("capture-cell-not-ready", {
    runtimeReason: runtime.refuse === true ? runtime.reason : "predicate-unmet",
    unmet: [...(readiness?.unmet ?? [])],
    observed: readiness?.observed ?? null,
    polls: readiness?.polls ?? 0,
    phase: readiness?.phase ?? "unknown",
    elapsedMs: readiness?.elapsedMs ?? 0,
    timeoutMs: readiness?.timeoutMs ?? 0,
  });
}

function readCellReadiness(page, cell) {
  return page.evaluate((renderer) => {
    const viewer =
      window.viewer ??
      (renderer === "webgl" ? window.webglViewer : window.webgpuViewer);
    const scene = viewer?.scene;
    return {
      viewerPresent: !!scene,
      renderReady: scene?.renderReady,
      // `null` = this page has no globe to wait for, which satisfies the
      // predicate; `undefined` = the page did not answer, which does not.
      tilesLoaded: scene?.globe ? scene.globe.tilesLoaded === true : null,
    };
  }, cell.renderer);
}

/**
 * Wait for a cell to be capturable: poll the readiness predicates, then apply
 * the rig's settle, then re-read them once more.
 *
 * The final re-read is not redundant. The settle exists because a scene that
 * has just become ready is still converging, and a scene that STOPS being
 * ready during it (a new tile request, a pipeline rebuild) would otherwise be
 * captured mid-flight with the poll's stale `true` as the evidence.
 *
 * @param {object} page The page.
 * @param {object} cell The descriptor cell.
 * @param {() => number} [now] Clock.
 * @param {{sleep?: Function, sample?: Function}} [dependencies] Seams; the
 *   defaults read the real page.
 * @returns {Promise<object>} `{ready, renderReady, observed, unmet, polls,
 *   elapsedMs, timeoutMs, phase}`.
 */
export async function waitForCellReadiness(
  page,
  cell,
  now = Date.now,
  dependencies = {},
) {
  const started = now();
  const timeoutMs = cell.readinessTimeoutMs;
  const predicates = cell.readinessPredicates ?? READINESS_PREDICATES;
  const sleep = dependencies.sleep ?? ((ms) => page.waitForTimeout(ms));
  const sample = dependencies.sample ?? (() => readCellReadiness(page, cell));

  if (cell.pageKind === "split-screen") {
    // The split-screen page gates viewer creation behind a button so a human
    // chooses when two WebGPU adapters come up; automation clicks it, exactly
    // as `capture-and-diff.mjs:823-824` does.
    await page.waitForSelector("#btnLaunch", { timeout: timeoutMs });
    await page.click("#btnLaunch");
    await page.waitForFunction(
      () => !!(window.webglViewer && window.webgpuViewer),
      null,
      { timeout: timeoutMs },
    );
    await page.evaluate((renderer) => {
      const viewer =
        renderer === "webgl" ? window.webglViewer : window.webgpuViewer;
      const canvas = viewer?.scene?.canvas;
      if (!canvas) {
        throw new Error(`split-screen ${renderer} viewer exposes no canvas`);
      }
      canvas.setAttribute("data-vr-tag", renderer);
    }, cell.renderer);
  } else {
    await page.waitForFunction(() => !!window.viewer?.scene, null, {
      timeout: timeoutMs,
    });
  }

  const polled = await pollReadiness({
    sample,
    now,
    sleep,
    timeoutMs,
    pollIntervalMs:
      cell.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS,
    predicates,
  });
  if (!polled.ready) {
    return {
      ...polled,
      renderReady: polled.observed?.renderReady,
      elapsedMs: now() - started,
      phase: "poll",
    };
  }

  await settleCell(page, cell);

  const observed = await sample();
  const unmet = predicates.filter(
    (name) => !readinessSatisfied(readAt(observed, name)),
  );
  return {
    ready: unmet.length === 0,
    renderReady: observed?.renderReady,
    observed,
    unmet,
    // What the poll was still waiting for on its last unsatisfied sample. On
    // the SUCCESS path this is the only record of why readiness took as long
    // as it did, and it is what `summariseCellReadiness` banks.
    lastUnmet: unmet.length === 0 ? polled.lastUnmet : unmet,
    polls: polled.polls + 1,
    elapsedMs: now() - started,
    timeoutMs,
    phase: unmet.length === 0 ? "settled" : "settle",
  };
}

/**
 * The readiness facts a SUCCESSFUL cell banks in the capture receipt.
 *
 * WHY THE SUCCESS PATH NEEDS THIS AT ALL. Until now `polls`, the elapsed time
 * and the last unmet predicate reached a caller only through
 * {@link decideCellReadinessRefusal} — i.e. only when the cell FAILED. A green
 * capture recorded none of it, so the Edge leg of 2026-09-19, asked how long
 * readiness took and on what, had to wrap `dependencies.now` in a recorder and
 * segment its call trace at each cell's `capturedAt`. An executor should be
 * able to quote the number, not infer it. It is banked in the RECEIPT and not
 * in the manifest deliberately: the manifest is the contact sheet's input and
 * its bytes are the sheet's identity, and a timing that differs run to run has
 * no business moving a page's md5.
 *
 * @param {object|null|undefined} readiness A {@link waitForCellReadiness} result.
 * @returns {{polls: number, elapsedMsAfterFinalPoll: number, budgetMs: number,
 *   phase: string, lastUnmet: string}|null} The summary, or `null` when the
 *   cell body reported no readiness at all (an injected `cellWork`).
 */
export function summariseCellReadiness(readiness) {
  if (readiness === null || typeof readiness !== "object") {
    return null;
  }
  const lastUnmet = [...(readiness.lastUnmet ?? readiness.unmet ?? [])];
  return {
    polls: readiness.polls ?? 0,
    // NOT `elapsedMs`. The budget is tested after a sample returns, so this
    // number may exceed `budgetMs` by up to one poll — see `pollReadiness`.
    // The field is named for the instant it is read at so nobody reads an
    // overshoot as a bug.
    elapsedMsAfterFinalPoll: readiness.elapsedMs ?? 0,
    budgetMs: readiness.timeoutMs ?? 0,
    phase: readiness.phase ?? "unknown",
    lastUnmet: lastUnmet.length > 0 ? lastUnmet.join(", ") : "none",
  };
}

async function settleCell(page, cell) {
  if (cell.readiness?.kind === "settleMs") {
    await page.waitForTimeout(cell.readiness.ms);
    return;
  }
  await page.evaluate(
    (frames) =>
      new Promise((resolve) => {
        let count = 0;
        const tick = () => {
          if (count++ >= frames) {
            resolve();
          } else {
            requestAnimationFrame(tick);
          }
        };
        tick();
      }),
    cell.readiness?.frames ?? 1,
  );
}

/**
 * The durable record a capture writes when the lifecycle's hard stop is about
 * to end the process.
 *
 * A WATCHDOG THAT KILLS THE PROCESS OWES A DIAGNOSIS. The lifecycle's own
 * hard-stop line says only that quiescence was not reached — the Edge leg of
 * 2026-09-18 hit it and the run exited 2 with nothing else printed, so the
 * cell failure that caused the wedge was unrecoverable from the transcript.
 * This is the capture's half of that message: which phase it was in, which
 * cell, for how long, and what it still had open. It is built through the
 * runtime's own {@link buildIncidentRecord} so a capture incident reads like
 * every other incident this fleet writes.
 *
 * @param {object} options Options.
 * @param {object} options.descriptor The run descriptor.
 * @param {object} options.progress `{phase, cell, startedAt, open, completed}`.
 * @param {number} options.at The clock reading, in milliseconds.
 * @param {string} options.reason What the lifecycle said.
 * @returns {object} The incident record.
 */
export function buildCaptureIncident({ descriptor, progress, at, reason }) {
  return buildIncidentRecord({
    outcome: RUN_OUTCOMES.ERRORED,
    runtimeReceipt: {
      kind: "capture-incident",
      probe: descriptor.slotOwner,
      captureId: descriptor.captureId,
      captureRoot: descriptor.captureRoot,
      origins: { ...descriptor.origins },
      servedBuildAssertion: descriptor.servedBuild ? "enforced" : "waived",
      phase: progress.phase,
      cell: progress.cell,
      elapsedMs: at - progress.startedAt,
      openResources: [...progress.open],
      cellsCompleted: [...progress.completed],
      deadlineMs: descriptor.deadlineMs,
      closeDeadlineMs: descriptor.closeDeadlineMs,
      hardStopGraceMs: descriptor.hardStopGraceMs,
    },
    error: reason,
  });
}

/**
 * Capture a rig (or a rig set) over BEFORE and AFTER origins, on every
 * renderer the rig declares, in ONE browser run.
 *
 * The order is fixed and is the point of the module: resolve the origins,
 * plan every cell, preflight both served builds, take the single Edge slot,
 * and only then open a browser — every refusal that can be decided without a
 * GPU is decided before one is claimed. The slot and the browser are both
 * taken THROUGH the lifecycle scope, so the browser is closed whatever the
 * cell work does AND whatever the watchdog does, and every measurement is
 * computed in Node after that close.
 *
 * @param {object|object[]} rig The rig, or the rig set.
 * @param {{BEFORE: string, AFTER: string}} origins Required; never defaulted.
 * @param {object} [options] See {@link buildCaptureDescriptor}.
 * @param {object} [dependencies] Injection seams.
 * @param {object} [dependencies.chromium] Playwright's chromium namespace.
 * @param {Function} [dependencies.launch] Edge launcher.
 * @param {Function} [dependencies.preflight] Served-build preflight.
 * @param {Function} [dependencies.acquireSlot] Edge-slot holder, supplied to the lifecycle as its slot dependency.
 * @param {Function} [dependencies.lifecycle] Bounded lifecycle; a replacement must honour the same scope contract.
 * @param {object} [dependencies.lifecycleDependencies] The lifecycle's own timer/exit/diagnostic seams.
 * @param {Function} [dependencies.decodePng] PNG decoder.
 * @param {Function} [dependencies.encodePng] RGBA encoder for the heat-maps.
 * @param {Function} [dependencies.writeFile] `(file, body) => void`.
 * @param {Function} [dependencies.mkdir] `(directory) => void`.
 * @param {Function} [dependencies.now] Clock.
 * @returns {Promise<{descriptor: object, manifest: object, receipt: object,
 *   manifestPath: string, receiptPath: string, writtenPaths: string[]}>} The run.
 */
export async function capture(rig, origins, options = {}, dependencies = {}) {
  const {
    chromium,
    launch = launchEdge,
    preflight: preflightImpl = preflightServedBuildArtifacts,
    acquireSlot = withEdgeSlot,
    lifecycle = withProbeLifecycle,
    lifecycleDependencies,
    decodePng: decodePngImpl = decodePng,
    encodePng = encodeRgbaPng,
    writeFile = (file, body) => fs.writeFileSync(file, body),
    mkdir = (directory) => fs.mkdirSync(directory, { recursive: true }),
    now = Date.now,
  } = dependencies;

  const descriptor = buildCaptureDescriptor(rig, origins, options);
  const servedBuildAssertion = descriptor.servedBuild ? "enforced" : "waived";

  const preflightBySlot = {};
  if (descriptor.servedBuild) {
    for (const slot of descriptor.slots) {
      preflightBySlot[slot] = await preflightImpl({
        origin: descriptor.origins[slot],
        repositoryRoot: descriptor.repositoryRoot,
        artifacts: [...descriptor.requiredArtifacts],
      });
    }
  }
  throwForDecision(
    decideCaptureRefusal({
      rig,
      origins,
      preflight: preflightBySlot,
      servedBuild: descriptor.servedBuild,
      requiredArtifacts: descriptor.requiredArtifacts,
    }),
    "the served bytes are not the bytes on disk; rebuild, or restart the server with --serve-built",
  );

  const measurable = descriptor.cells.filter(
    (cell) => cell.state === CELL_STATES.MEASURED,
  );
  const produced = new Map();
  let edgeSlot = null;
  let browsersLaunched = 0;

  // What the watchdog would otherwise be unable to say. Updated in place as
  // the run moves, and read only when the hard stop is about to fire.
  const progress = {
    phase: measurable.length > 0 ? "planned" : "no measurable cell",
    cell: null,
    startedAt: now(),
    open: new Set(),
    completed: [],
  };

  if (measurable.length > 0) {
    // THE SLOT AND THE BROWSER ARE THE LIFECYCLE'S, NOT THIS FUNCTION'S.
    // An earlier shape opened the browser by hand inside the lifecycle body
    // and closed it in a `finally`. That closes on the ordinary path and on
    // the throw path, and on NEITHER of the two paths the lifecycle exists
    // for: nothing was registered, so the "prove every resource closed" check
    // had an empty list to prove, the orderly deadline's abort reached no
    // aborter, and `hardExit()` could end the process with Edge still
    // running. Taking both through the scope fixes all three at once, and
    // `withResource` additionally AGGREGATES a failing close with the cell
    // failure instead of letting "Target closed" replace the real diagnosis.
    progress.phase = "acquiring the Edge slot";
    const lifecycleBody = async (lifecycleScope) =>
      lifecycleScope.withEdgeSlot(async (slotScope, held) => {
        edgeSlot = {
          owner: held?.owner ?? descriptor.slotOwner,
          pid: held?.pid ?? null,
          acquiredAt: held?.acquiredAt ?? null,
          reclaimed: held?.reclaimed ?? null,
        };
        progress.open.add("edge slot");
        progress.phase = "launching the browser";
        await slotScope.withResource(
          {
            kind: "browser",
            // ONE browser for the whole run: the BEFORE and AFTER legs of a
            // pair are only comparable if nothing between them changed, and a
            // second browser changes the shader cache, the GPU process and
            // the adapter.
            label: `${descriptor.slotOwner} browser`,
            acquire: async () => {
              const browser = await launch({
                headed: descriptor.headed,
                launchArgs: descriptor.launchArgs ?? undefined,
                chromium,
              });
              browsersLaunched++;
              progress.open.add("browser");
              return browser;
            },
            close: async (browser) => {
              progress.phase = "closing the browser";
              await browser.close();
              progress.open.delete("browser");
            },
            isClosed: (browser) => !browser.isConnected(),
          },
          async (browser) => {
            for (const cell of measurable) {
              // Between cells, never inside one: a run that has begun
              // draining stops planning more work here rather than opening
              // another page against a slot it may no longer hold.
              slotScope.checkpoint();
              progress.phase = "capturing";
              progress.cell = cell.key;
              produced.set(
                cell.key,
                await descriptor.cellWork(cell, {
                  browser,
                  descriptor,
                  options,
                  now,
                  scope: slotScope,
                }),
              );
              progress.completed.push(cell.key);
              progress.cell = null;
            }
            progress.phase = "every cell captured";
          },
        );
        progress.open.delete("edge slot");
      });

    // The lifecycle takes the slot itself, so the caller's `acquireSlot` seam
    // reaches it as its own slot dependency. The wrapper exists only to carry
    // the injected clock, which the lifecycle's call shape does not forward.
    const slotDependency = (slotOptions, slotBody) =>
      acquireSlot({ ...slotOptions, now: now() }, slotBody);

    // THE HARD STOP DOES NOT GET TO LEAVE WITHOUT SAYING WHAT IT WAS WAITING
    // FOR. The lifecycle writes exactly one diagnostic, on exactly one path:
    // immediately before `exit()` in `hardExit()` (`probe-lifecycle.mjs:224`).
    // So a wrapper here is precisely "the watchdog is about to kill us", and
    // it writes the capture's own state FIRST — to the same sink, and as a
    // durable `capture-incident.json` — before letting the lifecycle's line
    // through unchanged. Every write is guarded: a diagnostic that throws must
    // not become the reason the process dies, and `exit()` follows
    // synchronously, which is why the incident is written with the SYNCHRONOUS
    // writer this module already takes.
    // The one way to lose it: a caller that replaces `dependencies.lifecycle`
    // AND supplies its own `writeDiagnostic` after spreading ours discards this
    // wrapper along with it. That is the same trade as replacing the lifecycle
    // itself — a replacement owns the diagnostics too — and it is why the
    // documented seam is `lifecycleDependencies`, which this wraps rather than
    // replaces.
    const baseWriteDiagnostic =
      lifecycleDependencies?.writeDiagnostic ??
      ((text) => process.stderr.write(text));
    const writeDiagnostic = (text) => {
      const incident = buildCaptureIncident({
        descriptor,
        progress,
        at: now(),
        reason: String(text).trim(),
      });
      try {
        baseWriteDiagnostic(
          `${descriptor.slotOwner} incident: phase "${incident.phase}", cell ${incident.cell ?? "none"}, ${incident.elapsedMs} ms elapsed, still open [${incident.openResources.join(", ") || "nothing"}], ${incident.cellsCompleted.length} cell(s) captured\n`,
        );
      } catch {
        // A broken sink is not worth failing the exit over.
      }
      try {
        mkdir(descriptor.outputDirectory);
        writeFile(
          path.join(descriptor.outputDirectory, descriptor.incidentName),
          `${JSON.stringify(incident, null, 2)}\n`,
        );
      } catch {
        // Likewise for a read-only or absent output directory.
      }
      return baseWriteDiagnostic(text);
    };

    await lifecycle(
      {
        probe: descriptor.slotOwner,
        deadlineMs: descriptor.deadlineMs,
        closeDeadlineMs: descriptor.closeDeadlineMs,
        hardStopGraceMs: descriptor.hardStopGraceMs,
        edgeSlotLockPath: descriptor.edgeSlotLockPath,
      },
      lifecycleBody,
      { ...lifecycleDependencies, edgeSlot: slotDependency, writeDiagnostic },
    );
  }

  return finishCapture({
    descriptor,
    produced,
    servedBuildAssertion,
    preflight: descriptor.servedBuild ? preflightBySlot : null,
    edgeSlot,
    browsersLaunched,
    decodePngImpl,
    encodePng,
    writeFile,
    mkdir,
    now,
  });
}

function finishCapture({
  descriptor,
  produced,
  servedBuildAssertion,
  preflight,
  edgeSlot,
  browsersLaunched,
  decodePngImpl,
  encodePng,
  writeFile,
  mkdir,
  now,
}) {
  const writtenPaths = [];
  const decoded = new Map();
  const cellRecords = new Map();
  const captures = [];

  for (const cell of descriptor.cells) {
    if (cell.state === CELL_STATES.UNMEASURED) {
      cellRecords.set(cell.key, unmeasuredCell(cell.reason, cell.trackedBy));
      continue;
    }
    const result = produced.get(cell.key);
    if (result === undefined) {
      cellRecords.set(
        cell.key,
        unmeasuredCell("the cell produced no capture", cell.trackedBy),
      );
      continue;
    }
    const buffer = Buffer.from(result.buffer);
    const image = decodePngImpl(buffer);
    decoded.set(cell.key, image);
    // `capture()` is the single writer for every artifact in the tree, so an
    // injected cell body produces the same on-disk layout as the default one.
    mkdir(cell.outputDirectory);
    writeFile(cell.outputPath, buffer);
    writtenPaths.push(cell.outputPath);
    const record = {
      state: CELL_STATES.MEASURED,
      image: cell.image,
      width: image.width,
      height: image.height,
      byteLength: buffer.byteLength,
      sha256: result.sha256 ?? sha256(buffer),
      url: result.url ?? cell.url,
      capturedAt: result.capturedAt ?? new Date(now()).toISOString(),
      metrics: cellMetrics(image, image),
    };
    cellRecords.set(cell.key, record);
    captures.push({
      name: cell.key,
      path: cell.image,
      byteLength: record.byteLength,
      sha256: record.sha256,
      matchCount: result.matchCount ?? null,
      // The SUCCESS path's readiness record — `null` when the cell body was
      // injected and reported none. Receipt only: the manifest is unchanged.
      readiness: summariseCellReadiness(result.readiness),
    });
  }

  const pairRecords = new Map();
  for (const pair of descriptor.pairs) {
    const before = cellRecords.get(`${pair.key}|BEFORE`);
    const after = cellRecords.get(`${pair.key}|AFTER`);
    if (before?.state !== CELL_STATES.MEASURED) {
      pairRecords.set(pair.key, unmeasuredPair("BEFORE is UNMEASURED"));
      continue;
    }
    if (after?.state !== CELL_STATES.MEASURED) {
      pairRecords.set(pair.key, unmeasuredPair("AFTER is UNMEASURED"));
      continue;
    }
    const beforeImage = decoded.get(`${pair.key}|BEFORE`);
    const afterImage = decoded.get(`${pair.key}|AFTER`);
    if (
      beforeImage.width !== afterImage.width ||
      beforeImage.height !== afterImage.height
    ) {
      pairRecords.set(
        pair.key,
        unmeasuredPair(
          `BEFORE is ${beforeImage.width}x${beforeImage.height} and AFTER is ${afterImage.width}x${afterImage.height} — a pair of two sizes cannot be diffed`,
        ),
      );
      continue;
    }
    const metrics = pairMetrics(beforeImage, afterImage, {
      tolerance: pair.tolerance,
    });
    mkdir(path.dirname(pair.diffPath));
    writeFile(
      pair.diffPath,
      Buffer.from(
        encodePng(metrics.diffRgba, beforeImage.width, beforeImage.height),
      ),
    );
    writtenPaths.push(pair.diffPath);
    pairRecords.set(pair.key, {
      state: CELL_STATES.MEASURED,
      diffImage: pair.diffImage,
      mismatchPct: metrics.mismatchPct,
      changedPx: metrics.changedPx,
      bbox: metrics.bbox,
      tolerance: metrics.tolerance,
      metrics: { mssim: metrics.mssim, windows: metrics.windows },
    });
  }

  const generatedAt = new Date(now()).toISOString();
  const manifest = buildCaptureManifest({
    descriptor,
    cells: cellRecords,
    pairs: pairRecords,
    receiptPath: descriptor.receiptPath,
    generatedAt,
    servedBuildAssertion,
  });
  const violations = validateManifest(manifest);
  if (violations.length > 0) {
    throw new ProbeRefusal(
      "capture-manifest-invalid",
      `the capture manifest this run assembled does not validate: ${violations.join("; ")}`,
      { violations },
    );
  }

  const measured = [...cellRecords.values()].filter(
    (record) => record.state === CELL_STATES.MEASURED,
  ).length;
  const receipt = assembleReceipt({
    envelope: "runtime",
    runtime: {
      capture: descriptor.captureId,
      generatedAt,
      origins: { ...descriptor.origins },
      servedBuildAssertion,
      preflight,
      edgeSlot,
      launchArgs: descriptor.launchArgs,
      deadlineMs: descriptor.deadlineMs,
      browsersLaunched,
      captures,
    },
    fields: {
      manifest: descriptor.manifestName,
      captureRoot: descriptor.captureRoot,
      rigs: descriptor.rigs.map((summary) => summary.id),
      renderers: [...descriptor.renderers],
      slots: [...descriptor.slots],
      cells: {
        measured,
        unmeasured: cellRecords.size - measured,
      },
    },
  });

  mkdir(descriptor.outputDirectory);
  const manifestPath = path.join(
    descriptor.outputDirectory,
    descriptor.manifestName,
  );
  const receiptPath = path.join(
    descriptor.outputDirectory,
    ...descriptor.receiptPath.split("/"),
  );
  writeFile(manifestPath, normalizeJson(manifest));
  writeFile(receiptPath, normalizeJson(receipt));
  writtenPaths.push(manifestPath, receiptPath);

  return {
    descriptor,
    manifest,
    receipt,
    manifestPath,
    receiptPath,
    writtenPaths,
  };
}
