import { Pass } from "../../../index.js";

// Direct import since WebGPUDrawCommand is not in the public barrel export
import WebGPUDrawCommand from "../../../Source/Renderer/WebGPU/WebGPUDrawCommand.js";

describe("Renderer/WebGPU/WebGPUDrawCommand", function () {
  // Mock GPU objects — these are plain JS objects that satisfy the duck-type
  // interface without requiring a real GPU device.
  const mockPipeline = { label: "mock-pipeline" };
  const mockBindGroup = { label: "mock-bg0" };
  const mockVertexBuffer = {
    buffer: { size: 1024, label: "mock-vb" },
    size: 1024,
  };
  const mockIndexBuffer = {
    buffer: { size: 256, label: "mock-ib" },
    size: 256,
  };

  it("constructs with required options", function () {
    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
    });

    expect(cmd.pipeline).toBe(mockPipeline);
    expect(cmd.vertexBuffers.length).toEqual(1);
    expect(cmd.vertexBuffers[0]).toBe(mockVertexBuffer);
    expect(cmd.isWebGPUDrawCommand).toBe(true);
    expect(cmd.enabled).toBe(true);
    expect(cmd.instanceCount).toEqual(1);
    expect(cmd.firstVertex).toEqual(0);
    expect(cmd.firstIndex).toEqual(0);
    expect(cmd.firstInstance).toEqual(0);
    expect(cmd.cull).toBe(true);
    expect(cmd.castShadows).toBe(false);
    expect(cmd.receiveShadows).toBe(false);
    expect(cmd.executeInClosestFrustum).toBe(false);
  });

  it("constructs with all options", function () {
    const boundingVolume = { center: {}, radius: 100 };
    const modelMatrix = {};
    const owner = { name: "test-owner" };

    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      bindGroups: [mockBindGroup],
      vertexBuffers: [mockVertexBuffer],
      indexBuffer: mockIndexBuffer,
      indexFormat: "uint32",
      indexCount: 36,
      instanceCount: 5,
      firstIndex: 2,
      firstVertex: 1,
      firstInstance: 3,
      pass: Pass.OPAQUE,
      owner: owner,
      boundingVolume: boundingVolume,
      modelMatrix: modelMatrix,
      cull: false,
      castShadows: true,
      receiveShadows: true,
      executeInClosestFrustum: true,
      sortLayer: 100,
      sortPriority: 5,
      materialSortId: 42,
      visibilityMask: 0x0f,
      isTransmissive: true,
    });

    expect(cmd.pipeline).toBe(mockPipeline);
    expect(cmd.bindGroups.length).toEqual(1);
    expect(cmd.bindGroups[0]).toBe(mockBindGroup);
    expect(cmd.bindGroup).toBe(mockBindGroup);
    expect(cmd.vertexBuffers.length).toEqual(1);
    expect(cmd.indexBuffer).toBe(mockIndexBuffer);
    expect(cmd.indexFormat).toEqual("uint32");
    expect(cmd.indexCount).toEqual(36);
    expect(cmd.instanceCount).toEqual(5);
    expect(cmd.firstIndex).toEqual(2);
    expect(cmd.firstVertex).toEqual(1);
    expect(cmd.firstInstance).toEqual(3);
    expect(cmd.pass).toEqual(Pass.OPAQUE);
    expect(cmd.owner).toBe(owner);
    expect(cmd.boundingVolume).toBe(boundingVolume);
    expect(cmd.modelMatrix).toBe(modelMatrix);
    expect(cmd.cull).toBe(false);
    expect(cmd.castShadows).toBe(true);
    expect(cmd.receiveShadows).toBe(true);
    expect(cmd.executeInClosestFrustum).toBe(true);
    expect(cmd.sortLayer).toEqual(100);
    expect(cmd.sortPriority).toEqual(5);
    expect(cmd.materialSortId).toEqual(42);
    expect(cmd.visibilityMask).toEqual(0x0f);
    expect(cmd.isTransmissive).toBe(true);
  });

  it("supports single bindGroup option for backward compatibility", function () {
    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      bindGroup: mockBindGroup,
      vertexBuffer: mockVertexBuffer,
    });

    expect(cmd.bindGroup).toBe(mockBindGroup);
    expect(cmd.bindGroups.length).toEqual(1);
    expect(cmd.bindGroups[0]).toBe(mockBindGroup);
  });

  it("supports single vertexBuffer option for backward compatibility", function () {
    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
    });

    expect(cmd.vertexBuffer).toBe(mockVertexBuffer);
    expect(cmd.vertexBuffers.length).toEqual(1);
    expect(cmd.vertexBuffers[0]).toBe(mockVertexBuffer);
  });

  it("has empty bind groups when none provided", function () {
    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
    });

    expect(cmd.bindGroups.length).toEqual(0);
    expect(cmd.bindGroup).toBeUndefined();
  });

  it("defaults sorting properties", function () {
    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
    });

    expect(cmd.sortLayer).toEqual(50); // RenderLayer.Order.WORLD
    expect(cmd.sortPriority).toEqual(0);
    expect(cmd.materialSortId).toEqual(0);
    expect(cmd.visibilityMask).toEqual(0xffffffff);
    expect(cmd.isTransmissive).toBe(false);
  });

  it("isWebGPUDrawCommand is always true and readonly", function () {
    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
    });

    expect(cmd.isWebGPUDrawCommand).toBe(true);
  });

  it("does not execute when disabled", function () {
    let executed = false;
    const mockPassEncoder = {
      setPipeline: function () {
        executed = true;
      },
      setBindGroup: function () {},
      setVertexBuffer: function () {},
      drawIndexed: function () {},
      draw: function () {},
    };

    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      vertexCount: 3,
    });
    cmd.enabled = false;
    cmd.execute(mockPassEncoder);

    expect(executed).toBe(false);
  });

  it("executes non-indexed draw when no index buffer", function () {
    const calls = [];
    const mockPassEncoder = {
      setPipeline: function (p) {
        calls.push(["setPipeline", p]);
      },
      setBindGroup: function (i, bg) {
        calls.push(["setBindGroup", i, bg]);
      },
      setVertexBuffer: function (i, buf) {
        calls.push(["setVertexBuffer", i]);
      },
      draw: function (count, instances, firstVert, firstInst) {
        calls.push(["draw", count, instances, firstVert, firstInst]);
      },
      drawIndexed: function () {
        calls.push(["drawIndexed"]);
      },
    };

    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      bindGroups: [mockBindGroup],
      vertexBuffer: mockVertexBuffer,
      vertexCount: 36,
      instanceCount: 2,
      firstVertex: 4,
      firstInstance: 1,
    });
    cmd.execute(mockPassEncoder);

    expect(calls[0][0]).toEqual("setPipeline");
    expect(calls[0][1]).toBe(mockPipeline);
    expect(calls[1][0]).toEqual("setBindGroup");
    expect(calls[1][1]).toEqual(0);
    expect(calls[2][0]).toEqual("setVertexBuffer");
    // Last call should be draw (non-indexed)
    const drawCall = calls[calls.length - 1];
    expect(drawCall[0]).toEqual("draw");
    expect(drawCall[1]).toEqual(36); // vertexCount
    expect(drawCall[2]).toEqual(2); // instanceCount
    expect(drawCall[3]).toEqual(4); // firstVertex
    expect(drawCall[4]).toEqual(1); // firstInstance
  });

  it("applies a pass dynamic-state override after command renderState", function () {
    const viewports = [];
    const scissors = [];
    const mockPassEncoder = {
      setPipeline: function () {},
      setBindGroup: function () {},
      setVertexBuffer: function () {},
      setViewport: function (...args) {
        viewports.push(args);
      },
      setScissorRect: function (...args) {
        scissors.push(args);
      },
      draw: function () {},
    };
    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      vertexCount: 3,
      renderState: {
        viewport: { x: 1, y: 2, width: 90, height: 80 },
        scissorTest: {
          enabled: true,
          rectangle: { x: 3, y: 4, width: 70, height: 60 },
        },
      },
    });

    cmd.execute(mockPassEncoder, {
      viewport: { x: 0, y: 0, width: 100, height: 80 },
      scissor: { x: 10, y: 55, width: 3, height: 5 },
    });

    expect(viewports).toEqual([
      [1, 2, 90, 80, 0, 1],
      [0, 0, 100, 80, 0, 1],
    ]);
    expect(scissors).toEqual([
      [3, 4, 70, 60],
      [10, 55, 3, 5],
    ]);
  });

  it("does not re-emit pass dynamic state for commands that leave it untouched", function () {
    const setViewport = jasmine.createSpy("setViewport");
    const setScissorRect = jasmine.createSpy("setScissorRect");
    const mockPassEncoder = {
      setPipeline: function () {},
      setBindGroup: function () {},
      setVertexBuffer: function () {},
      setViewport: setViewport,
      setScissorRect: setScissorRect,
      setStencilReference: function () {},
      draw: function () {},
    };
    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      vertexCount: 3,
    });

    cmd.execute(mockPassEncoder, {
      viewport: { x: 0, y: 0, width: 100, height: 80 },
      scissor: { x: 10, y: 55, width: 3, height: 5 },
    });

    const stencilOnly = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      vertexCount: 3,
      renderState: { stencilTest: { reference: 7 } },
    });
    stencilOnly.execute(mockPassEncoder, {
      viewport: { x: 0, y: 0, width: 100, height: 80 },
      scissor: { x: 10, y: 55, width: 3, height: 5 },
    });

    expect(setViewport).not.toHaveBeenCalled();
    expect(setScissorRect).not.toHaveBeenCalled();
  });

  it("publishes pass dynamic state once before replaying a render bundle", function () {
    const calls = [];
    const bundle = {};
    const mockPassEncoder = {
      setViewport: function (...args) {
        calls.push(["viewport", ...args]);
      },
      setScissorRect: function (...args) {
        calls.push(["scissor", ...args]);
      },
      executeBundles: function (bundles) {
        calls.push(["bundle", bundles]);
      },
    };
    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
    });
    cmd.bundle = bundle;

    cmd.execute(mockPassEncoder, {
      viewport: { x: 0, y: 0, width: 100, height: 80 },
      scissor: { x: 10, y: 55, width: 3, height: 5 },
    });

    expect(calls).toEqual([
      ["viewport", 0, 0, 100, 80, 0, 1],
      ["scissor", 10, 55, 3, 5],
      ["bundle", [bundle]],
    ]);
  });

  it("executes indexed draw when index buffer is provided", function () {
    const calls = [];
    const mockPassEncoder = {
      setPipeline: function () {
        calls.push("setPipeline");
      },
      setBindGroup: function () {
        calls.push("setBindGroup");
      },
      setVertexBuffer: function () {
        calls.push("setVertexBuffer");
      },
      setIndexBuffer: function (buf, fmt) {
        calls.push(["setIndexBuffer", fmt]);
      },
      drawIndexed: function (count, instances, firstIdx, baseVert, firstInst) {
        calls.push([
          "drawIndexed",
          count,
          instances,
          firstIdx,
          baseVert,
          firstInst,
        ]);
      },
      draw: function () {
        calls.push("draw");
      },
    };

    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffer: mockVertexBuffer,
      indexBuffer: mockIndexBuffer,
      indexFormat: "uint16",
      indexCount: 12,
    });
    cmd.execute(mockPassEncoder);

    // Should have setIndexBuffer call
    const indexCall = calls.find(
      (c) => Array.isArray(c) && c[0] === "setIndexBuffer",
    );
    expect(indexCall).toBeDefined();
    expect(indexCall[1]).toEqual("uint16");

    // Should have drawIndexed call
    const drawCall = calls.find(
      (c) => Array.isArray(c) && c[0] === "drawIndexed",
    );
    expect(drawCall).toBeDefined();
    expect(drawCall[1]).toEqual(12); // indexCount
  });

  it("supports multiple bind groups", function () {
    const bg1 = { label: "bg1" };
    const bg2 = { label: "bg2" };
    const bg3 = { label: "bg3" };

    const bindGroupIndices = [];
    const mockPassEncoder = {
      setPipeline: function () {},
      setBindGroup: function (i) {
        bindGroupIndices.push(i);
      },
      setVertexBuffer: function () {},
      draw: function () {},
    };

    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      bindGroups: [bg1, bg2, bg3],
      vertexBuffer: mockVertexBuffer,
      vertexCount: 3,
    });
    cmd.execute(mockPassEncoder);

    expect(bindGroupIndices).toEqual([0, 1, 2]);
  });

  it("supports multiple vertex buffers", function () {
    const vb1 = { buffer: { size: 100 }, size: 100 };
    const vb2 = { buffer: { size: 200 }, size: 200 };

    const vbIndices = [];
    const mockPassEncoder = {
      setPipeline: function () {},
      setBindGroup: function () {},
      setVertexBuffer: function (i) {
        vbIndices.push(i);
      },
      draw: function () {},
    };

    const cmd = new WebGPUDrawCommand({
      pipeline: mockPipeline,
      vertexBuffers: [vb1, vb2],
      vertexCount: 3,
    });
    cmd.execute(mockPassEncoder);

    expect(vbIndices).toEqual([0, 1]);
  });

  it("detects uint16 index format for small buffers", function () {
    const smallBuffer = { size: 24 }; // 12 indices * 2 bytes
    const format = WebGPUDrawCommand.detectIndexFormat(smallBuffer, 12);
    expect(format).toEqual("uint16");
  });

  it("detects uint32 index format for large indices", function () {
    const largeBuffer = { size: 48 }; // 12 indices * 4 bytes
    const format = WebGPUDrawCommand.detectIndexFormat(largeBuffer, 12);
    expect(format).toEqual("uint32");
  });

  it("defaults to uint16 for undefined buffer", function () {
    const format = WebGPUDrawCommand.detectIndexFormat(undefined, 0);
    expect(format).toEqual("uint16");
  });

  it("throws without options", function () {
    expect(function () {
      return new WebGPUDrawCommand();
    }).toThrowError();
  });

  it("throws without pipeline", function () {
    expect(function () {
      return new WebGPUDrawCommand({
        vertexBuffer: mockVertexBuffer,
      });
    }).toThrowError();
  });

  it("throws without vertex buffer", function () {
    expect(function () {
      return new WebGPUDrawCommand({
        pipeline: mockPipeline,
      });
    }).toThrowError();
  });
});
