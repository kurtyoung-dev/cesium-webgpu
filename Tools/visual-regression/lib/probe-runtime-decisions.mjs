// probe-runtime-decisions.mjs — the runtime's refusal decisions over the served build and the navigated origin.
//
// @purpose Companion of probe-runtime.mjs: decideServedBuildRefusal, decideOriginRefusal and decideRenderReadyRefusal, the pure decisions that map a preflight result, a navigated url and a renderReady wait onto the runtime's accepted/refused decision shape.
// @status ACTIVE
//
// WHY A PIECE. These three decisions are pure and need no browser, so they
// moved out of `probe-runtime.mjs` when that module passed 1,000 lines
// (DX-KIT-DECOMPOSE-RUNTIME-WATER). The runtime re-exports all three, so no
// importer changed.

import { acceptedDecision, refusedDecision } from "./probe-refusal.mjs";
import { REQUIRED_SERVED_ARTIFACTS } from "./probe-runtime-args.mjs";
import { checkNavigatedOrigin } from "./sandcastle2-origin-rewrite.mjs";

/**
 * Decide whether a served-build preflight clears the run.
 *
 * @param {object|null} preflight Result of `preflightServedBuildArtifacts`, or `null` when waived.
 * @param {object} [options] Options.
 * @param {string[]} [options.requiredArtifacts] Artifacts that must have matched.
 * @param {boolean} [options.waived] Whether `--no-serve-built` waived the assertion.
 * @returns {object} An accepted or refusing decision.
 */
export function decideServedBuildRefusal(preflight, options = {}) {
  const requiredArtifacts =
    options.requiredArtifacts ?? REQUIRED_SERVED_ARTIFACTS;
  if (options.waived === true) {
    return acceptedDecision();
  }
  if (!preflight || preflight.ok !== true) {
    return refusedDecision("served-build-preflight-failed", {
      preflight: preflight ?? null,
    });
  }
  const results = Array.isArray(preflight.artifacts) ? preflight.artifacts : [];
  const byPath = new Map(results.map((result) => [result.path, result]));
  const missingOrUnmatched = requiredArtifacts.filter((artifact) => {
    const result = byPath.get(artifact);
    return !result || result.match !== true;
  });
  if (missingOrUnmatched.length > 0) {
    return refusedDecision("served-build-preflight-incomplete", {
      missingOrUnmatched,
      preflight,
    });
  }
  return acceptedDecision();
}

/**
 * Decide whether a navigation stayed on the origin it was pointed at. The
 * comparison itself is delegated to `sandcastle2-origin-rewrite.mjs` so the
 * origin grammar has one home; this wrapper only maps its verdict onto the
 * runtime's decision shape.
 *
 * @param {object} options Inputs.
 * @param {string} options.requestedOrigin Origin the navigation was asked to reach.
 * @param {string} options.actualUrl The url the page ended on, after redirects.
 * @param {string} [options.label] What is being checked, folded into the reason.
 * @returns {object} An accepted or refusing decision.
 */
export function decideOriginRefusal({
  requestedOrigin,
  actualUrl,
  label = "navigation",
}) {
  let expected;
  try {
    expected = new URL(requestedOrigin).origin;
  } catch {
    return refusedDecision("requested-origin-invalid", { requestedOrigin });
  }
  const verdict = checkNavigatedOrigin({
    observedUrl: actualUrl,
    expectedOrigin: expected,
    label,
  });
  if (verdict.ok === true) {
    return acceptedDecision();
  }
  return refusedDecision(
    verdict.code === "UNPARSABLE_URL"
      ? "navigation-url-invalid"
      : "origin-mismatch",
    {
      requestedOrigin: expected,
      actualOrigin: verdict.observedOrigin,
      actualUrl,
      reason: verdict.reason,
    },
  );
}

/**
 * Decide whether a settle that was supposed to be gated on `Scene.renderReady`
 * may be believed. A capture taken before readiness is not a slow measurement,
 * it is a different measurement, so it refuses rather than scoring.
 *
 * @param {object} options Inputs.
 * @param {unknown} options.renderReady What the page reported for `scene.renderReady`.
 * @param {number} options.elapsedMs How long the wait took.
 * @param {number} options.timeoutMs The budget it had.
 * @returns {object} An accepted or refusing decision.
 */
export function decideRenderReadyRefusal({
  renderReady,
  elapsedMs,
  timeoutMs,
}) {
  if (typeof renderReady !== "boolean") {
    return refusedDecision("render-ready-absent", {
      observed: renderReady === undefined ? "undefined" : typeof renderReady,
    });
  }
  if (renderReady !== true) {
    return refusedDecision("render-ready-timeout", { elapsedMs, timeoutMs });
  }
  return acceptedDecision();
}
