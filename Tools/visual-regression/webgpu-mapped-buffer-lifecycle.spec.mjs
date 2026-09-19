/**
 * @purpose Drives the real WebGPU readback, staging-cache, performance-manager, context-teardown and compute-validation paths under fake GPU objects, and asserts the values they produce rather than the shape of their source.
 * @status ACTIVE
 *
 * A mapped GPUBuffer refuses every copy into it. When a readback buffer is
 * persistent - created once and reused every frame - a single throw between
 * the map and the unmap therefore does not cost one frame's data, it costs the
 * feature: from that point the copy fails validation forever and the renderer
 * falls back permanently.
 *
 * These tests drive the real engine code paths with fake GPU objects that
 * enforce the two rules the real API enforces (a mapped buffer cannot be
 * re-mapped, and a mapped buffer cannot receive a copy), so what they assert
 * is the observable consequence - whether the buffers are usable afterwards -
 * and not whether a particular keyword appears in the source.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

import { bundle } from "./lib/engine-stub-bundler.mjs";
import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const engineWebGPU = resolve(
  directory,
  "../../packages/engine/Source/Renderer/WebGPU",
);

// The engine imports its shaders as generated `.js` modules the build emits
// from the `.wgsl` originals. An unbuilt tree has none of them, and none of
// them matters here, so every missing shader specifier resolves to an empty
// default export.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js") &&
      typeof context.parentURL === "string" &&
      context.parentURL.startsWith("file:")
    ) {
      const asJs = new URL(specifier, context.parentURL);
      if (
        asJs.pathname.includes("/packages/engine/Source/Shaders/") &&
        !fs.existsSync(fileURLToPath(asJs))
      ) {
        return {
          url: "data:text/javascript,export default%20%22%22%3B",
          shortCircuit: true,
        };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      return {
        format: "module",
        source: ts.transpileModule(
          fs.readFileSync(fileURLToPath(url), "utf8"),
          {
            compilerOptions: {
              module: ts.ModuleKind.ESNext,
              target: ts.ScriptTarget.ES2022,
              verbatimModuleSyntax: false,
            },
          },
        ).outputText,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

enableEngineTsResolution();

globalThis.GPUMapMode ??= { READ: 1, WRITE: 2 };
globalThis.GPUBufferUsage ??= {
  MAP_READ: 0x0001,
  MAP_WRITE: 0x0002,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
};

const { mapAndRead, WebGPUBufferMapper } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUBufferMapper.ts")).href
);
const { WebGPUEntityClusterDispatcher } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUEntityClusterDispatcher.ts")).href
);
const { default: WebGPUComputeEngine } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUComputeEngine.ts")).href
);
const { default: WebGPUComputeCommand } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUComputeCommand.ts")).href
);
const { WebGPUPerformanceManager } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUPerformanceManager.ts")).href
);
const { getWebGPUInstanceWorldPosition } = await import(
  pathToFileURL(resolve(engineWebGPU, "WebGPUComputeInstanceRenderer.ts")).href
);

/**
 * A GPUBuffer stand-in that enforces the two rules this lane is about: a
 * mapped buffer cannot be mapped again, and a mapped buffer cannot receive a
 * copy. Without those rules a fake would report a leaked mapping as success,
 * which is exactly the failure the real API produces and the spec must see.
 *
 * @param {string} name Identifies the buffer in failure messages.
 * @param {object} [options] Fake behaviour.
 * @param {number} [options.size] Byte length.
 * @param {number} [options.usage] Usage flags.
 * @param {Error} [options.rejectMap] Rejection for `mapAsync`.
 * @returns {object} The fake buffer.
 */
function fakeBuffer(name, options = {}) {
  const size = options.size ?? 32;
  const store = new Uint8Array(size);
  const buffer = {
    name,
    size,
    usage: options.usage ?? 0,
    store,
    mapped: false,
    destroyed: false,
    mapCalls: 0,
    unmapCalls: 0,
    copiesAccepted: 0,
  };
  let ranges = [];
  buffer.mapAsync = async (mode, offset = 0, rangeSize) => {
    buffer.mapCalls++;
    if (buffer.destroyed) {
      throw new Error(`mapAsync on a destroyed buffer: ${name}`);
    }
    if (buffer.mapped) {
      throw new Error(`mapAsync on an already-mapped buffer: ${name}`);
    }
    if (options.rejectMap) {
      throw options.rejectMap;
    }
    buffer.lastMap = { mode, offset, size: rangeSize };
    buffer.mapped = true;
  };
  buffer.getMappedRange = (offset = 0, rangeSize = size - offset) => {
    if (!buffer.mapped) {
      throw new Error(`getMappedRange on an unmapped buffer: ${name}`);
    }
    const copy = store.slice(offset, offset + rangeSize);
    ranges.push({ offset, view: copy });
    return copy.buffer;
  };
  buffer.unmap = () => {
    buffer.unmapCalls++;
    if (buffer.destroyed) {
      throw new Error(`unmap on a destroyed buffer: ${name}`);
    }
    for (const range of ranges) {
      store.set(range.view, range.offset);
    }
    ranges = [];
    buffer.mapped = false;
  };
  buffer.destroy = () => {
    buffer.destroyed = true;
    buffer.mapped = false;
  };
  // Stands in for `copyBufferToBuffer` naming this buffer as its destination,
  // which the real API rejects while the buffer is mapped.
  buffer.acceptCopy = () => {
    if (buffer.mapped) {
      throw new Error(`copy into a mapped buffer: ${name}`);
    }
    buffer.copiesAccepted++;
  };
  return buffer;
}

/**
 * A GPUDevice stand-in that hands out fake buffers and records every copy it
 * is asked to encode against them.
 *
 * @returns {object} The fake device.
 */
function fakeDevice() {
  const device = {
    buffers: [],
    copies: [],
    submits: 0,
    limits: { maxComputeWorkgroupsPerDimension: 65535 },
  };
  device.createBuffer = (descriptor) => {
    const buffer = fakeBuffer(
      descriptor.label ?? `buffer${device.buffers.length}`,
      {
        size: descriptor.size,
        usage: descriptor.usage,
      },
    );
    device.buffers.push(buffer);
    return buffer;
  };
  device.createShaderModule = () => ({ kind: "shaderModule" });
  device.createBindGroupLayout = () => ({ kind: "bindGroupLayout" });
  device.createBindGroup = () => ({ kind: "bindGroup" });
  device.createPipelineLayout = () => ({ kind: "pipelineLayout" });
  device.createComputePipeline = () => ({ kind: "computePipeline" });
  device.createCommandEncoder = () => ({
    clearBuffer: () => {},
    beginComputePass: () => ({
      setPipeline: () => {},
      setBindGroup: () => {},
      dispatchWorkgroups: () => {},
      end: () => {},
    }),
    copyBufferToBuffer: (src, srcOffset, dst, dstOffset, byteLength) => {
      dst.acceptCopy();
      dst.store.set(
        src.store.slice(srcOffset, srcOffset + byteLength),
        dstOffset,
      );
      device.copies.push({ src, srcOffset, dst, dstOffset, byteLength });
    },
    finish: () => ({ kind: "commandBuffer" }),
  });
  device.queue = {
    writeBuffer: () => {},
    submit: () => {
      device.submits++;
    },
  };
  return device;
}

// ───────────────── group A: the helper's own contract ─────────────────

test("A1 a decoder that returns yields its value and leaves the buffer usable", async () => {
  const buffer = fakeBuffer("readback");
  buffer.store.set([7, 0, 0, 0], 0);

  const value = await mapAndRead(
    buffer,
    { offset: 0, size: 8 },
    (mapped) => new Uint32Array(mapped)[0],
  );

  assert.equal(value, 7, "the decoded value is what the caller receives");
  assert.equal(buffer.mapped, false);
  assert.equal(buffer.unmapCalls, 1);
  buffer.acceptCopy();
  assert.equal(buffer.copiesAccepted, 1, "the buffer still accepts a copy");
});

test("A2 a decoder that throws still leaves the buffer unmapped and re-mappable", async () => {
  const buffer = fakeBuffer("readback");
  const boom = new Error("decode failed");

  await assert.rejects(
    mapAndRead(buffer, { offset: 0, size: 8 }, () => {
      throw boom;
    }),
    (error) => error === boom,
    "the decoder's own rejection reaches the caller",
  );

  assert.equal(
    buffer.mapped,
    false,
    "a buffer left mapped rejects every later copy into it, which is the " +
      "permanent failure this helper exists to prevent",
  );
  buffer.acceptCopy();
  assert.equal(buffer.copiesAccepted, 1);

  const again = await mapAndRead(
    buffer,
    { offset: 0, size: 8 },
    () => "second read",
  );
  assert.equal(again, "second read", "a subsequent map succeeds");
});

test("A3 a rejected map leaves the buffer untouched and unmaps nothing", async () => {
  const rejection = new Error("device lost");
  const buffer = fakeBuffer("readback", { rejectMap: rejection });

  await assert.rejects(
    mapAndRead(buffer, { offset: 0, size: 8 }, () => "never"),
    (error) => error === rejection,
  );
  assert.equal(buffer.unmapCalls, 0, "nothing was mapped, so nothing unmaps");
  assert.equal(buffer.mapped, false);
});

test("A4 under Promise.all one rejected map leaves the settled buffers unmapped", async () => {
  const rejection = new Error("one map rejected");
  const first = fakeBuffer("first");
  const second = fakeBuffer("second", { rejectMap: rejection });
  const third = fakeBuffer("third");

  const decode = (mapped) => new Uint32Array(mapped).slice();
  await assert.rejects(
    Promise.all([
      mapAndRead(first, { offset: 0, size: 8 }, decode),
      mapAndRead(second, { offset: 0, size: 8 }, decode),
      mapAndRead(third, { offset: 0, size: 8 }, decode),
    ]),
    (error) => error === rejection,
  );

  // `Promise.all` rejects on the first rejection while its siblings are still
  // settling, so the partial settle is the case that must not leave a mapping
  // behind.
  await Promise.resolve();
  for (const buffer of [first, third]) {
    assert.equal(
      buffer.mapped,
      false,
      `${buffer.name} must not stay mapped when a sibling's map rejects`,
    );
    buffer.acceptCopy();
  }
});

// ────────── group B: the cluster dispatcher's three persistent buffers ──────

/**
 * Runs one `computeGrid` against a fake device.
 *
 * @param {object} [options] Options.
 * @param {number} [options.rejectIndex] Index of the readback buffer whose
 *   `mapAsync` rejects, in creation order.
 * @returns {Promise<object>} The device, dispatcher, readbacks and result.
 */
async function runClusterGrid(options = {}) {
  const device = fakeDevice();
  const dispatcher = new WebGPUEntityClusterDispatcher(device);
  const coords = new Float32Array(4 * 4);

  // The readback buffers are created inside `_ensureResources`, so the
  // rejection is installed after the first allocation and before the map.
  const original = device.createBuffer;
  let created = 0;
  const readbacks = [];
  device.createBuffer = (descriptor) => {
    const buffer = original(descriptor);
    if ((descriptor.usage & globalThis.GPUBufferUsage.MAP_READ) !== 0) {
      readbacks.push(buffer);
      if (created === options.rejectIndex) {
        // One-shot: the buffer is persistent, so a permanent override would
        // assert nothing about whether the NEXT frame can use it again.
        const honest = buffer.mapAsync;
        let armed = true;
        buffer.mapAsync = async (...args) => {
          if (armed) {
            armed = false;
            buffer.mapCalls++;
            throw new Error(`map rejected: ${buffer.name}`);
          }
          return honest(...args);
        };
      }
      created++;
    }
    return buffer;
  };

  const result = await dispatcher.computeGrid(coords, 4, 2, 2, 8, 0, 0);
  return { device, dispatcher, readbacks, result };
}

test("B1 the happy path decodes all three aggregates", async () => {
  const { readbacks, result } = await runClusterGrid();
  assert.equal(readbacks.length, 3, "three persistent readback buffers");
  assert.ok(result, "a successful readback returns a grid");
  assert.equal(result.cellCounts.length, 4);
  assert.equal(result.cellRep.length, 4);
  assert.equal(result.pointCellId.length, 4);
  for (const buffer of readbacks) {
    assert.equal(buffer.mapped, false);
  }
});

test("B2 one rejected map leaves no cluster buffer mapped, and the next dispatch still works", async () => {
  const { dispatcher, device, readbacks } = await runClusterGrid({
    rejectIndex: 1,
  });

  for (const buffer of readbacks) {
    assert.equal(
      buffer.mapped,
      false,
      `${buffer.name} stayed mapped: every later copy into it fails ` +
        `validation, so GPU clustering never recovers`,
    );
  }

  // The real consequence, asserted as the real consequence: the next frame's
  // copies into the same persistent buffers are accepted, and the dispatch
  // produces a grid again.
  const before = device.copies.length;
  const second = await dispatcher.computeGrid(
    new Float32Array(16),
    4,
    2,
    2,
    8,
    0,
    0,
  );
  assert.equal(device.copies.length, before + 3);
  assert.ok(second, "the dispatcher recovers on the next frame");
});

/**
 * Lets every pending microtask of the fire-and-forget readback settle. The
 * public entry point arms `_readInstancePositionAsync` with `void`, so the
 * decode finishes after the synchronous call returns.
 *
 * @returns {Promise<void>} Resolves once the microtask queue is drained.
 */
function drain() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("B3 a throwing decode leaves the instance pick-position buffer re-usable", async () => {
  const device = fakeDevice();
  const context = { _device: device };
  const instanceBuffer = fakeBuffer("instanceRecords", { size: 256 });
  // The kernel's record layout: positionHigh at 0, positionLow at 16, so the
  // absolute position is the component-wise sum.
  const records = new Float32Array(instanceBuffer.store.buffer);
  records[0] = 1000;
  records[4] = 1.5;
  records[1] = 2000;
  records[5] = 2.5;
  records[2] = 3000;
  records[6] = 3.5;

  const cache = {
    instanceCount: 1,
    instanceBuffers: [instanceBuffer],
    pingPongIndex: 0,
    posReadbackPending: false,
    posReadbackBuffer: null,
    posCacheValue: null,
    posCacheIndex: -1,
    posCacheStamp: 0,
    posUpdateCount: 0,
  };
  const collection = { _webgpuCache: cache };

  // The staging buffer is created by the code under test on its first call and
  // then cached on the collection, which is what makes a leaked mapping
  // permanent. Its first mapped range is handed back with a byte length that
  // is not a multiple of 4, so the real decode's `new Float32Array(mapped)`
  // throws where the decode runs.
  const createBuffer = device.createBuffer;
  let poisoned = false;
  device.createBuffer = (descriptor) => {
    const buffer = createBuffer(descriptor);
    if ((descriptor.usage & globalThis.GPUBufferUsage.MAP_READ) !== 0) {
      const honest = buffer.getMappedRange;
      buffer.getMappedRange = (...args) => {
        const range = honest(...args);
        if (!poisoned) {
          poisoned = true;
          return range.slice(0, 62);
        }
        return range;
      };
    }
    return buffer;
  };

  assert.equal(
    getWebGPUInstanceWorldPosition(collection, 0, undefined, context),
    undefined,
    "a cold query arms the readback and returns nothing",
  );
  await drain();

  const staging = cache.posReadbackBuffer;
  assert.ok(staging, "the readback allocated and cached its staging buffer");
  assert.ok(poisoned, "the decode really ran against the poisoned range");
  assert.equal(
    cache.posCacheValue,
    null,
    "the decode threw, so the rejection propagated to the caller's catch and " +
      "no position was cached",
  );
  assert.equal(cache.posReadbackPending, false, "the readback re-armed");
  assert.equal(
    staging.mapped,
    false,
    "a staging buffer left mapped fails the next frame's copy into it, and " +
      "this one is cached on the collection, so instance pick positions would " +
      "never work again",
  );
  staging.acceptCopy();

  // The recovery is the proof: the same cached buffer maps again and the
  // decode reconstructs positionHigh + positionLow.
  getWebGPUInstanceWorldPosition(collection, 0, undefined, context);
  await drain();
  assert.equal(
    cache.posReadbackBuffer,
    staging,
    "the same buffer is reused, so this is the wedge case and not a fresh one",
  );
  const position = getWebGPUInstanceWorldPosition(
    collection,
    0,
    undefined,
    context,
  );
  assert.ok(position, "the next query returns a position");
  assert.equal(position.x, 1001.5);
  assert.equal(position.y, 2002.5);
  assert.equal(position.z, 3003.5);
});

// ──────── group C: the mapper's staging and readback cache recycling ────────

test("C1 a second readback of the same size reuses the cached buffer", async () => {
  const device = fakeDevice();
  const mapper = new WebGPUBufferMapper(device);
  const source = fakeBuffer("source", { size: 64 });

  const first = await mapper.readbackBuffer(source, 16);
  assert.equal(first.length, 16);
  const afterFirst = device.buffers.length;
  assert.equal(
    mapper.getStats().cachedStagingBuffers,
    1,
    "a finished readback returns its buffer to the cache",
  );

  await mapper.readbackBuffer(source, 16);
  assert.equal(
    device.buffers.length,
    afterFirst,
    "the second readback allocates nothing: it reuses the recycled buffer",
  );
});

test("C2 an upload never receives a buffer created for reading", async () => {
  const device = fakeDevice();
  const mapper = new WebGPUBufferMapper(device);
  const source = fakeBuffer("source", { size: 64 });
  const destination = fakeBuffer("destination", { size: 64 });

  await mapper.readbackBuffer(source, 16);
  const readbackBuffers = device.buffers.slice();

  await mapper.uploadViaStagingBuffer(destination, new Uint8Array(16), {
    destOffset: 8,
  });

  const staging = device.copies.at(-1).src;
  assert.ok(
    !readbackBuffers.includes(staging),
    "a MAP_READ|COPY_DST buffer cannot be written by an upload, so the " +
      "recycled readback entry must not be handed to a write caller",
  );
  assert.equal(
    staging.usage &
      (globalThis.GPUBufferUsage.MAP_WRITE |
        globalThis.GPUBufferUsage.COPY_SRC),
    globalThis.GPUBufferUsage.MAP_WRITE | globalThis.GPUBufferUsage.COPY_SRC,
  );
  assert.equal(
    device.copies.at(-1).dstOffset,
    8,
    "the caller's destination offset reaches the copy",
  );
});

test("C3 the recycled caches stay bounded without a frame advance", async () => {
  const device = fakeDevice();
  const mapper = new WebGPUBufferMapper(device);
  const source = fakeBuffer("source", { size: 4096 });

  // Each size lands in its own cache entry, because a cached buffer is reused
  // only for a request within a factor of two of its size.
  for (const bytes of [16, 64, 256, 1024, 4096]) {
    await mapper.readbackBuffer(source, bytes);
  }
  assert.ok(
    mapper.getStats().cachedStagingBuffers <= 4,
    `cache grew to ${mapper.getStats().cachedStagingBuffers}`,
  );
});

test("C4 destroying the mapper destroys the recycled buffers", async () => {
  const device = fakeDevice();
  const mapper = new WebGPUBufferMapper(device);
  const source = fakeBuffer("source", { size: 64 });

  await mapper.readbackBuffer(source, 16);
  mapper.destroy();
  assert.ok(
    device.buffers.every((buffer) => buffer.destroyed),
    "a recycled buffer the cache still holds is destroyed with the mapper",
  );
});

// ───────── group D: the performance manager reaches an implemented API ──────

/**
 * Builds a performance manager over a real buffer mapper.
 *
 * @returns {object} The manager, the device and the mapper.
 */
function performanceManagerOverRealMapper() {
  const device = fakeDevice();
  const mapper = new WebGPUBufferMapper(device);
  const context = {
    device,
    supportsComputeShaders: false,
    computeEngine: null,
    renderBundleManager: null,
    indirectDrawManager: null,
    timestampProfiler: null,
    bufferMapper: mapper,
  };
  const manager = new WebGPUPerformanceManager(context, {
    bufferMapping: true,
  });
  return { manager, device, mapper };
}

test("D1 readbackBuffer returns the bytes instead of throwing on a missing method", async () => {
  const { manager, device } = performanceManagerOverRealMapper();
  const source = fakeBuffer("source", { size: 64 });
  source.store.set([1, 2, 3, 4], 8);

  const result = await manager.readbackBuffer(source, 4, 8);

  assert.ok(result instanceof Uint8Array, "the manager returns the bytes");
  assert.deepEqual(Array.from(result), [1, 2, 3, 4]);
  assert.equal(
    device.copies.at(-1).srcOffset,
    8,
    "the caller's source offset reaches the copy",
  );
});

test("D2 uploadViaStaging lands the data at the requested destination offset", async () => {
  const { manager, device } = performanceManagerOverRealMapper();
  const destination = fakeBuffer("destination", { size: 64 });

  await manager.uploadViaStaging(destination, new Uint8Array([9, 9, 9, 9]), 16);

  const copy = device.copies.at(-1);
  assert.equal(copy.dst, destination);
  assert.equal(
    copy.dstOffset,
    16,
    "a numeric offset passed where an options object is expected silently " +
      "writes at 0",
  );
  assert.deepEqual(Array.from(copy.src.store.slice(0, 4)), [9, 9, 9, 9]);
});

// ───────── group E: context teardown releases both pipeline caches ──────────

test("E1 destroy() empties the render and compute pipeline caches", async () => {
  const contextPath = resolve(engineWebGPU, "WebGPUContext.ts");
  const { WebGPUContext } = await bundle({
    path: contextPath,
    source: fs.readFileSync(contextPath, "utf8").replace(/\r\n/g, "\n"),
    real: [],
  });

  /**
   * A cache stand-in with the two maps the real `destroy()` clears.
   *
   * @returns {object} The fake cache.
   */
  const fakeCache = () => {
    const cache = {
      cache: new Map([["pipeline", { kind: "entry" }]]),
      pendingPipelines: new Map([["pipeline", Promise.resolve()]]),
    };
    cache.destroy = () => {
      cache.cache.clear();
      cache.pendingPipelines.clear();
    };
    return cache;
  };

  const renderCache = fakeCache();
  const computeCache = fakeCache();
  const noop = { clear: () => {}, reset: () => {}, destroy: () => {} };
  const host = Object.create(WebGPUContext.prototype);
  Object.assign(host, {
    _isDestroyed: false,
    _pendingTextureMipJobs: [],
    _webgpuPipelineCache: renderCache,
    _webgpuComputePipelineCache: computeCache,
    _shaderCache: noop,
    _textureCache: noop,
    _bufferPool: noop,
    _samplerCache: noop,
    _bindGroupLayoutCache: noop,
    _bindGroupCache: noop,
    _deviceInvalidationBus: noop,
    _cacheRegistry: noop,
    _featureFlags: noop,
    _environmentDemandRegistry: noop,
    _environmentRefreshCoordinator: noop,
    _environmentRefreshScheduler: noop,
    _gpuCullerByFrustum: new Map(),
    _gpuCullerByFrustumInitializing: new Map(),
    _gpuCullerByCascade: new Map(),
    _gpuCullerByCascadeInitializing: new Map(),
    _gl: {
      destroyCompatibilityTextureHandles: () => {},
      destroyCompatibilityBufferHandles: () => {},
    },
    _pendingTextureDestroys: [],
    _uniformBufferPool: [],
    _device: null,
    _deviceLossRecovery: null,
    _performanceManager: null,
    _pointCloudLOD: null,
    _pointCloudLODInitializationToken: 0,
    _pointCloudLODInitializing: false,
    _pointCloudLODInitializationError: null,
    _pointCloudLODInitializationErrorReported: false,
  });

  // `destroy()` is best-effort: it records the first failure from a missing
  // collaborator and rethrows at the end, after every other step has run.
  try {
    host.destroy();
  } catch {
    /* a fixture is not a whole context; the caches are what this asserts */
  }

  assert.equal(renderCache.cache.size, 0, "the render pipeline cache is empty");
  assert.equal(renderCache.pendingPipelines.size, 0);
  assert.equal(
    computeCache.cache.size,
    0,
    "the compute pipeline cache is empty",
  );
  assert.equal(computeCache.pendingPipelines.size, 0);
  assert.equal(host._webgpuPipelineCache, null);
  assert.equal(host._webgpuComputePipelineCache, null);
});

// ──────────── group F: every workgroup axis is validated ────────────────────

test("F1 an oversized Y is rejected even when X is an explicit zero", () => {
  const device = fakeDevice();
  const engine = new WebGPUComputeEngine(device);
  const command = new WebGPUComputeCommand({
    workgroupCountX: 0,
    workgroupCountY: device.limits.maxComputeWorkgroupsPerDimension + 1,
    workgroupCountZ: 1,
    label: "oversizedY",
  });

  assert.throws(
    () => engine._validateWorkgroups(command),
    /exceeds device limit maxComputeWorkgroupsPerDimension=65535 for 'oversizedY'/,
    "the engine's own named error is what a caller must see, not a browser " +
      "validation message from dispatchWorkgroups",
  );
});

test("F2 a legal dispatch with an explicit zero axis still passes", () => {
  const device = fakeDevice();
  const engine = new WebGPUComputeEngine(device);
  const command = new WebGPUComputeCommand({
    workgroupCountX: 0,
    workgroupCountY: 4,
    workgroupCountZ: 1,
    label: "emptyX",
  });

  assert.doesNotThrow(() => engine._validateWorkgroups(command));
});
