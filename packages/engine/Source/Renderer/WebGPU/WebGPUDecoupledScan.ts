/**
 * Single-dispatch inclusive prefix sum over a `storage array<u32>` using the
 * decoupled-lookback scan pattern from Merrill & Garland 2016 (NVIDIA CUB).
 * This is the runtime wrapper around `Shaders/WebGPU/Compute/DecoupledLookbackScan.wgsl`
 * — it owns the pipeline, the reusable `partitions` buffer, and a tiny
 * params UBO, and exposes a single `dispatch()` call that encodes the scan
 * onto a caller-provided command encoder.
 *
 * Why this exists:
 *   - Two-pass (reduce + downsweep) scans require a global barrier between
 *     passes and round-trip through an intermediate buffer.
 *   - The decoupled-lookback variant packs the whole scan into one dispatch
 *     by having each workgroup publish its aggregate to a global partition
 *     array, then walk backward to accumulate its exclusive prefix.
 *   - For Cesium's scale (~10-50k draw commands / visible points / particles
 *     per frame) this is a ~20-30% speedup and — more importantly — it pairs
 *     cleanly with indirect draws: you never CPU-roundtrip the prefix.
 *
 * Consumer pattern (intended):
 *   1. Upstream pass writes 0/1 visibility flags into a storage buffer.
 *   2. `WebGPUDecoupledScan.dispatch(encoder, flagsBuffer, prefixBuffer, N)`
 *      runs the scan.
 *   3. A second short compute pass uses `prefixBuffer` to compact visible
 *      indices into a dense list.
 *
 * First consumer (not wired here):
 *   `WebGPUPointCloudLODProcessor` uses an atomic-add-based compaction that
 *   produces an order-unstable visible-index list. Swapping it to a scan
 *   gives deterministic output ordering, which matters for point-cloud
 *   picking consistency.
 *
 * API shape deliberately mirrors `WebGPUGPUCuller` so future consumers can
 * pattern-match between them: `initialize(shaderCode)` → `ensureCapacity(n)`
 * → `dispatch(encoder, input, output, count)` → `destroy()`.
 *
 * @private
 * @module WebGPUDecoupledScan
 */

/// <reference types="@webgpu/types" />

import {
  makeBindGroupLayout,
  storageBuffer,
  uniformBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  trackComputePipelineCreation,
  type AsyncResourceMonitor,
} from "./AsyncResourceMonitor.js";

/** Workgroup size baked into the shader. Must match `WORKGROUP_SIZE` in
 *  `DecoupledLookbackScan.wgsl`. Changing this requires a shader edit. */
const WORKGROUP_SIZE = 256;

/** Params UBO is a single u32 plus three padding u32s (min UBO alignment is
 *  16 bytes per the WebGPU spec; keep the whole struct at the minimum
 *  256-byte alignment required for uniform-buffer binding offsets). */
const PARAMS_BUFFER_SIZE = 256;

export interface WebGPUDecoupledScanOptions {
  /** Maximum element count the scan needs to handle. Controls the initial
   *  size of the `partitions` buffer. The buffer is re-allocated if a
   *  larger count is later requested via `ensureCapacity`. Default 65536. */
  maxElements?: number;
  /** Debug label prefix. Default "DecoupledScan". */
  label?: string;
  /** Async resource monitor. */
  asyncResourceMonitor?: AsyncResourceMonitor | null;
  /**
   * Forward-progress occupancy gate (A2.3). The decoupled-lookback scan
   * spins on peer-workgroup partitions, which is only livelock-safe if the
   * device can make forward progress across all dispatched workgroups.
   * WebGPU exposes no occupancy query, so this is the maximum workgroup
   * count `dispatch()` will encode before refusing (and falling back to a
   * non-scan path). Defaults to `device.limits.maxComputeWorkgroupsPerDimension`
   * — the hardware dispatch-dimension limit, i.e. a pure capability gate with
   * no false trips. Consumers targeting drivers with known-weak forward
   * progress can pass a smaller value to force an earlier fallback.
   */
  maxSafeWorkgroups?: number;
}

/** Immutable shader artifacts that owner scanners may share on one device. */
export interface WebGPUDecoupledScanSharedArtifacts {
  pipeline: GPUComputePipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

/**
 * Thin runtime wrapper around the decoupled-lookback scan compute shader.
 * One instance per GPUDevice; re-use across frames and consumers.
 */
export class WebGPUDecoupledScan {
  private _device: GPUDevice;
  private _label: string;

  private _pipeline: GPUComputePipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _initialized: boolean = false;

  // Per-dispatch transient buffers.
  private _paramsBuffer: GPUBuffer | null = null;
  /** Global partition array — `ceil(N / WORKGROUP_SIZE)` u32 entries. */
  private _partitionsBuffer: GPUBuffer | null = null;
  /** Cached capacity in elements — we only reallocate `_partitionsBuffer`
   *  when the caller asks for more than this. */
  private _partitionsCapacity: number = 0;

  private _isDestroyed: boolean = false;

  private _monitor: AsyncResourceMonitor | null;

  /** Occupancy gate (A2.3). Max workgroups `dispatch()` will encode. */
  private _maxSafeWorkgroups: number;

  /** Throttle state for the permanent occupancy-gate sentinel. */
  private _gateTrips: number = 0;
  private _lastGateLogTime: number = 0;

  constructor(device: GPUDevice, options: WebGPUDecoupledScanOptions = {}) {
    this._device = device;
    this._label = options.label ?? "DecoupledScan";
    // Set the initial target capacity; the actual allocation happens in
    // `initialize()` once we know we're going to dispatch at least once.
    this._partitionsCapacity = options.maxElements ?? 65536;
    this._monitor = options.asyncResourceMonitor ?? null;
    // Default the occupancy gate to the hardware dispatch-dimension limit —
    // a capability gate with no false trips. A consumer-supplied override
    // clamps to that hard limit (a larger value could never dispatch). The
    // WebGPU spec guarantees this limit is at least 65535; fall back to that
    // when the device object doesn't expose `limits` (e.g. mock test devices).
    const hardLimit = device.limits?.maxComputeWorkgroupsPerDimension ?? 65535;
    const requested = options.maxSafeWorkgroups ?? hardLimit;
    this._maxSafeWorkgroups = Math.max(1, Math.min(requested, hardLimit));
  }

  /**
   * Creates the compute pipeline and the params UBO. The partitions buffer
   * is allocated lazily on the first dispatch so that callers which
   * construct-but-never-use the scanner don't pay for a 256 KB storage
   * buffer.
   *
   * @param shaderCode The contents of `DecoupledLookbackScan.wgsl`. Passed
   *   in rather than imported so the build-variant alias plugin can
   *   intercept the import in backend-agnostic builds if needed.
   */
  async initialize(
    shaderCode: string,
    sharedArtifacts?: WebGPUDecoupledScanSharedArtifacts,
  ): Promise<void> {
    if (this._initialized) {
      return;
    }

    if (sharedArtifacts) {
      this._bindGroupLayout = sharedArtifacts.bindGroupLayout;
      this._pipeline = sharedArtifacts.pipeline;
    } else {
      const shaderModule = this._device.createShaderModule({
        code: shaderCode,
        label: `${this._label} Shader Module`,
      });

      this._bindGroupLayout = makeBindGroupLayout(
        this._device,
        `${this._label} BindGroupLayout`,
        [
          uniformBuffer(0, Stage.COMPUTE),
          storageBuffer(1, Stage.COMPUTE, { readOnly: true }),
          storageBuffer(2, Stage.COMPUTE),
          storageBuffer(3, Stage.COMPUTE),
        ],
      );

      const pipelineLayout = this._device.createPipelineLayout({
        label: `${this._label} PipelineLayout`,
        bindGroupLayouts: [this._bindGroupLayout],
      });

      this._pipeline = await trackComputePipelineCreation(
        this._monitor,
        this._device,
        {
          label: `${this._label} Pipeline`,
          layout: pipelineLayout,
          compute: { module: shaderModule, entryPoint: "scan" },
        },
        "DecoupledScan",
      );
    }

    this._paramsBuffer = this._device.createBuffer({
      label: `${this._label} Params`,
      size: PARAMS_BUFFER_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this._initialized = true;
  }

  /**
   * Grows the partitions buffer if needed to handle `elementCount`. Called
   * from `dispatch` before recording; exposed publicly so consumers that
   * want to pre-allocate for a known worst-case can do so outside the
   * frame's hot path.
   */
  ensureCapacity(elementCount: number): void {
    if (!this._initialized) {
      throw new Error(
        `[${this._label}] ensureCapacity called before initialize()`,
      );
    }
    const requiredPartitions = Math.ceil(elementCount / WORKGROUP_SIZE);
    const currentPartitions = Math.ceil(
      this._partitionsCapacity / WORKGROUP_SIZE,
    );
    if (this._partitionsBuffer && requiredPartitions <= currentPartitions) {
      return;
    }
    // Grow in power-of-two steps to amortize reallocations across a few
    // consumer frames.
    let newCapacity = Math.max(this._partitionsCapacity, elementCount);
    while (Math.ceil(newCapacity / WORKGROUP_SIZE) < requiredPartitions) {
      newCapacity *= 2;
    }

    this._partitionsBuffer?.destroy();
    const partitionsByteSize = Math.ceil(newCapacity / WORKGROUP_SIZE) * 4;
    this._partitionsBuffer = this._device.createBuffer({
      label: `${this._label} Partitions`,
      size: Math.max(partitionsByteSize, 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this._partitionsCapacity = newCapacity;
  }

  /**
   * Encodes the scan onto `encoder`. The caller supplies input + output
   * buffers (both must be `STORAGE` and sized for at least `elementCount`
   * u32 entries). The output is the INCLUSIVE prefix sum of input —
   * `output[i] = input[0] + input[1] + … + input[i]`.
   *
   * The partitions buffer is cleared to zero each dispatch because the
   * shader's decoupled-lookback relies on `FLAG_EMPTY` (== 0) as the
   * initial state for every partition. `writeBuffer` of a small zeros
   * typed array is cheap and avoids a second compute pass just to clear.
   *
   * @returns `true` on a successful encode; `false` if the scanner was
   *   destroyed or not initialized (caller can fall back to a CPU path).
   */
  /**
   * Forward-progress occupancy gate (A2.3). Returns `true` if a scan over
   * `elementCount` elements is safe to dispatch — i.e. its workgroup count
   * does not exceed the safe co-residency estimate (`maxSafeWorkgroups`).
   *
   * Because the decoupled-lookback kernel spins on peer-workgroup partitions
   * and WebGPU guarantees no cross-workgroup forward progress, dispatching
   * more workgroups than the device can co-schedule risks a livelock the WGSL
   * watchdog would only bail out of by producing a numerically-incomplete
   * scan. When the gate fails it emits a PERMANENT (throttled) `console.error`
   * sentinel — per the CLAUDE.md loop-sentinel mandate — so the condition is
   * visible in production, and callers should fall back to a non-scan path.
   */
  canDispatch(elementCount: number): boolean {
    if (elementCount <= 0) {
      return true;
    }
    const workgroups = Math.ceil(elementCount / WORKGROUP_SIZE);
    if (workgroups <= this._maxSafeWorkgroups) {
      return true;
    }
    // Permanent sentinel — a real forward-progress hazard, NOT a debug log.
    // Throttled so a persistently-oversized consumer doesn't spam per frame.
    this._gateTrips++;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - this._lastGateLogTime > 3000) {
      this._lastGateLogTime = now;
      console.error(
        `[${this._label}] decoupled-lookback occupancy gate refused a scan: ` +
          `${workgroups} workgroups (${elementCount} elements) exceeds the ` +
          `safe co-residency limit of ${this._maxSafeWorkgroups}. Forward ` +
          `progress is not guaranteed across that many workgroups — the ` +
          `caller must fall back to a non-scan compaction path. ` +
          `(${this._gateTrips} trips so far)`,
      );
    }
    return false;
  }

  dispatch(
    encoder: GPUCommandEncoder,
    inputBuffer: GPUBuffer,
    outputBuffer: GPUBuffer,
    elementCount: number,
  ): boolean {
    if (this._isDestroyed || !this._initialized) {
      return false;
    }
    if (elementCount <= 0) {
      return true; // nothing to do — trivially successful
    }
    // Occupancy gate (A2.3) — refuse dispatches whose workgroup count exceeds
    // the safe co-residency estimate rather than risk a decoupled-lookback
    // livelock. Callers that ignore the return value get a no-op encode.
    if (!this.canDispatch(elementCount)) {
      return false;
    }
    this.ensureCapacity(elementCount);

    // Upload elementCount into the params UBO. We keep the padding slots
    // zeroed so the shader's struct layout stays in sync even as it grows.
    const paramsData = new Uint32Array([elementCount, 0, 0, 0]);
    this._device.queue.writeBuffer(
      this._paramsBuffer!,
      0,
      paramsData.buffer,
      paramsData.byteOffset,
      paramsData.byteLength,
    );

    // Zero the partitions buffer — the shader's decoupled-lookback relies
    // on FLAG_EMPTY being the initial state for every partition. A single
    // `writeBuffer` of zeros is cheaper than a separate clear-compute pass.
    const partitionsByteSize = Math.ceil(elementCount / WORKGROUP_SIZE) * 4;
    const zeros = new Uint32Array(Math.ceil(partitionsByteSize / 4));
    this._device.queue.writeBuffer(
      this._partitionsBuffer!,
      0,
      zeros.buffer,
      zeros.byteOffset,
      partitionsByteSize,
    );

    const bindGroup = this._device.createBindGroup({
      label: `${this._label} BindGroup`,
      layout: this._bindGroupLayout!,
      entries: [
        { binding: 0, resource: { buffer: this._paramsBuffer! } },
        { binding: 1, resource: { buffer: inputBuffer } },
        { binding: 2, resource: { buffer: outputBuffer } },
        { binding: 3, resource: { buffer: this._partitionsBuffer! } },
      ],
    });

    const pass = encoder.beginComputePass({
      label: `${this._label} ComputePass`,
    });
    pass.setPipeline(this._pipeline!);
    pass.setBindGroup(0, bindGroup);
    const workgroups = Math.ceil(elementCount / WORKGROUP_SIZE);
    // Pass y/z explicitly so diagnostics (and the spec) see the full
    // WebGPU-spec defaults rather than undefined.
    pass.dispatchWorkgroups(workgroups, 1, 1);
    pass.end();
    return true;
  }

  /**
   * Current partitions-buffer capacity (for diagnostics / sizing decisions
   * by consumers that want to pre-grow).
   */
  get capacity(): number {
    return this._partitionsCapacity;
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  get sharedArtifacts(): WebGPUDecoupledScanSharedArtifacts | undefined {
    return this._pipeline && this._bindGroupLayout
      ? {
          pipeline: this._pipeline,
          bindGroupLayout: this._bindGroupLayout,
        }
      : undefined;
  }

  destroy(): void {
    if (this._isDestroyed) {
      return;
    }
    this._paramsBuffer?.destroy();
    this._paramsBuffer = null;
    this._partitionsBuffer?.destroy();
    this._partitionsBuffer = null;
    this._pipeline = null;
    this._bindGroupLayout = null;
    this._initialized = false;
    this._isDestroyed = true;
  }
}

export default WebGPUDecoupledScan;
