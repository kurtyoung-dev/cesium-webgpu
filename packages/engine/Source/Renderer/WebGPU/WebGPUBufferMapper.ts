/// <reference types="@webgpu/types" />
/**
 * Efficient CPU↔GPU buffer access via `buffer.mapAsync()` + `getMappedRange()`.
 *
 * mapAsync() provides direct memory access to GPU buffers without intermediate
 * copies (unlike writeBuffer which always copies). This is more efficient for:
 * - Large terrain data uploads (staging buffer → GPU)
 * - Pick readback (GPU → CPU)
 * - Compute shader result readback
 *
 * The mapper manages staging buffers and double-buffering to prevent GPU stalls.
 *
 * @example
 * const mapper = new WebGPUBufferMapper(device);
 *
 * // Upload large data via staging:
 * await mapper.uploadViaStagingBuffer(destBuffer, terrainData);
 *
 * // Read back data:
 * const result = await mapper.readbackBuffer(sourceBuffer, byteLength);
 * @module WebGPUBufferMapper
 */

/**
 * Upload options for staging buffer transfers.
 */
export interface StagingUploadOptions {
  /** Offset in destination buffer (default: 0) */
  destOffset?: number;
  /** Optional label */
  label?: string;
}

/**
 * Readback options.
 */
export interface ReadbackOptions {
  /** Offset in source buffer (default: 0) */
  srcOffset?: number;
  /** Optional label */
  label?: string;
}

/**
 * Statistics for the buffer mapper.
 */
export interface BufferMapperStats {
  /** Number of staging uploads performed */
  uploadCount: number;
  /** Number of readbacks performed */
  readbackCount: number;
  /** Total bytes uploaded via staging */
  totalBytesUploaded: number;
  /** Total bytes read back */
  totalBytesReadback: number;
  /** Staging buffers currently cached */
  cachedStagingBuffers: number;
}

/**
 * Cached staging buffer entry.
 */
interface StagingEntry {
  buffer: GPUBuffer;
  size: number;
  lastUsed: number;
}

/**
 * Manages efficient CPU↔GPU buffer transfers using buffer mapping.
 *
 * Key advantage over writeBuffer(): for large uploads, mapping a staging
 * buffer and writing directly is more efficient because:
 * 1. No intermediate copy in the driver
 * 2. Data is written directly to GPU-visible memory
 * 3. The staging buffer can be reused across frames
 */
export class WebGPUBufferMapper {
  private _device: GPUDevice;

  // Staging buffer cache (for uploads)
  private _stagingCache: StagingEntry[] = [];
  private _maxCachedBuffers: number = 4;

  // Readback buffer cache
  private _readbackCache: StagingEntry[] = [];

  // Statistics
  private _uploadCount: number = 0;
  private _readbackCount: number = 0;
  private _totalBytesUploaded: number = 0;
  private _totalBytesReadback: number = 0;
  private _frameCount: number = 0;

  private _isDestroyed: boolean = false;

  constructor(device: GPUDevice) {
    this._device = device;
  }

  /**
   * Upload data to a GPU buffer via a staging buffer with mapAsync.
   *
   * Flow: create/reuse staging buffer → mapAsync(WRITE) → write data →
   * unmap → copyBufferToBuffer (staging → dest)
   *
   * @param destBuffer - The destination GPU buffer
   * @param data - The data to upload
   * @param options - Upload options
   */
  async uploadViaStagingBuffer(
    destBuffer: GPUBuffer,
    data: ArrayBuffer | ArrayBufferView,
    options: StagingUploadOptions = {},
  ): Promise<void> {
    const byteLength =
      data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
    const destOffset = options.destOffset ?? 0;

    // Align to 4 bytes
    const alignedSize = Math.ceil(byteLength / 4) * 4;

    // Get or create staging buffer
    const staging = this._getStagingBuffer(alignedSize, GPUMapMode.WRITE);

    // Map and write. Guard against destruction during the await (viewer
    // teardown / device-loss race): calling getMappedRange on a destroyed
    // staging buffer throws, and leaving it in the mapped-pending state
    // permanently wedges the buffer pool entry.
    await staging.mapAsync(GPUMapMode.WRITE);
    if (this._isDestroyed) {
      try {
        staging.unmap();
      } catch {
        /* already unmapped or destroyed */
      }
      return;
    }
    const mappedRange = new Uint8Array(staging.getMappedRange(0, alignedSize));

    if (data instanceof ArrayBuffer) {
      mappedRange.set(new Uint8Array(data));
    } else {
      mappedRange.set(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    }

    staging.unmap();

    // Copy staging → dest
    const encoder = this._device.createCommandEncoder({
      label: options.label ?? "Staging Upload",
    });
    encoder.copyBufferToBuffer(staging, 0, destBuffer, destOffset, alignedSize);
    this._device.queue.submit([encoder.finish()]);

    this._uploadCount++;
    this._totalBytesUploaded += byteLength;
  }

  /**
   * Read data back from a GPU buffer.
   *
   * Flow: copyBufferToBuffer (src → readback) → submit →
   * mapAsync(READ) → getMappedRange → copy to result
   *
   * @param srcBuffer - The source GPU buffer (must have COPY_SRC usage)
   * @param byteLength - Number of bytes to read
   * @param options - Readback options
   * @returns The data as a Uint8Array
   */
  async readbackBuffer(
    srcBuffer: GPUBuffer,
    byteLength: number,
    options: ReadbackOptions = {},
  ): Promise<Uint8Array> {
    const srcOffset = options.srcOffset ?? 0;
    const alignedSize = Math.ceil(byteLength / 4) * 4;

    // Create readback buffer
    const readback = this._getReadbackBuffer(alignedSize);

    // Copy src → readback
    const encoder = this._device.createCommandEncoder({
      label: options.label ?? "Buffer Readback",
    });
    encoder.copyBufferToBuffer(srcBuffer, srcOffset, readback, 0, alignedSize);
    this._device.queue.submit([encoder.finish()]);

    // Map and read. Same destroyed-guard pattern as the upload path above.
    await readback.mapAsync(GPUMapMode.READ);
    if (this._isDestroyed) {
      try {
        readback.unmap();
      } catch {
        /* already unmapped or destroyed */
      }
      return new Uint8Array(byteLength);
    }
    const mappedData = new Uint8Array(readback.getMappedRange(0, alignedSize));
    const result = new Uint8Array(byteLength);
    result.set(mappedData.subarray(0, byteLength));
    readback.unmap();

    this._readbackCount++;
    this._totalBytesReadback += byteLength;

    return result;
  }

  /**
   * Read back buffer data as a typed array.
   *
   * @param srcBuffer - Source GPU buffer
   * @param byteLength - Bytes to read
   * @param TypedArrayCtor - Constructor for the result type
   * @returns Typed array with the data
   */
  async readbackTyped<
    T extends Float32Array | Uint32Array | Int32Array | Uint16Array,
  >(
    srcBuffer: GPUBuffer,
    byteLength: number,
    TypedArrayCtor: new (buffer: ArrayBuffer) => T,
  ): Promise<T> {
    const data = await this.readbackBuffer(srcBuffer, byteLength);
    return new TypedArrayCtor(data.buffer as ArrayBuffer);
  }

  /**
   * Get or create a staging buffer for uploads.
   * @private
   */
  private _getStagingBuffer(size: number, mode: GPUMapModeFlags): GPUBuffer {
    // Try to find a cached buffer of sufficient size
    for (let i = 0; i < this._stagingCache.length; i++) {
      const entry = this._stagingCache[i];
      if (entry.size >= size && entry.size <= size * 2) {
        this._stagingCache.splice(i, 1);
        entry.lastUsed = this._frameCount;
        return entry.buffer;
      }
    }

    // Create new
    const usage =
      mode === GPUMapMode.WRITE
        ? GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC
        : GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST;

    return this._device.createBuffer({
      size,
      usage,
      label: `Staging Buffer (${size} bytes)`,
    });
  }

  /**
   * Get or create a readback buffer.
   * @private
   */
  private _getReadbackBuffer(size: number): GPUBuffer {
    for (let i = 0; i < this._readbackCache.length; i++) {
      const entry = this._readbackCache[i];
      if (entry.size >= size && entry.size <= size * 2) {
        this._readbackCache.splice(i, 1);
        return entry.buffer;
      }
    }

    return this._device.createBuffer({
      size,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      label: `Readback Buffer (${size} bytes)`,
    });
  }

  /**
   * Advance frame counter and trim old staging buffers.
   */
  advanceFrame(): void {
    this._frameCount++;

    // Trim staging cache
    while (this._stagingCache.length > this._maxCachedBuffers) {
      const entry = this._stagingCache.shift()!;
      entry.buffer.destroy();
    }
    while (this._readbackCache.length > this._maxCachedBuffers) {
      const entry = this._readbackCache.shift()!;
      entry.buffer.destroy();
    }
  }

  /** Get statistics */
  getStats(): BufferMapperStats {
    return {
      uploadCount: this._uploadCount,
      readbackCount: this._readbackCount,
      totalBytesUploaded: this._totalBytesUploaded,
      totalBytesReadback: this._totalBytesReadback,
      cachedStagingBuffers:
        this._stagingCache.length + this._readbackCache.length,
    };
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  destroy(): void {
    if (this._isDestroyed) return;
    for (const e of this._stagingCache) e.buffer.destroy();
    for (const e of this._readbackCache) e.buffer.destroy();
    this._stagingCache = [];
    this._readbackCache = [];
    this._isDestroyed = true;
  }
}

export default WebGPUBufferMapper;
