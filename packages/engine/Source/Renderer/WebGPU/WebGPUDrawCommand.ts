import defined from "../../Core/defined.js";
import DeveloperError from "../../Core/DeveloperError.js";
import {
  DEFAULT_COMMAND_MATERIAL_SORT_ID,
  DEFAULT_COMMAND_SORT_LAYER,
  DEFAULT_COMMAND_SORT_PRIORITY,
  normalizeCommandMaterialSortId,
  normalizeCommandSortByte,
} from "../CommandOrdering.js";
import WebGPUBuffer from "./WebGPUBuffer.js";
import {
  applyPerEncoderState,
  type CesiumRenderStateLike,
} from "./RenderStateToPipelineVariant.js";

/**
 * Index buffer format type for WebGPU draw commands.
 * Maps directly to WebGPU GPUIndexFormat.
 */
export type IndexFormat = "uint16" | "uint32";

/**
 * Back-reference to the scene object that created a draw command
 * (e.g. Primitive, Billboard, PointPrimitive, Model). The renderer only
 * reads `constructor.name` for debug labels; scene code reads it for
 * picking and batching. Kept structural so owners from any collection
 * (including future ones) assign without casts.
 */
export interface WebGPUCommandOwner {
  readonly constructor?: { readonly name?: string };
}

/**
 * Pipeline creation config retained on a draw command so OIT variants can
 * be built lazily by WebGPUSceneRenderer / WebGPUOIT. Mirrors the subset of
 * GPURenderPipelineDescriptor we need to rebuild the pipeline with a
 * different fragment shader (for weighted-blended transparency).
 */
export interface WebGPUPipelineConfig {
  label?: string;
  layout: GPUPipelineLayout | "auto";
  vertexBuffers?: GPUVertexBufferLayout[];
  vertexEntryPoint?: string;
  fragmentEntryPoint?: string;
  primitive?: GPUPrimitiveState;
  depthStencil?: GPUDepthStencilState;
  multisample?: GPUMultisampleState;
}

/**
 * A vertex/index buffer can be either our WebGPUBuffer wrapper or a raw GPUBuffer.
 * WebGPUBuffer has a `.buffer` accessor; raw GPUBuffer is used directly.
 */
export type AnyGPUBuffer = WebGPUBuffer | GPUBuffer;

/**
 * Pass-owned dynamic state that must win over a command's baked WebGL-style
 * renderState. Pick rendering uses this to enforce its small query rectangle.
 */
export interface WebGPUDynamicStateOverride {
  viewport?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  scissor?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

function applyDynamicStateOverride(
  passEncoder: GPURenderPassEncoder,
  override?: WebGPUDynamicStateOverride,
  renderState?: CesiumRenderStateLike,
  force = false,
): void {
  const viewport = override?.viewport;
  if (viewport && (force || renderState?.viewport)) {
    passEncoder.setViewport(
      viewport.x,
      viewport.y,
      viewport.width,
      viewport.height,
      0,
      1,
    );
  }
  const scissor = override?.scissor;
  if (
    scissor &&
    (force ||
      (renderState?.scissorTest?.enabled && renderState.scissorTest.rectangle))
  ) {
    passEncoder.setScissorRect(
      scissor.x,
      scissor.y,
      scissor.width,
      scissor.height,
    );
  }
}

/** Extracts the underlying GPUBuffer from either a WebGPUBuffer or raw GPUBuffer. */
function resolveBuffer(buf: AnyGPUBuffer): GPUBuffer {
  if (buf instanceof WebGPUBuffer) {
    return buf.buffer;
  }
  return buf;
}

/** Gets the size of an AnyGPUBuffer. */
function resolveBufferSize(buf: AnyGPUBuffer): number {
  return buf.size;
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
  owner?: WebGPUCommandOwner;
  boundingVolume?: CesiumBoundingSphere;
  modelMatrix?: CesiumMatrix4;
  cull?: boolean;
  /**
   * When false, the command bypasses occlusion culling. Default true.
   * Mirrors `DrawCommand.occlude` from the WebGL path so scene code that
   * sets `command.occlude = false` (e.g. always-on-top overlays) honors
   * the same semantics on both backends.
   */
  occlude?: boolean;
  debugShowBoundingVolume?: boolean;
  castShadows?: boolean;
  receiveShadows?: boolean;
  pickId?: string;
  /**
   * When true, the command is executed only during pick passes. Default
   * false. Mirrors `DrawCommand.pickOnly`.
   */
  pickOnly?: boolean;
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
  /**
   * Indirect draw args buffer. When set, `execute()` calls
   * `passEncoder.drawIndirect(indirectBuffer, indirectOffset)` (or the
   * indexed variant when `indexBuffer` is also set) instead of the
   * CPU-specified vertex/instance count path. The buffer must match
   * WebGPU's indirect layout:
   *   - non-indexed: `(vertexCount, instanceCount, firstVertex, firstInstance)` × u32
   *   - indexed:     `(indexCount, instanceCount, firstIndex, baseVertex, firstInstance)` × u32
   *
   * Consumed by the GPU-LOD point cloud renderer where a compute pass
   * writes instanceCount into the buffer before the draw runs. CPU-side
   * `instanceCount` is ignored when this is set.
   */
  drawIndirectBuffer?: AnyGPUBuffer;
  /** Byte offset into `drawIndirectBuffer` for the draw args. Default 0. */
  drawIndirectOffset?: number;
  /**
   * Optional WebGL-style `renderState` carried through for C-R1. Feature
   * renderers that want to honour `stencilReference`, `blendConstant`,
   * `viewport`, or `scissorRect` on a per-command basis populate this.
   * `WebGPUDrawCommand.execute()` forwards it to
   * {@link applyPerEncoderState} immediately before the draw call.
   * Pipeline-baked fields (cullMode, depthCompare, blend equations,
   * stencil ops, colorWriteMask, depthBias) must be packed into the
   * pipeline itself via {@link renderStateToPipelineVariant}; those
   * cannot change per-draw.
   */
  renderState?: CesiumRenderStateLike;
  /**
   * C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 78). When true, the command
   * contributes to translucent classification depth. Set by
   * `Cesium3DTile.js:1084` for translucent 3D-tile commands. Defaults
   * to false; only 3D-tile renderers should set it.
   */
  depthForTranslucentClassification?: boolean;
  /**
   * C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79). Optional sibling pipeline
   * with `depthWriteEnabled = true` forced on for ALPHA_BLEND. When
   * `depthForTranslucentClassification` is true and this variant is
   * supplied, `execute()` binds it instead of the default `pipeline`,
   * causing the translucent tile surface to populate the scene-FB
   * depth attachment. The stencil-based GroundPrimitive classifier
   * then clips its volumes against the tile surface (matching WebGL's
   * `czm_globeDepthTexture` sampling behaviour without a separate
   * depth-texture pass). For OPAQUE/MASK commands the variant is
   * unused because depth is already written.
   */
  classificationDepthPipeline?: GPURenderPipeline;
  /**
   * Migration Session 3 (Batch 83) — late-bound bind-group resolvers.
   * One slot per @group binding; entries that are `undefined` use the
   * static `bindGroups[i]`, entries that are functions are called at
   * execute() time and their return value overrides the static bind
   * group for that draw. Used for resources that change per-frustum
   * (e.g., depth-sample classifier's depth source view) — the static
   * `bindGroups[i]` references the view from when the command was
   * built, while the resolver fetches the current frustum's view at
   * draw time. Returning `null` falls back to the static reference
   * (graceful no-op when the per-frustum source isn't published yet).
   */
  bindGroupResolvers?: Array<undefined | (() => GPUBindGroup | null)>;
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
  owner?: WebGPUCommandOwner;
  boundingVolume?: CesiumBoundingSphere;
  modelMatrix?: CesiumMatrix4;
  cull: boolean;
  /** See WebGPUDrawCommandOptions.occlude. */
  occlude: boolean;
  debugShowBoundingVolume: boolean;
  castShadows: boolean;
  receiveShadows: boolean;
  pickId?: string;
  /** See WebGPUDrawCommandOptions.pickOnly. */
  pickOnly: boolean;
  executeInClosestFrustum: boolean;

  // Indirect-draw support — see the matching fields on
  // WebGPUDrawCommandOptions for the expected buffer layout.
  drawIndirectBuffer?: AnyGPUBuffer;
  drawIndirectOffset: number;

  // OIT pipeline variant for weighted blended transparency (MRT)
  _oitPipeline?: GPURenderPipeline;
  // Original WGSL shader code for creating OIT variants at runtime
  _shaderCode?: string;
  // Pipeline config needed to recreate OIT variants
  _pipelineConfig?: WebGPUPipelineConfig;

  // C-R1: WebGL-style renderState forwarded to the encoder per-draw.
  renderState?: CesiumRenderStateLike;

  /**
   * C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 78). Mirrors the WebGL
   * `DrawCommand.depthForTranslucentClassification` flag (set by
   * `Cesium3DTile.js:1084` on every translucent 3D-tile command).
   * `WebGPUTranslucentTileClassification.executeTranslucentDepthPass`
   * checks this flag before doing the broad scene-depth copy — when no
   * commands in the frustum are flagged, the entire pack-depth pipeline
   * is short-circuited.
   *
   * Defaults `false`. Should propagate through any per-command derived
   * variants the renderer creates (depth-only, log-depth, pick) so the
   * dispatcher's variant selection doesn't strip the flag mid-frame.
   */
  depthForTranslucentClassification: boolean = false;

  /**
   * C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79). Optional depth-write variant
   * of `pipeline`. Bound by `execute()` in place of `pipeline` whenever
   * `depthForTranslucentClassification` is true and this variant is set.
   * For ALPHA_BLEND models, `WebGPUModelRenderer` builds a sibling
   * pipeline with `depthWriteEnabled = true` and stashes it here so a
   * translucent 3D-tile surface populates the scene-FB depth attachment.
   * Undefined for OPAQUE/MASK paths (they already write depth) and for
   * non-tile renderers that never receive the flag.
   */
  classificationDepthPipeline?: GPURenderPipeline;

  /**
   * Migration Session 3 (Batch 83) — per-bind-group late-binding
   * resolvers. See `WebGPUDrawCommandOptions.bindGroupResolvers` for
   * the contract. Indexed by @group binding number; absent entries
   * use the static `bindGroups[i]` reference. Resolvers run inside
   * `execute()` between pipeline binding and vertex-buffer setup,
   * giving consumers (e.g., depth-sample classifier) a hook to swap
   * in a frustum-current bind group without rebuilding the command.
   */
  bindGroupResolvers?: Array<undefined | (() => GPUBindGroup | null)>;

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
    this.occlude = options.occlude ?? true;
    this.debugShowBoundingVolume = options.debugShowBoundingVolume ?? false;
    this.castShadows = options.castShadows ?? false;
    this.receiveShadows = options.receiveShadows ?? false;
    this.pickId = options.pickId;
    this.pickOnly = options.pickOnly ?? false;
    this.executeInClosestFrustum = options.executeInClosestFrustum ?? false;

    // Structured sort properties (matching DrawCommand parity)
    this.sortLayer = normalizeCommandSortByte(
      options.sortLayer,
      DEFAULT_COMMAND_SORT_LAYER,
    );
    this.sortPriority = normalizeCommandSortByte(
      options.sortPriority,
      DEFAULT_COMMAND_SORT_PRIORITY,
    );
    this.materialSortId = normalizeCommandMaterialSortId(
      options.materialSortId ?? DEFAULT_COMMAND_MATERIAL_SORT_ID,
    );
    this.visibilityMask = options.visibilityMask ?? 0xffffffff;
    this.isTransmissive = options.isTransmissive ?? false;

    // Indirect draw — when the consumer sets this, `execute()` takes
    // the drawIndirect / drawIndexedIndirect path and ignores CPU-side
    // counts. Used by the GPU-LOD point cloud path where visibleCount
    // is computed on the GPU.
    this.drawIndirectBuffer = options.drawIndirectBuffer;
    this.drawIndirectOffset = options.drawIndirectOffset ?? 0;

    // C-R1: WebGL-style renderState forwarded per-draw. Undefined when the
    // feature renderer already bakes everything into the pipeline (typical
    // WebGPU-native case); non-null when the command came from a WebGL
    // consumer that wants stencilRef / blendConstant / viewport / scissor.
    this.renderState = options.renderState;
    this.depthForTranslucentClassification =
      options.depthForTranslucentClassification ?? false;
    this.classificationDepthPipeline = options.classificationDepthPipeline;
    this.bindGroupResolvers = options.bindGroupResolvers;
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
   * @param dynamicStateOverride Optional pass-owned viewport/scissor applied
   * after command renderState so the pass restriction wins.
   *
   * @example
   * const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
   * drawCommand.execute(passEncoder);
   * passEncoder.end();
   */
  execute(
    passEncoder: GPURenderPassEncoder,
    dynamicStateOverride?: WebGPUDynamicStateOverride,
  ): void {
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
      // A bundle is opaque at replay time, so publish the pass-owned state
      // immediately before it. Native commands below can be more selective:
      // they restore only channels their renderState actually overwrote.
      applyDynamicStateOverride(
        passEncoder,
        dynamicStateOverride,
        undefined,
        true,
      );
      passEncoder.executeBundles([this.bundle!]);
      return;
    }

    // Set the pipeline. C-R8-TRANSLUCENT-DEPTH-ONLY (Batch 79) — when
    // a translucent 3D-tile command is flagged for classification depth
    // and a depth-write variant has been provided, bind the variant
    // instead of the default. The variant differs only in
    // `depthWriteEnabled = true`; layout, vertex, fragment, and blend
    // are identical, so the bind groups / vertex buffers / draw call
    // below remain valid. This makes the tile populate scene-FB depth
    // so the stencil-based GroundPrimitive classifier clips against
    // the tile surface (matching WebGL's depth-texture sampling
    // behaviour for translucent classification).
    const pipelineToBind =
      this.depthForTranslucentClassification &&
      defined(this.classificationDepthPipeline)
        ? this.classificationDepthPipeline!
        : this.pipeline;
    passEncoder.setPipeline(pipelineToBind);

    // C-R1: apply per-encoder dynamic state (stencilRef / blendConstant /
    // viewport / scissor) from any WebGL-style renderState before the draw
    // call. No-op when `renderState` is undefined (the WebGPU-native
    // happy path where everything is baked into the pipeline).
    if (this.renderState) {
      applyPerEncoderState(passEncoder, this.renderState);
    }
    applyDynamicStateOverride(
      passEncoder,
      dynamicStateOverride,
      this.renderState,
    );

    // Set all bind groups. Migration Session 3 (Batch 83) — per-index
    // resolvers, when present, are called at draw time to swap in a
    // frustum-current bind group (e.g., the depth-sample classifier's
    // depth source view, which can flip between globe-depth and
    // packed-translucent-depth across frustums within the same frame).
    // Resolvers returning `null` fall back to the static reference,
    // keeping the command functional when the per-frustum source isn't
    // published yet (first frame, viewport resize, no translucent
    // tiles this frustum).
    for (let i = 0; i < this.bindGroups.length; i++) {
      const resolver = this.bindGroupResolvers?.[i];
      const resolved = resolver ? resolver() : null;
      passEncoder.setBindGroup(i, resolved ?? this.bindGroups[i]);
    }

    // Set all vertex buffers
    for (let i = 0; i < this.vertexBuffers.length; i++) {
      passEncoder.setVertexBuffer(i, resolveBuffer(this.vertexBuffers[i]));
    }

    // Execute draw call — indirect takes priority over CPU-specified
    // counts. The indirect buffer's layout is set by its producer (e.g.
    // the WebGPU point cloud LOD compute pass writes visibleCount into
    // the instanceCount slot). Both indexed and non-indexed variants
    // are supported; index buffer presence picks the variant.
    if (defined(this.drawIndirectBuffer)) {
      const indirectBuf = resolveBuffer(this.drawIndirectBuffer!);
      if (defined(this.indexBuffer)) {
        passEncoder.setIndexBuffer(
          resolveBuffer(this.indexBuffer!),
          this.indexFormat,
        );
        passEncoder.drawIndexedIndirect(indirectBuf, this.drawIndirectOffset);
      } else {
        passEncoder.drawIndirect(indirectBuf, this.drawIndirectOffset);
      }
    } else if (defined(this.indexBuffer) && defined(this.indexCount)) {
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
      occlude: this.occlude,
      debugShowBoundingVolume: this.debugShowBoundingVolume,
      castShadows: this.castShadows,
      receiveShadows: this.receiveShadows,
      pickId: this.pickId,
      pickOnly: this.pickOnly,
      executeInClosestFrustum: this.executeInClosestFrustum,
      sortKey: this.sortKey,
      sortLayer: this.sortLayer,
      sortPriority: this.sortPriority,
      materialSortId: this.materialSortId,
      visibilityMask: this.visibilityMask,
      isTransmissive: this.isTransmissive,
      renderState: this.renderState,
    });
  }
}

export default WebGPUDrawCommand;
