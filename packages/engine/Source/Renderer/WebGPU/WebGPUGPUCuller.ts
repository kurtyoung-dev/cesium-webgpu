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
  private _readbackBuffer: GPUBuffer | null = null;
  private _countReadbackBuffer: GPUBuffer | null = null;

  private _isDestroyed: boolean = false;

  constructor(device: GPUDevice, options: GPUCullerOptions = {}) {
    this._device = device;
    this._maxObjects = options.maxObjects ?? 65536;
    this._workgroupSize = options.workgroupSize ?? 256;
    this._label = options.label ?? "GPUCuller";
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
    this._bindGroupLayout = this._device.createBindGroupLayout({
      label: `${this._label} Bind Group Layout`,
      entries: [
        // binding 0: frustum planes (uniform)
        {
          binding: 0,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        // binding 1: params (uniform) - objectCount + mode
        {
          binding: 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform" },
        },
        // binding 2: bounding spheres (storage, read)
        {
          binding: 2,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "read-only-storage" },
        },
        // binding 3: visibility flags (storage, read-write)
        {
          binding: 3,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        // binding 4: indirect draw buffer (storage, read-write)
        {
          binding: 4,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
        // binding 5: visible count (storage, read-write)
        {
          binding: 5,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "storage" },
        },
      ],
    });

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
      this._pipeline = await this._device.createComputePipelineAsync({
        label: `${this._label} Compute Pipeline (${entryPoint})`,
        layout: pipelineLayout,
        compute: {
          module: shaderModule,
          entryPoint,
        },
      });
    } catch (e) {
      if (useSubgroups) {
        console.warn(
          `[WebGPUGPUCuller] Subgroup variant failed to compile, falling back to scalar main: ${e}`,
        );
        this._pipeline = await this._device.createComputePipelineAsync({
          label: `${this._label} Compute Pipeline (main fallback)`,
          layout: pipelineLayout,
          compute: {
            module: shaderModule,
            entryPoint: "main",
          },
        });
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

    // Readback buffers
    this._readbackBuffer = this._device.createBuffer({
      size: maxObj * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: `${this._label} Visibility Readback`,
    });

    this._countReadbackBuffer = this._device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: `${this._label} Count Readback`,
    });
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
      console.warn(
        `[${this._label}] Not initialized — call initialize() first`,
      );
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
    if (!this._visibilityBuffer || !this._readbackBuffer) return;

    encoder.copyBufferToBuffer(
      this._visibilityBuffer,
      0,
      this._readbackBuffer,
      0,
      objectCount * 4,
    );

    encoder.copyBufferToBuffer(
      this._visibleCountBuffer!,
      0,
      this._countReadbackBuffer!,
      0,
      4,
    );
  }

  /**
   * Read back culling results asynchronously.
   * Call after the command buffer has been submitted.
   *
   * @param objectCount - Number of objects that were culled
   * @returns Culling results
   */
  async readResults(objectCount: number): Promise<CullResults> {
    if (!this._readbackBuffer || !this._countReadbackBuffer) {
      return {
        visibilityFlags: new Uint32Array(0),
        visibleCount: 0,
        objectCount: 0,
      };
    }

    // Map visibility buffer
    await this._readbackBuffer.mapAsync(GPUMapMode.READ);
    const visData = new Uint32Array(
      this._readbackBuffer.getMappedRange(0, objectCount * 4),
    );
    const visibilityFlags = new Uint32Array(visData);
    this._readbackBuffer.unmap();

    // Map count buffer
    await this._countReadbackBuffer.mapAsync(GPUMapMode.READ);
    const countData = new Uint32Array(
      this._countReadbackBuffer.getMappedRange(0, 4),
    );
    const visibleCount = countData[0];
    this._countReadbackBuffer.unmap();

    return { visibilityFlags, visibleCount, objectCount };
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
    this._readbackBuffer?.destroy();
    this._countReadbackBuffer?.destroy();

    this._pipeline = null;
    this._bindGroupLayout = null;
    this._isDestroyed = true;
  }
}

export default WebGPUGPUCuller;
