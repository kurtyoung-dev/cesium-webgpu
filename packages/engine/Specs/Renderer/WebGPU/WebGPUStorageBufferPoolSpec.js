import {
  WebGPUStorageBufferPool,
  default as DefaultExport,
} from "../../../Source/Renderer/WebGPU/WebGPUStorageBufferPool.js";
import { createRecordingWebGPUBufferDevice } from "./createRecordingWebGPUBufferDevice.js";

// ── Test fixtures ───────────────────────────────────────────────────
//
// WebGPUStorageBufferPool sub-buckets reusable GPUBuffers by size. The
// only GPU interaction is device.createBuffer (in acquire's miss path and
// in createWithData), handle.buffer.destroy() (release/trim/destroy), and
// device.queue.writeBuffer (createWithData). None of that needs a live
// GPUDevice — a recording mock that hands back plain objects with a
// destroy() spy lets the full bucket/free-list/stats surface run
// deterministically in Karma without WebGPU. This mirrors the house
// pattern in WebGPURingBufferAllocatorSpec.js.
//
// What's covered (all device-free w.r.t. a *real* GPU):
//   - constructor defaults (maxPerBucket 8, maxTotal 64, label
//     "StoragePool") + option overrides
//   - acquire() size/offset math: next-power-of-2 bucketing, the 256-byte
//     floor, bucket-key format, usage-flag mapping, label generation
//   - acquire() pool-hit path: free-list pop, requestedSize rewrite,
//     hit/acquired/pooled accounting (no createBuffer call on a hit)
//   - release() free-list push + the maxTotal / maxPerBucket eviction
//     (destroy) branches
//   - getStats() accounting (pooledCount, acquiredCount, pooledMemory,
//     bucketCount, hitRate)
//   - trim() down to maxKeep + empty-bucket deletion
//   - createWithData() 4-byte alignment math + usage/label + the
//     ArrayBuffer vs. ArrayBufferView writeBuffer forwarding
//   - isDestroyed / destroy() idempotence + buffer teardown
//
// Nothing here requires a real GPUDevice/queue — the mock records every
// call, so even the "createBuffer" branches are deterministic.

// The pool ORs the global GPUBufferUsage enum when building usage flags.
// Provide a numeric stand-in (spec values) so the math is assertable in
// Node/Karma without WebGPU.
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

function makePool(options) {
  const { device, created, writes } = createRecordingWebGPUBufferDevice();
  const pool = new WebGPUStorageBufferPool(device, options);
  return { pool, created, writes };
}

describe("Renderer/WebGPU/WebGPUStorageBufferPool", function () {
  describe("exports", function () {
    it("exposes the class as a named + default export", function () {
      expect(WebGPUStorageBufferPool).toBeDefined();
      expect(typeof WebGPUStorageBufferPool).toBe("function");
      expect(DefaultExport).toBe(WebGPUStorageBufferPool);
    });
  });

  describe("constructor + defaults", function () {
    it("does not touch the device on construction", function () {
      const { pool, created } = makePool();
      expect(pool).toBeDefined();
      expect(created.length).toBe(0);
    });

    it("starts un-destroyed", function () {
      const { pool } = makePool();
      expect(pool.isDestroyed).toBe(false);
    });

    it("reports a zeroed stats shape on a fresh pool", function () {
      const { pool } = makePool();
      const s = pool.getStats();
      expect(s.pooledCount).toBe(0);
      expect(s.acquiredCount).toBe(0);
      expect(s.pooledMemory).toBe(0);
      expect(s.bucketCount).toBe(0);
      expect(s.hitRate).toBe(0);
    });

    it("defaults label to 'StoragePool' (observed via acquire's label)", function () {
      const { pool, created } = makePool();
      pool.acquire(256);
      // Default label prefix is "StoragePool"; bucket 256, write-only.
      expect(created[0].label).toBe("StoragePool (256 bytes, write-only)");
    });

    it("honours a custom label prefix", function () {
      const { pool, created } = makePool({ label: "Particles" });
      pool.acquire(256);
      expect(created[0].label).toBe("Particles (256 bytes, write-only)");
    });
  });

  describe("acquire() size bucketing (next power of 2, 256 floor)", function () {
    it("floors sub-256 requests to a 256-byte bucket", function () {
      const { pool } = makePool();
      expect(pool.acquire(1).allocatedSize).toBe(256);
      expect(pool.acquire(0).allocatedSize).toBe(256);
      expect(pool.acquire(256).allocatedSize).toBe(256);
    });

    it("rounds up to the next power of 2", function () {
      const { pool } = makePool();
      expect(pool.acquire(257).allocatedSize).toBe(512);
      expect(pool.acquire(1000).allocatedSize).toBe(1024);
      expect(pool.acquire(1024).allocatedSize).toBe(1024);
      expect(pool.acquire(1025).allocatedSize).toBe(2048);
    });

    it("buckets a 1 MB request to exactly 1 MB (already a power of 2)", function () {
      const { pool } = makePool();
      expect(pool.acquire(1024 * 1024).allocatedSize).toBe(1024 * 1024);
    });

    it("records requestedSize as the raw (un-bucketed) request", function () {
      const { pool } = makePool();
      const handle = pool.acquire(1000);
      expect(handle.requestedSize).toBe(1000);
      expect(handle.allocatedSize).toBe(1024);
    });
  });

  describe("acquire() bucket key + usage flags + label", function () {
    it("keys write-only buckets as `${bucketSize}_w`", function () {
      const { pool } = makePool();
      expect(pool.acquire(1000, false).bucketKey).toBe("1024_w");
    });

    it("keys readable buckets as `${bucketSize}_r`", function () {
      const { pool } = makePool();
      expect(pool.acquire(1000, true).bucketKey).toBe("1024_r");
    });

    it("sets STORAGE | COPY_DST for write-only buffers", function () {
      const { pool, created } = makePool();
      pool.acquire(256, false);
      const expected = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      expect(created[0].usage).toBe(expected);
      // COPY_SRC must NOT be set on a write-only buffer.
      expect(created[0].usage & GPUBufferUsage.COPY_SRC).toBe(0);
    });

    it("adds COPY_SRC for readable buffers", function () {
      const { pool, created } = makePool();
      pool.acquire(256, true);
      const expected =
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC;
      expect(created[0].usage).toBe(expected);
    });

    it("defaults readable to false", function () {
      const { pool } = makePool();
      expect(pool.acquire(256).readable).toBe(false);
    });

    it("labels readable buffers 'readable' and uses the bucket size", function () {
      const { pool, created } = makePool();
      pool.acquire(257, true);
      expect(created[0].label).toBe("StoragePool (512 bytes, readable)");
    });

    it("sizes the created GPU buffer to the bucket size", function () {
      const { pool, created } = makePool();
      pool.acquire(1000);
      expect(created[0].size).toBe(1024);
    });
  });

  describe("acquire() pool-hit path (free-list reuse)", function () {
    it("reuses a released buffer instead of creating a new one", function () {
      const { pool, created } = makePool();
      const a = pool.acquire(1000); // miss → 1 created
      pool.release(a); // returns to the 1024_w bucket
      const b = pool.acquire(1000); // hit → no new create
      expect(created.length).toBe(1);
      expect(b.buffer).toBe(a.buffer);
    });

    it("rewrites requestedSize on a reused handle", function () {
      const { pool } = makePool();
      const a = pool.acquire(1000); // bucket 1024
      pool.release(a);
      const b = pool.acquire(700); // same 1024 bucket → hit
      expect(b.allocatedSize).toBe(1024);
      expect(b.requestedSize).toBe(700);
    });

    it("does NOT reuse across readable/write-only buckets", function () {
      const { pool, created } = makePool();
      const w = pool.acquire(1000, false);
      pool.release(w);
      // Same size, different readability → different bucket key → miss.
      pool.acquire(1000, true);
      expect(created.length).toBe(2);
    });

    it("does NOT reuse across different size buckets", function () {
      const { pool, created } = makePool();
      const small = pool.acquire(256);
      pool.release(small);
      pool.acquire(1000); // 1024 bucket → miss
      expect(created.length).toBe(2);
    });
  });

  describe("getStats() accounting", function () {
    it("counts acquired buffers and resets on release", function () {
      const { pool } = makePool();
      const a = pool.acquire(256);
      const b = pool.acquire(256);
      expect(pool.getStats().acquiredCount).toBe(2);
      pool.release(a);
      expect(pool.getStats().acquiredCount).toBe(1);
      pool.release(b);
      expect(pool.getStats().acquiredCount).toBe(0);
    });

    it("tracks pooledCount + pooledMemory of released buffers", function () {
      const { pool } = makePool();
      const a = pool.acquire(1000); // allocatedSize 1024
      const b = pool.acquire(256); // allocatedSize 256
      pool.release(a);
      pool.release(b);
      const s = pool.getStats();
      expect(s.pooledCount).toBe(2);
      expect(s.pooledMemory).toBe(1024 + 256);
    });

    it("counts distinct size/readability buckets", function () {
      const { pool } = makePool();
      pool.release(pool.acquire(256, false)); // 256_w
      pool.release(pool.acquire(256, true)); // 256_r
      pool.release(pool.acquire(1000, false)); // 1024_w
      expect(pool.getStats().bucketCount).toBe(3);
    });

    it("computes hitRate = hits / acquires", function () {
      const { pool } = makePool();
      const a = pool.acquire(256); // miss (acquire #1)
      pool.release(a);
      pool.acquire(256); // hit (acquire #2)
      pool.acquire(256); // miss (acquire #3) — only one pooled buffer
      // 1 hit / 3 acquires.
      expect(pool.getStats().hitRate).toBeCloseTo(1 / 3, 12);
    });

    it("reports hitRate 0 before any acquire", function () {
      const { pool } = makePool();
      expect(pool.getStats().hitRate).toBe(0);
    });
  });

  describe("release() eviction branches", function () {
    it("destroys instead of pooling once maxTotal is reached", function () {
      // maxTotal 1: the first release pools, the second must destroy.
      const { pool } = makePool({ maxTotal: 1 });
      const a = pool.acquire(256);
      const b = pool.acquire(512); // distinct bucket
      pool.release(a); // pooled → totalPooled 1
      pool.release(b); // totalPooled >= maxTotal → destroy
      expect(b.buffer.destroyed).toBe(true);
      expect(a.buffer.destroyed).toBe(false);
      expect(pool.getStats().pooledCount).toBe(1);
    });

    it("destroys instead of pooling once a bucket hits maxPerBucket", function () {
      // maxPerBucket 1: second release to the SAME bucket must destroy.
      const { pool } = makePool({ maxPerBucket: 1, maxTotal: 64 });
      const a = pool.acquire(256);
      const b = pool.acquire(256); // same 256_w bucket
      pool.release(a); // bucket length 1
      pool.release(b); // bucket.length >= maxPerBucket → destroy
      expect(b.buffer.destroyed).toBe(true);
      expect(pool.getStats().pooledCount).toBe(1);
    });

    it("does not destroy a buffer that is successfully pooled", function () {
      const { pool } = makePool();
      const a = pool.acquire(256);
      pool.release(a);
      expect(a.buffer.destroyed).toBe(false);
    });
  });

  describe("trim()", function () {
    it("destroys excess buffers down to maxKeep per bucket", function () {
      const { pool } = makePool();
      const handles = [
        pool.acquire(256),
        pool.acquire(256),
        pool.acquire(256),
        pool.acquire(256),
      ];
      handles.forEach((h) => pool.release(h)); // 4 in the 256_w bucket
      expect(pool.getStats().pooledCount).toBe(4);

      pool.trim(2); // keep 2, destroy 2
      expect(pool.getStats().pooledCount).toBe(2);
    });

    it("defaults maxKeep to 2", function () {
      const { pool } = makePool();
      const handles = [pool.acquire(256), pool.acquire(256), pool.acquire(256)];
      handles.forEach((h) => pool.release(h)); // 3 pooled
      pool.trim(); // default keep 2
      expect(pool.getStats().pooledCount).toBe(2);
    });

    it("deletes a bucket emptied to zero (maxKeep 0)", function () {
      const { pool } = makePool();
      pool.release(pool.acquire(256));
      pool.release(pool.acquire(512));
      expect(pool.getStats().bucketCount).toBe(2);
      pool.trim(0); // empty every bucket → all deleted
      expect(pool.getStats().bucketCount).toBe(0);
      expect(pool.getStats().pooledCount).toBe(0);
    });

    it("destroys the trimmed-away buffers", function () {
      const { pool } = makePool();
      const kept = pool.acquire(256);
      const dropped = pool.acquire(256);
      pool.release(kept);
      pool.release(dropped); // dropped is on top of the bucket (LIFO)
      pool.trim(1); // pops/destroys the top entry
      expect(dropped.buffer.destroyed).toBe(true);
      expect(kept.buffer.destroyed).toBe(false);
    });
  });

  describe("createWithData()", function () {
    it("aligns the buffer size up to a 4-byte multiple", function () {
      const { pool, created } = makePool();
      // 5 bytes → ceil(5/4)*4 = 8.
      pool.createWithData(new Uint8Array(5));
      expect(created[0].size).toBe(8);
    });

    it("leaves already-aligned sizes unchanged", function () {
      const { pool, created } = makePool();
      pool.createWithData(new Float32Array(4)); // 16 bytes
      expect(created[0].size).toBe(16);
    });

    it("labels one-shot buffers with 'with data' and the aligned size", function () {
      const { pool, created } = makePool();
      pool.createWithData(new Uint8Array(5));
      expect(created[0].label).toBe("StoragePool (8 bytes, with data)");
    });

    it("sets STORAGE | COPY_DST and adds COPY_SRC only when readable", function () {
      const { pool, created } = makePool();
      pool.createWithData(new Float32Array(4), false);
      pool.createWithData(new Float32Array(4), true);
      expect(created[0].usage).toBe(
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      );
      expect(created[1].usage).toBe(
        GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      );
    });

    it("forwards an ArrayBuffer through queue.writeBuffer at offset 0", function () {
      const { pool, writes, created } = makePool();
      const ab = new ArrayBuffer(16);
      const buffer = pool.createWithData(ab);
      expect(writes.length).toBe(1);
      expect(writes[0].buffer).toBe(buffer);
      expect(writes[0].buffer).toBe(created[0]);
      expect(writes[0].offset).toBe(0);
      // ArrayBuffer path passes the buffer directly (no view offset args).
      expect(writes[0].source).toBe(ab);
    });

    it("forwards an ArrayBufferView with its byteOffset + byteLength", function () {
      const { pool, writes } = makePool();
      // A subarray view so byteOffset is non-zero and distinct.
      const backing = new Float32Array(8); // 32 bytes
      const view = backing.subarray(2, 6); // 4 floats, byteOffset 8, byteLength 16
      pool.createWithData(view);
      expect(writes.length).toBe(1);
      expect(writes[0].source).toBe(view.buffer);
      expect(writes[0].srcOffset).toBe(view.byteOffset);
      expect(writes[0].byteLength).toBe(view.byteLength);
    });
  });

  describe("destroy() + isDestroyed", function () {
    it("destroys all pooled buffers and clears the pool", function () {
      const { pool } = makePool();
      const a = pool.acquire(256);
      const b = pool.acquire(512);
      pool.release(a);
      pool.release(b);
      pool.destroy();
      expect(a.buffer.destroyed).toBe(true);
      expect(b.buffer.destroyed).toBe(true);
      expect(pool.isDestroyed).toBe(true);
      const s = pool.getStats();
      expect(s.pooledCount).toBe(0);
      expect(s.bucketCount).toBe(0);
    });

    it("is idempotent (a second destroy is a no-op)", function () {
      const { pool } = makePool();
      pool.destroy();
      expect(() => pool.destroy()).not.toThrow();
      expect(pool.isDestroyed).toBe(true);
    });
  });
});
