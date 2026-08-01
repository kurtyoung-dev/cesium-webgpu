import { WebGPUPostProcessPipeline } from "../../../Source/Renderer/WebGPU/WebGPUPostProcessPipeline.js";

function createExposureHost(initialExposure = 1.0) {
  const writes = [];
  const uniformBuffer = { label: "tonemap-uniforms" };
  const host = {
    _manualExposure: initialExposure,
    _tonemapUploadedExposure: initialExposure,
    _tonemapStage: { uniformBuffer },
    _device: {
      queue: {
        writeBuffer(buffer, offset, source) {
          writes.push({ buffer, offset, value: source[0] });
        },
      },
    },
  };
  host._writeTonemappingExposure =
    WebGPUPostProcessPipeline.prototype._writeTonemappingExposure;
  return { host, uniformBuffer, writes };
}

function setExposure(host, exposure) {
  WebGPUPostProcessPipeline.prototype.setTonemappingExposure.call(
    host,
    exposure,
  );
}

describe("Renderer/WebGPU/WebGPUPostProcessPipeline tonemap exposure", function () {
  it("allocates and writes only when the effective fixed exposure changes", function () {
    const { host, uniformBuffer, writes } = createExposureHost();
    spyOn(host, "_writeTonemappingExposure").and.callThrough();

    setExposure(host, 1.0);
    setExposure(host, 1.0 + Number.EPSILON);
    expect(host._writeTonemappingExposure).not.toHaveBeenCalled();
    expect(writes.length).toBe(0);

    setExposure(host, 1.25);
    setExposure(host, 1.25);
    expect(host._writeTonemappingExposure).toHaveBeenCalledTimes(1);
    expect(writes).toEqual([
      { buffer: uniformBuffer, offset: 0, value: Math.fround(1.25) },
    ]);
    expect(host._manualExposure).toBe(Math.fround(1.25));
  });

  it("normalizes non-finite fixed exposure to the safe default once", function () {
    const { host, writes } = createExposureHost(2.0);

    setExposure(host, Number.POSITIVE_INFINITY);
    setExposure(host, Number.NaN);

    expect(host._manualExposure).toBe(1.0);
    expect(writes.length).toBe(1);
    expect(writes[0].value).toBe(1.0);
  });

  it("does not dirty-gate genuinely changing adapted exposure writes", function () {
    const { host, writes } = createExposureHost();

    host._writeTonemappingExposure(0.75);
    host._writeTonemappingExposure(0.875);

    expect(
      writes.map(function (write) {
        return write.value;
      }),
    ).toEqual([0.75, 0.875]);
    expect(host._manualExposure).toBe(1.0);
  });

  it("restores unchanged manual exposure after an adapted auto value", function () {
    const { host, writes } = createExposureHost(1.0);

    host._writeTonemappingExposure(0.625);
    setExposure(host, 1.0);
    setExposure(host, 1.0);

    expect(
      writes.map(function (write) {
        return write.value;
      }),
    ).toEqual([0.625, 1.0]);
    expect(host._tonemapUploadedExposure).toBe(1.0);
  });

  it("records the normalized initial exposure packed by addTonemapping", function () {
    let packedUniforms;
    const host = {
      _tonemapStage: null,
      _intermediateFormat: "rgba16float",
      _manualExposure: 1.0,
      _tonemapUploadedExposure: 1.0,
      _compileStage(_device, _name, _source, _format, uniforms) {
        packedUniforms = uniforms;
        return { uniformBuffer: { label: "tonemap-uniforms" } };
      },
    };

    WebGPUPostProcessPipeline.prototype.addTonemapping.call(
      host,
      {},
      "bgra8unorm",
      0,
      1.0 + Number.EPSILON,
    );

    expect(packedUniforms[0]).toBe(1.0);
    expect(host._manualExposure).toBe(1.0);
    expect(host._tonemapUploadedExposure).toBe(1.0);
  });
});
