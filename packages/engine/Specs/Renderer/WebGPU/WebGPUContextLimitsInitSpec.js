import { initializeContextLimitsFromDevice } from "../../../Source/Renderer/WebGPU/WebGPUContextLimitsInit.js";
import ContextLimits from "../../../Source/Renderer/ContextLimits.js";
import GraphicsCapabilities from "../../../Source/Renderer/GraphicsCapabilities.js";

describe("Renderer/WebGPU/WebGPUContextLimitsInit", function () {
  function makeDevice(options = {}) {
    return {
      limits: {
        maxTextureDimension2D: options.maxTextureDimension2D ?? 8192,
        maxSampledTexturesPerShaderStage:
          options.maxSampledTexturesPerShaderStage ?? 16,
        maxVertexAttributes: options.maxVertexAttributes ?? 30,
        maxColorAttachments: options.maxColorAttachments ?? 8,
        maxTextureDimension3D: options.maxTextureDimension3D ?? 2048,
        maxTextureArrayLayers: options.maxTextureArrayLayers ?? 256,
      },
      features: new Set(options.features ?? []),
    };
  }

  it("returns the shared immutable empty snapshot without a device", function () {
    expect(initializeContextLimitsFromDevice(undefined)).toBe(
      GraphicsCapabilities.EMPTY,
    );
    expect(initializeContextLimitsFromDevice(null)).toBe(
      GraphicsCapabilities.EMPTY,
    );
  });

  it("maps device limits into a frozen context-owned snapshot", function () {
    const capabilities = initializeContextLimitsFromDevice(makeDevice());

    expect(capabilities.maximumTextureSize).toBe(8192);
    expect(capabilities.maximumCubeMapSize).toBe(8192);
    expect(capabilities.maximumRenderbufferSize).toBe(8192);
    expect(capabilities.maximumViewportWidth).toBe(8192);
    expect(capabilities.maximumViewportHeight).toBe(8192);
    expect(capabilities.maximumTextureImageUnits).toBe(16);
    expect(capabilities.maximumVertexTextureImageUnits).toBe(16);
    expect(capabilities.maximumCombinedTextureImageUnits).toBe(32);
    expect(capabilities.maximumVertexAttributes).toBe(30);
    expect(capabilities.maximumDrawBuffers).toBe(8);
    expect(capabilities.maximumColorAttachments).toBe(8);
    expect(capabilities.maximum3DTextureSize).toBe(2048);
    expect(capabilities.maximumArrayTextureLayers).toBe(256);
    expect(capabilities.maximumSamples).toBe(4);
    expect(capabilities.highpFloatSupported).toBe(true);
    expect(capabilities.highpIntSupported).toBe(true);
    expect(Object.isFrozen(capabilities)).toBeTrue();
    expect(Object.isFrozen(capabilities.ktx2TranscodeTargets)).toBeTrue();
  });

  it("derives stable KTX2 targets from enabled WebGPU features", function () {
    const capabilities = initializeContextLimitsFromDevice(
      makeDevice({
        features: [
          "texture-compression-bc",
          "texture-compression-astc",
          "texture-compression-etc2",
        ],
      }),
    );

    expect(capabilities.ktx2TranscodeTargets.s3tc).toBeTrue();
    expect(capabilities.ktx2TranscodeTargets.bc7).toBeTrue();
    expect(capabilities.ktx2TranscodeTargets.astc).toBeTrue();
    expect(capabilities.ktx2TranscodeTargets.etc).toBeTrue();
    expect(capabilities.ktx2TranscodeTargets.pvrtc).toBeFalse();
    expect(capabilities.ktx2TranscodeTargetKey).toBe("ktx2-2d");
  });

  it("does not mutate the deprecated process-global ContextLimits module", function () {
    const before = ContextLimits._maximumTextureSize;
    initializeContextLimitsFromDevice(makeDevice());
    expect(ContextLimits._maximumTextureSize).toBe(before);
  });

  it("keeps two device snapshots independent in alternating order", function () {
    const small = initializeContextLimitsFromDevice(
      makeDevice({
        maxTextureDimension2D: 2048,
        maxSampledTexturesPerShaderStage: 8,
        maxVertexAttributes: 16,
        maxColorAttachments: 4,
        maxTextureDimension3D: 512,
        maxTextureArrayLayers: 64,
        features: ["texture-compression-etc2"],
      }),
    );
    const large = initializeContextLimitsFromDevice(
      makeDevice({
        maxTextureDimension2D: 16384,
        maxSampledTexturesPerShaderStage: 32,
        maxVertexAttributes: 32,
        maxColorAttachments: 8,
        maxTextureDimension3D: 4096,
        maxTextureArrayLayers: 512,
        features: ["texture-compression-bc"],
      }),
    );

    for (let i = 0; i < 32; i++) {
      const first = i % 2 === 0 ? small : large;
      const second = i % 2 === 0 ? large : small;
      expect(first.maximumTextureSize).toBe(i % 2 === 0 ? 2048 : 16384);
      expect(second.maximumTextureSize).toBe(i % 2 === 0 ? 16384 : 2048);
      expect(small.ktx2TranscodeTargets.etc).toBeTrue();
      expect(small.ktx2TranscodeTargets.s3tc).toBeFalse();
      expect(large.ktx2TranscodeTargets.s3tc).toBeTrue();
      expect(large.ktx2TranscodeTargets.etc).toBeFalse();
    }
  });

  it("preserves explicit zero optional limits", function () {
    const device = makeDevice();
    device.limits.maxColorAttachments = 0;
    device.limits.maxTextureDimension3D = 0;
    device.limits.maxTextureArrayLayers = 0;
    const capabilities = initializeContextLimitsFromDevice(device);
    expect(capabilities.maximumDrawBuffers).toBe(0);
    expect(capabilities.maximumColorAttachments).toBe(0);
    expect(capabilities.maximum3DTextureSize).toBe(0);
    expect(capabilities.maximumArrayTextureLayers).toBe(0);
  });
});
