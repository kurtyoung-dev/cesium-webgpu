import {
  _destroyEffectsDeviceCache,
  _ensureEffectsBgCache,
  clearEffectsPlaceholderCacheForDevice,
  getPlaceholderEffects,
  releaseEffectsPlaceholderCacheForContext,
  retainEffectsPlaceholderCacheForContext,
} from "../../../Source/Renderer/WebGPU/WebGPUEffectsBindGroup.js";
import WebGPUEffectsStateCache from "../../../Source/Renderer/WebGPU/WebGPUEffectsStateCache.js";

describe("Renderer/WebGPU/WebGPUEffects device-cache ownership", function () {
  it("initializes all eleven depth placeholders with one cached submission", function () {
    const textures = [];
    const passes = [];
    const commandBuffers = [];
    const createCommandEncoderSpy = jasmine.createSpy("createCommandEncoder");
    const submit = jasmine.createSpy("submit");
    const device = {
      createBindGroupLayout(descriptor) {
        return { descriptor };
      },
      createBindGroup(descriptor) {
        return { descriptor };
      },
      createBuffer(descriptor) {
        return { descriptor, destroy: jasmine.createSpy("buffer.destroy") };
      },
      createSampler(descriptor) {
        return { descriptor };
      },
      createTexture(descriptor) {
        const texture = {
          descriptor,
          views: [],
          destroy: jasmine.createSpy("texture.destroy"),
          createView(viewDescriptor = {}) {
            const view = { texture, descriptor: viewDescriptor };
            texture.views.push(view);
            return view;
          },
        };
        textures.push(texture);
        return texture;
      },
      createCommandEncoder(descriptor) {
        createCommandEncoderSpy(descriptor);
        const commandBuffer = {};
        commandBuffers.push(commandBuffer);
        return {
          beginRenderPass(passDescriptor) {
            passes.push(passDescriptor);
            return { end() {} };
          },
          finish: jasmine.createSpy("finish").and.returnValue(commandBuffer),
        };
      },
      queue: {
        writeBuffer() {},
        writeTexture() {},
        submit,
      },
    };

    const first = getPlaceholderEffects(device);
    const second = getPlaceholderEffects(device);

    expect(second.bindGroup).toBe(first.bindGroup);
    expect(second.uniformBuffer).toBe(first.uniformBuffer);
    expect(createCommandEncoderSpy).toHaveBeenCalledTimes(1);
    expect(createCommandEncoderSpy).toHaveBeenCalledWith({
      label: "Initialize effects depth placeholders",
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith([commandBuffers[0]]);
    expect(passes.length).toBe(11);
    for (const pass of passes) {
      expect(pass.colorAttachments).toEqual([]);
      expect(pass.depthStencilAttachment.depthClearValue).toBe(1.0);
      expect(pass.depthStencilAttachment.depthLoadOp).toBe("clear");
      expect(pass.depthStencilAttachment.depthStoreOp).toBe("store");
    }

    const entries = first.bindGroup.descriptor.entries;
    const baseDepthView = entries.find((entry) => entry.binding === 1).resource;
    const csmDepthView = entries.find((entry) => entry.binding === 11).resource;
    const cubeDepthView = entries.find(
      (entry) => entry.binding === 17,
    ).resource;
    expect(passes[0].depthStencilAttachment.view).toBe(baseDepthView);
    expect(baseDepthView.texture.views.length).toBe(1);
    expect(
      passes
        .slice(1, 5)
        .map(
          (pass) => pass.depthStencilAttachment.view.descriptor.baseArrayLayer,
        ),
    ).toEqual([0, 1, 2, 3]);
    expect(
      passes
        .slice(1, 5)
        .every(
          (pass) =>
            pass.depthStencilAttachment.view.texture === csmDepthView.texture,
        ),
    ).toBeTrue();
    expect(
      passes
        .slice(5)
        .map(
          (pass) => pass.depthStencilAttachment.view.descriptor.baseArrayLayer,
        ),
    ).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      passes
        .slice(5)
        .every(
          (pass) =>
            pass.depthStencilAttachment.view.texture === cubeDepthView.texture,
        ),
    ).toBeTrue();

    const firstDepthTexture = baseDepthView.texture;
    clearEffectsPlaceholderCacheForDevice(device);
    expect(firstDepthTexture.destroy).toHaveBeenCalledTimes(1);

    const recovered = getPlaceholderEffects(device);
    expect(recovered.bindGroup).not.toBe(first.bindGroup);
    expect(
      recovered.bindGroup.descriptor.entries.find(
        (entry) => entry.binding === 1,
      ).resource.texture,
    ).not.toBe(firstDepthTexture);
    expect(createCommandEncoderSpy).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(passes.length).toBe(22);

    clearEffectsPlaceholderCacheForDevice(device);
  });

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
