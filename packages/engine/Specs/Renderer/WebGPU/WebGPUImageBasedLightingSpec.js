import {
  destroyWebGPUImageBasedLightingResources,
  updateWebGPUImageBasedLighting,
} from "../../../Source/Renderer/WebGPU/WebGPUImageBasedLighting.js";

describe("Renderer/WebGPU/WebGPUImageBasedLighting", function () {
  function createDeviceHarness() {
    const buffers = [];
    const textures = [];
    const device = {
      createBuffer: jasmine.createSpy("createBuffer").and.callFake(() => {
        const buffer = { destroy: jasmine.createSpy("destroy") };
        buffers.push(buffer);
        return buffer;
      }),
      createTexture: jasmine.createSpy("createTexture").and.callFake(() => {
        const texture = {
          createView: jasmine.createSpy("createView").and.returnValue({}),
          destroy: jasmine.createSpy("destroy"),
        };
        textures.push(texture);
        return texture;
      }),
      createSampler: jasmine.createSpy("createSampler").and.returnValue({}),
      queue: {
        writeBuffer: jasmine.createSpy("writeBuffer"),
        writeTexture: jasmine.createSpy("writeTexture"),
      },
    };
    return { buffers, device, textures };
  }

  function createHarness() {
    const gpu = createDeviceHarness();
    const { buffers, device, textures } = gpu;
    const context = {
      device,
      resourceGeneration: 0,
      graphicsCapabilities: {
        ktx2TranscodeTargets: { cacheKey: "test" },
      },
    };
    const frameState = {
      frameNumber: 1,
      context,
      brdfLutGenerator: { update: jasmine.createSpy("update") },
    };
    const coefficients = Array.from({ length: 9 }, (_, i) => ({
      x: i + 0.25,
      y: i + 0.5,
      z: i + 0.75,
    }));
    const ibl = {
      imageBasedLightingFactor: { x: 1.0, y: 1.0 },
      sphericalHarmonicCoefficients: coefficients,
      _previousFrameNumber: undefined,
      _previousFrameContext: undefined,
      _specularEnvironmentCubeMap: undefined,
      _specularEnvironmentMaps: undefined,
    };
    return {
      buffers,
      coefficients,
      context,
      device,
      frameState,
      ibl,
      textures,
    };
  }

  function updateNextFrame(harness) {
    harness.frameState.frameNumber++;
    updateWebGPUImageBasedLighting(harness.ibl, harness.frameState);
  }

  it("keeps one SH buffer and uploads only when packed values change", function () {
    const harness = createHarness();
    updateWebGPUImageBasedLighting(harness.ibl, harness.frameState);

    expect(harness.device.createBuffer).toHaveBeenCalledTimes(1);
    expect(harness.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
    const shBuffer = harness.ibl._webgpuSHBuffer;
    expect(shBuffer).toBe(harness.buffers[0]);

    updateNextFrame(harness);
    expect(harness.device.createBuffer).toHaveBeenCalledTimes(1);
    expect(harness.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
    expect(harness.ibl._webgpuSHBuffer).toBe(shBuffer);

    harness.coefficients[0].x += 1.0;
    updateNextFrame(harness);
    expect(harness.device.createBuffer).toHaveBeenCalledTimes(1);
    expect(harness.device.queue.writeBuffer).toHaveBeenCalledTimes(3);
    expect(harness.ibl._webgpuSHBuffer).toBe(shBuffer);

    harness.ibl.sphericalHarmonicCoefficients = undefined;
    updateNextFrame(harness);
    expect(harness.device.createBuffer).toHaveBeenCalledTimes(1);
    expect(harness.device.queue.writeBuffer).toHaveBeenCalledTimes(4);
    expect(harness.ibl._webgpuHasSH).toBe(false);
    expect(harness.ibl._webgpuSHBuffer).toBe(shBuffer);

    updateNextFrame(harness);
    expect(harness.device.queue.writeBuffer).toHaveBeenCalledTimes(4);

    destroyWebGPUImageBasedLightingResources(harness.ibl);
    expect(shBuffer.destroy).toHaveBeenCalledTimes(1);
  });

  it("rebuilds every native handle for the exact device generation", function () {
    const harness = createHarness();
    updateWebGPUImageBasedLighting(harness.ibl, harness.frameState);

    const generation0Buffer = harness.ibl._webgpuSHBuffer;
    const generation0Textures = harness.textures.slice();
    expect(generation0Textures.length).toBe(2);

    // Deliberately keep the same frame number and context identity. A resource
    // generation change must run before the duplicate-frame fast path.
    harness.context.resourceGeneration++;
    updateWebGPUImageBasedLighting(harness.ibl, harness.frameState);

    expect(generation0Buffer.destroy).toHaveBeenCalledTimes(1);
    for (const texture of generation0Textures) {
      expect(texture.destroy).toHaveBeenCalledTimes(1);
    }
    expect(harness.device.createBuffer).toHaveBeenCalledTimes(2);
    expect(harness.device.createTexture).toHaveBeenCalledTimes(4);
    expect(harness.device.queue.writeBuffer).toHaveBeenCalledTimes(4);
    const generation1Buffer = harness.ibl._webgpuSHBuffer;
    expect(generation1Buffer).not.toBe(generation0Buffer);
    const generation1Textures = harness.textures.slice(2);

    // A replacement device is independently authoritative even if a caller
    // accidentally reuses the numeric generation.
    const replacement = createDeviceHarness();
    harness.context.device = replacement.device;
    updateWebGPUImageBasedLighting(harness.ibl, harness.frameState);

    expect(generation1Buffer.destroy).toHaveBeenCalledTimes(1);
    for (const texture of generation1Textures) {
      expect(texture.destroy).toHaveBeenCalledTimes(1);
    }
    expect(replacement.device.createBuffer).toHaveBeenCalledTimes(1);
    expect(replacement.device.createTexture).toHaveBeenCalledTimes(2);
    expect(replacement.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
    expect(harness.ibl._webgpuSHBuffer).toBe(replacement.buffers[0]);
    expect(harness.ibl._webgpuSHBuffer).not.toBe(generation1Buffer);
  });

  it("detaches a stale generation and drains every handle when destroy throws", function () {
    const harness = createHarness();
    updateWebGPUImageBasedLighting(harness.ibl, harness.frameState);

    const generation0Buffer = harness.ibl._webgpuSHBuffer;
    const generation0Textures = harness.textures.slice();
    const generation0Cube = {
      destroy: jasmine.createSpy("destroyCube").and.throwError("device lost"),
    };
    harness.ibl._webgpuSpecularCube = generation0Cube;
    harness.ibl._specularEnvironmentCubeMap = { ready: true };
    generation0Textures[0].destroy.and.throwError("device lost");
    generation0Buffer.destroy.and.throwError("device lost");

    harness.context.resourceGeneration++;
    expect(function () {
      updateWebGPUImageBasedLighting(harness.ibl, harness.frameState);
    }).not.toThrow();

    for (const texture of generation0Textures) {
      expect(texture.destroy).toHaveBeenCalledTimes(1);
    }
    expect(generation0Buffer.destroy).toHaveBeenCalledTimes(1);
    expect(generation0Cube.destroy).toHaveBeenCalledTimes(1);
    expect(harness.ibl._webgpuSpecularCube).toBeUndefined();
    expect(harness.ibl._specularEnvironmentCubeMap).toBeUndefined();
    expect(harness.ibl._webgpuSHBuffer).toBe(harness.buffers[1]);
    expect(harness.ibl._webgpuSHBuffer).not.toBe(generation0Buffer);
  });
});
