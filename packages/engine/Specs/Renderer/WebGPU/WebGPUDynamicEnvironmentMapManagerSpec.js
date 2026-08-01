import {
  getRenderableSceneCaptureSourceRevision,
  hasRenderableSceneCaptureSources,
  runSceneCapture,
  SceneCaptureResult,
} from "../../../Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.js";
import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import {
  getOrCreateDynamicEnvironmentKernelPack,
  resetDynamicEnvironmentKernelPacksForSpecs,
  resolveSceneCaptureMode,
  shouldRefreshSceneCapture,
  shouldResetSceneCaptureHistory,
  updateSceneCaptureAttemptBookkeeping,
  updateSceneCaptureBookkeeping,
} from "../../../Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.js";
import { publishWebGPUSceneCaptureSources } from "../../../Source/Scene/GlobeSurfaceTileProviderRendering.js";
import {
  createIrradiancePipeline,
  createRadianceHQPipeline,
  createRadiancePipeline,
  generateIBLMaps,
} from "../../../Source/Renderer/WebGPU/WebGPUIBLPipeline.js";

describe("Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager", function () {
  it("shares immutable kernels by device generation and storage format", function () {
    resetDynamicEnvironmentKernelPacksForSpecs();

    const counts = {
      bindGroupLayouts: 0,
      pipelineLayouts: 0,
      shaderModules: 0,
      computePipelines: 0,
    };
    const device = {
      createBindGroupLayout(descriptor) {
        counts.bindGroupLayouts++;
        return { descriptor };
      },
      createPipelineLayout(descriptor) {
        counts.pipelineLayouts++;
        return { descriptor };
      },
      createShaderModule(descriptor) {
        counts.shaderModules++;
        return { descriptor };
      },
      createComputePipeline(descriptor) {
        counts.computePipelines++;
        return { descriptor };
      },
    };

    const first = getOrCreateDynamicEnvironmentKernelPack(
      device,
      1,
      "rgba8unorm",
    );
    const second = getOrCreateDynamicEnvironmentKernelPack(
      device,
      1,
      "rgba8unorm",
    );

    expect(second).toBe(first);
    expect(counts).toEqual({
      bindGroupLayouts: 2,
      pipelineLayouts: 2,
      shaderModules: 2,
      computePipelines: 2,
    });

    const hdr = getOrCreateDynamicEnvironmentKernelPack(
      device,
      1,
      "rgba16float",
    );
    expect(hdr.skyPipeline).not.toBe(first.skyPipeline);
    expect(hdr.shPipeline).toBe(first.shPipeline);
    expect(counts).toEqual({
      bindGroupLayouts: 3,
      pipelineLayouts: 3,
      shaderModules: 3,
      computePipelines: 3,
    });

    const recovered = getOrCreateDynamicEnvironmentKernelPack(
      device,
      2,
      "rgba8unorm",
    );
    expect(recovered.skyPipeline).not.toBe(first.skyPipeline);
    expect(recovered.shPipeline).not.toBe(first.shPipeline);
    expect(counts).toEqual({
      bindGroupLayouts: 5,
      pipelineLayouts: 5,
      shaderModules: 5,
      computePipelines: 5,
    });

    resetDynamicEnvironmentKernelPacksForSpecs();
  });

  it("shares IBL convolution kernels across manager caches", function () {
    const counts = {
      bindGroupLayouts: 0,
      pipelineLayouts: 0,
      shaderModules: 0,
      computePipelines: 0,
    };
    const device = {
      createBindGroupLayout(descriptor) {
        counts.bindGroupLayouts++;
        return { descriptor };
      },
      createPipelineLayout(descriptor) {
        counts.pipelineLayouts++;
        return { descriptor };
      },
      createShaderModule(descriptor) {
        counts.shaderModules++;
        return { descriptor };
      },
      createComputePipeline(descriptor) {
        counts.computePipelines++;
        return { descriptor };
      },
    };

    const first = [
      createIrradiancePipeline(device, null),
      createRadiancePipeline(device, null),
      createRadianceHQPipeline(device, null),
    ];
    const second = [
      createIrradiancePipeline(device, null),
      createRadiancePipeline(device, null),
      createRadianceHQPipeline(device, null),
    ];

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(counts).toEqual({
      bindGroupLayouts: 3,
      pipelineLayouts: 3,
      shaderModules: 3,
      computePipelines: 3,
    });
  });

  it("packs a standalone HQ IBL refresh into one immutable upload and submission", function () {
    const parameterBuffers = [];
    const bindGroupDescriptors = [];
    let uploadedBytes;
    const finish = jasmine.createSpy("finish").and.returnValue({});
    const submit = jasmine.createSpy("submit");
    const writeBuffer = jasmine
      .createSpy("writeBuffer")
      .and.callFake(function (_buffer, _offset, data, dataOffset, size) {
        uploadedBytes = data.slice(dataOffset, dataOffset + size);
      });
    const computePass = {
      setPipeline() {},
      setBindGroup() {},
      dispatchWorkgroups() {},
      end() {},
    };
    const encoder = {
      beginComputePass() {
        return computePass;
      },
      finish,
    };
    const createCommandEncoder = jasmine
      .createSpy("createCommandEncoder")
      .and.returnValue(encoder);
    const device = {
      limits: { minUniformBufferOffsetAlignment: 256 },
      createCommandEncoder,
      createBuffer(descriptor) {
        const buffer = {
          descriptor,
          destroy: jasmine.createSpy("destroy"),
        };
        parameterBuffers.push(buffer);
        return buffer;
      },
      createTexture(descriptor) {
        return {
          descriptor,
          width: descriptor.size.width,
          mipLevelCount: descriptor.mipLevelCount ?? 1,
          createView() {
            return {};
          },
          destroy() {},
        };
      },
      createBindGroup(descriptor) {
        bindGroupDescriptors.push(descriptor);
        return { descriptor };
      },
      queue: { writeBuffer, submit },
    };
    const cache = {
      irradianceTexture: null,
      irradianceView: null,
      radianceTexture: null,
      radianceView: null,
      irradiancePipeline: {},
      radiancePipeline: {},
      irradianceBGL: {},
      radianceBGL: {},
      sampler: {},
      sourceVersion: -1,
      radianceHQPipeline: {},
      radianceHQBGL: {},
      mipDownsamplePipeline: {},
      mipDownsampleBGL: {},
      mipDownsampleFormat: "rgba8unorm",
    };
    const sourceCube = {
      width: 64,
      mipLevelCount: 4,
      createView() {
        return {};
      },
    };

    generateIBLMaps(device, cache, {}, null, {
      quality: "high",
      sourceCube,
      sourceFormat: "rgba8unorm",
    });

    // 6 irradiance + 3 source mips + 6 faces × 6 radiance mips.
    const dispatchCount = 45;
    const alignment = 256;
    expect(createCommandEncoder).toHaveBeenCalledTimes(1);
    expect(parameterBuffers.length).toBe(1);
    expect(parameterBuffers[0].descriptor.size).toBe(dispatchCount * alignment);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(uploadedBytes.byteLength).toBe(dispatchCount * alignment);
    expect(finish).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(parameterBuffers[0].destroy).toHaveBeenCalledTimes(1);

    expect(bindGroupDescriptors.length).toBe(dispatchCount);
    const parameterBindings = bindGroupDescriptors.map(
      (descriptor) => descriptor.entries[3].resource,
    );
    expect(
      parameterBindings.every(
        (binding) => binding.buffer === parameterBuffers[0],
      ),
    ).toBeTrue();
    expect(parameterBindings.map((binding) => binding.offset)).toEqual(
      Array.from({ length: dispatchCount }, (_unused, i) => i * alignment),
    );
    expect(
      parameterBindings.every((binding) => binding.size === 16),
    ).toBeTrue();

    // The single late upload retains each dispatch's original bytes rather
    // than aliasing every binding to the final face/mip values.
    const words = new Uint32Array(uploadedBytes);
    const readSlot = (slot) =>
      Array.from(
        words.slice((slot * alignment) / 4, (slot * alignment) / 4 + 4),
      );
    for (let face = 0; face < 6; face++) {
      expect(readSlot(face)).toEqual([face, 32, 0, 0]);
    }
    expect(readSlot(6)).toEqual([32, 0, 0, 0]);
    expect(readSlot(7)).toEqual([16, 0, 0, 0]);
    expect(readSlot(8)).toEqual([8, 0, 0, 0]);
    expect(readSlot(9)).toEqual([0, 0, 6, 128]);
    expect(readSlot(44)).toEqual([5, 5, 6, 4]);
  });

  it("builds all six model faces from one capture eye", function () {
    const eye = new Cartesian3(6378137.0, 125.0, -250.0);
    const activePosition = new Cartesian3();
    const activeDirection = new Cartesian3();
    const captureCalls = [];
    const uniformState = {
      cameraPosition: activePosition,
      updateCamera(camera) {
        if (camera.positionWC) {
          Cartesian3.clone(camera.positionWC, activePosition);
        }
        if (camera.directionWC) {
          Cartesian3.clone(camera.directionWC, activeDirection);
        }
      },
    };
    const buildCaptureCommands = jasmine
      .createSpy("buildCaptureCommands")
      .and.callFake(function (_entry, _device, _frameState, _format, face) {
        captureCalls.push({
          face,
          position: Cartesian3.clone(activePosition),
          direction: Cartesian3.clone(activeDirection),
        });
        return [
          {
            pipeline: {},
            bindGroups: [{}, {}, {}, {}],
            vertexBuffers: [],
            indexBuffer: {},
            indexCount: 3,
            indexFormat: "uint16",
            instanceCount: 1,
          },
        ];
      });
    const pass = {
      setPipeline() {},
      setBindGroup() {},
      setVertexBuffer() {},
      setIndexBuffer() {},
      drawIndexed() {},
      end() {},
    };
    const encoder = {
      beginRenderPass() {
        return pass;
      },
      finish() {
        return {};
      },
    };
    const submit = jasmine.createSpy("submit");
    const flushPendingUniformUploads = jasmine.createSpy(
      "flushPendingUniformUploads",
    );
    const flushPendingImageryMipJobs = jasmine.createSpy(
      "flushPendingImageryMipJobs",
    );
    const createCommandEncoder = jasmine
      .createSpy("createCommandEncoder")
      .and.returnValue(encoder);
    const device = {
      createTexture() {
        return {
          createView() {
            return {};
          },
          destroy() {},
        };
      },
      createCommandEncoder,
      queue: { submit },
    };
    const frameState = {
      frameNumber: 11,
      mode: 3,
      globeVisible: false,
      camera: { positionWC: new Cartesian3(1.0, 2.0, 3.0) },
      context: {
        sceneCaptureReflections: true,
        uniformState,
        flushPendingUniformUploads,
        flushPendingImageryMipJobs,
        _webgpuSceneCaptureModels: {
          frameNumber: 11,
          models: [{}],
          buildCaptureCommands,
        },
      },
    };
    const cache = {
      faceViews: [{}, {}, {}, {}, {}, {}],
      size: 16,
      cubemapFormat: "rgba8unorm",
      captureDepthTexture: null,
      captureDepthView: null,
      captureDepthSize: 0,
    };
    const manager = {
      enableSceneCapture: true,
      _position: eye,
    };

    expect(runSceneCapture(device, cache, manager, frameState, false)).toBe(
      SceneCaptureResult.SUBMITTED,
    );
    expect(buildCaptureCommands).toHaveBeenCalledTimes(6);
    expect(captureCalls.map((call) => call.face)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      captureCalls.every((call) => Cartesian3.equals(call.position, eye)),
    ).toBeTrue();
    expect(
      new Set(
        captureCalls.map((call) =>
          [call.direction.x, call.direction.y, call.direction.z]
            .map((value) => value.toFixed(12))
            .join("|"),
        ),
      ).size,
    ).toBe(6);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(createCommandEncoder).toHaveBeenCalledTimes(1);
    expect(flushPendingUniformUploads).toHaveBeenCalledTimes(1);
    expect(flushPendingImageryMipJobs).toHaveBeenCalledTimes(1);

    // A manager-owned refresh encoder records the same capture without a
    // private encoder or queue submission, while preserving prerequisite
    // uniform/mip flushing before the caller eventually submits it.
    const callerFinish = jasmine.createSpy("callerFinish");
    const callerEncoder = {
      beginRenderPass() {
        return pass;
      },
      finish: callerFinish,
    };
    expect(
      runSceneCapture(device, cache, manager, frameState, false, callerEncoder),
    ).toBe(SceneCaptureResult.SUBMITTED);
    expect(createCommandEncoder).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(callerFinish).not.toHaveBeenCalled();
    expect(flushPendingUniformUploads).toHaveBeenCalledTimes(2);
    expect(flushPendingImageryMipJobs).toHaveBeenCalledTimes(2);
  });

  it("reports a first/recovered-frame capture miss before globe publication", function () {
    const manager = {
      enableSceneCapture: true,
      _position: { x: 1.0, y: 2.0, z: 3.0 },
    };
    const frameState = {
      frameNumber: 12,
      afterRender: [],
      mode: 3,
      globeVisible: true,
      camera: {},
      context: {
        sceneCaptureReflections: true,
        _webgpuSceneCaptureSources: null,
      },
    };

    expect(runSceneCapture({}, {}, manager, frameState)).toBe(
      SceneCaptureResult.FAILED,
    );
    expect(hasRenderableSceneCaptureSources(frameState)).toBeFalse();
    expect(getRenderableSceneCaptureSourceRevision(frameState)).toBe(-1);

    const globeRenderer = {};
    const tileProvider = {
      _quadtree: {
        _tilesToRender: [],
      },
    };
    publishWebGPUSceneCaptureSources(
      frameState.context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    expect(hasRenderableSceneCaptureSources(frameState)).toBeFalse();
    expect(getRenderableSceneCaptureSourceRevision(frameState)).toBe(-1);
    expect(frameState.afterRender.length).toBe(1);
    expect(frameState.afterRender[0]()).toBeTrue();

    tileProvider._quadtree._tilesToRender.push({});
    expect(hasRenderableSceneCaptureSources(frameState)).toBeTrue();
    expect(getRenderableSceneCaptureSourceRevision(frameState)).toBe(1);
  });

  it("wakes a delayed publication once and reuses its source record", function () {
    const context = {};
    const globeRenderer = {};
    const tileProvider = {
      _quadtree: {
        _tilesToRender: [{}],
      },
    };
    const frameState = {
      frameNumber: 20,
      afterRender: [],
      context,
    };

    publishWebGPUSceneCaptureSources(
      context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    const sources = context._webgpuSceneCaptureSources;
    expect(frameState.afterRender.length).toBe(1);
    expect(hasRenderableSceneCaptureSources(frameState)).toBeTrue();
    expect(sources.publicationRevision).toBe(1);

    frameState.frameNumber = 21;
    frameState.afterRender = [];
    expect(hasRenderableSceneCaptureSources(frameState)).toBeTrue();
    publishWebGPUSceneCaptureSources(
      context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    expect(context._webgpuSceneCaptureSources).toBe(sources);
    expect(frameState.afterRender.length).toBe(0);
    expect(sources.publicationRevision).toBe(1);

    frameState.frameNumber = 23;
    frameState.afterRender = [];
    expect(hasRenderableSceneCaptureSources(frameState)).toBeFalse();
    publishWebGPUSceneCaptureSources(
      context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    expect(context._webgpuSceneCaptureSources).toBe(sources);
    expect(frameState.afterRender.length).toBe(1);
    expect(sources.publicationRevision).toBe(2);
  });

  it("does not advance capture debounce state after a missed submission", function () {
    const cache = {
      framesSinceCapture: 5,
      lastCaptureCameraX: Number.NaN,
      lastCaptureCameraY: Number.NaN,
      lastCaptureCameraZ: Number.NaN,
      lastCaptureSourceRevision: -1,
    };

    expect(
      updateSceneCaptureBookkeeping(
        cache,
        { x: 10.0, y: 20.0, z: 30.0 },
        false,
        4,
      ),
    ).toBeUndefined();
    expect(cache.framesSinceCapture).toBe(5);
    expect(cache.lastCaptureCameraX).toBeNaN();
    expect(cache.lastCaptureCameraY).toBeNaN();
    expect(cache.lastCaptureCameraZ).toBeNaN();
    expect(cache.lastCaptureSourceRevision).toBe(-1);
  });

  it("forces the one producer follow-up when publication resumes", function () {
    const cache = {
      framesSinceCaptureAttempt: 2,
      lastCaptureAttemptCameraX: 10.0,
      lastCaptureAttemptCameraY: 20.0,
      lastCaptureAttemptCameraZ: 30.0,
      lastCaptureAttemptSourceRevision: 4,
    };
    const stationaryPosition = { x: 10.0, y: 20.0, z: 30.0 };

    expect(
      shouldRefreshSceneCapture(cache, stationaryPosition, -1),
    ).toBeFalse();
    expect(shouldRefreshSceneCapture(cache, stationaryPosition, 4)).toBeFalse();
    expect(shouldRefreshSceneCapture(cache, stationaryPosition, 5)).toBeTrue();
  });

  it("commits debounce state only after a real capture submission", function () {
    const cache = {
      framesSinceCapture: 8,
      lastCaptureCameraX: Number.NaN,
      lastCaptureCameraY: Number.NaN,
      lastCaptureCameraZ: Number.NaN,
      lastCaptureSourceRevision: -1,
    };

    expect(
      updateSceneCaptureBookkeeping(
        cache,
        { x: 10.0, y: 20.0, z: 30.0 },
        true,
        7,
      ),
    ).toBeUndefined();
    expect(cache.framesSinceCapture).toBe(0);
    expect(cache.lastCaptureCameraX).toBe(10.0);
    expect(cache.lastCaptureCameraY).toBe(20.0);
    expect(cache.lastCaptureCameraZ).toBe(30.0);
    expect(cache.lastCaptureSourceRevision).toBe(7);
  });

  it("rejects a retained globe source while hidden and wakes once when shown", function () {
    const context = {};
    const globeRenderer = {};
    const tileProvider = {
      _sceneCaptureContentRevision: 1,
      _quadtree: {
        _tilesToRender: [{}],
      },
    };
    const frameState = {
      frameNumber: 40,
      afterRender: [],
      globeVisible: true,
      context,
    };

    publishWebGPUSceneCaptureSources(
      context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    expect(getRenderableSceneCaptureSourceRevision(frameState)).toBe(1);

    frameState.frameNumber = 41;
    frameState.afterRender = [];
    frameState.globeVisible = false;
    expect(hasRenderableSceneCaptureSources(frameState)).toBeFalse();
    expect(getRenderableSceneCaptureSourceRevision(frameState)).toBe(-1);

    frameState.frameNumber = 42;
    frameState.afterRender = [];
    frameState.globeVisible = true;
    expect(hasRenderableSceneCaptureSources(frameState)).toBeFalse();
    publishWebGPUSceneCaptureSources(
      context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    expect(context._webgpuSceneCaptureSources.publicationRevision).toBe(2);
    expect(frameState.afterRender.length).toBe(1);
  });

  it("advances publication on stable-provider content changes only", function () {
    const context = {};
    const globeRenderer = {};
    const tileProvider = {
      _sceneCaptureContentRevision: 7,
      _quadtree: {
        _tilesToRender: [{}],
      },
    };
    const frameState = {
      frameNumber: 50,
      afterRender: [],
      globeVisible: true,
      context,
    };

    publishWebGPUSceneCaptureSources(
      context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    expect(context._webgpuSceneCaptureSources.publicationRevision).toBe(1);

    const publishedSources = context._webgpuSceneCaptureSources;
    let sameFrameWrites = 0;
    context._webgpuSceneCaptureSources = new Proxy(publishedSources, {
      set(target, property, value) {
        sameFrameWrites++;
        return Reflect.set(target, property, value);
      },
    });
    frameState.afterRender = [];
    publishWebGPUSceneCaptureSources(
      context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    expect(sameFrameWrites).toBe(0);
    expect(frameState.afterRender.length).toBe(0);

    frameState.frameNumber = 51;
    frameState.afterRender = [];
    publishWebGPUSceneCaptureSources(
      context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    expect(context._webgpuSceneCaptureSources.publicationRevision).toBe(1);
    expect(frameState.afterRender.length).toBe(0);

    tileProvider._sceneCaptureContentRevision++;
    frameState.frameNumber = 52;
    frameState.afterRender = [];
    expect(hasRenderableSceneCaptureSources(frameState)).toBeFalse();
    publishWebGPUSceneCaptureSources(
      context,
      globeRenderer,
      tileProvider,
      frameState,
    );
    expect(context._webgpuSceneCaptureSources.publicationRevision).toBe(2);
    expect(frameState.afterRender.length).toBe(1);
  });

  it("does not submit or report success for a zero-command globe replay", function () {
    const submit = jasmine.createSpy("submit");
    const getOrCreateCaptureTileCommands = jasmine
      .createSpy("getOrCreateCaptureTileCommands")
      .and.returnValue([]);
    const manager = {
      enableSceneCapture: true,
      _position: { x: 6378137.0, y: 0.0, z: 0.0 },
    };
    const frameState = {
      frameNumber: 60,
      mode: 3,
      globeVisible: true,
      camera: {},
      context: {
        sceneCaptureReflections: true,
        uniformState: {
          updateCamera: jasmine.createSpy("updateCamera"),
        },
        _webgpuSceneCaptureSources: {
          frameNumber: 59,
          publicationRevision: 3,
          contentRevision: 2,
          globeRenderer: {
            getOrCreateCaptureTileCommands,
          },
          tileProvider: {
            _sceneCaptureContentRevision: 2,
            _quadtree: {
              _tilesToRender: [{ data: {} }],
            },
          },
        },
      },
    };
    const cache = {
      faceViews: [{}, {}, {}, {}, {}, {}],
      size: 16,
      cubemapFormat: "rgba8unorm",
      captureDepthTexture: null,
      captureDepthView: null,
      captureDepthSize: 0,
    };
    const device = {
      queue: { submit },
    };

    expect(runSceneCapture(device, cache, manager, frameState, true)).toBe(
      SceneCaptureResult.FAILED,
    );
    expect(submit).not.toHaveBeenCalled();
    expect(cache.captureDepthTexture).toBeNull();
    expect(getOrCreateCaptureTileCommands).toHaveBeenCalledTimes(6);
  });

  it("treats a hidden globe with no models as a deliberate sky-only state", function () {
    const frameState = {
      frameNumber: 70,
      mode: 3,
      globeVisible: false,
      camera: {},
      context: {
        sceneCaptureReflections: true,
        _webgpuSceneCaptureModels: null,
      },
    };
    const manager = {
      enableSceneCapture: true,
      _position: { x: 1.0, y: 2.0, z: 3.0 },
    };

    expect(runSceneCapture({}, {}, manager, frameState, false)).toBe(
      SceneCaptureResult.SKY_ONLY,
    );
  });

  it("separates attempt throttling from successful debounce", function () {
    const cache = {
      framesSinceCaptureAttempt: 8,
      lastCaptureAttemptCameraX: Number.NaN,
      lastCaptureAttemptCameraY: Number.NaN,
      lastCaptureAttemptCameraZ: Number.NaN,
      lastCaptureAttemptSourceRevision: -1,
      framesSinceCapture: 8,
      lastCaptureCameraX: Number.NaN,
      lastCaptureCameraY: Number.NaN,
      lastCaptureCameraZ: Number.NaN,
      lastCaptureSourceRevision: -1,
    };
    const position = { x: 10.0, y: 20.0, z: 30.0 };

    updateSceneCaptureAttemptBookkeeping(cache, position, 4);
    updateSceneCaptureBookkeeping(cache, position, false, 4);

    expect(cache.framesSinceCaptureAttempt).toBe(0);
    expect(cache.lastCaptureAttemptSourceRevision).toBe(4);
    expect(cache.framesSinceCapture).toBe(8);
    expect(cache.lastCaptureSourceRevision).toBe(-1);
    expect(shouldRefreshSceneCapture(cache, position, 4)).toBeFalse();
  });

  it("resets temporal history on opt-out, provider revision, or failed replay", function () {
    expect(resolveSceneCaptureMode(true, true)).toBe(2);
    expect(resolveSceneCaptureMode(true, false)).toBe(1);
    expect(resolveSceneCaptureMode(false, true)).toBe(0);

    const cache = {
      lastSceneCaptureMode: 2,
      lastSceneCaptureSourceRevision: 7,
      lastSceneCaptureResult: SceneCaptureResult.SUBMITTED,
    };
    expect(
      shouldResetSceneCaptureHistory(cache, 2, 7, SceneCaptureResult.SUBMITTED),
    ).toBeFalse();
    expect(
      shouldResetSceneCaptureHistory(cache, 2, 8, SceneCaptureResult.SUBMITTED),
    ).toBeTrue();
    expect(
      shouldResetSceneCaptureHistory(cache, 0, -1, SceneCaptureResult.SKY_ONLY),
    ).toBeTrue();
    expect(
      shouldResetSceneCaptureHistory(cache, 2, 7, SceneCaptureResult.FAILED),
    ).toBeTrue();
  });
});
