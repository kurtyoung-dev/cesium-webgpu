/**
 * @module WebGLCompatibilityStub
 *
 * **Nexus module** — WebGL compatibility shim for the WebGPU rendering context.
 *
 * Provides WebGL constants and stub methods that legacy CesiumJS code expects
 * (e.g., `Texture.js`, `Framebuffer.js`) so they can function without crashing
 * when the WebGPU renderer is active. This is important for third-party
 * consumers of CesiumJS (e.g., TerriaJS) that may depend on WebGL-shaped APIs.
 *
 * The stub is split across domain-specific modules in the `Stubs/` directory
 * for maintainability. This file acts as the single entry point (nexus) that
 * composes all domain stubs into a unified WebGL-shaped object.
 *
 * **Domain modules:**
 * - `WebGLStubTexture` — Texture creation, binding, upload, copy, mipmaps
 * - `WebGLStubFramebuffer` — Framebuffer and renderbuffer lifecycle
 * - `WebGLStubBuffer` — Buffer creation, binding, data upload, vertex attribs
 * - `WebGLStubPipelineState` — Clear, viewport, scissor, enable/disable,
 *   blend, depth, stencil, culling, color mask
 * - `WebGLStubShader` — Shader program placeholders, parameter queries, misc
 *
 * Once all CesiumJS rendering code is fully migrated to the WebGPU
 * abstraction (`GraphicsContext` factory methods), this stub can be
 * progressively reduced. Individual domain modules can be removed as their
 * corresponding CesiumJS subsystems are migrated.
 *
 * @see WebGPUContext
 * @see GraphicsContext
 */

// Re-export the shared types so consumers can import from this nexus
export type { WebGLStubState, LogUsageFn } from "./Stubs/WebGLStubTypes.js";

// Domain stub creators
import {
  TEXTURE_CONSTANTS,
  createTextureStubs,
} from "./Stubs/WebGLStubTexture.js";
import { createFramebufferStubs } from "./Stubs/WebGLStubFramebuffer.js";
import {
  BUFFER_CONSTANTS,
  createBufferStubs,
} from "./Stubs/WebGLStubBuffer.js";
import {
  PIPELINE_STATE_CONSTANTS,
  createPipelineStateStubs,
} from "./Stubs/WebGLStubPipelineState.js";
import { createShaderStubs } from "./Stubs/WebGLStubShader.js";

// Import the type for the function signature
import type { WebGLStubState } from "./Stubs/WebGLStubTypes.js";

/**
 * Creates the WebGL compatibility stub object.
 *
 * The returned object has the same shape as a `WebGLRenderingContext`,
 * providing constants and stub method implementations that map to WebGPU
 * state tracking or no-ops. It is composed from domain-specific modules
 * that each handle a logical subset of the WebGL API surface.
 *
 * @param state - Shared mutable state from WebGPUContext
 * @returns A WebGL-shaped stub object
 */
export function createWebGLCompatibilityStub(state: WebGLStubState): any {
  const logUsage = (_method: string, _reason: string) => {
    // Disabled for less noise — uncomment for debugging WebGL compatibility layer
    // console.log(`[WebGPU Compatibility] gl.${_method}() called - ${_reason}`);
  };

  return {
    // Constants from domain modules
    ...TEXTURE_CONSTANTS,
    ...BUFFER_CONSTANTS,
    ...PIPELINE_STATE_CONSTANTS,

    // Methods from domain modules
    ...createTextureStubs(state, logUsage),
    ...createFramebufferStubs(state, logUsage),
    ...createBufferStubs(state, logUsage),
    ...createPipelineStateStubs(state, logUsage),
    ...createShaderStubs(logUsage),
  };
}

export default createWebGLCompatibilityStub;
