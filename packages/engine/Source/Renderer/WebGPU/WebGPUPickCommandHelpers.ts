/**
 * Shared lifecycle and descriptor utilities for WebGPU pick commands.
 *
 * The helpers cache per-primitive pick IDs, attach pick variants to color
 * commands, clone compatible single-target pipeline descriptors, and clear
 * cached IDs and destroy their registry entries during renderer teardown.
 * Fragment shader bodies, uniform layouts, and readiness-aware pipeline-cache
 * routing remain renderer-specific.
 *
 * Model rendering uses a context-scoped pick-pipeline cache keyed by material
 * and pipeline configuration rather than cloning each color descriptor. It
 * lets matching primitives reuse one canonical pipeline while still sharing
 * {@link ensurePickId} and {@link attachPickToColorCommand}.
 *
 * @private
 */

import type {
  PickKind,
  PickTarget,
  PickTargetField,
} from "../GraphicsContext.js";
import type { WebGPURenderPipelineDescriptor } from "./WebGPURenderPipelineCache.js";

/**
 * Subset of `GraphicsContext` we need for pick-id allocation. Kept narrow so
 * callers (which already have either a typed `WebGPUContext` or a JS-side
 * `Context`) can pass the context through without an extra cast.
 *
 * @private
 */
export interface PickIdContext {
  createPickId(object: PickTarget, kind?: PickKind): CesiumPickId;
}

/**
 * Shape of the per-primitive cache slot used for renderers with a SINGLE
 * pickId per primitive (Ellipsoid, Ground, Splat, Voxel). The matching
 * legacy field names `_pickId` / `_pickIdLastId` are preserved so any
 * existing debug-tooling / external references keep working.
 *
 * @private
 */
export interface SinglePickIdCache {
  _pickId?: CesiumPickId;
  _pickIdLastId?: unknown;
}

/**
 * Shape of the per-model cache slot used by renderers that allocate one
 * pickId per glTF primitive (Model). Keyed by a caller-provided string
 * (e.g. `"${nodeIdx}_${primIdx}"`).
 *
 * @private
 */
export interface MultiPickIdCache {
  pickIds?: Record<string, CesiumPickId>;
}

/**
 * Shape of Cesium's wrapper chain for geometry-backed primitives. The inner
 * `Primitive` owns one pick ID per `GeometryInstance`; wrappers such as
 * `GroundPrimitive` and `ClassificationPrimitive` expose it through one or
 * two `_primitive` links.
 *
 * @private
 */
export interface GeometryInstancePickIdNode {
  _pickIds?: CesiumPickId[];
  _primitive?: GeometryInstancePickIdNode;
}

/**
 * Return the first upstream GeometryInstance pick ID in a primitive wrapper
 * chain without allocating anything.
 *
 * Geometry-backed feature renderers must reuse this ID instead of registering
 * a second wrapper-level ID: the upstream object carries the public instance
 * `id` and the correct `pickPrimitive` payload, while a wrapper generally has
 * no own `id`. The fixed-depth walk is allocation-free on the render hot path
 * and covers the current direct Primitive, ClassificationPrimitive ->
 * Primitive, and GroundPrimitive -> ClassificationPrimitive -> Primitive
 * shapes.
 *
 * @param root - Outermost renderer owner (or a direct Primitive).
 * @returns The first GeometryInstance pick ID, or undefined while the inner
 *   Primitive is not ready / picking is disabled.
 *
 * @private
 */
export function findFirstGeometryInstancePickId(
  root: GeometryInstancePickIdNode | undefined,
): CesiumPickId | undefined {
  let current = root;
  for (let depth = 0; depth < 4 && current; depth++) {
    const pickIds = current._pickIds;
    if (pickIds && pickIds.length > 0) {
      return pickIds[0];
    }
    current = current._primitive;
  }
  return undefined;
}

/**
 * Allocate (or refresh) a {@link CesiumPickId} for a primitive and cache it
 * on the supplied target object.
 *
 * Two operating modes:
 *
 *   1. **`idKey === undefined`** (single-id mode): cache slot is
 *      `{ _pickId, _pickIdLastId }`. The cached id is kept across frames and
 *      re-allocated only when `target.id` changes. Used by Ellipsoid, Ground,
 *      GaussianSplat, and Voxel, all of which have one pick target per
 *      primitive.
 *
 *   2. **`idKey` is a string** (multi-id mode): cache slot is
 *      `{ pickIds: Record<string, CesiumPickId> }`. The cache grows by one
 *      entry per new key. Used by Model with the per-glTF-primitive key
 *      `"${nodeIdx}_${primIdx}"`.
 *
 * Returns the cached pickId (or `undefined` if neither {@link allowAllocate}
 * nor an existing cache entry produced one — e.g. an offscreen-only frame
 * where pick allocation is gated off).
 *
 * @param target - The primitive (or model) to register with the pick
 *   registry. Used both as the pick payload and as the cache host. Caller
 *   passes `target` typed as the renderer's primitive type and supplies the
 *   cache type via {@link cache}.
 * @param context - Anything implementing {@link PickIdContext}. Both
 *   `Context` (WebGL) and `WebGPUContext` work via {@link GraphicsContext}.
 * @param cache - The cache slot. For single-id mode, must be the same object
 *   that owns `_pickId` / `_pickIdLastId`; for multi-id mode, must own
 *   `pickIds`. (Conventionally the primitive itself for single-id and the
 *   per-renderer cache object for multi-id.)
 * @param options - Per-call options.
 * @param options.allowAllocate - When `false`, only returns an already-cached
 *   pickId; never allocates. This lets each renderer apply its exact demand
 *   policy (for example, an active pick pass plus owner/classifier
 *   eligibility) without duplicating the read-back path. Defaults to `true`.
 * @param options.idKey - When set, switches to multi-id mode keyed by this
 *   string. When unset, single-id mode.
 * @param options.kind - Pick discriminator passed to `context.createPickId`.
 *   Defaults to `"primitive"` to match all five existing call sites.
 *
 * @returns The cached or freshly-allocated pickId, or `undefined` if
 *   {@link options.allowAllocate} was `false` and no entry was cached.
 *
 * @private
 */
export function ensurePickId(
  target: PickTarget,
  context: PickIdContext,
  cache: SinglePickIdCache | MultiPickIdCache,
  options?: {
    allowAllocate?: boolean;
    idKey?: string;
    kind?: PickKind;
    /**
     * Optional fields copied into the multi-ID pick object. Callers can attach
     * backend-neutral detail such as the owning model used by structural
     * metadata queries.
     */
    detail?: Record<string, PickTargetField>;
  },
): CesiumPickId | undefined {
  const allowAllocate = options?.allowAllocate ?? true;
  const idKey = options?.idKey;
  const kind: PickKind = options?.kind ?? "primitive";
  const detail = options?.detail;

  if (idKey !== undefined) {
    const multi = cache as MultiPickIdCache;
    if (!multi.pickIds) {
      if (!allowAllocate) {
        return undefined;
      }
      multi.pickIds = {};
    }
    const existing = multi.pickIds[idKey];
    if (existing) {
      return existing;
    }
    if (!allowAllocate) {
      return undefined;
    }
    const pickObject: PickTarget = detail
      ? { primitive: target, id: idKey, detail }
      : { primitive: target, id: idKey };
    const created = context.createPickId(pickObject, kind);
    multi.pickIds[idKey] = created;
    return created;
  }

  // Single-id mode. The cache slot uses the legacy `_pickId` / `_pickIdLastId`
  // names so existing debug tooling and external references keep working.
  const single = cache as SinglePickIdCache;
  // Pull `id` from the target without forcing a typed cast — the index
  // signature on `PickTarget` makes this safe.
  const currentId: unknown = (target as { id?: unknown }).id;

  if (single._pickId && single._pickIdLastId === currentId) {
    return single._pickId;
  }

  if (!allowAllocate) {
    return single._pickId;
  }

  if (single._pickId) {
    single._pickId.destroy();
  }
  const fresh = context.createPickId(
    { primitive: target, id: currentId },
    kind,
  );
  single._pickId = fresh;
  single._pickIdLastId = currentId;
  return fresh;
}

/**
 * Bulk-destroy every cached pickId on a renderer cache, regardless of which
 * shape (single-id or multi-id) was used. Safe to call on a half-populated
 * cache or one that never entered a pick pass — every branch is a no-op when
 * its slot is empty.
 *
 * Called from each renderer's `destroy*Resources` path so the pick registry
 * reclaims the color slot(s) before the cache object itself is dropped.
 *
 * @param cache - The cache slot. May implement either {@link SinglePickIdCache}
 *   or {@link MultiPickIdCache}, or both.
 *
 * @private
 */
export function destroyPickIds(
  cache: (SinglePickIdCache & Partial<MultiPickIdCache>) | undefined,
): void {
  if (!cache) {
    return;
  }

  const singlePickId = cache._pickId;
  const pickIds = cache.pickIds;
  cache._pickId = undefined;
  cache._pickIdLastId = undefined;
  cache.pickIds = undefined;

  let firstDestroyError: unknown;
  let hasDestroyError = false;
  const destroyBestEffort = (pickId: CesiumPickId | undefined): void => {
    if (!pickId) {
      return;
    }
    try {
      pickId.destroy();
    } catch (error) {
      if (!hasDestroyError) {
        firstDestroyError = error;
        hasDestroyError = true;
      }
    }
  };

  destroyBestEffort(singlePickId);
  if (pickIds) {
    for (const key of Object.keys(pickIds)) {
      destroyBestEffort(pickIds[key]);
    }
  }

  if (hasDestroyError) {
    throw firstDestroyError;
  }
}

/**
 * Options for {@link buildPickPipelineDescriptor}.
 *
 * @private
 */
export interface BuildPickPipelineDescriptorOptions {
  /**
   * Optional descriptor name override. Defaults to the color descriptor's
   * name with `" pick"` appended so the WebGPU dev-tools labels stay
   * distinguishable.
   */
  name?: string;

  /**
   * When `true`, force the pick descriptor's `depthStencil.depthWriteEnabled`
   * to `true` regardless of the color descriptor's setting.
   *
   * Enable this when later pick draws depend on prior fragments updating
   * depth for back-clipping. Pass `false` for paths that intentionally keep
   * depth writes disabled.
   *
   * Defaults to `true` to match the most common case (the descriptor is
   * cloned for an opaque-depth-style renderer).
   */
  forceDepthWriteEnabled?: boolean;
}

/**
 * Clone a color pipeline descriptor into a pick variant: same layout, same
 * vertex stage, same depthStencil shape — but the fragment entry swaps to
 * {@link pickFragmentEntry}, and the color targets are replaced by exactly
 * one explicit non-blended single-sample target stamped with
 * {@link pickFormat}. This keeps pick colors byte-exact for round-trip
 * readback. `depthWriteEnabled` is overridden per
 * {@link options.forceDepthWriteEnabled}.
 *
 * {@link pickFormat} is required and callers pass
 * `context.pickPipelineFormat`, keeping byte-ID picking independent of the
 * scene color format when high dynamic range rendering uses a float target.
 *
 * Returns a new descriptor without mutating the input. Safe to feed into
 * `WebGPURenderPipelineCache.getPipeline()` or pass through `descriptorToGPU`.
 *
 * @param colorDescriptor - The color pipeline descriptor to clone.
 * @param pickFragmentEntry - The WGSL function name to use as the pick
 *   fragment entry point. Must exist in the same shader module as the color
 *   fragment entry; the helper does NOT swap the module reference.
 * @param pickFormat - The pick color attachment format. Pass
 *   `context.pickPipelineFormat`.
 * @param options - See {@link BuildPickPipelineDescriptorOptions}.
 *
 * @private
 */
export function buildPickPipelineDescriptor(
  colorDescriptor: WebGPURenderPipelineDescriptor,
  pickFragmentEntry: string,
  pickFormat: GPUTextureFormat,
  options?: BuildPickPipelineDescriptorOptions,
): WebGPURenderPipelineDescriptor {
  const forceDepthWriteEnabled = options?.forceDepthWriteEnabled ?? true;

  const colorFragment = colorDescriptor.fragment;
  if (!colorFragment) {
    // The pick descriptor needs a fragment stage to emit pickColor — without
    // one we'd produce a depth-only pipeline that writes nothing into the
    // pick FBO. Throw rather than silently producing a broken pipeline.
    throw new Error(
      `WebGPUPickCommandHelpers.buildPickPipelineDescriptor: ` +
        `colorDescriptor "${colorDescriptor.name}" has no fragment stage; ` +
        `cannot derive a pick variant.`,
    );
  }

  // The pick render pass has one color attachment. Preserve the first defined
  // target's write mask, remove blending, and stamp the caller's pick format
  // rather than inheriting a potentially different scene color format.
  const slot0 = colorFragment.targets.find(
    (t): t is GPUColorTargetState => t !== null && t !== undefined,
  );
  if (!slot0) {
    throw new Error(
      `WebGPUPickCommandHelpers.buildPickPipelineDescriptor: ` +
        `colorDescriptor "${colorDescriptor.name}" has no color target; ` +
        `cannot derive a pick variant.`,
    );
  }
  const { blend: _blend, ...slot0NoBlend } = slot0;
  void _blend;
  const pickTargets: GPUColorTargetState[] = [
    { ...slot0NoBlend, format: pickFormat },
  ];

  const pickFragment = {
    module: colorFragment.module,
    entryPoint: pickFragmentEntry,
    targets: pickTargets,
  };

  const pickDepthStencil: GPUDepthStencilState | undefined =
    colorDescriptor.depthStencil
      ? {
          ...colorDescriptor.depthStencil,
          depthWriteEnabled: forceDepthWriteEnabled
            ? true
            : colorDescriptor.depthStencil.depthWriteEnabled,
        }
      : undefined;

  return {
    name: options?.name ?? `${colorDescriptor.name} pick`,
    layout: colorDescriptor.layout,
    vertex: {
      module: colorDescriptor.vertex.module,
      entryPoint: colorDescriptor.vertex.entryPoint,
      buffers: colorDescriptor.vertex.buffers,
    },
    fragment: pickFragment,
    primitive: colorDescriptor.primitive,
    depthStencil: pickDepthStencil,
    // The pick framebuffer is single-sample. Omit the color descriptor's
    // multisample state so this pipeline remains compatible when the color
    // pass uses multisampling.
    multisample: undefined,
  };
}

/**
 * Drawable surface — anything with a mutable `derivedCommands` bag. Both
 * `WebGPUDrawCommand` and JS-side legacy `DrawCommand` instances satisfy
 * this shape; we keep the helper backend-neutral.
 *
 * @private
 */
export interface DrawCommandWithDerivedSlot {
  derivedCommands?: {
    picking?: {
      pickCommand?: unknown;
      // Optional hover and precise variants. When absent, the dispatcher
      // falls back to the default pick command. Renderers can materialize them
      // lazily after pickHoverAsync or pickPreciseAsync is requested.
      pickHoverCommand?: unknown;
      pickPrecisePass1Command?: unknown;
      pickPrecisePass2Command?: unknown;
      // Per-cell variant selected only while passes.pickVoxel is active.
      pickVoxelCommand?: unknown;
    };
    // Metadata variant selected while frameState.pickingMetadata is true.
    pickingMetadata?: {
      pickMetadataCommand?: unknown;
    };
    // Shared snapping slot, materialized lazily after Scene.snap is requested.
    snapping?: {
      snapCommand?: unknown;
    };
  } & Record<string, unknown>;
}

/**
 * Wire a pick command onto the color command's `derivedCommands.picking`
 * slot so `selectCommandVariant` selects it during pick passes.
 *
 * Idempotent — calling it more than once with the same arguments is a no-op
 * after the first call. Calling with a fresh pick command replaces the slot.
 *
 * @param colorCommand - The base color command emitted into the command list.
 * @param pickCommand - The pick variant. Should be tagged with
 *   `pickOnly: true` by the caller so other passes skip it.
 *
 * @private
 */
export function attachPickToColorCommand<TPick>(
  colorCommand: DrawCommandWithDerivedSlot,
  pickCommand: TPick,
): void {
  const existing = colorCommand.derivedCommands;
  if (existing) {
    const picking = existing.picking;
    if (picking) {
      picking.pickCommand = pickCommand;
      return;
    }
    existing.picking = { pickCommand };
    return;
  }
  colorCommand.derivedCommands = { picking: { pickCommand } };
}

/**
 * Wires optional hover and two-pass precise commands onto the color command's
 * picking slot.
 *
 * Renderers call this after `attachPickToColorCommand` populates the default
 * pick command. The dispatcher reads
 * `frameState.passes.pickMode` to choose which variant fires:
 *
 *   - 'default' → existing pickCommand
 *   - 'hover'   → pickHoverCommand, falling back to pickCommand when absent
 *   - 'precise' → pickPrecisePass1Command + pickPrecisePass2Command
 *                 in the same render pass, falling back to pickCommand when
 *                 precise variants are absent
 *
 * @private
 */
export function attachPickVariantsToColorCommand<TPick>(
  colorCommand: DrawCommandWithDerivedSlot,
  variants: {
    hoverPick?: TPick;
    precisePass1?: TPick;
    precisePass2?: TPick;
  },
): void {
  let derived = colorCommand.derivedCommands;
  if (!derived) {
    derived = {};
    colorCommand.derivedCommands = derived;
  }
  let picking = derived.picking;
  if (!picking) {
    picking = {};
    derived.picking = picking;
  }
  if (variants.hoverPick !== undefined) {
    picking.pickHoverCommand = variants.hoverPick;
  }
  if (variants.precisePass1 !== undefined) {
    picking.pickPrecisePass1Command = variants.precisePass1;
  }
  if (variants.precisePass2 !== undefined) {
    picking.pickPrecisePass2Command = variants.precisePass2;
  }
}

/**
 * Wires a snapping-pass command onto the color command's
 * `derivedCommands.snapping.snapCommand` slot so
 * `selectCommandVariant(..., snapVariant = true)` returns it during the payload
 * phase of a `Scene.snap` mini-frame.
 *
 * The separate slot prevents object-pick commands, which target a byte-color
 * attachment, from entering the rg32uint snap payload pass and failing
 * draw-time attachment validation.
 *
 * Idempotent — replaces the slot on each call.
 *
 * @param colorCommand - The base color command emitted into the command list.
 * @param snapCommand - The snap variant (tagged `pickOnly: true` by the caller
 *   so ordinary passes skip it).
 *
 * @private
 */
export function attachSnapToColorCommand<TSnap>(
  colorCommand: DrawCommandWithDerivedSlot,
  snapCommand: TSnap,
): void {
  let derived = colorCommand.derivedCommands;
  if (!derived) {
    derived = {};
    colorCommand.derivedCommands = derived;
  }
  const snapping = derived.snapping;
  if (snapping) {
    snapping.snapCommand = snapCommand;
    return;
  }
  derived.snapping = { snapCommand };
}

/**
 * Wires a per-cell voxel-pick command onto the color command's
 * `derivedCommands.picking.pickVoxelCommand` slot so the
 * `selectCommandVariant` dispatcher (in `WebGPUSceneRenderer.ts`) returns it
 * during a `Scene.pickVoxel` pass (`frameState.passes.pickVoxel === true`).
 * The variant packs `{ megatextureIndex, sampleIndex }` separately from the
 * ordinary object-pick command, which stays untouched.
 *
 * Idempotent — replaces the slot on each call.
 *
 * @param colorCommand - The base color command emitted into the command list.
 * @param pickVoxelCommand - The per-cell pick variant (pickOnly: true).
 *
 * @private
 */
export function attachPickVoxelToColorCommand<TPick>(
  colorCommand: DrawCommandWithDerivedSlot,
  pickVoxelCommand: TPick,
): void {
  let derived = colorCommand.derivedCommands;
  if (!derived) {
    derived = {};
    colorCommand.derivedCommands = derived;
  }
  let picking = derived.picking;
  if (!picking) {
    picking = {};
    derived.picking = picking;
  }
  picking.pickVoxelCommand = pickVoxelCommand;
}

/**
 * Wires a metadata-pick command onto the color command's
 * `derivedCommands.pickingMetadata.pickMetadataCommand` slot so the
 * `selectCommandVariant` dispatcher (in `WebGPUSceneRenderer.ts`) returns it
 * during a `scene.pickMetadata` pass (`frameState.pickingMetadata === true`).
 *
 * Idempotent — replaces the slot on each call so a re-pick of a different
 * property updates the command.
 *
 * @param colorCommand - The base color command emitted into the command list.
 * @param pickMetadataCommand - The metadata-pick variant (pickOnly: true).
 *
 * @private
 */
export function attachPickMetadataToColorCommand<TPick>(
  colorCommand: DrawCommandWithDerivedSlot,
  pickMetadataCommand: TPick,
): void {
  let derived = colorCommand.derivedCommands;
  if (!derived) {
    derived = {};
    colorCommand.derivedCommands = derived;
  }
  derived.pickingMetadata = { pickMetadataCommand };
}
