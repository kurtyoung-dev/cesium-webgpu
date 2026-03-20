/**
 * @module WebGLStubPipelineState
 *
 * WebGL pipeline state method stubs for the WebGPU compatibility layer.
 * Covers clear operations, viewport/scissor, enable/disable capabilities,
 * blend functions, depth functions, stencil operations, face culling,
 * and color mask. All state is tracked on the `WebGLStubState` object
 * and consumed when WebGPU pipelines or render passes are created.
 *
 * @see WebGLCompatibilityStub (nexus)
 */

/// <reference types="@webgpu/types" />

import Color from "../../../Core/Color.js";
import type { WebGLStubState, LogUsageFn } from "./WebGLStubTypes.js";

// WebGL capability constants
const GL_DEPTH_TEST = 0x0b71;
const GL_BLEND = 0x0be2;
const GL_CULL_FACE = 0x0b44;
const GL_SCISSOR_TEST = 0x0c11;

// WebGL cull face mode constants
const GL_FRONT = 0x0404;
const GL_BACK = 0x0405;

// WebGL front face constants
const GL_CW = 0x0900;

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
  STENCIL_TEST: 0x0b90,
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
): Record<string, any> {
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

    // ==== Stencil functions (tracked — full implementation pending) ====

    stencilFunc: () => {},
    stencilMask: () => {},
    stencilOp: () => {},

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
