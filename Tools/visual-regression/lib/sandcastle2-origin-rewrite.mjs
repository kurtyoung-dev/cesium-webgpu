// sandcastle2-origin-rewrite.mjs — neutralize the built Sandcastle2 app's
// baked-in top-level redirect, and refuse loudly — continuously, not once —
// whenever that neutralization did not hold for a given page.
//
// @purpose Reusable Playwright helper for every opener of the built Sandcastle2 app: rewrites the build-time-baked outer/inner origin strings the app's own responses carry, and attaches a persistent per-navigation guard (main frame + bucket/run frame) that throws a named, distinguishable refusal the instant any navigation lands off the requested origin — checked synchronously at every guard call AND automatically at page close, so a caller that never awaits a navigation call is still refused.
// @status ACTIVE
//
// THE PROBLEM. The Sandcastle2 build step bakes two literal origin strings
// into the compiled bundle it serves: the surrounding app's own origin, and
// the origin the run/bucket iframe is expected to live on. One of the
// compiled entry points compares the baked "outer" string against the live
// `window.location.origin` at the very top of the page and, on any mismatch,
// performs an unconditional top-level `window.location.replace(...)` to the
// baked origin. Once a build has been produced with the default origins it
// stays on disk unchanged, and gets served unchanged by every later run, so
// opening the built app on any OTHER port silently redirects the whole page
// away from the port that was actually requested.
//
// THE FIX HAS TWO INDEPENDENT HALVES, and only one of them is the actual
// deliverable:
//
//   1. A response rewrite ({@link installOriginRewrite}) that intercepts the
//      built app's own text responses and replaces the baked origin strings
//      with the origins a run actually wants, before the browser ever parses
//      them. This is the convenience: a page configured this way should
//      never trip the guard below.
//   2. A PERSISTENT navigation guard ({@link attachOriginGuard} and the
//      functions built on it) that is independent of whether the rewrite is
//      installed. It listens to EVERY `framenavigated` event for the main
//      frame and for the run/bucket frame, for as long as the page is open —
//      not a one-shot check after a fixed quiet window — and records the
//      first origin mismatch it ever sees. `assertNoOriginBreach()` is
//      SYNCHRONOUS and re-checks that recorded state on demand; the page
//      factory below calls it automatically when the page closes, so a
//      breach that happens after a caller's last awaited check — or after a
//      navigation call the caller never awaited at all — still surfaces
//      loudly instead of silently closing over it.
//
// A protected page should never see the guard fire. An unprotected one, or
// one that hits a build carrying an origin this module was not told about,
// must see it fire every time — immediately if a caller is still watching,
// and at the latest when the page closes if nobody was.

import { URL } from "node:url";

/** Route glob passed to Playwright's `context.route`/`page.route`. Scoped to the built app's own path so unrelated requests (imagery, Ion, a sibling app) are never intercepted. */
export const DEFAULT_ORIGIN_REWRITE_ROUTE_GLOB = "**/Apps/Sandcastle2/**";

/** Outer-app origin the build bakes in when nothing else is passed to it. */
export const DEFAULT_BAKED_SERVED_ORIGIN = "http://localhost:8080";

/** Inner/bucket-mirror origin the build bakes in when nothing else is passed to it (main port + 1, by the build's own convention). */
export const DEFAULT_BAKED_BUCKET_ORIGIN = "http://localhost:8081";

/** File extensions the rewrite bothers reading a body for; everything else is passed through untouched. */
const REWRITABLE_URL_PATTERN = /\.(m?js|html)(\?|$)/;

/** Urls that mean "no real navigation has happened on this frame yet" — never worth checking. */
const NON_NAVIGATION_URLS = new Set(["about:blank", ""]);

/**
 * Thrown by the navigation guard. Distinguishable by name from an ordinary
 * Playwright navigation error (a dead port, DNS failure) so a caller can
 * treat "we could not connect at all" and "we connected but landed on the
 * wrong origin" as the two different findings they are.
 */
export class OriginRewriteRefusal extends Error {
  /**
   * @param {string} code Short, stable machine-matchable reason code.
   * @param {string} reason Human-readable, specific refusal reason.
   * @param {object} [details] Extra fields folded onto the error for callers that want structure without parsing the message.
   */
  constructor(code, reason, details = {}) {
    super(reason);
    this.name = "OriginRewriteRefusal";
    this.code = code;
    this.reason = reason;
    Object.assign(this, details);
  }
}

/**
 * Pure predicate: does an observed url's origin match the origin a
 * navigation was supposed to land on? Kept separate from any Playwright call
 * so the comparison itself is unit-testable without a browser, and reused by
 * every check the persistent guard below performs.
 *
 * @param {object} options
 * @param {string} options.observedUrl The actual url a frame navigated to.
 * @param {string} options.expectedOrigin The origin the navigation was asked to reach.
 * @param {string} [options.label] What is being checked (e.g. "page", "bucket frame"), folded into the reason string.
 * @returns {{ok: boolean, code: string, reason: string, observedOrigin: string|null}}
 */
export function checkNavigatedOrigin({
  observedUrl,
  expectedOrigin,
  label = "navigation",
}) {
  let observedOrigin;
  try {
    observedOrigin = new URL(observedUrl).origin;
  } catch (error) {
    return {
      ok: false,
      code: "UNPARSABLE_URL",
      reason: `${label}: could not parse the observed url "${observedUrl}" (${error?.message ?? error})`,
      observedOrigin: null,
    };
  }
  if (observedOrigin !== expectedOrigin) {
    return {
      ok: false,
      code: "ORIGIN_MISMATCH",
      reason: `${label}: expected origin ${expectedOrigin} but the observed url is ${observedUrl} (origin ${observedOrigin}) — refusing rather than proceeding against an unverified origin`,
      observedOrigin,
    };
  }
  return {
    ok: true,
    code: "OK",
    reason: `${label}: origin ${observedOrigin} matches the requested ${expectedOrigin}`,
    observedOrigin,
  };
}

/**
 * One-shot version of {@link checkNavigatedOrigin} that throws instead of
 * returning a verdict. Still useful as a building block and directly
 * unit-tested, but callers guarding a LIVE page should prefer
 * {@link attachOriginGuard} / {@link gotoWithOriginGuard} — a single call to
 * this function only proves the origin at the instant it was called, not for
 * the page's whole lifetime.
 *
 * @param {object} options Same shape as {@link checkNavigatedOrigin}.
 * @returns {{ok: true, code: "OK", reason: string, observedOrigin: string}} Only returns on success.
 * @throws {OriginRewriteRefusal} On a mismatch or an unparsable url.
 */
export function assertNavigatedOrigin(options) {
  const verdict = checkNavigatedOrigin(options);
  if (!verdict.ok) {
    throw new OriginRewriteRefusal(verdict.code, verdict.reason, {
      observedUrl: options.observedUrl,
      expectedOrigin: options.expectedOrigin,
      observedOrigin: verdict.observedOrigin,
      label: options.label ?? "navigation",
    });
  }
  return verdict;
}

/**
 * Compute the four origins one Sandcastle2 origin-rewrite call needs: the two
 * origins a run was actually launched on, and the two the build bakes in by
 * default (or whatever a caller knows a particular build was baked with).
 *
 * @param {object} options
 * @param {number|string} options.servedPort Port the app itself is served on for this run.
 * @param {number|string} options.bucketPort Port the run/mirror frame is served on for this run.
 * @param {string} [options.hostname] Defaults to "localhost" — matches every known build invocation.
 * @param {string} [options.bakedServedOrigin] Defaults to {@link DEFAULT_BAKED_SERVED_ORIGIN}.
 * @param {string} [options.bakedBucketOrigin] Defaults to {@link DEFAULT_BAKED_BUCKET_ORIGIN}.
 * @returns {{servedOrigin: string, bucketOrigin: string, bakedServedOrigin: string, bakedBucketOrigin: string}}
 */
export function computeSandcastle2Origins({
  servedPort,
  bucketPort,
  hostname = "localhost",
  bakedServedOrigin = DEFAULT_BAKED_SERVED_ORIGIN,
  bakedBucketOrigin = DEFAULT_BAKED_BUCKET_ORIGIN,
}) {
  return {
    servedOrigin: `http://${hostname}:${servedPort}`,
    bucketOrigin: `http://${hostname}:${bucketPort}`,
    bakedServedOrigin,
    bakedBucketOrigin,
  };
}

/**
 * Replace every occurrence of the two baked origin strings in a response body
 * with the two origins a run actually wants. Pure string substitution, kept
 * separate from the route handler below so the substitution itself can be
 * unit-tested against fixture text without a browser or a network call.
 *
 * A body carrying neither baked origin is returned unchanged (by reference)
 * so a caller can cheaply tell "nothing to rewrite" from "rewrote it" if it
 * wants to.
 *
 * @param {string} text Response body text.
 * @param {{servedOrigin: string, bucketOrigin: string, bakedServedOrigin: string, bakedBucketOrigin: string}} origins Output of {@link computeSandcastle2Origins}.
 * @returns {string} The rewritten (or, if nothing matched, original) text.
 */
export function rewriteBakedOrigins(text, origins) {
  const { servedOrigin, bucketOrigin, bakedServedOrigin, bakedBucketOrigin } =
    origins;
  if (!text.includes(bakedBucketOrigin) && !text.includes(bakedServedOrigin)) {
    return text;
  }
  return text
    .split(bakedBucketOrigin)
    .join(bucketOrigin)
    .split(bakedServedOrigin)
    .join(servedOrigin);
}

/**
 * `BrowserContext`/`Page` objects the rewrite has already been installed on —
 * installing it twice on the same object would register a second route
 * handler that shadows the first (Playwright routes are last-registered-
 * wins), which is harmless but wasteful; tracked so a page factory can call
 * this unconditionally without callers having to coordinate.
 */
const REWRITE_INSTALLED = new WeakSet();

/**
 * Install the response rewrite on a Playwright `BrowserContext` or `Page`.
 * Intercepts every request matched by `routeGlob`; for a request whose url
 * looks like a JS/HTML resource, fetches the real response and replaces any
 * baked origin strings in its body with the origins this run actually wants
 * before fulfilling it. Every other request — images, fonts, non-matching
 * urls — is passed through with `route.continue()` untouched. Idempotent per
 * `contextOrPage` object (see {@link REWRITE_INSTALLED}).
 *
 * This installs the FIX, not the guard: a caller still has to guard the
 * navigation itself (via {@link attachOriginGuard} / {@link gotoWithOriginGuard}
 * / {@link waitForBucketFrameOriginGuard}, or the {@link createGuardedPage}
 * factory, which does both) to prove the fix actually held for a given page —
 * this function has no way to know whether the page it is attached to will
 * ever navigate anywhere.
 *
 * @param {{route: Function}} contextOrPage A Playwright `BrowserContext` or `Page` (duck-typed to `.route()`, so a stand-in works in a test that has no real browser).
 * @param {{servedOrigin: string, bucketOrigin: string, bakedServedOrigin: string, bakedBucketOrigin: string}} origins Output of {@link computeSandcastle2Origins}.
 * @param {object} [options]
 * @param {string} [options.routeGlob] Defaults to {@link DEFAULT_ORIGIN_REWRITE_ROUTE_GLOB}.
 * @returns {Promise<void>}
 */
export async function installOriginRewrite(
  contextOrPage,
  origins,
  options = {},
) {
  if (REWRITE_INSTALLED.has(contextOrPage)) {
    return;
  }
  REWRITE_INSTALLED.add(contextOrPage);
  const routeGlob = options.routeGlob ?? DEFAULT_ORIGIN_REWRITE_ROUTE_GLOB;
  await contextOrPage.route(routeGlob, async (route) => {
    const url = route.request().url();
    if (!REWRITABLE_URL_PATTERN.test(url)) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = rewriteBakedOrigins(await response.text(), origins);
    await route.fulfill({ response, body });
  });
}

/**
 * Find the bucket/run frame among a page's frames, by its well-known
 * template path. Used to locate the frame for reading its state (e.g.
 * `frame.evaluate(...)`); the origin GUARD below does not rely on this — it
 * checks every direct child of the main frame by PARENTAGE, so a
 * wrong-origin frame is caught even if its content never reaches a
 * `templates/bucket.html` path at all.
 *
 * @param {import("playwright").Page} page
 * @returns {import("playwright").Frame|null}
 */
export function findBucketFrame(page) {
  return (
    page
      .frames()
      .find((frame) => frame.url().includes("templates/bucket.html")) ?? null
  );
}

/**
 * `WeakMap<Page, GuardHandle>` — the one persistent guard attached to a given
 * page, memoized so `gotoWithOriginGuard`, `waitForBucketFrameOriginGuard`
 * and the page factory all extend the SAME listener instead of stacking
 * independent ones.
 */
const PAGE_GUARDS = new WeakMap();

/**
 * Attach a PERSISTENT origin guard to a page: a `framenavigated` listener
 * that runs for the rest of the page's life (until {@link
 * GuardHandle.detach} is called), checking the main frame against
 * `origins.servedOrigin` and every direct child frame of the main frame
 * against `origins.bucketOrigin`. This is the fix for the one-shot defect —
 * the listener is never torn down after a fixed quiet window, so a redirect
 * that happens 5 navigations and several seconds later is caught exactly the
 * same as one that happens immediately.
 *
 * The listener RECORDS a breach (does not throw) the instant it sees one —
 * `framenavigated` fires synchronously with Playwright's own event loop, so
 * a breach is captured whether or not any caller is currently `await`ing
 * anything. {@link GuardHandle.assertNoOriginBreach} is the synchronous,
 * on-demand read of that recorded state; call it any time, as many times as
 * you like — the first breach ever recorded keeps throwing until the guard
 * is detached or the page closes.
 *
 * @typedef {object} GuardHandle
 * @property {() => void} assertNoOriginBreach Throws {@link OriginRewriteRefusal} (the FIRST one recorded) if any navigation this guard has observed ever missed its expected origin. No-op otherwise.
 * @property {() => OriginRewriteRefusal[]} getBreaches All breaches recorded so far, oldest first.
 * @property {(origins: object) => void} updateOrigins Merge in an `origins` object (only the keys present are applied) — lets a later, more specific call (e.g. `waitForBucketFrameOriginGuard` learning the bucket origin after `gotoWithOriginGuard` only knew the served one) extend an already-attached guard instead of creating a second one.
 * @property {(options?: {quietMs?: number, timeoutMs?: number}) => Promise<void>} waitForQuiet Resolve once no `framenavigated` event this guard cares about has fired for `quietMs` (default 300ms), or after `timeoutMs` (default 3000ms) regardless — a best-effort PROMPT check, not a safety boundary: the listener keeps recording breaches long after this resolves.
 * @property {() => void} beginNavigation Mark one guarded navigation as in flight. Paired with {@link GuardHandle.endNavigation}; called by `gotoWithOriginGuard` / `waitForBucketFrameOriginGuard` around their own work so {@link GuardHandle.hasPendingNavigation} can answer "is a navigation this guard cannot yet vouch for still running" — the question `page.close()` needs answered, since a navigation closed out from under it never gets the chance to record whatever it would have found.
 * @property {() => void} endNavigation Mark one in-flight navigation as finished (settled either way). Always called from a `finally`, so a thrown/rejected navigation still decrements.
 * @property {() => boolean} hasPendingNavigation True while at least one `beginNavigation` has not yet been matched by an `endNavigation`.
 * @property {() => void} detach Remove the listener. Only the page factory's wrapped `close()` and tests should normally call this.
 *
 * @param {import("playwright").Page} page
 * @param {object} options
 * @param {{servedOrigin?: string, bucketOrigin?: string}} options.origins Origins to guard. Either may be omitted to skip guarding that frame kind.
 * @param {string} [options.label] Folded into every recorded breach's reason.
 * @returns {GuardHandle}
 */
export function attachOriginGuard(page, { origins, label = "sandcastle2" }) {
  const state = {
    breaches: [],
    expected: {
      servedOrigin: origins?.servedOrigin,
      bucketOrigin: origins?.bucketOrigin,
    },
    label,
    lastNavigatedAt: Date.now(),
    inFlight: 0,
  };

  const recordIfBreach = (url, expectedOrigin, sublabel) => {
    if (!expectedOrigin || NON_NAVIGATION_URLS.has(url)) {
      return;
    }
    const verdict = checkNavigatedOrigin({
      observedUrl: url,
      expectedOrigin,
      label: `${state.label}: ${sublabel}`,
    });
    if (!verdict.ok) {
      state.breaches.push(
        new OriginRewriteRefusal(verdict.code, verdict.reason, {
          observedUrl: url,
          expectedOrigin,
          observedOrigin: verdict.observedOrigin,
          label: `${state.label}: ${sublabel}`,
        }),
      );
    }
  };

  const onFrameNavigated = (frame) => {
    state.lastNavigatedAt = Date.now();
    let url;
    try {
      url = frame.url();
    } catch {
      return; // a frame can detach mid-event; nothing to check
    }
    if (frame === page.mainFrame()) {
      recordIfBreach(url, state.expected.servedOrigin, "page");
      return;
    }
    if (frame.parentFrame && frame.parentFrame() === page.mainFrame()) {
      // ANY direct child of the main frame is treated as the run/bucket
      // frame and checked by ORIGIN, not by url shape — a wrong-origin
      // frame is caught even if its content never reaches a
      // "templates/bucket.html" path at all.
      recordIfBreach(url, state.expected.bucketOrigin, "bucket frame");
    }
  };

  page.on("framenavigated", onFrameNavigated);
  // A frame that had already navigated before this guard attached (a race
  // between page creation and attachment) is checked once immediately too,
  // so "attached late" never means "never checked".
  for (const frame of page.frames()) {
    onFrameNavigated(frame);
  }

  return {
    assertNoOriginBreach() {
      if (state.breaches.length > 0) {
        throw state.breaches[0];
      }
    },
    getBreaches() {
      return state.breaches.slice();
    },
    updateOrigins(nextOrigins = {}) {
      if (nextOrigins.servedOrigin) {
        state.expected.servedOrigin = nextOrigins.servedOrigin;
      }
      if (nextOrigins.bucketOrigin) {
        state.expected.bucketOrigin = nextOrigins.bucketOrigin;
      }
      // Re-check every currently-known frame against the newly-learned
      // expectation immediately, rather than waiting for the next
      // navigation event that may never come (e.g. a frame that already
      // settled before the bucket origin was learned).
      for (const frame of page.frames()) {
        onFrameNavigated(frame);
      }
    },
    async waitForQuiet({ quietMs = 300, timeoutMs = 3000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const elapsed = Date.now() - state.lastNavigatedAt;
        if (elapsed >= quietMs) {
          return;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))),
        );
      }
    },
    beginNavigation() {
      state.inFlight += 1;
    },
    endNavigation() {
      state.inFlight = Math.max(0, state.inFlight - 1);
    },
    hasPendingNavigation() {
      return state.inFlight > 0;
    },
    detach() {
      page.off("framenavigated", onFrameNavigated);
      PAGE_GUARDS.delete(page);
    },
  };
}

/**
 * Get the guard already attached to `page`, or attach a new one — memoized
 * per page via {@link PAGE_GUARDS} so repeated calls (from
 * `gotoWithOriginGuard`, `waitForBucketFrameOriginGuard`, the page factory)
 * extend one continuous listener instead of stacking independent ones that
 * would each only see events from the moment THEY attached.
 *
 * @param {import("playwright").Page} page
 * @param {object} options Same shape as {@link attachOriginGuard}.
 * @returns {GuardHandle}
 */
export function getOrCreateOriginGuard(page, options) {
  let guard = PAGE_GUARDS.get(page);
  if (!guard) {
    guard = attachOriginGuard(page, options);
    PAGE_GUARDS.set(page, guard);
  } else if (options?.origins) {
    guard.updateOrigins(options.origins);
  }
  return guard;
}

/**
 * THE PAGE FACTORY. Creates a page, attaches (or extends) its persistent
 * origin guard, and wraps `page.close()` so that closing the page always
 * checks the guard FIRST. This is what makes the guard FAIL CLOSED for a
 * caller that forgets to `await` a navigation call (or awaits it but never
 * checks the result): even if nobody explicitly asked, whatever the listener
 * recorded during the page's whole lifetime is asserted at close time,
 * before the page actually goes away.
 *
 * The wrapped `close()` does three things, STRICTLY in this order, and the
 * order is load-bearing:
 *
 *   1. **Assert.** `assertNoOriginBreach()` — a recorded breach wins over
 *      everything below. Additionally, if a guarded navigation
 *      (`gotoWithOriginGuard` / `waitForBucketFrameOriginGuard`) is still
 *      IN FLIGHT when `close()` is called, that by itself is refused with
 *      `NAVIGATION_UNVERIFIED`: a navigation closed out from under it never
 *      gets the chance to finish being checked, so `close()` cannot
 *      honestly vouch for it either way.
 *   2. **Close.** The real `close()` always runs next, whether or not step 1
 *      found anything — cleanup is never skipped because of a breach.
 *   3. **Detach.** The `framenavigated` listener is removed only after the
 *      page has actually closed, so it keeps observing right up to the end
 *      rather than going blind while `close()` is still in flight — and step
 *      1's assertion is RE-CHECKED right before detaching, so a navigation
 *      the page's own teardown script fires DURING step 2 (still observed,
 *      since the listener has not been removed yet) is caught too, not just
 *      ones already recorded before `close()` was called at all.
 *
 * A refusal found by either check is preserved as the error `close()` throws
 * EVEN IF step 2's own close call also fails — a cleanup-time rejection must
 * never silently replace the reason this page was refused in the first
 * place. If neither check found anything but step 2 failed, that close
 * failure still surfaces (nothing here silently swallows a real close error
 * either).
 *
 * @param {import("playwright").BrowserContext} context
 * @param {{servedOrigin: string, bucketOrigin: string}} origins Output of {@link computeSandcastle2Origins} (or any subset — see {@link attachOriginGuard}).
 * @param {object} [options]
 * @param {string} [options.label]
 * @returns {Promise<import("playwright").Page>} The page, ready to navigate. `assertNoOriginBreach()` is called once before this resolves (always a no-op at this point — the page is on `about:blank` — but it establishes the contract this factory exists to guarantee).
 */
export async function createGuardedPage(context, origins, options = {}) {
  const page = await context.newPage();
  const guard = getOrCreateOriginGuard(page, {
    origins,
    label: options.label ?? "sandcastle2",
  });
  const originalClose = page.close.bind(page);
  const captureRefusal = () => {
    try {
      guard.assertNoOriginBreach();
      if (guard.hasPendingNavigation()) {
        throw new OriginRewriteRefusal(
          "NAVIGATION_UNVERIFIED",
          `${options.label ?? "sandcastle2"}: page.close() was called while a guarded navigation was still in flight — its origin was never verified`,
          {},
        );
      }
      return null;
    } catch (error) {
      return error;
    }
  };
  page.close = async (...args) => {
    let refusal = captureRefusal();
    let closeError;
    try {
      await originalClose(...args);
    } catch (error) {
      closeError = error;
    } finally {
      // Re-check before detaching: a navigation that happens WHILE
      // `originalClose()` is running (the page's own teardown script firing
      // one more redirect as it goes) is still observed by the listener
      // since it has not been removed yet — catching it here, rather than
      // only checking once before `originalClose()` starts, is what makes
      // this genuinely "assert, close, detach" and not "assert, close-and-
      // hope-nothing-happens-during-it, detach".
      if (!refusal) {
        refusal = captureRefusal();
      }
      guard.detach();
    }
    if (refusal) {
      throw refusal;
    }
    if (closeError) {
      throw closeError;
    }
  };
  guard.assertNoOriginBreach();
  return page;
}

/**
 * Navigate a page and guard it. Attaches (or extends) the page's persistent
 * origin guard via {@link getOrCreateOriginGuard}, navigates, waits a bounded
 * PROMPT period for navigation activity to go quiet, and asserts. The prompt
 * wait is a convenience, not the safety boundary — the guard keeps listening
 * long after this function returns, so a redirect that lands after the wait
 * (or after this call was never even awaited) is still caught by a LATER
 * `assertNoOriginBreach()` call, including the one the page factory runs
 * automatically at close.
 *
 * A same-tab, script-initiated redirect issued before the original document
 * finishes loading aborts that original navigation; Chromium reports the
 * abort as `net::ERR_ABORTED` on the `goto()` call itself. That is not a
 * connection failure — it is exactly what an UNPROTECTED page's first
 * navigation looks like from the inside — so it is swallowed here (after
 * still checking the guard, in case the abort itself is diagnostic) and the
 * quiet-wait below is left to observe where the page actually ends up. Any
 * OTHER navigation error (a dead port, DNS failure, timeout) is a genuine
 * connection failure and is rethrown unchanged, so it is never mistaken for
 * a silent success.
 *
 * @param {import("playwright").Page} page
 * @param {string} url Absolute url to navigate to.
 * @param {object} options
 * @param {{servedOrigin: string, bucketOrigin?: string}} options.origins
 * @param {object} [options.gotoOptions] Forwarded to `page.goto` (merged under a `domcontentloaded` default `waitUntil`).
 * @param {number} [options.quietMs] Forwarded to {@link GuardHandle.waitForQuiet}.
 * @param {number} [options.timeoutMs] Forwarded to {@link GuardHandle.waitForQuiet}.
 * @param {string} [options.label]
 * @returns {Promise<{finalUrl: string, assertNoOriginBreach: () => void}>}
 * @throws {OriginRewriteRefusal} If any navigation observed so far missed its expected origin.
 */
export async function gotoWithOriginGuard(
  page,
  url,
  {
    origins,
    gotoOptions = {},
    quietMs = 300,
    timeoutMs = 3000,
    label = "sandcastle2",
  },
) {
  const guard = getOrCreateOriginGuard(page, { origins, label });
  guard.beginNavigation();
  try {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", ...gotoOptions });
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/ERR_ABORTED/.test(message)) {
        guard.assertNoOriginBreach();
        throw error;
      }
    }
    await guard.waitForQuiet({ quietMs, timeoutMs });
    guard.assertNoOriginBreach();
    return {
      finalUrl: page.url(),
      assertNoOriginBreach: guard.assertNoOriginBreach,
    };
  } finally {
    guard.endNavigation();
  }
}

/**
 * Wait for the bucket/run frame to appear and guard it. Extends the page's
 * persistent guard with `origins.bucketOrigin` (if not already known), polls
 * for a frame matching {@link findBucketFrame} to exist, then asserts. As
 * with {@link gotoWithOriginGuard}, the guard itself is not bounded by this
 * call's own timeout — it keeps watching every child frame of the main frame
 * for the rest of the page's life.
 *
 * @param {import("playwright").Page} page
 * @param {object} options
 * @param {{servedOrigin?: string, bucketOrigin: string}} options.origins
 * @param {number} [options.timeoutMs] How long to wait for a frame at that path to appear at all.
 * @param {number} [options.pollMs] How often to re-check for the frame while waiting.
 * @param {string} [options.label]
 * @returns {Promise<{frame: import("playwright").Frame, finalUrl: string, assertNoOriginBreach: () => void}>}
 * @throws {OriginRewriteRefusal} If no bucket frame appears in time, or any navigation observed so far missed its expected origin.
 */
export async function waitForBucketFrameOriginGuard(
  page,
  { origins, timeoutMs = 20000, pollMs = 100, label = "sandcastle2" },
) {
  const guard = getOrCreateOriginGuard(page, { origins, label });
  guard.beginNavigation();
  try {
    const deadline = Date.now() + timeoutMs;
    let frame = findBucketFrame(page);
    while (!frame && Date.now() < deadline) {
      guard.assertNoOriginBreach();
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      frame = findBucketFrame(page);
    }
    guard.assertNoOriginBreach();
    if (!frame) {
      throw new OriginRewriteRefusal(
        "BUCKET_FRAME_TIMEOUT",
        `${label}: bucket frame: no frame matching templates/bucket.html appeared within ${timeoutMs}ms`,
        { expectedOrigin: origins?.bucketOrigin },
      );
    }
    // The listener normally records a matching frame's navigation the
    // instant Playwright fires the event, before `findBucketFrame` above
    // ever sees it — this is a short defensive wait for the rare case that
    // ordering differs.
    await guard.waitForQuiet({ quietMs: 150, timeoutMs: 1000 });
    guard.assertNoOriginBreach();
    return {
      frame,
      finalUrl: frame.url(),
      assertNoOriginBreach: guard.assertNoOriginBreach,
    };
  } finally {
    guard.endNavigation();
  }
}
