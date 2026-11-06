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
    const makeCache = () => ({
      bindGroupLayout: {},
      uniformBuffer: {},
      sampler: { label: "main sampler" },
      weatherSampler: { label: "weather sampler" },
      lutSampler: { label: "lut sampler" },
      materialFlow: { buffer: { label: "material flow" } },
      mainBindGroups: [null, null],
      mainBindGroupNextSlot: 0,
    });
    const makeInputs = () => ({
      color: { label: "color" },
      depth: { label: "depth" },
      weather: { label: "weather" },
      shape: { label: "shape" },
      detail: { label: "detail" },
      noiseSampler: { label: "noise sampler" },
      lut: {
        skyView: { label: "sky view" },
        multipleScatter: { label: "multiple scatter" },
        transmittance: { label: "transmittance" },
      },
    });
    const resolve = (device, cache, i) =>
      getOrCreateCloudMainBindGroup(
        device,
        cache,
        i.color,
        i.depth,
        i.weather,
        i.shape,
        i.detail,
        i.noiseSampler,
        i.lut,
      );
    const resourceAt = (bindGroup, binding) =>
      bindGroup.descriptor.entries.find((e) => e.binding === binding).resource;

    // Reuse: identical inputs resolve to the identical bind group.
    const reuseDevice = makeDevice();
    const reuseCache = makeCache();
    const reuseInputs = makeInputs();
    const first = resolve(reuseDevice, reuseCache, reuseInputs);
    const firstAgain = resolve(reuseDevice, reuseCache, reuseInputs);
    expect(firstAgain).toBe(first);
    expect(reuseDevice.created).toBe(1);

    // Every sampled resource is part of the key and lands at its binding.
    const cases = [
      ["colorView", 0, false, (c, i, r) => (i.color = r)],
      ["depthView", 1, false, (c, i, r) => (i.depth = r)],
      ["cache.sampler", 2, false, (c, i, r) => (c.sampler = r)],
      ["weatherView", 4, false, (c, i, r) => (i.weather = r)],
      ["cache.weatherSampler", 5, false, (c, i, r) => (c.weatherSampler = r)],
      ["shapeView", 6, false, (c, i, r) => (i.shape = r)],
      ["detailView", 7, false, (c, i, r) => (i.detail = r)],
      ["noiseSampler", 8, false, (c, i, r) => (i.noiseSampler = r)],
      ["lutViews.skyView", 9, false, (c, i, r) => (i.lut.skyView = r)],
      [
        "lutViews.multipleScatter",
        10,
        false,
        (c, i, r) => (i.lut.multipleScatter = r),
      ],
      [
        "lutViews.transmittance",
        11,
        false,
        (c, i, r) => (i.lut.transmittance = r),
      ],
      ["cache.lutSampler", 12, false, (c, i, r) => (c.lutSampler = r)],
      [
        "cache.materialFlow.buffer",
        15,
        true,
        (c, i, r) => (c.materialFlow.buffer = r),
      ],
    ];
    for (const [name, binding, isBuffer, replace] of cases) {
      const device = makeDevice();
      const cache = makeCache();
      const inputs = makeInputs();
      const before = resolve(device, cache, inputs);
      expect(device.created).withContext(name).toBe(1);

      const replacement = { label: `replacement ${name}` };
      replace(cache, inputs, replacement);
      const after = resolve(device, cache, inputs);

      expect(after).withContext(name).not.toBe(before);
      expect(device.created).withContext(name).toBe(2);
      const bound = resourceAt(after, binding);
      if (isBuffer) {
        expect(bound.buffer).withContext(name).toBe(replacement);
      } else {
        expect(bound).withContext(name).toBe(replacement);
      }
    }
  });

  it("keys every resource the exact non-colour bindings carry", function () {
    const view = (label) => ({ label });
    const makeCache = () => ({
      bindGroupLayout: {},
      uniformBuffer: {},
      sampler: {},
      weatherSampler: {},
      lutSampler: {},
      materialFlow: { buffer: {} },
      mainBindGroups: [null, null],
      mainBindGroupNextSlot: 0,
    });
    const makeExact = () => ({
      depth: view("depth"),
      mainSampler: view("main sampler"),
      uniform: { buffer: view("uniform") },
      weatherView: view("weather"),
      weatherSampler: view("weather sampler"),
      shapeView: view("shape"),
      detailView: view("detail"),
      noiseSampler: view("noise sampler"),
      skyView: view("sky view"),
      multipleScatter: view("multiple scatter"),
      transmittance: view("transmittance"),
      lutSampler: view("lut sampler"),
      densityMomentsView: view("density moments"),
      materialFlowBuffer: view("material flow"),
      occupancyView: view("occupancy"),
      occupancyUniformBuffer: view("occupancy uniform"),
      weatherBoundsBuffer: view("weather bounds"),
      densityCacheView: view("density cache"),
      densityCacheUniform: view("density cache uniform"),
      deepShadowView: view("deep shadow"),
      deepShadowUniform: view("deep shadow uniform"),
      lightingBudgetUniform: view("lighting budget"),
    });
    const color = view("color");
    const resolve = (device, cache, exact) =>
      getOrCreateCloudMainBindGroup(
        device,
        cache,
        color,
        view("depth argument"),
        view("weather argument"),
        view("shape argument"),
        view("detail argument"),
        view("noise sampler argument"),
        {
          skyView: view("sky argument"),
          multipleScatter: view("scatter argument"),
          transmittance: view("transmittance argument"),
        },
        undefined,
        exact,
      );
    const resourceAt = (bindGroup, binding) =>
      bindGroup.descriptor.entries.find((e) => e.binding === binding).resource;

    // Reuse: the same exact bindings resolve to the same bind group, whatever
    // the positional arguments the exact set overrides.
    const reuseDevice = makeDevice();
    const reuseCache = makeCache();
    const reuseExact = makeExact();
    const first = resolve(reuseDevice, reuseCache, reuseExact);
    expect(resolve(reuseDevice, reuseCache, reuseExact)).toBe(first);
    expect(reuseDevice.created).toBe(1);

    // [field, binding, bound as a buffer]
    const cases = [
      ["depth", 1, false],
      ["mainSampler", 2, false],
      ["weatherView", 4, false],
      ["weatherSampler", 5, false],
      ["shapeView", 6, false],
      ["detailView", 7, false],
      ["noiseSampler", 8, false],
      ["skyView", 9, false],
      ["multipleScatter", 10, false],
      ["transmittance", 11, false],
      ["lutSampler", 12, false],
      ["densityMomentsView", 14, false],
      ["materialFlowBuffer", 15, true],
      ["occupancyView", 17, false],
      ["occupancyUniformBuffer", 18, true],
      ["weatherBoundsBuffer", 19, true],
      ["densityCacheView", 20, false],
      ["densityCacheUniform", 21, true],
      ["deepShadowView", 22, false],
      ["deepShadowUniform", 23, true],
      ["lightingBudgetUniform", 26, true],
    ];
    for (const [field, binding, isBuffer] of cases) {
      const device = makeDevice();
      const cache = makeCache();
      const exact = makeExact();
      const before = resolve(device, cache, exact);
      const replacement = view(`replacement ${field}`);
      const after = resolve(device, cache, { ...exact, [field]: replacement });

      expect(after).withContext(field).not.toBe(before);
      expect(device.created).withContext(field).toBe(2);
      const bound = resourceAt(after, binding);
      expect(isBuffer ? bound.buffer : bound)
        .withContext(field)
        .toBe(replacement);
    }

    // The uniform epoch's buffer is keyed too.
    const device = makeDevice();
    const cache = makeCache();
    const exact = makeExact();
    const before = resolve(device, cache, exact);
    const uniform = { buffer: view("replacement uniform") };
    const after = resolve(device, cache, { ...exact, uniform });
    expect(after).not.toBe(before);
    expect(resourceAt(after, 3).buffer).toBe(uniform.buffer);
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
