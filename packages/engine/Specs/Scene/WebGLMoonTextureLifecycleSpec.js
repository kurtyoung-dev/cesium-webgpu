import {
  WebGLMoonTextureChannel,
  commitWebGLMoonTextureChannel,
  createWebGLMoonTextureLifecycle,
  createWebGLMoonTexturePairKey,
  getWebGLMoonTextureLifecycleDiagnostics,
  reconcileWebGLMoonTextureChannel,
  retireWebGLMoonTextureLifecycle,
} from "../../Source/Scene/WebGLMoonTextureLifecycle.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (resolvePromise, rejectPromise) {
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
  const context = {};
  const owner = {};
  const lifecycle = createWebGLMoonTextureLifecycle(owner, context);
  const acquisitions = [];
  const textures = [];
  const hooks = {
    acquireSource: function (url) {
      const gate = deferred();
      const lease = {
        source: { url },
        ready: gate.promise,
        releases: 0,
        release: function () {
          this.releases++;
        },
      };
      acquisitions.push({ gate, lease });
      return lease;
    },
  };
  function reconcile(channel, url, pairKey, demanded = true) {
    return reconcileWebGLMoonTextureChannel(lifecycle, channel, {
      context,
      url,
      pairKey,
      demanded,
      hooks,
    });
  }
  function commit(channel, commitContext = context) {
    return commitWebGLMoonTextureChannel(
      lifecycle,
      channel,
      commitContext,
      function (source, identity) {
        const texture = { source, identity, destroys: 0 };
        textures.push(texture);
        return texture;
      },
      function (texture) {
        texture.destroys++;
      },
    );
  }
  return {
    context,
    owner,
    lifecycle,
    acquisitions,
    textures,
    reconcile,
    commit,
  };
}

describe("Scene/WebGLMoonTextureLifecycle", function () {
  it("stages in the Promise callback and realizes only on frame commit", async function () {
    const h = makeHarness();
    const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
    h.acquisitions[0].gate.resolve();
    await drainMicrotasks();

    expect(h.textures.length).toBe(0);
    expect(h.acquisitions[0].lease.releases).toBe(0);
    expect(h.commit(WebGLMoonTextureChannel.ALBEDO).committed).toBe(true);
    expect(h.textures.length).toBe(1);
    expect(h.acquisitions[0].lease.releases).toBe(1);
  });

  it("reports source-free lifecycle identities and realization counters", async function () {
    const h = makeHarness();
    const pairA = createWebGLMoonTexturePairKey("a.jpg", undefined);
    const pairB = createWebGLMoonTexturePairKey("b.jpg", undefined);
    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pairA);

    let diagnostics = getWebGLMoonTextureLifecycleDiagnostics(h.lifecycle);
    expect(diagnostics.albedo.pendingUrl).toBe("a.jpg");
    expect(diagnostics.albedo.pendingPair).toBe(pairA);
    expect(diagnostics.albedo.realTexture).toBe(false);
    expect(diagnostics.albedo.gpuRealizations).toBe(0);

    h.acquisitions[0].gate.resolve();
    await drainMicrotasks();
    h.commit(WebGLMoonTextureChannel.ALBEDO);
    diagnostics = getWebGLMoonTextureLifecycleDiagnostics(h.lifecycle);
    expect(diagnostics.albedo.currentUrl).toBe("a.jpg");
    expect(diagnostics.albedo.currentPair).toBe(pairA);
    expect(diagnostics.albedo.pendingUrl).toBeNull();
    expect(diagnostics.albedo.pendingPair).toBeNull();
    expect(diagnostics.albedo.gpuRealizations).toBe(1);
    expect(diagnostics.albedo.publications).toBe(1);

    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "b.jpg", pairB);
    diagnostics = getWebGLMoonTextureLifecycleDiagnostics(h.lifecycle);
    expect(diagnostics.albedo.effectivePair).toBe(pairB);
    expect(diagnostics.albedo.currentUrl).toBe("a.jpg");
    expect(diagnostics.albedo.currentPair).toBe(pairA);
    expect(diagnostics.albedo.pendingUrl).toBe("b.jpg");
    expect(diagnostics.albedo.pendingPair).toBe(pairB);
    expect(diagnostics.albedo.value).toBeUndefined();
    expect(Object.isFrozen(diagnostics)).toBe(true);
    expect(Object.isFrozen(diagnostics.albedo)).toBe(true);
  });

  it("pins exact owner context URL pair and request serial identity", async function () {
    const h = makeHarness();
    const pairA = createWebGLMoonTexturePairKey("a.jpg", undefined);
    const pairB = createWebGLMoonTexturePairKey("b.jpg", undefined);
    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pairA);
    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "b.jpg", pairB);
    expect(h.acquisitions[0].lease.releases).toBe(1);
    h.acquisitions[1].gate.resolve();
    await drainMicrotasks();

    const result = h.commit(WebGLMoonTextureChannel.ALBEDO);
    expect(result.identity.owner).toBe(h.owner);
    expect(result.identity.context).toBe(h.context);
    expect(result.identity.exactUrl).toBe("b.jpg");
    expect(result.identity.effectivePair).toBe(pairB);
    expect(result.identity.requestSerial).toBe(2);
  });

  it("retains a matching normal realization across off and on", async function () {
    const h = makeHarness();
    const pair = createWebGLMoonTexturePairKey("a.jpg", "n.png");
    h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, true);
    h.acquisitions[0].gate.resolve();
    await drainMicrotasks();
    h.commit(WebGLMoonTextureChannel.NORMAL);

    expect(
      h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, false),
    ).toEqual({ retireCurrent: false, started: false });
    expect(
      h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, true),
    ).toEqual({ retireCurrent: false, started: false });
    expect(h.acquisitions.length).toBe(1);
    expect(h.textures.length).toBe(1);
  });

  it("finishes and retains matching in-flight normal work after demand turns off", async function () {
    const h = makeHarness();
    const pair = createWebGLMoonTexturePairKey("a.jpg", "n.png");
    h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, true);
    h.acquisitions[0].gate.resolve();
    await drainMicrotasks();
    h.reconcile(WebGLMoonTextureChannel.NORMAL, "n.png", pair, false);

    expect(h.commit(WebGLMoonTextureChannel.NORMAL).committed).toBe(true);
    expect(h.acquisitions[0].lease.releases).toBe(1);
    expect(h.textures.length).toBe(1);
  });

  it("does not realize against a non-current context", async function () {
    const h = makeHarness();
    const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
    h.acquisitions[0].gate.resolve();
    await drainMicrotasks();

    expect(h.commit(WebGLMoonTextureChannel.ALBEDO, {}).committed).toBe(false);
    expect(h.textures.length).toBe(0);
    expect(h.acquisitions[0].lease.releases).toBe(1);
  });

  it("releases pending ownership exactly once on teardown and late settle", async function () {
    const h = makeHarness();
    const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
    retireWebGLMoonTextureLifecycle(h.lifecycle, "owner destroyed");
    retireWebGLMoonTextureLifecycle(h.lifecycle, "owner destroyed again");
    expect(h.acquisitions[0].lease.releases).toBe(1);

    h.acquisitions[0].gate.resolve();
    await drainMicrotasks();
    expect(h.acquisitions[0].lease.releases).toBe(1);
    expect(h.textures.length).toBe(0);
  });

  it("rejects late readiness after its exact context is destroyed", async function () {
    const h = makeHarness();
    let destroyed = false;
    h.context.isDestroyed = function () {
      return destroyed;
    };
    const pair = createWebGLMoonTexturePairKey("a.jpg", undefined);
    h.reconcile(WebGLMoonTextureChannel.ALBEDO, "a.jpg", pair);
    destroyed = true;
    h.acquisitions[0].gate.resolve();
    await drainMicrotasks();

    expect(h.acquisitions[0].lease.releases).toBe(1);
    expect(h.lifecycle.channels.albedo.staged).toBeUndefined();
    expect(h.textures.length).toBe(0);
  });
});
