/**
 * @module WebGPURingBufferAllocator
 *
 * Per-frame ring buffer allocator for uniform data.
 * Eliminates per-frame GPU buffer creation by sub-allocating from large
 * backing buffers in a circular fashion.
 *
 * Architecture:
 * - Maintains N "pages" (large GPU buffers) that are cycled through
 * - Each frame advances to the next page
 * - Within a frame, allocations bump a write offset within the current page
 * - Old pages are safe to reuse after GPU has consumed them (N frames later)
 *
 * @example
 * const allocator = new WebGPURingBufferAllocator(device, {
 *   pageSize: 4 * 1024 * 1024,  // 4MB per page
 *   pageCount: 3,                // triple-buffer
 * });
 *
 * // Each frame:
 * allocator.beginFrame();
 * const alloc = allocator.allocate(256); // 256 bytes for a uniform block
 * device.queue.writeBuffer(alloc.buffer, alloc.offset, data);
 * // Use alloc.buffer + alloc.offset in bind group
 * allocator.endFrame();
 */

/// <reference types="@webgpu/types" />

/**
 * Represents a single allocation within a ring buffer page.
 */
export interface RingBufferAllocation {
  /** The GPU buffer containing this allocation */
  buffer: GPUBuffer;
  /** Byte offset within the buffer */
  offset: number;
  /** Size in bytes of this allocation */
  size: number;
  /** The page index this allocation belongs to */
  pageIndex: number;
}

/**
 * Configuration options for the ring buffer allocator.
 */
export interface RingBufferAllocatorOptions {
  /** Size of each backing buffer page in bytes (default: 4MB) */
  pageSize?: number;
  /** Number of pages to cycle through (default: 3 for triple-buffering) */
  pageCount?: number;
  /** Buffer usage flags (default: UNIFORM | COPY_DST) */
  usage?: GPUBufferUsageFlags;
  /** Minimum alignment for allocations in bytes (default: 256 for UBOs) */
  minAlignment?: number;
  /** Label prefix for debug (default: 'RingBuffer') */
  label?: string;
  /**
   * Maximum total page count (steady + overflow) before allocation throws.
   * Acts as a circuit breaker against runaway accretion. Default: 32.
   */
  maxPageCount?: number;
  /**
   * Auto-trim cadence: trim overflow pages every N successful frames.
   * Set to 0 to disable auto-trim (caller must call trimOverflowPages
   * manually). Default: 60.
   */
  autoTrimEveryFrames?: number;
}

/**
 * Statistics for the ring buffer allocator.
 */
export interface RingBufferStats {
  /** Total bytes allocated across all pages */
  totalCapacity: number;
  /** Bytes used in the current frame */
  currentFrameUsed: number;
  /** Peak bytes used in any single frame */
  peakFrameUsage: number;
  /** Number of allocations in the current frame */
  currentFrameAllocations: number;
  /** Total number of page overflows (new pages created dynamically) */
  overflowCount: number;
  /** Number of active pages */
  pageCount: number;
}

/**
 * A single page in the ring buffer.
 */
interface RingBufferPage {
  buffer: GPUBuffer;
  size: number;
}

/**
 * Ring buffer sub-allocator for per-frame GPU data.
 *
 * Instead of creating new GPUBuffers every frame (expensive), this allocator
 * maintains a small set of large backing buffers and sub-allocates from them
 * in a circular fashion.
 */
export class WebGPURingBufferAllocator {
  private _device: GPUDevice;
  private _pages: RingBufferPage[] = [];
  private _pageSize: number;
  private _pageCount: number;
  private _usage: GPUBufferUsageFlags;
  private _minAlignment: number;
  private _label: string;

  // Frame state
  private _currentPageIndex: number = 0;
  private _currentOffset: number = 0;
  private _frameAllocations: number = 0;
  private _isInFrame: boolean = false;

  // Statistics
  private _peakFrameUsage: number = 0;
  private _overflowCount: number = 0;
  private _frameCount: number = 0;
  private _maxPageCount: number;
  private _autoTrimEveryFrames: number;
  private _hasWarnedOverflow: boolean = false;

  private _isDestroyed: boolean = false;

  /**
   * Creates a new ring buffer allocator.
   *
   * @param device - The GPU device
   * @param options - Configuration options
   */
  constructor(device: GPUDevice, options: RingBufferAllocatorOptions = {}) {
    this._device = device;
    this._pageSize = options.pageSize ?? 4 * 1024 * 1024; // 4MB default
    this._pageCount = options.pageCount ?? 3;
    this._usage =
      options.usage ?? GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST;
    this._minAlignment = options.minAlignment ?? 256; // UBO alignment
    this._label = options.label ?? "RingBuffer";
    this._maxPageCount = options.maxPageCount ?? 32;
    this._autoTrimEveryFrames = options.autoTrimEveryFrames ?? 60;

    // Pre-create all pages
    for (let i = 0; i < this._pageCount; i++) {
      this._createPage(i);
    }
  }

  /**
   * Creates a new backing buffer page.
   * @private
   */
  private _createPage(index: number): void {
    const buffer = this._device.createBuffer({
      size: this._pageSize,
      usage: this._usage,
      label: `${this._label} Page ${index} (${(this._pageSize / 1024 / 1024).toFixed(1)}MB)`,
    });

    this._pages.push({ buffer, size: this._pageSize });
  }

  /**
   * Begin a new frame. Advances to the next page in the ring.
   * Must be called once per frame before any allocations.
   */
  beginFrame(): void {
    // Track peak usage from previous frame
    if (this._currentOffset > this._peakFrameUsage) {
      this._peakFrameUsage = this._currentOffset;
    }

    // Advance to next page (circular)
    this._currentPageIndex = (this._currentPageIndex + 1) % this._pages.length;
    this._currentOffset = 0;
    this._frameAllocations = 0;
    this._isInFrame = true;
  }

  /**
   * End the current frame. Finalizes allocations and reclaims memory from
   * any temporary overflow pages on a fixed cadence so the allocator
   * does not silently drift into arena-allocator territory.
   */
  endFrame(): void {
    this._isInFrame = false;
    this._frameCount++;
    if (
      this._autoTrimEveryFrames > 0 &&
      this._pages.length > this._pageCount &&
      this._frameCount % this._autoTrimEveryFrames === 0
    ) {
      this.trimOverflowPages();
    }
  }

  /**
   * Allocate a block of bytes from the current frame's page.
   *
   * The allocation is aligned to `minAlignment` (default 256 bytes for UBOs).
   * If the current page is full, a new overflow page is created dynamically.
   *
   * @param size - Number of bytes to allocate
   * @returns The allocation descriptor with buffer, offset, and size
   */
  allocate(size: number): RingBufferAllocation {
    // Align the offset
    const alignedOffset = this._alignOffset(this._currentOffset);
    // Align the size to ensure next allocation starts aligned
    const alignedSize = this._alignSize(size);

    // Check if current page has room
    const currentPage = this._pages[this._currentPageIndex];
    if (alignedOffset + alignedSize > currentPage.size) {
      // Current page is full — create overflow page
      if (this._pages.length >= this._maxPageCount) {
        throw new Error(
          `[CesiumJS:webgpu] Ring allocator "${this._label}" exceeded ` +
            `maxPageCount=${this._maxPageCount} (${this._overflowCount} overflows). ` +
            `Increase pageSize, reduce per-frame uniform writes, or raise maxPageCount.`,
        );
      }
      this._overflowCount++;
      if (!this._hasWarnedOverflow) {
        this._hasWarnedOverflow = true;
        console.warn(
          `[CesiumJS:webgpu] Ring allocator "${this._label}" overflowed its ` +
            `${(this._pageSize / 1024 / 1024).toFixed(1)}MB page. ` +
            `Consider raising pageSize. Overflow pages auto-trim every ` +
            `${this._autoTrimEveryFrames} frames.`,
        );
      }
      const overflowSize = Math.max(this._pageSize, alignedSize);
      const overflowIndex = this._pages.length;

      const buffer = this._device.createBuffer({
        size: overflowSize,
        usage: this._usage,
        label: `${this._label} Overflow Page ${overflowIndex}`,
      });

      this._pages.push({ buffer, size: overflowSize });
      this._currentPageIndex = overflowIndex;
      this._currentOffset = 0;

      // Recurse with the new page
      return this.allocate(size);
    }

    const allocation: RingBufferAllocation = {
      buffer: currentPage.buffer,
      offset: alignedOffset,
      size: alignedSize,
      pageIndex: this._currentPageIndex,
    };

    this._currentOffset = alignedOffset + alignedSize;
    this._frameAllocations++;

    return allocation;
  }

  /**
   * Allocate and immediately write data.
   *
   * Convenience method that combines allocate() + writeBuffer().
   *
   * @param data - The data to write (typed array or ArrayBuffer)
   * @returns The allocation descriptor
   */
  allocateAndWrite(data: ArrayBuffer | ArrayBufferView): RingBufferAllocation {
    const byteLength =
      data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
    const allocation = this.allocate(byteLength);

    if (data instanceof ArrayBuffer) {
      this._device.queue.writeBuffer(
        allocation.buffer,
        allocation.offset,
        data,
      );
    } else {
      this._device.queue.writeBuffer(
        allocation.buffer,
        allocation.offset,
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
    }

    return allocation;
  }

  /**
   * Get statistics about the allocator.
   */
  getStats(): RingBufferStats {
    return {
      totalCapacity: this._pages.reduce((sum, p) => sum + p.size, 0),
      currentFrameUsed: this._currentOffset,
      peakFrameUsage: this._peakFrameUsage,
      currentFrameAllocations: this._frameAllocations,
      overflowCount: this._overflowCount,
      pageCount: this._pages.length,
    };
  }

  /**
   * Reset statistics counters.
   */
  resetStats(): void {
    this._peakFrameUsage = 0;
    this._overflowCount = 0;
  }

  /**
   * Trim overflow pages back to the original page count.
   * Call this periodically (e.g., every 60 frames) to reclaim memory
   * from temporary overflow pages.
   */
  trimOverflowPages(): void {
    while (this._pages.length > this._pageCount) {
      const page = this._pages.pop()!;
      page.buffer.destroy();
    }
    // Ensure current page index is valid
    if (this._currentPageIndex >= this._pages.length) {
      this._currentPageIndex = 0;
    }
  }

  /**
   * Align an offset to the minimum alignment boundary.
   * @private
   */
  private _alignOffset(offset: number): number {
    return Math.ceil(offset / this._minAlignment) * this._minAlignment;
  }

  /**
   * Align a size to 4-byte boundary (WebGPU requirement).
   * @private
   */
  private _alignSize(size: number): number {
    return Math.ceil(size / 4) * 4;
  }

  /**
   * Whether the allocator has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * The current page's GPU buffer (for creating bind groups).
   */
  get currentBuffer(): GPUBuffer {
    return this._pages[this._currentPageIndex].buffer;
  }

  /**
   * Destroy all pages and free GPU memory.
   */
  destroy(): void {
    if (this._isDestroyed) return;
    for (const page of this._pages) {
      page.buffer.destroy();
    }
    this._pages = [];
    this._isDestroyed = true;
  }
}

export default WebGPURingBufferAllocator;
