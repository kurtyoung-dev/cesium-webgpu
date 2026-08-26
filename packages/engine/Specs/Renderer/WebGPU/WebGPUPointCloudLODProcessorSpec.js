import { WebGPUPointCloudLODProcessor } from "../../../Source/Renderer/WebGPU/WebGPUPointCloudLODProcessor.js";

// Mirrors the mock-device harness from WebGPUDecoupledScanSpec so both
// specs exercise the same orchestration contract — init creates
// pipelines + bind group layouts, uploadPositions writes positions,
// dispatch encodes the compute pipeline(s) to the encoder. The actual
// GPU work can't be exercised in Jasmine headless, so we assert the
// shape of what was queued (number of passes, which bind groups were
// set, which buffer-to-buffer copies happened).
function makeMockDevice(options = {}) {
  const buffers = [];
  const writes = [];
  const pipelines = [];
  const bindGroups = [];

  const device = {
    features: new Set(options.features ?? []),
    createShaderModule(desc) {
      return { __isShaderModule: true, label: desc?.label };
    },
    createBindGroupLayout(desc) {
      return { __isBGL: true, label: desc?.label, entries: desc?.entries };
    },
    createPipelineLayout(desc) {
      return {
        __isPL: true,
        label: desc?.label,
        bindGroupLayouts: desc?.bindGroupLayouts,
      };
    },
    createComputePipelineAsync(desc) {
      const p = {
        __isPipeline: true,
        label: desc.label,
        entryPoint: desc.compute?.entryPoint,
        layout: desc.layout,
      };
      pipelines.push(p);
      return Promise.resolve(p);
    },
    createBuffer(desc) {
      const buf = {
        size: desc.size,
        usage: desc.usage,
        label: desc.label,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      buffers.push(buf);
      return buf;
    },
    createBindGroup(desc) {
      const bg = {
        __isBG: true,
        label: desc.label,
        layout: desc.layout,
        entries: desc.entries,
      };
      bindGroups.push(bg);
      return bg;
    },
    queue: {
      writeBuffer(buffer, offset, source, srcOffset, byteLength) {
        writes.push({ buffer, offset, source, srcOffset, byteLength });
      },
    },
  };
  return { device, buffers, writes, pipelines, bindGroups };
}

function makeMockEncoder() {
  const passes = [];
  const clears = [];
  const copies = [];
  return {
    beginComputePass(desc) {
      const pass = {
        label: desc?.label,
        _pipeline: null,
        _bindGroups: [],
        _dispatches: [],
        setPipeline(p) {
          this._pipeline = p;
        },
        setBindGroup(idx, bg) {
          this._bindGroups.push({ idx, bg });
        },
        dispatchWorkgroups(x, y, z) {
          this._dispatches.push({ x, y, z });
        },
        end() {
          this._ended = true;
        },
      };
      passes.push(pass);
      return pass;
    },
    clearBuffer(buffer, offset, size) {
      clears.push({ buffer, offset, size });
    },
    copyBufferToBuffer(src, srcOff, dst, dstOff, size) {
      copies.push({ src, srcOff, dst, dstOff, size });
    },
    passes,
    clears,
    copies,
  };
}

if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    MAP_READ: 0x0001,
    MAP_WRITE: 0x0002,
    COPY_SRC: 0x0004,
    COPY_DST: 0x0008,
    INDEX: 0x0010,
    VERTEX: 0x0020,
    UNIFORM: 0x0040,
    STORAGE: 0x0080,
    INDIRECT: 0x0100,
    QUERY_RESOLVE: 0x0200,
  };
}
if (typeof globalThis.GPUShaderStage === "undefined") {
  globalThis.GPUShaderStage = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
}

function makeParams(pointCount, maxVisiblePoints) {
  return {
    cameraPositionLocal: [0, 0, 0],
    projectionScale: 1000,
    targetPixelSpacing: 1,
    frustumPlanes: new Float32Array(24),
    pointCount,
    maxVisiblePoints,
    geometricError: 1,
    modelLinear: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
  };
}

describe("Renderer/WebGPU/WebGPUPointCloudLODProcessor", function () {
  describe("atomic-add path (default)", function () {
    it("initialize() compiles the portable pipeline without subgroup variant", async function () {
      const { device, pipelines } = makeMockDevice();
      const processor = new WebGPUPointCloudLODProcessor(device);
      await processor.initialize();
      // One pipeline: computeMain. The subgroup variant is not compiled
      // because `device.features` is empty.
      expect(pipelines.length).toBe(1);
      expect(pipelines[0].entryPoint).toBe("computeMain");
      expect(processor.isReady).toBe(true);
    });

    it("dispatch encodes a single compute pass", async function () {
      const { device, writes } = makeMockDevice();
      const processor = new WebGPUPointCloudLODProcessor(device);
      await processor.initialize();
      processor.uploadPositions(
        new Float32Array([0, 1, 2, 3]),
        new Float32Array([0, 1, 2, 3]),
        new Float32Array([0, 1, 2, 3]),
      );
      const encoder = makeMockEncoder();
      processor.dispatch(encoder, makeParams(4, 256));
      expect(encoder.passes.length).toBe(1);
      expect(encoder.passes[0]._dispatches).toEqual([{ x: 1, y: 1, z: 1 }]);
      expect(encoder.clears.length).toBe(1);
      expect(encoder.copies.length).toBe(0);
      const paramsWrite = writes.find((write) =>
        write.buffer.label?.endsWith("LODParams UB"),
      );
      expect(new Uint32Array(paramsWrite.source)[33]).toBe(4);
    });

    it("forks distinct mutable owner streams while sharing immutable compute artifacts", async function () {
      const { device, pipelines, buffers, bindGroups } = makeMockDevice();
      const template = new WebGPUPointCloudLODProcessor(device);
      await template.initialize();
      const pipelineCount = pipelines.length;
      const ownerA = await template.createOwnerStream("Cloud A");
      const ownerB = await template.createOwnerStream("Cloud B");
      expect(pipelines.length).toBe(pipelineCount);

      const positions = new Float32Array([0, 1, 2, 3]);
      ownerA.uploadPositions(positions, positions, positions);
      ownerB.uploadPositions(positions, positions, positions);
      const encoderA = makeMockEncoder();
      const encoderB = makeMockEncoder();
      ownerA.dispatch(encoderA, makeParams(4, 4));
      ownerB.dispatch(encoderB, makeParams(4, 4));

      expect(encoderA.passes[0]._pipeline).toBe(encoderB.passes[0]._pipeline);
      const bgA = encoderA.passes[0]._bindGroups[0].bg;
      const bgB = encoderB.passes[0]._bindGroups[0].bg;
      expect(bgA).not.toBe(bgB);
      expect(bgA.layout).toBe(bgB.layout);
      expect(ownerA.visibleCountBuffer).not.toBe(ownerB.visibleCountBuffer);
      expect(ownerA.visibleIndicesBuffer).not.toBe(ownerB.visibleIndicesBuffer);
      const aBuffers = buffers.filter((b) => b.label?.startsWith("Cloud A"));
      const bBuffers = buffers.filter((b) => b.label?.startsWith("Cloud B"));
      expect(aBuffers.length).toBeGreaterThan(4);
      expect(bBuffers.length).toBeGreaterThan(4);
      expect(
        bindGroups.filter((bg) => bg.label?.startsWith("Cloud A")).length,
      ).toBeGreaterThan(0);
      expect(
        bindGroups.filter((bg) => bg.label?.startsWith("Cloud B")).length,
      ).toBeGreaterThan(0);

      ownerA.destroy();
      expect(aBuffers.every((buffer) => buffer.destroyed)).toBe(true);
      expect(bBuffers.every((buffer) => !buffer.destroyed)).toBe(true);
      ownerB.destroy();
      template.destroy();
    });
  });

  describe("decoupled-scan path (useDecoupledScan: true)", function () {
    it("initialize() compiles the atomic pipeline AND both scan entry points", async function () {
      const { device, pipelines } = makeMockDevice();
      const processor = new WebGPUPointCloudLODProcessor(device, {
        useDecoupledScan: true,
      });
      await processor.initialize();
      const entryPoints = pipelines.map((p) => p.entryPoint);
      // Atomic main + tag + compact + the scanner's "scan" pipeline = 4.
      // We don't hard-assert the number because the scanner is a
      // composition and could grow; but we DO assert the two
      // scan-specific entry points appear.
      expect(entryPoints).toContain("computeMain");
      expect(entryPoints).toContain("tagVisible");
      expect(entryPoints).toContain("compactScanned");
      expect(entryPoints).toContain("scan");
    });

    it("uploadPositions allocates flags + prefix storage buffers", async function () {
      const { device, buffers } = makeMockDevice();
      const processor = new WebGPUPointCloudLODProcessor(device, {
        useDecoupledScan: true,
      });
      await processor.initialize();
      processor.uploadPositions(
        new Float32Array(1024),
        new Float32Array(1024),
        new Float32Array(1024),
      );
      const labels = buffers.map((b) => b.label);
      expect(labels.some((l) => /flags$/.test(l))).toBe(true);
      expect(labels.some((l) => /prefix$/.test(l))).toBe(true);
    });

    it("shares deterministic scan pipelines while isolating owner scratch", async function () {
      const { device, pipelines, buffers } = makeMockDevice();
      const template = new WebGPUPointCloudLODProcessor(device, {
        useDecoupledScan: true,
      });
      await template.initialize();
      const compileCount = pipelines.length;
      const ownerA = await template.createOwnerStream("Scan A");
      const ownerB = await template.createOwnerStream("Scan B");
      expect(pipelines.length).toBe(compileCount);

      const positions = new Float32Array(512);
      ownerA.uploadPositions(positions, positions, positions);
      ownerB.uploadPositions(positions, positions, positions);
      const encoderA = makeMockEncoder();
      const encoderB = makeMockEncoder();
      ownerA.dispatch(encoderA, makeParams(512, 512));
      ownerB.dispatch(encoderB, makeParams(512, 512));
      const scanA = encoderA.passes.find(
        (pass) => pass._pipeline?.entryPoint === "scan",
      );
      const scanB = encoderB.passes.find(
        (pass) => pass._pipeline?.entryPoint === "scan",
      );
      expect(scanA._pipeline).toBe(scanB._pipeline);

      const ownerABuffers = buffers.filter((b) =>
        b.label?.startsWith("Scan A"),
      );
      const ownerBBuffers = buffers.filter((b) =>
        b.label?.startsWith("Scan B"),
      );
      ownerA.destroy();
      expect(ownerABuffers.every((buffer) => buffer.destroyed)).toBe(true);
      expect(ownerBBuffers.every((buffer) => !buffer.destroyed)).toBe(true);
      ownerB.destroy();
      template.destroy();
    });

    it("dispatch encodes tag + scan + capped visible-count publication", async function () {
      const { device } = makeMockDevice();
      const processor = new WebGPUPointCloudLODProcessor(device, {
        useDecoupledScan: true,
      });
      await processor.initialize();
      processor.uploadPositions(
        new Float32Array(1024),
        new Float32Array(1024),
        new Float32Array(1024),
      );
      const encoder = makeMockEncoder();
      processor.dispatch(encoder, makeParams(1024, 512));
      // Three compute passes: tagVisible, scan, compactScanned.
      expect(encoder.passes.length).toBe(3);
      // compactScanned writes min(prefix[N-1], maxVisiblePoints) directly to
      // the atomic count. Copying the raw prefix total would overrun indirect.
      expect(encoder.copies.length).toBe(0);
      const compact = encoder.passes.find(
        (pass) => pass._pipeline?.entryPoint === "compactScanned",
      );
      expect(
        compact._bindGroups[0].bg.entries.some((entry) => entry.binding === 7),
      ).toBe(true);
    });

    it("dispatch is a no-op for zero-length input", async function () {
      const { device } = makeMockDevice();
      const processor = new WebGPUPointCloudLODProcessor(device, {
        useDecoupledScan: true,
      });
      await processor.initialize();
      const encoder = makeMockEncoder();
      processor.dispatch(encoder, makeParams(0, 0));
      expect(encoder.passes.length).toBe(0);
      expect(encoder.clears.length).toBe(0);
      expect(encoder.copies.length).toBe(0);
    });

    it("destroy() tears down scan-path resources", async function () {
      const { device, buffers } = makeMockDevice();
      const processor = new WebGPUPointCloudLODProcessor(device, {
        useDecoupledScan: true,
      });
      await processor.initialize();
      processor.uploadPositions(
        new Float32Array(128),
        new Float32Array(128),
        new Float32Array(128),
      );
      processor.destroy();
      // All buffers the processor created should be destroyed. (The
      // scanner owns its partitions buffer — its destroy() is called
      // via scanner.destroy() and tracked in the same buffers array.)
      const undestroyed = buffers.filter((b) => !b.destroyed);
      expect(undestroyed.length).toBe(0);
    });
  });
});
