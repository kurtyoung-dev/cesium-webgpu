import {
  BillboardCollection,
  DrawCommand,
  LabelCollection,
  PointPrimitiveCollection,
  PolylineCollection,
} from "../../index.js";
import {
  DEFAULT_COMMAND_MATERIAL_SORT_ID,
  DEFAULT_COMMAND_SORT_LAYER,
  DEFAULT_COMMAND_SORT_PRIORITY,
  applyCommandOrdering,
  compareCommandOrdering,
  getCommandDistanceSquaredForSort,
  isCommandOrderingGPUEncodable,
  normalizeCommandOrdering,
  syncCollectionCommandOrdering,
} from "../../Source/Renderer/CommandOrdering.js";
import WebGPUDrawCommand from "../../Source/Renderer/WebGPU/WebGPUDrawCommand.js";
import { WebGPUSceneRenderer } from "../../Source/Renderer/WebGPU/WebGPUSceneRenderer.js";
import GPUSortKeysShader from "../../Source/Shaders/WebGPU/Compute/GPUSortKeys.js";
import { backToFront, frontToBack } from "../../Source/Scene/CommandSorter.js";
import WasmSortBridge from "../../Source/Scene/WasmSortBridge.js";

describe("Renderer/CommandOrdering", function () {
  const mockPipeline = { label: "command-ordering-pipeline" };
  const mockVertexBuffer = {
    buffer: { size: 16, label: "command-ordering-vertex-buffer" },
    size: 16,
  };

  it("uses one default contract for WebGL and WebGPU commands", function () {
    const webgl = new DrawCommand();
    const webgpu = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
    });

    for (const command of [webgl, webgpu]) {
      expect(command.sortLayer).toBe(DEFAULT_COMMAND_SORT_LAYER);
      expect(command.sortPriority).toBe(DEFAULT_COMMAND_SORT_PRIORITY);
      expect(command.materialSortId).toBe(DEFAULT_COMMAND_MATERIAL_SORT_ID);
    }
  });

  it("maps every collection's public fields to identical backend commands", function () {
    const collections = [
      new BillboardCollection({ renderLayer: 70, renderPriority: 11 }),
      new LabelCollection({ renderLayer: 71, renderPriority: 12 }),
      new PointPrimitiveCollection({ renderLayer: 72, renderPriority: 13 }),
      new PolylineCollection({ renderLayer: 73, renderPriority: 14 }),
    ];

    try {
      for (const collection of collections) {
        const ordering = syncCollectionCommandOrdering(collection);
        const webgl = applyCommandOrdering(new DrawCommand(), ordering);
        const webgpu = new WebGPUDrawCommand({
          pipeline: mockPipeline,
          vertexBuffer: mockVertexBuffer,
          sortLayer: ordering.sortLayer,
          sortPriority: ordering.sortPriority,
          materialSortId: ordering.materialSortId,
        });

        expect(webgl.sortLayer).toBe(collection.renderLayer);
        expect(webgl.sortPriority).toBe(collection.renderPriority);
        expect(webgpu.sortLayer).toBe(webgl.sortLayer);
        expect(webgpu.sortPriority).toBe(webgl.sortPriority);
        expect(webgpu.materialSortId).toBe(webgl.materialSortId);
      }

      const labels = collections[1];
      expect(labels._glyphBillboardCollection.renderLayer).toBe(
        labels.renderLayer,
      );
      expect(labels._backgroundBillboardCollection.renderPriority).toBe(
        labels.renderPriority,
      );
    } finally {
      for (const collection of collections) {
        collection.destroy();
      }
    }
  });

  it("makes render layer authoritative in both live CPU comparators", function () {
    const lowerLayerWebGL = new DrawCommand({
      sortLayer: 50,
      sortPriority: 255,
      materialSortId: 65535,
      boundingVolume: makeBoundingVolume(1),
    });
    const higherLayerWebGPU = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      sortLayer: 70,
      sortPriority: 0,
      materialSortId: 1,
      boundingVolume: makeBoundingVolume(10_000),
    });
    const camera = { x: 0, y: 0, z: 0 };

    expect(
      frontToBack(lowerLayerWebGL, higherLayerWebGPU, camera),
    ).toBeLessThan(0);
    expect(
      backToFront(lowerLayerWebGL, higherLayerWebGPU, camera),
    ).toBeLessThan(0);
  });

  it("serializes canonical names into dense GPU-sort SOA data", function () {
    let captured;
    const featureRenderer = {
      init: function () {
        return true;
      },
      dispatch: function (_encoder, soa) {
        captured = {
          distanceSquared: soa.distanceSquared[0],
          renderLayer: soa.renderLayers[0],
          sortPriority: soa.sortPriorities[0],
          materialSortId: soa.materialSortIds[0],
        };
        return true;
      },
    };
    const context = {
      _currentCommandEncoder: {},
      uniformState: {
        cameraPosition: { x: 1, y: 2, z: 3 },
      },
      getFeatureRenderer: function () {
        return featureRenderer;
      },
    };
    const command = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      boundingVolume: makeBoundingVolume(1),
      sortLayer: 70,
      sortPriority: 23,
      materialSortId: 91,
    });
    // These legacy aliases must not override the canonical contract.
    command.renderLayer = 3;
    command.materialId = 4;

    const renderer = new WebGPUSceneRenderer();
    expect(renderer._dispatchGPUSortKeys(context, [command], 1)).toBe(true);
    expect(captured).toEqual({
      // The center-to-camera distance is 27; the bounding volume's canonical
      // surface distance is 1 and must be the value uploaded.
      distanceSquared: 1,
      renderLayer: 70,
      sortPriority: 23,
      materialSortId: 91,
    });
  });

  it("saturates GPU SOA fields and rejects lossy legacy sort keys", function () {
    let captured;
    let dispatches = 0;
    const featureRenderer = {
      init: function () {
        return true;
      },
      dispatch: function (_encoder, soa) {
        dispatches++;
        captured = {
          layers: Array.from(soa.renderLayers.subarray(0, soa.count)),
          priorities: Array.from(soa.sortPriorities.subarray(0, soa.count)),
          materials: Array.from(soa.materialSortIds.subarray(0, soa.count)),
        };
        return true;
      },
    };
    const context = {
      _currentCommandEncoder: {},
      uniformState: { cameraPosition: { x: 0, y: 0, z: 0 } },
      getFeatureRenderer: function () {
        return featureRenderer;
      },
    };
    const commands = [-1, 256].map(function (value) {
      const command = new WebGPUDrawCommand({
        pipeline: mockPipeline,
        vertexBuffer: mockVertexBuffer,
        boundingVolume: makeBoundingVolume(1),
      });
      // Exercise mutation after construction, where public command fields can
      // otherwise bypass constructor normalization.
      command.sortLayer = value;
      command.sortPriority = value;
      command.materialSortId = value < 0 ? -1 : 65536;
      return command;
    });

    const renderer = new WebGPUSceneRenderer();
    expect(renderer._dispatchGPUSortKeys(context, commands, 2)).toBe(true);
    expect(captured).toEqual({
      layers: [0, 255],
      priorities: [0, 255],
      materials: [0, 65535],
    });

    commands[0].sortKey = 7;
    expect(renderer._dispatchGPUSortKeys(context, commands, 2)).toBe(false);
    expect(dispatches).toBe(1);
  });

  it("preserves built-in layer values in packed CPU and GPU sort keys", function () {
    const bridge = new WasmSortBridge({ threshold: 100, capacity: 2 });
    const commands = [
      {
        sortLayer: 0,
        sortPriority: 255,
        materialSortId: 0,
        boundingVolume: makeBoundingVolume(0),
      },
      {
        sortLayer: 80,
        sortPriority: 0,
        materialSortId: 0,
        boundingVolume: makeBoundingVolume(0),
      },
    ];

    try {
      const indices = bridge.sortWithPackedKeys(
        commands,
        { x: 0, y: 0, z: 0 },
        false,
      );
      expect(Array.from(indices.subarray(0, 2))).toEqual([0, 1]);
    } finally {
      bridge.destroy();
    }

    expect(GPUSortKeysShader).toContain("renderLayers[cmdIndex] & 0xFFu");
    expect(GPUSortKeysShader).toContain("(layer << 24u)");
  });

  it("generates GPU keys from uploaded canonical distances", function () {
    expect(GPUSortKeysShader).toContain(
      "let dist2 = distanceSquared[cmdIndex]",
    );
    expect(GPUSortKeysShader).not.toContain("params.cameraPositionX");
    expect(GPUSortKeysShader).not.toContain("centerX[cmdIndex]");
  });

  it("saturates packed fields instead of wrapping at byte boundaries", function () {
    const boundaryValues = [-1, 0, 255, 256];
    const expected = [0, 0, 255, 255];

    for (let i = 0; i < boundaryValues.length; i++) {
      const webgl = new DrawCommand({
        sortLayer: boundaryValues[i],
        sortPriority: boundaryValues[i],
      });
      const webgpu = new WebGPUDrawCommand({
        pipeline: mockPipeline,
        vertexBuffer: mockVertexBuffer,
        sortLayer: boundaryValues[i],
        sortPriority: boundaryValues[i],
      });
      expect(webgl.sortLayer).toBe(expected[i]);
      expect(webgl.sortPriority).toBe(expected[i]);
      expect(webgpu.sortLayer).toBe(expected[i]);
      expect(webgpu.sortPriority).toBe(expected[i]);
    }

    const normalizedCommands = [
      { sortLayer: -1 },
      { sortLayer: 0 },
      { sortLayer: 255 },
      { sortLayer: 256 },
    ].map(normalizeCommandOrdering);
    expect(
      compareCommandOrdering(normalizedCommands[0], normalizedCommands[1]),
    ).toBe(0);
    expect(
      compareCommandOrdering(normalizedCommands[2], normalizedCommands[3]),
    ).toBe(0);
    expect(
      compareCommandOrdering(normalizedCommands[1], normalizedCommands[2]),
    ).toBe(-255);

    const bridge = new WasmSortBridge({ threshold: 100, capacity: 4 });
    const commands = boundaryValues.map(function (sortLayer) {
      return {
        sortLayer,
        boundingVolume: makeBoundingVolume(0),
      };
    });
    try {
      const indices = bridge.sortWithPackedKeys(
        commands,
        { x: 0, y: 0, z: 0 },
        false,
      );
      expect(Array.from(indices.subarray(0, 4))).toEqual([0, 1, 2, 3]);
    } finally {
      bridge.destroy();
    }
  });

  it("keeps legacy non-zero sort keys on the lossless CPU path", function () {
    expect(isCommandOrderingGPUEncodable({ sortKey: 0 })).toBe(true);
    expect(isCommandOrderingGPUEncodable({})).toBe(true);
    expect(isCommandOrderingGPUEncodable({ sortKey: 1 })).toBe(false);
    expect(isCommandOrderingGPUEncodable({ sortKey: -1 })).toBe(false);
  });

  it("uses the bounding volume's canonical distance instead of its center", function () {
    const camera = { x: 6_378_137, y: 100, z: -50 };
    const boundingVolume = {
      center: { x: 100_000_000, y: 0, z: 0 },
      distanceSquaredTo: jasmine.createSpy().and.returnValue(12.25),
    };
    const command = { boundingVolume };

    expect(getCommandDistanceSquaredForSort(command, camera)).toBe(12.25);
    expect(boundingVolume.distanceSquaredTo).toHaveBeenCalledWith(camera);
  });

  it("keeps the whole GPU-sort list on CPU when canonical distance is unavailable", function () {
    let dispatches = 0;
    const featureRenderer = {
      init: function () {
        return true;
      },
      dispatch: function () {
        dispatches++;
        return true;
      },
    };
    const context = {
      _currentCommandEncoder: {},
      uniformState: { cameraPosition: { x: 0, y: 0, z: 0 } },
      getFeatureRenderer: function () {
        return featureRenderer;
      },
    };
    const valid = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      boundingVolume: makeBoundingVolume(1),
    });
    const missingDistance = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      boundingVolume: { center: { x: 1, y: 2, z: 3 } },
    });
    const nonFiniteDistance = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      boundingVolume: makeBoundingVolume(Number.NaN),
    });
    const renderer = new WebGPUSceneRenderer();

    expect(
      renderer._dispatchGPUSortKeys(context, [valid, missingDistance], 2),
    ).toBe(false);
    expect(
      renderer._dispatchGPUSortKeys(context, [valid, nonFiniteDistance], 2),
    ).toBe(false);
    expect(dispatches).toBe(0);
  });
});

function makeBoundingVolume(distanceSquared) {
  return {
    center: { x: 4, y: 5, z: 6 },
    distanceSquaredTo: function () {
      return distanceSquared;
    },
  };
}
