import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import Matrix3 from "../../../Source/Core/Matrix3.js";
import Matrix4 from "../../../Source/Core/Matrix4.js";
import Quaternion from "../../../Source/Core/Quaternion.js";
import {
  LIT_CAMERA_BYTES,
  LIT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
  LIT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
  LIT_ENCODED_CAMERA_WORLD_LOW_OFFSET,
  LIT_PIXEL_RATIO_OFFSET,
  LIT_INVERSE_VIEW_QUATERNION_OFFSET,
  LIT_LOG_DEPTH_OFFSET,
  LIT_MODEL_MATRIX_COLUMN_0_OFFSET,
  LIT_PREVIOUS_VIEW_PROJECTION_OFFSET,
  writeRTEUniformsLit,
} from "../../../Source/Renderer/WebGPU/WebGPUPrimitiveCommands.js";
import { writeNormalizedInverseViewQuaternion } from "../../../Source/Renderer/WebGPU/WebGPUPrimitiveCameraQuaternion.js";
import { getShaderSource } from "../../../Source/Renderer/WebGPU/WebGPUPrimitiveShaders.js";

describe("Renderer/WebGPU Primitive model-matrix RTE", function () {
  const shaderKeys = [
    "matAlphaMapLit",
    "matAspectRampLit",
    "matBumpMapLit",
    "matCheckerLit",
    "matColorLit",
    "matDiffuseMapLit",
    "matDotLit",
    "matElevBandLit",
    "matElevContourLit",
    "matElevRampLit",
    "matEmissionMapLit",
    "matFadeLit",
    "matGridLit",
    "matImageLit",
    "matNormalMapLit",
    "matRimLightingLit",
    "matSlopeRampLit",
    "matSpecularMapLit",
    "matStripeLit",
    "matWaterLit",
    "phong",
    "phongTextured",
    "pbrSimple",
    "pbrTextured",
  ];

  const scratchModelMatrix = new Matrix4();
  const scratchWorldPosition = new Cartesian3();
  const scratchExpectedRte = new Cartesian3();
  const scratchEyePosition = new Cartesian3();
  const scratchActualRte = new Cartesian3();
  const scratchInverseViewRotation = new Matrix3();
  const scratchViewRotation = new Matrix3();
  const scratchPackedRotation = new Matrix3();
  const packedQuaternionData = new Float32Array(4);
  const packedQuaternion = new Quaternion();

  function expectCoordinateEquivalence(translation, rotation, scale) {
    Matrix4.fromTranslationQuaternionRotationScale(
      translation,
      rotation,
      scale,
      scratchModelMatrix,
    );
    const localPosition = new Cartesian3(3.5, -2.0, 1.25);
    Matrix4.multiplyByPoint(
      scratchModelMatrix,
      localPosition,
      scratchWorldPosition,
    );

    const cameraPosition = new Cartesian3(11.0, -7.0, 4.0);
    Cartesian3.subtract(
      scratchWorldPosition,
      cameraPosition,
      scratchExpectedRte,
    );

    const cameraRotation = Quaternion.fromAxisAngle(
      Cartesian3.UNIT_Z,
      0.67,
      new Quaternion(),
    );
    Matrix3.fromQuaternion(cameraRotation, scratchInverseViewRotation);
    Matrix3.transpose(scratchInverseViewRotation, scratchViewRotation);
    Matrix3.multiplyByVector(
      scratchViewRotation,
      scratchExpectedRte,
      scratchEyePosition,
    );

    writeNormalizedInverseViewQuaternion(
      packedQuaternionData,
      0,
      scratchInverseViewRotation,
    );
    packedQuaternion.x = packedQuaternionData[0];
    packedQuaternion.y = packedQuaternionData[1];
    packedQuaternion.z = packedQuaternionData[2];
    packedQuaternion.w = packedQuaternionData[3];
    Matrix3.fromQuaternion(packedQuaternion, scratchPackedRotation);
    Matrix3.multiplyByVector(
      scratchPackedRotation,
      scratchEyePosition,
      scratchActualRte,
    );

    expect(
      Cartesian3.equalsEpsilon(
        scratchActualRte,
        scratchExpectedRte,
        1.0e-6,
        1.0e-6,
      ),
    ).toBe(true);
  }

  it("preserves camera-relative coordinates through model translation", function () {
    expectCoordinateEquivalence(
      new Cartesian3(120.0, -35.0, 8.0),
      Quaternion.IDENTITY,
      new Cartesian3(1.0, 1.0, 1.0),
    );
  });

  it("preserves camera-relative coordinates through model rotation", function () {
    expectCoordinateEquivalence(
      Cartesian3.ZERO,
      Quaternion.fromAxisAngle(Cartesian3.UNIT_Y, 1.1, new Quaternion()),
      new Cartesian3(1.0, 1.0, 1.0),
    );
  });

  it("preserves camera-relative coordinates through nonuniform model scale", function () {
    expectCoordinateEquivalence(
      new Cartesian3(-9.0, 6.0, 2.0),
      Quaternion.fromAxisAngle(Cartesian3.UNIT_X, 0.4, new Quaternion()),
      new Cartesian3(2.0, 0.5, 3.25),
    );
  });

  it("reuses a cached quaternion and invalidates it when the matrix mutates", function () {
    const matrix = Matrix3.fromRotationX(0.25, new Matrix3());
    const data = new Float32Array(4);

    expect(writeNormalizedInverseViewQuaternion(data, 0, matrix)).toBe(true);
    const first = Array.from(data);
    expect(writeNormalizedInverseViewQuaternion(data, 0, matrix)).toBe(false);
    expect(Array.from(data)).toEqual(first);

    Matrix3.fromRotationY(0.75, matrix);
    expect(writeNormalizedInverseViewQuaternion(data, 0, matrix)).toBe(true);
    expect(Array.from(data)).not.toEqual(first);
    expect(Math.hypot(data[0], data[1], data[2], data[3])).toBeCloseTo(1.0, 6);
  });

  it("keeps the lit camera tail fields disjoint", function () {
    const data = new Float32Array(LIT_CAMERA_BYTES / 4);
    const previousViewProjection = Matrix4.fromTranslation(
      new Cartesian3(7.0, 8.0, 9.0),
      new Matrix4(),
    );
    const inverseViewRotation = Matrix3.fromRotationZ(0.5, new Matrix3());
    const modelMatrix3 = Matrix3.fromRowMajorArray(
      [2.0, 3.0, 5.0, 7.0, 11.0, 13.0, 17.0, 19.0, 23.0],
      new Matrix3(),
    );
    const camWorldHigh = new Cartesian3(65536.0, -131072.0, 196608.0);
    const camWorldLow = new Cartesian3(1.25, -2.5, 3.75);
    const oneOverRadii = new Cartesian3(0.125, 0.25, 0.5);
    const identity = Matrix4.clone(Matrix4.IDENTITY, new Matrix4());
    const rte = {
      mvpRTE: identity,
      modelViewRTE: identity,
      modelView: identity,
      camHigh: Cartesian3.ZERO,
      camLow: Cartesian3.ZERO,
      modelMatrix3: modelMatrix3,
      camWorldHigh: camWorldHigh,
      camWorldLow: camWorldLow,
    };
    const uniformState = {
      frameState: undefined,
      previousViewProjection: previousViewProjection,
      inverseViewRotation: inverseViewRotation,
      sunDirectionEC: Cartesian3.UNIT_Z,
      currentFrustum: {
        x: 2.0,
        y: 1002.0,
      },
      oneOverLog2FarDepthFromNearPlusOne: 0.125,
      ellipsoid: {
        oneOverRadii: oneOverRadii,
      },
    };

    writeRTEUniformsLit(data, rte, uniformState);

    expect(LIT_CAMERA_BYTES).toBe(448);
    expect(LIT_PREVIOUS_VIEW_PROJECTION_OFFSET).toBe(60);
    expect(LIT_INVERSE_VIEW_QUATERNION_OFFSET).toBe(76);
    expect(LIT_LOG_DEPTH_OFFSET).toBe(80);
    expect(LIT_ELLIPSOID_ONE_OVER_RADII_OFFSET).toBe(84);
    expect(LIT_MODEL_MATRIX_COLUMN_0_OFFSET).toBe(88);
    expect(LIT_ENCODED_CAMERA_WORLD_HIGH_OFFSET).toBe(100);
    expect(LIT_ENCODED_CAMERA_WORLD_LOW_OFFSET).toBe(104);
    expect(LIT_PIXEL_RATIO_OFFSET).toBe(108);

    const packedPrevious = new Array(16);
    Matrix4.pack(previousViewProjection, packedPrevious);
    expect(
      Array.from(
        data.subarray(
          LIT_PREVIOUS_VIEW_PROJECTION_OFFSET,
          LIT_INVERSE_VIEW_QUATERNION_OFFSET,
        ),
      ),
    ).toEqual(packedPrevious);

    const q = data.subarray(
      LIT_INVERSE_VIEW_QUATERNION_OFFSET,
      LIT_LOG_DEPTH_OFFSET,
    );
    expect(Math.hypot(q[0], q[1], q[2], q[3])).toBeCloseTo(1.0, 6);
    expect(
      Array.from(
        data.subarray(
          LIT_LOG_DEPTH_OFFSET,
          LIT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
        ),
      ),
    ).toEqual([2.0, 1002.0, 0.125, 0.0]);
    expect(
      Array.from(
        data.subarray(
          LIT_ELLIPSOID_ONE_OVER_RADII_OFFSET,
          LIT_MODEL_MATRIX_COLUMN_0_OFFSET,
        ),
      ),
    ).toEqual([0.125, 0.25, 0.5, 1.0]);
    expect(
      Array.from(
        data.subarray(
          LIT_MODEL_MATRIX_COLUMN_0_OFFSET,
          LIT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
        ),
      ),
    ).toEqual([
      2.0, 7.0, 17.0, 0.0, 3.0, 11.0, 19.0, 0.0, 5.0, 13.0, 23.0, 0.0,
    ]);
    expect(
      Array.from(
        data.subarray(
          LIT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
          LIT_ENCODED_CAMERA_WORLD_LOW_OFFSET,
        ),
      ),
    ).toEqual([65536.0, -131072.0, 196608.0, 0.0]);
    expect(
      Array.from(
        data.subarray(
          LIT_ENCODED_CAMERA_WORLD_LOW_OFFSET,
          LIT_CAMERA_BYTES / Float32Array.BYTES_PER_ELEMENT,
        ),
      ),
    ).toEqual([1.25, -2.5, 3.75, 0.0]);

    const vector = new Cartesian3(7.0, -11.0, 13.0);
    const expected = Matrix3.multiplyByVector(
      modelMatrix3,
      vector,
      new Cartesian3(),
    );
    const matrixTail = data.subarray(
      LIT_MODEL_MATRIX_COLUMN_0_OFFSET,
      LIT_ENCODED_CAMERA_WORLD_HIGH_OFFSET,
    );
    const shaderProduct = new Cartesian3(
      matrixTail[0] * vector.x +
        matrixTail[4] * vector.y +
        matrixTail[8] * vector.z,
      matrixTail[1] * vector.x +
        matrixTail[5] * vector.y +
        matrixTail[9] * vector.z,
      matrixTail[2] * vector.x +
        matrixTail[6] * vector.y +
        matrixTail[10] * vector.z,
    );
    expect(Cartesian3.equals(shaderProduct, expected)).toBe(true);
  });

  it("keeps the exact 24 lit shader families on the shared coordinate contract", function () {
    expect(shaderKeys.length).toBe(24);
    expect(new Set(shaderKeys).size).toBe(24);

    for (let i = 0; i < shaderKeys.length; ++i) {
      const key = shaderKeys[i];
      const source = getShaderSource(key);
      const previousVpIndex = source.indexOf(
        "previousViewProjection: mat4x4<f32>,",
      );
      const quaternionIndex = source.indexOf(
        "inverseViewQuaternion: vec4<f32>,",
      );
      const logDepthIndex = source.indexOf("logDepth: vec4<f32>,");

      expect(previousVpIndex).withContext(key).toBeGreaterThan(-1);
      expect(quaternionIndex).withContext(key).toBeGreaterThan(previousVpIndex);
      expect(logDepthIndex).withContext(key).toBeGreaterThan(quaternionIndex);
      expect(source.match(/inverseViewQuaternion: vec4<f32>,/g).length)
        .withContext(key)
        .toBe(1);
      expect(source).withContext(key).toContain("struct EffectsUniforms");
      expect(source)
        .withContext(key)
        .toMatch(
          /@group\([23]\) @binding\(0\) var<uniform> effects: EffectsUniforms;/,
        );
      expect(source)
        .withContext(key)
        .toContain(
          "fn rotateEyeToWorld(vector: vec3<f32>, quaternion: vec4<f32>)",
        );
      expect(source)
        .withContext(key)
        .toMatch(
          /let viewPosition = \(camera\.modelViewRelativeToEye \* (eyePos|posRTE)\)\.xyz;/,
        );
      expect(source)
        .withContext(key)
        .toContain("output.viewPosition = viewPosition;");
      expect(source)
        .withContext(key)
        .toContain(
          "output.eyePosition = rotateEyeToWorld(viewPosition, camera.inverseViewQuaternion);",
        );
      expect(source)
        .withContext(key)
        .toContain("let viewDepth = abs(input.viewPosition.z);");
      expect(source)
        .withContext(key)
        .not.toMatch(/output\.eyePosition = (eyePos|posRTE)\.xyz;/);
    }
  });

  it("keeps Phong single-map sampling in eye space", function () {
    for (const key of ["phong", "phongTextured"]) {
      const source = getShaderSource(key);
      expect(source)
        .withContext(key)
        .toContain("shadowFactor = computeShadowFactor(input.viewPosition);");
      expect(source)
        .withContext(key)
        .not.toContain("computeShadowFactor(input.eyePosition)");
      expect(source)
        .withContext(key)
        .toContain("if (clipByPlanes(input.viewPosition)) { discard; }");
      expect(source)
        .withContext(key)
        .toContain(
          "let dist = abs(dot(input.viewPosition, planeData.xyz) + planeData.w);",
        );
    }
  });
});
