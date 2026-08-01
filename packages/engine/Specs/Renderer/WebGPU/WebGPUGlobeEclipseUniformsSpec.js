import {
  ECLIPSE_UNIFORM_BYTES,
  isActiveEclipseUniformBlock,
  WebGPUGlobeEclipseUniforms,
} from "../../../Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.js";

if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    COPY_DST: 0x0008,
    UNIFORM: 0x0040,
  };
}

function makeDevice() {
  let nextBuffer = 1;
  const writes = [];
  const device = {
    createBuffer(descriptor) {
      return {
        id: nextBuffer++,
        descriptor,
        destroy() {},
      };
    },
    queue: {
      writeBuffer(...args) {
        writes.push(args);
      },
    },
  };
  return { device, writes };
}

function makeActiveBlock() {
  return {
    revision: 7,
    sunDirectionAndInvRange: { x: 1.0, y: 0.0, z: 0.0, w: 1.0e-11 },
    moonDirectionDeltaAndInvRange: {
      x: 0.0,
      y: 1.0e-4,
      z: 0.0,
      w: 2.6e-9,
    },
    params: { x: 2.0, y: 1.0, z: 0.1, w: 0.2 },
    params2: { x: 5.0e-5, y: 1.0 / 3.0, z: 0.0, w: 0.3 },
  };
}

describe("Renderer/WebGPU/WebGPUGlobeEclipseUniforms", function () {
  it("reuses one inert buffer without touching the frame ring", function () {
    const { device } = makeDevice();
    let allocations = 0;
    const allocator = {
      allocationEpoch: 1,
      allocateAndWrite() {
        allocations++;
        return { buffer: {}, offset: 0 };
      },
    };
    const frameState = {
      context: { uniformAllocator: allocator },
      frameNumber: 10,
      eclipseGlobeShadow: {
        ...makeActiveBlock(),
        params: { x: 0.0, y: 1.0, z: 0.0, w: 0.0 },
      },
    };
    const uniforms = new WebGPUGlobeEclipseUniforms();

    const first = uniforms.prepare(device, frameState);
    allocator.allocationEpoch++;
    const second = uniforms.prepare(device, frameState);

    expect(second).toBe(first);
    expect(first.offset).toBe(0);
    expect(first.size).toBe(ECLIPSE_UNIFORM_BYTES);
    expect(allocations).toBe(0);
    uniforms.destroy();
  });

  it("invalidates an active slice when a pick mini-frame advances the allocator epoch", function () {
    const { device } = makeDevice();
    const ringBuffer = {};
    let allocations = 0;
    let nextOffset = 0;
    const allocator = {
      allocationEpoch: 4,
      allocateAndWrite(data, size) {
        allocations++;
        const offset = nextOffset;
        nextOffset += 256;
        return {
          // One backing page with aligned slices inside an allocation epoch.
          buffer: ringBuffer,
          offset,
          size,
          data,
        };
      },
    };
    const frameState = {
      context: { uniformAllocator: allocator },
      // A standalone pick mini-frame does not advance this value.
      frameNumber: 20,
      eclipseGlobeShadow: makeActiveBlock(),
    };
    const uniforms = new WebGPUGlobeEclipseUniforms();

    const sceneSlice = uniforms.prepare(device, frameState);
    const sameWindowSlice = uniforms.prepare(device, frameState);
    expect(sameWindowSlice).toBe(sceneSlice);
    expect(allocations).toBe(1);

    frameState.eclipseGlobeShadow = {
      ...makeActiveBlock(),
      revision: 8,
    };
    const secondViewSlice = uniforms.prepare(device, frameState);
    expect(secondViewSlice).not.toBe(sceneSlice);
    expect(allocations).toBe(2);

    frameState.eclipseGlobeShadow = makeActiveBlock();
    allocator.allocationEpoch++;
    // Model a page-count wrap: a new allocation epoch may revisit the same
    // backing buffer and the same first offset.
    nextOffset = 0;
    const pickSlice = uniforms.prepare(device, frameState);
    expect(pickSlice).not.toBe(sceneSlice);
    expect(pickSlice.buffer).toBe(sceneSlice.buffer);
    expect(pickSlice.offset).toBe(sceneSlice.offset);
    expect(allocations).toBe(3);
    uniforms.destroy();
  });

  it("never memoizes across calls when the allocation window is unknowable", function () {
    const { device } = makeDevice();
    let allocations = 0;
    const allocator = {
      allocateAndWrite(data, size) {
        allocations++;
        return { buffer: {}, offset: 0, size, data };
      },
    };
    const frameState = {
      context: { uniformAllocator: allocator },
      // frameNumber is intentionally stable: it is not a safe ring-lifetime
      // boundary because standalone pick mini-frames do not advance it.
      frameNumber: 30,
      eclipseGlobeShadow: makeActiveBlock(),
    };
    const uniforms = new WebGPUGlobeEclipseUniforms();

    const first = uniforms.prepare(device, frameState);
    const second = uniforms.prepare(device, frameState);

    expect(second).not.toBe(first);
    expect(allocations).toBe(2);
    uniforms.destroy();
  });

  it("uses command encoder identity as the compatibility allocation window", function () {
    const { device } = makeDevice();
    let allocations = 0;
    const allocator = {
      allocateAndWrite(data, size) {
        allocations++;
        return { buffer: {}, offset: 0, size, data };
      },
    };
    const frameState = {
      context: {
        uniformAllocator: allocator,
        currentCommandEncoder: {},
      },
      frameNumber: 40,
      eclipseGlobeShadow: makeActiveBlock(),
    };
    const uniforms = new WebGPUGlobeEclipseUniforms();

    const first = uniforms.prepare(device, frameState);
    expect(uniforms.prepare(device, frameState)).toBe(first);
    expect(allocations).toBe(1);

    frameState.context.currentCommandEncoder = {};
    expect(uniforms.prepare(device, frameState)).not.toBe(first);
    expect(allocations).toBe(2);
    uniforms.destroy();
  });

  it("packs SunLight and custom-light correction-only blocks without body rays", function () {
    const { device } = makeDevice();
    const packed = [];
    const allocator = {
      allocationEpoch: 1,
      allocateAndWrite(data, size) {
        packed.push(Array.from(data));
        return { buffer: {}, offset: packed.length * 256, size };
      },
    };
    const uniforms = new WebGPUGlobeEclipseUniforms();

    for (const gate of [3.0, 4.0]) {
      const block = {
        ...makeActiveBlock(),
        revision: gate,
        sunDirectionAndInvRange: { x: 0.0, y: 0.0, z: 0.0, w: 0.0 },
        moonDirectionDeltaAndInvRange: {
          x: 0.0,
          y: 0.0,
          z: 0.0,
          w: 0.0,
        },
        params: { x: gate, y: 2.0, z: 0.0, w: 0.0 },
        params2: { x: 5.0e-5, y: 1.0 / 3.0, z: 0.0, w: 0.0 },
      };
      expect(isActiveEclipseUniformBlock(block)).toBe(true);
      uniforms.prepare(device, {
        context: { uniformAllocator: allocator },
        eclipseGlobeShadow: block,
      });
    }

    expect(packed.length).toBe(2);
    expect(packed[0].slice(0, 8)).toEqual([
      0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
    ]);
    expect(packed[0][8]).toBe(3.0);
    expect(packed[1][8]).toBe(4.0);
    expect(packed[0][9]).toBe(2.0);
    expect(packed[1][9]).toBe(2.0);
    uniforms.destroy();
  });
});
