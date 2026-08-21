/**
 * Scene-level WebGPU lane for the spec suites —
 * NEW-SPEC-HARNESS-NO-WEBGPU-SCENE-COVERAGE.
 *
 * The Jasmine harness can already drive a real `GPUDevice`: several specs under
 * `packages/engine/Specs/Renderer/WebGPU/` acquire one, and the Karma
 * `EdgeHeadlessCI` launcher is configured to keep the GPU process alive for
 * exactly that reason (`Specs/karma.conf.cjs`). What was missing is a lane in
 * which a constructed *Scene* runs on that device, so Scene-level WebGPU claims
 * do not have to rest on Playwright probes or on source-text pattern matching.
 *
 * A lane like this is only worth having if it cannot pass while doing nothing.
 * Three measured failure modes would otherwise let it look green while
 * certifying the wrong thing, and each has a countermeasure here:
 *
 *   1. WRONG BACKEND. Requesting the WebGPU renderer without
 *      `strictRenderer: true` resolves a working *WebGL* scene when WebGPU is
 *      unavailable — `getRendererAttemptPlan` appends a WebGL attempt for an
 *      explicit WebGPU request, and `ContextFactory` takes it with only a
 *      `console.warn`. Every assertion in a "WebGPU spec" would then pass
 *      against WebGL. `Specs/createSceneAsync.js` closes this by demanding
 *      strict mode and re-checking `context.rendererType` after construction.
 *
 *   2. WRONG ADAPTER TIER. An absent GPU does not produce an absent adapter.
 *      With `--disable-gpu` — which the stock `ChromeHeadless` launcher always
 *      appends — Chromium still resolves an adapter, reporting
 *      `vendor: "google", architecture: "swiftshader", isFallbackAdapter: true`.
 *      The trap is adapter *tier*, not adapter *presence*, so the lane records
 *      the tier and can be told to demand hardware.
 *
 *   3. INVISIBLE SKIP. `specReporter.suppressSkipped` is true for the gulp test
 *      task, so a `pending()` or `xdescribe`d spec produces no output at all: a
 *      dead lane and a passing lane look identical in the terminal. Two things
 *      answer this — a summary line emitted through Karma on every run that
 *      declares a lane suite, and a root `afterAll` that THROWS when the lane
 *      was demanded and nothing in it executed.
 *
 * Countermeasure 3 is the load-bearing one. A skipped suite that reports its
 * reason is a truthful skip; a skipped suite that reports nothing is
 * indistinguishable from coverage.
 */

/** Reason recorded when the host exposes no WebGPU implementation at all. */
export const WEBGPU_LANE_SKIP_REASON = "requires a WebGPU adapter";

/** Reason recorded when the run is a WebGL-stub lane, where WebGPU cannot apply. */
export const WEBGPU_STUB_LANE_SKIP_REASON = "webgl stub lane";

/** Global on which the "the lane must execute" demand is published. */
export const WEBGPU_LANE_DEMANDED_KEY = "__cesiumWebGPULaneDemanded";

/** Global holding the adapter tier the lane requires. */
export const WEBGPU_LANE_REQUIRED_TIER_KEY = "__cesiumWebGPULaneRequiredTier";

/** Global holding the roster of suites declared through the lane. */
export const DECLARED_SUITES_KEY = "__cesiumDeclaredWebGPUSuites";

/** Global holding the truthful roster of skipped lane suites. */
export const SKIPPED_SUITES_KEY = "__cesiumSkippedWebGPUSuites";

/** Global holding per-spec execution tallies for the lane. */
export const EXECUTION_LEDGER_KEY = "__cesiumWebGPULaneExecution";

/** Global holding the adapter tier a lane spec observed. */
export const OBSERVED_ADAPTER_KEY = "__cesiumWebGPUObservedAdapter";

/** Global holding the canonical end-of-run report for machine inspection. */
export const WEBGPU_LANE_SUMMARY_KEY = "__cesiumWebGPULaneSummary";

/** Prefix kept stable so CI logs can extract the report without heuristics. */
export const WEBGPU_LANE_SUMMARY_PREFIX = "[webgpu lane] summary ";

/**
 * Adapter tiers the lane distinguishes.
 *
 * `UNKNOWN` exists because a masked or empty `GPUAdapterInfo` is a real
 * outcome, and it must not be readable as hardware. It is treated as a failure
 * by a lane that demands hardware, for the same reason `isExternalRequestUrl`
 * in `Specs/networkPolicy.js` reports an unparseable URL as external: "we
 * could not tell" must never become "allowed".
 */
export const AdapterTier = Object.freeze({
  HARDWARE: "hardware",
  SOFTWARE: "software",
  UNKNOWN: "unknown",
});

/** Tier requirements a caller may demand of the lane. */
export const RequiredAdapterTier = Object.freeze({
  HARDWARE: "hardware",
  ANY: "any",
});

/**
 * Substrings that identify a software rasterizer across the platforms this
 * fork is exercised on. `isFallbackAdapter` is authoritative where a browser
 * sets it, but it is not universal — a Mesa `llvmpipe` / `lavapipe` adapter is
 * a genuine software device that is not necessarily flagged as a fallback — so
 * the name check is a second, independent net rather than a redundant one.
 */
const SOFTWARE_ADAPTER_MARKERS = [
  "swiftshader",
  "llvmpipe",
  "lavapipe",
  "softpipe",
  "software rasterizer",
  "software adapter",
  "microsoft basic render",
  "basic render driver",
];

/** Locale-independent code-unit order for byte-stable CI reports. */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Classifies an adapter as hardware, software, or indeterminate.
 *
 * Pure and total over arbitrary input: anything that cannot be shown to be
 * either is reported as `UNKNOWN` rather than being waved through as hardware.
 *
 * @param {object} [info] A `GPUAdapterInfo`-shaped object. Only `vendor`,
 *   `architecture`, `device`, `description` and `isFallbackAdapter` are read,
 *   so a plain object may be supplied by a test.
 * @returns {string} One of {@link AdapterTier}.
 */
export function classifyAdapterTier(info) {
  if (info === null || typeof info !== "object") {
    return AdapterTier.UNKNOWN;
  }

  if (info.isFallbackAdapter === true) {
    return AdapterTier.SOFTWARE;
  }

  const fields = ["vendor", "architecture", "device", "description"]
    .map((name) => (typeof info[name] === "string" ? info[name] : ""))
    .filter((value) => value.length > 0);

  const haystack = fields.join(" ").toLowerCase();
  if (SOFTWARE_ADAPTER_MARKERS.some((marker) => haystack.includes(marker))) {
    return AdapterTier.SOFTWARE;
  }

  // No descriptive field carried any information — Chromium masks the whole
  // structure in some configurations. Not provably hardware.
  if (fields.length === 0) {
    return AdapterTier.UNKNOWN;
  }

  // `isFallbackAdapter` is only trustworthy as a positive signal where the
  // browser actually implements it. Its absence alongside a real vendor or
  // architecture string is the ordinary hardware shape.
  return AdapterTier.HARDWARE;
}

/**
 * Declaration-time capability probe. Deliberately does NOT request an adapter:
 * `describeRequiresWebGPU` has to decide synchronously, before Jasmine starts
 * collecting the suite, and an async probe cannot inform that decision.
 *
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {boolean} Whether the host exposes a WebGPU implementation.
 */
export function isWebGPUAvailable(scope) {
  const target = scope ?? globalThis;
  return (
    typeof target.navigator !== "undefined" &&
    target.navigator !== null &&
    "gpu" in target.navigator
  );
}

/**
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {boolean} Whether the run demands that the lane execute.
 */
export function isWebGPULaneDemanded(scope) {
  return (scope ?? globalThis)[WEBGPU_LANE_DEMANDED_KEY] === true;
}

/**
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {string} The adapter tier the lane requires.
 */
export function requiredAdapterTier(scope) {
  const value = (scope ?? globalThis)[WEBGPU_LANE_REQUIRED_TIER_KEY];
  return value === RequiredAdapterTier.ANY
    ? RequiredAdapterTier.ANY
    : value === RequiredAdapterTier.HARDWARE
      ? RequiredAdapterTier.HARDWARE
      : RequiredAdapterTier.ANY;
}

/**
 * Publishes the lane configuration and resets its per-run bookkeeping.
 *
 * A demanded lane defaults to requiring HARDWARE. That default is the point of
 * the demand: a caller who asks for the lane to run is asking for it to run on
 * a real GPU, and has to say `--webgpu-tier=any` to accept a software adapter.
 *
 * @param {object} [options]
 * @param {boolean} [options.demanded=false] Whether the lane must execute.
 * @param {string} [options.requiredTier] One of {@link RequiredAdapterTier}.
 * @param {object} [scope] The global object; defaults to `globalThis`.
 */
export function setWebGPULane(options, scope) {
  const target = scope ?? globalThis;
  const demanded = options?.demanded === true;
  const requested = options?.requiredTier;
  const requiredTier =
    requested === RequiredAdapterTier.ANY ||
    requested === RequiredAdapterTier.HARDWARE
      ? requested
      : demanded
        ? RequiredAdapterTier.HARDWARE
        : RequiredAdapterTier.ANY;

  target[WEBGPU_LANE_DEMANDED_KEY] = demanded;
  target[WEBGPU_LANE_REQUIRED_TIER_KEY] = requiredTier;
  target[DECLARED_SUITES_KEY] = [];
  target[SKIPPED_SUITES_KEY] = [];
  target[EXECUTION_LEDGER_KEY] = { executed: 0, failed: 0, skipped: 0 };
  target[OBSERVED_ADAPTER_KEY] = undefined;
  target[WEBGPU_LANE_SUMMARY_KEY] = undefined;
}

/**
 * Declares a suite that requires a constructed WebGPU Scene.
 *
 * When the host exposes no WebGPU implementation — or the run is a WebGL-stub
 * lane, where a real backend is not what is under test — the suite is skipped
 * and recorded with its reason. That is a truthful skip the end-of-run report
 * names; it is never a silent pass, and it is never a fallback onto WebGL.
 *
 * @param {string} name The suite name.
 * @param {Function} suite The suite body.
 * @param {string} [category] The existing describe category (e.g. "WebGL").
 * @param {object} [scope] The global object; defaults to `globalThis`.
 */
export function describeRequiresWebGPU(name, suite, category, scope) {
  const target = scope ?? globalThis;
  target[DECLARED_SUITES_KEY] = target[DECLARED_SUITES_KEY] ?? [];
  target[DECLARED_SUITES_KEY].push(name);

  const reason = !isWebGPUAvailable(target)
    ? WEBGPU_LANE_SKIP_REASON
    : target.webglStub === true
      ? WEBGPU_STUB_LANE_SKIP_REASON
      : null;

  if (reason !== null) {
    target[SKIPPED_SUITES_KEY] = target[SKIPPED_SUITES_KEY] ?? [];
    target[SKIPPED_SUITES_KEY].push({ name, reason });
    target.xdescribe(name, suite);
    return;
  }

  target.describe(name, suite, category);
}

/**
 * Records the adapter a lane spec actually ran against.
 *
 * Called by the spec rather than by the helper, because the adapter that
 * matters is the one the constructed Scene's context holds — not one this
 * module could request separately and hope is the same.
 *
 * @param {object} [info] A `GPUAdapterInfo`-shaped object.
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {string} The classified tier, one of {@link AdapterTier}.
 */
export function recordWebGPUAdapterTier(info, scope) {
  const target = scope ?? globalThis;
  const tier = classifyAdapterTier(info);
  const read = (name) =>
    info !== null && typeof info === "object" && typeof info[name] === "string"
      ? info[name]
      : "";

  target[OBSERVED_ADAPTER_KEY] = {
    tier,
    vendor: read("vendor"),
    architecture: read("architecture"),
    device: read("device"),
    description: read("description"),
    isFallbackAdapter:
      info !== null && typeof info === "object"
        ? info.isFallbackAdapter === true
        : false,
  };
  return tier;
}

/**
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {object|undefined} The recorded adapter record, if a spec set one.
 */
export function observedWebGPUAdapter(scope) {
  return (scope ?? globalThis)[OBSERVED_ADAPTER_KEY];
}

/**
 * Installs the reporter that counts what the lane actually EXECUTED.
 *
 * Counting has to happen at `specDone`, not in a `beforeEach` inside the suite:
 * a spec that calls `pending()` in its body runs its `beforeEach` hooks first,
 * so a hook-based tally would count a pending spec as coverage — which is the
 * precise confusion this lane exists to remove. Jasmine reports `pending` and
 * `excluded` as distinct statuses at `specDone`, so only `passed` and `failed`
 * are counted as execution.
 *
 * @param {{addReporter: (reporter: object) => void}} env Jasmine environment.
 * @param {object} [scope] The global object; defaults to `globalThis`.
 */
export function installWebGPULaneSpecLedger(env, scope) {
  const target = scope ?? globalThis;
  if (typeof env?.addReporter !== "function") {
    throw new Error("[webgpu lane] Jasmine reporter is unavailable.");
  }

  env.addReporter({
    specDone(result) {
      const fullName =
        typeof result?.fullName === "string" ? result.fullName : "";
      const declared = target[DECLARED_SUITES_KEY] ?? [];
      if (!declared.some((name) => fullName.startsWith(name))) {
        return;
      }

      const ledger = (target[EXECUTION_LEDGER_KEY] = target[
        EXECUTION_LEDGER_KEY
      ] ?? { executed: 0, failed: 0, skipped: 0 });

      if (result.status === "passed" || result.status === "failed") {
        ledger.executed += 1;
        if (result.status === "failed") {
          ledger.failed += 1;
        }
        return;
      }
      ledger.skipped += 1;
    },
  });
}

/**
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {object} The raw lane state.
 */
export function summarizeWebGPULane(scope) {
  const target = scope ?? globalThis;
  return {
    demanded: isWebGPULaneDemanded(target),
    requiredTier: requiredAdapterTier(target),
    declaredSuites: target[DECLARED_SUITES_KEY] ?? [],
    skippedSuites: target[SKIPPED_SUITES_KEY] ?? [],
    execution: target[EXECUTION_LEDGER_KEY] ?? {
      executed: 0,
      failed: 0,
      skipped: 0,
    },
    adapter: target[OBSERVED_ADAPTER_KEY],
  };
}

/**
 * Produces a deterministic, serialization-ready end-of-run report. Declaration
 * order is useful while debugging but must not make the CI report unstable, so
 * the rosters are sorted without mutating the live ledgers.
 *
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {object}
 */
export function createWebGPULaneRunSummary(scope) {
  const state = summarizeWebGPULane(scope);
  const declaredSuites = [...state.declaredSuites]
    .map(String)
    .sort(compareStrings);
  const skippedSuites = state.skippedSuites
    .map(({ name, reason }) => ({ name: String(name), reason: String(reason) }))
    .sort(
      (left, right) =>
        compareStrings(left.name, right.name) ||
        compareStrings(left.reason, right.reason),
    );

  return {
    demanded: state.demanded,
    requiredTier: state.requiredTier,
    declaredSuiteCount: declaredSuites.length,
    skippedSuiteCount: skippedSuites.length,
    executedSpecCount: state.execution.executed ?? 0,
    failedSpecCount: state.execution.failed ?? 0,
    skippedSpecCount: state.execution.skipped ?? 0,
    adapterTier: state.adapter?.tier ?? AdapterTier.UNKNOWN,
    adapterObserved: state.adapter !== undefined,
    adapter: state.adapter ?? null,
    declaredSuites,
    skippedSuites,
  };
}

/**
 * Formats the canonical report as one machine-readable log line.
 *
 * @param {ReturnType<typeof createWebGPULaneRunSummary>} summary
 * @returns {string}
 */
export function formatWebGPULaneRunSummary(summary) {
  return `${WEBGPU_LANE_SUMMARY_PREFIX}${JSON.stringify(summary)}`;
}

/**
 * Computes the fail-closed verdict for a finished run.
 *
 * Split out from the hook so it can be exercised directly over a synthetic
 * summary — a lane whose own failure path has never been executed is not
 * meaningfully fail-closed.
 *
 * @param {ReturnType<typeof createWebGPULaneRunSummary>} summary
 * @returns {string|null} The failure message, or null when the run is clean.
 */
export function webgpuLaneFailureMessage(summary) {
  if (!summary.demanded) {
    return null;
  }

  if (summary.executedSpecCount === 0) {
    const detail =
      summary.skippedSuites.length > 0
        ? summary.skippedSuites
            .map(({ name, reason }) => `${name} (${reason})`)
            .join("; ")
        : summary.declaredSuiteCount === 0
          ? "no suite was declared with describeRequiresWebGPU()"
          : "the declared suites produced no executed specs";
    return (
      `[webgpu lane] the WebGPU lane was demanded but ZERO WebGPU specs executed: ${detail}. ` +
      `A skipped lane is invisible in the default reporter (specReporter.suppressSkipped ` +
      `is true), so this run is failed rather than reported as green. Run without ` +
      `--webgpu to accept a skip, or fix the environment so an adapter is available.`
    );
  }

  if (summary.requiredTier === RequiredAdapterTier.HARDWARE) {
    if (!summary.adapterObserved) {
      return (
        `[webgpu lane] the lane executed ${summary.executedSpecCount} spec(s) but never ` +
        `recorded an adapter tier, so a software adapter cannot be ruled out. A lane spec ` +
        `must call recordWebGPUAdapterTier() with its context's adapter info.`
      );
    }
    if (summary.adapterTier !== AdapterTier.HARDWARE) {
      const { vendor, architecture, isFallbackAdapter } = summary.adapter ?? {};
      return (
        `[webgpu lane] hardware was required but the adapter classified as ` +
        `"${summary.adapterTier}" (vendor="${vendor ?? ""}", architecture="${architecture ?? ""}", ` +
        `isFallbackAdapter=${isFallbackAdapter === true}). A software adapter is still an ` +
        `adapter: --disable-gpu resolves SwiftShader and would otherwise let this run ` +
        `certify hardware it never touched. Pass --webgpu-tier=any to accept it.`
      );
    }
  }

  return null;
}

/**
 * Installs the root end-of-run assertion and report for the WebGPU lane.
 *
 * The report is emitted on every run that declared a lane suite, demanded or
 * not. That is what makes a skip visible: `specReporter.suppressSkipped` is
 * true for the gulp test task, so without this line an `xdescribe`d lane
 * produces no terminal output whatsoever and is indistinguishable from a lane
 * that ran.
 *
 * Jasmine executes root `afterAll` hooks in reverse declaration order, so a
 * hook installed before spec modules evaluate runs after their root cleanup.
 *
 * @param {{afterAll: (callback: () => void) => void}} env Jasmine environment.
 * @param {object} [options]
 * @param {object} [options.scope] The global object; defaults to `globalThis`.
 * @param {(message: string) => void} [options.report] Report sink; defaults to `console.info`.
 */
export function installWebGPULaneRunAssertion(env, options = {}) {
  const target = options.scope ?? globalThis;
  const report =
    options.report ?? ((message) => target.console?.info?.(message));

  env.afterAll(function assertWebGPULaneRanAsDemanded() {
    const summary = createWebGPULaneRunSummary(target);
    if (!summary.demanded && summary.declaredSuiteCount === 0) {
      return;
    }

    target[WEBGPU_LANE_SUMMARY_KEY] = summary;
    report(formatWebGPULaneRunSummary(summary));

    const failure = webgpuLaneFailureMessage(summary);
    if (failure !== null) {
      throw new Error(failure);
    }
  });
}
