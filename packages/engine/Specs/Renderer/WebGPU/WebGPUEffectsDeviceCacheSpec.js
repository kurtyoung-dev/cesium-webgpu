import {
  _destroyEffectsDeviceCache,
  _ensureEffectsBgCache,
  clearEffectsPlaceholderCacheForDevice,
  releaseEffectsPlaceholderCacheForContext,
  retainEffectsPlaceholderCacheForContext,
} from "../../../Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js";
import WebGPUEffectsStateCache from "../../../Source/Renderer/WebGPU/WebGPUEffectsStateCache.js";

describe("Renderer/WebGPU/WebGPUEffects device-cache ownership", function () {
  it("keeps a shared device cache until its last context owner releases it", function () {
    const device = {};
    const firstContext = {};
    const secondContext = {};

    retainEffectsPlaceholderCacheForContext(device, firstContext);
    retainEffectsPlaceholderCacheForContext(device, secondContext);
    // Retaining the same context twice is deliberately idempotent.
    retainEffectsPlaceholderCacheForContext(device, firstContext);

    expect(releaseEffectsPlaceholderCacheForContext(device, firstContext)).toBe(
      false,
    );
    expect(
      releaseEffectsPlaceholderCacheForContext(device, secondContext),
    ).toBe(true);
    expect(
      releaseEffectsPlaceholderCacheForContext(device, secondContext),
    ).toBe(false);
  });

  it("destroys active, retired, and placeholder resources exactly once", function () {
    const stateCache = new WebGPUEffectsStateCache({ maxGroups: 4 });
    const activeBuffer = { destroy: jasmine.createSpy("active.destroy") };
    stateCache.acquire(
      "active",
      new Uint32Array([1]),
      1,
      function () {
        return { buffer: activeBuffer, bindGroup: {} };
      },
      function () {},
      function () {},
    );

    const retiredBuffer = { destroy: jasmine.createSpy("retired.destroy") };
    const sharedPlaceholder = {
      destroy: jasmine.createSpy("placeholder.destroy"),
    };
    const cache = {
      owners: new Set([{}]),
      effectsBgCaches: new Map([[{}, { stateCache }]]),
      effectsRetirementPending: true,
      effectsRetirementQueue: [
        { buffer: retiredBuffer, bindGroup: {} },
        // A duplicate reference must still be destroyed just once.
        { buffer: retiredBuffer, bindGroup: {} },
      ],
      placeholderDepthTex: sharedPlaceholder,
      placeholderClipTex: sharedPlaceholder,
      placeholderUniformBuffer: sharedPlaceholder,
    };

    _destroyEffectsDeviceCache(cache);
    _destroyEffectsDeviceCache(cache);

    expect(activeBuffer.destroy).toHaveBeenCalledTimes(1);
    expect(retiredBuffer.destroy).toHaveBeenCalledTimes(1);
    expect(sharedPlaceholder.destroy).toHaveBeenCalledTimes(1);
    expect(cache.effectsRetirementPending).toBe(false);
    expect(cache.effectsRetirementQueue.length).toBe(0);
    expect(cache.owners.size).toBe(0);
    expect(stateCache.getDiagnostics(480).slotCount).toBe(0);
  });

  it("partitions volatile slots by context instead of Scene frame number", function () {
    const cache = {};
    const firstContext = {};
    const secondContext = {};
    const first = _ensureEffectsBgCache(cache, firstContext);
    const second = _ensureEffectsBgCache(cache, secondContext);

    expect(first).not.toBe(second);
    expect(_ensureEffectsBgCache(cache, firstContext)).toBe(first);

    const firstResource = first.stateCache.acquire(
      "same-owner-and-resources",
      new Uint32Array([1]),
      100,
      function () {
        return { buffer: {}, bindGroup: {} };
      },
      function () {},
      function () {},
    );
    const secondResource = second.stateCache.acquire(
      "same-owner-and-resources",
      new Uint32Array([1]),
      1,
      function () {
        return { buffer: {}, bindGroup: {} };
      },
      function () {},
      function () {},
    );

    expect(firstResource).not.toBe(secondResource);
    expect(first.stateCache.getDiagnostics(480).slotCount).toBe(1);
    expect(second.stateCache.getDiagnostics(480).slotCount).toBe(1);
  });

  it("allows whole-device invalidation to be repeated safely", function () {
    const device = {};
    const owner = {};
    retainEffectsPlaceholderCacheForContext(device, owner);

    clearEffectsPlaceholderCacheForDevice(device);
    clearEffectsPlaceholderCacheForDevice(device);
    expect(releaseEffectsPlaceholderCacheForContext(device, owner)).toBe(false);
  });
});
