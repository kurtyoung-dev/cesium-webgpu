/**
 * @module WebGPUGPUCuller
 *
 * GPU-side frustum culling via compute shader.
 * Tests arrays of bounding spheres against frustum planes entirely on the GPU,
 * eliminating the CPU bottleneck for dense 3D Tiles scenes.
 *
 * Integrates with WebGPUIndirectDrawManager for GPU-driven rendering:
 * the compute shader sets instanceCount=0 for culled objects in the indirect
 * draw buffer, so culled objects are never drawn.
 *
 * @example
 * const culler = new WebGPUGPUCuller(device);
 * await culler.initialize();
 *
 * // Each frame:
 * culler.uploadBoundingSpheres(sphereData);
 * culler.uploadFrustumPlanes(frustumPlanes);
 * culler.dispatch(commandEncoder, objectCount, CullMode.VISIBILITY);
 * // After submit: read visibilityFlags or use indirect draw buffer
 */

/// <reference types="@webgpu/types" />
import { gpuData } from "./webgpuTypeHelpers.js";
import {
  makeBindGroupLayout,
  uniformBuffer,
  storageBuffer,
  Stage,
} from "./WebGPUBindGroupLayoutHelpers.js";
import {
  trackComputePipelineCreation,
  type AsyncResourceMonitor,
} from "./AsyncResourceMonitor.js";

/**
 * Culling mode determines what the compute shader writes.
 */
export enum CullMode {
  /** Write visibility flags only (0/1 per object) */
  VISIBILITY = 0,
  /** Write visibility flags AND update indirect draw buffer */
  INDIRECT = 1,
  /** Write visibility flags AND count visible objects atomically */
  COUNT = 2,
}

/**
 * Options for the GPU culler.
 */
export interface GPUCullerOptions {
  /** Maximum number of objects to cull per dispatch (default: 65536) */
  maxObjects?: number;
  /** Workgroup size (must match WGSL shader) (default: 256) */
  workgroupSize?: number;
  /** Label prefix for debug */
  label?: string;
  /**
   * NEW-WEBGPU-PIPELINE-READY-SIGNAL — optional async resource monitor
   * so the direct `createComputePipelineAsync` call publishes wakeup
   * events. When omitted (test harnesses), the renderer still works
   * but its inflight pipeline isn't tokenized.
   */
  asyncResourceMonitor?: AsyncResourceMonitor | null;
}

/**
 * Culling results (available after readback).
 */
export interface CullResults {
  /** Visibility flags: 1 = visible, 0 = culled */
  visibilityFlags: Uint32Array;
  /** Total visible object count (only valid in COUNT mode) */
  visibleCount: number;
  /** Total objects tested */
  objectCount: number;
}

/**
 * GPU compute frustum culler.
 *
 * Uses a compute shader to test bounding spheres against frustum planes.
 * Workgroup size of 256 means each dispatch handles up to
 * ceil(objectCount / 256) workgroups.
 */
export class WebGPUGPUCuller {
  private _device: GPUDevice;
  private _maxObjects: number;
  private _workgroupSize: number;
  private _label: string;

  // Compute pipeline
  private _pipeline: GPUComputePipeline | null = null;
  private _bindGroupLayout: GPUBindGroupLayout | null = null;
  private _initialized: boolean = false;

  // GPU buffers
  private _frustumBuffer: GPUBuffer | null = null;
  private _paramsBuffer: GPUBuffer | null = null;
  private _sphereBuffer: GPUBuffer | null = null;
  private _visibilityBuffer: GPUBuffer | null = null;
  private _indirectBuffer: GPUBuffer | null = null;
  private _visibleCountBuffer: GPUBuffer | null = null;
  // Two-buffer readback ring (Wave-0 P0 residual fix) — a single staging
  // buffer cannot pipeline GPU->CPU readback: mapAsync must run AFTER the
  // copy is submitted, yet the next frame's copy must not target a buffer
  // that is still mapping. With a ring the prepareReadback writes one slot
  // while the OTHER (written + submitted last frame) is mapped, so neither
  // "used in submit while pending map" nor "while mapped" can occur. The
  // decoded result is cached in `_latestResults`; `readResults()` returns it.
  private _readbackBuffers: (GPUBuffer | null)[] = [null, null];
  private _countReadbackBuffers: (GPUBuffer | null)[] = [null, null];
  private _rbWriteIdx: number = 0;
  private _rbPendingIdx: number = -1;
  private _rbPendingCount: number = 0;
  private _rbMapping: boolean[] = [false, false];
  private _latestResults: CullResults | null = null;

  private _isDestroyed: boolean = false;

  private _monitor: AsyncResourceMonitor | null;

  constructor(device: GPUDevice, options: GPUCullerOptions = {}) {
    this._device = device;
    this._maxObjects = options.maxObjects ?? 65536;
    this._workgroupSize = options.workgroupSize ?? 256;
    this._label = options.label ?? "GPUCuller";
    this._monitor = options.asyncResourceMonitor ?? null;
  }

  /**
   * Initialize the compute pipeline and buffers.
   * Must be called before any dispatch.
   *
   * @param shaderCode - The WGSL compute shader source (FrustumCull.wgsl)
   */
  async initialize(shaderCode: string): Promise<void> {
    if (this._initialized) return;

    // Pick the subgroup-accelerated entry point when the device supports it.
    // The "subgroups" feature collapses per-thread atomicAdd into one
    // atomicAdd per subgroup for the compaction counter (mode 2), giving a
    // 2-4× speedup on cards with native subgroup support. The portable
    // `main` entry is used otherwise — same semantics, scalar atomics.
    const useSubgroups = this._device.features.has(
      "subgroups" as GPUFeatureName,
    );

    // Preprocess the shader source. The .wgsl file wraps `mainSubgroups` in
    // sentinel comments and does NOT contain an `enable subgroups;` directive
    // (WGSL requires every `enable` to precede all global decls — having one
    // mid-file is a parse error). Two paths:
    //   - Subgroup-capable device → prepend `enable subgroups;` to the source
    //   - Non-capable device       → strip the entire __SUBGROUP_BLOCK_*__
    //                                section so the parser never sees the
    //                                `subgroupBallot` / `countOneBits` calls
    //                                or the `subgroup_invocation_id` builtin.
    let preparedShaderCode: string;
    if (useSubgroups) {
      preparedShaderCode = `enable subgroups;\n${shaderCode}`;
    } else {
      preparedShaderCode = shaderCode.replace(
        /\/\/ __SUBGROUP_BLOCK_START__[\s\S]*?\/\/ __SUBGROUP_BLOCK_END__/,
        "// (subgroup variant stripped — feature not present)",
      );
    }

    // Create shader module
    const shaderModule = this._device.createShaderModule({
      code: preparedShaderCode,
      label: `${this._label} Shader Module`,
    });

    // Create bind group layout
    this._bindGroupLayout = makeBindGroupLayout(
      this._device,
      `${this._label} Bind Group Layout`,
      [
        // binding 0: frustum planes (uniform)
        uniformBuffer(0, Stage.COMPUTE),
        // binding 1: params (uniform) - objectCount + mode
        uniformBuffer(1, Stage.COMPUTE),
        // binding 2: bounding spheres (storage, read)
        storageBuffer(2, Stage.COMPUTE, { readOnly: true }),
        // binding 3: visibility flags (storage, read-write)
        storageBuffer(3, Stage.COMPUTE),
        // binding 4: indirect draw buffer (storage, read-write)
        storageBuffer(4, Stage.COMPUTE),
        // binding 5: visible count (storage, read-write)
        storageBuffer(5, Stage.COMPUTE),
      ],
    );

    // Create pipeline layout
    const pipelineLayout = this._device.createPipelineLayout({
      label: `${this._label} Pipeline Layout`,
      bindGroupLayouts: [this._bindGroupLayout],
    });

    // useSubgroups was computed above when preprocessing the shader source.
    const entryPoint = useSubgroups ? "mainSubgroups" : "main";

    // Create compute pipeline (async for non-blocking compilation).
    // If the subgroup variant fails to compile (driver edge cases), fall back
    // to the portable main entry point so culling still works.
    try {
      this._pipeline = await trackComputePipelineCreation(
        this._monitor,
        this._device,
        {
          label: `${this._label} Compute Pipeline (${entryPoint})`,
          layout: pipelineLayout,
          compute: {
            module: shaderModule,
            entryPoint,
          },
        },
        `GPUCuller-${entryPoint}`,
      );
    } catch (e) {
      if (useSubgroups) {
        //>>includeStart('debug', pragmas.debug);
        console.warn(
          `[WebGPUGPUCuller] Subgroup variant failed to compile, falling back to scalar main: ${e}`,
        );
        //>>includeEnd('debug');
        this._pipeline = await trackComputePipelineCreation(
          this._monitor,
          this._device,
          {
            label: `${this._label} Compute Pipeline (main fallback)`,
            layout: pipelineLayout,
            compute: {
              module: shaderModule,
              entryPoint: "main",
            },
          },
          "GPUCuller-main-fallback",
        );
      } else {
        throw e;
      }
    }

    // Create GPU buffers
    this._createBuffers();

    this._initialized = true;
  }

  /**
   * Create all GPU buffers for culling.
   * @private
   */
  private _createBuffers(): void {
    const maxObj = this._maxObjects;

    // Frustum planes: 6 × vec4<f32> = 96 bytes, aligned to 256
    this._frustumBuffer = this._device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `${this._label} Frustum Planes`,
    });

    // Params: vec4<u32> = 16 bytes, aligned to 256
    this._paramsBuffer = this._device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `${this._label} Params`,
    });

    // Bounding spheres: maxObj × vec4<f32> = maxObj × 16 bytes
    this._sphereBuffer = this._device.createBuffer({
      size: maxObj * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      label: `${this._label} Bounding Spheres`,
    });

    // Visibility flags: maxObj × u32
    this._visibilityBuffer = this._device.createBuffer({
      size: maxObj * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      label: `${this._label} Visibility Flags`,
    });

    // Indirect draws: maxObj × 5 × u32 (indexed draw params)
    this._indirectBuffer = this._device.createBuffer({
      size: maxObj * 20,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.INDIRECT |
        GPUBufferUsage.COPY_DST,
      label: `${this._label} Indirect Draws`,
    });

    // Visible count: single atomic<u32>
    this._visibleCountBuffer = this._device.createBuffer({
      size: 4,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
      label: `${this._label} Visible Count`,
    });

    // Readback buffers — two-slot ring (Wave-0 P0 residual fix). See the
    // `_readbackBuffers` field doc for why a single buffer races.
    this._readbackBuffers = [0, 1].map((i) =>
      this._device.createBuffer({
        size: maxObj * 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        label: `${this._label} Visibility Readback${i}`,
      }),
    );
    this._countReadbackBuffers = [0, 1].map((i) =>
      this._device.createBuffer({
        size: 4,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        label: `${this._label} Count Readback${i}`,
      }),
    );
    this._rbWriteIdx = 0;
    this._rbPendingIdx = -1;
    this._rbPendingCount = 0;
    this._rbMapping = [false, false];
  }

  /**
   * Upload bounding spheres to the GPU.
   *
   * @param spheres - Float32Array of [cx, cy, cz, radius] × N
   */
  uploadBoundingSpheres(spheres: Float32Array): void {
    if (!this._sphereBuffer) return;
    this._device.queue.writeBuffer(this._sphereBuffer, 0, gpuData(spheres));
  }

  /**
   * Upload frustum planes to the GPU.
   *
   * @param planes - Float32Array of 6 × [nx, ny, nz, d] = 24 floats
   */
  uploadFrustumPlanes(planes: Float32Array): void {
    if (!this._frustumBuffer) return;
    this._device.queue.writeBuffer(this._frustumBuffer, 0, gpuData(planes));
  }

  /**
   * Dispatch the culling compute shader.
   *
   * @param encoder - The command encoder
   * @param objectCount - Number of objects to cull
   * @param mode - Culling mode
   * @param externalIndirectBuffer - Optional external indirect buffer to cull into
   */
  dispatch(
    encoder: GPUCommandEncoder,
    objectCount: number,
    mode: CullMode = CullMode.VISIBILITY,
    externalIndirectBuffer?: GPUBuffer,
  ): void {
    if (!this._initialized || !this._pipeline || !this._bindGroupLayout) {
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[${this._label}] Not initialized — call initialize() first`,
      );
      //>>includeEnd('debug');
      return;
    }

    // Upload params
    const paramsData = new Uint32Array([objectCount, mode, 0, 0]);
    this._device.queue.writeBuffer(this._paramsBuffer!, 0, gpuData(paramsData));

    // Reset visible count to 0 if using COUNT mode
    if (mode === CullMode.COUNT) {
      const zero = new Uint32Array([0]);
      this._device.queue.writeBuffer(
        this._visibleCountBuffer!,
        0,
        gpuData(zero),
      );
    }

    // Create bind group
    const indirectBuf = externalIndirectBuffer ?? this._indirectBuffer!;
    const bindGroup = this._device.createBindGroup({
      label: `${this._label} Bind Group`,
      layout: this._bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this._frustumBuffer! } },
        { binding: 1, resource: { buffer: this._paramsBuffer! } },
        { binding: 2, resource: { buffer: this._sphereBuffer! } },
        { binding: 3, resource: { buffer: this._visibilityBuffer! } },
        { binding: 4, resource: { buffer: indirectBuf } },
        { binding: 5, resource: { buffer: this._visibleCountBuffer! } },
      ],
    });

    // Dispatch compute
    const computePass = encoder.beginComputePass({
      label: `${this._label} Compute Pass`,
    });
    computePass.setPipeline(this._pipeline);
    computePass.setBindGroup(0, bindGroup);
    const workgroups = Math.ceil(objectCount / this._workgroupSize);
    computePass.dispatchWorkgroups(workgroups);
    computePass.end();
  }

  /**
   * Copy visibility results to readback buffer.
   * Call this after dispatch and before submit.
   *
   * @param encoder - The command encoder
   * @param objectCount - Number of objects
   */
  prepareReadback(encoder: GPUCommandEncoder, objectCount: number): void {
    if (!this._visibilityBuffer) return;

    // Deferred readback (Wave-0 P0 residual fix): map the slot written on a
    // PRIOR prepareReadback — its copy has been submitted by now, so mapAsync
    // is legal and never targets the slot we are about to write below.
    this._pumpReadback();

    // Pick a slot that isn't currently mapping. Prefer the round-robin index;
    // fall back to the other; if BOTH are mapping (very slow readback), skip
    // the copy this frame — the consumer keeps using `_latestResults`.
    let i = this._rbWriteIdx;
    if (this._rbMapping[i]) {
      i ^= 1;
      if (this._rbMapping[i]) return;
    }
    const vbuf = this._readbackBuffers[i];
    const cbuf = this._countReadbackBuffers[i];
    if (!vbuf || !cbuf) return;

    encoder.copyBufferToBuffer(
      this._visibilityBuffer,
      0,
      vbuf,
      0,
      objectCount * 4,
    );
    encoder.copyBufferToBuffer(this._visibleCountBuffer!, 0, cbuf, 0, 4);

    this._rbPendingIdx = i;
    this._rbPendingCount = objectCount;
    this._rbWriteIdx = i ^ 1;
  }

  /**
   * Deferred-readback pump (Wave-0 P0 residual fix). Maps the readback slot
   * written by a PRIOR `prepareReadback` — by the time this runs (the start
   * of the next prepareReadback) that copy has been submitted, so mapAsync is
   * legal and the slot is not the one about to be written. Decodes into
   * `_latestResults`. No-op when nothing is pending or the slot is mapping.
   */
  private _pumpReadback(): void {
    const i = this._rbPendingIdx;
    if (i < 0 || this._rbMapping[i]) return;
    const count = this._rbPendingCount;
    this._rbPendingIdx = -1;
    if (count <= 0) return;
    const vbuf = this._readbackBuffers[i];
    const cbuf = this._countReadbackBuffers[i];
    if (!vbuf || !cbuf) return;
    this._rbMapping[i] = true;
    Promise.all([
      vbuf.mapAsync(GPUMapMode.READ, 0, count * 4),
      cbuf.mapAsync(GPUMapMode.READ, 0, 4),
    ])
      .then(() => {
        const visibilityFlags = new Uint32Array(
          new Uint32Array(vbuf.getMappedRange(0, count * 4)),
        );
        const visibleCount = new Uint32Array(cbuf.getMappedRange(0, 4))[0];
        vbuf.unmap();
        cbuf.unmap();
        this._latestResults = {
          visibilityFlags,
          visibleCount,
          objectCount: count,
        };
      })
      .catch(() => {
        try {
          vbuf.unmap();
        } catch {
          /* not mapped */
        }
        try {
          cbuf.unmap();
        } catch {
          /* not mapped */
        }
      })
      .finally(() => {
        this._rbMapping[i] = false;
      });
  }

  /**
   * Read back culling results asynchronously.
   * Call after the command buffer has been submitted.
   *
   * @param objectCount - Number of objects that were culled
   * @returns Culling results
   */
  /**
   * Return the most recently decoded cull results. Readback is now deferred +
   * double-buffered inside `prepareReadback` / `_pumpReadback` (mapAsync runs
   * at the next prepareReadback, after the prior copy submitted), so this
   * entry point hands back the cache — preserving the existing
   * `readResults().then(store)` caller contract with zero map-vs-submit races.
   */
  async readResults(objectCount: number): Promise<CullResults> {
    void objectCount;
    return (
      this._latestResults ?? {
        visibilityFlags: new Uint32Array(0),
        visibleCount: 0,
        objectCount: 0,
      }
    );
  }

  /**
   * Whether the culler is initialized and ready.
   */
  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * The visibility output buffer (for use in bind groups).
   */
  get visibilityBuffer(): GPUBuffer | null {
    return this._visibilityBuffer;
  }

  /**
   * The internal indirect draw buffer.
   */
  get indirectBuffer(): GPUBuffer | null {
    return this._indirectBuffer;
  }

  /**
   * Whether the culler has been destroyed.
   */
  get isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /**
   * Destroy all GPU resources.
   */
  destroy(): void {
    if (this._isDestroyed) return;

    this._frustumBuffer?.destroy();
    this._paramsBuffer?.destroy();
    this._sphereBuffer?.destroy();
    this._visibilityBuffer?.destroy();
    this._indirectBuffer?.destroy();
    this._visibleCountBuffer?.destroy();
    for (const b of this._readbackBuffers) {
      b?.destroy();
    }
    for (const b of this._countReadbackBuffers) {
      b?.destroy();
    }
    this._latestResults = null;
    this._rbPendingIdx = -1;
    this._rbMapping = [false, false];

    this._pipeline = null;
    this._bindGroupLayout = null;
    this._isDestroyed = true;
  }
}

export default WebGPUGPUCuller;
