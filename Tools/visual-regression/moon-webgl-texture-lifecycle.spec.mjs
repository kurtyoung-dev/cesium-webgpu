import test from "node:test";
import assert from "node:assert/strict";

import {
  WebGLMoonTextureChannel,
  commitWebGLMoonTextureChannel,
  createWebGLMoonTextureLifecycle,
  createWebGLMoonTexturePairKey,
  getWebGLMoonTextureLifecycleDiagnostics,
  getWebGLMoonPublishedTexture,
  prepareWebGLMoonUploadSource,
  reconcileWebGLMoonTextureChannel,
  retireWebGLMoonPublishedTexture,
  retireWebGLMoonTextureLifecycle,
  releaseWebGLMoonUploadSource,
} from "../../packages/engine/Source/Scene/WebGLMoonTextureLifecycle.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks(turns = 6) {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

function makeHarness() {
  const context = { name: "context-a" };
  const owner = {};
  const lifecycle = createWebGLMoonTextureLifecycle(owner, context);
  const acquisitions = [];
  const realizations = [];
  const errors = [];
  const destroyed = [];
  const hooks = {
    acquireSource(url, identity) {
      const gate = deferred();
      const source = {
        url,
        closeCount: 0,
        close() {
          this.closeCount++;
        },
      };
      const lease = {
        source,
        ready: gate.promise,
        releaseCount: 0,
        release() {
          this.releaseCount++;
          return this.releaseCount === 1;
        },
      };
      acquisitions.push({ url, identity, gate, lease, source });
      return lease;
    },
    onError(error, phase, identity) {
      errors.push({ error, phase, identity });
    },
  };
  function reconcile(
    channel,
    url,
    pairKey,
    demanded = true,
    requestHooks = hooks,
  ) {
    return reconcileWebGLMoonTextureChannel(lifecycle, channel, {
      context,
      url,
      pairKey,
      demanded,
      hooks: requestHooks,
    });
  }
  function commit(channel, commitContext = context, createTexture) {
    return commitWebGLMoonTextureChannel(
      lifecycle,
      channel,
      commitContext,
      createTexture ??
        ((source, identity) => {
          const texture = {
            source,
            identity,
            destroyCount: 0,
          };
          realizations.push(texture);
          return texture;
        }),
      (texture) => {
        texture.destroyCount++;
        destroyed.push(texture);
      },
    );
  }
  return {
    context,
    owner,
    lifecycle,
    hooks,
    acquisitions,
    realizations,
    errors,
    destroyed,
    reconcile,
    commit,
  };
}

test("callbacks stage decoded sources but WebGL realization waits for frame commit", async () => {
  const h = makeHarness();
  const pair = createWebGLMoonTexturePairKey("a.jpg", "n.png");
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();

  assert.equal(h.realizations.length, 0);
  assert.equal(h.lifecycle.channels.albedo.state, "source-ready");
  assert.equal(h.acquisitions[0].lease.releaseCount, 0);

  const publication = h.commit(WebGLMoonTextureChannel.ALBEDO);
  assert.equal(publication.committed, true);
  assert.equal(h.realizations.length, 1);
  assert.equal(h.acquisitions[0].lease.releaseCount, 1);
  assert.equal(h.acquisitions[0].source.closeCount, 0);
  assert.equal(
    getWebGLMoonPublishedTexture(h.lifecycle, WebGLMoonTextureChannel.ALBEDO),
    publication.value,
  );
});

test("A to B to A mutation releases each stale pending lease exactly once", async () => {
  const h = makeHarness();
  const pairA = createWebGLMoonTexturePairKey("a.jpg", "n-a.png");
  const pairB = createWebGLMoonTexturePairKey("b.jpg", "n-b.png");

  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pairA);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "b.jpg", pairB);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pairA);
  assert.deepEqual(
    h.acquisitions.map((entry) => entry.lease.releaseCount),
    [1, 1, 0],
  );

  for (const acquisition of h.acquisitions) {
    acquisition.gate.resolve();
  }
  await drainMicrotasks();
  const result = h.commit(WebGLMoonTextureChannel.ALBEDO);
  assert.equal(result.committed, true);
  assert.equal(result.identity.exactUrl, "a.jpg");
  assert.equal(result.identity.requestSerial, 3);
  assert.deepEqual(
    h.acquisitions.map((entry) => entry.lease.releaseCount),
    [1, 1, 1],
  );
  assert.equal(h.realizations.length, 1);
});

test("A to pending B to A retains the published texture and reports current", async () => {
  const h = makeHarness();
  const pairA = createWebGLMoonTexturePairKey("a.jpg", "n-a.png");
  const pairB = createWebGLMoonTexturePairKey("b.jpg", "n-b.png");

  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pairA);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  const publishedA = h.commit(WebGLMoonTextureChannel.ALBEDO);
  assert.equal(publishedA.committed, true);
  assert.equal(h.lifecycle.channels.albedo.state, "current");

  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "b.jpg", pairB);
  assert.equal(h.lifecycle.channels.albedo.state, "source-pending");
  const backToA = h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pairA);

  assert.deepEqual(backToA, { retireCurrent: false, started: false });
  assert.equal(h.acquisitions.length, 2);
  assert.equal(h.acquisitions[1].lease.releaseCount, 1);
  assert.equal(h.lifecycle.channels.albedo.state, "current");
  assert.equal(
    getWebGLMoonPublishedTexture(h.lifecycle, WebGLMoonTextureChannel.ALBEDO),
    publishedA.value,
  );
  assert.equal(h.realizations.length, 1);
});

test("A to pending B to A reports current while relief is disabled", async () => {
  const h = makeHarness();
  const pairA = createWebGLMoonTexturePairKey("a.jpg", "n-a.png");
  const pairB = createWebGLMoonTexturePairKey("b.jpg", "n-b.png");

  h.reconcile(WebGLMoonTextureChannel.NORMAL, "n-a.png", pairA);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  const publishedA = h.commit(WebGLMoonTextureChannel.NORMAL);
  assert.equal(publishedA.committed, true);

  h.reconcile(WebGLMoonTextureChannel.NORMAL, "n-b.png", pairB, false);
  const backToA = h.reconcile(
    WebGLMoonTextureChannel.NORMAL,
    "n-a.png",
    pairA,
    false,
  );

  assert.deepEqual(backToA, { retireCurrent: false, started: false });
  assert.equal(h.lifecycle.channels.normal.state, "current");
  assert.equal(h.lifecycle.channels.normal.demanded, false);
  assert.equal(
    getWebGLMoonPublishedTexture(h.lifecycle, WebGLMoonTextureChannel.NORMAL),
    publishedA.value,
  );
  assert.equal(h.realizations.length, 1);
});

test("matching normal realization survives relief off and returns without work", async () => {
  const h = makeHarness();
  const pair = createWebGLMoonTexturePairKey("a.jpg", "n.png");
  h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, true);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  const first = h.commit(WebGLMoonTextureChannel.NORMAL);
  assert.equal(first.committed, true);

  const off = h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, false);
  assert.deepEqual(off, { retireCurrent: false, started: false });
  assert.equal(h.commit(WebGLMoonTextureChannel.NORMAL).committed, false);
  const on = h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, true);
  assert.deepEqual(on, { retireCurrent: false, started: false });
  assert.equal(h.acquisitions.length, 1);
  assert.equal(h.realizations.length, 1);
  assert.equal(
    getWebGLMoonPublishedTexture(h.lifecycle, WebGLMoonTextureChannel.NORMAL),
    first.value,
  );
});

test("normal work already in flight realizes and remains retained after relief turns off", async () => {
  const h = makeHarness();
  const pair = createWebGLMoonTexturePairKey("a.jpg", "n.png");
  h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, true);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();

  h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, false);
  const result = h.commit(WebGLMoonTextureChannel.NORMAL);
  assert.equal(result.committed, true);
  assert.equal(h.acquisitions[0].lease.releaseCount, 1);
  assert.equal(h.realizations.length, 1);
  assert.equal(
    getWebGLMoonPublishedTexture(h.lifecycle, WebGLMoonTextureChannel.NORMAL),
    result.value,
  );
});

test("WebGL preparation bakes ImageBitmap flip and closes only its derivative", async () => {
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const shared = {
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };
  const derivative = {
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };
  let observedSource;
  let observedOptions;
  globalThis.createImageBitmap = async function (source, options) {
    observedSource = source;
    observedOptions = options;
    return derivative;
  };
  try {
    const prepared = await prepareWebGLMoonUploadSource(shared);
    assert.equal(observedSource, shared);
    assert.equal(observedOptions.imageOrientation, "flipY");
    assert.equal(prepared.uploadSource, derivative);
    assert.equal(prepared.flipY, false);
    releaseWebGLMoonUploadSource(prepared);
    releaseWebGLMoonUploadSource(prepared);
    assert.equal(derivative.closeCount, 1);
    assert.equal(shared.closeCount, 0);
  } finally {
    if (originalCreateImageBitmap === undefined) {
      delete globalThis.createImageBitmap;
    } else {
      globalThis.createImageBitmap = originalCreateImageBitmap;
    }
  }
});

test("teardown during asynchronous preparation defers lease release until the read ends", async () => {
  const h = makeHarness();
  const preparation = deferred();
  const derivative = { releaseCount: 0 };
  const hooks = {
    acquireSource: h.hooks.acquireSource,
    prepareSource() {
      return preparation.promise;
    },
    releaseSource(source) {
      source.releaseCount++;
    },
  };
  const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair, true, hooks);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  retireWebGLMoonTextureLifecycle(h.lifecycle, "destroyed during prepare");
  assert.equal(h.acquisitions[0].lease.releaseCount, 0);

  preparation.resolve(derivative);
  await drainMicrotasks();
  assert.equal(derivative.releaseCount, 1);
  assert.equal(h.acquisitions[0].lease.releaseCount, 1);
  assert.equal(h.realizations.length, 0);
});

test("normal URL mutation while relief is off retires the mismatched GPU value", async () => {
  const h = makeHarness();
  const pairA = createWebGLMoonTexturePairKey("a.jpg", "n-a.png");
  h.reconcile(WebGLMoonTextureChannel.NORMAL, "n-a.png", pairA, true);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  const first = h.commit(WebGLMoonTextureChannel.NORMAL);

  const pairB = createWebGLMoonTexturePairKey("a.jpg", "n-b.png");
  const result = h.reconcile(
    WebGLMoonTextureChannel.NORMAL,
    "n-b.png",
    pairB,
    false,
  );
  assert.deepEqual(result, { retireCurrent: true, started: false });
  const retirement = retireWebGLMoonPublishedTexture(
    h.lifecycle,
    WebGLMoonTextureChannel.NORMAL,
  );
  assert.equal(retirement.previous, first.value);
  assert.equal(h.acquisitions.length, 1);
});

test("wrong-context frame cannot realize a staged source", async () => {
  const h = makeHarness();
  const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();

  const result = h.commit(WebGLMoonTextureChannel.ALBEDO, {
    name: "context-b",
  });
  assert.equal(result.committed, false);
  assert.equal(h.realizations.length, 0);
  assert.equal(h.acquisitions[0].lease.releaseCount, 1);
});

test("context retirement prevents a late callback from publishing", async () => {
  const h = makeHarness();
  const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
  const retired = retireWebGLMoonTextureLifecycle(
    h.lifecycle,
    "context changed",
  );
  assert.deepEqual(retired, { albedo: undefined, normal: undefined });
  assert.equal(h.acquisitions[0].lease.releaseCount, 1);

  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  assert.equal(h.realizations.length, 0);
  assert.equal(h.lifecycle.channels.albedo.staged, undefined);
  assert.equal(h.acquisitions[0].source.closeCount, 0);
});

test("a destroyed current context rejects late source readiness", async () => {
  const h = makeHarness();
  let destroyed = false;
  h.context.isDestroyed = () => destroyed;
  const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
  destroyed = true;
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();

  assert.equal(h.acquisitions[0].lease.releaseCount, 1);
  assert.equal(h.lifecycle.channels.albedo.staged, undefined);
  assert.equal(h.commit(WebGLMoonTextureChannel.ALBEDO).committed, false);
  assert.equal(h.realizations.length, 0);
});

test("teardown releases a staged source exactly once", async () => {
  const h = makeHarness();
  const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  assert.equal(h.acquisitions[0].lease.releaseCount, 0);

  retireWebGLMoonTextureLifecycle(h.lifecycle, "owner destroyed");
  retireWebGLMoonTextureLifecycle(h.lifecycle, "owner destroyed again");
  assert.equal(h.acquisitions[0].lease.releaseCount, 1);
  assert.equal(h.acquisitions[0].source.closeCount, 0);
});

test("one of two shared consumers can retire while the other realizes", async () => {
  const source = {
    closeCount: 0,
    close() {
      this.closeCount++;
    },
  };
  const gate = deferred();
  const leases = [];
  const acquireSource = () => {
    const lease = {
      source,
      ready: gate.promise,
      releaseCount: 0,
      release() {
        this.releaseCount++;
      },
    };
    leases.push(lease);
    return lease;
  };
  const first = makeHarness();
  const second = makeHarness();
  const hooks = { acquireSource };
  const pair = createWebGLMoonTexturePairKey("shared.jpg", undefined);
  first.reconcile(
    WebGLMoonTextureChannel.ALBEDO,
    "shared.jpg",
    pair,
    true,
    hooks,
  );
  second.reconcile(
    WebGLMoonTextureChannel.ALBEDO,
    "shared.jpg",
    pair,
    true,
    hooks,
  );
  retireWebGLMoonTextureLifecycle(first.lifecycle, "first owner destroyed");
  gate.resolve();
  await drainMicrotasks();
  const result = second.commit(WebGLMoonTextureChannel.ALBEDO);

  assert.equal(result.committed, true);
  assert.deepEqual(
    leases.map((lease) => lease.releaseCount),
    [1, 1],
  );
  assert.equal(source.closeCount, 0);
});

test("reentrant URL mutation during realization destroys only the stale Texture", async () => {
  const h = makeHarness();
  const pairA = createWebGLMoonTexturePairKey("a.jpg", undefined);
  const pairB = createWebGLMoonTexturePairKey("b.jpg", undefined);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pairA);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();

  const result = h.commit(
    WebGLMoonTextureChannel.ALBEDO,
    h.context,
    (source, identity) => {
      const texture = { source, identity, destroyCount: 0 };
      h.realizations.push(texture);
      h.reconcile(WebGLMoonTextureChannel.ALBEDO, "b.jpg", pairB);
      return texture;
    },
  );
  assert.equal(result.committed, false);
  assert.equal(h.realizations[0].destroyCount, 1);
  assert.equal(h.acquisitions[0].lease.releaseCount, 1);
  assert.equal(h.acquisitions.length, 2);
});

test("reentrant source acquisition releases the orphan and preserves its replacement", async () => {
  const h = makeHarness();
  const pairA = createWebGLMoonTexturePairKey("a.jpg", undefined);
  const pairB = createWebGLMoonTexturePairKey("b.jpg", undefined);
  let reentered = false;
  const hooks = {
    acquireSource(url, identity) {
      const lease = h.hooks.acquireSource(url, identity);
      if (!reentered) {
        reentered = true;
        h.reconcile(
          WebGLMoonTextureChannel.ALBEDO,
          "b.jpg",
          pairB,
          true,
          h.hooks,
        );
      }
      return lease;
    },
  };

  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pairA, true, hooks);
  assert.deepEqual(
    h.acquisitions.map((entry) => entry.lease.releaseCount),
    [1, 0],
  );
  // The nested replacement is acquired before the stale outer lease returns.
  h.acquisitions[0].gate.resolve();
  h.acquisitions[1].gate.resolve();
  await drainMicrotasks();
  const result = h.commit(WebGLMoonTextureChannel.ALBEDO);
  assert.equal(result.committed, true);
  assert.equal(result.identity.exactUrl, "b.jpg");
  assert.deepEqual(
    h.acquisitions.map((entry) => entry.lease.releaseCount),
    [1, 1],
  );
});

test("a throwing readiness getter fails without escaping or leaking its lease", () => {
  const h = makeHarness();
  const lease = {
    source: {},
    releaseCount: 0,
    release() {
      this.releaseCount++;
    },
    get ready() {
      throw new Error("hostile ready getter");
    },
  };
  const pair = createWebGLMoonTexturePairKey("bad.jpg", undefined);
  assert.doesNotThrow(() => {
    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "bad.jpg", pair, true, {
      acquireSource() {
        return lease;
      },
      onError: h.hooks.onError,
    });
  });
  assert.equal(lease.releaseCount, 1);
  assert.equal(h.lifecycle.channels.albedo.state, "failed");
  assert.equal(h.errors[0].phase, "source-ready");
});

test("realization failure releases the lease and suppresses same-identity retry", async () => {
  const h = makeHarness();
  const pair = createWebGLMoonTexturePairKey("bad.jpg", undefined);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "bad.jpg", pair);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  const result = h.commit(WebGLMoonTextureChannel.ALBEDO, h.context, () => {
    throw new Error("upload failed");
  });
  assert.equal(result.committed, false);
  assert.equal(h.acquisitions[0].lease.releaseCount, 1);
  assert.equal(h.errors[0].phase, "texture-realization");
  assert.deepEqual(
    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "bad.jpg", pair),
    { retireCurrent: false, started: false },
  );
  assert.equal(h.acquisitions.length, 1);
});

test("albedo and normal request serials remain independent", () => {
  const h = makeHarness();
  const pair = createWebGLMoonTexturePairKey("a.jpg", "n.png");
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
  assert.equal(h.lifecycle.channels.albedo.requestSerial, 1);
  assert.equal(h.lifecycle.channels.normal.requestSerial, 0);
  h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, false);
  assert.equal(h.lifecycle.channels.albedo.requestSerial, 1);
  assert.equal(h.lifecycle.channels.normal.requestSerial, 1);
});

test("steady-state reconciliation and empty commits reuse immutable results", async () => {
  const h = makeHarness();
  const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  h.commit(WebGLMoonTextureChannel.ALBEDO);

  const first = h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
  const second = h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
  assert.equal(first, second);
  const firstEmptyCommit = h.commit(WebGLMoonTextureChannel.ALBEDO);
  const secondEmptyCommit = h.commit(WebGLMoonTextureChannel.ALBEDO);
  assert.equal(firstEmptyCommit, secondEmptyCommit);
});

test("diagnostics expose identities and counters without GPU or decoded-source handles", async () => {
  const h = makeHarness();
  const pairA = createWebGLMoonTexturePairKey("a.jpg", "n.png");
  const pairB = createWebGLMoonTexturePairKey("b.jpg", "n.png");
  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pairA);

  let diagnostics = getWebGLMoonTextureLifecycleDiagnostics(h.lifecycle);
  assert.equal(diagnostics.albedo.pendingUrl, "a.jpg");
  assert.equal(diagnostics.albedo.pendingPair, pairA);
  assert.equal(diagnostics.albedo.realTexture, false);
  assert.equal(diagnostics.albedo.gpuRealizations, 0);

  h.acquisitions[0].gate.resolve();
  await drainMicrotasks();
  h.commit(WebGLMoonTextureChannel.ALBEDO);

  diagnostics = getWebGLMoonTextureLifecycleDiagnostics(h.lifecycle);
  assert.equal(diagnostics.albedo.currentUrl, "a.jpg");
  assert.equal(diagnostics.albedo.currentPair, pairA);
  assert.equal(diagnostics.albedo.pendingUrl, null);
  assert.equal(diagnostics.albedo.pendingPair, null);
  assert.equal(diagnostics.albedo.gpuRealizations, 1);
  assert.equal(diagnostics.albedo.publications, 1);

  h.reconcile(WebGLMoonTextureChannel.ALBEDO, "b.jpg", pairB);
  diagnostics = getWebGLMoonTextureLifecycleDiagnostics(h.lifecycle);
  assert.equal(diagnostics.albedo.effectivePair, pairB);
  assert.equal(diagnostics.albedo.currentUrl, "a.jpg");
  assert.equal(diagnostics.albedo.currentPair, pairA);
  assert.equal(diagnostics.albedo.pendingUrl, "b.jpg");
  assert.equal(diagnostics.albedo.pendingPair, pairB);
  assert.equal("value" in diagnostics.albedo, false);
  assert.equal("source" in diagnostics.albedo, false);
  assert.equal(Object.isFrozen(diagnostics), true);
  assert.equal(Object.isFrozen(diagnostics.albedo), true);
});
