import {
  WebGPUMipmapGenerator,
  supportsWebGPUMipmapGeneration,
  supportsWebGPULayeredMipmapGeneration,
  supportsWebGPURenderAttachment,
} from "../../../Source/Renderer/WebGPU/WebGPUMipmapGenerator.js";

function makeHarness() {
  const views = [];
  const bindGroups = [];
  const passes = [];
  const encoder = {
    beginRenderPass: function (descriptor) {
      const calls = [];
      const pass = {
        descriptor: descriptor,
        calls: calls,
        setPipeline: function (value) {
          calls.push(["pipeline", value]);
        },
        setBindGroup: function (index, value) {
          calls.push(["bindGroup", index, value]);
        },
        draw: function (count) {
          calls.push(["draw", count]);
        },
        end: function () {
          calls.push(["end"]);
        },
      };
      passes.push(pass);
      return pass;
    },
  };
  const device = {
    features: new Set(),
    createShaderModule: function (descriptor) {
      return { descriptor: descriptor };
    },
    createSampler: function (descriptor) {
      return { descriptor: descriptor };
    },
    createBindGroupLayout: function (descriptor) {
      return { descriptor: descriptor };
    },
    createPipelineLayout: function (descriptor) {
      return { descriptor: descriptor };
    },
    createRenderPipeline: function (descriptor) {
      return { descriptor: descriptor };
    },
    createBindGroup: function (descriptor) {
      const bindGroup = { descriptor: descriptor };
      bindGroups.push(bindGroup);
      return bindGroup;
    },
  };
  const texture = {
    createView: function (descriptor) {
      const view = { descriptor: descriptor };
      views.push(view);
      return view;
    },
  };
  return { device, texture, encoder, views, bindGroups, passes };
}

describe("Renderer/WebGPU/WebGPUMipmapGenerator", function () {
  it("gates the blit path to filterable color-renderable formats and features", function () {
    const device = { features: new Set() };
    expect(supportsWebGPUMipmapGeneration(device, "rgba8unorm")).toBe(true);
    expect(supportsWebGPUMipmapGeneration(device, "rgba8snorm")).toBe(false);
    expect(supportsWebGPUMipmapGeneration(device, "rgba16unorm")).toBe(false);
    expect(supportsWebGPUMipmapGeneration(device, "rgba8uint")).toBe(false);
    expect(supportsWebGPUMipmapGeneration(device, "depth32float")).toBe(false);
    expect(supportsWebGPUMipmapGeneration(device, "bc1-rgba-unorm")).toBe(
      false,
    );
    expect(supportsWebGPUMipmapGeneration(device, "rgba32float")).toBe(false);
    expect(supportsWebGPUMipmapGeneration(device, "rg11b10ufloat")).toBe(false);

    device.features.add("float32-filterable");
    device.features.add("rg11b10ufloat-renderable");
    device.features.add("texture-formats-tier1");
    expect(supportsWebGPUMipmapGeneration(device, "r32float")).toBe(true);
    expect(supportsWebGPUMipmapGeneration(device, "rg32float")).toBe(true);
    expect(supportsWebGPUMipmapGeneration(device, "rgba32float")).toBe(true);
    expect(supportsWebGPUMipmapGeneration(device, "rg11b10ufloat")).toBe(true);
    expect(supportsWebGPUMipmapGeneration(device, "r8snorm")).toBe(true);
    expect(supportsWebGPUMipmapGeneration(device, "rg16snorm")).toBe(true);
    expect(supportsWebGPUMipmapGeneration(device, "rgba16unorm")).toBe(true);

    expect(supportsWebGPULayeredMipmapGeneration(device)).toBe(false);
    device.features.add("core-features-and-limits");
    expect(supportsWebGPULayeredMipmapGeneration(device)).toBe(true);
  });

  it("keeps general render attachments distinct from color-blit eligibility", function () {
    const device = { features: new Set() };
    for (const format of [
      "depth16unorm",
      "depth24plus",
      "depth24plus-stencil8",
      "depth32float",
    ]) {
      expect(supportsWebGPURenderAttachment(device, format)).toBe(true);
      expect(supportsWebGPUMipmapGeneration(device, format)).toBe(false);
    }
    expect(
      supportsWebGPURenderAttachment(device, "depth32float-stencil8"),
    ).toBe(false);
    device.features.add("depth32float-stencil8");
    expect(
      supportsWebGPURenderAttachment(device, "depth32float-stencil8"),
    ).toBe(true);
  });

  it("rejects unsupported formats before creating generator resources", function () {
    const h = makeHarness();
    const generator = new WebGPUMipmapGenerator(h.device);

    expect(function () {
      generator.generateMipmaps(h.texture, "rgba8uint", 3, h.encoder);
    }).toThrowError(/filterable color-renderable format/);
    expect(h.passes.length).toBe(0);
    expect(h.bindGroups.length).toBe(0);
  });

  it("rejects use after destroy without retaining per-texture chains", function () {
    const h = makeHarness();
    const generator = new WebGPUMipmapGenerator(h.device);
    generator.generateMipmaps(h.texture, "rgba8unorm", 2, h.encoder);

    generator.destroy();

    expect(generator.isDestroyed).toBe(true);
    expect(generator._bindGroupCache).toBeUndefined();
    expect(function () {
      generator.generateMipmaps(h.texture, "rgba8unorm", 1, h.encoder);
    }).toThrowError(/destroyed/);
  });

  it("encodes every cube face through exact single-layer 2D views", function () {
    const h = makeHarness();
    const generator = new WebGPUMipmapGenerator(h.device);

    expect(
      generator.generateMipmaps(h.texture, "rgba8unorm", 3, h.encoder, {
        dimension: "cube",
        baseArrayLayer: 0,
        arrayLayerCount: 6,
      }),
    ).toBe(h.encoder);

    // Six faces, each with destination levels 1 and 2.
    expect(h.passes.length).toBe(12);
    expect(h.bindGroups.length).toBe(12);
    expect(h.views.length).toBe(24);

    const sourceDescriptors = h.bindGroups.map(function (bindGroup) {
      return bindGroup.descriptor.entries[1].resource.descriptor;
    });
    const destinationDescriptors = h.passes.map(function (pass) {
      return pass.descriptor.colorAttachments[0].view.descriptor;
    });
    for (const descriptor of [
      ...sourceDescriptors,
      ...destinationDescriptors,
    ]) {
      expect(descriptor.dimension).toBe("2d");
      expect(descriptor.arrayLayerCount).toBe(1);
    }
    expect(
      sourceDescriptors.map(function (descriptor) {
        return [descriptor.baseArrayLayer, descriptor.baseMipLevel];
      }),
    ).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
      [3, 0],
      [3, 1],
      [4, 0],
      [4, 1],
      [5, 0],
      [5, 1],
    ]);
    expect(
      destinationDescriptors.map(function (descriptor) {
        return [descriptor.baseArrayLayer, descriptor.baseMipLevel];
      }),
    ).toEqual([
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
      [3, 1],
      [3, 2],
      [4, 1],
      [4, 2],
      [5, 1],
      [5, 2],
    ]);
    for (const pass of h.passes) {
      expect(pass.calls[2]).toEqual(["draw", 3]);
      expect(pass.calls[3]).toEqual(["end"]);
    }
  });
});
