/**
 * @module SharedResourcePool
 *
 * Strategy A: Shared CPU-Side Data Pool using SharedArrayBuffer.
 *
 * When multiple GraphicsContexts are active (e.g., split-screen with WebGL + WebGPU),
 * each context needs its own GPU resources but the CPU-side source data (terrain vertices,
 * imagery pixels, model geometry) can be shared via SharedArrayBuffer.
 *
 * This pool manages named SharedArrayBuffer allocations that any context can read from
 * to create its own GPU buffers/textures. Data is prepared ONCE (e.g., by a WebWorker
 * running WASM terrain tessellation) and consumed by multiple contexts.
 *
 * ## Prerequisites
 * - COOP/COEP headers required for SharedArrayBuffer:
 *   `Cross-Origin-Opener-Policy: same-origin`
 *   `Cross-Origin-Embedder-Policy: require-corp`
 * - Falls back to regular ArrayBuffer when SharedArrayBuffer is unavailable.
 *
 * ## Usage
 * ```typescript
 * const pool = SharedResourcePool.instance;
 *
 * // Worker writes terrain data into shared memory
 * const terrainData = pool.allocate('terrain-tile-12345', 1024 * 6 * 4); // 1024 vertices × 6 floats × 4 bytes
 * const view = new Float32Array(terrainData.buffer, terrainData.byteOffset, 1024 * 6);
 * // ... fill view with terrain vertex data ...
 *
 * // Both WebGL and WebGPU contexts read from the SAME buffer
 * contextA.createVertexBuffer(terrainData); // WebGL
 * contextB.createVertexBuffer(terrainData); // WebGPU
 *
 * // Release when no longer needed
 * pool.release('terrain-tile-12345');
 * ```
 *
 * @see ContextRegistry
 * @see WebGPUDevicePool
 */

/**
 * Whether SharedArrayBuffer is available in the current environment.
 * Requires COOP/COEP headers to be set on the page.
 */
export function isSharedArrayBufferSupported(): boolean {
  return typeof SharedArrayBuffer !== "undefined";
}

/**
 * A named allocation in the shared resource pool.
 */
export interface SharedAllocation {
  /** The underlying buffer (SharedArrayBuffer or ArrayBuffer fallback) */
  readonly buffer: SharedArrayBuffer | ArrayBuffer;
  /** Byte offset within the buffer for this allocation */
  readonly byteOffset: number;
  /** Size in bytes of this allocation */
  readonly byteLength: number;
  /** Reference count — how many contexts are using this allocation */
  refCount: number;
  /** Whether this uses SharedArrayBuffer (true) or ArrayBuffer fallback (false) */
  readonly isShared: boolean;
}

/**
 * Configuration for the SharedResourcePool.
 */
export interface SharedResourcePoolOptions {
  /**
   * Initial backing buffer size in bytes.
   * The pool pre-allocates a large SharedArrayBuffer and sub-allocates from it.
   * Default: 64MB
   */
  initialSize?: number;

  /**
   * Maximum backing buffer size in bytes.
   * Default: 256MB
   */
  maxSize?: number;

  /**
   * Whether to force using regular ArrayBuffer even if SharedArrayBuffer is available.
   * Useful for testing or when COOP/COEP headers can't be set.
   * Default: false
   */
  forceRegularArrayBuffer?: boolean;
}

/**
 * Shared CPU-side data pool for multi-context resource sharing.
 *
 * Manages a pool of SharedArrayBuffer-backed memory that multiple
 * GraphicsContext instances can read from simultaneously. This avoids
 * duplicating large CPU-side data (terrain, imagery, geometry) when
 * running split-screen or multi-view with different rendering backends.
 */
export class SharedResourcePool {
  private static _instance: SharedResourcePool | null = null;

  private _allocations: Map<string, SharedAllocation> = new Map();
  private _useShared: boolean;
  private _totalAllocated: number = 0;
  private _maxSize: number;

  /**
   * Get the singleton instance of the SharedResourcePool.
   */
  static get instance(): SharedResourcePool {
    if (!SharedResourcePool._instance) {
      SharedResourcePool._instance = new SharedResourcePool();
    }
    return SharedResourcePool._instance;
  }

  /**
   * Create a new SharedResourcePool.
   * Prefer using `SharedResourcePool.instance` for the singleton.
   */
  constructor(options?: SharedResourcePoolOptions) {
    const opts = options ?? {};
    this._useShared =
      !opts.forceRegularArrayBuffer && isSharedArrayBufferSupported();
    this._maxSize = opts.maxSize ?? 256 * 1024 * 1024; // 256MB
  }

  /**
   * Whether this pool is using SharedArrayBuffer (true) or ArrayBuffer fallback (false).
   */
  get isShared(): boolean {
    return this._useShared;
  }

  /**
   * Total bytes currently allocated across all named allocations.
   */
  get totalAllocated(): number {
    return this._totalAllocated;
  }

  /**
   * Number of active allocations.
   */
  get allocationCount(): number {
    return this._allocations.size;
  }

  /**
   * Allocate a named block of shared memory.
   *
   * If a block with the same name already exists, its reference count
   * is incremented and the existing allocation is returned.
   *
   * @param name - Unique name for the allocation (e.g., 'terrain-tile-12345')
   * @param sizeInBytes - Size of the allocation in bytes
   * @returns The shared allocation, usable from any context or WebWorker
   */
  allocate(name: string, sizeInBytes: number): SharedAllocation {
    // Return existing allocation if present (bump refcount)
    const existing = this._allocations.get(name);
    if (existing) {
      existing.refCount++;
      return existing;
    }

    // Create new buffer
    const buffer = this._useShared
      ? new SharedArrayBuffer(sizeInBytes)
      : new ArrayBuffer(sizeInBytes);

    const allocation: SharedAllocation = {
      buffer,
      byteOffset: 0,
      byteLength: sizeInBytes,
      refCount: 1,
      isShared: this._useShared,
    };

    this._allocations.set(name, allocation);
    this._totalAllocated += sizeInBytes;

    return allocation;
  }

  /**
   * Get an existing allocation by name without incrementing its reference count.
   *
   * @param name - The allocation name
   * @returns The allocation, or undefined if not found
   */
  get(name: string): SharedAllocation | undefined {
    return this._allocations.get(name);
  }

  /**
   * Acquire a reference to an existing allocation (increments refcount).
   *
   * @param name - The allocation name
   * @returns The allocation with incremented refcount, or undefined if not found
   */
  acquire(name: string): SharedAllocation | undefined {
    const alloc = this._allocations.get(name);
    if (alloc) {
      alloc.refCount++;
    }
    return alloc;
  }

  /**
   * Release a reference to a named allocation.
   * When the reference count reaches zero, the allocation is freed.
   *
   * @param name - The allocation name to release
   * @returns True if the allocation was fully freed, false if references remain
   */
  release(name: string): boolean {
    const alloc = this._allocations.get(name);
    if (!alloc) {
      return false;
    }

    alloc.refCount--;
    if (alloc.refCount <= 0) {
      this._allocations.delete(name);
      this._totalAllocated -= alloc.byteLength;
      return true;
    }
    return false;
  }

  /**
   * Create a typed array view into a shared allocation.
   * Useful for reading/writing specific data formats.
   *
   * @param name - The allocation name
   * @param TypedArrayConstructor - The typed array constructor (Float32Array, Uint16Array, etc.)
   * @param byteOffset - Optional byte offset within the allocation
   * @param length - Optional element count (not byte count)
   * @returns A typed array view, or undefined if allocation not found
   */
  getView<
    Ctor extends
      | Float32ArrayConstructor
      | Float64ArrayConstructor
      | Uint8ArrayConstructor
      | Uint16ArrayConstructor
      | Uint32ArrayConstructor
      | Int16ArrayConstructor
      | Int32ArrayConstructor,
  >(
    name: string,
    TypedArrayConstructor: Ctor,
    byteOffset?: number,
    length?: number,
  ): InstanceType<Ctor> | undefined {
    const alloc = this._allocations.get(name);
    if (!alloc) {
      return undefined;
    }

    const offset = alloc.byteOffset + (byteOffset ?? 0);
    // Every TypedArray constructor exposes BYTES_PER_ELEMENT as a static;
    // the union type below carries that guarantee so no cast is needed.
    const bytesPerElement = TypedArrayConstructor.BYTES_PER_ELEMENT;
    const elementCount =
      length ?? (alloc.byteLength - (byteOffset ?? 0)) / bytesPerElement;

    // `new Ctor(...)` returns the union of InstanceTypes; narrow to the
    // generic's InstanceType via a typed cast (safe because Ctor and
    // InstanceType<Ctor> are linked by the generic).
    return new TypedArrayConstructor(
      alloc.buffer as ArrayBuffer,
      offset,
      elementCount,
    ) as InstanceType<Ctor>;
  }

  /**
   * Check if a named allocation exists.
   */
  has(name: string): boolean {
    return this._allocations.has(name);
  }

  /**
   * Release all allocations, regardless of reference count.
   * Used during cleanup/shutdown.
   */
  releaseAll(): void {
    this._allocations.clear();
    this._totalAllocated = 0;
  }

  /**
   * Get diagnostic info about current pool state.
   */
  getDiagnostics(): {
    isShared: boolean;
    totalAllocated: number;
    allocationCount: number;
    allocations: Array<{
      name: string;
      byteLength: number;
      refCount: number;
    }>;
  } {
    const allocations: Array<{
      name: string;
      byteLength: number;
      refCount: number;
    }> = [];
    for (const [name, alloc] of this._allocations) {
      allocations.push({
        name,
        byteLength: alloc.byteLength,
        refCount: alloc.refCount,
      });
    }

    return {
      isShared: this._useShared,
      totalAllocated: this._totalAllocated,
      allocationCount: this._allocations.size,
      allocations,
    };
  }

  /**
   * Reset the singleton (for testing).
   * @private
   */
  static _resetInstance(): void {
    if (SharedResourcePool._instance) {
      SharedResourcePool._instance.releaseAll();
      SharedResourcePool._instance = null;
    }
  }
}

export default SharedResourcePool;
