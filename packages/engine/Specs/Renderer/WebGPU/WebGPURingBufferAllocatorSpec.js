import { WebGPURingBufferAllocator } from "../../../Source/Renderer/WebGPU/WebGPURingBufferAllocator.js";

// Mock GPUBuffer / GPUDevice that records buffer creations and queue writes.
// The allocator never actually executes GPU work — it only sub-allocates byte
// ranges from buffers it asked the device to create — so we can run the full
// suite without a real device. This keeps the spec environment-portable
// (Jasmine in headless Node, Karma, browsers without WebGPU).
function makeMockDevice() {
  const created = [];
  const writes = [];
  const device = {
    createBuffer(desc) {
      const buffer = {
        size: desc.size,
        usage: desc.usage,
        label: desc.label,
        destroyed: false,
        destroy() {
          this.destroyed = true;
        },
      };
      created.push(buffer);
      return buffer;
    },
    queue: {
      writeBuffer(buffer, offset, source, srcOffset, byteLength) {
        writes.push({ buffer, offset, source, srcOffset, byteLength });
      },
    },
  };
  return { device, created, writes };
}

// The allocator references the global GPUBufferUsage enum on construction
// when the caller doesn't pass an explicit `usage`. Provide a numeric stand-in
// that matches the WebGPU spec values so default-construction works in Node.
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

describe("Renderer/WebGPU/WebGPURingBufferAllocator", function () {
  it("pre-creates `pageCount` pages on construction", function () {
    const { device, created } = makeMockDevice();
    // The constructor's only observable side-effect is the device.createBuffer
    // calls it makes for each page; the allocator itself isn't read here.
    const allocator = new WebGPURingBufferAllocator(device, {
      pageSize: 4096,
      pageCount: 3,
    });
    expect(allocator).toBeDefined();
    expect(created.length).toBe(3);
    for (const buf of created) {
      expect(buf.size).toBe(4096);
    }
  });

  it("rotates to the next page on each beginFrame", function () {
    const { device } = makeMockDevice();
    const alloc = new WebGPURingBufferAllocator(device, {
      pageSize: 4096,
      pageCount: 3,
    });
    const pageIndices = [];
    for (let i = 0; i < 6; i++) {
      alloc.beginFrame();
      pageIndices.push(alloc.allocate(64).pageIndex);
      alloc.endFrame();
    }
    // Ring of 3 pages → indices should cycle 1,2,0,1,2,0 (start advances to 1
    // because beginFrame is called BEFORE the first allocation each frame).
    expect(pageIndices).toEqual([1, 2, 0, 1, 2, 0]);
  });

  it("aligns offsets to minAlignment and sizes to 4 bytes", function () {
    const { device } = makeMockDevice();
    const alloc = new WebGPURingBufferAllocator(device, {
      pageSize: 8192,
      pageCount: 2,
      minAlignment: 256,
    });
    alloc.beginFrame();
    const a = alloc.allocate(100);
    const b = alloc.allocate(100);
    // Offsets are rounded up to minAlignment (256) via _alignOffset so each
    // allocation begins on a UBO-bindable boundary (WebGPURingBufferAllocator
    // .ts:340-342). Reported sizes are rounded only to 4 bytes via _alignSize
    // (WebGPURingBufferAllocator.ts:348-350) — WebGPU requires writeBuffer /
    // copy byteLength to be a 4-byte multiple, but does NOT require allocation
    // size to be padded to minAlignment. The next allocation's offset is
    // re-aligned to 256 regardless of the prior size, which is what guarantees
    // b.offset === 256.
    expect(a.offset).toBe(0);
    expect(a.size).toBe(100); // 100 is already a 4-byte multiple
    expect(b.offset).toBe(256); // offset re-aligned to next 256 boundary
    expect(b.size).toBe(100);
    alloc.endFrame();
  });

  it("creates an overflow page when the current page is full", function () {
    const { device, created } = makeMockDevice();
    const alloc = new WebGPURingBufferAllocator(device, {
      pageSize: 512,
      pageCount: 2,
      minAlignment: 256,
    });
    expect(created.length).toBe(2);

    alloc.beginFrame();
    alloc.allocate(256); // fills slot 0..255
    alloc.allocate(256); // fills slot 256..511 → page is now exactly full
    const overflow = alloc.allocate(256); // forces overflow
    expect(created.length).toBe(3);
    expect(overflow.pageIndex).toBe(2);
    expect(alloc.getStats().overflowCount).toBe(1);
    alloc.endFrame();
  });

  it("tracks peak usage across frames", function () {
    const { device } = makeMockDevice();
    const alloc = new WebGPURingBufferAllocator(device, {
      pageSize: 4096,
      pageCount: 2,
      minAlignment: 256,
    });
    alloc.beginFrame();
    alloc.allocate(256);
    alloc.endFrame();

    alloc.beginFrame();
    alloc.allocate(256);
    alloc.allocate(256);
    alloc.allocate(256); // 3 × 256 = 768 bytes — peak frame
    alloc.endFrame();

    alloc.beginFrame(); // beginFrame is what samples the previous frame's peak
    expect(alloc.getStats().peakFrameUsage).toBe(768);
    alloc.endFrame();
  });

  it("allocateAndWrite stages typed arrays until flush", function () {
    const { device, writes } = makeMockDevice();
    const alloc = new WebGPURingBufferAllocator(device, {
      pageSize: 4096,
      pageCount: 2,
    });
    alloc.beginFrame();
    const data = new Float32Array([1, 2, 3, 4]);
    const result = alloc.allocateAndWrite(data);
    expect(writes.length).toBe(0);
    alloc.flush();
    expect(writes.length).toBe(1);
    expect(writes[0].buffer).toBe(result.buffer);
    expect(writes[0].offset).toBe(result.offset);
    expect(writes[0].byteLength).toBe(data.byteLength);
    expect(
      Array.from(
        new Float32Array(writes[0].source, writes[0].srcOffset, data.length),
      ),
    ).toEqual(Array.from(data));
    alloc.endFrame();
  });

  it("coalesces multiple allocations on one page into one queue write", function () {
    const { device, writes } = makeMockDevice();
    const alloc = new WebGPURingBufferAllocator(device, {
      pageSize: 4096,
      pageCount: 2,
      minAlignment: 256,
    });
    alloc.beginFrame();
    alloc.allocateAndWrite(new Uint32Array([0x11223344]));
    alloc.allocateAndWrite(new Uint32Array([0x55667788]));
    alloc.flush();
    expect(writes.length).toBe(1);
    expect(writes[0].offset).toBe(0);
    expect(writes[0].byteLength).toBe(260);
    alloc.flush();
    expect(writes.length).toBe(1);
    alloc.endFrame();
  });

  it("flushes every dirty page when staged writes overflow", function () {
    const { device, writes } = makeMockDevice();
    const alloc = new WebGPURingBufferAllocator(device, {
      pageSize: 512,
      pageCount: 2,
      minAlignment: 256,
    });
    alloc.beginFrame();
    const first = alloc.allocateAndWrite(new Uint8Array(300).fill(1));
    const second = alloc.allocateAndWrite(new Uint8Array(300).fill(2));
    expect(first.pageIndex).not.toBe(second.pageIndex);

    alloc.flush();

    expect(writes.length).toBe(2);
    expect(writes[0].buffer).toBe(first.buffer);
    expect(writes[0].byteLength).toBe(300);
    expect(writes[1].buffer).toBe(second.buffer);
    expect(writes[1].byteLength).toBe(300);
    alloc.endFrame();
  });

  it("does not upload unwritten tail padding from a wider binding", function () {
    const { device, writes } = makeMockDevice();
    const alloc = new WebGPURingBufferAllocator(device, {
      pageSize: 4096,
      pageCount: 2,
      minAlignment: 256,
    });
    alloc.beginFrame();
    const payload = new Uint32Array([0x12345678]);
    const result = alloc.allocateAndWrite(payload, 192);
    alloc.flush();

    expect(result.size).toBe(192);
    expect(writes.length).toBe(1);
    expect(writes[0].byteLength).toBe(payload.byteLength);
    alloc.endFrame();
  });
});
