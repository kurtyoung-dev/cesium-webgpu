/// <reference types="@webgpu/types" />
/**
 * WebGPU centralized pipeline-variant factory — the WGSL counterpart of
 * WebGL's `Scene/DerivedCommand.js`. Core SHIPPED Batch 248
 * (NEW-DERIVEDCOMMAND-VARIANT-FACTORY); was scaffolding until then.
 *
 * The derived-command architecture has two halves:
 *
 * **Dispatch half — variant STRUCTURE + selection (lives elsewhere).**
 * Commands carry a `derivedCommands.{picking,depth,shadows,logDepth,hdr}.*`
 * structure and `selectCommandVariant` (WebGPUSceneRenderer.ts) dispatches
 * through it every frame for pick / depth / shadow / log-depth passes.
 *
 * **Factory half — THIS file.** In WebGL, DerivedCommand mutates
 * ShaderPrograms by injecting defines and replacing fragment shader code.
 * In WebGPU, a variant is a PIPELINE-DESCRIPTOR mutation (color targets,
 * depth-stencil state, multisample state, …) plus a shader-module /
 * entry-point swap, materialized through the central
 * `WebGPURenderPipelineCache` under a variant-keyed descriptor name:
 *
 *   - {@link WebGPUDerivedCommand.deriveDescriptor} — pure descriptor
 *     derivation per {@link DerivedCommandType}. Never mutates the base
 *     descriptor; enforces the cross-renderer invariants centrally (below).
 *   - {@link WebGPUDerivedCommand.resolveVariantPipeline} — the shared
 *     sync → async → direct-create pipeline-resolution state machine every
 *     renderer previously hand-rolled (`tryResolve*Pipeline`). Returns the
 *     pipeline when cached, kicks off async creation and returns `null`
 *     when not (caller skips the variant draw for a frame).
 *   - {@link WebGPUDerivedCommand.deriveCommand} — command-level clone +
 *     override stamping for consumers that attach the variant command on
 *     `derivedCommands.*` for the dispatcher.
 *
 * # Centrally-enforced invariants
 *
 *   - **MSAA bake** — scene-FB variants (LOG_DEPTH, DEPTH_ONLY) bake
 *     `multisample.count` from `options.sceneFBSampleCount` (pass
 *     `context._msaaSamples`); a count-1 pipeline in the MSAA scene pass
 *     kills the whole pass (the Batch-228 Cloud bug class). Off-scene-FB
 *     variants (PICK, VELOCITY) DROP multisample entirely — the pick FBO
 *     and the rg16float velocity texture are always single-sample.
 *   - **Scene-FB target shape** — scene-FB variants re-stamp their color
 *     targets through `makeSceneFBTargets` so the variant always matches
 *     the CURRENT scene-FB attachment shape (MRT slot-1 placeholder),
 *     even if the base descriptor predates an MRT-mode flip.
 *   - **Pick target shape** — PICK variants keep ONLY slot 0 with blend
 *     stripped (pick colors must reach the FBO byte-exact) because the
 *     pick render pass has exactly one color attachment.
 *
 * # Variant-keyed cache names
 *
 * Derived descriptors are named `${base.name}::${kind}` (plus entry-point
 * markers when an entry point is swapped). The central pipeline cache keys
 * on `descriptor.name` + state fields but NOT on shader-module identity, so
 * the base name MUST uniquely identify the shader source variant — the
 * established convention of embedding the defines bitmask hex in the name
 * (`defines=0x..`) satisfies this; keep it for every adopter.
 *
 * # Variant kinds
 *
 *   - {@link DerivedCommandType.PICK} — slot-0-only blend-stripped target,
 *     depth write forced on (configurable), multisample dropped. Supports
 *     both pick styles: same-module fragment-entry swap (the C-R9
 *     `fragmentPickMain` pattern) and whole-module swap (billboard's
 *     dedicated pick shader source).
 *   - {@link DerivedCommandType.VELOCITY} — single rg16float target,
 *     read-only depth (shares scene depth), optional appended vertex-buffer
 *     layouts for the one-frame-lagged previous-instance mirror (the
 *     Batch 143 motion-vector pattern).
 *   - {@link DerivedCommandType.LOG_DEPTH} — same scene-FB pass shape;
 *     swaps to the `LOG_DEPTH`-define shader module (callers preprocess via
 *     the module cache — see WebGPULogDepth.ts for gating) and/or swaps
 *     entry points. The NEW-COLLECTIONS-LOG-DEPTH epic consumes this kind.
 *   - {@link DerivedCommandType.DEPTH_ONLY} — writeMask 0 on every color
 *     target (shape preserved for pass-compat), depth write forced on.
 *   - {@link DerivedCommandType.HDR} / {@link DerivedCommandType.SHADOW} —
 *     NOT YET IMPLEMENTED; `deriveDescriptor` throws loudly. Tracked as
 *     follow-ups under NEW-DERIVEDCOMMAND-VARIANT-FACTORY in
 *     migration_doc/DEFERRED_WORK.md.
 *
 * # Adopters
 *
 *   - Billboard PICK (WebGPUBillboardRenderer.js, Batch 248) — replaced the
 *     hand-rolled `buildBillboardPickDescriptor`; the color/velocity/pick
 *     resolution all route through {@link resolveVariantPipeline}.
 *   - Next: the log-depth epic (every collection + globe pipeline), then
 *     incremental absorption of the remaining per-renderer pick/velocity/
 *     depth descriptor surgery (WebGPUPickCommandHelpers'
 *     `buildPickPipelineDescriptor` call sites are the natural candidates).
 *
 * @private
 */

import type {
  WebGPURenderPipelineCache,
  WebGPURenderPipelineDescriptor,
} from "./WebGPURenderPipelineCache.js";
import { makeSceneFBTargets } from "./WebGPUSceneFBTargetHelpers.js";

/** Types of derived command variants */
export enum DerivedCommandType {
  LOG_DEPTH = "logDepth",
  DEPTH_ONLY = "depthOnly",
  PICK = "pick",
  HDR = "hdr",
  SHADOW = "shadow",
  VELOCITY = "velocity",
}

/**
 * Options for {@link WebGPUDerivedCommand.deriveDescriptor}. One bag for
 * all kinds — each field documents which kinds consume it. Unconsumed
 * fields are ignored.
 */
export interface DeriveVariantOptions {
  /**
   * Replace the shader module of BOTH stages (vertex + fragment). The
   * billboard pick pattern: a dedicated pick shader source compiled at the
   * same defines as the color module. Overridden per-stage by
   * {@link vertexModule} / {@link fragmentModule} when both are given.
   */
  module?: GPUShaderModule;
  /** Replace only the vertex stage's module. */
  vertexModule?: GPUShaderModule;
  /** Swap the vertex entry point (e.g. `vertexVelocityMain`). */
  vertexEntryPoint?: string;
  /** Replace only the fragment stage's module. */
  fragmentModule?: GPUShaderModule;
  /** Swap the fragment entry point (e.g. `fragmentPickMain`). */
  fragmentEntryPoint?: string;
  /**
   * Extra discriminator appended to the variant-keyed name. Required when
   * the same (base, kind) pair is derived with different shader modules
   * that aren't already distinguished by the base name (rare — the
   * defines-in-name convention covers the standard cases).
   */
  nameSuffix?: string;
  /**
   * Scene-FB kinds (LOG_DEPTH, DEPTH_ONLY): the MSAA sample count to bake
   * into `multisample.count` — pass `context._msaaSamples`. When omitted
   * the base descriptor's multisample state is inherited unchanged.
   * Ignored by PICK / VELOCITY (their targets are always single-sample).
   */
  sceneFBSampleCount?: number;
  /**
   * PICK: force `depthStencil.depthWriteEnabled = true` on the variant so
   * pick fragments back-clip subsequent pick draws (default `true`,
   * matching WebGPUPickCommandHelpers). Pass `false` to inherit the base
   * descriptor's depth-write state (translucent / stencil-gated renderers).
   */
  forceDepthWriteEnabled?: boolean;
  /**
   * PICK: the pick color-target format — REQUIRED for PICK derivation
   * (NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE). Pass `context.pickPipelineFormat`,
   * the context's sole byte-object-ID attachment authority. Inheriting the
   * base slot-0 format was silently wrong in HDR: the scene target is a
   * float format while the pick FBO stays an 8-bit unorm, so an inherited
   * pick pipeline trips "Attachment state not compatible" and every pick
   * returns undefined.
   */
  pickFormat?: GPUTextureFormat;
  /**
   * VELOCITY: the velocity texture format. Default `"rg16float"` — the
   * scene-FB velocity target format (Batch 143 motion-vector pattern).
   */
  velocityFormat?: GPUTextureFormat;
  /**
   * Vertex-buffer layouts appended after the base descriptor's buffers.
   * The velocity pattern uses this for the previous-instance mirror slot
   * (e.g. billboard's `VELOCITY_PREV_INSTANCE_BUFFER_LAYOUT`).
   */
  extraVertexBufferLayouts?: GPUVertexBufferLayout[];
}

/**
 * Per-(renderer, defines) pipeline slot for {@link resolveVariantPipeline}.
 * Renderers keep these in their own Maps (typically keyed by the defines
 * bitmask) — the entry is the unit of the sync/async resolution dance.
 */
export interface VariantPipelineEntry {
  descriptor: WebGPURenderPipelineDescriptor;
  pipeline: GPURenderPipeline | null;
  pending: boolean;
}

const EMPTY_OPTIONS: DeriveVariantOptions = {};

/**
 * Build the variant-keyed descriptor name. Entry-point swaps are encoded
 * so two variants of the same kind with different entry points never alias
 * in the central cache (which keys on name + state, not module identity).
 */
function deriveVariantName(
  base: WebGPURenderPipelineDescriptor,
  kind: DerivedCommandType,
  options: DeriveVariantOptions,
): string {
  let name = `${base.name}::${kind}`;
  if (
    options.vertexEntryPoint !== undefined &&
    options.vertexEntryPoint !== base.vertex.entryPoint
  ) {
    name += `::vs=${options.vertexEntryPoint}`;
  }
  if (
    options.fragmentEntryPoint !== undefined &&
    options.fragmentEntryPoint !== base.fragment?.entryPoint
  ) {
    name += `::fs=${options.fragmentEntryPoint}`;
  }
  if (options.nameSuffix !== undefined) {
    name += `::${options.nameSuffix}`;
  }
  return name;
}

/** Shared vertex-stage derivation: module/entry swap + appended buffers. */
function deriveVertexStage(
  base: WebGPURenderPipelineDescriptor,
  options: DeriveVariantOptions,
): WebGPURenderPipelineDescriptor["vertex"] {
  const extra = options.extraVertexBufferLayouts;
  const buffers =
    extra !== undefined && extra.length > 0
      ? [...(base.vertex.buffers ?? []), ...extra]
      : base.vertex.buffers;
  return {
    module: options.vertexModule ?? options.module ?? base.vertex.module,
    entryPoint: options.vertexEntryPoint ?? base.vertex.entryPoint,
    buffers,
  };
}

/** Fragment module/entry resolution shared by all fragment-bearing kinds. */
function deriveFragmentModuleEntry(
  base: NonNullable<WebGPURenderPipelineDescriptor["fragment"]>,
  options: DeriveVariantOptions,
): { module: GPUShaderModule; entryPoint: string } {
  return {
    module: options.fragmentModule ?? options.module ?? base.module,
    entryPoint: options.fragmentEntryPoint ?? base.entryPoint,
  };
}

/**
 * Central MSAA-bake rule: when the caller supplies the scene-FB sample
 * count, bake it (count 1 → omit, matching every renderer's convention);
 * otherwise inherit the base descriptor's multisample state verbatim.
 */
function bakeMultisample(
  sceneFBSampleCount: number | undefined,
  baseMultisample: GPUMultisampleState | undefined,
): GPUMultisampleState | undefined {
  if (sceneFBSampleCount !== undefined) {
    return sceneFBSampleCount > 1 ? { count: sceneFBSampleCount } : undefined;
  }
  return baseMultisample;
}

/**
 * Re-stamp a scene-FB pipeline's color targets through the central
 * `makeSceneFBTargets` helper so the variant matches the CURRENT scene-FB
 * attachment shape. Slot 0's format/blend/writeMask are preserved; the MRT
 * slot-1 placeholder (and its emit flag) is regenerated per the current
 * MRT mode.
 */
function restampSceneFBTargets(
  targets: Array<GPUColorTargetState | null>,
): Array<GPUColorTargetState | null> {
  const slot0 = targets.find((t) => t !== null && t !== undefined);
  if (!slot0) {
    return targets;
  }
  const emitsGBuffer = targets.some(
    (t, i) =>
      i > 0 && t !== null && t !== undefined && (t.writeMask ?? 0xf) !== 0,
  );
  return makeSceneFBTargets(slot0.format, {
    blend: slot0.blend,
    writeMask: slot0.writeMask,
    emitsGBuffer,
  });
}

function requireFragment(
  base: WebGPURenderPipelineDescriptor,
  kind: DerivedCommandType,
): NonNullable<WebGPURenderPipelineDescriptor["fragment"]> {
  if (!base.fragment) {
    throw new Error(
      `WebGPUDerivedCommand.deriveDescriptor: base descriptor ` +
        `"${base.name}" has no fragment stage; cannot derive a "${kind}" variant.`,
    );
  }
  return base.fragment;
}

/**
 * PICK: exactly ONE blend-stripped color target stamped with the REQUIRED
 * `options.pickFormat` (`context.pickPipelineFormat` — the pick pass has
 * exactly one attachment and pick colors must land byte-exact), depth write
 * forced on by default, multisample dropped (pick FBO is single-sample).
 */
function derivePickDescriptor(
  base: WebGPURenderPipelineDescriptor,
  options: DeriveVariantOptions,
): WebGPURenderPipelineDescriptor {
  const baseFragment = requireFragment(base, DerivedCommandType.PICK);
  const slot0 = baseFragment.targets.find(
    (t): t is GPUColorTargetState => t !== null && t !== undefined,
  );
  if (!slot0) {
    throw new Error(
      `WebGPUDerivedCommand.deriveDescriptor: base descriptor ` +
        `"${base.name}" has no color target; cannot derive a pick variant.`,
    );
  }
  if (options.pickFormat === undefined) {
    // NEW-WEBGPU-HDR-PICK-FORMAT-CLOSURE — the pick target format must be
    // stamped explicitly from `context.pickPipelineFormat`. Silently
    // inheriting the base slot-0 (scene) format produced HDR pick pipelines
    // targeting a float format against the 8-bit unorm pick attachment.
    throw new Error(
      `WebGPUDerivedCommand.deriveDescriptor: PICK derivation for ` +
        `"${base.name}" requires options.pickFormat ` +
        `(pass context.pickPipelineFormat).`,
    );
  }
  const { blend: _blend, ...slot0NoBlend } = slot0;
  void _blend;
  const pickTarget: GPUColorTargetState = {
    ...slot0NoBlend,
    format: options.pickFormat,
  };

  const forceDepthWriteEnabled = options.forceDepthWriteEnabled ?? true;
  const depthStencil: GPUDepthStencilState | undefined = base.depthStencil
    ? {
        ...base.depthStencil,
        depthWriteEnabled: forceDepthWriteEnabled
          ? true
          : base.depthStencil.depthWriteEnabled,
      }
    : undefined;

  return {
    name: deriveVariantName(base, DerivedCommandType.PICK, options),
    layout: base.layout,
    vertex: deriveVertexStage(base, options),
    fragment: {
      ...deriveFragmentModuleEntry(baseFragment, options),
      targets: [pickTarget],
    },
    primitive: base.primitive,
    depthStencil,
    multisample: undefined,
  };
}

/**
 * VELOCITY: single rg16float target, read-only depth sharing the scene
 * depth (fragments behind opaque geometry emit no velocity), optional
 * appended previous-instance vertex-buffer layouts, single-sample.
 */
function deriveVelocityDescriptor(
  base: WebGPURenderPipelineDescriptor,
  options: DeriveVariantOptions,
): WebGPURenderPipelineDescriptor {
  const baseFragment = requireFragment(base, DerivedCommandType.VELOCITY);
  const depthStencil: GPUDepthStencilState | undefined = base.depthStencil
    ? {
        format: base.depthStencil.format,
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      }
    : undefined;
  return {
    name: deriveVariantName(base, DerivedCommandType.VELOCITY, options),
    layout: base.layout,
    vertex: deriveVertexStage(base, options),
    fragment: {
      ...deriveFragmentModuleEntry(baseFragment, options),
      targets: [{ format: options.velocityFormat ?? "rg16float" }],
    },
    primitive: base.primitive,
    depthStencil,
    multisample: undefined,
  };
}

/**
 * LOG_DEPTH: same scene-FB pass shape — target shape re-stamped per the
 * current MRT mode, MSAA baked from {@link DeriveVariantOptions.sceneFBSampleCount}.
 * The actual depth transformation comes from the swapped shader module
 * (compiled with the `LOG_DEPTH` define) and/or swapped entry points.
 */
function deriveLogDepthDescriptor(
  base: WebGPURenderPipelineDescriptor,
  options: DeriveVariantOptions,
): WebGPURenderPipelineDescriptor {
  const baseFragment = requireFragment(base, DerivedCommandType.LOG_DEPTH);
  return {
    name: deriveVariantName(base, DerivedCommandType.LOG_DEPTH, options),
    layout: base.layout,
    vertex: deriveVertexStage(base, options),
    fragment: {
      ...deriveFragmentModuleEntry(baseFragment, options),
      targets: restampSceneFBTargets(baseFragment.targets),
    },
    primitive: base.primitive,
    depthStencil: base.depthStencil,
    multisample: bakeMultisample(options.sceneFBSampleCount, base.multisample),
  };
}

/**
 * DEPTH_ONLY: every color target's writeMask zeroed (target COUNT and
 * formats preserved so the pipeline stays pass-compatible), blend
 * stripped, depth write forced on.
 */
function deriveDepthOnlyDescriptor(
  base: WebGPURenderPipelineDescriptor,
  options: DeriveVariantOptions,
): WebGPURenderPipelineDescriptor {
  const baseFragment = base.fragment;
  const depthStencil: GPUDepthStencilState | undefined = base.depthStencil
    ? { ...base.depthStencil, depthWriteEnabled: true }
    : { format: "depth24plus", depthWriteEnabled: true };
  return {
    name: deriveVariantName(base, DerivedCommandType.DEPTH_ONLY, options),
    layout: base.layout,
    vertex: deriveVertexStage(base, options),
    fragment: baseFragment
      ? {
          ...deriveFragmentModuleEntry(baseFragment, options),
          targets: baseFragment.targets.map((t) =>
            t === null || t === undefined
              ? t
              : { format: t.format, writeMask: 0 },
          ),
        }
      : undefined,
    primitive: base.primitive,
    depthStencil,
    multisample: bakeMultisample(options.sceneFBSampleCount, base.multisample),
  };
}

/**
 * Convert a cache-friendly descriptor into the raw WebGPU descriptor shape
 * for the direct-create fallback path (no central cache available).
 */
function variantDescriptorToGPU(
  d: WebGPURenderPipelineDescriptor,
): GPURenderPipelineDescriptor {
  const result: GPURenderPipelineDescriptor = {
    label: d.name,
    layout: d.layout ?? "auto",
    vertex: {
      module: d.vertex.module,
      entryPoint: d.vertex.entryPoint,
      buffers: d.vertex.buffers,
    },
    primitive: d.primitive,
    depthStencil: d.depthStencil,
    multisample: d.multisample,
  };
  if (d.fragment) {
    result.fragment = {
      module: d.fragment.module,
      entryPoint: d.fragment.entryPoint,
      targets: d.fragment.targets,
    };
  }
  return result;
}

export class WebGPUDerivedCommand {
  /**
   * Derive a variant pipeline descriptor from a base descriptor. Pure —
   * the base descriptor is never mutated; the result is safe to hold in a
   * renderer's long-lived entry Map and feed to
   * {@link resolveVariantPipeline}.
   *
   * @param base The base (color) pipeline descriptor.
   * @param kind The variant kind to derive.
   * @param options See {@link DeriveVariantOptions}.
   * @returns A new variant-keyed descriptor.
   * @throws For kinds that are not implemented yet (HDR, SHADOW) or when
   *   the base descriptor is missing a stage the kind requires.
   */
  static deriveDescriptor(
    base: WebGPURenderPipelineDescriptor,
    kind: DerivedCommandType,
    options?: DeriveVariantOptions,
  ): WebGPURenderPipelineDescriptor {
    const opts = options ?? EMPTY_OPTIONS;
    switch (kind) {
      case DerivedCommandType.PICK:
        return derivePickDescriptor(base, opts);
      case DerivedCommandType.VELOCITY:
        return deriveVelocityDescriptor(base, opts);
      case DerivedCommandType.LOG_DEPTH:
        return deriveLogDepthDescriptor(base, opts);
      case DerivedCommandType.DEPTH_ONLY:
        return deriveDepthOnlyDescriptor(base, opts);
      default:
        throw new Error(
          `WebGPUDerivedCommand.deriveDescriptor: variant kind "${kind}" is ` +
            `not implemented yet — tracked as a follow-up under ` +
            `NEW-DERIVEDCOMMAND-VARIANT-FACTORY in migration_doc/DEFERRED_WORK.md.`,
        );
    }
  }

  /**
   * Resolve a variant pipeline through the central pipeline cache. Returns
   * the existing GPU pipeline if cached; otherwise kicks off async creation
   * and returns `null` so the caller skips the variant draw this frame (a
   * frame later it's ready). Falls back to direct synchronous creation when
   * `pipelineCache` is null (test harnesses / pre-cache contexts).
   *
   * Generalizes the per-renderer `tryResolve*Pipeline` helpers (Batch 73
   * pattern) — pass the renderer's cached {@link VariantPipelineEntry}.
   */
  static resolveVariantPipeline(
    device: GPUDevice,
    pipelineCache: WebGPURenderPipelineCache | null | undefined,
    entry: VariantPipelineEntry,
  ): GPURenderPipeline | null {
    if (entry.pipeline) {
      return entry.pipeline;
    }
    if (pipelineCache) {
      const sync = pipelineCache.getPipelineSync(entry.descriptor);
      if (sync) {
        entry.pipeline = sync;
        entry.pending = false;
        return sync;
      }
      if (!entry.pending) {
        entry.pending = true;
        pipelineCache
          .getPipeline(entry.descriptor)
          .then((p) => {
            entry.pipeline = p;
            entry.pending = false;
          })
          .catch(() => {
            // The cache already logged the creation failure with the
            // descriptor name; clearing `pending` lets a corrected
            // descriptor (e.g. after a format-generation bump) retry.
            entry.pending = false;
          });
      }
      return null;
    }
    entry.pipeline = device.createRenderPipeline(
      variantDescriptorToGPU(entry.descriptor),
    );
    entry.pending = false;
    return entry.pipeline;
  }

  /**
   * Command-level variant derivation: clone the base command (via its own
   * `clone()` when present, shallow copy otherwise) and stamp overrides
   * (typically `{ pipeline }` plus pass/flag fields). The clone is what
   * consumers attach on `derivedCommands.*` for `selectCommandVariant`.
   *
   * The base command is never mutated.
   */
  static deriveCommand(
    baseCommand: CesiumAnyDrawCommand,
    overrides?: Record<string, unknown>,
  ): CesiumAnyDrawCommand {
    const derived =
      typeof baseCommand.clone === "function"
        ? baseCommand.clone()
        : Object.assign({}, baseCommand);
    if (overrides) {
      Object.assign(derived, overrides);
    }
    return derived;
  }
}
