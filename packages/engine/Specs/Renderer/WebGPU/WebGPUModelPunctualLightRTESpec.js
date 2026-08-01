import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import Matrix3 from "../../../Source/Core/Matrix3.js";
import Matrix4 from "../../../Source/Core/Matrix4.js";
import {
  getOrCreateModelCaptureCommands,
  packPunctualLights,
} from "../../../Source/Renderer/WebGPU/WebGPUModelRenderer.js";
import ModelPBRComplete from "../../../Source/Shaders/WebGPU/Model/ModelPBRComplete.js";

describe("Renderer/WebGPU model punctual-light RTE", function () {
  function makePointLight(position) {
    return {
      enabled: true,
      lightType: 1,
      position,
      color: { red: 1.0, green: 0.75, blue: 0.5 },
      intensity: 2.0,
      range: 250.0,
      constantAttenuation: 1.0,
      linearAttenuation: 0.09,
      quadraticAttenuation: 0.032,
    };
  }

  function makeSpotLight(position, direction) {
    return {
      enabled: true,
      lightType: 2,
      position,
      direction,
      color: { red: 0.5, green: 0.75, blue: 1.0 },
      intensity: 3.0,
      range: 400.0,
      innerConeAngle: 0.2,
      outerConeAngle: 0.4,
    };
  }

  it("subtracts the active camera in f64 before point and spot positions enter f32", function () {
    const earth = 6378137.0;
    const camera = new Cartesian3(earth, -earth, earth * 0.5);
    const point = makePointLight(
      new Cartesian3(earth + 0.125, -earth - 0.375, earth * 0.5 + 12.25),
    );
    const spot = makeSpotLight(
      new Cartesian3(earth - 0.25, -earth + 0.625, earth * 0.5 - 8.5),
      new Cartesian3(0.0, 1.0, 0.0),
    );
    const lights = {
      length: 2,
      get(index) {
        return index === 0 ? point : spot;
      },
      pack() {
        throw new Error("production LightCollection.get path expected");
      },
    };
    const data = new Float32Array(216);

    packPunctualLights(
      data,
      16,
      lights,
      { modelMatrix: Matrix4.IDENTITY, lightsFromGltf: false },
      camera,
    );

    const pointOffset = 20;
    const spotOffset = pointOffset + 20;
    expect(data[16]).toBe(2);
    expect(Array.from(data.slice(pointOffset, pointOffset + 3))).toEqual([
      0.125, -0.375, 12.25,
    ]);
    expect(Array.from(data.slice(spotOffset, spotOffset + 3))).toEqual([
      -0.25, 0.625, -8.5,
    ]);
    expect(Array.from(data.slice(spotOffset + 16, spotOffset + 19))).toEqual([
      0.0, 1.0, 0.0,
    ]);

    // Negative controls: quantizing either absolute operand first destroys the
    // sub-meter deltas that the camera-relative pack preserves.
    expect(Math.fround(point.position.x) - Math.fround(camera.x)).not.toBe(
      0.125,
    );
    expect(Math.fround(spot.position.x) - Math.fround(camera.x)).not.toBe(
      -0.25,
    );
  });

  it("keeps punctual shading entirely camera-relative and frame-coherent", function () {
    const punctualStart = ModelPBRComplete.indexOf("// ── Punctual lights");
    const punctualEnd = ModelPBRComplete.indexOf(
      "// ── Ambient / IBL",
      punctualStart,
    );
    const source = ModelPBRComplete.slice(punctualStart, punctualEnd);

    expect(source).toContain(
      "punctualNWC = normalize(light.eyeToWorldRotation * N)",
    );
    expect(source).toContain(
      "punctualVWC = normalize(light.eyeToWorldRotation * V)",
    );
    expect(source).toContain("let toLight = pl.posOrDir - rteWC");
    expect(source).not.toContain("camera.cameraPositionWC + rteWC");
    expect(source).toContain("dot(-Lp, spotFwd)");
  });

  it("binds six immutable capture-view light slices instead of the on-screen buffer", function () {
    const earth = 6378137.0;
    const eye = new Cartesian3(earth, 100.0, -50.0);
    const point = makePointLight(new Cartesian3(earth + 0.125, 100.5, -47.75));
    const lights = {
      length: 1,
      get() {
        return point;
      },
      pack() {
        throw new Error("production LightCollection.get path expected");
      },
    };
    const ringBuffer = { label: "frame-uniform-ring" };
    const allocations = [];
    let nextOffset = 0;
    const allocator = {
      allocateAndWrite(data, size) {
        const snapshot = new Float32Array(
          data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        );
        const allocation = {
          buffer: ringBuffer,
          offset: nextOffset,
          size,
          snapshot,
        };
        allocations.push(allocation);
        nextOffset += Math.ceil(size / 256) * 256;
        return allocation;
      },
    };
    const bindGroupDescriptors = [];
    const device = {
      createBindGroup(descriptor) {
        bindGroupDescriptors.push(descriptor);
        return { descriptor };
      },
    };
    const pipelineCache = {
      cameraBGL: {},
      defaultIBLCubemapView: {},
      defaultIBLSampler: {},
      defaultSHBuffer: {},
      defaultBrdfLutView: {},
      defaultBrdfLutSampler: {},
      defaultFeatureIdEntries() {
        return [];
      },
      getOrCreateMaterialBGL() {
        return {};
      },
      clearMetadataWGSL() {},
      setMetadataWGSL() {},
      setPrimitiveTopology() {},
      getCapturePipeline() {
        return {};
      },
    };
    const persistentLightGPUBuffer = { label: "on-screen-light-buffer" };
    const entry = {
      model: {
        modelMatrix: Matrix4.IDENTITY,
        lightsFromGltf: false,
        isDestroyed() {
          return false;
        },
      },
      pipelineCache,
      records: [
        {
          indexBuffer: {},
          indexCount: 3,
          indexFormat: "uint16",
          vertexBuffers: [],
          instanceCount: 1,
          nodeModelMatrix: Matrix4.IDENTITY,
          materialBuffer: { buffer: { label: "material-buffer" } },
          lightBuffer: { buffer: persistentLightGPUBuffer },
          textureEntries: [],
          featureIdEntries: [],
          materialDefines: 0,
          mergedInstanceBG: {},
          effectsBG: {},
          topology: "triangle-list",
          alphaMode: 0,
          doubleSided: false,
        },
      ],
    };
    const uniformState = {
      view: Matrix4.clone(Matrix4.IDENTITY),
      projection: Matrix4.clone(Matrix4.IDENTITY),
      previousViewProjection: Matrix4.clone(Matrix4.IDENTITY),
      cameraPosition: eye,
      lightDirectionEC: new Cartesian3(0.0, 0.0, 1.0),
      inverseViewRotation: Matrix3.clone(Matrix3.IDENTITY),
    };
    const frameState = {
      mode: 3,
      camera: { positionWC: new Cartesian3(1.0, 2.0, 3.0) },
      context: { uniformState, uniformAllocator: allocator },
      lights,
    };
    const lightBindings = [];

    for (let face = 0; face < 6; face++) {
      uniformState.inverseViewRotation = Matrix3.fromRotationZ(
        (face * Math.PI) / 3.0,
        new Matrix3(),
      );
      const commands = getOrCreateModelCaptureCommands(
        entry,
        device,
        frameState,
        "rgba8unorm",
      );
      expect(commands.length).toBe(1);
      lightBindings.push(
        commands[0].bindGroups[1].descriptor.entries.find(
          (bindEntry) => bindEntry.binding === 1,
        ).resource,
      );
    }

    const lightAllocations = allocations.filter(
      (allocation) => allocation.size === 864,
    );
    expect(lightAllocations.length).toBe(6);
    expect(new Set(lightBindings.map((binding) => binding.offset)).size).toBe(
      6,
    );
    expect(
      lightBindings.every(
        (binding) =>
          binding.buffer === ringBuffer &&
          binding.size === 864 &&
          binding.buffer !== persistentLightGPUBuffer,
      ),
    ).toBeTrue();
    expect(lightBindings.map((binding) => binding.offset)).toEqual(
      lightAllocations.map((allocation) => allocation.offset),
    );

    for (const allocation of lightAllocations) {
      expect(Array.from(allocation.snapshot.slice(20, 23))).toEqual([
        0.125, 0.5, 2.25,
      ]);
    }
    const rotationKeys = lightAllocations.map((allocation) =>
      [
        ...allocation.snapshot.slice(204, 207),
        ...allocation.snapshot.slice(208, 211),
        ...allocation.snapshot.slice(212, 215),
      ].join("|"),
    );
    expect(new Set(rotationKeys).size).toBe(6);
    expect(
      bindGroupDescriptors.some((descriptor) =>
        descriptor.entries?.some(
          (bindEntry) =>
            bindEntry.binding === 1 &&
            bindEntry.resource?.buffer === persistentLightGPUBuffer,
        ),
      ),
    ).toBeFalse();
  });
});
