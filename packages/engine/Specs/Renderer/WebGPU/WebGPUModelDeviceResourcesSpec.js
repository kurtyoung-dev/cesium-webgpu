import {
  acquireWebGPUModelDeviceResources,
  getOrCreateWebGPUModelPipelineLayoutCache,
  releaseWebGPUModelDeviceResources,
} from "../../../Source/Renderer/WebGPU/WebGPUModelDeviceResources.js";

function makeDevice() {
  const textures = [];
  const buffers = [];
  const samplers = [];
  const bindGroupLayouts = [];
  const bindGroups = [];
  const writes = [];

  return {
    textures: textures,
    buffers: buffers,
    samplers: samplers,
    bindGroupLayouts: bindGroupLayouts,
    bindGroups: bindGroups,
    writes: writes,
    queue: {
      writeTexture: function () {
        writes.push("texture");
      },
      writeBuffer: function () {
        writes.push("buffer");
      },
    },
    createTexture: function (descriptor) {
      const texture = {
        descriptor: descriptor,
        views: [],
        destroy: jasmine.createSpy(`${descriptor.label}.destroy`),
        createView: function (viewDescriptor) {
          const view = { texture: texture, descriptor: viewDescriptor };
          texture.views.push(view);
          return view;
        },
      };
      textures.push(texture);
      return texture;
    },
    createBuffer: function (descriptor) {
      const buffer = {
        descriptor: descriptor,
        destroy: jasmine.createSpy(`${descriptor.label}.destroy`),
      };
      buffers.push(buffer);
      return buffer;
    },
    createSampler: function (descriptor) {
      const sampler = { descriptor: descriptor };
      samplers.push(sampler);
      return sampler;
    },
    createBindGroupLayout: function (descriptor) {
      const layout = { descriptor: descriptor };
      bindGroupLayouts.push(layout);
      return layout;
    },
    createBindGroup: function (descriptor) {
      const bindGroup = { descriptor: descriptor };
      bindGroups.push(bindGroup);
      return bindGroup;
    },
  };
}

function expectNotDestroyed(resources) {
  for (const texture of resources.textures) {
    expect(texture.destroy).not.toHaveBeenCalled();
  }
  for (const buffer of resources.buffers) {
    expect(buffer.destroy).not.toHaveBeenCalled();
  }
}

function expectDestroyedOnce(resources) {
  for (const texture of resources.textures) {
    expect(texture.destroy).toHaveBeenCalledTimes(1);
  }
  for (const buffer of resources.buffers) {
    expect(buffer.destroy).toHaveBeenCalledTimes(1);
  }
}

describe("Renderer/WebGPU/WebGPUModelDeviceResources", function () {
  it("shares immutable resources on one exact device until the final release", function () {
    const device = makeDevice();
    const first = acquireWebGPUModelDeviceResources(device, 7);
    const second = acquireWebGPUModelDeviceResources(device, 7);

    expect(second).toBe(first);
    expect(device.bindGroupLayouts.length).toBe(2);
    expect(device.textures.length).toBe(6);
    expect(device.buffers.length).toBe(13);
    expect(device.samplers.length).toBe(4);
    expect(device.bindGroups.length).toBe(1);
    expect(first.defaultInstanceBG.descriptor.layout).toBe(first.instanceBGL);
    expect(second.materialBGLCache).toBe(first.materialBGLCache);
    expect(second.pipelineLayoutCachesByEffectsLayout).toBe(
      first.pipelineLayoutCachesByEffectsLayout,
    );
    first.materialBGLCache.set(7, { label: "shared-material-layout" });

    const effectsLayout = {};
    const replacementEffectsLayout = {};
    const sharedPipelineLayouts = new Map([
      [7, { label: "shared-pipeline-layout" }],
    ]);
    first.pipelineLayoutCachesByEffectsLayout.set(
      effectsLayout,
      sharedPipelineLayouts,
    );
    expect(second.pipelineLayoutCachesByEffectsLayout.get(effectsLayout)).toBe(
      sharedPipelineLayouts,
    );
    expect(
      getOrCreateWebGPUModelPipelineLayoutCache(second, effectsLayout),
    ).toBe(sharedPipelineLayouts);
    expect(
      getOrCreateWebGPUModelPipelineLayoutCache(
        second,
        replacementEffectsLayout,
      ),
    ).not.toBe(sharedPipelineLayouts);

    releaseWebGPUModelDeviceResources(device, 7, first);
    expectNotDestroyed(device);
    expect(second.materialBGLCache.size).toBe(1);

    releaseWebGPUModelDeviceResources(device, 7, second);
    expectDestroyedOnce(device);
    expect(first.materialBGLCache.size).toBe(0);
  });

  it("partitions generations even when the GPUDevice identity is unchanged", function () {
    const device = makeDevice();
    const generationA = acquireWebGPUModelDeviceResources(device, 3);
    const generationAResources = {
      textures: device.textures.slice(),
      buffers: device.buffers.slice(),
    };
    const generationB = acquireWebGPUModelDeviceResources(device, 4);
    const generationBResources = {
      textures: device.textures.slice(generationAResources.textures.length),
      buffers: device.buffers.slice(generationAResources.buffers.length),
    };

    expect(generationB).not.toBe(generationA);
    expect(generationB.defaultWhiteTexture).not.toBe(
      generationA.defaultWhiteTexture,
    );

    releaseWebGPUModelDeviceResources(device, 3, generationA);
    expectDestroyedOnce(generationAResources);
    expectNotDestroyed(generationBResources);

    releaseWebGPUModelDeviceResources(device, 4, generationB);
    expectDestroyedOnce(generationBResources);
  });

  it("keeps devices isolated and recreates after final release", function () {
    const deviceA = makeDevice();
    const deviceB = makeDevice();
    const generationA = acquireWebGPUModelDeviceResources(deviceA, 2);
    const generationB = acquireWebGPUModelDeviceResources(deviceB, 2);

    expect(generationB).not.toBe(generationA);
    expect(generationB.defaultWhiteTexture).not.toBe(
      generationA.defaultWhiteTexture,
    );

    releaseWebGPUModelDeviceResources(deviceA, 2, generationA);
    const replacementA = acquireWebGPUModelDeviceResources(deviceA, 2);
    expect(replacementA).not.toBe(generationA);
    expect(deviceA.bindGroupLayouts.length).toBe(4);

    releaseWebGPUModelDeviceResources(deviceA, 2, replacementA);
    releaseWebGPUModelDeviceResources(deviceB, 2, generationB);
    expectDestroyedOnce(deviceA);
    expectDestroyedOnce(deviceB);
  });

  it("publishes stable views for the shared fallback textures", function () {
    const device = makeDevice();
    const resources = acquireWebGPUModelDeviceResources(device, 0);

    expect(resources.defaultWhiteTextureView.texture).toBe(
      resources.defaultWhiteTexture,
    );
    expect(resources.defaultNormalTextureView.texture).toBe(
      resources.defaultNormalTexture,
    );
    expect(resources.defaultBlackTextureView.texture).toBe(
      resources.defaultBlackTexture,
    );

    releaseWebGPUModelDeviceResources(device, 0, resources);
  });

  it("rolls back every native resource when construction fails before publication", function () {
    const device = makeDevice();
    const createBindGroup = device.createBindGroup;
    let rejectCreation = true;
    device.createBindGroup = function (descriptor) {
      if (rejectCreation) {
        throw new Error("late shared-resource construction failure");
      }
      return createBindGroup.call(device, descriptor);
    };

    expect(function () {
      acquireWebGPUModelDeviceResources(device, 11);
    }).toThrowError("late shared-resource construction failure");

    const failedResources = {
      textures: device.textures.slice(),
      buffers: device.buffers.slice(),
    };
    expect(failedResources.textures.length).toBeGreaterThan(0);
    expect(failedResources.buffers.length).toBeGreaterThan(0);
    expectDestroyedOnce(failedResources);

    // A failed transaction must not occupy the pool tuple. Retrying the exact
    // tuple builds a fresh graph and publishes only that successful graph.
    rejectCreation = false;
    const recovered = acquireWebGPUModelDeviceResources(device, 11);
    expect(recovered.defaultWhiteTexture).not.toBe(failedResources.textures[0]);
    for (const resource of failedResources.textures) {
      expect(resource.destroy).toHaveBeenCalledTimes(1);
    }
    for (const resource of failedResources.buffers) {
      expect(resource.destroy).toHaveBeenCalledTimes(1);
    }

    const successfulResources = {
      textures: device.textures.slice(failedResources.textures.length),
      buffers: device.buffers.slice(failedResources.buffers.length),
    };
    expectNotDestroyed(successfulResources);
    releaseWebGPUModelDeviceResources(device, 11, recovered);
    expectDestroyedOnce(successfulResources);
  });

  it("drains every shared owner before rethrowing the first release error", function () {
    const device = makeDevice();
    const resources = acquireWebGPUModelDeviceResources(device, 23);
    const firstError = new Error("lost-device texture destroy failed");
    device.textures[0].destroy.and.callFake(function () {
      throw firstError;
    });

    expect(function () {
      releaseWebGPUModelDeviceResources(device, 23, resources);
    }).toThrow(firstError);
    expectDestroyedOnce(device);

    // The failed native destroy must not leave the logical pool lease behind.
    const replacement = acquireWebGPUModelDeviceResources(device, 23);
    expect(replacement).not.toBe(resources);
    device.textures[0].destroy.and.stub();
    releaseWebGPUModelDeviceResources(device, 23, replacement);
  });
});
