import {
  MoonTextureChannel,
  commitWebGPUMoonTextureCandidate,
  createWebGPUMoonTextureLifecycle,
  createWebGPUMoonTexturePairKey,
  reconcileWebGPUMoonTextureChannel,
  retireWebGPUMoonTextureLifecycle,
} from "../../../Source/Renderer/WebGPU/WebGPUMoonTextureLifecycle.js";
import { WebGPUContext } from "../../../Source/Renderer/WebGPU/WebGPUContext.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (resolvePromise, rejectPromise) {
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

function makeHarness() {
  const device = {};
  const context = { device, resourceGeneration: 7 };
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
  const hooks = {
    fetchImage: function (url) {
      const gate = deferred();
      fetches.push({ url, gate });
      return gate.promise;
    },
    createCandidate: function () {
      const candidate = {
        id: candidates.length + 1,
        upload: deferred(),
        destroys: 0,
        finalizes: 0,
      };
      candidates.push(candidate);
      return candidate;
    },
    uploadCandidate: function (_image, candidate) {
      return candidate.upload.promise;
    },
    finalizeCandidate: function (candidate) {
      candidate.finalizes++;
      candidate.view = {};
      return candidate;
    },
    destroyCandidate: function (candidate) {
      candidate.destroys++;
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
    lifecycle,
    hooks,
    fetches,
    candidates,
    request,
  };
}

describe("Renderer/WebGPU/WebGPUMoonTextureLifecycle", function () {
  it("destroys a superseded upload candidate once and only stages the replacement", async function () {
    const h = makeHarness();
    const pairA = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    const pairB = createWebGPUMoonTexturePairKey("b.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pairA);
    await drainMicrotasks();
    h.fetches[0].gate.resolve({});
    await drainMicrotasks();
    const stale = h.candidates[0];

    h.request(MoonTextureChannel.ALBEDO, "b.jpg", pairB);
    expect(stale.destroys).toBe(1);
    await drainMicrotasks();
    h.fetches[1].gate.resolve({});
    await drainMicrotasks();
    const current = h.candidates[1];
    stale.upload.resolve({});
    current.upload.resolve({});
    await drainMicrotasks();

    expect(stale.destroys).toBe(1);
    expect(h.lifecycle.channels.albedo.staged.candidate.value).toBe(current);
    expect(h.lifecycle.channels.albedo.staged.identity.exactUrl).toBe("b.jpg");
  });

  it("kills tuple mutations before stale candidates can be finalized", async function () {
    for (const mutation of ["owner", "device", "generation", "cache"]) {
      const h = makeHarness();
      const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
      h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
      await drainMicrotasks();
      h.fetches[0].gate.resolve({});
      await drainMicrotasks();
      const candidate = h.candidates[0];
      if (mutation === "owner") {
        h.owner._webgpuCache = {};
      } else if (mutation === "device") {
        h.context.device = {};
      } else if (mutation === "generation") {
        h.context.resourceGeneration++;
      } else {
        h.cache._moonTextureLifecycle = {};
      }
      candidate.upload.resolve({});
      await drainMicrotasks();
      expect(candidate.destroys).toBe(1);
      expect(candidate.finalizes).toBe(0);
      expect(h.lifecycle.channels.albedo.staged).toBeUndefined();
    }
  });

  it("destroys a candidate when a reentrant finalizer invalidates its tuple", async function () {
    const h = makeHarness();
    h.hooks.finalizeCandidate = function (candidate) {
      candidate.finalizes++;
      candidate.view = {};
      h.owner._webgpuCache = {};
      return candidate;
    };
    const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
    await drainMicrotasks();
    h.fetches[0].gate.resolve({});
    await drainMicrotasks();
    const candidate = h.candidates[0];
    candidate.upload.resolve({});
    await drainMicrotasks();

    expect(candidate.finalizes).toBe(1);
    expect(candidate.destroys).toBe(1);
    expect(h.lifecycle.channels.albedo.staged).toBeUndefined();
  });

  it("starts no normal work at zero demand and retains matching inflight work", async function () {
    const h = makeHarness();
    const pair = createWebGPUMoonTexturePairKey("a.jpg", "n.png");
    expect(
      h.request(MoonTextureChannel.NORMAL, "n.png", pair, false).started,
    ).toBe(false);
    await drainMicrotasks();
    expect(h.fetches.length).toBe(0);

    h.request(MoonTextureChannel.NORMAL, "n.png", pair, true);
    await drainMicrotasks();
    h.fetches[0].gate.resolve({});
    await drainMicrotasks();
    const candidate = h.candidates[0];
    h.request(MoonTextureChannel.NORMAL, "n.png", pair, false);
    candidate.upload.resolve({});
    await drainMicrotasks();
    expect(candidate.destroys).toBe(0);
    expect(h.lifecycle.channels.normal.state).toBe("candidate-ready");

    const events = [];
    let current = { id: "flat" };
    const callbacks = {
      invalidate: function () {
        events.push("invalidate");
      },
      publish: function (ready) {
        const previous = current;
        current = ready;
        events.push("publish");
        return previous;
      },
      destroyPrevious: function () {
        events.push("destroy-old");
      },
    };
    expect(
      commitWebGPUMoonTextureCandidate(
        h.lifecycle,
        MoonTextureChannel.NORMAL,
        callbacks,
      ),
    ).toBe(false);
    expect(events).toEqual([]);
    expect(current.id).toBe("flat");
    h.request(MoonTextureChannel.NORMAL, "n.png", pair, true);
    expect(
      commitWebGPUMoonTextureCandidate(
        h.lifecycle,
        MoonTextureChannel.NORMAL,
        callbacks,
      ),
    ).toBe(true);
    expect(current).toBe(candidate);
  });

  it("publishes only on update and invalidates before old retirement", async function () {
    const h = makeHarness();
    const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
    await drainMicrotasks();
    h.fetches[0].gate.resolve({});
    await drainMicrotasks();
    h.candidates[0].upload.resolve({});
    await drainMicrotasks();

    const events = [];
    let current = { id: "placeholder" };
    expect(current.id).toBe("placeholder");
    expect(h.lifecycle.channels.albedo.state).toBe("candidate-ready");
    commitWebGPUMoonTextureCandidate(h.lifecycle, MoonTextureChannel.ALBEDO, {
      invalidate: function () {
        events.push("invalidate");
      },
      publish: function (candidate) {
        const previous = current;
        current = candidate;
        events.push("publish");
        return previous;
      },
      destroyPrevious: function () {
        events.push("destroy-old");
      },
    });
    expect(events).toEqual(["invalidate", "publish", "destroy-old"]);
    expect(current).toBe(h.candidates[0]);
  });

  it("prepares frame-owned work immediately before transactional publication", async function () {
    const h = makeHarness();
    const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
    await drainMicrotasks();
    h.fetches[0].gate.resolve({});
    await drainMicrotasks();
    h.candidates[0].upload.resolve({});
    await drainMicrotasks();

    const events = [];
    const committed = commitWebGPUMoonTextureCandidate(
      h.lifecycle,
      MoonTextureChannel.ALBEDO,
      {
        prepareCandidate: function () {
          events.push("prepare-mips");
        },
        invalidate: function () {
          events.push("invalidate");
        },
        publish: function () {
          events.push("publish");
          return { id: "placeholder" };
        },
        destroyPrevious: function () {
          events.push("destroy-old");
        },
      },
    );

    expect(committed).toBe(true);
    expect(events).toEqual([
      "prepare-mips",
      "invalidate",
      "publish",
      "destroy-old",
    ]);
  });

  it("revalidates the exact tuple after frame-work preparation", async function () {
    const h = makeHarness();
    const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
    await drainMicrotasks();
    h.fetches[0].gate.resolve({});
    await drainMicrotasks();
    const candidate = h.candidates[0];
    candidate.upload.resolve({});
    await drainMicrotasks();

    const publish = jasmine.createSpy("publish");
    const committed = commitWebGPUMoonTextureCandidate(
      h.lifecycle,
      MoonTextureChannel.ALBEDO,
      {
        prepareCandidate: function () {
          h.owner._webgpuCache = {};
        },
        invalidate: jasmine.createSpy("invalidate"),
        publish: publish,
        destroyPrevious: jasmine.createSpy("destroyPrevious"),
      },
    );

    expect(committed).toBe(false);
    expect(publish).not.toHaveBeenCalled();
    expect(candidate.destroys).toBe(1);
    expect(h.lifecycle.channels.albedo.staged).toBeUndefined();
  });

  it("uses one renderer-neutral frame-owned mip queue and retains the imagery alias", function () {
    const queueSubmit = jasmine.createSpy("queue.submit");
    const encoder = {
      finish: jasmine.createSpy("encoder.finish").and.returnValue({}),
    };
    const context = Object.create(WebGPUContext.prototype);
    context._device = {
      queue: { submit: queueSubmit },
      createCommandEncoder: jasmine
        .createSpy("createCommandEncoder")
        .and.returnValue(encoder),
    };
    context._isDestroyed = false;
    context._terminallyLost = false;
    context._deviceResourceGeneration = 4;
    context._pendingTextureMipJobs = [];
    context._pendingTextureMipJobKeys = new WeakMap();
    context._inlineDestroyedTextures = new WeakSet();
    context._mipmapGenerator = {
      generateMipmaps: jasmine.createSpy("generateMipmaps"),
    };
    const canceledTexture = {};
    const liveTexture = {};

    context.enqueueTextureMipGeneration(canceledTexture, "rgba8unorm", 12);
    context.enqueueImageryMipGeneration(liveTexture, "rgba8unorm", 11);
    context.noteInlineTextureDestroy(canceledTexture);
    const commandBuffer = context._encodePendingTextureMipJobs();

    expect(commandBuffer).not.toBeNull();
    expect(context._mipmapGenerator.generateMipmaps).toHaveBeenCalledOnceWith(
      liveTexture,
      "rgba8unorm",
      11,
      encoder,
      {
        dimension: "2d",
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      },
    );
    expect(queueSubmit).not.toHaveBeenCalled();
    expect(context._pendingTextureMipJobs.length).toBe(0);
  });

  it("rejects unsupported queue formats before allocating preparation work", function () {
    const context = Object.create(WebGPUContext.prototype);
    context._device = { features: new Set() };
    context._isDestroyed = false;
    context._terminallyLost = false;
    context._deviceResourceGeneration = 1;
    context._pendingTextureMipJobs = [];
    context._pendingTextureMipJobKeys = new WeakMap();

    const texture = {};
    expect(context.enqueueTextureMipGeneration(texture, "rgba8uint", 4)).toBe(
      false,
    );
    expect(context._pendingTextureMipJobs.length).toBe(0);
    expect(context._pendingTextureMipJobKeys.get(texture)).toBeUndefined();
  });

  it("rejects layered generation on compatibility adapters without core view semantics", function () {
    const context = Object.create(WebGPUContext.prototype);
    context._device = { features: new Set() };
    context._options = { featureLevel: "compatibility" };
    context._isDestroyed = false;
    context._terminallyLost = false;
    context._deviceResourceGeneration = 1;
    context._pendingTextureMipJobs = [];
    context._pendingTextureMipJobKeys = new WeakMap();

    expect(
      context.enqueueTextureMipGeneration({}, "rgba8unorm", 4, {
        dimension: "cube",
        baseArrayLayer: 0,
        arrayLayerCount: 6,
      }),
    ).toBe(false);
    expect(context._pendingTextureMipJobs.length).toBe(0);

    context._device.features.add("core-features-and-limits");
    expect(
      context.enqueueTextureMipGeneration({}, "rgba8unorm", 4, {
        dimension: "cube",
        baseArrayLayer: 0,
        arrayLayerCount: 6,
      }),
    ).toBe(true);
  });

  it("requeues every live exact-tuple job when preparation encoding throws", function () {
    const encoder = { finish: jasmine.createSpy("finish") };
    const context = Object.create(WebGPUContext.prototype);
    context._device = {
      features: new Set(),
      createCommandEncoder: jasmine
        .createSpy("createCommandEncoder")
        .and.returnValue(encoder),
    };
    context._deviceResourceGeneration = 7;
    context._isDestroyed = false;
    context._terminallyLost = false;
    context._pendingTextureMipJobs = [];
    context._pendingTextureMipJobKeys = new WeakMap();
    context._inlineDestroyedTextures = new WeakSet();
    const failure = new Error("synthetic mip encode failure");
    context._mipmapGenerator = {
      generateMipmaps: jasmine
        .createSpy("generateMipmaps")
        .and.throwError(failure),
    };
    const texture = {};
    expect(context.enqueueTextureMipGeneration(texture, "rgba8unorm", 4)).toBe(
      true,
    );

    expect(function () {
      context._encodePendingTextureMipJobs();
    }).toThrow(failure);
    expect(context._pendingTextureMipJobs.length).toBe(1);
    expect(context.enqueueTextureMipGeneration(texture, "rgba8unorm", 4)).toBe(
      true,
    );
    expect(context._pendingTextureMipJobs.length).toBe(1);
    expect(encoder.finish).not.toHaveBeenCalled();
  });

  it("requeues encoded jobs when finishing the preparation buffer throws", function () {
    const finishFailure = new Error("synthetic mip finish failure");
    const encoder = {
      finish: jasmine.createSpy("finish").and.throwError(finishFailure),
    };
    const context = Object.create(WebGPUContext.prototype);
    context._device = {
      features: new Set(),
      createCommandEncoder: function () {
        return encoder;
      },
    };
    context._deviceResourceGeneration = 8;
    context._isDestroyed = false;
    context._terminallyLost = false;
    context._pendingTextureMipJobs = [];
    context._pendingTextureMipJobKeys = new WeakMap();
    context._inlineDestroyedTextures = new WeakSet();
    context._mipmapGenerator = {
      generateMipmaps: jasmine.createSpy("generateMipmaps"),
    };
    const texture = {};
    context.enqueueTextureMipGeneration(texture, "rgba8unorm", 3);

    expect(function () {
      context._encodePendingTextureMipJobs();
    }).toThrow(finishFailure);
    expect(context._pendingTextureMipJobs.length).toBe(1);
    expect(context._pendingTextureMipJobs[0].texture).toBe(texture);
  });

  it("requeues a synchronously rejected submit and retries it exactly once", function () {
    const submitFailure = new Error("synthetic mip submit failure");
    const submit = jasmine.createSpy("submit").and.callFake(function () {
      if (submit.calls.count() === 1) {
        throw submitFailure;
      }
    });
    const encoder = {
      finish: jasmine.createSpy("finish").and.returnValue({}),
    };
    const generateMipmaps = jasmine.createSpy("generateMipmaps");
    const context = Object.create(WebGPUContext.prototype);
    context._device = {
      features: new Set(),
      queue: { submit },
      createCommandEncoder: function () {
        return encoder;
      },
    };
    context._deviceResourceGeneration = 9;
    context._isDestroyed = false;
    context._terminallyLost = false;
    context._pendingTextureMipJobs = [];
    context._pendingTextureMipJobKeys = new WeakMap();
    context._inlineDestroyedTextures = new WeakSet();
    context._mipmapGenerator = { generateMipmaps };
    const texture = {};
    context.enqueueTextureMipGeneration(texture, "rgba8unorm", 3);

    expect(function () {
      context.flushPendingTextureMipJobs();
    }).toThrow(submitFailure);
    expect(context._pendingTextureMipJobs.length).toBe(1);

    context.flushPendingTextureMipJobs();
    expect(context._pendingTextureMipJobs.length).toBe(0);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(generateMipmaps).toHaveBeenCalledTimes(2);
  });

  it("encodes compatibility-copy mips into the current encoder only when no pass is active", function () {
    const encoder = {};
    const texture = {};
    const generateMipmaps = jasmine.createSpy("generateMipmaps");
    const context = Object.create(WebGPUContext.prototype);
    context._device = { features: new Set() };
    context._isDestroyed = false;
    context._terminallyLost = false;
    context._currentCommandEncoder = encoder;
    context._currentRenderPassEncoder = null;
    context._mipmapGenerator = { generateMipmaps };
    const options = {
      dimension: "2d",
      baseArrayLayer: 0,
      arrayLayerCount: 1,
    };

    expect(
      context.encodeTextureMipGenerationInCurrentEncoder(
        texture,
        "rgba8unorm",
        3,
        options,
      ),
    ).toBe(true);
    expect(generateMipmaps).toHaveBeenCalledOnceWith(
      texture,
      "rgba8unorm",
      3,
      encoder,
      options,
    );

    context._currentRenderPassEncoder = {};
    expect(
      context.encodeTextureMipGenerationInCurrentEncoder(
        texture,
        "rgba8unorm",
        3,
        options,
      ),
    ).toBe(false);
    expect(generateMipmaps).toHaveBeenCalledTimes(1);
  });

  it("drops an old-device job before lazily touching the replacement mip generator", function () {
    const oldDevice = {
      createCommandEncoder: jasmine.createSpy("old.createCommandEncoder"),
    };
    const replacementDevice = {
      createCommandEncoder: jasmine.createSpy(
        "replacement.createCommandEncoder",
      ),
    };
    const context = Object.create(WebGPUContext.prototype);
    context._device = oldDevice;
    context._deviceResourceGeneration = 12;
    context._isDestroyed = false;
    context._terminallyLost = false;
    context._pendingTextureMipJobs = [];
    context._pendingTextureMipJobKeys = new WeakMap();
    context._inlineDestroyedTextures = new WeakSet();
    context._mipmapGenerator = null;

    context.enqueueTextureMipGeneration({}, "rgba8unorm", 4);
    expect(context._pendingTextureMipJobs.length).toBe(1);
    expect(context._mipmapGenerator).toBeNull();

    // Simulate the most dangerous ordering: recovery publishes its candidate
    // before cache invalidation. Even if a future regression omitted the eager
    // queue clear, the exact ownership stamp must reject this stale job.
    context._device = replacementDevice;
    context._deviceResourceGeneration = 13;
    expect(context._encodePendingTextureMipJobs()).toBeNull();

    expect(replacementDevice.createCommandEncoder).not.toHaveBeenCalled();
    expect(context._mipmapGenerator).toBeNull();
    expect(context._pendingTextureMipJobs.length).toBe(0);
  });

  it("coalesces exact mip jobs while retaining distinct layer ranges", function () {
    const encoder = {
      finish: jasmine.createSpy("encoder.finish").and.returnValue({}),
    };
    const context = Object.create(WebGPUContext.prototype);
    context._device = {
      createCommandEncoder: jasmine
        .createSpy("createCommandEncoder")
        .and.returnValue(encoder),
    };
    context._deviceResourceGeneration = 2;
    context._isDestroyed = false;
    context._terminallyLost = false;
    context._pendingTextureMipJobs = [];
    context._pendingTextureMipJobKeys = new WeakMap();
    context._inlineDestroyedTextures = new WeakSet();
    context._mipmapGenerator = {
      generateMipmaps: jasmine.createSpy("generateMipmaps"),
    };
    const texture = {};
    const firstRange = {
      dimension: "2d-array",
      baseArrayLayer: 0,
      arrayLayerCount: 2,
    };
    const secondRange = {
      dimension: "2d-array",
      baseArrayLayer: 2,
      arrayLayerCount: 2,
    };

    context.enqueueTextureMipGeneration(texture, "rgba8unorm", 4, firstRange);
    context.enqueueTextureMipGeneration(texture, "rgba8unorm", 4, firstRange);
    context.enqueueTextureMipGeneration(texture, "rgba8unorm", 4, secondRange);

    expect(context._pendingTextureMipJobs.length).toBe(2);
    context._encodePendingTextureMipJobs();
    expect(context._mipmapGenerator.generateMipmaps.calls.count()).toBe(2);
    expect(
      context._mipmapGenerator.generateMipmaps.calls.argsFor(0)[4],
    ).toEqual(firstRange);
    expect(
      context._mipmapGenerator.generateMipmaps.calls.argsFor(1)[4],
    ).toEqual(secondRange);
  });

  it("routes context image mip creation through the frame-owned queue", function () {
    const rawTexture = {
      destroy: jasmine.createSpy("rawTexture.destroy"),
    };
    const submit = jasmine.createSpy("queue.submit");
    const device = {
      createTexture: jasmine
        .createSpy("device.createTexture")
        .and.returnValue(rawTexture),
      queue: {
        copyExternalImageToTexture: jasmine.createSpy(
          "copyExternalImageToTexture",
        ),
        submit: submit,
      },
    };
    const context = Object.create(WebGPUContext.prototype);
    context._device = device;
    context._deviceResourceGeneration = 5;
    context._isDestroyed = false;
    context._terminallyLost = false;
    context.enqueueTextureMipGeneration = jasmine
      .createSpy("enqueueTextureMipGeneration")
      .and.returnValue(true);
    const source = document.createElement("canvas");
    source.width = 4;
    source.height = 4;

    const texture = context.createTextureFromImage(source, "rgba8unorm", true);

    expect(texture.texture).toBe(rawTexture);
    expect(context.enqueueTextureMipGeneration).toHaveBeenCalledOnceWith(
      rawTexture,
      "rgba8unorm",
      3,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(rawTexture.destroy).not.toHaveBeenCalled();
  });

  it("rejects unsupported external-image destinations before allocation", function () {
    const rawTexture = {
      destroy: jasmine.createSpy("rawTexture.destroy"),
    };
    let descriptor;
    const device = {
      features: new Set(),
      createTexture: function (value) {
        descriptor = value;
        return rawTexture;
      },
      queue: {
        copyExternalImageToTexture: jasmine.createSpy(
          "copyExternalImageToTexture",
        ),
      },
    };
    const context = Object.create(WebGPUContext.prototype);
    context._device = device;
    context._deviceResourceGeneration = 5;
    context._isDestroyed = false;
    context._terminallyLost = false;
    context.enqueueTextureMipGeneration = jasmine.createSpy(
      "enqueueTextureMipGeneration",
    );
    const source = document.createElement("canvas");
    source.width = 4;
    source.height = 4;

    const texture = context.createTextureFromImage(source, "rgba8uint", true);

    expect(texture).toBeNull();
    expect(descriptor).toBeUndefined();
    expect(device.queue.copyExternalImageToTexture).not.toHaveBeenCalled();
    expect(context.enqueueTextureMipGeneration).not.toHaveBeenCalled();
    expect(rawTexture.destroy).not.toHaveBeenCalled();
  });

  it("keeps render-attachment usage required by a single-level external copy", function () {
    let descriptor;
    const rawTexture = { destroy: function () {} };
    const device = {
      features: new Set(),
      createTexture: function (value) {
        descriptor = value;
        return rawTexture;
      },
      queue: { copyExternalImageToTexture: function () {} },
    };
    const context = Object.create(WebGPUContext.prototype);
    context._device = device;
    context._deviceResourceGeneration = 5;
    context._isDestroyed = false;
    context._terminallyLost = false;
    const source = document.createElement("canvas");
    source.width = 4;
    source.height = 4;

    expect(
      context.createTextureFromImage(source, "rgba8unorm", false),
    ).not.toBeNull();
    expect(descriptor.mipLevelCount).toBe(1);
    expect(descriptor.usage & GPUTextureUsage.TEXTURE_BINDING).not.toBe(0);
    expect(descriptor.usage & GPUTextureUsage.COPY_DST).not.toBe(0);
    expect(descriptor.usage & GPUTextureUsage.RENDER_ATTACHMENT).not.toBe(0);
  });

  it("retirement prevents a late callback from mutating the orphan", async function () {
    const h = makeHarness();
    const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
    await drainMicrotasks();
    h.fetches[0].gate.resolve({});
    await drainMicrotasks();
    const candidate = h.candidates[0];
    retireWebGPUMoonTextureLifecycle(h.lifecycle, "spec-destroy");
    h.owner._webgpuCache = undefined;
    candidate.upload.resolve({});
    await drainMicrotasks();
    expect(candidate.destroys).toBe(1);
    expect(h.lifecycle.channels.albedo.state).toBe("retired");
  });

  it("releases a closeable fetch result that settles after retirement exactly once", async function () {
    const h = makeHarness();
    h.hooks.releaseFetchedSource = function (image) {
      image.close();
    };
    const image = {
      closeCount: 0,
      close: function () {
        this.closeCount++;
      },
    };
    const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
    await drainMicrotasks();
    retireWebGPUMoonTextureLifecycle(h.lifecycle, "spec-destroy");
    h.owner._webgpuCache = undefined;
    h.fetches[0].gate.resolve(image);
    await drainMicrotasks();

    expect(image.closeCount).toBe(1);
    expect(h.candidates.length).toBe(0);
  });

  it("transfers current fetched-source ownership without double closing", async function () {
    const h = makeHarness();
    let fetchedReleases = 0;
    let preparedReleases = 0;
    h.hooks.releaseFetchedSource = function (image) {
      fetchedReleases++;
      image.close();
    };
    h.hooks.prepareSource = function (image) {
      return { image };
    };
    h.hooks.releaseSource = function (source) {
      preparedReleases++;
      source.image.close();
    };
    const image = {
      closeCount: 0,
      close: function () {
        this.closeCount++;
      },
    };
    const pair = createWebGPUMoonTexturePairKey("a.jpg", undefined);
    h.request(MoonTextureChannel.ALBEDO, "a.jpg", pair);
    await drainMicrotasks();
    h.fetches[0].gate.resolve(image);
    await drainMicrotasks();
    h.candidates[0].upload.resolve({});
    await drainMicrotasks();

    expect(fetchedReleases).toBe(0);
    expect(preparedReleases).toBe(1);
    expect(image.closeCount).toBe(1);
  });

  it("reuses lifecycle options and immutable steady-state results", function () {
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

    expect(Object.isFrozen(started)).toBe(true);
    expect(Object.isFrozen(firstNoWork)).toBe(true);
    expect(firstNoWork).toBe(secondNoWork);
    expect(channel.reconcileOptions).toBe(options);
    expect(options).not.toBe(h.lifecycle.channels.normal.reconcileOptions);
  });
});
