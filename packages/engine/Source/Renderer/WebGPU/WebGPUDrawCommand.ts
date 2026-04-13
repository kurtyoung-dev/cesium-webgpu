import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";
import WebGPUBuffer from "./WebGPUBuffer.js";

/**
 * Index buffer format type for WebGPU draw commands.
 * Maps directly to WebGPU GPUIndexFormat.
 */
export type IndexFormat = "uint16" | "uint32";

/**
 * A vertex/index buffer can be either our WebGPUBuffer wrapper or a raw GPUBuffer.
 * WebGPUBuffer has a `.buffer` accessor; raw GPUBuffer is used directly.
 */
export type AnyGPUBuffer = WebGPUBuffer | GPUBuffer;

/** Extracts the underlying GPUBuffer from either a WebGPUBuffer or raw GPUBuffer. */
function resolveBuffer(buf: AnyGPUBuffer): GPUBuffer {
  // Try public getter first (WebGPUBuffer.buffer)
  const pub = (buf as any).buffer;
  if (pub !== undefined && typeof pub === "object") {
    return pub as GPUBuffer;
  }
  // Fallback: private field (esbuild may not preserve getter in some modes)
  const priv = (buf as any)._buffer;
  if (priv !== undefined && typeof priv === "object") {
    return priv as GPUBuffer;
  }
  // Raw GPUBuffer — return as-is
  return buf as GPUBuffer;
}

/** Gets the size of an AnyGPUBuffer. */
function resolveBufferSize(buf: AnyGPUBuffer): number {
  if ((buf as WebGPUBuffer).size !== undefined) {
    return (buf as WebGPUBuffer).size;
  }
  return (buf as GPUBuffer).size;
}

/**
 * Options for constructing a WebGPUDrawCommand.
 */
interface WebGPUDrawCommandOptions {
  pipeline: GPURenderPipeline;
  /** Single bind group (legacy) or array of bind groups */
  bindGroup?: GPUBindGroup;
  bindGroups?: GPUBindGroup[];
  /** Single vertex buffer (legacy) or array of vertex buffers */
  vertexBuffer?: AnyGPUBuffer;
  vertexBuffers?: AnyGPUBuffer[];
  indexBuffer?: AnyGPUBuffer;
  /** Index format - 'uint16' or 'uint32'. Auto-detected from indexBuffer if not specified. */
  indexFormat?: IndexFormat;
  vertexCount?: number;
  indexCount?: number;
  instanceCount?: number;
  firstVertex?: number;
  firstIndex?: number;
  firstInstance?: number;
  pass?: number;
  owner?: any;
  boundingVolume?: CesiumBoundingSphere;
  modelMatrix?: CesiumMatrix4;
  cull?: boolean;
  debugShowBoundingVolume?: boolean;
  castShadows?: boolean;
  receiveShadows?: boolean;
  pickId?: string;
  executeInClosestFrustum?: boolean;
  sortKey?: number;
  /** Render layer order value. Default 50 (RenderLayer.Order.WORLD). */
  sortLayer?: number;
  /** Priority within the render layer. Lower renders first. Default 0. */
  sortPriority?: number;
  /** Material/shader grouping ID for batching. Default 0. */
  materialSortId?: number;
  /** 32-bit visibility group bitmask. Default 0xFFFFFFFF. */
  visibilityMask?: number;
  /** Whether this is transmissive geometry (glass, water). Default false. */
  isTransmissive?: boolean;
}

/**
 * Represents a draw command for WebGPU rendering.
 * Encapsulates the state needed to execute a single draw call including
 * pipeline, bind groups, vertex/index buffers, and draw parameters.
 *
 * Supports:
 * - Multiple vertex buffers (for separate position, normal, UV buffers)
 * - Multiple bind groups (for uniforms in @group(0), textures in @group(1), etc.)
 * - Configurable index format (uint16/uint32 with auto-detection)
 *
 * @alias WebGPUDrawCommand
 *
 * @param {WebGPUDrawCommandOptions} options Object with the following properties:
 * @param {GPURenderPipeline} options.pipeline The render pipeline to use for drawing.
 * @param {GPUBindGroup} [options.bindGroup] Single bind group (for backward compatibility).
 * @param {GPUBindGroup[]} [options.bindGroups] Array of bind groups (preferred for multi-group shaders).
 * @param {WebGPUBuffer} [options.vertexBuffer] Single vertex buffer (for backward compatibility).
 * @param {WebGPUBuffer[]} [options.vertexBuffers] Array of vertex buffers (preferred for multi-buffer layouts).
 * @param {WebGPUBuffer} [options.indexBuffer] The index buffer (optional for non-indexed draws).
 * @param {IndexFormat} [options.indexFormat] Index format - auto-detected if not provided.
 * @param {number} [options.vertexCount] Number of vertices to draw (for non-indexed draws).
 * @param {number} [options.indexCount] Number of indices to draw (for indexed draws).
 * @param {number} [options.instanceCount=1] Number of instances to draw.
 * @param {number} [options.firstVertex=0] Offset into the vertex buffer.
 * @param {number} [options.firstIndex=0] Offset into the index buffer.
 * @param {number} [options.firstInstance=0] First instance to draw.
 *
 * @private
 */
class WebGPUDrawCommand {
  pipeline: GPURenderPipeline;
  /** @deprecated Use bindGroups instead */
  bindGroup?: GPUBindGroup;
  bindGroups: GPUBindGroup[];
  /** @deprecated Use vertexBuffers instead */
  vertexBuffer?: AnyGPUBuffer;
  vertexBuffers: AnyGPUBuffer[];
  indexBuffer?: AnyGPUBuffer;
  indexFormat: IndexFormat;
  vertexCount?: number;
  indexCount?: number;
  instanceCount: number;
  firstVertex: number;
  firstIndex: number;
  firstInstance: number;
  enabled: boolean;
  /**
   * Optional pre-encoded render bundle. When set, `execute()` calls
   * `passEncoder.executeBundles([bundle])` and skips the per-frame
   * pipeline / bind group / buffer / draw recording. Owners that benefit
   * (static-pipeline renderers like the moon, sky atmosphere) build the
   * bundle once via {@link WebGPURenderBundleManager#getOrCreate} and
   * keep it cached. The fallback path still works if `bundle` is unset,
   * so renderers can opt in incrementally. Phase 1.2c v2 — Moon is the
   * first consumer.
   */
  bundle?: GPURenderBundle;

  // Properties needed for Scene/View command binning and culling
  pass: number;
  sortKey?: number;
  /** Render layer order value. Default 50 (RenderLayer.Order.WORLD). */
  sortLayer: number;
  /** Priority within the render layer. Lower renders first. Default 0. */
  sortPriority: number;
  /** Material/shader grouping ID for batching. Default 0. */
  materialSortId: number;
  /** 32-bit visibility group bitmask. Default 0xFFFFFFFF. */
  visibilityMask: number;
  /** Whether this is transmissive geometry (glass, water). Default false. */
  isTransmissive: boolean;
  owner?: any;
  boundingVolume?: CesiumBoundingSphere;
  modelMatrix?: CesiumMatrix4;
  cull: boolean;
  debugShowBoundingVolume: boolean;
  castShadows: boolean;
  receiveShadows: boolean;
  pickId?: string;
  executeInClosestFrustum: boolean;

  // OIT pipeline variant for weighted blended transparency (MRT)
  _oitPipeline?: GPURenderPipeline;
  // Original WGSL shader code for creating OIT variants at runtime
  _shaderCode?: string;
  // Pipeline config needed to recreate OIT variants
  _pipelineConfig?: any;

  // Flag to identify this as a WebGPU draw command (for Scene.js type checking)
  readonly isWebGPUDrawCommand: boolean = true;

  constructor(options: WebGPUDrawCommandOptions) {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(options)) {
      throw new DeveloperError("options is required.");
    }
    if (!defined(options.pipeline)) {
      throw new DeveloperError("options.pipeline is required.");
    }
    if (!defined(options.vertexBuffer) && !defined(options.vertexBuffers)) {
      throw new DeveloperError(
        "options.vertexBuffer or options.vertexBuffers is required.",
      );
    }
    //>>includeEnd('debug');

    this.pipeline = options.pipeline;

    // Support both single bind group (backward compat) and array of bind groups
    if (defined(options.bindGroups)) {
      this.bindGroups = options.bindGroups!;
      this.bindGroup = options.bindGroups![0]; // backward compat
    } else if (defined(options.bindGroup)) {
      this.bindGroups = [options.bindGroup!];
      this.bindGroup = options.bindGroup;
    } else {
      this.bindGroups = [];
      this.bindGroup = undefined;
    }

    // Support both single vertex buffer (backward compat) and array of vertex buffers
    if (defined(options.vertexBuffers)) {
      this.vertexBuffers = options.vertexBuffers!;
      this.vertexBuffer = options.vertexBuffers![0]; // backward compat
    } else if (defined(options.vertexBuffer)) {
      this.vertexBuffers = [options.vertexBuffer!];
      this.vertexBuffer = options.vertexBuffer;
    } else {
      this.vertexBuffers = [];
      this.vertexBuffer = undefined;
    }

    this.indexBuffer = options.indexBuffer;

    // Auto-detect index format from buffer data size if not specified
    if (defined(options.indexFormat)) {
      this.indexFormat = options.indexFormat!;
    } else if (defined(options.indexBuffer)) {
      // Heuristic: if the buffer size divided by indexCount gives 4 bytes per index, it's uint32
      // Otherwise default to uint16. This can be overridden explicitly.
      this.indexFormat = WebGPUDrawCommand.detectIndexFormat(
        options.indexBuffer!,
        options.indexCount,
      );
    } else {
      this.indexFormat = "uint16";
    }

    this.vertexCount = options.vertexCount;
    this.indexCount = options.indexCount;
    this.instanceCount = options.instanceCount ?? 1;
    this.firstVertex = options.firstVertex ?? 0;
    this.firstIndex = options.firstIndex ?? 0;
    this.firstInstance = options.firstInstance ?? 0;
    this.enabled = true;

    // Initialize Scene/View command properties with defaults
    this.pass = options.pass ?? 0; // Pass.OPAQUE
    this.sortKey = options.sortKey ?? 0;
    this.owner = options.owner;
    this.boundingVolume = options.boundingVolume;
    this.modelMatrix = options.modelMatrix;
    this.cull = options.cull ?? true;
    this.debugShowBoundingVolume = options.debugShowBoundingVolume ?? false;
    this.castShadows = options.castShadows ?? false;
    this.receiveShadows = options.receiveShadows ?? false;
    this.pickId = options.pickId;
    this.executeInClosestFrustum = options.executeInClosestFrustum ?? false;

    // Structured sort properties (matching DrawCommand parity)
    this.sortLayer = options.sortLayer ?? 50; // RenderLayer.Order.WORLD
    this.sortPriority = options.sortPriority ?? 0;
    this.materialSortId = options.materialSortId ?? 0;
    this.visibilityMask = options.visibilityMask ?? 0xffffffff;
    this.isTransmissive = options.isTransmissive ?? false;
  }

  /**
   * Auto-detect index format based on buffer size and index count.
   *
   * @param {WebGPUBuffer} indexBuffer - The index buffer
   * @param {number} [indexCount] - Number of indices
   * @returns {IndexFormat} Detected index format
   */
  static detectIndexFormat(
    indexBuffer: AnyGPUBuffer,
    indexCount?: number,
  ): IndexFormat {
    if (!defined(indexBuffer) || !defined(indexCount) || indexCount === 0) {
      return "uint16";
    }

    // If buffer size / indexCount == 4, it's uint32; if == 2, it's uint16
    const bytesPerIndex = resolveBufferSize(indexBuffer) / indexCount!;

    if (bytesPerIndex >= 4) {
      return "uint32";
    }

    return "uint16";
  }

  /**
   * Executes the draw command by encoding it into the given render pass encoder.
   *
   * @param {GPURenderPassEncoder} passEncoder The render pass encoder to encode commands into.
   *
   * @example
   * const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
   * drawCommand.execute(passEncoder);
   * passEncoder.end();
   */
  execute(passEncoder: GPURenderPassEncoder): void {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(passEncoder)) {
      throw new DeveloperError("passEncoder is required.");
    }
    //>>includeEnd('debug');

    if (!this.enabled) {
      return;
    }

    // Pre-encoded bundle fast path. When the owner has cached a
    // GPURenderBundle (via WebGPURenderBundleManager), replay it instead
    // of recording the draw calls again. The bundle internally captures
    // setPipeline / setBindGroup / setVertexBuffer / setIndexBuffer /
    // drawIndexed, so the per-frame CPU work collapses to one
    // executeBundles call. Phase 1.2c v2 — Moon is the first consumer.
    if (defined(this.bundle)) {
      passEncoder.executeBundles([this.bundle!]);
      return;
    }

    // Set the pipeline
    passEncoder.setPipeline(this.pipeline);

    // Set all bind groups
    for (let i = 0; i < this.bindGroups.length; i++) {
      passEncoder.setBindGroup(i, this.bindGroups[i]);
    }

    // Set all vertex buffers
    for (let i = 0; i < this.vertexBuffers.length; i++) {
      passEncoder.setVertexBuffer(i, resolveBuffer(this.vertexBuffers[i]));
    }

    // Execute draw call - indexed or non-indexed
    if (defined(this.indexBuffer) && defined(this.indexCount)) {
      // Indexed draw - use detected/configured index format
      passEncoder.setIndexBuffer(
        resolveBuffer(this.indexBuffer!),
        this.indexFormat,
      );
      passEncoder.drawIndexed(
        this.indexCount!,
        this.instanceCount,
        this.firstIndex,
        0, // baseVertex
        this.firstInstance,
      );
    } else if (defined(this.vertexCount)) {
      // Non-indexed draw
      passEncoder.draw(
        this.vertexCount!,
        this.instanceCount,
        this.firstVertex,
        this.firstInstance,
      );
    } else {
      //>>includeStart('debug', pragmas.debug);
      throw new DeveloperError(
        "Either indexCount or vertexCount must be specified.",
      );
      //>>includeEnd('debug');
    }
  }

  /**
   * Creates a shallow clone of this draw command.
   *
   * @returns {WebGPUDrawCommand} A new draw command with the same properties.
   */
  clone(): WebGPUDrawCommand {
    return new WebGPUDrawCommand({
      pipeline: this.pipeline,
      bindGroups: [...this.bindGroups],
      vertexBuffers: [...this.vertexBuffers],
      indexBuffer: this.indexBuffer,
      indexFormat: this.indexFormat,
      vertexCount: this.vertexCount,
      indexCount: this.indexCount,
      instanceCount: this.instanceCount,
      firstVertex: this.firstVertex,
      firstIndex: this.firstIndex,
      firstInstance: this.firstInstance,
      pass: this.pass,
      owner: this.owner,
      boundingVolume: this.boundingVolume,
      modelMatrix: this.modelMatrix,
      cull: this.cull,
      debugShowBoundingVolume: this.debugShowBoundingVolume,
      castShadows: this.castShadows,
      receiveShadows: this.receiveShadows,
      pickId: this.pickId,
      executeInClosestFrustum: this.executeInClosestFrustum,
      sortKey: this.sortKey,
      sortLayer: this.sortLayer,
      sortPriority: this.sortPriority,
      materialSortId: this.materialSortId,
      visibilityMask: this.visibilityMask,
      isTransmissive: this.isTransmissive,
    });
  }
}

export default WebGPUDrawCommand;
