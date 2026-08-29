/// <reference types="@webgpu/types" />
/**
 * WebGL `RenderState` ↔ WebGPU `PipelineVariant` + per-encoder dynamic state translator.
 *
 * The WebGL renderer reads `command.renderState` and maps it to a handful of
 * gl calls (polygonOffset, stencilRef, blendConstant, viewport, scissor).
 * WebGPU splits that same information across two places:
 *
 *  1. **Pipeline-baked state** (recreated via `device.createRenderPipeline`
 *     when any field changes) — cullMode, depthCompare, depthWrite, blend,
 *     stencil operations, colorWriteMask, depthBias.
 *  2. **Per-encoder dynamic state** (called on the `GPURenderPassEncoder`
 *     per draw, shares pipelines) — stencilReference, blendConstant,
 *     viewport, scissorRect.
 *
 * This module provides the two translators that feature renderers + the
 * `WebGPUDrawCommand.execute()` path consume.
 *
 * - {@link renderStateToPipelineVariant} packs WebGL `renderState` into a
 *   {@link PipelineVariant} so {@link WebGPURenderPipelineCache} can cache
 *   one pipeline per distinct state.
 * - {@link applyPerEncoderState} issues the four per-encoder calls
 *   (`setStencilReference`, `setBlendConstant`, `setViewport`,
 *   `setScissorRect`) directly on a `GPURenderPassEncoder`.
 *
 * Fix sketch: **C-R1** of the Renderer-Deep principal-engineer review.
 *
 * @private
 */

import type { PipelineVariant } from "./WebGPURenderPipelineCache.js";

/**
 * WebGL `renderState` shape — intentionally narrow; only the fields this
 * module reads are declared. Additional fields (`lineWidth`, `frontFace`,
 * etc.) that the WebGPU pipeline already handles through other paths are
 * omitted so the interface stays a compile-time contract for the fields
 * that actually flow through this translator.
 */
export interface CesiumRenderStateLike {
  cull?: { enabled?: boolean; face?: number };
  depthTest?: { enabled?: boolean; func?: number };
  depthMask?: boolean;
  colorMask?: {
    red?: boolean;
    green?: boolean;
    blue?: boolean;
    alpha?: boolean;
  };
  polygonOffset?: {
    enabled?: boolean;
    factor?: number;
    units?: number;
  };
  blending?: {
    enabled?: boolean;
    color?: { red?: number; green?: number; blue?: number; alpha?: number };
    // GL constants — kept as numbers so we avoid importing WebGL2RenderingContext here
    equationRgb?: number;
    equationAlpha?: number;
    functionSourceRgb?: number;
    functionSourceAlpha?: number;
    functionDestinationRgb?: number;
    functionDestinationAlpha?: number;
  };
  stencilTest?: {
    enabled?: boolean;
    reference?: number;
    mask?: number;
    frontFunction?: number;
    backFunction?: number;
    frontOperation?: { fail?: number; zFail?: number; zPass?: number };
    backOperation?: { fail?: number; zFail?: number; zPass?: number };
  };
  stencilMask?: number;
  viewport?: { x: number; y: number; width: number; height: number };
  scissorTest?: {
    enabled?: boolean;
    rectangle?: { x: number; y: number; width: number; height: number };
  };
}

// ── GL → WebGPU enum maps ──────────────────────────────────────────────

// WebGL constants (not imported to keep this module free of a hard runtime
// dep on the WebGL2 context). Values match the spec:
//  - CW = 0x0900, CCW = 0x0901
//  - FRONT = 0x0404, BACK = 0x0405, FRONT_AND_BACK = 0x0408
//  - NEVER = 0x0200, LESS = 0x0201, EQUAL = 0x0202, LEQUAL = 0x0203,
//    GREATER = 0x0204, NOTEQUAL = 0x0205, GEQUAL = 0x0206, ALWAYS = 0x0207
//  - ZERO = 0, ONE = 1, SRC_COLOR = 0x0300, ONE_MINUS_SRC_COLOR = 0x0301,
//    SRC_ALPHA = 0x0302, ONE_MINUS_SRC_ALPHA = 0x0303,
//    DST_ALPHA = 0x0304, ONE_MINUS_DST_ALPHA = 0x0305,
//    DST_COLOR = 0x0306, ONE_MINUS_DST_COLOR = 0x0307,
//    SRC_ALPHA_SATURATE = 0x0308,
//    CONSTANT_COLOR = 0x8001, ONE_MINUS_CONSTANT_COLOR = 0x8002,
//    CONSTANT_ALPHA = 0x8003, ONE_MINUS_CONSTANT_ALPHA = 0x8004
//  - FUNC_ADD = 0x8006, FUNC_SUBTRACT = 0x800A,
//    FUNC_REVERSE_SUBTRACT = 0x800B, MIN = 0x8007, MAX = 0x8008
//  - KEEP = 0x1E00, REPLACE = 0x1E01, INCR = 0x1E02, DECR = 0x1E03,
//    INVERT = 0x150A, INCR_WRAP = 0x8507, DECR_WRAP = 0x8508

function glCompareToGPU(
  func: number | undefined,
): GPUCompareFunction | undefined {
  switch (func) {
    case 0x0200:
      return "never";
    case 0x0201:
      return "less";
    case 0x0202:
      return "equal";
    case 0x0203:
      return "less-equal";
    case 0x0204:
      return "greater";
    case 0x0205:
      return "not-equal";
    case 0x0206:
      return "greater-equal";
    case 0x0207:
      return "always";
    default:
      return undefined;
  }
}

function glBlendFactorToGPU(
  factor: number | undefined,
): GPUBlendFactor | undefined {
  switch (factor) {
    case 0:
      return "zero";
    case 1:
      return "one";
    case 0x0300:
      return "src";
    case 0x0301:
      return "one-minus-src";
    case 0x0302:
      return "src-alpha";
    case 0x0303:
      return "one-minus-src-alpha";
    case 0x0304:
      return "dst-alpha";
    case 0x0305:
      return "one-minus-dst-alpha";
    case 0x0306:
      return "dst";
    case 0x0307:
      return "one-minus-dst";
    case 0x0308:
      return "src-alpha-saturated";
    case 0x8001:
      return "constant";
    case 0x8002:
      return "one-minus-constant";
    // GL CONSTANT_ALPHA (0x8003) / ONE_MINUS_CONSTANT_ALPHA (0x8004) have
    // no WebGPU analogue — WebGPU only exposes `constant` / `one-minus-constant`
    // (RGBA). Fall back to `constant` with the alpha component honored via
    // `setBlendConstant()`; this matches the visual when the alpha is the
    // only significant channel, which is how CesiumJS actually uses them.
    case 0x8003:
      return "constant";
    case 0x8004:
      return "one-minus-constant";
    default:
      return undefined;
  }
}

function glBlendEquationToGPU(
  eq: number | undefined,
): GPUBlendOperation | undefined {
  switch (eq) {
    case 0x8006:
      return "add";
    case 0x800a:
      return "subtract";
    case 0x800b:
      return "reverse-subtract";
    case 0x8007:
      return "min";
    case 0x8008:
      return "max";
    default:
      return undefined;
  }
}

function glStencilOpToGPU(
  op: number | undefined,
): GPUStencilOperation | undefined {
  switch (op) {
    case 0:
      return "zero";
    case 0x1e00:
      return "keep";
    case 0x1e01:
      return "replace";
    case 0x1e02:
      return "increment-clamp";
    case 0x1e03:
      return "decrement-clamp";
    case 0x150a:
      return "invert";
    case 0x8507:
      return "increment-wrap";
    case 0x8508:
      return "decrement-wrap";
    default:
      return undefined;
  }
}

function glCullFaceToGPU(
  enabled: boolean | undefined,
  face: number | undefined,
): GPUCullMode {
  if (!enabled) {
    return "none";
  }
  switch (face) {
    case 0x0404:
      return "front";
    case 0x0405:
      return "back";
    case 0x0408:
      // FRONT_AND_BACK — no WebGPU equivalent. Caller should detect this
      // case and skip the draw rather than relying on culling; we return
      // "back" so the pipeline still compiles.
      return "back";
    default:
      return "back";
  }
}

function colorMaskToGPUWriteMask(
  mask: CesiumRenderStateLike["colorMask"] | undefined,
): GPUColorWriteFlags {
  if (!mask) {
    return 0xf;
  }
  let bits: GPUColorWriteFlags = 0;
  if (mask.red) bits |= 0x1;
  if (mask.green) bits |= 0x2;
  if (mask.blue) bits |= 0x4;
  if (mask.alpha) bits |= 0x8;
  return bits;
}

/**
 * Translate a WebGL `renderState.blending` descriptor into the equivalent
 * {@link GPUBlendState}, or `undefined` when that state does not blend.
 *
 * A pipeline that bakes its color-target blend from a boolean translucency
 * flag can read the blend WebGL would actually have applied instead, which is
 * not always the same answer. `Appearance.getRenderState` forces alpha
 * blending on for a translucent appearance but never turns it off for an
 * opaque one, so an appearance constructed with `translucent: true` keeps the
 * alpha blend its constructor put on `Appearance#renderState` even when the
 * material it carries reports itself opaque.
 */
export function renderStateToBlendState(
  renderState: CesiumRenderStateLike | undefined,
): GPUBlendState | undefined {
  const blending = renderState?.blending;
  if (!blending?.enabled) {
    return undefined;
  }
  return {
    color: {
      srcFactor: glBlendFactorToGPU(blending.functionSourceRgb) ?? "one",
      dstFactor: glBlendFactorToGPU(blending.functionDestinationRgb) ?? "zero",
      operation: glBlendEquationToGPU(blending.equationRgb) ?? "add",
    },
    alpha: {
      srcFactor: glBlendFactorToGPU(blending.functionSourceAlpha) ?? "one",
      dstFactor:
        glBlendFactorToGPU(blending.functionDestinationAlpha) ?? "zero",
      operation: glBlendEquationToGPU(blending.equationAlpha) ?? "add",
    },
  };
}

/**
 * Map WebGL `renderState` to a {@link PipelineVariant} suitable for
 * {@link WebGPURenderPipelineCache.buildPipeline}. The returned variant
 * carries only fields that actually differ from the underlying pipeline
 * descriptor — callers can use the `{...variant, ...overrides}` pattern.
 *
 * Does NOT populate per-encoder fields (blendConstant intentionally
 * passes through even though it's per-encoder, because the variant
 * carries it for the `WebGPUDrawCommand.execute()` consumer).
 */
export function renderStateToPipelineVariant(
  renderState: CesiumRenderStateLike | undefined,
): PipelineVariant | undefined {
  if (!renderState) {
    return undefined;
  }
  const variant: PipelineVariant = {};

  if (renderState.cull) {
    variant.cullMode = glCullFaceToGPU(
      renderState.cull.enabled,
      renderState.cull.face,
    );
  }

  if (renderState.depthTest) {
    variant.depthTest = renderState.depthTest.enabled ?? true;
    const cmp = glCompareToGPU(renderState.depthTest.func);
    if (cmp !== undefined) {
      variant.depthCompare = cmp;
    }
  }

  if (typeof renderState.depthMask === "boolean") {
    variant.depthWrite = renderState.depthMask;
  }

  if (renderState.colorMask) {
    variant.colorWriteMask = colorMaskToGPUWriteMask(renderState.colorMask);
  }

  if (renderState.polygonOffset?.enabled) {
    // WebGL polygonOffset(factor, units):
    //   depthOffset = factor * DZ + units * r
    // WebGPU maps directly: factor → depthBiasSlopeScale, units → depthBias.
    // `depthBiasClamp` has no WebGL analogue; leave 0.
    variant.depthBiasSlopeScale = renderState.polygonOffset.factor ?? 0;
    variant.depthBias = renderState.polygonOffset.units ?? 0;
  }

  const blending = renderState.blending;
  const blend = renderStateToBlendState(renderState);
  if (blend) {
    variant.blend = blend;
    if (blending?.color) {
      variant.blendConstant = {
        r: blending.color.red ?? 0,
        g: blending.color.green ?? 0,
        b: blending.color.blue ?? 0,
        a: blending.color.alpha ?? 0,
      };
    }
  }

  if (renderState.stencilTest?.enabled) {
    const st = renderState.stencilTest;
    if (st.frontFunction !== undefined || st.frontOperation) {
      variant.stencilFront = {
        compare: glCompareToGPU(st.frontFunction) ?? "always",
        failOp: glStencilOpToGPU(st.frontOperation?.fail) ?? "keep",
        depthFailOp: glStencilOpToGPU(st.frontOperation?.zFail) ?? "keep",
        passOp: glStencilOpToGPU(st.frontOperation?.zPass) ?? "keep",
      };
    }
    if (st.backFunction !== undefined || st.backOperation) {
      variant.stencilBack = {
        compare: glCompareToGPU(st.backFunction) ?? "always",
        failOp: glStencilOpToGPU(st.backOperation?.fail) ?? "keep",
        depthFailOp: glStencilOpToGPU(st.backOperation?.zFail) ?? "keep",
        passOp: glStencilOpToGPU(st.backOperation?.zPass) ?? "keep",
      };
    }
    if (typeof st.mask === "number") {
      variant.stencilReadMask = st.mask & 0xff;
    }
  }
  if (typeof renderState.stencilMask === "number") {
    variant.stencilWriteMask = renderState.stencilMask & 0xff;
  }

  return variant;
}

/**
 * Apply the per-encoder dynamic state (`setStencilReference`,
 * `setBlendConstant`, `setViewport`, `setScissorRect`) that WebGPU
 * requires to be issued on the pass encoder each draw.
 *
 * The caller passes the combined `renderState` from the command (which
 * may be a WebGL-style object) plus an optional pre-computed variant
 * that already captured the pipeline-baked fields (so we don't repeat
 * the translation here).
 *
 * Viewport and scissor are only applied when the renderState carries
 * explicit rectangles — the encoder default set when the pass was
 * opened (`context.beginRenderPass` / `resumeDefaultRenderPass`)
 * otherwise remains in effect.
 */
export function applyPerEncoderState(
  passEncoder: GPURenderPassEncoder,
  renderState: CesiumRenderStateLike | undefined,
  variant?: PipelineVariant,
): void {
  if (!renderState && !variant) {
    return;
  }

  const stencilRef = renderState?.stencilTest?.reference;
  if (typeof stencilRef === "number" && stencilRef !== 0) {
    passEncoder.setStencilReference(stencilRef);
  }

  const bc = variant?.blendConstant;
  if (bc) {
    passEncoder.setBlendConstant(bc);
  } else if (renderState?.blending?.enabled && renderState.blending.color) {
    const c = renderState.blending.color;
    passEncoder.setBlendConstant({
      r: c.red ?? 0,
      g: c.green ?? 0,
      b: c.blue ?? 0,
      a: c.alpha ?? 0,
    });
  }

  const vp = renderState?.viewport;
  if (vp) {
    // WebGL viewport is (x, y, width, height) with min/max depth fixed to
    // (0, 1). WebGPU requires all six args; clamp height to >= 1 so the
    // `viewport` call doesn't throw on degenerate rectangles that the
    // WebGL driver happily accepted.
    passEncoder.setViewport(
      vp.x,
      vp.y,
      Math.max(1, vp.width),
      Math.max(1, vp.height),
      0,
      1,
    );
  }

  const scissor = renderState?.scissorTest;
  if (scissor?.enabled && scissor.rectangle) {
    const r = scissor.rectangle;
    passEncoder.setScissorRect(
      Math.max(0, r.x),
      Math.max(0, r.y),
      Math.max(1, r.width),
      Math.max(1, r.height),
    );
  }
}
