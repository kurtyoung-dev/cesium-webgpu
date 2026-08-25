/// <reference types="@webgpu/types" />
/**
 * Central utilities for building WebGPU command and pipeline variants.
 *
 * Renderer commands may expose a
 * `derivedCommands.{picking,depth,shadows,logDepth,hdr}.*` structure that
 * `selectCommandVariant` dispatches. This module owns the reusable construction
 * half of that architecture:
 *
 *   - {@link WebGPUDerivedCommand.deriveDescriptor} performs pure descriptor
 *     derivation without mutating the base descriptor.
 *   - {@link WebGPUDerivedCommand.resolveVariantPipeline} provides the shared
 *     synchronous, asynchronous, or direct-create pipeline-resolution state
 *     machine. A cache miss starts asynchronous creation and returns `null`, so
 *     the caller skips the variant draw for that frame.
 *   - {@link WebGPUDerivedCommand.deriveCommand} clones a command and stamps
 *     overrides for consumers that attach variants to `derivedCommands.*`.
 *
 * # Descriptor invariants
 *
 *   - Scene-framebuffer variants (`LOG_DEPTH`, `DEPTH_ONLY`) bake
 *     `multisample.count` from `options.sceneFBSampleCount`. Offscreen variants
 *     (`PICK`, `VELOCITY`) drop multisampling because their targets are
 *     single-sample. A scene-pipeline sample count that differs from its pass
 *     attachments makes the pipeline incompatible and invalidates the pass.
 *   - Scene-framebuffer variants re-stamp their color targets through
 *     `makeSceneFBTargets` so they match the current attachment shape,
 *     including the MRT slot-1 placeholder, even when the base descriptor
 *     predates an MRT attachment-shape change.
 *   - `PICK` variants keep only color target zero and strip blending so pick
 *     colors reach the single-attachment pick framebuffer byte-exact.
 *
 * # Cache identity
 *
 * Variant names include the base name, kind, and optional suffix or entry-point
 * markers for diagnostics. Cache correctness also includes shader-module and
 * entry-point identity plus structural pipeline state, so readable names are
 * not the sole aliasing barrier.
 *
 * # Variant kinds
 *
 *   - {@link DerivedCommandType.PICK} uses a blend-stripped target, drops
 *     multisampling, and forces depth writes by default. It supports both an
 *     entry-point swap and a whole-module swap.
 *   - {@link DerivedCommandType.VELOCITY} uses a single `rg16float` target,
 *     read-only scene depth, and optional previous-instance vertex layouts.
 *   - {@link DerivedCommandType.LOG_DEPTH} preserves the scene-framebuffer
 *     shape while allowing a module or entry-point swap.
 *   - {@link DerivedCommandType.DEPTH_ONLY} preserves target shape with a zero
 *     write mask and forces depth writes.
 *   - {@link DerivedCommandType.HDR} and {@link DerivedCommandType.SHADOW} are
 *     reserved enum values; `deriveDescriptor` rejects them.
 *
 * Billboard pick is the current descriptor-derivation adopter. Other renderers
 * retain local descriptor derivation.
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
   * Replace the shader module of both stages (vertex + fragment). The
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
   * Extra name and cache-key discriminator for variants that need a readable
   * distinction in diagnostics. Cache identity separately includes
   * shader-module and entry-point identity.
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
   * PICK: the required pick color-target format. Pass
   * `context.pickPipelineFormat`, because an HDR scene target may use a float
   * format while the pick framebuffer uses an 8-bit unorm format. Inheriting
   * the scene format would make the pipeline incompatible with the pick
   * attachment.
   */
  pickFormat?: GPUTextureFormat;
  /**
   * VELOCITY: the velocity texture format. Default `"rg16float"`, the
   * scene-framebuffer velocity target format.
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
 * Build a readable variant descriptor name. Entry-point swaps and an optional
 * suffix remain visible in diagnostics; the cache separately keys module,
 * entry-point, and structural pipeline identity.
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
    // Stamp the format from `context.pickPipelineFormat`. Inheriting the base
    // scene format can pair an HDR float pipeline with the 8-bit unorm pick
    // attachment.
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
   * Pass the renderer's cached {@link VariantPipelineEntry}; the entry is the
   * stable unit of the resolution state machine.
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
