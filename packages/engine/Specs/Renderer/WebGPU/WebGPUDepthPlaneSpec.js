import { WebGPUDepthPlane } from "../../../Source/Renderer/WebGPU/WebGPUDepthPlane.js";

describe("Renderer/WebGPU/WebGPUDepthPlane", function () {
  function createHarness() {
    const descriptors = [];
    const buffers = [];
    const device = {
      limits: {
        minUniformBufferOffsetAlignment: 256,
      },
      createShaderModule: jasmine
        .createSpy("createShaderModule")
        .and.callFake((descriptor) => ({ descriptor })),
      createBindGroupLayout: jasmine
        .createSpy("createBindGroupLayout")
        .and.callFake((descriptor) => ({ descriptor })),
      createBuffer: jasmine
        .createSpy("createBuffer")
        .and.callFake((descriptor) => {
          const buffer = {
            size: descriptor.size,
            descriptor,
            destroy: jasmine.createSpy("destroy"),
          };
          buffers.push(buffer);
          return buffer;
        }),
      createBindGroup: jasmine
        .createSpy("createBindGroup")
        .and.callFake((descriptor) => ({ descriptor })),
      createPipelineLayout: jasmine
        .createSpy("createPipelineLayout")
        .and.callFake((descriptor) => ({ descriptor })),
      queue: {
        writeBuffer: jasmine.createSpy("writeBuffer"),
      },
    };
    const pipelineCache = {
      getPipeline: jasmine
        .createSpy("getPipeline")
        .and.callFake((descriptor) => {
          descriptors.push(descriptor);
          return Promise.resolve({ name: descriptor.name });
        }),
    };
    return { buffers, descriptors, device, pipelineCache };
  }

  function initializeDepthPlane(harness) {
    const plane = new WebGPUDepthPlane();
    plane.initialize(
      harness.device,
      "depth24plus-stencil8",
      "bgra8unorm",
      harness.pipelineCache,
      4,
      true,
      "rgba8unorm",
    );
    return plane;
  }

  it("prepares exact scene-MRT and single-target pick pipeline contracts", async function () {
    const harness = createHarness();
    const plane = initializeDepthPlane(harness);

    expect(plane.isForDevice(harness.device)).toBe(true);
    expect(plane.isForDevice({})).toBe(false);

    expect(harness.descriptors.length).toBe(2);
    const sceneDescriptor = harness.descriptors[0];
    const pickDescriptor = harness.descriptors[1];

    expect(sceneDescriptor.name).toBe("DepthPlane-Pipeline[ld]");
    expect(sceneDescriptor.fragment.targets.length).toBe(2);
    expect(sceneDescriptor.fragment.targets[0].format).toBe("bgra8unorm");
    expect(sceneDescriptor.fragment.targets[0].writeMask).toBe(0);
    expect(sceneDescriptor.depthStencil.format).toBe("depth24plus-stencil8");
    expect(sceneDescriptor.multisample.count).toBe(4);

    expect(pickDescriptor.name).toBe("DepthPlane-Pipeline[ld][pick]");
    expect(pickDescriptor.fragment.targets).toEqual([
      { format: "rgba8unorm", writeMask: 0 },
    ]);
    expect(pickDescriptor.depthStencil.format).toBe("depth24plus-stencil8");
    expect(pickDescriptor.multisample).toBeUndefined();

    expect(pickDescriptor.vertex).toBe(sceneDescriptor.vertex);
    expect(pickDescriptor.layout).toBe(sceneDescriptor.layout);
    expect(harness.device.createShaderModule).toHaveBeenCalledTimes(1);
    expect(harness.device.createBindGroupLayout).toHaveBeenCalledTimes(1);
    const uniformLayoutEntry =
      harness.device.createBindGroupLayout.calls.mostRecent().args[0]
        .entries[0];
    expect(uniformLayoutEntry.buffer.hasDynamicOffset).toBe(true);
    expect(uniformLayoutEntry.buffer.minBindingSize).toBe(112);

    await Promise.resolve();
    plane.destroy();
    expect(plane.isForDevice(harness.device)).toBe(false);
  });

  it("selects the pipeline matching the explicit pass kind", async function () {
    const harness = createHarness();
    const plane = initializeDepthPlane(harness);
    await Promise.resolve();

    plane._enabled = true;
    plane._vertexCount = 4;
    const renderPass = {
      setPipeline: jasmine.createSpy("setPipeline"),
      setBindGroup: jasmine.createSpy("setBindGroup"),
      setVertexBuffer: jasmine.createSpy("setVertexBuffer"),
      draw: jasmine.createSpy("draw"),
    };

    plane.execute(renderPass, "pick");
    expect(renderPass.setPipeline).toHaveBeenCalledWith({
      name: "DepthPlane-Pipeline[ld][pick]",
    });

    renderPass.setPipeline.calls.reset();
    plane.execute(renderPass, "scene");
    expect(renderPass.setPipeline).toHaveBeenCalledWith({
      name: "DepthPlane-Pipeline[ld]",
    });

    plane.destroy();
  });

  it("never substitutes the scene pipeline when the pick variant is unavailable", async function () {
    const harness = createHarness();
    const plane = initializeDepthPlane(harness);
    await Promise.resolve();

    plane._enabled = true;
    plane._vertexCount = 4;
    plane._pickPipeline = null;
    const renderPass = {
      setPipeline: jasmine.createSpy("setPipeline"),
      setBindGroup: jasmine.createSpy("setBindGroup"),
      setVertexBuffer: jasmine.createSpy("setVertexBuffer"),
      draw: jasmine.createSpy("draw"),
    };

    plane.execute(renderPass, "pick");
    expect(renderPass.setPipeline).not.toHaveBeenCalled();
    expect(renderPass.draw).not.toHaveBeenCalled();

    plane.destroy();
  });

  it("binds one aligned immutable uniform slice per natural-frustum draw", async function () {
    const harness = createHarness();
    const plane = initializeDepthPlane(harness);
    await Promise.resolve();

    const frameState = {
      mode: 3,
      camera: {
        positionWC: { x: 7000000.0, y: 0.0, z: 0.0 },
      },
      mapProjection: {
        ellipsoid: {
          radii: { x: 6378137.0, y: 6378137.0, z: 6356752.314245 },
        },
      },
    };
    const dynamicOffsets = [];
    const renderPass = {
      setPipeline: jasmine.createSpy("setPipeline"),
      setBindGroup: jasmine
        .createSpy("setBindGroup")
        .and.callFake((_index, _bindGroup, offsets) => {
          dynamicOffsets.push(Array.from(offsets));
        }),
      setVertexBuffer: jasmine.createSpy("setVertexBuffer"),
      draw: jasmine.createSpy("draw"),
    };

    plane.beginPass(frameState, harness.device, 3);
    expect(plane._uniformCapacity).toBe(4);
    expect(plane._uniformBuffer.size).toBe(1024);
    expect(harness.device.queue.writeBuffer.calls.count()).toBe(1);

    const payload = new Float32Array(28);
    for (let i = 0; i < 3; i++) {
      payload[0] = i + 1;
      plane.updateUniforms(harness.device, payload);
      plane.execute(renderPass, "scene");
    }

    expect(dynamicOffsets).toEqual([[0], [256], [512]]);
    const uniformWrites = harness.device.queue.writeBuffer.calls
      .allArgs()
      .slice(1);
    expect(uniformWrites.map((args) => args[1])).toEqual([0, 256, 512]);
    expect(renderPass.draw).toHaveBeenCalledTimes(3);

    const bufferCreates = harness.device.createBuffer.calls.count();
    const bindGroupCreates = harness.device.createBindGroup.calls.count();
    plane.beginPass(frameState, harness.device, 3);
    expect(harness.device.createBuffer.calls.count()).toBe(bufferCreates);
    expect(harness.device.createBindGroup.calls.count()).toBe(bindGroupCreates);
    expect(() => {
      for (let i = 0; i < 5; i++) {
        plane.updateUniforms(harness.device, payload);
      }
    }).toThrowError(/uniform ring exhausted/);

    plane.destroy();
  });

  it("keeps the direct update/execute compatibility path reusable", async function () {
    const harness = createHarness();
    const plane = initializeDepthPlane(harness);
    await Promise.resolve();

    const frameState = {
      mode: 3,
      camera: {
        positionWC: { x: 7000000.0, y: 0.0, z: 0.0 },
      },
      mapProjection: {
        ellipsoid: {
          radii: { x: 6378137.0, y: 6378137.0, z: 6356752.314245 },
        },
      },
      context: {
        uniformState: {
          modelViewProjectionRelativeToEye: [
            1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
          ],
          encodedCameraPositionMCHigh: { x: 0, y: 0, z: 0 },
          encodedCameraPositionMCLow: { x: 0, y: 0, z: 0 },
          currentFrustum: { x: 1, y: 10000000 },
          oneOverLog2FarDepthFromNearPlusOne: 0.05,
        },
      },
    };
    const dynamicOffsets = [];
    const renderPass = {
      setPipeline: jasmine.createSpy("setPipeline"),
      setBindGroup: jasmine
        .createSpy("setBindGroup")
        .and.callFake((_index, _bindGroup, offsets) => {
          dynamicOffsets.push(Array.from(offsets));
        }),
      setVertexBuffer: jasmine.createSpy("setVertexBuffer"),
      draw: jasmine.createSpy("draw"),
    };

    expect(() => {
      plane.update(frameState, harness.device);
      plane.execute(renderPass, "scene");
      plane.update(frameState, harness.device);
      plane.execute(renderPass, "scene");
    }).not.toThrow();
    expect(dynamicOffsets).toEqual([[0], [0]]);

    plane.destroy();
  });
});
