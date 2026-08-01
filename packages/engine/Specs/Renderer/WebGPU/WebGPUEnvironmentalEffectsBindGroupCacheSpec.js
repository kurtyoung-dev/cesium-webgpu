import {
  clearCloudCompositeBindGroupCaches,
  getOrCreateCloudMainBindGroup,
  getOrCreateCloudUpscaleBindGroup,
} from "../../../Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.js";
import {
  clearFogCompositeBindGroupCache,
  getOrCreateFogCompositeBindGroup,
} from "../../../Source/Renderer/WebGPU/WebGPUVolumetricFogRenderer.js";

function makeDevice() {
  let created = 0;
  return {
    get created() {
      return created;
    },
    createBindGroup(descriptor) {
      created++;
      return { descriptor, id: created };
    },
  };
}

describe("Renderer/WebGPU environmental-effects bind-group caches", function () {
  it("retains both volumetric-fog temporal source identities", function () {
    const device = makeDevice();
    const color = { label: "color" };
    const depth = { label: "depth" };
    const history0 = { label: "history 0" };
    const history1 = { label: "history 1" };
    const resources = {
      compositeBindGroupLayout: { label: "layout" },
      compositeUniformBuffer: { label: "uniforms" },
      compositeSampler: { label: "sampler" },
      compositeBindGroups: [null, null],
      compositeBindGroupNextSlot: 0,
    };

    const first = getOrCreateFogCompositeBindGroup(
      device,
      resources,
      color,
      depth,
      "bgra8unorm",
      history0,
    );
    const second = getOrCreateFogCompositeBindGroup(
      device,
      resources,
      color,
      depth,
      "bgra8unorm",
      history1,
    );
    const firstAgain = getOrCreateFogCompositeBindGroup(
      device,
      resources,
      color,
      depth,
      "bgra8unorm",
      history0,
    );

    expect(device.created).toBe(2);
    expect(firstAgain).toBe(first);
    expect(second).not.toBe(first);
  });

  it("invalidates fog entries on a real identity or format change", function () {
    const device = makeDevice();
    const resources = {
      compositeBindGroupLayout: {},
      compositeUniformBuffer: {},
      compositeSampler: {},
      compositeBindGroups: [null, null],
      compositeBindGroupNextSlot: 0,
    };
    const color = {};
    const depth = {};
    const fog = {};

    getOrCreateFogCompositeBindGroup(
      device,
      resources,
      color,
      depth,
      "bgra8unorm",
      fog,
    );
    getOrCreateFogCompositeBindGroup(
      device,
      resources,
      color,
      depth,
      "rgba16float",
      fog,
    );
    expect(device.created).toBe(2);

    clearFogCompositeBindGroupCache(resources);
    expect(resources.compositeBindGroups).toEqual([null, null]);
    expect(resources.compositeBindGroupNextSlot).toBe(0);
  });

  it("reuses the settled cloud main bind group and keys every sampled resource", function () {
    const device = makeDevice();
    const cache = {
      bindGroupLayout: {},
      uniformBuffer: {},
      sampler: { label: "main sampler" },
      weatherSampler: { label: "weather sampler" },
      lutSampler: { label: "lut sampler" },
      mainBindGroups: [null, null],
      mainBindGroupNextSlot: 0,
    };
    const color = {};
    const depth = {};
    const weather = {};
    const shape = {};
    const detail = {};
    const noiseSampler = {};
    const lut0 = {
      skyView: {},
      multipleScatter: {},
      transmittance: {},
    };

    const first = getOrCreateCloudMainBindGroup(
      device,
      cache,
      color,
      depth,
      weather,
      shape,
      detail,
      noiseSampler,
      lut0,
    );
    const firstAgain = getOrCreateCloudMainBindGroup(
      device,
      cache,
      color,
      depth,
      weather,
      shape,
      detail,
      noiseSampler,
      lut0,
    );
    const lut1 = { ...lut0, skyView: {} };
    getOrCreateCloudMainBindGroup(
      device,
      cache,
      color,
      depth,
      weather,
      shape,
      detail,
      noiseSampler,
      lut1,
    );

    expect(firstAgain).toBe(first);
    expect(device.created).toBe(2);
  });

  it("retains both cloud temporal-upscale source identities and clears both caches", function () {
    const device = makeDevice();
    const cache = {
      upscaleBindGroupLayout: {},
      upscaleUniformBuffer: {},
      upscaleSampler: {},
      upscaleBindGroups: [null, null],
      upscaleBindGroupNextSlot: 0,
      mainBindGroups: [{ bindGroup: {} }, { bindGroup: {} }],
      mainBindGroupNextSlot: 1,
    };
    const history0 = {};
    const history1 = {};
    const color = {};
    const depth = {};

    const first = getOrCreateCloudUpscaleBindGroup(
      device,
      cache,
      history0,
      color,
      depth,
    );
    getOrCreateCloudUpscaleBindGroup(device, cache, history1, color, depth);
    const firstAgain = getOrCreateCloudUpscaleBindGroup(
      device,
      cache,
      history0,
      color,
      depth,
    );

    expect(device.created).toBe(2);
    expect(firstAgain).toBe(first);

    clearCloudCompositeBindGroupCaches(cache);
    expect(cache.mainBindGroups).toEqual([null, null]);
    expect(cache.upscaleBindGroups).toEqual([null, null]);
    expect(cache.mainBindGroupNextSlot).toBe(0);
    expect(cache.upscaleBindGroupNextSlot).toBe(0);
  });
});
