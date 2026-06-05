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

// Re-export the pipeline-state extractor so compat-path consumers can
// convert accumulated gl.* state into a `PipelineVariant` that
// `WebGPURenderPipelineCache` will honor. Closes the Proton-style
// loop: tracking blend/depth/stencil/cull state is only useful when
// something later reads it back out into a pipeline.
export {
  extractPipelineStateFromStub,
  extractRenderPassStateFromStub,
  applyStubVariantToBuilder,
} from "./WebGLStubPipelineExtractor.js";
export type { WebGLStubRenderPassState } from "./WebGLStubPipelineExtractor.js";

// Re-export the shader translator registry so apps can plug in a
// GLSL→WGSL translator (typically naga-wasm via
// `NagaShaderTranslator`). See WebGPUShaderTranslator for the
// interface and architectural context.
export {
  registerShaderTranslator,
  getActiveShaderTranslator,
  subscribeToShaderTranslatorChange,
  // Preprocessors run BEFORE the translator and transform GLSL source
  // in-place. Typical use: an app registers a preprocessor backed by
  // Cesium's `ShaderSource` so stub-input GLSL that references
  // `czm_*` builtins is combined with the builtins (inline) before
  // naga sees it. Registration is opt-in — the stub works without a
  // preprocessor for self-contained user GLSL.
  registerShaderPreprocessor,
  getActiveShaderPreprocessor,
  WGSLPassthroughTranslator,
  NotSupportedTranslator,
} from "./WebGPUShaderTranslator.js";
export type {
  ShaderStage,
  ShaderReflection,
  TranslatedShader,
  ShaderTranslator,
  ShaderPreprocessor,
} from "./WebGPUShaderTranslator.js";

// Naga adapter. Users who run `npm install naga-wasm` call
// `registerShaderTranslator(new NagaShaderTranslator())` at bootstrap
// to enable runtime GLSL→WGSL translation for the WebGL compat stub.
export {
  NagaShaderTranslator,
  transpileGLSL as nagaTranspileGLSL,
  isNagaReady,
  isNagaUnavailable,
} from "./WebGPUNagaTranspiler.js";

// Naga reflection → WebGPU BGL auto-derive. Pairs with the
// `validate_wgsl` export from the vendored naga-wasm: call it on
// translated WGSL, feed the JSON through `parseNagaReflection`, then
// hand the resulting `NagaReflection` to
// `buildBindGroupLayoutDescriptors`. The output descriptors drop
// straight into `device.createBindGroupLayout(…)`.
export {
  parseNagaReflection,
  buildBindGroupLayoutDescriptors,
  // Program-level convenience: takes the compiled program's stage
  // reflections and returns materialized GPUBindGroupLayout objects
  // on the supplied device. Stage visibility is merged (VERTEX |
  // FRAGMENT) per-binding automatically — same binding declared in
  // both vertex + fragment ends up with both bits set.
  buildBindGroupLayoutsFromProgram,
} from "./WebGPUBindGroupReflection.js";
export type {
  NagaReflection,
  NagaBinding,
  BuildBindGroupLayoutsFromProgramOptions,
} from "./WebGPUBindGroupReflection.js";

/**
 * Vertex + fragment shader module pair returned from
 * `getCompiledShaderForProgram`. Pipeline builders feed `vertex`
 * into `vertex.module` + `vertexEntryPoint` into `vertex.entryPoint`,
 * and similarly for fragment.
 *
 * Reflection is included so the builder can derive vertex-attribute
 * locations and uniform-buffer layouts from the translator output —
 * the current (naga) translator emits empty reflection, so builders
 * that need real reflection should either use a richer translator
 * (slang-wasm when its reflection API is wired) or author the
 * pipeline descriptor by hand.
 */
export interface CompiledProgramModules {
  vertex: GPUShaderModule;
  vertexEntryPoint: string;
  fragment: GPUShaderModule;
  fragmentEntryPoint: string;
  vertexReflection: import("./WebGPUShaderTranslator.js").ShaderReflection;
  fragmentReflection: import("./WebGPUShaderTranslator.js").ShaderReflection;
}

/**
 * Retrieve the compiled shader modules for a program returned from
 * `gl.createProgram()` after `gl.linkProgram()` has run. Awaits the
 * linker's async completion and returns null if the program didn't
 * link (no translator registered, translator error, or device
 * unavailable).
 *
 * Downstream pipeline builders combine this with
 * `extractPipelineStateFromStub(state)` to produce a complete
 * `WebGPURenderPipelineDescriptor` + `PipelineVariant` pair the cache
 * can consume. WebGPU render pipelines take separate vertex + fragment
 * modules, so we return the pair rather than a single concatenated
 * module — concatenation would collide on both stages' `fn main`.
 *
 * @param program The stub program object
 * @returns The compiled module pair, or null on any failure
 */
export async function getCompiledShaderForProgram(
  program: unknown,
): Promise<CompiledProgramModules | null> {
  const p = program as {
    _linkReady?: Promise<CompiledProgramModules | null>;
    _programModules?: CompiledProgramModules | null;
  } | null;
  if (!p) return null;
  if (p._programModules) return p._programModules;
  if (p._linkReady) return await p._linkReady;
  return null;
}

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
export function createWebGLCompatibilityStub(state: WebGLStubState) {
  // Track which stub methods have been called (log once per method for noise reduction)
  const _loggedMethods = new Set<string>();
  const logUsage = (method: string, reason: string) => {
    if (!_loggedMethods.has(method)) {
      _loggedMethods.add(method);
      //>>includeStart('debug', pragmas.debug);
      console.warn(
        `[WebGPU:StubFallback] gl.${method}() called — ${reason}. ` +
          `This indicates missing WebGPU functionality that should be added.`,
      );
      //>>includeEnd('debug');
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
