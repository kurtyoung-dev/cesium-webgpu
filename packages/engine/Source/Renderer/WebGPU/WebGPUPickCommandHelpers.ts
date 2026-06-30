/**
 * WebGPU Pick Command Helpers — shared lifecycle + descriptor utilities for
 * the per-renderer pick command pattern (C-R9 family).
 *
 * Background (Batch 59 — Extract WebGPUPickCommandHelpers): five renderers
 * (Ellipsoid B30, Ground B31, GaussianSplat B31, Voxel B53, Model B54)
 * converged on the same recipe:
 *
 *   - Per-primitive (or per-glTF-primitive) `CesiumPickId` allocated on first
 *     render/pick frame, cached, and re-allocated whenever `primitive.id`
 *     changes (so a runtime `id` reassignment doesn't keep the stale color).
 *   - A pick render-pipeline that mirrors the color pipeline's layout +
 *     vertex stage + depth-stencil but swaps the fragment entry to a
 *     renderer-specific WGSL function (`fragmentPickMain` / `pickFS` /
 *     `samplePickAtRayMarchHit` / etc.) and disables blending so the pick
 *     color reaches the FBO byte-exact.
 *   - A `WebGPUDrawCommand` that shares everything except pipeline with the
 *     color command, wired onto `colorCommand.derivedCommands.picking
 *     .pickCommand` so the Batch 29 `selectCommandVariant` dispatcher in
 *     `WebGPUSceneRenderer.ts` swaps to it during pick passes.
 *   - Teardown that calls `pickId.destroy()` so the registry slot is
 *     reclaimed before the cache slot is dropped.
 *
 * **What is shared (extracted here):** the lifecycle + wiring boilerplate.
 *
 * **What stays per-renderer (NOT extracted):**
 *   - The WGSL pick fragment source (Voxel does ray-march, Splat does Gaussian
 *     evaluation, Model has alpha-mask discard, etc. — the entry signatures
 *     and bodies legitimately differ).
 *   - The UBO struct layout — every renderer has its own pickColor offset and
 *     companion fields.
 *   - The pipeline-cache routing (sync / async dance through
 *     `WebGPURenderPipelineCache`) — kept per-renderer because cache lookup
 *     timing is fused with the renderer's own ready-state machine.
 *
 * **Renderer that intentionally bypasses these helpers:**
 *   - `WebGPUModelRenderer.js` uses `WebGPUModelPipelineCache.getPickPipeline
 *     (alphaMode, doubleSided)` — a context-scoped cache that materializes
 *     the pick pipeline from a parameter pair rather than from a clonable
 *     descriptor, because the alpha-mask + double-sided combinatorics drive
 *     a small set of canonical pick pipelines shared across every Model
 *     primitive. Cloning each color descriptor would duplicate work the
 *     pipeline cache already coalesces.
 *
 *     Model still uses {@link ensurePickId} (with a string `idKey` to keep a
 *     map of per-primitive pickIds keyed by `nodeIdx_primIdx`) and
 *     {@link attachPickToColorCommand}, just not
 *     {@link buildPickPipelineDescriptor}.
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
 *   pickId; never allocates. Used by callers that want to gate allocation on
 *   `frameState.passes.pick || passes.render` without duplicating the
 *   read-back path. Defaults to `true`.
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
     * DP-H46e — optional `detail` payload folded into the pick object so the
     * backend-agnostic `Scene.pickMetadata` orchestration (which reads
     * `pickedObject.detail.model.structuralMetadata`) and any other
     * detail-consuming caller see the SAME shape WebGL's
     * `PickingPipelineStage.buildPickObject` produces (`{ primitive, detail: {
     * model, node, primitive } }`). Omitted by every existing caller so the
     * pick object is byte-identical (`{ primitive, id }`) for them.
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
  // Single-id slot.
  if (cache._pickId) {
    cache._pickId.destroy();
    cache._pickId = undefined;
    cache._pickIdLastId = undefined;
  }
  // Multi-id slot.
  if (cache.pickIds) {
    for (const key of Object.keys(cache.pickIds)) {
      cache.pickIds[key]?.destroy();
    }
    cache.pickIds = undefined;
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
   * The Batch 30 Ellipsoid pick path uses `true` (pick fragments must paint
   * into the pick depth target so subsequent pick draws back-clip correctly).
   *
   * Splat / Voxel / Ground all use `false` (their color paths don't write
   * depth either — translucent or stencil-gated draws). Pass `false` for
   * those.
   *
   * Defaults to `true` to match the most common case (the descriptor is
   * cloned for an opaque-depth-style renderer).
   */
  forceDepthWriteEnabled?: boolean;
}

/**
 * Clone a color pipeline descriptor into a pick variant: same layout, same
 * vertex stage, same depthStencil shape — but the fragment entry swaps to
 * {@link pickFragmentEntry}, every color target loses its blend state (pick
 * colors MUST reach the FBO byte-exact for round-trip readback to work),
 * and `depthWriteEnabled` is overridden per {@link options.forceDepthWriteEnabled}.
 *
 * Returns a new descriptor; does NOT mutate the input. Safe to feed into
 * `WebGPURenderPipelineCache.getPipeline()` or pass through `descriptorToGPU`.
 *
 * @param colorDescriptor - The color pipeline descriptor to clone.
 * @param pickFragmentEntry - The WGSL function name to use as the pick
 *   fragment entry point. Must exist in the same shader module as the color
 *   fragment entry; the helper does NOT swap the module reference.
 * @param options - See {@link BuildPickPipelineDescriptorOptions}.
 *
 * @private
 */
export function buildPickPipelineDescriptor(
  colorDescriptor: WebGPURenderPipelineDescriptor,
  pickFragmentEntry: string,
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

  // Strip blend on every color target while preserving format + writeMask.
  // Spread instead of mutating so the caller's descriptor stays untouched
  // (matters for renderers that hold the color descriptor in long-lived
  // pipeline-resources state).
  //
  // Slice 5c-B Batch 118 — filter out the G-buffer slot-1 target. The
  // pick render pass has 1 color attachment (the pick framebuffer's
  // rgba8unorm color); converted renderers' color pipelines now declare
  // 2 targets (scene color + G-buffer placeholder) via
  // `makeSceneFBTargets`. Without this filter the pick pipeline would
  // declare 2 targets against a 1-attachment pass and trip
  // "Attachment state not compatible" at the first pick. Drop any
  // target whose format matches the G-buffer format AND filter out
  // explicit nulls in case a future caller passes them.
  const pickTargets: GPUColorTargetState[] = colorFragment.targets
    .filter(
      (t): t is GPUColorTargetState =>
        t !== null && t !== undefined && t.format !== "rgba16float",
    )
    .map((target) => {
      // Drop the `blend` slot entirely. `writeMask` defaults to ALL when not
      // specified, which is what we want for pick targets.
      const { blend: _blend, ...rest } = target;
      // `_blend` is intentionally discarded; rename to underscore-prefix to
      // keep linters happy without an explicit unused-marker comment.
      void _blend;
      return rest;
    });

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
    // Slice 5c-B Batch 118 — pick framebuffer is always single-sample
    // (the pick FB doesn't use MSAA; pick reads back exact bytes from
    // the rgba8unorm color attachment). Drop the color descriptor's
    // multisample state entirely so the pick pipeline targets the
    // single-sample pick pass even when color is MSAA. Previously the
    // pick pipeline inherited color's multisample and would have
    // tripped "Attachment state not compatible" at first pick attempt
    // for any renderer using MSAA color + this helper.
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
      // Batch 192 — C-R9-MODEL-PICK-TRANSLUCENT second-slice variants.
      // Both are optional; primitives that opt into hover/precise pick
      // populate them, others leave them undefined and the dispatcher
      // falls back to the default `pickCommand`. Materialized only
      // when `scene.pickHover()` / `scene.pickPrecise()` is called at
      // least once on the scene (lazy pipeline allocation).
      pickHoverCommand?: unknown;
      pickPrecisePass1Command?: unknown;
      pickPrecisePass2Command?: unknown;
    };
    // DP-H46e — metadata-pick slot. Materialized only during a
    // `scene.pickMetadata` pass (frameState.pickingMetadata true); the
    // dispatcher returns `pickMetadataCommand` ahead of the regular pick slot.
    pickingMetadata?: {
      pickMetadataCommand?: unknown;
    };
  } & Record<string, unknown>;
}

/**
 * Wire a pick command onto the color command's `derivedCommands.picking`
 * slot so the Batch 29 `selectCommandVariant` dispatcher (in
 * `WebGPUSceneRenderer.ts`) swaps to it during pick passes.
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
 * C-R9-MODEL-PICK-TRANSLUCENT (Batch 192) — second-slice pick variant
 * attachment. Wires the optional hover (Option D) and precise (Option C
 * 2-pass) pick commands onto the color command's picking slot.
 *
 * Renderers call this AFTER `attachPickToColorCommand` populates the
 * default pick command. The dispatcher (`selectCommandVariant`) reads
 * `frameState.passes.pickMode` to choose which variant fires:
 *
 *   - 'default' → existing pickCommand (B186 first slice)
 *   - 'hover'   → pickHoverCommand (Option D dither, falls back to
 *                 pickCommand if hover variant absent)
 *   - 'precise' → pickPrecisePass1Command + pickPrecisePass2Command
 *                 (sequenced same render pass; falls back to pickCommand
 *                 if precise variants absent — OPAQUE/MASK case)
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
 * DP-H46e — wire a metadata-pick command onto the color command's
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
