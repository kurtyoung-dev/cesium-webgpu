import {
  BUFFER_CONSTANTS,
  createBufferStubs,
  WebGLStubBufferRegistry,
} from "../../../Source/Renderer/WebGPU/Stubs/WebGLStubBuffer.js";

if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
  };
}

describe("Renderer/WebGPU/Stubs/WebGLStubBuffer", function () {
  const GL_ARRAY_BUFFER = 0x8892;
  const GL_ELEMENT_ARRAY_BUFFER = 0x8893;

  function makeDevice(tag) {
    const resources = [];
    const writes = [];
    let liveBytes = 0;

    const device = {
      createBuffer(descriptor) {
        let destroyed = false;
        const buffer = {
          deviceTag: tag,
          size: descriptor.size,
          usage: descriptor.usage,
          label: descriptor.label,
          get destroyed() {
            return destroyed;
          },
          destroy() {
            if (destroyed) {
              return;
            }
            destroyed = true;
            liveBytes -= descriptor.size;
          },
        };
        liveBytes += descriptor.size;
        resources.push(buffer);
        return buffer;
      },
      queue: {
        writeBuffer(buffer, offset, data, dataOffset = 0, size) {
          if (buffer.destroyed) {
            throw new Error("writeBuffer targeted a destroyed buffer");
          }
          const source =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          const writeSize = size ?? source.byteLength - dataOffset;
          writes.push({
            buffer,
            offset,
            bytes: Array.from(
              source.subarray(dataOffset, dataOffset + writeSize),
            ),
          });
        },
      },
    };

    return {
      device,
      resources,
      writes,
      get liveBytes() {
        return liveBytes;
      },
    };
  }

  function makeState(device = null, allocateCompatibilityBuffers = true) {
    return {
      device,
      boundVertexBuffer: null,
      boundIndexBuffer: null,
      bufferRegistry: new WebGLStubBufferRegistry(),
      allocateCompatibilityBuffers,
    };
  }

  function createHarness(device = null, allocateCompatibilityBuffers = true) {
    const state = makeState(device, allocateCompatibilityBuffers);
    const stubs = createBufferStubs(state, function () {});
    return { state, stubs };
  }

  describe("BUFFER_CONSTANTS", function () {
    it("pins and freezes the buffer constants", function () {
      expect(BUFFER_CONSTANTS.ARRAY_BUFFER).toBe(GL_ARRAY_BUFFER);
      expect(BUFFER_CONSTANTS.ELEMENT_ARRAY_BUFFER).toBe(
        GL_ELEMENT_ARRAY_BUFFER,
      );
      expect(BUFFER_CONSTANTS.STATIC_DRAW).toBe(0x88e4);
      expect(BUFFER_CONSTANTS.DYNAMIC_DRAW).toBe(0x88e8);
      expect(BUFFER_CONSTANTS.STREAM_DRAW).toBe(0x88e0);
      expect(Object.isFrozen(BUFFER_CONSTANTS)).toBe(true);
    });
  });

  describe("handle ownership", function () {
    it("returns the full method surface", function () {
      const { stubs } = createHarness();
      const expectedMethods = [
        "createBuffer",
        "bindBuffer",
        "deleteBuffer",
        "bufferData",
        "bufferSubData",
        "invalidateCompatibilityBufferHandles",
        "destroyCompatibilityBufferHandles",
        "getCompatibilityBufferDiagnostics",
        "enableVertexAttribArray",
        "disableVertexAttribArray",
        "vertexAttribPointer",
        "vertexAttribDivisor",
      ];
      for (const name of expectedMethods) {
        expect(typeof stubs[name]).toBe("function");
      }
    });

    it("creates a stable handle without an eager native allocation", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();

      expect(gpu.resources.length).toBe(0);
      expect(gpu.liveBytes).toBe(0);
      expect(handle._webgpuBuffer).toBeNull();
      expect(handle._size).toBe(0);
      expect(handle._device).toBeNull();
      expect(handle._destroyed).toBe(false);
      expect(typeof handle.destroy).toBe("function");
      expect(stubs.getCompatibilityBufferDiagnostics()).toEqual({
        registeredHandleCount: 1,
        logicalStoreCount: 0,
        logicalStoreBytes: 0,
        liveBufferCount: 0,
        liveBufferBytes: 0,
      });
      expect(Object.isFrozen(stubs.getCompatibilityBufferDiagnostics())).toBe(
        true,
      );
    });

    it("creates the same stable handle while the device is unavailable", function () {
      const { stubs } = createHarness();
      const handle = stubs.createBuffer();

      expect(handle._webgpuBuffer).toBeNull();
      expect(handle._size).toBe(0);
      expect(handle._destroyed).toBe(false);
    });

    it("stores the handle identity in each binding slot", function () {
      const { state, stubs } = createHarness();
      const vertex = stubs.createBuffer();
      const index = stubs.createBuffer();

      stubs.bindBuffer(GL_ARRAY_BUFFER, vertex);
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, index);
      expect(state.boundVertexBuffer).toBe(vertex);
      expect(state.boundIndexBuffer).toBe(index);

      stubs.bindBuffer(GL_ARRAY_BUFFER, null);
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, null);
      expect(state.boundVertexBuffer).toBeNull();
      expect(state.boundIndexBuffer).toBeNull();
    });

    it("ignores unknown targets and will not rebind a deleted handle", function () {
      const { state, stubs } = createHarness();
      const handle = stubs.createBuffer();

      stubs.bindBuffer(0xdead, handle);
      expect(state.boundVertexBuffer).toBeNull();
      expect(state.boundIndexBuffer).toBeNull();

      stubs.deleteBuffer(handle);
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      expect(state.boundVertexBuffer).toBeNull();
    });
  });

  describe("metadata-only production policy", function () {
    it("tracks logical stores without allocating, uploading, or retaining payloads", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device, false);
      const vertex = stubs.createBuffer();
      const index = stubs.createBuffer();

      stubs.bindBuffer(GL_ARRAY_BUFFER, vertex);
      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array([1, 2, 3, 4, 5]), 0);
      stubs.bufferSubData(GL_ARRAY_BUFFER, 0, new Uint8Array([9, 8, 7, 6]));
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, index);
      stubs.bufferData(GL_ELEMENT_ARRAY_BUFFER, 10, 0);

      expect(vertex._size).toBe(5);
      expect(index._size).toBe(10);
      expect(vertex._webgpuBuffer).toBeNull();
      expect(index._webgpuBuffer).toBeNull();
      expect(vertex._device).toBeNull();
      expect(Object.hasOwn(vertex, "_data")).toBe(false);
      expect(gpu.resources.length).toBe(0);
      expect(gpu.writes.length).toBe(0);
      expect(stubs.getCompatibilityBufferDiagnostics()).toEqual({
        registeredHandleCount: 2,
        logicalStoreCount: 2,
        logicalStoreBytes: 15,
        liveBufferCount: 0,
        liveBufferBytes: 0,
      });
    });

    it("tracks a logical store even before a GPUDevice is available", function () {
      const { stubs } = createHarness(null, false);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);

      stubs.bufferData(GL_ARRAY_BUFFER, 256, 0);

      expect(handle._size).toBe(256);
      expect(handle._webgpuBuffer).toBeNull();
    });
  });

  describe("bufferData", function () {
    it("allocates only the aligned bytes needed below 4 KiB", function () {
      const gpu = makeDevice("A");
      const { state, stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);

      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array([1, 2, 3, 4, 5]), 0);

      expect(state.boundVertexBuffer).toBe(handle);
      expect(gpu.resources.length).toBe(1);
      expect(gpu.resources[0].size).toBe(8);
      expect(gpu.liveBytes).toBe(8);
      expect(handle._webgpuBuffer).toBe(gpu.resources[0]);
      expect(handle._size).toBe(5);
      expect(gpu.writes[0].bytes).toEqual([1, 2, 3, 4, 5, 0, 0, 0]);
    });

    it("allocates above 4 KiB without an intermediate 4 KiB resource", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, handle);

      stubs.bufferData(GL_ELEMENT_ARRAY_BUFFER, new Uint8Array(4097), 0);

      expect(gpu.resources.length).toBe(1);
      expect(gpu.resources[0].size).toBe(4100);
      expect(gpu.liveBytes).toBe(4100);
      expect(handle._size).toBe(4097);
    });

    it("implements numeric size-only allocation without uploading", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);

      stubs.bufferData(GL_ARRAY_BUFFER, 256, 0);

      expect(gpu.resources.length).toBe(1);
      expect(gpu.resources[0].size).toBe(256);
      expect(gpu.writes.length).toBe(0);
      expect(handle._size).toBe(256);
    });

    it("atomically grows the current resource while preserving handle identity", function () {
      const gpu = makeDevice("A");
      const { state, stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array(16), 0);
      const first = handle._webgpuBuffer;

      stubs.bindBuffer(GL_ARRAY_BUFFER, null);
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array(5001), 0);
      const second = handle._webgpuBuffer;

      expect(state.boundVertexBuffer).toBe(handle);
      expect(second).not.toBe(first);
      expect(first.destroyed).toBe(true);
      expect(second.destroyed).toBe(false);
      expect(gpu.resources.length).toBe(2);
      expect(gpu.liveBytes).toBe(5004);
      expect(handle._size).toBe(5001);
    });

    it("keeps the current owner when replacement allocation fails", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, 16, 0);
      const current = handle._webgpuBuffer;
      gpu.device.createBuffer = function () {
        throw new Error("allocation failed");
      };

      expect(function () {
        stubs.bufferData(GL_ARRAY_BUFFER, 64, 0);
      }).toThrowError("allocation failed");

      expect(handle._webgpuBuffer).toBe(current);
      expect(handle._size).toBe(16);
      expect(current.destroyed).toBe(false);
      expect(gpu.liveBytes).toBe(16);
    });

    it("rolls back growth when the replacement upload throws", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(
        GL_ARRAY_BUFFER,
        new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        0,
      );
      const current = handle._webgpuBuffer;
      const originalWrite = gpu.device.queue.writeBuffer;
      gpu.device.queue.writeBuffer = function (candidate) {
        expect(candidate).not.toBe(current);
        expect(current.destroyed).toBe(false);
        throw new Error("device lost during write");
      };

      expect(function () {
        stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array(64), 0);
      }).toThrowError("device lost during write");

      expect(handle._webgpuBuffer).toBe(current);
      expect(handle._size).toBe(8);
      expect(handle._device).toBe(gpu.device);
      expect(current.destroyed).toBe(false);
      expect(gpu.resources.length).toBe(2);
      expect(gpu.resources[1].destroyed).toBe(true);
      expect(gpu.liveBytes).toBe(8);

      gpu.device.queue.writeBuffer = originalWrite;
    });

    it("reuses sufficient capacity and updates the logical store size", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array(64), 0);
      const resource = handle._webgpuBuffer;

      stubs.bufferData(GL_ARRAY_BUFFER, 12, 0);

      expect(gpu.resources.length).toBe(1);
      expect(handle._webgpuBuffer).toBe(resource);
      expect(handle._size).toBe(12);
      expect(gpu.liveBytes).toBe(64);
    });

    it("replaces an old-device resource before writing after device loss", function () {
      const gpuA = makeDevice("A");
      const gpuB = makeDevice("B");
      const { state, stubs } = createHarness(gpuA.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array(16), 0);
      const oldResource = handle._webgpuBuffer;

      state.device = null;
      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array(32), 0);
      expect(handle._webgpuBuffer).toBe(oldResource);
      expect(oldResource.destroyed).toBe(false);

      state.device = gpuB.device;
      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array(16), 0);

      expect(oldResource.destroyed).toBe(true);
      expect(gpuA.liveBytes).toBe(0);
      expect(gpuB.liveBytes).toBe(16);
      expect(handle._device).toBe(gpuB.device);
      expect(gpuB.writes[0].buffer.deviceTag).toBe("B");
    });

    it("releases the current store for a zero-sized bufferData", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, 32, 0);

      stubs.bufferData(GL_ARRAY_BUFFER, 0, 0);

      expect(gpu.liveBytes).toBe(0);
      expect(handle._webgpuBuffer).toBeNull();
      expect(handle._size).toBe(0);
      expect(handle._destroyed).toBe(false);
    });

    it("does nothing without a bound handle or current device", function () {
      const gpu = makeDevice("A");
      const { state, stubs } = createHarness();
      const handle = stubs.createBuffer();

      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array(16), 0);
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, new Uint8Array(16), 0);
      expect(gpu.resources.length).toBe(0);

      state.device = gpu.device;
      stubs.bufferData(0xdead, new Uint8Array(16), 0);
      expect(gpu.resources.length).toBe(0);
    });
  });

  describe("bufferSubData", function () {
    it("writes in-bounds data to the handle's current resource", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, 32, 0);

      stubs.bufferSubData(
        GL_ARRAY_BUFFER,
        8,
        new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2]),
      );

      expect(gpu.writes.length).toBe(1);
      expect(gpu.writes[0].buffer).toBe(handle._webgpuBuffer);
      expect(gpu.writes[0].offset).toBe(8);
      expect(gpu.writes[0].bytes).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    });

    it("fails safely for unaligned or out-of-range writes", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, 16, 0);
      const resource = handle._webgpuBuffer;

      stubs.bufferSubData(GL_ARRAY_BUFFER, 2, new Uint8Array(4));
      stubs.bufferSubData(GL_ARRAY_BUFFER, 4, new Uint8Array(5));
      stubs.bufferSubData(GL_ARRAY_BUFFER, 12, new Uint8Array(8));
      stubs.bufferSubData(GL_ARRAY_BUFFER, -4, new Uint8Array(4));

      expect(gpu.writes.length).toBe(0);
      expect(gpu.resources.length).toBe(1);
      expect(handle._webgpuBuffer).toBe(resource);
      expect(resource.destroyed).toBe(false);
    });

    it("replaces an old-device resource before a recovery upload", function () {
      const gpuA = makeDevice("A");
      const gpuB = makeDevice("B");
      const { state, stubs } = createHarness(gpuA.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ELEMENT_ARRAY_BUFFER, 64, 0);
      const oldResource = handle._webgpuBuffer;

      state.device = gpuB.device;
      stubs.bufferSubData(GL_ELEMENT_ARRAY_BUFFER, 4, new Uint32Array([7, 8]));

      expect(oldResource.destroyed).toBe(true);
      expect(gpuA.liveBytes).toBe(0);
      expect(gpuB.liveBytes).toBe(64);
      expect(handle._webgpuBuffer.deviceTag).toBe("B");
      expect(gpuB.writes[0].buffer).toBe(handle._webgpuBuffer);
      expect(handle._size).toBe(64);
    });

    it("rolls back an old-device realization when sub-data upload throws", function () {
      const gpuA = makeDevice("A");
      const gpuB = makeDevice("B");
      const { state, stubs } = createHarness(gpuA.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ELEMENT_ARRAY_BUFFER, 64, 0);
      const current = handle._webgpuBuffer;
      state.device = gpuB.device;
      gpuB.device.queue.writeBuffer = function () {
        throw new Error("recovery write failed");
      };

      expect(function () {
        stubs.bufferSubData(
          GL_ELEMENT_ARRAY_BUFFER,
          4,
          new Uint32Array([7, 8]),
        );
      }).toThrowError("recovery write failed");

      expect(handle._webgpuBuffer).toBe(current);
      expect(handle._device).toBe(gpuA.device);
      expect(handle._size).toBe(64);
      expect(current.destroyed).toBe(false);
      expect(gpuA.liveBytes).toBe(64);
      expect(gpuB.resources.length).toBe(1);
      expect(gpuB.resources[0].destroyed).toBe(true);
      expect(gpuB.liveBytes).toBe(0);
    });

    it("does nothing before bufferData establishes a store", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);

      stubs.bufferSubData(GL_ARRAY_BUFFER, 0, new Uint8Array(4));

      expect(gpu.resources.length).toBe(0);
      expect(gpu.writes.length).toBe(0);
    });
  });

  describe("deleteBuffer", function () {
    it("destroys only the current native owner once and clears all bindings", function () {
      const gpu = makeDevice("A");
      const { state, stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, 16, 0);
      stubs.bufferData(GL_ARRAY_BUFFER, 64, 0);
      const first = gpu.resources[0];
      const current = gpu.resources[1];
      stubs.bindBuffer(GL_ELEMENT_ARRAY_BUFFER, handle);

      expect(first.destroyed).toBe(true);
      expect(current.destroyed).toBe(false);
      expect(gpu.liveBytes).toBe(64);

      stubs.deleteBuffer(handle);
      stubs.deleteBuffer(handle);

      expect(current.destroyed).toBe(true);
      expect(gpu.liveBytes).toBe(0);
      expect(state.boundVertexBuffer).toBeNull();
      expect(state.boundIndexBuffer).toBeNull();
      expect(handle._webgpuBuffer).toBeNull();
      expect(handle._destroyed).toBe(true);
      expect(stubs.getCompatibilityBufferDiagnostics()).toEqual({
        registeredHandleCount: 0,
        logicalStoreCount: 0,
        logicalStoreBytes: 0,
        liveBufferCount: 0,
        liveBufferBytes: 0,
      });
    });

    it("is safe for null and never-allocated handles", function () {
      const gpu = makeDevice("A");
      const { stubs } = createHarness(gpu.device);
      const handle = stubs.createBuffer();

      expect(function () {
        stubs.deleteBuffer(null);
        stubs.deleteBuffer(handle);
        stubs.deleteBuffer(handle);
      }).not.toThrow();
      expect(gpu.resources.length).toBe(0);
      expect(gpu.liveBytes).toBe(0);
    });
  });

  describe("context-local lifetime", function () {
    it("invalidates unbound native resources but preserves reusable handles", function () {
      const gpuA = makeDevice("A");
      const gpuB = makeDevice("B");
      const { state, stubs } = createHarness(gpuA.device);
      const handle = stubs.createBuffer();
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferData(GL_ARRAY_BUFFER, 32, 0);
      const oldResource = handle._webgpuBuffer;
      stubs.bindBuffer(GL_ARRAY_BUFFER, null);

      expect(stubs.getCompatibilityBufferDiagnostics()).toEqual({
        registeredHandleCount: 1,
        logicalStoreCount: 1,
        logicalStoreBytes: 32,
        liveBufferCount: 1,
        liveBufferBytes: 32,
      });

      stubs.invalidateCompatibilityBufferHandles();

      expect(oldResource.destroyed).toBe(true);
      expect(gpuA.liveBytes).toBe(0);
      expect(handle._webgpuBuffer).toBeNull();
      expect(handle._device).toBeNull();
      expect(handle._size).toBe(32);
      expect(handle._destroyed).toBe(false);
      expect(stubs.getCompatibilityBufferDiagnostics()).toEqual({
        registeredHandleCount: 1,
        logicalStoreCount: 1,
        logicalStoreBytes: 32,
        liveBufferCount: 0,
        liveBufferBytes: 0,
      });

      state.device = gpuB.device;
      stubs.bindBuffer(GL_ARRAY_BUFFER, handle);
      stubs.bufferSubData(GL_ARRAY_BUFFER, 4, new Uint32Array([9, 10]));
      expect(handle._webgpuBuffer.deviceTag).toBe("B");
      expect(handle._size).toBe(32);
      expect(gpuB.liveBytes).toBe(32);
    });

    it("drains one context's unbound buffers while a pooled-device peer remains live", function () {
      const gpu = makeDevice("shared");
      const first = createHarness(gpu.device);
      const second = createHarness(gpu.device);
      const firstHandle = first.stubs.createBuffer();
      const secondHandle = second.stubs.createBuffer();
      first.stubs.bindBuffer(GL_ARRAY_BUFFER, firstHandle);
      first.stubs.bufferData(GL_ARRAY_BUFFER, 24, 0);
      first.stubs.bindBuffer(GL_ARRAY_BUFFER, null);
      second.stubs.bindBuffer(GL_ARRAY_BUFFER, secondHandle);
      second.stubs.bufferData(GL_ARRAY_BUFFER, 40, 0);
      second.stubs.bindBuffer(GL_ARRAY_BUFFER, null);
      const firstResource = firstHandle._webgpuBuffer;
      const secondResource = secondHandle._webgpuBuffer;

      first.stubs.destroyCompatibilityBufferHandles();

      expect(firstResource.destroyed).toBe(true);
      expect(firstHandle._destroyed).toBe(true);
      expect(first.stubs.getCompatibilityBufferDiagnostics()).toEqual({
        registeredHandleCount: 0,
        logicalStoreCount: 0,
        logicalStoreBytes: 0,
        liveBufferCount: 0,
        liveBufferBytes: 0,
      });
      expect(secondResource.destroyed).toBe(false);
      expect(secondHandle._destroyed).toBe(false);
      expect(second.stubs.getCompatibilityBufferDiagnostics()).toEqual({
        registeredHandleCount: 1,
        logicalStoreCount: 1,
        logicalStoreBytes: 40,
        liveBufferCount: 1,
        liveBufferBytes: 40,
      });
      expect(gpu.liveBytes).toBe(40);
    });
  });

  describe("vertex-attribute no-ops", function () {
    it("keeps the legacy calls callable without a device", function () {
      const { stubs } = createHarness();
      expect(function () {
        stubs.enableVertexAttribArray(0);
        stubs.disableVertexAttribArray(0);
        stubs.vertexAttribPointer(0, 3, 0x1406, false, 0, 0);
        stubs.vertexAttribDivisor(0, 1);
      }).not.toThrow();
    });
  });
});
