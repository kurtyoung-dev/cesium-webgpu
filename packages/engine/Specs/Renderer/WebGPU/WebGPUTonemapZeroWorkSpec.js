import {
  TonemapMode,
  WebGPUPostProcessPipeline,
} from "../../../Source/Renderer/WebGPU/WebGPUPostProcessPipeline.js";
import TonemappingWGSL from "../../../Source/Shaders/WebGPU/PostProcess/Tonemapping.js";
import TonemappingF16WGSL from "../../../Source/Shaders/WebGPU/PostProcess/Tonemapping_f16.js";

describe("Renderer/WebGPU/WebGPUTonemapZeroWork", function () {
  function createPipelineHarness() {
    const writes = [];
    const pipeline = new WebGPUPostProcessPipeline();
    const uniformBuffer = {};
    pipeline._device = {
      queue: {
        writeBuffer(buffer, offset, data) {
          writes.push({ buffer, offset, value: data[0] });
        },
      },
    };
    pipeline._tonemapStage = { uniformBuffer };
    return { pipeline, uniformBuffer, writes };
  }

  it("does no queue write for unchanged mode and zero dither", function () {
    const { pipeline, writes } = createPipelineHarness();

    pipeline.setTonemappingMode(TonemapMode.REINHARD);
    pipeline.setTonemapDither(0.0);

    expect(writes.length).toBe(0);
  });

  it("writes mode only when the value changes", function () {
    const { pipeline, uniformBuffer, writes } = createPipelineHarness();

    pipeline.setTonemappingMode(TonemapMode.ACES);
    pipeline.setTonemappingMode(TonemapMode.ACES);
    pipeline.setTonemappingMode(TonemapMode.REINHARD);

    expect(writes).toEqual([
      { buffer: uniformBuffer, offset: 8, value: TonemapMode.ACES },
      { buffer: uniformBuffer, offset: 8, value: TonemapMode.REINHARD },
    ]);
  });

  it("preserves enabled dither mutation, disable, and stable-off behavior", function () {
    const { pipeline, uniformBuffer, writes } = createPipelineHarness();

    pipeline.setTonemapDither(1.0);
    pipeline.setTonemapDither(1.0);
    pipeline.setTonemapDither(2.0);
    pipeline.setTonemapDither(0.0);
    pipeline.setTonemapDither(0.0);

    expect(writes).toEqual([
      { buffer: uniformBuffer, offset: 16, value: 1.0 },
      { buffer: uniformBuffer, offset: 16, value: 2.0 },
      { buffer: uniformBuffer, offset: 16, value: 0.0 },
    ]);
  });

  it("normalizes invalid and sub-f32 inputs before comparing cached values", function () {
    const { pipeline, uniformBuffer, writes } = createPipelineHarness();
    const first = 1.00000001;
    const sameF32 = 1.00000002;

    pipeline.setTonemapDither(Number.NaN);
    pipeline.setTonemapDither(first);
    pipeline.setTonemapDither(sameF32);
    pipeline.setTonemapDither(Number.POSITIVE_INFINITY);
    pipeline.setTonemapDither(Number.NaN);
    pipeline.setTonemappingMode(Number.NaN);
    pipeline.setTonemappingMode(999);

    expect(writes).toEqual([
      { buffer: uniformBuffer, offset: 16, value: Math.fround(first) },
      { buffer: uniformBuffer, offset: 16, value: 0.0 },
    ]);
  });

  it("branches around both TPDF hashes in the f32 and f16 shaders", function () {
    for (const source of [TonemappingWGSL, TonemappingF16WGSL]) {
      const branchIndex = source.indexOf("if (params.ditherStrength != 0.0)");
      const callIndex = source.indexOf(
        "tpdfDither(input.position.xy, params.ditherStrength)",
      );
      expect(branchIndex).toBeGreaterThan(-1);
      expect(callIndex).toBeGreaterThan(branchIndex);
    }
  });
});
