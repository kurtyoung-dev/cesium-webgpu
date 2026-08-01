import { getAvailableFrameCommandEncoder } from "../../../Source/Renderer/WebGPU/WebGPUFrameCommandEncoder.js";

describe("Renderer/WebGPU/WebGPUFrameCommandEncoder", function () {
  it("returns the public frame encoder when no render pass is active", function () {
    const encoder = {};
    expect(
      getAvailableFrameCommandEncoder({
        currentCommandEncoder: encoder,
        hasActiveRenderPass: false,
      }),
    ).toBe(encoder);
  });

  it("supports the legacy underscore encoder surface", function () {
    const encoder = {};
    expect(
      getAvailableFrameCommandEncoder({
        _currentCommandEncoder: encoder,
        _currentRenderPassEncoder: null,
      }),
    ).toBe(encoder);
  });

  it("refuses a frame encoder while a render pass is active", function () {
    const encoder = {};
    expect(
      getAvailableFrameCommandEncoder({
        currentCommandEncoder: encoder,
        hasActiveRenderPass: true,
      }),
    ).toBeNull();
    expect(
      getAvailableFrameCommandEncoder({
        currentCommandEncoder: encoder,
        _currentRenderPassEncoder: {},
      }),
    ).toBeNull();
  });

  it("returns null outside a frame", function () {
    expect(getAvailableFrameCommandEncoder(undefined)).toBeNull();
    expect(
      getAvailableFrameCommandEncoder({ currentCommandEncoder: null }),
    ).toBeNull();
  });
});
