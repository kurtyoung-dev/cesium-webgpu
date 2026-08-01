/**
 * WebGPU implementation of the GraphicsContext interface.
 * Provides a WebGPU-based rendering backend for CesiumJS with modern GPU features.
 *
 * @example
 * const context = await WebGPUContext.create(canvas, options);
 * context.beginFrame();
 * // ... render commands ...
 * context.endFrame();
 * @module WebGPUContext
 */

/// <reference types="@webgpu/types" />

import RendererType, { RendererInitializationError } from "../RendererType.js";
import WebGPUSync from "./WebGPUSync.js";
import {
  GraphicsContext,
  GraphicsContextOptions,
  DebugStatsObject,
  DebugStatsValue,
  VolumetricCloudRequest,
} from "../GraphicsContext.js";
import DeveloperError from "../../Core/DeveloperError.js";
import defined from "../../Core/defined.js";
import RuntimeError from "../../Core/RuntimeError.js";
import createGuid from "../../Core/createGuid.js";
import ClipSpaceConvention from "../../Core/ClipSpaceConvention.js";
import Color from "../../Core/Color.js";
import UniformState from "../UniformState.js";
import GraphicsCapabilities from "../GraphicsCapabilities.js";
import PassState from "../PassState.js";
import RenderState from "../RenderState.js";
import ShaderCache from "../ShaderCache.js";
import TextureCache from "../TextureCache.js";
import { WebGPUShaderCache } from "./WebGPUShaderCache.js";
import { WebGPURenderPipelineCache } from "./WebGPURenderPipelineCache.js";
// C11-174 — type-only: bind-group cache counters surfaced by
// `getRendererStatistics()`. No runtime dependency on the cache module.
import type { BindGroupCacheStats } from "./WebGPUBindGroupCache.js";
import { AsyncResourceMonitor } from "./AsyncResourceMonitor.js";
import { AsyncResourceTelemetry } from "./AsyncResourceTelemetry.js";
import { WebGPUComputePipelineCache } from "./WebGPUComputePipelineCache.js";
import { WebGPUBuffer } from "./WebGPUBuffer.js";
import { WebGPUTexture } from "./WebGPUTexture.js";
import { WebGPUMipmapGenerator } from "./WebGPUMipmapGenerator.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
// C10-06 Step A: statically imported so the WGF-6 primitive-index utils cache
// is populated synchronously during `_initialize` instead of paying an inline
// dynamic-import round-trip serialized into every boot. The module is a pure
// static-method class with zero top-level imports and no module-level side
// effects, so folding it into the (already-lazy) WebGPU chunk is a net win.
import { WebGPUPrimitiveIndexUtils } from "./WebGPUPrimitiveIndexUtils.js";
import { WebGPUPickFramebuffer } from "./WebGPUPickFramebuffer.js";
import { isSceneFBMrtMode } from "./WebGPUSceneFBTargetHelpers.js";
import {
  computeAttachmentDemand,
  type AttachmentDemandRecord,
  type AttachmentDemandSceneLike,
} from "./WebGPUAttachmentDemandRegistry.js";
import {
  WebGPUEnvironmentDemand,
  WebGPUEnvironmentDemandReason,
  WebGPUEnvironmentDemandRegistry,
  type WebGPUEnvironmentDemandTelemetry,
  type WebGPUEnvironmentDemandValue,
} from "./WebGPUEnvironmentDemandRegistry.js";
import {
  WebGPUViewportQuad,
  type ViewportQuadCommand,
  type ViewportQuadCommandOptions,
} from "./WebGPUViewportQuad.js";
// `createWebGLCompatibilityStub` import retained for the `_gl` field's
// `ReturnType<typeof ...>` annotation. The state-literal that used to
// live in `_initializeWebGLStub` (and the `webglToWebGPU*` /
// `WebGLStubState` symbols it consumed) moved to
// `WebGPUContextWebGLStubInit.ts` in Batch 129.
import { createWebGLCompatibilityStub } from "./WebGLCompatibilityStub.js";
import { buildWebGLCompatibilityStubFor } from "./WebGPUContextWebGLStubInit.js";
import { WebGPUDeviceInvalidationBus } from "./WebGPUDeviceInvalidationBus.js";
import { WebGPUResourceCacheRegistry } from "./WebGPUResourceCacheRegistry.js";
import { WebGPUFeatureFlags } from "./WebGPUFeatureFlags.js";
import { WebGPUDevicePool } from "./WebGPUDevicePool.js";
import { buildDeviceLossRecoveryFor } from "./WebGPUContextDeviceLoss.js";
import {
  getFrameStatistics,
  resetFrameStatistics,
  recordDrawCall as recordDrawCallExt,
  type WebGPUFrameStatistics,
} from "./WebGPUFrameStatistics.js";
import type {
  StubTextureWrapper,
  StubFramebuffer,
  StubRenderbuffer,
  StubAttachment,
  StubBufferHandle,
} from "./Stubs/WebGLStubTypes.js";
// `DeviceLossRecoveryHost` no longer imported — the host literal that
// used it moved to `WebGPUContextDeviceLoss.ts` in Batch 143.
import {
  DeviceLossState,
  WebGPUDeviceLossRecovery,
  type DeviceLostCallback,
} from "./WebGPUDeviceLossRecovery.js";
// FORK-2 fix: WebGPUResourceManager and WebGPUPickManager were unused imports — removed.
// They can be re-added when their intended usage is implemented.
import { WebGPURenderBundleManager } from "./WebGPURenderBundleManager.js";
import WebGPUComputeEngine from "./WebGPUComputeEngine.js";
import { WebGPUTimestampProfiler } from "./WebGPUTimestampProfiler.js";
import { WebGPUStorageBufferPool } from "./WebGPUStorageBufferPool.js";
import { WebGPUIndirectDrawManager } from "./WebGPUIndirectDrawManager.js";
import { WebGPUCSMRenderer } from "./WebGPUCSMRenderer.js";
import { WebGPUBufferMapper } from "./WebGPUBufferMapper.js";
import { WebGPURingBufferAllocator } from "./WebGPURingBufferAllocator.js";
import { destroyEnvironmentalEffectsCompositor } from "./WebGPUEnvironmentalEffectsCompositor.js";
import {
  refreshShadowReceiveUniformPrefix,
  releaseEffectsPlaceholderCacheForContext,
  retainEffectsPlaceholderCacheForContext,
} from "./WebGPUEffectsBindGroup.js";
import {
  applyCanvasConfig as applyCanvasConfigExt,
  reconfigureCanvas as reconfigureCanvasExt,
  setHDRCanvasOutput as setHDRCanvasOutputExt,
  setHDRFallbackListener as setHDRFallbackListenerExt,
  clearAllHDRFallbackListeners as clearAllHDRFallbackListenersExt,
} from "./WebGPUContextCanvasConfig.js";
import type { GPUCullerInstance } from "./WebGPUContextCullerPool.js";
import {
  getGpuCuller as getGpuCullerExt,
  getGpuCullerForOpaqueFrustum as getGpuCullerForOpaqueFrustumExt,
  getGpuCullerForCascade as getGpuCullerForCascadeExt,
  getGpuCullerTranslucent as getGpuCullerTranslucentExt,
  reapIdleAuxCullers as reapIdleAuxCullersExt,
  reapAllAuxCullers as reapAllAuxCullersExt,
} from "./WebGPUContextCullerPool.js";
import {
  createDefaultTextures,
  copyTexture as copyTextureUtil,
  copyTextureRegion as copyTextureRegionUtil,
  createTextureFromImage as createTextureFromImageUtil,
  createPixelReadbackPBO,
  type DefaultTextures,
} from "./WebGPUTextureUtilities.js";
import { registerWebGPUFeatureRenderers } from "./WebGPUFeatureRenderers.js";
import FeatureRendererKey from "../FeatureRendererKey.js";
import {
  WebGPUPerformanceManager,
  type PerformanceConfig,
} from "./WebGPUPerformanceManager.js";
import { jsModule } from "./webgpuTypeHelpers.js";

/** Type-shape for the JS-only RenderState.fromCache() static. */
interface RenderStateStatics {
  fromCache: (renderState?: CesiumOpaqueObject) => CesiumOpaqueRenderState;
}

// ViewportQuadCommand and ViewportQuadCommandOptions are imported from
// WebGPUViewportQuad so the single source of truth lives next to the
// implementation. See below.

/** Return type for getPipelineState(). */
interface WebGPUPipelineStateSnapshot {
  depthStencil?: {
    format: GPUTextureFormat;
    depthWriteEnabled: boolean;
    depthCompare: GPUCompareFunction;
  };
  blend?: {
    color: {
      srcFactor: GPUBlendFactor;
      dstFactor: GPUBlendFactor;
      operation: GPUBlendOperation;
    };
    alpha: {
      srcFactor: GPUBlendFactor;
      dstFactor: GPUBlendFactor;
      operation: GPUBlendOperation;
    };
  };
  primitive: {
    cullMode: GPUCullMode;
    frontFace: GPUFrontFace;
  };
  colorWriteMask: number;
}

/** Return type for readPixelsToPBO(). */
interface PixelReadbackPBO {
  buffer: GPUBuffer;
  width: number;
  height: number;
  bytesPerRow: number;
  mapAsync: () => Promise<Uint8Array>;
  getBufferData: (dst: Uint8Array | Uint16Array | Float32Array) => void;
  destroy: () => void;
}

// `WebGPUFrameStatistics` interface moved to `WebGPUFrameStatistics.ts`
// in Batch 144 (audit candidate #6). Imported below.

// (ViewportQuadCommandOptions shape lives in WebGPUViewportQuad.ts and is
// imported at the top of the file.)

/** Shader source that can be a string or an object with _wgslCode. */
type ShaderSource =
  string | { _wgslCode?: string; sources?: string[]; defines?: string[] };

// `GPUCullerInstance` moved to `WebGPUContextCullerPool.ts` (Q35 decomposition
// slice) and is imported type-only above. The culler-pool lazy-init +
// idle-decay logic now lives in that module as host-interface free functions.

// Point cloud LOD processor contract — import the type-only reference
// so TS knows the shape without eagerly pulling the 30KB compute-shader
// module into the context's import graph. Consumers elsewhere can use
// the same type re-exported from this file (see `export type` at the
// bottom) without touching the processor module.
import type { WebGPUPointCloudLODProcessorInstance } from "./WebGPUPointCloudLODProcessor.js";

/** Minimal ClearCommand shape accessed by the clear() method. */
interface CesiumClearCommand {
  color?: CesiumColor | false;
  depth?: number | false;
  stencil?: number | false;
  framebuffer?: CesiumOpaqueFramebuffer;
  execute?: (
    context: CesiumGraphicsContext,
    passState?: CesiumPassState,
  ) => void;
}

/**
 * C11-174 — minimal structural surface of `WebGPUPostProcessPipeline`
 * consumed by `getRendererStatistics()` to expose the per-effect
 * bind-group cache counters. Registered by
 * `WebGPUSceneRendererEnsureResources` when the pipeline is (re)created.
 * Kept structural so this module never imports the post-process pipeline
 * graph; readers must check `isDestroyed` because the reference can
 * outlive a scene-renderer teardown.
 */
interface PostProcessCacheStatsSource {
  readonly isDestroyed: boolean;
  getBindGroupCacheStats(): {
    bloom: BindGroupCacheStats | null;
    ambientOcclusion: BindGroupCacheStats | null;
    autoExposure: BindGroupCacheStats | null;
  };
}

// Re-export types that external code may depend on
export { DeviceLossState, type DeviceLostCallback };

/**
 * Explicit classification of the currently-open render pass (C9-07 /
 * FAR-405-C0). Scene-FB pass opens declare "scene-framebuffer"; the
 * default swap-chain pass is "default-canvas"; every other custom pass
 * (shadow, pick, OIT, clear, post-process helpers, …) is "external".
 * The `clear()` guard keys off this instead of inferring from pass labels.
 */
export type WebGPUPassTarget =
  "default-canvas" | "scene-framebuffer" | "external";
// Re-export the LOD processor interface so consumers (e.g. the point
// cloud renderer) can import it from the context barrel without
// pulling in the compute pipeline class itself.
export type { WebGPUPointCloudLODProcessorInstance };

/**
 * WebGPU-specific context options
 */
export interface WebGPUContextOptions extends GraphicsContextOptions {
  /**
   * Preferred GPU power preference
   */
  powerPreference?: GPUPowerPreference;

  /**
   * WebGPU feature level: "core" (default) or "compatibility".
   * Compatibility mode runs on WebGL2 hardware via a restricted WebGPU feature set.
   * This enables WebGPU API benefits (modern shader compilation, pipeline caching)
   * on hardware that doesn't support full WebGPU.
   */
  featureLevel?: "core" | "compatibility";

  /**
   * Required features for the device
   */
  requiredFeatures?: GPUFeatureName[];

  /**
   * Required limits for the device
   */
  requiredLimits?: Record<string, number>;

  /**
   * C10-06 Step B — an in-flight `requestAdapter()` promise kicked off by
   * `ContextFactory.createWebGPU` *before* the ~3 MB WebGPU chunk is parsed,
   * so GPU-process adapter negotiation overlaps chunk parse/eval instead of
   * being gated behind it. Consumed by `WebGPUDevicePool.acquireDevice`; a
   * mismatch or rejection falls back to the pool's own `requestAdapter`
   * (conservative — never forced). Not persisted into device-loss recovery
   * options (an adapter is single-use).
   */
  prefetchedAdapter?: Promise<GPUAdapter | null>;

  /**
   * AUDIT_2026_05_02 C.1 (Batch 135) — when true (default), route
   * adapter + device acquisition through `WebGPUDevicePool` so multi-
   * canvas scenarios (split-screen, multi-monitor, picture-in-picture)
   * share a single GPUDevice. Set to false to force a fresh device for
   * this context regardless of what the pool has cached. Useful for:
   *
   *   - Tests that need an isolated device (no resource bleed-through
   *     from a previous test's device).
   *   - Benchmarking specific limit / feature configurations that must
   *     not be conflated with the primary device's negotiated state.
   *   - Recovery scenarios where the shared device is suspect and the
   *     caller wants a fresh negotiation.
   *
   * The pool path keeps adaptive limit negotiation (scaling against
   * adapter ceilings) — the user-supplied `requiredLimits` are still
   * honored verbatim and never lowered.
   *
   * @default true
   */
  useDevicePool?: boolean;

  /**
   * When true, the per-context point-cloud LOD processor compacts its
   * visible-index buffer with a parallel prefix scan instead of the
   * default per-workgroup atomicAdd. Output ordering becomes
   * deterministic (visibleIndices sorted by original point index) —
   * required for GPU-driven picking against a compacted list,
   * persistent point-selection buffers across frames, and split-screen
   * / multi-view passes that must produce identical index streams.
   *
   * Trade-off: one extra compute pass + two extra storage buffers per
   * capacity unit. Default false — opt in per context.
   */
  useDeterministicPointCloudLOD?: boolean;
}

interface ShadowPassCommandList {
  commandList: CesiumAnyDrawCommand[];
}

/**
 * Flatten legacy per-cascade/per-face shadow lists into the unique command set
 * expected by native WebGPU shadow renderers. First occurrence wins so command
 * ordering stays deterministic.
 *
 * Callers provide persistent scratch containers; both are reset here.
 */
export function collectUniqueShadowCastCommands(
  passes: ReadonlyArray<ShadowPassCommandList>,
  target: CesiumAnyDrawCommand[],
  seen: Set<CesiumAnyDrawCommand>,
): CesiumAnyDrawCommand[] {
  target.length = 0;
  seen.clear();
  for (let j = 0; j < passes.length; ++j) {
    const commandList = passes[j].commandList;
    for (let k = 0; k < commandList.length; ++k) {
      const command = commandList[k];
      if (!seen.has(command)) {
        seen.add(command);
        target.push(command);
      }
    }
  }
  return target;
}

/**
 * WebGPU implementation of GraphicsContext.
 * Manages the WebGPU device, adapter, and rendering pipeline.
 */
export class WebGPUContext extends GraphicsContext {
  /** One validation wrapper per pooled device, leased by live contexts. */
  private static readonly _shaderValidationByDevice = new WeakMap<
    GPUDevice,
    {
      original: GPUDevice["createShaderModule"];
      wrapper: GPUDevice["createShaderModule"];
      contextIds: Set<string>;
    }
  >();

  // Public underscore fields: these have public getters but renderers also
  // access the fields directly for performance. Marking public is honest
  // about the actual access pattern across the WebGPU renderer module.
  public _canvas: HTMLCanvasElement;
  // Public underscore: shared with the device-loss host-adapter
  // builder (Batch 143).
  public _adapter: GPUAdapter | null = null;
  public _device: GPUDevice | null = null;
  /**
   * AUDIT_2026_05_02 C.1 (Batch 135) — true when `_device` was acquired
   * via `WebGPUDevicePool.acquireDevice`, false when an external caller
   * supplied the device directly (e.g., the recovery path that hands a
   * fresh device into the existing context). The destroy path uses this
   * to decide between `pool.releaseDevice` (refcount-aware; the right
   * call when the device may be shared with other contexts) and a
   * direct `device.destroy()` (only safe when this context owns the
   * device exclusively).
   */
  public _deviceFromPool: boolean = false;
  // Public underscore: shared with the WebGL-stub state proxy (Batch 129
  // extraction).
  public _context: GPUCanvasContext | null = null;
  public _presentationFormat: GPUTextureFormat = "bgra8unorm";
  // HDR-DISPLAY (Batch 206) — when true, the canvas is configured with
  // `format: 'rgba16float' + colorSpace: 'display-p3' + toneMapping:
  // {mode: 'extended'}`. Driven by `Scene.useHDRCanvasOutput`. Toggle
  // path clears the pipeline cache because every pipeline targeting
  // the canvas format must be recompiled.
  // Public underscore: shared with the canvas-config helper
  // (`WebGPUContextCanvasConfig.ts`, Batch 593 decomposition slice).
  public _hdrCanvasOutput: boolean = false;
  // B213-O2 (Batch 219 audit fix) + B219-N4 (Batch 225 audit fix) —
  // Scene-installed listeners called when the context's HDR fallback
  // chain (B206-N1) trips and demotes `_hdrCanvasOutput` from true →
  // false. Each Scene.js instance attached to this context registers
  // its own listener so its `_useHDRCanvasOutput` flag follows the
  // demotion. Without the Set the prior single-slot design only
  // synced the LAST-installed scene; multi-scene-per-context
  // configurations (split-screen, picture-in-picture) ended up with
  // stale Scene flags on all but the last viewer.
  // Public underscore: shared with the canvas-config helper
  // (`WebGPUContextCanvasConfig.ts`, Batch 593 decomposition slice).
  public _hdrFallbackListeners: Set<(newValue: boolean) => void> = new Set();
  private _depthFormat: GPUTextureFormat = "depth24plus-stencil8";
  // Public underscore: shared with the device-loss host-adapter (Batch 143).
  public _isDestroyed: boolean = false;
  private _terminallyLost: boolean = false;
  // Public underscore accessor: FATAL device state is distinct from completed
  // context teardown. Entering it drops in-progress encoders immediately so no
  // subsequent path can submit old-device work, while destroy() remains legal.
  public get _isTerminallyLost(): boolean {
    return this._terminallyLost;
  }
  public set _isTerminallyLost(value: boolean) {
    this._terminallyLost = value;
    if (value) {
      this._currentRenderPassEncoder = null;
      this._activePassTarget = null;
      this._currentCommandEncoder = null;
      this._drainAfterFrameSubmitCallbacks(false);
    }
  }
  // Public underscore: shared with the device-loss host-adapter (Batch 143).
  public _options: WebGPUContextOptions;

  // Deferred GPU-texture destruction. Textures the SCENE evicts mid-frame
  // (e.g. `Imagery.releaseReference` dropping a reprojected/Mercator imagery
  // texture under memory pressure) cannot be `.destroy()`-ed inline — the
  // current frame's globe-tile draw may still reference them in a command
  // buffer that has not been submitted yet, which surfaces as
  // "Destroyed texture used in a submit". Scene code calls
  // `scheduleTextureDestroy()` instead; `endFrame()` frees the batch only
  // after the just-submitted GPU work completes (`onSubmittedWorkDone`).
  private _pendingTextureDestroys: GPUTexture[] = [];

  // C11-184 — native shadow rendering consumes a unique command set, not the
  // legacy per-cascade/per-cube-face lists flattened with duplicates. Both
  // containers persist with the context so the shadow hot path allocates
  // neither a temporary array nor a Set each frame.
  private _shadowCastCommandsScratch: CesiumAnyDrawCommand[] = [];
  private _shadowCastCommandsSeen: Set<CesiumAnyDrawCommand> = new Set();
  // Model and primitive effects groups are prepared before the current light
  // camera is fitted. Queue their stable UBs and refresh the shadow prefix in one
  // post-ShadowMap preparation phase, before any color command executes.
  private _shadowReceiveUniformRefreshes: unknown[] = [];
  private _shadowReceiveUniformRefreshSet: Set<GPUBuffer> = new Set();

  // C9-12A (hardened Batch 686) — imagery mip-generation jobs deferred out of
  // draw emission. A tile that realizes a new imagery GPUTexture during
  // command building enqueues a job here instead of opening a private encoder
  // + private submit. `endFrame` encodes every pending job into ONE
  // `"ImageryMipPreparation"` encoder submitted immediately BEFORE the frame
  // encoder's own submit (F8: two submits — same-queue ordering guaranteed, an
  // invalid prep buffer cannot invalidate the frame), so the queue orders
  // `copyExternalImageToTexture` → mip passes → scene passes and the realizing
  // frame samples complete mips. Renderers that privately submit mid-frame
  // work sampling imagery textures MUST call `flushPendingImageryMipJobs`
  // first (F3). Zero private submits from the draw path.
  private _pendingImageryMipJobs: Array<{
    texture: GPUTexture;
    format: GPUTextureFormat;
    mipLevelCount: number;
  }> = [];

  // F7 (Batch 686) — textures destroyed INLINE (dead immediately). Consulted
  // by the pending-mip encode step: only these are skipped. Scheduled destroys
  // (`_pendingTextureDestroys`) remain live through the frame submit and MUST
  // still get their mip chains. WeakSet — entries vanish with the texture.
  private _inlineDestroyedTextures = new WeakSet<GPUTexture>();

  // Frame state for command recording — public for cross-renderer access
  public _currentCommandEncoder: GPUCommandEncoder | null = null;
  public _currentRenderPassEncoder: GPURenderPassEncoder | null = null;

  // C11-76 — callbacks that must start only after the frame command buffer is
  // actually submitted. Readback clients use this seam to record copies on the
  // shared encoder without calling mapAsync while the staging buffer is still
  // referenced by an unsubmitted command buffer.
  private _afterFrameSubmitCallbacks: Array<(submitted: boolean) => void> = [];

  // C9-07 / FAR-405-C0 — explicit render-pass target tracking. The
  // clear() guard used to infer "is a scene-owned pass active?" from
  // `_currentRenderPassEncoder.label.startsWith("Scene")`; the target is
  // now tracked explicitly at every pass open/end site instead:
  //   "default-canvas"    — the swap-chain pass (`_beginDefaultRenderPass`)
  //   "scene-framebuffer" — the scene-FB pass (declared by its 3 open sites)
  //   "external"          — every other custom pass (shadow, pick, clear, …)
  private _activePassTarget: WebGPUPassTarget | null = null;

  // C9-07 / FAR-405-C0 — per-frame canvas demand flags. `beginFrame` no
  // longer opens the canvas pass eagerly; the FIRST open of a frame clears
  // each untouched channel (historically beginFrame cleared exactly once,
  // then every re-open loaded). Depth is the load-bearing half: an
  // untouched "Scene Depth Texture" read with depthLoadOp:"load" yields
  // WebGPU lazy-zero 0.0, not the historical clear value 1.0. Color is
  // set by any canvas-color write, including the post-process blit (which
  // encodes raw passes the context cannot observe — see
  // `markCanvasContentWritten`). Reset in `beginFrame`/`beginPickFrame`
  // ONLY, never in `endFrame`, so a pick mini-frame between render frames
  // cannot corrupt the next render frame's state.
  private _canvasColorTouchedThisFrame: boolean = false;
  private _canvasDepthTouchedThisFrame: boolean = false;
  private _currentTextureView: GPUTextureView | null = null;
  private _depthTexture: GPUTexture | null = null;
  private _depthTextureView: GPUTextureView | null = null;
  private _depthOnlyTextureView: GPUTextureView | null = null;
  private _uniformState: CesiumUniformState;

  // WebGL compatibility — stub object that masquerades as a
  // WebGLRenderingContext for legacy JS resources (Texture.js, CubeMap.js,
  // Framebuffer.js, etc.) that read `context._gl.FLOAT`, `context._gl.RGBA`,
  // etc. Typed via `ReturnType<typeof createWebGLCompatibilityStub>` so
  // the shape is inferred from the stub builder instead of declared as
  // `Record<string, unknown>`. TS callers get access to the full method
  // and constant list; JS callers are unaffected.
  public _gl!: ReturnType<typeof createWebGLCompatibilityStub>;

  // WGF-6: Cached reference to WebGPUPrimitiveIndexUtils so Scene.js can probe
  // `@builtin(primitive_index)` support without importing from Renderer/WebGPU.
  // Populated lazily by initialize() — Scene reads it via the public
  // `triangulationDebugSupported` getter.
  public _primitiveIndexUtilsCache: CesiumOpaqueObject | null = null;

  // WebGPU-specific caches and managers
  private _webgpuShaderCache: WebGPUShaderCache | null = null;
  // Public underscore: read by the canvas-config helper's HDR-toggle
  // cache invalidation (`WebGPUContextCanvasConfig.ts`, Batch 593).
  public _webgpuPipelineCache: WebGPURenderPipelineCache | null = null;
  // C11-174 — back-reference to the active post-process pipeline's
  // cache-stats surface (see `PostProcessCacheStatsSource`). Public
  // underscore: written by `WebGPUSceneRendererEnsureResources` when the
  // pipeline is (re)created. Read-only debug exposure.
  public _postProcessCacheStatsSource: PostProcessCacheStatsSource | null =
    null;
  private _webgpuComputePipelineCache: WebGPUComputePipelineCache | null = null;
  // NEW-WEBGPU-PIPELINE-READY-SIGNAL — Phase 1 scaffolding. Per-context
  // registry of inflight async GPU work. Lazy-initialized via the
  // `asyncResources` getter so contexts that never trigger async work
  // pay zero cost. Survives device-loss (subscribers stay attached);
  // device-loss callbacks call `reset()` to reject every inflight
  // token in one sweep.
  private _asyncResources: AsyncResourceMonitor | null = null;
  // NEW-WEBGPU-PERF-MONITOR-SUBSCRIBER — perf-side aggregator that
  // subscribes to the monitor and tracks per-kind p50/p95/p99 latency,
  // throughput, failure rates, and peak inflight pressure. Read by the
  // perf manager (or any consumer) to decide whether to throttle
  // pipeline-variant generation, defer non-critical compute work, etc.
  // Always-on; cost is one subscriber + ~1 KB resident.
  private _asyncResourceTelemetry: AsyncResourceTelemetry | null = null;
  // C11-193 — observe-only, GPU-free selected-consumer ledger. This does not
  // gate refresh work in this slice; it establishes conservative admission
  // semantics and evidence for the later context-owned bounded job scheduler.
  private _environmentDemandRegistry = new WebGPUEnvironmentDemandRegistry();
  // Public underscore: shared with the frame-statistics extract (Batch 144).
  public _samplerCache: Map<string, GPUSampler> = new Map();
  public _bindGroupLayoutCache: Map<string, GPUBindGroupLayout> = new Map();
  private _bindGroupCache: Map<string, GPUBindGroup> = new Map();

  // Resource pools for efficient reuse
  private _bufferPool: Map<string, GPUBuffer[]> = new Map();
  // Public underscore: shared with the frame-statistics extract (Batch 144).
  public _uniformBufferPool: GPUBuffer[] = [];
  private _mipmapGenerator: WebGPUMipmapGenerator | null = null;

  // GPU statistics and debugging
  public _frameCount: number = 0;
  // Public underscore: shared with the frame-statistics extract (Batch 144).
  public _drawCallCount: number = 0;
  public _triangleCount: number = 0;

  // WebGPU optional features that were successfully enabled.
  // Body extracted to `WebGPUFeatureFlags` in Batch 132. The Context
  // retains `hasFeature` / `enabledFeatures` as 1-line delegators so
  // external callers and the debug snapshot don't move.
  private _featureFlags = new WebGPUFeatureFlags();

  // Dynamic rendering state set by WebGPUSceneRenderer during frame execution
  public _depthStencilView: GPUTextureView | null = null;
  public _sceneColorView: GPUTextureView | null = null;
  public _sceneColorFormat: GPUTextureFormat = "bgra8unorm";
  public _msaaSamples: number = 1;
  public useIndirectDrawForTiles: boolean = false;

  // ── C9-09-ATTACHMENT-DEMAND-REGISTRY (FAR-401-C0) ──
  // Conservative force switch. While `true` the frame is forced to the
  // historical full-MRT scene-FB topology regardless of consumer demand,
  // preserving today's exact behavior. It stays `true` until C9-10 lands
  // the demand-driven topology flip behind the Gate-B decision point
  // (queue §3). Any un-enumerable consumer is covered by keeping this true
  // (campaign 9 rule 3 — unknown demand keeps MRT).
  public forceSceneMRT: boolean = true;
  // Frozen per-frame demand record (computed once in
  // updateAndClearFramebuffers, immutable for the rest of the frame). Both
  // the legacy executor and the future FAR-400/401 graph read this. Null
  // before the first frame.
  public _attachmentDemand: AttachmentDemandRecord | null = null;
  // Actual measured scene-FB attachment behavior for this frame, so the
  // debug snapshot can assert the registry record matches reality
  // (C9-09 acceptance). Reset at the top of updateAndClearFramebuffers.
  public _attachmentDemandActual: {
    gbufferAllocated: boolean;
    gbufferBytes: number;
    gbufferMsaaCompanionBytes: number;
    sceneColorAttachmentCount: number;
    slot1AttachmentOpens: number;
    slot1ResolveOpens: number;
    // C10-03-MSAA-BOUNDARY-BYTES — measured demand-driven scene-COLOR resolve
    // passes this frame (label `SceneFramebuffer-Color_demand_resolve`). Under
    // the elision this is exactly 1 on the default globe (the pre-post-process
    // ensure); 0 when `_msaaSamples <= 1`. Slot-1 (G-buffer) resolves are
    // counted separately by `slot1ResolveOpens` and are out of scope here.
    sceneColorResolveOpens: number;
  } = {
    gbufferAllocated: false,
    gbufferBytes: 0,
    gbufferMsaaCompanionBytes: 0,
    sceneColorAttachmentCount: 0,
    slot1AttachmentOpens: 0,
    slot1ResolveOpens: 0,
    sceneColorResolveOpens: 0,
  };

  // C10-03-MSAA-BOUNDARY-BYTES — intra-frame scene-COLOR resolve staleness.
  // Set `true` whenever a `"scene-framebuffer"` pass opens (new draws make the
  // single-sample resolve texture stale) and cleared only by
  // `WebGPUSceneRenderer._ensureSceneColorResolved`. Reset conservatively to
  // `true` at frame begin / pick begin / scene-FB recreate. A per-frame pure
  // demand record (`_attachmentDemand`) cannot own this because it is immutable
  // for the frame; this single flag, anchored on the existing C9-07
  // `_activePassTarget` tracking, is the executor of the resolved-scene-color
  // demand. Conservative default `true` (Rule 3: unknown demand resolves).
  public _sceneColorResolvePending: boolean = true;

  // C10-03-MSAA-BOUNDARY-BYTES — elision kill switch. Default `true` =
  // demand-driven "resolve-on-consume" (the shipped behavior). Set `false` to
  // restore the historical eager per-segment resolve (the scene-FB open sites
  // bake `resolveTarget` again and `_ensureSceneColorResolved` becomes inert),
  // so the two paths differ ONLY in resolve timing. Kept because the clean
  // one-commit revert boundary cannot be exercised without git; this bool is
  // the on/off/restored oracle mechanism (identical-build A/B) and a runtime
  // safety fallback. Reverting the batch removes it together with the elision.
  public _sceneColorResolveElisionEnabled: boolean = true;

  // Renderer-wide log-depth master switch (Approach A for
  // NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION / NEW-COLLECTIONS-LOG-DEPTH).
  // Default TRUE since Batch 251: the globe (Batch 183), lit Phong
  // primitives (Batch 188), depth plane (Batch 249), the five collections +
  // compute-instance system (Batch 250), and the Model PBR pipeline family
  // (Batch 251) all write csm_writeLogDepth-encoded `@builtin(frag_depth)`
  // when `isWebGPULogDepthActive(context, frameState)` is true — matching
  // WebGL's LOG_DEPTH path. Far-range depth ties (a billboard 1000 m above
  // terrain at a 220 km camera was ~0.03 hyperbolic quanta — Batch 229
  // measurement) now resolve at sub-meter precision. This remains a
  // one-line kill switch: flipping it false restores hyperbolic NDC depth
  // everywhere (every producer/consumer is define-gated and rebuilds
  // through keyed cache misses / per-renderer flip guards). Remaining
  // hyperbolic writers (Mat* primitives, Buffer* family,
  // EllipsoidPrimitive, Vector3DTile, GroundPolyline's depth-sample read)
  // are tracked under NEW-LOG-DEPTH-REMAINING-PRODUCERS in
  // migration_doc/DEFERRED_WORK.md. See WebGPULogDepth.ts.
  public _logDepthWriteEnabled: boolean = true;

  // NEW-WEBGPU-PICK-FLEET-LOG-DEPTH (C10-11) — pick-fleet log-depth master
  // switch, SEPARATE from `_logDepthWriteEnabled` (scene). The pick mini-frame
  // owns its own single shared depth attachment (WebGPUSceneRendererPickPass,
  // INV-2), so the whole native pick fleet must be uniformly hyperbolic OR
  // uniformly log — a mixed FBO depth-tests incoherently. Historically this
  // defaulted FALSE while the fleet was still uniformly hyperbolic. Batch 708
  // (NEW-WEBGPU-VOXEL-PICK-LOG-DEPTH) cleared the last blocker (voxel had zero
  // log-depth infra); C10-11 then converted EVERY remaining native pick producer
  // (globe, model incl. hover/metadata/precise-pass, ellipsoid, splat, buffer
  // point/polygon/polyline, billboard/point/polyline collections, primitive
  // pick families) to write log `@builtin(frag_depth)` gated on
  // `isWebGPUPickLogDepthActive`, so this flips TRUE in one coordinated change:
  // the shared pick FBO is now uniformly log. OPAQUE picks write the log depth;
  // BLEND/translucent picks keep depth-test-only (Batch-186 opaque-behind-
  // translucent pickability). Flipping this false restores the uniformly-
  // hyperbolic pick FBO (kill switch) — proven byte-identical (gate-off).
  public _pickLogDepthWriteEnabled: boolean = true;

  // Slice 5c-B Batch 129 — post-process snapshot. After the post-process
  // pipeline has blitted scene FB to canvas, a 1-pass copyTextureToTexture
  // mirrors the canvas into this view so env effects (SSR, NPR, Clouds,
  // Weather, Volumetric Fog) sample a POST-processed, tonemapped,
  // display-space color source instead of the raw HDR scene FB. The
  // env effects then composite their output BACK onto the canvas;
  // WebGPU forbids read+write of the same texture in a single pass, so
  // the intermediate is required.
  //
  // Allocated lazily by `WebGPUSceneRendererEnsureResources` when the
  // canvas size or format changes. Width/height tracked alongside.
  public _postProcessSnapshotTexture: GPUTexture | null = null;
  public _postProcessSnapshotView: GPUTextureView | null = null;
  public _postProcessSnapshotWidth: number = 0;
  public _postProcessSnapshotHeight: number = 0;

  // C-R8-EDGE-FBO (Batch 44) — edge-framebuffer texture views, set by
  // `WebGPUSceneRenderer._execute3DTilePasses` after the edges pass
  // resolves its MRT attachments. Consumers (edge composite stage,
  // future per-fragment edge detection in model shaders) read these
  // as the WebGPU equivalent of WebGL's
  // `uniformState.edge{Color,Id,Depth}Texture`. `null` when no edge
  // commands ran this frame, signalling downstream consumers to skip.
  public _edgeColorView: GPUTextureView | null = null;
  public _edgeIdView: GPUTextureView | null = null;
  public _edgeDepthView: GPUTextureView | null = null;
  // C-R8-EDGE-INLINE — packed globe depth view from
  // `WebGPUGlobeDepth.executeCopyDepth`. Published each frame after
  // `executeCopyDepth` runs so downstream effects (the inline edge
  // detection stage in Model FS) have a single place to read it from. The
  // view identity is target-owned and stable until resize/device recreation;
  // `null` means globe depth was not computed in the current frame.
  public _globeDepthView: GPUTextureView | null = null;
  /** Pick-scoped packed depth; never falls back to a previous render frame. */
  public _pickClassificationDepthView: GPUTextureView | null = null;
  // Batch 139 (NEW-LABEL-SDF-BIND-GROUP-CACHING) — published
  // alongside `_globeDepthView` so collection renderers with their own view
  // policy can compare the underlying texture identity. Both rotate only on
  // target recreation. `null` when globe depth was not computed this frame.
  public _globeDepthTexture: GPUTexture | null = null;
  // NEW-GROUNDPRIM-CLASSIFIER-PER-FRUSTUM-UBO (Batch 173) — per-slice
  // frustum state published by the multi-frustum loop right after
  // `_updateFrustumUniforms` refreshes `uniformState` for the slice.
  // Depth-sample classifiers (GroundPrimitive textured-material FS, and
  // the GroundPolyline / Vector3DTile classifiers as they adopt the
  // same path) recover eye-space from the sampled globe depth via
  // `invProj`, but their per-primitive UBO is packed ONCE per frame at
  // command-build time and so carries the WRONG slice's projection in
  // multi-frustum scenes. These fields let a per-slice bind-group
  // resolver bind the correct `invProj` + `(near, far)` at draw time.
  // `_currentFrustumInvProj` is a 16-float column-major matrix (reused
  // buffer, overwritten per slice); `_currentFrustumNearFar` is a
  // length-2 `[near, far]`. `_currentFrustumIndex` (already published as
  // a renderer field) selects which per-slice GPU buffer the resolver
  // writes/binds, so distinct slices land in distinct buffers (a single
  // shared buffer would be clobbered last-wins by `queue.writeBuffer`,
  // which applies all writes before the command buffer executes).
  public _currentFrustumInvProj: Float32Array | null = null;
  public _currentFrustumNearFar: Float32Array | null = null;
  public _currentFrustumIndex: number = 0;
  // NEW-WEBGPU-GLOBE-CLASSIFY-DEPTH-PRECISION — the FULL camera frustum
  // `[near, far]` the globe used to LOG-encode the entire depth texture this
  // frame. The globe DrawCommand is built once at scene-update (with
  // `uniformState.currentFrustum === camera.frustum`) and REPLAYED unchanged
  // across every slice, so there is exactly ONE log-encode near/far for the
  // whole globe depth texture. Depth-sample classifiers MUST decode eye
  // distance with THIS, then unproject with the per-slice `invProj`/`(near,
  // far)` above — decoding with the per-slice band reconstructs garbage
  // (~1e12 m) → flat textured-material UV. Captured pre-loop in
  // `WebGPUSceneRendererFrustumLoop` before the per-slice `updateFrustum`
  // mutates `camera.frustum`; consumed via the classifier `fstate` UBO.
  public _logDepthEncodeNearFar: Float32Array | null = null;
  // Migration Session 2 — packed translucent depth view from
  // `WebGPUTranslucentTileClassification.executePackDepth`. Published
  // each frame after the pack-depth pipeline runs IF translucent depth
  // was captured this frame (gated on `tcc.hasTranslucentDepth`).
  // `null` on frames without translucent 3D-tile content. The
  // depth-sample classifier (`WebGPUGroundPrimitiveRenderer`) prefers
  // this view over `_globeDepthView` when present so classification
  // volumes clip against the front-most translucent tile surface,
  // matching WebGL's `czm_unpackDepth(czm_globeDepthTexture)` behaviour
  // for translucent-on-translucent classification.
  public _packedTranslucentDepthView: GPUTextureView | null = null;

  // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — set to `true` by
  // WebGPUModelRenderer when emitting a primitive whose material
  // declares KHR_materials_transmission. SceneRenderer reads it
  // between OPAQUE and TRANSLUCENT passes to decide whether to
  // run the refraction capture (copyTextureToTexture from scene
  // color into the refraction target). Reset per-frame by the
  // SceneRenderer at the start of the frame so stale flags from
  // a previous render don't trigger spurious copies. The flag is
  // a coarse "any transmissive primitive in scene"; a future
  // refinement can scope to "transmissive primitive in this
  // frustum's TRANSLUCENT pass".
  public _sceneHasTransmission: boolean = false;
  // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — view of the scene-FB
  // refraction capture, published by SceneRenderer at the end of
  // the capture step. `null` until first capture; consumed by the
  // Model textureBindGroup builder at @group(2)@binding(23). When
  // null the bind group falls back to the white placeholder and
  // the FS sees a constant white "background" for transmission —
  // visually wrong but doesn't cause a binding error.
  public _refractionSceneView: GPUTextureView | null = null;

  // Batch 110 — scene pipeline format generation. Bumped by
  // `WebGPUSceneRenderer.update` whenever `_sceneColorFormat` changes
  // (HDR toggle, MSAA toggle, canvas format change). Renderers that
  // cache pipelines targeting scene FB (model PBR, globe terrain,
  // sky atmosphere, billboards, polylines, ground primitives, etc.)
  // compare against their last-built generation; when the value
  // differs, they clear and rebuild their pipeline caches against
  // the current `scenePipelineFormat`. This is what makes runtime
  // HDR toggle actually work — pre-Batch 110 every cached pipeline
  // had the canvas format baked in, producing format-mismatch
  // validation warnings + black scene FB writes when HDR toggled.
  public _scenePipelineFormatGeneration: number = 0;

  // Physical-device resource generation. Unlike the scene-format epoch above,
  // this advances on every successful recovery even when the replacement has
  // identical formats/limits. Scene command owners use it to reject buffers,
  // bind groups, and pipelines created by the previous GPUDevice.
  public _deviceResourceGeneration: number = 0;

  /**
   * Backend-agnostic epoch that increments whenever the scene render-target
   * color format changes at runtime (HDR toggle, MSAA toggle, canvas-format
   * change). Scene-level command builders that cache backend pipelines keyed
   * to the scene FB format (e.g. `Primitive` via the PRIMITIVE feature
   * renderer) compare this across frames and force a command rebuild when it
   * moves, so a mid-session `scene.highDynamicRange` flip rekeys their
   * pipelines instead of submitting a stale-format draw. The WebGL context
   * returns a constant 0 (its FBO format never changes on HDR toggle), so
   * consumers stay byte-identical on WebGL.
   */
  get renderTargetGeneration(): number {
    return this._scenePipelineFormatGeneration;
  }

  override get resourceGeneration(): number {
    return this._deviceResourceGeneration;
  }

  /**
   * Format that pipelines drawing into the scene framebuffer should
   * target. Equivalent to `_sceneColorFormat` (the scene FB's color
   * attachment format). Differs from `presentationFormat` (canvas
   * swap chain format) only when HDR is on — scene FB then uses
   * `rgba16float` or `rg11b10ufloat` while canvas stays at the
   * platform default (typically `bgra8unorm`). Renderers should use
   * THIS getter for fragment target formats; only the post-process
   * final-blit pipeline + debug overlays target `presentationFormat`.
   */
  get scenePipelineFormat(): GPUTextureFormat {
    return (
      this._sceneColorFormat ??
      this.presentationFormat ??
      ("bgra8unorm" as GPUTextureFormat)
    );
  }

  /**
   * Canonical color target for object-ID pick pipelines and the pick
   * framebuffer. Pick IDs use byte-exact RGBA readback, so an HDR scene
   * target cannot be reused as the pick attachment. Keeping this decision on
   * the context gives every pick producer and the framebuffer one format
   * authority instead of independently clamping the scene format.
   */
  get pickPipelineFormat(): GPUTextureFormat {
    const sceneFormat = this.scenePipelineFormat;
    return sceneFormat === "bgra8unorm" || sceneFormat === "rgba8unorm"
      ? sceneFormat
      : "rgba8unorm";
  }

  // WebGL extension properties (WebGPU natively supports these as core features)
  public floatingPointTexture: boolean = true; // WebGPU always supports float textures
  public halfFloatingPointTexture: boolean = true; // WebGPU always supports half-float textures
  public textureFloatLinear: boolean = true; // WebGPU always supports float filtering
  public textureHalfFloatLinear: boolean = true; // WebGPU always supports half-float filtering

  /**
   * Phase 5 WGF-1: when `true`, render pipelines that participate in the
   * ClippingPlaneCollection use a `@builtin(clip_distances)` vertex output
   * instead of the legacy fragment-discard path. Auto-set to `true` by
   * `_updateFeatureFlags()` when the device grants the `clip-distances`
   * feature; consumers can flip it back off for visual diffing against
   * the legacy path. Currently consumed only by the globe terrain
   * pipeline; the model pipeline doesn't yet have clipping plane support
   * to migrate.
   */
  public useHardwareClipDistances: boolean = false;

  /**
   * Phase 5 WGF-3 / PARITY-F16-POSTPROCESS: when `true`, post-process
   * pipeline stages that have a hand-tuned f16 variant compile and use
   * the half-precision source instead of the f32 source. This is an
   * OPT-IN that defaults to `false` (it is NOT auto-set) and every
   * selection site additionally double-gates on the device actually
   * granting the `shader-f16` feature — on a non-granting device the
   * f32 shaders are selected unchanged and every `_f16.wgsl` module is
   * inert. All post-process stages now ship f16 variants (Tonemapping,
   * ColorGrading, FXAA, BrightPass/BloomComposite/GaussianBlur1D, AO
   * generate/modulate, DepthOfField, GodRay generate/composite,
   * ScreenSpaceReflections). The flag also gates any future scene-side
   * f16 use, but RTE / depth / globe-UV math must always stay f32 (see
   * CLAUDE.md).
   */
  public useShaderF16: boolean = false;
  public s3tc: CesiumCompressedTextureExtension = null;
  public pvrtc: CesiumCompressedTextureExtension = null;
  public astc: CesiumCompressedTextureExtension = null;
  public etc: CesiumCompressedTextureExtension = null;
  public etc1: CesiumCompressedTextureExtension = null;
  public bc7: CesiumCompressedTextureExtension = null;
  public webgl2: boolean = false;
  public _textureFilterAnisotropic: CesiumCompressedTextureExtension = null;

  // Additional WebGL properties for full compatibility
  public _id: string;
  public _shaderCache: CesiumShaderCache;
  public _textureCache: CesiumOpaqueObject;
  public _stencilBits: number = 8;
  public _antialias: boolean = false;
  // Cross-subsystem cache (see SceneGlobalCache in cesium-js-types.d.ts).
  // Known keys are typed; new keys land in the opaque-object index
  // signature fallback. No `Record<string, unknown>` here.
  public cache: SceneGlobalCache = {};
  public options: WebGPUContextOptions;
  public validateFramebuffer: boolean = false;
  public validateShaderProgram: boolean = false;
  public logShaderCompilation: boolean = false;

  // Vertex array object methods (WebGL compat stubs — noop functions)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- WebGL compat noop stubs with varied signatures
  public glCreateVertexArray: (() => object) | null = null;
  public glBindVertexArray: ((...args: unknown[]) => void) | null = null;
  public glDeleteVertexArray: ((...args: unknown[]) => void) | null = null;

  // Instanced rendering methods (WebGL compat stubs)
  public glDrawElementsInstanced: ((...args: unknown[]) => void) | null = null;
  public glDrawArraysInstanced: ((...args: unknown[]) => void) | null = null;
  public glVertexAttribDivisor: ((...args: unknown[]) => void) | null = null;

  // Vertex-attribute divisor state cache (WebGL-parity bookkeeping).
  // Shared `VertexArray.js` writes `context._vertexAttribDivisors[index]`
  // and `context._previousDrawInstanced` when binding instanced attributes
  // (the ANGLE-workaround divisor cache `Context.js` keeps). On WebGPU a
  // divisor has no GPU-side meaning — model instancing flows through a
  // storage buffer indexed by `instance_index` (WebGPUModelInstancing),
  // and collection instancing bakes `stepMode: "instance"` into each
  // pipeline's vertex-buffer layout — but the cache must exist so the
  // shared bookkeeping is absorbed instead of crashing the render loop
  // (NEW-WEBGPU-INSTANCED-VA-DIVISORS, Batch 245). Sized from device
  // limits in `_initializeContextLimits` (re-run on device-loss recovery,
  // which also resets it — fresh-context semantics, matching Context.js).
  public _vertexAttribDivisors: number[] = [];
  public _previousDrawInstanced: boolean = false;

  // Draw buffers (WebGL compat stubs)
  public glDrawBuffers: ((...args: unknown[]) => void) | null = null;

  // Extension support flags
  private _standardDerivatives: boolean = true;
  private _blendMinmax: boolean = true;
  private _elementIndexUint: boolean = true;
  private _fragDepth: boolean = true;
  private _textureFloat: boolean = true;
  private _textureHalfFloat: boolean = true;
  private _textureFloatLinear: boolean = true;
  private _textureHalfFloatLinear: boolean = true;
  private _supportsTextureLod: boolean = true;
  private _colorBufferFloat: boolean = true;
  private _floatBlend: boolean = true;
  private _colorBufferHalfFloat: boolean = true;
  private _s3tc: boolean = false;
  private _pvrtc: boolean = false;
  private _astc: boolean = false;
  private _etc: boolean = false;
  private _etc1: boolean = false;
  private _bc7: boolean = false;
  private _vertexArrayObject: boolean = true;
  private _instancedArrays: boolean = true;
  private _drawBuffers: boolean = true;

  // Default textures
  private _defaultTexture: WebGPUTexture | undefined;
  private _defaultEmissiveTexture: WebGPUTexture | undefined;
  private _defaultNormalTexture: WebGPUTexture | undefined;
  private _defaultCubeMap: WebGPUTexture | undefined;

  // Render state
  // Public underscore: shared with the WebGL-stub state proxy (Batch 129
  // extraction). Same convention as `public _device`, `public _canvas`.
  public _clearColor: CesiumColor;
  public _clearDepth: number = 1.0;
  public _clearStencil: number = 0;
  private _defaultPassState: CesiumPassState | undefined;
  private _defaultRenderState: CesiumOpaqueRenderState | undefined;
  private _currentRenderState: CesiumOpaqueRenderState | undefined;
  private _currentPassState: CesiumPassState | undefined;
  private _currentFramebuffer: CesiumOpaqueFramebuffer | undefined;

  // Viewport and scissor state
  private _viewport: { x: number; y: number; width: number; height: number } = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };
  // Public underscore: shared with the WebGL-stub state proxy.
  public _scissorTest: boolean = false;
  private _scissorRect: {
    x: number;
    y: number;
    width: number;
    height: number;
  } = { x: 0, y: 0, width: 0, height: 0 };

  // WebGPU pipeline state tracking (for creating pipelines with correct
  // state). Public underscore: shared with the WebGL-stub state proxy
  // (Batch 129 extraction).
  public _depthTestEnabled: boolean = true;
  public _depthWriteEnabled: boolean = true;
  // Default depthCompare is `less-equal`, not `less`. At planetary scale
  // the projected clip-space Z can round up to exactly the far plane,
  // and `less` would discard those fragments. `less-equal` is the safe
  // default; pipelines that genuinely need strict-less can override.
  public _depthCompare: GPUCompareFunction = "less-equal";
  public _blendEnabled: boolean = false;
  public _cullFaceEnabled: boolean = true;
  public _cullMode: GPUCullMode = "back";
  public _frontFace: GPUFrontFace = "ccw";
  public _colorWriteMask: number = 0xf; // RGBA
  public _blendSrc: GPUBlendFactor = "one";
  public _blendDst: GPUBlendFactor = "zero";
  public _blendSrcAlpha: GPUBlendFactor = "one";
  public _blendDstAlpha: GPUBlendFactor = "zero";
  public _blendOp: GPUBlendOperation = "add";
  public _blendOpAlpha: GPUBlendOperation = "add";

  // Viewport quad for full-screen effects
  private _viewportQuadVertexBuffer: WebGPUBuffer | null = null;
  private _viewportQuadPipeline: GPURenderPipeline | null = null;
  private _viewportQuad: WebGPUViewportQuad | null = null;

  // Pick objects — managed by GraphicsContext base class
  // (_pickObjects Map and _nextPickColor counter are inherited)

  // Device loss recovery — delegated to WebGPUDeviceLossRecovery (FORK-1 fix)
  private _deviceLossRecovery: WebGPUDeviceLossRecovery | null = null;
  private _releaseShaderValidation: (() => void) | null = null;

  // GL compatibility - bound buffer/texture tracking for legacy code.
  // Public underscore: shared with the WebGL-stub state proxy
  // (Batch 129 extraction).
  public _boundVertexBuffer: StubBufferHandle | null = null;
  public _boundIndexBuffer: StubBufferHandle | null = null;
  public _activeTextureUnit: number = 0;
  public _textureBindings: Map<
    number,
    { target: number; texture: StubTextureWrapper | null }
  > = new Map();
  public _boundFramebuffer: StubFramebuffer | null = null;
  public _boundReadFramebuffer: StubFramebuffer | null = null;
  public _boundDrawFramebuffer: StubFramebuffer | null = null;
  public _boundRenderbuffer: StubRenderbuffer | null = null;
  public _framebuffers: Map<
    StubFramebuffer,
    { colorAttachment: StubAttachment; depthAttachment: StubAttachment }
  > = new Map();

  /**
   * Private constructor. Use WebGPUContext.create() instead.
   *
   * @private
   * @param {HTMLCanvasElement} canvas - The canvas element
   * @param {WebGPUContextOptions} options - Configuration options
   */
  private constructor(
    canvas: HTMLCanvasElement,
    options: WebGPUContextOptions,
  ) {
    super(); // Initialize GraphicsContext base (registry, logging, feature renderers)

    this._canvas = canvas;
    this._options = options;
    this._clipSpaceConvention = ClipSpaceConvention.WEBGPU;

    // Generate unique ID
    this._id = createGuid();

    // Initialize caches
    this._shaderCache = new ShaderCache(this);
    this._textureCache = new TextureCache();

    // Initialize uniform and pass state
    this._uniformState = new UniformState(this.clipSpaceConvention);
    this._defaultPassState = new PassState(this);
    this._defaultRenderState =
      jsModule<RenderStateStatics>(RenderState).fromCache();
    this._currentRenderState = this._defaultRenderState;
    this._currentPassState = this._defaultPassState;

    // Initialize clear values
    this._clearColor = new Color(0.0, 0.0, 0.0, 0.0);

    // Initialize vertex array object methods (no-op for WebGPU)
    this.glCreateVertexArray = () => ({});
    this.glBindVertexArray = () => {};
    this.glDeleteVertexArray = () => {};

    // Initialize instanced rendering methods (no-op for WebGPU)
    this.glDrawElementsInstanced = () => {};
    this.glDrawArraysInstanced = () => {};
    this.glVertexAttribDivisor = () => {};

    // Initialize draw buffers (no-op for WebGPU)
    this.glDrawBuffers = () => {};

    // Store options
    this.options = options;

    // Initialize WebGL compatibility stub
    // This provides WebGL constants that legacy code expects
    this._initializeWebGLStub();

    // Registry publication is the commit point of create(). A partially
    // initialized WebGPU context must never be observable globally.
  }

  /**
   * Creates and initializes a new WebGPUContext.
   * This is an async factory method because WebGPU initialization is asynchronous.
   *
   * @param {HTMLCanvasElement} canvas - The canvas element for rendering
   * @param {WebGPUContextOptions} [options] - Configuration options
   * @returns {Promise<WebGPUContext>} The initialized WebGPU context
   * @throws {RuntimeError} If WebGPU is not supported or initialization fails
   *
   * @example
   * const context = await WebGPUContext.create(canvas, {
   *   powerPreference: 'high-performance'
   * });
   */
  static async create(
    canvas: HTMLCanvasElement,
    options: WebGPUContextOptions = {},
  ): Promise<WebGPUContext> {
    //>>includeStart('debug', pragmas.debug);
    if (!defined(canvas)) {
      throw new DeveloperError("canvas is required.");
    }

    if (!("gpu" in navigator)) {
      throw new RendererInitializationError(
        "availability",
        "WebGPU is not supported in this browser. " +
          "Please use a browser with WebGPU support (Chrome 113+, Edge 113+) " +
          'or set renderer to "webgl" or "auto".',
      );
    }
    //>>includeEnd('debug');

    let context: WebGPUContext | undefined;
    try {
      context = new WebGPUContext(canvas, options);
      await context._initialize();
      context._registerWithRegistry();
      return context;
    } catch (error) {
      // Roll back every resource/refcount acquired before the failure. The
      // context was never registered, so destroy's unregister is a no-op.
      context?.destroy();
      throw error;
    }
  }

  /**
   * Initializes the WebGPU device and canvas context.
   *
   * @private
   * @returns {Promise<void>}
   * @throws {RuntimeError} If initialization fails
   */
  private async _initialize(): Promise<void> {
    try {
      // AUDIT_2026_05_02 C.1 (Batch 135) — adapter + device acquisition
      // routes through `WebGPUDevicePool`. The pool owns the adaptive
      // limit + feature negotiation that used to live inline here:
      // it inspects the adapter's exposed ceilings, scales requested
      // limits up (capped at sane upper bounds), merges
      // `WebGPUFeatureFlags.DESIRED_FEATURES` with user-supplied
      // `requiredFeatures`, and returns the freshly-created (or shared)
      // device.
      //
      // Multi-canvas scenarios (split-screen, multi-monitor,
      // picture-in-picture) automatically share a GPUDevice when their
      // feature + limit requirements are compatible — saving ~50% of
      // VRAM on duplicated pipelines / textures. Single-context users
      // get the same code path; the pool just creates a fresh device
      // and hands it back.
      //
      // Set `options.useDevicePool = false` to opt out (forces a fresh
      // device for this context regardless of pool state). Default true.
      const useDevicePool = this._options.useDevicePool !== false;
      const acquired = await WebGPUDevicePool.instance.acquireDevice({
        powerPreference: this._options.powerPreference ?? "high-performance",
        featureLevel: this._options.featureLevel,
        requiredFeatures: this._options.requiredFeatures,
        requiredLimits: this._options.requiredLimits,
        forceNewDevice: !useDevicePool,
        // C10-06 Step B: hand the pre-kicked adapter request to the pool so
        // negotiation that started during chunk parse is reused instead of
        // re-requested serially. Pool falls back on any mismatch/rejection.
        prefetchedAdapter: this._options.prefetchedAdapter,
      });

      this._adapter = acquired.adapter;
      this._device = acquired.device;
      retainEffectsPlaceholderCacheForContext(this._device, this);
      // Track whether we pulled a shared device or got our own — this
      // flag drives the destroy path's choice between `pool.releaseDevice`
      // (refcount-aware) and a direct `device.destroy()` (only safe if
      // we own the device exclusively).
      this._deviceFromPool = true;

      if (!this._adapter) {
        throw new RendererInitializationError(
          "adapter",
          "Failed to get WebGPU adapter. " +
            "WebGPU may not be properly supported on this device.",
        );
      }

      // Record which features were actually enabled (Batch 132).
      this._featureFlags.markEnabled(this._device.features);

      // Log enabled optional features for debugging. Pull the list from
      // the device's actual `features` set so the message reflects what
      // the pool's negotiator + adapter granted (which may differ from
      // user-requested features when the adapter doesn't support all of
      // them).
      const enabledFeatures = Array.from(this._device.features) as string[];
      //>>includeStart('debug', pragmas.debug);
      if (enabledFeatures.length > 0) {
        console.log(
          `[WebGPU] Enabled optional features: ${enabledFeatures.join(", ")}` +
            (acquired.isShared ? " (shared device)" : " (own device)"),
        );
      }
      //>>includeEnd('debug');

      // Wrap createShaderModule to automatically validate compilation.
      // Every shader across the entire renderer gets async error logging
      // without modifying individual call sites. Compilation errors are
      // logged to the console immediately instead of silently poisoning
      // downstream pipelines and command buffers.
      this._installShaderValidation(this._device);

      // Populate the resource-cache registry so device-loss recovery's
      // first `_clearAllCaches()` call sees a fully-wired registry.
      // (Batch 131.)
      this._registerResourceCaches();

      // Capture this context generation's immutable device capabilities.
      this._initializeContextLimits();

      // Update capability flags based on enabled features
      this._updateFeatureFlags();

      // WGF-6: Cache the primitive_index utility module so backend-agnostic
      // Scene code can probe support without importing from Renderer/WebGPU.
      // C10-06 Step A: assigned synchronously from the static import above —
      // the former inline `await import(...)` serialized an extra module
      // round-trip into every boot for a dependency-free utility. Consumers
      // (`supportsTriangulationDebug`, :1734) already tolerate a null cache.
      this._primitiveIndexUtilsCache = WebGPUPrimitiveIndexUtils;

      // Configure canvas context
      this._context = this._canvas.getContext("webgpu") as GPUCanvasContext;

      if (!this._context) {
        throw new RuntimeError("Failed to get WebGPU canvas context.");
      }

      // Get preferred format
      this._presentationFormat = navigator.gpu.getPreferredCanvasFormat();

      // Configure the canvas. HDR-DISPLAY (Batch 206) — `_hdrCanvasOutput`
      // is false by default at init; the helper still routes through
      // here so a follow-up `setHDRCanvasOutput(true)` and the helper
      // share one configure path. Batch 213 (B206-N1 audit fix) routes
      // through `_applyCanvasConfig` for browser-compat fallback.
      this._applyCanvasConfig();

      // Initialize default textures
      this._initializeDefaultTextures();

      // Initialization complete — adapter and format selected
      const level = this._options.featureLevel ?? "core";
      this.log(
        "info",
        `Initialized (featureLevel: ${level}, adapter: ${this._adapter?.info?.vendor ?? "unknown"})`,
      );

      // Register all WebGPU feature renderers so scene files can access them
      // via context.getFeatureRenderer('name') instead of importing directly
      registerWebGPUFeatureRenderers(this);

      // C10-06 Step A (INV-06-6): the former `initPrimitiveShaders` /
      // `initCollectionShaders` awaits were removed. Both bodies are no-ops
      // (`WebGPUPrimitiveShaders.js:246` / `WebGPUCollectionShaders.js:66` —
      // "shaders are statically imported and always available"), so awaiting
      // them only added two dead microtask turns to the boot critical path.

      // Pipeline warm-up: proactively initialize common renderers to avoid
      // first-frame stutter from synchronous pipeline compilation.
      this._warmUpPipelines();

      // Install loss handling only after every fallible initialization stage
      // has committed. A failed create therefore leaves no device-loss
      // callback retaining the rejected context on a shared pooled device.
      this._setupDeviceLostHandler();
    } catch (error) {
      if (error instanceof RendererInitializationError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new RendererInitializationError(
        "context",
        `Failed to initialize WebGPU context: ${message}`,
        error,
      );
    }
  }

  /**
   * Proactively initialize common renderers to avoid first-frame pipeline stutter.
   * Fires-and-forgets — initialization happens in background.
   * @private
   */
  private _warmUpPipelines(): void {
    // Batch 71 — globe-surface warmup removed (was dead code).
    //
    // Previously this method did:
    //   globeFR._instance = new globeFR.RendererClass(this);
    //
    // intending to pre-compile the terrain shader module + pipeline
    // layout. But the actual render path in
    // `GlobeSurfaceTileProviderRendering.addWebGPUDrawCommandsForTile`
    // creates its OWN per-device renderer instance via a module-scoped
    // `_webgpuGlobeRenderers` WeakMap and calls `.initialize(device,
    // shaderCode, fmt)` on it. The `globeFR._instance` created here was
    // never reached at render time, AND the constructor alone doesn't
    // perform any GPU work (it just allocates a Float32Array scratch).
    // So the warmup achieved nothing for globe.
    //
    // C10-06 Step C.1 — the fix is now wired. `warmUpGlobeRenderer` (a
    // top-level export in `GlobeSurfaceTileProviderRendering.js`) populates the
    // module-scoped `_webgpuGlobeRenderers` WeakMap and calls `.initialize`,
    // which runs the 2-variant GlobeTerrain shader-module prewarm during this
    // idle init window instead of on the first tile draw (measured ~176 ms
    // `rendererReady→firstFrame` on WebGPU vs ~16 ms WebGL — the +146-200 ms
    // stall the comment below wrongly called "below the perceptible
    // threshold"). Fire-and-forget via a dynamic import so this never blocks
    // `_initialize` from returning and never introduces an eager Renderer→Scene
    // cycle (INV-06-2). Every failure mode is caught and dropped — the lazy
    // first-frame path stays correct.
    void import("../../Scene/GlobeSurfaceTileProviderRendering.js")
      .then((m) => {
        m.warmUpGlobeRenderer(this);
      })
      .catch(() => {
        /* prewarm is best-effort — the lazy first-frame path still works */
      });
    //
    // AUDIT_2026_05_02 C.2 (Batch 135) — eager `void this.gpuCuller`
    // trigger removed. The lazy getter remains; consumers wired in
    // Batches 209-211 trigger initialization on first use. Eager
    // warm-up is now opt-in via `warmUpHighDensityDispatchers()`
    // (Batch 215) so users with known-dense scenes can amortize the
    // pipeline-compile cost into a load frame.
  }

  /**
   * Batch 215 — proactively initialize the three high-density GPU
   * dispatchers (gpuCuller, HiZ occlusion, GPUSortKeys) so their
   * compute-shader pipeline compiles + buffer allocations happen
   * during scene load instead of the first frame where command count
   * crosses the activation threshold. Without this warm-up the first
   * threshold crossing hitches by 5-50 ms (compile + alloc).
   *
   * Triggered by `Scene.gpuCullingHint = 'always'`. The contained
   * default is 'never'; 'auto' remains an explicit characterization
   * mode for users who anticipate >10K visible commands.
   *
   * Fire-and-forget: each dispatcher's init is async; failures are
   * non-fatal (lazy path still works).
   *
   * @param hintViewportWidth  expected canvas width for HiZ pyramid
   *    sizing. Pass the current `drawingBufferWidth` if you have it;
   *    HiZ resizes when the actual canvas changes.
   * @param hintViewportHeight expected canvas height for HiZ pyramid
   * @param hintMaxCommands    expected peak opaque command count
   *    (sets the buffer capacity for all three dispatchers).
   */
  /**
   * B219-N3 (Batch 225 audit fix) — Scene-level GPU culling hint
   * mirror. Called by `Scene.gpuCullingHint` setter.
   *
   * When set to `'never'`:
   *   - Lazy getters refuse to allocate new culler instances.
   *   - Any existing aux-culler instances are immediately reaped
   *     (B225-N1 audit fix, Batch 230) instead of waiting up to
   *     10 seconds for the idle-decay sweep (Batch 229). The user
   *     explicitly opted out — honor that immediately.
   *
   * Mid-render reap is safe because the next render frame's
   * gate-update reads the hint and short-circuits to false, so the
   * filter chain skips even if the prior frame's commands were
   * sized to a now-destroyed buffer.
   */
  public setGpuCullingHint(hint: "auto" | "always" | "never"): void {
    const prev = this._gpuCullingHint;
    this._gpuCullingHint = hint;
    if (hint === "never" && prev !== "never") {
      this._reapAllAuxCullers();
    }
  }

  /**
   * B225-N1 (Batch 230 audit fix) — destroy every auxiliary culler
   * instance immediately. Used by `setGpuCullingHint('never')` to
   * honor the opt-out without waiting for idle-decay. Distinct from
   * `_reapIdleAuxCullers` (Batch 229) which is selective by
   * last-used age.
   */
  private _reapAllAuxCullers(): void {
    // Body extracted to `WebGPUContextCullerPool.ts` (Q35 slice).
    reapAllAuxCullersExt(this);
  }

  public get gpuCullingHint(): "auto" | "always" | "never" {
    return this._gpuCullingHint;
  }

  public warmUpHighDensityDispatchers(
    hintViewportWidth: number = 1920,
    hintViewportHeight: number = 1080,
    hintMaxCommands: number = 16384,
  ): void {
    if (!this._device || this._isDeviceUnavailable) return;
    // B219-N3 — refuse warm-up when the hint forbids it. Symmetric
    // with the lazy-getter guards so both eager + lazy paths agree.
    if (this._gpuCullingHint === "never") return;

    // gpuCuller — touching the getter triggers the dynamic import +
    // pipeline compile. Errors are caught inside the getter chain.
    void this.gpuCuller;
    // B215-N2 (Batch 219 audit fix) — warm the dedicated translucent
    // culler too. Without this, the first activation of the
    // translucent path still pays the 5-50 ms compile hitch even
    // though the user opted into eager warm-up.
    void this.gpuCullerTranslucent;
    // Batch 220 — per-frustum opaque cullers (1..3 typical) so a
    // multi-frustum log-depth scene doesn't hitch as later frustums
    // first activate.
    for (let i = 1; i < 4; i++) {
      this.getGPUCullerForOpaqueFrustum(i);
    }
    // Batch 221 — per-cascade shadow cullers (4 typical CSM
    // cascades). No-op until Phase 2 activation but the compile
    // cost amortizes here regardless.
    for (let i = 0; i < 4; i++) {
      this.getGPUCullerForCascade(i);
    }

    // HiZ — call the FR init directly with the hint dimensions.
    const hizFR = this.getFeatureRenderer(
      FeatureRendererKey.HI_Z_OCCLUSION,
    ) as { init?: (w: number, h: number, max: number) => boolean } | null;
    try {
      hizFR?.init?.(hintViewportWidth, hintViewportHeight, hintMaxCommands);
    } catch (e) {
      //>>includeStart('debug', pragmas.debug);
      this.log(
        "warn",
        `HiZ warm-up failed (lazy path will still work on demand): ${(e as Error).message}`,
      );
      //>>includeEnd('debug');
    }

    // GPUSortKeys — same shape, single-arg init.
    const sortFR = this.getFeatureRenderer(
      FeatureRendererKey.GPU_SORT_KEYS,
    ) as { init?: (max: number) => boolean } | null;
    try {
      sortFR?.init?.(hintMaxCommands);
    } catch (e) {
      //>>includeStart('debug', pragmas.debug);
      this.log(
        "warn",
        `GPUSortKeys warm-up failed (lazy path will still work on demand): ${(e as Error).message}`,
      );
      //>>includeEnd('debug');
    }
  }

  /**
   * Initialize default textures (white, black, normal, cubemap)
   * @internal
   */
  // Public underscore: shared with the device-loss host-adapter (Batch 143).
  public _initializeDefaultTextures(): void {
    if (!this._device) {
      return;
    }

    // Build the full replacement set off to the side. A pooled candidate may
    // remain alive for another Context after this recovery attempt fails, so
    // relying on candidate-device destruction to reclaim a half-built set is
    // not sufficient.
    const created: WebGPUTexture[] = [];
    let whiteTex: WebGPUTexture;
    let blackTex: WebGPUTexture;
    let normalTex: WebGPUTexture;
    let cubeTex: WebGPUTexture;
    try {
      const whiteData = new Uint8Array([255, 255, 255, 255]);
      whiteTex = WebGPUTexture.create2D(
        this._device,
        1,
        1,
        "rgba8unorm",
        1,
        "Default White Texture",
      );
      created.push(whiteTex);
      whiteTex.write(whiteData, 1, 1);

      const blackData = new Uint8Array([0, 0, 0, 255]);
      blackTex = WebGPUTexture.create2D(
        this._device,
        1,
        1,
        "rgba8unorm",
        1,
        "Default Emissive Texture",
      );
      created.push(blackTex);
      blackTex.write(blackData, 1, 1);

      // Normal = (0.5, 0.5, 1.0) in RGB space.
      const normalData = new Uint8Array([128, 128, 255, 255]);
      normalTex = WebGPUTexture.create2D(
        this._device,
        1,
        1,
        "rgba8unorm",
        1,
        "Default Normal Texture",
      );
      created.push(normalTex);
      normalTex.write(normalData, 1, 1);

      cubeTex = WebGPUTexture.createCubeMap(
        this._device,
        1,
        "rgba8unorm",
        1,
        "Default Cube Map",
      );
      created.push(cubeTex);
      for (let face = 0; face < 6; face++) {
        cubeTex.write(whiteData, 1, 1, face);
      }
    } catch (error) {
      for (let i = created.length - 1; i >= 0; i--) {
        try {
          created[i].destroy();
        } catch {
          // Preserve the initialization failure; candidate cleanup continues.
        }
      }
      throw error;
    }

    const previous = [
      this._defaultTexture,
      this._defaultEmissiveTexture,
      this._defaultNormalTexture,
      this._defaultCubeMap,
    ];
    this._defaultTexture = whiteTex;
    this._defaultEmissiveTexture = blackTex;
    this._defaultNormalTexture = normalTex;
    this._defaultCubeMap = cubeTex;
    for (const texture of previous) {
      texture?.destroy();
    }
  }

  // GraphicsContext interface implementation

  /**
   * The renderer type for this context
   */
  get rendererType(): RendererType {
    return this._options.featureLevel === "compatibility"
      ? RendererType.WEBGPU_COMPAT
      : RendererType.WEBGPU;
  }

  /**
   * The WebGPU feature level: "core" or "compatibility"
   */
  get featureLevel(): string {
    return this._options.featureLevel ?? "core";
  }

  /**
   * Item 1.2 (IBL-HDR, Batch 426). When true, the dynamic environment
   * map allocates its source cube + procedural-sky storage texture as
   * `rgba16float`. Default `false` → `rgba8unorm` (WebGL-parity, byte-
   * identical). Read by `WebGPUDynamicEnvironmentMapManager`.
   */
  get hdrEnvironmentMap(): boolean {
    return this._options.webgpu?.hdrEnvironmentMap ?? false;
  }

  /**
   * Item 1.3 (IBL-PREFILTER-HQ, Batch 426). `'parity'` (default) samples
   * the source cube at mip 0 in the radiance prefilter; `'high'` builds a
   * source mip chain and samples a GGX-pdf-derived LOD. Read by
   * `WebGPUDynamicEnvironmentMapManager` / `WebGPUIBLPipeline`.
   */
  get iblPrefilterQuality(): "parity" | "high" {
    return this._options.webgpu?.iblPrefilterQuality ?? "parity";
  }

  /**
   * Item 2.2 (ENV-AERIAL-MS, Batch 430). When true, the dynamic
   * environment-map procedural sky fill AND the aerial-perspective
   * post-process source their sky radiance from the sun-relative sky-view +
   * multiple-scattering LUTs (the same tables the visible SkyAtmosphere
   * samples) instead of their own inline single-scatter approximations, so
   * reflected sky (env cube → model IBL) and hazed distance (aerial
   * perspective) match the visible MS sky. Default `false` keeps both
   * shaders' inline ports verbatim (byte-identical). Read by
   * `WebGPUDynamicEnvironmentMapManager` + `WebGPUPostProcessStageCollection`.
   */
  get envMapMultiScatter(): boolean {
    return this._options.webgpu?.envMapMultiScatter ?? false;
  }

  /**
   * C2-25 ENV-SCENE-CAPTURE (Batch 446). When true (AND a
   * `DynamicEnvironmentMapManager` opts in via `enableSceneCapture`), the
   * dynamic env cube refresh renders the opaque globe surface into its 6 faces
   * from 6 ENU cube-face cameras so terrain reflects in water / PBR models.
   * Default `false` keeps the env cube filled by the procedural sky alone
   * (byte-identical to the shipped parity path; zero extra GPU passes). Read by
   * `WebGPUDynamicEnvironmentMapManager`.
   */
  get sceneCaptureReflections(): boolean {
    return this._options.webgpu?.sceneCaptureReflections ?? false;
  }

  /**
   * C2-25 ENV-TEMPORAL (Batch 449). When true, the dynamic env cube refresh
   * temporally accumulates: a history cube + an exponential-moving-average
   * blend pass is inserted between the cube capture and the IBL prefilter, so
   * the env map crossfades smoothly on small sun/camera change and the 6-face
   * capture amortizes across frames (resetting history on a large sun/camera
   * delta so it can't smear). Default `false` allocates no history cube and
   * runs no blend pass — byte-identical to the shipped parity path. Read by
   * `WebGPUDynamicEnvironmentMapManager`.
   */
  get envMapTemporalAccumulation(): boolean {
    return this._options.webgpu?.envMapTemporalAccumulation ?? false;
  }

  /**
   * C2-25 item 3-C ENV-CLOUDS / CLOUD-IBL-FULL (Batch 450). When true, the
   * dynamic env cube's procedural sky fill runs a LOW-RES per-face procedural
   * cloud raymarch and composites it over the sky before the IBL prefilter, so
   * a cloudy/overcast sky produces a genuinely cloudier reflection + diffuse
   * IBL (visible cloud structure), not just the 4.2 coarse darkening. Pairs
   * with `envMapTemporalAccumulation` to smooth the march over frames. Default
   * `false` binds placeholder noise and never takes the march branch
   * (byte-identical). Read by `WebGPUDynamicEnvironmentMapManager`.
   */
  get cloudsInReflections(): boolean {
    return this._options.webgpu?.cloudsInReflections ?? false;
  }

  /**
   * The canvas element associated with this context
   */
  get canvas(): HTMLCanvasElement {
    return this._canvas;
  }

  /**
   * The width of the drawing buffer
   */
  get drawingBufferWidth(): number {
    return this._canvas.width;
  }

  /**
   * The height of the drawing buffer
   */
  get drawingBufferHeight(): number {
    return this._canvas.height;
  }

  /**
   * Whether the context supports depth textures (always true for WebGPU)
   */
  get depthTexture(): boolean {
    return true;
  }

  /**
   * Whether the context supports fragment depth (always true for WebGPU)
   */
  get fragmentDepth(): boolean {
    return true;
  }

  /**
   * WebGPU uses 0-to-1 depth range (unlike WebGL's -1 to 1).
   * Scene code uses this to set Matrix4 depth range type.
   */
  override get depthRangeZeroToOne(): boolean {
    return true;
  }

  /**
   * WebGPU needs the `SCENE_RENDERER` FR to be registered — it owns the
   * offscreen framebuffer + post-process composite that blits the scene
   * to the canvas surface texture. Without the FR the canvas is black.
   */
  override get requiresSceneRenderer(): boolean {
    return true;
  }

  /**
   * WebGPU's optional `WebGPUCSMRenderer` owns cascade textures, matrices, and
   * per-cascade dispatch; `WebGPUShadowMapRenderer` renders the non-CSM default
   * (`useCascadedShadowMaps === false`) into one depth target. Both consume the
   * caster set `collectUniqueShadowCastCommands` unions across
   * `ShadowMap.passes`, so the legacy pass count is irrelevant to them — what
   * they read from the scene `ShadowMap` is pass 0's camera (cast transform)
   * and `_shadowMapMatrix` (receive transform). See the base-class doc: the
   * scene `ShadowMap` keeps `cascadesEnabled: true` here as it does on WebGL.
   */
  override get managesSceneShadowCascadesNatively(): boolean {
    return true;
  }

  /**
   * AUDIT_2026_05_02 — WebGPU has no `GPUBuffer.getBufferData()` analog.
   * Consumers (Model renderer, EdgeVisibility stage, b3dm path) must
   * read vertex data from the loader's typed-array cache rather than
   * via a back-channel from the GPU buffer. Replaces the scattered
   * `frameState.context.isWebGPU === true` checks in `GltfLoader.js`
   * and `EdgeVisibilityPipelineStage.js`.
   */
  override get requiresVertexTypedArrayRetention(): boolean {
    return true;
  }

  /**
   * AUDIT_2026_05_02 — WebGPU has no `SunPostProcess` class.
   * Sun bloom on WebGPU is handled by `WebGPUPostProcessPipeline`
   * (Bloom + LensFlare). Replaces the `isWebGPU` allocation guard
   * in `FramebufferOrchestrator.js`.
   */
  override get supportsLegacySunBloom(): boolean {
    return false;
  }

  /**
   * WebGPU has no synchronous pixel readback — `readPixels` is a shim that
   * returns `null` (see below); real readback is async (`readPixelsToPBO` +
   * `mapAsync`). Overrides the base `true` so call sites that previously used
   * `defined(context.readPixels)` as a "is WebGL" proxy (PickDepth,
   * InstancingPipelineStage) correctly take their async / keep-typed-array
   * branch on WebGPU.
   */
  override get supportsSynchronousReadback(): boolean {
    return false;
  }

  /**
   * Cloud-unification epic — per-frame volumetric cloud request published by a
   * `CloudCollection` whose `renderMode` is `VOLUMETRIC`. Stored here for the
   * env-effects phase to consume. `undefined` when no collection requested a
   * deck this frame. Nothing reads it yet (scaffold slice).
   */
  private _volumetricCloudRequest?: VolumetricCloudRequest;

  /**
   * Store this frame's volumetric cloud config (first VOLUMETRIC collection
   * wins — the primary deck; later requests this frame are ignored). Overrides
   * the base no-op so scene code can publish unconditionally without branching
   * on `isWebGPU`. See migration_doc/CLOUD_UNIFICATION_DESIGN.md §1.3.
   */
  override requestVolumetricClouds(config: VolumetricCloudRequest): void {
    if (this._volumetricCloudRequest === undefined) {
      this._volumetricCloudRequest = config;
    }
  }

  /**
   * Non-consuming scheduling signal for the scene renderer. A user-owned
   * VOLUMETRIC collection may be the only visible content in a frame, so its
   * pending request must keep the post-frustum environmental chain alive even
   * when no geometry command produced a frustum.
   */
  override get hasVolumetricCloudRequest(): boolean {
    return this._volumetricCloudRequest?.enabled === true;
  }

  /**
   * Retrieve and clear the frame's volumetric cloud request. Called by the
   * env-effects consumer once per frame; clearing here means a collection that
   * stops publishing (mode flipped back to BILLBOARD, or destroyed) correctly
   * yields no deck the next frame.
   */
  override consumeVolumetricCloudRequest(): VolumetricCloudRequest | undefined {
    const request = this._volumetricCloudRequest;
    this._volumetricCloudRequest = undefined;
    return request;
  }

  /**
   * NEW-PICK-WEBGPU-DEPTH-RECONSTRUCTION (Batch 252) — the single packed
   * pick-depth texture (`WebGPUGlobeDepth.globeDepthTexture`, shared across
   * all frustum slices) carries full-frustum LOG depth whenever the
   * renderer-wide log-depth master switch is on (Batch 251 default). Mirrors
   * `_logDepthWriteEnabled` so flipping the kill switch automatically returns
   * `Picking` to its SAFE undefined → ray-pick fallback (the per-slice
   * hyperbolic depth written with the switch off has no consistent
   * single-texture reconstruction).
   */
  override get pickDepthFullFrustumLogEncode(): boolean {
    return this._logDepthWriteEnabled;
  }

  /**
   * AUDIT_2026_05_02 — WebGPU scene renderer hard-codes the full-canvas
   * viewport (`setViewport(0, 0, _width, _height)`); the per-eye split
   * `executeWebVRCommands` performs has no effect. Until the per-eye
   * viewport plumb lands, fail loudly when `scene.useWebVR = true`
   * rather than silently producing single-eye output. Replaces the
   * `isWebGPU` guard in `Scene.useWebVR` setter.
   */
  override get supportsStereoViewport(): boolean {
    return false;
  }

  /**
   * WebGPU exposes the primitive index-utils compute module that drives
   * `scene.triangulationDebug`. True when both the device and the utils
   * module are ready; false during the pre-init window.
   */
  override get supportsTriangulationDebug(): boolean {
    const utils = this._primitiveIndexUtilsCache as
      { isSupported?: (device: GPUDevice) => boolean } | undefined;
    return this._device !== null && utils !== undefined && !!utils.isSupported;
  }

  // ═══════════════════════════════════════════════════════════
  // COMPUTE SHADER CAPABILITY OVERRIDES
  //
  // WebGPU has full native compute shader support. These overrides
  // report the actual device limits so scene code can make informed
  // decisions about dispatch sizes, workgroup counts, and whether
  // to use GPU compute vs CPU/WASM fallbacks.
  // ═══════════════════════════════════════════════════════════

  /**
   * WebGPU natively supports real GPU compute shaders.
   * Always true when a valid device exists.
   */
  override get supportsComputeShaders(): boolean {
    return this._device !== null;
  }

  /**
   * WebGPU supports indirect compute dispatch via `dispatchWorkgroupsIndirect()`.
   * This enables fully GPU-driven pipelines where workgroup counts come from
   * a GPU buffer rather than CPU-specified values.
   */
  override get supportsIndirectCompute(): boolean {
    return this._device !== null;
  }

  /**
   * WebGPU natively supports storage buffers (`storage` binding type).
   * Storage buffers allow compute/vertex/fragment shaders to read/write
   * large structured data (up to `maxStorageBufferBindingSize`, typically 128+ MB).
   */
  override get supportsStorageBuffers(): boolean {
    return this._device !== null;
  }

  /**
   * Maximum workgroups per dispatch dimension from the GPUDevice limits.
   * Typically 65535 on most GPUs.
   */
  override get maxComputeWorkgroupsPerDimension(): number {
    return this._device?.limits?.maxComputeWorkgroupsPerDimension ?? 0;
  }

  /**
   * Maximum total invocations per workgroup from the GPUDevice limits.
   * Typically 256 on most GPUs.
   */
  override get maxComputeInvocationsPerWorkgroup(): number {
    return this._device?.limits?.maxComputeInvocationsPerWorkgroup ?? 0;
  }

  /**
   * Maximum shared (workgroup) memory in bytes from the GPUDevice limits.
   * Typically 16384 bytes on most GPUs.
   */
  override get maxComputeWorkgroupStorageSize(): number {
    return this._device?.limits?.maxComputeWorkgroupStorageSize ?? 0;
  }

  /**
   * Whether the context has been destroyed. Method (not getter) form to
   * match the upstream CesiumJS convention used everywhere else — also
   * compatible with `destroyObject.js`, which overwrites `.isDestroyed`
   * with a `returnTrue` function on destroyed objects.
   */
  isDestroyed(): boolean {
    return this._isDestroyed;
  }

  /** Rendering is unavailable before or after physical context teardown. */
  private get _isDeviceUnavailable(): boolean {
    return this._isDestroyed || this._isTerminallyLost;
  }

  /**
   * Gets the WebGPU device
   * @returns {GPUDevice | null} The GPU device
   */
  get device(): GPUDevice | null {
    return this._device;
  }

  /**
   * Gets the WebGPU adapter
   * @returns {GPUAdapter | null} The GPU adapter
   */
  get adapter(): GPUAdapter | null {
    return this._adapter;
  }

  /**
   * Gets the presentation format
   * @returns {GPUTextureFormat} The texture format
   */
  get presentationFormat(): GPUTextureFormat {
    return this._presentationFormat;
  }

  /**
   * Begin a new frame - creates the command encoder and acquires the canvas
   * swap-chain view. The default canvas render pass is NOT opened here
   * (C9-07 / FAR-405-C0): it opens on first demand — a consumer calling
   * `resumeDefaultRenderPass()`/`_beginDefaultRenderPass()`, a canvas draw
   * via `executeDrawCommand`, or the `endFrame` clear/present fallback for
   * frames where nothing else touches the canvas. The first open of a
   * frame clears each untouched channel, so the historical
   * clear-once-then-load sequence is preserved exactly.
   *
   * Use `beginRenderPass()` to start additional render passes within the frame
   * (e.g., for shadow maps, pick framebuffers, post-processing).
   *
   * Frame lifecycle:
   * ```
   * beginFrame()          — creates command encoder + acquires swap view
   *   beginRenderPass(desc)    — start a pass (e.g., scene FB, shadow, pick)
   *   draw commands...
   *   endCurrentRenderPass()
   *   resumeDefaultRenderPass() — open/resume the canvas pass on demand
   *   ...
   * endFrame()            — ends any active pass, presents (clearing) if the
   *                         canvas was never touched, + submits the buffer
   * ```
   */
  beginFrame(): void {
    if (this._isDeviceUnavailable) {
      //>>includeStart('debug', pragmas.debug);
      throw new DeveloperError(
        this._isDestroyed
          ? "Context has been destroyed."
          : "Context's WebGPU device is terminally lost.",
      );
      //>>includeEnd('debug');
      return;
    }

    if (!this._device || !this._context) {
      return;
    }

    // A truncated prior frame must not strand readback promises. Normal frames
    // drain this list immediately after queue.submit in endFrame().
    this._drainAfterFrameSubmitCallbacks(false);

    // Reset frame statistics
    this._drawCallCount = 0;
    this._triangleCount = 0;
    this._frameCount++;
    this._environmentDemandRegistry.beginFrame(this._deviceResourceGeneration);
    this._clearCallsThisFrame = 0;
    this._clearOverflowWarned = false;
    this._shadowReceiveUniformRefreshes.length = 0;
    this._shadowReceiveUniformRefreshSet.clear();

    // C9-07 / FAR-405-C0 — reset the canvas demand flags + pass target.
    // Reset here (and in beginPickFrame), never in endFrame — see the
    // field docs.
    this._activePassTarget = null;
    this._canvasColorTouchedThisFrame = false;
    this._canvasDepthTouchedThisFrame = false;
    // C10-03 — a fresh frame starts with no valid resolved scene color.
    this._sceneColorResolvePending = true;

    // Advance ring buffer allocator to next page
    if (this._uniformAllocator) {
      this._uniformAllocator.beginFrame();
    }

    // NEW-AUX-CULLER-IDLE-DECAY (Batch 229) — bump internal frame
    // counter + periodically prune idle auxiliary culler instances.
    // The check runs every `IDLE_DECAY_CHECK_INTERVAL` frames so the
    // walk cost amortizes to ~zero per frame.
    this._internalFrameId++;
    if (this._internalFrameId % WebGPUContext.IDLE_DECAY_CHECK_INTERVAL === 0) {
      this._reapIdleAuxCullers();
    }

    // Create command encoder for this frame
    this._currentCommandEncoder = this._device.createCommandEncoder({
      label: "Scene Frame Command Encoder",
    });

    // Timestamp profiling is opt-in. If the performance manager already
    // exists, begin before opening the default pass so the first pass is not
    // omitted from the sample. The manager method is idempotent because the
    // scene renderer also enters its broader per-frame lifecycle later.
    this._performanceManager?.beginTimestampFrame();

    // Get current canvas texture
    const canvasTexture = this._context.getCurrentTexture();
    this._currentTextureView = canvasTexture.createView();

    // Create or recreate depth texture if needed
    this._ensureDepthTexture();

    // C9-07 / FAR-405-C0 — the default (canvas) render pass is no longer
    // opened here. On the default route the scene renderer immediately
    // redirected to the scene framebuffer, making this an empty pass
    // (2/frame measured empty on the moving route, C9-05 API lane); it
    // now opens on first demand and `endFrame` presents a cleared canvas
    // for frames where no consumer touches it.

    // NEW-WEBGPU-UNIFORMSTATE-VIEWPORT (Batch 368, item 371): seed
    // uniformState.viewport once per frame. The WebGL path seeds it in
    // RenderState.applyViewport (alongside gl.viewport); the WebGPU path never
    // did, so uniformState.viewportOrthographic / viewportTransformation stayed
    // at IDENTITY and every screen-space WGSL shader had to hand-build them
    // from drawingBufferWidth/Height. Seeding here makes the canonical
    // UniformState getters correct for ALL screen-space WebGPU shaders.
    // UniformState owns this context's immutable ClipSpaceConvention, so the
    // lazy viewport-orthographic matrix uses WebGPU's 0..1 depth range without
    // any process-global renderer ordering. The setter only reads
    // x/y/width/height, so a plain object literal suffices.
    this._uniformState.viewport = {
      x: 0,
      y: 0,
      width: this.drawingBufferWidth,
      height: this.drawingBufferHeight,
    };
  }

  /**
   * Begin a command encoder for an OFF-SCREEN mini-frame (pick / metadata
   * pick) that runs OUTSIDE the normal `render()` path.
   *
   * `Scene.pick`/`pickAsync` render via `pickBegin → updateAndExecuteCommands`,
   * which never calls {@link WebGPUContext#beginFrame} — so there is no command
   * encoder, and the WebGPU pick pass (`executePickPass`) would early-return on
   * the missing encoder, leaving the pick framebuffer empty (every pick returns
   * `undefined` — FORK-34). This creates just the encoder + advances the uniform
   * ring-buffer page (the non-canvas half of `beginFrame`); it deliberately
   * does NOT acquire the canvas texture or open the default canvas render pass
   * (the pick pass renders to the pick FBO and manages its own pass). The
   * matching submit/finalize is `pickEnd → context.endFrame()`. No-op if an
   * encoder already exists (e.g. re-entrant call within one pick).
   */
  beginPickFrame(): void {
    if (
      this._isDeviceUnavailable ||
      !this._device ||
      this._currentCommandEncoder
    ) {
      return;
    }
    // C9-07 / FAR-405-C0 — pick mini-frames never acquire the swap view,
    // so the endFrame present fallback (gated on `_currentTextureView`)
    // can never fabricate a canvas pass here. Reset the tracking state
    // anyway so a stale target from a truncated frame can't leak in.
    //
    // C9-AUDIT-P1-SWEEP (Batch 684) edge (b): if a render frame still holds
    // the swap view (its endFrame has not run), its canvas-touched flags
    // describe the PP-blit that already wrote the canvas this frame — a pick
    // mini-frame must NOT wipe them, or the render's present fallback would
    // re-clear the blit. Only reset the demand flags for a standalone pick.
    const renderFrameInFlight = this._currentTextureView !== null;
    if (!renderFrameInFlight) {
      this._shadowReceiveUniformRefreshes.length = 0;
      this._shadowReceiveUniformRefreshSet.clear();
    }
    this._activePassTarget = null;
    // C10-03 — pick mini-frames render to a single-sample pick FBO, so the
    // ensure helper is inert (I5); reset conservatively regardless.
    this._sceneColorResolvePending = true;
    if (!renderFrameInFlight) {
      this._canvasColorTouchedThisFrame = false;
      this._canvasDepthTouchedThisFrame = false;
    }
    // C9-AUDIT-P1-SWEEP (Batch 684) edge (a): drop any swap view a prior
    // (possibly truncated) render frame left behind so a pick pass cannot
    // lazily open the stale canvas view during this mini-frame.
    this._currentTextureView = null;
    if (this._uniformAllocator) {
      this._uniformAllocator.beginFrame();
    }
    this._currentCommandEncoder = this._device.createCommandEncoder({
      label: "Pick Frame Command Encoder",
    });
    this._performanceManager?.beginTimestampFrame();
  }

  /**
   * Establish a queue-ordering boundary before Scene2D renders its second
   * wrapped viewport. Both viewport updates belong to one logical Cesium
   * frame, but several backend resources (including legacy persistent model
   * uniforms) are rewritten in-place by the second update. Submitting the
   * first encoder segment before those writes prevents them from changing
   * data that the first viewport has only recorded, not yet consumed.
   *
   * The frame's swap view, demand flags, uniform-allocation page, timestamp
   * frame, deferred destroys, and after-submit callbacks remain owned by the
   * logical frame. Only the command encoder is rotated. WebGL inherits the
   * no-op implementation from GraphicsContext because its first viewport has
   * already executed when the second update begins.
   */
  override beginSecondaryViewport(): void {
    if (
      this._isDeviceUnavailable ||
      !this._device ||
      !this._currentCommandEncoder
    ) {
      return;
    }

    try {
      this.endCurrentRenderPass();

      // Ring allocations referenced by the first segment must reach the queue
      // before the segment itself. Later allocations stay on the same logical
      // frame page but occupy distinct slices.
      this._uniformAllocator?.flush();

      // Imagery realized during the first viewport must have complete mip
      // chains before that viewport samples it. Keep the established isolated
      // prep submit so a validation failure cannot invalidate the scene work.
      const prepBuffer = this._encodePendingImageryMipJobs();
      if (prepBuffer) {
        this._device.queue.submit([prepBuffer]);
      }

      const firstViewportBuffer = this._currentCommandEncoder.finish();
      this._device.queue.submit([firstViewportBuffer]);
      this._currentCommandEncoder = this._device.createCommandEncoder({
        label: "Secondary Viewport Continuation Encoder",
      });
    } catch (error) {
      // The segment cannot be retried safely after finish/submit starts. Match
      // endFrame's abandonment contract so readback promises and the allocator
      // cannot leak into a future request-render frame.
      this._drainAfterFrameSubmitCallbacks(false);
      this._currentRenderPassEncoder = null;
      this._activePassTarget = null;
      this._currentCommandEncoder = null;
      this._currentTextureView = null;
      this._uniformAllocator?.endFrame();
      throw error;
    }
  }

  /**
   * Starts the default render pass targeting the canvas surface.
   *
   * C9-07 / FAR-405-C0 — no longer called from `beginFrame()`; the canvas
   * pass opens on first demand (`resumeDefaultRenderPass`, the lazy
   * `executeDrawCommand` open, or the `endFrame` present fallback). Load
   * ops derive from the per-frame demand flags: the FIRST open of a frame
   * clears each untouched channel (exactly what the historical beginFrame
   * open did once per frame), every subsequent open loads. Callers no
   * longer choose clear-vs-load — the flags make it deterministic.
   *
   * @param {string} [label] - Pass label; the endFrame present fallback
   *   passes a distinct label so API-lane evidence is self-describing.
   */
  private _beginDefaultRenderPass(
    label: string = "Scene Main Render Pass",
  ): void {
    if (!this._currentCommandEncoder || !this._currentTextureView) {
      return;
    }

    // A pass must never be re-opened on top of an already-active pass. The
    // browser validation layer raises "cannot begin a render pass while
    // another is encoding" asynchronously, which is hard to trace back to
    // the JS caller. In debug builds we throw synchronously with the stack
    // pointing at whoever called us; in release we defensively end the
    // orphan pass so production keeps rendering.
    //>>includeStart('debug', pragmas.debug);
    if (this._currentRenderPassEncoder) {
      throw new DeveloperError(
        `[CesiumJS:webgpu:${this._id}] _beginDefaultRenderPass() called ` +
          `with an active render pass (label='${this._currentRenderPassEncoder.label ?? ""}'). ` +
          `Call endCurrentRenderPass() before opening a new one.`,
      );
    }
    //>>includeEnd('debug');
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
      this._activePassTarget = null;
    }

    // First-open-clears rule (C9-07 / FAR-405-C0): today's frame always
    // cleared these channels exactly once (at beginFrame) and loaded
    // thereafter; deriving from the flags clears each channel exactly once
    // at its first actual open instead. Depth is load-bearing: an
    // untouched depth texture read with "load" yields lazy-zero 0.0, not
    // the historical clear value 1.0, and every depth-tested canvas draw
    // would fail.
    const colorLoadOp: GPULoadOp = this._canvasColorTouchedThisFrame
      ? "load"
      : "clear";
    const depthLoadOp: GPULoadOp = this._canvasDepthTouchedThisFrame
      ? "load"
      : "clear";

    const renderPassDescriptor: GPURenderPassDescriptor = {
      label,
      colorAttachments: [
        {
          view: this._currentTextureView,
          clearValue: {
            r: this._clearColor.red ?? 0.0,
            g: this._clearColor.green ?? 0.0,
            b: this._clearColor.blue ?? 0.0,
            a: this._clearColor.alpha ?? 1.0,
          },
          loadOp: colorLoadOp,
          storeOp: "store",
        },
      ],
      depthStencilAttachment: this._depthTextureView
        ? {
            view: this._depthTextureView,
            depthClearValue: this._clearDepth,
            depthLoadOp: depthLoadOp,
            depthStoreOp: "store",
            stencilClearValue: this._clearStencil,
            stencilLoadOp: depthLoadOp,
            stencilStoreOp: "store",
          }
        : undefined,
    };

    this._currentRenderPassEncoder =
      this._currentCommandEncoder.beginRenderPass(
        this.withRenderPassTimestamps(renderPassDescriptor, label),
      );
    this._activePassTarget = "default-canvas";
    // This pass's store defines the canvas content from here on.
    this._canvasColorTouchedThisFrame = true;
    this._canvasDepthTouchedThisFrame = true;

    // Set default viewport to full canvas size
    this._currentRenderPassEncoder.setViewport(
      0,
      0,
      this._canvas.width,
      this._canvas.height,
      0,
      1,
    );
    this._currentRenderPassEncoder.setScissorRect(
      0,
      0,
      this._canvas.width,
      this._canvas.height,
    );
  }

  /**
   * Begin a new render pass with a custom descriptor.
   *
   * If a render pass is currently active, it will be ended first.
   * This enables multi-pass rendering for:
   * - Shadow map rendering (depth-only pass to shadow texture)
   * - Pick framebuffer rendering (color pass to pick texture)
   * - Post-processing (full-screen quad to intermediate texture)
   * - Translucent rendering (separate pass with different blend state)
   *
   * @param {GPURenderPassDescriptor} descriptor - The render pass descriptor
   * @param {WebGPUPassTarget} [target="external"] - Explicit pass-target
   *   classification (C9-07 / FAR-405-C0). The three scene-FB open sites
   *   declare "scene-framebuffer"; everything else defaults to "external".
   * @returns {GPURenderPassEncoder | null} The new render pass encoder, or null if no command encoder
   *
   * @example
   * // Shadow map pass
   * const shadowPass = context.beginRenderPass({
   *   colorAttachments: [],
   *   depthStencilAttachment: {
   *     view: shadowDepthTextureView,
   *     depthClearValue: 1.0,
   *     depthLoadOp: "clear",
   *     depthStoreOp: "store",
   *   }
   * });
   *
   * // Render shadow casters...
   * context.endCurrentRenderPass();
   *
   * // Resume canvas rendering
   * context.resumeDefaultRenderPass();
   */
  beginRenderPass(
    descriptor: GPURenderPassDescriptor,
    target: WebGPUPassTarget = "external",
  ): GPURenderPassEncoder | null {
    if (!this._currentCommandEncoder) {
      this.log(
        "warn",
        "beginRenderPass: No command encoder — call beginFrame() first",
      );
      return null;
    }

    // Same invariant as `_beginDefaultRenderPass`: opening a pass while
    // another is encoding is a JS-side bug that the browser surfaces only
    // as an async validation error. Throw loudly in debug so the stack
    // points at the caller; fall through to the silent defensive end in
    // release so production keeps rendering.
    //>>includeStart('debug', pragmas.debug);
    if (this._currentRenderPassEncoder) {
      throw new DeveloperError(
        `[CesiumJS:webgpu:${this._id}] beginRenderPass() called with an ` +
          `active render pass (label='${this._currentRenderPassEncoder.label ?? ""}'). ` +
          `Call endCurrentRenderPass() before opening a new one.`,
      );
    }
    //>>includeEnd('debug');

    // End current render pass if one is active
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
      this._activePassTarget = null;
    }

    // Begin the new render pass
    this._currentRenderPassEncoder =
      this._currentCommandEncoder.beginRenderPass(
        this.withRenderPassTimestamps(descriptor),
      );
    this._activePassTarget = target;

    // C10-03-MSAA-BOUNDARY-BYTES — opening a scene-framebuffer segment means
    // new draws will land in the multisampled color attachment, making the
    // single-sample resolve texture stale. Mark it so the next resolved-color
    // consumer's `_ensureSceneColorResolved` performs the (now demand-driven)
    // resolve. This single hook, keyed on the C9-07 pass target, replaces the
    // eager per-`pass.end()` resolve that `getColorAttachments({resolve:false})`
    // removed. Canvas / external / pick passes never dirty scene color.
    if (target === "scene-framebuffer") {
      this._sceneColorResolvePending = true;
    }

    // Canvas-touch MECHANISM (C9-07 / FAR-405-C0): a pass whose color or
    // depth attachment IS the current swap-chain view has, by construction,
    // written canvas content — record it structurally so the next
    // default-pass open loads (never clears) the channel and the endFrame
    // present fallback preserves the blit. This is the belt to the manual
    // `markCanvasContentWritten()` suspenders (still called at every existing
    // site). The scan is over ≤8 attachments — no allocation, no logging.
    const colorAttachments = descriptor.colorAttachments;
    if (defined(colorAttachments)) {
      for (const attachment of colorAttachments) {
        if (
          defined(attachment) &&
          attachment.view === this._currentTextureView
        ) {
          this._canvasColorTouchedThisFrame = true;
          break;
        }
      }
    }
    const depthAttachment = descriptor.depthStencilAttachment;
    if (
      defined(depthAttachment) &&
      depthAttachment.view === this._depthTextureView
    ) {
      this._canvasDepthTouchedThisFrame = true;
    }

    return this._currentRenderPassEncoder;
  }

  /**
   * Return a render-pass descriptor with opt-in timestamp writes attached.
   * Direct-pass subsystems use this when they intentionally encode on the
   * context's command encoder without taking ownership of the active-pass
   * lifecycle. Default rendering returns the exact descriptor unchanged.
   */
  withRenderPassTimestamps(
    descriptor: GPURenderPassDescriptor,
    fallbackName?: string,
  ): GPURenderPassDescriptor {
    const performanceManager = this._performanceManager;
    return performanceManager
      ? performanceManager.withRenderPassTimestamps(descriptor, fallbackName)
      : descriptor;
  }

  /** Compute-pass counterpart to {@link withRenderPassTimestamps}. */
  withComputePassTimestamps(
    descriptor: GPUComputePassDescriptor,
    fallbackName?: string,
  ): GPUComputePassDescriptor {
    const performanceManager = this._performanceManager;
    return performanceManager
      ? performanceManager.withComputePassTimestamps(descriptor, fallbackName)
      : descriptor;
  }

  /**
   * End the currently active render pass without submitting the command buffer.
   *
   * After calling this, you can:
   * - Start a new render pass with `beginRenderPass(descriptor)`
   * - Resume the default canvas pass with `resumeDefaultRenderPass()`
   * - End the frame with `endFrame()`
   *
   * This is safe to call even if no render pass is active (no-op).
   */
  endCurrentRenderPass(): void {
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
      this._activePassTarget = null;
    }
  }

  /**
   * Resume rendering to the default canvas render pass.
   *
   * This starts a new render pass targeting the canvas surface, preserving
   * what was already rendered this frame (the first open of a frame clears
   * untouched channels — see `_beginDefaultRenderPass`). Use this after
   * completing a non-default render pass (e.g., shadow map, pick buffer)
   * to continue rendering to the screen.
   *
   * @returns {GPURenderPassEncoder | null} The render pass encoder, or null
   */
  resumeDefaultRenderPass(): GPURenderPassEncoder | null {
    if (!this._currentCommandEncoder || !this._currentTextureView) {
      this.log(
        "warn",
        "resumeDefaultRenderPass: No command encoder or texture view",
      );
      return null;
    }

    // End current pass if active
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
      this._activePassTarget = null;
    }

    // Open the default pass; load ops derive from the per-frame demand
    // flags (clear on the frame's first open, load thereafter).
    this._beginDefaultRenderPass();

    return this._currentRenderPassEncoder;
  }

  /**
   * Get the current command encoder for advanced operations.
   * Available between beginFrame() and endFrame().
   *
   * @returns {GPUCommandEncoder | null} The active command encoder
   */
  get currentCommandEncoder(): GPUCommandEncoder | null {
    return this._currentCommandEncoder;
  }

  /**
   * Run a callback immediately after the current frame command buffer is
   * submitted. Returns false when no frame owns an encoder, allowing callers
   * to retain an off-frame private-submit fallback.
   *
   * @param callback Receives true after submit, false if the frame is
   * abandoned or the device becomes unavailable before submission.
   * @returns Whether the callback was accepted by the active frame.
   * @private
   */
  enqueueAfterFrameSubmit(callback: (submitted: boolean) => void): boolean {
    if (
      typeof callback !== "function" ||
      this._isDeviceUnavailable ||
      !this._currentCommandEncoder
    ) {
      return false;
    }
    this._afterFrameSubmitCallbacks.push(callback);
    return true;
  }

  private _drainAfterFrameSubmitCallbacks(submitted: boolean): void {
    if (this._afterFrameSubmitCallbacks.length === 0) {
      return;
    }
    const callbacks = this._afterFrameSubmitCallbacks;
    this._afterFrameSubmitCallbacks = [];
    for (let i = 0; i < callbacks.length; i++) {
      try {
        callbacks[i](submitted);
      } catch {
        // Readback owners surface their own failures. One callback must never
        // prevent the rest of the frame's post-submit notifications.
      }
    }
  }

  /**
   * Get the current canvas texture view (the render target for the default pass).
   * Available between beginFrame() and endFrame().
   *
   * @returns {GPUTextureView | null} The current canvas texture view
   */
  get currentTextureView(): GPUTextureView | null {
    return this._currentTextureView;
  }

  /**
   * Get the depth texture view for the default render pass.
   *
   * @returns {GPUTextureView | null} The depth/stencil texture view
   */
  get depthTextureView(): GPUTextureView | null {
    return this._depthTextureView;
  }

  /**
   * Depth-only view suitable for sampling in compute shaders.
   * Strips the stencil aspect so the view matches `texture_depth_2d`
   * in WGSL and `sampleType: "depth"` in bind group layouts.
   */
  get depthOnlyTextureView(): GPUTextureView | null {
    return this._depthOnlyTextureView;
  }

  /**
   * Get the depth format used by this context.
   *
   * @returns {GPUTextureFormat} The depth texture format
   */
  get depthFormat(): GPUTextureFormat {
    return this._depthFormat;
  }

  /**
   * Check if a render pass is currently active.
   *
   * @returns {boolean} True if a render pass encoder is active
   */
  get hasActiveRenderPass(): boolean {
    return this._currentRenderPassEncoder !== null;
  }

  /**
   * Declare that this frame's canvas color content has been written by a
   * pass the context cannot observe (C9-07 / FAR-405-C0). The post-process
   * pipeline and the debug overlays blit to `currentTextureView` through
   * raw `encoder.beginRenderPass` calls, bypassing the context pass
   * helpers — without this marker the next default-pass open would use
   * `loadOp:"clear"` and the `endFrame` present fallback would wipe the
   * blit with a cleared canvas.
   */
  markCanvasContentWritten(): void {
    this._canvasColorTouchedThisFrame = true;
  }

  /**
   * End the current frame - ends render pass and submits commands
   */
  /**
   * Queues a GPUTexture for destruction after the current frame's submitted
   * GPU work has completed. Use this — never `texture.destroy()` — for any
   * texture that may still be referenced by an in-flight command buffer, such
   * as scene-driven imagery eviction that runs mid-frame (before the globe
   * draw that binds the texture has been submitted). The actual free runs from
   * {@link WebGPUContext#endFrame} via `device.queue.onSubmittedWorkDone()`.
   *
   * No-op for a null/undefined texture. If the device is gone (context
   * destroyed / lost) the texture is freed immediately — a safe no-op.
   */
  scheduleTextureDestroy(texture: GPUTexture | null | undefined): void {
    if (!texture) {
      return;
    }
    if (!this._device || this._isDeviceUnavailable) {
      try {
        texture.destroy();
      } catch {
        // Device already lost — GPUTexture.destroy() is a safe no-op, but
        // guard anyway so eviction never throws during teardown.
      }
      return;
    }
    this._pendingTextureDestroys.push(texture);
  }

  /**
   * Enqueue mip-chain generation for a freshly-uploaded texture (C9-12A). The
   * job is encoded into the shared `"ImageryMipPreparation"` encoder in
   * {@link WebGPUContext#endFrame} and submitted before the frame encoder, so
   * the mips are complete before any scene pass samples the texture this frame.
   *
   * If the device is gone the job is dropped: nothing will sample the texture
   * (its owning realization is discarded on device change), so generating mips
   * would be wasted work and would fail on the dead device anyway.
   */
  enqueueImageryMipGeneration(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
  ): void {
    if (!texture || mipLevelCount <= 1) {
      return;
    }
    if (!this._device || this._isDeviceUnavailable) {
      return;
    }
    this._pendingImageryMipJobs.push({ texture, format, mipLevelCount });
  }

  /**
   * F7 (Batch 686) — record that a texture was destroyed INLINE (it is dead
   * immediately, unlike {@link WebGPUContext#scheduleTextureDestroy}'d
   * textures, which stay live until after this frame's submit completes).
   * The pending-mip encode step drops jobs ONLY for inline-destroyed textures;
   * scheduled-but-live textures still get their mips (worst case trivially
   * wasted work, correct output always).
   */
  noteInlineTextureDestroy(texture: GPUTexture): void {
    this._inlineDestroyedTextures.add(texture);
  }

  /**
   * Capture-and-clear the pending imagery mip jobs and encode them into one
   * `"ImageryMipPreparation"` command buffer (C9-12A). Returns null when there
   * is nothing to encode. Shared by {@link WebGPUContext#endFrame} and
   * {@link WebGPUContext#flushPendingImageryMipJobs}.
   */
  private _encodePendingImageryMipJobs(): GPUCommandBuffer | null {
    if (this._pendingImageryMipJobs.length === 0 || !this._device) {
      return null;
    }
    const jobs = this._pendingImageryMipJobs;
    this._pendingImageryMipJobs = [];
    const prepEncoder = this._device.createCommandEncoder({
      label: "ImageryMipPreparation",
    });
    const gen = this.mipmapGenerator;
    let encoded = 0;
    for (let i = 0; i < jobs.length; ++i) {
      const job = jobs[i];
      // F7 — skip ONLY textures actually destroyed inline (dead now).
      // Scheduled destroys (`_pendingTextureDestroys`) stay LIVE until after
      // the upcoming submit — this frame's already-encoded draws may still
      // sample them, so their mip chains MUST be generated.
      if (this._inlineDestroyedTextures.has(job.texture)) {
        continue;
      }
      gen.generateMipmaps(
        job.texture,
        job.format,
        job.mipLevelCount,
        prepEncoder,
      );
      ++encoded;
    }
    return encoded > 0 ? prepEncoder.finish() : null;
  }

  /**
   * F3 (Batch 686) — immediately encode + submit any pending imagery mip jobs.
   * MUST be called by every renderer that privately `queue.submit`s work which
   * samples globe imagery textures mid-frame (e.g. the dynamic environment-map
   * capture): without the flush, a texture realized earlier in the same frame
   * would be sampled with mips 1..N still zero-initialized, because the
   * frame-owned `"ImageryMipPreparation"` submit only happens in `endFrame`.
   * No-op when nothing is pending.
   */
  flushPendingImageryMipJobs(): void {
    if (this._pendingImageryMipJobs.length === 0) {
      return;
    }
    if (!this._device || this._isDeviceUnavailable) {
      this._pendingImageryMipJobs.length = 0;
      return;
    }
    const prepBuffer = this._encodePendingImageryMipJobs();
    if (prepBuffer) {
      this._device.queue.submit([prepBuffer]);
    }
  }

  /**
   * Flush staged frame-ring uniform bytes before a private mid-frame submit.
   *
   * Normal scene work relies on endFrame() doing this once immediately before
   * the frame command buffer is submitted. A renderer that owns a separate
   * encoder/submit (dynamic environment capture) must establish the same queue
   * ordering explicitly or its commands can observe stale ring contents.
   */
  flushPendingUniformUploads(): void {
    this._uniformAllocator?.flush();
  }

  /**
   * Queue one stable effects UBO for post-light-fit shadow refresh.
   * Repeated primitives of the same model share the buffer and dedupe here.
   */
  enqueueShadowReceiveUniformRefresh(
    uniformBuffer: GPUBuffer,
    shadowMap: object,
  ): void {
    if (this._shadowReceiveUniformRefreshSet.has(uniformBuffer)) {
      return;
    }
    this._shadowReceiveUniformRefreshSet.add(uniformBuffer);
    this._shadowReceiveUniformRefreshes.push(uniformBuffer, shadowMap);
  }

  /**
   * Flush the frame's shadow-receive resource list after ShadowMap.update()
   * fitted the current light camera and before color execution.
   */
  flushShadowReceiveUniformRefreshes(): void {
    const device = this._device;
    const refreshes = this._shadowReceiveUniformRefreshes;
    if (device) {
      for (let i = 0; i < refreshes.length; i += 2) {
        refreshShadowReceiveUniformPrefix(
          device,
          refreshes[i] as GPUBuffer,
          refreshes[i + 1] as object,
        );
      }
    }
    refreshes.length = 0;
    this._shadowReceiveUniformRefreshSet.clear();
  }

  endFrame(): void {
    if (this._isDeviceUnavailable) {
      //>>includeStart('debug', pragmas.debug);
      throw new DeveloperError(
        this._isDestroyed
          ? "Context has been destroyed."
          : "Context's WebGPU device is terminally lost.",
      );
      //>>includeEnd('debug');
      return;
    }

    if (!this._device || !this._currentCommandEncoder) {
      return;
    }

    let uniformAllocatorFrameEnded = false;
    try {
      // End render pass if active
      if (this._currentRenderPassEncoder) {
        this._currentRenderPassEncoder.end();
        this._currentRenderPassEncoder = null;
        this._activePassTarget = null;
      }

      // C9-07 / FAR-405-C0 — deferred clear/present fallback. An acquired
      // swap texture that nothing writes presents WebGPU lazy-zeros; the
      // historical behavior was one beginFrame clear pass every frame. The
      // ONLY frames that pay this open+end are frames where no consumer
      // touched the canvas color (empty scene, post-process missing,
      // exception-truncated frames). Pick mini-frames never acquire a swap
      // view (`beginPickFrame`), so `_currentTextureView === null` excludes
      // them naturally. The distinct label keeps API-lane evidence
      // self-describing (nothing in live code matches pass labels).
      if (
        this._currentTextureView !== null &&
        !this._canvasColorTouchedThisFrame
      ) {
        this._beginDefaultRenderPass("Canvas Demand Clear Pass");
        if (this._currentRenderPassEncoder) {
          const fallbackPass = this
            ._currentRenderPassEncoder as GPURenderPassEncoder;
          fallbackPass.end();
          this._currentRenderPassEncoder = null;
          this._activePassTarget = null;
        }
      }

      // Coalesce per-draw uniform uploads into one queue write per dirty ring
      // page. Queue writes issued before submit are ordered before the command
      // buffer that consumes them.
      this._uniformAllocator?.flush();

      // Timestamp queries must resolve after every frame pass has ended and
      // before this encoder is finished. The manager is lazy and endFrame is
      // idempotent, so pick/empty frames that never began profiling are no-ops.
      this._performanceManager?.endFrame(this._currentCommandEncoder);

      // C9-12A (hardened Batch 686) — encode all imagery mip jobs deferred out
      // of draw emission into one prep encoder and submit it BEFORE the frame
      // encoder as its OWN submit (F8 — same-queue ordering is guaranteed, and
      // an invalid prep buffer can no longer invalidate the whole frame submit).
      // Queue ordering (copyExternalImageToTexture at update time → these mip
      // passes → scene passes) guarantees the frame that realized the texture
      // samples complete mips. Only textures destroyed INLINE this frame are
      // skipped (F7); scheduled-destroy textures are live through this submit
      // and still get their mips.
      const prepBuffer = this._encodePendingImageryMipJobs();
      if (prepBuffer) {
        this._device.queue.submit([prepBuffer]);
      }

      // Submit command buffer
      const commandBuffer = this._currentCommandEncoder.finish();
      this._device.queue.submit([commandBuffer]);
      this._drainAfterFrameSubmitCallbacks(true);
      this._timestampProfiler?.afterSubmit();

      // Drain deferred texture destroys: any texture the scene evicted this
      // frame is now safe to free once the work just submitted (which may bind
      // it) finishes on the GPU. Captured-then-cleared so a destroy enqueued
      // after this point rides the next frame's drain instead of this one's.
      if (this._pendingTextureDestroys.length > 0) {
        const toDestroy = this._pendingTextureDestroys;
        this._pendingTextureDestroys = [];
        this._device.queue.onSubmittedWorkDone().then(
          () => {
            for (let i = 0; i < toDestroy.length; ++i) {
              try {
                toDestroy[i].destroy();
              } catch {
                // Device lost / already destroyed — destroy() is a safe no-op.
              }
            }
          },
          () => {
            // onSubmittedWorkDone rejected (device lost) — the device teardown
            // reclaims these textures; just drop our references.
          },
        );
      }

      // Finalize ring buffer frame
      if (this._uniformAllocator) {
        uniformAllocatorFrameEnded = true;
        this._uniformAllocator.endFrame();
      }

      // Clear frame state
      this._currentCommandEncoder = null;
      this._currentTextureView = null;
    } catch (error) {
      // C11-76 — any failure before the frame submit completes abandons every
      // frame-owned readback copy. Do not leave promises queued for a future
      // beginFrame: request-render scenes may stop immediately after an error.
      this._drainAfterFrameSubmitCallbacks(false);
      this._currentRenderPassEncoder = null;
      this._activePassTarget = null;
      this._currentCommandEncoder = null;
      this._currentTextureView = null;
      if (!uniformAllocatorFrameEnded && this._uniformAllocator) {
        uniformAllocatorFrameEnded = true;
        this._uniformAllocator.endFrame();
      }
      throw error;
    }
  }

  /**
   * Ensures depth texture exists and matches canvas size
   * @private
   */
  private _ensureDepthTexture(): void {
    if (!this._device) {
      return;
    }

    const width = this._canvas.width;
    const height = this._canvas.height;

    // Recreate if size changed or doesn't exist
    if (
      !this._depthTexture ||
      this._depthTexture.width !== width ||
      this._depthTexture.height !== height
    ) {
      // Destroy old texture
      if (this._depthTexture) {
        this._depthTexture.destroy();
      }

      // Create new depth texture. TEXTURE_BINDING is added so compute
      // shaders (Hi-Z pyramid, occlusion test, G-buffer producer in
      // Phase 8a Slice 2) can sample the depth after the render pass
      // stores it.
      //
      // Batch 86 (Phase 8a Slice 2b) — flipped on unconditionally
      // (previously the comment said "guarded by opt-in" but no opt-in
      // logic was ever implemented; the accessor `depthOnlyTextureView`
      // always returned null, silently disabling HiZ and the G-buffer
      // producer). Enabling unconditionally has negligible perf cost
      // (one extra texture-usage bit, no per-frame work) and unblocks
      // every compute-sampled-depth consumer.
      const depthUsage =
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
      this._depthTexture = this._device.createTexture({
        size: { width, height },
        format: this._depthFormat,
        usage: depthUsage,
        label: "Scene Depth Texture",
      });

      this._depthTextureView = this._depthTexture.createView();
      // Depth-only view (aspect = "depth-only") so compute shaders can
      // bind it as `texture_depth_2d` per the WebGPU spec. The full view
      // above (aspect = "all") is what render-pass depth-stencil
      // attachments expect.
      this._depthOnlyTextureView = this._depthTexture.createView({
        aspect: "depth-only",
      });
    }
  }

  // ====================================================================================
  // Feature Detection & Auto-Request (C1/C3/C4)
  /**
   * Wrap `device.createShaderModule` so every shader module created by
   * ANY renderer component automatically gets async compilation
   * validation. Errors are logged with file/line info from the WGSL
   * source instead of surfacing as cryptic "invalid pipeline" errors
   * that cascade through render bundles and kill the entire frame.
   */
  private _installShaderValidation(device: GPUDevice): void {
    this._releaseShaderValidation?.();

    let installation = WebGPUContext._shaderValidationByDevice.get(device);
    if (!installation) {
      const original = device.createShaderModule;
      const contextIds = new Set<string>();
      const wrapper = function (
        this: GPUDevice,
        descriptor: GPUShaderModuleDescriptor,
      ): GPUShaderModule {
        const mod = original.call(device, descriptor);
        const contextId = contextIds.values().next().value ?? "shared-device";
        // Fire-and-forget async validation — doesn't block pipeline
        // creation but surfaces errors in the console immediately.
        mod.getCompilationInfo().then((info: GPUCompilationInfo) => {
          for (const msg of info.messages) {
            if (msg.type === "error") {
              console.error(
                `[CesiumJS:webgpu:${contextId}] Shader "${descriptor.label ?? "unlabeled"}" ` +
                  `compilation ERROR at line ${msg.lineNum}:${msg.linePos}: ${msg.message}`,
              );
            } else if (msg.type === "warning") {
              //>>includeStart('debug', pragmas.debug);
              console.warn(
                `[CesiumJS:webgpu:${contextId}] Shader "${descriptor.label ?? "unlabeled"}" ` +
                  `warning at line ${msg.lineNum}: ${msg.message}`,
              );
              //>>includeEnd('debug');
            }
          }
        });
        return mod;
      };
      installation = { original, wrapper, contextIds };
      WebGPUContext._shaderValidationByDevice.set(device, installation);
      device.createShaderModule = wrapper;
    }

    installation.contextIds.add(this._id);
    let released = false;
    this._releaseShaderValidation = () => {
      if (released) {
        return;
      }
      released = true;
      installation!.contextIds.delete(this._id);
      if (installation!.contextIds.size === 0) {
        if (device.createShaderModule === installation!.wrapper) {
          device.createShaderModule = installation!.original;
        }
        WebGPUContext._shaderValidationByDevice.delete(device);
      }
      this._releaseShaderValidation = null;
    };
  }

  /**
   * Lazy-initialize the cascaded shadow map renderer. Called on the
   * first frame where `scene.useCascadedShadowMaps` is true.
   *
   * @param resolution Per-cascade texture resolution (256..4096). Passed
   *   through from `scene.cascadedShadowMapResolution`. The CSM renderer
   *   clamps the value, so callers need not pre-clamp.
   * @param softShadows Whether the receive shaders soften cascade edges
   *   with a 3x3 PCF box kernel (NEW-CSM-SOFT-SHADOW-PCF). Passed through
   *   from `scene.cascadedShadowMapSoftShadows`. Defaults to true.
   */
  private _initCSMRenderer(resolution?: number, softShadows?: boolean): void {
    if (this._csmRenderer || !this._device) {
      return;
    }
    this._csmRenderer = new WebGPUCSMRenderer({
      enabled: true,
      resolution,
      softShadows: softShadows ?? true,
    });
    this._csmRenderer.initialize(this._device);
  }

  // ====================================================================================

  // `DESIRED_FEATURES` constant + `_buildFeatureList` wrapper moved
  // to `WebGPUFeatureFlags.ts` in Batch 132. The Context calls
  // `this._featureFlags.buildRequestList(adapter, userRequested)`
  // directly from `_initialize` now; there's no longer a private
  // method on the class for building the request list because there
  // was only ever one caller.

  /**
   * Updates internal capability flags based on which features were
   * successfully enabled on the device. Called after device creation.
   *
   * @private
   */
  private _updateFeatureFlags(): void {
    // C1: float32-filterable — update the textureFloatLinear flag
    // Without this feature, float32 textures require nearest-only sampling
    if (this._featureFlags.has("float32-filterable")) {
      this.textureFloatLinear = true;
      this._textureFloatLinear = true;
    }

    // C3 (Phase 5 WGF-1) + I5 (Phase 5 WGF-3): both flags stay OPT-IN
    // even when the device grants the underlying feature. Reasons:
    //
    // - WGF-1 (`clip-distances`): the hardware path requires SCENE3D mode
    //   AND union-mode clipping; the gating in WebGPUGlobeSurfaceRenderer
    //   covers correctness, but until the visual-regression harness is
    //   wired we don't want to silently change rendering on every fork
    //   user that happens to enable clipping planes.
    //
    // - WGF-3 (`shader-f16`): a small fraction of adapters report
    //   shader-f16 support but trip on specific operators. The fallback
    //   path is async-only (popErrorScope is a promise) so a failed
    //   compile produces a black post-process output until the user
    //   manually disables the flag. Opt-in until the validation harness
    //   can probe per-shader-variant compilation at init.
    //
    // Consumers enable either flag with:
    //   scene.context.useHardwareClipDistances = true;
    //   scene.context.useShaderF16 = true;
    // The capability flags `hasClipDistances` / `hasShaderF16` on the
    // debug snapshot expose what the adapter actually granted.

    // Texture compression formats
    if (this._featureFlags.has("texture-compression-bc")) {
      this._s3tc = true;
      this._bc7 = true;
      this.s3tc = true;
      this.bc7 = true;
    }
    if (this._featureFlags.has("texture-compression-etc2")) {
      this._etc = true;
      this.etc = true;
    }
    if (this._featureFlags.has("texture-compression-astc")) {
      this._astc = true;
      this.astc = true;
    }
  }

  /**
   * Check if a specific WebGPU feature is enabled on the device.
   *
   * @param {string} featureName - Feature name (e.g., 'float32-filterable',
   *   'clip-distances', 'dual-source-blending', 'timestamp-query', 'shader-f16')
   * @returns {boolean} True if the feature is enabled
   *
   * @example
   * if (context.hasFeature('clip-distances')) {
   *   // Use native clip planes instead of stencil-based clipping
   * }
   * if (context.hasFeature('dual-source-blending')) {
   *   // Use single-pass weighted-average OIT
   * }
   */
  hasFeature(featureName: string): boolean {
    return this._featureFlags.has(featureName);
  }

  /**
   * Get all enabled optional features.
   * @returns {string[]} Array of enabled feature names
   */
  get enabledFeatures(): string[] {
    return this._featureFlags.enabledList;
  }

  /**
   * Replaces this context's immutable capability snapshot from device limits.
   * @internal
   */
  // Public underscore: shared with the device-loss host-adapter (Batch 143).
  public _initializeContextLimits(): void {
    if (!this._device) {
      this._graphicsCapabilities = GraphicsCapabilities.EMPTY;
      return;
    }
    this._graphicsCapabilities = GraphicsCapabilities.fromWebGPUDevice(
      this._device,
    );

    // (Re)build the vertex-attribute divisor state cache now that the
    // real device limits are known. Runs again on device-loss recovery,
    // resetting all divisors to 0 — fresh-context semantics, mirroring
    // the Context.js constructor loop over maximumVertexAttributes.
    const maxVertexAttributes = this._device?.limits.maxVertexAttributes ?? 16;
    this._vertexAttribDivisors.length = 0;
    for (let i = 0; i < maxVertexAttributes; i++) {
      this._vertexAttribDivisors.push(0);
    }
    this._previousDrawInstanced = false;
  }

  /**
   * Initialize the WebGL compatibility stub that provides WebGL
   * constants + bound-state mirrors for legacy JS resources
   * (Texture.js, CubeMap.js, Framebuffer.js) that read
   * `context._gl.TEXTURE_2D` etc. Delegates to
   * {@link buildWebGLCompatibilityStubFor} which builds the live state
   * proxy over this context's `public _xxx` fields.
   * @private
   */
  private _initializeWebGLStub(): void {
    // Live state proxy + factory call moved to
    // `WebGPUContextWebGLStubInit.ts` (Batch 129). The 26 underscore-
    // prefixed fields the proxy reads/writes are now `public _xxx` on
    // this class — same convention as `public _device`, `public _canvas`,
    // `public _frameCount`.
    this._gl = buildWebGLCompatibilityStubFor(this);
  }

  /**
   * Gets the current render pass encoder (for command recording)
   * @returns {GPURenderPassEncoder | null} The active render pass encoder
   */
  get currentRenderPassEncoder(): GPURenderPassEncoder | null {
    return this._currentRenderPassEncoder;
  }

  /**
   * Gets the uniform state for managing shader uniforms
   * @returns {CesiumUniformState} The uniform state
   */
  get uniformState(): CesiumUniformState {
    return this._uniformState;
  }

  /**
   * Initialize viewport quad vertex buffer - PRIORITY 2
   * Creates a full-screen quad for post-processing effects
   * @private
   */
  private _initializeViewportQuad(): void {
    if (!this._device || this._viewportQuadVertexBuffer) {
      return;
    }

    // Full-screen quad vertices (2 triangles covering NDC -1 to 1)
    // Format: [x, y] positions
    const quadVertices = new Float32Array([
      -1.0,
      -1.0, // Bottom-left
      1.0,
      -1.0, // Bottom-right
      -1.0,
      1.0, // Top-left
      1.0,
      1.0, // Top-right
    ]);

    this._viewportQuadVertexBuffer = WebGPUBuffer.createVertexBuffer(
      this._device,
      quadVertices,
      "Viewport Quad Vertex Buffer",
    );
  }

  /**
   * Creates a viewport quad command for screen-space effects.
   *
   * Accepts WGSL shader code (string with @vertex/@fragment, or object with
   * `_wgslCode` property). GLSL shaders return a noop command — callers that
   * need WebGPU support must provide WGSL equivalents.
   *
   * Delegates to {@link WebGPUViewportQuad} for pipeline caching, bind group
   * creation, and fullscreen triangle rendering.
   *
   * @see WebGPUViewportQuad for shader conventions and binding layout
   * @param {unknown} fragmentShader - WGSL shader code or GLSL source
   * @param {ViewportQuadCommandOptions} [options] - uniformMap, framebuffer, owner, renderState, pass,
   *   pipelineConfig (blend/depth/stencil)
   * @returns {ViewportQuadCommand} A command object with execute(passEncoder?, context?)
   */
  createViewportQuadCommand(
    fragmentShader: string | CesiumOpaqueShaderSource | { _wgslCode?: string },
    options?: ViewportQuadCommandOptions,
  ): ViewportQuadCommand {
    const device = this._device;
    const opts = (options ?? {}) as ViewportQuadCommandOptions;

    // Determine WGSL code from various input types
    let wgslCode: string | null = null;
    if (typeof fragmentShader === "string") {
      if (
        fragmentShader.includes("@vertex") ||
        fragmentShader.includes("@fragment")
      ) {
        wgslCode = fragmentShader;
      }
    } else if (
      typeof fragmentShader === "object" &&
      fragmentShader !== null &&
      "_wgslCode" in fragmentShader
    ) {
      wgslCode = (fragmentShader as { _wgslCode?: string })._wgslCode as string;
    }

    if (!wgslCode || !device) {
      // GLSL or no device — return noop command
      return {
        execute: () => {},
        shaderProgram: fragmentShader,
        uniformMap: opts.uniformMap || {},
        framebuffer: opts.framebuffer || null,
        owner: opts.owner,
        renderState: opts.renderState,
        pass: opts.pass,
        _isViewportQuadCommand: true,
        destroy: () => {},
      };
    }

    // Lazy-init the viewport quad utility
    if (!this._viewportQuad) {
      this._viewportQuad = new WebGPUViewportQuad(device);
    }

    const targetFormat: GPUTextureFormat =
      this._presentationFormat || "bgra8unorm";

    return this._viewportQuad.createCommand(wgslCode, targetFormat, {
      uniformMap: opts.uniformMap,
      framebuffer: opts.framebuffer,
      owner: opts.owner,
      renderState: opts.renderState,
      pass: opts.pass,
      pipelineConfig: opts.pipelineConfig,
      bindGroupEntries: opts.bindGroupEntries,
    });
  }

  /**
   * Direct access to the WebGPUViewportQuad utility for advanced use cases
   * (targeted render passes, explicit bind groups, etc.).
   */
  get viewportQuad(): WebGPUViewportQuad | null {
    if (!this._viewportQuad && this._device) {
      this._viewportQuad = new WebGPUViewportQuad(this._device);
    }
    return this._viewportQuad;
  }

  /**
   * Gets a viewport quad vertex array (used for full-screen effects) - PRIORITY 2 IMPLEMENTED
   * @returns {CesiumOpaqueVertexArray} A vertex array containing the viewport quad data
   */
  getViewportQuadVertexArray(): CesiumOpaqueVertexArray {
    // Ensure viewport quad is initialized
    if (!this._viewportQuadVertexBuffer) {
      this._initializeViewportQuad();
    }

    return {
      _attributes: [
        {
          index: 0,
          enabled: true,
          vertexBuffer: this._viewportQuadVertexBuffer,
          componentsPerAttribute: 2,
          componentDatatype: 5126, // FLOAT
          normalize: false,
          offsetInBytes: 0,
          strideInBytes: 8, // 2 floats * 4 bytes
        },
      ],
      numberOfVertices: 4,
      // WebGPU-specific: actual buffer for direct access
      _webgpuVertexBuffer: this._viewportQuadVertexBuffer,
    };
  }

  /**
   * AUDIT_2026_05_02 C.7 — backend-agnostic GPU-completion fence
   * factory. WebGPU backend wraps `device.queue.onSubmittedWorkDone()`
   * via the `WebGPUSync` class. See `GraphicsContext.createSync` for
   * the contract — both backends expose the same `waitForSignal` API
   * so consumers stay backend-agnostic.
   */
  override createSync(_options?: object) {
    // Batch 187 — pre-existing TS error fix. `WebGPUSync.create` accepts
    // `{ context }` and reads `context._device` internally; the prior
    // call passed `{ device, timeoutFrames }` which doesn't match
    // `WebGPUSyncOptions`. The `device`/`timeoutFrames` fields had no
    // consumers (verified by grep) — `options` is part of the abstract
    // base signature and currently has no caller-provided fields, so
    // pass `this` as the context and let WebGPUSync resolve the device.
    if (this._isDeviceUnavailable || !this._device) {
      throw new DeveloperError(
        this._isDestroyed
          ? "createSync called after the WebGPU context was destroyed."
          : this._isTerminallyLost
            ? "createSync called after the WebGPU device was terminally lost."
            : "createSync called before WebGPU device is initialized.",
      );
    }
    return WebGPUSync.create({
      context: this as unknown as CesiumGraphicsContext,
    });
  }

  /**
   * Draw command execution - PRIORITY 1 IMPLEMENTED
   * Executes WebGPU draw commands using the current render pass encoder
   * @param {CesiumDrawCommand} drawCommand - The draw command to execute (WebGPUDrawCommand)
   * @param {CesiumPassState} passState - Pass state information
   */
  draw(drawCommand: CesiumDrawCommand, passState?: CesiumPassState): void {
    if (this._isDeviceUnavailable) {
      //>>includeStart('debug', pragmas.debug);
      throw new DeveloperError(
        this._isDestroyed
          ? "Context has been destroyed."
          : "Context's WebGPU device is terminally lost.",
      );
      //>>includeEnd('debug');
      return;
    }

    if (!this._currentRenderPassEncoder) {
      this.log("warn", "draw() called without active render pass encoder");
      return;
    }

    // Check if this is a WebGPUDrawCommand
    if (drawCommand && typeof drawCommand.execute === "function") {
      // Execute WebGPU draw command — pass the render pass encoder directly
      // (CesiumDrawCommand.execute has a WebGPU overload accepting
      // GPURenderPassEncoder; see cesium-js-types.d.ts).
      drawCommand.execute(this._currentRenderPassEncoder);

      // Record statistics
      this._drawCallCount++;
      const cmd = drawCommand as CesiumAnyDrawCommand;
      if (cmd.indexCount) {
        this._triangleCount += Math.floor(cmd.indexCount / 3);
      } else if (cmd.vertexCount) {
        this._triangleCount += Math.floor(cmd.vertexCount / 3);
      }
    } else {
      // Legacy draw command - log warning
      this.log(
        "warn",
        "Unsupported draw command format - use WebGPUDrawCommand",
      );
    }
  }

  /**
   * Set viewport - PRIORITY 1 IMPLEMENTED
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} width - Width
   * @param {number} height - Height
   */
  setViewport(x: number, y: number, width: number, height: number): void {
    this._viewport = { x, y, width, height };

    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.setViewport(x, y, width, height, 0, 1);
    }
  }

  /**
   * Set scissor rectangle - PRIORITY 1 IMPLEMENTED
   * @param {number} x - X coordinate
   * @param {number} y - Y coordinate
   * @param {number} width - Width
   * @param {number} height - Height
   */
  setScissorRect(x: number, y: number, width: number, height: number): void {
    this._scissorRect = { x, y, width, height };
    this._scissorTest = true;

    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.setScissorRect(x, y, width, height);
    }
  }

  /**
   * Disable scissor test - PRIORITY 1 IMPLEMENTED
   */
  disableScissorTest(): void {
    this._scissorTest = false;
    // WebGPU doesn't have a "disable" - set to full viewport
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.setScissorRect(
        0,
        0,
        this._canvas.width,
        this._canvas.height,
      );
    }
  }

  /**
   * Read pixels from a framebuffer (or the canvas) into a Pixel Buffer Object.
   *
   * This is the primary GPU readback path for WebGPU picking.  The returned
   * PBO handle exposes an async `mapAsync()` that yields a `Uint8Array` of
   * the requested pixel rectangle, and a synchronous `getBufferData(dst)`
   * that copies the (already mapped) data into a caller-supplied typed array
   * — matching the API that `PickFramebuffer.endAsync` expects.
   *
   * @param {object} readState - `{ x, y, width, height, framebuffer }`
   * @returns {object|null} PBO handle with `mapAsync`, `getBufferData`, `destroy`
   */
  readPixelsToPBO(readState: CesiumReadState): PixelReadbackPBO | null {
    if (
      this._isDeviceUnavailable ||
      !this._device ||
      !this._currentCommandEncoder
    ) {
      this.log("warn", "readPixelsToPBO: No active device or command encoder");
      return null;
    }

    const x = readState.x ?? 0;
    const y = readState.y ?? 0;
    const width = readState.width ?? this._canvas.width;
    const height = readState.height ?? this._canvas.height;

    // 256-byte row alignment required by copyTextureToBuffer
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const bufferSize = Math.max(bytesPerRow * height, 4);

    const readbackBuffer = this._device.createBuffer({
      size: bufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      label: "Pixel Readback Buffer",
    });

    // Must end the active render pass before any copy operations
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
      this._activePassTarget = null;
    }

    // Resolve the source GPU texture -----------------------------------------------
    let sourceTexture: GPUTexture | null = null;
    const fb = readState.framebuffer;

    if (fb) {
      // WebGPU FramebufferManager / RenderTarget path
      if (typeof fb.getColorTexture === "function") {
        sourceTexture = fb.getColorTexture(0) ?? null;
      }
      // Legacy WebGL Framebuffer with _colorTextures array
      const colorTextures = fb._colorTextures;
      if (!sourceTexture && colorTextures && colorTextures.length > 0) {
        const ct = colorTextures[0];
        sourceTexture = ct?.texture ?? ct?._texture ?? null;
      }
      // Fallback: object might directly be a GPUTexture
      if (!sourceTexture && fb instanceof GPUTexture) {
        sourceTexture = fb;
      }
    }

    // Default: read from the current canvas texture
    if (!sourceTexture) {
      sourceTexture = this._context?.getCurrentTexture() ?? null;
    }

    if (!sourceTexture) {
      this.log("warn", "readPixelsToPBO: No source texture available");
      readbackBuffer.destroy();
      return null;
    }

    // Issue the texture → buffer copy
    this._currentCommandEncoder.copyTextureToBuffer(
      { texture: sourceTexture, origin: { x, y, z: 0 } },
      { buffer: readbackBuffer, bytesPerRow },
      { width, height, depthOrArrayLayers: 1 },
    );

    // The PBO handle -----------------------------------------------------------------
    let mappedData: Uint8Array | null = null;

    return {
      buffer: readbackBuffer,
      width,
      height,
      bytesPerRow,

      /**
       * Async map — call after the command buffer has been submitted.
       * Returns the raw pixel data as a Uint8Array (with row padding),
       * or `null` if the device was lost / the buffer destroyed while
       * the map was in flight (H-P5 hardening).
       */
      mapAsync: async (): Promise<Uint8Array | null> => {
        // H-P5 — guard mapAsync against device-loss / teardown races.
        // Without this a lost device during a pending PBO read leaves
        // the promise rejected unhandled, crashing the app. The outer
        // `readPixelsAsync` already handles a null return; other
        // callers (fire-and-forget paths) also benefit from the clean
        // null instead of an unhandled rejection.
        try {
          await readbackBuffer.mapAsync(GPUMapMode.READ);
          const arrayBuffer = readbackBuffer.getMappedRange();
          mappedData = new Uint8Array(arrayBuffer.slice(0));
          readbackBuffer.unmap();
          return mappedData;
        } catch (e) {
          mappedData = null;
          return null;
        }
      },

      /**
       * Synchronous copy of the already-mapped data into a caller-supplied
       * typed array. This is the API PickFramebuffer.endAsync uses via
       * `pbo.getBufferData(pixels)`.  Must call `mapAsync()` first.
       */
      getBufferData: (dst: Uint8Array | Uint16Array | Float32Array): void => {
        if (!mappedData) {
          // Can't use this.log() in closure — use console.warn with prefix
          //>>includeStart('debug', pragmas.debug);
          console.warn(
            "[CesiumJS:webgpu] getBufferData called before mapAsync completed",
          );
          //>>includeEnd('debug');
          return;
        }
        // Strip row-padding: copy only `width * 4` bytes per row
        const rowBytes = width * 4;
        for (let row = 0; row < height; row++) {
          const srcOff = row * bytesPerRow;
          const dstOff = row * rowBytes;
          dst.set(mappedData.subarray(srcOff, srcOff + rowBytes), dstOff);
        }
      },

      destroy: (): void => {
        mappedData = null;
        readbackBuffer.destroy();
      },
    };
  }

  /**
   * Async convenience wrapper around readPixelsToPBO for one-shot readback.
   *
   * Reads pixels from the specified framebuffer (or canvas), submits the
   * pending commands, maps the readback buffer, and returns the pixel data
   * as a tightly-packed `Uint8Array` (width × height × 4, RGBA).
   *
   * @param {object} readState - `{ x, y, width, height, framebuffer }`
   * @returns {Promise<Uint8Array|null>} RGBA pixel data or null on failure
   */
  async readPixelsAsync(
    readState: CesiumReadState,
  ): Promise<Uint8Array | null> {
    const pbo = this.readPixelsToPBO(readState);
    if (!pbo) {
      return null;
    }

    // Submit the command buffer so the copy actually executes on the GPU
    if (this._currentCommandEncoder) {
      // Coalesce any staged per-draw uniform uploads before this MID-FRAME
      // submit. Queue writes issued before submit are ordered before the
      // command buffer that consumes them — without this flush, draws already
      // encoded into this encoder would read stale ring-buffer bytes because
      // their staged writes would only land at endFrame's flush, AFTER this
      // submit. Mirrors the endFrame() flush.
      this._uniformAllocator?.flush();
      // F3 (Batch 686) — this mid-frame submit executes draws already encoded
      // into the frame encoder, which may sample an imagery texture realized
      // THIS frame whose mip chain is still pending for endFrame. Flush the
      // pending mip jobs first (own submit) so the queue orders mips → draws.
      this.flushPendingImageryMipJobs();
      const commandBuffer = this._currentCommandEncoder.finish();
      this._device!.queue.submit([commandBuffer]);
      // Create a fresh encoder for any subsequent operations this frame
      this._currentCommandEncoder = this._device!.createCommandEncoder({
        label: "Post-Readback Command Encoder",
      });
    }

    try {
      const rawData = await pbo.mapAsync();
      if (!rawData) {
        // H-P5 — mapAsync now returns null on device-loss / teardown.
        // Return null so callers get a clean failure instead of a
        // null-dereference on the row-copy loop below.
        pbo.destroy();
        return null;
      }
      // Strip row-alignment padding into a tight RGBA array
      const width = pbo.width;
      const height = pbo.height;
      const result = new Uint8Array(width * height * 4);
      const rowBytes = width * 4;
      for (let row = 0; row < height; row++) {
        const srcOff = row * pbo.bytesPerRow;
        const dstOff = row * rowBytes;
        result.set(rawData.subarray(srcOff, srcOff + rowBytes), dstOff);
      }
      return result;
    } catch (err) {
      this.log("error", `readPixelsAsync failed: ${err}`);
      return null;
    } finally {
      pbo.destroy();
    }
  }

  /**
   * Read pixels from framebuffer (sync).
   *
   * True synchronous readback is impossible in WebGPU.  This shim returns
   * `null` — callers should use `readPixelsToPBO()` + `mapAsync()` for the
   * async path (which is what `PickFramebuffer.endAsync` already does).
   *
   * @param {unknown} readState - Read state configuration
   * @returns {unknown} Always null in WebGPU
   */
  readPixels(_readState: CesiumReadState): Uint8Array | null {
    // Suppress noisy warnings — picking code already has an async path
    return null;
  }

  // createPickId() and getObjectByPickColor() are inherited from GraphicsContext.
  // The shared PickId class provides both `.color` (WebGL) and `.normalizedRgba`
  // (WebGPU) encodings. getObjectByPickColor handles both uint32 and {red,green,blue}
  // calling conventions. No override needed. (FORK-35 fix)

  /**
   * Default framebuffer for the context
   */
  get defaultFramebuffer(): CesiumOpaqueFramebuffer | null {
    return null; // WebGPU doesn't use framebuffer objects like WebGL
  }

  /**
   * WebGPU Context ID
   */
  get id(): string {
    return this._id;
  }

  /**
   * Shader cache for the context
   */
  get shaderCache(): CesiumShaderCache {
    return this._shaderCache;
  }

  /**
   * Texture cache for the context
   */
  get textureCache(): CesiumOpaqueObject {
    return this._textureCache;
  }

  /**
   * Stencil bits available
   */
  get stencilBits(): number {
    return this._stencilBits;
  }

  /**
   * Whether stencil buffer is supported
   */
  get stencilBuffer(): boolean {
    return this._stencilBits >= 8;
  }

  /**
   * Whether antialiasing is enabled
   */
  get antialias(): boolean {
    return this._antialias;
  }

  /**
   * Whether MSAA is supported (always true for WebGPU)
   */
  get msaa(): boolean {
    return true;
  }

  /**
   * Standard derivatives support
   */
  get standardDerivatives(): boolean {
    return this._standardDerivatives;
  }

  /**
   * Float blend support
   */
  get floatBlend(): boolean {
    return this._floatBlend;
  }

  /**
   * Blend minmax support
   */
  get blendMinmax(): boolean {
    return this._blendMinmax;
  }

  /**
   * Element index uint support
   */
  get elementIndexUint(): boolean {
    return this._elementIndexUint;
  }

  /**
   * Color buffer float support
   */
  get colorBufferFloat(): boolean {
    return this._colorBufferFloat;
  }

  /**
   * Color buffer half float support
   */
  get colorBufferHalfFloat(): boolean {
    return this._colorBufferHalfFloat;
  }

  /**
   * Texture filter anisotropic support
   */
  get textureFilterAnisotropic(): boolean {
    return false; // WebGPU doesn't expose this yet
  }

  /**
   * Vertex array object support
   */
  get vertexArrayObject(): boolean {
    return this._vertexArrayObject;
  }

  /**
   * Instanced arrays support
   */
  get instancedArrays(): boolean {
    return this._instancedArrays;
  }

  /**
   * Draw buffers support
   */
  get drawBuffers(): boolean {
    return this._drawBuffers;
  }

  /**
   * Texture LOD support
   */
  get supportsTextureLod(): boolean {
    return this._supportsTextureLod;
  }

  /**
   * Basis texture compression support
   */
  get supportsBasis(): boolean {
    return this.graphicsCapabilities.supportsBasis;
  }

  /**
   * Default 1x1 white texture
   */
  get defaultTexture(): CesiumOpaqueTexture {
    return this._defaultTexture!;
  }

  /**
   * Default 1x1 black emissive texture
   */
  get defaultEmissiveTexture(): CesiumOpaqueTexture | undefined {
    return this._defaultEmissiveTexture;
  }

  /**
   * Default 1x1 normal texture
   */
  get defaultNormalTexture(): CesiumOpaqueTexture | undefined {
    return this._defaultNormalTexture;
  }

  /**
   * Default cube map
   */
  get defaultCubeMap(): CesiumOpaqueTexture | undefined {
    return this._defaultCubeMap;
  }

  /**
   * Clear the framebuffer using a ClearCommand.
   *
   * In WebGPU, clears cannot happen inside an active render pass.
   * To honour a mid-frame clear (e.g., depth-only clear between frustums in
   * multi-frustum rendering) we:
   *   1. End the current render pass.
   *   2. Begin a new render pass where the requested channels use
   *      loadOp:"clear" with the supplied values and all other channels
   *      use loadOp:"load" to preserve existing content.
   *
   * @param {unknown} clearCommand - ClearCommand with optional color, depth, stencil
   * @param {CesiumPassState} passState - PassState (may contain a custom framebuffer)
   */
  // Tracks clear() calls per frame for infinite-loop detection.
  // Reset in beginFrame(). If this exceeds 50, something is re-entering
  // clear recursively — log once and bail to prevent the tab from freezing.
  private _clearCallsThisFrame: number = 0;
  private _clearOverflowWarned: boolean = false;

  clear(clearCommand: CesiumClearCommand, passState?: CesiumPassState): void {
    if (this._isDeviceUnavailable) {
      //>>includeStart('debug', pragmas.debug);
      throw new DeveloperError(
        this._isDestroyed
          ? "Context has been destroyed."
          : "Context's WebGPU device is terminally lost.",
      );
      //>>includeEnd('debug');
      return;
    }

    if (!this._device || !this._context || !this._currentCommandEncoder) {
      return;
    }

    const cmd = clearCommand as CesiumClearCommand;
    const ps = passState as CesiumPassState | undefined;

    // ── Infinite-loop guard (permanent, not debug-only) ──
    // BUG-12 proved that a mis-ordered guard can cause clear() to be
    // called hundreds of times per frame, freezing the tab. This counter
    // is cheap (one increment + comparison) and catches the failure mode
    // immediately with a clear error message.
    this._clearCallsThisFrame++;
    if (this._clearCallsThisFrame > 50) {
      if (!this._clearOverflowWarned) {
        this._clearOverflowWarned = true;
        console.error(
          `[CesiumJS:webgpu] clear() called ${this._clearCallsThisFrame}+ ` +
            `times in one frame — likely infinite loop. Breaking. ` +
            `Active pass: "${this._currentRenderPassEncoder?.label ?? "(none)"}". ` +
            `Check FramebufferOrchestrator clear sequence.`,
        );
      }
      return;
    }

    // Nothing to clear
    // Guard against boolean `false` — callers pass { color: false } to mean "don't clear color"
    const wantColor = cmd.color !== undefined && cmd.color !== false;
    const wantDepth = cmd.depth !== undefined && cmd.depth !== false;
    const wantStencil = cmd.stencil !== undefined && cmd.stencil !== false;
    if (!wantColor && !wantDepth && !wantStencil) {
      return;
    }

    // ── Scene-owned pass guard (MUST run BEFORE ending the pass) ──
    //
    // When a scene-owned pass (the scene framebuffer pass or the default
    // canvas pass) is active, ClearCommands must NOT tear it down and
    // replace it with a canvas-targeting clear pass. Those passes were
    // opened with the correct load ops, so these clears are redundant —
    // and tearing down the scene-FB pass mid-frame is the documented
    // all-black failure mode.
    //
    // C9-07 / FAR-405-C0 — the guard used to infer this from
    // `_currentRenderPassEncoder.label.startsWith("Scene")` (matching
    // exactly "Scene Main Render Pass" + "Scene Framebuffer Render
    // Pass"); it now reads the explicitly tracked pass target, which is
    // nulled at every `.end()` site, so the historical moved-below-end
    // bug (guard always seeing null) cannot silently recur.
    if (
      this._activePassTarget === "scene-framebuffer" ||
      this._activePassTarget === "default-canvas"
    ) {
      return;
    }

    const hadActivePass = this._currentRenderPassEncoder !== null;

    // End the active render pass so we can start a fresh one with clear ops
    if (this._currentRenderPassEncoder) {
      this._currentRenderPassEncoder.end();
      this._currentRenderPassEncoder = null;
      this._activePassTarget = null;
    }

    // Build a render pass descriptor that clears only the requested channels
    // and loads (preserves) everything else.
    const colorLoadOp: GPULoadOp = wantColor ? "clear" : "load";
    let depthLoadOp: GPULoadOp = wantDepth ? "clear" : "load";
    let stencilLoadOp: GPULoadOp = wantStencil ? "clear" : "load";

    let colorView = this._currentTextureView;
    let depthStencilView = this._depthTextureView;

    // If the passState or clearCommand specifies a framebuffer, use it
    const fb = ps?.framebuffer ?? cmd.framebuffer;
    if (fb) {
      // Support WebGPURenderTarget / WebGPUFramebufferManager style objects
      if (typeof fb.getColorTextureView === "function") {
        colorView = fb.getColorTextureView(0) ?? colorView;
      }
      if (typeof fb.getDepthStencilTextureView === "function") {
        depthStencilView = fb.getDepthStencilTextureView() ?? depthStencilView;
      } else if (typeof fb.getDepthTextureView === "function") {
        depthStencilView = fb.getDepthTextureView() ?? depthStencilView;
      }
    }

    if (!colorView) {
      return;
    }

    // ── Deferred canvas clear (C9-07 / FAR-405-C0) ──
    // A default-framebuffer clear arriving while no pass is active and the
    // canvas is still untouched this frame (the background
    // `scene._clearColorCommand` on the new deferred-open timeline) is
    // subsumed by the pending first-open clear (or the endFrame present
    // fallback), which delivers the same `_clearColor`/`_clearDepth`/
    // `_clearStencil` values. This reproduces the historical behavior
    // where that command arrived while the beginFrame canvas pass was
    // active and was swallowed by the guard above. NOTE: `cmd.color` is
    // deliberately NOT copied into `_clearColor` here — that would change
    // empty-scene bytes from transparent black to the scene background
    // color (ledgered as a WebGL-parity follow-on candidate, not this
    // slice).
    if (
      !hadActivePass &&
      colorView === this._currentTextureView &&
      !this._canvasColorTouchedThisFrame &&
      !this._canvasDepthTouchedThisFrame
    ) {
      return;
    }

    // C9-07 / FAR-405-C0 — when this clear pass attaches the CONTEXT
    // (canvas) depth texture and that texture is untouched this frame, a
    // "load" op would read lazy-zero 0.0 instead of the historical 1.0
    // (the beginFrame pass used to clear it every frame). Force a clear
    // to the default values — byte-identical to what "load" used to see.
    if (
      depthStencilView === this._depthTextureView &&
      depthStencilView !== null &&
      !this._canvasDepthTouchedThisFrame
    ) {
      depthLoadOp = "clear";
      stencilLoadOp = "clear";
    }

    const cc = cmd.color as CesiumColor | undefined;
    const clearColor =
      wantColor && cc
        ? {
            r: cc.red ?? 0.0,
            g: cc.green ?? 0.0,
            b: cc.blue ?? 0.0,
            a: cc.alpha ?? 1.0,
          }
        : { r: 0, g: 0, b: 0, a: 0 };

    const renderPassDescriptor: GPURenderPassDescriptor = {
      label: "ClearCommand Render Pass",
      colorAttachments: [
        {
          view: colorView,
          clearValue: clearColor,
          loadOp: colorLoadOp,
          storeOp: "store",
        },
      ],
      depthStencilAttachment: depthStencilView
        ? {
            view: depthStencilView,
            depthClearValue: wantDepth ? (cmd.depth as number) : 1.0,
            depthLoadOp: depthLoadOp,
            depthStoreOp: "store",
            stencilClearValue: wantStencil ? (cmd.stencil as number) : 0,
            stencilLoadOp: stencilLoadOp,
            stencilStoreOp: "store",
          }
        : undefined,
    };

    // Begin a new pass with the clear ops, then immediately make it the
    // active pass so subsequent draw commands render into it.
    this._currentRenderPassEncoder =
      this._currentCommandEncoder.beginRenderPass(
        this.withRenderPassTimestamps(
          renderPassDescriptor,
          "ClearCommand Render Pass",
        ),
      );
    // "external" (NOT "default-canvas") so a subsequent default-FB
    // ClearCommand still executes — the historical label guard never
    // matched "ClearCommand Render Pass" either.
    this._activePassTarget = "external";
    // The stores of this pass define the canvas channels it attaches.
    if (colorView === this._currentTextureView) {
      this._canvasColorTouchedThisFrame = true;
    }
    if (
      depthStencilView !== null &&
      depthStencilView === this._depthTextureView
    ) {
      this._canvasDepthTouchedThisFrame = true;
    }

    // Restore default viewport / scissor
    this._currentRenderPassEncoder.setViewport(
      0,
      0,
      this._canvas.width,
      this._canvas.height,
      0,
      1,
    );
    this._currentRenderPassEncoder.setScissorRect(
      0,
      0,
      this._canvas.width,
      this._canvas.height,
    );
  }

  /**
   * Resize the drawing buffer
   */
  resize(): void {
    // Canvas resizing is handled automatically by the browser
    // Just need to reconfigure if needed. HDR-DISPLAY (Batch 206)
    // routes through `_applyCanvasConfig` (Batch 213 audit fix) so
    // the HDR mode survives resize and a browser without extended
    // toneMapping support degrades to rgba16float-only or SDR.
    if (this._context && this._device && !this._isDeviceUnavailable) {
      this._applyCanvasConfig();
    }
  }

  /**
   * Get a string describing the renderer
   *
   * @returns {string} Renderer description
   */
  getRendererString(): string {
    if (!this._adapter) {
      return "WebGPU (Not initialized)";
    }

    const adapterName =
      (this._adapter as GPUAdapter & { name?: string }).name ?? "Unknown GPU";
    return `WebGPU - ${adapterName}`;
  }

  // ====================================================================================
  // GraphicsContext Command Execution Overrides
  // These override the default (WebGL) implementations so Scene.js
  // can dispatch commands without any `isWebGPU` checks.
  // ====================================================================================

  /**
   * WebGPU override: dispatch draw commands through the active render pass encoder.
   * Silently skips non-WebGPU commands (expected during transition).
   *
   * C9-07 / FAR-405-C0 — demand-open: a WebGPU draw command arriving with
   * no active pass during a render frame (legacy overlay commands from
   * `Scene._overlayCommandList`, executed after post-process) lazily opens
   * the default canvas pass. Historically those commands landed in the
   * canvas pass the post-process tail unconditionally re-opened; the tail
   * resume is now demand-driven, so the open happens here instead — same
   * target, same load ops (canvas already marked written by the PP blit).
   * Pick mini-frames (`_currentTextureView === null`) keep the silent skip.
   */
  override executeDrawCommand(
    command: CesiumAnyDrawCommand,
    _scene: CesiumScene,
    _passState: CesiumPassState,
    _debugFramebuffer?: CesiumOpaqueFramebuffer,
  ): void {
    let renderPass = this._currentRenderPassEncoder;
    if (
      !renderPass &&
      command.isWebGPUDrawCommand === true &&
      this._currentCommandEncoder !== null &&
      this._currentTextureView !== null
    ) {
      renderPass = this.resumeDefaultRenderPass();
    }
    if (!renderPass) {
      return;
    }
    if (command.isWebGPUDrawCommand === true) {
      command.execute(renderPass);
    }
    // Non-WebGPU commands are silently skipped (expected during transition)
  }

  /**
   * WebGPU override: execute compute commands that have the WebGPU compute flag.
   * Sun compute is handled procedurally in WebGPUEnvironmentRenderer, so
   * sunComputeCommand is skipped.
   */
  override executeComputeCommands(
    computeCommandList: CesiumComputeCommand[],
    _sunComputeCommand: CesiumComputeCommand | undefined,
    _computeEngine: CesiumOpaqueObject | undefined,
  ): void {
    for (let i = 0; i < computeCommandList.length; ++i) {
      const cmd = computeCommandList[i];
      if (cmd.isWebGPUComputeCommand) {
        cmd.execute(this);
      }
    }
  }

  /**
   * WebGPU override: delegate shadow casting to the SHADOW_MAP feature renderer.
   * Returns true to signal Scene.js that shadow casting was handled.
   */
  override executeShadowMapCastCommands(scene: CesiumScene): boolean {
    const shadowFR = this.getFeatureRenderer(FeatureRendererKey.SHADOW_MAP) as
      import("../GraphicsContext.js").SystemRenderer | undefined;
    if (!shadowFR?.renderCastPass) {
      return true; // Handled (no-op if no shadow renderer registered)
    }
    const { shadowState } = scene.frameState;
    // DP-H43 — honor `viewer.shadows = false` / scene-wide shadow gate.
    // WebGL's Scene.js per-command check (`shadowsEnabled && command.castShadows`)
    // skips the entire cast derivation when the flag is off. Mirror that
    // here at the pass entry so we don't iterate shadowMaps for nothing
    // (and so users don't pay the GPU cost of a depth-only pass when
    // shadows are disabled globally).
    if (!shadowState || shadowState.shadowsEnabled === false) {
      return true;
    }
    const { shadowMaps } = shadowState;
    const encoder = this._currentCommandEncoder;
    if (!encoder) {
      return true;
    }

    // CSM path: when cascaded shadow maps are enabled, compute splits,
    // fit cascades, and render every cast command once per cascade into
    // the cascade array texture. The CSM renderer owns its own UBO
    // (layout-compatible with the single-shadow-map path) and reuses
    // the same cast pipelines via the shared factory. Slice 1 scope:
    // `rte24` commands only; other vertex layouts are skipped.
    //
    // Gate on SCENE3D: the cascade frustum-corner math reads
    // `camera.frustum.fovy` + `aspectRatio` (perspective-only). In 2D
    // and Columbus View the camera uses OrthographicFrustum without
    // fovy — the default fallback (π/3) would produce garbage cascade
    // bounds. Morph mode is blended and unstable; skip too. Slice 3
    // adds altitude-adaptive ortho-mode splits.
    const isScene3D = scene.frameState?.mode === 3; /* SceneMode.SCENE3D */
    const csmRequested = scene.useCascadedShadowMaps === true && isScene3D;
    // Effects bind groups are assembled earlier during primitive update. A
    // CSM renderer created here is therefore not visible to this frame's
    // receivers yet. Warm it now, but keep the current frame on the complete
    // one-pass path; the next frame sees the persistent renderer and switches
    // cast + receive together.
    const useCSM = csmRequested && !!this._csmRenderer;
    if (csmRequested) {
      if (!this._csmRenderer) {
        // Scene.cascadedShadowMapResolution is a user-tunable surface
        // (scene property) — honor it at lazy-init time. Subsequent
        // changes don't re-allocate; user must dispose + reinit for
        // a different resolution to take effect.
        this._initCSMRenderer(
          scene.cascadedShadowMapResolution,
          scene.cascadedShadowMapSoftShadows,
        );
      }
      const csm = this._csmRenderer;
      if (useCSM && csm) {
        const camera = scene.frameState.camera;
        const frustum = camera.frustum;
        // Light direction: prefer the shadow map's lightCamera direction
        // (already set by Scene.js to face the light), negate to get
        // surface-toward-light for the cascade VP math. Fall back to
        // sunDirectionWC when no shadow map is active.
        const sunDir = scene._context?.uniformState?.sunDirectionWC as
          { x: number; y: number; z: number } | undefined;
        const lightDir = sunDir ?? { x: 0, y: 1, z: 0 };
        // PARITY-RTE-ELLIPSOID-AWARE (FEAT-3DT2-03) — thread the scene's
        // actual ellipsoid into the cascade ground-clamp so non-Earth
        // globes (Mars/Moon/scaled mocks) clamp against THEIR surface.
        // WGS84 scenes hit the change-detected early-out inside
        // setEllipsoid (byte-identical constants).
        csm.setEllipsoid(
          scene.ellipsoid?.radii ?? scene.globe?.ellipsoid?.radii,
        );
        // NEW-CSM-CASCADE-GROUND-FIT — clamp the split distribution to the
        // visible ground depth so the near cascade fits the actual receiver
        // patch (sub-metre/texel) instead of spreading over the whole
        // [near, maxShadowDistance] range. Mirrors WebGL ShadowMap clamping
        // sceneCamera.frustum.far to the visible scene volume.
        const groundFar = csm.computeVisibleGroundFar(camera);
        csm.computeSplits(frustum.near, frustum.far, groundFar);
        csm.computeCascadeVPs(camera, lightDir);
      }
    }

    for (let i = 0; i < shadowMaps.length; ++i) {
      const shadowMap = shadowMaps[i];
      if (shadowMap.outOfView) {
        continue;
      }
      // Collect each caster once for single-map/CSM scheduling and the
      // no-caster transition test. Keep the legacy pass lists populated until
      // after native encoding: point-light cube rendering consumes each
      // face's own culled list instead of drawing this union six times.
      const { passes } = shadowMap;
      const castCommands = collectUniqueShadowCastCommands(
        passes,
        this._shadowCastCommandsScratch,
        this._shadowCastCommandsSeen,
      );
      const activeShadowContentState =
        useCSM && i === 0 && this._csmRenderer
          ? this._csmRenderer._shadowContentState
          : (
              shadowMap as {
                _webgpuCache?: { shadowContentState?: string };
              }
            )._webgpuCache?.shadowContentState;
      // A transition from populated -> no casters still needs one clear-only
      // pass or receivers sample stale depth indefinitely. Once empty, both
      // renderers suppress repeated clears so the settled no-caster path stays
      // pass-free.
      if (castCommands.length > 0 || activeShadowContentState !== "empty") {
        this.endCurrentRenderPass();

        if (useCSM && this._csmRenderer) {
          // CSM replaces the PRIMARY shadow map's cascade set. Render
          // every cascade layer in one call — the renderer manages per-
          // cascade UBOs + bind groups internally and picks up the
          // compiled cast pipelines from a private cache so the single-
          // shadow-map path's cache stays untouched. Slice 1 scope: only
          // the first (primary, sun) shadow map drives CSM; additional
          // shadow maps keep the single-map path (spot lights, manual
          // secondary shadows). Slice 3 wires moon-light cascade pairs.
          if (i === 0) {
            const camera = scene.frameState.camera;
            // Batch 226 — pass the context so the CSM cast helper
            // can look up per-cascade culler instances + read the
            // gpuCullingHint for `'never'` short-circuit.
            this._csmRenderer.renderCastPass(
              encoder,
              castCommands as ReadonlyArray<unknown>,
              camera.positionWC,
              scene._frameState,
              this,
            );
          } else {
            shadowFR.renderCastPass(
              encoder,
              shadowMap,
              scene._frameState,
              castCommands,
            );
          }
        } else {
          // Single shadow map path (default).
          shadowFR.renderCastPass(
            encoder,
            shadowMap,
            scene._frameState,
            castCommands,
          );
        }

        this.resumeDefaultRenderPass();
      }
      for (let j = 0; j < passes.length; ++j) {
        passes[j].commandList.length = 0;
      }
      castCommands.length = 0;
      this._shadowCastCommandsSeen.clear();
    }
    return true;
  }

  /**
   * WebGPU override: set environment state flags and clear with background color.
   * Returns true to signal Scene.js that framebuffer setup was handled.
   */
  override updateAndClearFramebuffers(
    scene: CesiumScene,
    passState: CesiumPassState,
    clearColor: CesiumColor,
  ): boolean {
    const frameState = scene._frameState;
    const environmentState = scene._environmentState;
    const passes = frameState.passes;
    const picking = passes.pick || passes.pickVoxel;

    environmentState.originalFramebuffer = passState.framebuffer;

    const globe = scene._globe;
    // SceneMode constants: MORPHING=0, COLUMBUS_VIEW=1, SCENE2D=2, SCENE3D=3.
    // Mirrors upstream `Scene.js:3114-3117` — force globe-depth clear in
    // SCENE2D regardless of `depthTestAgainstTerrain`. The 14.5-pattern
    // bug (this used to read `=== 1` mis-labeled as SCENE2D) silently
    // broke SCENE2D rendering and made COLUMBUS_VIEW clear globe depth
    // unconditionally.
    environmentState.clearGlobeDepth =
      defined(globe) &&
      globe.show &&
      (!globe.depthTestAgainstTerrain ||
        scene.mode === 2); /* SceneMode.SCENE2D */
    environmentState.useDepthPlane =
      environmentState.clearGlobeDepth &&
      scene.mode === 3 /* SceneMode.SCENE3D */ &&
      scene._globeTranslucencyState.useDepthPlane;

    // C-R8-GLOBE-DEPTH-ENABLE (Batch 42) + C-R8-GLOBE-DEPTH-MSAA (Batch
    // 43) — flip the flag on for WebGPU so the globe-depth-framebuffer
    // path runs (matches WebGL's `FramebufferOrchestrator.js:59-60`
    // which sets this to `defined(view.globeDepth)`, i.e., always on
    // when not picking). Concrete user-visible effect:
    // `WebGPUSceneRenderer` instantiates `_globeDepth`, the post-tile
    // depth-copy hook fires (writing a sampleable packed depth
    // texture), and `pickPosition` reads that texture to translate
    // screen-space picks into world coordinates. Batch 43 added the
    // MSAA depth-sampling variant (`texture_depth_multisampled_2d` +
    // `textureLoad` sample-index-0) so the flag no longer needs an
    // MSAA gate — both sample counts are wired.
    environmentState.useGlobeDepthFramebuffer = !picking;

    environmentState.useOIT =
      !picking && scene._useOIT && defined(scene._alternateSceneRenderer);

    const postProcess = scene.postProcessStages;
    // WebGPU always needs the post-process pipeline active because the
    // scene renders to an offscreen framebuffer — the post-process
    // tonemapping/blit pass is the ONLY path that composites the scene
    // color to the canvas surface texture. Without it the canvas stays
    // black. The WebGL path can render directly to the canvas when
    // post-processing is off, but WebGPU cannot.
    environmentState.usePostProcess = !picking;
    environmentState.usePostProcessSelected = false;

    environmentState.useInvertClassification =
      !picking && scene.invertClassification;
    environmentState.renderTranslucentDepthForPick = false;

    // ── C9-09-ATTACHMENT-DEMAND-REGISTRY (FAR-401-C0) ──
    // Compute the ONE canonical attachment-demand record for this frame,
    // once, before any scene pass opens or any pipeline builds. Observe-only
    // in this slice: the record is frozen on the context and reported through
    // the debug snapshot, but nothing in the render path gates on it yet
    // (C9-10 is the slice that acts on `gbufferDemanded`). `forceSceneMRT`
    // defaults true, so `topology` is `"mrt"` every frame — matching the
    // always-MRT legacy executor. Reset the per-frame actual counters here so
    // the snapshot reflects only this frame.
    const actual = this._attachmentDemandActual;
    actual.gbufferAllocated = false;
    actual.gbufferBytes = 0;
    actual.gbufferMsaaCompanionBytes = 0;
    actual.sceneColorAttachmentCount = 0;
    actual.slot1AttachmentOpens = 0;
    actual.slot1ResolveOpens = 0;
    actual.sceneColorResolveOpens = 0;
    this._attachmentDemand = computeAttachmentDemand(
      scene as unknown as AttachmentDemandSceneLike,
      {
        forceSceneMRT: this.forceSceneMRT,
        picking: picking === true,
        globeDepth: environmentState.useGlobeDepthFramebuffer === true,
        postProcess: environmentState.usePostProcess === true,
      },
    );

    // Phase 8a Slice 1 (Batch 80) + Slice 2b (Batch 86) — G-buffer
    // allocation. Mirrors the gating block in
    // `FramebufferOrchestrator.js` which DOES NOT run on WebGPU
    // because the WebGPU context overrides `updateAndClearFramebuffers`
    // to return `true` (handled here, skip the rest of the orchestrator).
    // Without this block the `useDeferredLighting` flag has no effect
    // on the WebGPU backend — the framebuffer never allocates and the
    // producer dispatcher early-outs because `outputView` is null.
    // `Scene._view` is a JS module without an ambient type; structurally
    // unpack just the slots this block needs.
    const view = (
      scene as unknown as {
        _view?: {
          viewport: { width: number; height: number };
          gBufferFramebuffer?: {
            update(
              context: WebGPUContext,
              viewport: { width: number; height: number },
              hdr: boolean,
              numSamples: number,
            ): void;
            clear(context: WebGPUContext, passState: CesiumPassState): void;
          };
        };
      }
    )._view;
    // `useDeferredLighting` is a CONSUMER flag — it controls whether
    // AO / SSR / future clustered lighting opt into reading G-buffer
    // normals vs falling back to depth-derived. The G-buffer texture
    // itself is now allocated UNCONDITIONALLY (Slice 5c-B Phase 2 v2
    // Sub-B, Batch 115b) so the MRT render pass in Sub-C can bind it
    // as a slot-1 color attachment every frame without checking the
    // consumer flag. Memory cost: 1 single-sample rgba16float texture
    // (~16 MB at 1080p) plus an MSAA companion when scene.msaaSamples > 1.
    const useDeferredLighting =
      !picking &&
      frameState.useDeferredLighting === true &&
      view !== undefined &&
      view.gBufferFramebuffer !== undefined;
    environmentState.useDeferredLighting = useDeferredLighting;
    // Always-on allocation: gate only on !picking + view existence.
    // The compute producer in `WebGPUSceneRenderer._executeGBufferProducer`
    // still gates on `useDeferredLighting === true`, so allocating
    // the texture without enabling the consumer doesn't incur producer
    // dispatch cost — just the one-time GPU memory allocation.
    if (!picking && view?.gBufferFramebuffer) {
      // `_hdr` isn't in the ambient `CesiumScene` interface —
      // structurally narrow here. Mirrors the same access pattern used
      // in `FramebufferOrchestrator.js` (the WebGL side).
      const sceneExt = scene as unknown as {
        _hdr: boolean;
      };
      // Batch 244 (NEW-TAA-EFFECT-NEVER-ADDED first activation) — use
      // the EFFECTIVE sample count (`this._msaaSamples`, written by
      // `WebGPUSceneRenderer.prepareFrame`; TAA forces it to 1 per the
      // Batch 234 coupling), NOT the raw user `scene.msaaSamples`.
      // This was the lone scene-pass attachment producer still reading
      // the user setting: on the first taaEnabled frame it kept the
      // G-buffer's MSAA x4 companion bound as colorAttachments[1]
      // while every other attachment dropped to single-sample —
      // "sample count (4) does not match" killed the WHOLE scene pass
      // and the canvas went black for as long as TAA stayed on.
      view.gBufferFramebuffer.update(
        this,
        view.viewport,
        sceneExt._hdr,
        this._msaaSamples ?? 1,
      );
      view.gBufferFramebuffer.clear(this, passState);

      // C9-09 truthful reporting: record the ACTUAL G-buffer byte cost this
      // frame so the debug snapshot can assert the demand record matches
      // reality. rgba16float = 8 bytes/texel; the MSAA companion multiplies
      // by the effective sample count. `narrow` re-reads the allocated
      // dimensions/sample count that `update()` just committed.
      const gbfDims = view.gBufferFramebuffer as unknown as {
        _width?: number;
        _height?: number;
        _sampleCount?: number;
        framebuffer?: boolean;
      };
      const gw = gbfDims._width ?? 0;
      const gh = gbfDims._height ?? 0;
      const gsamples = gbfDims._sampleCount ?? 1;
      if (gbfDims.framebuffer === true && gw > 0 && gh > 0) {
        actual.gbufferAllocated = true;
        actual.gbufferBytes = gw * gh * 8;
        actual.gbufferMsaaCompanionBytes =
          gsamples > 1 ? gw * gh * 8 * gsamples : 0;
      }
    }
    // Actual scene-FB color topology this frame: MRT mode binds slot 0 +
    // slot 1 (2 attachments); one-target binds slot 0 only. Non-render
    // (pick) frames use the single-target pick topology.
    actual.sceneColorAttachmentCount = picking ? 1 : isSceneFBMrtMode() ? 2 : 1;

    // Batch 95 — drive the PostProcessStageCollection sync. The WebGL
    // orchestrator at `FramebufferOrchestrator.js:126` calls
    // `postProcess.update(context, useLogDepth, useHdr)` to populate the
    // `_webgpuCache` slot (via the POST_PROCESS_COLLECTION FR). Because
    // this override returns `true`, the orchestrator's call is skipped,
    // and without this line `configureWebGPUPostProcessPipeline` (which
    // runs later in `ensureResources`) sees an empty default cache and
    // never initializes AO / Bloom / DoF. Setting AO via
    // `scene.postProcessStages.ambientOcclusion.enabled = true` then has
    // no visible effect — caught by `probe-slice4-verify.mjs`.
    const ppc = scene.postProcessStages as unknown as
      | {
          update(
            context: WebGPUContext,
            useLogDepth: boolean,
            useHdr: boolean,
          ): void;
        }
      | undefined;
    if (ppc?.update) {
      const sceneHdr = (scene as unknown as { _hdr?: boolean })._hdr ?? false;
      ppc.update(this, !!frameState.useLogDepth, sceneHdr);
    }

    // SceneMode.SCENE2D = 2 (mirrors `Scene.js:3131`). The 14.5-pattern
    // bug had this as `!== 1` (which is COLUMBUS_VIEW), turning WebVR
    // off for 2.5D and on for 2D — the opposite of the WebGL behavior.
    environmentState.useWebVR =
      scene._useWebVR &&
      scene.mode !== 2 /* SceneMode.SCENE2D */ &&
      !passes.offscreen;

    const clear = scene._clearColorCommand;
    Color.clone(clearColor, clear.color);
    clear.execute(this, passState);
    return true;
  }

  /**
   * WebGPU override: no-op for now (OIT composite and post-processing
   * are not yet wired for WebGPU). Returns true to skip WebGL path.
   */
  /**
   * WebGPU override: create a WebGPUPickFramebuffer for GPU-based picking.
   * View.js calls this factory instead of directly importing WebGPUPickFramebuffer.
   */
  override createPickFramebuffer(): WebGPUPickFramebuffer {
    return new WebGPUPickFramebuffer(this);
  }

  override resolveFramebuffers(
    _scene: CesiumScene,
    _passState: CesiumPassState,
  ): boolean {
    return true;
  }

  /**
   * Destroy the context and free all resources
   */
  destroy(): void {
    if (this._isDestroyed) {
      return;
    }

    // C11-76 — reject readbacks that recorded a copy into the current frame
    // but were waiting for endFrame() to submit it. Context teardown can occur
    // before endFrame (and a pooled GPUDevice may remain alive), so leaving the
    // callbacks queued would strand their promises and retain feature buffers.
    // Abandon the unfinished encoder before destroying those feature owners.
    this._drainAfterFrameSubmitCallbacks(false);
    this._currentRenderPassEncoder = null;
    this._activePassTarget = null;
    this._currentCommandEncoder = null;

    // Unregister from the global ContextRegistry before destroying resources
    this._unregisterFromRegistry();
    this._destroyFeatureRenderers();

    // Signal in-flight device-loss recovery to abort. We don't await here
    // (destroy() is sync), but flipping the flag prevents the recovered
    // device from being promoted into the host after we've started tearing
    // down. _device.destroy() below is what actually fires the device.lost
    // promise on the recovery path.
    if (this._deviceLossRecovery) {
      // Fire-and-forget — dispose() handles its own catch
      void this._deviceLossRecovery.dispose();
      this._deviceLossRecovery = null;
    }

    // C-R13 (2026-04-16 renderer-deep review): destroy all subsystems
    // that own GPU resources BEFORE destroying the device. Each
    // `destroy()` below calls `.destroy()` on its owned buffers /
    // textures / query sets, and those calls require the device to
    // still be alive. Previously this block ran after `_device.destroy()`
    // which made the GPU validator flag teardown as an error and
    // leaked transient buffer contents on long-lived multi-viewer apps.

    // Destroy viewport quad utility
    if (this._viewportQuad) {
      this._viewportQuad.destroy();
      this._viewportQuad = null;
    }

    // Destroy mipmap generator
    if (this._mipmapGenerator) {
      this._mipmapGenerator.destroy();
      this._mipmapGenerator = null;
    }

    // Destroy advanced infrastructure singletons
    if (this._renderBundleManager) {
      this._renderBundleManager.destroy();
      this._renderBundleManager = null;
    }
    if (this._timestampProfiler) {
      this._timestampProfiler.destroy();
      this._timestampProfiler = null;
    }
    if (this._storageBufferPool) {
      this._storageBufferPool.destroy();
      this._storageBufferPool = null;
    }
    if (this._indirectDrawManager) {
      this._indirectDrawManager.destroy();
      this._indirectDrawManager = null;
    }
    if (this._gpuCuller) {
      this._gpuCuller.destroy();
      this._gpuCuller = null;
    }
    // Batch 222 — destroy the auxiliary culler instances added in
    // Batches 218 (translucent), 220 (per-opaque-frustum), and 221
    // (per-cascade). Without this they leak on context destruction
    // — at peak (1 translucent + 3 per-frustum + 4 per-cascade)
    // that's ~4 MB of orphaned VRAM per leaked context.
    if (this._gpuCullerTranslucent) {
      this._gpuCullerTranslucent.destroy();
      this._gpuCullerTranslucent = null;
    }
    for (const culler of this._gpuCullerByFrustum.values()) {
      culler.destroy();
    }
    this._gpuCullerByFrustum.clear();
    this._gpuCullerByFrustumInitializing.clear();
    for (const culler of this._gpuCullerByCascade.values()) {
      culler.destroy();
    }
    this._gpuCullerByCascade.clear();
    this._gpuCullerByCascadeInitializing.clear();
    if (this._pointCloudLOD) {
      this._pointCloudLOD.destroy();
      this._pointCloudLOD = null;
    }
    if (this._csmRenderer) {
      this._csmRenderer.destroy();
      this._csmRenderer = null;
    }
    if (this._bufferMapper) {
      this._bufferMapper.destroy();
      this._bufferMapper = null;
    }
    if (this._uniformAllocator) {
      this._uniformAllocator.destroy();
      this._uniformAllocator = null;
    }

    // Context-owned textures/caches must be released explicitly because a
    // pooled GPUDevice may outlive this context (including failed creates).
    destroyEnvironmentalEffectsCompositor(this);
    this._depthTexture?.destroy();
    this._depthTexture = null;
    this._depthTextureView = null;
    this._depthOnlyTextureView = null;
    this._defaultTexture?.destroy();
    this._defaultTexture = undefined;
    this._defaultEmissiveTexture?.destroy();
    this._defaultEmissiveTexture = undefined;
    this._defaultNormalTexture?.destroy();
    this._defaultNormalTexture = undefined;
    this._defaultCubeMap?.destroy();
    this._defaultCubeMap = undefined;
    for (const texture of this._pendingTextureDestroys) {
      texture.destroy();
    }
    this._pendingTextureDestroys.length = 0;
    // C9-12A — drop any undelivered imagery mip jobs on teardown.
    this._pendingImageryMipJobs.length = 0;
    this._environmentDemandRegistry.reset(this._deviceResourceGeneration);

    this._shaderCache.destroy();
    const textureCache = this._textureCache as { destroy?: () => void };
    textureCache.destroy?.();

    this._asyncResourceTelemetry?.destroy();
    this._asyncResourceTelemetry = null;
    this._asyncResources?.reset("context-destroyed");
    this._asyncResources = null;
    this.clearAllHDRFallbackListeners();

    // Clear buffer pools (drops device-owned buffers back for GC).
    this._bufferPool.clear();
    this._uniformBufferPool = [];

    // Clear caches that reference device-owned handles.
    this._samplerCache.clear();
    this._bindGroupLayoutCache.clear();
    this._bindGroupCache.clear();

    // Drop device-invalidation subscribers so their closures release
    // immediately even if a long-lived holder keeps this Context
    // reference alive. Batch 130 — explicit lifecycle cleanup that the
    // pre-extraction `Set<() => void>` field relied on GC for.
    this._deviceInvalidationBus.clear();

    // Drop the resource-cache registry's registered closures so they
    // don't keep this Context's own fields alive past destroy.
    // (Batch 131.)
    this._cacheRegistry.clear();

    // Drop the feature-flags enabled set. (Batch 132.) The Set is
    // small and would die with the Context anyway; explicit clear
    // matches the lifecycle pattern used by the bus + cache registry.
    this._featureFlags.clear();

    // Remove this context's lease from the device-level shader validation
    // wrapper. The last lease restores the device's original method, so a
    // failed create cannot leave a closure rooted in a shared pooled device.
    this._releaseShaderValidation?.();

    // Compatibility buffers are context-owned even when the physical device
    // is pooled. Drain every registered handle before releasing this
    // context's device lease; another context retaining the same GPUDevice
    // must not keep these otherwise-unbound allocations alive.
    this._gl.destroyCompatibilityBufferHandles();

    // Release this context's lease on device-level effects resources before
    // returning a pooled device. The final context owner drains buffers and
    // placeholder textures; earlier owners leave the shared cache intact.
    if (this._device) {
      releaseEffectsPlaceholderCacheForContext(this._device, this);
    }

    // Stop presenting from this canvas before releasing the device lease. The
    // final pooled owner destroys the GPUDevice synchronously, so unconfiguring
    // afterwards would leave presentation teardown racing a dead device.
    try {
      this._context?.unconfigure();
    } catch {
      // A lost canvas can already be unconfigured by the browser. Device and
      // pool ownership still has to be released even if presentation teardown
      // reports a late error.
    }

    // NOW destroy the device — everything that needed it has already run.
    // AUDIT_2026_05_02 C.1 (Batch 135) — when the device came from the
    // pool, release the reference so refcount drops; the pool destroys
    // the underlying GPUDevice only when the last context releases it.
    // When the device was supplied externally (e.g., legacy direct
    // injection or the recovery path before it switches to the pool),
    // call `destroy()` directly because no pool refcount exists for it.
    if (this._device) {
      if (this._deviceFromPool) {
        WebGPUDevicePool.instance.releaseDevice(this._device);
      } else if (!this._isTerminallyLost) {
        this._device.destroy();
      }
      // A terminally-lost isolated device was already destroyed by the
      // browser (or explicitly by the caller). Do not issue a second destroy;
      // some implementations reject it during loss teardown.
      this._device = null;
      this._deviceFromPool = false;
    }

    // Clear references
    this._adapter = null;
    this._context = null;
    this._isTerminallyLost = false;
    this._isDestroyed = true;
  }

  // ====================================================================================
  // WebGL to WebGPU State Conversion Helpers
  // Delegates to standalone functions in WebGLStateConverters.ts
  // ====================================================================================

  // The previous `_webglToWebGPUBlendFactor` / `_webglToWebGPUBlendOp` /
  // `_webglToWebGPUCompareFunction` wrapper methods existed only to feed
  // the WebGL-stub state literal. After the literal moved to
  // `WebGPUContextWebGLStubInit.ts` (Batch 129) the stub points
  // straight at the module-level functions in `WebGLStateConverters.ts`,
  // so the wrappers are gone.

  /**
   * Get current pipeline state for pipeline creation
   * @returns {object} Current pipeline state
   */
  getPipelineState(): WebGPUPipelineStateSnapshot {
    return {
      depthStencil: this._depthTestEnabled
        ? {
            format: this._depthFormat,
            depthWriteEnabled: this._depthWriteEnabled,
            depthCompare: this._depthCompare,
          }
        : undefined,
      blend: this._blendEnabled
        ? {
            color: {
              srcFactor: this._blendSrc,
              dstFactor: this._blendDst,
              operation: this._blendOp,
            },
            alpha: {
              srcFactor: this._blendSrcAlpha,
              dstFactor: this._blendDstAlpha,
              operation: this._blendOpAlpha,
            },
          }
        : undefined,
      primitive: {
        cullMode: this._cullFaceEnabled ? this._cullMode : "none",
        frontFace: this._frontFace,
      },
      colorWriteMask: this._colorWriteMask,
    };
  }

  // ====================================================================================
  // WebGPU-Specific Utility Methods (for actual WebGPU rendering)
  // ====================================================================================

  /**
   * Get or create a cached sampler
   * @param {GPUSamplerDescriptor} descriptor - Sampler descriptor
   * @returns {GPUSampler} The sampler
   */
  getOrCreateSampler(descriptor: GPUSamplerDescriptor): GPUSampler | null {
    if (this._isDeviceUnavailable || !this._device) {
      return null;
    }

    const key = JSON.stringify(descriptor);
    let sampler = this._samplerCache.get(key);

    if (!sampler) {
      sampler = this._device.createSampler(descriptor);
      this._samplerCache.set(key, sampler);
    }

    return sampler;
  }

  /**
   * Get or create a cached bind group layout
   * @param {GPUBindGroupLayoutDescriptor} descriptor - Bind group layout descriptor
   * @returns {GPUBindGroupLayout} The bind group layout
   */
  getOrCreateBindGroupLayout(
    descriptor: GPUBindGroupLayoutDescriptor,
  ): GPUBindGroupLayout | null {
    if (this._isDeviceUnavailable || !this._device) {
      return null;
    }

    const key = JSON.stringify(descriptor);
    let layout = this._bindGroupLayoutCache.get(key);

    if (!layout) {
      layout = this._device.createBindGroupLayout(descriptor);
      this._bindGroupLayoutCache.set(key, layout);
    }

    return layout;
  }

  /**
   * Create a bind group (not cached, as they contain buffer references that change)
   * @param {GPUBindGroupDescriptor} descriptor - Bind group descriptor
   * @returns {GPUBindGroup} The bind group
   */
  createBindGroup(descriptor: GPUBindGroupDescriptor): GPUBindGroup | null {
    if (this._isDeviceUnavailable || !this._device) {
      return null;
    }

    return this._device.createBindGroup(descriptor);
  }

  /**
   * Get a uniform buffer from the pool or create a new one - PRIORITY 3 ENHANCED
   * @param {number} size - Size in bytes
   * @returns {GPUBuffer | null} A uniform buffer
   */
  getUniformBuffer(size: number): GPUBuffer | null {
    if (this._isDeviceUnavailable || !this._device) {
      return null;
    }

    // Guard against zero or negative sizes
    size = Math.max(size, 4);
    // Align size to 256 bytes (uniform buffer alignment requirement)
    const alignedSize = Math.ceil(size / 256) * 256;

    // Try to reuse from pool - find best fit
    const availableBuffer = this._uniformBufferPool.find(
      (buf) => buf.size >= alignedSize && buf.size < alignedSize * 2, // Don't waste too much memory
    );

    if (availableBuffer) {
      const index = this._uniformBufferPool.indexOf(availableBuffer);
      this._uniformBufferPool.splice(index, 1);
      return availableBuffer;
    }

    // Create new buffer
    return this._device.createBuffer({
      size: alignedSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: `Uniform Buffer (Pooled, ${alignedSize} bytes)`,
    });
  }

  /**
   * Return a uniform buffer to the pool for reuse - PRIORITY 3 ENHANCED
   * @param {GPUBuffer} buffer - The buffer to return
   */
  returnUniformBuffer(buffer: GPUBuffer): void {
    if (buffer && this._isDeviceUnavailable) {
      buffer.destroy();
      return;
    }
    if (buffer && this._uniformBufferPool.length < 100) {
      // Limit pool size
      this._uniformBufferPool.push(buffer);
    } else if (buffer && this._uniformBufferPool.length >= 100) {
      // Pool is full - destroy the buffer
      buffer.destroy();
    }
  }

  /**
   * Get a buffer from the general buffer pool - PRIORITY 3 NEW
   * @param {string} type - Buffer type ('vertex', 'index', 'storage')
   * @param {number} size - Size in bytes
   * @param {GPUBufferUsageFlags} usage - Buffer usage flags
   * @returns {GPUBuffer | null} A buffer from the pool or newly created
   */
  getPooledBuffer(
    type: string,
    size: number,
    usage: GPUBufferUsageFlags,
  ): GPUBuffer | null {
    if (this._isDeviceUnavailable || !this._device) {
      return null;
    }

    const pool = this._bufferPool.get(type) || [];
    const availableBuffer = pool.find(
      (buf) => buf.size >= size && buf.size < size * 2,
    );

    if (availableBuffer) {
      const index = pool.indexOf(availableBuffer);
      pool.splice(index, 1);
      this._bufferPool.set(type, pool);
      return availableBuffer;
    }

    // Create new buffer — guard against zero size
    const safeSize = Math.max(size, 4);
    return this._device.createBuffer({
      size: safeSize,
      usage,
      label: `${type} Buffer (Pooled, ${safeSize} bytes)`,
    });
  }

  /**
   * Return a buffer to the general buffer pool - PRIORITY 3 NEW
   * @param {string} type - Buffer type ('vertex', 'index', 'storage')
   * @param {GPUBuffer} buffer - The buffer to return
   */
  returnPooledBuffer(type: string, buffer: GPUBuffer): void {
    if (!buffer) {
      return;
    }
    if (this._isDeviceUnavailable) {
      buffer.destroy();
      return;
    }

    const pool = this._bufferPool.get(type) || [];

    if (pool.length < 50) {
      // Limit per-type pool size
      pool.push(buffer);
      this._bufferPool.set(type, pool);
    } else {
      // Pool full - destroy buffer
      buffer.destroy();
    }
  }

  /**
   * Check if texture compression format is supported - PRIORITY 3 NEW
   * @param {string} format - Compression format name ('bc7', 'astc', 'etc2')
   * @returns {boolean} Whether the format is supported
   */
  supportsTextureCompression(format: string): boolean {
    if (this._isDeviceUnavailable || !this._device) {
      return false;
    }

    // Map format names to WebGPU texture compression features
    const featureMap: Record<string, GPUFeatureName> = {
      bc7: "texture-compression-bc",
      astc: "texture-compression-astc",
      etc2: "texture-compression-etc2",
    };

    const feature = featureMap[format.toLowerCase()];
    if (!feature) {
      return false;
    }

    return this._device.features.has(feature);
  }

  /**
   * Get supported texture compression formats - PRIORITY 3 NEW
   * @returns {string[]} Array of supported compression format names
   */
  getSupportedCompressionFormats(): string[] {
    if (this._isDeviceUnavailable || !this._device) {
      return [];
    }

    const formats: string[] = [];

    if (this._device.features.has("texture-compression-bc")) {
      formats.push("bc7", "s3tc");
      this._s3tc = true;
      this._bc7 = true;
    }

    if (this._device.features.has("texture-compression-astc")) {
      formats.push("astc");
      this._astc = true;
    }

    if (this._device.features.has("texture-compression-etc2")) {
      formats.push("etc2", "etc");
      this._etc = true;
    }

    return formats;
  }

  /**
   * Copy texture to texture (texture copy operation) - PRIORITY 1 NEW
   * Equivalent to WebGL's copyTexImage2D / copyTexSubImage2D
   * @param {GPUTexture} source - Source texture
   * @param {GPUTexture} destination - Destination texture
   * @param {GPUOrigin3D} [sourceOrigin] - Source origin (default: {x: 0, y: 0, z: 0})
   * @param {GPUOrigin3D} [destinationOrigin] - Destination origin (default: {x: 0, y: 0, z: 0})
   * @param {GPUExtent3D} [copySize] - Copy size (default: source texture size)
   *
   * @example
   * // Copy entire texture
   * context.copyTexture(sourceTexture, destTexture);
   *
   * // Copy region
   * context.copyTexture(
   *   sourceTexture, destTexture,
   *   { x: 64, y: 64, z: 0 },
   *   { x: 0, y: 0, z: 0 },
   *   { width: 128, height: 128 }
   * );
   */
  copyTexture(
    source: GPUTexture,
    destination: GPUTexture,
    sourceOrigin?: GPUOrigin3D,
    destinationOrigin?: GPUOrigin3D,
    copySize?: GPUExtent3D,
  ): void {
    if (this._isDeviceUnavailable) {
      //>>includeStart('debug', pragmas.debug);
      throw new DeveloperError(
        this._isDestroyed
          ? "Context has been destroyed."
          : "Context's WebGPU device is terminally lost.",
      );
      //>>includeEnd('debug');
      return;
    }
    //>>includeStart('debug', pragmas.debug);
    if (!this._currentCommandEncoder) {
      throw new DeveloperError(
        "No active command encoder. Call beginFrame() first.",
      );
    }
    //>>includeEnd('debug');

    // Default values
    const srcOrigin = sourceOrigin ?? { x: 0, y: 0, z: 0 };
    const dstOrigin = destinationOrigin ?? { x: 0, y: 0, z: 0 };
    const size = copySize ?? {
      width: source.width,
      height: source.height,
      depthOrArrayLayers: 1,
    };

    // Perform copy
    this._currentCommandEncoder.copyTextureToTexture(
      {
        texture: source,
        origin: srcOrigin,
      },
      {
        texture: destination,
        origin: dstOrigin,
      },
      size,
    );
  }

  /**
   * Copy texture region with convenience wrapper - PRIORITY 1 NEW
   * Simplified version of copyTexture for common use cases
   * @param {GPUTexture} source - Source texture
   * @param {GPUTexture} destination - Destination texture
   * @param {number} srcX - Source X coordinate
   * @param {number} srcY - Source Y coordinate
   * @param {number} dstX - Destination X coordinate
   * @param {number} dstY - Destination Y coordinate
   * @param {number} width - Copy width
   * @param {number} height - Copy height
   *
   * @example
   * context.copyTextureRegion(sourceTexture, destTexture, 64, 64, 0, 0, 128, 128);
   */
  copyTextureRegion(
    source: GPUTexture,
    destination: GPUTexture,
    srcX: number,
    srcY: number,
    dstX: number,
    dstY: number,
    width: number,
    height: number,
  ): void {
    this.copyTexture(
      source,
      destination,
      { x: srcX, y: srcY, z: 0 },
      { x: dstX, y: dstY, z: 0 },
      { width, height, depthOrArrayLayers: 1 },
    );
  }

  /**
   * Create a texture from image data - PRIORITY 3 NEW
   * Helper method for common texture creation from images.
   *
   * Synchronous fast path: copies the source as-is via
   * `queue.copyExternalImageToTexture`. This does NOT respect EXIF orientation
   * — for `HTMLImageElement` decoded from a JPEG with a non-trivial Orientation
   * tag, the GPU sees pixels in their unrotated layout. If the caller needs
   * orientation handling, route through {@link createTextureFromImageAsync}
   * which uses the WGF-8 `WebGPUImageUpload` helper to bake EXIF rotation in
   * via `createImageBitmap`.
   *
   * @param {ImageBitmap | HTMLImageElement | HTMLCanvasElement} source - Image source
   * @param {GPUTextureFormat} [format='rgba8unorm'] - Texture format
   * @param {boolean} [generateMipmaps=false] - Whether to generate mipmaps
   * @returns {WebGPUTexture | null} The created texture
   */
  createTextureFromImage(
    source: ImageBitmap | HTMLImageElement | HTMLCanvasElement,
    format: GPUTextureFormat = "rgba8unorm",
    generateMipmaps: boolean = false,
  ): WebGPUTexture | null {
    if (this._isDeviceUnavailable || !this._device) {
      return null;
    }

    const width =
      "width" in source ? source.width : (source as HTMLCanvasElement).width;
    const height =
      "height" in source ? source.height : (source as HTMLCanvasElement).height;
    const mipLevelCount = generateMipmaps
      ? Math.floor(Math.log2(Math.max(width, height))) + 1
      : 1;

    const texture = WebGPUTexture.create2D(
      this._device,
      width,
      height,
      format,
      mipLevelCount,
      "Texture from Image",
    );

    // Copy image to texture using queue.copyExternalImageToTexture
    if (this._device.queue) {
      this._device.queue.copyExternalImageToTexture(
        { source: source as ImageBitmap },
        { texture: texture.texture },
        { width, height },
      );
    }

    // Generate mipmaps if requested and texture has multiple mip levels
    if (generateMipmaps && mipLevelCount > 1) {
      texture.generateMipmaps(this.mipmapGenerator);
    }

    return texture;
  }

  /**
   * Async variant of {@link createTextureFromImage} that routes through the
   * WGF-8 {@link WebGPUImageUpload} helper. Use this when the source is an
   * `HTMLImageElement` or `Blob` that may carry EXIF orientation metadata
   * (rotated phone photos, scanned documents) — the helper decodes through
   * `createImageBitmap({ imageOrientation: "from-image" })` so the resulting
   * texture pixels are upright.
   *
   * Allocates the destination texture *before* awaiting the decode so callers
   * that need a placeholder ID immediately can chain off the returned promise
   * without an extra round trip.
   */
  async createTextureFromImageAsync(
    source:
      | ImageBitmap
      | HTMLImageElement
      | HTMLCanvasElement
      | OffscreenCanvas
      | Blob,
    format: GPUTextureFormat = "rgba8unorm",
    generateMipmaps: boolean = false,
    options: {
      flipY?: boolean;
      premultipliedAlpha?: boolean;
      respectEXIF?: boolean;
    } = {},
  ): Promise<WebGPUTexture | null> {
    if (this._isDeviceUnavailable || !this._device) {
      return null;
    }

    const { WebGPUImageUpload } = await import("./WebGPUImageUpload.js");
    // NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 5) — pass the monitor so
    // the bitmap decode publishes a wakeup event when it lands. Without
    // this, an environment-map decode that finishes after the scene
    // hibernates leaves the canvas frozen with the missing texture.
    const decoded = await WebGPUImageUpload.decodeWithOrientation(
      source,
      this.asyncResources,
      "Texture from Image (async)",
    );

    // Decoding can outlive a terminal loss. Do not allocate or upload through
    // the retained dead device during the short interval before teardown.
    if (this._isDeviceUnavailable || !this._device) {
      if (decoded !== source && "close" in decoded) {
        decoded.close();
      }
      return null;
    }

    // After EXIF rotation the bitmap dimensions can be swapped (90°/270°), so
    // pull width/height from the decoded surface, not the original source.
    const width = (decoded as { width: number }).width;
    const height = (decoded as { height: number }).height;
    const mipLevelCount = generateMipmaps
      ? Math.floor(Math.log2(Math.max(width, height))) + 1
      : 1;

    const texture = WebGPUTexture.create2D(
      this._device,
      width,
      height,
      format,
      mipLevelCount,
      "Texture from Image (async)",
    );

    await WebGPUImageUpload.uploadImageToTexture(
      this._device,
      decoded,
      texture.texture,
      {
        respectEXIF: false, // already decoded above
        flipY: options.flipY,
        premultipliedAlpha: options.premultipliedAlpha,
      },
    );

    if (generateMipmaps && mipLevelCount > 1) {
      texture.generateMipmaps(this.mipmapGenerator);
    }

    return texture;
  }

  /**
   * Create a staging buffer for data upload - PRIORITY 3 NEW
   * @param {number} size - Size in bytes
   * @returns {GPUBuffer | null} A staging buffer
   */
  createStagingBuffer(size: number): GPUBuffer | null {
    if (this._isDeviceUnavailable || !this._device) {
      return null;
    }

    // Guard against zero size
    const safeSize = Math.max(size, 4);
    return this._device.createBuffer({
      size: safeSize,
      usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
      label: "Staging Buffer",
    });
  }

  /**
   * Gets or lazily creates the shared mipmap generator for this context.
   * The generator caches its shader module and pipelines per texture format
   * so repeated mipmap generation is efficient.
   *
   * @returns {WebGPUMipmapGenerator} The mipmap generator
   */
  get mipmapGenerator(): WebGPUMipmapGenerator {
    if (!this._mipmapGenerator && this._device && !this._isDeviceUnavailable) {
      this._mipmapGenerator = new WebGPUMipmapGenerator(this._device);
      // C-R12 (Batch 33) — on device-loss, drop the reference so the
      // next access rebuilds against the recovered device. Calling
      // `destroy()` on the stale instance is pointless — its internal
      // GPUBuffer.destroy() calls fail against the dead device anyway.
      this.onDeviceInvalidated(() => {
        this._mipmapGenerator = null;
        // C9-12A — drop any imagery mip jobs queued for the lost device;
        // encoding them with the recovered device's generator would be a
        // cross-device validation error. Their textures die with the device.
        this._pendingImageryMipJobs.length = 0;
      });
    }
    return this._mipmapGenerator!;
  }

  // ====================================================================================
  // Advanced Infrastructure — Lazy-Initialized Singletons
  // These are exposed via getters and created on first access.
  // ====================================================================================

  private _renderBundleManager: WebGPURenderBundleManager | null = null;
  // NEW-WEBGPU-COMPUTE-ENGINE-WIRING (Batch 367, item 370) — general-purpose
  // compute dispatch engine. Lazy-initialized via the `computeEngine` getter
  // so contexts that never run compute pay zero cost. Dropped on device loss
  // (caches dead GPUComputePipelines). Mirrors `_renderBundleManager`.
  private _computeEngine: WebGPUComputeEngine | null = null;
  private _timestampProfiler: WebGPUTimestampProfiler | null = null;
  private _storageBufferPool: WebGPUStorageBufferPool | null = null;
  private _indirectDrawManager: WebGPUIndirectDrawManager | null = null;
  private _bufferMapper: WebGPUBufferMapper | null = null;
  private _performanceManager: WebGPUPerformanceManager | null = null;
  private _uniformAllocator: WebGPURingBufferAllocator | null = null;
  // B220-O1 (Batch 225) — defensive cap on auxiliary culler allocation.
  // Moved to `WebGPUContextCullerPool.ts` as `MAX_AUX_CULLER_INDEX` (Q35
  // decomposition slice); the culler-pool free functions own it now.

  // B219-N3 (Batch 225 audit fix) — Scene-level GPU culling hint
  // mirrored on the context so lazy aux-culler getters can refuse
  // allocation when the user set `Scene.gpuCullingHint = 'never'`.
  // Previously 'never' was stored on Scene but never read by the
  // allocation path; if a render frame ever hit a gate-active code
  // path (e.g., a partial regression), the lazy getter would still
  // burn VRAM. Closes the asymmetry — 'never' truly disables.
  // Public-underscore: read+written by the culler-pool helpers
  // (`WebGPUContextCullerPool.ts`) and `setGpuCullingHint`.
  public _gpuCullingHint: "auto" | "always" | "never" = "never";

  // NEW-AUX-CULLER-IDLE-DECAY (Batch 229) — track when each
  // auxiliary culler instance was last used, and periodically reap
  // cullers idle for >= IDLE_DECAY_FRAMES. The destroy() walk
  // (Batch 222) handles context teardown, but during a long-running
  // session that transitions from high-density → low-density and
  // stays there, the auxiliary cullers stay allocated forever
  // (~1 MB/instance × up to 8 = ~8 MB VRAM). The decay reaps them
  // automatically; lazy getters reallocate on demand if usage
  // returns. The internal frame id is bumped from `beginFrame()`
  // so the comparison is purely against this context's lifetime.
  // IDLE_DECAY_FRAMES moved to `WebGPUContextCullerPool.ts` (Q35 slice); the
  // reaper free function owns the threshold. IDLE_DECAY_CHECK_INTERVAL stays
  // here — it drives the `beginFrame()` cadence that calls the reaper.
  private static readonly IDLE_DECAY_CHECK_INTERVAL = 120; // 2s
  // Public-underscore: the culler-pool helpers read/write these.
  public _internalFrameId: number = 0;
  public _gpuCullerLastUsed: number = 0;
  public _gpuCullerTranslucentLastUsed: number = 0;
  public _gpuCullerByFrustumLastUsed: Map<number, number> = new Map();
  public _gpuCullerByCascadeLastUsed: Map<number, number> = new Map();

  public _gpuCuller: GPUCullerInstance | null = null;
  public _gpuCullerInitializing: boolean = false;
  // B216-N1 (Batch 218 audit fix) — separate culler instance for the
  // translucent pass. The dispatcher reuses ONE staging buffer
  // (`_readbackBuffer`); if opaque + translucent both
  // `prepareReadback` against the same instance in the same encoder,
  // the second copy clobbers the first, corrupting opaque's readback.
  // Using a second instance gives translucent its own buffers.
  public _gpuCullerTranslucent: GPUCullerInstance | null = null;
  public _gpuCullerTranslucentInitializing: boolean = false;
  // NEW-MULTIFRUSTUM-CULL-RESULTS (Batch 220) — per-frustum culler
  // instances for the opaque pass. Same root cause as B216-N1: the
  // shared `_visibilityBuffer` + `_readbackBuffer` get clobbered when
  // multiple frustums call `prepareReadback` in the same encoder.
  // Frustum 0 reuses `_gpuCuller` (the original instance) so existing
  // single-frustum scenes don't pay extra VRAM. Frustums 1..N get
  // their own instances on first use. Typical scene has 1-4 frustums
  // → at most 3 extra instances ≈ ~1.5 MB total VRAM.
  public _gpuCullerByFrustum: Map<number, GPUCullerInstance> = new Map();
  public _gpuCullerByFrustumInitializing: Set<number> = new Set();
  // NEW-SHADOW-CAST-GPU-CULL Phase 1 (Batch 221) — per-cascade
  // culler instances for CSM shadow cast. Same B216-N1 / Batch 220
  // pattern: each cascade needs its own staging buffer to avoid
  // collision in the encoder. Phase 1 ships infrastructure ONLY;
  // activation (filter dispatch in `WebGPUCSMCastPass`) is deferred
  // pending Gribb-Hartmann plane extraction + visual verification.
  // See `NEW-SHADOW-CAST-GPU-CULL-PHASE-2` in DEFERRED_WORK.md.
  public _gpuCullerByCascade: Map<number, GPUCullerInstance> = new Map();
  public _gpuCullerByCascadeInitializing: Set<number> = new Set();
  private _pointCloudLOD: WebGPUPointCloudLODProcessorInstance | null = null;
  private _pointCloudLODInitializing: boolean = false;
  private _csmRenderer: WebGPUCSMRenderer | null = null;

  /**
   * Ring buffer allocator for per-frame uniform buffer suballocation.
   * Reduces GPU memory fragmentation by suballocating from pre-created pages
   * instead of creating new buffers each frame. Triple-buffered (3 pages).
   * Lazy-initialized on first access.
   */
  /**
   * Cascaded shadow map renderer. Lazy-initialized the first frame
   * `scene.useCascadedShadowMaps` is true. Exposed so the globe surface
   * + primitive bind-group builders can read the cascade params UBO +
   * depth array view without reaching into private state.
   */
  get csmRenderer(): WebGPUCSMRenderer | null {
    return this._csmRenderer;
  }

  get uniformAllocator(): WebGPURingBufferAllocator | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._uniformAllocator && this._device) {
      this._uniformAllocator = new WebGPURingBufferAllocator(this._device, {
        pageSize: 4 * 1024 * 1024, // 4MB per page
        pageCount: 3, // Triple-buffered
        minAlignment: 256, // WebGPU uniform buffer offset alignment
        label: "Uniform ring buffer",
      });
    }
    return this._uniformAllocator;
  }

  /**
   * Performance manager that orchestrates all WebGPU performance infrastructure:
   * render bundles, indirect drawing, GPU culling, timestamp profiling, buffer mapping.
   * Lazy-initialized on first access. Configure via `performanceManager.config`.
   */
  get performanceManager(): WebGPUPerformanceManager {
    if (!this._performanceManager) {
      // WebGPUPerformanceManager is partially implemented: its
      // PerformanceManagerContext interface declares the full intended
      // API (appendDraw, buildAndSubmit, beginPass/endPass, etc.) that
      // WebGPUContext will satisfy once IndirectDrawManager and
      // TimestampProfiler are completed. Until then, the structural
      // mismatch is real and the cast bridges the in-progress gap.
      this._performanceManager = new WebGPUPerformanceManager(
        this as unknown as ConstructorParameters<
          typeof WebGPUPerformanceManager
        >[0],
      );
    }
    return this._performanceManager;
  }

  /**
   * Render bundle manager for caching static geometry draw calls.
   * Pre-encodes draw commands for terrain tiles, buildings, etc.
   * Gives 50-80% CPU reduction for static geometry.
   *
   * Overrides `GraphicsContext.renderBundleManager` (default `null`),
   * so Scene code can `ctx.renderBundleManager` without branching on
   * backend — WebGL will silently see `null` and skip the snapshot
   * freezable registration.
   */
  override get renderBundleManager(): WebGPURenderBundleManager | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._renderBundleManager && this._device) {
      this._renderBundleManager = new WebGPURenderBundleManager(this._device);
      // C-R12 (Batch 33) — bundles hold references to pipelines /
      // buffers that are invalid after device loss. Drop them.
      this.onDeviceInvalidated(() => {
        this._renderBundleManager = null;
      });
    }
    return this._renderBundleManager;
  }

  /**
   * NEW-WEBGPU-COMPUTE-ENGINE-WIRING (Batch 367, item 370) — general-purpose
   * WebGPU compute engine. Until this getter existed, `WebGPUContext.computeEngine`
   * was `undefined`, so every `WebGPUPerformanceManager.dispatchCompute()` call
   * (atmosphere LUT bake, frustum cull, point-cloud sort/LOD, GPU sort keys,
   * Hi-Z, normal-from-depth, polygon SDF) returned early as a silent no-op.
   * Lazy-initialized on first access once the device exists; returns `null`
   * during early bring-up. Wired to the per-context central compute-pipeline
   * cache (cross-instance dedup for layout-explicit callers) and the
   * async-resource monitor (the `createPipelineAsync` path). Dropped on device
   * loss — it caches GPUComputePipelines invalid after the device is recreated.
   */
  get computeEngine(): WebGPUComputeEngine | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._computeEngine && this._device) {
      this._computeEngine = new WebGPUComputeEngine(
        this._device,
        this.webgpuComputePipelineCache ?? undefined,
      );
      this._computeEngine.asyncResourceMonitor = this.asyncResources;
      this.onDeviceInvalidated(() => {
        this._computeEngine?.destroy();
        this._computeEngine = null;
      });
    }
    return this._computeEngine;
  }

  /**
   * C9-09-ATTACHMENT-DEMAND-REGISTRY debug surface. Returns the frozen
   * per-frame demand record (the registry's prediction) alongside the
   * ACTUAL measured scene-FB attachment behavior this frame, so callers can
   * assert the two agree (`record.topology` vs `actual.sceneColorAttachmentCount`,
   * `record.gbufferDemanded` vs `actual.gbufferAllocated`). Read by
   * `Scene.getDebugSnapshot().attachmentDemand`. Pure read.
   *
   * @returns The demand record + actual counters, or null before the first frame.
   */
  getAttachmentDemandStats(): {
    record: AttachmentDemandRecord;
    actual: {
      mrtTopologyActive: boolean;
      gbufferAllocated: boolean;
      gbufferBytes: number;
      gbufferMsaaCompanionBytes: number;
      sceneColorAttachmentCount: number;
      slot1AttachmentOpens: number;
      slot1ResolveOpens: number;
      sceneColorResolveOpens: number;
    };
    forceSceneMRT: boolean;
    recordMatchesActual: boolean;
  } | null {
    const record = this._attachmentDemand;
    if (record === null) {
      return null;
    }
    const a = this._attachmentDemandActual;
    const mrtTopologyActive = isSceneFBMrtMode();
    // The record describes actual behavior when its topology matches the
    // scene-FB color-attachment count the executor actually used (2 => mrt,
    // 1 => one-target). Pick frames are single-target by construction and
    // excluded from the render-topology equivalence.
    const topologyMatchesCount =
      record.topology === "mrt"
        ? a.sceneColorAttachmentCount === 2
        : a.sceneColorAttachmentCount === 1;
    // C9-AUDIT-P1-SWEEP (Batch 684): the attachment-count comparison above is
    // near-tautological with the same demand flag the record was derived from.
    // Fold the INDEPENDENTLY-MEASURED slot-1 open counter in so a non-pick
    // frame only "matches" when the predicted MRT topology also coincides with
    // slot-1 attachments having actually opened this frame (mrt <=> opens>0).
    const slot1Opened = a.slot1AttachmentOpens > 0;
    const recordMatchesActual =
      record.other.picking === true
        ? true
        : topologyMatchesCount && (record.topology === "mrt") === slot1Opened;
    return {
      record,
      actual: {
        mrtTopologyActive,
        gbufferAllocated: a.gbufferAllocated,
        gbufferBytes: a.gbufferBytes,
        gbufferMsaaCompanionBytes: a.gbufferMsaaCompanionBytes,
        sceneColorAttachmentCount: a.sceneColorAttachmentCount,
        slot1AttachmentOpens: a.slot1AttachmentOpens,
        slot1ResolveOpens: a.slot1ResolveOpens,
        sceneColorResolveOpens: a.sceneColorResolveOpens,
      },
      forceSceneMRT: this.forceSceneMRT,
      recordMatchesActual,
    };
  }

  /**
   * C11-193 observe-only registration seam used by backend-neutral Scene
   * producers. No refresh work is gated here; UNKNOWN remains conservative.
   */
  recordEnvironmentMapDemand(
    manager: object,
    demand: WebGPUEnvironmentDemandValue,
    reason: "tileset-selection" | "standalone-owner",
    consumerCount = 0,
  ): void {
    const reasonBit =
      reason === "tileset-selection"
        ? WebGPUEnvironmentDemandReason.TILESET_SELECTION
        : WebGPUEnvironmentDemandReason.STANDALONE_OWNER;

    if (demand === WebGPUEnvironmentDemand.DEMANDED) {
      this._environmentDemandRegistry.registerDemand(
        manager,
        reasonBit,
        consumerCount,
      );
    } else if (demand === WebGPUEnvironmentDemand.PROVEN_NONE) {
      this._environmentDemandRegistry.registerProvenNoDemand(
        manager,
        reasonBit,
      );
    } else {
      this._environmentDemandRegistry.registerUnknown(
        manager,
        reasonBit,
        consumerCount,
      );
    }
  }

  /** Record what today's unconditional manager update observed. */
  observeEnvironmentMapDemand(manager: object): WebGPUEnvironmentDemandValue {
    return this._environmentDemandRegistry.observeUpdate(manager);
  }

  /** Allocation-bearing debug snapshot; never used to gate renderer work. */
  getEnvironmentMapDemandStats(): WebGPUEnvironmentDemandTelemetry {
    return this._environmentDemandRegistry.getTelemetry();
  }

  /**
   * Phase 6 debug surface — overrides {@link GraphicsContext#getRendererStatistics}
   * to expose WebGPU-specific introspection: bundle cache state, fog
   * froxel grid state, GPU memory pool usage, indirect draw counters,
   * etc. Pure read; safe to call from `Scene.getDebugSnapshot()` even
   * when Scene code can't import from `Renderer/WebGPU/`.
   *
   * Most fields are populated lazily — they only return non-empty data
   * once the corresponding subsystem has been touched at least once
   * during a frame. Callers should treat every field as optional.
   */
  override getRendererStatistics(): DebugStatsObject {
    const stats: { [k: string]: DebugStatsValue | undefined } = {
      backend: "webgpu",
      contextId: this._id,
      hasDevice: !!this._device,
      isDestroyed: this.isDestroyed(),
    };
    if (this._renderBundleManager) {
      try {
        stats.bundleManager = this._renderBundleManager.statistics;
      } catch (e) {
        stats.bundleManager = { error: String((e as Error)?.message ?? e) };
      }
    }
    if (this._performanceManager) {
      // `frameTimings` is a getter on WebGPUPerformanceManager that returns
      // the per-pass GPU timing snapshot. Every field is a number or a
      // `Record<string, number>`, which DebugStatsObject accepts via its
      // index-signature shape — no cast required.
      try {
        stats.performance = this._performanceManager.frameTimings;
      } catch (e) {
        stats.performance = { error: String((e as Error)?.message ?? e) };
      }
    }
    if (this._timestampProfiler) {
      try {
        const tp = this._timestampProfiler;
        if (tp && typeof tp.getResults === "function") {
          // ProfilingResults extends DebugStatsObject at source, so this
          // assigns directly with no cast.
          stats.timestamps = tp.getResults();
        }
      } catch (e) {
        stats.timestamps = { error: String((e as Error)?.message ?? e) };
      }
    }
    if (this._indirectDrawManager) {
      stats.indirectDraw = {
        drawCount: this._indirectDrawManager.drawCount ?? 0,
      };
    }
    // Volumetric fog renderer is wired through the feature renderer
    // registry, not a direct context field. Pull it via the standard
    // dispatch path so the lookup respects the lazy load contract.
    try {
      const fogFR = this.getFeatureRenderer(
        FeatureRendererKey.VOLUMETRIC_FOG,
      ) as
        | (CesiumFeatureRenderer & { getStatistics?: () => DebugStatsObject })
        | undefined;
      if (fogFR && typeof fogFR.getStatistics === "function") {
        stats.volumetricFog = fogFR.getStatistics();
      }
    } catch (e) {
      stats.volumetricFog = { error: String((e as Error)?.message ?? e) };
    }
    // Phase 3 — Hi-Z occlusion + GPU sort keys diagnostic snapshots.
    try {
      const hiZFR = this.getFeatureRenderer(
        FeatureRendererKey.HI_Z_OCCLUSION,
      ) as
        | (CesiumFeatureRenderer & { getStatistics?: () => DebugStatsObject })
        | undefined;
      if (hiZFR && typeof hiZFR.getStatistics === "function") {
        stats.hiZOcclusion = hiZFR.getStatistics();
      }
    } catch (e) {
      stats.hiZOcclusion = { error: String((e as Error)?.message ?? e) };
    }
    try {
      const sortFR = this.getFeatureRenderer(
        FeatureRendererKey.GPU_SORT_KEYS,
      ) as
        | (CesiumFeatureRenderer & { getStatistics?: () => DebugStatsObject })
        | undefined;
      if (sortFR && typeof sortFR.getStatistics === "function") {
        stats.gpuSortKeys = sortFR.getStatistics();
      }
    } catch (e) {
      stats.gpuSortKeys = { error: String((e as Error)?.message ?? e) };
    }
    // Point cloud sort dispatcher stats.
    try {
      const pcSortFR = this.getFeatureRenderer(
        FeatureRendererKey.POINT_CLOUD_SORT,
      ) as
        | (CesiumFeatureRenderer & { getStatistics?: () => DebugStatsObject })
        | undefined;
      if (pcSortFR && typeof pcSortFR.getStatistics === "function") {
        stats.pointCloudSort = pcSortFR.getStatistics();
      }
    } catch (e) {
      stats.pointCloudSort = { error: String((e as Error)?.message ?? e) };
    }
    // CSM renderer stats.
    if (this._csmRenderer) {
      try {
        stats.csmShadows = this._csmRenderer.getStatistics();
      } catch (e) {
        stats.csmShadows = { error: String((e as Error)?.message ?? e) };
      }
    }
    // C11-174 — render-pipeline + post-process bind-group cache
    // effectiveness counters. Pure exposure of bookkeeping both caches
    // already pay for on their lookup paths — no new per-frame work. A
    // near-zero bind-group hitRate is the Batch-717 churn shape (resource
    // identities recreated every frame without cache invalidation).
    if (this._webgpuPipelineCache) {
      try {
        stats.pipelineCache = { ...this._webgpuPipelineCache.getStats() };
      } catch (e) {
        stats.pipelineCache = { error: String((e as Error)?.message ?? e) };
      }
    }
    stats.environmentMapDemand = {
      ...this._environmentDemandRegistry.getTelemetry(),
    };
    const ppCacheSource = this._postProcessCacheStatsSource;
    if (ppCacheSource && !ppCacheSource.isDestroyed) {
      try {
        const bg = ppCacheSource.getBindGroupCacheStats();
        stats.bindGroupCaches = {
          bloom: bg.bloom ? { ...bg.bloom } : null,
          ambientOcclusion: bg.ambientOcclusion
            ? { ...bg.ambientOcclusion }
            : null,
          autoExposure: bg.autoExposure ? { ...bg.autoExposure } : null,
        };
      } catch (e) {
        stats.bindGroupCaches = { error: String((e as Error)?.message ?? e) };
      }
    }
    // Phase 5 — capability snapshot. Lists every WebGPU optional
    // feature the device negotiated successfully so an operator can
    // confirm at a glance what's available on this adapter. The list
    // is the source of truth for "can I wire shader-f16 yet" decisions.
    stats.capabilities = {
      enabledFeatures: this.enabledFeatures,
      hasShaderF16: this.hasFeature("shader-f16"),
      hasDualSourceBlending: this.hasFeature("dual-source-blending"),
      hasClipDistances: this.hasFeature("clip-distances"),
      useHardwareClipDistances: this.useHardwareClipDistances,
      useShaderF16: this.useShaderF16,
      hasTimestampQuery: this.hasFeature("timestamp-query"),
      hasIndirectFirstInstance: this.hasFeature("indirect-first-instance"),
      hasFloat32Filterable: this.hasFeature("float32-filterable"),
      hasSubgroups: this.hasFeature("subgroups"),
      hasBgra8UnormStorage: this.hasFeature("bgra8unorm-storage"),
    };
    return stats;
  }

  /**
   * GPU timestamp profiler for measuring render pass durations.
   * Requires 'timestamp-query' feature to be enabled.
   */
  get timestampProfiler(): WebGPUTimestampProfiler | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (
      !this._timestampProfiler &&
      this._device &&
      this.hasFeature("timestamp-query")
    ) {
      this._timestampProfiler = new WebGPUTimestampProfiler(
        this._device,
        this.hasFeature("timestamp-query"),
      );
      // C-R12 (Batch 33) — query sets are device-scoped; drop on loss.
      this.onDeviceInvalidated(() => {
        this._timestampProfiler = null;
      });
    }
    return this._timestampProfiler;
  }

  /**
   * Storage buffer pool for compute shader inputs/outputs and large datasets.
   * Pre-allocates and reuses GPU storage buffers.
   */
  get storageBufferPool(): WebGPUStorageBufferPool | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._storageBufferPool && this._device) {
      this._storageBufferPool = new WebGPUStorageBufferPool(this._device);
      // C-R12 (Batch 33) — pooled buffers are bound to the dead device.
      this.onDeviceInvalidated(() => {
        this._storageBufferPool = null;
      });
    }
    return this._storageBufferPool;
  }

  /**
   * Indirect draw manager for GPU-driven rendering.
   * Writes draw parameters from compute shaders for drawIndirect/drawIndexedIndirect.
   */
  get indirectDrawManager(): WebGPUIndirectDrawManager | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._indirectDrawManager && this._device) {
      this._indirectDrawManager = new WebGPUIndirectDrawManager(this._device);
      // C-R12 (Batch 33) — indirect args staging buffer is device-scoped.
      this.onDeviceInvalidated(() => {
        this._indirectDrawManager = null;
      });
    }
    return this._indirectDrawManager;
  }

  /**
   * Buffer mapper for async CPU↔GPU buffer access.
   * Manages mapAsync/getMappedRange for readback and upload.
   */
  get bufferMapper(): WebGPUBufferMapper | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._bufferMapper && this._device) {
      this._bufferMapper = new WebGPUBufferMapper(this._device);
      // C-R12 (Batch 33) — staging + readback caches hold device buffers.
      this.onDeviceInvalidated(() => {
        this._bufferMapper = null;
      });
    }
    return this._bufferMapper;
  }

  /**
   * Central render-pipeline cache — the single `WebGPURenderPipelineCache`
   * instance callers should route through when they want pipeline
   * creation to dedupe across renderers. Lazy-initialized on first
   * access so the cache isn't built until someone needs it.
   *
   * C-R7 (Batch 34). Previously the field was declared but never
   * instantiated, so every feature renderer built and cached its own
   * pipelines in its own local Map. Centralising the cache lets
   * cross-renderer variants (e.g. the same depth-cast layout used by
   * both CSM and point-light shadows) share a single pipeline.
   *
   * The cache key already covers depth/blend/stencil/cull/polygonOffset
   * (Batch 30) and was extended in Batch 34 to include multisample
   * count, per-target color format + writeMask, depth format, and
   * vertex buffer layout signature. Two pipelines that differ in any
   * of those fields now materialize as distinct pipeline objects.
   */
  get webgpuPipelineCache(): WebGPURenderPipelineCache | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._webgpuPipelineCache && this._device) {
      // NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 2) — pass the
      // context's async monitor so every async pipeline creation
      // publishes wakeup events. The monitor getter is lazy and
      // returns the same instance across device-loss cycles, so
      // wiring it in the constructor is safe — the cache is
      // recreated on device loss and picks up the same monitor.
      this._webgpuPipelineCache = new WebGPURenderPipelineCache(
        this._device,
        this._id,
        undefined,
        this.asyncResources,
      );
      // C-R12 — drop the pipeline cache on device loss so the next
      // access rebuilds against the recovered device.
      this.onDeviceInvalidated(() => {
        this._webgpuPipelineCache = null;
      });
    }
    return this._webgpuPipelineCache;
  }

  /**
   * Central compute-pipeline cache — the `WebGPUComputePipelineCache`
   * instance for this context. Compute-pipeline consumers (Weather,
   * VolumetricFog, AutoExposure, GPUCuller, PointCloudLODProcessor)
   * route their `device.createComputePipeline()` calls through this
   * cache so identical (name, layout, entryPoint) tuples dedupe
   * across renderer instances and across context reinitializations.
   *
   * Lazy-initialized on first access; dropped on device loss along
   * with the render pipeline cache. Returns `null` when the device
   * isn't yet present (early bring-up) or has been invalidated.
   *
   * C-R7-COMPUTE-PIPELINE-CACHE (Batch 76).
   */
  get webgpuComputePipelineCache(): WebGPUComputePipelineCache | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._webgpuComputePipelineCache && this._device) {
      this._webgpuComputePipelineCache = new WebGPUComputePipelineCache(
        this._device,
        this._id,
        this.asyncResources,
      );
      this.onDeviceInvalidated(() => {
        this._webgpuComputePipelineCache = null;
      });
    }
    return this._webgpuComputePipelineCache;
  }

  /**
   * NEW-WEBGPU-PIPELINE-READY-SIGNAL (Phase 1) — async resource
   * registry for this context. Returns the same instance for the
   * lifetime of the context (survives device loss; only inflight
   * tokens are reset, subscribers stay attached). Producers (the
   * pipeline caches, image-decode helper, shader-module cache) call
   * `monitor.begin / resolve / reject`; consumers (typically the
   * attached Scene) call `monitor.subscribe`.
   *
   * See `AsyncResourceMonitor.ts` for the design rationale.
   */
  get asyncResources(): AsyncResourceMonitor {
    if (!this._asyncResources) {
      this._asyncResources = new AsyncResourceMonitor(this._id);
      // Eagerly attach the telemetry subscriber so it doesn't miss
      // events fired before the first `asyncResourceTelemetry` read.
      // Lazy attachment causes a startup blind spot: the first few
      // pipelines (which are also the slowest, because they hit cold
      // shader-compile paths) would compile before any consumer
      // touched the telemetry getter, leaving p50/p95 stats empty.
      // Cost: ~1 KB resident + one subscriber callback per event.
      this._asyncResourceTelemetry = new AsyncResourceTelemetry(
        this._asyncResources,
      );
      this.onDeviceInvalidated(() => {
        // Reset, do NOT null — Scene subscribers are still valid;
        // only the inflight GPU work needs to be flushed so producers
        // re-issue against the recovered device.
        this._asyncResources?.reset("device-invalidated");
      });
    }
    return this._asyncResources;
  }

  /**
   * NEW-WEBGPU-PERF-MONITOR-SUBSCRIBER — per-context async-resource
   * telemetry. Eagerly attached when the monitor is first created
   * (see `asyncResources` getter) so events fired before the first
   * read aren't lost. Survives device loss for the same reason the
   * monitor does (subscriber stays attached; only inflight tokens
   * are reset on `monitor.reset`).
   *
   * Consumers: `WebGPUPerformanceManager.getAsyncResourceStats()` for
   * budget decisions, `CesiumDebug.asyncResources()` for live-snapshot
   * readouts, and any future scaling logic that needs per-kind
   * percentile data.
   */
  get asyncResourceTelemetry(): AsyncResourceTelemetry {
    // Touch the monitor getter so the eager-attach path runs if it
    // hasn't already (e.g., a consumer that touches telemetry before
    // any other code path consumed the monitor).
    void this.asyncResources;
    // Cast: we know the monitor getter always populates this.
    return this._asyncResourceTelemetry!;
  }

  /**
   * GPU frustum culler for compute-shader-based visibility testing.
   * Lazy-initialized on first access. Async init loads the FrustumCull.wgsl shader.
   * @returns The culler instance (may not be initialized yet — check .initialized)
   */
  get gpuCuller(): GPUCullerInstance | null {
    // Body extracted to `WebGPUContextCullerPool.ts` (Q35 slice).
    return getGpuCullerExt(this);
  }

  /**
   * NEW-MULTIFRUSTUM-CULL-RESULTS (Batch 220) — return the GPU
   * culler instance for opaque-pass frustum `idx`. Frustum 0 reuses
   * the original `gpuCuller` so single-frustum scenes don't pay
   * extra VRAM; frustums 1..N get their own lazy-init instances so
   * their `prepareReadback` calls in the same encoder don't clobber
   * each other's staging buffers.
   *
   * Returns `null` if init is still pending or the device is gone.
   */
  public getGPUCullerForOpaqueFrustum(idx: number): GPUCullerInstance | null {
    // Body extracted to `WebGPUContextCullerPool.ts` (Q35 slice).
    return getGpuCullerForOpaqueFrustumExt(this, idx);
  }

  /**
   * NEW-SHADOW-CAST-GPU-CULL Phase 1 (Batch 221) — per-cascade GPU
   * culler instances for CSM shadow cast. Each cascade gets its own
   * `_visibilityBuffer` + `_readbackBuffer` so the per-cascade
   * `prepareReadback` calls don't collide in the same encoder.
   * Lazy-init on first request per cascade index.
   *
   * Phase 1 (Batch 221) shipped the infrastructure; Phase 2 (commit
   * `2302859f0f`, Batches 225-230) WIRED THE LIVE DISPATCH —
   * `WebGPUCSMCastPass` now packs per-cascade cull planes
   * (`packCascadeCullPlanes`, a correctness-safe cube-around-sphere
   * over-include rather than tight Gribb-Hartmann), runs the hysteresis
   * gate, dispatches this culler, and filters the cast list by the
   * prior-frame readback. The only owed follow-up is a dense-shadow
   * Playwright visual diff (NEW-SHADOW-CAST-GPU-CULL-PHASE-2 residual,
   * doc-synced Batch 172). This comment previously claimed "Phase 1
   * only / does NOT yet dispatch" — that was stale.
   */
  public getGPUCullerForCascade(idx: number): GPUCullerInstance | null {
    // Body extracted to `WebGPUContextCullerPool.ts` (Q35 slice).
    return getGpuCullerForCascadeExt(this, idx);
  }

  /**
   * B216-N1 (Batch 218 audit fix) — second GPU frustum culler used
   * exclusively for the translucent pass. Gives translucent its own
   * `_visibilityBuffer` + `_readbackBuffer` so its `prepareReadback`
   * doesn't clobber the opaque pass's pending readback in the same
   * encoder. Same lazy-init pattern as `gpuCuller`.
   */
  get gpuCullerTranslucent(): GPUCullerInstance | null {
    // Body extracted to `WebGPUContextCullerPool.ts` (Q35 slice).
    return getGpuCullerTranslucentExt(this);
  }

  /**
   * Lazy-init point cloud LOD processor. Produces a compacted
   * visible-indices buffer + atomic visible count via compute, so
   * downstream point cloud renderers can use `drawIndirect` instead
   * of iterating all points every frame.
   *
   * Mirrors `gpuCuller`: same lazy-import pattern, same per-context
   * instance, same error-swallow-and-warn on init failure. Consumers
   * must check `.isReady` before calling `dispatch` since init is
   * async — the getter returns the instance as soon as one exists,
   * even if the pipelines are still compiling.
   *
   * @returns The processor instance (may be mid-initialization — check .isReady)
   */
  get pointCloudLOD(): WebGPUPointCloudLODProcessorInstance | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (
      !this._pointCloudLOD &&
      this._device &&
      !this._pointCloudLODInitializing
    ) {
      this._pointCloudLODInitializing = true;
      import("./WebGPUPointCloudLODProcessor.js")
        .then(({ WebGPUPointCloudLODProcessor }) => {
          const proc = new WebGPUPointCloudLODProcessor(this._device!, {
            label: `ctx-${this._id}`,
            useDecoupledScan:
              this._options.useDeterministicPointCloudLOD ?? false,
            asyncResourceMonitor: this.asyncResources,
          });
          return proc.initialize().then(() => {
            // WebGPUPointCloudLODProcessor explicitly
            // `implements WebGPUPointCloudLODProcessorInstance` — no cast
            // needed when assigning the instance to the typed field.
            this._pointCloudLOD = proc;
            this._pointCloudLODInitializing = false;
          });
        })
        .catch((e: unknown) => {
          //>>includeStart('debug', pragmas.debug);
          console.warn(
            `[CesiumJS:webgpu:ctx-${this._id}] Point cloud LOD init failed:`,
            e,
          );
          //>>includeEnd('debug');
          this._pointCloudLODInitializing = false;
        });
    }
    return this._pointCloudLOD;
  }

  /**
   * Get frame statistics
   * @returns {object} Statistics object
   */
  getStatistics(): WebGPUFrameStatistics {
    // Body extracted to `WebGPUFrameStatistics.ts` in Batch 144.
    return getFrameStatistics(this);
  }

  /**
   * Reset frame statistics
   */
  resetStatistics(): void {
    resetFrameStatistics(this);
  }

  /**
   * Increment draw call counter
   * @param {number} triangles - Number of triangles drawn
   */
  recordDrawCall(triangles: number = 0): void {
    recordDrawCallExt(this, triangles);
  }

  // ====================================================================================
  // Device Loss Recovery — FORK-1 fix: delegated to WebGPUDeviceLossRecovery
  // Previously ~150 lines of duplicated inline logic. Now uses the standalone
  // recovery module with the DeviceLossRecoveryHost interface pattern.
  // ====================================================================================

  /**
   * Set up device loss handler by creating and configuring a
   * WebGPUDeviceLossRecovery instance that implements all recovery logic.
   * @private
   */
  private _setupDeviceLostHandler(): void {
    if (!this._device) return;
    // Host-adapter literal extracted to `WebGPUContextDeviceLoss.ts`
    // in Batch 143. The wrapper stays so `_initialize` keeps calling
    // it as `this._setupDeviceLostHandler()`.
    this._deviceLossRecovery = buildDeviceLossRecoveryFor(this, 3);
    this._deviceLossRecovery.onDeviceLost((info) => {
      if (info.reason !== "recovered") {
        // Dynamic imports started against the old device generation may
        // still settle while recovery is running. Advance their slot tokens
        // immediately so none can install into the recovered context.
        this._invalidatePendingFeatureRenderers();
      }
    });
    this._deviceLossRecovery.setupHandler(this._device);
  }

  /**
   * Re-configure the canvas context after device loss recovery.
   * Called by WebGPUDeviceLossRecovery via the DeviceLossRecoveryHost interface.
   * @internal
   */
  // Public underscore: shared with the device-loss host-adapter (Batch 143).
  public _reconfigureCanvas(): void {
    // Body extracted to `WebGPUContextCanvasConfig.ts` (Batch 593).
    reconfigureCanvasExt(this);
  }

  /**
   * HDR-DISPLAY (Batch 213, B206-N1 audit fix) — apply the canvas
   * config with a fallback path when the browser rejects HDR-only
   * fields. Body extracted to `WebGPUContextCanvasConfig.ts` (Batch
   * 593); see that module for the full fallback-chain rationale
   * (extended toneMapping → rgba16float → SDR).
   */
  private _applyCanvasConfig(): void {
    applyCanvasConfigExt(this);
  }

  /**
   * HDR-DISPLAY (Batch 206) — request an HDR-output canvas. Matches
   * `Scene.useHDRCanvasOutput` and is invoked by the Scene setter.
   *
   * Switching the canvas format invalidates every pipeline that
   * targets the canvas format (the identity-blit pipeline, debug
   * overlays, anything using `presentationFormat`). The pipeline cache
   * is cleared so subsequent `getOrCreatePipeline` calls rebuild
   * against the new format on demand.
   *
   * No-ops if the flag is unchanged or the context is uninitialized.
   */
  public setHDRCanvasOutput(enabled: boolean): void {
    // Body extracted to `WebGPUContextCanvasConfig.ts` (Batch 593).
    setHDRCanvasOutputExt(this, enabled);
  }

  /** HDR-DISPLAY (Batch 206) — current canvas-output HDR state. */
  public get hdrCanvasOutput(): boolean {
    return this._hdrCanvasOutput;
  }

  /**
   * NEW-AUX-CULLER-IDLE-DECAY (Batch 229) — destroy auxiliary
   * culler instances idle for >= IDLE_DECAY_FRAMES. Called at
   * IDLE_DECAY_CHECK_INTERVAL-frame intervals from `beginFrame()`.
   *
   * Sweep order: per-frustum (idx >= 1, since 0 reuses _gpuCuller),
   * per-cascade, then translucent culler, then the main _gpuCuller.
   * Each destroy nullifies the slot so the lazy getter reallocates
   * on demand.
   */
  private _reapIdleAuxCullers(): void {
    // Body extracted to `WebGPUContextCullerPool.ts` (Q35 slice).
    reapIdleAuxCullersExt(this);
  }

  /**
   * B213-O2 (Batch 219) + B219-N4 (Batch 225) + B225-N2 audit fix
   * (Batch 230) — register a callback fired when the HDR canvas
   * configure fails and the context demotes itself to SDR.
   * Scene.js installs this so its `_useHDRCanvasOutput` flag stays
   * in sync with the canvas reality. Returns an unsubscribe
   * function so the Scene can clean up at destruction.
   *
   * Multiple Scenes per Context (split-screen, picture-in-picture)
   * each register their own listener — they all fire on demotion.
   *
   * **B225-N2 (Batch 230 audit fix)** — `null` is no longer a magic
   * "clear all listeners" value. The legacy single-slot path that
   * accepted `null` could nuke other Scenes' listeners when one
   * Scene called it for cleanup. Callers should use the returned
   * unsubscribe function for per-listener cleanup. To clear ALL
   * listeners (e.g., context teardown), call
   * `clearAllHDRFallbackListeners()` explicitly.
   *
   * Returns the unsubscribe function on success, or null when
   * `listener` was nullish.
   */
  public setHDRFallbackListener(
    listener: ((newValue: boolean) => void) | null,
  ): (() => void) | null {
    // Body extracted to `WebGPUContextCanvasConfig.ts` (Batch 593).
    return setHDRFallbackListenerExt(this, listener);
  }

  /**
   * B225-N2 (Batch 230 audit fix) — explicit "clear every
   * registered HDR fallback listener" entry point. Used at context
   * teardown. Distinct from `setHDRFallbackListener(null)` so the
   * intent is unambiguous and can't accidentally fire from a Scene
   * that just wanted to remove its own listener.
   */
  public clearAllHDRFallbackListeners(): void {
    // Body extracted to `WebGPUContextCanvasConfig.ts` (Batch 593).
    clearAllHDRFallbackListenersExt(this);
  }

  /**
   * Register every Context-owned cache with `_cacheRegistry`. Called
   * once from `_initialize` after the caches and pools exist. Order
   * matches the original inline `_clearAllCaches` body so any
   * implicit dependency between clears is preserved.
   *
   * Device-level effects resources are owner-refcounted separately because a
   * pooled GPUDevice may outlive any one Context.
   *
   * @private
   */
  private _registerResourceCaches(): void {
    this._cacheRegistry
      .register("samplerCache", () => this._samplerCache.clear())
      .register("bindGroupLayoutCache", () =>
        this._bindGroupLayoutCache.clear(),
      )
      .register("bindGroupCache", () => this._bindGroupCache.clear())
      .register("bufferPool", () => this._bufferPool.clear())
      .register("uniformBufferPool", () => {
        this._uniformBufferPool = [];
      })
      .register("uniformAllocator", () => {
        // Every page belongs to the current physical GPUDevice generation.
        // A recovered device must never receive a bind group backed by an
        // old-generation ring slice.
        this._uniformAllocator?.destroy();
        this._uniformAllocator = null;
      })
      .register("environmentalEffectsCompositor", () => {
        destroyEnvironmentalEffectsCompositor(this);
      })
      .register("depthTexture", () => {
        this._depthTexture = null;
        this._depthTextureView = null;
      })
      .register("viewportQuad", () => {
        this._viewportQuadVertexBuffer = null;
        this._viewportQuadPipeline = null;
      })
      .register("shaderCache", () => this._webgpuShaderCache?.clear())
      .register("pipelineCache", () => this._webgpuPipelineCache?.clear())
      .register("computePipelineCache", () =>
        this._webgpuComputePipelineCache?.clear(),
      )
      // AUDIT_2026_05_02 C.3 — register orphan caches that hold GPU
      // handles. After device-loss recovery, cached bundles / buffers /
      // pipelines reference dead handles; not clearing them here means
      // replay throws validation errors on the recovered device. All
      // five `?.` chains and `null` resets are defensive — these
      // subsystems may be lazy and not yet allocated at recovery time.
      .register("renderBundleManager", () => {
        this._renderBundleManager?.destroy();
        this._renderBundleManager = null;
      })
      .register("computeEngine", () => {
        this._computeEngine?.destroy();
        this._computeEngine = null;
      })
      .register("storageBufferPool", () => {
        this._storageBufferPool?.destroy?.();
        this._storageBufferPool = null;
      })
      .register("mipmapGenerator", () => {
        this._mipmapGenerator?.destroy?.();
        this._mipmapGenerator = null;
      })
      .register("timestampProfiler", () => {
        this._timestampProfiler?.destroy?.();
        this._timestampProfiler = null;
      })
      .register("indirectDrawManager", () => {
        this._indirectDrawManager?.destroy?.();
        this._indirectDrawManager = null;
      });
  }

  /**
   * Clear all stale GPU caches after device loss recovery.
   * Called by WebGPUDeviceLossRecovery via the DeviceLossRecoveryHost interface.
   * @internal
   */
  // Public underscore: shared with the device-loss host-adapter (Batch 143).
  public _clearAllCaches(previousDevice?: GPUDevice | null): void {
    // A device-loss edge abandons the current encoder permanently. Reject
    // frame-owned readbacks immediately; request-render scenes may never start
    // another frame, and terminal loss has no future frame by definition.
    this._drainAfterFrameSubmitCallbacks(false);
    this._currentRenderPassEncoder = null;
    this._activePassTarget = null;
    this._currentCommandEncoder = null;
    this._currentTextureView = null;

    // Per-cache try/catch + named error logs live inside the registry
    // (Batch 131). What stays inline:
    //   - effects-cache lease transfer — moves this context from the lost
    //     physical device generation to the recovered one.
    //   - `_fireDeviceInvalidated` — the side-effect that notifies
    //     external subscribers AFTER all caches drop their stale
    //     handles.
    this._cacheRegistry.clearAll();

    // C9-AUDIT-P1-SWEEP (Batch 684) — the globe renderer's per-(context, frame)
    // effects memo (Batch 677 `_globeEffectsHandle`) is a context expando that
    // pins a bind group + shadowMap/clipping/tileProvider refs from the lost
    // device generation. Drop it on invalidation so recovery does not reuse a
    // stale-device bind group; it is intra-frame by design and rebuilt next
    // frame, so nulling here is safe by construction.
    (this as unknown as { _globeEffectsHandle?: unknown })._globeEffectsHandle =
      null;

    // Dynamic-environment capture intentionally consumes the previous globe
    // frame's published renderer/tile references before the next main globe
    // draw republishes them. After recovery those references contain
    // old-device pipelines, bind groups, and buffers, so invalidate both
    // producer snapshots explicitly.
    (
      this as unknown as {
        _webgpuSceneCaptureSources?: unknown;
        _webgpuSceneCaptureModels?: unknown;
      }
    )._webgpuSceneCaptureSources = null;
    (
      this as unknown as {
        _webgpuSceneCaptureModels?: unknown;
      }
    )._webgpuSceneCaptureModels = null;

    // Stable WebGL-shaped handles survive recovery, but their native buffers
    // belong to the old device generation. Release every registered native
    // allocation, including unbound buffers that the two binding slots cannot
    // reach. Later bufferData/bufferSubData calls realize the same handles on
    // the recovered device.
    this._gl.invalidateCompatibilityBufferHandles();

    // Recovery has already swapped `_device` before reaching this hook.
    // Move the validation lease off the lost device and onto the recovered
    // generation; `_installShaderValidation` releases the old lease first.
    if (this._device) {
      this._installShaderValidation(this._device);
    }

    // Recovery swaps `_device` before entering this hook. Move only this
    // context's effects-cache ownership from the lost generation to the new
    // one. A pooled device may have multiple contexts, so the old entry is
    // destroyed only after every context has released it; the new entry must
    // never be force-cleared here.
    if (previousDevice && previousDevice !== this._device) {
      releaseEffectsPlaceholderCacheForContext(previousDevice, this);
    }
    if (this._device) {
      retainEffectsPlaceholderCacheForContext(this._device, this);
    }

    // The replacement device may expose byte-identical formats and limits, but
    // none of its native objects are compatible with the previous device.
    // Advance only after all throwing cache/lease work has completed, and
    // independently from the scene-format generation, so command owners cannot
    // mistake "same format" for "same resource lifetime".
    this._deviceResourceGeneration += 1;
    this._environmentDemandRegistry.reset(this._deviceResourceGeneration);

    // C-R12 (Batch 33) — fire the invalidation event so every
    // subscribed subsystem / feature renderer / per-object cache
    // drops its stale GPU handles. The context-level caches above
    // cover the `WebGPUContext`-owned set; subscribers cover
    // subsystem-owned (`_renderBundleManager`, `_timestampProfiler`,
    // `_storageBufferPool`, `_mipmapGenerator`) and external
    // (effect bind-group caches, module-level WeakMaps) state that
    // the context can't reach directly.
    this._fireDeviceInvalidated();
  }

  /**
   * Roll back context-owned state created for a recovery candidate whose
   * initialization failed. Device ownership remains with the recovery
   * candidate lease; this hook only drains per-context resources/leases that
   * would otherwise survive when a pooled device has another owner.
   * @internal
   */
  public _rollbackRecoveredDevice(candidateDevice: GPUDevice): void {
    const defaultTextures = [
      this._defaultTexture,
      this._defaultEmissiveTexture,
      this._defaultNormalTexture,
      this._defaultCubeMap,
    ];
    this._defaultTexture = undefined;
    this._defaultEmissiveTexture = undefined;
    this._defaultNormalTexture = undefined;
    this._defaultCubeMap = undefined;

    for (const texture of defaultTextures) {
      try {
        texture?.destroy();
      } catch {
        // Candidate teardown below still releases the physical device lease.
      }
    }

    try {
      this._releaseShaderValidation?.();
    } catch {
      // A failed wrapper restoration must not block the remaining lease drains.
    }
    try {
      releaseEffectsPlaceholderCacheForContext(candidateDevice, this);
    } catch {
      // Candidate release remains mandatory even if cache cleanup misbehaves.
    }
    try {
      this._context?.unconfigure();
    } catch {
      // A lost canvas can already be unconfigured by the browser.
    }

    this._graphicsCapabilities = GraphicsCapabilities.EMPTY;
    this._vertexAttribDivisors.length = 0;
    this._previousDrawInstanced = false;
  }

  // C-R12 (Batch 33) — Device-invalidation subscriber registry.
  // Body extracted to `WebGPUDeviceInvalidationBus` in Batch 130. The
  // public `onDeviceInvalidated` method + private
  // `_fireDeviceInvalidated` keep the same signatures so the 8
  // internal callsites and the one external caller
  // (WebGPUSceneRenderer.ts:747) don't move.
  private _deviceInvalidationBus = new WebGPUDeviceInvalidationBus(
    () => this.id,
  );

  // Resource-cache registry (Batch 131). Populated by
  // `_registerResourceCaches()` during `_initialize` after the caches
  // exist. `_clearAllCaches` walks it in registration order during
  // device-loss recovery; each entry runs inside its own try/catch.
  private _cacheRegistry = new WebGPUResourceCacheRegistry(() => this.id);

  /**
   * Subscribe to device-invalidation events.
   * @see GraphicsContext.onDeviceInvalidated
   */
  onDeviceInvalidated(callback: () => void): () => void {
    return this._deviceInvalidationBus.subscribe(callback);
  }

  /**
   * Dispatch the invalidation event to every subscriber. Individual
   * subscriber errors are caught + logged so one failing subsystem
   * doesn't block the rest from cleaning up.
   * @private
   */
  private _fireDeviceInvalidated(): void {
    this._deviceInvalidationBus.fire();
  }

  /**
   * Register a callback for device loss events.
   * Delegates to the WebGPUDeviceLossRecovery instance.
   *
   * @param {DeviceLostCallback} callback - Callback to invoke on device loss
   * @returns {() => void} A function to unregister the callback
   */
  onDeviceLost(callback: DeviceLostCallback): () => void {
    if (this._deviceLossRecovery) {
      return this._deviceLossRecovery.onDeviceLost(callback);
    }
    // Fallback: no-op unsubscribe if recovery not yet initialized
    return () => {};
  }

  /**
   * Get the current device loss state.
   * @returns {DeviceLossState} Current device state
   */
  get deviceLossState(): DeviceLossState {
    return this._deviceLossRecovery?.state ?? DeviceLossState.HEALTHY;
  }

  /**
   * Get the number of recovery attempts that have been made.
   * @returns {number} Number of recovery attempts
   */
  get recoveryAttempts(): number {
    return this._deviceLossRecovery?.attempts ?? 0;
  }
}

export default WebGPUContext;
