/**
 * @module WebGPUIndirectDrawManager
 *
 * Manages indirect draw buffers for GPU-driven rendering.
 * Instead of issuing thousands of individual draw calls from the CPU,
 * a compute shader fills an indirect draw buffer with draw parameters,
 * and a single `drawIndexedIndirect()` or `drawIndirect()` call executes them all.
 *
 * This is the primary performance pattern for 3D Tiles rendering where
 * thousands of tile models need frustum/occlusion culling each frame.
 *
 * Architecture:
 * 1. CPU uploads per-instance data (bounding spheres, transforms) to storage buffers
 * 2. GPU compute shader performs culling and writes draw parameters to indirect buffer
 * 3. CPU issues a single drawIndexedIndirect() / multi-draw-indirect call
 *
 * @example
 * const manager = new WebGPUIndirectDrawManager(device, { maxDrawCalls: 4096 });
 * manager.beginFrame();
 * manager.addDrawCall({ vertexCount: 36, instanceCount: 1, ... });
 * manager.flush(); // Writes all draw params to GPU buffer
 * // In render pass:
 * renderPass.drawIndirect(manager.indirectBuffer, 0);
 */

/// <reference types="@webgpu/types" />

/**
 * Parameters for a single indirect draw call (non-indexed).
 * Matches the GPUDrawIndirectParameters layout (4 × uint32).
 */
export interface IndirectDrawParams {
  vertexCount: number;
  instanceCount: number;
  firstVertex: number;
  firstInstance: number;
}

/**
 * Parameters for a single indexed indirect draw call.
 * Matches the GPUDrawIndexedIndirectParameters layout (5 × uint32).
 */
export interface IndirectDrawIndexedParams {
  indexCount: number;
  instanceCount: number;
  firstIndex: number;
  baseVertex: number;
  firstInstance: number;
}

/**
 * Options for the indirect draw manager.
 */
export interface IndirectDrawManagerOptions {
  /** Maximum number of draw calls in a single indirect buffer (default: 4096) */
  maxDrawCalls?: number;
  /** Whether to use indexed draw calls (default: true) */
  indexed?: boolean;
  /** Label prefix for debug (default: 'IndirectDraw') */
  label?: string;
}

/**
 * Statistics for the indirect draw manager.
 */
export interface IndirectDrawStats {
  /** Number of draw calls queued this frame */
  drawCallCount: number;
  /** Maximum capacity */
  maxDrawCalls: number;
  /** Total instances across all draw calls */
  totalInstances: number;
  /** Total vertices/indices across all draw calls */
  totalVerticesOrIndices: number;
  /** Whether the buffer is indexed */
  indexed: boolean;
}

/**
 * Manages GPU indirect draw buffers for batch rendering.
 *
 * Supports both `drawIndirect` (4 uint32 per call) and
 * `drawIndexedIndirect` (5 uint32 per call) modes.
 */
export class WebGPUIndirectDrawManager {
  private _device: GPUDevice;
  private _maxDrawCalls: number;
  private _indexed: boolean;
  private _label: string;

  // GPU buffers
  private _indirectBuffer: GPUBuffer;
  private _drawCountBuffer: GPUBuffer; // Stores the actual number of draws

  // CPU staging data
  private _cpuBuffer: Uint32Array;
  private _drawCount: number = 0;
  private _strideInUint32s: number; // 4 for non-indexed, 5 for indexed
  private _strideInBytes: number;

  // Statistics
  private _totalInstances: number = 0;
  private _totalVerticesOrIndices: number = 0;

  private _isDestroyed: boolean = false;

  /**
   * Creates a new indirect draw manager.
   *
   * @param device - The GPU device
   * @param options - Configuration options
   */
  constructor(device: GPUDevice, options: IndirectDrawManagerOptions = {}) {
    this._device = device;
    this._maxDrawCalls = options.maxDrawCalls ?? 4096;
    this._indexed = options.indexed ?? true;
    this._label = options.label ?? "IndirectDraw";

    // Layout: 4 uint32s for non-indexed, 5 uint32s for indexed
    this._strideInUint32s = this._indexed ? 5 : 4;
    this._strideInBytes = this._strideInUint32s * 4;

    // CPU staging buffer
    const totalUint32s = this._maxDrawCalls * this._strideInUint32s;
    this._cpuBuffer = new Uint32Array(totalUint32s);

    // GPU indirect buffer
    this._indirectBuffer = device.createBuffer({
      size: totalUint32s * 4,
      usage:
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST,
      label: `${this._label} Indirect Buffer (${this._maxDrawCalls} draws)`,
    });

    // Draw count buffer (single uint32)
    this._drawCountBuffer = device.createBuffer({
      size: 4,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
      label: `${this._label} Draw Count Buffer`,
    });
  }

  /**
   * Begin a new frame. Resets all draw calls.
   */
  beginFrame(): void {
    this._drawCount = 0;
    this._totalInstances = 0;
    this._totalVerticesOrIndices = 0;
  }

  /**
   * Add a non-indexed draw call to the batch.
   *
   * @param params - Draw parameters
   * @returns The index of this draw call in the buffer
   */
  addDrawCall(params: IndirectDrawParams): number {
    if (this._drawCount >= this._maxDrawCalls) {
      console.warn(
        `[${this._label}] Max draw calls (${this._maxDrawCalls}) exceeded`,
      );
      return -1;
    }

    const offset = this._drawCount * this._strideInUint32s;
    this._cpuBuffer[offset + 0] = params.vertexCount;
    this._cpuBuffer[offset + 1] = params.instanceCount;
    this._cpuBuffer[offset + 2] = params.firstVertex;
    this._cpuBuffer[offset + 3] = params.firstInstance;

    this._totalInstances += params.instanceCount;
    this._totalVerticesOrIndices += params.vertexCount * params.instanceCount;

    return this._drawCount++;
  }

  /**
   * Add an indexed draw call to the batch.
   *
   * @param params - Indexed draw parameters
   * @returns The index of this draw call in the buffer
   */
  addIndexedDrawCall(params: IndirectDrawIndexedParams): number {
    if (this._drawCount >= this._maxDrawCalls) {
      console.warn(
        `[${this._label}] Max draw calls (${this._maxDrawCalls}) exceeded`,
      );
      return -1;
    }

    const offset = this._drawCount * this._strideInUint32s;
    this._cpuBuffer[offset + 0] = params.indexCount;
    this._cpuBuffer[offset + 1] = params.instanceCount;
    this._cpuBuffer[offset + 2] = params.firstIndex;
    this._cpuBuffer[offset + 3] = params.baseVertex;
    if (this._strideInUint32s >= 5) {
      this._cpuBuffer[offset + 4] = params.firstInstance;
    }

    this._totalInstances += params.instanceCount;
    this._totalVerticesOrIndices += params.indexCount * params.instanceCount;

    return this._drawCount++;
  }

  /**
   * Upload all queued draw calls to the GPU indirect buffer.
   * Call this after all addDrawCall/addIndexedDrawCall calls and before
   * issuing the render pass.
   */
  flush(): void {
    if (this._drawCount === 0) return;

    const byteLength = this._drawCount * this._strideInBytes;
    this._device.queue.writeBuffer(
      this._indirectBuffer,
      0,
      this._cpuBuffer.buffer,
      0,
      byteLength,
    );

    // Update draw count buffer
    const countData = new Uint32Array([this._drawCount]);
    this._device.queue.writeBuffer(this._drawCountBuffer, 0, countData);
  }

  /**
   * Clear a specific draw call's instance count to 0 (effectively culling it).
   * This can be done from a compute shader that writes to the indirect buffer.
   *
   * @param drawIndex - Index of the draw call to cull
   */
  cullDrawCall(drawIndex: number): void {
    if (drawIndex < 0 || drawIndex >= this._drawCount) return;
    const offset = drawIndex * this._strideInUint32s;
    this._cpuBuffer[offset + 1] = 0; // instanceCount = 0
  }

  /**
   * Execute all draw calls using drawIndirect (non-indexed).
   *
   * @param renderPass - The active render pass encoder
   */
  executeDrawIndirect(renderPass: GPURenderPassEncoder): void {
    for (let i = 0; i < this._drawCount; i++) {
      renderPass.drawIndirect(this._indirectBuffer, i * this._strideInBytes);
    }
  }

  /**
   * Execute all draw calls using drawIndexedIndirect.
   *
   * @param renderPass - The active render pass encoder
   */
  executeDrawIndexedIndirect(renderPass: GPURenderPassEncoder): void {
    for (let i = 0; i < this._drawCount; i++) {
      renderPass.drawIndexedIndirect(
        this._indirectBuffer,
        i * this._strideInBytes,
      );
    }
  }

  /**
   * The GPU indirect buffer (for use with drawIndirect/drawIndexedIndirect).
   */
  get indirectBuffer(): GPUBuffer {
    return this._indirectBuffer;
  }

  /**
   * The GPU buffer storing the draw count (for compute shader output).
   */
  get drawCountBuffer(): GPUBuffer {
    return this._drawCountBuffer;
  }

  /**
   * The number of draw calls queued this frame.
   */
  get drawCount(): number {
    return this._drawCount;
  }

  /**
   * Stride in bytes per draw call entry.
   */
  get strideInBytes(): number {
    return this._strideInBytes;
  }

  /**
   * Whether the manager uses indexed draw calls.
   */
  get indexed(): boolean {
    return this._indexed;
  }

  /**
   * Submit a homogeneous batch of WebGPUDrawCommands as a single indirect
   * draw sequence. All commands in the batch MUST share the same
   * pipeline, bind groups, vertex buffer layout, and (for indexed mode)
   * index buffer — only the per-call draw parameters may vary.
   *
   * This is the high-level entry point for tile collections (3D Tiles,
   * point clouds, batched primitives) to opt into GPU-driven rendering.
   * Steps the caller still owns:
   *   1. Pre-sort/group commands so each call here gets a homogeneous batch
   *   2. Bind the shared pipeline + bind groups + vertex/index buffers on
   *      the render pass *before* invoking executeDrawIndexedIndirect /
   *      executeDrawIndirect
   *   3. (Optional) Run a compute culler against the batch's bounding
   *      spheres to set instanceCount=0 on culled draws (see
   *      WebGPUGPUCuller.dispatch with mode=INDIRECT)
   *
   * Returns the index of the first draw call in the batch (subsequent
   * calls follow contiguously). Returns -1 on overflow.
   *
   * @param commands Array of compatible WebGPUDrawCommand-like objects
   * @returns First draw index, or -1 if the batch did not fit
   */
  submitBatch(commands: ReadonlyArray<any>): number {
    if (commands.length === 0) return this._drawCount;
    if (this._drawCount + commands.length > this._maxDrawCalls) {
      console.warn(
        `[${this._label}] submitBatch overflow: have=${this._drawCount} ` +
          `incoming=${commands.length} max=${this._maxDrawCalls}`,
      );
      return -1;
    }
    const firstIndex = this._drawCount;
    if (this._indexed) {
      for (const c of commands) {
        this.addIndexedDrawCall({
          indexCount: c.indexCount ?? c._indexCount ?? 0,
          instanceCount: c.instanceCount ?? c._instanceCount ?? 1,
          firstIndex: c.firstIndex ?? 0,
          baseVertex: c.baseVertex ?? 0,
          firstInstance: c.firstInstance ?? 0,
        });
      }
    } else {
      for (const c of commands) {
        this.addDrawCall({
          vertexCount: c.vertexCount ?? c._vertexCount ?? 0,
          instanceCount: c.instanceCount ?? c._instanceCount ?? 1,
          firstVertex: c.firstVertex ?? 0,
          firstInstance: c.firstInstance ?? 0,
        });
      }
    }
    return firstIndex;
  }

  /**
   * Execute a contiguous range of draw calls (the slice returned by
   * `submitBatch`) on the active render pass. Caller must have bound
   * the matching pipeline / vertex / index buffers first.
   *
   * @param renderPass Active render pass encoder
   * @param firstIndex Index returned by submitBatch
   * @param count Number of draws in the batch
   */
  executeBatchIndexed(
    renderPass: GPURenderPassEncoder,
    firstIndex: number,
    count: number,
  ): void {
    if (count <= 0) return;
    const stride = this._strideInBytes;
    const end = firstIndex + count;
    for (let i = firstIndex; i < end; i++) {
      renderPass.drawIndexedIndirect(this._indirectBuffer, i * stride);
    }
  }

  /**
   * Get statistics about the current frame's draw calls.
   */
  getStats(): IndirectDrawStats {
    return {
      drawCallCount: this._drawCount,
      maxDrawCalls: this._maxDrawCalls,
      totalInstances: this._totalInstances,
      totalVerticesOrIndices: this._totalVerticesOrIndices,
      indexed: this._indexed,
    };
  }

  /**
   * Whether the manager has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Destroy GPU resources.
   */
  destroy(): void {
    if (this._isDestroyed) return;
    this._indirectBuffer.destroy();
    this._drawCountBuffer.destroy();
    this._isDestroyed = true;
  }
}

export default WebGPUIndirectDrawManager;
