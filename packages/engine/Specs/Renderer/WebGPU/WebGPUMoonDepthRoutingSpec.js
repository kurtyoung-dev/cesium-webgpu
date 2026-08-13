import { tryResolvePhysicalMoonPipeline } from "../../../Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js";

describe("Renderer/WebGPU/WebGPUMoonDepthRouting", function () {
  it("makes an async physical-pipeline failure terminal for the cache tuple", async function () {
    const warning = spyOn(console, "warn");
    const pipelineCache = {
      getPipelineSync: jasmine
        .createSpy("getPipelineSync")
        .and.returnValue(null),
      getPipeline: jasmine
        .createSpy("getPipeline")
        .and.returnValue(
          Promise.reject(new Error("invalid physical pipeline")),
        ),
    };
    const entry = {
      descriptor: {},
      pipeline: null,
      pending: false,
      failed: false,
      failureReported: false,
    };

    expect(tryResolvePhysicalMoonPipeline({}, pipelineCache, entry)).toBeNull();
    await Promise.resolve();
    await Promise.resolve();

    expect(entry.failed).toBe(true);
    expect(entry.pending).toBe(false);
    expect(warning).toHaveBeenCalledTimes(1);

    expect(tryResolvePhysicalMoonPipeline({}, pipelineCache, entry)).toBeNull();
    expect(pipelineCache.getPipeline).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
