import {
  getRenderableSceneCaptureSourceRevision,
  hasRenderableSceneCaptureSources,
  runSceneCapture,
  SceneCaptureResult,
} from "../../../Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapCapture.js";
import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import {
  destroyWebGPUDynamicEnvironmentMapResources,
  getOrCreateDynamicIBLPipelineCache,
  getOrCreateDynamicEnvironmentKernelPack,
  isDynamicEnvironmentCacheCurrent,
  preflightWebGPUDynamicEnvironmentMap,
  resetDynamicEnvironmentKernelPacksForSpecs,
  resolveSceneCaptureMode,
  shouldRefreshSceneCapture,
  shouldResetSceneCaptureHistory,
  updateWebGPUDynamicEnvironmentMap,
  updateSceneCaptureAttemptBookkeeping,
  updateSceneCaptureBookkeeping,
} from "../../../Source/Renderer/WebGPU/WebGPUDynamicEnvironmentMapManager.js";
import { publishWebGPUSceneCaptureSources } from "../../../Source/Scene/GlobeSurfaceTileProviderRendering.js";
import {
  createIBLCommandEncodingScope,
  createIrradiancePipeline,
  createRadianceHQPipeline,
  createRadiancePipeline,
  destroyIBLCommandEncodingScope,
  getOrCreateIBLPersistentParameterArena,
  generateIBLMaps,
  resetIBLDeviceKernelPacksForSpecs,
  submitIBLCommandEncodingScope,
} from "../../../Source/Renderer/WebGPU/WebGPUIBLPipeline.js";

function createFrameOwnedDynamicRefreshHarness() {
  const textures = [];
  const buffers = [];
  const parameterHandles = [];
  const scheduledTextureDestroys = [];
  const encoderCallbacks = new Map();
  let encoderSerial = 0;
  let failPassCountdown = null;

  const makeComputePass = function () {
    return {
      setPipeline() {},
      setBindGroup() {},
      dispatchWorkgroups() {},
      end() {},
    };
  };
  const makeEncoder = function () {
    const encoder = {
      id: ++encoderSerial,
      beginComputePass() {
        if (failPassCountdown !== null) {
          if (failPassCountdown === 0) {
            failPassCountdown = null;
            throw new Error("injected late compute-pass failure");
          }
          failPassCountdown--;
        }
        return makeComputePass();
      },
      copyTextureToTexture() {},
      finish: jasmine
        .createSpy(`frameFinish${encoderSerial}`)
        .and.returnValue({}),
    };
    return encoder;
  };

  const privateEncoder = makeEncoder();
  const createCommandEncoder = jasmine
    .createSpy("createCommandEncoder")
    .and.returnValue(privateEncoder);
  const writeBuffer = jasmine.createSpy("writeBuffer");
  const submit = jasmine.createSpy("submit");
  const device = {
    limits: { minUniformBufferOffsetAlignment: 256 },
    createCommandEncoder,
    createTexture(descriptor) {
      const size = descriptor.size;
      const width =
        typeof size === "number"
          ? size
          : Array.isArray(size)
            ? size[0]
            : size.width;
      const texture = {
        descriptor,
        width,
        mipLevelCount: descriptor.mipLevelCount ?? 1,
        createView(viewDescriptor) {
          return { texture, descriptor: viewDescriptor };
        },
        destroy: jasmine.createSpy(`destroyTexture${textures.length}`),
      };
      textures.push(texture);
      return texture;
    },
    createBuffer(descriptor) {
      const buffer = {
        descriptor,
        destroy: jasmine.createSpy(`destroyBuffer${buffers.length}`),
      };
      buffers.push(buffer);
      return buffer;
    },
    createSampler(descriptor) {
      return { descriptor };
    },
    createBindGroupLayout(descriptor) {
      return { descriptor };
    },
    createPipelineLayout(descriptor) {
      return { descriptor };
    },
    createShaderModule(descriptor) {
      return { descriptor };
    },
    createComputePipeline(descriptor) {
      return { descriptor };
    },
    createBindGroup(descriptor) {
      return { descriptor };
    },
    queue: {
      writeBuffer,
      writeTexture: jasmine.createSpy("writeTexture"),
      submit,
    },
  };
  const pool = {
    acquireParameterBuffer: jasmine
      .createSpy("acquireParameterBuffer")
      .and.callFake(function (_byteLength, label) {
        const handle = {
          label,
          buffer: {
            label,
            destroy: jasmine.createSpy(
              `destroyParameterBuffer${parameterHandles.length}`,
            ),
          },
        };
        parameterHandles.push(handle);
        return handle;
      }),
    releaseParameterBuffer: jasmine.createSpy("releaseParameterBuffer"),
  };
  const noteEnvironmentRefreshSubmitted = jasmine.createSpy(
    "noteEnvironmentRefreshSubmitted",
  );
  const scheduleEnvironmentRefresh = jasmine
    .createSpy("scheduleEnvironmentRefresh")
    .and.returnValue("grant");
  let frameEncoder = makeEncoder();
  const context = {
    device,
    resourceGeneration: 1,
    currentCommandEncoder: frameEncoder,
    _currentCommandEncoder: frameEncoder,
    uniformState: {
      sunDirectionWC: { x: 0.3, y: 0.0, z: 0.95 },
    },
    scheduleEnvironmentRefresh,
    noteEnvironmentRefreshSubmitted,
    getEnvironmentTargetPool() {
      return pool;
    },
    scheduleTextureDestroy: jasmine
      .createSpy("scheduleTextureDestroy")
      .and.callFake(function (texture) {
        scheduledTextureDestroys.push(texture);
      }),
    enqueueAfterCommandEncoderSubmit: jasmine
      .createSpy("enqueueAfterCommandEncoderSubmit")
      .and.callFake(function (encoder, callback) {
        if (encoder !== context.currentCommandEncoder) {
          return false;
        }
        const callbacks = encoderCallbacks.get(encoder) ?? [];
        callbacks.push(callback);
        encoderCallbacks.set(encoder, callbacks);
        return true;
      }),
  };
  const frameState = {
    context,
    mode: 3,
    globeVisible: true,
    afterRender: [],
    frameNumber: 1,
    sunDirectionWC: context.uniformState.sunDirectionWC,
  };
  const createManager = function () {
    return {
      _mipmapLevels: 1,
      enabled: true,
      shouldUpdate: true,
      _position: new Cartesian3(6378137.0, 0.0, 0.0),
      _shouldRegenerateShaders: false,
      _cubemapSize: 16,
      _radianceMap: null,
    };
  };

  return {
    context,
    device,
    frameState,
    pool,
    textures,
    scheduledTextureDestroys,
    parameterHandles,
    createCommandEncoder,
    writeBuffer,
    submit,
    scheduleEnvironmentRefresh,
    noteEnvironmentRefreshSubmitted,
    createManager,
    callbacksFor(encoder = frameEncoder) {
      return encoderCallbacks.get(encoder) ?? [];
    },
    settle(encoder = frameEncoder, submitted = true) {
      const callbacks = encoderCallbacks.get(encoder) ?? [];
      encoderCallbacks.delete(encoder);
      for (const callback of callbacks) {
        callback(submitted);
      }
    },
    nextFrame() {
      frameEncoder = makeEncoder();
      context.currentCommandEncoder = frameEncoder;
      context._currentCommandEncoder = frameEncoder;
      frameState.afterRender = [];
      frameState.frameNumber++;
      return frameEncoder;
    },
    currentEncoder() {
      return frameEncoder;
    },
    failAfterComputePasses(count) {
      failPassCountdown = count;
    },
  };
}

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
    resetIBLDeviceKernelPacksForSpecs();
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
      createIrradiancePipeline(device, null, 1),
      createRadiancePipeline(device, null, 1),
      createRadianceHQPipeline(device, null, 1),
    ];
    const second = [
      createIrradiancePipeline(device, null, 1),
      createRadiancePipeline(device, null, 1),
      createRadianceHQPipeline(device, null, 1),
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

    const recovered = createIrradiancePipeline(device, null, 2);
    expect(recovered).not.toBe(first[0]);
    expect(counts).toEqual({
      bindGroupLayouts: 4,
      pipelineLayouts: 4,
      shaderModules: 4,
      computePipelines: 4,
    });
    resetIBLDeviceKernelPacksForSpecs();
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
          destroy: jasmine.createSpy("destroy"),
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

    // An authored/explicit source does not opt into the dynamic-output policy.
    // Its historical replace-on-refresh lifecycle remains unchanged.
    const firstIrradiance = cache.irradianceTexture;
    const firstRadiance = cache.radianceTexture;
    generateIBLMaps(device, cache, {}, null, {
      quality: "high",
      sourceCube,
      sourceFormat: "rgba8unorm",
    });
    expect(cache.irradianceTexture).not.toBe(firstIrradiance);
    expect(cache.radianceTexture).not.toBe(firstRadiance);
    expect(firstIrradiance.destroy).toHaveBeenCalledTimes(1);
    expect(firstRadiance.destroy).toHaveBeenCalledTimes(1);
  });

  it("retains dynamic IBL outputs and bind state until ownership topology changes", function () {
    const textures = [];
    const bindGroups = [];
    const dispatchWorkgroups = jasmine.createSpy("dispatchWorkgroups");
    let failNextWrite = false;
    let failNextSubmit = false;
    let failNextEncoder = false;
    const writeBuffer = jasmine
      .createSpy("writeBuffer")
      .and.callFake(function () {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("injected write failure");
        }
      });
    const submit = jasmine.createSpy("submit").and.callFake(function () {
      if (failNextSubmit) {
        failNextSubmit = false;
        throw new Error("injected submit failure");
      }
    });
    let failNextView = false;
    const device = {
      limits: { minUniformBufferOffsetAlignment: 256 },
      createTexture(descriptor) {
        const texture = {
          descriptor,
          destroy: jasmine.createSpy("destroy"),
          createView(viewDescriptor) {
            if (failNextView) {
              failNextView = false;
              throw new Error("injected view failure");
            }
            return { texture, descriptor: viewDescriptor };
          },
        };
        textures.push(texture);
        return texture;
      },
      createBuffer() {
        return { destroy: jasmine.createSpy("destroy") };
      },
      createCommandEncoder() {
        if (failNextEncoder) {
          failNextEncoder = false;
          throw new Error("injected encoder failure");
        }
        return {
          beginComputePass() {
            return {
              setPipeline() {},
              setBindGroup() {},
              dispatchWorkgroups,
              end() {},
            };
          },
          finish() {
            return {};
          },
        };
      },
      createBindGroup(descriptor) {
        const group = { descriptor };
        bindGroups.push(group);
        return group;
      },
      queue: { writeBuffer, submit },
    };
    const pool = {
      acquireParameterBuffer: jasmine
        .createSpy("acquireParameterBuffer")
        .and.callFake(function () {
          return { buffer: { destroy: jasmine.createSpy("destroy") } };
        }),
      releaseParameterBuffer: jasmine.createSpy("releaseParameterBuffer"),
    };
    const contextA = {};
    const contextB = {};
    const ownerA = {
      context: contextA,
      device,
      resourceGeneration: 7,
      size: 256,
      mipmapLevels: 4,
      cubemapFormat: "rgba8unorm",
      iblCache: null,
    };
    const ownerB = {
      context: contextB,
      device,
      resourceGeneration: 7,
      size: 256,
      mipmapLevels: 4,
      cubemapFormat: "rgba8unorm",
      iblCache: null,
    };
    const cacheA = getOrCreateDynamicIBLPipelineCache(ownerA);
    const cacheB = getOrCreateDynamicIBLPipelineCache(ownerB);
    expect(cacheB).not.toBe(cacheA);
    expect(isDynamicEnvironmentCacheCurrent(ownerA, contextA, device, 7)).toBe(
      true,
    );
    expect(isDynamicEnvironmentCacheCurrent(ownerA, contextB, device, 7)).toBe(
      false,
    );
    expect(isDynamicEnvironmentCacheCurrent(ownerA, contextA, device, 8)).toBe(
      false,
    );

    for (const cache of [cacheA, cacheB]) {
      cache.irradiancePipeline = {};
      cache.radiancePipeline = {};
      cache.irradianceBGL = {};
      cache.radianceBGL = {};
      cache.sampler = {};
    }
    const sourceView = {};
    const encode = function (cache, capacity = 42) {
      const arena = getOrCreateIBLPersistentParameterArena(
        device,
        7,
        cache,
        capacity,
        pool,
        "spec",
      );
      const scope = createIBLCommandEncodingScope(
        device,
        "spec",
        capacity,
        null,
        arena,
      );
      try {
        generateIBLMaps(device, cache, sourceView, null, undefined, scope);
        return scope;
      } catch (error) {
        destroyIBLCommandEncodingScope(scope);
        throw error;
      }
    };
    const refresh = function (cache) {
      const scope = encode(cache);
      try {
        submitIBLCommandEncodingScope(device, scope);
      } finally {
        destroyIBLCommandEncodingScope(scope);
      }
    };

    refresh(cacheA);
    const stable = {
      irradianceTexture: cacheA.irradianceTexture,
      irradianceView: cacheA.irradianceView,
      irradianceStorageView: cacheA.irradianceStorageView,
      radianceTexture: cacheA.radianceTexture,
      radianceView: cacheA.radianceView,
      radianceMipStorageViews: cacheA.radianceMipStorageViews,
      irradianceGroups: cacheA.irradianceBindGroupState.groups,
      radianceGroups: cacheA.radianceBindGroupState.groups,
    };
    refresh(cacheA);
    expect(cacheA.irradianceTexture).toBe(stable.irradianceTexture);
    expect(cacheA.irradianceView).toBe(stable.irradianceView);
    expect(cacheA.irradianceStorageView).toBe(stable.irradianceStorageView);
    expect(cacheA.radianceTexture).toBe(stable.radianceTexture);
    expect(cacheA.radianceView).toBe(stable.radianceView);
    expect(cacheA.radianceMipStorageViews).toBe(stable.radianceMipStorageViews);
    expect(cacheA.irradianceBindGroupState.groups).toBe(
      stable.irradianceGroups,
    );
    expect(cacheA.radianceBindGroupState.groups).toBe(stable.radianceGroups);
    expect(textures.length).toBe(2);
    expect(bindGroups.length).toBe(42);
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenCalledTimes(2);
    expect(dispatchWorkgroups).toHaveBeenCalledTimes(84);

    refresh(cacheB);
    expect(cacheB.irradianceTexture).not.toBe(cacheA.irradianceTexture);
    expect(cacheB.radianceTexture).not.toBe(cacheA.radianceTexture);
    expect(pool.acquireParameterBuffer).toHaveBeenCalledTimes(2);

    cacheA.outputTopologyKey = "512:4:rgba8unorm";
    refresh(cacheA);
    expect(cacheA.irradianceTexture).not.toBe(stable.irradianceTexture);
    expect(cacheA.radianceTexture).not.toBe(stable.radianceTexture);
    expect(stable.irradianceTexture.destroy).toHaveBeenCalledTimes(1);
    expect(stable.radianceTexture.destroy).toHaveBeenCalledTimes(1);

    const retainedIrradiance = cacheA.irradianceTexture;
    const retainedRadiance = cacheA.radianceTexture;
    cacheA.outputTopologyKey = "1024:4:rgba8unorm";
    failNextView = true;
    expect(function () {
      generateIBLMaps(device, cacheA, sourceView);
    }).toThrowError("injected view failure");
    expect(cacheA.irradianceTexture).toBe(retainedIrradiance);
    expect(cacheA.radianceTexture).toBe(retainedRadiance);
    expect(textures[textures.length - 1].destroy).toHaveBeenCalledTimes(1);

    cacheA.outputTopologyKey = "2048:4:rgba8unorm";
    failNextEncoder = true;
    expect(function () {
      generateIBLMaps(device, cacheA, sourceView);
    }).toThrowError("injected encoder failure");
    expect(cacheA.irradianceTexture).toBe(retainedIrradiance);
    expect(cacheA.radianceTexture).toBe(retainedRadiance);
    expect(textures[textures.length - 1].destroy).toHaveBeenCalledTimes(1);
    expect(textures[textures.length - 2].destroy).toHaveBeenCalledTimes(1);

    cacheA.outputTopologyKey = "4096:4:rgba8unorm";
    const writeCandidateStart = textures.length;
    failNextWrite = true;
    expect(function () {
      refresh(cacheA);
    }).toThrowError("injected write failure");
    expect(cacheA.irradianceTexture).toBe(retainedIrradiance);
    expect(cacheA.radianceTexture).toBe(retainedRadiance);
    expect(cacheA.persistentParameterArena.inUse).toBeFalse();
    expect(textures[writeCandidateStart].destroy).toHaveBeenCalledTimes(1);
    expect(textures[writeCandidateStart + 1].destroy).toHaveBeenCalledTimes(1);
    refresh(cacheA);
    expect(cacheA.irradianceTexture).not.toBe(retainedIrradiance);
    expect(cacheA.radianceTexture).not.toBe(retainedRadiance);

    const afterWriteRetryIrradiance = cacheA.irradianceTexture;
    const afterWriteRetryRadiance = cacheA.radianceTexture;
    cacheA.outputTopologyKey = "8192:4:rgba8unorm";
    const submitCandidateStart = textures.length;
    failNextSubmit = true;
    expect(function () {
      refresh(cacheA);
    }).toThrowError("injected submit failure");
    expect(cacheA.irradianceTexture).toBe(afterWriteRetryIrradiance);
    expect(cacheA.radianceTexture).toBe(afterWriteRetryRadiance);
    expect(cacheA.persistentParameterArena.inUse).toBeFalse();
    expect(textures[submitCandidateStart].destroy).toHaveBeenCalledTimes(1);
    expect(textures[submitCandidateStart + 1].destroy).toHaveBeenCalledTimes(1);
    refresh(cacheA);
    expect(cacheA.irradianceTexture).not.toBe(afterWriteRetryIrradiance);
    expect(cacheA.radianceTexture).not.toBe(afterWriteRetryRadiance);

    cacheA.outputTopologyKey = "16384:4:rgba8unorm";
    const beforePendingIrradiance = cacheA.irradianceTexture;
    const beforePendingRadiance = cacheA.radianceTexture;
    const pendingScope = encode(cacheA);
    expect(cacheA.irradianceTexture).toBe(beforePendingIrradiance);
    expect(cacheA.radianceTexture).toBe(beforePendingRadiance);
    expect(function () {
      generateIBLMaps(
        device,
        cacheA,
        sourceView,
        null,
        undefined,
        pendingScope,
      );
    }).toThrowError("Persistent IBL cache already has a pending transaction.");
    destroyIBLCommandEncodingScope(pendingScope);
    expect(cacheA.pendingOutputTransaction).toBeNull();
    expect(cacheA.persistentParameterArena.inUse).toBeFalse();

    const activeArena = cacheA.persistentParameterArena;
    const activeScope = createIBLCommandEncodingScope(
      device,
      "arena upgrade spec",
      42,
      null,
      activeArena,
    );
    expect(function () {
      getOrCreateIBLPersistentParameterArena(
        device,
        7,
        cacheA,
        43,
        pool,
        "arena upgrade spec",
      );
    }).toThrowError(
      "Cannot replace a persistent IBL parameter arena while it is in use.",
    );
    expect(cacheA.persistentParameterArena).toBe(activeArena);
    destroyIBLCommandEncodingScope(activeScope);
  });

  it("borrows the frame encoder and publishes only after exact submission", function () {
    const harness = createFrameOwnedDynamicRefreshHarness();
    const manager = harness.createManager();
    const encoder = harness.currentEncoder();

    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);

    const cache = manager._webgpuCache;
    const arena = cache.iblCache.persistentParameterArena;
    expect(harness.createCommandEncoder).not.toHaveBeenCalled();
    expect(encoder.finish).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.callbacksFor(encoder).length).toBe(1);
    expect(
      harness.writeBuffer.calls
        .allArgs()
        .some((args) => args[0] === arena.parameterBuffer),
    ).toBeTrue();
    expect(arena.inUse).toBeTrue();
    expect(cache.needsUpdate).toBeTrue();
    expect(cache.lastSunDirX).toBeNaN();
    expect(manager._radianceMap).toBeNull();
    expect(manager._webgpuIBLDiffuseView).toBeUndefined();
    expect(harness.noteEnvironmentRefreshSubmitted).not.toHaveBeenCalled();

    harness.settle(encoder, true);

    expect(cache.pendingRefresh).toBeNull();
    expect(arena.inUse).toBeFalse();
    expect(cache.needsUpdate).toBeFalse();
    expect(cache.lastSunDirX).toBe(0.3);
    expect(manager._radianceMap._webgpuTexture).toBe(cache.cubemapTexture);
    expect(manager._webgpuIBLDiffuseView).toBe(cache.iblCache.irradianceView);
    expect(manager._webgpuIBLSpecularView).toBe(cache.iblCache.radianceView);
    expect(manager._webgpuSHBuffer).toBe(cache.shBuffer);
    expect(harness.noteEnvironmentRefreshSubmitted).toHaveBeenCalledTimes(1);
    expect(harness.frameState.afterRender.length).toBe(1);
    expect(harness.frameState.afterRender[0]()).toBeTrue();
  });

  it("preserves the off-frame private submission fallback", function () {
    const harness = createFrameOwnedDynamicRefreshHarness();
    const manager = harness.createManager();
    harness.context.currentCommandEncoder = null;
    harness.context._currentCommandEncoder = null;

    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);

    const cache = manager._webgpuCache;
    const privateEncoder =
      harness.createCommandEncoder.calls.mostRecent().returnValue;
    expect(harness.createCommandEncoder).toHaveBeenCalledTimes(1);
    expect(privateEncoder.finish).toHaveBeenCalledTimes(1);
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(
      harness.context.enqueueAfterCommandEncoderSubmit,
    ).not.toHaveBeenCalled();
    expect(cache.pendingRefresh).toBeNull();
    expect(cache.iblCache.persistentParameterArena.inUse).toBeFalse();
    expect(manager._radianceMap._webgpuTexture).toBe(cache.cubemapTexture);
    expect(manager._webgpuIBLDiffuseView).toBe(cache.iblCache.irradianceView);
    expect(harness.noteEnvironmentRefreshSubmitted).toHaveBeenCalledTimes(1);
  });

  it("rolls back an abandoned frame refresh and retries with the retained arena", function () {
    const harness = createFrameOwnedDynamicRefreshHarness();
    const manager = harness.createManager();
    const firstEncoder = harness.currentEncoder();

    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    const cache = manager._webgpuCache;
    const arena = cache.iblCache.persistentParameterArena;
    const transaction = cache.iblCache.pendingOutputTransaction;
    const candidateIrradiance = transaction.workingCache.irradianceTexture;
    const candidateRadiance = transaction.workingCache.radianceTexture;

    harness.settle(firstEncoder, false);

    expect(candidateIrradiance.destroy).toHaveBeenCalledTimes(1);
    expect(candidateRadiance.destroy).toHaveBeenCalledTimes(1);
    expect(cache.pendingRefresh).toBeNull();
    expect(cache.iblCache.pendingOutputTransaction).toBeNull();
    expect(arena.inUse).toBeFalse();
    expect(cache.needsUpdate).toBeTrue();
    expect(manager._radianceMap).toBeNull();
    expect(harness.noteEnvironmentRefreshSubmitted).not.toHaveBeenCalled();

    const retryEncoder = harness.nextFrame();
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    expect(cache.iblCache.persistentParameterArena).toBe(arena);
    expect(arena.inUse).toBeTrue();
    expect(harness.callbacksFor(retryEncoder).length).toBe(1);
    harness.settle(retryEncoder, true);
    expect(arena.inUse).toBeFalse();
    expect(manager._webgpuIBLDiffuseView).toBe(cache.iblCache.irradianceView);
    expect(harness.noteEnvironmentRefreshSubmitted).toHaveBeenCalledTimes(1);
  });

  it("never exposes a destroyed raw cube while topology publication is pending", function () {
    const harness = createFrameOwnedDynamicRefreshHarness();
    const manager = harness.createManager();
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    harness.settle(harness.currentEncoder(), true);

    const cache = manager._webgpuCache;
    const incumbentCube = cache.cubemapTexture;
    expect(manager._radianceMap._webgpuTexture).toBe(incumbentCube);
    manager._cubemapSize = 32;
    const topologyEncoder = harness.nextFrame();
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);

    expect(incumbentCube.destroy).not.toHaveBeenCalled();
    expect(harness.scheduledTextureDestroys).toContain(incumbentCube);
    expect(manager._radianceMap).toBeNull();
    expect(cache.pendingRefresh).not.toBeNull();
    expect(cache.pendingRefresh.commitState).not.toBeNull();
    harness.settle(topologyEncoder, false);
    expect(manager._radianceMap).toBeNull();
    expect(cache.needsUpdate).toBeTrue();

    const retryEncoder = harness.nextFrame();
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    expect(manager._radianceMap).toBeNull();
    harness.settle(retryEncoder, true);
    expect(manager._radianceMap._webgpuTexture).toBe(cache.cubemapTexture);
    expect(manager._radianceMap._webgpuTexture).not.toBe(incumbentCube);
  });

  it("suppresses duplicate pending grants and fails closed on a late encode error", function () {
    const harness = createFrameOwnedDynamicRefreshHarness();
    const manager = harness.createManager();
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    harness.settle(harness.currentEncoder(), true);
    const cache = manager._webgpuCache;

    const stableEncoder = harness.nextFrame();
    harness.context.uniformState.sunDirectionWC = { x: -0.3, y: 0.0, z: 0.95 };
    harness.frameState.sunDirectionWC =
      harness.context.uniformState.sunDirectionWC;
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    const pending = cache.pendingRefresh;
    const scheduleCount = harness.scheduleEnvironmentRefresh.calls.count();
    const writeCount = harness.writeBuffer.calls.count();
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    expect(cache.pendingRefresh).toBe(pending);
    expect(harness.callbacksFor(stableEncoder).length).toBe(1);
    expect(harness.scheduleEnvironmentRefresh.calls.count()).toBe(
      scheduleCount,
    );
    expect(harness.writeBuffer.calls.count()).toBe(writeCount);
    harness.settle(stableEncoder, true);
    expect(harness.frameState.afterRender.length).toBe(0);

    const failedEncoder = harness.nextFrame();
    harness.context.uniformState.sunDirectionWC = { x: 0.3, y: 0.2, z: 0.9 };
    harness.frameState.sunDirectionWC =
      harness.context.uniformState.sunDirectionWC;
    harness.failAfterComputePasses(5);
    expect(function () {
      updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    }).toThrowError("injected late compute-pass failure");
    expect(cache.pendingRefresh.encodingFailed).toBeTrue();
    expect(cache.iblCache.persistentParameterArena.inUse).toBeTrue();
    expect(manager._radianceMap).toBeNull();
    expect(manager._webgpuIBLDiffuseView).toBeNull();
    expect(cache.historyValid).toBeFalse();
    expect(harness.noteEnvironmentRefreshSubmitted).toHaveBeenCalledTimes(2);

    // Even a submitted disposition cannot publish partially encoded stable
    // outputs; it only releases the retained lease and schedules a clean retry.
    harness.settle(failedEncoder, true);
    expect(cache.pendingRefresh).toBeNull();
    expect(cache.iblCache.persistentParameterArena.inUse).toBeFalse();
    expect(cache.needsUpdate).toBeTrue();
    expect(manager._radianceMap).toBeNull();
    expect(harness.noteEnvironmentRefreshSubmitted).toHaveBeenCalledTimes(2);

    const retryEncoder = harness.nextFrame();
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    harness.settle(retryEncoder, true);
    expect(manager._radianceMap).not.toBeNull();
    expect(harness.noteEnvironmentRefreshSubmitted).toHaveBeenCalledTimes(3);
  });

  it("defers pending cache destruction until the exact encoder settles", function () {
    const harness = createFrameOwnedDynamicRefreshHarness();
    const manager = harness.createManager();
    const encoder = harness.currentEncoder();
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);

    const cache = manager._webgpuCache;
    const arena = cache.iblCache.persistentParameterArena;
    const candidate = cache.iblCache.pendingOutputTransaction.workingCache;
    destroyWebGPUDynamicEnvironmentMapResources(manager);

    expect(manager._webgpuCache).toBeUndefined();
    expect(manager._radianceMap).toBeNull();
    expect(cache.pendingRefresh.retireCacheAfterSettlement).toBeTrue();
    expect(arena.inUse).toBeTrue();
    expect(harness.pool.releaseParameterBuffer).not.toHaveBeenCalled();
    expect(candidate.irradianceTexture.destroy).not.toHaveBeenCalled();
    expect(candidate.radianceTexture.destroy).not.toHaveBeenCalled();

    harness.settle(encoder, true);
    expect(arena.inUse).toBeFalse();
    expect(harness.pool.releaseParameterBuffer).toHaveBeenCalledTimes(1);
    expect(candidate.irradianceTexture.destroy).not.toHaveBeenCalled();
    expect(candidate.radianceTexture.destroy).not.toHaveBeenCalled();
    expect(harness.scheduledTextureDestroys).toContain(
      candidate.irradianceTexture,
    );
    expect(harness.scheduledTextureDestroys).toContain(
      candidate.radianceTexture,
    );
    expect(harness.noteEnvironmentRefreshSubmitted).not.toHaveBeenCalled();
  });

  it("retires old-device outputs when recovery precedes the false drain", function () {
    const harness = createFrameOwnedDynamicRefreshHarness();
    const manager = harness.createManager();
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    harness.settle(harness.currentEncoder(), true);

    const cache = manager._webgpuCache;
    const incumbentCube = cache.cubemapTexture;
    const arena = cache.iblCache.persistentParameterArena;
    const staleEncoder = harness.nextFrame();
    harness.context.uniformState.sunDirectionWC = { x: -0.3, y: 0.0, z: 0.95 };
    harness.frameState.sunDirectionWC =
      harness.context.uniformState.sunDirectionWC;
    updateWebGPUDynamicEnvironmentMap(manager, harness.frameState);
    expect(manager._radianceMap._webgpuTexture).toBe(incumbentCube);
    expect(arena.inUse).toBeTrue();

    // WebGPUContext recovery changes the live tuple before draining the exact
    // old segment false. That callback must be sufficient cleanup even if no
    // later manager update ever runs.
    harness.context.resourceGeneration = 2;
    harness.settle(staleEncoder, false);

    expect(manager._webgpuCache).toBeUndefined();
    expect(manager._radianceMap).toBeNull();
    expect(manager._webgpuIBLDiffuseView).toBeNull();
    expect(manager._webgpuIBLSpecularView).toBeNull();
    expect(arena.inUse).toBeFalse();
    expect(arena.destroyed).toBeTrue();
    expect(harness.pool.releaseParameterBuffer).toHaveBeenCalledTimes(1);
    expect(incumbentCube.destroy).not.toHaveBeenCalled();
    expect(harness.scheduledTextureDestroys).toContain(incumbentCube);
    expect(harness.noteEnvironmentRefreshSubmitted).toHaveBeenCalledTimes(1);
  });

  it("preflight detaches old-device outputs before a deferred backend tick", function () {
    const oldContext = {};
    const oldDevice = {};
    const newDevice = {};
    const retireTexture = jasmine.createSpy("retireTexture");
    const oldDiffuse = {};
    const oldSpecular = {};
    const oldSampler = {};
    const oldShBuffer = {};
    const manager = {
      _webgpuCache: {
        context: oldContext,
        device: oldDevice,
        resourceGeneration: 1,
        retireTexture,
        pendingRefresh: null,
        iblCache: null,
      },
      _radianceMap: {},
      _webgpuIBLDiffuseView: oldDiffuse,
      _webgpuIBLSpecularView: oldSpecular,
      _webgpuIBLSampler: oldSampler,
      _webgpuIBLMaxMipLevel: 5,
      _webgpuSHBuffer: oldShBuffer,
    };
    const frameState = {
      context: {
        device: newDevice,
        resourceGeneration: 2,
      },
    };

    preflightWebGPUDynamicEnvironmentMap(manager, frameState);

    expect(manager._webgpuCache).toBeUndefined();
    expect(manager._radianceMap).toBeNull();
    expect(manager._webgpuIBLDiffuseView).toBeNull();
    expect(manager._webgpuIBLSpecularView).toBeNull();
    expect(manager._webgpuIBLSampler).toBeNull();
    expect(manager._webgpuIBLMaxMipLevel).toBe(0);
    expect(manager._webgpuSHBuffer).toBeNull();
  });

  it("keeps simultaneous managers on distinct writable arenas", function () {
    const harness = createFrameOwnedDynamicRefreshHarness();
    const managerA = harness.createManager();
    const managerB = harness.createManager();
    const encoder = harness.currentEncoder();

    updateWebGPUDynamicEnvironmentMap(managerA, harness.frameState);
    updateWebGPUDynamicEnvironmentMap(managerB, harness.frameState);

    const cacheA = managerA._webgpuCache;
    const cacheB = managerB._webgpuCache;
    const arenaA = cacheA.iblCache.persistentParameterArena;
    const arenaB = cacheB.iblCache.persistentParameterArena;
    expect(arenaB).not.toBe(arenaA);
    expect(arenaB.parameterBuffer).not.toBe(arenaA.parameterBuffer);
    expect(arenaA.inUse).toBeTrue();
    expect(arenaB.inUse).toBeTrue();
    expect(harness.callbacksFor(encoder).length).toBe(2);
    expect(harness.createCommandEncoder).not.toHaveBeenCalled();
    expect(harness.submit).not.toHaveBeenCalled();

    harness.settle(encoder, true);
    expect(arenaA.inUse).toBeFalse();
    expect(arenaB.inUse).toBeFalse();
    expect(managerA._webgpuIBLDiffuseView).not.toBe(
      managerB._webgpuIBLDiffuseView,
    );
    expect(harness.noteEnvironmentRefreshSubmitted).toHaveBeenCalledTimes(2);
    // Both initial publications share one request-render callback identity.
    expect(harness.frameState.afterRender.length).toBe(1);
  });

  it("tears down every owned dynamic IBL resource after one destroy fails", function () {
    const firstDestroy = jasmine
      .createSpy("firstDestroy")
      .and.throwError("injected destroy failure");
    const laterDestroy = jasmine.createSpy("laterDestroy");
    const irradianceDestroy = jasmine.createSpy("irradianceDestroy");
    const radianceDestroy = jasmine.createSpy("radianceDestroy");
    const releaseParameterBuffer = jasmine.createSpy("releaseParameterBuffer");
    const manager = {
      _webgpuCache: {
        cubemapTexture: { destroy: firstDestroy },
        skyUniformBuffer: { destroy: laterDestroy },
        iblCache: {
          irradianceTexture: { destroy: irradianceDestroy },
          irradianceView: {},
          radianceTexture: { destroy: radianceDestroy },
          radianceView: {},
          persistentParameterArena: {
            device: {},
            resourceGeneration: 1,
            parameterBuffer: {},
            parameterBytes: new ArrayBuffer(256),
            parameterWords: new Uint32Array(64),
            parameterAlignment: 256,
            parameterCapacity: 1,
            parameterPool: { releaseParameterBuffer },
            parameterHandle: { buffer: {} },
            inUse: true,
            destroyed: false,
          },
        },
      },
      _radianceMap: {},
      _webgpuIBLDiffuseView: {},
      _webgpuIBLSpecularView: {},
      _webgpuIBLSampler: {},
      _webgpuIBLMaxMipLevel: 5,
      _webgpuSHBuffer: {},
    };

    expect(function () {
      destroyWebGPUDynamicEnvironmentMapResources(manager);
    }).not.toThrow();
    expect(firstDestroy).toHaveBeenCalled();
    expect(laterDestroy).toHaveBeenCalled();
    expect(irradianceDestroy).toHaveBeenCalled();
    expect(radianceDestroy).toHaveBeenCalled();
    expect(releaseParameterBuffer).toHaveBeenCalled();
    expect(manager._webgpuCache).toBeUndefined();
    expect(manager._radianceMap).toBeNull();
    expect(manager._webgpuIBLDiffuseView).toBeNull();
    expect(manager._webgpuIBLSpecularView).toBeNull();
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
    const flushPendingTextureMipJobs = jasmine.createSpy(
      "flushPendingTextureMipJobs",
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
        flushPendingTextureMipJobs,
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
    expect(flushPendingTextureMipJobs).toHaveBeenCalledTimes(1);

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
    expect(flushPendingTextureMipJobs).toHaveBeenCalledTimes(2);
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
