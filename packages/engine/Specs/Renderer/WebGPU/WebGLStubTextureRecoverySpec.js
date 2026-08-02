import {
  createTextureStubs,
  getWebGPUTextureForDevice,
  WebGLStubTextureRegistry,
} from "../../../Source/Renderer/WebGPU/Stubs/WebGLStubTexture.js";

const TEXTURE_2D = 0x0de1;
const TEXTURE_CUBE_MAP = 0x8513;
const TEXTURE_CUBE_MAP_POSITIVE_X = 0x8515;
const RGBA = 0x1908;
const UNSIGNED_BYTE = 0x1401;
const TEXTURE_MIN_FILTER = 0x2801;
const LINEAR = 0x2601;
const LINEAR_MIPMAP_LINEAR = 0x2703;

function makeDevice(tag) {
  const textures = [];
  const writes = [];
  const mipJobs = [];
  return {
    tag,
    textures,
    writes,
    mipJobs,
    features: new Set([
      "texture-compression-bc",
      "texture-compression-astc",
      "texture-compression-etc2",
    ]),
    createTexture(descriptor) {
      const texture = {
        tag,
        descriptor,
        destroyed: false,
        createView(viewDescriptor) {
          return { texture, viewDescriptor };
        },
        destroy() {
          this.destroyed = true;
        },
      };
      textures.push(texture);
      return texture;
    },
    createSampler(descriptor) {
      return { tag, descriptor };
    },
    queue: {
      writeTexture(destination, data, layout, size) {
        writes.push({
          destination,
          data: Array.from(
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          ),
          layout,
          size,
        });
      },
      copyExternalImageToTexture() {
        throw new Error("external uploads are not used by this fake");
      },
      submit() {
        throw new Error("compatibility texture code must not submit");
      },
    },
  };
}

function makeHarness(device, resourceGeneration = 0) {
  const canceledMipTextures = [];
  const encoderEvents = [];
  const usage = [];
  const state = {
    device,
    resourceGeneration,
    context: null,
    currentCommandEncoder: null,
    currentRenderPassEncoder: null,
    activeTextureUnit: 0,
    textureBindings: new Map(),
    textureRegistry: new WebGLStubTextureRegistry(),
    boundFramebuffer: null,
    pixelStore: {
      unpackFlipY: false,
      unpackPremultiplyAlpha: false,
      unpackAlignment: 4,
    },
    mipmapGenerator: null,
    enqueueMipGeneration(texture, format, mipLevelCount, options) {
      device.mipJobs.push({ texture, format, mipLevelCount, options });
      return true;
    },
    encodeMipGenerationInCurrentEncoder(
      texture,
      format,
      mipLevelCount,
      options,
    ) {
      encoderEvents.push({
        kind: "mip",
        encoder: state.currentCommandEncoder,
        texture,
        format,
        mipLevelCount,
        options,
      });
      return true;
    },
    copyTextureRegion(source, destination) {
      encoderEvents.push({
        kind: "copy",
        encoder: state.currentCommandEncoder,
        source,
        texture: destination,
      });
      return true;
    },
    cancelMipGeneration(texture) {
      canceledMipTextures.push(texture);
    },
  };
  return {
    state,
    stubs: createTextureStubs(state, function (method, reason) {
      usage.push({ method, reason });
    }),
    canceledMipTextures,
    encoderEvents,
    usage,
  };
}

function uploadRgba(stubs, texture, bytes, width = 2, height = 2) {
  stubs.bindTexture(TEXTURE_2D, texture);
  stubs.texImage2D(
    TEXTURE_2D,
    0,
    RGBA,
    width,
    height,
    0,
    RGBA,
    UNSIGNED_BYTE,
    bytes,
  );
}

describe("Renderer/WebGPU/WebGLStubTexture generation safety", function () {
  it("rejects a replacement device until the owner explicitly re-uploads", function () {
    const deviceA = makeDevice("A");
    const deviceB = makeDevice("B");
    const { state, stubs } = makeHarness(deviceA, 7);
    const texture = stubs.createTexture();
    uploadRgba(stubs, texture, new Uint8Array(16).fill(23));
    const oldNative = texture._webgpuTexture.texture;
    const writesBeforeInvalidation = deviceA.writes.length;

    expect(getWebGPUTextureForDevice(texture, deviceB, 7)).toBeNull();
    expect(getWebGPUTextureForDevice(texture, deviceA, 8)).toBeNull();
    expect(
      getWebGPUTextureForDevice(
        { _isPlaceholder: true, _webgpuTexture: texture._webgpuTexture },
        deviceA,
        7,
      ),
    ).toBeNull();

    stubs.invalidateCompatibilityTextureHandles();
    expect(oldNative.destroyed).toBe(true);
    expect(deviceA.writes.length).toBe(writesBeforeInvalidation);

    state.device = deviceB;
    state.resourceGeneration = 8;
    expect(getWebGPUTextureForDevice(texture, deviceB, 8)).toBeNull();
    uploadRgba(stubs, texture, new Uint8Array(16).fill(91));
    const replacement = getWebGPUTextureForDevice(texture, deviceB, 8);
    expect(replacement.texture.tag).toBe("B");
    expect(replacement.texture).not.toBe(oldNative);
    expect(deviceB.writes.length).toBe(1);
  });

  it("partitions generations on the same GPUDevice", function () {
    const device = makeDevice("shared");
    const { state, stubs } = makeHarness(device, 2);
    const texture = stubs.createTexture();
    uploadRgba(stubs, texture, new Uint8Array(16).fill(5));
    const generation2 = texture._webgpuTexture.texture;

    stubs.invalidateCompatibilityTextureHandles();
    state.resourceGeneration = 3;
    expect(getWebGPUTextureForDevice(texture, device, 3)).toBeNull();
    uploadRgba(stubs, texture, new Uint8Array(16).fill(6));
    const generation3 = getWebGPUTextureForDevice(texture, device, 3).texture;

    expect(generation3).not.toBe(generation2);
    expect(generation2.destroyed).toBe(true);
    expect(getWebGPUTextureForDevice(texture, device, 2)).toBeNull();
  });

  it("invalidates without replaying uploads or mip work", function () {
    const device = makeDevice("A");
    const { stubs } = makeHarness(device);
    const texture = stubs.createTexture();
    uploadRgba(stubs, texture, new Uint8Array(16).fill(9));
    stubs.generateMipmap(TEXTURE_2D);
    const writes = device.writes.length;
    const mipJobs = device.mipJobs.length;

    expect(stubs.getCompatibilityTextureDiagnostics()).toEqual({
      registeredHandleCount: 1,
      liveTextureCount: 1,
    });
    stubs.invalidateCompatibilityTextureHandles();
    expect(device.writes.length).toBe(writes);
    expect(device.mipJobs.length).toBe(mipJobs);
    expect(stubs.getCompatibilityTextureDiagnostics()).toEqual({
      registeredHandleCount: 1,
      liveTextureCount: 0,
    });
  });

  it("cancels queued mip work before same-frame replacement and delete", function () {
    const device = makeDevice("A");
    const { stubs, canceledMipTextures } = makeHarness(device);
    const texture = stubs.createTexture();
    uploadRgba(stubs, texture, new Uint8Array(4 * 4 * 4).fill(9), 4, 4);
    const firstNative = texture._webgpuTexture.texture;
    stubs.generateMipmap(TEXTURE_2D);

    uploadRgba(stubs, texture, new Uint8Array(8 * 8 * 4).fill(7), 8, 8);
    const replacement = texture._webgpuTexture.texture;
    expect(replacement).not.toBe(firstNative);
    expect(canceledMipTextures).toEqual([firstNative]);
    expect(firstNative.destroyed).toBe(true);

    stubs.generateMipmap(TEXTURE_2D);
    stubs.deleteTexture(texture);
    expect(canceledMipTextures).toEqual([firstNative, replacement]);
    expect(replacement.destroyed).toBe(true);
  });

  it("reallocates when the same-size sampler transitions to a mip chain", function () {
    const device = makeDevice("A");
    const { stubs, canceledMipTextures } = makeHarness(device);
    const texture = stubs.createTexture();
    stubs.bindTexture(TEXTURE_2D, texture);
    stubs.texParameteri(TEXTURE_2D, TEXTURE_MIN_FILTER, LINEAR);
    uploadRgba(stubs, texture, new Uint8Array(4 * 4 * 4), 4, 4);
    const singleLevel = texture._webgpuTexture.texture;
    expect(texture._webgpuTexture.mipLevelCount).toBe(1);

    stubs.texParameteri(TEXTURE_2D, TEXTURE_MIN_FILTER, LINEAR_MIPMAP_LINEAR);
    uploadRgba(stubs, texture, new Uint8Array(4 * 4 * 4), 4, 4);

    expect(texture._webgpuTexture.mipLevelCount).toBe(3);
    expect(texture._webgpuTexture.texture).not.toBe(singleLevel);
    expect(canceledMipTextures).toEqual([singleLevel]);
    expect(singleLevel.destroyed).toBe(true);
  });

  it("still destroys a native when mip cancellation throws", function () {
    const device = makeDevice("A");
    const { state, stubs } = makeHarness(device);
    const texture = stubs.createTexture();
    uploadRgba(stubs, texture, new Uint8Array(16), 2, 2);
    const native = texture._webgpuTexture.texture;
    const cancellationError = new Error("synthetic cancellation failure");
    state.cancelMipGeneration = function () {
      throw cancellationError;
    };

    expect(function () {
      stubs.deleteTexture(texture);
    }).toThrow(cancellationError);
    expect(native.destroyed).toBe(true);
  });

  it("describes cube mip work as six independently renderable faces", function () {
    const device = makeDevice("A");
    const { stubs } = makeHarness(device);
    const texture = stubs.createTexture();
    stubs.bindTexture(TEXTURE_CUBE_MAP, texture);
    stubs.texImage2D(
      TEXTURE_CUBE_MAP_POSITIVE_X,
      0,
      RGBA,
      4,
      4,
      0,
      RGBA,
      UNSIGNED_BYTE,
      new Uint8Array(4 * 4 * 4),
    );

    stubs.generateMipmap(TEXTURE_CUBE_MAP);

    expect(device.textures[0].descriptor.textureBindingViewDimension).toBe(
      "cube",
    );
    expect(device.mipJobs.length).toBe(1);
    expect(device.mipJobs[0].options).toEqual({
      dimension: "cube",
      baseArrayLayer: 0,
      arrayLayerCount: 6,
    });
  });

  it("encodes framebuffer-copy mips after the copy in the same scene encoder", function () {
    const device = makeDevice("A");
    const { state, stubs, encoderEvents } = makeHarness(device);
    const texture = stubs.createTexture();
    uploadRgba(stubs, texture, new Uint8Array(4 * 4 * 4), 4, 4);
    const destination = texture._webgpuTexture.texture;
    const source = {};
    const encoder = {};
    state.currentCommandEncoder = encoder;
    state.boundFramebuffer = { colorAttachment: { _texture: source } };

    stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 4, 4);
    // Queue uploads always execute before the eventually submitted scene
    // encoder, even when the JS call occurs after recording the copy. The copy
    // dependency must therefore survive and keep mips after that copy.
    stubs.texSubImage2D(
      TEXTURE_2D,
      0,
      0,
      0,
      4,
      4,
      RGBA,
      UNSIGNED_BYTE,
      new Uint8Array(4 * 4 * 4).fill(31),
    );
    stubs.generateMipmap(TEXTURE_2D);

    expect(
      encoderEvents.map(function (event) {
        return event.kind;
      }),
    ).toEqual(["copy", "mip"]);
    expect(encoderEvents[0]).toEqual({
      kind: "copy",
      encoder,
      source,
      texture: destination,
    });
    expect(encoderEvents[1].encoder).toBe(encoder);
    expect(encoderEvents[1].texture).toBe(destination);
    expect(device.mipJobs.length).toBe(0);

    // The exact dependency is consumed. A later request without another
    // framebuffer copy returns to the canonical frame-preparation queue.
    state.currentCommandEncoder = {};
    stubs.generateMipmap(TEXTURE_2D);
    expect(device.mipJobs.length).toBe(1);
  });

  it("does not publish a same-encoder dependency when the copy is rejected", function () {
    const device = makeDevice("A");
    const { state, stubs, encoderEvents, usage } = makeHarness(device);
    const texture = stubs.createTexture();
    uploadRgba(stubs, texture, new Uint8Array(4 * 4 * 4), 4, 4);
    state.currentCommandEncoder = {};
    state.boundFramebuffer = { colorAttachment: { _texture: {} } };
    state.copyTextureRegion = function () {
      return false;
    };

    stubs.copyTexSubImage2D(TEXTURE_2D, 0, 0, 0, 0, 0, 4, 4);
    stubs.generateMipmap(TEXTURE_2D);

    expect(encoderEvents.length).toBe(0);
    expect(device.mipJobs.length).toBe(1);
    expect(usage).toContain(
      jasmine.objectContaining({
        method: "copyTexSubImage2D",
        reason: jasmine.stringMatching(/rejected/),
      }),
    );
  });

  it("preserves authored storage while surfacing automatic-generation rejection", function () {
    const device = makeDevice("A");
    const { state, stubs, usage } = makeHarness(device);
    const texture = stubs.createTexture();
    stubs.bindTexture(TEXTURE_2D, texture);
    stubs.texImage2D(
      TEXTURE_2D,
      0,
      0x822e, // R32F
      4,
      4,
      0,
      0x1903, // RED
      0x1406, // FLOAT
      new Float32Array(16),
    );

    expect(texture._webgpuTexture.format).toBe("r32float");
    expect(texture._webgpuTexture.mipLevelCount).toBe(3);
    state.enqueueMipGeneration = function () {
      return false;
    };
    stubs.generateMipmap(TEXTURE_2D);
    expect(device.mipJobs.length).toBe(0);
    expect(usage).toContain(
      jasmine.objectContaining({
        method: "generateMipmap",
        reason: jasmine.stringMatching(/rejected format r32float/),
      }),
    );
  });

  it("uploads supported block-compressed tail mips with physical block extents", function () {
    const device = makeDevice("A");
    const { stubs } = makeHarness(device);
    const texture = stubs.createTexture();
    stubs.bindTexture(TEXTURE_2D, texture);
    const block = new Uint8Array(8).fill(17);
    stubs.compressedTexImage2D(TEXTURE_2D, 0, 0x83f1, 4, 4, 0, block);
    stubs.compressedTexImage2D(TEXTURE_2D, 1, 0x83f1, 2, 2, 0, block);
    stubs.compressedTexSubImage2D(TEXTURE_2D, 2, 0, 0, 1, 1, 0x83f1, block);

    expect(texture._webgpuTexture.format).toBe("bc1-rgba-unorm");
    expect(device.writes.length).toBe(3);
    expect(
      device.writes.map(function (write) {
        return write.destination.mipLevel;
      }),
    ).toEqual([0, 1, 2]);
    for (const write of device.writes) {
      expect(write.layout.bytesPerRow).toBe(8);
      expect(write.layout.rowsPerImage).toBe(1);
      expect(write.size.width).toBe(4);
      expect(write.size.height).toBe(4);
    }
    stubs.generateMipmap(TEXTURE_2D);
    expect(device.mipJobs.length).toBe(0);
    const writesBeforeInvalidCalls = device.writes.length;
    stubs.compressedTexImage2D(TEXTURE_2D, 3, 0x83f1, 1, 1, 0, block);
    stubs.compressedTexSubImage2D(TEXTURE_2D, 0, 2, 0, 2, 4, 0x83f1, block);
    stubs.compressedTexSubImage2D(
      TEXTURE_2D,
      1,
      0,
      0,
      2,
      2,
      0x93b0,
      new Uint8Array(16),
    );
    stubs.compressedTexSubImage2D(TEXTURE_2D, 0, -4, 0, 4, 4, 0x83f1, block);
    expect(device.writes.length).toBe(writesBeforeInvalidCalls);
    const writes = device.writes.length;
    stubs.invalidateCompatibilityTextureHandles();
    expect(device.writes.length).toBe(writes);
  });

  it("rejects unavailable compressed features and misaligned base descriptors", function () {
    const device = makeDevice("A");
    device.features.delete("texture-compression-bc");
    const { stubs } = makeHarness(device);
    const unsupported = stubs.createTexture();
    stubs.bindTexture(TEXTURE_2D, unsupported);
    stubs.compressedTexImage2D(
      TEXTURE_2D,
      0,
      0x83f1,
      4,
      4,
      0,
      new Uint8Array(8),
    );
    expect(device.textures.length).toBe(0);
    expect(unsupported._webgpuTexture).toBeNull();

    device.features.add("texture-compression-bc");
    const misaligned = stubs.createTexture();
    stubs.bindTexture(TEXTURE_2D, misaligned);
    stubs.compressedTexImage2D(
      TEXTURE_2D,
      0,
      0x83f1,
      6,
      4,
      0,
      new Uint8Array(16),
    );
    expect(device.textures.length).toBe(0);
    expect(misaligned._webgpuTexture).toBeNull();
    expect(device.writes.length).toBe(0);
  });

  it("drains all native textures and the mip owner when one destroy throws", function () {
    const device = makeDevice("A");
    const { state, stubs } = makeHarness(device);
    const first = stubs.createTexture();
    const second = stubs.createTexture();
    uploadRgba(stubs, first, new Uint8Array(16).fill(1));
    uploadRgba(stubs, second, new Uint8Array(16).fill(2));
    const firstNative = first._webgpuTexture.texture;
    const secondNative = second._webgpuTexture.texture;
    const destroyFirst = firstNative.destroy;
    const firstError = new Error("first texture destroy failed");
    firstNative.destroy = function () {
      destroyFirst.call(firstNative);
      throw firstError;
    };
    let mipOwnerDestroyed = false;
    state.mipmapGenerator = {
      destroy() {
        mipOwnerDestroyed = true;
      },
    };

    expect(function () {
      stubs.invalidateCompatibilityTextureHandles();
    }).toThrow(firstError);

    expect(firstNative.destroyed).toBe(true);
    expect(secondNative.destroyed).toBe(true);
    expect(first._webgpuTexture).toBeNull();
    expect(second._webgpuTexture).toBeNull();
    expect(mipOwnerDestroyed).toBe(true);
    expect(state.mipmapGenerator).toBeNull();
    expect(stubs.getCompatibilityTextureDiagnostics()).toEqual({
      registeredHandleCount: 2,
      liveTextureCount: 0,
    });
  });

  it("final teardown detaches every logical texture when one destroy throws", function () {
    const device = makeDevice("A");
    const { stubs } = makeHarness(device);
    const first = stubs.createTexture();
    const second = stubs.createTexture();
    uploadRgba(stubs, first, new Uint8Array(16).fill(1));
    uploadRgba(stubs, second, new Uint8Array(16).fill(2));
    const firstNative = first._webgpuTexture.texture;
    const secondNative = second._webgpuTexture.texture;
    const destroyFirst = firstNative.destroy;
    const firstError = new Error("first final texture destroy failed");
    firstNative.destroy = function () {
      destroyFirst.call(firstNative);
      throw firstError;
    };

    expect(function () {
      stubs.destroyCompatibilityTextureHandles();
    }).toThrow(firstError);

    expect(firstNative.destroyed).toBe(true);
    expect(secondNative.destroyed).toBe(true);
    expect(first._webgpuTexture).toBeNull();
    expect(second._webgpuTexture).toBeNull();
    expect(first._getAllocation()).toBeNull();
    expect(second._getAllocation()).toBeNull();
    expect(first._destroyed).toBe(true);
    expect(second._destroyed).toBe(true);
    expect(stubs.getCompatibilityTextureDiagnostics()).toEqual({
      registeredHandleCount: 0,
      liveTextureCount: 0,
    });
  });

  it("logical delete and final destroy release registry ownership", function () {
    const device = makeDevice("A");
    const { stubs } = makeHarness(device);
    const texture = stubs.createTexture();
    uploadRgba(stubs, texture, new Uint8Array(16).fill(3));
    const native = texture._webgpuTexture.texture;

    stubs.deleteTexture(texture);
    expect(native.destroyed).toBe(true);
    expect(stubs.getCompatibilityTextureDiagnostics()).toEqual({
      registeredHandleCount: 0,
      liveTextureCount: 0,
    });
    expect(getWebGPUTextureForDevice(texture, device, 0)).toBeNull();

    const second = stubs.createTexture();
    uploadRgba(stubs, second, new Uint8Array(16).fill(4));
    stubs.destroyCompatibilityTextureHandles();
    expect(stubs.getCompatibilityTextureDiagnostics()).toEqual({
      registeredHandleCount: 0,
      liveTextureCount: 0,
    });
  });
});
