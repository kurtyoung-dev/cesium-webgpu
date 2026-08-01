import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import Cartesian4 from "../../../Source/Core/Cartesian4.js";
import ClipSpaceConvention from "../../../Source/Core/ClipSpaceConvention.js";
import Matrix4 from "../../../Source/Core/Matrix4.js";
import Pass from "../../../Source/Renderer/Pass.js";
import {
  computeShadowCastRteMatrix,
  computeWebGPUPointShadowCastRteMatrix,
  resolveShadowCastCameraPosition,
  getShadowCastTopology,
  getShadowCastCullMode,
  getShadowCastPipelineCacheKey,
  registerShadowCastVariant,
  getRegisteredShadowCastVariantKeys,
  getShadowCastVariant,
  getShadowMapResources,
  packShadowCastUniforms,
  packShadowCastBias,
  renderShadowCastPass,
  getPointLightCubeLayer,
  isTerrainShadowCaster,
  _getOrCreateCastPipeline,
  _inferShadowLayoutKey,
  _resetShadowLayoutWarningsForSpec,
  _resetShadowCastVariantRegistryForSpec,
} from "../../../Source/Renderer/WebGPU/WebGPUShadowMapRenderer.js";

function makeProjection() {
  return Matrix4.computePerspectiveFieldOfView(
    Math.PI / 3.0,
    1.25,
    1.0,
    20000000.0,
    new Matrix4(),
    ClipSpaceConvention.WEBGPU,
  );
}

function makeLightCamera(position, projection) {
  const viewTranslation = new Cartesian3(-position.x, -position.y, -position.z);
  return {
    clipSpaceConvention: ClipSpaceConvention.WEBGPU,
    frustum: {
      getProjectionMatrix: function (clipSpaceConvention) {
        expect(clipSpaceConvention).toBe(ClipSpaceConvention.WEBGPU);
        return projection;
      },
    },
    viewMatrix: Matrix4.fromTranslation(viewTranslation, new Matrix4()),
    // Cast packing must not use the texture-biased receive transform.
    getViewProjection: function () {
      return Matrix4.fromUniformScale(99.0, new Matrix4());
    },
  };
}

const legacyPointDirections = [
  new Cartesian3(-1.0, 0.0, 0.0),
  new Cartesian3(0.0, -1.0, 0.0),
  new Cartesian3(0.0, 0.0, -1.0),
  new Cartesian3(1.0, 0.0, 0.0),
  new Cartesian3(0.0, 1.0, 0.0),
  new Cartesian3(0.0, 0.0, 1.0),
];
const legacyPointUps = [
  new Cartesian3(0.0, -1.0, 0.0),
  new Cartesian3(0.0, 0.0, -1.0),
  new Cartesian3(0.0, -1.0, 0.0),
  new Cartesian3(0.0, -1.0, 0.0),
  new Cartesian3(0.0, 0.0, 1.0),
  new Cartesian3(0.0, -1.0, 0.0),
];
const legacyPointRights = [
  new Cartesian3(0.0, 0.0, 1.0),
  new Cartesian3(1.0, 0.0, 0.0),
  new Cartesian3(-1.0, 0.0, 0.0),
  new Cartesian3(0.0, 0.0, -1.0),
  new Cartesian3(1.0, 0.0, 0.0),
  new Cartesian3(1.0, 0.0, 0.0),
];

function makeLegacyPointFaceCameras(position, projection) {
  return legacyPointDirections.map(function (direction, passIndex) {
    const camera = makeLightCamera(position, projection);
    camera.viewMatrix = Matrix4.computeView(
      position,
      direction,
      legacyPointUps[passIndex],
      legacyPointRights[passIndex],
      new Matrix4(),
    );
    return camera;
  });
}

function computeExpectedCastMatrix(lightCamera, sceneCameraPositionWC) {
  const lightWorldVP = Matrix4.multiply(
    lightCamera.frustum.getProjectionMatrix(lightCamera.clipSpaceConvention),
    lightCamera.viewMatrix,
    new Matrix4(),
  );
  const cameraTranslation = Matrix4.fromTranslation(
    sceneCameraPositionWC,
    new Matrix4(),
  );
  return Matrix4.multiply(lightWorldVP, cameraTranslation, new Matrix4());
}

function makePipelineDevice() {
  const pipelineDescriptors = [];
  const bindGroupDescriptors = [];
  const writeBufferCalls = [];
  const createdBuffers = [];
  return {
    pipelineDescriptors,
    bindGroupDescriptors,
    writeBufferCalls,
    createdBuffers,
    queue: {
      writeBuffer: function (...args) {
        writeBufferCalls.push(args);
      },
    },
    createShaderModule: function (descriptor) {
      return { descriptor };
    },
    createBuffer: function (descriptor) {
      const buffer = {
        descriptor,
        destroy: jasmine.createSpy("destroy"),
      };
      createdBuffers.push(buffer);
      return buffer;
    },
    createBindGroupLayout: function (descriptor) {
      return { descriptor };
    },
    createPipelineLayout: function (descriptor) {
      return { descriptor };
    },
    createRenderPipeline: function (descriptor) {
      pipelineDescriptors.push(descriptor);
      return { descriptor };
    },
    createBindGroup: function (descriptor) {
      bindGroupDescriptors.push(descriptor);
      return { descriptor };
    },
  };
}

function makeRenderPassEncoder() {
  const passDescriptors = [];
  const passes = [];
  return {
    passDescriptors,
    passes,
    beginRenderPass: function (descriptor) {
      passDescriptors.push(descriptor);
      const pass = {
        ended: false,
        setPipeline: function () {},
        setBindGroup: function () {},
        setVertexBuffer: function () {},
        setIndexBuffer: function () {},
        draw: function () {},
        drawIndexed: function () {},
        end: function () {
          this.ended = true;
        },
      };
      passes.push(pass);
      return pass;
    },
  };
}

describe("Renderer/WebGPU/WebGPUShadowMapRenderer", function () {
  it("preserves an explicit zero shadow darkness", function () {
    const resources = getShadowMapResources({
      darkness: 0.0,
      softShadows: false,
      _shadowMapMatrix: Matrix4.IDENTITY,
      _webgpuCache: {
        depthTexture: {},
        depthTextureView: {},
        comparisonSampler: {},
        size: 1024,
        isCube: false,
      },
    });

    expect(resources.darkness).toBe(0.0);
  });

  describe("shadow cast RTE matrix", function () {
    it("matches lightWorldVP * worldPosition at Earth scale", function () {
      const projection = makeProjection();
      const lightCamera = makeLightCamera(
        new Cartesian3(6379137.0, -1240.0, 2800.0),
        projection,
      );
      const sceneCameraPositionWC = new Cartesian3(
        6378137.25,
        -1200.5,
        3000.125,
      );
      const castMatrix = computeShadowCastRteMatrix(
        lightCamera,
        sceneCameraPositionWC,
        new Matrix4(),
      );

      const relativePosition = new Cartesian4(12.5, -8.25, -450.0, 1.0);
      const worldPosition = new Cartesian4(
        sceneCameraPositionWC.x + relativePosition.x,
        sceneCameraPositionWC.y + relativePosition.y,
        sceneCameraPositionWC.z + relativePosition.z,
        1.0,
      );
      const lightWorldVP = Matrix4.multiply(
        projection,
        lightCamera.viewMatrix,
        new Matrix4(),
      );
      const actual = Matrix4.multiplyByVector(
        castMatrix,
        relativePosition,
        new Cartesian4(),
      );
      const expected = Matrix4.multiplyByVector(
        lightWorldVP,
        worldPosition,
        new Cartesian4(),
      );

      expect(actual.x).toEqualEpsilon(expected.x, 1.0e-8);
      expect(actual.y).toEqualEpsilon(expected.y, 1.0e-8);
      expect(actual.z).toEqualEpsilon(expected.z, 1.0e-8);
      expect(actual.w).toEqualEpsilon(expected.w, 1.0e-8);
    });

    it("packs the cast transform without replacing the receive matrix", function () {
      const projection = makeProjection();
      const lightCamera = makeLightCamera(
        new Cartesian3(6379000.0, 500.0, 1800.0),
        projection,
      );
      const sceneCameraPositionWC = new Cartesian3(6378137.0, 450.0, 2000.0);
      const receiveMatrix = Matrix4.fromUniformScale(7.0, new Matrix4());
      receiveMatrix[12] = 0.25;
      receiveMatrix[13] = 0.5;
      const receiveSnapshot = Matrix4.clone(receiveMatrix, new Matrix4());
      const data = new Float32Array(32);

      packShadowCastUniforms(
        data,
        {
          _passes: [{ camera: lightCamera }],
          _shadowMapMatrix: receiveMatrix,
          _primitiveBias: { depthBias: 0.00002 },
        },
        { camera: { positionWC: sceneCameraPositionWC } },
      );

      expect(Matrix4.equals(receiveMatrix, receiveSnapshot)).toBe(true);
      const expected = computeExpectedCastMatrix(
        lightCamera,
        sceneCameraPositionWC,
      );
      for (let i = 0; i < 16; i++) {
        expect(data[i]).toBe(Math.fround(expected[i]));
      }
    });

    it("uses UniformState's active view as the pass-wide cast origin", function () {
      const projection = makeProjection();
      const lightCamera = makeLightCamera(
        new Cartesian3(6379000.0, 500.0, 1800.0),
        projection,
      );
      const activeCameraPositionWC = new Cartesian3(
        6378137.25,
        450.5,
        2000.125,
      );
      const frameCameraPositionWC = new Cartesian3(6379000.0, 9000.0, 9000.0);
      const frameState = {
        context: {
          uniformState: { cameraPosition: activeCameraPositionWC },
        },
        camera: { positionWC: frameCameraPositionWC },
      };
      const data = new Float32Array(32);

      expect(resolveShadowCastCameraPosition(frameState)).toBe(
        activeCameraPositionWC,
      );
      packShadowCastUniforms(
        data,
        {
          _passes: [{ camera: lightCamera }],
          _primitiveBias: { depthBias: 0.00002 },
        },
        frameState,
      );

      const expected = computeExpectedCastMatrix(
        lightCamera,
        activeCameraPositionWC,
      );
      for (let i = 0; i < 16; i++) {
        expect(data[i]).toBe(Math.fround(expected[i]));
      }
    });

    it("uses each point-light face camera's raw world VP", function () {
      const projection = makeProjection();
      const sceneCameraPositionWC = new Cartesian3(6378137.0, -2200.0, 1450.0);
      const face0 = makeLightCamera(
        new Cartesian3(6378237.0, -2100.0, 1500.0),
        projection,
      );
      const face1 = makeLightCamera(
        new Cartesian3(6378337.0, -2050.0, 1600.0),
        projection,
      );
      face1.viewMatrix[0] = -1.0;
      face1.viewMatrix[10] = -1.0;

      const result0 = computeShadowCastRteMatrix(
        face0,
        sceneCameraPositionWC,
        new Matrix4(),
      );
      const result1 = computeShadowCastRteMatrix(
        face1,
        sceneCameraPositionWC,
        new Matrix4(),
      );
      const expected1 = computeExpectedCastMatrix(face1, sceneCameraPositionWC);

      expect(Matrix4.equals(result0, result1)).toBe(false);
      expect(Matrix4.equalsEpsilon(result1, expected1, 1.0e-12)).toBe(true);
    });

    it("mirrors only point-face view Y for WebGPU cube lookup", function () {
      const projection = makeProjection();
      const sceneCameraPositionWC = new Cartesian3(6378137.0, -2200.0, 1450.0);
      const faceCamera = makeLightCamera(
        new Cartesian3(6378237.0, -2100.0, 1500.0),
        projection,
      );
      faceCamera.viewMatrix[1] = 2.0;
      faceCamera.viewMatrix[5] = 3.0;
      faceCamera.viewMatrix[9] = 4.0;
      faceCamera.viewMatrix[13] = 5.0;
      const originalView = Matrix4.clone(faceCamera.viewMatrix, new Matrix4());

      const actual = computeWebGPUPointShadowCastRteMatrix(
        faceCamera,
        sceneCameraPositionWC,
        new Matrix4(),
      );
      const flippedView = Matrix4.clone(faceCamera.viewMatrix, new Matrix4());
      flippedView[1] *= -1.0;
      flippedView[5] *= -1.0;
      flippedView[9] *= -1.0;
      flippedView[13] *= -1.0;
      const expectedCamera = { ...faceCamera, viewMatrix: flippedView };
      const expected = computeExpectedCastMatrix(
        expectedCamera,
        sceneCameraPositionWC,
      );

      expect(Matrix4.equals(faceCamera.viewMatrix, originalView)).toBe(true);
      expect(Matrix4.equalsEpsilon(actual, expected, 1.0e-12)).toBe(true);
    });

    it("rebases the single-position world-space variant before light projection", function () {
      const p12 = getShadowCastVariant("p12");
      expect(p12.vsCode).toContain("(p - u.camH) - u.camL");
    });
  });

  describe("point light casting", function () {
    it("maps legacy pass order to WebGPU cube layers", function () {
      const layers = [];
      for (let passIndex = 0; passIndex < 6; passIndex++) {
        layers.push(getPointLightCubeLayer(passIndex));
      }
      expect(layers).toEqual([1, 3, 5, 0, 2, 4]);
    });

    it("matches the repository's top-left WebGPU cube-face basis", function () {
      const projection = Matrix4.computePerspectiveFieldOfView(
        Math.PI / 2.0,
        1.0,
        1.0,
        100.0,
        new Matrix4(),
        ClipSpaceConvention.WEBGPU,
      );
      const origin = Cartesian3.ZERO;
      const faceCameras = makeLegacyPointFaceCameras(origin, projection);

      for (let passIndex = 0; passIndex < 6; passIndex++) {
        const camera = faceCameras[passIndex];
        const matrix = computeWebGPUPointShadowCastRteMatrix(
          camera,
          origin,
          new Matrix4(),
        );
        const canonicalUp = Cartesian3.negate(
          legacyPointUps[passIndex],
          new Cartesian3(),
        );
        const center = Cartesian3.multiplyByScalar(
          legacyPointDirections[passIndex],
          10.0,
          new Cartesian3(),
        );
        const screenUp = Cartesian3.add(center, canonicalUp, new Cartesian3());
        const screenRight = Cartesian3.add(
          center,
          legacyPointRights[passIndex],
          new Cartesian3(),
        );
        const centerClip = Matrix4.multiplyByVector(
          matrix,
          new Cartesian4(center.x, center.y, center.z, 1.0),
          new Cartesian4(),
        );
        const upClip = Matrix4.multiplyByVector(
          matrix,
          new Cartesian4(screenUp.x, screenUp.y, screenUp.z, 1.0),
          new Cartesian4(),
        );
        const rightClip = Matrix4.multiplyByVector(
          matrix,
          new Cartesian4(screenRight.x, screenRight.y, screenRight.z, 1.0),
          new Cartesian4(),
        );

        expect(centerClip.x / centerClip.w)
          .withContext(passIndex)
          .toBeCloseTo(0.0, 12);
        expect(centerClip.y / centerClip.w)
          .withContext(passIndex)
          .toBeCloseTo(0.0, 12);
        expect(upClip.y / upClip.w)
          .withContext(passIndex)
          .toBeGreaterThan(0.0);
        expect(rightClip.x / rightClip.w)
          .withContext(passIndex)
          .toBeGreaterThan(0.0);
      }
    });

    it("packs zero cast bias because point receive applies the bias", function () {
      const projection = makeProjection();
      const camera = makeLightCamera(
        new Cartesian3(6378200.0, 25.0, 40.0),
        projection,
      );
      const data = new Float32Array(32);

      packShadowCastUniforms(
        data,
        {
          _isPointLight: true,
          _passes: [{ camera }],
          _pointBias: { depthBias: 0.125 },
          _primitiveBias: {
            depthBias: 0.25,
            normalShadingSmooth: 0.5,
          },
        },
        {
          camera: {
            positionWC: new Cartesian3(6378137.0, 0.0, 0.0),
          },
        },
      );

      expect(data[24]).toBe(0.0);
      expect(data[25]).toBe(0.5);
    });

    it("writes six distinct face buffers and never writes the unused base buffer", function () {
      const projection = makeProjection();
      const sceneCameraPositionWC = new Cartesian3(6378137.0, 0.0, 0.0);
      const pointLightPositionWC = new Cartesian3(6378200.0, 25.0, 40.0);
      const faceCameras = makeLegacyPointFaceCameras(
        pointLightPositionWC,
        projection,
      );

      const device = makePipelineDevice();
      const encoder = makeRenderPassEncoder();
      const baseBuffer = { label: "base-shadow-buffer" };
      const faceBuffers = [];
      const pointFaceUniformBuffers = [];
      const pointFaceUniformData = [];
      const pointFaceCastBindGroups = [];
      const cubeFaceViews = [];
      for (let face = 0; face < 6; face++) {
        const buffer = { label: `face-buffer-${face}` };
        faceBuffers.push(buffer);
        pointFaceUniformBuffers.push({ buffer });
        pointFaceUniformData.push(new Float32Array(32));
        pointFaceCastBindGroups.push(new Map());
        cubeFaceViews.push({ label: `cube-layer-${face}` });
      }
      const cache = {
        depthTextureView: cubeFaceViews[0],
        isCube: true,
        cubeFaceViews,
        uniformBuffer: { buffer: baseBuffer },
        uniformData: new Float32Array(32),
        pointFaceUniformBuffers,
        pointFaceUniformData,
        pointFaceCastBindGroups,
        shadowContentState: "empty",
      };
      const shadowMap = {
        _isPointLight: true,
        _passes: faceCameras.map((camera) => ({ camera })),
        _primitiveBias: { depthBias: 0.25 },
        _webgpuCache: cache,
      };
      const vertexBuffer = { label: "caster-vertices" };
      const castCommands = [
        {
          _shadowCastLayout: "rte24",
          vertexBuffers: [{ buffer: vertexBuffer, arrayStride: 24 }],
          vertexCount: 3,
        },
      ];

      const encoded = renderShadowCastPass(
        encoder,
        shadowMap,
        {
          camera: { positionWC: sceneCameraPositionWC },
          context: { device },
        },
        castCommands,
      );

      const writtenBuffers = device.writeBufferCalls.map((call) => call[0]);
      expect(encoded).toBe(true);
      expect(writtenBuffers.length).toBe(6);
      expect(new Set(writtenBuffers).size).toBe(6);
      expect(writtenBuffers).toEqual(faceBuffers);
      expect(writtenBuffers).not.toContain(baseBuffer);
      expect(device.bindGroupDescriptors.length).toBe(6);
      expect(
        device.bindGroupDescriptors.map(
          (descriptor) => descriptor.entries[0].resource.buffer,
        ),
      ).toEqual(faceBuffers);
      expect(encoder.passDescriptors.length).toBe(6);
      for (let face = 0; face < 6; face++) {
        expect(pointFaceUniformData[face][24]).toBe(0.0);
      }
      expect(device.pipelineDescriptors[0].primitive.cullMode).toBe("front");
    });
  });

  describe("directional caster bias families", function () {
    it("packs distinct primitive and terrain separation values", function () {
      const data = new Float32Array(32);
      const shadowMap = {
        _primitiveBias: {
          depthBias: 0.00002,
          normalShadingSmooth: 0.05,
        },
        _terrainBias: {
          depthBias: 0.0001,
          normalShadingSmooth: 0.3,
        },
      };

      packShadowCastBias(data, shadowMap, false);
      expect(data[24]).toBeCloseTo(0.00002, 9);
      expect(data[25]).toBeCloseTo(0.05, 7);

      packShadowCastBias(data, shadowMap, true);
      expect(data[24]).toBeCloseTo(0.0001, 8);
      expect(data[25]).toBeCloseTo(0.3, 7);
      expect(isTerrainShadowCaster({ pass: Pass.GLOBE })).toBe(true);
      expect(isTerrainShadowCaster({ pass: Pass.OPAQUE })).toBe(false);
    });

    it("binds stable family-owned UBOs in one mixed cast pass", function () {
      const projection = makeProjection();
      const sceneCameraPositionWC = new Cartesian3(6378137.0, 0.0, 0.0);
      const lightCamera = makeLightCamera(
        new Cartesian3(6378200.0, 25.0, 40.0),
        projection,
      );
      const device = makePipelineDevice();
      const encoder = makeRenderPassEncoder();
      const baseBuffer = { label: "primitive-shadow-buffer" };
      const terrainGlobalsBuffer = { label: "terrain-globals-buffer" };
      const cache = {
        depthTextureView: { label: "directional-depth-view" },
        isCube: false,
        uniformBuffer: { buffer: baseBuffer },
        uniformData: new Float32Array(32),
        terrainGlobalsUB: { buffer: terrainGlobalsBuffer },
        terrainGlobalsData: new Float32Array(4),
        shadowContentState: "empty",
      };
      const shadowMap = {
        _isPointLight: false,
        _passes: [{ camera: lightCamera }],
        _primitiveBias: { depthBias: 0.00002 },
        _terrainBias: { depthBias: 0.0001 },
        _webgpuCache: cache,
      };
      const vertexBuffer = { label: "caster-vertices" };
      const primitiveCommand = {
        pass: Pass.OPAQUE,
        _shadowCastLayout: "rte24",
        vertexBuffers: [{ buffer: vertexBuffer, arrayStride: 24 }],
        vertexCount: 3,
      };
      const terrainCommand = {
        pass: Pass.GLOBE,
        _shadowCastLayout: "quantized12",
        _shadowCastTerrainUB: { label: "terrain-tile-buffer" },
        vertexBuffers: [{ buffer: vertexBuffer, arrayStride: 16 }],
        vertexCount: 3,
      };
      const uncompressedTerrainCommand = {
        pass: Pass.GLOBE,
        _shadowCastLayout: "terrainUncompressed",
        _shadowCastTerrainUB: { label: "uncompressed-terrain-tile-buffer" },
        vertexBuffers: [{ buffer: vertexBuffer, arrayStride: 24 }],
        vertexCount: 3,
      };
      const commands = [
        primitiveCommand,
        terrainCommand,
        uncompressedTerrainCommand,
      ];

      expect(
        renderShadowCastPass(
          encoder,
          shadowMap,
          {
            camera: { positionWC: sceneCameraPositionWC },
            context: { device },
          },
          commands,
        ),
      ).toBe(true);

      const terrainBuffer = cache.terrainCastUniformBuffer.buffer;
      expect(device.createdBuffers.length).toBe(1);
      expect(device.writeBufferCalls.map((call) => call[0])).toEqual([
        terrainGlobalsBuffer,
        baseBuffer,
        terrainBuffer,
      ]);
      expect(cache.uniformData[24]).toBeCloseTo(0.00002, 9);
      expect(cache.terrainCastUniformData[24]).toBeCloseTo(0.0001, 8);
      expect(
        device.bindGroupDescriptors.map(
          (descriptor) => descriptor.entries[0].resource.buffer,
        ),
      ).toEqual([baseBuffer, terrainBuffer, terrainBuffer]);
      expect(terrainCommand._shadowCastTerrainGlobalsUB).toBe(
        cache.terrainGlobalsUB,
      );
      expect(uncompressedTerrainCommand._shadowCastTerrainGlobalsUB).toBe(
        cache.terrainGlobalsUB,
      );
      expect(
        device.bindGroupDescriptors.slice(1).map(function (descriptor) {
          return descriptor.entries[2].resource.buffer;
        }),
      ).toEqual([terrainGlobalsBuffer, terrainGlobalsBuffer]);
      expect(encoder.passDescriptors.length).toBe(1);

      const secondEncoder = makeRenderPassEncoder();
      expect(
        renderShadowCastPass(
          secondEncoder,
          shadowMap,
          {
            camera: { positionWC: sceneCameraPositionWC },
            context: { device },
          },
          commands,
        ),
      ).toBe(true);
      expect(device.createdBuffers.length).toBe(1);
      expect(device.pipelineDescriptors.length).toBe(3);
      expect(device.bindGroupDescriptors.length).toBe(3);
      expect(secondEncoder.passDescriptors.length).toBe(1);
    });
  });

  describe("empty caster transitions", function () {
    it("clears a single shadow map once and leaves settled empty frames pass-free", function () {
      const encoder = makeRenderPassEncoder();
      const shadowMap = {
        _isPointLight: false,
        _webgpuCache: {
          depthTextureView: { label: "single-depth-view" },
          shadowContentState: "casters",
        },
      };

      expect(renderShadowCastPass(encoder, shadowMap, {}, [])).toBe(true);
      expect(encoder.passDescriptors.length).toBe(1);
      expect(encoder.passes[0].ended).toBe(true);
      expect(shadowMap._webgpuCache.shadowContentState).toBe("empty");

      expect(renderShadowCastPass(encoder, shadowMap, {}, [])).toBe(false);
      expect(encoder.passDescriptors.length).toBe(1);
    });

    it("clears all point faces once and leaves settled empty frames pass-free", function () {
      const encoder = makeRenderPassEncoder();
      const cubeFaceViews = [];
      for (let layer = 0; layer < 6; layer++) {
        cubeFaceViews.push({ label: `cube-layer-${layer}` });
      }
      const shadowMap = {
        _isPointLight: true,
        _webgpuCache: {
          depthTextureView: cubeFaceViews[0],
          isCube: true,
          cubeFaceViews,
          shadowContentState: "casters",
        },
      };

      expect(renderShadowCastPass(encoder, shadowMap, {}, [])).toBe(true);
      expect(encoder.passDescriptors.length).toBe(6);
      expect(
        encoder.passDescriptors.map(
          (descriptor) => descriptor.depthStencilAttachment.view,
        ),
      ).toEqual([
        cubeFaceViews[1],
        cubeFaceViews[3],
        cubeFaceViews[5],
        cubeFaceViews[0],
        cubeFaceViews[2],
        cubeFaceViews[4],
      ]);
      expect(encoder.passes.every((pass) => pass.ended)).toBe(true);
      expect(shadowMap._webgpuCache.shadowContentState).toBe("empty");

      expect(renderShadowCastPass(encoder, shadowMap, {}, [])).toBe(false);
      expect(encoder.passDescriptors.length).toBe(6);
    });
  });

  describe("shadow cast pipeline state", function () {
    it("defaults to triangle-list with WebGL's back-face culling", function () {
      expect(getShadowCastTopology({})).toBe("triangle-list");
      expect(getShadowCastCullMode({})).toBe("back");
    });

    it("maps topology and command cull state", function () {
      expect(
        getShadowCastTopology({
          _shadowCastTopology: "line-list",
          renderState: { cull: { enabled: false, face: 0x0404 } },
        }),
      ).toBe("line-list");
      expect(
        getShadowCastCullMode({
          renderState: { cull: { enabled: false, face: 0x0404 } },
        }),
      ).toBe("none");
      expect(
        getShadowCastCullMode({
          renderState: { cull: { enabled: true, face: 0x0404 } },
        }),
      ).toBe("back");
      expect(
        getShadowCastCullMode({
          renderState: { cull: { enabled: true, face: 0x0405 } },
        }),
      ).toBe("back");
      expect(
        getShadowCastCullMode({
          _shadowCastCullMode: "none",
          renderState: { cull: { enabled: true, face: 0x0405 } },
        }),
      ).toBe("none");
      expect(getShadowCastCullMode({}, true)).toBe("front");
      expect(
        getShadowCastCullMode(
          {
            _shadowCastCullMode: "front",
            renderState: { cull: { enabled: true } },
          },
          true,
        ),
      ).toBe("back");
      expect(
        getShadowCastCullMode(
          {
            renderState: { cull: { enabled: false } },
          },
          true,
        ),
      ).toBe("none");
    });

    it("keys pipelines by layout, stride, topology, and cull mode", function () {
      const base = getShadowCastPipelineCacheKey(
        "rte24",
        24,
        "triangle-list",
        "back",
      );
      expect(
        getShadowCastPipelineCacheKey("p12", 24, "triangle-list", "back"),
      ).not.toBe(base);
      expect(
        getShadowCastPipelineCacheKey("rte24", 28, "triangle-list", "back"),
      ).not.toBe(base);
      expect(
        getShadowCastPipelineCacheKey("rte24", 24, "line-list", "back"),
      ).not.toBe(base);
      expect(
        getShadowCastPipelineCacheKey("rte24", 24, "triangle-list", "none"),
      ).not.toBe(base);
    });

    it("creates and reuses the matching baked-state pipeline variant", function () {
      const device = makePipelineDevice();
      const cache = {};

      const base = _getOrCreateCastPipeline(
        device,
        cache,
        "rte24",
        24,
        "triangle-list",
        "back",
      );
      const repeated = _getOrCreateCastPipeline(
        device,
        cache,
        "rte24",
        24,
        "triangle-list",
        "back",
      );
      const line = _getOrCreateCastPipeline(
        device,
        cache,
        "rte24",
        24,
        "line-list",
        "back",
      );
      const unculled = _getOrCreateCastPipeline(
        device,
        cache,
        "rte24",
        24,
        "triangle-list",
        "none",
      );
      const widerStride = _getOrCreateCastPipeline(
        device,
        cache,
        "rte24",
        32,
        "triangle-list",
        "back",
      );
      const otherLayout = _getOrCreateCastPipeline(
        device,
        cache,
        "p12",
        12,
        "triangle-list",
        "back",
      );

      expect(repeated).toBe(base);
      expect(line).not.toBe(base);
      expect(unculled).not.toBe(base);
      expect(widerStride).not.toBe(base);
      expect(otherLayout).not.toBe(base);
      expect(device.pipelineDescriptors.length).toBe(5);
      expect(line.pipeline.descriptor.primitive).toEqual({
        topology: "line-list",
        cullMode: "back",
      });
      expect(unculled.pipeline.descriptor.primitive.cullMode).toBe("none");
      expect(
        widerStride.pipeline.descriptor.vertex.buffers[0].arrayStride,
      ).toBe(32);
      expect(cache.castPipelines.size).toBe(5);
    });
  });

  describe("shadow cast variant registry", function () {
    afterEach(function () {
      // Strip any test-added variants so the registry returns to its
      // module-load state. Built-in keys (rte24, p12, ...) are preserved.
      _resetShadowCastVariantRegistryForSpec();
    });

    it("ships with the rte24 default variant", function () {
      const keys = getRegisteredShadowCastVariantKeys();
      expect(keys).toContain("rte24");
    });

    it("ships with the p12 single-vec3 variant for non-RTE models", function () {
      const keys = getRegisteredShadowCastVariantKeys();
      expect(keys).toContain("p12");
    });

    it("registerShadowCastVariant adds new layout keys", function () {
      const before = getRegisteredShadowCastVariantKeys().length;
      const key = "__test_variant_adds_layout_key";
      registerShadowCastVariant(key, {
        vsCode: `
@vertex fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.lightVP * vec4f(p, 1.0);
}`,
        buffers: [
          {
            arrayStride: 12,
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
          },
        ],
      });
      const after = getRegisteredShadowCastVariantKeys();
      expect(after).toContain(key);
      expect(after.length).toBe(before + 1);
    });

    it("registerShadowCastVariant overwrites duplicate keys", function () {
      const key = "__test_dup_overwrites_key";
      const variantA = {
        vsCode: "// A",
        buffers: [{ arrayStride: 12, attributes: [] }],
      };
      const variantB = {
        vsCode: "// B",
        buffers: [{ arrayStride: 24, attributes: [] }],
      };
      registerShadowCastVariant(key, variantA);
      const countAfterA = getRegisteredShadowCastVariantKeys().length;
      registerShadowCastVariant(key, variantB);
      const countAfterB = getRegisteredShadowCastVariantKeys().length;
      // Re-registration must not duplicate the key.
      expect(countAfterB).toBe(countAfterA);
    });

    it("_resetShadowCastVariantRegistryForSpec restores built-ins only", function () {
      const builtinKeys = getRegisteredShadowCastVariantKeys().slice();
      registerShadowCastVariant("__test_reset_check", {
        vsCode: "// noop",
        buffers: [{ arrayStride: 12, attributes: [] }],
      });
      expect(getRegisteredShadowCastVariantKeys()).toContain(
        "__test_reset_check",
      );
      _resetShadowCastVariantRegistryForSpec();
      const afterReset = getRegisteredShadowCastVariantKeys();
      expect(afterReset).not.toContain("__test_reset_check");
      // Built-in keys preserved in the same order.
      expect(afterReset.sort()).toEqual(builtinKeys.sort());
    });
  });

  describe("_inferShadowLayoutKey()", function () {
    beforeEach(function () {
      _resetShadowLayoutWarningsForSpec();
    });

    it("picks rte24 for stride-24 commands", function () {
      expect(_inferShadowLayoutKey({}, 24)).toBe("rte24");
    });

    it("picks rte24 when stride is undefined (default assumption)", function () {
      expect(_inferShadowLayoutKey({}, undefined)).toBe("rte24");
    });

    it("picks p12 for stride-12 commands", function () {
      expect(_inferShadowLayoutKey({}, 12)).toBe("p12");
    });

    it("returns null and warns once for unrecognized strides", function () {
      const warnSpy = spyOn(console, "warn");
      expect(_inferShadowLayoutKey({}, 99)).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // Second call with the same stride must NOT warn again.
      expect(_inferShadowLayoutKey({}, 99)).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it("warns per distinct stride", function () {
      const warnSpy = spyOn(console, "warn");
      _inferShadowLayoutKey({}, 7);
      _inferShadowLayoutKey({}, 13);
      _inferShadowLayoutKey({}, 7); // already warned
      expect(warnSpy).toHaveBeenCalledTimes(2);
    });

    it("respects explicit _shadowCastLayout override on the command", function () {
      // Even with a recognized stride, the explicit override wins.
      expect(_inferShadowLayoutKey({ _shadowCastLayout: "custom" }, 24)).toBe(
        "custom",
      );
      expect(_inferShadowLayoutKey({ _shadowCastLayout: "p12" }, 24)).toBe(
        "p12",
      );
    });
  });
});
