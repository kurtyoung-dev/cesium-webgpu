import WebGPUTextureUtilities, {
  copyTexture,
  copyTextureRegion,
  createPixelReadbackPBO,
  createDefaultTextures,
  createTextureFromImage,
} from "../../../Source/Renderer/WebGPU/WebGPUTextureUtilities.js";

// These specs are pure-logic tests — no real GPU device is created. The
// default-origin / default-size computation in `copyTexture`, the origin
// and extent packing in `copyTextureRegion`, and the 256-byte-row-align
// math in `createPixelReadbackPBO` are all deterministic given a fake
// encoder/device that simply records the arguments forwarded to it. The
// two functions that genuinely need a live device + queue
// (`createDefaultTextures`, `createTextureFromImage`) are only asserted to
// exist — their bodies are exercised by the integration-level WebGPU
// suites that spin up an adapter.

// `GPUBufferUsage` / `GPUMapMode` globals aren't declared in every Karma
// runner. Provide constants that match the WebGPU spec values so the
// buffer-usage flags inside `createPixelReadbackPBO` resolve to the same
// bitmask we assert against below. (Mirrors the GPUShaderStage shim in
// WebGPUBindGroupReflectionSpec.)
if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
}
if (typeof globalThis.GPUMapMode === "undefined") {
  globalThis.GPUMapMode = {
    READ: 0x0001,
    WRITE: 0x0002,
  };
}

describe("Renderer/WebGPU/WebGPUTextureUtilities", function () {
  // A fake GPUCommandEncoder that records the arguments of the copy calls
  // the utilities forward to it, so we can assert on the computed defaults
  // without touching real GPU resources.
  function createFakeEncoder() {
    return {
      copyTextureToTextureCalls: [],
      copyTextureToBufferCalls: [],
      copyTextureToTexture: function (src, dst, size) {
        this.copyTextureToTextureCalls.push({ src, dst, size });
      },
      copyTextureToBuffer: function (src, dst, size) {
        this.copyTextureToBufferCalls.push({ src, dst, size });
      },
    };
  }

  // A fake source/destination GPUTexture: only `width`/`height` are read by
  // the utilities.
  function fakeTexture(width, height) {
    return { width: width, height: height };
  }

  describe("copyTexture", function () {
    it("defaults origins to (0,0,0) and size to full source dimensions", function () {
      const encoder = createFakeEncoder();
      const source = fakeTexture(64, 32);
      const destination = fakeTexture(64, 32);

      copyTexture(encoder, source, destination);

      expect(encoder.copyTextureToTextureCalls.length).toBe(1);
      const call = encoder.copyTextureToTextureCalls[0];
      expect(call.src.texture).toBe(source);
      expect(call.src.origin).toEqual({ x: 0, y: 0, z: 0 });
      expect(call.dst.texture).toBe(destination);
      expect(call.dst.origin).toEqual({ x: 0, y: 0, z: 0 });
      expect(call.size).toEqual({
        width: 64,
        height: 32,
        depthOrArrayLayers: 1,
      });
    });

    it("forwards explicitly-supplied origins and copySize verbatim", function () {
      const encoder = createFakeEncoder();
      const source = fakeTexture(128, 128);
      const destination = fakeTexture(256, 256);
      const srcOrigin = { x: 5, y: 6, z: 0 };
      const dstOrigin = { x: 7, y: 8, z: 0 };
      const size = { width: 10, height: 12, depthOrArrayLayers: 1 };

      copyTexture(encoder, source, destination, srcOrigin, dstOrigin, size);

      const call = encoder.copyTextureToTextureCalls[0];
      expect(call.src.origin).toBe(srcOrigin);
      expect(call.dst.origin).toBe(dstOrigin);
      expect(call.size).toBe(size);
    });

    it("uses default origins but an explicit copySize when only size is supplied", function () {
      const encoder = createFakeEncoder();
      const source = fakeTexture(64, 64);
      const destination = fakeTexture(64, 64);
      const size = { width: 16, height: 16, depthOrArrayLayers: 1 };

      copyTexture(encoder, source, destination, undefined, undefined, size);

      const call = encoder.copyTextureToTextureCalls[0];
      expect(call.src.origin).toEqual({ x: 0, y: 0, z: 0 });
      expect(call.dst.origin).toEqual({ x: 0, y: 0, z: 0 });
      expect(call.size).toBe(size);
    });
  });

  describe("copyTextureRegion", function () {
    it("packs (srcX,srcY)/(dstX,dstY) into z=0 origins and (width,height) into a 1-layer extent", function () {
      const encoder = createFakeEncoder();
      const source = fakeTexture(512, 512);
      const destination = fakeTexture(512, 512);

      copyTextureRegion(encoder, source, destination, 1, 2, 3, 4, 20, 30);

      expect(encoder.copyTextureToTextureCalls.length).toBe(1);
      const call = encoder.copyTextureToTextureCalls[0];
      expect(call.src.texture).toBe(source);
      expect(call.dst.texture).toBe(destination);
      expect(call.src.origin).toEqual({ x: 1, y: 2, z: 0 });
      expect(call.dst.origin).toEqual({ x: 3, y: 4, z: 0 });
      expect(call.size).toEqual({
        width: 20,
        height: 30,
        depthOrArrayLayers: 1,
      });
    });
  });

  describe("createPixelReadbackPBO", function () {
    // A fake GPUDevice that records createBuffer descriptors and returns a
    // recording buffer handle.
    function createFakeDevice() {
      return {
        createdBuffers: [],
        createBuffer: function (descriptor) {
          const buffer = {
            descriptor: descriptor,
            destroyed: false,
            destroy: function () {
              this.destroyed = true;
            },
          };
          this.createdBuffers.push(buffer);
          return buffer;
        },
      };
    }

    it("rounds bytesPerRow up to the next 256-byte multiple (width*4 already aligned)", function () {
      // width=64 → 64*4 = 256, already a 256-multiple → stays 256.
      const device = createFakeDevice();
      const encoder = createFakeEncoder();
      const pbo = createPixelReadbackPBO(
        device,
        encoder,
        fakeTexture(64, 8),
        0,
        0,
        64,
        8,
      );
      expect(pbo.bytesPerRow).toBe(256);
      // bufferSize = bytesPerRow * height = 256 * 8.
      expect(device.createdBuffers[0].descriptor.size).toBe(256 * 8);
    });

    it("pads bytesPerRow when width*4 is not a 256-byte multiple", function () {
      // width=1 → 1*4 = 4 → ceil(4/256)*256 = 256.
      const device = createFakeDevice();
      const encoder = createFakeEncoder();
      const pbo = createPixelReadbackPBO(
        device,
        encoder,
        fakeTexture(1, 1),
        0,
        0,
        1,
        1,
      );
      expect(pbo.bytesPerRow).toBe(256);

      // width=100 → 100*4 = 400 → ceil(400/256)*256 = 512.
      const pbo2 = createPixelReadbackPBO(
        createFakeDevice(),
        createFakeEncoder(),
        fakeTexture(100, 4),
        0,
        0,
        100,
        4,
      );
      expect(pbo2.bytesPerRow).toBe(512);
      expect(pbo2.height).toBe(4);
      expect(pbo2.width).toBe(100);
    });

    it("requests a COPY_DST | MAP_READ buffer sized bytesPerRow*height", function () {
      const device = createFakeDevice();
      const encoder = createFakeEncoder();
      createPixelReadbackPBO(
        device,
        encoder,
        fakeTexture(50, 20),
        0,
        0,
        50,
        20,
      );

      // width=50 → 50*4 = 200 → ceil(200/256)*256 = 256.
      const descriptor = device.createdBuffers[0].descriptor;
      expect(descriptor.size).toBe(256 * 20);
      expect(descriptor.usage).toBe(
        globalThis.GPUBufferUsage.COPY_DST | globalThis.GPUBufferUsage.MAP_READ,
      );
    });

    it("issues copyTextureToBuffer from the (x,y,z=0) origin with the aligned bytesPerRow", function () {
      const device = createFakeDevice();
      const encoder = createFakeEncoder();
      createPixelReadbackPBO(
        device,
        encoder,
        fakeTexture(64, 64),
        12,
        34,
        8,
        4,
      );

      expect(encoder.copyTextureToBufferCalls.length).toBe(1);
      const call = encoder.copyTextureToBufferCalls[0];
      expect(call.src.origin).toEqual({ x: 12, y: 34, z: 0 });
      // width=8 → 8*4 = 32 → ceil(32/256)*256 = 256.
      expect(call.dst.bytesPerRow).toBe(256);
      expect(call.dst.buffer).toBe(device.createdBuffers[0]);
      expect(call.size).toEqual({
        width: 8,
        height: 4,
        depthOrArrayLayers: 1,
      });
    });

    it("returns a handle exposing buffer/width/height/bytesPerRow and mapAsync/destroy", function () {
      const device = createFakeDevice();
      const encoder = createFakeEncoder();
      const pbo = createPixelReadbackPBO(
        device,
        encoder,
        fakeTexture(64, 64),
        0,
        0,
        16,
        16,
      );
      expect(pbo.buffer).toBe(device.createdBuffers[0]);
      expect(pbo.width).toBe(16);
      expect(pbo.height).toBe(16);
      expect(typeof pbo.bytesPerRow).toBe("number");
      expect(typeof pbo.mapAsync).toBe("function");
      expect(typeof pbo.destroy).toBe("function");
    });

    it("destroy() releases the underlying readback buffer", function () {
      const device = createFakeDevice();
      const encoder = createFakeEncoder();
      const pbo = createPixelReadbackPBO(
        device,
        encoder,
        fakeTexture(64, 64),
        0,
        0,
        16,
        16,
      );
      expect(device.createdBuffers[0].destroyed).toBe(false);
      pbo.destroy();
      expect(device.createdBuffers[0].destroyed).toBe(true);
    });
  });

  describe("module exports", function () {
    it("exposes the device-dependent helpers as functions", function () {
      // These need a live GPUDevice/queue, so their bodies are covered by
      // the integration suites; here we just guard against an accidental
      // export removal.
      expect(typeof createDefaultTextures).toBe("function");
      expect(typeof createTextureFromImage).toBe("function");
    });

    it("default export wires the same five functions", function () {
      expect(WebGPUTextureUtilities.createDefaultTextures).toBe(
        createDefaultTextures,
      );
      expect(WebGPUTextureUtilities.copyTexture).toBe(copyTexture);
      expect(WebGPUTextureUtilities.copyTextureRegion).toBe(copyTextureRegion);
      expect(WebGPUTextureUtilities.createTextureFromImage).toBe(
        createTextureFromImage,
      );
      expect(WebGPUTextureUtilities.createPixelReadbackPBO).toBe(
        createPixelReadbackPBO,
      );
    });
  });
});
