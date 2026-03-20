/**
 * @module WebGLStubShader
 *
 * WebGL shader program, parameter query, and miscellaneous method stubs
 * for the WebGPU compatibility layer. Shader methods are mostly no-ops
 * since WebGPU uses `GPUShaderModule` rather than the WebGL
 * compile/link workflow. Parameter queries and framebuffer blit/readback
 * return safe defaults.
 *
 * @see WebGLCompatibilityStub (nexus)
 */

import type { LogUsageFn } from "./WebGLStubTypes.js";

// WebGL type constant for FLOAT
const GL_FLOAT = 0x1406;

/**
 * Creates shader, parameter query, and miscellaneous stub methods.
 *
 * @param _logUsage - Debug logging function (unused — shader ops are silent)
 * @returns Object containing all shader/misc stub methods
 */
export function createShaderStubs(_logUsage: LogUsageFn): Record<string, any> {
  return {
    // ==== Shader methods (placeholders — WebGPU uses shader modules) ====

    createShader: (type: number) => ({ _type: type, _isWebGPU: true }),
    deleteShader: () => {},
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => "",
    createProgram: () => ({ _isWebGPU: true }),
    deleteProgram: () => {},
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    useProgram: () => {},

    getActiveUniform: (
      _program: any,
      index: number,
    ): { name: string; size: number; type: number } => ({
      name: `uniform_${index}`,
      size: 1,
      type: GL_FLOAT,
    }),

    getActiveAttrib: (
      _program: any,
      index: number,
    ): { name: string; size: number; type: number } => ({
      name: `attrib_${index}`,
      size: 1,
      type: GL_FLOAT,
    }),

    getUniformLocation: (
      _program: any,
      name: string,
    ): { _name: string; _isWebGPU: boolean } => ({
      _name: name,
      _isWebGPU: true,
    }),

    getAttribLocation: (_program: any, name: string): number => {
      const locationMap: Record<string, number> = {
        position: 0,
        normal: 1,
        texCoord: 2,
        color: 3,
        tangent: 4,
        bitangent: 5,
      };
      return locationMap[name] ?? -1;
    },

    // ==== Parameter queries ====

    getParameter: (_param: number) => 0,
    getExtension: (_name: string): null => null,

    // ==== Framebuffer blitting & read pixels ====

    blitFramebuffer: () => {},
    readPixels: (): null => null,
  };
}
