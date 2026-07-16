import {
  dispatchDepthResolve,
  getDepthResolvePipeline,
} from "../../../Source/Renderer/WebGPU/WebGPUDepthResolveMSAA.js";

if (typeof globalThis.GPUShaderStage === "undefined") {
  globalThis.GPUShaderStage = {
    VERTEX: 0x1,
    FRAGMENT: 0x2,
    COMPUTE: 0x4,
  };
}

function makeDevice() {
  const calls = {
    shaderModules: 0,
    bindGroupLayouts: 0,
    pipelineLayouts: 0,
    pipelines: 0,
    bindGroups: 0,
  };
  const device = {
    createShaderModule() {
      calls.shaderModules++;
      return {};
    },
    createBindGroupLayout() {
      calls.bindGroupLayouts++;
      return {};
    },
    createPipelineLayout() {
      calls.pipelineLayouts++;
      return {};
    },
    createRenderPipeline() {
      calls.pipelines++;
      return {};
    },
    createBindGroup(descriptor) {
      calls.bindGroups++;
      return { descriptor };
    },
  };
  return { device, calls };
}

function makeEncoder() {
  const passes = [];
  return {
    passes,
    beginRenderPass(descriptor) {
      const calls = [];
      const pass = {
        descriptor,
        calls,
        setPipeline(value) {
          calls.push(["pipeline", value]);
        },
        setBindGroup(index, value) {
          calls.push(["bindGroup", index, value]);
        },
        draw(count) {
          calls.push(["draw", count]);
        },
        end() {
          calls.push(["end"]);
        },
      };
      passes.push(pass);
      return pass;
    },
  };
}

describe("Renderer/WebGPU/WebGPUDepthResolveMSAA", function () {
  it("caches the pipeline per device", function () {
    const a = makeDevice();
    const b = makeDevice();

    expect(getDepthResolvePipeline(a.device)).toBe(
      getDepthResolvePipeline(a.device),
    );
    expect(a.calls.pipelines).toBe(1);

    expect(getDepthResolvePipeline(b.device)).not.toBe(
      getDepthResolvePipeline(a.device),
    );
    expect(b.calls.pipelines).toBe(1);
  });

  it("reuses a bind group for a stable MSAA depth view", function () {
    const { device, calls } = makeDevice();
    const encoder = makeEncoder();
    const inputView = {};
    const outputA = {};
    const outputB = {};

    dispatchDepthResolve(encoder, device, inputView, outputA);
    dispatchDepthResolve(encoder, device, inputView, outputB);

    expect(calls.bindGroups).toBe(1);
    expect(encoder.passes.length).toBe(2);
    expect(encoder.passes[0].descriptor.colorAttachments[0].view).toBe(outputA);
    expect(encoder.passes[1].descriptor.colorAttachments[0].view).toBe(outputB);
  });

  it("creates a new bind group when the MSAA depth view changes", function () {
    const { device, calls } = makeDevice();
    const encoder = makeEncoder();

    dispatchDepthResolve(encoder, device, {}, {});
    dispatchDepthResolve(encoder, device, {}, {});

    expect(calls.bindGroups).toBe(2);
  });
});
