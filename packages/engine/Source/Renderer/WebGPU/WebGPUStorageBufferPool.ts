/**
 * Pooled storage buffer manager for large GPU datasets.
 * Storage buffers (SSBO) enable shaders to read/write arbitrary-sized data,
 * essential for compute shaders, large point clouds, and instance data.
 *
 * This pool maintains reusable storage buffers to avoid per-frame allocation.
 * Buffers are bucketed by size (powers of 2) for efficient reuse.
 *
 * @example
 * const pool = new WebGPUStorageBufferPool(device);
 * const buf = pool.acquire(1024 * 1024); // 1MB storage buffer
 * device.queue.writeBuffer(buf.buffer, 0, data);
 * // ... use in bind group ...
 * pool.release(buf);
 * @module WebGPUStorageBufferPool
 */

/// <reference types="@webgpu/types" />

/**
 * A pooled storage buffer handle.
 */
export interface PooledStorageBuffer {
  /** The GPU buffer */
  buffer: GPUBuffer;
  /** The actual allocated size (may be larger than requested) */
  allocatedSize: number;
  /** The requested size */
  requestedSize: number;
  /** Whether this buffer has COPY_SRC for readback */
  readable: boolean;
  /** Pool bucket key */
  bucketKey: string;
}

/**
 * Options for the storage buffer pool.
 */
export interface StorageBufferPoolOptions {
  /** Maximum number of buffers to keep per size bucket (default: 8) */
  maxPerBucket?: number;
  /** Maximum total buffers in the pool (default: 64) */
  maxTotal?: number;
  /** Label prefix */
  label?: string;
}

/**
 * Pool statistics.
 */
export interface StoragePoolStats {
  /** Number of buffers currently in the pool (available) */
  pooledCount: number;
  /** Number of buffers currently acquired (in use) */
  acquiredCount: number;
  /** Total GPU memory in pool (bytes) */
  pooledMemory: number;
  /** Number of size buckets */
  bucketCount: number;
  /** Cache hit rate (0-1) */
  hitRate: number;
}

/**
 * Pooled storage buffer manager.
 *
 * Storage buffers are bucketed by size (rounded up to next power of 2)
 * for efficient reuse. This prevents the common anti-pattern of creating
 * and destroying storage buffers every frame.
 */
export class WebGPUStorageBufferPool {
  private _device: GPUDevice;
  private _maxPerBucket: number;
  private _maxTotal: number;
  private _label: string;

  // Pool: bucketKey → available buffers
  private _pool: Map<string, PooledStorageBuffer[]> = new Map();
  private _totalPooled: number = 0;

  // Statistics
  private _acquireCount: number = 0;
  private _hitCount: number = 0;
  private _acquiredCount: number = 0;

  private _isDestroyed: boolean = false;

  constructor(device: GPUDevice, options: StorageBufferPoolOptions = {}) {
    this._device = device;
    this._maxPerBucket = options.maxPerBucket ?? 8;
    this._maxTotal = options.maxTotal ?? 64;
    this._label = options.label ?? "StoragePool";
  }

  /**
   * Acquire a storage buffer of at least the given size.
   *
   * @param size - Minimum size in bytes
   * @param readable - Whether to include COPY_SRC for CPU readback (default: false)
   * @returns A pooled storage buffer handle
   */
  acquire(size: number, readable: boolean = false): PooledStorageBuffer {
    const bucketSize = this._nextPowerOf2(Math.max(size, 256));
    const key = `${bucketSize}_${readable ? "r" : "w"}`;

    this._acquireCount++;

    // Try to find a pooled buffer
    const bucket = this._pool.get(key);
    if (bucket && bucket.length > 0) {
      const handle = bucket.pop()!;
      this._totalPooled--;
      this._hitCount++;
      this._acquiredCount++;
      handle.requestedSize = size;
      return handle;
    }

    // Create new buffer
    let usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    if (readable) {
      usage |= GPUBufferUsage.COPY_SRC;
    }

    const buffer = this._device.createBuffer({
      size: bucketSize,
      usage,
      label: `${this._label} (${bucketSize} bytes, ${readable ? "readable" : "write-only"})`,
    });

    this._acquiredCount++;

    return {
      buffer,
      allocatedSize: bucketSize,
      requestedSize: size,
      readable,
      bucketKey: key,
    };
  }

  /**
   * Release a storage buffer back to the pool.
   *
   * @param handle - The buffer handle from acquire()
   */
  release(handle: PooledStorageBuffer): void {
    this._acquiredCount--;

    // Check if pool is full
    if (this._totalPooled >= this._maxTotal) {
      handle.buffer.destroy();
      return;
    }

    // Check bucket limit
    let bucket = this._pool.get(handle.bucketKey);
    if (!bucket) {
      bucket = [];
      this._pool.set(handle.bucketKey, bucket);
    }

    if (bucket.length >= this._maxPerBucket) {
      handle.buffer.destroy();
      return;
    }

    bucket.push(handle);
    this._totalPooled++;
  }

  /**
   * Create a storage buffer with initial data (not pooled).
   * Convenience method for one-shot uploads.
   *
   * @param data - Initial data
   * @param readable - Whether to include COPY_SRC
   * @returns The GPU buffer
   */
  createWithData(
    data: ArrayBuffer | ArrayBufferView,
    readable: boolean = false,
  ): GPUBuffer {
    const byteLength =
      data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
    const alignedSize = Math.ceil(byteLength / 4) * 4;

    let usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
    if (readable) {
      usage |= GPUBufferUsage.COPY_SRC;
    }

    const buffer = this._device.createBuffer({
      size: alignedSize,
      usage,
      label: `${this._label} (${alignedSize} bytes, with data)`,
    });

    if (data instanceof ArrayBuffer) {
      this._device.queue.writeBuffer(buffer, 0, data);
    } else {
      this._device.queue.writeBuffer(
        buffer,
        0,
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
    }

    return buffer;
  }

  /**
   * Get pool statistics.
   */
  getStats(): StoragePoolStats {
    return {
      pooledCount: this._totalPooled,
      acquiredCount: this._acquiredCount,
      pooledMemory: this._calculatePooledMemory(),
      bucketCount: this._pool.size,
      hitRate: this._acquireCount > 0 ? this._hitCount / this._acquireCount : 0,
    };
  }

  /**
   * Trim the pool by destroying excess buffers.
   * @param maxKeep - Maximum buffers to keep per bucket (default: 2)
   */
  trim(maxKeep: number = 2): void {
    for (const [key, bucket] of this._pool) {
      while (bucket.length > maxKeep) {
        const handle = bucket.pop()!;
        handle.buffer.destroy();
        this._totalPooled--;
      }
      if (bucket.length === 0) {
        this._pool.delete(key);
      }
    }
  }

  /** @private */
  private _nextPowerOf2(n: number): number {
    n--;
    n |= n >> 1;
    n |= n >> 2;
    n |= n >> 4;
    n |= n >> 8;
    n |= n >> 16;
    return n + 1;
  }

  /** @private */
  private _calculatePooledMemory(): number {
    let total = 0;
    for (const bucket of this._pool.values()) {
      for (const handle of bucket) {
        total += handle.allocatedSize;
      }
    }
    return total;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  destroy(): void {
    if (this._isDestroyed) return;
    for (const bucket of this._pool.values()) {
      for (const handle of bucket) {
        handle.buffer.destroy();
      }
    }
    this._pool.clear();
    this._totalPooled = 0;
    this._isDestroyed = true;
  }
}

export default WebGPUStorageBufferPool;
