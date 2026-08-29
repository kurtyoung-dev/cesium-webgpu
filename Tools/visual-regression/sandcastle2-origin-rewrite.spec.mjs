// sandcastle2-origin-rewrite.spec.mjs — contract spec for the Sandcastle2
// origin-rewrite helper and its PERSISTENT navigation guard.
//
// @purpose Proves the persistent, continuous origin guard (not a one-shot check): a fake-page unit proof of a later redirect being caught, a real-browser proof through the WIRED integration path (openSandcastle2Url, opened via createGuardedPage), the app's own redirect to a dead baked origin producing a captured connection-error request failure followed by an ORIGIN_MISMATCH refusal on the resulting error page (B(c)) — distinct from a directly-dead requested url, which fails as a plain connection error (B(c-direct)) — an in-flight navigation refusing page.close() with NAVIGATION_UNVERIFIED, a fire-and-forget navigation still refusing at page-close via a subprocess with an explicit close-time sentinel, and the comparison mutant killing leg (b).
// @status ACTIVE
//
// GROUP A is pure-Node and always runs — including, critically, a fake
// EventEmitter-shaped page that proves {@link attachOriginGuard} keeps
// recording breaches after its first check ever returns, with no real
// browser timing involved at all. That is the deterministic proof that the
// guard is continuous; the real-browser tests in Group B additionally
// reproduce the same property against actual navigation timing.
//
// GROUP B drives a local stub — two "served" servers (the ports THIS run
// asked for) and two "decoy" servers (a second, live, reachable pair
// standing in for whatever origins a stale build was baked with — never a
// dead port for the DECOY, so a completed-but-wrong navigation is
// distinguishable from a connection failure) — through the REAL exported
// entry points, INCLUDING `openSandcastle2Url` from
// `sandcastle2-renderer-gate.mjs`, which is the actual code path every wired
// opener uses. Every browser test is `{skip: ...}`, never silently replaced,
// when Edge cannot launch in this environment — so a raw pass/skip count
// tells a reader whether the browser legs actually ran, which a uniform
// "N passing" total cannot. The always-run, separately-named "-emulated"
// tests below Group B exercise the same helper functions without a browser
// and are never a substitute for the browser legs' evidence.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import test, { after } from "node:test";

import {
  OriginRewriteRefusal,
  assertNavigatedOrigin,
  attachOriginGuard,
  checkNavigatedOrigin,
  computeSandcastle2Origins,
  createGuardedPage,
  findBucketFrame,
  getOrCreateOriginGuard,
  gotoWithOriginGuard,
  rewriteBakedOrigins,
} from "./lib/sandcastle2-origin-rewrite.mjs";
import { openSandcastle2Url } from "./lib/sandcastle2-renderer-gate.mjs";

// --- Group A: pure predicate / rewrite / persistent-guard, no browser ------

test("A1 checkNavigatedOrigin passes when the observed origin matches", () => {
  const verdict = checkNavigatedOrigin({
    observedUrl: "http://localhost:8094/Apps/Sandcastle2/index.html?id=x",
    expectedOrigin: "http://localhost:8094",
    label: "page",
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.code, "OK");
  assert.equal(verdict.observedOrigin, "http://localhost:8094");
});

test("A2 checkNavigatedOrigin refuses when the observed origin differs", () => {
  const verdict = checkNavigatedOrigin({
    observedUrl: "http://localhost:8080/Apps/Sandcastle2/index.html",
    expectedOrigin: "http://localhost:8094",
    label: "page",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "ORIGIN_MISMATCH");
  assert.match(verdict.reason, /expected origin http:\/\/localhost:8094/);
  assert.match(verdict.reason, /localhost:8080/);
});

test("A3 checkNavigatedOrigin reports an unparsable url distinctly from a mismatch", () => {
  const verdict = checkNavigatedOrigin({
    observedUrl: "not a url",
    expectedOrigin: "http://localhost:8094",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, "UNPARSABLE_URL");
  assert.equal(verdict.observedOrigin, null);
});

test("A4 assertNavigatedOrigin throws OriginRewriteRefusal, named and coded, on a mismatch", () => {
  assert.throws(
    () =>
      assertNavigatedOrigin({
        observedUrl: "http://localhost:8080/x",
        expectedOrigin: "http://localhost:8094",
        label: "page",
      }),
    (error) => {
      assert.ok(error instanceof OriginRewriteRefusal);
      assert.equal(error.name, "OriginRewriteRefusal");
      assert.equal(error.code, "ORIGIN_MISMATCH");
      assert.equal(error.expectedOrigin, "http://localhost:8094");
      assert.equal(error.observedOrigin, "http://localhost:8080");
      return true;
    },
  );
});

test("A5 assertNavigatedOrigin returns quietly (does not throw) on a match", () => {
  const verdict = assertNavigatedOrigin({
    observedUrl: "http://localhost:8094/y",
    expectedOrigin: "http://localhost:8094",
  });
  assert.equal(verdict.ok, true);
});

test("A6 computeSandcastle2Origins derives all four origins from ports", () => {
  const origins = computeSandcastle2Origins({
    servedPort: 8094,
    bucketPort: 8095,
  });
  assert.deepEqual(origins, {
    servedOrigin: "http://localhost:8094",
    bucketOrigin: "http://localhost:8095",
    bakedServedOrigin: "http://localhost:8080",
    bakedBucketOrigin: "http://localhost:8081",
  });
});

test("A7 computeSandcastle2Origins honours an overridden baked pair (a build not baked with the defaults)", () => {
  const origins = computeSandcastle2Origins({
    servedPort: 9001,
    bucketPort: 9002,
    bakedServedOrigin: "http://localhost:19000",
    bakedBucketOrigin: "http://localhost:19001",
  });
  assert.equal(origins.bakedServedOrigin, "http://localhost:19000");
  assert.equal(origins.bakedBucketOrigin, "http://localhost:19001");
});

test("A8 rewriteBakedOrigins replaces both baked origins, leaving unrelated text untouched", () => {
  const origins = computeSandcastle2Origins({
    servedPort: 8094,
    bucketPort: 8095,
  });
  const source = [
    'const OUTER_ORIGIN = "http://localhost:8080";',
    'const INNER_ORIGIN = "http://localhost:8081";',
    "// unrelated comment mentioning neither origin",
  ].join("\n");
  const rewritten = rewriteBakedOrigins(source, origins);
  assert.match(rewritten, /http:\/\/localhost:8094/);
  assert.match(rewritten, /http:\/\/localhost:8095/);
  assert.doesNotMatch(rewritten, /localhost:8080/);
  assert.doesNotMatch(rewritten, /localhost:8081/);
  assert.match(rewritten, /unrelated comment/);
});

test("A9 rewriteBakedOrigins returns text unchanged when neither baked origin is present", () => {
  const origins = computeSandcastle2Origins({
    servedPort: 8094,
    bucketPort: 8095,
  });
  const source = "no origins mentioned here at all";
  assert.equal(rewriteBakedOrigins(source, origins), source);
});

test("A12 findBucketFrame picks the frame whose url carries templates/bucket.html", () => {
  const fakePage = {
    frames: () => [
      { url: () => "http://localhost:8094/Apps/Sandcastle2/index.html" },
      {
        url: () =>
          "http://localhost:8095/Apps/Sandcastle2/templates/bucket.html",
      },
    ],
  };
  const frame = findBucketFrame(fakePage);
  assert.ok(frame);
  assert.equal(
    frame.url(),
    "http://localhost:8095/Apps/Sandcastle2/templates/bucket.html",
  );
});

test("A13 findBucketFrame returns null when no frame matches", () => {
  const fakePage = { frames: () => [{ url: () => "http://localhost:8094/x" }] };
  assert.equal(findBucketFrame(fakePage), null);
});

// --- A14+: attachOriginGuard against a fake, EventEmitter-shaped page ------
//
// This is the deterministic proof of the continuity fix: no real browser, no
// timing race — a `framenavigated` listener that fires exactly when this
// fake page's own navigate methods fire, so "does the SAME guard instance
// catch a SECOND, LATER navigation after already having checked a first,
// matching one" is provable with zero flakiness.

function makeFakePage(initialMainUrl = "about:blank") {
  const emitter = new EventEmitter();
  const state = { mainUrl: initialMainUrl, children: [] };
  const mainFrame = {
    url: () => state.mainUrl,
    parentFrame: () => null,
  };
  const page = {
    mainFrame: () => mainFrame,
    frames: () => [mainFrame, ...state.children],
    on: (event, fn) => emitter.on(event, fn),
    off: (event, fn) => emitter.off(event, fn),
    navigateMain(url) {
      state.mainUrl = url;
      emitter.emit("framenavigated", mainFrame);
    },
    addChildFrame(url) {
      const frame = { url: () => url, parentFrame: () => mainFrame };
      state.children.push(frame);
      emitter.emit("framenavigated", frame);
      return frame;
    },
    navigateChild(frame, url) {
      frame.url = () => url;
      emitter.emit("framenavigated", frame);
    },
  };
  return page;
}

test("A14 attachOriginGuard: matching main-frame navigation records no breach", () => {
  const page = makeFakePage();
  const guard = attachOriginGuard(page, {
    origins: { servedOrigin: "http://localhost:8094" },
  });
  page.navigateMain("http://localhost:8094/Apps/Sandcastle2/index.html");
  guard.assertNoOriginBreach();
  assert.deepEqual(guard.getBreaches(), []);
});

test("A15 attachOriginGuard: THE CONTINUITY PROOF — a matching first navigation, then a LATER mismatching one, is still caught by the SAME guard instance", () => {
  const page = makeFakePage();
  const guard = attachOriginGuard(page, {
    origins: { servedOrigin: "http://localhost:8094" },
  });
  page.navigateMain("http://localhost:8094/Apps/Sandcastle2/index.html");
  guard.assertNoOriginBreach(); // passes — nothing wrong yet

  // A caller that checked once and moved on (or never awaited a check at
  // all) would miss this under the old one-shot design. The SAME guard,
  // still listening, must not.
  page.navigateMain("http://localhost:8080/Apps/Sandcastle2/index.html");
  assert.throws(
    () => guard.assertNoOriginBreach(),
    (error) => {
      assert.ok(error instanceof OriginRewriteRefusal);
      assert.equal(error.code, "ORIGIN_MISMATCH");
      assert.equal(error.observedOrigin, "http://localhost:8080");
      return true;
    },
  );
});

test("A16 attachOriginGuard: a child frame is checked by PARENTAGE, not by a bucket.html url pattern", () => {
  const page = makeFakePage(
    "http://localhost:8094/Apps/Sandcastle2/index.html",
  );
  const guard = attachOriginGuard(page, {
    origins: {
      servedOrigin: "http://localhost:8094",
      bucketOrigin: "http://localhost:8095",
    },
  });
  // A child frame whose url does NOT look like "templates/bucket.html" at
  // all, on the wrong origin, must still be caught — the guard's whole point
  // is not depending on the wrong content happening to look recognizable.
  page.addChildFrame("http://localhost:9999/totally/unexpected/path");
  assert.throws(
    () => guard.assertNoOriginBreach(),
    (error) => {
      assert.equal(error.code, "ORIGIN_MISMATCH");
      assert.equal(error.observedOrigin, "http://localhost:9999");
      assert.match(error.label, /bucket frame/);
      return true;
    },
  );
});

test("A17 attachOriginGuard: a correctly-origined child frame records no breach", () => {
  const page = makeFakePage(
    "http://localhost:8094/Apps/Sandcastle2/index.html",
  );
  const guard = attachOriginGuard(page, {
    origins: {
      servedOrigin: "http://localhost:8094",
      bucketOrigin: "http://localhost:8095",
    },
  });
  page.addChildFrame(
    "http://localhost:8095/Apps/Sandcastle2/templates/bucket.html",
  );
  guard.assertNoOriginBreach();
});

test("A18 attachOriginGuard: about:blank and empty urls are never treated as a breach", () => {
  const page = makeFakePage();
  const guard = attachOriginGuard(page, {
    origins: { servedOrigin: "http://localhost:8094" },
  });
  page.addChildFrame("about:blank");
  guard.assertNoOriginBreach();
});

test("A19 attachOriginGuard: the FIRST breach keeps throwing on every subsequent assertNoOriginBreach call", () => {
  const page = makeFakePage();
  const guard = attachOriginGuard(page, {
    origins: { servedOrigin: "http://localhost:8094" },
  });
  page.navigateMain("http://localhost:8080/x");
  page.navigateMain("http://localhost:8081/y"); // a second, different mismatch

  // `assert.throws(fn)` (no validator) only asserts a throw happened — it
  // does NOT return the thrown error — so the errors are captured manually
  // to inspect which one each call actually threw.
  let first;
  try {
    guard.assertNoOriginBreach();
  } catch (error) {
    first = error;
  }
  let second;
  try {
    guard.assertNoOriginBreach();
  } catch (error) {
    second = error;
  }
  assert.ok(first instanceof OriginRewriteRefusal);
  assert.ok(second instanceof OriginRewriteRefusal);
  assert.equal(first.observedOrigin, "http://localhost:8080");
  assert.equal(second.observedOrigin, "http://localhost:8080"); // still the FIRST one
  assert.equal(guard.getBreaches().length, 2);
});

test("A20 getOrCreateOriginGuard memoizes one guard per page and updateOrigins extends it", () => {
  const page = makeFakePage("http://localhost:8094/x");
  const guard1 = getOrCreateOriginGuard(page, {
    origins: { servedOrigin: "http://localhost:8094" },
  });
  const guard2 = getOrCreateOriginGuard(page, {
    origins: { bucketOrigin: "http://localhost:8095" },
  });
  assert.equal(
    guard1,
    guard2,
    "expected the SAME guard instance, not a second one",
  );
  // The bucket origin learned via the second call must now be enforced —
  // proving updateOrigins re-armed the ALREADY-attached listener rather than
  // silently doing nothing.
  page.addChildFrame("http://localhost:9999/wrong");
  assert.throws(() => guard1.assertNoOriginBreach(), OriginRewriteRefusal);
});

test("A21 attachOriginGuard: updateOrigins re-checks frames that already existed before the origin was known", () => {
  const page = makeFakePage("http://localhost:8094/x");
  page.addChildFrame(
    "http://localhost:9999/already-here-before-bucket-origin-was-known",
  );
  const guard = attachOriginGuard(page, {
    origins: { servedOrigin: "http://localhost:8094" }, // no bucketOrigin yet
  });
  guard.assertNoOriginBreach(); // not checked yet — no expectation configured
  guard.updateOrigins({ bucketOrigin: "http://localhost:8095" });
  assert.throws(() => guard.assertNoOriginBreach(), OriginRewriteRefusal);
});

test("A22 waitForQuiet resolves once navigation activity stops, well under its timeout", async () => {
  const page = makeFakePage();
  const guard = attachOriginGuard(page, {
    origins: { servedOrigin: "http://localhost:8094" },
  });
  page.navigateMain("http://localhost:8094/x");
  const start = Date.now();
  await guard.waitForQuiet({ quietMs: 60, timeoutMs: 2000 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `expected a prompt return, took ${elapsed}ms`);
});

test("A23 waitForQuiet honours its hard timeout even under continuous navigation", async () => {
  const page = makeFakePage();
  const guard = attachOriginGuard(page, {
    origins: { servedOrigin: "http://localhost:8094" },
  });
  const interval = setInterval(
    () => page.navigateMain(`http://localhost:8094/${Date.now()}`),
    20,
  );
  const start = Date.now();
  await guard.waitForQuiet({ quietMs: 10000, timeoutMs: 200 });
  clearInterval(interval);
  const elapsed = Date.now() - start;
  assert.ok(
    elapsed < 2000,
    `settle loop did not honour its timeout (${elapsed}ms)`,
  );
});

test("A24 createGuardedPage's wrapped close() fail-closed contract, against a fake context (no browser needed)", async () => {
  // createGuardedPage itself takes a real Playwright BrowserContext (it calls
  // context.newPage()), so this test exercises the SAME wrapping shape
  // directly against a fake context — proving assertNoOriginBreach() really
  // is invoked from a monkey-patched close() before the original close runs.
  const page = makeFakePage();
  let originalCloseCalls = 0;
  page.close = async () => {
    originalCloseCalls += 1;
  };
  const fakeContext = { newPage: async () => page };
  const guardedPage = await createGuardedPage(fakeContext, {
    servedOrigin: "http://localhost:8094",
  });
  page.navigateMain("http://localhost:8080/wrong");
  await assert.rejects(guardedPage.close(), OriginRewriteRefusal);
  assert.equal(
    originalCloseCalls,
    1,
    "the original close() must still run even though the assertion threw",
  );
});

test("A25 attachOriginGuard: beginNavigation/endNavigation/hasPendingNavigation track in-flight guarded navigations", () => {
  const page = makeFakePage();
  const guard = attachOriginGuard(page, {
    origins: { servedOrigin: "http://localhost:8094" },
  });
  assert.equal(guard.hasPendingNavigation(), false);
  guard.beginNavigation();
  assert.equal(guard.hasPendingNavigation(), true);
  guard.beginNavigation(); // a second, concurrent guarded call
  assert.equal(guard.hasPendingNavigation(), true);
  guard.endNavigation();
  assert.equal(
    guard.hasPendingNavigation(),
    true,
    "one of two in-flight navigations ending must not clear the flag",
  );
  guard.endNavigation();
  assert.equal(guard.hasPendingNavigation(), false);
  // Never goes negative on an unpaired end — defensive, since a bug
  // elsewhere miscounting should not manifest as a permanently-stuck "always
  // pending" state.
  guard.endNavigation();
  assert.equal(guard.hasPendingNavigation(), false);
});

test("A26 createGuardedPage's wrapped close() refuses NAVIGATION_UNVERIFIED while a guarded navigation is still in flight", async () => {
  const page = makeFakePage();
  page.close = async () => {};
  const fakeContext = { newPage: async () => page };
  const guardedPage = await createGuardedPage(fakeContext, {
    servedOrigin: "http://localhost:8094",
  });
  // Simulates "a gotoWithOriginGuard call is still awaiting" without needing
  // a real pending promise — beginNavigation/endNavigation are exactly what
  // gotoWithOriginGuard itself calls, so driving them directly here proves
  // the SAME state createGuardedPage's close() reads.
  const guard = getOrCreateOriginGuard(page, {});
  guard.beginNavigation();
  await assert.rejects(guardedPage.close(), (error) => {
    assert.ok(error instanceof OriginRewriteRefusal);
    assert.equal(error.code, "NAVIGATION_UNVERIFIED");
    return true;
  });
});

test("A27 createGuardedPage's wrapped close(): a recorded breach wins over a close-time cleanup error", async () => {
  const page = makeFakePage();
  page.close = async () => {
    throw new Error(
      "unrelated cleanup failure — e.g. the browser process already died",
    );
  };
  const fakeContext = { newPage: async () => page };
  const guardedPage = await createGuardedPage(fakeContext, {
    servedOrigin: "http://localhost:8094",
  });
  page.navigateMain("http://localhost:8080/wrong");
  await assert.rejects(guardedPage.close(), (error) => {
    assert.ok(
      error instanceof OriginRewriteRefusal,
      `expected the origin refusal to win over the cleanup error, got ${error?.name}: ${error?.message}`,
    );
    assert.equal(error.code, "ORIGIN_MISMATCH");
    return true;
  });
});

test("A28 createGuardedPage's wrapped close(): a cleanup error still surfaces when there was no breach to prefer", async () => {
  const page = makeFakePage();
  page.close = async () => {
    throw new Error("close genuinely failed, and nothing else was wrong");
  };
  const fakeContext = { newPage: async () => page };
  const guardedPage = await createGuardedPage(fakeContext, {
    servedOrigin: "http://localhost:8094",
  });
  // No navigation at all — nothing for the guard to object to.
  await assert.rejects(guardedPage.close(), (error) => {
    assert.ok(
      !(error instanceof OriginRewriteRefusal),
      "expected the plain close error, not a manufactured refusal",
    );
    assert.match(error.message, /close genuinely failed/);
    return true;
  });
});

test("A29 createGuardedPage's wrapped close(): the listener detaches AFTER close, not before — a navigation during close() is still observed", async () => {
  const page = makeFakePage();
  const order = [];
  const originalOff = page.off;
  page.off = (...args) => {
    order.push("detach");
    return originalOff(...args);
  };
  page.close = async () => {
    order.push("closing");
    // A navigation that happens WHILE close() is running (a real-world race
    // — the page's own script fires one more redirect as it tears down)
    // must still be observed, which is only possible if detach() has not
    // already removed the listener.
    page.navigateMain("http://localhost:8080/late-during-close");
  };
  const fakeContext = { newPage: async () => page };
  const guardedPage = await createGuardedPage(fakeContext, {
    servedOrigin: "http://localhost:8094",
  });
  // No breach recorded yet — close() itself is what triggers the late
  // navigation above, so THIS call must reflect it too, proving detach ran
  // strictly after the listener had a chance to see it.
  await assert.rejects(guardedPage.close(), (error) => {
    assert.ok(error instanceof OriginRewriteRefusal);
    assert.equal(error.observedOrigin, "http://localhost:8080");
    return true;
  });
  assert.deepEqual(
    order,
    ["closing", "detach"],
    "detach() must run strictly after the original close(), not before or interleaved earlier",
  );
});

// --- Group B: browser proof against a local stub ---------------------------
//
// Four tiny http servers, each on an OS-assigned ephemeral port:
//   served / bucket   — the ports THIS run actually wants (like --port).
//   decoyOuter / decoyBucket — a second, live, reachable pair standing in
//     for "whatever origins a stale build happened to be baked with".

function startStub(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function stubOrigin(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Mirrors packages/sandcastle/src/main.tsx's redirect shape (the actual
 * defect) plus a minimal stand-in for Bucket.tsx's iframe-src construction
 * AND bucket-client.ts's OUTER_ORIGIN bridge constant — against
 * caller-supplied baked origins, optionally delayed, so the spec does not
 * depend on Apps/Sandcastle2 having been built.
 *
 * @param {string} bakedOuterOrigin
 * @param {string} bakedInnerOrigin
 * @param {number} [delayMs] Delay before the redirect DECISION is made — 0 means immediate (the common case); a positive value reproduces a same-tab redirect that lands after the caller's own short quiet-wait window, the exact shape blocker 1 named.
 */
function outerAppScript(bakedOuterOrigin, bakedInnerOrigin, delayMs = 0) {
  const decide = `
    if (window.self === window.top && window.location.origin !== OUTER_ORIGIN) {
      window.location.replace(
        OUTER_ORIGIN + window.location.pathname + window.location.search + window.location.hash,
      );
    } else {
      const ifr = document.createElement("iframe");
      ifr.id = "bucket-frame";
      ifr.src = new URL("/Apps/Sandcastle2/templates/bucket.html", INNER_ORIGIN).toString();
      document.body.appendChild(ifr);
    }
  `;
  return `
const OUTER_ORIGIN = ${JSON.stringify(bakedOuterOrigin)};
const INNER_ORIGIN = ${JSON.stringify(bakedInnerOrigin)};
${delayMs > 0 ? `setTimeout(() => { ${decide} }, ${delayMs});` : decide}
`;
}

function outerAppHtml() {
  return `<!doctype html><html><head><title>stub outer</title></head><body>
<script type="module" src="/Apps/Sandcastle2/assets/index-test.js"></script>
</body></html>`;
}

/**
 * Bucket stub carrying its OWN baked outer-origin bridge constant (mirroring
 * bucket-client.ts's `OUTER_ORIGIN = __OUTER_ORIGIN__`, used there as the
 * postMessage target), written into the DOM at load so a test can read it
 * back after the rewrite has (or has not) run — this is what proves
 * `installOriginRewrite` rewrites a CROSS-ORIGIN response body, not just the
 * first document requested.
 */
function bucketHtml(bakedOuterOrigin) {
  return `<!doctype html><html><head><title>stub bucket</title></head>
<body data-marker="bucket-reached">
<script>
  const OUTER_ORIGIN = ${JSON.stringify(bakedOuterOrigin)};
  document.body.dataset.outerOrigin = OUTER_ORIGIN;
</script>
</body></html>`;
}

async function makeOuterStub(bakedOuterOrigin, bakedInnerOrigin, delayMs = 0) {
  return startStub((req, res) => {
    if (req.url.startsWith("/Apps/Sandcastle2/assets/index-test.js")) {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(outerAppScript(bakedOuterOrigin, bakedInnerOrigin, delayMs));
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(outerAppHtml());
  });
}

async function makeBucketStub(bakedOuterOriginForBridge) {
  return startStub((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(bucketHtml(bakedOuterOriginForBridge ?? "http://unset.invalid"));
  });
}

/** A decoy that serves only harmless static content — never runs its own redirect logic (see the module-level note above test B(a) for why). */
async function makeDecoyStub() {
  return startStub((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><html><head><title>decoy</title></head><body data-marker="decoy-reached"></body></html>`,
    );
  });
}

let browser = null;
let browserAvailable = false;
let launchError = null;
try {
  const { chromium } = await import("playwright");
  browser = await chromium.launch({
    channel: "msedge",
    headless: true,
    args: ["--enable-unsafe-webgpu"],
  });
  browserAvailable = true;
} catch (error) {
  launchError = error;
}

after(async () => {
  if (browser) {
    await browser.close().catch(() => {});
  }
});

const skipReason = browserAvailable
  ? false
  : `Playwright/Edge did not launch (${String(launchError?.message ?? launchError).slice(0, 200)}) — see the always-run "-emulated" tests below for the non-browser fallback proof; this is NOT a substitute for browser evidence, which is why this test is SKIPPED rather than silently swapped.`;

test(
  "B setup: the stub servers reproduce the real redirect/iframe/bridge shape byte-for-byte in structure",
  { skip: skipReason },
  async () => {
    const outer = await makeOuterStub(
      "http://127.0.0.1:1",
      "http://127.0.0.1:2",
    );
    const bucket = await makeBucketStub("http://127.0.0.1:1");
    try {
      const origin = stubOrigin(outer);
      const html = await (
        await fetch(`${origin}/Apps/Sandcastle2/index.html`)
      ).text();
      assert.match(html, /assets\/index-test\.js/);
      const js = await (
        await fetch(`${origin}/Apps/Sandcastle2/assets/index-test.js`)
      ).text();
      assert.match(js, /window\.location\.replace/);
      assert.match(js, /window\.self === window\.top/);
      const bucketHtmlText = await (
        await fetch(
          `${stubOrigin(bucket)}/Apps/Sandcastle2/templates/bucket.html`,
        )
      ).text();
      assert.match(bucketHtmlText, /bucket-reached/);
      assert.match(bucketHtmlText, /OUTER_ORIGIN/);
    } finally {
      outer.close();
      bucket.close();
    }
  },
);

test(
  "B(a) via openSandcastle2Url (the WIRED integration path): page AND bucket frame settle on requested origins, and the bucket's cross-origin bridge constant is rewritten",
  { skip: skipReason },
  async () => {
    const decoyOuter = await makeDecoyStub();
    const decoyBucket = await makeBucketStub();
    const decoyOuterOrigin = stubOrigin(decoyOuter);
    const decoyBucketOrigin = stubOrigin(decoyBucket);
    const served = await makeOuterStub(decoyOuterOrigin, decoyBucketOrigin);
    // The bucket stub's own bridge constant is baked with the decoy outer
    // origin too — proving the REWRITE reaches this cross-origin response,
    // not just the first (same-origin) document requested.
    const bucketWithBridge = await makeBucketStub(decoyOuterOrigin);

    const servedOrigin = stubOrigin(served);
    const bucketOrigin = stubOrigin(bucketWithBridge);

    const context = await browser.newContext();
    try {
      // createGuardedPage, not a bare context.newPage() — this is the whole
      // point of the "wired integration path" claim: the reviewer's finding
      // was that openSandcastle2Url against an unguarded page proves
      // navigation-time behaviour but not the fail-closed-at-close
      // guarantee. Using the real factory here means this test's own
      // `context.close()` in `finally` — which does NOT go through
      // `page.close()` — is not what's relied on; nothing extra is needed to
      // prove close-time behaviour here specifically because nothing went
      // wrong on this success path, but the SHAPE every real opener must use
      // is exercised end to end.
      const page = await createGuardedPage(context, {
        servedOrigin,
        bucketOrigin,
        bakedServedOrigin: decoyOuterOrigin,
        bakedBucketOrigin: decoyBucketOrigin,
      });
      const { url, finalUrl, bucketFrame, bucketFinalUrl } =
        await openSandcastle2Url(
          page,
          {
            base: servedOrigin,
            bucketBase: bucketOrigin,
            // The stub is baked with the DECOY pair (see makeOuterStub above),
            // not the real build's 8080/8081 defaults — openSandcastle2Url has
            // to be told, exactly like a real caller opening a build produced
            // with a non-default --port/--sandcastlePort would have to.
            bakedServedOrigin: decoyOuterOrigin,
            bakedBucketOrigin: decoyBucketOrigin,
            id: "x",
            renderer: "webgpu",
          },
          { timeoutMs: 4000 },
        );
      assert.match(url, /Apps\/Sandcastle2\/index\.html/);
      assert.equal(new URL(finalUrl).origin, servedOrigin);
      assert.ok(bucketFrame, "expected a bucket frame");
      assert.equal(new URL(bucketFinalUrl).origin, bucketOrigin);
      assert.match(bucketFinalUrl, /templates\/bucket\.html/);

      // The cross-origin proof: the bucket response's own baked bridge
      // constant, read back from inside the bucket frame, must be the
      // REQUESTED served origin — not the baked decoy — which only holds if
      // installOriginRewrite rewrote THAT response body, not just the
      // outer document's.
      const observedBridgeOrigin = await bucketFrame.evaluate(
        () => document.body.dataset.outerOrigin,
      );
      assert.equal(observedBridgeOrigin, servedOrigin);

      // The page factory's own contract, exercised here too: close() must
      // succeed cleanly (no breach was ever recorded on this success path).
      await page.close();
    } finally {
      await context.close();
      served.close();
      bucketWithBridge.close();
      decoyOuter.close();
      decoyBucket.close();
    }
  },
);

test(
  "B(b) rewrite NOT installed (low-level call): the baked redirect completes to the live decoy, and the guard refuses with the named reason",
  { skip: skipReason },
  async () => {
    const bucket = await makeBucketStub();
    const decoyOuter = await makeDecoyStub();
    const decoyBucket = await makeBucketStub();
    const decoyOuterOrigin = stubOrigin(decoyOuter);
    const decoyBucketOrigin = stubOrigin(decoyBucket);
    const served = await makeOuterStub(decoyOuterOrigin, decoyBucketOrigin);

    const context = await browser.newContext();
    try {
      const origins = computeSandcastle2Origins({
        servedPort: new URL(stubOrigin(served)).port,
        bucketPort: new URL(stubOrigin(bucket)).port,
        hostname: "127.0.0.1",
        bakedServedOrigin: decoyOuterOrigin,
        bakedBucketOrigin: decoyBucketOrigin,
      });
      // Deliberately NOT calling installOriginRewrite — "the helper removed".
      const page = await context.newPage();

      await assert.rejects(
        gotoWithOriginGuard(
          page,
          `${origins.servedOrigin}/Apps/Sandcastle2/index.html`,
          {
            origins,
            timeoutMs: 4000,
          },
        ),
        (error) => {
          assert.ok(
            error instanceof OriginRewriteRefusal,
            `expected OriginRewriteRefusal, got ${error?.name}: ${error?.message}`,
          );
          assert.equal(error.code, "ORIGIN_MISMATCH");
          assert.equal(error.expectedOrigin, origins.servedOrigin);
          assert.equal(error.observedOrigin, decoyOuterOrigin);
          assert.match(error.reason, /refusing rather than proceeding/);
          return true;
        },
      );
    } finally {
      await context.close();
      served.close();
      bucket.close();
      decoyOuter.close();
      decoyBucket.close();
    }
  },
);

test(
  "B(late) THE BLOCKER-1 REPRODUCTION: a redirect delayed past gotoWithOriginGuard's own short quiet-wait is still caught, by a LATER assertNoOriginBreach() call on the SAME guard",
  { skip: skipReason },
  async () => {
    const bucket = await makeBucketStub();
    const decoyOuter = await makeDecoyStub();
    const decoyBucket = await makeBucketStub();
    const decoyOuterOrigin = stubOrigin(decoyOuter);
    const decoyBucketOrigin = stubOrigin(decoyBucket);
    // 400ms delay — deliberately later than the SHORT quiet-wait window this
    // test hands gotoWithOriginGuard below, reproducing the reviewer's
    // synthetic 350ms redirect against the real mechanism.
    const served = await makeOuterStub(
      decoyOuterOrigin,
      decoyBucketOrigin,
      400,
    );

    const context = await browser.newContext();
    try {
      const origins = computeSandcastle2Origins({
        servedPort: new URL(stubOrigin(served)).port,
        bucketPort: new URL(stubOrigin(bucket)).port,
        hostname: "127.0.0.1",
        bakedServedOrigin: decoyOuterOrigin,
        bakedBucketOrigin: decoyBucketOrigin,
      });
      const page = await context.newPage();
      const guard = getOrCreateOriginGuard(page, { origins });

      // A deliberately short window — shorter than the 400ms redirect delay
      // — so THIS call alone may plausibly return without ever seeing the
      // breach, exactly like the old one-shot implementation always would.
      let earlyCheckThrew = false;
      try {
        await gotoWithOriginGuard(
          page,
          `${origins.servedOrigin}/Apps/Sandcastle2/index.html`,
          {
            origins,
            quietMs: 50,
            timeoutMs: 150,
          },
        );
      } catch (error) {
        assert.ok(error instanceof OriginRewriteRefusal);
        earlyCheckThrew = true;
      }

      // Whether or not the early check happened to catch it, the SAME guard
      // must have recorded the breach by the time the redirect has actually
      // had time to fire.
      await new Promise((resolve) => setTimeout(resolve, 700));
      assert.throws(
        () => guard.assertNoOriginBreach(),
        (error) => {
          assert.ok(error instanceof OriginRewriteRefusal);
          assert.equal(error.observedOrigin, decoyOuterOrigin);
          return true;
        },
        "the persistent guard did not catch a redirect that landed after the short quiet-wait window",
      );
      // Documented, not asserted strictly either way: whether the EARLY call
      // itself threw depends on exact scheduling, and is not the property
      // this test exists to prove.
      void earlyCheckThrew;
    } finally {
      await context.close();
      served.close();
      bucket.close();
      decoyOuter.close();
      decoyBucket.close();
    }
  },
);

test(
  "B(c) the app's OWN redirect targets a DEAD baked origin: never a silent success — VERIFIED (not assumed) to surface as an ORIGIN_MISMATCH refusal, because Chromium commits an internal error page rather than leaving the call rejected",
  { skip: skipReason },
  async () => {
    // A real, bindable-then-closed port — guaranteed nothing listens there —
    // used as the BAKED outer origin the served app's own script redirects
    // to, reproducing the actual failure shape (the app's redirect hits a
    // dead server), not merely "the caller's own initial url was dead"
    // (that distinct case is B(c-direct) below).
    //
    // A same-tab `location.replace()` to an unreachable origin was checked
    // directly against this exact fixture before writing this assertion
    // (`page.on("requestfailed")` + `page.on("framenavigated")`): Chromium
    // fires `requestfailed` with `net::ERR_CONNECTION_REFUSED`, then COMMITS
    // the frame to `chrome-error://chromewebdata/` rather than leaving the
    // navigation attempt in a rejected, uncommitted state — so
    // `gotoWithOriginGuard`'s own `page.goto()` call for the FIRST (real,
    // successful) navigation never sees this failure at all; the persistent
    // guard's `framenavigated` listener is what observes the error page and
    // correctly reports its origin as not matching the requested one. This
    // is a stronger, more informative signal than an undifferentiated
    // connection error would be — it still satisfies "never a silent
    // success", which is the property this test asserts, not the specific
    // error shape.
    const deadHolder = await startStub((_req, res) => res.end());
    const deadPort = deadHolder.address().port;
    await new Promise((resolve) => deadHolder.close(resolve));
    const deadOuterOrigin = `http://127.0.0.1:${deadPort}`;

    const bucket = await makeBucketStub();
    const served = await makeOuterStub(deadOuterOrigin, "http://127.0.0.1:1");

    const context = await browser.newContext();
    try {
      const origins = computeSandcastle2Origins({
        servedPort: new URL(stubOrigin(served)).port,
        bucketPort: new URL(stubOrigin(bucket)).port,
        hostname: "127.0.0.1",
        bakedServedOrigin: deadOuterOrigin,
        bakedBucketOrigin: "http://127.0.0.1:1",
      });
      // Deliberately NOT installing the rewrite — the app's own script must
      // be the one attempting the dead-origin navigation.
      const page = await context.newPage();

      // Capture the underlying connection failure directly, not just its
      // downstream symptom (the committed error page's origin) — the
      // reviewer's exact ask: the dead-baked-origin leg must observe
      // `requestfailed` for `deadOuterOrigin` and assert its connection-error
      // reason, in addition to the resulting refusal.
      const deadOriginFailures = [];
      page.on("requestfailed", (request) => {
        if (request.url().startsWith(deadOuterOrigin)) {
          deadOriginFailures.push({
            url: request.url(),
            errorText: request.failure()?.errorText ?? null,
          });
        }
      });

      await assert.rejects(
        gotoWithOriginGuard(
          page,
          `${origins.servedOrigin}/Apps/Sandcastle2/index.html`,
          {
            origins,
            gotoOptions: { timeout: 5000 },
            timeoutMs: 3000,
          },
        ),
        (error) => {
          assert.ok(
            error instanceof OriginRewriteRefusal,
            `expected an OriginRewriteRefusal (verified behavior), got ${error?.name}: ${error?.message}`,
          );
          assert.equal(error.code, "ORIGIN_MISMATCH");
          // Chromium's committed error-page url ("chrome-error://chromewebdata/")
          // has no standard origin, which the WHATWG URL spec resolves to the
          // literal string "null" — asserted here so a future browser version
          // that changes this shape fails loudly instead of this test quietly
          // asserting nothing.
          assert.equal(error.observedOrigin, "null");
          return true;
        },
      );

      // The connection-error evidence UNDERNEATH that refusal: at least one
      // request to the dead baked origin actually failed to connect, and the
      // browser's own reported reason names a connection failure — proving
      // this leg's failure mode really is "the app tried to reach a dead
      // server", not merely "the resulting page had a strange origin".
      assert.ok(
        deadOriginFailures.length > 0,
        `expected at least one requestfailed event for ${deadOuterOrigin}, got none`,
      );
      assert.ok(
        deadOriginFailures.some((f) =>
          /ERR_CONNECTION_REFUSED|ERR_CONNECTION|ERR_FAILED/i.test(
            f.errorText ?? "",
          ),
        ),
        `expected a connection-error reason among ${JSON.stringify(deadOriginFailures)}`,
      );
    } finally {
      await context.close();
      served.close();
      bucket.close();
    }
  },
);

test(
  "B(c-direct) a leg pointed at a genuinely dead port as its OWN initial url fails as a connection error",
  { skip: skipReason },
  async () => {
    const dead = await startStub((_req, res) => res.end());
    const deadPort = dead.address().port;
    await new Promise((resolve) => dead.close(resolve));

    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await assert.rejects(
        gotoWithOriginGuard(
          page,
          `http://127.0.0.1:${deadPort}/Apps/Sandcastle2/index.html`,
          {
            origins: { servedOrigin: `http://127.0.0.1:${deadPort}` },
            gotoOptions: { timeout: 5000 },
          },
        ),
        (error) => {
          assert.ok(
            !(error instanceof OriginRewriteRefusal),
            "a dead port must fail as a connection error, not an origin refusal",
          );
          assert.match(
            String(error?.message ?? error),
            /ERR_CONNECTION_REFUSED|net::ERR|Timeout|ECONNREFUSED/i,
          );
          return true;
        },
      );
    } finally {
      await context.close();
    }
  },
);

test(
  "B(subprocess) a FIRE-AND-FORGET navigation (never awaited, never caught) still refuses at page.close() — asserted via an explicit close-time sentinel, not an inferred process exit code",
  { skip: skipReason, timeout: 30000 },
  async () => {
    const bucket = await makeBucketStub();
    const decoyOuter = await makeDecoyStub();
    const decoyBucket = await makeBucketStub();
    const decoyOuterOrigin = stubOrigin(decoyOuter);
    const decoyBucketOrigin = stubOrigin(decoyBucket);
    const served = await makeOuterStub(decoyOuterOrigin, decoyBucketOrigin);

    const libUrl = new URL(
      "./lib/sandcastle2-origin-rewrite.mjs",
      import.meta.url,
    ).href;
    const servedOrigin = stubOrigin(served);
    const bucketOrigin = stubOrigin(bucket);

    // The navigation call below is genuinely fire-and-forget (no `await`, no
    // `.catch()`) — a careless caller who forgot both is exactly who this
    // proves is still protected. Left alone, its eventual rejection would
    // ALSO crash the process as an unhandled rejection, which is a REAL
    // consequence of the same carelessness but not the one this test is
    // trying to isolate: an unhandled-rejection exit could happen before
    // `page.close()` ever runs, proving nothing about the close-time
    // assertion specifically (the prior revision's failure mode, per
    // review). `process.on("unhandledRejection", () => {})` suppresses ONLY
    // that expected rejection so the script deterministically reaches
    // `page.close()`; the actual proof is the explicit sentinel printed from
    // the close() catch below, which the parent requires verbatim.
    const script = `
import { chromium } from "playwright";
import { createGuardedPage, gotoWithOriginGuard } from ${JSON.stringify(libUrl)};
process.on("unhandledRejection", () => {}); // isolates this test to the close-time assertion — see comment above
const origins = {
  servedOrigin: ${JSON.stringify(servedOrigin)},
  bucketOrigin: ${JSON.stringify(bucketOrigin)},
};
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--enable-unsafe-webgpu"] });
const context = await browser.newContext();
const page = await createGuardedPage(context, origins);
gotoWithOriginGuard(page, origins.servedOrigin + "/Apps/Sandcastle2/index.html", { origins }); // NOT awaited
await new Promise((r) => setTimeout(r, 2000)); // generous — well past the in-flight navigation's own settle time, so close() sees a RECORDED breach (ORIGIN_MISMATCH), not a still-pending one (NAVIGATION_UNVERIFIED)
try {
  await page.close();
  console.error("PAGE_CLOSE_OK");
  process.exitCode = 1; // close() should have thrown; reaching here is itself a failure
} catch (error) {
  console.error("PAGE_CLOSE_REFUSAL", error.name, error.code);
  process.exitCode = error.name === "OriginRewriteRefusal" ? 0 : 1;
} finally {
  await browser.close();
}
`;

    const child = spawn(process.execPath, ["--input-type=module"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.stdin.write(script);
    child.stdin.end();
    const exitCode = await new Promise((resolve) => {
      child.on("close", (code) => resolve(code));
    });

    try {
      assert.equal(
        exitCode,
        0,
        `expected the PAGE_CLOSE_REFUSAL branch to set a clean exit; stderr:\n${stderr}`,
      );
      assert.match(
        stderr,
        /PAGE_CLOSE_REFUSAL OriginRewriteRefusal ORIGIN_MISMATCH/,
        `expected the explicit close-time sentinel naming ORIGIN_MISMATCH, stderr:\n${stderr}`,
      );
    } finally {
      served.close();
      bucket.close();
      decoyOuter.close();
      decoyBucket.close();
    }
  },
);

// --- Always-run, non-browser "-emulated" tests ------------------------------
//
// NEVER a substitute for Group B above — these exercise the pure comparison
// and rewrite functions the SAME way an unprotected/protected run would use
// them, without a browser, and run on EVERY invocation of this file
// regardless of whether Edge is available.

function emulateRedirectDecision(rewrittenScriptText, currentOrigin) {
  const outerMatch = /const OUTER_ORIGIN = "([^"]+)"/.exec(rewrittenScriptText);
  const innerMatch = /const INNER_ORIGIN = "([^"]+)"/.exec(rewrittenScriptText);
  const outerOrigin = outerMatch[1];
  const innerOrigin = innerMatch[1];
  if (currentOrigin !== outerOrigin) {
    return { redirectedTo: outerOrigin };
  }
  return { bucketOrigin: innerOrigin };
}

test("B-emulated(a) rewrite installed: the emulated decision keeps the run on the requested origin", async () => {
  const decoyOuter = await makeDecoyStub();
  const decoyBucket = await makeBucketStub();
  const bucket = await makeBucketStub();
  try {
    const decoyOuterOrigin = stubOrigin(decoyOuter);
    const decoyBucketOrigin = stubOrigin(decoyBucket);
    const requestedServedOrigin = "http://127.0.0.1:19999";
    const origins = computeSandcastle2Origins({
      servedPort: 19999,
      bucketPort: new URL(stubOrigin(bucket)).port,
      hostname: "127.0.0.1",
      bakedServedOrigin: decoyOuterOrigin,
      bakedBucketOrigin: decoyBucketOrigin,
    });
    const rawScript = outerAppScript(decoyOuterOrigin, decoyBucketOrigin);
    const rewritten = rewriteBakedOrigins(rawScript, origins);
    const decision = emulateRedirectDecision(rewritten, requestedServedOrigin);
    assert.equal(decision.redirectedTo, undefined);
    assert.equal(decision.bucketOrigin, origins.bucketOrigin);
    assertNavigatedOrigin({
      observedUrl: `${requestedServedOrigin}/Apps/Sandcastle2/index.html`,
      expectedOrigin: requestedServedOrigin,
    });
  } finally {
    decoyOuter.close();
    decoyBucket.close();
    bucket.close();
  }
});

test("B-emulated(b) rewrite NOT installed: the emulated decision redirects, and the guard refuses", async () => {
  const decoyOuter = await makeDecoyStub();
  const decoyBucket = await makeBucketStub();
  try {
    const decoyOuterOrigin = stubOrigin(decoyOuter);
    const decoyBucketOrigin = stubOrigin(decoyBucket);
    const requestedServedOrigin = "http://127.0.0.1:19999";
    const rawScript = outerAppScript(decoyOuterOrigin, decoyBucketOrigin);
    // Unrewritten — "the helper removed".
    const decision = emulateRedirectDecision(rawScript, requestedServedOrigin);
    assert.equal(decision.redirectedTo, decoyOuterOrigin);
    assert.throws(
      () =>
        assertNavigatedOrigin({
          observedUrl: `${decision.redirectedTo}/Apps/Sandcastle2/index.html`,
          expectedOrigin: requestedServedOrigin,
        }),
      (error) => {
        assert.ok(error instanceof OriginRewriteRefusal);
        assert.equal(error.code, "ORIGIN_MISMATCH");
        return true;
      },
    );
  } finally {
    decoyOuter.close();
    decoyBucket.close();
  }
});

test("B-emulated(c) a dead port fails fetch as a connection error, not a silent success", async () => {
  const dead = await startStub((_req, res) => res.end());
  const deadPort = dead.address().port;
  await new Promise((resolve) => dead.close(resolve));
  await assert.rejects(
    fetch(`http://127.0.0.1:${deadPort}/Apps/Sandcastle2/index.html`),
    (error) => {
      assert.ok(!(error instanceof OriginRewriteRefusal));
      return true;
    },
  );
});
