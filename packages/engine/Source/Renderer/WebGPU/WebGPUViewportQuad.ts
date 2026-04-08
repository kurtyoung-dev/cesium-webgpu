/// <reference types="@webgpu/types" />
/**
 * WebGPU Viewport Quad Utility
 *
 * Provides fullscreen quad rendering for screen-space effects using the
 * efficient 3-vertex fullscreen triangle pattern (no vertex buffer needed).
 *
 * All WGSL shaders must follow this convention:
 * - Vertex entry point: `vertexMain` using `@builtin(vertex_index)` for
 *   3-vertex fullscreen triangle coverage
 * - Fragment entry point: `fragmentMain`
 * - Bind group 0 for all resources (textures, samplers, uniform buffers)
 *
 * Standard binding convention (most shaders follow this):
 *   @group(0) @binding(0) — texture_2d or texture_depth_2d
 *   @group(0) @binding(1) — sampler
 *   @group(0) @binding(2) — uniform buffer (optional)
 *
 * Multi-texture shaders use sequential binding pairs:
 *   @group(0) @binding(0,1) — texture + sampler pair 0
 *   @group(0) @binding(2,3) — texture + sampler pair 1
 *   @group(0) @binding(N)   — uniform buffer (last)
 *
 * @private
 */

// Alpha blend state matching CesiumJS BlendingState.ALPHA_BLEND
const ALPHA_BLEND_STATE: GPUBlendState = {
  color: {
    srcFactor: "src-alpha",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
};

// Additive blend state for OIT accumulation
const ADDITIVE_BLEND_STATE: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
};

// Pre-multiplied alpha blend
const PREMULTIPLIED_BLEND_STATE: GPUBlendState = {
  color: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
  alpha: {
    srcFactor: "one",
    dstFactor: "one-minus-src-alpha",
    operation: "add",
  },
};

export const ViewportQuadBlendState = Object.freeze({
  ALPHA_BLEND: ALPHA_BLEND_STATE,
  ADDITIVE: ADDITIVE_BLEND_STATE,
  PREMULTIPLIED_ALPHA: PREMULTIPLIED_BLEND_STATE,
});

/** Pipeline configuration for viewport quad rendering */
export interface ViewportQuadPipelineConfig {
  /** Blend state for the color target (default: opaque/no blending) */
  blend?: GPUBlendState;
  /** Color write mask (default: ALL) */
  writeMask?: GPUColorWriteFlags;
  /** Depth/stencil format if depth testing is needed (default: none) */
  depthStencilFormat?: GPUTextureFormat;
  /** Depth write (default: false for viewport quads) */
  depthWriteEnabled?: boolean;
  /** Depth compare function (default: "always") */
  depthCompare?: GPUCompareFunction;
  /** Stencil front/back config (default: none) */
  stencilFront?: GPUStencilFaceState;
  stencilBack?: GPUStencilFaceState;
  stencilReadMask?: number;
  stencilWriteMask?: number;
}

/** Options for creating a viewport quad command */
export interface ViewportQuadCommandOptions {
  /** Map of uniform name → getter function. Values are auto-detected by type. */
  uniformMap?: Record<string, () => any>;
  /** Explicit bind group entries (bypasses uniformMap auto-detection). */
  bindGroupEntries?: GPUBindGroupEntry[];
  /** Framebuffer to render into (metadata for Scene render loop) */
  framebuffer?: any;
  /** Owner object (for debugging / error messages) */
  owner?: any;
  /** Render state (metadata for Scene compatibility) */
  renderState?: any;
  /** Render pass (e.g., Pass.OVERLAY) */
  pass?: number;
  /** Pipeline config (blend, depth, stencil) */
  pipelineConfig?: ViewportQuadPipelineConfig;
}

interface CachedPipeline {
  pipeline: GPURenderPipeline;
  bindGroupLayout: GPUBindGroupLayout;
}

/**
 * Simple string hash for pipeline cache keys.
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Manages fullscreen viewport quad pipelines, bind groups, and execution.
 *
 * Lifecycle: create once per WebGPUContext, call destroy() when context is torn down.
 */
export class WebGPUViewportQuad {
  private _device: GPUDevice;
  private _pipelineCache: Map<string, CachedPipeline> = new Map();
  private _linearSampler: GPUSampler;
  private _nearestSampler: GPUSampler;
  private _comparisonSampler: GPUSampler;

  constructor(device: GPUDevice) {
    this._device = device;

    this._linearSampler = device.createSampler({
      label: "ViewportQuad-LinearSampler",
      magFilter: "linear",
      minFilter: "linear",
    });
    this._nearestSampler = device.createSampler({
      label: "ViewportQuad-NearestSampler",
      magFilter: "nearest",
      minFilter: "nearest",
    });
    this._comparisonSampler = device.createSampler({
      label: "ViewportQuad-ComparisonSampler",
      compare: "less",
      magFilter: "linear",
      minFilter: "linear",
    });
  }

  /** Linear filtering sampler (default for most operations) */
  get linearSampler(): GPUSampler {
    return this._linearSampler;
  }
  /** Nearest filtering sampler (for depth / integer textures) */
  get nearestSampler(): GPUSampler {
    return this._nearestSampler;
  }
  /** Comparison sampler (for shadow maps) */
  get comparisonSampler(): GPUSampler {
    return this._comparisonSampler;
  }

  // ================================================================
  //  Pipeline creation and caching
  // ================================================================

  /**
   * Get or create a render pipeline for the given WGSL shader.
   *
   * Pipelines are cached by shader hash + format + blend/depth/stencil config.
   * Multiple commands sharing the same shader and config reuse one pipeline.
   *
   * @param wgslCode - Full WGSL source (vertex + fragment)
   * @param targetFormat - Color target format (e.g., "bgra8unorm")
   * @param config - Optional blend, depth, stencil configuration
   * @param label - Debug label for the pipeline
   * @returns Cached pipeline + its bind group layout
   */
  getPipeline(
    wgslCode: string,
    targetFormat: GPUTextureFormat,
    config?: ViewportQuadPipelineConfig,
    label?: string,
  ): CachedPipeline {
    const configKey = config
      ? `${config.blend ? "b" : ""}${config.depthStencilFormat ?? ""}${config.depthCompare ?? ""}${config.writeMask ?? ""}`
      : "default";
    const cacheKey = `vq_${hashString(wgslCode)}_${targetFormat}_${configKey}`;

    let cached = this._pipelineCache.get(cacheKey);
    if (cached) return cached;

    const shaderModule = this._device.createShaderModule({
      label: `ViewportQuad-Shader-${label || "cmd"}`,
      code: wgslCode,
    });

    const colorTargets: GPUColorTargetState[] = [
      {
        format: targetFormat,
        blend: config?.blend,
        writeMask: config?.writeMask,
      },
    ];

    let depthStencil: GPUDepthStencilState | undefined;
    if (config?.depthStencilFormat) {
      depthStencil = {
        format: config.depthStencilFormat,
        depthWriteEnabled: config.depthWriteEnabled ?? false,
        depthCompare: config.depthCompare ?? "always",
      };
      if (config.stencilFront || config.stencilBack) {
        depthStencil.stencilFront = config.stencilFront;
        depthStencil.stencilBack = config.stencilBack;
        if (config.stencilReadMask !== undefined) {
          depthStencil.stencilReadMask = config.stencilReadMask;
        }
        if (config.stencilWriteMask !== undefined) {
          depthStencil.stencilWriteMask = config.stencilWriteMask;
        }
      }
    }

    const pipeline = this._device.createRenderPipeline({
      label: `ViewportQuad-Pipeline-${label || "cmd"}`,
      layout: "auto",
      vertex: { module: shaderModule, entryPoint: "vertexMain" },
      fragment: {
        module: shaderModule,
        entryPoint: "fragmentMain",
        targets: colorTargets,
      },
      primitive: { topology: "triangle-list" },
      depthStencil,
    });

    const bindGroupLayout = pipeline.getBindGroupLayout(0);
    cached = { pipeline, bindGroupLayout };
    this._pipelineCache.set(cacheKey, cached);
    return cached;
  }

  // ================================================================
  //  Bind group creation
  // ================================================================

  /**
   * Create a bind group from a uniform map using auto-detection.
   *
   * Resource types are identified by duck-typing:
   * - Object with `.view` + `.sampler` → texture + sampler (WebGPUTexture)
   * - Object with `.view` only → texture + default linear sampler
   * - Object with `._webgpuTexture` → CesiumJS Texture wrapper
   * - Float32Array / TypedArray → uniform buffer
   * - number → uniform buffer (padded to 16 bytes)
   * - GPUTextureView → texture view + default sampler
   *
   * Bindings are assigned sequentially in uniform map key order.
   * The uniform map key order MUST match the shader @binding declarations.
   *
   * @param layout - Bind group layout from getPipeline()
   * @param uniformMap - Map of name → getter function
   * @param existingUBO - Reuse this uniform buffer (avoids allocation per frame)
   * @param label - Debug label
   * @returns Bind group and the uniform buffer (for reuse next frame)
   */
  createBindGroupFromUniformMap(
    layout: GPUBindGroupLayout,
    uniformMap: Record<string, () => any>,
    existingUBO?: GPUBuffer | null,
    label?: string,
  ): { bindGroup: GPUBindGroup; uniformBuffer: GPUBuffer | null } {
    const entries: GPUBindGroupEntry[] = [];
    let binding = 0;
    let ubo = existingUBO ?? null;

    for (const key of Object.keys(uniformMap)) {
      const fn = uniformMap[key];
      if (typeof fn !== "function") continue;
      const value = fn();
      if (value == null) continue;

      const resolved = this._resolveBindGroupEntry(value, binding, ubo, label);
      for (const entry of resolved.entries) {
        entries.push(entry);
      }
      binding += resolved.entries.length;
      if (resolved.uniformBuffer) {
        ubo = resolved.uniformBuffer;
      }
    }

    const bindGroup = this._device.createBindGroup({
      label: `ViewportQuad-BindGroup-${label || "cmd"}`,
      layout,
      entries,
    });

    return { bindGroup, uniformBuffer: ubo };
  }

  /**
   * Create a bind group from explicit entries.
   */
  createBindGroup(
    layout: GPUBindGroupLayout,
    entries: GPUBindGroupEntry[],
    label?: string,
  ): GPUBindGroup {
    return this._device.createBindGroup({
      label: `ViewportQuad-BindGroup-${label || "cmd"}`,
      layout,
      entries,
    });
  }

  // ================================================================
  //  Execution helpers
  // ================================================================

  /**
   * Execute a fullscreen draw within an existing render pass.
   */
  draw(
    passEncoder: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    bindGroup?: GPUBindGroup,
  ): void {
    passEncoder.setPipeline(pipeline);
    if (bindGroup) {
      passEncoder.setBindGroup(0, bindGroup);
    }
    passEncoder.draw(3); // 3-vertex fullscreen triangle
  }

  /**
   * Execute a fullscreen draw in its own render pass targeting a specific texture.
   *
   * Use this when the command needs to render to a framebuffer different from
   * the current scene render pass. Creates and immediately submits its own
   * GPURenderPass.
   *
   * @param encoder - Command encoder
   * @param pipeline - Render pipeline
   * @param bindGroup - Bind group (optional)
   * @param colorView - Target color texture view
   * @param options - Load/store ops, depth view, clear color
   */
  drawToTarget(
    encoder: GPUCommandEncoder,
    pipeline: GPURenderPipeline,
    bindGroup: GPUBindGroup | undefined,
    colorView: GPUTextureView,
    options?: {
      depthView?: GPUTextureView;
      clearColor?: { r: number; g: number; b: number; a: number };
      loadOp?: GPULoadOp;
      storeOp?: GPUStoreOp;
      stencilView?: GPUTextureView;
      label?: string;
    },
  ): void {
    const loadOp = options?.loadOp ?? (options?.clearColor ? "clear" : "load");
    const colorAttachment: GPURenderPassColorAttachment = {
      view: colorView,
      loadOp,
      storeOp: options?.storeOp ?? "store",
    };
    if (options?.clearColor) {
      colorAttachment.clearValue = options.clearColor;
    }

    const passDesc: GPURenderPassDescriptor = {
      label: options?.label ?? "ViewportQuad-TargetedPass",
      colorAttachments: [colorAttachment],
    };

    const depthView = options?.depthView ?? options?.stencilView;
    if (depthView) {
      passDesc.depthStencilAttachment = {
        view: depthView,
        depthLoadOp: "load",
        depthStoreOp: "store",
        stencilLoadOp: "load",
        stencilStoreOp: "store",
      };
    }

    const pass = encoder.beginRenderPass(passDesc);
    this.draw(pass, pipeline, bindGroup);
    pass.end();
  }

  // ================================================================
  //  High-level command creation
  // ================================================================

  /**
   * Create a command object compatible with CesiumJS Scene rendering.
   *
   * The returned command has an `execute(passEncoder?, context?)` method
   * and the standard DrawCommand properties (uniformMap, framebuffer, etc.)
   * for Scene render loop compatibility.
   *
   * Pipeline is lazily compiled on first execute and cached.
   * Bind group is rebuilt each frame (uniform values can change).
   *
   * @param wgslCode - Full WGSL source (vertex + fragment)
   * @param targetFormat - Color target format
   * @param options - Command options
   * @returns A command object with execute()
   */
  createCommand(
    wgslCode: string,
    targetFormat: GPUTextureFormat,
    options?: ViewportQuadCommandOptions,
  ): any {
    const vq = this;
    let cached: CachedPipeline | null = null;
    let uniformBuffer: GPUBuffer | null = null;

    const command: any = {
      shaderProgram: null,
      uniformMap: options?.uniformMap || {},
      framebuffer: options?.framebuffer || null,
      owner: options?.owner,
      renderState: options?.renderState,
      pass: options?.pass,
      _wgslCode: wgslCode,
      _isViewportQuadCommand: true,

      execute: (renderPassEncoder?: GPURenderPassEncoder, contextArg?: any) => {
        const passEncoder =
          renderPassEncoder ??
          (contextArg as any)?._currentRenderPassEncoder ??
          null;
        if (!passEncoder) return;

        // Lazily compile pipeline
        if (!cached) {
          const label = command.owner?.constructor?.name ?? "ViewportQuadCmd";
          cached = vq.getPipeline(
            wgslCode,
            targetFormat,
            options?.pipelineConfig,
            label,
          );
        }

        // Build bind group
        let bindGroup: GPUBindGroup | undefined;
        if (options?.bindGroupEntries) {
          bindGroup = vq.createBindGroup(
            cached.bindGroupLayout,
            options.bindGroupEntries,
          );
        } else if (
          command.uniformMap &&
          Object.keys(command.uniformMap).length > 0
        ) {
          try {
            const result = vq.createBindGroupFromUniformMap(
              cached.bindGroupLayout,
              command.uniformMap,
              uniformBuffer,
              command.owner?.constructor?.name,
            );
            bindGroup = result.bindGroup;
            uniformBuffer = result.uniformBuffer;
          } catch (e: any) {
            // Bind group mismatch — log once, skip draw
            return;
          }
        }

        vq.draw(passEncoder, cached.pipeline, bindGroup);
      },

      destroy: () => {
        uniformBuffer?.destroy();
        uniformBuffer = null;
        cached = null;
      },
    };

    return command;
  }

  // ================================================================
  //  Cleanup
  // ================================================================

  destroy(): void {
    this._pipelineCache.clear();
    // Samplers are device-level and destroyed with the device
  }

  // ================================================================
  //  Private helpers
  // ================================================================

  /**
   * Resolve a uniform value into bind group entries.
   * @private
   */
  private _resolveBindGroupEntry(
    value: any,
    startBinding: number,
    existingUBO: GPUBuffer | null,
    label?: string,
  ): {
    entries: GPUBindGroupEntry[];
    uniformBuffer: GPUBuffer | null;
  } {
    const entries: GPUBindGroupEntry[] = [];
    let ubo = existingUBO;

    // WebGPUTexture with view + sampler
    if (value.view !== undefined && value.sampler !== undefined) {
      entries.push({ binding: startBinding, resource: value.view });
      entries.push({ binding: startBinding + 1, resource: value.sampler });
      return { entries, uniformBuffer: ubo };
    }

    // Has view but no sampler (raw GPUTextureView or partial wrapper)
    if (value.view !== undefined) {
      entries.push({ binding: startBinding, resource: value.view });
      entries.push({
        binding: startBinding + 1,
        resource: this._linearSampler,
      });
      return { entries, uniformBuffer: ubo };
    }

    // CesiumJS Texture wrapper with _webgpuTexture
    if (value._webgpuTexture) {
      const tex = value._webgpuTexture;
      entries.push({
        binding: startBinding,
        resource: tex.view ?? tex.createView?.(),
      });
      entries.push({
        binding: startBinding + 1,
        resource: tex.sampler ?? this._linearSampler,
      });
      return { entries, uniformBuffer: ubo };
    }

    // GPUTexture (raw, create a view)
    if (value.createView && value.format !== undefined) {
      entries.push({ binding: startBinding, resource: value.createView() });
      entries.push({
        binding: startBinding + 1,
        resource: this._linearSampler,
      });
      return { entries, uniformBuffer: ubo };
    }

    // TypedArray → uniform buffer
    if (ArrayBuffer.isView(value)) {
      const byteLen = (value as ArrayBufferView).byteLength;
      const alignedSize = Math.max(Math.ceil(byteLen / 16) * 16, 16);
      if (!ubo || ubo.size < alignedSize) {
        ubo?.destroy();
        ubo = this._device.createBuffer({
          label: `ViewportQuad-UBO-${label || "cmd"}`,
          size: alignedSize,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      this._device.queue.writeBuffer(ubo, 0, value as ArrayBufferView);
      entries.push({ binding: startBinding, resource: { buffer: ubo } });
      return { entries, uniformBuffer: ubo };
    }

    // Single number → padded uniform buffer
    if (typeof value === "number") {
      const data = new Float32Array([value, 0, 0, 0]);
      if (!ubo || ubo.size < 16) {
        ubo?.destroy();
        ubo = this._device.createBuffer({
          label: `ViewportQuad-UBO-${label || "cmd"}`,
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      this._device.queue.writeBuffer(ubo, 0, data as Float32Array<ArrayBuffer>);
      entries.push({ binding: startBinding, resource: { buffer: ubo } });
      return { entries, uniformBuffer: ubo };
    }

    // Color object → vec4 uniform buffer
    if (
      value.red !== undefined &&
      value.green !== undefined &&
      value.blue !== undefined
    ) {
      const data = new Float32Array([
        value.red,
        value.green,
        value.blue,
        value.alpha ?? 1.0,
      ]);
      if (!ubo || ubo.size < 16) {
        ubo?.destroy();
        ubo = this._device.createBuffer({
          label: `ViewportQuad-UBO-${label || "cmd"}`,
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      this._device.queue.writeBuffer(ubo, 0, data as Float32Array<ArrayBuffer>);
      entries.push({ binding: startBinding, resource: { buffer: ubo } });
      return { entries, uniformBuffer: ubo };
    }

    // Cartesian2 / Cartesian3 / Cartesian4 → uniform buffer
    if (value.x !== undefined && value.y !== undefined) {
      const components = [value.x, value.y];
      if (value.z !== undefined) components.push(value.z);
      if (value.w !== undefined) components.push(value.w);
      // Pad to 16 bytes
      while (components.length < 4) components.push(0);
      const data = new Float32Array(components);
      if (!ubo || ubo.size < 16) {
        ubo?.destroy();
        ubo = this._device.createBuffer({
          label: `ViewportQuad-UBO-${label || "cmd"}`,
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
      }
      this._device.queue.writeBuffer(ubo, 0, data as Float32Array<ArrayBuffer>);
      entries.push({ binding: startBinding, resource: { buffer: ubo } });
      return { entries, uniformBuffer: ubo };
    }

    // Unknown type — skip silently
    return { entries: [], uniformBuffer: ubo };
  }
}
