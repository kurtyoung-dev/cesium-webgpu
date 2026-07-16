import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import Matrix4 from "../../../Source/Core/Matrix4.js";
import {
  MATERIAL_RESOURCE_RETIREMENT_GRACE_FRAMES,
  groupByMaterialType,
  prepareMaterialTypeFrameResources,
  pruneInactiveMaterialResources,
} from "../../../Source/Renderer/WebGPU/WebGPUPolylineRenderer.js";

describe("Renderer/WebGPU/WebGPUPolylineRenderer material grouping", function () {
  it("does not merge distinct material instances that share a shader type", function () {
    const firstMaterial = { type: "PolylineGlow" };
    const secondMaterial = { type: "PolylineGlow" };
    const collection = {
      _polylines: [
        {
          show: true,
          positions: [{}, {}],
          material: firstMaterial,
        },
        {
          show: true,
          positions: [{}, {}],
          material: secondMaterial,
        },
      ],
    };

    const groups = groupByMaterialType(collection);
    expect(groups.size).toBe(2);
    expect(groups.get(firstMaterial).polylines.length).toBe(1);
    expect(groups.get(secondMaterial).polylines.length).toBe(1);
  });

  it("still batches polylines that share the exact material", function () {
    const material = { type: "PolylineDash" };
    const collection = {
      _polylines: [
        { show: true, positions: [{}, {}], material },
        { show: true, positions: [{}, {}], material },
      ],
    };

    const groups = groupByMaterialType(collection);
    expect(groups.size).toBe(1);
    expect(groups.get(material).polylines.length).toBe(2);
  });

  it("uploads shared camera state once per material type per update", function () {
    const materialType = "PolylineGlow";
    const cameraLayout = {};
    const materialLayout = {};
    const pipeline = {};
    const pipelineEntry = {
      pipeline,
      cameraBindGroupLayout: cameraLayout,
      materialBindGroupLayout: materialLayout,
    };
    const cache = {
      _pipelineFormatGeneration: 0,
      pipelines: {
        [materialType]: new Map([["0|0", pipelineEntry]]),
      },
    };
    const queue = {
      writeBuffer: jasmine.createSpy("writeBuffer"),
    };
    const device = {
      queue,
      createBuffer: jasmine
        .createSpy("createBuffer")
        .and.callFake(function (descriptor) {
          return { ...descriptor, destroy: function () {} };
        }),
      createBindGroup: jasmine.createSpy("createBindGroup").and.returnValue({}),
    };
    const uniformState = {
      view: Matrix4.IDENTITY,
      projection: Matrix4.IDENTITY,
      previousViewProjection: Matrix4.IDENTITY,
      currentFrustum: { x: 1.0, y: 1000.0 },
      oneOverLog2FarDepthFromNearPlusOne: 0.1,
    };
    const context = {
      _scenePipelineFormatGeneration: 0,
      uniformState,
      canvas: { width: 800, height: 600 },
      drawingBufferWidth: 800,
    };
    const frameState = {
      context,
      camera: { positionWC: Cartesian3.ZERO },
    };

    const first = prepareMaterialTypeFrameResources(
      cache,
      device,
      context,
      materialType,
      0,
      false,
      frameState,
      Matrix4.IDENTITY,
      1,
    );
    const second = prepareMaterialTypeFrameResources(
      cache,
      device,
      context,
      materialType,
      0,
      false,
      frameState,
      Matrix4.IDENTITY,
      1,
    );

    expect(second).toBe(first);
    expect(queue.writeBuffer).toHaveBeenCalledTimes(1);
    expect(device.createBuffer).toHaveBeenCalledTimes(1);
    expect(device.createBindGroup).toHaveBeenCalledTimes(1);
  });

  it("keeps briefly inactive material resources resident before retirement", function () {
    const materialKey = "PolylineGlow_1";
    const materialBuffer = { destroy: jasmine.createSpy("material destroy") };
    const segmentBuffer = { destroy: jasmine.createSpy("segment destroy") };
    const previousSegmentBuffer = {
      destroy: jasmine.createSpy("previous segment destroy"),
    };
    const cache = {
      [`materialBuffer_${materialKey}`]: materialBuffer,
      [`segmentBuffer_${materialKey}`]: segmentBuffer,
      [`prevSegmentBuffer_${materialKey}`]: previousSegmentBuffer,
      [`materialBuffer_${materialKey}_size`]: 16,
      [`materialUploadState_${materialKey}`]: {},
      [`matBindGroup_${materialKey}`]: {},
      [`prevSegmentData_${materialKey}`]: new Float32Array(4),
    };
    const active = new Set([materialKey]);

    pruneInactiveMaterialResources(cache, active, 10);
    active.clear();
    pruneInactiveMaterialResources(
      cache,
      active,
      10 + MATERIAL_RESOURCE_RETIREMENT_GRACE_FRAMES - 1,
    );

    expect(materialBuffer.destroy).not.toHaveBeenCalled();
    expect(segmentBuffer.destroy).not.toHaveBeenCalled();
    expect(previousSegmentBuffer.destroy).not.toHaveBeenCalled();

    pruneInactiveMaterialResources(
      cache,
      active,
      10 + MATERIAL_RESOURCE_RETIREMENT_GRACE_FRAMES,
    );

    expect(materialBuffer.destroy).toHaveBeenCalledTimes(1);
    expect(segmentBuffer.destroy).toHaveBeenCalledTimes(1);
    expect(previousSegmentBuffer.destroy).toHaveBeenCalledTimes(1);
    expect(cache[`materialBuffer_${materialKey}`]).toBeUndefined();
    expect(cache[`segmentBuffer_${materialKey}`]).toBeUndefined();
    expect(cache[`prevSegmentBuffer_${materialKey}`]).toBeUndefined();
  });
});
