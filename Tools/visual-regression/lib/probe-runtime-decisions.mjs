// probe-runtime-decisions.mjs — the runtime's refusal decisions over the served build and the navigated origin.
//
// @purpose Companion of probe-runtime.mjs: decideServedBuildRefusal, decideOriginRefusal and decideRenderReadyRefusal, and decidePortRefusal with throwIfProbeBaseRefused and PORT_8080_REFUSAL_MESSAGE (the port-8080 decision), the pure decisions that map a preflight result, a navigated url, a renderReady wait, a port and a PROBE_BASE onto the runtime's accepted/refused decision shape.
// @status ACTIVE
//
// WHY A PIECE. These decisions need no browser, so they moved out of
// `probe-runtime.mjs` when that module passed 1,000 lines
// (DX-KIT-DECOMPOSE-RUNTIME-WATER); the port-8080 decision joined them later.
// The runtime re-exports every one, so no importer changed.
// `throwIfProbeBaseRefused` is the one that throws instead of returning a
// decision: it is how a probe that does not run on `runProbe` raises it.

import {
  acceptedDecision,
  refusedDecision,
  throwForDecision,
} from "./probe-refusal.mjs";
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

/**
 * The words a port-8080 refusal is raised with, wherever it is raised: by
 * `parseProbeArgs` for a runtime probe, and by a probe with its own origin
 * protocol (the c11 13/90 `PROBE_BASE` harnesses) at its run entry.
 */
export const PORT_8080_REFUSAL_MESSAGE =
  "the probe runtime refuses port 8080; serve the built tree on a governed port (node server.js --port 8094 --serve-built)";

/**
 * Decide whether a probe may be pointed at `port`.
 *
 * The built Sandcastle2 app bakes `http://localhost:8080` into its own
 * top-level redirect (`Q-145`), and the default dev server on 8080 serves a
 * live esbuild of the SOURCE tree rather than the built one. A probe on 8080
 * therefore cannot distinguish "I measured the build" from "I measured the
 * maintainer's running session", so no probe is let try. Exported so a probe
 * that resolves its origin some other way refuses with the same id.
 *
 * @param {number} port The port the probe would reach.
 * @returns {object} An accepted or refusing decision.
 */
export function decidePortRefusal(port) {
  if (port === 8080) {
    return refusedDecision("port-8080-forbidden", { port });
  }
  return acceptedDecision();
}

/**
 * Refuse, before any browser, a `PROBE_BASE` origin a probe with its own
 * origin protocol (the c11 13/90 harnesses, which do not run on `runProbe`)
 * must not be pointed at: an unset or empty one (`probe-base-unset` — there
 * is no default origin to fall back to, because the old default was the
 * forbidden 8080) or one on port 8080 (`port-8080-forbidden`, the runtime's
 * own id and message). A value that is not a URL at all is left to the
 * caller's own origin normaliser, which already reports it.
 *
 * @param {unknown} value The raw `PROBE_BASE`.
 * @returns {object} The accepted decision, when nothing was refused.
 */
export function throwIfProbeBaseRefused(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    const decision = refusedDecision("probe-base-unset", { env: "PROBE_BASE" });
    throwForDecision(
      decision,
      "PROBE_BASE is not set; point it at the built tree on a governed port (PROBE_BASE=http://localhost:8094), never 8080",
    );
  }
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return acceptedDecision();
  }
  const port =
    url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const decision = decidePortRefusal(port);
  throwForDecision(
    decision.refuse
      ? { ...decision, details: { ...decision.details, probeBase: url.origin } }
      : decision,
    PORT_8080_REFUSAL_MESSAGE,
  );
  return decision;
}
