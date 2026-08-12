/**
 * Offline dependency isolation for the spec suites — C11-134
 * (NEW-FULL-SUITE-OFFLINE-DEPENDENCY-ISOLATION).
 *
 * The dev sandbox has no reliable outbound network, so any spec that reaches
 * Ion / Cesium World Terrain / an arbitrary tile server is nondeterministic: it
 * times out, or it passes only when the network happens to be up. A suite that
 * randomly times out cannot produce the truthful executed/skipped counts the
 * campaign exit gate is defined on.
 *
 * The isolation has two halves, and BOTH are required — a quarantine without a
 * guard just moves the leak to the next spec that lands:
 *
 *   1. An explicit ONLINE LANE. Suites that genuinely need a live service are
 *      declared with {@link describeRequiresNetwork}. In the offline lane they
 *      are skipped with a recorded reason ("requires network"), which is a
 *      truthful skip, not a silent pass. Coverage is quarantined, never deleted.
 *   2. A FETCH GUARD. In the offline lane any request to a host other than the
 *      Karma origin fails loudly and is recorded, so a newly-added network
 *      dependency fails the day it lands instead of silently degrading the
 *      suite months later.
 */

/** Reason recorded against every suite the offline lane skips. */
export const NETWORK_LANE_SKIP_REASON = "requires network";

/** Global on which the offline lane flag is published for spec modules. */
export const OFFLINE_LANE_FLAG = "__cesiumOfflineLane";

/** Global holding the truthful roster of skipped online-lane suites. */
export const SKIPPED_SUITES_KEY = "__cesiumSkippedNetworkSuites";

/** Global holding requests the guard refused, for post-run triage. */
export const BLOCKED_REQUESTS_KEY = "__cesiumBlockedNetworkRequests";

/** Global holding the canonical end-of-run report for machine inspection. */
export const NETWORK_LANE_SUMMARY_KEY = "__cesiumNetworkLaneSummary";

/** Prefix kept stable so CI logs can extract the report without heuristics. */
export const NETWORK_LANE_SUMMARY_PREFIX = "[offline lane] summary ";

/** Global holding the full name of the Jasmine spec currently executing. */
export const CURRENT_JASMINE_SPEC_KEY = "__cesiumCurrentJasmineSpec";

/** Attribution used for requests made by bootstrap and root hooks. */
export const OUTSIDE_JASMINE_SPEC = "<outside-spec>";

/**
 * URL schemes that never leave the page and are therefore always allowed:
 * inline payloads, object URLs, and the module-worker bootstrap.
 */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:", "filesystem:"]);

/** Query parameters whose values must never enter a test artifact or log. */
const SENSITIVE_QUERY_PARAMETERS = new Set([
  "access_token",
  "access-token",
  "api_key",
  "api-key",
  "apikey",
  "authorization",
  "client_secret",
  "client-secret",
  "credential",
  "key",
  "password",
  "secret",
  "session",
  "session_token",
  "session-token",
  "signature",
  "subscription_key",
  "subscription-key",
  "token",
]);

/** Locale-independent code-unit order for byte-stable CI reports. */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Redacts credentials while preserving the URL shape used to diagnose a leak.
 * This intentionally operates on the query text rather than requiring an
 * absolute URL, so relative and protocol-relative requests are handled too.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function redactSensitiveRequestUrl(value) {
  const url = String(value);
  const questionIndex = url.indexOf("?");
  if (questionIndex === -1) {
    return url;
  }

  const hashIndex = url.indexOf("#", questionIndex);
  const queryEnd = hashIndex === -1 ? url.length : hashIndex;
  const query = url.slice(questionIndex + 1, queryEnd);
  const redactedQuery = query
    .split("&")
    .map((parameter) => {
      const equalsIndex = parameter.indexOf("=");
      const encodedName =
        equalsIndex === -1 ? parameter : parameter.slice(0, equalsIndex);
      let name;
      try {
        name = decodeURIComponent(encodedName.replace(/\+/g, " "));
      } catch {
        // An undecodable name cannot be proven safe. Preserve its structure but
        // redact its value so malformed credential-like input cannot leak.
        return equalsIndex === -1 ? encodedName : `${encodedName}=[REDACTED]`;
      }
      if (!SENSITIVE_QUERY_PARAMETERS.has(name.toLowerCase())) {
        return parameter;
      }
      return `${encodedName}=[REDACTED]`;
    })
    .join("&");

  return `${url.slice(0, questionIndex + 1)}${redactedQuery}${url.slice(queryEnd)}`;
}

/**
 * Decides whether a request URL would leave the Karma origin.
 *
 * Pure and total: an unparseable URL is reported as external rather than
 * waved through, because "we could not tell" must not become "allowed".
 *
 * @param {string} url The requested URL, absolute or relative.
 * @param {object} options
 * @param {string} options.origin The page origin requests are allowed to reach.
 * @param {readonly string[]} [options.allowedOrigins] Extra permitted origins.
 * @returns {boolean} True when the request targets a foreign origin.
 */
export function isExternalRequestUrl(url, options) {
  const { origin, allowedOrigins = [] } = options ?? {};
  if (typeof url !== "string" || url.length === 0) {
    return true;
  }

  const scheme = url.slice(0, Math.max(0, url.indexOf(":") + 1)).toLowerCase();
  if (LOCAL_SCHEMES.has(scheme)) {
    return false;
  }

  let resolved;
  try {
    resolved = new URL(url, origin);
  } catch {
    return true;
  }

  if (LOCAL_SCHEMES.has(resolved.protocol)) {
    return false;
  }
  return (
    resolved.origin !== origin && !allowedOrigins.includes(resolved.origin)
  );
}

/**
 * Builds the error a blocked request reports. Names the offending URL and the
 * lane, so the failure is self-diagnosing rather than a bare timeout.
 *
 * @param {string} url
 * @returns {Error}
 */
export function offlineViolationError(url) {
  const redactedUrl = redactSensitiveRequestUrl(url);
  return new Error(
    `[offline lane] blocked request to ${redactedUrl}. Specs must not reach external hosts: ` +
      `use a local fixture under Specs/Data, mock the request, or declare the suite ` +
      `with describeRequiresNetwork() so it is skipped as "${NETWORK_LANE_SKIP_REASON}".`,
  );
}

/**
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {boolean} Whether the offline lane is active.
 */
export function isOfflineLane(scope) {
  return (scope ?? globalThis)[OFFLINE_LANE_FLAG] === true;
}

/**
 * Publishes the offline-lane flag and resets its per-run bookkeeping.
 *
 * @param {boolean} offline
 * @param {object} [scope] The global object; defaults to `globalThis`.
 */
export function setOfflineLane(offline, scope) {
  const target = scope ?? globalThis;
  target[OFFLINE_LANE_FLAG] = offline === true;
  target[SKIPPED_SUITES_KEY] = [];
  target[BLOCKED_REQUESTS_KEY] = [];
  target[NETWORK_LANE_SUMMARY_KEY] = undefined;
  target[CURRENT_JASMINE_SPEC_KEY] = OUTSIDE_JASMINE_SPEC;
}

/**
 * Installs stable per-request Jasmine attribution before specs evaluate.
 * Missing reporter data maps to an explicit sentinel instead of disappearing
 * from the evidence, so attribution is fail-closed.
 *
 * @param {{addReporter: (reporter: object) => void}} env Jasmine environment.
 * @param {object} [scope] The global object; defaults to `globalThis`.
 */
export function installOfflineNetworkSpecAttribution(env, scope) {
  const target = scope ?? globalThis;
  if (typeof env?.addReporter !== "function") {
    throw new Error(
      "[offline lane] Jasmine spec attribution reporter is unavailable.",
    );
  }

  env.addReporter({
    specStarted(result) {
      const fullName = result?.fullName;
      target[CURRENT_JASMINE_SPEC_KEY] =
        typeof fullName === "string" && fullName.length > 0
          ? fullName
          : OUTSIDE_JASMINE_SPEC;
    },
    specDone() {
      target[CURRENT_JASMINE_SPEC_KEY] = OUTSIDE_JASMINE_SPEC;
    },
  });
}

/**
 * Declares a suite that genuinely requires a live external service.
 *
 * In the offline lane the suite is skipped and recorded with its reason — a
 * truthful SKIP that the exit gate can report, not a silent pass. With the
 * online lane enabled it runs exactly as it did before, preserving coverage.
 *
 * @param {string} name The suite name.
 * @param {Function} suite The suite body.
 * @param {string} [category] The existing describe category (e.g. "WebGL").
 * @param {object} [scope] The global object; defaults to `globalThis`.
 */
export function describeRequiresNetwork(name, suite, category, scope) {
  const target = scope ?? globalThis;
  if (isOfflineLane(target)) {
    target[SKIPPED_SUITES_KEY] = target[SKIPPED_SUITES_KEY] ?? [];
    target[SKIPPED_SUITES_KEY].push({
      name,
      reason: NETWORK_LANE_SKIP_REASON,
    });
    target.xdescribe(name, suite);
    return;
  }
  target.describe(name, suite, category);
}

/**
 * Installs the offline fetch guard over `fetch` and `XMLHttpRequest`. Every
 * refusal is recorded before it throws so a run that dies on one blocked
 * request still shows the whole leak surface.
 *
 * @param {object} options
 * @param {string} options.origin The permitted origin.
 * @param {object} [options.scope] The global object; defaults to `globalThis`.
 * @returns {() => void} Uninstaller, restoring the original implementations.
 */
export function installOfflineNetworkGuard(options) {
  const { origin, scope } = options;
  const target = scope ?? globalThis;
  target[BLOCKED_REQUESTS_KEY] = target[BLOCKED_REQUESTS_KEY] ?? [];

  /** Records the refusal and returns the error, leaving throw-vs-reject to the caller. */
  const refuse = (url, api) => {
    const redactedUrl = redactSensitiveRequestUrl(url);
    const spec =
      typeof target[CURRENT_JASMINE_SPEC_KEY] === "string"
        ? target[CURRENT_JASMINE_SPEC_KEY]
        : OUTSIDE_JASMINE_SPEC;
    target[BLOCKED_REQUESTS_KEY].push({ url: redactedUrl, api, spec });
    return offlineViolationError(redactedUrl);
  };
  // Deliberately do not forward `allowedOrigins` here. A URL allowlist cannot
  // prove that a test-local fake intercepted the transport, so it must never
  // authorize native fetch/XHR in the offline lane. Tests that use foreign URL
  // shapes must intercept above this boundary; anything reaching it blocks.
  const isBlocked = (url) => isExternalRequestUrl(String(url), { origin });

  const originalFetch = target.fetch;
  if (typeof originalFetch === "function") {
    target.fetch = function guardedFetch(input, init) {
      const url =
        typeof input === "string"
          ? input
          : typeof input?.url === "string"
            ? input.url
            : typeof input?.href === "string"
              ? input.href
              : "";
      if (isBlocked(url)) {
        // `fetch` always settles a promise; throwing synchronously here would
        // break every `fetch(...).catch(...)` caller and disguise the refusal.
        return Promise.reject(refuse(url, "fetch"));
      }
      return originalFetch.call(this, input, init);
    };
  }

  const xhrPrototype = target.XMLHttpRequest?.prototype;
  const originalOpen = xhrPrototype?.open;
  if (typeof originalOpen === "function") {
    xhrPrototype.open = function guardedOpen(method, url, ...rest) {
      if (isBlocked(url)) {
        // `open()` throws on a bad URL, so a synchronous throw is the faithful
        // failure mode here.
        throw refuse(url, "xhr");
      }
      return originalOpen.call(this, method, url, ...rest);
    };
  }

  return function uninstallOfflineNetworkGuard() {
    if (typeof originalFetch === "function") {
      target.fetch = originalFetch;
    }
    if (typeof originalOpen === "function") {
      xhrPrototype.open = originalOpen;
    }
  };
}

/**
 * Summarizes the lane for a run report: how many suites were quarantined and
 * whether anything leaked past the guard.
 *
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {{offline: boolean, skippedSuites: Array<{name: string, reason: string}>, blockedRequests: Array<{url: string, api: string}>}}
 */
export function summarizeNetworkLane(scope) {
  const target = scope ?? globalThis;
  return {
    offline: isOfflineLane(target),
    skippedSuites: target[SKIPPED_SUITES_KEY] ?? [],
    blockedRequests: target[BLOCKED_REQUESTS_KEY] ?? [],
  };
}

/**
 * Produces a deterministic, serialization-ready end-of-run report. Declaration
 * and request order are useful while debugging, but must not make the CI report
 * unstable, so both rosters are sorted without mutating the live ledgers.
 *
 * @param {object} [scope] The global object; defaults to `globalThis`.
 * @returns {{offline: boolean, skippedSuiteCount: number, blockedRequestCount: number, skippedSuites: Array<{name: string, reason: string}>, blockedRequests: Array<{url: string, api: string, spec: string, count: number}>}}
 */
export function createNetworkLaneRunSummary(scope) {
  const summary = summarizeNetworkLane(scope);
  const skippedSuites = summary.skippedSuites
    .map(({ name, reason }) => ({ name: String(name), reason: String(reason) }))
    .sort(
      (left, right) =>
        compareStrings(left.name, right.name) ||
        compareStrings(left.reason, right.reason),
    );
  const blockedRequestGroups = new Map();
  for (const request of summary.blockedRequests) {
    const entry = {
      url: redactSensitiveRequestUrl(request.url),
      api: String(request.api),
      spec:
        typeof request.spec === "string" ? request.spec : OUTSIDE_JASMINE_SPEC,
    };
    const key = JSON.stringify([entry.api, entry.url, entry.spec]);
    const existing = blockedRequestGroups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      blockedRequestGroups.set(key, { ...entry, count: 1 });
    }
  }
  const blockedRequests = [...blockedRequestGroups.values()].sort(
    (left, right) =>
      compareStrings(left.api, right.api) ||
      compareStrings(left.url, right.url) ||
      compareStrings(left.spec, right.spec),
  );
  const blockedRequestCount = blockedRequests.reduce(
    (total, { count }) => total + count,
    0,
  );

  return {
    offline: summary.offline,
    skippedSuiteCount: skippedSuites.length,
    blockedRequestCount,
    skippedSuites,
    blockedRequests,
  };
}

/**
 * Formats the canonical report as one machine-readable log line.
 *
 * @param {ReturnType<typeof createNetworkLaneRunSummary>} summary
 * @returns {string}
 */
export function formatNetworkLaneRunSummary(summary) {
  return `${NETWORK_LANE_SUMMARY_PREFIX}${JSON.stringify(summary)}`;
}

/**
 * Installs the root end-of-run assertion for the offline lane.
 *
 * This is deliberately a root `afterAll`, not only a request-time exception:
 * product or spec code is allowed to catch a rejected fetch or thrown XHR
 * `open()`, but catching it must not turn an offline dependency into a green
 * run. Jasmine executes root afterAll hooks in reverse declaration order, so a
 * hook installed before spec modules evaluate runs after their root cleanup.
 *
 * @param {{afterAll: (callback: () => void) => void}} env Jasmine environment.
 * @param {object} [options]
 * @param {object} [options.scope] The global object; defaults to `globalThis`.
 * @param {(message: string) => void} [options.report] Report sink; defaults to `console.info`.
 */
export function installOfflineNetworkRunAssertion(env, options = {}) {
  const target = options.scope ?? globalThis;
  const report =
    options.report ?? ((message) => target.console?.info?.(message));

  env.afterAll(function assertOfflineNetworkRunIsClean() {
    const summary = createNetworkLaneRunSummary(target);
    if (!summary.offline) {
      return;
    }

    target[NETWORK_LANE_SUMMARY_KEY] = summary;
    report(formatNetworkLaneRunSummary(summary));

    if (summary.blockedRequestCount === 0) {
      return;
    }

    const refused = summary.blockedRequests
      .map(({ api, url, spec, count }) => `${count}x ${api} ${url} (${spec})`)
      .join("; ");
    throw new Error(
      `[offline lane] ${summary.blockedRequestCount} blocked request(s) remained in the ` +
        `end-of-run ledger: ${refused}. A request-time error was caught, but the ` +
        `offline run is fail-closed; mock the transport or use describeRequiresNetwork().`,
    );
  });
}
