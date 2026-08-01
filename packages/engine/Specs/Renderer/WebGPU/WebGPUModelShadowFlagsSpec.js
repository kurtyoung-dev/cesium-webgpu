import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import Matrix4 from "../../../Source/Core/Matrix4.js";
import {
  getCurrentModelLightShadowMap,
  getModelCommandShadowFlags,
  getModelShadowCastLayout,
  getStyledTranslucentModelShadowFlags,
  isModelShadowCastingActive,
  isModelShadowReceivingActive,
  updateModelShadowCastUniform,
} from "../../../Source/Renderer/WebGPU/WebGPUModelRenderer.js";
import SceneMode from "../../../Source/Scene/SceneMode.js";
import ShadowMode from "../../../Source/Scene/ShadowMode.js";

if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    COPY_DST: 0x0008,
    UNIFORM: 0x0040,
  };
}

describe("Renderer/WebGPU/WebGPUModel shadow flags", function () {
  function makeDevice() {
    const buffers = [];
    const writes = [];
    const device = {
      createBuffer(descriptor) {
        const buffer = {
          descriptor: descriptor,
          destroyCalls: 0,
          destroy() {
            this.destroyCalls++;
          },
        };
        buffers.push(buffer);
        return buffer;
      },
      queue: {
        writeBuffer(buffer, offset, source, sourceOffset, size) {
          const bytes = new Uint8Array(source, sourceOffset, size).slice();
          writes.push({
            buffer: buffer,
            offset: offset,
            data: new Float32Array(bytes.buffer),
          });
        },
      },
    };
    return { device: device, buffers: buffers, writes: writes };
  }

  function expectFlags(shadowMode, castShadows, receiveShadows) {
    expect(getModelCommandShadowFlags(shadowMode, false, true)).toEqual({
      castShadows: castShadows,
      receiveShadows: receiveShadows,
    });
  }

  it("maps ShadowMode.ENABLED to cast and receive", function () {
    expectFlags(ShadowMode.ENABLED, true, true);
  });

  it("maps ShadowMode.CAST_ONLY to cast only", function () {
    expectFlags(ShadowMode.CAST_ONLY, true, false);
  });

  it("maps ShadowMode.RECEIVE_ONLY to receive only", function () {
    expectFlags(ShadowMode.RECEIVE_ONLY, false, true);
  });

  it("maps ShadowMode.DISABLED to neither cast nor receive", function () {
    expectFlags(ShadowMode.DISABLED, false, false);
  });

  it("uses ENABLED for the model default", function () {
    expectFlags(undefined, true, true);
  });

  it("suppresses shadows for classifier commands", function () {
    expect(getModelCommandShadowFlags(ShadowMode.ENABLED, true, true)).toEqual({
      castShadows: false,
      receiveShadows: false,
    });
  });

  it("suppresses shadows for non-color derived commands", function () {
    expect(
      getModelCommandShadowFlags(ShadowMode.ENABLED, false, false),
    ).toEqual({
      castShadows: false,
      receiveShadows: false,
    });
  });

  it("keeps the styled translucent twin receive-only and untagged", function () {
    const colorFlags = getModelCommandShadowFlags(
      ShadowMode.ENABLED,
      false,
      true,
    );
    const twinFlags = getStyledTranslucentModelShadowFlags(colorFlags);

    expect(twinFlags).toEqual({
      castShadows: false,
      receiveShadows: true,
    });
    expect(Object.keys(twinFlags).sort()).toEqual([
      "castShadows",
      "receiveShadows",
    ]);
    expect(twinFlags._shadowCastLayout).toBeUndefined();

    const castOnlyFlags = getModelCommandShadowFlags(
      ShadowMode.CAST_ONLY,
      false,
      true,
    );
    expect(getStyledTranslucentModelShadowFlags(castOnlyFlags)).toEqual({
      castShadows: false,
      receiveShadows: false,
    });
  });

  it("selects only complete supported model cast layouts", function () {
    expect(getModelShadowCastLayout(false, 1, false, false)).toBe("modelP12");
    expect(getModelShadowCastLayout(true, 1, true, false)).toBe("modelSkinned");
    expect(getModelShadowCastLayout(false, 3, false, true)).toBe(
      "modelInstancedSB",
    );

    expect(getModelShadowCastLayout(true, 1, false, false)).toBeUndefined();
    expect(getModelShadowCastLayout(false, 3, false, false)).toBeUndefined();
    expect(getModelShadowCastLayout(true, 3, true, true)).toBeUndefined();
  });

  it("does not realize cast resources when global shadows are off", function () {
    const frameState = {
      shadowMaps: [],
      passes: { pick: false, pickVoxel: false },
      mode: SceneMode.SCENE3D,
    };

    expect(isModelShadowCastingActive(true, frameState)).toBe(false);
  });

  it("realizes cast resources only for an active 3D render shadow pass", function () {
    const frameState = {
      shadowMaps: [{}],
      passes: { pick: false, pickVoxel: false },
      mode: SceneMode.SCENE3D,
    };

    expect(isModelShadowCastingActive(true, frameState)).toBe(true);
    expect(isModelShadowCastingActive(false, frameState)).toBe(false);

    frameState.passes.pick = true;
    expect(isModelShadowCastingActive(true, frameState)).toBe(false);

    frameState.passes.pick = false;
    frameState.mode = SceneMode.SCENE2D;
    expect(isModelShadowCastingActive(true, frameState)).toBe(false);
  });

  it("activates shadow receiving only for an active light shadow pass", function () {
    expect(isModelShadowReceivingActive(true, true, true)).toBe(true);
    expect(isModelShadowReceivingActive(false, true, true)).toBe(false);
    expect(isModelShadowReceivingActive(true, false, true)).toBe(false);
    expect(isModelShadowReceivingActive(true, true, false)).toBe(false);
  });

  it("resolves receive maps from same-frame shadow inputs, not stale state", function () {
    const analyticalMap = { fromLightSource: false };
    const lightMap = { fromLightSource: true };
    const frameState = {
      shadowMaps: [analyticalMap, lightMap],
      shadowState: {
        lightShadowsEnabled: false,
        lightShadowMaps: [],
      },
    };

    expect(getCurrentModelLightShadowMap(frameState, true)).toBe(lightMap);
    expect(getCurrentModelLightShadowMap(frameState, false)).toBeUndefined();

    frameState.shadowMaps.length = 0;
    frameState.shadowState.lightShadowsEnabled = true;
    frameState.shadowState.lightShadowMaps.push(lightMap);
    expect(getCurrentModelLightShadowMap(frameState, true)).toBeUndefined();
  });

  it("uploads a shadow transform on first use", function () {
    const { device, buffers, writes } = makeDevice();
    const host = {};

    const uniform = updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "root shadow",
    );

    expect(buffers.length).toBe(1);
    expect(buffers[0].descriptor.label).toBe("root shadow");
    expect(buffers[0].descriptor.size).toBe(96);
    expect(writes.length).toBe(1);
    expect(writes[0].buffer).toBe(uniform.buffer);
    expect(Array.from(writes[0].data.slice(0, 16))).toEqual(
      Matrix4.pack(Matrix4.IDENTITY, new Array(16)),
    );
    expect(Array.from(writes[0].data.slice(16))).toEqual(new Array(8).fill(0));
  });

  it("skips an unchanged shadow transform upload", function () {
    const { device, buffers, writes } = makeDevice();
    const host = {};

    const first = updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "root shadow",
    );
    const second = updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "root shadow",
    );

    expect(second).toBe(first);
    expect(buffers.length).toBe(1);
    expect(writes.length).toBe(1);
  });

  it("uploads unchanged bytes after the GPU buffer is recreated", function () {
    const { device, buffers, writes } = makeDevice();
    const host = {};

    const first = updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "root shadow",
    );
    host.shadowCastUB = undefined;
    const replacement = updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "root shadow",
    );

    expect(replacement).not.toBe(first);
    expect(buffers.length).toBe(2);
    expect(writes.length).toBe(2);
    expect(writes[1].buffer).toBe(replacement.buffer);
  });

  it("recreates a destroyed shadow transform buffer", function () {
    const { device, buffers, writes } = makeDevice();
    const host = {};

    const first = updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "root shadow",
    );
    first.destroy();
    const replacement = updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "root shadow",
    );

    expect(replacement).not.toBe(first);
    expect(first.isDestroyed).toBe(true);
    expect(host.shadowCastDevice).toBe(device);
    expect(buffers.length).toBe(2);
    expect(buffers[0].destroyCalls).toBe(1);
    expect(writes.length).toBe(2);
    expect(writes[1].buffer).toBe(replacement.buffer);
  });

  it("recreates a shadow transform buffer for a replacement device", function () {
    const firstHarness = makeDevice();
    const secondHarness = makeDevice();
    const host = {};

    const first = updateModelShadowCastUniform(
      firstHarness.device,
      host,
      Matrix4.IDENTITY,
      "root shadow",
    );
    const replacement = updateModelShadowCastUniform(
      secondHarness.device,
      host,
      Matrix4.IDENTITY,
      "root shadow",
    );

    expect(replacement).not.toBe(first);
    expect(first.isDestroyed).toBe(true);
    expect(host.shadowCastDevice).toBe(secondHarness.device);
    expect(firstHarness.buffers.length).toBe(1);
    expect(firstHarness.buffers[0].destroyCalls).toBe(1);
    expect(secondHarness.buffers.length).toBe(1);
    expect(firstHarness.writes.length).toBe(1);
    expect(secondHarness.writes.length).toBe(1);
    expect(secondHarness.writes[0].buffer).toBe(replacement.buffer);
  });

  it("uploads a changed node shadow transform without reallocating", function () {
    const { device, buffers, writes } = makeDevice();
    const host = {};
    const changedMatrix = Matrix4.clone(Matrix4.IDENTITY);
    changedMatrix[12] = 128.0;
    changedMatrix[13] = -32.0;

    updateModelShadowCastUniform(device, host, Matrix4.IDENTITY, "node shadow");
    updateModelShadowCastUniform(device, host, changedMatrix, "node shadow");

    expect(buffers.length).toBe(1);
    expect(writes.length).toBe(2);
    expect(Array.from(writes[1].data.slice(0, 16))).toEqual(
      Matrix4.pack(Matrix4.IDENTITY, new Array(16)),
    );
    expect(writes[1].data[16] + writes[1].data[20]).toBe(-128.0);
    expect(writes[1].data[17] + writes[1].data[21]).toBe(32.0);
  });

  it("keeps root and transformed-node shadow uniforms separate", function () {
    const { device, buffers, writes } = makeDevice();
    const rootHost = {};
    const nodeHost = {};
    const nodeMatrix = Matrix4.clone(Matrix4.IDENTITY);
    nodeMatrix[12] = 64.0;

    const rootUniform = updateModelShadowCastUniform(
      device,
      rootHost,
      Matrix4.IDENTITY,
      "root shadow",
    );
    const nodeUniform = updateModelShadowCastUniform(
      device,
      nodeHost,
      nodeMatrix,
      "node shadow",
    );

    expect(rootUniform).not.toBe(nodeUniform);
    expect(rootUniform.buffer).not.toBe(nodeUniform.buffer);
    expect(buffers.length).toBe(2);
    expect(writes.length).toBe(2);
  });

  it("packs an Earth-scale model as linear plus model-space camera RTE", function () {
    const { device, writes } = makeDevice();
    const host = {};
    const modelMatrix = Matrix4.clone(Matrix4.IDENTITY);
    modelMatrix[12] = 6378137.0;
    modelMatrix[13] = -4512345.25;
    modelMatrix[14] = 3840000.5;
    const cameraPositionWC = new Cartesian3(
      modelMatrix[12] + 12.25,
      modelMatrix[13] - 3.5,
      modelMatrix[14] + 100.125,
    );

    updateModelShadowCastUniform(
      device,
      host,
      modelMatrix,
      "earth shadow",
      cameraPositionWC,
    );

    const data = writes[0].data;
    expect(data[12]).toBe(0.0);
    expect(data[13]).toBe(0.0);
    expect(data[14]).toBe(0.0);
    expect(data[16] + data[20]).toBeCloseTo(12.25, 6);
    expect(data[17] + data[21]).toBeCloseTo(-3.5, 6);
    expect(data[18] + data[22]).toBeCloseTo(100.125, 6);
  });

  it("reuses the packed color-camera RTE without another model inverse", function () {
    const { device, writes } = makeDevice();
    const host = {};
    const packedCameraData = new Float32Array(80);
    packedCameraData[48] = 12.0;
    packedCameraData[49] = -3.0;
    packedCameraData[50] = 100.0;
    packedCameraData[52] = 0.25;
    packedCameraData[53] = -0.5;
    packedCameraData[54] = 0.125;
    spyOn(Matrix4, "inverse").and.callThrough();

    updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "shared camera shadow",
      new Cartesian3(6378137.0, 0.0, 0.0),
      packedCameraData,
    );

    expect(Matrix4.inverse).not.toHaveBeenCalled();
    expect(writes.length).toBe(1);
    expect(Array.from(writes[0].data.slice(16, 23))).toEqual([
      12.0, -3.0, 100.0, 0.0, 0.25, -0.5, 0.125,
    ]);
  });

  it("uploads when only the shadow camera moves", function () {
    const { device, buffers, writes } = makeDevice();
    const host = {};

    updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "moving camera shadow",
      new Cartesian3(1.0, 2.0, 3.0),
    );
    updateModelShadowCastUniform(
      device,
      host,
      Matrix4.IDENTITY,
      "moving camera shadow",
      new Cartesian3(4.0, 5.0, 6.0),
    );

    expect(buffers.length).toBe(1);
    expect(writes.length).toBe(2);
  });
});
