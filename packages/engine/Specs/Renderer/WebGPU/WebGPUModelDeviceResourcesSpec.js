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
    const first = acquireWebGPUModelDeviceResources(device);
    const second = acquireWebGPUModelDeviceResources(device);

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

    releaseWebGPUModelDeviceResources(device, first);
    expectNotDestroyed(device);
    expect(second.materialBGLCache.size).toBe(1);

    releaseWebGPUModelDeviceResources(device, second);
    expectDestroyedOnce(device);
    expect(first.materialBGLCache.size).toBe(0);
  });

  it("keeps device generations isolated and recreates after final release", function () {
    const deviceA = makeDevice();
    const deviceB = makeDevice();
    const generationA = acquireWebGPUModelDeviceResources(deviceA);
    const generationB = acquireWebGPUModelDeviceResources(deviceB);

    expect(generationB).not.toBe(generationA);
    expect(generationB.defaultWhiteTexture).not.toBe(
      generationA.defaultWhiteTexture,
    );

    releaseWebGPUModelDeviceResources(deviceA, generationA);
    const replacementA = acquireWebGPUModelDeviceResources(deviceA);
    expect(replacementA).not.toBe(generationA);
    expect(deviceA.bindGroupLayouts.length).toBe(4);

    releaseWebGPUModelDeviceResources(deviceA, replacementA);
    releaseWebGPUModelDeviceResources(deviceB, generationB);
    expectDestroyedOnce(deviceA);
    expectDestroyedOnce(deviceB);
  });

  it("publishes stable views for the shared fallback textures", function () {
    const device = makeDevice();
    const resources = acquireWebGPUModelDeviceResources(device);

    expect(resources.defaultWhiteTextureView.texture).toBe(
      resources.defaultWhiteTexture,
    );
    expect(resources.defaultNormalTextureView.texture).toBe(
      resources.defaultNormalTexture,
    );
    expect(resources.defaultBlackTextureView.texture).toBe(
      resources.defaultBlackTexture,
    );

    releaseWebGPUModelDeviceResources(device, resources);
  });
});
