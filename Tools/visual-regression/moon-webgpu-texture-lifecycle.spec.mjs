import test from "node:test";
import assert from "node:assert/strict";

import { MoonDecodedSourceCache } from "../../packages/engine/Source/Core/MoonDecodedSourceCache.js";
import {
  MoonTextureChannel,
  commitWebGPUMoonTextureCandidate,
  createWebGPUMoonUploadSource,
  createWebGPUMoonTextureLifecycle,
  createWebGPUMoonTexturePairKey,
  getWebGPUMoonTextureLifecycleDiagnostics,
  reconcileWebGPUMoonTextureChannel,
  releaseWebGPUMoonUploadSource,
  retireWebGPUMoonPublishedTexture,
  retireWebGPUMoonTextureLifecycle,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUMoonTextureLifecycle.js";

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

function makeCloseableSource(name, byteLength = 16) {
  return {
    name,
    byteLength,
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };
}

function makeImmediateLease(source, readyGate) {
  const lease = {
    source,
    releaseCount: 0,
    release() {
      this.releaseCount++;
      return this.releaseCount === 1;
    },
  };
  lease.ready = readyGate?.promise ?? Promise.resolve(lease);
  return lease;
}

function makeDecodedSourceCache(fetchSource) {
  return new MoonDecodedSourceCache({
    maxEntries: 8,
    maxBytes: 1024,
    canonicalizeUrl: (url) => `https://moon.invalid/${url}`,
    fetchSource,
    decodeSource: async (source) => source,
    estimateBytes: (source) => source.byteLength,
    closeSource: (source) => source.close(),
  });
}

function makeHarness() {
  const device = { name: "device-a" };
  const context = { device, resourceGeneration: 4 };
  const cache = {};
  const owner = { _webgpuCache: cache };
  const lifecycle = createWebGPUMoonTextureLifecycle(
    owner,
    cache,
    context,
    device,
    context.resourceGeneration,
  );
  const fetches = [];
  const candidates = [];
  const monitorEvents = [];
  const errors = [];
  let nextCandidate = 1;

  const hooks = {
    beginAsync(identity) {
      const token = `${identity.channel}:${identity.requestSerial}`;
      monitorEvents.push(`begin:${token}`);
      return token;
    },
    resolveAsync(token) {
      monitorEvents.push(`resolve:${token}`);
    },
    rejectAsync(token) {
      monitorEvents.push(`reject:${token}`);
    },
    fetchImage(url) {
      const gate = deferred();
      fetches.push({ url, gate });
      return gate.promise;
    },
    createCandidate(image) {
      const upload = deferred();
      const candidate = {
        id: nextCandidate++,
        image,
        upload,
        destroyCount: 0,
        finalizeCount: 0,
      };
      candidates.push(candidate);
      return candidate;
    },
    uploadCandidate(_image, candidate) {
      return candidate.upload.promise;
    },
    finalizeCandidate(candidate, dimensions) {
      candidate.finalizeCount++;
      candidate.width = dimensions.width;
      candidate.height = dimensions.height;
      candidate.view = { candidateId: candidate.id };
      return candidate;
    },
    destroyCandidate(candidate) {
      candidate.destroyCount++;
    },
    onError(error, phase) {
      errors.push({ error, phase });
    },
  };

  function request(channel, url, pairKey, demanded = true) {
    return reconcileWebGPUMoonTextureChannel(lifecycle, channel, {
      url,
      pairKey,
      demanded,
      hooks,
    });
  }

  return {
    owner,
    cache,
    context,
    device,
    lifecycle,
    hooks,
    fetches,
    candidates,
    monitorEvents,
    errors,
    request,
  };
}

function installDecodedSourceLeaseHooks(harness, decodedSourceCache) {
  let leasedRawReleaseAttempts = 0;
  delete harness.hooks.fetchImage;
  harness.hooks.acquireSource = function (url) {
    return decodedSourceCache.acquire(url, {
      imageOrientation: "from-image",
      colorSpaceConversion: "default",
      premultiplyAlpha: "default",
    });
  };
  // Mutation oracle: a leased cache source must never enter the legacy raw-
  // fetch cleanup path, which would close an ImageBitmap another renderer may
  // still be using.
  harness.hooks.releaseFetchedSource = function (source) {
    leasedRawReleaseAttempts++;
    source.close();
  };
  harness.hooks.prepareSource = function (sharedSource) {
    return createWebGPUMoonUploadSource(sharedSource, sharedSource);
  };
  harness.hooks.releaseSource = releaseWebGPUMoonUploadSource;
  return {
    get leasedRawReleaseAttempts() {
      return leasedRawReleaseAttempts;
    },
  };
}

function makePublicationHarness(initial = { id: "placeholder" }) {
  const events = [];
  let current = initial;
  const callbacks = {
    invalidate() {
      events.push("invalidate");
    },
    publish(candidate) {
      const previous = current;
      current = candidate;
      events.push(`publish:${candidate.id}`);
      return previous;
    },
    destroyPrevious(previous) {
      events.push(`destroy:${previous.id}`);
      previous.destroyCount = (previous.destroyCount ?? 0) + 1;
    },
    preparePlaceholder() {
      events.push("prepare-placeholder");
      return { id: "placeholder-next" };
    },
    publishPlaceholder(placeholder) {
      const previous = current;
      current = placeholder;
      events.push("publish-placeholder");
      return previous;
    },
  };
  return {
    callbacks,
    events,
    get current() {
      return current;
    },
  };
}

function containsReference(value, target, visited = new Set()) {
  if (value === target) {
    return true;
  }
  if (value === null || typeof value !== "object" || visited.has(value)) {
    return false;
  }
  visited.add(value);
  return Object.values(value).some((child) =>
    containsReference(child, target, visited),
  );
}

test("diagnostics preserve staged and current pair identity without exposing resources", async () => {
  const h = makeHarness();
  const source = { url: "a.jpg" };
  const pair = createWebGPUMoonTexturePairKey("a.jpg", "n.png");
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve(source);
  await drainMicrotasks();
  h.candidates[0].upload.resolve({ width: 8, height: 4 });
  await drainMicrotasks();

  let diagnostics = getWebGPUMoonTextureLifecycleDiagnostics(h.lifecycle);
  assert.equal(Object.isFrozen(diagnostics), true);
  assert.equal(diagnostics.albedoRequestState, "candidate-ready");
  assert.equal(diagnostics.albedoDesiredUrl, "a.jpg");
  assert.equal(diagnostics.albedoEffectivePair, pair);
  assert.equal(diagnostics.albedoCurrentUrl, null);
  assert.equal(diagnostics.albedoCurrentPair, null);
  assert.equal(diagnostics.albedoPendingUrl, "a.jpg");
  assert.equal(diagnostics.albedoPendingPair, pair);
  assert.equal(diagnostics.albedoCandidateReady, true);
  assert.equal(diagnostics.albedoGpuRealizations, 1);
  assert.equal(diagnostics.albedoSuccessfulUploads, 1);
  assert.equal(diagnostics.albedoPublications, 0);
  for (const resource of [
    h.owner,
    h.cache,
    h.context,
    h.device,
    h.lifecycle,
    h.candidates[0],
    source,
  ]) {
    assert.equal(containsReference(diagnostics, resource), false);
  }

  const publication = makePublicationHarness();
  assert.equal(
    commitWebGPUMoonTextureCandidate(
      h.lifecycle,
      MoonTextureChannel.ALBEDO,
      publication.callbacks,
    ),
    true,
  );
  diagnostics = getWebGPUMoonTextureLifecycleDiagnostics(h.lifecycle);
  assert.equal(diagnostics.albedoRequestState, "current");
  assert.equal(diagnostics.albedoCurrentUrl, "a.jpg");
  assert.equal(diagnostics.albedoCurrentPair, pair);
  assert.equal(diagnostics.albedoPendingUrl, null);
  assert.equal(diagnostics.albedoPendingPair, null);
  assert.equal(diagnostics.albedoCandidateReady, false);
  assert.equal(diagnostics.albedoPublications, 1);
});

test("diagnostic destroy counters classify each actual candidate retirement once", async () => {
  const stale = makeHarness();
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);
  stale.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  await drainMicrotasks();
  stale.fetches[0].gate.resolve({ url: "a.jpg" });
  await drainMicrotasks();
  stale.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
  assert.equal(stale.candidates[0].destroyCount, 1);
  assert.equal(stale.lifecycle.channels.albedo.staleCandidateDestroys, 1);
  retireWebGPUMoonTextureLifecycle(stale.lifecycle, "test-complete");
  assert.equal(stale.candidates[0].destroyCount, 1);
  assert.equal(stale.lifecycle.channels.albedo.staleCandidateDestroys, 1);

  const failedUpload = makeHarness();
  failedUpload.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  await drainMicrotasks();
  failedUpload.fetches[0].gate.resolve({ url: "a.jpg" });
  await drainMicrotasks();
  failedUpload.candidates[0].upload.reject(new Error("upload failed"));
  await drainMicrotasks();
  assert.equal(failedUpload.candidates[0].destroyCount, 1);
  assert.equal(
    failedUpload.lifecycle.channels.albedo.failedCandidateDestroys,
    1,
  );
  assert.equal(failedUpload.lifecycle.channels.albedo.successfulUploads, 0);

  const failedPublication = makeHarness();
  failedPublication.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  await drainMicrotasks();
  failedPublication.fetches[0].gate.resolve({ url: "a.jpg" });
  await drainMicrotasks();
  failedPublication.candidates[0].upload.resolve({ width: 8, height: 4 });
  await drainMicrotasks();
  const publication = makePublicationHarness();
  publication.callbacks.invalidate = function () {
    throw new Error("invalidation failed");
  };
  assert.equal(
    commitWebGPUMoonTextureCandidate(
      failedPublication.lifecycle,
      MoonTextureChannel.ALBEDO,
      publication.callbacks,
    ),
    false,
  );
  assert.equal(failedPublication.candidates[0].destroyCount, 1);
  assert.equal(
    failedPublication.lifecycle.channels.albedo.failedCandidateDestroys,
    1,
  );
  assert.equal(failedPublication.lifecycle.channels.albedo.publications, 0);
});

test("destroy during fetch cannot create or publish a candidate", async () => {
  const h = makeHarness();
  const pair = createWebGPUMoonTexturePairKey("a.jpg", "n.png");
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  assert.equal(h.fetches.length, 1);

  retireWebGPUMoonTextureLifecycle(h.lifecycle, "owner-destroyed");
  h.owner._webgpuCache = undefined;
  h.fetches[0].gate.resolve({ url: "a.jpg" });
  await drainMicrotasks();

  assert.equal(h.candidates.length, 0);
  assert.equal(h.lifecycle.channels.albedo.state, "retired");
  assert.deepEqual(h.monitorEvents, ["begin:albedo:1", "resolve:albedo:1"]);
});

test("a closeable fetch result settling after retirement is released exactly once", async () => {
  const h = makeHarness();
  h.hooks.releaseFetchedSource = function (image) {
    image.close();
  };
  const image = {
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();

  retireWebGPUMoonTextureLifecycle(h.lifecycle, "owner-destroyed");
  h.owner._webgpuCache = undefined;
  h.fetches[0].gate.resolve(image);
  await drainMicrotasks();

  assert.equal(image.closeCount, 1);
  assert.equal(h.candidates.length, 0);
});

test("a closeable fetch result settling after URL supersession is released exactly once", async () => {
  const h = makeHarness();
  h.hooks.releaseFetchedSource = function (image) {
    image.close();
  };
  const image = {
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  await drainMicrotasks();
  h.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
  await drainMicrotasks();

  h.fetches[0].gate.resolve(image);
  await drainMicrotasks();

  assert.equal(image.closeCount, 1);
  assert.equal(h.candidates.length, 0);
  retireWebGPUMoonTextureLifecycle(h.lifecycle, "test-complete");
});

test("a stale pending decoded-source lease is synchronously owned, released, and aborted", async () => {
  const fetches = [];
  const decodedSourceCache = makeDecodedSourceCache(
    (_url, _decodeOptions, signal) => {
      const gate = deferred();
      const record = { gate, signal, abortCount: 0 };
      signal.addEventListener("abort", () => record.abortCount++);
      fetches.push(record);
      return gate.promise;
    },
  );
  const h = makeHarness();
  const traps = installDecodedSourceLeaseHooks(h, decodedSourceCache);
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);

  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  const leaseA = h.lifecycle.channels.albedo.request.sourceLease;
  // Mutation oracle for Promise-only acquisition: no microtask may be needed
  // before the lifecycle has a releasable owner and the cache has begun work.
  assert.notEqual(leaseA, undefined);
  assert.equal(fetches.length, 1);
  assert.equal(decodedSourceCache.getDiagnostics().pendingLeases, 1);

  h.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
  const leaseB = h.lifecycle.channels.albedo.request.sourceLease;
  assert.equal(fetches.length, 2);
  assert.equal(fetches[0].signal.aborted, true);
  assert.equal(fetches[0].abortCount, 1);
  await assert.rejects(leaseA.ready, { name: "AbortError" });

  const staleSource = makeCloseableSource("stale-a");
  fetches[0].gate.resolve(staleSource);
  await drainMicrotasks();
  assert.equal(staleSource.closeCount, 1);
  assert.equal(h.candidates.length, 0);
  assert.equal(decodedSourceCache.getDiagnostics().cancelledSettlements, 1);

  retireWebGPUMoonTextureLifecycle(h.lifecycle, "pending-b-retired");
  assert.equal(fetches[1].signal.aborted, true);
  assert.equal(fetches[1].abortCount, 1);
  await assert.rejects(leaseB.ready, { name: "AbortError" });
  const retiredSource = makeCloseableSource("retired-b");
  fetches[1].gate.resolve(retiredSource);
  await drainMicrotasks();

  const diagnostics = decodedSourceCache.getDiagnostics();
  assert.equal(retiredSource.closeCount, 1);
  assert.equal(diagnostics.entryCount, 0);
  assert.equal(diagnostics.pendingLeaseCancellations, 2);
  assert.equal(diagnostics.abortedLoads, 2);
  assert.equal(diagnostics.cancelledSettlements, 2);
  assert.equal(traps.leasedRawReleaseAttempts, 0);
});

test("WebGPU upload-source ownership never directly closes the leased shared source", () => {
  const sharedSource = makeCloseableSource("shared");
  const passThrough = createWebGPUMoonUploadSource(sharedSource, sharedSource);
  assert.equal(passThrough.ownedUploadSource, false);
  releaseWebGPUMoonUploadSource(passThrough);
  releaseWebGPUMoonUploadSource(passThrough);
  assert.equal(sharedSource.closeCount, 0);

  const derivative = makeCloseableSource("derived");
  const converted = createWebGPUMoonUploadSource(sharedSource, derivative);
  assert.equal(converted.ownedUploadSource, true);
  releaseWebGPUMoonUploadSource(converted);
  releaseWebGPUMoonUploadSource(converted);
  assert.equal(sharedSource.closeCount, 0);
  assert.equal(derivative.closeCount, 1);
});

test("retiring one of two decoded-source consumers cannot close the source used by the other", async () => {
  const fetchGate = deferred();
  let fetchCount = 0;
  const decodedSourceCache = makeDecodedSourceCache(() => {
    fetchCount++;
    return fetchGate.promise;
  });
  const first = makeHarness();
  const second = makeHarness();
  const firstTraps = installDecodedSourceLeaseHooks(first, decodedSourceCache);
  const secondTraps = installDecodedSourceLeaseHooks(
    second,
    decodedSourceCache,
  );
  const secondPreparation = deferred();
  second.hooks.prepareSource = function (sharedSource) {
    return secondPreparation.promise.then(function () {
      return createWebGPUMoonUploadSource(sharedSource, sharedSource);
    });
  };
  const pair = createWebGPUMoonTexturePairKey("shared.jpg", undefined);

  first.request(MoonTextureChannel.ALBEDO, "shared.jpg", pair);
  second.request(MoonTextureChannel.ALBEDO, "shared.jpg", pair);
  assert.equal(fetchCount, 1);
  assert.equal(decodedSourceCache.getDiagnostics().pendingLeases, 2);

  const sharedSource = makeCloseableSource("shared");
  fetchGate.resolve(sharedSource);
  await drainMicrotasks();
  assert.equal(first.candidates.length, 1);
  assert.equal(second.candidates.length, 0);
  assert.equal(decodedSourceCache.getDiagnostics().readyLeases, 2);

  retireWebGPUMoonTextureLifecycle(first.lifecycle, "first-consumer-retired");
  assert.equal(first.candidates[0].destroyCount, 1);
  assert.equal(sharedSource.closeCount, 0);
  assert.equal(decodedSourceCache.getDiagnostics().readyLeases, 1);

  secondPreparation.resolve();
  await drainMicrotasks();
  assert.equal(second.candidates.length, 1);
  assert.equal(sharedSource.closeCount, 0);
  second.candidates[0].upload.resolve({ width: 8, height: 4 });
  first.candidates[0].upload.resolve({ width: 8, height: 4 });
  await drainMicrotasks();
  assert.notEqual(second.lifecycle.channels.albedo.staged, undefined);
  assert.equal(decodedSourceCache.getDiagnostics().readyLeases, 0);
  assert.equal(sharedSource.closeCount, 0);
  assert.equal(firstTraps.leasedRawReleaseAttempts, 0);
  assert.equal(secondTraps.leasedRawReleaseAttempts, 0);

  assert.deepEqual(decodedSourceCache.clear(), { evicted: 1, deferred: 0 });
  assert.equal(sharedSource.closeCount, 1);
});

test("decoded-source leases release exactly once on success, failure, supersession, and teardown", async () => {
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);

  const success = makeHarness();
  const successLease = makeImmediateLease({ name: "success" });
  delete success.hooks.fetchImage;
  success.hooks.acquireSource = () => successLease;
  success.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  assert.equal(
    success.lifecycle.channels.albedo.request.sourceLease,
    successLease,
  );
  await drainMicrotasks();
  success.candidates[0].upload.resolve({ width: 8, height: 4 });
  await drainMicrotasks();
  assert.equal(successLease.releaseCount, 1);
  retireWebGPUMoonTextureLifecycle(success.lifecycle, "after-success");
  assert.equal(successLease.releaseCount, 1);

  const failure = makeHarness();
  const failureLease = makeImmediateLease({ name: "failure" });
  delete failure.hooks.fetchImage;
  failure.hooks.acquireSource = () => failureLease;
  failure.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  await drainMicrotasks();
  failure.candidates[0].upload.reject(new Error("upload failed"));
  await drainMicrotasks();
  assert.equal(failure.lifecycle.channels.albedo.state, "failed");
  assert.equal(failureLease.releaseCount, 1);
  retireWebGPUMoonTextureLifecycle(failure.lifecycle, "after-failure");
  assert.equal(failureLease.releaseCount, 1);

  const superseded = makeHarness();
  const oldGate = deferred();
  const replacementGate = deferred();
  const oldLease = makeImmediateLease({ name: "old" }, oldGate);
  const replacementLease = makeImmediateLease(
    { name: "replacement" },
    replacementGate,
  );
  const queuedLeases = [oldLease, replacementLease];
  delete superseded.hooks.fetchImage;
  superseded.hooks.acquireSource = () => queuedLeases.shift();
  superseded.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  superseded.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
  assert.equal(oldLease.releaseCount, 1);
  oldGate.resolve(oldLease);
  await drainMicrotasks();
  assert.equal(oldLease.releaseCount, 1);
  retireWebGPUMoonTextureLifecycle(superseded.lifecycle, "replacement-retired");
  assert.equal(replacementLease.releaseCount, 1);
  replacementGate.resolve(replacementLease);
  await drainMicrotasks();
  assert.equal(replacementLease.releaseCount, 1);

  const tornDown = makeHarness();
  const teardownGate = deferred();
  const teardownLease = makeImmediateLease({ name: "teardown" }, teardownGate);
  delete tornDown.hooks.fetchImage;
  tornDown.hooks.acquireSource = () => teardownLease;
  tornDown.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  retireWebGPUMoonTextureLifecycle(tornDown.lifecycle, "pending-teardown");
  assert.equal(teardownLease.releaseCount, 1);
  teardownGate.resolve(teardownLease);
  await drainMicrotasks();
  assert.equal(teardownLease.releaseCount, 1);
  assert.equal(tornDown.candidates.length, 0);
});

test("reentrant async-monitor retirement settles the returned token and starts no source work", () => {
  const h = makeHarness();
  const returnedToken = { id: "returned-after-retirement" };
  const resolvedTokens = [];
  let acquisitions = 0;
  delete h.hooks.fetchImage;
  h.hooks.beginAsync = function () {
    retireWebGPUMoonTextureLifecycle(h.lifecycle, "inside-beginAsync");
    return returnedToken;
  };
  h.hooks.resolveAsync = function (token) {
    resolvedTokens.push(token);
  };
  h.hooks.acquireSource = function () {
    acquisitions++;
    return makeImmediateLease({ name: "must-not-acquire" });
  };

  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);

  assert.equal(h.lifecycle.retired, true);
  assert.equal(h.lifecycle.channels.albedo.state, "retired");
  assert.equal(acquisitions, 0);
  assert.deepEqual(resolvedTokens, [returnedToken]);
});

test("a lease returned after reentrant source-acquisition supersession is released without disturbing its replacement", async () => {
  const h = makeHarness();
  const oldGate = deferred();
  const replacementGate = deferred();
  const oldLease = makeImmediateLease({ name: "old" }, oldGate);
  const replacementLease = makeImmediateLease(
    { name: "replacement" },
    replacementGate,
  );
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);
  delete h.hooks.fetchImage;
  h.hooks.acquireSource = function (url) {
    if (url === "a.jpg") {
      h.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
      return oldLease;
    }
    return replacementLease;
  };

  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  const currentRequest = h.lifecycle.channels.albedo.request;
  assert.equal(currentRequest.identity.exactUrl, "b.jpg");
  assert.equal(currentRequest.sourceLease, replacementLease);
  assert.equal(oldLease.releaseCount, 1);
  assert.equal(replacementLease.releaseCount, 0);
  assert.deepEqual(h.monitorEvents, [
    "begin:albedo:1",
    "resolve:albedo:1",
    "begin:albedo:2",
  ]);

  retireWebGPUMoonTextureLifecycle(h.lifecycle, "replacement-retired");
  assert.equal(oldLease.releaseCount, 1);
  assert.equal(replacementLease.releaseCount, 1);
  oldGate.resolve(oldLease);
  replacementGate.resolve(replacementLease);
  await drainMicrotasks();
  assert.equal(oldLease.releaseCount, 1);
  assert.equal(replacementLease.releaseCount, 1);
  assert.equal(h.candidates.length, 0);
});

test("retirement defers lease release until asynchronous source preparation stops reading it", async () => {
  const h = makeHarness();
  const preparation = deferred();
  const lease = makeImmediateLease({ name: "shared-while-preparing" });
  let preparedReleaseCount = 0;
  delete h.hooks.fetchImage;
  h.hooks.acquireSource = () => lease;
  h.hooks.prepareSource = () => preparation.promise;
  h.hooks.releaseSource = function () {
    preparedReleaseCount++;
  };

  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  const request = h.lifecycle.channels.albedo.request;
  await drainMicrotasks();
  assert.equal(request.preparingSource, true);

  retireWebGPUMoonTextureLifecycle(h.lifecycle, "during-leased-preparation");
  assert.equal(request.sourceLease, lease);
  assert.equal(request.sourceLeaseReleasePending, true);
  assert.equal(lease.releaseCount, 0);

  preparation.resolve({ derived: true });
  await drainMicrotasks();
  assert.equal(preparedReleaseCount, 1);
  assert.equal(request.sourceLease, undefined);
  assert.equal(request.sourceLeaseReleasePending, false);
  assert.equal(lease.releaseCount, 1);
  assert.equal(h.candidates.length, 0);
});

test("a current closeable fetch result transfers to prepared ownership without double close", async () => {
  const h = makeHarness();
  let fetchedReleaseCount = 0;
  let preparedReleaseCount = 0;
  h.hooks.releaseFetchedSource = function (image) {
    fetchedReleaseCount++;
    image.close();
  };
  h.hooks.prepareSource = function (image) {
    return { image };
  };
  h.hooks.releaseSource = function (source) {
    preparedReleaseCount++;
    source.image.close();
  };
  const image = {
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve(image);
  await drainMicrotasks();
  assert.equal(h.candidates.length, 1);

  h.candidates[0].upload.resolve({ width: 8, height: 4 });
  await drainMicrotasks();

  assert.equal(fetchedReleaseCount, 0);
  assert.equal(preparedReleaseCount, 1);
  assert.equal(image.closeCount, 1);
  assert.notEqual(h.lifecycle.channels.albedo.staged, undefined);
});

test("a closeable fetch result is released when source preparation rejects", async () => {
  const h = makeHarness();
  h.hooks.releaseFetchedSource = function (image) {
    image.close();
  };
  h.hooks.prepareSource = function () {
    return Promise.reject(new Error("decode failed"));
  };
  const image = {
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve(image);
  await drainMicrotasks();

  assert.equal(image.closeCount, 1);
  assert.equal(h.candidates.length, 0);
  assert.equal(h.lifecycle.channels.albedo.state, "failed");
  assert.equal(h.errors[0].phase, "source-prepare");
});

test("destroy during source preparation releases decoded input without allocating GPU work", async () => {
  const h = makeHarness();
  const prepare = deferred();
  let releaseCount = 0;
  h.hooks.prepareSource = function () {
    return prepare.promise;
  };
  h.hooks.releaseSource = function () {
    releaseCount++;
  };
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a.jpg" });
  await drainMicrotasks();

  retireWebGPUMoonTextureLifecycle(h.lifecycle, "during-decode");
  prepare.resolve({ decoded: true });
  await drainMicrotasks();
  assert.equal(releaseCount, 1);
  assert.equal(h.candidates.length, 0);
});

test("destroy after candidate creation destroys it exactly once", async () => {
  const h = makeHarness();
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a.jpg" });
  await drainMicrotasks();
  assert.equal(h.candidates.length, 1);

  retireWebGPUMoonTextureLifecycle(h.lifecycle, "owner-destroyed");
  assert.equal(h.candidates[0].destroyCount, 1);
  h.candidates[0].upload.resolve({ width: 8, height: 4 });
  await drainMicrotasks();
  assert.equal(h.candidates[0].destroyCount, 1);
  assert.equal(h.lifecycle.channels.albedo.staged, undefined);
});

test("failed replacement preserves current and does not retry every frame", async () => {
  const h = makeHarness();
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a.jpg" });
  await drainMicrotasks();
  h.candidates[0].upload.resolve({ width: 8, height: 4 });
  await drainMicrotasks();
  const publication = makePublicationHarness();
  assert.equal(
    commitWebGPUMoonTextureCandidate(
      h.lifecycle,
      MoonTextureChannel.ALBEDO,
      publication.callbacks,
    ),
    true,
  );
  const currentA = publication.current;

  const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
  await drainMicrotasks();
  h.fetches[1].gate.resolve({ url: "b.jpg" });
  await drainMicrotasks();
  h.candidates[1].upload.reject(new Error("upload failed"));
  await drainMicrotasks();

  assert.equal(h.candidates[1].destroyCount, 1);
  assert.equal(publication.current, currentA);
  assert.equal(h.lifecycle.channels.albedo.state, "failed");
  assert.equal(
    h.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB).started,
    false,
  );
  assert.equal(h.fetches.length, 2);
});

test("A to pending B to A retains the publication and reports current", async () => {
  const h = makeHarness();
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);

  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a.jpg" });
  await drainMicrotasks();
  h.candidates[0].upload.resolve({ width: 4, height: 2 });
  await drainMicrotasks();
  const publication = makePublicationHarness();
  assert.equal(
    commitWebGPUMoonTextureCandidate(
      h.lifecycle,
      MoonTextureChannel.ALBEDO,
      publication.callbacks,
    ),
    true,
  );
  const publishedA = publication.current;
  const identityA = h.lifecycle.channels.albedo.currentIdentity;

  h.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
  await drainMicrotasks();
  assert.equal(h.lifecycle.channels.albedo.state, "source-pending");
  const backToA = h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);

  assert.deepEqual(backToA, { retireCurrent: false, started: false });
  assert.equal(h.fetches.length, 2);
  assert.equal(h.lifecycle.channels.albedo.state, "current");
  assert.equal(h.lifecycle.channels.albedo.currentIdentity, identityA);
  assert.equal(publication.current, publishedA);
  assert.equal(h.candidates.length, 1);
});

test("A to pending B to A reports current while relief is disabled", async () => {
  const h = makeHarness();
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", "n-a.png");
  const pairB = createWebGPUMoonTexturePairKey("b.jpg", "n-b.png");

  h.request(MoonTextureChannel.NORMAL, "n-a.png", pairA);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "n-a.png" });
  await drainMicrotasks();
  h.candidates[0].upload.resolve({ width: 4, height: 2 });
  await drainMicrotasks();
  const publication = makePublicationHarness();
  assert.equal(
    commitWebGPUMoonTextureCandidate(
      h.lifecycle,
      MoonTextureChannel.NORMAL,
      publication.callbacks,
    ),
    true,
  );
  const publishedA = publication.current;

  h.request(MoonTextureChannel.NORMAL, "n-b.png", pairB, false);
  const backToA = h.request(MoonTextureChannel.NORMAL, "n-a.png", pairA, false);

  assert.deepEqual(backToA, { retireCurrent: false, started: false });
  assert.equal(h.lifecycle.channels.normal.state, "current");
  assert.equal(h.lifecycle.channels.normal.demanded, false);
  assert.equal(publication.current, publishedA);
  assert.equal(h.candidates.length, 1);
});

test("A to B to A stages only the newest serial in every upload settlement order", async () => {
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of permutations) {
    const h = makeHarness();
    const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);

    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
    await drainMicrotasks();
    h.fetches[0].gate.resolve({ url: "a-old" });
    await drainMicrotasks();

    h.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
    await drainMicrotasks();
    h.fetches[1].gate.resolve({ url: "b" });
    await drainMicrotasks();

    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
    await drainMicrotasks();
    h.fetches[2].gate.resolve({ url: "a-new" });
    await drainMicrotasks();
    const [oldA, candidateB, newestA] = h.candidates;

    assert.equal(oldA.destroyCount, 1);
    assert.equal(candidateB.destroyCount, 1);
    const dimensions = [
      { width: 1, height: 1 },
      { width: 2, height: 2 },
      { width: 4, height: 4 },
    ];
    for (const index of order) {
      h.candidates[index].upload.resolve(dimensions[index]);
    }
    await drainMicrotasks();

    const staged = h.lifecycle.channels.albedo.staged;
    assert.equal(staged.candidate.value, newestA);
    assert.equal(staged.identity.requestSerial, 3);
    assert.equal(oldA.destroyCount, 1);
    assert.equal(candidateB.destroyCount, 1);
  }
});

test("A to B to A creates only the newest candidate in every fetch settlement order", async () => {
  const permutations = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of permutations) {
    const h = makeHarness();
    const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
    await drainMicrotasks();
    h.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
    await drainMicrotasks();
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
    await drainMicrotasks();
    assert.equal(h.fetches.length, 3);

    for (const index of order) {
      h.fetches[index].gate.resolve({ fetchIndex: index });
    }
    await drainMicrotasks();
    assert.equal(h.candidates.length, 1);
    assert.equal(h.candidates[0].image.fetchIndex, 2);
    h.candidates[0].upload.resolve({ width: 4, height: 4 });
    await drainMicrotasks();
    assert.equal(h.lifecycle.channels.albedo.staged.identity.requestSerial, 3);
  }
});

test("URL removal invalidates pending work and retires the published texture", async () => {
  const h = makeHarness();
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a" });
  await drainMicrotasks();
  h.candidates[0].upload.resolve({ width: 4, height: 2 });
  await drainMicrotasks();
  const publication = makePublicationHarness();
  commitWebGPUMoonTextureCandidate(
    h.lifecycle,
    MoonTextureChannel.ALBEDO,
    publication.callbacks,
  );

  const nonePair = createWebGPUMoonTexturePairKey(undefined, undefined);
  const result = h.request(
    MoonTextureChannel.ALBEDO,
    undefined,
    nonePair,
    false,
  );
  assert.equal(result.retireCurrent, true);
  assert.equal(
    retireWebGPUMoonPublishedTexture(
      h.lifecycle,
      MoonTextureChannel.ALBEDO,
      publication.callbacks,
    ),
    true,
  );
  assert.deepEqual(publication.events.slice(-4), [
    "prepare-placeholder",
    "invalidate",
    "publish-placeholder",
    "destroy:1",
  ]);
});

for (const mutation of ["owner", "device", "generation", "cache"]) {
  test(`${mutation} tuple mutation rejects a post-upload candidate`, async () => {
    const h = makeHarness();
    const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
    await drainMicrotasks();
    h.fetches[0].gate.resolve({ url: "a" });
    await drainMicrotasks();
    const candidate = h.candidates[0];

    if (mutation === "owner") h.owner._webgpuCache = {};
    if (mutation === "device") h.context.device = { name: "device-b" };
    if (mutation === "generation") h.context.resourceGeneration++;
    if (mutation === "cache") h.cache._moonTextureLifecycle = {};

    candidate.upload.resolve({ width: 8, height: 4 });
    await drainMicrotasks();
    assert.equal(candidate.destroyCount, 1);
    assert.equal(candidate.finalizeCount, 0);
    assert.equal(h.lifecycle.channels.albedo.staged, undefined);
  });
}

test("a reentrant finalizer cannot stage after invalidating its tuple", async () => {
  const h = makeHarness();
  h.hooks.finalizeCandidate = function (candidate, dimensions) {
    candidate.finalizeCount++;
    candidate.width = dimensions.width;
    candidate.height = dimensions.height;
    h.owner._webgpuCache = {};
    return candidate;
  };
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a" });
  await drainMicrotasks();
  const candidate = h.candidates[0];
  candidate.upload.resolve({ width: 8, height: 4 });
  await drainMicrotasks();

  assert.equal(candidate.finalizeCount, 1);
  assert.equal(candidate.destroyCount, 1);
  assert.equal(h.lifecycle.channels.albedo.staged, undefined);
});

test("zero normal demand starts no work and off/on retains matching work", async () => {
  const h = makeHarness();
  const pair = createWebGPUMoonTexturePairKey("a.jpg", "n.png");
  const off = h.request(MoonTextureChannel.NORMAL, "n.png", pair, false);
  await drainMicrotasks();
  assert.equal(off.started, false);
  assert.equal(h.fetches.length, 0);

  h.request(MoonTextureChannel.NORMAL, "n.png", pair, true);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "n" });
  await drainMicrotasks();
  const candidate = h.candidates[0];
  const offDuring = h.request(MoonTextureChannel.NORMAL, "n.png", pair, false);
  assert.equal(offDuring.started, false);
  assert.equal(candidate.destroyCount, 0);
  candidate.upload.resolve({ width: 4, height: 2 });
  await drainMicrotasks();
  assert.equal(h.lifecycle.channels.normal.state, "candidate-ready");

  const publication = makePublicationHarness({ id: "flat" });
  assert.equal(
    commitWebGPUMoonTextureCandidate(
      h.lifecycle,
      MoonTextureChannel.NORMAL,
      publication.callbacks,
    ),
    false,
  );
  assert.equal(publication.current.id, "flat");
  assert.deepEqual(publication.events, []);
  assert.equal(h.fetches.length, 1);
  assert.equal(
    h.request(MoonTextureChannel.NORMAL, "n.png", pair, true).started,
    false,
  );
  assert.equal(
    commitWebGPUMoonTextureCandidate(
      h.lifecycle,
      MoonTextureChannel.NORMAL,
      publication.callbacks,
    ),
    true,
  );
  assert.equal(publication.current, candidate);
  assert.equal(h.fetches.length, 1);
});

test("synchronous upload failure is classified as upload and destroys the candidate", async () => {
  const h = makeHarness();
  h.hooks.uploadCandidate = function () {
    throw new Error("sync copy failed");
  };
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a" });
  await drainMicrotasks();

  assert.equal(h.candidates[0].destroyCount, 1);
  assert.equal(h.lifecycle.channels.albedo.state, "failed");
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].phase, "candidate-upload");
});

test("published retirement remains successful when old cleanup and diagnostics throw", async () => {
  const h = makeHarness();
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a" });
  await drainMicrotasks();
  h.candidates[0].upload.resolve({ width: 4, height: 2 });
  await drainMicrotasks();
  const publication = makePublicationHarness();
  commitWebGPUMoonTextureCandidate(
    h.lifecycle,
    MoonTextureChannel.ALBEDO,
    publication.callbacks,
  );
  publication.callbacks.destroyPrevious = function () {
    throw new Error("old destroy failed");
  };
  publication.callbacks.onError = function () {
    throw new Error("diagnostic failed");
  };

  assert.equal(
    retireWebGPUMoonPublishedTexture(
      h.lifecycle,
      MoonTextureChannel.ALBEDO,
      publication.callbacks,
    ),
    true,
  );
  assert.equal(h.lifecycle.channels.albedo.currentIdentity, undefined);
  assert.equal(publication.current.id, "placeholder-next");
});

test("failed placeholder transaction destroys its prepared resource and keeps current", async () => {
  const h = makeHarness();
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a" });
  await drainMicrotasks();
  h.candidates[0].upload.resolve({ width: 4, height: 2 });
  await drainMicrotasks();
  const publication = makePublicationHarness();
  commitWebGPUMoonTextureCandidate(
    h.lifecycle,
    MoonTextureChannel.ALBEDO,
    publication.callbacks,
  );
  const before = publication.current;
  let rollbackDestroyCount = 0;
  publication.callbacks.invalidate = function () {
    throw new Error("invalidate failed");
  };
  publication.callbacks.destroyPreparedPlaceholder = function () {
    rollbackDestroyCount++;
  };
  publication.callbacks.onError = function () {
    throw new Error("diagnostic failed");
  };

  assert.equal(
    retireWebGPUMoonPublishedTexture(
      h.lifecycle,
      MoonTextureChannel.ALBEDO,
      publication.callbacks,
    ),
    false,
  );
  assert.equal(rollbackDestroyCount, 1);
  assert.equal(publication.current, before);
  assert.notEqual(h.lifecycle.channels.albedo.currentIdentity, undefined);
});

test("albedo and normal request serials advance independently", () => {
  const h = makeHarness();
  const pair = createWebGPUMoonTexturePairKey("a.jpg", "n.png");
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair, true);
  assert.equal(h.lifecycle.channels.albedo.requestSerial, 1);
  assert.equal(h.lifecycle.channels.normal.requestSerial, 0);
  h.request(MoonTextureChannel.NORMAL, "n.png", pair, false);
  assert.equal(h.lifecycle.channels.albedo.requestSerial, 1);
  assert.equal(h.lifecycle.channels.normal.requestSerial, 1);
});

test("steady-state reconciliation reuses lifecycle options and immutable results", () => {
  const h = makeHarness();
  const channel = h.lifecycle.channels.albedo;
  const options = channel.reconcileOptions;
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  options.url = "a.jpg";
  options.pairKey = pair;
  options.demanded = true;
  options.hooks = h.hooks;

  const started = reconcileWebGPUMoonTextureChannel(
    h.lifecycle,
    MoonTextureChannel.ALBEDO,
    options,
  );
  const firstNoWork = reconcileWebGPUMoonTextureChannel(
    h.lifecycle,
    MoonTextureChannel.ALBEDO,
    options,
  );
  const secondNoWork = reconcileWebGPUMoonTextureChannel(
    h.lifecycle,
    MoonTextureChannel.ALBEDO,
    options,
  );

  assert.equal(Object.isFrozen(started), true);
  assert.equal(Object.isFrozen(firstNoWork), true);
  assert.equal(firstNoWork, secondNoWork);
  assert.equal(channel.reconcileOptions, options);
  assert.notEqual(options, h.lifecycle.channels.normal.reconcileOptions);
});

test("transactional commit invalidates before publish and old retirement", async () => {
  const h = makeHarness();
  const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
  await drainMicrotasks();
  h.fetches[0].gate.resolve({ url: "a" });
  await drainMicrotasks();
  h.candidates[0].upload.resolve({ width: 8, height: 4 });
  await drainMicrotasks();
  const publication = makePublicationHarness();

  commitWebGPUMoonTextureCandidate(
    h.lifecycle,
    MoonTextureChannel.ALBEDO,
    publication.callbacks,
  );
  assert.deepEqual(publication.events, [
    "invalidate",
    "publish:1",
    "destroy:placeholder",
  ]);
  assert.equal(h.candidates[0].destroyCount, 0);
  assert.ok(h.monitorEvents.includes("resolve:albedo:1"));
});

test("failed URL can retry only after a deliberate away/back serial change", async () => {
  const h = makeHarness();
  const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
  h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
  await drainMicrotasks();
  h.fetches[0].gate.reject(new Error("404"));
  await drainMicrotasks();
  assert.equal(h.lifecycle.channels.albedo.state, "failed");
  assert.equal(
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA).started,
    false,
  );

  const nonePair = createWebGPUMoonTexturePairKey(undefined, undefined);
  h.request(MoonTextureChannel.ALBEDO, undefined, nonePair, false);
  assert.equal(
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA).started,
    true,
  );
  assert.equal(h.lifecycle.channels.albedo.requestSerial, 3);
});
