import { WebGPUDecoupledScan } from "../../../Source/Renderer/WebGPU/WebGPUDecoupledScan.js";

// Mock device lets us assert the orchestration — init calls into
// createShaderModule + createBindGroupLayout + createComputePipelineAsync,
// dispatch writes params + zeros partitions + encodes a compute pass,
// ensureCapacity grows the partitions buffer. The actual GPU work isn't
// exercised (no WebGPU device in Jasmine headless), which mirrors the
// pattern already used by WebGPURingBufferAllocatorSpec.
function makeMockDevice() {
  const buffers = [];
  const writes = [];
  const pipelines = [];
  const bindGroups = [];

  const device = {
    createShaderModule() {
      return { __isShaderModule: true };
    },
    createBindGroupLayout() {
      return { __isBGL: true };
    },
    createPipelineLayout() {
      return { __isPL: true };
    },
    createComputePipelineAsync(desc) {
      const p = { __isPipeline: true, label: desc.label };
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
      const bg = { __isBG: true, entries: desc.entries };
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
  return {
    beginComputePass() {
      const pass = {
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
    passes,
  };
}

// The runtime references the global GPUBufferUsage constants when building
// buffer descriptors. Provide a numeric stand-in so the spec works in Node.
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

describe("Renderer/WebGPU/WebGPUDecoupledScan", function () {
  it("does not allocate GPU resources before initialize()", function () {
    const { device, buffers, pipelines } = makeMockDevice();
    const scan = new WebGPUDecoupledScan(device, { maxElements: 1024 });
    expect(scan.isInitialized).toBe(false);
    expect(buffers.length).toBe(0);
    expect(pipelines.length).toBe(0);
  });

  it("initialize() creates a pipeline and params UBO (but not partitions)", async function () {
    const { device, buffers, pipelines } = makeMockDevice();
    const scan = new WebGPUDecoupledScan(device, { maxElements: 1024 });
    await scan.initialize("/* wgsl stub */");
    expect(scan.isInitialized).toBe(true);
    expect(pipelines.length).toBe(1);
    // Only the params UBO is allocated at init time; the partitions buffer
    // is lazy so scanners that are constructed-but-never-dispatched don't
    // pay for a storage buffer.
    expect(buffers.length).toBe(1);
    expect(buffers[0].label).toContain("Params");
  });

  it("ensureCapacity grows the partitions buffer as needed", async function () {
    const { device, buffers } = makeMockDevice();
    const scan = new WebGPUDecoupledScan(device, { maxElements: 256 });
    await scan.initialize("/* wgsl stub */");

    scan.ensureCapacity(256);
    const afterFirstGrow = buffers.length;
    expect(afterFirstGrow).toBeGreaterThan(1);
    const partsBuf = buffers[buffers.length - 1];
    expect(partsBuf.label).toContain("Partitions");
    // 256 elements / 256 workgroup size = 1 partition × 4 bytes = 4 bytes.
    expect(partsBuf.size).toBeGreaterThanOrEqual(4);

    // Re-request same capacity → should be a no-op (no new buffer).
    scan.ensureCapacity(256);
    expect(buffers.length).toBe(afterFirstGrow);

    // Grow: new capacity triggers a new allocation. The old partitions
    // buffer is destroyed.
    scan.ensureCapacity(10_000);
    expect(buffers.length).toBeGreaterThan(afterFirstGrow);
    expect(partsBuf.destroyed).toBe(true);
  });

  it("dispatch writes params, zeros partitions, encodes a compute pass", async function () {
    const { device, writes, bindGroups } = makeMockDevice();
    const scan = new WebGPUDecoupledScan(device, { maxElements: 1024 });
    await scan.initialize("/* wgsl stub */");

    const encoder = makeMockEncoder();
    // Synthesize input/output storage buffers — the scan doesn't read
    // them, but it wires them into the bind group so dispatch has to
    // treat them as valid handles.
    const inputBuffer = device.createBuffer({
      size: 1024 * 4,
      usage: GPUBufferUsage.STORAGE,
      label: "in",
    });
    const outputBuffer = device.createBuffer({
      size: 1024 * 4,
      usage: GPUBufferUsage.STORAGE,
      label: "out",
    });

    const ok = scan.dispatch(encoder, inputBuffer, outputBuffer, 1024);
    expect(ok).toBe(true);

    // Two queue.writeBuffer calls: params and zero-partitions.
    // (Plus zero reallocations because we stayed under maxElements.)
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(writes[0].buffer.label).toContain("Params");
    expect(writes[1].buffer.label).toContain("Partitions");

    // One compute pass with dispatchWorkgroups(ceil(1024/256)) = 4.
    expect(encoder.passes.length).toBe(1);
    const pass = encoder.passes[0];
    expect(pass._dispatches).toEqual([{ x: 4, y: 1, z: 1 }]);
    expect(pass._ended).toBe(true);

    // One bind group, containing all 4 bindings (params, in, out, parts).
    expect(bindGroups.length).toBe(1);
    expect(bindGroups[0].entries.length).toBe(4);
  });

  it("dispatch is a no-op for zero-length input", async function () {
    const { device, writes } = makeMockDevice();
    const scan = new WebGPUDecoupledScan(device, { maxElements: 1024 });
    await scan.initialize("/* wgsl stub */");

    const encoder = makeMockEncoder();
    const buf = device.createBuffer({ size: 4, usage: 0, label: "x" });
    expect(scan.dispatch(encoder, buf, buf, 0)).toBe(true);
    expect(encoder.passes.length).toBe(0);
    // zero-length also shouldn't emit param/partition writes beyond
    // whatever ensureCapacity may have done on init.
    expect(writes.length).toBe(0);
  });

  it("dispatch returns false after destroy()", async function () {
    const { device } = makeMockDevice();
    const scan = new WebGPUDecoupledScan(device, { maxElements: 1024 });
    await scan.initialize("/* wgsl stub */");
    scan.destroy();
    expect(scan.isDestroyed).toBe(true);

    const encoder = makeMockEncoder();
    const buf = device.createBuffer({ size: 4, usage: 0, label: "x" });
    expect(scan.dispatch(encoder, buf, buf, 128)).toBe(false);
  });
});
