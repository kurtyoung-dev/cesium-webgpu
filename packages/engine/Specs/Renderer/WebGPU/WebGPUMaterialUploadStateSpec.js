import {
  createMaterialUploadState,
  uploadMaterialUniformBuffer,
} from "../../../Source/Renderer/WebGPU/WebGPUMaterialUploadState.js";

describe("Renderer/WebGPU/WebGPUMaterialUploadState", function () {
  function createDevice() {
    const writes = [];
    return {
      writes,
      queue: {
        writeBuffer(buffer, offset, data) {
          writes.push({ buffer, offset, data });
        },
      },
    };
  }

  it("tracks a shared material independently for every GPU buffer", function () {
    const device = createDevice();
    const material = {
      version: 1,
      gpuData: new Float32Array([1, 2, 3, 4]),
    };
    const firstState = createMaterialUploadState();
    const secondState = createMaterialUploadState();

    expect(
      uploadMaterialUniformBuffer(device, { id: 1 }, material, firstState),
    ).toBe(true);
    expect(
      uploadMaterialUniformBuffer(device, { id: 2 }, material, secondState),
    ).toBe(true);
    expect(device.writes.length).toBe(2);

    expect(
      uploadMaterialUniformBuffer(device, { id: 1 }, material, firstState),
    ).toBe(false);
    expect(device.writes.length).toBe(2);

    material.version++;
    expect(
      uploadMaterialUniformBuffer(device, { id: 1 }, material, firstState),
    ).toBe(true);
    expect(
      uploadMaterialUniformBuffer(device, { id: 2 }, material, secondState),
    ).toBe(true);
    expect(device.writes.length).toBe(4);
  });

  it("uploads a replacement source even when its version matches", function () {
    const device = createDevice();
    const state = createMaterialUploadState();
    const first = { version: 7, gpuData: new Float32Array([1]) };
    const replacement = { version: 7, gpuData: new Float32Array([2]) };

    uploadMaterialUniformBuffer(device, {}, first, state);
    expect(uploadMaterialUniformBuffer(device, {}, replacement, state)).toBe(
      true,
    );
    expect(device.writes.length).toBe(2);
  });

  it("never consumes a legacy shared dirty flag", function () {
    const device = createDevice();
    const material = {
      isDirty: true,
      clearDirty: jasmine.createSpy("clearDirty"),
      gpuData: new Float32Array([1]),
    };

    uploadMaterialUniformBuffer(
      device,
      {},
      material,
      createMaterialUploadState(),
    );
    expect(material.clearDirty).not.toHaveBeenCalled();
  });
});
