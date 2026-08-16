// @purpose Behavioral tests for MoonDecodedSourceCache: canonical URL keying, dedupe, deferred decode settlement and decoded-source close accounting.
// @status ACTIVE

import test from "node:test";
import assert from "node:assert/strict";

import Resource from "../../packages/engine/Source/Core/Resource.js";
import {
  MoonDecodedSourceCache,
  canonicalizeMoonDecodedSourceUrl,
  createMoonDecodedSourceKey,
  normalizeMoonDecodedSourceOptions,
} from "../../packages/engine/Source/Core/MoonDecodedSourceCache.js";

const testBaseUrl = "https://moon.invalid/assets/";

function canonicalizeUrl(url) {
  return new URL(String(url), testBaseUrl).href;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 8) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function makeSource(name, byteLength = 16, closeError) {
  return {
    name,
    byteLength,
    closeCount: 0,
    close() {
      this.closeCount++;
      if (closeError !== undefined) {
        throw closeError;
      }
    },
  };
}

function makeCache(options = {}) {
  return new MoonDecodedSourceCache({
    maxEntries: options.maxEntries ?? 8,
    maxBytes: options.maxBytes ?? 1024,
    canonicalizeUrl,
    fetchSource: options.fetchSource,
    decodeSource: options.decodeSource,
    estimateBytes:
      options.estimateBytes ?? ((source) => source.byteLength ?? 0),
    closeSource:
      options.closeSource ??
      ((source) => {
        source.close?.();
      }),
    onCleanupError: options.onCleanupError,
  });
}

async function acquireAndRelease(cache, url, decodeOptions) {
  const lease = await acquireReady(cache, url, decodeOptions);
  const source = lease.source;
  assert.equal(lease.release(), true);
  return source;
}

async function acquireReady(cache, url, decodeOptions) {
  const lease = cache.acquire(url, decodeOptions);
  assert.equal(await lease.ready, lease);
  return lease;
}

test("cache keys use the exact canonical URL and every decode axis", () => {
  assert.equal(
    canonicalizeMoonDecodedSourceUrl(
      "https://moon.invalid/moon.png?edition=1#client-fragment",
    ),
    "https://moon.invalid/moon.png?edition=1",
  );
  assert.throws(
    () =>
      canonicalizeMoonDecodedSourceUrl(
        new Resource({
          url: "https://moon.invalid/moon.png",
          headers: { "X-Test-Identity": "distinct-request" },
        }),
      ),
    /nonempty string/,
  );

  const defaults = normalizeMoonDecodedSourceOptions();
  assert.deepEqual(defaults, {
    imageOrientation: "from-image",
    colorSpaceConversion: "default",
    premultiplyAlpha: "default",
  });
  assert.equal(Object.isFrozen(defaults), true);

  const relative = createMoonDecodedSourceKey(
    "moon.png?edition=1",
    undefined,
    canonicalizeUrl,
  );
  const absolute = createMoonDecodedSourceKey(
    "https://moon.invalid/assets/moon.png?edition=1",
    undefined,
    canonicalizeUrl,
  );
  assert.equal(relative.key, absolute.key);
  assert.equal(relative.exactUrl, absolute.exactUrl);
  assert.equal(Object.isFrozen(relative), true);
  assert.equal(Object.isFrozen(relative.decodeOptions), true);

  const changedUrl = createMoonDecodedSourceKey(
    "moon.png?edition=2",
    undefined,
    canonicalizeUrl,
  );
  const flipped = createMoonDecodedSourceKey(
    "moon.png?edition=1",
    { imageOrientation: "flipY" },
    canonicalizeUrl,
  );
  const unconverted = createMoonDecodedSourceKey(
    "moon.png?edition=1",
    { colorSpaceConversion: "none" },
    canonicalizeUrl,
  );
  const premultiplied = createMoonDecodedSourceKey(
    "moon.png?edition=1",
    { premultiplyAlpha: "premultiply" },
    canonicalizeUrl,
  );
  assert.notEqual(changedUrl.key, relative.key);
  assert.notEqual(flipped.key, relative.key);
  assert.notEqual(unconverted.key, relative.key);
  assert.notEqual(premultiplied.key, relative.key);

  assert.throws(
    () => normalizeMoonDecodedSourceOptions({ imageOrientation: "upside" }),
    RangeError,
  );
  assert.throws(
    () =>
      normalizeMoonDecodedSourceOptions({
        colorSpaceConversion: "browser-dependent",
      }),
    RangeError,
  );
  assert.throws(
    () => normalizeMoonDecodedSourceOptions({ premultiplyAlpha: "always" }),
    RangeError,
  );
  assert.throws(
    () => new MoonDecodedSourceCache({ maxEntries: -1 }),
    RangeError,
  );
  assert.throws(
    () => new MoonDecodedSourceCache({ maxBytes: 1.5 }),
    RangeError,
  );
});

test("concurrent acquires coalesce and ready hits return unique leases", async () => {
  const gate = deferred();
  const source = makeSource("shared");
  let fetches = 0;
  let decodes = 0;
  const cache = makeCache({
    fetchSource() {
      fetches++;
      return gate.promise;
    },
    decodeSource(value) {
      decodes++;
      return value;
    },
  });

  const first = cache.acquire("shared.png");
  const second = cache.acquire("./shared.png");
  assert.equal(fetches, 1);
  assert.equal(decodes, 0);
  gate.resolve(source);

  const [firstReady, secondReady] = await Promise.all([
    first.ready,
    second.ready,
  ]);
  assert.equal(firstReady, first);
  assert.equal(secondReady, second);
  assert.notEqual(first, second);
  assert.equal(first.source, source);
  assert.equal(second.source, source);
  assert.equal(fetches, 1);
  assert.equal(decodes, 1);
  assert.deepEqual(
    {
      misses: cache.getDiagnostics().misses,
      coalesced: cache.getDiagnostics().coalesced,
      activeLeases: cache.getDiagnostics().activeLeases,
    },
    { misses: 1, coalesced: 1, activeLeases: 2 },
  );

  assert.equal(first.release(), true);
  assert.equal(first.release(), false);
  assert.equal(first.source, undefined);
  assert.equal(second.release(), true);

  const hit = await acquireReady(cache, "shared.png");
  assert.notEqual(hit, first);
  assert.notEqual(hit, second);
  assert.equal(hit.source, source);
  assert.equal(cache.getDiagnostics().hits, 1);
  assert.equal(fetches, 1);
  assert.equal(hit.release(), true);
  assert.equal(source.closeCount, 0);

  assert.deepEqual(cache.clear(), { evicted: 1, deferred: 0 });
  assert.equal(source.closeCount, 1);
});

test("fetch and decoded source ownership transfer without double close", async () => {
  const fetched = makeSource("fetched");
  const decoded = makeSource("decoded", 24);
  const cache = makeCache({
    fetchSource: async () => fetched,
    decodeSource: async () => decoded,
  });

  const lease = await acquireReady(cache, "ownership.png");
  assert.equal(lease.source, decoded);
  assert.equal(fetched.closeCount, 1);
  assert.equal(decoded.closeCount, 0);

  lease.release();
  cache.clear();
  assert.equal(fetched.closeCount, 1);
  assert.equal(decoded.closeCount, 1);
});

test("entry pressure evicts the least recently used zero-reference source", async () => {
  const sources = new Map();
  const cache = makeCache({
    maxEntries: 2,
    fetchSource: async (url) => {
      const source = makeSource(url);
      sources.set(url, source);
      return source;
    },
    decodeSource: async (source) => source,
  });

  const sourceA = await acquireAndRelease(cache, "a.png");
  const sourceB = await acquireAndRelease(cache, "b.png");
  const refreshedA = await acquireAndRelease(cache, "a.png");
  assert.equal(refreshedA, sourceA);
  const sourceC = await acquireAndRelease(cache, "c.png");

  assert.equal(sourceA.closeCount, 0);
  assert.equal(sourceB.closeCount, 1);
  assert.equal(sourceC.closeCount, 0);
  assert.equal(cache.getDiagnostics().entryCount, 2);
  assert.equal(cache.getDiagnostics().evictions, 1);
  assert.equal(sources.size, 3);

  cache.clear();
  assert.equal(sourceA.closeCount, 1);
  assert.equal(sourceB.closeCount, 1);
  assert.equal(sourceC.closeCount, 1);
});

test("byte pressure pins active sources and retires an oversized source on release", async () => {
  const sources = [];
  const cache = makeCache({
    maxBytes: 20,
    fetchSource: async (url) => {
      const source = makeSource(url, url.endsWith("c.png") ? 24 : 16);
      sources.push(source);
      return source;
    },
    decodeSource: async (source) => source,
  });

  const sourceA = await acquireAndRelease(cache, "a.png");
  const leaseB = await acquireReady(cache, "b.png");
  const sourceB = leaseB.source;
  assert.equal(sourceA.closeCount, 1);
  assert.equal(sourceB.closeCount, 0);
  assert.equal(cache.getDiagnostics().overByteBudget, false);
  leaseB.release();

  const leaseC = await acquireReady(cache, "c.png");
  const sourceC = leaseC.source;
  let diagnostics = cache.getDiagnostics();
  assert.equal(sourceB.closeCount, 1);
  assert.equal(sourceC.closeCount, 0);
  assert.equal(diagnostics.overByteBudget, true);
  assert.equal(diagnostics.activeLeases, 1);

  leaseC.release();
  diagnostics = cache.getDiagnostics();
  assert.equal(sourceC.closeCount, 1);
  assert.equal(diagnostics.entryCount, 0);
  assert.equal(diagnostics.totalBytes, 0);
  assert.equal(diagnostics.overByteBudget, false);
  assert.equal(sources.length, 3);
});

test("default byte accounting uses intrinsic decoded image dimensions", async () => {
  const source = makeSource("intrinsic");
  source.naturalWidth = 4;
  source.naturalHeight = 4;
  source.width = 1;
  source.height = 1;
  const cache = new MoonDecodedSourceCache({
    maxEntries: 4,
    maxBytes: 32,
    canonicalizeUrl,
    fetchSource: async () => source,
    decodeSource: async (value) => value,
    closeSource(value) {
      value.close();
    },
  });

  const lease = await acquireReady(cache, "intrinsic.png");
  assert.equal(lease.byteLength, 64);
  assert.equal(cache.getDiagnostics().totalBytes, 64);
  assert.equal(cache.getDiagnostics().overByteBudget, true);
  lease.release();
  assert.equal(source.closeCount, 1);
  assert.equal(cache.getDiagnostics().entryCount, 0);
});

test("pending loads stay pinned through clear and never duplicate decode work", async () => {
  const gate = deferred();
  const source = makeSource("pending");
  let fetches = 0;
  let decodes = 0;
  const cache = makeCache({
    maxEntries: 0,
    maxBytes: 0,
    fetchSource() {
      fetches++;
      return gate.promise;
    },
    decodeSource(value) {
      decodes++;
      return value;
    },
  });

  const first = cache.acquire("pending.png");
  assert.deepEqual(cache.clear(), { evicted: 0, deferred: 1 });
  const second = cache.acquire("pending.png");
  assert.equal(fetches, 1);
  assert.equal(cache.getDiagnostics().pendingEntries, 1);
  assert.equal(cache.getDiagnostics().overEntryBudget, true);

  gate.resolve(source);
  await Promise.all([first.ready, second.ready]);
  assert.equal(decodes, 1);
  assert.equal(cache.getDiagnostics().activeLeases, 2);
  assert.equal(source.closeCount, 0);
  first.release();
  assert.equal(source.closeCount, 0);
  second.release();
  assert.equal(source.closeCount, 1);
  assert.equal(cache.getDiagnostics().entryCount, 0);
});

test("cancelling one of two pending leases preserves the shared load", async () => {
  const gate = deferred();
  const source = makeSource("remaining-waiter");
  let signal;
  let aborts = 0;
  let decodes = 0;
  const cache = makeCache({
    fetchSource(_url, _decodeOptions, fetchSignal) {
      signal = fetchSignal;
      signal.addEventListener("abort", () => aborts++);
      return gate.promise;
    },
    decodeSource(value) {
      decodes++;
      return value;
    },
  });

  const cancelled = cache.acquire("two-waiters.png");
  const remaining = cache.acquire("two-waiters.png");
  let diagnostics = cache.getDiagnostics();
  assert.equal(diagnostics.pendingLeases, 2);
  assert.equal(diagnostics.readyLeases, 0);
  assert.equal(diagnostics.activePendingEntries, 1);
  assert.equal(diagnostics.activeReadyEntries, 0);

  assert.equal(cancelled.release(), true);
  await assert.rejects(cancelled.ready, { name: "AbortError" });
  diagnostics = cache.getDiagnostics();
  assert.equal(signal.aborted, false);
  assert.equal(aborts, 0);
  assert.equal(diagnostics.pendingLeases, 1);
  assert.equal(diagnostics.pendingLeaseCancellations, 1);
  assert.equal(diagnostics.abortedLoads, 0);

  gate.resolve(source);
  assert.equal(await remaining.ready, remaining);
  diagnostics = cache.getDiagnostics();
  assert.equal(decodes, 1);
  assert.equal(diagnostics.pendingLeases, 0);
  assert.equal(diagnostics.readyLeases, 1);
  assert.equal(diagnostics.activePendingEntries, 0);
  assert.equal(diagnostics.activeReadyEntries, 1);
  remaining.release();
  cache.clear();
  assert.equal(source.closeCount, 1);
});

test("same-key mutation oracle keeps a late cancelled load cleanup-only", async () => {
  const fetches = [];
  const decodedNames = [];
  let aborts = 0;
  const cache = makeCache({
    fetchSource(_url, _decodeOptions, signal) {
      const gate = deferred();
      signal.addEventListener("abort", () => aborts++);
      fetches.push({ gate, signal });
      return gate.promise;
    },
    decodeSource(source) {
      decodedNames.push(source.name);
      return source;
    },
  });

  const obsolete = cache.acquire("mutation-oracle.png");
  assert.equal(fetches.length, 1);
  assert.equal(obsolete.release(), true);
  await assert.rejects(obsolete.ready, { name: "AbortError" });
  assert.equal(fetches[0].signal.aborted, true);
  assert.equal(aborts, 1);
  assert.equal(cache.getDiagnostics().entryCount, 0);
  assert.equal(cache.getDiagnostics().abortedLoads, 1);

  const current = cache.acquire("mutation-oracle.png");
  assert.equal(fetches.length, 2);
  const obsoleteSource = makeSource("obsolete");
  fetches[0].gate.resolve(obsoleteSource);
  await drainMicrotasks();

  let diagnostics = cache.getDiagnostics();
  assert.equal(obsoleteSource.closeCount, 1);
  assert.deepEqual(decodedNames, []);
  assert.equal(diagnostics.entryCount, 1);
  assert.equal(diagnostics.pendingEntries, 1);
  assert.equal(diagnostics.pendingLeases, 1);
  assert.equal(diagnostics.cancelledSettlements, 1);

  const currentSource = makeSource("current");
  fetches[1].gate.resolve(currentSource);
  assert.equal(await current.ready, current);
  diagnostics = cache.getDiagnostics();
  assert.deepEqual(decodedNames, ["current"]);
  assert.equal(current.source, currentSource);
  assert.equal(diagnostics.loads, 1);
  assert.equal(diagnostics.readyEntries, 1);
  assert.equal(diagnostics.pendingEntries, 0);

  current.release();
  cache.clear();
  assert.equal(currentSource.closeCount, 1);
});

test("reentrant byte accounting cannot publish after releasing the last waiter", async () => {
  const source = makeSource("reentrant-accounting");
  let lease;
  const cache = makeCache({
    fetchSource: async () => source,
    decodeSource: async (value) => value,
    estimateBytes() {
      assert.equal(lease.release(), true);
      return source.byteLength;
    },
  });

  lease = cache.acquire("reentrant-accounting.png");
  await assert.rejects(lease.ready, { name: "AbortError" });
  await drainMicrotasks();
  const diagnostics = cache.getDiagnostics();
  assert.equal(source.closeCount, 1);
  assert.equal(diagnostics.entryCount, 0);
  assert.equal(diagnostics.loads, 0);
  assert.equal(diagnostics.abortedLoads, 1);
  assert.equal(diagnostics.cancelledSettlements, 1);
});

test("cancellation during decode cleans every late source without publication", async () => {
  const decodeGate = deferred();
  const fetched = makeSource("decode-input");
  const decoded = makeSource("decode-output");
  let signal;
  const cache = makeCache({
    fetchSource: async () => fetched,
    decodeSource(_source, _decodeOptions, _url, decodeSignal) {
      signal = decodeSignal;
      return decodeGate.promise;
    },
  });

  const lease = cache.acquire("cancel-during-decode.png");
  await drainMicrotasks();
  assert.equal(signal.aborted, false);
  lease.release();
  await assert.rejects(lease.ready, { name: "AbortError" });
  assert.equal(signal.aborted, true);
  assert.equal(cache.getDiagnostics().entryCount, 0);

  decodeGate.resolve(decoded);
  await drainMicrotasks();
  const diagnostics = cache.getDiagnostics();
  assert.equal(fetched.closeCount, 1);
  assert.equal(decoded.closeCount, 1);
  assert.equal(diagnostics.loads, 0);
  assert.equal(diagnostics.failures, 0);
  assert.equal(diagnostics.cancelledSettlements, 1);
});

test("clear immediately evicts inactive entries and defers active entries", async () => {
  const fetched = [];
  const cache = makeCache({
    fetchSource: async (url) => {
      const source = makeSource(url);
      fetched.push(source);
      return source;
    },
    decodeSource: async (source) => source,
  });

  const active = await acquireReady(cache, "active.png");
  const inactiveSource = await acquireAndRelease(cache, "inactive.png");
  assert.deepEqual(cache.clear(), { evicted: 1, deferred: 1 });
  assert.equal(inactiveSource.closeCount, 1);
  assert.equal(active.source.closeCount, 0);

  const secondActive = await acquireReady(cache, "active.png");
  assert.equal(secondActive.source, active.source);
  assert.equal(fetched.length, 2);
  assert.equal(cache.getDiagnostics().hits, 1);
  const activeSource = active.source;
  active.release();
  assert.equal(activeSource.closeCount, 0);
  secondActive.release();
  assert.equal(activeSource.closeCount, 1);
  assert.equal(cache.getDiagnostics().entryCount, 0);
});

test("failed shared loads are removed, cleaned, and retryable", async () => {
  const fetched = [];
  let decodeAttempts = 0;
  const cache = makeCache({
    fetchSource: async (url) => {
      const source = makeSource(`${url}:${fetched.length}`);
      fetched.push(source);
      return source;
    },
    decodeSource(source) {
      decodeAttempts++;
      if (decodeAttempts === 1) {
        throw new Error("decode failed");
      }
      return source;
    },
  });

  const first = cache.acquire("retry.png");
  const coalesced = cache.acquire("retry.png");
  const results = await Promise.allSettled([first.ready, coalesced.ready]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.match(results[0].reason.message, /decode failed/);
  assert.equal(fetched[0].closeCount, 1);
  assert.equal(cache.getDiagnostics().entryCount, 0);
  assert.equal(cache.getDiagnostics().failures, 1);

  const retry = await acquireReady(cache, "retry.png");
  assert.equal(retry.source, fetched[1]);
  assert.equal(fetched.length, 2);
  assert.equal(decodeAttempts, 2);
  retry.release();
  cache.clear();
  assert.equal(fetched[1].closeCount, 1);
});

test("post-decode accounting failures close both owned stages exactly once", async () => {
  const fetched = makeSource("fetched");
  const decoded = makeSource("decoded");
  const cache = makeCache({
    fetchSource: async () => fetched,
    decodeSource: async () => decoded,
    estimateBytes() {
      throw new Error("accounting failed");
    },
  });

  const failedLease = cache.acquire("bad-size.png");
  await assert.rejects(failedLease.ready, /accounting failed/);
  assert.equal(fetched.closeCount, 1);
  assert.equal(decoded.closeCount, 1);
  assert.equal(cache.getDiagnostics().entryCount, 0);
  assert.equal(cache.getDiagnostics().failures, 1);
});

test("cleanup failures and diagnostic callbacks cannot escape release", async () => {
  const cleanupError = new Error("close failed");
  const source = makeSource("close-error", 16, cleanupError);
  const cleanupReports = [];
  const cache = makeCache({
    maxEntries: 0,
    fetchSource: async () => source,
    decodeSource: async (value) => value,
    onCleanupError(error, details) {
      cleanupReports.push({ error, details });
      throw new Error("observer failed");
    },
  });

  const lease = await acquireReady(cache, "close-error.png");
  assert.doesNotThrow(() => lease.release());
  assert.equal(lease.release(), false);
  assert.equal(source.closeCount, 1);
  assert.equal(cleanupReports.length, 1);
  assert.equal(cleanupReports[0].error, cleanupError);
  assert.equal(cleanupReports[0].details.reason, "budget");
  assert.equal(cache.getDiagnostics().cleanupErrors, 1);
  assert.equal(cache.getDiagnostics().entryCount, 0);
});

test("diagnostics are frozen, sorted, and never expose source objects", async () => {
  const cache = makeCache({
    fetchSource: async (url) => makeSource(url),
    decodeSource: async (source) => source,
  });

  const zLease = await acquireReady(cache, "z.png");
  await acquireAndRelease(cache, "a.png");
  const diagnostics = cache.getDiagnostics();

  assert.equal(Object.isFrozen(diagnostics), true);
  assert.equal(Object.isFrozen(diagnostics.entries), true);
  assert.equal(diagnostics.entryCount, 2);
  assert.equal(diagnostics.activeEntries, 1);
  assert.equal(diagnostics.activeLeases, 1);
  assert.equal(diagnostics.retainedEntries, 1);
  assert.equal(diagnostics.retainedBytes, 16);
  assert.deepEqual(
    diagnostics.entries.map((entry) => entry.exactUrl),
    ["https://moon.invalid/assets/a.png", "https://moon.invalid/assets/z.png"],
  );
  for (const entry of diagnostics.entries) {
    assert.equal(Object.isFrozen(entry), true);
    assert.equal(Object.hasOwn(entry, "source"), false);
  }

  zLease.release();
  cache.clear();
});
