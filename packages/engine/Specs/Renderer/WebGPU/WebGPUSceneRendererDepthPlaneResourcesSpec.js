import { ensureDepthPlane } from "../../../Source/Renderer/WebGPU/WebGPUSceneRendererEnsureResources.js";

describe("Renderer/WebGPU/WebGPUSceneRenderer depth-plane resources", function () {
  function createDevice(name) {
    const descriptors = [];
    const device = {
      name,
      limits: { minUniformBufferOffsetAlignment: 256 },
      createShaderModule: jasmine
        .createSpy(`${name}.createShaderModule`)
        .and.callFake((descriptor) => ({ descriptor, device: name })),
      createBindGroupLayout: jasmine
        .createSpy(`${name}.createBindGroupLayout`)
        .and.callFake((descriptor) => ({ descriptor, device: name })),
      createBuffer: jasmine
        .createSpy(`${name}.createBuffer`)
        .and.callFake((descriptor) => ({
          descriptor,
          size: descriptor.size,
          destroy: jasmine.createSpy(`${name}.buffer.destroy`),
        })),
      createBindGroup: jasmine
        .createSpy(`${name}.createBindGroup`)
        .and.callFake((descriptor) => ({ descriptor, device: name })),
      createPipelineLayout: jasmine
        .createSpy(`${name}.createPipelineLayout`)
        .and.callFake((descriptor) => ({ descriptor, device: name })),
      queue: { writeBuffer: jasmine.createSpy(`${name}.writeBuffer`) },
    };
    const pipelineCache = {
      getPipeline: jasmine
        .createSpy(`${name}.getPipeline`)
        .and.callFake((descriptor) => {
          descriptors.push(descriptor);
          return Promise.resolve({ descriptor, device: name });
        }),
    };
    return { descriptors, device, pipelineCache };
  }

  function createConfig(deviceHarness, overrides = {}) {
    const context = {
      _device: deviceHarness.device,
      _deviceResourceGeneration: overrides.resourceGeneration ?? 0,
      _scenePipelineFormatGeneration: 7,
      _logDepthWriteEnabled: overrides.logDepth ?? true,
      _msaaSamples: overrides.msaa ?? 4,
      scenePipelineFormat: overrides.sceneFormat ?? "rg11b10ufloat",
      presentationFormat: "bgra8unorm",
      pickPipelineFormat: overrides.pickFormat ?? "rgba8unorm",
      depthFormat: "depth24plus-stencil8",
      webgpuPipelineCache: deviceHarness.pipelineCache,
    };
    return {
      useDepthPlane: overrides.useDepthPlane ?? true,
      context,
      scene: {
        _frameState: { useLogDepth: overrides.logDepth ?? true },
      },
    };
  }

  it("reuses an exact identity and replaces it across device generation", async function () {
    const deviceA = createDevice("deviceA");
    const deviceB = createDevice("deviceB");
    const host = { _depthPlane: null };
    const config = createConfig(deviceA, { resourceGeneration: 3 });

    ensureDepthPlane(host, config);
    const planeA = host._depthPlane;
    expect(planeA.isForDevice(deviceA.device)).toBe(true);
    expect(deviceA.descriptors.length).toBe(2);
    expect(deviceA.descriptors[0].fragment.targets.length).toBe(2);
    expect(deviceA.descriptors[1].fragment.targets).toEqual([
      { format: "rgba8unorm", writeMask: 0 },
    ]);

    ensureDepthPlane(host, config);
    expect(host._depthPlane).toBe(planeA);
    expect(deviceA.device.createBuffer.calls.count()).toBe(2);

    const renderTargetGeneration =
      config.context._scenePipelineFormatGeneration;
    config.context._device = deviceB.device;
    config.context.webgpuPipelineCache = deviceB.pipelineCache;
    config.context._deviceResourceGeneration++;
    ensureDepthPlane(host, config);

    expect(planeA.isDestroyed).toBe(true);
    expect(host._depthPlane).not.toBe(planeA);
    expect(host._depthPlane.isForDevice(deviceB.device)).toBe(true);
    expect(config.context._deviceResourceGeneration).toBe(4);
    expect(config.context._scenePipelineFormatGeneration).toBe(
      renderTargetGeneration,
    );
    expect(deviceB.descriptors.length).toBe(2);
    expect(deviceA.device.createBuffer.calls.count()).toBe(2);
    await Promise.resolve();
    host._depthPlane.destroy();
  });

  it("rebuilds for log-depth and exact attachment identity changes", function () {
    const harness = createDevice("device");
    const host = { _depthPlane: null };
    const config = createConfig(harness);

    ensureDepthPlane(host, config);
    const first = host._depthPlane;
    config.context._logDepthWriteEnabled = false;
    config.scene._frameState.useLogDepth = false;
    ensureDepthPlane(host, config);
    const second = host._depthPlane;
    expect(first.isDestroyed).toBe(true);
    expect(second).not.toBe(first);

    config.context.scenePipelineFormat = "bgra8unorm";
    config.context.pickPipelineFormat = "bgra8unorm";
    config.context._msaaSamples = 1;
    ensureDepthPlane(host, config);
    expect(second.isDestroyed).toBe(true);
    expect(host._depthPlane).not.toBe(second);
    expect(host._depthPlane._colorFormat).toBe("bgra8unorm");
    expect(host._depthPlane._pickColorFormat).toBe("bgra8unorm");
    expect(host._depthPlane._sampleCount).toBe(1);
    host._depthPlane.destroy();
  });

  it("does no work when the depth plane is not requested", function () {
    const harness = createDevice("device");
    const host = { _depthPlane: null };
    const config = createConfig(harness, { useDepthPlane: false });

    ensureDepthPlane(host, config);
    expect(host._depthPlane).toBeNull();
    expect(harness.device.createShaderModule).not.toHaveBeenCalled();
    expect(harness.pipelineCache.getPipeline).not.toHaveBeenCalled();
  });

  it("does not publish a partially initialized replacement", function () {
    const harness = createDevice("failingDevice");
    harness.device.createShaderModule.and.throwError("synthetic init failure");
    const host = { _depthPlane: null };
    const config = createConfig(harness);

    expect(() => ensureDepthPlane(host, config)).toThrowError(
      "synthetic init failure",
    );
    expect(host._depthPlane).toBeNull();
  });
});
