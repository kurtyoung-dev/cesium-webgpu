/**
 * WebGL pipeline state method stubs for the WebGPU compatibility layer.
 * Covers clear operations, viewport/scissor, enable/disable capabilities,
 * blend functions, depth functions, stencil operations, face culling,
 * and color mask. All state is tracked on the `WebGLStubState` object
 * and consumed when WebGPU pipelines or render passes are created.
 *
 * @see WebGLCompatibilityStub (nexus)
 * @module WebGLStubPipelineState
 */

/// <reference types="@webgpu/types" />

import Color from "../../../Core/Color.js";
import type { WebGLStubState, LogUsageFn } from "./WebGLStubTypes.js";

// WebGL capability constants
const GL_DEPTH_TEST = 0x0b71;
const GL_BLEND = 0x0be2;
const GL_CULL_FACE = 0x0b44;
const GL_SCISSOR_TEST = 0x0c11;
const GL_STENCIL_TEST = 0x0b90;

// WebGL cull face mode constants
const GL_FRONT = 0x0404;
const GL_BACK = 0x0405;

// WebGL front face constants
const GL_CW = 0x0900;

// WebGL stencil-op constants → GPUStencilOperation strings
const GL_KEEP = 0x1e00;
const GL_REPLACE = 0x1e01;
const GL_INCR = 0x1e02;
const GL_DECR = 0x1e03;
const GL_INVERT = 0x150a;
const GL_INCR_WRAP = 0x8507;
const GL_DECR_WRAP = 0x8508;

function webglToWebGPUStencilOp(glOp: number): GPUStencilOperation {
  switch (glOp) {
    case GL_KEEP:
      return "keep";
    case 0:
      return "zero";
    case GL_REPLACE:
      return "replace";
    case GL_INCR:
      return "increment-clamp";
    case GL_INCR_WRAP:
      return "increment-wrap";
    case GL_DECR:
      return "decrement-clamp";
    case GL_DECR_WRAP:
      return "decrement-wrap";
    case GL_INVERT:
      return "invert";
    default:
      return "keep";
  }
}

/**
 * WebGL pipeline state constants.
 */
export const PIPELINE_STATE_CONSTANTS = Object.freeze({
  // Clear bit masks
  COLOR_BUFFER_BIT: 0x4000,
  DEPTH_BUFFER_BIT: 0x0100,
  STENCIL_BUFFER_BIT: 0x0400,

  // Capability constants
  DEPTH_TEST: GL_DEPTH_TEST,
  BLEND: GL_BLEND,
  CULL_FACE: GL_CULL_FACE,
  SCISSOR_TEST: GL_SCISSOR_TEST,
  STENCIL_TEST: GL_STENCIL_TEST,
  SAMPLE_ALPHA_TO_COVERAGE: 0x809e,
});

/**
 * Creates pipeline state stub methods (clear, viewport, scissor,
 * enable/disable, blend, depth, stencil, culling, color mask).
 *
 * @param state - Shared mutable state from WebGPUContext
 * @param logUsage - Debug logging function
 * @returns Object containing all pipeline state stub methods
 */
export function createPipelineStateStubs(
  state: WebGLStubState,
  logUsage: LogUsageFn,
) {
  return {
    // ==== Clear methods (state tracked for render pass loadOp) ====

    clear: () =>
      logUsage("clear", 'Use loadOp: "clear" in GPURenderPassDescriptor'),
    clearColor: (r?: number, g?: number, b?: number, a?: number) => {
      if (r !== undefined) state.clearColor = new Color(r, g, b, a);
    },
    clearDepth: (depth?: number) => {
      if (depth !== undefined) state.clearDepth = depth;
    },
    clearStencil: (s?: number) => {
      if (s !== undefined) state.clearStencil = s;
    },

    // ==== Viewport and scissor ====

    viewport: (x: number, y: number, width: number, height: number) => {
      state.setViewport(x, y, width, height);
    },
    scissor: (x: number, y: number, width: number, height: number) => {
      state.setScissorRect(x, y, width, height);
    },

    // ==== Enable / disable (state tracked for pipeline creation) ====

    enable: (cap: number) => {
      switch (cap) {
        case GL_DEPTH_TEST:
          state.depthTestEnabled = true;
          break;
        case GL_BLEND:
          state.blendEnabled = true;
          break;
        case GL_CULL_FACE:
          state.cullFaceEnabled = true;
          break;
        case GL_SCISSOR_TEST:
          state.scissorTest = true;
          break;
        case GL_STENCIL_TEST:
          state.stencilTestEnabled = true;
          break;
      }
    },
    disable: (cap: number) => {
      switch (cap) {
        case GL_DEPTH_TEST:
          state.depthTestEnabled = false;
          break;
        case GL_BLEND:
          state.blendEnabled = false;
          break;
        case GL_CULL_FACE:
          state.cullFaceEnabled = false;
          break;
        case GL_SCISSOR_TEST:
          state.scissorTest = false;
          state.disableScissorTest();
          break;
        case GL_STENCIL_TEST:
          state.stencilTestEnabled = false;
          break;
      }
    },

    // ==== Blend functions (state tracked for pipeline creation) ====

    blendFunc: (sfactor: number, dfactor: number) => {
      state.blendSrc = state.webglToWebGPUBlendFactor(sfactor);
      state.blendDst = state.webglToWebGPUBlendFactor(dfactor);
      state.blendSrcAlpha = state.blendSrc;
      state.blendDstAlpha = state.blendDst;
    },
    blendFuncSeparate: (
      srcRGB: number,
      dstRGB: number,
      srcAlpha: number,
      dstAlpha: number,
    ) => {
      state.blendSrc = state.webglToWebGPUBlendFactor(srcRGB);
      state.blendDst = state.webglToWebGPUBlendFactor(dstRGB);
      state.blendSrcAlpha = state.webglToWebGPUBlendFactor(srcAlpha);
      state.blendDstAlpha = state.webglToWebGPUBlendFactor(dstAlpha);
    },
    blendEquation: (mode: number) => {
      state.blendOp = state.webglToWebGPUBlendOp(mode);
      state.blendOpAlpha = state.blendOp;
    },
    blendEquationSeparate: (modeRGB: number, modeAlpha: number) => {
      state.blendOp = state.webglToWebGPUBlendOp(modeRGB);
      state.blendOpAlpha = state.webglToWebGPUBlendOp(modeAlpha);
    },
    blendColor: (r: number, g: number, b: number, a: number) => {
      if (state.currentRenderPassEncoder) {
        state.currentRenderPassEncoder.setBlendConstant([r, g, b, a]);
      }
    },

    // ==== Depth functions (state tracked for pipeline creation) ====

    depthFunc: (func: number) => {
      state.depthCompare = state.webglToWebGPUCompareFunction(func);
    },
    depthMask: (flag: boolean) => {
      state.depthWriteEnabled = flag;
    },
    depthRange: () => {
      // WebGPU always uses 0–1 depth range
    },

    // ==== Stencil functions (state tracked for pipeline creation) ====
    //
    // WebGPU's depth-stencil state is baked into pipelines, so the stub
    // can't apply stencil immediately — it only records the values. The
    // pipeline-creation paths in WebGPUContext / WebGPURenderPipelineCache
    // can read these fields when the corresponding `stencilTestEnabled`
    // flag is set on the stub state.

    stencilFunc: (func: number, ref: number, mask: number) => {
      const compare = state.webglToWebGPUCompareFunction(func);
      state.stencilFrontCompare = compare;
      state.stencilBackCompare = compare;
      state.stencilReference = ref;
      state.stencilReadMask = mask;
      // The render pass needs the reference value imperatively when one is
      // open — apply it eagerly so the GPU side picks it up next draw.
      if (state.currentRenderPassEncoder) {
        state.currentRenderPassEncoder.setStencilReference(ref);
      }
    },
    stencilFuncSeparate: (
      face: number,
      func: number,
      ref: number,
      mask: number,
    ) => {
      const compare = state.webglToWebGPUCompareFunction(func);
      // GL_FRONT = 0x0404, GL_BACK = 0x0405, GL_FRONT_AND_BACK = 0x0408
      if (face === 0x0404 || face === 0x0408)
        state.stencilFrontCompare = compare;
      if (face === 0x0405 || face === 0x0408)
        state.stencilBackCompare = compare;
      state.stencilReference = ref;
      state.stencilReadMask = mask;
      if (state.currentRenderPassEncoder) {
        state.currentRenderPassEncoder.setStencilReference(ref);
      }
    },
    stencilMask: (mask: number) => {
      state.stencilWriteMask = mask;
    },
    stencilMaskSeparate: (_face: number, mask: number) => {
      // WebGPU has only one stencil write mask (no front/back split).
      state.stencilWriteMask = mask;
    },
    stencilOp: (fail: number, zfail: number, zpass: number) => {
      state.stencilFailOp = webglToWebGPUStencilOp(fail);
      state.stencilDepthFailOp = webglToWebGPUStencilOp(zfail);
      state.stencilPassOp = webglToWebGPUStencilOp(zpass);
    },
    stencilOpSeparate: (
      _face: number,
      fail: number,
      zfail: number,
      zpass: number,
    ) => {
      // Same single-face limitation as stencilMaskSeparate.
      state.stencilFailOp = webglToWebGPUStencilOp(fail);
      state.stencilDepthFailOp = webglToWebGPUStencilOp(zfail);
      state.stencilPassOp = webglToWebGPUStencilOp(zpass);
    },

    // ==== Culling (state tracked for pipeline creation) ====

    cullFace: (mode: number) => {
      if (mode === GL_FRONT) state.cullMode = "front";
      else if (mode === GL_BACK) state.cullMode = "back";
      else state.cullMode = "none";
    },
    frontFace: (mode: number) => {
      state.frontFace = mode === GL_CW ? "cw" : "ccw";
    },

    // ==== Color mask ====

    colorMask: (r: boolean, g: boolean, b: boolean, a: boolean) => {
      state.colorWriteMask =
        (r ? 0x1 : 0) | (g ? 0x2 : 0) | (b ? 0x4 : 0) | (a ? 0x8 : 0);
    },
  };
}
