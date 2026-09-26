/**
 * Host-capability lane for individual specs.
 *
 * Some specs assert a contract that only a host with a particular capability
 * can serve: one that creates a real WebGL context (not the `--webgl-stub`
 * stand-in), or one that drives `WebGPUContext.create` far enough to reach its
 * late-initialization rollback, which requires `navigator.gpu`. On a host
 * without the capability those specs fail for a reason that has nothing to do
 * with their contract, and the failure hides the contract's real state.
 *
 * `Specs/webgpuPolicy.js` already solves the Scene-level WebGPU case at suite
 * granularity. This module is its spec-level sibling for capabilities that a
 * unit spec needs from the host, and it keeps the same three rules:
 *
 *   1. PROBE ONCE, RECORD THE REASON. Each capability is probed at most once per
 *      page and the verdict is cached with a reason that says what was
 *      attempted and what came back. A probe that throws is reported as missing
 *      WITH the thrown message; "we could not tell" is never silent.
 *
 *   2. A SKIP MUST BE VISIBLE. `specReporter.suppressSkipped` is true for both
 *      the gulp test and coverage tasks and console capture is off in CI, so a
 *      `pending()` spec produces no output at all. The lane therefore emits one
 *      summary line naming every skipped spec and its reason, through the
 *      `report` sink the caller supplies. `Specs/customizeJasmine.js` wires that
 *      sink to `window.__karma__.info`, the one channel that reaches both CI
 *      logs; the default `console.info` sink is invisible there.
 *
 *   3. A DEMANDED CAPABILITY FAILS LOUDLY. A host that should have the
 *      capability can demand it, and a demanded capability that is missing
 *      fails the spec with the probe's reason instead of skipping it.
 *
 * The probe runs when the spec starts, not when it is declared, so a run that
 * filters the spec out never pays for a context it would not use.
 */

import { isWebGPUAvailable } from "./webgpuPolicy.js";

/** Capabilities a spec may require of the host. */
export const Capability = Object.freeze({
  /** A real WebGL context, created the way `Context` creates one. */
  REAL_WEBGL: "real-webgl",
  /** A WebGPU implementation exposed as `navigator.gpu`. */
  WEBGPU_API: "webgpu-api",
});

const CAPABILITY_REQUIREMENTS = Object.freeze({
  [Capability.REAL_WEBGL]: "requires a real WebGL context",
  [Capability.WEBGPU_API]: "requires a WebGPU implementation",
});

/** Global holding the cached probe verdicts, keyed by capability. */
export const CAPABILITY_PROBES_KEY = "__cesiumCapabilityProbes";

/** Global holding the list of demanded capabilities. */
export const CAPABILITIES_DEMANDED_KEY = "__cesiumCapabilitiesDemanded";

/** Global holding the declared capability specs and their outcomes. */
export const CAPABILITY_LEDGER_KEY = "__cesiumCapabilityLedger";

/** Global holding the canonical end-of-run report for machine inspection. */
export const CAPABILITY_LANE_SUMMARY_KEY = "__cesiumCapabilityLaneSummary";

/** Prefix kept stable so CI logs can extract the report without heuristics. */
export const CAPABILITY_LANE_SUMMARY_PREFIX = "[capability lane] summary ";

/** Karma client argument that demands every capability. */
export const REQUIRE_CAPABILITIES_ARGUMENT = "--require-capabilities";

/** Locale-independent code-unit order for byte-stable CI reports. */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertKnownCapability(capability) {
  if (!Object.hasOwn(CAPABILITY_REQUIREMENTS, capability)) {
    throw new Error(`[capability lane] unknown capability "${capability}".`);
  }
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function verdict(capability, available, detail) {
  return {
    capability,
    available,
    reason: available
      ? null
      : `${CAPABILITY_REQUIREMENTS[capability]}: ${detail}`,
  };
}

function freshLedger() {
  return { specs: new Map(), skips: new Map() };
}

function ledgerOf(target) {
  return (target[CAPABILITY_LEDGER_KEY] =
    target[CAPABILITY_LEDGER_KEY] ?? freshLedger());
}

/**
 * Attempts one real WebGL context the way `Context` asks for one: WebGL 2
 * whenever the browser defines `WebGL2RenderingContext`, with the attributes
 * `Context` overrides by default. The context is released immediately so the
 * probe does not hold one of the browser's limited context slots.
 */
function probeRealWebGL(target) {
  const capability = Capability.REAL_WEBGL;
  if (typeof target.WebGLRenderingContext === "undefined") {
    return verdict(
      capability,
      false,
      "the browser defines no WebGLRenderingContext",
    );
  }
  if (typeof target.document?.createElement !== "function") {
    return verdict(capability, false, "there is no document to hold a canvas");
  }

  const contextType =
    typeof target.WebGL2RenderingContext !== "undefined" ? "webgl2" : "webgl";
  let gl;
  try {
    const canvas = target.document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    gl = canvas.getContext(contextType, {
      alpha: false,
      stencil: true,
      powerPreference: "high-performance",
    });
  } catch (error) {
    return verdict(
      capability,
      false,
      `canvas.getContext("${contextType}") threw: ${describeError(error)}`,
    );
  }

  if (gl === null || gl === undefined) {
    return verdict(
      capability,
      false,
      `canvas.getContext("${contextType}") returned ${gl}`,
    );
  }

  try {
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    // The context was created, which is all the probe asks. Releasing it early
    // is a courtesy to the browser's context budget, not part of the verdict.
  }
  return verdict(capability, true);
}

function probeWebGPUApi(target) {
  return isWebGPUAvailable(target)
    ? verdict(Capability.WEBGPU_API, true)
    : verdict(Capability.WEBGPU_API, false, "navigator.gpu is absent");
}

/**
 * Probes a capability once per page and returns the cached verdict.
 *
 * @param {string} capability One of {@link Capability}.
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {{capability: string, available: boolean, reason: string|null}}
 */
export function probeCapability(capability, scope) {
  assertKnownCapability(capability);
  const target = scope ?? globalThis;
  const probes = (target[CAPABILITY_PROBES_KEY] =
    target[CAPABILITY_PROBES_KEY] ?? {});
  if (!Object.hasOwn(probes, capability)) {
    try {
      probes[capability] =
        capability === Capability.REAL_WEBGL
          ? probeRealWebGL(target)
          : probeWebGPUApi(target);
    } catch (error) {
      probes[capability] = verdict(
        capability,
        false,
        `the probe threw: ${describeError(error)}`,
      );
    }
  }
  return probes[capability];
}

/**
 * Lists the capabilities a karma client argument list demands.
 *
 * @param {Array} [args] `window.__karma__.config.args`.
 * @param {object} [options]
 * @param {boolean} [options.webgpuDemanded=false] Whether the Scene-level
 *   WebGPU lane is demanded; a run that demands WebGPU Scenes cannot accept a
 *   host without `navigator.gpu`.
 * @returns {string[]} Demanded capabilities.
 */
export function demandedCapabilities(args, options) {
  if (Array.isArray(args) && args.includes(REQUIRE_CAPABILITIES_ARGUMENT)) {
    return Object.values(Capability);
  }
  return options?.webgpuDemanded === true ? [Capability.WEBGPU_API] : [];
}

/**
 * Publishes the lane configuration and resets its per-run bookkeeping,
 * including cached probe verdicts.
 *
 * @param {object} [options]
 * @param {string[]} [options.demanded=[]] Capabilities that must be present.
 * @param {object} [scope] The global object; defaults to `globalThis`.
 */
export function setCapabilityLane(options, scope) {
  const target = scope ?? globalThis;
  const demanded = [...(options?.demanded ?? [])];
  demanded.forEach(assertKnownCapability);
  target[CAPABILITIES_DEMANDED_KEY] = demanded;
  target[CAPABILITY_PROBES_KEY] = {};
  target[CAPABILITY_LEDGER_KEY] = freshLedger();
  target[CAPABILITY_LANE_SUMMARY_KEY] = undefined;
}

/**
 * @param {string} capability One of {@link Capability}.
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {boolean} Whether the run demands the capability.
 */
export function isCapabilityDemanded(capability, scope) {
  const demanded = (scope ?? globalThis)[CAPABILITIES_DEMANDED_KEY];
  return Array.isArray(demanded) && demanded.includes(capability);
}

/**
 * Declares a spec that needs a host capability.
 *
 * Where the capability is present the body runs unchanged. Where it is missing
 * the spec is marked pending with the probe's reason and recorded for the
 * end-of-run summary, unless the run demands the capability, in which case the
 * spec fails with that reason.
 *
 * @param {string} capability One of {@link Capability}.
 * @param {string} description The spec description, exactly as `it` takes it.
 * @param {Function} body The spec body; may be async or take `done`.
 * @param {number} [timeout] Passed through to `it`.
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {object} What `it` returns.
 */
export function itRequiresCapability(
  capability,
  description,
  body,
  timeout,
  scope,
) {
  assertKnownCapability(capability);
  const target = scope ?? globalThis;

  // Runs when the spec starts, after `it` below has returned the spec's id.
  function gate() {
    const result = probeCapability(capability, target);
    if (result.available) {
      return;
    }
    if (isCapabilityDemanded(capability, target)) {
      throw new Error(
        `[capability lane] "${capability}" was demanded but is missing: ${result.reason}.`,
      );
    }
    ledgerOf(target).skips.set(spec?.id, { capability, reason: result.reason });
    target.pending(result.reason);
  }

  // Jasmine reads a spec's arity to decide whether it takes `done`, so the
  // gate must keep the body's.
  const gated =
    body.length > 0
      ? function (done) {
          gate();
          return body.call(this, done);
        }
      : function () {
          gate();
          return body.call(this);
        };

  const spec = target.it(description, gated, timeout);
  ledgerOf(target).specs.set(spec?.id, { capability, status: "declared" });
  return spec;
}

/**
 * Installs the reporter that records what each capability spec did.
 *
 * Counting at `specDone` distinguishes a spec that ran from one that was
 * skipped for a missing capability, and from one a spec filter excluded.
 *
 * @param {{addReporter: (reporter: object) => void}} env Jasmine environment.
 * @param {object} [scope] The global object; defaults to `globalThis`.
 */
export function installCapabilityLaneSpecLedger(env, scope) {
  const target = scope ?? globalThis;
  if (typeof env?.addReporter !== "function") {
    throw new Error("[capability lane] Jasmine reporter is unavailable.");
  }

  env.addReporter({
    specDone(result) {
      const record = ledgerOf(target).specs.get(result?.id);
      if (record === undefined) {
        return;
      }
      record.status = result.status;
      record.fullName =
        typeof result.fullName === "string" ? result.fullName : "";
    },
  });
}

/**
 * Produces a deterministic, serialization-ready end-of-run report.
 *
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {object}
 */
export function createCapabilityLaneRunSummary(scope) {
  const target = scope ?? globalThis;
  const { specs, skips } = ledgerOf(target);
  let executedSpecCount = 0;
  let failedSpecCount = 0;
  const skippedSpecs = [];
  for (const [id, record] of specs) {
    if (record.status === "passed" || record.status === "failed") {
      executedSpecCount += 1;
      if (record.status === "failed") {
        failedSpecCount += 1;
      }
    } else if (record.status === "pending" && skips.has(id)) {
      skippedSpecs.push({
        name: record.fullName ?? "",
        capability: skips.get(id).capability,
        reason: skips.get(id).reason,
      });
    }
  }
  skippedSpecs.sort(
    (left, right) =>
      compareStrings(left.name, right.name) ||
      compareStrings(left.capability, right.capability),
  );

  const probes = target[CAPABILITY_PROBES_KEY] ?? {};
  return {
    demanded: [...(target[CAPABILITIES_DEMANDED_KEY] ?? [])].sort(
      compareStrings,
    ),
    declaredSpecCount: specs.size,
    executedSpecCount,
    failedSpecCount,
    skippedSpecCount: skippedSpecs.length,
    probes: Object.keys(probes)
      .sort(compareStrings)
      .map((capability) => ({
        capability,
        available: probes[capability].available,
        reason: probes[capability].reason,
      })),
    skippedSpecs,
  };
}

/**
 * Formats the canonical report as one machine-readable log line.
 *
 * @param {ReturnType<typeof createCapabilityLaneRunSummary>} summary
 * @returns {string}
 */
export function formatCapabilityLaneRunSummary(summary) {
  return `${CAPABILITY_LANE_SUMMARY_PREFIX}${JSON.stringify(summary)}`;
}

/**
 * Installs the root end-of-run report for the capability lane.
 *
 * The report is emitted whenever a capability spec executed or was skipped,
 * so a run where every guarded spec ran says so, and a run where one was
 * skipped names it and why. A run that filtered them all out stays silent.
 *
 * @param {{afterAll: (callback: () => void) => void}} env Jasmine environment.
 * @param {object} [options]
 * @param {object} [options.scope] The global object; defaults to `globalThis`.
 * @param {(message: string) => void} [options.report] Report sink; defaults to
 *   `console.info`, which CI does not capture, so a caller that needs the line
 *   in a CI log must supply the Karma channel.
 */
export function installCapabilityLaneRunReport(env, options = {}) {
  const target = options.scope ?? globalThis;
  const report =
    options.report ?? ((message) => target.console?.info?.(message));

  env.afterAll(function reportCapabilityLane() {
    const summary = createCapabilityLaneRunSummary(target);
    if (summary.executedSpecCount === 0 && summary.skippedSpecCount === 0) {
      return;
    }
    target[CAPABILITY_LANE_SUMMARY_KEY] = summary;
    report(formatCapabilityLaneRunSummary(summary));
  });
}
