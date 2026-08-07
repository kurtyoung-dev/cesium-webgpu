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

/**
 * URL schemes that never leave the page and are therefore always allowed:
 * inline payloads, object URLs, and the module-worker bootstrap.
 */
const LOCAL_SCHEMES = new Set(["data:", "blob:", "about:", "filesystem:"]);

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
  return new Error(
    `[offline lane] blocked request to ${url}. Specs must not reach external hosts: ` +
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
 * Installs the offline fetch guard over `fetch`, `XMLHttpRequest` and
 * `Image.src`. Every refusal is recorded before it throws so a run that dies on
 * one blocked request still shows the whole leak surface.
 *
 * @param {object} options
 * @param {string} options.origin The permitted origin.
 * @param {readonly string[]} [options.allowedOrigins] Extra permitted origins.
 * @param {object} [options.scope] The global object; defaults to `globalThis`.
 * @returns {() => void} Uninstaller, restoring the original implementations.
 */
export function installOfflineNetworkGuard(options) {
  const { origin, allowedOrigins = [], scope } = options;
  const target = scope ?? globalThis;
  target[BLOCKED_REQUESTS_KEY] = target[BLOCKED_REQUESTS_KEY] ?? [];

  /** Records the refusal and returns the error, leaving throw-vs-reject to the caller. */
  const refuse = (url, api) => {
    target[BLOCKED_REQUESTS_KEY].push({ url: String(url), api });
    return offlineViolationError(url);
  };
  const isBlocked = (url) =>
    isExternalRequestUrl(String(url), { origin, allowedOrigins });

  const originalFetch = target.fetch;
  if (typeof originalFetch === "function") {
    target.fetch = function guardedFetch(input, init) {
      const url = typeof input === "string" ? input : (input?.url ?? "");
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
