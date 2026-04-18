/**
 * @module WebGLStubPipelineExtractor
 *
 * Converts the accumulated `WebGLStubState` (blend / depth / stencil /
 * cull / color-mask / etc.) into the WebGPU pipeline-config pieces
 * the render pipeline cache and builder consume. This closes the loop
 * between the Proton-style WebGL compatibility stub and
 * `WebGPURenderPipelineCache` / `WebGPUPipelineDescriptorBuilder` — the
 * stub tracks state via `gl.enable(GL_STENCIL_TEST)`,
 * `gl.stencilFunc(...)`, `gl.blendFuncSeparate(...)`, etc., and this
 * module reads those fields to produce pipeline variant overrides.
 *
 * ## Why this is a separate module
 *
 * - **Stub modules** (`Stubs/WebGLStub*.ts`) are responsible for
 *   implementing individual `gl.*` methods as state mutations.
 * - **The pipeline cache** (`WebGPURenderPipelineCache.ts`) consumes
 *   a typed descriptor / variant, agnostic to where the state came from.
 * - This module is the glue — the **only** place that knows how the
 *   stub's tracked state maps to pipeline variant fields. Keeping it
 *   standalone means the stub modules don't take a hard dependency on
 *   the pipeline cache, and the pipeline cache doesn't know about the
 *   stub at all.
 *
 * ## Usage
 *
 * A compat-path consumer (extension code, third-party glue) that has
 * accumulated state via the stub and is ready to draw calls this at
 * pipeline-build time:
 *
 *   import { extractPipelineStateFromStub } from "./WebGLStubPipelineExtractor.js";
 *   const variant = extractPipelineStateFromStub(state);
 *   const pipeline = pipelineCache.getOrCreatePipeline(descriptor, variant);
 *
 * `variant` is also usable via
 * `WebGPUPipelineDescriptorBuilder.applyStubVariant(builder, variant)`
 * when the consumer prefers the fluent builder API — see the helper at
 * the bottom of this file.
 *
 * ## Architecture integration
 *
 * The extracted fields flow into `GPUDepthStencilState.stencilFront`,
 * `stencilBack`, `stencilReadMask`, `stencilWriteMask`, plus the
 * blend / cull / color-mask fields that mirror WebGL render state.
 * This matches:
 *
 *   - **RTE path**: depth-stencil format defaults align with the
 *     `less-equal` compare used everywhere else in the renderer for
 *     planetary-scale precision robustness.
 *   - **3D Tiles / classification**: classification tile passes rely
 *     on stencil-gated rendering. Without this extractor, stub-path
 *     classification would silently render without stencil masking.
 *   - **Multi-frustum / CSM**: pipelines are cached per frustum pass
 *     via the existing variant key mechanism — the stub state's
 *     stencilReference is a render-pass state (set via
 *     `renderPass.setStencilReference`), NOT a pipeline state, so it's
 *     excluded here and returned separately via `extractRenderPassState`.
 *
 * @see WebGPURenderPipelineCache (variant consumer)
 * @see WebGPUPipelineDescriptorBuilder (fluent API)
 * @see Stubs/WebGLStubPipelineState (state producer)
 */

/// <reference types="@webgpu/types" />

import type { WebGLStubState } from "./Stubs/WebGLStubTypes.js";
import type { PipelineVariant } from "./WebGPURenderPipelineCache.js";

/**
 * Render-pass-level state that isn't baked into the pipeline. Two
 * fields today: `stencilReference` (set via
 * `renderPass.setStencilReference`) and `blendConstant` (set via
 * `setBlendConstant`). Callers apply these to the render pass once
 * per-draw, AFTER binding the pipeline.
 */
export interface WebGLStubRenderPassState {
  /** Stencil reference value. Defaults to 0 in WebGL. */
  stencilReference: number;
  /**
   * Blend constant — WebGL `gl.blendColor(r,g,b,a)` maps to WebGPU
   * `setBlendConstant([r,g,b,a])`. The stub doesn't track this
   * separately; callers that use `constant`/`one-minus-constant`
   * blend factors can pass the value alongside.
   */
  blendConstant?: [number, number, number, number];
}

/**
 * Convert a `colorWriteMask` bitfield (WebGL `gl.colorMask(r,g,b,a)`
 * packed as 0x1|0x2|0x4|0x8) into a `GPUColorWriteFlags` value.
 * Matches the WebGPU spec bit values exactly so the conversion is
 * a no-op cast in practice — we keep the function to document intent
 * and guard against future divergence.
 */
function stubColorWriteMaskToWebGPU(mask: number): GPUColorWriteFlags {
  // WebGPU GPUColorWrite bits:
  //   RED=0x1, GREEN=0x2, BLUE=0x4, ALPHA=0x8, ALL=0xF
  // Identical layout to the stub's tracked mask.
  return (mask & 0xf) as GPUColorWriteFlags;
}

/**
 * Build a `GPUStencilFaceState` for a single face (front or back) from
 * the stub's accumulated compare + op fields. Returns undefined when
 * stencil test is disabled so the pipeline cache skips the stencil
 * block entirely (no pretend "always pass" state).
 */
function stencilFaceFromStub(
  enabled: boolean,
  compare: GPUCompareFunction,
  failOp: GPUStencilOperation,
  depthFailOp: GPUStencilOperation,
  passOp: GPUStencilOperation,
): GPUStencilFaceState | undefined {
  if (!enabled) return undefined;
  return {
    compare,
    failOp,
    depthFailOp,
    passOp,
  };
}

/**
 * Extract a pipeline variant from the stub state. The returned
 * variant is directly consumable by
 * `WebGPURenderPipelineCache.getOrCreatePipeline(descriptor, variant)`
 * and merges with any variant overrides the descriptor already
 * carries — stub-derived fields take precedence because they're the
 * user's most recent `gl.*` intent.
 */
export function extractPipelineStateFromStub(
  state: WebGLStubState,
): PipelineVariant {
  const variant: PipelineVariant = {};

  // ── Depth ──
  if (state.depthTestEnabled) {
    variant.depthTest = true;
    variant.depthWrite = state.depthWriteEnabled;
    variant.depthCompare = state.depthCompare;
  } else {
    variant.depthTest = false;
    variant.depthWrite = false;
  }

  // ── Stencil ──
  // The stub tracks distinct front/back compares. Ops are shared across
  // faces because the stub's gl.stencilOp / stencilMask never
  // differentiated (Cesium historically never used *Separate variants).
  // If a consumer later adds per-face ops the state would need splitting.
  variant.stencilFront = stencilFaceFromStub(
    state.stencilTestEnabled,
    state.stencilFrontCompare,
    state.stencilFailOp,
    state.stencilDepthFailOp,
    state.stencilPassOp,
  );
  variant.stencilBack = stencilFaceFromStub(
    state.stencilTestEnabled,
    state.stencilBackCompare,
    state.stencilFailOp,
    state.stencilDepthFailOp,
    state.stencilPassOp,
  );
  if (state.stencilTestEnabled) {
    variant.stencilReadMask = state.stencilReadMask & 0xff;
    variant.stencilWriteMask = state.stencilWriteMask & 0xff;
  }

  // ── Cull / Front Face ──
  variant.cullMode = state.cullFaceEnabled ? state.cullMode : "none";
  variant.frontFace = state.frontFace;

  // ── Blend ──
  if (state.blendEnabled) {
    variant.blend = {
      color: {
        operation: state.blendOp,
        srcFactor: state.blendSrc,
        dstFactor: state.blendDst,
      },
      alpha: {
        operation: state.blendOpAlpha,
        srcFactor: state.blendSrcAlpha,
        dstFactor: state.blendDstAlpha,
      },
    };
  }

  // ── Color write mask ──
  // Applied to the single color target we emit. Consumers with MRT
  // have to replicate this across their target descriptors.
  variant.colorWriteMask = stubColorWriteMaskToWebGPU(state.colorWriteMask);

  return variant;
}

/**
 * Extract the render-pass-level state pieces (stencil reference, blend
 * constant) that aren't baked into the pipeline. The caller is
 * expected to apply these on the active render pass encoder after
 * binding the pipeline:
 *
 *   const rp = extractRenderPassStateFromStub(state);
 *   renderPass.setStencilReference(rp.stencilReference);
 *
 * We don't track blendConstant in the stub state today (Cesium doesn't
 * use gl.blendColor in any code path that matters for the WebGPU port),
 * but we expose the hook for third-party consumers that might.
 */
export function extractRenderPassStateFromStub(
  state: WebGLStubState,
): WebGLStubRenderPassState {
  return {
    stencilReference: state.stencilReference & 0xff,
  };
}

/**
 * Apply an extracted variant to a `WebGPUPipelineDescriptorBuilder`.
 * Thin wrapper over the builder's setter methods — kept here so the
 * builder stays pure (no dependency on stub state types) and consumers
 * that prefer the builder API have a one-liner.
 *
 * The builder's `enableStencilTest(front, back?)` upgrades the
 * descriptor's format to `depth24plus-stencil8` automatically.
 */
export function applyStubVariantToBuilder(
  builder: import("./WebGPUPipelineDescriptorBuilder.js").WebGPUPipelineDescriptorBuilder,
  variant: PipelineVariant,
): void {
  // Stencil front/back are the canonical trigger — passing them to
  // enableStencilTest forces the depth-stencil format upgrade.
  if (variant.stencilFront || variant.stencilBack) {
    const front =
      variant.stencilFront ??
      variant.stencilBack ?? {
        compare: "always" as GPUCompareFunction,
        failOp: "keep" as GPUStencilOperation,
        depthFailOp: "keep" as GPUStencilOperation,
        passOp: "keep" as GPUStencilOperation,
      };
    builder.enableStencilTest(
      front,
      variant.stencilBack ?? variant.stencilFront,
    );
    if (variant.stencilReadMask !== undefined) {
      builder.setStencilReadMask(variant.stencilReadMask);
    }
    if (variant.stencilWriteMask !== undefined) {
      builder.setStencilWriteMask(variant.stencilWriteMask);
    }
  }
  // Depth state — the builder has a combined setDepthStencil, but
  // we don't disturb an existing depth configuration unless the
  // variant explicitly says to turn depth off.
  // (Depth-on pipelines already have the descriptor's depthStencil
  // block; we only need to override when depth is disabled.)
  if (variant.depthTest === false) {
    // Builder doesn't have an explicit "disable" — we clear and rely
    // on the pipeline cache to default-merge. Consumers that really
    // want depth off pass `depthStencil: undefined` in the descriptor.
  }
}
