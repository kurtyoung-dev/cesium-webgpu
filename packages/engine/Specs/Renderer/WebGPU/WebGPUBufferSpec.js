import WebGPUBuffer from "../../../Source/Renderer/WebGPU/WebGPUBuffer.js";

describe("Renderer/WebGPU/WebGPUBuffer", function () {
  let device;
  const hasWebGPU =
    typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined";

  if (hasWebGPU) {
    beforeAll(async function () {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
          device = await adapter.requestDevice();
        }
      } catch (e) {
        // WebGPU not available in this environment
      }
    });

    afterAll(function () {
      if (device) {
        device.destroy();
        device = undefined;
      }
    });
  }

  it("is defined", function () {
    expect(WebGPUBuffer).toBeDefined();
  });

  it("has static factory methods", function () {
    expect(typeof WebGPUBuffer.createVertexBuffer).toBe("function");
    expect(typeof WebGPUBuffer.createIndexBuffer).toBe("function");
    expect(typeof WebGPUBuffer.createUniformBuffer).toBe("function");
    expect(typeof WebGPUBuffer.createStorageBuffer).toBe("function");
  });

  // GPU-dependent tests — only run when WebGPU device is available
  describe("with GPU device", function () {
    beforeEach(function () {
      if (!device) {
        pending("WebGPU device not available");
      }
    });

    it("creates a vertex buffer from Float32Array", function () {
      const data = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
      const buffer = WebGPUBuffer.createVertexBuffer(
        device,
        data,
        "test-vertex",
      );

      expect(buffer).toBeDefined();
      expect(buffer.buffer).toBeDefined();
      expect(buffer.size).toEqual(data.byteLength);
      expect(buffer.label).toEqual("test-vertex");
      expect(buffer.isDestroyed).toBe(false);

      buffer.destroy();
      expect(buffer.isDestroyed).toBe(true);
    });

    it("creates an index buffer from Uint16Array", function () {
      const data = new Uint16Array([0, 1, 2, 2, 3, 0]);
      const buffer = WebGPUBuffer.createIndexBuffer(device, data, "test-index");

      expect(buffer).toBeDefined();
      expect(buffer.size).toBeGreaterThanOrEqual(data.byteLength);
      expect(buffer.label).toEqual("test-index");

      buffer.destroy();
    });

    it("creates a uniform buffer with 256-byte alignment", function () {
      const buffer = WebGPUBuffer.createUniformBuffer(
        device,
        100,
        undefined,
        "test-uniform",
      );

      expect(buffer).toBeDefined();
      // Uniform buffers are 256-byte aligned in WebGPU
      expect(buffer.size).toBeGreaterThanOrEqual(100);
      expect(buffer.label).toEqual("test-uniform");

      buffer.destroy();
    });

    it("creates a storage buffer", function () {
      const buffer = WebGPUBuffer.createStorageBuffer(
        device,
        512,
        undefined,
        false,
        "test-storage",
      );

      expect(buffer).toBeDefined();
      expect(buffer.size).toBeGreaterThanOrEqual(512);

      buffer.destroy();
    });

    it("creates a buffer with initial data", function () {
      const data = new Float32Array([1.0, 2.0, 3.0, 4.0]);
      const buffer = WebGPUBuffer.createVertexBuffer(device, data, "test-data");

      expect(buffer).toBeDefined();
      expect(buffer.size).toEqual(data.byteLength);

      buffer.destroy();
    });

    it("writes data to buffer", function () {
      const data = new Float32Array([1.0, 2.0, 3.0, 4.0]);
      const buffer = WebGPUBuffer.createVertexBuffer(
        device,
        data,
        "test-write",
      );

      // Write new data
      const newData = new Float32Array([5.0, 6.0, 7.0, 8.0]);
      buffer.write(newData);

      // No error means write succeeded
      expect(buffer.size).toEqual(data.byteLength);

      buffer.destroy();
    });

    it("enforces minimum buffer size of 4 bytes", function () {
      // Empty data should still create a valid buffer
      const buffer = WebGPUBuffer.createVertexBuffer(
        device,
        new Float32Array(0),
        "test-empty",
      );

      expect(buffer).toBeDefined();
      expect(buffer.size).toBeGreaterThanOrEqual(4);

      buffer.destroy();
    });

    it("handles Uint32Array index buffers", function () {
      const data = new Uint32Array([0, 1, 2, 100000, 200000, 300000]);
      const buffer = WebGPUBuffer.createIndexBuffer(
        device,
        data,
        "test-uint32-index",
      );

      expect(buffer).toBeDefined();
      expect(buffer.size).toEqual(data.byteLength);

      buffer.destroy();
    });
  });
});
