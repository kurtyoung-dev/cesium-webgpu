import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import EncodedCartesian3 from "../../../Source/Core/EncodedCartesian3.js";
import Matrix4 from "../../../Source/Core/Matrix4.js";
import Quaternion from "../../../Source/Core/Quaternion.js";
import {
  PRIMITIVE_RTE_SHADOW_CAST_LAYOUT,
  configurePrimitiveShadowCastCommand,
  packPrimitiveShadowCastUniform,
  updatePrimitiveShadowCastCommand,
  updatePrimitiveShadowCastUniform,
} from "../../../Source/Renderer/WebGPU/WebGPUPrimitiveShadowCast.js";
import { getShadowCastVariant } from "../../../Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js";

if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    COPY_DST: 0x0008,
    UNIFORM: 0x0040,
  };
}

describe("Renderer/WebGPU/WebGPUPrimitiveShadowCast", function () {
  function makeDevice() {
    const buffers = [];
    const writes = [];
    const device = {
      createBuffer(descriptor) {
        const buffer = {
          descriptor: descriptor,
          destroyed: false,
          destroy() {
            this.destroyed = true;
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

  const scratchModel = new Matrix4();
  const scratchWorldPosition = new Cartesian3();
  const scratchExpectedRte = new Cartesian3();
  const scratchActualRte = new Cartesian3();
  const scratchRteMC = new Cartesian3();
  const scratchLinear = new Matrix4();
  const scratchEncodedPosition = new EncodedCartesian3();

  function expectTransformEquivalence(translation, rotation, scale) {
    Matrix4.fromTranslationQuaternionRotationScale(
      translation,
      rotation,
      scale,
      scratchModel,
    );
    const cameraWC = new Cartesian3(
      translation.x + 31.125,
      translation.y - 17.25,
      translation.z + 8.5,
    );
    const positionMC = new Cartesian3(4.25, -2.5, 1.125);
    const data = new Float32Array(24);
    packPrimitiveShadowCastUniform(data, scratchModel, cameraWC);

    EncodedCartesian3.fromCartesian(positionMC, scratchEncodedPosition);
    scratchRteMC.x =
      scratchEncodedPosition.high.x -
      data[16] +
      (scratchEncodedPosition.low.x - data[20]);
    scratchRteMC.y =
      scratchEncodedPosition.high.y -
      data[17] +
      (scratchEncodedPosition.low.y - data[21]);
    scratchRteMC.z =
      scratchEncodedPosition.high.z -
      data[18] +
      (scratchEncodedPosition.low.z - data[22]);
    Matrix4.unpack(data, 0, scratchLinear);
    Matrix4.multiplyByPointAsVector(
      scratchLinear,
      scratchRteMC,
      scratchActualRte,
    );

    Matrix4.multiplyByPoint(scratchModel, positionMC, scratchWorldPosition);
    Cartesian3.subtract(scratchWorldPosition, cameraWC, scratchExpectedRte);
    expect(
      Cartesian3.equalsEpsilon(
        scratchActualRte,
        scratchExpectedRte,
        1.0e-5,
        1.0e-5,
      ),
    ).toBe(true);
  }

  it("preserves translated primitive coordinates at Earth scale", function () {
    expectTransformEquivalence(
      new Cartesian3(6378137.0, -4512345.25, 3840000.5),
      Quaternion.IDENTITY,
      new Cartesian3(1.0, 1.0, 1.0),
    );
  });

  it("preserves rotated primitive coordinates", function () {
    expectTransformEquivalence(
      new Cartesian3(6378137.0, 100.0, -250.0),
      Quaternion.fromAxisAngle(Cartesian3.UNIT_Y, 0.71, new Quaternion()),
      new Cartesian3(1.0, 1.0, 1.0),
    );
  });

  it("preserves nonuniformly scaled primitive coordinates", function () {
    expectTransformEquivalence(
      new Cartesian3(-1200000.0, 5100000.0, 3300000.0),
      Quaternion.fromAxisAngle(Cartesian3.UNIT_X, -0.43, new Quaternion()),
      new Cartesian3(2.5, 0.375, 4.0),
    );
  });

  it("keeps world-space rte24 and primitive-space RTE as separate variants", function () {
    const worldVariant = getShadowCastVariant("rte24");
    const primitiveVariant = getShadowCastVariant(
      PRIMITIVE_RTE_SHADOW_CAST_LAYOUT,
    );

    expect(worldVariant.perCommandBindingFields).toBeUndefined();
    expect(worldVariant.vsCode).toContain(
      "let rte = (pH - u.camH) + (pL - u.camL);",
    );
    expect(primitiveVariant.perCommandBindingFields).toEqual([
      "_shadowCastPrimitiveUB",
    ]);
    expect(primitiveVariant.vsCode).toContain(
      "let rteMC = (pH - p.cameraMCHigh.xyz) + (pL - p.cameraMCLow.xyz);",
    );
    expect(primitiveVariant.vsCode).toContain(
      "p.modelLinear * vec4f(rteMC, 0.0)",
    );
  });

  it("shares one stable transform and bind-group cache host across command twins", function () {
    const { device, buffers, writes } = makeDevice();
    const host = {};
    const firstCommand = {};
    const secondCommand = {};
    configurePrimitiveShadowCastCommand(firstCommand, host, 44);
    configurePrimitiveShadowCastCommand(secondCommand, host, 44);

    const first = updatePrimitiveShadowCastCommand(
      device,
      firstCommand,
      Matrix4.IDENTITY,
      Cartesian3.ZERO,
    );
    const second = updatePrimitiveShadowCastCommand(
      device,
      secondCommand,
      Matrix4.IDENTITY,
      Cartesian3.ZERO,
    );

    expect(first).toBe(second);
    expect(firstCommand._shadowCastPrimitiveUB).toBe(first);
    expect(secondCommand._shadowCastPrimitiveUB).toBe(first);
    expect(firstCommand._shadowCastBindGroupCacheHost).toBe(host);
    expect(secondCommand._shadowCastBindGroupCacheHost).toBe(host);
    expect(firstCommand._shadowCastLayout).toBe(
      PRIMITIVE_RTE_SHADOW_CAST_LAYOUT,
    );
    expect(firstCommand.vertexStride).toBe(44);
    expect(buffers.length).toBe(1);
    expect(writes.length).toBe(1);
  });

  it("updates camera or model revisions without reallocating", function () {
    const { device, buffers, writes } = makeDevice();
    const host = {};
    const model = Matrix4.clone(Matrix4.IDENTITY);
    const first = updatePrimitiveShadowCastUniform(
      device,
      host,
      model,
      new Cartesian3(1.0, 2.0, 3.0),
    );
    const inputState = host.primitiveShadowCastInputState;
    const data = host.primitiveShadowCastData;

    updatePrimitiveShadowCastUniform(
      device,
      host,
      model,
      new Cartesian3(1.0, 2.0, 3.0),
    );
    updatePrimitiveShadowCastUniform(
      device,
      host,
      model,
      new Cartesian3(4.0, 5.0, 6.0),
    );
    model[12] = 128.0;
    const last = updatePrimitiveShadowCastUniform(
      device,
      host,
      model,
      new Cartesian3(4.0, 5.0, 6.0),
    );

    expect(last).toBe(first);
    expect(host.primitiveShadowCastInputState).toBe(inputState);
    expect(host.primitiveShadowCastData).toBe(data);
    expect(buffers.length).toBe(1);
    expect(writes.length).toBe(3);
    expect(writes[2].data[12]).toBe(0.0);
    expect(writes[2].data[16] + writes[2].data[20]).toBe(-124.0);
  });

  it("reuses the color-pass encoded model-space camera without another inverse", function () {
    const { device, writes } = makeDevice();
    const host = {};
    const model = Matrix4.fromTranslation(
      new Cartesian3(6378137.0, -250.0, 80.0),
      new Matrix4(),
    );
    const cameraWC = new Cartesian3(6378168.25, -267.5, 91.125);
    const inverse = Matrix4.inverse(model, new Matrix4());
    const cameraMC = Matrix4.multiplyByPoint(
      inverse,
      cameraWC,
      new Cartesian3(),
    );
    const encodedCameraMC = EncodedCartesian3.fromCartesian(
      cameraMC,
      new EncodedCartesian3(),
    );
    const expected = new Float32Array(24);
    packPrimitiveShadowCastUniform(expected, model, cameraWC);
    spyOn(Matrix4, "inverse").and.callThrough();

    updatePrimitiveShadowCastUniform(
      device,
      host,
      model,
      cameraWC,
      "Primitive shadow cast UB",
      encodedCameraMC.high,
      encodedCameraMC.low,
    );

    expect(Matrix4.inverse).not.toHaveBeenCalled();
    expect(writes.length).toBe(1);
    expect(Array.from(writes[0].data)).toEqual(Array.from(expected));
  });
});
