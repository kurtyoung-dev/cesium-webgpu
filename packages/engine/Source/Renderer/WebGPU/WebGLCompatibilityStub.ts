/**
 * @module WebGLCompatibilityStub
 *
 * **Proton-Style WebGL→WebGPU Translation Layer**
 *
 * Similar to how Valve's Proton translates Windows DirectX calls to Linux
 * Vulkan, this module translates WebGL API calls into equivalent WebGPU
 * operations. This enables third-party code, engine extensions, and legacy
 * CesiumJS subsystems to issue WebGL-shaped calls that execute on the WebGPU
 * backend transparently.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────────┐
 * │  User / Extension Code (writes WebGL-style calls)   │
 * └────────────────────────┬────────────────────────────┘
 *                          │  gl.bindTexture(), gl.bufferData(), etc.
 *                          ▼
 * ┌─────────────────────────────────────────────────────┐
 * │  WebGLCompatibilityStub (Translation Layer)         │
 * │  ┌───────────┐ ┌──────────────┐ ┌───────────────┐  │
 * │  │  Textures  │ │  Buffers     │ │  Pipeline     │  │
 * │  │  Stub      │ │  Stub        │ │  State Stub   │  │
 * │  └─────┬─────┘ └──────┬───────┘ └───────┬───────┘  │
 * │  ┌─────┴─────┐ ┌──────┴───────┐ ┌───────┴───────┐  │
 * │  │  Framebuf  │ │  Shader      │ │  WebGLState   │  │
 * │  │  Stub      │ │  Stub        │ │  Converters   │  │
 * │  └─────┬─────┘ └──────┬───────┘ └───────┬───────┘  │
 * └────────┴──────────────┴─────────────────┴──────────┘
 *                          │  Mapped to WebGPU operations
 *                          ▼
 * ┌─────────────────────────────────────────────────────┐
 * │  WebGPUContext / GPUDevice / GPUQueue               │
 * │  (Real WebGPU rendering backend)                    │
 * └─────────────────────────────────────────────────────┘
 * ```
 *
 * ## Translation Strategy
 *
 * The translation layer works with CesiumJS's `GraphicsContext` abstraction
 * and the WebGPU command list system:
 *
 * 1. **State tracking** — WebGL is a state machine; WebGPU is not. The stub
 *    tracks WebGL state (bound textures, active buffers, blend/depth modes)
 *    and batches them into WebGPU pipeline descriptors at draw time.
 *
 * 2. **Command routing** — WebGL draw calls (`drawArrays`, `drawElements`)
 *    are translated into `WebGPUDrawCommand` objects pushed to the command
 *    list. The `WebGPUSceneRenderer` executes them alongside native commands.
 *
 * 3. **Resource mapping** — WebGL resource handles (textures, buffers,
 *    framebuffers) wrap their WebGPU equivalents. `gl.createTexture()`
 *    returns an object with a `_webgpuTexture` property pointing to the
 *    real `GPUTexture`. Extension code can access either API surface.
 *
 * 4. **Format conversion** — `WebGLStateConverters.ts` maps WebGL enums
 *    to WebGPU equivalents (e.g., `gl.FLOAT` → `'float32'`,
 *    `gl.ONE_MINUS_SRC_ALPHA` → `'one-minus-src-alpha'`).
 *
 * ## How Extension Authors Use This
 *
 * Extension code that uses WebGL-style APIs works automatically when
 * the WebGPU renderer is active:
 *
 * ```javascript
 * // This works on BOTH WebGL and WebGPU backends:
 * const gl = context._gl; // On WebGPU, returns this translation stub
 * const tex = gl.createTexture();
 * gl.bindTexture(gl.TEXTURE_2D, tex);
 * gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA,
 *               gl.UNSIGNED_BYTE, pixels);
 *
 * // For new extensions, prefer the backend-agnostic API:
 * const tex = context.createTexture({ width, height, pixelFormat, ... });
 * ```
 *
 * ## WebGL → WebGPU Call Mapping Reference
 *
 * | WebGL Call | WebGPU Equivalent | Stub Domain |
 * |---|---|---|
 * | `gl.createTexture()` | `device.createTexture()` | Texture |
 * | `gl.texImage2D()` | `device.queue.writeTexture()` | Texture |
 * | `gl.generateMipmap()` | Compute mipmap generation | Texture |
 * | `gl.createBuffer()` | `device.createBuffer()` | Buffer |
 * | `gl.bufferData()` | `device.queue.writeBuffer()` | Buffer |
 * | `gl.createFramebuffer()` | Render target + attachments | Framebuffer |
 * | `gl.bindFramebuffer()` | Set active render target | Framebuffer |
 * | `gl.enable/disable()` | Pipeline descriptor state | PipelineState |
 * | `gl.blendFunc()` | `GPUBlendState` on pipeline | PipelineState |
 * | `gl.depthFunc()` | `GPUDepthStencilState` | PipelineState |
 * | `gl.viewport()` | `renderPass.setViewport()` | PipelineState |
 * | `gl.clear()` | Render pass load ops | PipelineState |
 * | `gl.createShader()` | `device.createShaderModule()` | Shader |
 * | `gl.drawArrays()` | `renderPass.draw()` | (command list) |
 * | `gl.drawElements()` | `renderPass.drawIndexed()` | (command list) |
 *
 * ## Limitations vs Full Translation (Proton-level)
 *
 * Unlike Valve's Proton which provides near-complete DirectX→Vulkan
 * translation, this stub is scoped to the CesiumJS API surface:
 *
 * - **No GLSL compilation** — Extension shaders must provide WGSL via
 *   the `RenderCommand` API or use the Slang cross-compiler. The stub
 *   does NOT transpile GLSL to WGSL at runtime.
 * - **No transform feedback** — Use compute shaders instead.
 * - **No WebGL1 extensions** — Only WebGL2 core functionality is mapped.
 * - **State is tracked, not replayed** — The stub records state for
 *   pipeline creation rather than replaying a GL command stream.
 *
 * ## Domain Modules
 *
 * - `WebGLStubTexture` — Texture creation, binding, upload, copy, mipmaps
 * - `WebGLStubFramebuffer` — Framebuffer and renderbuffer lifecycle
 * - `WebGLStubBuffer` — Buffer creation, binding, data upload, vertex attribs
 * - `WebGLStubPipelineState` — Clear, viewport, scissor, enable/disable,
 *   blend, depth, stencil, culling, color mask
 * - `WebGLStubShader` — Shader program placeholders, parameter queries, misc
 *
 * ## Progressive Reduction
 *
 * As CesiumJS subsystems migrate to `GraphicsContext` factory methods,
 * individual domain modules can be removed:
 *
 * | Migration Step | Removes |
 * |---|---|
 * | All textures via `context.createTexture()` | `WebGLStubTexture` |
 * | All buffers via `context.createBuffer()` | `WebGLStubBuffer` |
 * | All FBOs via `context.createFramebuffer()` | `WebGLStubFramebuffer` |
 * | All shaders via WGSL + `RenderCommand` | `WebGLStubShader` |
 * | Zero legacy `gl.*` state calls | `WebGLStubPipelineState` |
 *
 * @see WebGPUContext
 * @see GraphicsContext
 * @see WebGLStateConverters
 * @see RenderCommand
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
export function createWebGLCompatibilityStub(
  state: WebGLStubState,
): Record<string, unknown> {
  // Track which stub methods have been called (log once per method for noise reduction)
  const _loggedMethods = new Set<string>();
  const logUsage = (method: string, reason: string) => {
    if (!_loggedMethods.has(method)) {
      _loggedMethods.add(method);
      console.warn(
        `[WebGPU:StubFallback] gl.${method}() called — ${reason}. ` +
          `This indicates missing WebGPU functionality that should be added.`,
      );
    }
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
    ...createShaderStubs(state, logUsage),
  };
}

export default createWebGLCompatibilityStub;
