import { WebGPUUserPostProcessStage } from "../../../Source/Renderer/WebGPU/WebGPUUserPostProcessStage.js";

describe("Renderer/WebGPU/WebGPUUserPostProcessStage", function () {
  it("keeps multi-pass uniform bindings isolated and skips settled uploads", function () {
    const buffers = [];
    const writes = [];
    const bindGroups = [];
    const device = {
      queue: {
        writeBuffer: function (buffer, offset, data) {
          writes.push({ buffer, offset, data: new Float32Array(data).slice() });
        },
      },
      createShaderModule: function () {
        return {};
      },
      createBindGroupLayout: function () {
        return {};
      },
      createPipelineLayout: function () {
        return {};
      },
      createRenderPipeline: function () {
        return {};
      },
      createBuffer: function (descriptor) {
        const buffer = { descriptor, destroy: function () {} };
        buffers.push(buffer);
        return buffer;
      },
      createTexture: function () {
        const view = {};
        return {
          createView: function () {
            return view;
          },
          destroy: function () {},
        };
      },
      createBindGroup: function (descriptor) {
        const bindGroup = { descriptor };
        bindGroups.push(bindGroup);
        return bindGroup;
      },
    };
    const encoder = {
      beginRenderPass: function () {
        return {
          setPipeline: function () {},
          setBindGroup: function () {},
          draw: function () {},
          end: function () {},
        };
      },
    };
    const stage = new WebGPUUserPostProcessStage(
      "two-pass",
      "@fragment fn fragmentMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }",
      { strength: 1.0 },
      undefined,
      2,
    );

    stage.initialize(device, 16, 16, "rgba8unorm");
    stage.execute(encoder, {}, null, {});

    expect(buffers.length).toBe(2);
    expect(writes.length).toBe(2);
    expect(writes[0].buffer).not.toBe(writes[1].buffer);
    expect(writes[0].data[15]).toBe(0);
    expect(writes[1].data[15]).toBe(1);
    expect(bindGroups[0].descriptor.entries[2].resource.buffer).toBe(
      writes[0].buffer,
    );
    expect(bindGroups[1].descriptor.entries[2].resource.buffer).toBe(
      writes[1].buffer,
    );

    stage.execute(encoder, {}, null, {});
    expect(writes.length).toBe(2);
    stage.destroy();
  });
});
