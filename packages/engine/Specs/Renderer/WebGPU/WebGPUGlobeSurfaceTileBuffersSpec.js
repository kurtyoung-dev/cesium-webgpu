import {
  getTileKey,
  getOrCreateTileBuffers,
  ensureTerrainShadowCastUniformBuffer,
  prepareTerrainShadowCastCommandUniforms,
  evictStaleResources,
  removeImageryTexture,
} from "../../../Source/Renderer/WebGPU/WebGPUGlobeSurfaceTileBuffers.js";

// ── Scope ───────────────────────────────────────────────────────────
//
// Pure early-return/cache paths use a null device. A recording fake device
// covers the full VB/IB build plus C11-192's lazy terrain-shadow realization,
// device replacement, mesh replacement, counters, and destruction without
// requiring navigator.gpu.

if (typeof globalThis.GPUBufferUsage === "undefined") {
  globalThis.GPUBufferUsage = {
    COPY_DST: 0x08,
    INDEX: 0x10,
    VERTEX: 0x20,
    UNIFORM: 0x40,
  };
}

// A stub GPU buffer whose destroy() flips a flag so we can assert the
// helpers free what they should. Stands in for a GPUBuffer in the cache.
function fakeBuffer(tag, size = 0) {
  return {
    __tag: tag,
    size: size,
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
}

function makeRecordingDevice(name) {
  const device = {
    name: name,
    createdBuffers: [],
    writes: [],
    createBuffer(descriptor) {
      const buffer = fakeBuffer(descriptor.label, descriptor.size);
      buffer.usage = descriptor.usage;
      this.createdBuffers.push(buffer);
      return buffer;
    },
  };
  device.queue = {
    writeBuffer(...args) {
      device.writes.push(args);
    },
  };
  return device;
}

function makeRenderableMesh(positionOffset = 0) {
  return {
    _webgpuGeneration: 0,
    vertices: new Float32Array([
      positionOffset + 1,
      2,
      3,
      4,
      0,
      0,
      positionOffset + 5,
      6,
      7,
      8,
      1,
      0,
      positionOffset + 9,
      10,
      11,
      12,
      0,
      1,
    ]),
    indices: new Uint16Array([0, 1, 2]),
    center: { x: 101, y: 202, z: 303 },
    encoding: {
      stride: 6,
      hasVertexNormals: false,
      hasWebMercatorT: false,
      quantization: 0,
      minimumHeight: -12,
      maximumHeight: 34,
    },
  };
}

// A stub GPU texture for the imagery cache — same destroy-tracking shape.
function fakeTexture(tag) {
  return {
    __tag: tag,
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
}

// A minimal TileGPUResources-shaped cache entry. `meshGeneration` controls
// the cache-hit / stale-eviction branch in getOrCreateTileBuffers.
function fakeResources(meshGeneration, withShadowUB) {
  const r = {
    vertexBuffer: fakeBuffer("vb"),
    indexBuffer: fakeBuffer("ib"),
    indexCount: 6,
    indexFormat: "uint16",
    strideFloats: 6,
    strideBytes: 24,
    hasNormals: false,
    hasWebMercatorT: false,
    isQuantized: false,
    hasGeodeticSurfaceNormals: false,
    meshGeneration: meshGeneration,
  };
  if (withShadowUB) {
    r.shadowCastUB = fakeBuffer("shadow");
  }
  return r;
}

// A host with empty caches and a null device. The pure paths never read
// the device, so null is safe (the source uses `host._device!`, a TS-only
// assertion erased at runtime).
function makeHost(device = null, counters) {
  return {
    _device: device,
    _tileBufferCache: new Map(),
    _imageryTextureCache: new Map(),
    _logicalCounters: counters,
  };
}

describe("Renderer/WebGPU/WebGPUGlobeSurfaceTileBuffers", function () {
  describe("getTileKey()", function () {
    it("composes the key as `${level}_${x}_${y}`", function () {
      expect(getTileKey({ level: 3, x: 5, y: 7 })).toBe("3_5_7");
    });

    it("handles the zero tile", function () {
      expect(getTileKey({ level: 0, x: 0, y: 0 })).toBe("0_0_0");
    });

    it("preserves component order (x before y)", function () {
      // Distinguishes a swapped-order regression: (x=1,y=2) ≠ (x=2,y=1).
      expect(getTileKey({ level: 9, x: 1, y: 2 })).toBe("9_1_2");
      expect(getTileKey({ level: 9, x: 2, y: 1 })).toBe("9_2_1");
    });

    it("produces distinct keys for distinct tiles", function () {
      const a = getTileKey({ level: 4, x: 8, y: 8 });
      const b = getTileKey({ level: 5, x: 8, y: 8 });
      expect(a).not.toBe(b);
    });
  });

  describe("getOrCreateTileBuffers() — cache hit (device-free)", function () {
    it("returns the cached entry when meshGeneration matches", function () {
      const host = makeHost();
      const cached = fakeResources(2);
      host._tileBufferCache.set("0_0_0", cached);

      // mesh._webgpuGeneration (2) === cached.meshGeneration (2) → hit.
      const mesh = { _webgpuGeneration: 2 };
      const result = getOrCreateTileBuffers(host, "0_0_0", mesh);

      expect(result).toBe(cached);
      // A hit must not destroy the cached buffers.
      expect(cached.vertexBuffer.destroyed).toBe(false);
      expect(cached.indexBuffer.destroyed).toBe(false);
    });

    it("treats a missing _webgpuGeneration as generation 0", function () {
      const host = makeHost();
      const cached = fakeResources(0);
      host._tileBufferCache.set("1_0_0", cached);

      // mesh with no _webgpuGeneration → `|| 0` → 0 === cached's 0 → hit.
      const result = getOrCreateTileBuffers(host, "1_0_0", {});
      expect(result).toBe(cached);
    });
  });

  describe("getOrCreateTileBuffers() — empty geometry (device-free)", function () {
    it("returns null when the mesh has no vertices", function () {
      const host = makeHost();
      const mesh = {
        _webgpuGeneration: 0,
        vertices: null,
        indices: new Uint16Array([0, 1, 2]),
      };
      expect(getOrCreateTileBuffers(host, "0_0_0", mesh)).toBeNull();
      // Nothing was cached.
      expect(host._tileBufferCache.size).toBe(0);
    });

    it("returns null when the mesh has zero-length indices", function () {
      const host = makeHost();
      const mesh = {
        _webgpuGeneration: 0,
        vertices: new Float32Array([0, 0, 0, 0, 0, 0]),
        indices: new Uint16Array(0),
      };
      expect(getOrCreateTileBuffers(host, "0_0_0", mesh)).toBeNull();
    });

    it("returns null when the mesh has zero-length vertices", function () {
      const host = makeHost();
      const mesh = {
        _webgpuGeneration: 0,
        vertices: new Float32Array(0),
        indices: new Uint16Array([0, 1, 2]),
      };
      expect(getOrCreateTileBuffers(host, "0_0_0", mesh)).toBeNull();
    });

    it("destroys a stale cached entry's buffers before bailing on empty data", function () {
      const host = makeHost();
      // Stale: cached generation (1) differs from mesh generation (2) →
      // the cached buffers are destroyed, then the empty-data check returns
      // null. Exercises the stale-eviction destroy without a device.
      const stale = fakeResources(1, /* withShadowUB */ true);
      const staleShadowBuffer = stale.shadowCastUB;
      host._tileBufferCache.set("2_0_0", stale);

      const mesh = {
        _webgpuGeneration: 2,
        vertices: new Float32Array(0),
        indices: new Uint16Array(0),
      };
      const result = getOrCreateTileBuffers(host, "2_0_0", mesh);

      expect(result).toBeNull();
      expect(stale.vertexBuffer.destroyed).toBe(true);
      expect(stale.indexBuffer.destroyed).toBe(true);
      expect(staleShadowBuffer.destroyed).toBe(true);
      expect(stale.shadowCastUB).toBeUndefined();
    });
  });

  describe("getOrCreateTileBuffers() — fill-tile stride failure (device-free)", function () {
    it("returns null when no valid uncompressed stride (>=6) accommodates the indices", function () {
      const host = makeHost();
      // encoding.stride = 6 (uncompressed, not quantized). Indices need
      // vertex index 5 (neededVerts = 6), but vertices.length is only 10 →
      // floor(10/6) = 1 vertex at stride 6, which does NOT fit index 5.
      //
      // The corrector then searches strides s in [minStride=4 .. 6] for the
      // smallest s with floor(10/s) >= 6: floor(10/4)=2, floor(10/5)=2,
      // floor(10/6)=1 — none reach 6, so correctedStride stays 0 → the
      // guard `correctedStride === 0` returns null BEFORE any createBuffer.
      const mesh = {
        _webgpuGeneration: 0,
        vertices: new Float32Array(10),
        indices: new Uint16Array([0, 1, 2, 3, 4, 5]),
        encoding: {
          stride: 6,
          hasVertexNormals: false,
          hasWebMercatorT: false,
          quantization: 0, // NONE → not quantized
        },
      };
      expect(getOrCreateTileBuffers(host, "0_0_0", mesh)).toBeNull();
      expect(host._tileBufferCache.size).toBe(0);
    });

    it("returns null when the smallest fitting uncompressed stride is < 6 (no UVs)", function () {
      const host = makeHost();
      // encoding.stride = 6, not quantized. Indices need vertex index 11
      // (neededVerts = 12). vertices.length = 60 → floor(60/6) = 10 verts at
      // stride 6, which does NOT fit index 11.
      //
      // Corrector searches s in [4 .. 6]: floor(60/4)=15 >= 12 → first hit at
      // s=4 → correctedStride = 4. Then the guard `(!isQuantized &&
      // correctedStride < 6)` (4 < 6) returns null — the fill tile lacks UV
      // coords. Fires before any createBuffer call.
      const mesh = {
        _webgpuGeneration: 0,
        vertices: new Float32Array(60),
        indices: new Uint16Array([0, 11]),
        encoding: {
          stride: 6,
          hasVertexNormals: false,
          hasWebMercatorT: false,
          quantization: 0,
        },
      };
      expect(getOrCreateTileBuffers(host, "0_0_0", mesh)).toBeNull();
    });
  });

  describe("evictStaleResources()", function () {
    it("does nothing on an empty cache", function () {
      const host = makeHost();
      expect(() => evictStaleResources(host, new Set(["0_0_0"]))).not.toThrow();
      expect(host._tileBufferCache.size).toBe(0);
    });

    it("keeps entries whose key is in the active set", function () {
      const host = makeHost();
      const keep = fakeResources(0);
      host._tileBufferCache.set("0_0_0", keep);

      evictStaleResources(host, new Set(["0_0_0"]));

      expect(host._tileBufferCache.has("0_0_0")).toBe(true);
      expect(keep.vertexBuffer.destroyed).toBe(false);
      expect(keep.indexBuffer.destroyed).toBe(false);
    });

    it("destroys and removes entries whose key is not active", function () {
      const host = makeHost();
      const stale = fakeResources(0, /* withShadowUB */ true);
      const staleShadowBuffer = stale.shadowCastUB;
      host._tileBufferCache.set("9_9_9", stale);

      evictStaleResources(host, new Set(["0_0_0"]));

      expect(host._tileBufferCache.has("9_9_9")).toBe(false);
      expect(stale.vertexBuffer.destroyed).toBe(true);
      expect(stale.indexBuffer.destroyed).toBe(true);
      expect(staleShadowBuffer.destroyed).toBe(true);
      expect(stale.shadowCastUB).toBeUndefined();
    });

    it("does not require a shadowCastUB to evict", function () {
      const host = makeHost();
      const stale = fakeResources(0); // no shadowCastUB
      host._tileBufferCache.set("9_9_9", stale);

      expect(() => evictStaleResources(host, new Set())).not.toThrow();
      expect(host._tileBufferCache.has("9_9_9")).toBe(false);
      expect(stale.vertexBuffer.destroyed).toBe(true);
      expect(stale.indexBuffer.destroyed).toBe(true);
    });

    it("evicts only the inactive entries when the cache is mixed", function () {
      const host = makeHost();
      const keep = fakeResources(0);
      const drop = fakeResources(0);
      host._tileBufferCache.set("0_0_0", keep);
      host._tileBufferCache.set("1_2_3", drop);

      evictStaleResources(host, new Set(["0_0_0"]));

      expect(host._tileBufferCache.has("0_0_0")).toBe(true);
      expect(host._tileBufferCache.has("1_2_3")).toBe(false);
      expect(keep.vertexBuffer.destroyed).toBe(false);
      expect(drop.vertexBuffer.destroyed).toBe(true);
      expect(host._tileBufferCache.size).toBe(1);
    });
  });

  describe("lazy terrain shadow uniforms", function () {
    it("pays zero shadow allocation while off and completes first cast demand", function () {
      const counters = {};
      const deviceA = makeRecordingDevice("A");
      const host = makeHost(deviceA, counters);
      const mesh = makeRenderableMesh();
      const resources = getOrCreateTileBuffers(host, "4_2_3", mesh);

      expect(resources).not.toBeNull();
      expect(deviceA.createdBuffers.length).toBe(2);
      expect(deviceA.writes.length).toBe(2);
      expect(resources.shadowCastMesh).toBe(mesh);
      expect(resources.shadowCastUniformData).toBeUndefined();
      expect(resources.shadowCastUB).toBeUndefined();
      expect(counters.terrainShadowUniformBufferCreations).toBeUndefined();
      expect(counters.tileBufferLiveBytes).toBe(80);

      const command = {
        _shadowCastLayout: "terrainUncompressed",
        _shadowCastBindGroupCacheHost: resources,
      };
      expect(prepareTerrainShadowCastCommandUniforms(deviceA, [command])).toBe(
        1,
      );
      const bufferA = resources.shadowCastUB;
      const packedData = resources.shadowCastUniformData;
      expect(command._shadowCastTerrainUB).toBe(bufferA);
      expect(resources.shadowCastMesh).toBeUndefined();
      expect(packedData).toEqual(jasmine.any(Float32Array));
      expect(packedData[16]).toBe(101);
      expect(packedData[17]).toBe(202);
      expect(packedData[18]).toBe(303);
      expect(packedData[20]).toBe(-12);
      expect(packedData[21]).toBe(34);
      expect(deviceA.createdBuffers.length).toBe(3);
      expect(deviceA.writes.length).toBe(3);
      expect(counters.terrainShadowUniformDataPacks).toBe(1);
      expect(counters.terrainShadowUniformBufferCreations).toBe(1);
      expect(counters.terrainShadowUniformBufferWrites).toBe(1);
      expect(counters.terrainShadowUniformBufferLiveEntries).toBe(1);
      expect(counters.terrainShadowUniformBufferLiveBytes).toBe(96);
      expect(counters.tileBufferLiveBytes).toBe(176);

      expect(prepareTerrainShadowCastCommandUniforms(deviceA, [command])).toBe(
        1,
      );
      expect(deviceA.createdBuffers.length).toBe(3);
      expect(deviceA.writes.length).toBe(3);

      const deviceB = makeRecordingDevice("B");
      const bufferB = ensureTerrainShadowCastUniformBuffer(deviceB, resources);
      expect(bufferA.destroyed).toBe(true);
      expect(bufferB).not.toBe(bufferA);
      expect(resources.shadowCastUniformData).toBe(packedData);
      expect(counters.terrainShadowUniformDataPacks).toBe(1);
      expect(counters.terrainShadowUniformBufferCreations).toBe(2);
      expect(counters.terrainShadowUniformBufferWrites).toBe(2);
      expect(counters.terrainShadowUniformBufferRetirements).toBe(1);
      expect(counters.terrainShadowUniformBufferLiveEntries).toBe(1);
      expect(counters.tileBufferLiveBytes).toBe(176);

      evictStaleResources(host, new Set());
      expect(bufferB.destroyed).toBe(true);
      expect(counters.terrainShadowUniformBufferRetirements).toBe(2);
      expect(counters.terrainShadowUniformBufferLiveEntries).toBe(0);
      expect(counters.terrainShadowUniformBufferLiveBytes).toBe(0);
      expect(counters.tileBufferLiveEntries).toBe(0);
      expect(counters.tileBufferLiveBytes).toBe(0);
    });

    it("retires a realized UB when the tile mesh is replaced", function () {
      const counters = {};
      const device = makeRecordingDevice("mesh-replacement");
      const host = makeHost(device, counters);
      const first = getOrCreateTileBuffers(host, "5_8_9", makeRenderableMesh());
      const firstBuffer = ensureTerrainShadowCastUniformBuffer(device, first);

      const replacementMesh = makeRenderableMesh(1000);
      const replacement = getOrCreateTileBuffers(
        host,
        "5_8_9",
        replacementMesh,
      );
      expect(firstBuffer.destroyed).toBe(true);
      expect(replacement).not.toBe(first);
      expect(replacement.shadowCastMesh).toBe(replacementMesh);
      expect(replacement.shadowCastUniformData).toBeUndefined();
      expect(replacement.shadowCastUB).toBeUndefined();
      expect(counters.terrainShadowUniformBufferRetirements).toBe(1);
      expect(counters.terrainShadowUniformBufferLiveEntries).toBe(0);
      expect(counters.tileBufferLiveEntries).toBe(1);
      expect(counters.tileBufferLiveBytes).toBe(80);

      const replacementBuffer = ensureTerrainShadowCastUniformBuffer(
        device,
        replacement,
      );
      expect(replacementBuffer.destroyed).toBe(false);
      expect(counters.terrainShadowUniformBufferLiveEntries).toBe(1);
      expect(counters.tileBufferLiveBytes).toBe(176);
    });
  });

  describe("removeImageryTexture()", function () {
    it("is a no-op for an unknown cache key", function () {
      const host = makeHost();
      expect(() => removeImageryTexture(host, "missing")).not.toThrow();
      expect(host._imageryTextureCache.size).toBe(0);
    });

    it("destroys the texture and removes the entry", function () {
      const host = makeHost();
      const tex = fakeTexture("imagery-0");
      host._imageryTextureCache.set("layer0_0_0_0", {
        texture: tex,
        view: {},
        sourceWidth: 256,
        sourceHeight: 256,
      });

      removeImageryTexture(host, "layer0_0_0_0");

      expect(host._imageryTextureCache.has("layer0_0_0_0")).toBe(false);
      expect(tex.destroyed).toBe(true);
    });

    it("only removes the targeted entry", function () {
      const host = makeHost();
      const a = fakeTexture("a");
      const b = fakeTexture("b");
      host._imageryTextureCache.set("keyA", {
        texture: a,
        view: {},
        sourceWidth: 1,
        sourceHeight: 1,
      });
      host._imageryTextureCache.set("keyB", {
        texture: b,
        view: {},
        sourceWidth: 1,
        sourceHeight: 1,
      });

      removeImageryTexture(host, "keyA");

      expect(host._imageryTextureCache.has("keyA")).toBe(false);
      expect(host._imageryTextureCache.has("keyB")).toBe(true);
      expect(a.destroyed).toBe(true);
      expect(b.destroyed).toBe(false);
    });
  });
});
