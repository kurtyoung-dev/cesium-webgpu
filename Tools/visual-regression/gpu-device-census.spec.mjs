// gpu-device-census.spec.mjs - lane KT round 2 (Lebennin). Pure Node: no browser, no GPU.
// @purpose In-page GPU device census asserts live texture and buffer counts, estimated bytes, compile timing, and device destruction lifecycle.
// @status ACTIVE
//
// Covers behaviours C1, C2, C3, C4, and C5. C6 (owner label forms) is the lead's
// ROUND 4 addition for the seat's item F6 (Celos), written from the item text;
// C7 (the pipeline census) the lead's ROUND 5 addition for K5-3.
// Written from _lane-out/BEHAVIOUR_CELOS.md.

import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import {
  GPU_DEVICE_CENSUS_INIT_SOURCE,
  PIPELINE_ROW_KINDS,
  emptyGpuDeviceCensus,
  liveRowsForLabels,
  parseOwnerLabel,
  readGpuDeviceCensus,
  textureByteSize,
} from "./lib/gpu-device-census.mjs";

function createFakeWebGPU() {
  class FakeGPUTexture {
    constructor(descriptor = {}) {
      this.descriptor = descriptor;
      this.destroyed = false;
      this.destroyCalls = 0;
    }

    destroy() {
      this.destroyed = true;
      this.destroyCalls++;
    }
  }

  class FakeGPUBuffer {
    constructor(descriptor = {}) {
      this.descriptor = descriptor;
      this.destroyed = false;
      this.destroyCalls = 0;
    }

    destroy() {
      this.destroyed = true;
      this.destroyCalls++;
    }
  }

  class FakeGPUDevice {
    constructor(label = "device") {
      this.label = label;
      this.destroyed = false;
      this.destroyCalls = 0;
      this.calls = [];
    }

    createTexture(descriptor) {
      this.calls.push({ method: "createTexture", descriptor });
      return new FakeGPUTexture(descriptor);
    }

    createBuffer(descriptor) {
      this.calls.push({ method: "createBuffer", descriptor });
      return new FakeGPUBuffer(descriptor);
    }

    createShaderModule(descriptor) {
      this.calls.push({ method: "createShaderModule", descriptor });
      return { descriptor };
    }

    createRenderPipeline(descriptor) {
      this.calls.push({ method: "createRenderPipeline", descriptor });
      return { descriptor };
    }

    createComputePipeline(descriptor) {
      this.calls.push({ method: "createComputePipeline", descriptor });
      return { descriptor };
    }

    async createRenderPipelineAsync(descriptor) {
      this.calls.push({ method: "createRenderPipelineAsync", descriptor });
      if (descriptor && descriptor.fail) {
        throw new Error("Render pipeline creation failed");
      }
      return { descriptor };
    }

    async createComputePipelineAsync(descriptor) {
      this.calls.push({ method: "createComputePipelineAsync", descriptor });
      if (descriptor && descriptor.fail) {
        throw new Error("Compute pipeline creation failed");
      }
      return { descriptor };
    }

    destroy() {
      this.destroyed = true;
      this.destroyCalls++;
      this.calls.push({ method: "destroy" });
    }
  }

  return { FakeGPUDevice, FakeGPUTexture, FakeGPUBuffer };
}

function cleanupGlobals() {
  delete globalThis.__gpuDeviceCensus;
  delete globalThis.GPUDevice;
  delete globalThis.GPUTexture;
  delete globalThis.GPUBuffer;
}

function installCensusWithFakes() {
  cleanupGlobals();
  const fakes = createFakeWebGPU();
  globalThis.GPUDevice = fakes.FakeGPUDevice;
  globalThis.GPUTexture = fakes.FakeGPUTexture;
  globalThis.GPUBuffer = fakes.FakeGPUBuffer;
  vm.runInThisContext(GPU_DEVICE_CENSUS_INIT_SOURCE);
  return {
    ...fakes,
    census: globalThis.__gpuDeviceCensus,
  };
}

test.afterEach(() => {
  cleanupGlobals();
});

// C1: Page initialization, tracking live textures/buffers, repeated destroy, fallbacks

test("C1: installs globalThis.__gpuDeviceCensus with installed: true", () => {
  const { census } = installCensusWithFakes();
  assert.ok(census, "census must be defined on globalThis");
  assert.equal(census.installed, true);
  assert.equal(census.textures.created, 0);
  assert.equal(census.textures.destroyed, 0);
  assert.equal(census.textures.liveBytes, 0);
  assert.equal(census.buffers.created, 0);
  assert.equal(census.buffers.destroyed, 0);
  assert.equal(census.buffers.liveBytes, 0);
  assert.equal(census.repeatedDestroys, 0);
  assert.deepEqual(census.byLabel, {});
});

test("C1: installs with installed: false when WebGPU classes are absent", () => {
  cleanupGlobals();
  vm.runInThisContext(GPU_DEVICE_CENSUS_INIT_SOURCE);
  assert.ok(globalThis.__gpuDeviceCensus);
  assert.equal(globalThis.__gpuDeviceCensus.installed, false);
});

test("C1: installing twice is a no-op and does not double-count", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();
  dev.createTexture({ size: [16, 16], format: "rgba8unorm" });
  assert.equal(census.textures.created, 1);

  // Evaluate init source second time
  vm.runInThisContext(GPU_DEVICE_CENSUS_INIT_SOURCE);
  assert.equal(globalThis.__gpuDeviceCensus, census);
  assert.equal(census.textures.created, 1);
});

test("C1: wrapped methods reach originals and return their results", () => {
  const { FakeGPUDevice, FakeGPUTexture, FakeGPUBuffer } =
    installCensusWithFakes();
  const dev = new FakeGPUDevice();
  const texDesc = { size: [32, 32], format: "rgba8unorm", label: "color" };
  const tex = dev.createTexture(texDesc);
  assert.ok(tex instanceof FakeGPUTexture);
  assert.equal(dev.calls.filter((c) => c.method === "createTexture").length, 1);

  const bufDesc = { size: 512, label: "indices" };
  const buf = dev.createBuffer(bufDesc);
  assert.ok(buf instanceof FakeGPUBuffer);
  assert.equal(dev.calls.filter((c) => c.method === "createBuffer").length, 1);
});

test("C1: textures created and destroyed move created, destroyed, and liveBytes", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();
  const tex = dev.createTexture({
    size: [16, 16],
    format: "rgba8unorm",
    label: "sky",
  });
  // 16 * 16 * 4 bytes = 1024
  assert.equal(census.textures.created, 1);
  assert.equal(census.textures.destroyed, 0);
  assert.equal(census.textures.createdBytes, 1024);
  assert.equal(census.textures.liveBytes, 1024);
  assert.equal(census.byLabel["texture:sky"].created, 1);
  assert.equal(census.byLabel["texture:sky"].destroyed, 0);
  assert.equal(census.byLabel["texture:sky"].liveBytes, 1024);

  tex.destroy();
  assert.equal(tex.destroyed, true);
  assert.equal(census.textures.created, 1);
  assert.equal(census.textures.destroyed, 1);
  assert.equal(census.textures.liveBytes, 0);
  assert.equal(census.byLabel["texture:sky"].destroyed, 1);
  assert.equal(census.byLabel["texture:sky"].liveBytes, 0);
});

test("C1: buffers created and destroyed move created, destroyed, and liveBytes", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();
  const buf = dev.createBuffer({ size: 2048, label: "uniforms" });

  assert.equal(census.buffers.created, 1);
  assert.equal(census.buffers.destroyed, 0);
  assert.equal(census.buffers.createdBytes, 2048);
  assert.equal(census.buffers.liveBytes, 2048);
  assert.equal(census.byLabel["buffer:uniforms"].created, 1);
  assert.equal(census.byLabel["buffer:uniforms"].destroyed, 0);
  assert.equal(census.byLabel["buffer:uniforms"].liveBytes, 2048);

  buf.destroy();
  assert.equal(buf.destroyed, true);
  assert.equal(census.buffers.created, 1);
  assert.equal(census.buffers.destroyed, 1);
  assert.equal(census.buffers.liveBytes, 0);
  assert.equal(census.byLabel["buffer:uniforms"].destroyed, 1);
  assert.equal(census.byLabel["buffer:uniforms"].liveBytes, 0);
});

test("C1: a second destroy of the same resource increments repeatedDestroys only", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();
  const tex = dev.createTexture({
    size: [16, 16],
    format: "rgba8unorm",
    label: "tile",
  });

  tex.destroy();
  assert.equal(census.repeatedDestroys, 0);
  const snapTextures = { ...census.textures };
  const snapLabel = { ...census.byLabel["texture:tile"] };

  tex.destroy();
  assert.equal(census.repeatedDestroys, 1);
  assert.equal(census.textures.destroyed, snapTextures.destroyed);
  assert.equal(census.textures.liveBytes, snapTextures.liveBytes);
  assert.equal(census.byLabel["texture:tile"].destroyed, snapLabel.destroyed);
  assert.equal(census.byLabel["texture:tile"].liveBytes, snapLabel.liveBytes);

  tex.destroy();
  assert.equal(census.repeatedDestroys, 2);
});

test("C1: readGpuDeviceCensus reads page census or empty census fallback", async () => {
  const { census } = installCensusWithFakes();
  const fakePage = { evaluate: async (fn) => fn() };

  const readInstalled = await readGpuDeviceCensus(fakePage);
  assert.equal(readInstalled.installed, true);
  assert.deepEqual(readInstalled.textures, census.textures);

  cleanupGlobals();
  const readEmpty = await readGpuDeviceCensus(fakePage);
  assert.equal(readEmpty.installed, false);
  assert.deepEqual(readEmpty, emptyGpuDeviceCensus());
});

// C2: Texture byte sizing, mip chains, block compression, MSAA, 3D, and unknown formats

test("C2: textureByteSize sums w*h*bpp over mip chain for uncompressed 2D", () => {
  // 256x256 rgba8unorm with 9 mips:
  // 256*256*4 + 128*128*4 + 64*64*4 + 32*32*4 + 16*16*4 + 8*8*4 + 4*4*4 + 2*2*4 + 1*1*4 = 349,524
  const res9 = textureByteSize({
    size: [256, 256],
    format: "rgba8unorm",
    mipLevelCount: 9,
  });
  assert.deepEqual(res9, { bytes: 349524, format: "rgba8unorm" });

  // Object-shaped size: { width: 128, height: 128 }, 1 mip, r8unorm (1 byte/texel) = 16,384
  const resObj = textureByteSize({
    size: { width: 128, height: 128 },
    format: "r8unorm",
  });
  assert.deepEqual(resObj, { bytes: 16384, format: "r8unorm" });

  // 16-bit format: rgba16float (8 bytes/texel), 16x16, 1 mip = 16*16*8 = 2048
  const res16 = textureByteSize({
    size: [16, 16],
    format: "rgba16float",
  });
  assert.deepEqual(res16, { bytes: 2048, format: "rgba16float" });
});

test("C2: textureByteSize sizes block-compressed formats by 4x4 blocks", () => {
  // bc1-rgba-unorm: 8 bytes per 4x4 block
  // 64x64, 1 mip: ceil(64/4)*ceil(64/4)*8 = 16*16*8 = 2048 bytes
  assert.deepEqual(
    textureByteSize({ size: [64, 64], format: "bc1-rgba-unorm" }),
    { bytes: 2048, format: "bc1-rgba-unorm" },
  );

  // Non-multiple of 4: 10x10, 1 mip: ceil(10/4)*ceil(10/4)*8 = 3*3*8 = 72 bytes
  assert.deepEqual(
    textureByteSize({ size: [10, 10], format: "bc1-rgba-unorm" }),
    { bytes: 72, format: "bc1-rgba-unorm" },
  );

  // bc7-rgba-unorm: 16 bytes per 4x4 block, 32x32, 2 mips
  // Mip 0: 8*8*16 = 1024; Mip 1: 4*4*16 = 256; Total = 1280
  assert.deepEqual(
    textureByteSize({
      size: [32, 32],
      format: "bc7-rgba-unorm",
      mipLevelCount: 2,
    }),
    { bytes: 1280, format: "bc7-rgba-unorm" },
  );

  // astc-4x4-unorm: 16 bytes per 4x4 block, 16x16, 1 mip = 4*4*16 = 256 bytes
  assert.deepEqual(
    textureByteSize({ size: [16, 16], format: "astc-4x4-unorm" }),
    { bytes: 256, format: "astc-4x4-unorm" },
  );

  // etc2-rgb8unorm: 8 bytes per 4x4 block, 16x16, 1 mip = 4*4*8 = 128 bytes
  assert.deepEqual(
    textureByteSize({ size: [16, 16], format: "etc2-rgb8unorm" }),
    { bytes: 128, format: "etc2-rgb8unorm" },
  );
});

test("C2: textureByteSize multiplies byte size by sampleCount", () => {
  // 100x100 rgba8unorm (4 bpp), 1 mip = 40,000 bytes. With sampleCount 4 = 160,000 bytes.
  assert.deepEqual(
    textureByteSize({
      size: [100, 100],
      format: "rgba8unorm",
      sampleCount: 4,
    }),
    { bytes: 160000, format: "rgba8unorm" },
  );
});

test("C2: textureByteSize halves depth per mip level for 3D textures", () => {
  // 3D texture: 64x64x16, 3 mips, r8unorm (1 byte/texel)
  // Mip 0: 64*64*16 = 65,536
  // Mip 1: 32*32*8  = 8,192
  // Mip 2: 16*16*4  = 1,024
  // Total = 74,752
  assert.deepEqual(
    textureByteSize({
      dimension: "3d",
      size: [64, 64, 16],
      format: "r8unorm",
      mipLevelCount: 3,
    }),
    { bytes: 74752, format: "r8unorm" },
  );

  // Compare 2D array texture: layers do not halve per mip
  // Mip 0: 64*64*16 = 65,536
  // Mip 1: 32*32*16 = 16,384
  // Mip 2: 16*16*16 = 4,096
  // Total = 86,016
  assert.deepEqual(
    textureByteSize({
      dimension: "2d",
      size: [64, 64, 16],
      format: "r8unorm",
      mipLevelCount: 3,
    }),
    { bytes: 86016, format: "r8unorm" },
  );
});

test("C2: textureByteSize returns bytes null for unknown format or invalid size", () => {
  assert.deepEqual(
    textureByteSize({ size: [64, 64], format: "non-existent-fmt" }),
    { bytes: null, format: "non-existent-fmt" },
  );
  assert.deepEqual(textureByteSize(null), { bytes: null, format: null });
  assert.deepEqual(textureByteSize({ size: [0, 64], format: "rgba8unorm" }), {
    bytes: null,
    format: "rgba8unorm",
  });
});

test("C2: texture of unknown format is counted in unknownSize and adds no bytes", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();
  dev.createTexture({
    size: [32, 32],
    format: "non-existent-fmt",
    label: "mystery",
  });

  assert.equal(census.textures.created, 1);
  assert.equal(census.textures.unknownSize, 1);
  assert.equal(census.textures.createdBytes, 0);
  assert.equal(census.textures.liveBytes, 0);
  assert.equal(census.byLabel["texture:mystery"].liveBytes, 0);
});

// C3: Shader module and pipeline creation timing

test("C3: synchronous shaderModule creation increments count and adds syncMs", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();

  dev.createShaderModule({ code: "fn main() {}" });
  assert.equal(census.compile.shaderModules.count, 1);
  assert.ok(census.compile.shaderModules.syncMs >= 0);
  assert.ok(
    census.compile.firstCreateAtMs !== null &&
      census.compile.firstCreateAtMs >= 0,
  );
});

test("C3: synchronous pipeline creations increment count and add syncMs", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();

  dev.createRenderPipeline({ layout: "auto" });
  assert.equal(census.compile.renderPipelines.count, 1);
  assert.ok(census.compile.renderPipelines.syncMs >= 0);

  dev.createComputePipeline({ layout: "auto" });
  assert.equal(census.compile.computePipelines.count, 1);
  assert.ok(census.compile.computePipelines.syncMs >= 0);
});

test("C3: async pipeline resolution increments count, settled, and totalSettleMs", async () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();

  const promise = dev.createRenderPipelineAsync({ layout: "auto" });
  assert.equal(census.compile.renderPipelinesAsync.count, 1);
  await promise;

  assert.equal(census.compile.renderPipelinesAsync.settled, 1);
  assert.equal(census.compile.renderPipelinesAsync.rejected, 0);
  assert.ok(census.compile.renderPipelinesAsync.totalSettleMs >= 0);
});

test("C3: async pipeline rejection increments count, settled, rejected, and totalSettleMs", async () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();

  const promise = dev.createComputePipelineAsync({ fail: true });
  assert.equal(census.compile.computePipelinesAsync.count, 1);
  await assert.rejects(async () => await promise);

  assert.equal(census.compile.computePipelinesAsync.settled, 1);
  assert.equal(census.compile.computePipelinesAsync.rejected, 1);
  assert.ok(census.compile.computePipelinesAsync.totalSettleMs >= 0);
});

test("C3: firstCreateAtMs and lastSettleAtMs bound compile timing", async () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();

  assert.equal(census.compile.firstCreateAtMs, null);
  assert.equal(census.compile.lastSettleAtMs, null);

  dev.createShaderModule({ code: "" });
  const first = census.compile.firstCreateAtMs;
  assert.ok(first !== null && first >= 0);

  await dev.createRenderPipelineAsync({});
  const last = census.compile.lastSettleAtMs;
  assert.ok(last !== null && last >= 0);
  assert.ok(last >= first);
});

// C4: Live rows by label, freedByDevice deduction, and unseen label zeroes

test("C4: liveRowsForLabels returns live = created - destroyed - freedByDevice with separate counts", () => {
  const census = {
    byLabel: {
      "texture:clouds": {
        kind: "texture",
        label: "clouds",
        created: 5,
        destroyed: 2,
        freedByDevice: 1,
        liveBytes: 1000,
      },
      "buffer:water": {
        kind: "buffer",
        label: "water",
        created: 3,
        destroyed: 1,
        freedByDevice: 0,
        liveBytes: 500,
      },
    },
  };

  const rows = liveRowsForLabels(census, ["clouds", "water"]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    label: "clouds",
    kind: "texture",
    created: 5,
    destroyed: 2,
    freedByDevice: 1,
    live: 2,
    liveBytes: 1000,
    seen: true,
  });
  assert.deepEqual(rows[1], {
    label: "water",
    kind: "buffer",
    created: 3,
    destroyed: 1,
    freedByDevice: 0,
    live: 2,
    liveBytes: 500,
    seen: true,
  });
});

test("C4: liveRowsForLabels returns seen: false and zero row for uncreated label", () => {
  const census = { byLabel: {} };
  const rows = liveRowsForLabels(census, ["unseen"]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    label: "unseen",
    kind: null,
    created: 0,
    destroyed: 0,
    freedByDevice: 0,
    live: 0,
    liveBytes: 0,
    seen: false,
  });
});

test("C4: liveRowsForLabels returns separate rows when label is shared by texture and buffer", () => {
  const census = {
    byLabel: {
      "texture:shared": {
        kind: "texture",
        label: "shared",
        created: 1,
        destroyed: 0,
        freedByDevice: 0,
        liveBytes: 100,
      },
      "buffer:shared": {
        kind: "buffer",
        label: "shared",
        created: 2,
        destroyed: 1,
        freedByDevice: 0,
        liveBytes: 200,
      },
    },
  };

  const rows = liveRowsForLabels(census, ["shared"]);
  assert.equal(rows.length, 2);
  const texRow = rows.find((r) => r.kind === "texture");
  const bufRow = rows.find((r) => r.kind === "buffer");
  assert.ok(texRow);
  assert.ok(bufRow);
  assert.equal(texRow.freedByDevice, 0);
  assert.equal(bufRow.freedByDevice, 0);
  assert.equal(texRow.live, 1);
  assert.equal(bufRow.live, 1);
});

// C5 (ROUND 2): GPUDevice.prototype.destroy wrapping, freedByDevice, and multi-device lifecycle

test("C5: emptyGpuDeviceCensus carries freedByDevice and devicesDestroyed at 0", () => {
  const empty = emptyGpuDeviceCensus();
  assert.equal(empty.devicesDestroyed, 0);
  assert.equal(empty.textures.freedByDevice, 0);
  assert.equal(empty.buffers.freedByDevice, 0);
});

test("C5: destroying device calls original destroy and increments devicesDestroyed once", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice("dev1");

  assert.equal(dev.destroyed, false);
  assert.equal(census.devicesDestroyed, 0);

  dev.destroy();
  assert.equal(dev.destroyed, true);
  assert.equal(dev.destroyCalls, 1);
  assert.equal(census.devicesDestroyed, 1);
});

test("C5: destroying device moves undestroyed resources into freedByDevice and clears liveBytes", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();

  const tex1 = dev.createTexture({
    size: [16, 16],
    format: "rgba8unorm",
    label: "t1",
  }); // 1024 bytes
  dev.createTexture({
    size: [16, 16],
    format: "rgba8unorm",
    label: "t2",
  }); // 1024 bytes
  dev.createBuffer({ size: 512, label: "b1" }); // 512 bytes

  tex1.destroy(); // Explicit destroy
  assert.equal(census.textures.destroyed, 1);
  assert.equal(census.textures.liveBytes, 1024);
  assert.equal(census.buffers.liveBytes, 512);

  dev.destroy(); // Device destroy

  assert.equal(
    census.textures.destroyed,
    1,
    "destroyed count must not move on device destroy",
  );
  assert.equal(
    census.textures.freedByDevice,
    1,
    "undestroyed texture moves to freedByDevice",
  );
  assert.equal(
    census.textures.liveBytes,
    0,
    "freed texture bytes leave liveBytes",
  );
  assert.equal(census.byLabel["texture:t2"].freedByDevice, 1);
  assert.equal(census.byLabel["texture:t2"].destroyed, 0);
  assert.equal(census.byLabel["texture:t2"].liveBytes, 0);

  assert.equal(
    census.buffers.destroyed,
    0,
    "destroyed count must not move on device destroy",
  );
  assert.equal(
    census.buffers.freedByDevice,
    1,
    "undestroyed buffer moves to freedByDevice",
  );
  assert.equal(
    census.buffers.liveBytes,
    0,
    "freed buffer bytes leave liveBytes",
  );
  assert.equal(census.byLabel["buffer:b1"].freedByDevice, 1);
  assert.equal(census.byLabel["buffer:b1"].destroyed, 0);
  assert.equal(census.byLabel["buffer:b1"].liveBytes, 0);
});

test("C5: destroying one device leaves resources of another live device untouched", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const devA = new FakeGPUDevice("devA");
  const devB = new FakeGPUDevice("devB");

  devA.createTexture({
    size: [16, 16],
    format: "rgba8unorm",
    label: "texA",
  }); // 1024 bytes
  devB.createTexture({
    size: [32, 32],
    format: "rgba8unorm",
    label: "texB",
  }); // 4096 bytes
  devB.createBuffer({ size: 256, label: "bufB" });

  assert.equal(census.textures.created, 2);
  assert.equal(census.textures.liveBytes, 5120);

  devA.destroy();

  assert.equal(census.devicesDestroyed, 1);
  assert.equal(census.textures.freedByDevice, 1);
  assert.equal(census.byLabel["texture:texA"].freedByDevice, 1);
  assert.equal(census.byLabel["texture:texA"].liveBytes, 0);

  assert.equal(census.byLabel["texture:texB"].freedByDevice, 0);
  assert.equal(census.byLabel["texture:texB"].destroyed, 0);
  assert.equal(census.byLabel["texture:texB"].liveBytes, 4096);

  assert.equal(census.byLabel["buffer:bufB"].freedByDevice, 0);
  assert.equal(census.byLabel["buffer:bufB"].destroyed, 0);
  assert.equal(census.byLabel["buffer:bufB"].liveBytes, 256);

  assert.equal(census.textures.liveBytes, 4096);
  assert.equal(census.buffers.liveBytes, 256);
});

test("C5: repeated destroy of same device moves nothing", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice("dev");
  dev.createTexture({
    size: [16, 16],
    format: "rgba8unorm",
    label: "t",
  });

  dev.destroy();
  assert.equal(census.devicesDestroyed, 1);
  assert.equal(census.textures.freedByDevice, 1);

  dev.destroy(); // Repeated destroy
  assert.equal(
    census.devicesDestroyed,
    1,
    "devicesDestroyed must not increment again",
  );
  assert.equal(
    census.textures.freedByDevice,
    1,
    "freedByDevice must not change",
  );
  assert.equal(census.textures.liveBytes, 0);
});

test("C5: explicit destroy of resource after device destroyed moves no count and no byte", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice("dev");
  const tex = dev.createTexture({
    size: [16, 16],
    format: "rgba8unorm",
    label: "t",
  });

  dev.destroy();

  const snapTextures = { ...census.textures };
  const snapLabel = { ...census.byLabel["texture:t"] };
  const snapRepeated = census.repeatedDestroys;

  tex.destroy(); // Explicit destroy after device destroyed

  assert.equal(
    census.textures.destroyed,
    snapTextures.destroyed,
    "destroyed must not move",
  );
  assert.equal(
    census.textures.freedByDevice,
    snapTextures.freedByDevice,
    "freedByDevice must not move",
  );
  assert.equal(
    census.textures.liveBytes,
    snapTextures.liveBytes,
    "liveBytes must not move",
  );
  assert.equal(
    census.repeatedDestroys,
    snapRepeated,
    "repeatedDestroys must not move",
  );
  assert.equal(census.byLabel["texture:t"].destroyed, snapLabel.destroyed);
  assert.equal(
    census.byLabel["texture:t"].freedByDevice,
    snapLabel.freedByDevice,
  );
  assert.equal(census.byLabel["texture:t"].liveBytes, snapLabel.liveBytes);
});

// Lead addition (Celos, round 2), from the C5 sentence added after the spec
// author's pass: a resource created on a destroyed device is released at birth.
test("C5: a texture created on an already destroyed device counts as freedByDevice and adds no live byte", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();
  dev.destroy();
  dev.createTexture({ size: [4, 4], format: "rgba8unorm", label: "late" });
  assert.equal(census.textures.created, 1);
  assert.equal(census.textures.freedByDevice, 1);
  assert.equal(census.textures.liveBytes, 0);
  const [row] = liveRowsForLabels(census, ["late"]);
  assert.equal(row.live, 0);
  assert.equal(row.freedByDevice, 1);
  assert.equal(row.destroyed, 0);
});

// C6 (ROUND 4, F6): owner label forms. Lead addition (Celos, round 4).

const DYNAMIC_CENSUS = {
  byLabel: {
    "texture:Globe water-mask 7/12/40": {
      kind: "texture",
      label: "Globe water-mask 7/12/40",
      created: 1,
      destroyed: 1,
      freedByDevice: 0,
      liveBytes: 0,
    },
    "texture:Globe water-mask 8/25/81": {
      kind: "texture",
      label: "Globe water-mask 8/25/81",
      created: 1,
      destroyed: 0,
      freedByDevice: 0,
      liveBytes: 4096,
    },
    "texture:Globe imagery 3/1/2": {
      kind: "texture",
      label: "Globe imagery 3/1/2",
      created: 2,
      destroyed: 0,
      freedByDevice: 2,
      liveBytes: 0,
    },
    "buffer:Ocean spectrum": {
      kind: "buffer",
      label: "Ocean spectrum",
      created: 1,
      destroyed: 0,
      freedByDevice: 0,
      liveBytes: 64,
    },
  },
};

test("C6: (ROUND 4, F6) prefix:<text> censuses every dynamically labelled owner the prefix starts", () => {
  const rows = liveRowsForLabels(DYNAMIC_CENSUS, ["prefix:Globe water-mask "]);
  assert.equal(rows.length, 2);
  const labels = rows.map((row) => row.label).sort();
  assert.deepEqual(labels, [
    "Globe water-mask 7/12/40",
    "Globe water-mask 8/25/81",
  ]);
  for (const row of rows) {
    assert.equal(row.spec, "prefix:Globe water-mask ");
    assert.equal(row.seen, true);
  }
  const live = rows.find((row) => row.label === "Globe water-mask 8/25/81");
  assert.equal(live.live, 1);
  assert.equal(live.liveBytes, 4096);
});

test("C6: (ROUND 4, F6) re:<regex> censuses every label the pattern finds", () => {
  const rows = liveRowsForLabels(DYNAMIC_CENSUS, [
    "re:^Globe .* \\d+/\\d+/\\d+$",
  ]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.spec === "re:^Globe .* \\d+/\\d+/\\d+$"));
  const imagery = rows.find((row) => row.label === "Globe imagery 3/1/2");
  assert.equal(imagery.freedByDevice, 2);
  assert.equal(imagery.live, 0);
});

test("C6: (ROUND 4, F6) an exact label still matches only itself and keeps its row shape", () => {
  const rows = liveRowsForLabels(DYNAMIC_CENSUS, ["Globe water-mask"]);
  assert.deepEqual(rows, [
    {
      label: "Globe water-mask",
      kind: null,
      created: 0,
      destroyed: 0,
      freedByDevice: 0,
      live: 0,
      liveBytes: 0,
      seen: false,
    },
  ]);
  const exact = liveRowsForLabels(DYNAMIC_CENSUS, ["Ocean spectrum"]);
  assert.equal(exact.length, 1);
  assert.equal(exact[0].live, 1);
  assert.equal(Object.hasOwn(exact[0], "spec"), false);
});

test("C6: (ROUND 4, F6) a pattern that matches nothing reads one unseen row under its spec", () => {
  const rows = liveRowsForLabels(DYNAMIC_CENSUS, ["prefix:Bathymetry"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, "prefix:Bathymetry");
  assert.equal(rows[0].spec, "prefix:Bathymetry");
  assert.equal(rows[0].seen, false);
});

test("C6: (ROUND 4, F6) parseOwnerLabel reads the three forms and refuses empty or invalid ones", () => {
  assert.equal(parseOwnerLabel("LUT").form, "exact");
  assert.equal(parseOwnerLabel("prefix:Globe ").form, "prefix");
  assert.equal(parseOwnerLabel("re:^a+$").form, "re");
  assert.equal(parseOwnerLabel("re:^a+$").test("aaa"), true);
  assert.equal(parseOwnerLabel("prefix:Globe ").test("Globe 1"), true);
  assert.equal(parseOwnerLabel("prefix:Globe ").test("The Globe 1"), false);
  assert.throws(() => parseOwnerLabel(""), TypeError);
  assert.throws(() => parseOwnerLabel("prefix:"), TypeError);
  assert.throws(() => parseOwnerLabel("re:"), TypeError);
  assert.throws(
    () => parseOwnerLabel("re:("),
    /not a valid regular expression/,
  );
});

// C7: (ROUND 5, K5-3) pipelines censused by label like textures and buffers.
// Lead addition (Celos, round 5), written from the seat's item text.

test("C7: (ROUND 5, K5-3) synchronous render and compute pipelines are censused by label and read live", () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();
  const p1 = dev.createRenderPipeline({ label: "Globe terrain (ocean)" });
  dev.createRenderPipeline({ label: "Globe terrain (ocean)" });
  dev.createComputePipeline({ label: "enhOcean spectrum" });
  dev.createRenderPipeline({});
  assert.ok(p1 && p1.descriptor, "the original's pipeline is returned");
  assert.equal(census.pipelines.render.created, 3);
  assert.equal(census.pipelines.compute.created, 1);
  assert.deepEqual(census.byLabel["renderPipeline:Globe terrain (ocean)"], {
    kind: "renderPipeline",
    label: "Globe terrain (ocean)",
    created: 2,
    destroyed: 0,
    freedByDevice: 0,
    liveBytes: 0,
    pending: 0,
    rejected: 0,
  });
  assert.equal(census.byLabel["renderPipeline:(unlabelled)"].created, 1);
  assert.equal(census.byLabel["computePipeline:enhOcean spectrum"].created, 1);
  // Compile timing is unchanged by the census.
  assert.equal(census.compile.renderPipelines.count, 3);
  assert.equal(census.compile.computePipelines.count, 1);
  const rows = liveRowsForLabels(census, [
    "Globe terrain (ocean)",
    "re:^enhOcean",
  ]);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.label, row.live, row.pending]),
    [
      ["renderPipeline", "Globe terrain (ocean)", 2, 0],
      ["computePipeline", "enhOcean spectrum", 1, 0],
    ],
  );
  // No pipeline touches the texture or buffer totals PF-4 reads.
  assert.equal(census.textures.created, 0);
  assert.equal(census.buffers.created, 0);
});

test("C7: (ROUND 5, K5-3) an async pipeline is pending until its promise settles, then created or rejected", async () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const dev = new FakeGPUDevice();
  const ok = dev.createRenderPipelineAsync({ label: "Water enhanced" });
  const bad = dev.createComputePipelineAsync({
    label: "Water fft",
    fail: true,
  });
  assert.equal(census.byLabel["renderPipeline:Water enhanced"].pending, 1);
  assert.equal(census.byLabel["computePipeline:Water fft"].pending, 1);
  assert.equal(census.pipelines.render.pending, 1);
  assert.equal(census.pipelines.compute.pending, 1);
  assert.equal(census.byLabel["renderPipeline:Water enhanced"].created, 0);
  const keepAlive = liveRowsForLabels(census, ["prefix:Water "]);
  assert.deepEqual(
    keepAlive.map((row) => [row.label, row.live, row.pending]),
    [
      ["Water enhanced", 0, 1],
      ["Water fft", 0, 1],
    ],
  );
  await ok;
  await bad.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const rendered = census.byLabel["renderPipeline:Water enhanced"];
  assert.equal(rendered.pending, 0);
  assert.equal(rendered.created, 1);
  const failed = census.byLabel["computePipeline:Water fft"];
  assert.equal(failed.pending, 0);
  assert.equal(failed.created, 0);
  assert.equal(failed.rejected, 1);
  assert.equal(census.pipelines.render.created, 1);
  assert.equal(census.pipelines.compute.rejected, 1);
  assert.equal(census.pipelines.render.pending, 0);
});

test("C7: (ROUND 5, K5-3) destroying the device releases its pipelines; a pipeline row has no destroy", async () => {
  const { FakeGPUDevice, census } = installCensusWithFakes();
  const kept = new FakeGPUDevice("kept");
  const torn = new FakeGPUDevice("torn");
  kept.createRenderPipeline({ label: "Sky" });
  torn.createRenderPipeline({ label: "Sky" });
  await torn.createComputePipelineAsync({ label: "Clouds march" });
  await new Promise((resolve) => setImmediate(resolve));
  torn.destroy();
  const sky = census.byLabel["renderPipeline:Sky"];
  assert.equal(sky.created, 2);
  assert.equal(sky.destroyed, 0);
  assert.equal(sky.freedByDevice, 1);
  const [row] = liveRowsForLabels(census, ["Sky"]);
  assert.equal(row.live, 1, "the kept device's pipeline stays live");
  assert.equal(census.byLabel["computePipeline:Clouds march"].freedByDevice, 1);
  assert.equal(census.pipelines.render.freedByDevice, 1);
  assert.equal(census.pipelines.compute.freedByDevice, 1);
  // A pipeline created on the destroyed device is released at birth.
  torn.createRenderPipeline({ label: "Late" });
  assert.equal(census.byLabel["renderPipeline:Late"].freedByDevice, 1);
  assert.deepEqual(PIPELINE_ROW_KINDS, ["renderPipeline", "computePipeline"]);
});

test("C7: (ROUND 5, K5-3) the empty census carries the pipeline totals the installed one does", () => {
  const { census } = installCensusWithFakes();
  const empty = emptyGpuDeviceCensus();
  assert.deepEqual(Object.keys(empty).sort(), Object.keys(census).sort());
  assert.deepEqual(empty.pipelines, census.pipelines);
  assert.deepEqual(empty.pipelines.render, {
    created: 0,
    destroyed: 0,
    freedByDevice: 0,
    createdBytes: 0,
    liveBytes: 0,
    unknownSize: 0,
    pending: 0,
    rejected: 0,
  });
});
