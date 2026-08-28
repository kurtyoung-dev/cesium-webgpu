/// <reference types="@webgpu/types" />
/**
 * WebGPU Entity-Cluster grid dispatcher (Phase 10, NEW-ENTITYCLUSTER-GPU).
 *
 * Runtime wrapper around `EntityClusterGridGPU.wgsl`. Owns the input coord
 * buffer, the per-cell atomic count + representative buffers, the per-point
 * cell-id output, the params UBO, and the readback staging buffers. Exposes a
 * single `computeGrid()` entry point that uploads the screen-space coords,
 * clears the per-cell accumulators, dispatches the one-pass bin/count, and
 * reads back the per-cell aggregates so the (CPU) merge step can run over the
 * NON-EMPTY cells instead of every point.
 *
 * Why a GPU bin/count + CPU merge split (not a full GPU clusterer):
 *
 *   The expensive part of `EntityCluster`'s declutter at 50k+ markers is the
 *   per-frame `new KDBush(...)` build (O(N log N)) plus the greedy neighbour
 *   range-query loop. The BINNING half — assign every visible point to a
 *   screen-space grid cell and count occupancy — is embarrassingly parallel
 *   and is what this dispatcher offloads (a single O(N) compute pass). The
 *   REPRESENTATIVE-SELECTION + 3×3-neighbourhood MERGE half is inherently
 *   sequential (greedy claim-and-mark) and is best left on the CPU, where it
 *   now iterates over the reduced non-empty-cell set rather than N points.
 *   This is the standard "GPU reduce, CPU finish the small tail" decomposition
 *   and mirrors how `WebGPUGPUSortKeysDispatcher` produces keys the CPU/GPU
 *   consumer then orders. A fully-GPU merge (parallel union-find over the grid)
 *   is tracked as a follow-up — see NEW-ENTITYCLUSTER-GPU-MERGE in
 *   DEFERRED_WORK.md.
 *
 * Lifetime: one instance per GPUDevice, cached in a WeakMap keyed by context.
 * Buffers grow on demand for the point count and grid size; the readback is
 * the standard one-frame-latency `mapAsync` contract (the caller drops a call
 * while one is in flight). Declutter already lags the camera by a frame (it
 * runs off `camera.changed`), so a one-frame-stale grid is visually identical.
 *
 * @private
 * @module WebGPUEntityClusterDispatcher
 */

import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import { getAvailableFrameCommandEncoder } from "./WebGPUFrameCommandEncoder.js";

import EntityClusterGridGPUSource from "../../Shaders/WebGPU/Compute/EntityClusterGridGPU.js";

const PARAMS_BYTES = 32; // 8 × 4 bytes (u32 pointCount/gridCols/gridRows + f32 cellSize/originX/originY + 2 pad)
const WORKGROUP_SIZE = 256;
const EMPTY = 0xffffffff;

/** Result of one `computeGrid` call. All arrays are length `cellCount`
 *  (== gridCols * gridRows) except `pointCellId` which is length `pointCount`. */
export interface ClusterGridResult {
  gridCols: number;
  gridRows: number;
  cellSize: number;
  originX: number;
  originY: number;
  /** Per-cell occupancy count. */
  cellCounts: Uint32Array;
  /** Per-cell smallest member point index (== EMPTY for empty cells). */
  cellRep: Uint32Array;
  /** Per-point cell id (row * gridCols + col), or EMPTY for skipped points. */
  pointCellId: Uint32Array;
}

interface ClusterGridResources {
  pointCapacity: number;
  cellCapacity: number;
  paramsBuffer: GPUBuffer;
  coordsBuffer: GPUBuffer;
  cellCountsBuffer: GPUBuffer;
  cellRepBuffer: GPUBuffer;
  pointCellIdBuffer: GPUBuffer;
  cellCountsReadback: GPUBuffer;
  cellRepReadback: GPUBuffer;
  pointCellIdReadback: GPUBuffer;
  bindGroupLayout: GPUBindGroupLayout;
  bindGroup: GPUBindGroup;
  pipeline: GPUComputePipeline;
}

class WebGPUEntityClusterDispatcher {
  private _device: GPUDevice;
  private _shaderModule: GPUShaderModule | null = null;
  private _resources: ClusterGridResources | null = null;
  private _readbackInFlight = false;
  private _dispatches = 0;
  private _lastPointCount = 0;
  private _lastCellCount = 0;
  // Reusable scratch for the params UBO upload.
  private _paramsScratch = new ArrayBuffer(PARAMS_BYTES);
  private _paramsU32: Uint32Array;
  private _paramsF32: Float32Array;
  // Reusable fill scratch for the atomic-min representative sentinel; grown as
  // the cell count grows. Counts are cleared on-GPU with encoder.clearBuffer.
  private _clearRep: Uint32Array = new Uint32Array(0);

  constructor(device: GPUDevice) {
    this._device = device;
    this._paramsU32 = new Uint32Array(this._paramsScratch);
    this._paramsF32 = new Float32Array(this._paramsScratch);
    this._shaderModule = device.createShaderModule({
      label: "EntityClusterGridGPU_Shader",
      code: EntityClusterGridGPUSource,
    });
  }

  get statistics(): {
    allocated: boolean;
    pointCapacity: number;
    cellCapacity: number;
    dispatches: number;
    lastPointCount: number;
    lastCellCount: number;
  } {
    return {
      allocated: !!this._resources,
      pointCapacity: this._resources?.pointCapacity ?? 0,
      cellCapacity: this._resources?.cellCapacity ?? 0,
      dispatches: this._dispatches,
      lastPointCount: this._lastPointCount,
      lastCellCount: this._lastCellCount,
    };
  }

  private _ensureResources(pointCount: number, cellCount: number): boolean {
    const r = this._resources;
    if (r && r.pointCapacity >= pointCount && r.cellCapacity >= cellCount) {
      return true;
    }
    // Grow generously to amortize reallocation across camera moves.
    const pointCap = Math.max(pointCount, r ? r.pointCapacity * 2 : 4096);
    const cellCap = Math.max(cellCount, r ? r.cellCapacity * 2 : 4096);
    this._destroyResources();

    const device = this._device;
    const paramsBuffer = device.createBuffer({
      label: "EntityClusterGrid_Params",
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const coordsBuffer = device.createBuffer({
      label: "EntityClusterGrid_Coords",
      size: pointCap * 16, // vec4<f32>
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const mkCellRW = (label: string) =>
      device.createBuffer({
        label,
        size: cellCap * 4,
        usage:
          GPUBufferUsage.STORAGE |
          GPUBufferUsage.COPY_DST |
          GPUBufferUsage.COPY_SRC,
      });
    const cellCountsBuffer = mkCellRW("EntityClusterGrid_CellCounts");
    const cellRepBuffer = mkCellRW("EntityClusterGrid_CellRep");
    const pointCellIdBuffer = device.createBuffer({
      label: "EntityClusterGrid_PointCellId",
      size: pointCap * 4,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_DST |
        GPUBufferUsage.COPY_SRC,
    });
    const mkReadback = (label: string, size: number) =>
      device.createBuffer({
        label,
        size,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
    const cellCountsReadback = mkReadback(
      "EntityClusterGrid_CellCountsRB",
      cellCap * 4,
    );
    const cellRepReadback = mkReadback(
      "EntityClusterGrid_CellRepRB",
      cellCap * 4,
    );
    const pointCellIdReadback = mkReadback(
      "EntityClusterGrid_PointCellIdRB",
      pointCap * 4,
    );

    const bindGroupLayout = makeBindGroupLayout(
      device,
      "EntityClusterGrid_BGL",
      [
        uniformBuffer(0, Stage.COMPUTE),
        storageBuffer(1, Stage.COMPUTE, { readOnly: true }),
        storageBuffer(2, Stage.COMPUTE),
        storageBuffer(3, Stage.COMPUTE),
        storageBuffer(4, Stage.COMPUTE),
      ],
    );
    const bindGroup = device.createBindGroup({
      label: "EntityClusterGrid_BG",
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: coordsBuffer } },
        { binding: 2, resource: { buffer: cellCountsBuffer } },
        { binding: 3, resource: { buffer: cellRepBuffer } },
        { binding: 4, resource: { buffer: pointCellIdBuffer } },
      ],
    });
    const pipeline = device.createComputePipeline({
      label: "EntityClusterGrid_Pipeline",
      layout: device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout],
      }),
      compute: { module: this._shaderModule!, entryPoint: "main" },
    });

    this._resources = {
      pointCapacity: pointCap,
      cellCapacity: cellCap,
      paramsBuffer,
      coordsBuffer,
      cellCountsBuffer,
      cellRepBuffer,
      pointCellIdBuffer,
      cellCountsReadback,
      cellRepReadback,
      pointCellIdReadback,
      bindGroupLayout,
      bindGroup,
      pipeline,
    };
    return true;
  }

  /**
   * Upload `coords` (a flat Float32Array of length pointCount*4: x,y,0,0 per
   * point; x < -1e30 marks a skipped point), bin them into the grid, and read
   * back the per-cell aggregates. Returns null when a readback is already in
   * flight (caller drops + retries next frame — the previous grid stays valid).
   */
  async computeGrid(
    coords: Float32Array,
    pointCount: number,
    gridCols: number,
    gridRows: number,
    cellSize: number,
    originX: number,
    originY: number,
    frameContext?: ClusterDispatcherContext,
  ): Promise<ClusterGridResult | null> {
    if (pointCount <= 0 || gridCols <= 0 || gridRows <= 0) {
      return null;
    }
    if (this._readbackInFlight) {
      return null;
    }
    const cellCount = gridCols * gridRows;
    if (!this._ensureResources(pointCount, cellCount)) {
      return null;
    }
    const r = this._resources!;
    const device = this._device;

    // Upload coords (only the valid range).
    device.queue.writeBuffer(
      r.coordsBuffer,
      0,
      coords.buffer,
      coords.byteOffset,
      pointCount * 16,
    );

    // Clear per-cell accumulators: counts → 0, rep → EMPTY. Counts join the
    // compute command stream via clearBuffer, avoiding a CPU zero-fill upload.
    // Atomic-min representatives still require the all-ones sentinel.
    if (this._clearRep.length < cellCount) {
      this._clearRep = new Uint32Array(cellCount);
    }
    this._clearRep.fill(EMPTY, 0, cellCount);
    device.queue.writeBuffer(
      r.cellRepBuffer,
      0,
      this._clearRep.buffer,
      0,
      cellCount * 4,
    );

    // Params UBO.
    this._paramsU32[0] = pointCount;
    this._paramsU32[1] = gridCols;
    this._paramsU32[2] = gridRows;
    this._paramsF32[3] = cellSize;
    this._paramsF32[4] = originX;
    this._paramsF32[5] = originY;
    this._paramsU32[6] = 0;
    this._paramsU32[7] = 0;
    device.queue.writeBuffer(r.paramsBuffer, 0, this._paramsScratch);

    const frameEncoder = getAvailableFrameCommandEncoder(frameContext);
    let frameSubmission: Promise<boolean> | null = null;
    let usesFrameEncoder = false;
    if (
      frameEncoder &&
      typeof frameContext?.enqueueAfterFrameSubmit === "function"
    ) {
      frameSubmission = new Promise<boolean>((resolve) => {
        usesFrameEncoder = frameContext.enqueueAfterFrameSubmit!.call(
          frameContext,
          resolve,
        );
      });
      if (!usesFrameEncoder) {
        frameSubmission = null;
      }
    }
    const encoder = usesFrameEncoder
      ? frameEncoder!
      : device.createCommandEncoder({ label: "EntityClusterGrid_Encoder" });
    encoder.clearBuffer(r.cellCountsBuffer, 0, cellCount * 4);
    const pass = encoder.beginComputePass({ label: "EntityClusterGrid_Pass" });
    pass.setPipeline(r.pipeline);
    pass.setBindGroup(0, r.bindGroup);
    pass.dispatchWorkgroups(Math.ceil(pointCount / WORKGROUP_SIZE), 1, 1);
    pass.end();

    // Stage readbacks.
    encoder.copyBufferToBuffer(
      r.cellCountsBuffer,
      0,
      r.cellCountsReadback,
      0,
      cellCount * 4,
    );
    encoder.copyBufferToBuffer(
      r.cellRepBuffer,
      0,
      r.cellRepReadback,
      0,
      cellCount * 4,
    );
    encoder.copyBufferToBuffer(
      r.pointCellIdBuffer,
      0,
      r.pointCellIdReadback,
      0,
      pointCount * 4,
    );
    if (!usesFrameEncoder) {
      device.queue.submit([encoder.finish()]);
    }

    this._dispatches++;
    this._lastPointCount = pointCount;
    this._lastCellCount = cellCount;

    this._readbackInFlight = true;
    try {
      if (frameSubmission && !(await frameSubmission)) {
        return null;
      }
      await Promise.all([
        r.cellCountsReadback.mapAsync(GPUMapMode.READ, 0, cellCount * 4),
        r.cellRepReadback.mapAsync(GPUMapMode.READ, 0, cellCount * 4),
        r.pointCellIdReadback.mapAsync(GPUMapMode.READ, 0, pointCount * 4),
      ]);
      const cellCounts = new Uint32Array(
        r.cellCountsReadback.getMappedRange(0, cellCount * 4),
      ).slice();
      const cellRep = new Uint32Array(
        r.cellRepReadback.getMappedRange(0, cellCount * 4),
      ).slice();
      const pointCellId = new Uint32Array(
        r.pointCellIdReadback.getMappedRange(0, pointCount * 4),
      ).slice();
      r.cellCountsReadback.unmap();
      r.cellRepReadback.unmap();
      r.pointCellIdReadback.unmap();
      return {
        gridCols,
        gridRows,
        cellSize,
        originX,
        originY,
        cellCounts,
        cellRep,
        pointCellId,
      };
    } catch (e) {
      // Real error — a failed readback means the GPU path produced nothing;
      // the caller must fall back to the CPU clusterer this frame.
      console.error(
        `[WebGPUEntityClusterDispatcher] grid readback failed: ${
          (e as Error).message
        }`,
      );
      return null;
    } finally {
      this._readbackInFlight = false;
    }
  }

  private _destroyResources(): void {
    const r = this._resources;
    if (!r) {
      return;
    }
    try {
      r.paramsBuffer.destroy();
      r.coordsBuffer.destroy();
      r.cellCountsBuffer.destroy();
      r.cellRepBuffer.destroy();
      r.pointCellIdBuffer.destroy();
      r.cellCountsReadback.destroy();
      r.cellRepReadback.destroy();
      r.pointCellIdReadback.destroy();
    } catch (_e) {
      // Defensive — double-destroy is a no-op.
    }
    this._resources = null;
  }

  destroy(): void {
    this._destroyResources();
    this._readbackInFlight = false;
  }
}

// ─── Feature-renderer factory + entry points ───────────────────────────────

interface ClusterDispatcherContext {
  device: GPUDevice | null | undefined;
  readonly currentCommandEncoder?: GPUCommandEncoder | null;
  readonly _currentCommandEncoder?: GPUCommandEncoder | null;
  readonly hasActiveRenderPass?: boolean;
  readonly _currentRenderPassEncoder?: GPURenderPassEncoder | null;
  enqueueAfterFrameSubmit?(callback: (submitted: boolean) => void): boolean;
}

const _instances = new WeakMap<object, WebGPUEntityClusterDispatcher>();

function getOrCreateDispatcher(
  context: ClusterDispatcherContext,
): WebGPUEntityClusterDispatcher | null {
  if (!context || !context.device) {
    return null;
  }
  let inst = _instances.get(context);
  if (!inst) {
    inst = new WebGPUEntityClusterDispatcher(context.device);
    _instances.set(context, inst);
  }
  return inst;
}

/**
 * FR entry point: compute the screen-space grid bin/count for a set of
 * already-screen-projected, already-filtered points. `coords` is a flat
 * Float32Array (x,y,0,0 per point; x < -1e30 == skipped). Returns the per-cell
 * aggregates, or null when the GPU path is unavailable / a readback is in
 * flight (caller falls back to the CPU clusterer).
 */
function computeWebGPUEntityClusterGrid(
  context: ClusterDispatcherContext,
  coords: Float32Array,
  pointCount: number,
  gridCols: number,
  gridRows: number,
  cellSize: number,
  originX: number,
  originY: number,
): Promise<ClusterGridResult | null> {
  const inst = getOrCreateDispatcher(context);
  if (!inst) {
    return Promise.resolve(null);
  }
  return inst.computeGrid(
    coords,
    pointCount,
    gridCols,
    gridRows,
    cellSize,
    originX,
    originY,
    context,
  );
}

function getWebGPUEntityClusterStatistics(
  context: ClusterDispatcherContext,
): WebGPUEntityClusterDispatcher["statistics"] | null {
  const inst = _instances.get(context as object);
  return inst ? inst.statistics : null;
}

function destroyWebGPUEntityCluster(context: ClusterDispatcherContext): void {
  const inst = _instances.get(context as object);
  if (inst) {
    inst.destroy();
    _instances.delete(context as object);
  }
}

export {
  WebGPUEntityClusterDispatcher,
  computeWebGPUEntityClusterGrid,
  getWebGPUEntityClusterStatistics,
  destroyWebGPUEntityCluster,
};
export default WebGPUEntityClusterDispatcher;
