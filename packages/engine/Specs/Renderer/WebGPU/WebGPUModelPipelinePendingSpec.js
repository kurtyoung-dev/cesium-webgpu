import WebGPUModelPipelineCache from "../../../Source/Renderer/WebGPU/WebGPUModelPipelineCache.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise(function (resolvePromise, rejectPromise) {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createPipelineCacheHost(promise) {
  const central = {
    getPipelineSync: jasmine
      .createSpy("getPipelineSync")
      .and.returnValue(undefined),
    getPipeline: jasmine.createSpy("getPipeline").and.returnValue(promise),
  };
  const host = {
    _normalizeMaterialDefines: jasmine
      .createSpy("normalizeMaterialDefines")
      .and.callFake(function (value) {
        return value;
      }),
    _primitiveTopology: "triangle-list",
    _metadataVariantKey: jasmine
      .createSpy("metadataVariantKey")
      .and.callFake(function (value) {
        return value;
      }),
    _metadataSlotMode: jasmine.createSpy("metadataSlotMode").and.returnValue(0),
    _getOrCreateShaderModule: jasmine
      .createSpy("getOrCreateShaderModule")
      .and.returnValue({ label: "module" }),
    _getOrCreatePipelineLayout: jasmine
      .createSpy("getOrCreatePipelineLayout")
      .and.returnValue({ label: "layout" }),
    _getOrCreateErrorPipeline: jasmine
      .createSpy("getOrCreateErrorPipeline")
      .and.returnValue({ label: "error-pipeline" }),
    _pipelines: new Map(),
    _pendingColorPipelines: new Map(),
    _centralPipelineCache: central,
    _presentationFormat: "bgra8unorm",
    _depthFormat: "depth24plus-stencil8",
    _sampleCount: 1,
    _sceneFormatGeneration: 7,
    _lifecycleEpoch: 0,
    _errorSwapGeneration: 0,
  };
  return { host, central };
}

function getPipeline(host) {
  return WebGPUModelPipelineCache.prototype.getPipeline.call(
    host,
    WebGPUModelPipelineCache.ALPHA_OPAQUE,
    false,
    0,
  );
}

describe("Renderer/WebGPU/WebGPUModelPipelineCache pending color pipeline", function () {
  it("does not directly destroy a device-shared default property texture", function () {
    const propertyTexture = {
      destroy: jasmine.createSpy("defaultPropertyTexture.destroy"),
    };
    const cache = Object.create(WebGPUModelPipelineCache.prototype);
    cache._pipelines = new Map();
    cache._pendingColorPipelines = new Map();
    cache._pickPipelines = new Map();
    cache._snapPipelines = new Map();
    cache._errorPipelines = new Map();
    cache._depthWritePipelines = new Map();
    cache._velocityPipelines = new Map();
    cache._classificationPipelines = new Map();
    cache._silhouetteModelPipelines = new Map();
    cache._silhouetteColorPipelines = new Map();
    cache._pickHoverPipelines = new Map();
    cache._pickPrecisePass1Pipelines = new Map();
    cache._pickPrecisePass2Pipelines = new Map();
    cache._capturePipelines = new Map();
    cache._pickMetadataPipelines = new Map();
    cache._shaderModuleCache = new Map();
    cache._metadataShaderModuleCache = new Map();
    cache._errorShaderModule = null;
    cache._lifecycleEpoch = 0;
    cache._modelDeviceResources = null;
    cache._defaultPropertyTexture = propertyTexture;

    cache.destroy();

    expect(propertyTexture.destroy).not.toHaveBeenCalled();
  });

  it("drops a validation-scope settlement that arrives after destroy", async function () {
    const errorScope = createDeferred();
    const device = {
      pushErrorScope: jasmine.createSpy("pushErrorScope"),
      popErrorScope: jasmine
        .createSpy("popErrorScope")
        .and.returnValue(errorScope.promise),
      createRenderPipeline: jasmine
        .createSpy("createRenderPipeline")
        .and.callFake(function (descriptor) {
          return { descriptor };
        }),
    };
    const cache = Object.create(WebGPUModelPipelineCache.prototype);
    cache._device = device;
    cache._resourceGeneration = 3;
    cache._lifecycleEpoch = 4;
    cache._primitiveTopology = "triangle-list";
    cache._presentationFormat = "bgra8unorm";
    cache._depthFormat = "depth24plus-stencil8";
    cache._sampleCount = 1;
    cache._normalizeMaterialDefines = function (value) {
      return value;
    };
    cache._metadataVariantKey = function (value) {
      return value;
    };
    cache._metadataSlotMode = function () {
      return 0;
    };
    cache._getOrCreateShaderModule = jasmine
      .createSpy("getOrCreateShaderModule")
      .and.returnValue({ label: "shader" });
    cache._getOrCreatePipelineLayout = jasmine
      .createSpy("getOrCreatePipelineLayout")
      .and.returnValue({ label: "layout" });
    cache._getOrCreateErrorPipeline = jasmine
      .createSpy("getOrCreateErrorPipeline")
      .and.returnValue({ label: "error" });
    cache._errorSwapGeneration = 0;
    for (const name of [
      "_pipelines",
      "_pendingColorPipelines",
      "_pickPipelines",
      "_snapPipelines",
      "_errorPipelines",
      "_depthWritePipelines",
      "_velocityPipelines",
      "_classificationPipelines",
      "_silhouetteModelPipelines",
      "_silhouetteColorPipelines",
      "_pickHoverPipelines",
      "_pickPrecisePass1Pipelines",
      "_pickPrecisePass2Pipelines",
      "_capturePipelines",
      "_pickMetadataPipelines",
      "_shaderModuleCache",
      "_metadataShaderModuleCache",
    ]) {
      cache[name] = new Map();
    }
    cache._errorShaderModule = null;
    cache._modelDeviceResources = null;

    const built = cache.getDepthWritePipeline(
      WebGPUModelPipelineCache.ALPHA_BLEND,
      false,
      0,
    );
    expect(cache._depthWritePipelines.size).toBe(1);
    cache.destroy();
    expect(cache._lifecycleEpoch).toBe(5);
    expect(cache._depthWritePipelines.size).toBe(0);

    errorScope.resolve({ message: "late validation failure" });
    await errorScope.promise;
    await Promise.resolve();

    expect(built).toBeDefined();
    expect(cache._getOrCreateErrorPipeline).not.toHaveBeenCalled();
    expect(cache._depthWritePipelines.size).toBe(0);
    expect(cache._errorSwapGeneration).toBe(0);
  });

  it("does not rebuild or re-poll a variant owned by the local promise", async function () {
    const deferred = createDeferred();
    const { host, central } = createPipelineCacheHost(deferred.promise);

    expect(getPipeline(host)).toBeNull();
    expect(host._pendingColorPipelines.size).toBe(1);
    expect(host._getOrCreateShaderModule).toHaveBeenCalledTimes(1);
    expect(host._getOrCreatePipelineLayout).toHaveBeenCalledTimes(1);
    expect(central.getPipelineSync).toHaveBeenCalledTimes(1);
    expect(central.getPipeline).toHaveBeenCalledTimes(1);

    for (let frame = 0; frame < 100; frame++) {
      expect(getPipeline(host)).toBeNull();
    }
    expect(host._getOrCreateShaderModule).toHaveBeenCalledTimes(1);
    expect(host._getOrCreatePipelineLayout).toHaveBeenCalledTimes(1);
    expect(central.getPipelineSync).toHaveBeenCalledTimes(1);
    expect(central.getPipeline).toHaveBeenCalledTimes(1);

    const resolvedPipeline = { label: "resolved-pipeline" };
    deferred.resolve(resolvedPipeline);
    await deferred.promise;

    expect(host._pendingColorPipelines.size).toBe(0);
    expect(getPipeline(host)).toBe(resolvedPipeline);
    expect(central.getPipelineSync).toHaveBeenCalledTimes(1);
  });

  it("keeps rejection cleanup and the generation-correct error fallback", async function () {
    const deferred = createDeferred();
    const { host, central } = createPipelineCacheHost(deferred.promise);
    spyOn(console, "error");

    expect(getPipeline(host)).toBeNull();
    expect(getPipeline(host)).toBeNull();
    deferred.reject(new Error("expected pipeline failure"));
    await deferred.promise.catch(function () {});
    await Promise.resolve();

    expect(host._pendingColorPipelines.size).toBe(0);
    expect(host._getOrCreateErrorPipeline).toHaveBeenCalledTimes(1);
    expect(host._errorSwapGeneration).toBe(1);
    expect(getPipeline(host)).toBe(
      host._getOrCreateErrorPipeline.calls.first().returnValue,
    );
    expect(central.getPipelineSync).toHaveBeenCalledTimes(1);
    expect(central.getPipeline).toHaveBeenCalledTimes(1);
  });

  it("does not let a stale completion delete or publish over a replacement", async function () {
    const first = createDeferred();
    const second = createDeferred();
    const { host, central } = createPipelineCacheHost(first.promise);

    expect(getPipeline(host)).toBeNull();
    host._pendingColorPipelines.clear();
    host._sceneFormatGeneration++;
    central.getPipeline.and.returnValue(second.promise);
    expect(getPipeline(host)).toBeNull();

    first.resolve({ label: "stale-pipeline" });
    await first.promise;
    await Promise.resolve();
    expect(host._pendingColorPipelines.size).toBe(1);
    expect(host._pipelines.size).toBe(0);

    const replacement = { label: "replacement-pipeline" };
    second.resolve(replacement);
    await second.promise;
    await Promise.resolve();
    expect(host._pendingColorPipelines.size).toBe(0);
    expect(getPipeline(host)).toBe(replacement);
  });

  it("does not let a stale rejection error-swap a replacement", async function () {
    const first = createDeferred();
    const second = createDeferred();
    const { host, central } = createPipelineCacheHost(first.promise);
    spyOn(console, "error");

    expect(getPipeline(host)).toBeNull();
    host._pendingColorPipelines.clear();
    host._sceneFormatGeneration++;
    central.getPipeline.and.returnValue(second.promise);
    expect(getPipeline(host)).toBeNull();

    first.reject(new Error("stale failure"));
    await first.promise.catch(function () {});
    await Promise.resolve();
    expect(host._pendingColorPipelines.size).toBe(1);
    expect(host._getOrCreateErrorPipeline).not.toHaveBeenCalled();

    second.resolve({ label: "replacement-pipeline" });
    await second.promise;
    await Promise.resolve();
    expect(host._pendingColorPipelines.size).toBe(0);
  });
});
