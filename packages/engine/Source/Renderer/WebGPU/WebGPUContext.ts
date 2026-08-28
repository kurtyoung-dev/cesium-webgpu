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
import { snapshotCloudObservability } from "./WebGPUCloudObservability.js";
import type {
  CloudCpuStageAccumulator,
  CloudFrameCounters,
} from "./WebGPUCloudObservability.js";
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
// Type-only: bind-group cache counters surfaced by
// `getRendererStatistics()`. No runtime dependency on the cache module.
import type { BindGroupCacheStats } from "./WebGPUBindGroupCache.js";
import { AsyncResourceMonitor } from "./AsyncResourceMonitor.js";
import { AsyncResourceTelemetry } from "./AsyncResourceTelemetry.js";
import { WebGPUComputePipelineCache } from "./WebGPUComputePipelineCache.js";
import { WebGPUBuffer } from "./WebGPUBuffer.js";
import { WebGPUTexture } from "./WebGPUTexture.js";
import {
  WebGPUMipmapGenerator,
  supportsWebGPULayeredMipmapGeneration,
  supportsWebGPUMipmapGeneration,
  type WebGPUTextureMipGenerationOptions,
} from "./WebGPUMipmapGenerator.js";
import WebGPUDrawCommand from "./WebGPUDrawCommand.js";
// Statically imported so the primitive-index utils cache is populated
// synchronously during `_initialize` instead of paying an inline
// dynamic-import round-trip serialized into every boot. The module is a pure
// static-method class with no top-level imports and no module-level side
// effects, so folding it into the already-lazy WebGPU chunk costs nothing.
import { WebGPUPrimitiveIndexUtils } from "./WebGPUPrimitiveIndexUtils.js";
import { WebGPUPickFramebuffer } from "./WebGPUPickFramebuffer.js";
import { WebGPUSnapFramebuffer } from "./WebGPUSnapFramebuffer.js";
import { isSceneFBMrtMode } from "./WebGPUSceneFBTargetHelpers.js";
import {
  canvasClearStateUpdate,
  isClearChannelRequested,
} from "./WebGPUCanvasClearState.js";
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
  WebGPUEnvironmentRefreshScheduler,
  type WebGPUEnvironmentRefreshDecisionValue,
  type WebGPUEnvironmentRefreshTelemetry,
  type WebGPUEnvironmentRefreshUrgencyValue,
} from "./WebGPUEnvironmentRefreshScheduler.js";
import WebGPUEnvironmentRefreshCoordinator from "./WebGPUEnvironmentRefreshCoordinator.js";
import {
  WebGPUEnvironmentTargetPool,
  type WebGPUEnvironmentTargetPoolTelemetry,
} from "./WebGPUEnvironmentTargetPool.js";
import {
  WebGPUViewportQuad,
  type ViewportQuadCommand,
  type ViewportQuadCommandOptions,
} from "./WebGPUViewportQuad.js";
// `createWebGLCompatibilityStub` is imported for the `_gl` field's
// `ReturnType<typeof ...>` annotation; the state literal it builds lives in
// `WebGPUContextWebGLStubInit.ts`.
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
// `DeviceLossRecoveryHost` is not imported here: the host literal that uses it
// lives in `WebGPUContextDeviceLoss.ts`.
import {
  DeviceLossState,
  WebGPUDeviceLossRecovery,
  type DeviceLostCallback,
} from "./WebGPUDeviceLossRecovery.js";
import { WebGPURenderBundleManager } from "./WebGPURenderBundleManager.js";
import WebGPUComputeEngine from "./WebGPUComputeEngine.js";
import WebGPUComputeCommand from "./WebGPUComputeCommand.js";
import { WebGPUTimestampProfiler } from "./WebGPUTimestampProfiler.js";
import { WebGPUStorageBufferPool } from "./WebGPUStorageBufferPool.js";
import { WebGPUIndirectDrawManager } from "./WebGPUIndirectDrawManager.js";
import { WebGPUCSMRenderer } from "./WebGPUCSMRenderer.js";
import { WebGPUBufferMapper } from "./WebGPUBufferMapper.js";
import { WebGPURingBufferAllocator } from "./WebGPURingBufferAllocator.js";
import WebGPUModelCameraArena from "./WebGPUModelCameraArena.js";
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

interface PendingTextureMipJob {
  texture: GPUTexture;
  format: GPUTextureFormat;
  mipLevelCount: number;
  options: Required<WebGPUTextureMipGenerationOptions>;
  device: GPUDevice;
  resourceGeneration: number;
}

interface EncodedTextureMipBatch {
  commandBuffer: GPUCommandBuffer;
  jobs: PendingTextureMipJob[];
  device: GPUDevice;
  resourceGeneration: number;
}

const EXTERNAL_IMAGE_COPY_DESTINATION_FORMATS = new Set<GPUTextureFormat>([
  "r8unorm",
  "r16float",
  "r32float",
  "rg8unorm",
  "rg16float",
  "rg32float",
  "rgba8unorm",
  "rgba8unorm-srgb",
  "bgra8unorm",
  "bgra8unorm-srgb",
  "rgb10a2unorm",
  "rgba16float",
  "rgba32float",
]);
const TIER1_EXTERNAL_IMAGE_COPY_DESTINATION_FORMATS = new Set<GPUTextureFormat>(
  ["r16unorm", "rg16unorm", "rgba16unorm"],
);

function supportsExternalImageCopyDestination(
  device: GPUDevice,
  format: GPUTextureFormat,
): boolean {
  return (
    EXTERNAL_IMAGE_COPY_DESTINATION_FORMATS.has(format) ||
    (TIER1_EXTERNAL_IMAGE_COPY_DESTINATION_FORMATS.has(format) &&
      device.features.has("texture-formats-tier1"))
  );
}

// The `WebGPUFrameStatistics` interface is declared in
// `WebGPUFrameStatistics.ts` and imported above, as is the
// `ViewportQuadCommandOptions` shape from `WebGPUViewportQuad.ts`.

/** Shader source that can be a string or an object with _wgslCode. */
type ShaderSource =
  string | { _wgslCode?: string; sources?: string[]; defines?: string[] };

// `GPUCullerInstance` is declared in `WebGPUContextCullerPool.ts` and imported
// type-only above; the culler-pool lazy init and idle decay live there as
// host-interface free functions.

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
 * Minimal structural surface of `WebGPUPostProcessPipeline`
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
 * Explicit classification of the currently-open render pass.
 * Scene-FB pass opens declare "scene-framebuffer"; the
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
   * An in-flight `requestAdapter()` promise kicked off by
   * `ContextFactory.createWebGPU` *before* the ~3 MB WebGPU chunk is parsed,
   * so GPU-process adapter negotiation overlaps chunk parse/eval instead of
   * being gated behind it. Consumed by `WebGPUDevicePool.acquireDevice`; a
   * mismatch or rejection falls back to the pool's own `requestAdapter`
   * (conservative — never forced). Not persisted into device-loss recovery
   * options (an adapter is single-use).
   */
  prefetchedAdapter?: Promise<GPUAdapter | null>;

  /**
   * When true (the default), route
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
  // Public underscore: shared with the device-loss host-adapter builder.
  public _adapter: GPUAdapter | null = null;
  public _device: GPUDevice | null = null;
  /**
   * True when `_device` was acquired
   * via `WebGPUDevicePool.acquireDevice`, false when an external caller
   * supplied the device directly (e.g., the recovery path that hands a
   * fresh device into the existing context). The destroy path uses this
   * to decide between `pool.releaseDevice` (refcount-aware; the right
   * call when the device may be shared with other contexts) and a
   * direct `device.destroy()` (only safe when this context owns the
   * device exclusively).
   */
  public _deviceFromPool: boolean = false;
  // Public underscore: shared with the WebGL-stub state proxy.
  public _context: GPUCanvasContext | null = null;
  public _presentationFormat: GPUTextureFormat = "bgra8unorm";
  // When true, the canvas is configured with
  // `format: 'rgba16float' + colorSpace: 'display-p3' + toneMapping:
  // {mode: 'extended'}`. Driven by `Scene.useHDRCanvasOutput`. Toggling it
  // clears the pipeline cache because every pipeline targeting the canvas
  // format must be recompiled.
  // Public underscore: shared with the canvas-config helper
  // (`WebGPUContextCanvasConfig.ts`).
  public _hdrCanvasOutput: boolean = false;
  // Scene-installed listeners called when the context's HDR fallback chain
  // trips and demotes `_hdrCanvasOutput` from true to false. Each Scene.js
  // instance attached to this context registers its own listener so its
  // `_useHDRCanvasOutput` flag follows the demotion. A set rather than a
  // single slot because a single-slot design only syncs the last-installed
  // scene, leaving multi-scene-per-context configurations — split-screen,
  // picture-in-picture — with stale Scene flags on every other viewer.
  // Public underscore: shared with the canvas-config helper
  // (`WebGPUContextCanvasConfig.ts`).
  public _hdrFallbackListeners: Set<(newValue: boolean) => void> = new Set();
  private _depthFormat: GPUTextureFormat = "depth24plus-stencil8";
  // Public underscore: shared with the device-loss host-adapter.
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
      this._drainAfterCommandEncoderSubmitCallbacks(false);
      this._currentCommandEncoder = null;
      this._drainAfterFrameSubmitCallbacks(false);
    }
  }
  // Public underscore: shared with the device-loss host-adapter.
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

  // Native shadow rendering consumes a unique command set, not the
  // per-cascade/per-cube-face lists flattened with duplicates. Both
  // containers persist with the context so the shadow hot path allocates
  // neither a temporary array nor a Set each frame.
  private _shadowCastCommandsScratch: CesiumAnyDrawCommand[] = [];
  private _shadowCastCommandsSeen: Set<CesiumAnyDrawCommand> = new Set();
  // Model and primitive effects groups are prepared before the current light
  // camera is fitted. Queue their stable UBs and refresh the shadow prefix in one
  // post-ShadowMap preparation phase, before any color command executes.
  private _shadowReceiveUniformRefreshes: unknown[] = [];
  private _shadowReceiveUniformRefreshSet: Set<GPUBuffer> = new Set();

  // Texture mip-generation jobs deferred out of draw emission. A renderer that
  // realizes a new GPUTexture during command building enqueues a job here
  // instead of opening a private encoder and a private submit. `endFrame`
  // encodes every pending job into one `"TextureMipPreparation"` encoder
  // submitted immediately before the frame encoder's own submit — two submits
  // on one queue, so ordering is guaranteed and an invalid prep buffer cannot
  // invalidate the frame — which makes the queue order
  // `copyExternalImageToTexture`, then mip passes, then scene passes, so the
  // realizing frame samples complete mips. A renderer that privately submits
  // mid-frame work sampling newly realized textures must call
  // `flushPendingTextureMipJobs` first. The draw path performs no private
  // submits.
  private _pendingTextureMipJobs: PendingTextureMipJob[] = [];
  // Exact duplicate coalescing for the current pending batch. Kept weak by
  // texture identity and replaced wholesale whenever the batch drains.
  private _pendingTextureMipJobKeys = new WeakMap<GPUTexture, Set<string>>();

  // Textures destroyed inline, and therefore dead immediately. Consulted by
  // the pending-mip encode step: only these are skipped. Scheduled destroys
  // (`_pendingTextureDestroys`) remain live through the frame submit and still
  // need their mip chains. A WeakSet, so entries vanish with the texture.
  private _inlineDestroyedTextures = new WeakSet<GPUTexture>();

  // Frame state for command recording — public for cross-renderer access
  public _currentCommandEncoder: GPUCommandEncoder | null = null;
  public _currentRenderPassEncoder: GPURenderPassEncoder | null = null;

  // Callbacks that must start only after the frame command buffer is
  // actually submitted. Readback clients use this seam to record copies on the
  // shared encoder without calling mapAsync while the staging buffer is still
  // referenced by an unsubmitted command buffer.
  private _afterFrameSubmitCallbacks: Array<(submitted: boolean) => void> = [];

  // Callbacks owned by one exact command-encoder segment. Unlike the logical-
  // frame callbacks above, these settle whenever that encoder is submitted or
  // abandoned — including the Scene2D and readback boundaries that rotate the
  // encoder before the logical frame ends. The encoder identity is load-
  // bearing: a pooled GPUDevice can serve several contexts, and callbacks from
  // one context/segment must never settle another context's resource leases.
  private _afterCommandEncoderSubmitCallbacks: Map<
    GPUCommandEncoder,
    Array<(submitted: boolean) => void>
  > = new Map();
  private _commandEncoderSubmitCallbacksDraining = false;

  // Explicit render-pass target tracking, declared at every pass open and end
  // site so the `clear()` guard never has to infer "is a scene-owned pass
  // active?" from a pass label:
  //   "default-canvas"    — the swap-chain pass (`_beginDefaultRenderPass`)
  //   "scene-framebuffer" — the scene-FB pass, declared by its 3 open sites
  //   "external"          — every other custom pass (shadow, pick, clear, …)
  private _activePassTarget: WebGPUPassTarget | null = null;

  // Per-frame canvas demand flags. `beginFrame` does not open the canvas pass
  // eagerly; the first open of a frame clears each untouched channel. Depth is
  // the load-bearing half: an untouched "Scene Depth Texture" read with
  // `depthLoadOp: "load"` yields WebGPU's lazy zero, 0.0, not the 1.0 a clear
  // would have written. Color is set by any canvas-color write, including the
  // post-process blit, which encodes raw passes the context cannot observe —
  // see `markCanvasContentWritten`. Reset in `beginFrame` and
  // `beginPickFrame` only, never in `endFrame`, so a pick mini-frame between
  // render frames cannot corrupt the next render frame's state.
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

  // Cached reference to WebGPUPrimitiveIndexUtils so Scene.js can probe
  // `@builtin(primitive_index)` support without importing from Renderer/WebGPU.
  // Populated lazily by initialize() — Scene reads it via the public
  // `triangulationDebugSupported` getter.
  public _primitiveIndexUtilsCache: CesiumOpaqueObject | null = null;

  // WebGPU-specific caches and managers
  private _webgpuShaderCache: WebGPUShaderCache | null = null;
  // Public underscore: read by the canvas-config helper's HDR-toggle
  // cache invalidation (`WebGPUContextCanvasConfig.ts`).
  public _webgpuPipelineCache: WebGPURenderPipelineCache | null = null;
  // Back-reference to the active post-process pipeline's
  // cache-stats surface (see `PostProcessCacheStatsSource`). Public
  // underscore: written by `WebGPUSceneRendererEnsureResources` when the
  // pipeline is (re)created. Read-only debug exposure.
  public _postProcessCacheStatsSource: PostProcessCacheStatsSource | null =
    null;
  private _webgpuComputePipelineCache: WebGPUComputePipelineCache | null = null;
  // Per-context registry of inflight async GPU work. Lazily initialized via
  // the `asyncResources` getter so a context that never triggers async work
  // pays nothing. It survives device loss with its subscribers attached;
  // device-loss callbacks call `reset()` to reject every inflight token in one
  // sweep.
  private _asyncResources: AsyncResourceMonitor | null = null;
  // Perf-side aggregator that subscribes to the monitor and tracks per-kind
  // p50/p95/p99 latency, throughput, failure rates and peak inflight pressure.
  // Read by the perf manager, or any other consumer, to decide whether to
  // throttle pipeline-variant generation or defer non-critical compute work.
  // Always on; the cost is one subscriber and about 1 KB resident.
  private _asyncResourceTelemetry: AsyncResourceTelemetry | null = null;
  // GPU-free selected-consumer ledger. It supplies the conservative priority
  // semantics the same-frame coordinator and bounded job scheduler read.
  private _environmentDemandRegistry = new WebGPUEnvironmentDemandRegistry();
  // Scene-only collection queue. It delays the backend manager tick until
  // traversal has published final same-frame demand, but owns no GPU work or
  // manager output itself.
  private _environmentRefreshCoordinator =
    new WebGPUEnvironmentRefreshCoordinator();
  // Context-owned bounded refresh drain. It may reorder and bound
  // environment-refresh work; it may never drop it. See the module docs for
  // the no-starvation contract.
  private _environmentRefreshScheduler =
    new WebGPUEnvironmentRefreshScheduler();
  // Persistent, generation-keyed pool for the refresh path's transient
  // parameter arenas and capture depth targets. Lazily created on first use so
  // a context that never runs a dynamic environment map — and a context whose
  // device create failed — pays nothing.
  private _environmentTargetPool: WebGPUEnvironmentTargetPool | null = null;
  // Public underscore: shared with the frame-statistics extract.
  public _samplerCache: Map<string, GPUSampler> = new Map();
  public _bindGroupLayoutCache: Map<string, GPUBindGroupLayout> = new Map();
  private _bindGroupCache: Map<string, GPUBindGroup> = new Map();

  // Resource pools for efficient reuse
  private _bufferPool: Map<string, GPUBuffer[]> = new Map();
  // Public underscore: shared with the frame-statistics extract.
  public _uniformBufferPool: GPUBuffer[] = [];
  private _mipmapGenerator: WebGPUMipmapGenerator | null = null;

  // GPU statistics and debugging
  public _frameCount: number = 0;
  // Public underscore: shared with the frame-statistics extract.
  public _drawCallCount: number = 0;
  public _triangleCount: number = 0;

  // WebGPU optional features that were successfully enabled. The table lives
  // in `WebGPUFeatureFlags`; the context keeps `hasFeature` and
  // `enabledFeatures` as one-line delegators so external callers and the debug
  // snapshot address it here.
  private _featureFlags = new WebGPUFeatureFlags();

  // Dynamic rendering state set by WebGPUSceneRenderer during frame execution
  public _depthStencilView: GPUTextureView | null = null;
  public _sceneColorView: GPUTextureView | null = null;
  public _sceneColorFormat: GPUTextureFormat = "bgra8unorm";
  public _msaaSamples: number = 1;
  public useIndirectDrawForTiles: boolean = false;

  // Conservative force switch for the attachment-demand registry. While `true`
  // the frame is forced to the full-MRT scene-FB topology regardless of
  // consumer demand. Demand-driven topology selection is not wired yet, and
  // keeping this true is what covers a consumer the registry cannot enumerate:
  // unknown demand keeps MRT.
  public forceSceneMRT: boolean = true;
  // Frozen per-frame demand record, computed once in
  // `updateAndClearFramebuffers` and immutable for the rest of the frame. Null
  // before the first frame.
  public _attachmentDemand: AttachmentDemandRecord | null = null;
  // Actual measured scene-FB attachment behavior for this frame, so the
  // debug snapshot can assert the registry record matches reality.
  // Reset at the top of `updateAndClearFramebuffers`.
  public _attachmentDemandActual: {
    gbufferAllocated: boolean;
    gbufferBytes: number;
    gbufferMsaaCompanionBytes: number;
    sceneColorAttachmentCount: number;
    slot1AttachmentOpens: number;
    slot1ResolveOpens: number;
    // Measured demand-driven scene-color resolve passes this frame, labelled
    // `SceneFramebuffer-Color_demand_resolve`. Under the elision this is
    // exactly 1 on the default globe — the pre-post-process ensure — and 0
    // when `_msaaSamples <= 1`. Slot-1 (G-buffer) resolves are counted
    // separately by `slot1ResolveOpens`.
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

  // Intra-frame scene-color resolve staleness. Set `true` whenever a
  // `"scene-framebuffer"` pass opens, because new draws make the single-sample
  // resolve texture stale, and cleared only by
  // `WebGPUSceneRenderer._ensureSceneColorResolved`. Reset conservatively to
  // `true` at frame begin, pick begin and scene-FB recreate. The per-frame
  // demand record (`_attachmentDemand`) cannot own this because it is
  // immutable for the frame; this flag, anchored on `_activePassTarget`, is
  // what executes the resolved-scene-color demand. The conservative default is
  // `true`: unknown demand resolves.
  public _sceneColorResolvePending: boolean = true;

  // Elision kill switch. `true` selects demand-driven resolve-on-consume, the
  // shipped behavior. `false` restores the eager per-segment resolve — the
  // scene-FB open sites bake `resolveTarget` again and
  // `_ensureSceneColorResolved` becomes inert — so the two paths differ only
  // in resolve timing. That makes it both a runtime safety fallback and the
  // only way to A/B the elision within one build.
  public _sceneColorResolveElisionEnabled: boolean = true;

  // Renderer-wide log-depth master switch, `true` by default: the globe, lit
  // Phong primitives, the depth plane, the five collections, the
  // compute-instance system and the Model PBR pipeline family all write
  // `csm_writeLogDepth`-encoded `@builtin(frag_depth)` when
  // `isWebGPULogDepthActive(context, frameState)` is true, matching WebGL's
  // LOG_DEPTH path. That is what resolves far-range depth ties at sub-metre
  // precision: a billboard 1000 m above terrain seen from a 220 km camera
  // separates by about 0.03 of a hyperbolic quantum. Flipping this false is a
  // one-line kill switch restoring hyperbolic NDC depth everywhere, since
  // every producer and consumer is define-gated and rebuilds through keyed
  // cache misses and per-renderer flip guards. Mat* primitives, the Buffer*
  // family, EllipsoidPrimitive, Vector3DTile and GroundPolyline's
  // depth-sample read still write hyperbolic depth. See `WebGPULogDepth.ts`.
  public _logDepthWriteEnabled: boolean = true;

  // Pick-fleet log-depth master switch, separate from the scene's
  // `_logDepthWriteEnabled`. The pick mini-frame owns a single shared depth
  // attachment (`WebGPUSceneRendererPickPass`), so the whole native pick fleet
  // must be uniformly hyperbolic or uniformly log — a mixed attachment
  // depth-tests incoherently, which is why this is one switch rather than a
  // per-producer opt-in. Every native pick producer — globe, model including
  // the hover, metadata and precise passes, ellipsoid, splat, buffer
  // point/polygon/polyline, the billboard, point and polyline collections and
  // the primitive pick families — writes log `@builtin(frag_depth)` gated on
  // `isWebGPUPickLogDepthActive`. Opaque picks write the log depth; blend and
  // translucent picks stay depth-test-only, which is what keeps opaque
  // geometry behind translucent geometry pickable. Flipping this false
  // restores the uniformly hyperbolic pick attachment.
  public _pickLogDepthWriteEnabled: boolean = true;

  // Post-process snapshot. After the post-process pipeline has blitted the
  // scene framebuffer to the canvas, a single-pass `copyTextureToTexture`
  // mirrors the canvas into this view so environment effects — SSR, NPR,
  // clouds, weather, volumetric fog — sample a post-processed, tonemapped,
  // display-space colour source instead of the raw HDR scene framebuffer.
  // Those effects then composite their output back onto the canvas, and WebGPU
  // forbids reading and writing one texture in a single pass, so the
  // intermediate is required.
  //
  // Allocated lazily by `WebGPUSceneRendererEnsureResources` when the
  // canvas size or format changes. Width/height tracked alongside.
  public _postProcessSnapshotTexture: GPUTexture | null = null;
  public _postProcessSnapshotView: GPUTextureView | null = null;
  public _postProcessSnapshotWidth: number = 0;
  public _postProcessSnapshotHeight: number = 0;

  // Edge-framebuffer texture views, set by
  // `WebGPUSceneRenderer._execute3DTilePasses` after the edges pass
  // resolves its MRT attachments. Consumers such as the edge composite stage
  // read these as the WebGPU equivalent of WebGL's
  // `uniformState.edge{Color,Id,Depth}Texture`. `null` when no edge
  // commands ran this frame, signalling downstream consumers to skip.
  public _edgeColorView: GPUTextureView | null = null;
  public _edgeIdView: GPUTextureView | null = null;
  public _edgeDepthView: GPUTextureView | null = null;
  // Packed globe depth view from
  // `WebGPUGlobeDepth.executeCopyDepth`. Published each frame after
  // `executeCopyDepth` runs so downstream effects (the inline edge
  // detection stage in Model FS) have a single place to read it from. The
  // view identity is target-owned and stable until resize/device recreation;
  // `null` means globe depth was not computed in the current frame.
  public _globeDepthView: GPUTextureView | null = null;
  /** Pick-scoped packed depth; never falls back to a previous render frame. */
  public _pickClassificationDepthView: GPUTextureView | null = null;
  // Published alongside `_globeDepthView` so collection renderers with their
  // own view policy can compare the underlying texture identity. Both rotate
  // only on target recreation. `null` when globe depth was not computed this
  // frame.
  public _globeDepthTexture: GPUTexture | null = null;
  // Per-slice frustum state published by the multi-frustum loop right after
  // `_updateFrustumUniforms` refreshes `uniformState` for the slice.
  // Depth-sample classifiers — the GroundPrimitive textured-material FS, and
  // the GroundPolyline and Vector3DTile classifiers as they adopt the same
  // path — recover eye space from the sampled globe depth via `invProj`, but
  // their per-primitive UBO is packed once per frame at command-build time and
  // so carries the wrong slice's projection in a multi-frustum scene. These
  // fields let a per-slice bind-group resolver bind the correct `invProj` and
  // `(near, far)` at draw time.
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
  // The full camera frustum `[near, far]` the globe used to log-encode the
  // entire depth texture this frame. The globe DrawCommand is built once at
  // scene update, with `uniformState.currentFrustum === camera.frustum`, and
  // replayed unchanged across every slice, so one log-encode near/far covers
  // the whole globe depth texture. Depth-sample classifiers decode eye
  // distance with this, then unproject with the per-slice `invProj` and
  // `(near, far)` above; decoding with the per-slice band instead
  // reconstructs distances around 1e12 m and flattens the textured-material
  // UV. Captured before the loop in `WebGPUSceneRendererFrustumLoop`, ahead of
  // the per-slice `updateFrustum` that mutates `camera.frustum`, and consumed
  // via the classifier `fstate` UBO.
  public _logDepthEncodeNearFar: Float32Array | null = null;
  // Packed translucent depth view from
  // `WebGPUTranslucentTileClassification.executePackDepth`. Published
  // each frame after the pack-depth pipeline runs, if translucent depth
  // was captured this frame (gated on `tcc.hasTranslucentDepth`).
  // `null` on frames without translucent 3D-tile content. The
  // depth-sample classifier (`WebGPUGroundPrimitiveRenderer`) prefers
  // this view over `_globeDepthView` when present so classification
  // volumes clip against the front-most translucent tile surface,
  // matching WebGL's `czm_unpackDepth(czm_globeDepthTexture)` behaviour
  // for translucent-on-translucent classification.
  public _packedTranslucentDepthView: GPUTextureView | null = null;

  // Set to `true` by `WebGPUModelRenderer` when emitting a primitive whose
  // material declares KHR_materials_transmission. SceneRenderer reads it
  // between the opaque and translucent passes to decide whether to run the
  // refraction capture, a `copyTextureToTexture` from scene colour into the
  // refraction target. Reset per frame by the SceneRenderer at the start of
  // the frame so a stale flag cannot trigger a spurious copy. The flag is
  // coarse — any transmissive primitive anywhere in the scene sets it — and
  // could be scoped to a transmissive primitive in this frustum's translucent
  // pass.
  public _sceneHasTransmission: boolean = false;
  // View of the scene-FB refraction capture, published by SceneRenderer at
  // the end of the capture step. `null` until the first capture; consumed by
  // the model textureBindGroup builder at `@group(2) @binding(23)`. When
  // null the bind group falls back to the white placeholder, so the fragment
  // stage sees a constant white background for transmission — visually wrong,
  // but not a binding error.
  public _refractionSceneView: GPUTextureView | null = null;

  // Scene pipeline format generation, bumped by
  // `WebGPUSceneRenderer.update` whenever `_sceneColorFormat` changes, which
  // an HDR toggle, an MSAA toggle or a canvas format change all do. Renderers
  // that cache pipelines targeting the scene framebuffer — model PBR, globe
  // terrain, sky atmosphere, billboards, polylines, ground primitives and the
  // rest — compare against their last-built generation and, when it differs,
  // clear and rebuild their pipeline caches against the current
  // `scenePipelineFormat`. Without it a cached pipeline keeps the canvas
  // format it was built with, and toggling HDR produces format-mismatch
  // validation warnings and black scene-FB writes.
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
  // shared bookkeeping is absorbed instead of crashing the render loop.
  // Sized from device
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
  // Public underscore: shared with the WebGL-stub state proxy, the same
  // convention as `public _device` and `public _canvas`.
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

  // WebGPU pipeline state tracking, for creating pipelines with the correct
  // state. Public underscore: shared with the WebGL-stub state proxy.
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

  // Device loss recovery — delegated to WebGPUDeviceLossRecovery.
  private _deviceLossRecovery: WebGPUDeviceLossRecovery | null = null;
  private _releaseShaderValidation: (() => void) | null = null;

  // GL compatibility: bound buffer and texture tracking for legacy code.
  // Public underscore: shared with the WebGL-stub state proxy.
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
      // Cleanup is best-effort here: a late unconfigure/native-destroy error
      // must not replace the initialization failure that caused the rollback.
      try {
        context?.destroy();
      } catch {
        // destroy() still completes its guarded final-cleanup tail before
        // throwing. Preserve the primary create() rejection for callers.
      }
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
      // Adapter and device acquisition route through `WebGPUDevicePool`.
      // The pool owns the adaptive limit and feature negotiation:
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
        // Hand the pre-kicked adapter request to the pool so negotiation that
        // started during chunk parse is reused instead of re-requested
        // serially. The pool falls back on any mismatch or rejection.
        prefetchedAdapter: this._options.prefetchedAdapter,
      });

      this._adapter = acquired.adapter;
      this._device = acquired.device;
      retainEffectsPlaceholderCacheForContext(this._device, this);
      // Records that the device came from the pool, which drives the destroy
      // path's choice between the refcount-aware `pool.releaseDevice` and a
      // direct `device.destroy()`, safe only for an exclusively owned device.
      this._deviceFromPool = true;

      if (!this._adapter) {
        throw new RendererInitializationError(
          "adapter",
          "Failed to get WebGPU adapter. " +
            "WebGPU may not be properly supported on this device.",
        );
      }

      // Record which features were actually enabled.
      this._featureFlags.markEnabled(this._device.features);

      // Log enabled optional features for debugging. The list comes from
      // the device's own `features` set so the message reflects what the
      // pool's negotiator and the adapter granted, which can differ from the
      // user-requested features when the adapter supports only some of them.
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
      this._registerResourceCaches();

      // Capture this context generation's immutable device capabilities.
      this._initializeContextLimits();

      // Update capability flags based on enabled features
      this._updateFeatureFlags();

      // Cache the primitive_index utility module so backend-agnostic
      // Scene code can probe support without importing from Renderer/WebGPU.
      // Assigned synchronously from the static import above; an inline
      // `await import(...)` would serialize an extra module round-trip into
      // every boot for a dependency-free utility. Consumers such as
      // `supportsTriangulationDebug` tolerate a null cache.
      this._primitiveIndexUtilsCache = WebGPUPrimitiveIndexUtils;

      // Configure canvas context
      this._context = this._canvas.getContext("webgpu") as GPUCanvasContext;

      if (!this._context) {
        throw new RuntimeError("Failed to get WebGPU canvas context.");
      }

      // Get preferred format
      this._presentationFormat = navigator.gpu.getPreferredCanvasFormat();

      // Configure the canvas. `_hdrCanvasOutput` is false at init; routing
      // through `_applyCanvasConfig` keeps a later `setHDRCanvasOutput(true)`
      // on the same configure path, which is also where the browser-compat
      // fallback chain lives.
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

      // No shader-init await here: the primitive and collection shader
      // modules are statically imported and always available, so
      // `initPrimitiveShaders` / `initCollectionShaders` are no-ops and
      // awaiting them would add two dead microtask turns to the boot path.

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
    // `warmUpGlobeRenderer`, a top-level export in
    // `GlobeSurfaceTileProviderRendering.js`, populates the module-scoped
    // `_webgpuGlobeRenderers` WeakMap and calls `.initialize`, which runs the
    // two-variant GlobeTerrain shader-module prewarm in this idle init window
    // instead of on the first tile draw. Constructing the feature renderer
    // instance here would not do it: the render path in
    // `addWebGPUDrawCommandsForTile` builds its own per-device instance
    // through that WeakMap, and the constructor performs no GPU work. Without
    // the prewarm the first tile draw costs about 176 ms from
    // `rendererReady` to `firstFrame` on WebGPU against about 16 ms on WebGL.
    // Fire-and-forget through a dynamic import so it never blocks
    // `_initialize` from returning and never introduces an eager
    // Renderer-to-Scene cycle. Every failure is caught and dropped; the lazy
    // first-frame path stays correct.
    void import("../../Scene/GlobeSurfaceTileProviderRendering.js")
      .then((m) => {
        m.warmUpGlobeRenderer(this);
      })
      .catch(() => {
        /* prewarm is best-effort — the lazy first-frame path still works */
      });
    // The GPU cullers are not warmed here. Their lazy getters initialize on
    // first use, and eager warm-up is opt-in through
    // `warmUpHighDensityDispatchers()` so only a caller that knows its scene
    // is dense pays the pipeline-compile cost in a load frame.
  }

  /**
   * Scene-level GPU culling hint mirror. Called by the
   * `Scene.gpuCullingHint` setter.
   *
   * When set to `'never'`:
   *   - Lazy getters refuse to allocate new culler instances.
   *   - Any existing aux-culler instances are reaped immediately rather than
   *     waiting up to 10 seconds for the idle-decay sweep, because the caller
   *     has explicitly opted out.
   *
   * Reaping mid-render is safe because the next render frame's gate update
   * reads the hint and short-circuits to false, so the filter chain skips even
   * if the prior frame's commands were sized to a now-destroyed buffer.
   *
   * @param hint The culling hint to apply.
   */
  public setGpuCullingHint(hint: "auto" | "always" | "never"): void {
    const prev = this._gpuCullingHint;
    this._gpuCullingHint = hint;
    if (hint === "never" && prev !== "never") {
      this._reapAllAuxCullers();
    }
  }

  /**
   * Destroy every auxiliary culler instance immediately. Used by
   * `setGpuCullingHint('never')` to honour the opt-out without waiting for
   * idle decay, unlike `_reapIdleAuxCullers`, which is selective by
   * last-used age.
   */
  private _reapAllAuxCullers(): void {
    // Body lives in `WebGPUContextCullerPool.ts`.
    reapAllAuxCullersExt(this);
  }

  public get gpuCullingHint(): "auto" | "always" | "never" {
    return this._gpuCullingHint;
  }

  /**
   * Proactively initialize the three high-density GPU dispatchers — the GPU
   * culler, HiZ occlusion and GPU sort keys — so their compute-shader pipeline
   * compiles and buffer allocations happen during scene load instead of on the
   * first frame whose command count crosses the activation threshold. Without
   * the warm-up that first crossing hitches by 5-50 ms for the compile and
   * allocation.
   *
   * Triggered by `Scene.gpuCullingHint = 'always'`; the contained default is
   * `'never'`, and `'auto'` is an explicit characterization mode for scenes
   * expected to exceed 10,000 visible commands.
   *
   * Fire-and-forget: each dispatcher's init is async and a failure is
   * non-fatal, since the lazy path still works.
   *
   * @param {number} [hintViewportWidth=1920] Expected canvas width, used to
   *   size the HiZ pyramid. Pass the current `drawingBufferWidth` when it is
   *   known; HiZ resizes when the actual canvas changes.
   * @param {number} [hintViewportHeight=1080] Expected canvas height for the
   *   HiZ pyramid.
   * @param {number} [hintMaxCommands=16384] Expected peak opaque command
   *   count, which sets the buffer capacity for all three dispatchers.
   */
  public warmUpHighDensityDispatchers(
    hintViewportWidth: number = 1920,
    hintViewportHeight: number = 1080,
    hintMaxCommands: number = 16384,
  ): void {
    if (!this._device || this._isDeviceUnavailable) return;
    // Refuse warm-up when the hint forbids it, symmetric with the lazy-getter
    // guards so the eager and lazy paths agree.
    if (this._gpuCullingHint === "never") return;

    // gpuCuller — touching the getter triggers the dynamic import +
    // pipeline compile. Errors are caught inside the getter chain.
    void this.gpuCuller;
    // The dedicated translucent culler too: without it the first activation
    // of the translucent path still pays the 5-50 ms compile hitch the caller
    // opted into eager warm-up to avoid.
    void this.gpuCullerTranslucent;
    // Per-frustum opaque cullers, one to three in a typical scene, so a
    // multi-frustum log-depth scene does not hitch as later frustums first
    // activate.
    for (let i = 1; i < 4; i++) {
      this.getGPUCullerForOpaqueFrustum(i);
    }
    // Per-cascade shadow cullers, four for typical CSM cascades. Inert until
    // the cascades activate, but the compile cost amortizes here regardless.
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
  // Public underscore: shared with the device-loss host-adapter.
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
   * When true, the dynamic environment map allocates its source cube and
   * procedural-sky storage texture as `rgba16float`. The default `false`
   * selects `rgba8unorm`, matching WebGL. Read by
   * `WebGPUDynamicEnvironmentMapManager`.
   */
  get hdrEnvironmentMap(): boolean {
    return this._options.webgpu?.hdrEnvironmentMap ?? false;
  }

  /**
   * `'parity'`, the default, samples the source cube at mip 0 in the radiance
   * prefilter; `'high'` builds a source mip chain and samples a
   * GGX-pdf-derived LOD. Read by `WebGPUDynamicEnvironmentMapManager` and
   * `WebGPUIBLPipeline`.
   */
  get iblPrefilterQuality(): "parity" | "high" {
    return this._options.webgpu?.iblPrefilterQuality ?? "parity";
  }

  /**
   * When true, both the dynamic environment-map procedural sky fill and the
   * aerial-perspective post-process source their sky radiance from the
   * sun-relative sky-view and multiple-scattering LUTs — the same tables the
   * visible SkyAtmosphere samples — instead of their own inline
   * single-scatter approximations, so reflected sky and hazed distance match
   * the visible multiple-scattering sky. The default `false` leaves both
   * shaders on their inline ports. Read by
   * `WebGPUDynamicEnvironmentMapManager` and
   * `WebGPUPostProcessStageCollection`.
   */
  get envMapMultiScatter(): boolean {
    return this._options.webgpu?.envMapMultiScatter ?? false;
  }

  /**
   * When true, and when a `DynamicEnvironmentMapManager` opts in through
   * `enableSceneCapture`, the dynamic env cube refresh renders the opaque
   * globe surface into its six faces from six ENU cube-face cameras, so
   * terrain reflects in water and PBR models. The default `false` leaves the
   * env cube filled by the procedural sky alone and adds no GPU passes. Read
   * by `WebGPUDynamicEnvironmentMapManager`.
   */
  get sceneCaptureReflections(): boolean {
    return this._options.webgpu?.sceneCaptureReflections ?? false;
  }

  /**
   * When true, the dynamic env cube refresh accumulates temporally: a history
   * cube and an exponential-moving-average blend pass sit between the cube
   * capture and the IBL prefilter, so the env map crossfades smoothly on a
   * small sun or camera change and the six-face capture amortizes across
   * frames. History resets on a large sun or camera delta so it cannot smear.
   * The default `false` allocates no history cube and runs no blend pass.
   * Read by `WebGPUDynamicEnvironmentMapManager`.
   */
  get envMapTemporalAccumulation(): boolean {
    return this._options.webgpu?.envMapTemporalAccumulation ?? false;
  }

  /**
   * When true, the dynamic env cube's procedural sky fill runs a low-resolution
   * per-face procedural cloud raymarch and composites it over the sky before
   * the IBL prefilter, so a cloudy or overcast sky produces a reflection and
   * diffuse IBL with visible cloud structure rather than a uniform darkening.
   * Pairs with `envMapTemporalAccumulation` to smooth the march over frames.
   * The default `false` binds placeholder noise and never takes the march
   * branch. Read by `WebGPUDynamicEnvironmentMapManager`.
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
   * WebGPU has no offscreen ray-depth producer. The offscreen render that the
   * `*MostDetailed` height queries drive is a pick pass, and the globe-depth
   * framebuffer — the only packed pick-depth source here — is off for pick
   * passes, so the offscreen view's `PickDepth` never receives a depth texture
   * and its query returns `undefined`. Overrides the base `true` so callers can
   * test `Scene.sampleHeightMostDetailedSupported` /
   * `Scene.clampToHeightMostDetailedSupported` up front instead of discovering
   * the gap as an array full of `undefined`.
   *
   * The synchronous `Scene.sampleHeight` / `Scene.clampToHeight` are
   * unaffected — they reuse the main scene depth and stay supported here — so
   * this stays separate from `supportsSynchronousReadback`.
   */
  override get supportsOffscreenRayDepthReadback(): boolean {
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
   * on `isWebGPU`.
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
   * The single packed pick-depth texture — `WebGPUGlobeDepth.globeDepthTexture`,
   * shared across all frustum slices — carries full-frustum log depth whenever
   * the renderer-wide log-depth master switch is on. This mirrors
   * `_logDepthWriteEnabled` so flipping the kill switch returns `Picking` to
   * its undefined, ray-pick fallback: the per-slice hyperbolic depth written
   * with the switch off has no consistent single-texture reconstruction.
   */
  override get pickDepthFullFrustumLogEncode(): boolean {
    return this._logDepthWriteEnabled;
  }

  /**
   * The WebGPU scene renderer hard-codes the full-canvas viewport,
   * `setViewport(0, 0, _width, _height)`, so the per-eye split
   * `executeWebVRCommands` performs has no effect. Reporting no stereo
   * support makes `scene.useWebVR = true` fail loudly rather than silently
   * produce single-eye output.
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
   * Begin a new frame: creates the command encoder and acquires the canvas
   * swap-chain view. The default canvas render pass is not opened here. It
   * opens on first demand — a consumer calling
   * `resumeDefaultRenderPass()` or `_beginDefaultRenderPass()`, a canvas draw
   * through `executeDrawCommand`, or the `endFrame` clear/present fallback for
   * a frame where nothing else touches the canvas. The first open of a
   * frame clears each untouched channel, which reproduces a
   * clear-once-then-load sequence exactly.
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

    // A truncated prior frame must not strand submit-owned resource leases or
    // readback promises. Normal frames drain these lists at their respective
    // encoder-segment and logical-frame submission boundaries.
    this._drainAfterCommandEncoderSubmitCallbacks(false);
    this._drainAfterFrameSubmitCallbacks(false);

    // Reset frame statistics
    this._drawCallCount = 0;
    this._triangleCount = 0;
    this._frameCount++;
    this._environmentDemandRegistry.beginFrame(this._deviceResourceGeneration);
    this._environmentRefreshCoordinator.beginFrame(
      this._deviceResourceGeneration,
    );
    // Advance the bounded refresh drain and re-anchor the target pool
    // on the current device generation before any producer can request work.
    this._environmentRefreshScheduler.beginFrame(
      this._deviceResourceGeneration,
    );
    if (this._environmentTargetPool !== null) {
      this._environmentTargetPool.beginFrame(
        this._frameCount,
        this._device,
        this._deviceResourceGeneration,
      );
    }
    this._clearCallsThisFrame = 0;
    this._clearOverflowWarned = false;
    this._shadowReceiveUniformRefreshes.length = 0;
    this._shadowReceiveUniformRefreshSet.clear();

    // Reset the canvas demand flags and the pass target. Reset here and in
    // `beginPickFrame`, never in `endFrame` — see the field docs.
    this._activePassTarget = null;
    this._canvasColorTouchedThisFrame = false;
    this._canvasDepthTouchedThisFrame = false;
    // A fresh frame starts with no valid resolved scene color.
    this._sceneColorResolvePending = true;

    // Advance ring buffer allocator to next page
    if (this._uniformAllocator) {
      this._uniformAllocator.beginFrame();
    }

    // Bump the internal frame counter and periodically prune idle auxiliary
    // culler instances. The check runs every `IDLE_DECAY_CHECK_INTERVAL`
    // frames so the walk cost amortizes to nearly zero per frame.
    this._internalFrameId++;
    if (this._internalFrameId % WebGPUContext.IDLE_DECAY_CHECK_INTERVAL === 0) {
      this._reapIdleAuxCullers();
      // The same amortized cadence for the environment target pool. The
      // trim refuses to destroy anything used on the current frame, so it can
      // never race a recorded-but-unsubmitted command.
      this._environmentTargetPool?.trim(this._frameCount);
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

    // The default canvas render pass is not opened here. On the default route
    // the scene renderer immediately redirects to the scene framebuffer, so
    // opening it here produces two empty passes per frame; it opens on first
    // demand instead, and `endFrame` presents a cleared canvas for a frame no
    // consumer touches.

    // Seed `uniformState.viewport` once per frame. The WebGL path seeds it in
    // `RenderState.applyViewport`, alongside `gl.viewport`; without the
    // equivalent here `uniformState.viewportOrthographic` and
    // `viewportTransformation` stay at identity and every screen-space WGSL
    // shader has to hand-build them from drawingBufferWidth/Height. Seeding
    // here makes the canonical UniformState getters correct for every
    // screen-space WebGPU shader.
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
   * the missing encoder, leaving the pick framebuffer empty and every pick
   * returning `undefined`. This creates just the encoder and advances the
   * uniform ring-buffer page — the non-canvas half of `beginFrame`. It does
   * not acquire the canvas texture or open the default canvas render pass,
   * because the pick pass renders to the pick framebuffer and manages its own
   * pass. The matching submit and finalize is `pickEnd → context.endFrame()`.
   * A no-op if an encoder already exists, as in a re-entrant call within one
   * pick.
   */
  beginPickFrame(): void {
    if (
      this._isDeviceUnavailable ||
      !this._device ||
      this._currentCommandEncoder
    ) {
      return;
    }
    // Reaching this point starts a standalone pick mini-frame with a fresh
    // encoder. Its clear-loop budget must not inherit calls from a previously
    // submitted mini-frame. Keep these resets after the early-return gate so
    // the renderer's idempotent/re-entrant beginPickFrame call cannot reset the
    // budget while this mini-frame is already being encoded.
    this._clearCallsThisFrame = 0;
    this._clearOverflowWarned = false;
    // A pick mini-frame never acquires the swap view, so the `endFrame`
    // present fallback, gated on `_currentTextureView`, cannot fabricate a
    // canvas pass here. The tracking state is reset anyway so a stale target
    // from a truncated frame cannot leak in.
    //
    // If a render frame still holds the swap view — its `endFrame` has not run
    // — its canvas-touched flags describe the post-process blit that already
    // wrote the canvas this frame, and wiping them would make the render's
    // present fallback re-clear the blit. So only a standalone pick resets the
    // demand flags.
    const renderFrameInFlight = this._currentTextureView !== null;
    if (!renderFrameInFlight) {
      this._shadowReceiveUniformRefreshes.length = 0;
      this._shadowReceiveUniformRefreshSet.clear();
    }
    this._activePassTarget = null;
    // A pick mini-frame renders to a single-sample pick framebuffer, so the
    // ensure helper is inert; reset conservatively regardless.
    this._sceneColorResolvePending = true;
    if (!renderFrameInFlight) {
      this._canvasColorTouchedThisFrame = false;
      this._canvasDepthTouchedThisFrame = false;
    }
    // Drop any swap view a prior, possibly truncated, render frame left behind
    // so a pick pass cannot lazily open the stale canvas view during this
    // mini-frame.
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
   * frame, deferred destroys, and logical-frame after-submit callbacks remain
   * owned by the logical frame. Exact encoder-segment callbacks settle at this
   * boundary. Only the command encoder is rotated. WebGL inherits the
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
      this._submitPendingTextureMipJobs();

      const firstViewportEncoder = this._currentCommandEncoder;
      const firstViewportBuffer = firstViewportEncoder.finish();
      this._device.queue.submit([firstViewportBuffer]);
      // Close the submitted identity before callbacks run, so callback code
      // cannot attach new work to an encoder whose disposition is final.
      this._currentCommandEncoder = null;
      this._drainCommandEncoderSubmitCallbacks(firstViewportEncoder, true);
      this._currentCommandEncoder = this._device.createCommandEncoder({
        label: "Secondary Viewport Continuation Encoder",
      });
    } catch (error) {
      // The segment cannot be retried safely after finish/submit starts. Match
      // endFrame's abandonment contract so readback promises and the allocator
      // cannot leak into a future request-render frame.
      this._drainAfterCommandEncoderSubmitCallbacks(false);
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
   * Not called from `beginFrame()`: the canvas pass opens on first demand,
   * through `resumeDefaultRenderPass`, the lazy `executeDrawCommand` open, or
   * the `endFrame` present fallback. Load ops derive from the per-frame demand
   * flags — the first open of a frame clears each untouched channel and every
   * subsequent open loads — so a caller never chooses between clear and load.
   *
   * @param {string} [label] - Pass label; the `endFrame` present fallback
   *   passes a distinct label so a captured pass list is self-describing.
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
    // the JS caller. A debug build throws synchronously with the stack
    // pointing at the caller; a release build defensively ends the orphan pass
    // so production keeps rendering.
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

    // First open of a frame clears; every later open loads. Deriving the load
    // op from the demand flags clears each channel exactly once, at its first
    // actual open. Depth is the load-bearing half: an untouched depth texture
    // read with "load" yields WebGPU's lazy zero, 0.0, rather than the 1.0 a
    // clear writes, and every depth-tested canvas draw then fails.
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
   *   classification. The three scene-FB open sites declare
   *   "scene-framebuffer"; everything else defaults to "external".
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
    // as an async validation error. A debug build throws so the stack points
    // at the caller; a release build falls through to the defensive end so
    // production keeps rendering.
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

    // Opening a scene-framebuffer segment means new draws will land in the
    // multisampled color attachment, making the single-sample resolve texture
    // stale. Marking it here is what makes the next resolved-color consumer's
    // `_ensureSceneColorResolved` perform the demand-driven resolve, in place
    // of an eager resolve at every `pass.end()`. Canvas, external and pick
    // passes never dirty scene color.
    if (target === "scene-framebuffer") {
      this._sceneColorResolvePending = true;
    }

    // A pass whose color or depth attachment is the current swap-chain view
    // has, by construction, written canvas content. Recording that here
    // structurally is what makes the next default-pass open load rather than
    // clear the channel, and what makes the `endFrame` present fallback
    // preserve the blit; the manual `markCanvasContentWritten()` calls at each
    // write site are the redundant half. The scan covers at most eight
    // attachments and neither allocates nor logs.
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

  /**
   * Run a callback immediately after one exact command-encoder segment is
   * submitted, or when that segment is abandoned before submission.
   *
   * This is deliberately distinct from {@link enqueueAfterFrameSubmit}. A
   * logical frame can submit and rotate its encoder at a Scene2D viewport or
   * readback boundary. Submit-owned resource leases must settle at that exact
   * boundary rather than waiting for a later segment to finish.
   *
   * @param encoder The currently active encoder that owns the work/lease.
   * @param callback Receives true after that encoder reaches queue.submit, or
   *   false if it is abandoned first.
   * @returns Whether the callback was accepted by the exact active segment.
   * @private
   */
  enqueueAfterCommandEncoderSubmit(
    encoder: GPUCommandEncoder,
    callback: (submitted: boolean) => void,
  ): boolean {
    if (
      typeof callback !== "function" ||
      this._isDeviceUnavailable ||
      this._commandEncoderSubmitCallbacksDraining ||
      !encoder ||
      encoder !== this._currentCommandEncoder
    ) {
      return false;
    }

    let callbacks = this._afterCommandEncoderSubmitCallbacks.get(encoder);
    if (!callbacks) {
      callbacks = [];
      this._afterCommandEncoderSubmitCallbacks.set(encoder, callbacks);
    }
    callbacks.push(callback);
    return true;
  }

  private _invokeCommandEncoderSubmitCallbacks(
    callbacks: Array<(submitted: boolean) => void>,
    submitted: boolean,
  ): void {
    for (let i = 0; i < callbacks.length; i++) {
      try {
        callbacks[i](submitted);
      } catch {
        // A transaction owner reports its own failure. One callback must never
        // strand the remaining submit-owned leases for this encoder segment.
      }
    }
  }

  private _drainCommandEncoderSubmitCallbacks(
    encoder: GPUCommandEncoder,
    submitted: boolean,
  ): void {
    const callbacks = this._afterCommandEncoderSubmitCallbacks.get(encoder);
    if (!callbacks) {
      return;
    }
    // Delete before invoking user code. A callback cannot re-enlist work onto
    // an encoder whose disposition is already known.
    this._afterCommandEncoderSubmitCallbacks.delete(encoder);
    const wasDraining = this._commandEncoderSubmitCallbacksDraining;
    this._commandEncoderSubmitCallbacksDraining = true;
    try {
      this._invokeCommandEncoderSubmitCallbacks(callbacks, submitted);
    } finally {
      this._commandEncoderSubmitCallbacksDraining = wasDraining;
    }
  }

  private _drainAfterCommandEncoderSubmitCallbacks(submitted: boolean): void {
    if (this._afterCommandEncoderSubmitCallbacks.size === 0) {
      return;
    }
    const batches = this._afterCommandEncoderSubmitCallbacks;
    this._afterCommandEncoderSubmitCallbacks = new Map();
    const wasDraining = this._commandEncoderSubmitCallbacksDraining;
    this._commandEncoderSubmitCallbacksDraining = true;
    try {
      for (const callbacks of batches.values()) {
        this._invokeCommandEncoderSubmitCallbacks(callbacks, submitted);
      }
    } finally {
      this._commandEncoderSubmitCallbacksDraining = wasDraining;
    }
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
   * pass the context cannot observe. The post-process
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
   * Enqueue mip-chain generation for a freshly uploaded texture. The job is
   * encoded into the context's shared frame-owned preparation encoder in
   * {@link WebGPUContext#endFrame} and submitted before the frame encoder, so
   * the mips are complete before any scene pass samples the texture this frame.
   *
   * This is the canonical renderer-neutral API. The older imagery-named alias
   * remains below because globe/model compatibility callers shipped against it.
   * Neither API opens an encoder or submits privately from a renderer hot path.
   *
   * If the device is gone the job is dropped: nothing will sample the texture
   * (its owning realization is discarded on device change), so generating mips
   * would be wasted work and would fail on the dead device anyway.
   */
  enqueueTextureMipGeneration(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    options?: WebGPUTextureMipGenerationOptions,
  ): boolean {
    if (!texture || mipLevelCount <= 1) {
      return false;
    }
    const device = this._device;
    if (!device || this._isDeviceUnavailable) {
      return false;
    }
    if (!supportsWebGPUMipmapGeneration(device, format)) {
      return false;
    }
    const dimension = options?.dimension ?? "2d";
    if (dimension !== "2d" && !supportsWebGPULayeredMipmapGeneration(device)) {
      return false;
    }
    const normalizedOptions: Required<WebGPUTextureMipGenerationOptions> = {
      dimension,
      baseArrayLayer: Math.max(0, options?.baseArrayLayer ?? 0),
      arrayLayerCount: Math.max(
        1,
        options?.arrayLayerCount ?? (dimension === "cube" ? 6 : 1),
      ),
    };
    let textureJobKeys = this._pendingTextureMipJobKeys.get(texture);
    if (!textureJobKeys) {
      textureJobKeys = new Set<string>();
      this._pendingTextureMipJobKeys.set(texture, textureJobKeys);
    }
    const jobKey = `${format}|${mipLevelCount}|${normalizedOptions.dimension}|${normalizedOptions.baseArrayLayer}|${normalizedOptions.arrayLayerCount}`;
    if (textureJobKeys.has(jobKey)) {
      return true;
    }
    textureJobKeys.add(jobKey);
    this._pendingTextureMipJobs.push({
      texture,
      format,
      mipLevelCount,
      options: normalizedOptions,
      device,
      resourceGeneration: this._deviceResourceGeneration,
    });
    return true;
  }

  /**
   * Encode a mip chain directly after a compatibility copy recorded in the
   * current scene encoder. `copyTexImage2D`/`copyTexSubImage2D` can source
   * pixels rendered earlier in this same command buffer, so their mips cannot
   * use the normal pre-frame preparation submit (which necessarily runs before
   * that copy). Encoding copy -> mip passes in one encoder preserves WebGL
   * ordering without adding a private submission. Ordinary queue writes and
   * external-image uploads continue to use enqueueTextureMipGeneration().
   */
  encodeTextureMipGenerationInCurrentEncoder(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    options?: WebGPUTextureMipGenerationOptions,
  ): boolean {
    const device = this._device;
    const encoder = this._currentCommandEncoder;
    if (
      !texture ||
      mipLevelCount <= 1 ||
      !device ||
      this._isDeviceUnavailable ||
      !encoder ||
      this._currentRenderPassEncoder ||
      !supportsWebGPUMipmapGeneration(device, format) ||
      ((options?.dimension === "cube" || options?.dimension === "2d-array") &&
        !supportsWebGPULayeredMipmapGeneration(device))
    ) {
      return false;
    }
    this.mipmapGenerator.generateMipmaps(
      texture,
      format,
      mipLevelCount,
      encoder,
      options,
    );
    return true;
  }

  /**
   * Compatibility alias for the imagery-specific form of this surface.
   * Renderer-neutral consumers use
   * {@link WebGPUContext#enqueueTextureMipGeneration}.
   */
  enqueueImageryMipGeneration(
    texture: GPUTexture,
    format: GPUTextureFormat,
    mipLevelCount: number,
    options?: WebGPUTextureMipGenerationOptions,
  ): boolean {
    return this.enqueueTextureMipGeneration(
      texture,
      format,
      mipLevelCount,
      options,
    );
  }

  /**
   * Retire pending mip work before destroying a texture inline. Owners call
   * this immediately before `GPUTexture.destroy()` when replacement, failed
   * publication, or teardown makes the texture dead before the frame-owned mip
   * preparation encoder runs.
   *
   * Do not call this for {@link WebGPUContext#scheduleTextureDestroy}'d
   * textures. Deferred textures stay live through the upcoming frame submit
   * and may still be sampled by already-recorded commands.
   */
  cancelTextureMipGeneration(texture: GPUTexture): void {
    if (!texture) {
      return;
    }
    this._inlineDestroyedTextures.add(texture);
  }

  /** Compatibility alias for the original F7 inline-destroy notification. */
  noteInlineTextureDestroy(texture: GPUTexture): void {
    this.cancelTextureMipGeneration(texture);
  }

  private _textureMipJobKey(job: PendingTextureMipJob): string {
    return `${job.format}|${job.mipLevelCount}|${job.options.dimension}|${job.options.baseArrayLayer}|${job.options.arrayLayerCount}`;
  }

  /** Restore an unsubmitted preparation batch after synchronous encoding fails. */
  private _requeueTextureMipJobsAfterEncodeFailure(
    jobs: PendingTextureMipJob[],
    device: GPUDevice,
    resourceGeneration: number,
  ): void {
    // A generator/pipeline/view/finish failure invalidates the entire prep
    // command buffer, including jobs encoded successfully before the throw.
    // Rebuild the pending batch from exact still-live ownership tuples. Merge
    // any re-entrant enqueues after the original jobs so accepted work keeps
    // FIFO order while exact duplicates remain coalesced.
    const candidates = jobs.concat(this._pendingTextureMipJobs);
    const restored: PendingTextureMipJob[] = [];
    const keys = new WeakMap<GPUTexture, Set<string>>();
    for (let i = 0; i < candidates.length; ++i) {
      const job = candidates[i];
      if (
        job.device !== device ||
        job.resourceGeneration !== resourceGeneration ||
        this._inlineDestroyedTextures.has(job.texture)
      ) {
        continue;
      }
      let textureKeys = keys.get(job.texture);
      if (!textureKeys) {
        textureKeys = new Set<string>();
        keys.set(job.texture, textureKeys);
      }
      const key = this._textureMipJobKey(job);
      if (textureKeys.has(key)) {
        continue;
      }
      textureKeys.add(key);
      restored.push(job);
    }
    this._pendingTextureMipJobs = restored;
    this._pendingTextureMipJobKeys = keys;
  }

  /**
   * Capture-and-clear the pending texture mip jobs and encode them into one
   * `"TextureMipPreparation"` command buffer. Returns null when there
   * is nothing to encode. Shared by {@link WebGPUContext#endFrame} and
   * {@link WebGPUContext#flushPendingTextureMipJobs}.
   */
  private _encodePendingTextureMipJobs(): EncodedTextureMipBatch | null {
    if (this._pendingTextureMipJobs.length === 0) {
      return null;
    }
    const device = this._device;
    const jobs = this._pendingTextureMipJobs;
    this._pendingTextureMipJobs = [];
    this._pendingTextureMipJobKeys = new WeakMap();
    if (!device) {
      return null;
    }
    const resourceGeneration = this._deviceResourceGeneration;
    try {
      let prepEncoder: GPUCommandEncoder | null = null;
      let gen: WebGPUMipmapGenerator | null = null;
      let encoded = 0;
      for (let i = 0; i < jobs.length; ++i) {
        const job = jobs[i];
        // A queued texture belongs to one exact physical ownership tuple.
        if (
          job.device !== device ||
          job.resourceGeneration !== resourceGeneration
        ) {
          continue;
        }
        // F7 — skip ONLY textures actually destroyed inline (dead now).
        if (this._inlineDestroyedTextures.has(job.texture)) {
          continue;
        }
        if (!prepEncoder) {
          prepEncoder = device.createCommandEncoder({
            label: "TextureMipPreparation",
          });
          gen = this.mipmapGenerator;
        }
        gen!.generateMipmaps(
          job.texture,
          job.format,
          job.mipLevelCount,
          prepEncoder,
          job.options,
        );
        ++encoded;
      }
      return encoded > 0
        ? {
            commandBuffer: prepEncoder!.finish(),
            jobs,
            device,
            resourceGeneration,
          }
        : null;
    } catch (error) {
      this._requeueTextureMipJobsAfterEncodeFailure(
        jobs,
        device,
        resourceGeneration,
      );
      throw error;
    }
  }

  /** Encode and synchronously submit one pending mip batch transactionally. */
  private _submitPendingTextureMipJobs(): void {
    const batch = this._encodePendingTextureMipJobs();
    if (!batch) {
      return;
    }
    try {
      batch.device.queue.submit([batch.commandBuffer]);
    } catch (error) {
      // A synchronous submit rejection means none of this drained prep batch
      // is owned by the queue. Restore every still-live exact tuple so a later
      // frame/flush can retry; owners have already recorded queue acceptance.
      this._requeueTextureMipJobsAfterEncodeFailure(
        batch.jobs,
        batch.device,
        batch.resourceGeneration,
      );
      throw error;
    }
  }

  /**
   * Immediately encode + submit any pending texture mip jobs. This escape
   * hatch exists only for a renderer that already owns a private mid-frame
   * submit and must establish ordering before it samples newly realized
   * textures. Ordinary renderers enqueue work and let `endFrame()` own submit.
   *
   * Every renderer that privately `queue.submit`s work sampling globe imagery
   * textures mid-frame — the dynamic environment-map capture, for instance —
   * must call this. Without the flush, a texture realized earlier in the same
   * frame is sampled with mips 1..N still zero-initialized, because the
   * frame-owned `"TextureMipPreparation"` submit only happens in `endFrame`.
   * A no-op when nothing is pending.
   */
  flushPendingTextureMipJobs(): void {
    if (this._pendingTextureMipJobs.length === 0) {
      return;
    }
    if (!this._device || this._isDeviceUnavailable) {
      this._pendingTextureMipJobs.length = 0;
      this._pendingTextureMipJobKeys = new WeakMap();
      return;
    }
    this._submitPendingTextureMipJobs();
  }

  /** Compatibility alias for existing imagery capture callers. */
  flushPendingImageryMipJobs(): void {
    this.flushPendingTextureMipJobs();
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

      // Deferred clear and present fallback. An acquired swap texture that
      // nothing writes presents WebGPU lazy zeros, so a frame where no
      // consumer touched the canvas colour — an empty scene, a missing
      // post-process, an exception-truncated frame — needs this open and end.
      // Every other frame skips it. A pick mini-frame never acquires a swap
      // view in `beginPickFrame`, so `_currentTextureView === null` excludes
      // it naturally. The distinct label keeps a captured pass list
      // self-describing; no live code matches on pass labels.
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

      // Encode every texture mip job deferred out of draw emission into one
      // prep encoder and submit it as its own submit, before the frame
      // encoder: same-queue ordering is guaranteed, and an invalid prep buffer
      // then cannot invalidate the whole frame submit. The resulting queue
      // order — `copyExternalImageToTexture` at update time, then these mip
      // passes, then the scene passes — is what lets the frame that realized
      // the texture sample complete mips. Only textures destroyed inline this
      // frame are skipped; scheduled-destroy textures are live through this
      // submit and still get their mips.
      this._submitPendingTextureMipJobs();

      // Submit command buffer
      const submittedEncoder = this._currentCommandEncoder;
      const commandBuffer = submittedEncoder.finish();
      this._device.queue.submit([commandBuffer]);
      // This exact encoder segment is now queue-owned. Settle its leases before
      // the broader logical-frame callbacks and before any later finalization
      // step can fail.
      this._currentCommandEncoder = null;
      this._drainCommandEncoderSubmitCallbacks(submittedEncoder, true);
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
      // Any failure before the frame submit completes abandons every
      // frame-owned readback copy. Leaving the promises queued for a future
      // `beginFrame` would strand them: a request-render scene may stop
      // rendering immediately after an error.
      this._drainAfterCommandEncoderSubmitCallbacks(false);
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
      // shaders — the Hi-Z pyramid, the occlusion test, the G-buffer producer
      // — can sample the depth after the render pass stores it. It is
      // unconditional: the bit costs one texture-usage flag and no per-frame
      // work, while gating it leaves `depthOnlyTextureView` returning null and
      // silently disables every compute-sampled-depth consumer.
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
   *   with a 3x3 PCF box kernel. Passed through
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

  // The `DESIRED_FEATURES` constant and the request-list builder live in
  // `WebGPUFeatureFlags.ts`. `_initialize` calls
  // `this._featureFlags.buildRequestList(adapter, userRequested)` directly;
  // with one caller there is no reason for a private wrapper method here.

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
  // Public underscore: shared with the device-loss host-adapter.
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
    // The live state proxy and the factory call live in
    // `WebGPUContextWebGLStubInit.ts`. The 26 underscore-prefixed fields the
    // proxy reads and writes are `public _xxx` on this class, the same
    // convention as `public _device`, `public _canvas` and
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
    // `WebGPUSync.create` accepts `{ context }` and reads `context._device`
    // internally, so this passes `this` and lets it resolve the device.
    // `options` is part of the abstract base signature and carries no
    // caller-provided fields on this backend.
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
      const submittedEncoder = this._currentCommandEncoder;
      try {
        // Coalesce any staged per-draw uniform uploads before this MID-FRAME
        // submit. Queue writes issued before submit are ordered before the
        // command buffer that consumes them — without this flush, draws already
        // encoded into this encoder would read stale ring-buffer bytes because
        // their staged writes would only land at endFrame's flush, AFTER this
        // submit. Mirrors the endFrame() flush.
        this._uniformAllocator?.flush();
        // This mid-frame submit executes draws already encoded into the frame
        // encoder, which may sample an imagery texture realized this frame whose
        // mip chain is still pending for `endFrame`. Flushing the pending mip
        // jobs first, as their own submit, orders mips before draws on the
        // queue.
        this.flushPendingTextureMipJobs();
        const commandBuffer = submittedEncoder.finish();
        this._device!.queue.submit([commandBuffer]);
        this._currentCommandEncoder = null;
        this._drainCommandEncoderSubmitCallbacks(submittedEncoder, true);
        // Create a fresh encoder for any subsequent operations this frame.
        this._currentCommandEncoder = this._device!.createCommandEncoder({
          label: "Post-Readback Command Encoder",
        });
      } catch (error) {
        // `finish`/`submit` failure abandons this exact segment. If continuation
        // encoder creation failed after submit, the true drain above already
        // removed the batch and this false drain is an idempotent no-op.
        this._currentCommandEncoder = null;
        this._drainCommandEncoderSubmitCallbacks(submittedEncoder, false);
        // No continuation encoder exists, so the rest of the logical frame is
        // abandoned even when the old segment had already submitted. Reject
        // frame-wide readbacks now rather than leaving them for an endFrame()
        // that will early-return on the null encoder.
        this._drainAfterFrameSubmitCallbacks(false);
        pbo.destroy();
        throw error;
      }
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
  // calling conventions. No override needed.

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
  // Reset in beginFrame() and for each standalone beginPickFrame(). If this
  // exceeds 50, something is re-entering clear recursively — log once and bail
  // to prevent the tab from freezing.
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

    // Infinite-loop guard, permanent rather than debug-only. A mis-ordered
    // guard elsewhere can make `clear()` run hundreds of times in one frame
    // and freeze the tab. One increment and one comparison catch that
    // immediately with a diagnosable error.
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
    // Guard against boolean `false` — callers pass { color: false } to mean "don't clear color".
    // The predicate lives in `WebGPUCanvasClearState` so the request
    // interpretation here and the canvas clear-state capture below cannot drift
    // apart.
    const wantColor = isClearChannelRequested(cmd.color);
    const wantDepth = isClearChannelRequested(cmd.depth);
    const wantStencil = isClearChannelRequested(cmd.stencil);
    if (!wantColor && !wantDepth && !wantStencil) {
      return;
    }

    // Scene-owned pass guard. It has to run before the pass is ended.
    //
    // While a scene-owned pass — the scene framebuffer pass or the default
    // canvas pass — is active, a ClearCommand must not tear it down and
    // replace it with a canvas-targeting clear pass. Those passes are opened
    // with the correct load ops, so the clear is redundant, and tearing down
    // the scene-FB pass mid-frame renders the scene all black.
    //
    // The guard reads the explicitly tracked pass target, which is nulled at
    // every `.end()` site. Inferring it from the pass label instead would put
    // the guard at the mercy of label spelling, and placing it after the
    // `.end()` would make it read null and never fire.
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

    // Canvas clear-state capture. WebGL's `Context.clear` records every
    // requested clear value into GL clear state — `gl.clearColor`,
    // `clearDepth`, `clearStencil` — before issuing `gl.clear`, so the state
    // outlives the call that set it. Without the same capture here,
    // `_clearColor` never moves off its constructor value of transparent
    // black, and every frame whose canvas is first opened by
    // `_beginDefaultRenderPass` — the `endFrame` present fallback, the lazy
    // `executeDrawCommand` open, `resumeDefaultRenderPass` — presents
    // transparent black regardless of `scene.backgroundColor`.
    //
    // A content-free frame is exactly that case:
    // `WebGPUSceneRenderer.executeCommands` early-returns when
    // `shouldExecuteWebGPUSceneFrame` is false, so the scene-framebuffer pass,
    // the only other consumer of `frameState.backgroundColor`, never opens and
    // the present fallback is the sole writer of the canvas.
    //
    // The per-channel, canvas-only shape is decided in
    // `WebGPUCanvasClearState` so it stays testable without a device. `null`
    // is that module's only "no change" sentinel, so these are `!== null`
    // tests rather than truthiness tests: a transparent-black capture and a
    // `depth: 0` capture are both real values.
    const clearStateUpdate = canvasClearStateUpdate(
      cmd,
      colorView === this._currentTextureView,
    );
    if (clearStateUpdate.color !== null) {
      Color.clone(clearStateUpdate.color as CesiumColor, this._clearColor);
    }
    if (clearStateUpdate.depth !== null) {
      this._clearDepth = clearStateUpdate.depth;
    }
    if (clearStateUpdate.stencil !== null) {
      this._clearStencil = clearStateUpdate.stencil;
    }

    // Deferred canvas clear. A default-framebuffer clear arriving while no
    // pass is active and the canvas is still untouched this frame — the
    // background `scene._clearColorCommand` on the deferred-open timeline — is
    // subsumed by the pending first-open clear, or by the `endFrame` present
    // fallback, which delivers the same `_clearColor`, `_clearDepth` and
    // `_clearStencil` values. The capture block above is what makes "the same
    // values" true for colour; without it this deferral substitutes
    // transparent black for the scene background on every content-free frame.
    if (
      !hadActivePass &&
      colorView === this._currentTextureView &&
      !this._canvasColorTouchedThisFrame &&
      !this._canvasDepthTouchedThisFrame
    ) {
      return;
    }

    // When this clear pass attaches the context (canvas) depth texture and
    // that texture is untouched this frame, a "load" op reads WebGPU's lazy
    // zero, 0.0, rather than the 1.0 a clear writes. Force a clear to the
    // default values instead.
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
    // The browser handles canvas resizing; only the configuration needs
    // reapplying. Routing through `_applyCanvasConfig` is what makes the HDR
    // mode survive a resize, and what degrades a browser without extended
    // toneMapping support to rgba16float-only or SDR.
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
   * A WebGPU draw command arriving with no active pass during a render frame
   * — the overlay commands from `Scene._overlayCommandList`, executed after
   * post-process — lazily opens the default canvas pass here, since the
   * post-process tail resume is demand-driven and no longer re-opens it
   * unconditionally. Same target and same load ops: the post-process blit has
   * already marked the canvas written. A pick mini-frame, where
   * `_currentTextureView === null`, keeps the silent skip.
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
    computeCommandList: unknown[],
    _sunComputeCommand: unknown,
    _computeEngine: unknown,
  ): void {
    const commands: WebGPUComputeCommand[] = [];
    for (let i = 0; i < computeCommandList.length; ++i) {
      const cmd = computeCommandList[i] as CesiumComputeCommand | null;
      if (cmd?.isWebGPUComputeCommand === true) {
        commands.push(cmd as unknown as WebGPUComputeCommand);
      }
    }

    if (commands.length === 0) {
      return;
    }

    const cancelCommand = (command: WebGPUComputeCommand): void => {
      try {
        command.cancel();
      } catch {
        // One user callback must not strand the remaining queued commands.
      }
    };

    const encoder = this._currentCommandEncoder;
    const computeEngine = this.computeEngine;
    if (!encoder || !computeEngine) {
      for (const command of commands) {
        cancelCommand(command);
      }
      return;
    }

    try {
      // Compute and render passes cannot overlap on one command encoder. The
      // normal scene path is demand-deferred and usually has no active pass at
      // this point, but pick/custom framebuffer paths may legitimately do so.
      this.endCurrentRenderPass();
    } catch (error) {
      for (const command of commands) {
        cancelCommand(command);
      }
      throw error;
    }

    for (const command of commands) {
      let settled = false;
      let encodingFinished = false;
      let encodingFailed = false;
      let pendingDisposition: boolean | undefined;

      const settle = (submitted: boolean): void => {
        if (settled) {
          return;
        }

        pendingDisposition = submitted;
        if (!encodingFinished) {
          // Abandonment may happen re-entrantly inside preExecute (for example
          // a device-loss/destroy callback). Cancel immediately, then let the
          // engine's ownership predicate refuse to touch the dead encoder.
          if (!submitted) {
            settled = true;
            cancelCommand(command);
          }
          return;
        }

        settled = true;
        try {
          if (!encodingFailed && submitted) {
            command.postExecute?.();
          } else {
            command.cancel();
          }
        } catch {
          // The exact-encoder callback drain isolates callbacks too, but keep
          // immediate failure paths equally fail-safe.
        }
      };

      // Enlist before preparation/encoding. preExecute is user code and can
      // re-enter context teardown or device-loss handling; the command must
      // already belong to this exact encoder segment when that happens.
      if (!this.enqueueAfterCommandEncoderSubmit(encoder, settle)) {
        encodingFinished = true;
        encodingFailed = true;
        settle(false);
        continue;
      }

      const encoded = computeEngine.executeOnEncoder(
        encoder,
        command,
        () =>
          !settled &&
          pendingDisposition === undefined &&
          this._currentCommandEncoder === encoder &&
          !this._isDeviceUnavailable,
      );
      encodingFinished = true;
      encodingFailed = !encoded;

      if (!encoded) {
        settle(false);
      } else if (pendingDisposition !== undefined) {
        // Handles a re-entrant submit during preparation. A successful encode
        // normally cannot reach this branch because the predicate above
        // rejects any encoder whose disposition is already known.
        settle(pendingDisposition);
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
    // Honour `viewer.shadows = false` and the scene-wide shadow gate.
    // WebGL's per-command check in Scene.js,
    // `shadowsEnabled && command.castShadows`, skips the whole cast
    // derivation when the flag is off; testing it at the pass entry here
    // avoids iterating shadowMaps for nothing and avoids the GPU cost of a
    // depth-only pass when shadows are globally disabled.
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
        // Clamp the split distribution to the
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
            // The context is passed so the CSM cast helper can look up
            // per-cascade culler instances and read `gpuCullingHint` for the
            // `'never'` short-circuit.
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
      scene.debugSkipDepthPlane !== true &&
      scene._globeTranslucencyState.useDepthPlane;

    // On for WebGPU whenever not picking, so the globe-depth-framebuffer path
    // runs. This matches `FramebufferOrchestrator.js`, which sets the flag to
    // `defined(view.globeDepth)` on the WebGL side. The effect is that
    // `WebGPUSceneRenderer` instantiates `_globeDepth`, the post-tile
    // depth-copy hook fires and writes a sampleable packed depth texture, and
    // `pickPosition` reads that texture to translate a screen-space pick into
    // world coordinates. Both sample counts are wired — the MSAA variant
    // samples through `texture_depth_multisampled_2d` and `textureLoad` at
    // sample index 0 — so the flag needs no MSAA gate.
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

    // Compute the one canonical attachment-demand record for this frame,
    // before any scene pass opens or any pipeline builds. The record is
    // observe-only: it is frozen on the context and reported through the debug
    // snapshot, and nothing in the render path gates on it. `forceSceneMRT`
    // defaults true, so `topology` is `"mrt"` every frame. Reset the per-frame
    // actual counters here so the snapshot reflects only this frame.
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

    // G-buffer allocation, mirroring the gating block in
    // `FramebufferOrchestrator.js`, which does not run on WebGPU because this
    // context overrides `updateAndClearFramebuffers` to return `true` and skip
    // the rest of the orchestrator. Without this block the
    // `useDeferredLighting` flag has no effect on WebGPU: the framebuffer
    // never allocates and the producer dispatcher early-outs on a null
    // `outputView`. `Scene._view` is a JS module with no ambient type, so this
    // structurally unpacks just the slots the block needs.
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
    // `useDeferredLighting` is a consumer flag: it controls whether AO, SSR
    // and clustered lighting read G-buffer normals or fall back to
    // depth-derived ones. The G-buffer texture itself is allocated
    // unconditionally so the MRT render pass can bind it as a slot-1 colour
    // attachment every frame without consulting the consumer flag. The cost is
    // one single-sample rgba16float texture, about 16 MB at 1080p, plus an
    // MSAA companion when `scene.msaaSamples > 1`.
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
      // Use the effective sample count, `this._msaaSamples`, written by
      // `WebGPUSceneRenderer.prepareFrame` and forced to 1 while TAA is on —
      // not the raw user `scene.msaaSamples`. Reading the user setting here
      // keeps the G-buffer's 4x MSAA companion bound as
      // `colorAttachments[1]` on the first TAA-enabled frame while every other
      // attachment drops to single-sample, and the resulting sample-count
      // mismatch kills the whole scene pass for as long as TAA stays on.
      view.gBufferFramebuffer.update(
        this,
        view.viewport,
        sceneExt._hdr,
        this._msaaSamples ?? 1,
      );
      view.gBufferFramebuffer.clear(this, passState);

      // Record the actual G-buffer byte cost this frame so the debug snapshot
      // can assert the demand record matches reality. rgba16float is 8 bytes
      // per texel, and the MSAA companion multiplies by the effective sample
      // count. This re-reads the dimensions and sample count `update()` just
      // committed.
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

    // Drive the PostProcessStageCollection sync. The WebGL
    // orchestrator in `FramebufferOrchestrator.js` calls
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

  /**
   * WebGPU override: create the RGBA32F snap framebuffer behind `Scene.snap`.
   * `Snapping.js` calls this factory rather than importing the WebGPU class
   * directly, so scene code stays backend-agnostic.
   *
   * Constructing this object latches the `_snapEnabled` ever-used diagnostic.
   * The model renderer emits derived draws only while the current mini-frame's
   * `passes.snap` flag is true, so ordinary frames remain allocation-free even
   * after snapping has been used.
   */
  override createSnapFramebuffer(): WebGPUSnapFramebuffer {
    return new WebGPUSnapFramebuffer(this);
  }

  /**
   * True once a `WebGPUSnapFramebuffer` has been
   * constructed against this context. This is an ever-used diagnostic latch,
   * not an ordinary-frame command-demand signal; current demand comes from
   * `frameState.passes.snap`.
   */
  _snapEnabled: boolean = false;

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

    let firstFinalCleanupError: unknown;
    let hasFinalCleanupError = false;
    const continueFinalCleanupAfter = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        if (!hasFinalCleanupError) {
          firstFinalCleanupError = error;
          hasFinalCleanupError = true;
        }
      }
    };

    // Destruction is an irreversible terminal transition. Detach accepted but
    // unsubmitted mip work and publish the logical destroyed state before any
    // foreign/native cleanup can throw. This also makes a re-entrant destroy()
    // a no-op while the first call continues its best-effort drain.
    this._pendingTextureMipJobs.length = 0;
    this._pendingTextureMipJobKeys = new WeakMap();
    this._isDestroyed = true;

    // Reject readbacks that recorded a copy into the current frame
    // but were waiting for endFrame() to submit it. Context teardown can occur
    // before endFrame (and a pooled GPUDevice may remain alive), so leaving the
    // callbacks queued would strand their promises and retain feature buffers.
    // Abandon the unfinished encoder before destroying those feature owners.
    continueFinalCleanupAfter(() =>
      this._drainAfterCommandEncoderSubmitCallbacks(false),
    );
    continueFinalCleanupAfter(() =>
      this._drainAfterFrameSubmitCallbacks(false),
    );
    this._currentRenderPassEncoder = null;
    this._activePassTarget = null;
    this._currentCommandEncoder = null;

    // Unregister from the global ContextRegistry before destroying resources
    continueFinalCleanupAfter(() => this._unregisterFromRegistry());
    continueFinalCleanupAfter(() => this._destroyFeatureRenderers());

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

    // Destroy every subsystem that owns GPU resources before destroying the
    // device. Each `destroy()` below calls `.destroy()` on its own buffers,
    // textures and query sets, and those calls require a live device. Running
    // this block after `_device.destroy()` instead makes the GPU validator
    // flag teardown as an error and
    // leaked transient buffer contents on long-lived multi-viewer apps.

    // Destroy viewport quad utility
    const viewportQuad = this._viewportQuad;
    this._viewportQuad = null;
    continueFinalCleanupAfter(() => viewportQuad?.destroy());

    // Destroy mipmap generator
    const mipmapGenerator = this._mipmapGenerator;
    this._mipmapGenerator = null;
    continueFinalCleanupAfter(() => mipmapGenerator?.destroy());

    // Destroy advanced infrastructure singletons
    const performanceManager = this._performanceManager;
    this._performanceManager = null;
    this._performanceManagerConfig = null;
    continueFinalCleanupAfter(() => performanceManager?.destroy());
    const renderBundleManager = this._renderBundleManager;
    this._renderBundleManager = null;
    continueFinalCleanupAfter(() => renderBundleManager?.destroy());
    const timestampProfiler = this._timestampProfiler;
    this._timestampProfiler = null;
    continueFinalCleanupAfter(() => timestampProfiler?.destroy());
    const storageBufferPool = this._storageBufferPool;
    this._storageBufferPool = null;
    continueFinalCleanupAfter(() => storageBufferPool?.destroy());
    const indirectDrawManager = this._indirectDrawManager;
    this._indirectDrawManager = null;
    continueFinalCleanupAfter(() => indirectDrawManager?.destroy());
    const gpuCuller = this._gpuCuller;
    this._gpuCuller = null;
    continueFinalCleanupAfter(() => gpuCuller?.destroy());
    // Destroy the auxiliary culler instances — translucent, per-opaque-frustum
    // and per-cascade. Without this they leak on context destruction: at peak,
    // one translucent plus three per-frustum plus four per-cascade, roughly
    // 4 MB of orphaned VRAM per leaked context.
    const translucentCuller = this._gpuCullerTranslucent;
    this._gpuCullerTranslucent = null;
    continueFinalCleanupAfter(() => translucentCuller?.destroy());
    const frustumCullers = Array.from(this._gpuCullerByFrustum.values());
    this._gpuCullerByFrustum.clear();
    this._gpuCullerByFrustumInitializing.clear();
    for (const culler of frustumCullers) {
      continueFinalCleanupAfter(() => culler.destroy());
    }
    const cascadeCullers = Array.from(this._gpuCullerByCascade.values());
    this._gpuCullerByCascade.clear();
    this._gpuCullerByCascadeInitializing.clear();
    for (const culler of cascadeCullers) {
      continueFinalCleanupAfter(() => culler.destroy());
    }
    const pointCloudLOD = this._detachPointCloudLOD();
    continueFinalCleanupAfter(() => pointCloudLOD?.destroy());
    const csmRenderer = this._csmRenderer;
    this._csmRenderer = null;
    continueFinalCleanupAfter(() => csmRenderer?.destroy());
    const bufferMapper = this._bufferMapper;
    this._bufferMapper = null;
    continueFinalCleanupAfter(() => bufferMapper?.destroy());
    // The model arena's bind groups reference this context's ring pages. Drop
    // those references before destroying the allocator, and detach both
    // logical owners before invoking native cleanup so a throw cannot strand
    // a pooled lease or isolated GPUDevice.
    const modelCameraArena = this._modelCameraArena;
    this._modelCameraArena = null;
    continueFinalCleanupAfter(() => modelCameraArena?.invalidate());
    const uniformAllocator = this._uniformAllocator;
    this._uniformAllocator = null;
    continueFinalCleanupAfter(() => uniformAllocator?.destroy());

    // Context-owned textures/caches must be released explicitly because a
    // pooled GPUDevice may outlive this context (including failed creates).
    continueFinalCleanupAfter(() =>
      destroyEnvironmentalEffectsCompositor(this),
    );
    const depthTexture = this._depthTexture;
    this._depthTexture = null;
    this._depthTextureView = null;
    this._depthOnlyTextureView = null;
    continueFinalCleanupAfter(() => depthTexture?.destroy());
    const defaultTexture = this._defaultTexture;
    this._defaultTexture = undefined;
    continueFinalCleanupAfter(() => defaultTexture?.destroy());
    const defaultEmissiveTexture = this._defaultEmissiveTexture;
    this._defaultEmissiveTexture = undefined;
    continueFinalCleanupAfter(() => defaultEmissiveTexture?.destroy());
    const defaultNormalTexture = this._defaultNormalTexture;
    this._defaultNormalTexture = undefined;
    continueFinalCleanupAfter(() => defaultNormalTexture?.destroy());
    const defaultCubeMap = this._defaultCubeMap;
    this._defaultCubeMap = undefined;
    continueFinalCleanupAfter(() => defaultCubeMap?.destroy());
    const pendingTextureDestroys = this._pendingTextureDestroys;
    this._pendingTextureDestroys = [];
    for (const texture of pendingTextureDestroys) {
      continueFinalCleanupAfter(() => texture.destroy());
    }
    continueFinalCleanupAfter(() =>
      this._environmentDemandRegistry.reset(this._deviceResourceGeneration),
    );
    continueFinalCleanupAfter(() =>
      this._environmentRefreshCoordinator.reset(this._deviceResourceGeneration),
    );
    continueFinalCleanupAfter(() =>
      this._environmentRefreshScheduler.reset(this._deviceResourceGeneration),
    );
    const environmentTargetPool = this._environmentTargetPool;
    this._environmentTargetPool = null;
    continueFinalCleanupAfter(() => environmentTargetPool?.destroy());

    continueFinalCleanupAfter(() => this._shaderCache.destroy());
    const textureCache = this._textureCache as { destroy?: () => void };
    continueFinalCleanupAfter(() => textureCache.destroy?.());

    const asyncResourceTelemetry = this._asyncResourceTelemetry;
    this._asyncResourceTelemetry = null;
    continueFinalCleanupAfter(() => asyncResourceTelemetry?.destroy());
    const asyncResources = this._asyncResources;
    this._asyncResources = null;
    continueFinalCleanupAfter(() => asyncResources?.reset("context-destroyed"));
    continueFinalCleanupAfter(() => this.clearAllHDRFallbackListeners());

    // Clear buffer pools (drops device-owned buffers back for GC).
    continueFinalCleanupAfter(() => this._bufferPool.clear());
    this._uniformBufferPool = [];

    // Clear caches that reference device-owned handles.
    continueFinalCleanupAfter(() => this._samplerCache.clear());
    continueFinalCleanupAfter(() => this._bindGroupLayoutCache.clear());
    continueFinalCleanupAfter(() => this._bindGroupCache.clear());

    // Drop device-invalidation subscribers so their closures release
    // immediately even if a long-lived holder keeps this Context
    // reference alive, rather than relying on GC.
    continueFinalCleanupAfter(() => this._deviceInvalidationBus.clear());

    // Drop the resource-cache registry's registered closures so they
    // don't keep this Context's own fields alive past destroy.
    continueFinalCleanupAfter(() => this._cacheRegistry.clear());

    // Drop the feature-flags enabled set. The Set is small and would die with
    // the Context anyway; clearing it explicitly matches the lifecycle pattern
    // the bus and the cache registry use.
    continueFinalCleanupAfter(() => this._featureFlags.clear());

    // Remove this context's lease from the device-level shader validation
    // wrapper. The last lease restores the device's original method, so a
    // failed create cannot leave a closure rooted in a shared pooled device.
    continueFinalCleanupAfter(() => this._releaseShaderValidation?.());

    // Compatibility resources are context-owned even when the physical device
    // is pooled. Drain every registered handle before releasing this context's
    // device lease; another context retaining the same GPUDevice remains
    // independent.
    continueFinalCleanupAfter(() =>
      this._gl.destroyCompatibilityTextureHandles(),
    );
    continueFinalCleanupAfter(() =>
      this._gl.destroyCompatibilityBufferHandles(),
    );

    // Release this context's lease on device-level effects resources before
    // returning a pooled device. The final context owner drains buffers and
    // placeholder textures; earlier owners leave the shared cache intact.
    if (this._device) {
      continueFinalCleanupAfter(() =>
        releaseEffectsPlaceholderCacheForContext(this._device!, this),
      );
    }

    // Stop presenting from this canvas before releasing the device lease. The
    // final pooled owner destroys the GPUDevice synchronously, so unconfiguring
    // afterwards would leave presentation teardown racing a dead device.
    continueFinalCleanupAfter(() => this._context?.unconfigure());

    // NOW destroy the device — everything that needed it has already run.
    // When the device came from the pool, release the reference so the
    // refcount drops; the pool destroys
    // the underlying GPUDevice only when the last context releases it.
    // When the device was supplied externally (e.g., legacy direct
    // injection or the recovery path before it switches to the pool),
    // call `destroy()` directly because no pool refcount exists for it.
    if (this._device) {
      const device = this._device;
      const deviceFromPool = this._deviceFromPool;
      const terminallyLost = this._isTerminallyLost;
      this._device = null;
      this._deviceFromPool = false;
      continueFinalCleanupAfter(() => {
        if (deviceFromPool) {
          WebGPUDevicePool.instance.releaseDevice(device);
        } else if (!terminallyLost) {
          device.destroy();
        }
      });
      // A terminally-lost isolated device was already destroyed by the
      // browser (or explicitly by the caller). Do not issue a second destroy;
      // some implementations reject it during loss teardown.
    }

    // Clear references
    this._adapter = null;
    this._context = null;
    this._isTerminallyLost = false;
    // `_isDestroyed` was published before cleanup began so any early native
    // failure could not leave a logically live context.

    if (hasFinalCleanupError) {
      throw firstFinalCleanupError;
    }
  }

  // ====================================================================================
  // WebGL to WebGPU State Conversion Helpers
  // Delegates to standalone functions in WebGLStateConverters.ts
  // ====================================================================================

  // There are no `_webglToWebGPU*` conversion wrappers on this class: the
  // WebGL-stub state literal in `WebGPUContextWebGLStubInit.ts` points
  // straight at the module-level functions in `WebGLStateConverters.ts`.

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
  ): boolean {
    if (this._isDeviceUnavailable) {
      //>>includeStart('debug', pragmas.debug);
      throw new DeveloperError(
        this._isDestroyed
          ? "Context has been destroyed."
          : "Context's WebGPU device is terminally lost.",
      );
      //>>includeEnd('debug');
      return false;
    }
    //>>includeStart('debug', pragmas.debug);
    if (!this._currentCommandEncoder) {
      throw new DeveloperError(
        "No active command encoder. Call beginFrame() first.",
      );
    }
    //>>includeEnd('debug');
    if (!this._currentCommandEncoder) {
      return false;
    }

    // Texture copies are encoder commands and cannot be recorded while a
    // render pass is open. This bounded compatibility path must not silently
    // split a scene pass: callers that need that broader conversion must route
    // through the resource-command scheduler. Fail closed until then.
    if (this._currentRenderPassEncoder) {
      return false;
    }
    const sourceUsage = source.usage;
    const destinationUsage = destination.usage;
    if (
      (sourceUsage & GPUTextureUsage.COPY_SRC) === 0 ||
      (destinationUsage & GPUTextureUsage.COPY_DST) === 0
    ) {
      return false;
    }
    const sourceFormat = source.format;
    const destinationFormat = destination.format;
    const srgbPair =
      (sourceFormat === "rgba8unorm" &&
        destinationFormat === "rgba8unorm-srgb") ||
      (sourceFormat === "rgba8unorm-srgb" &&
        destinationFormat === "rgba8unorm") ||
      (sourceFormat === "bgra8unorm" &&
        destinationFormat === "bgra8unorm-srgb") ||
      (sourceFormat === "bgra8unorm-srgb" &&
        destinationFormat === "bgra8unorm");
    if (sourceFormat !== destinationFormat && !srgbPair) {
      return false;
    }
    // Block-compressed edge alignment needs richer descriptors than this API
    // carries (and compatibility devices prohibit those copies entirely).
    // Reject it instead of recording a command that can invalidate the entire
    // eventual scene submission. Same-format depth/stencil copies using the
    // default `aspect: "all"` remain valid and are intentionally preserved.
    const requiresExtendedCopyValidation = (
      format: GPUTextureFormat,
    ): boolean =>
      format.startsWith("bc") ||
      format.startsWith("etc2") ||
      format.startsWith("eac") ||
      format.startsWith("astc");
    if (
      requiresExtendedCopyValidation(sourceFormat) ||
      requiresExtendedCopyValidation(destinationFormat)
    ) {
      return false;
    }
    if (source.sampleCount !== 1 || destination.sampleCount !== 1) {
      return false;
    }

    const readOrigin = (
      origin: GPUOrigin3D | undefined,
    ): { x: number; y: number; z: number } | undefined => {
      if (!origin) {
        return { x: 0, y: 0, z: 0 };
      }
      const sequence = Array.isArray(origin) ? origin : undefined;
      const record = origin as GPUOrigin3DDict;
      const normalized = {
        x: sequence?.[0] ?? record.x ?? 0,
        y: sequence?.[1] ?? record.y ?? 0,
        z: sequence?.[2] ?? record.z ?? 0,
      };
      return Number.isInteger(normalized.x) &&
        Number.isInteger(normalized.y) &&
        Number.isInteger(normalized.z) &&
        normalized.x >= 0 &&
        normalized.y >= 0 &&
        normalized.z >= 0
        ? normalized
        : undefined;
    };
    const readExtent = (
      extent: GPUExtent3D | undefined,
    ):
      | { width: number; height: number; depthOrArrayLayers: number }
      | undefined => {
      if (!extent) {
        return {
          width: source.width,
          height: source.height,
          depthOrArrayLayers: 1,
        };
      }
      const sequence = Array.isArray(extent) ? extent : undefined;
      const record = extent as GPUExtent3DDict;
      const normalized = {
        width: sequence?.[0] ?? record.width,
        height: sequence?.[1] ?? record.height ?? 1,
        depthOrArrayLayers: sequence?.[2] ?? record.depthOrArrayLayers ?? 1,
      };
      return Number.isInteger(normalized.width) &&
        Number.isInteger(normalized.height) &&
        Number.isInteger(normalized.depthOrArrayLayers) &&
        normalized.width > 0 &&
        normalized.height > 0 &&
        normalized.depthOrArrayLayers > 0
        ? normalized
        : undefined;
    };

    const srcOrigin = readOrigin(sourceOrigin);
    const dstOrigin = readOrigin(destinationOrigin);
    const size = readExtent(copySize);
    if (!srcOrigin || !dstOrigin || !size) {
      return false;
    }
    const dimensions = [
      source.width,
      source.height,
      source.depthOrArrayLayers,
      destination.width,
      destination.height,
      destination.depthOrArrayLayers,
    ];
    if (
      !dimensions.every(
        (dimension) => Number.isInteger(dimension) && dimension > 0,
      )
    ) {
      return false;
    }
    if (
      srcOrigin.x + size.width > source.width ||
      srcOrigin.y + size.height > source.height ||
      srcOrigin.z + size.depthOrArrayLayers > source.depthOrArrayLayers ||
      dstOrigin.x + size.width > destination.width ||
      dstOrigin.y + size.height > destination.height ||
      dstOrigin.z + size.depthOrArrayLayers > destination.depthOrArrayLayers
    ) {
      return false;
    }
    if (source === destination) {
      // Copy validation is defined over subresource sets, not intersecting
      // pixel rectangles. At mip 0/all-aspect, distinct 2D array layers are
      // the only same-texture case this API can prove disjoint. A 1D/3D copy
      // remains within one mip subresource even when its coordinates differ.
      const layerRangesOverlap =
        srcOrigin.z < dstOrigin.z + size.depthOrArrayLayers &&
        dstOrigin.z < srcOrigin.z + size.depthOrArrayLayers;
      if (source.dimension !== "2d" || layerRangesOverlap) {
        return false;
      }
    }

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
    return true;
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
  ): boolean {
    return this.copyTexture(
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
    if (!supportsExternalImageCopyDestination(this._device, format)) {
      return null;
    }

    const width =
      "width" in source ? source.width : (source as HTMLCanvasElement).width;
    const height =
      "height" in source ? source.height : (source as HTMLCanvasElement).height;
    const canGenerateMipmaps =
      generateMipmaps && supportsWebGPUMipmapGeneration(this._device, format);
    const mipLevelCount = canGenerateMipmaps
      ? Math.floor(Math.log2(Math.max(width, height))) + 1
      : 1;

    const device = this._device;
    const resourceGeneration = this._deviceResourceGeneration;
    const texture = WebGPUTexture.create2D(
      device,
      width,
      height,
      format,
      mipLevelCount,
      "Texture from Image",
      GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    );
    texture.setBeforeDestroyCallback((candidate) =>
      this.cancelTextureMipGeneration(candidate),
    );

    try {
      device.queue.copyExternalImageToTexture(
        { source: source as ImageBitmap },
        { texture: texture.texture },
        { width, height },
      );

      // The upload and mip job must stay on the same physical ownership tuple.
      if (
        this._device !== device ||
        this._deviceResourceGeneration !== resourceGeneration ||
        this._isDeviceUnavailable
      ) {
        texture.destroy();
        return null;
      }
      if (
        canGenerateMipmaps &&
        mipLevelCount > 1 &&
        !this.enqueueTextureMipGeneration(
          texture.texture,
          format,
          mipLevelCount,
        )
      ) {
        texture.destroy();
        return null;
      }
      return texture;
    } catch (error) {
      try {
        texture.destroy();
      } catch {
        // Preserve the upload/publication error; retirement is cleanup-only.
      }
      throw error;
    }
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
    if (!supportsExternalImageCopyDestination(this._device, format)) {
      return null;
    }

    const { WebGPUImageUpload } = await import("./WebGPUImageUpload.js");
    // Pass the monitor so the bitmap decode publishes a wakeup event when it
    // lands. Without
    // this, an environment-map decode that finishes after the scene
    // hibernates leaves the canvas frozen with the missing texture.
    const decoded = await WebGPUImageUpload.decodeWithOrientation(
      source,
      this.asyncResources,
      "Texture from Image (async)",
    );
    const ownedDecodedSurface =
      decoded !== source && "close" in decoded
        ? (decoded as ImageBitmap)
        : null;

    try {
      // Decoding can outlive a terminal loss. Do not allocate or upload through
      // the retained dead device during the short interval before teardown.
      if (this._isDeviceUnavailable || !this._device) {
        return null;
      }

      // After EXIF rotation the bitmap dimensions can be swapped (90°/270°), so
      // pull width/height from the decoded surface, not the original source.
      const width = (decoded as { width: number }).width;
      const height = (decoded as { height: number }).height;
      const canGenerateMipmaps =
        generateMipmaps && supportsWebGPUMipmapGeneration(this._device, format);
      const mipLevelCount = canGenerateMipmaps
        ? Math.floor(Math.log2(Math.max(width, height))) + 1
        : 1;

      const device = this._device;
      const resourceGeneration = this._deviceResourceGeneration;
      const texture = WebGPUTexture.create2D(
        device,
        width,
        height,
        format,
        mipLevelCount,
        "Texture from Image (async)",
        GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_DST |
          GPUTextureUsage.RENDER_ATTACHMENT,
      );
      texture.setBeforeDestroyCallback((candidate) =>
        this.cancelTextureMipGeneration(candidate),
      );

      try {
        await WebGPUImageUpload.uploadImageToTexture(
          device,
          decoded,
          texture.texture,
          {
            respectEXIF: false, // already decoded above
            flipY: options.flipY,
            premultipliedAlpha: options.premultipliedAlpha,
          },
        );

        if (
          this._device !== device ||
          this._deviceResourceGeneration !== resourceGeneration ||
          this._isDeviceUnavailable
        ) {
          texture.destroy();
          return null;
        }
        if (
          canGenerateMipmaps &&
          mipLevelCount > 1 &&
          !this.enqueueTextureMipGeneration(
            texture.texture,
            format,
            mipLevelCount,
          )
        ) {
          texture.destroy();
          return null;
        }
        return texture;
      } catch (error) {
        try {
          texture.destroy();
        } catch {
          // Preserve the upload/publication error; retirement is cleanup-only.
        }
        throw error;
      }
    } finally {
      if (ownedDecodedSurface) {
        try {
          ownedDecodedSurface.close();
        } catch {
          // Decode surfaces are temporary cleanup; preserve upload outcomes.
        }
      }
    }
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
    }
    return this._mipmapGenerator!;
  }

  // ====================================================================================
  // Advanced Infrastructure — Lazy-Initialized Singletons
  // These are exposed via getters and created on first access.
  // ====================================================================================

  private _renderBundleManager: WebGPURenderBundleManager | null = null;
  // Private runtime factory/debug seam used by deterministic integration
  // probes and legacy PerformanceManager wiring. Keeping it context-local
  // avoids promoting the native command class to the public engine barrel.
  readonly _computeCommandClass = WebGPUComputeCommand;
  // General-purpose compute dispatch engine. Lazily initialized via the
  // `computeEngine` getter so a context that never runs compute pays nothing,
  // and dropped on device loss because it caches GPUComputePipelines. Mirrors
  // `_renderBundleManager`.
  private _computeEngine: WebGPUComputeEngine | null = null;
  private _timestampProfiler: WebGPUTimestampProfiler | null = null;
  private _storageBufferPool: WebGPUStorageBufferPool | null = null;
  private _indirectDrawManager: WebGPUIndirectDrawManager | null = null;
  private _bufferMapper: WebGPUBufferMapper | null = null;
  private _performanceManager: WebGPUPerformanceManager | null = null;
  private _performanceManagerConfig: PerformanceConfig | null = null;
  // Mutable bind-group state is context-owned because every cached
  // group references pages from this context's uniform allocator. Immutable
  // cameraBGL remains shared through WebGPUModelDeviceResources.
  private _modelCameraArena: WebGPUModelCameraArena | null = null;
  private _uniformAllocator: WebGPURingBufferAllocator | null = null;
  // The defensive cap on auxiliary culler allocation lives in
  // `WebGPUContextCullerPool.ts` as `MAX_AUX_CULLER_INDEX`, with the
  // culler-pool free functions that enforce it.

  // Scene-level GPU culling hint, mirrored on the context so the lazy
  // aux-culler getters can refuse allocation when
  // `Scene.gpuCullingHint = 'never'`. Storing it only on Scene leaves the
  // allocation path unaware of the opt-out, and any code path that reaches a
  // gate-active branch then burns VRAM anyway.
  // Public-underscore: read and written by the culler-pool helpers
  // (`WebGPUContextCullerPool.ts`) and `setGpuCullingHint`.
  public _gpuCullingHint: "auto" | "always" | "never" = "never";

  // Track when each auxiliary culler instance was last used, so cullers idle
  // for at least `IDLE_DECAY_FRAMES` can be reaped periodically. The
  // `destroy()` walk covers context teardown, but a long-running session that
  // moves from high density to low density and stays there would otherwise
  // hold the auxiliary cullers forever — about 1 MB per instance across up to
  // eight instances. The decay reaps them and the lazy getters reallocate on
  // demand if usage returns. The internal frame id is bumped from
  // `beginFrame()`, so the comparison is purely against this context's
  // lifetime.
  // `IDLE_DECAY_FRAMES` lives in `WebGPUContextCullerPool.ts` with the reaper
  // that applies it. `IDLE_DECAY_CHECK_INTERVAL` stays here because it drives
  // the `beginFrame()` cadence that calls the reaper.
  private static readonly IDLE_DECAY_CHECK_INTERVAL = 120; // 2s
  // Public-underscore: the culler-pool helpers read/write these.
  public _internalFrameId: number = 0;
  public _gpuCullerLastUsed: number = 0;
  public _gpuCullerTranslucentLastUsed: number = 0;
  public _gpuCullerByFrustumLastUsed: Map<number, number> = new Map();
  public _gpuCullerByCascadeLastUsed: Map<number, number> = new Map();

  public _gpuCuller: GPUCullerInstance | null = null;
  public _gpuCullerInitializing: boolean = false;
  // A separate culler instance for the translucent pass. The dispatcher reuses
  // one staging buffer, `_readbackBuffer`, so if opaque and translucent both
  // `prepareReadback` against the same instance in one encoder the second copy
  // clobbers the first and corrupts the opaque readback. A second instance
  // gives translucent its own buffers.
  public _gpuCullerTranslucent: GPUCullerInstance | null = null;
  public _gpuCullerTranslucentInitializing: boolean = false;
  // Per-frustum culler instances for the opaque pass, for the same reason as
  // the translucent instance above: the shared `_visibilityBuffer` and
  // `_readbackBuffer` get clobbered when several frustums call
  // `prepareReadback` in one encoder. Frustum 0 reuses `_gpuCuller`, so a
  // single-frustum scene pays no extra VRAM; frustums 1..N get their own
  // instances on first use. A typical scene has one to four frustums, so at
  // most three extra instances, around 1.5 MB of VRAM.
  public _gpuCullerByFrustum: Map<number, GPUCullerInstance> = new Map();
  public _gpuCullerByFrustumInitializing: Set<number> = new Set();
  // Per-cascade culler instances for the CSM shadow cast, on the same pattern:
  // each cascade needs its own staging buffer to avoid colliding in the
  // encoder.
  public _gpuCullerByCascade: Map<number, GPUCullerInstance> = new Map();
  public _gpuCullerByCascadeInitializing: Set<number> = new Set();
  private _pointCloudLOD: WebGPUPointCloudLODProcessorInstance | null = null;
  private _pointCloudLODInitializing: boolean = false;
  private _pointCloudLODInitializationToken: number = 0;
  private _pointCloudLODInitializationError: unknown = null;
  private _pointCloudLODInitializationErrorReported: boolean = false;
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
   * Context-local model camera/light bind-group arena. Kept beside the uniform
   * allocator because its cached groups reference that allocator's pages.
   * Multiple contexts may share a GPUDevice and immutable model layouts, but
   * they must never share this mutable page-identity cache.
   */
  get modelCameraArena(): WebGPUModelCameraArena | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._modelCameraArena && this._device) {
      this._modelCameraArena = new WebGPUModelCameraArena();
    }
    return this._modelCameraArena;
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
        this._performanceManagerConfig ?? undefined,
      );
      this._performanceManagerConfig = null;
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
      // Bundles hold references to pipelines and buffers that are invalid
      // after device loss. Drop them.
      this.onDeviceInvalidated(() => {
        this._renderBundleManager = null;
      });
    }
    return this._renderBundleManager;
  }

  /**
   * General-purpose WebGPU compute engine. Every
   * `WebGPUPerformanceManager.dispatchCompute()` caller — the atmosphere LUT
   * bake, frustum cull, point-cloud sort and LOD, GPU sort keys, Hi-Z,
   * normal-from-depth, polygon SDF — resolves its engine through here, and
   * returns early as a silent no-op if this is `undefined`. Lazily initialized
   * on first access once the device exists, and `null` during early bring-up.
   * Wired to the per-context central compute-pipeline cache, which dedupes
   * across instances for layout-explicit callers, and to the async-resource
   * monitor on the `createPipelineAsync` path. Dropped on device loss: it
   * caches GPUComputePipelines that a recreated device invalidates.
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
   * Attachment-demand debug surface. Returns the frozen
   * per-frame demand record — the registry's prediction — alongside the
   * measured scene-FB attachment behavior this frame, so callers can
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
    // The attachment-count comparison above is near-tautological with the
    // demand flag the record was derived from. Folding in the independently
    // measured slot-1 open counter means a non-pick frame only matches when
    // the predicted MRT topology coincides with slot-1 attachments having
    // actually opened this frame.
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
   * Demand registration seam used by backend-neutral Scene producers.
   * Demand may reorder bounded refresh work, but never drops it; unknown stays
   * conservative.
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
   * Open Scene's primitive-collection phase for dynamic-environment updates.
   * WebGL has no corresponding hook; ViewportExecutor calls this optionally.
   */
  beginEnvironmentMapUpdateCollection(): boolean {
    if (this._isDeviceUnavailable || this._currentCommandEncoder === null) {
      return false;
    }
    return this._environmentRefreshCoordinator.beginCollection(
      this._deviceResourceGeneration,
    );
  }

  /** Close the matching Scene primitive-collection phase. */
  endEnvironmentMapUpdateCollection(): void {
    this._environmentRefreshCoordinator.endCollection(
      this._deviceResourceGeneration,
    );
  }

  /**
   * Offer one backend manager tick to the active Scene collection.
   *
   * `false` means no Scene collection owns the call, so the feature-renderer
   * wrapper must preserve the historical immediate/off-frame updater. `true`
   * means this context consumed the call, including exact-manager duplicates.
   */
  queueEnvironmentMapUpdate<TManager extends object>(
    manager: TManager,
    frameState: CesiumFrameState,
    update: (manager: TManager, frameState: CesiumFrameState) => void,
  ): boolean {
    if (frameState.context !== this || this._isDeviceUnavailable) {
      return false;
    }
    return this._environmentRefreshCoordinator.enqueue(
      manager,
      frameState,
      update,
      this._deviceResourceGeneration,
      this,
    );
  }

  /**
   * Invoke queued manager ticks on the exact active Scene encoder.
   * The first half of a split-2D frame passes `false` so NORMAL work can see
   * second-viewport demand before final admission.
   */
  drainEnvironmentMapUpdates(includeNormal = true): number {
    if (
      this._isDeviceUnavailable ||
      this._currentCommandEncoder === null ||
      this.hasActiveRenderPass
    ) {
      return 0;
    }
    return this._environmentRefreshCoordinator.drain(
      this._environmentDemandRegistry,
      this._deviceResourceGeneration,
      includeNormal,
    );
  }

  /**
   * Bounded-drain admission seam.
   *
   * Returns `"run"` when the caller must perform the refresh this frame, or
   * `"defer"` when it must skip the refresh, commit NO bookkeeping (so its
   * level-triggered dirty predicate re-fires unchanged), and arm the resume
   * path via {@link WebGPUContext#consumeEnvironmentRefreshResume}.
   *
   * Deferral is bounded: after `MAX_DEFERRAL_FRAMES` consecutive deferrals a
   * request escalates to MANDATORY and runs regardless of budget. Callers whose
   * consumers have no valid published resource must request MANDATORY directly.
   */
  scheduleEnvironmentRefresh(
    manager: object,
    urgency: WebGPUEnvironmentRefreshUrgencyValue,
  ): WebGPUEnvironmentRefreshDecisionValue {
    return this._environmentRefreshScheduler.requestRefresh(manager, urgency);
  }

  /** Record that a granted refresh actually reached `queue.submit`. */
  noteEnvironmentRefreshSubmitted(manager: object): void {
    this._environmentRefreshScheduler.noteRefreshSubmitted(manager);
  }

  /**
   * True exactly once per frame, for the first deferral of that frame. A
   * `requestRenderMode` scene MUST turn this into a render request, otherwise
   * deferred refresh work has no frame to resume on.
   */
  consumeEnvironmentRefreshResume(): boolean {
    return this._environmentRefreshScheduler.consumeResumeRequest();
  }

  /** True while at least one deferred refresh is still owed a frame. */
  hasPendingEnvironmentRefreshWork(): boolean {
    return this._environmentRefreshScheduler.hasPendingWork();
  }

  /**
   * Context-owned persistent pool for the environment refresh path's transient
   * parameter arenas and capture depth targets. Created on first use and always
   * anchored to the current `(device, resourceGeneration)` pair.
   */
  getEnvironmentTargetPool(): WebGPUEnvironmentTargetPool | null {
    if (!this._device || this._isDeviceUnavailable) {
      return null;
    }
    if (this._environmentTargetPool === null) {
      this._environmentTargetPool = new WebGPUEnvironmentTargetPool(
        this._device,
        this._deviceResourceGeneration,
      );
    } else {
      // Producers can reach the pool outside `beginFrame` (compute-only /
      // offscreen paths). Re-anchor here too so a recovered device can never
      // hand out an object created for the lost one.
      this._environmentTargetPool.adopt(
        this._device,
        this._deviceResourceGeneration,
      );
    }
    return this._environmentTargetPool;
  }

  /** Allocation-bearing debug snapshot; never used to gate renderer work. */
  getEnvironmentRefreshStats(): WebGPUEnvironmentRefreshTelemetry {
    return this._environmentRefreshScheduler.getTelemetry();
  }

  /** Allocation-bearing debug snapshot; never used to gate renderer work. */
  getEnvironmentTargetPoolStats(): WebGPUEnvironmentTargetPoolTelemetry | null {
    return this._environmentTargetPool?.getTelemetry() ?? null;
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
    // Render-pipeline and post-process bind-group cache
    // effectiveness counters. Pure exposure of bookkeeping both caches
    // already pay for on their lookup paths, with no new per-frame work. A
    // near-zero bind-group hit rate means resource identities are being
    // recreated every frame without cache invalidation.
    if (this._webgpuPipelineCache) {
      try {
        stats.pipelineCache = { ...this._webgpuPipelineCache.getStats() };
      } catch (e) {
        stats.pipelineCache = { error: String((e as Error)?.message ?? e) };
      }
    }
    // Cloud CPU and GPU observability. The counters are bookkeeping the
    // cloud renderer already pays for on its own encode path; this is pure
    // exposure. `gpu` is scoped to the seven cloud pass labels and folded
    // through the same `summarizeFrameCoverage` union the whole-frame ledger
    // uses, so `clouds.cloudCoveredMs` is a unique-sample measure rather than
    // a sum that double-counts overlapping passes.
    const cloudCache = (
      this as unknown as {
        _cloudCache?: {
          observability?: CloudFrameCounters;
          cpuStages?: CloudCpuStageAccumulator;
          temporalHistoryGeneration?: number;
          temporalHistoryResetCount?: number;
          temporalHistoryAcceptedFrames?: number;
        };
      }
    )._cloudCache;
    if (cloudCache?.observability && cloudCache.cpuStages) {
      try {
        const profiler = this._timestampProfiler;
        const samples = profiler?.latestFrameSamples ?? null;
        stats.volumetricClouds = snapshotCloudObservability({
          counters: cloudCache.observability,
          cpu: cloudCache.cpuStages,
          temporal: {
            generation: cloudCache.temporalHistoryGeneration ?? 0,
            resetCount: cloudCache.temporalHistoryResetCount ?? 0,
            acceptedFrames: cloudCache.temporalHistoryAcceptedFrames ?? 0,
          },
          samples: samples && samples.length > 0 ? samples : null,
        });
      } catch (e) {
        stats.volumetricClouds = { error: String((e as Error)?.message ?? e) };
      }
    }
    stats.environmentMapDemand = {
      ...this._environmentDemandRegistry.getTelemetry(),
    };
    // Bounded-drain and target-pool credit. `deferred` with a zero
    // `maxDeferredFramesObserved` past the cap is the healthy shape; a non-zero
    // `staleReleases` after a recovery is expected exactly once per borrower.
    stats.environmentRefreshDrain = {
      ...this._environmentRefreshScheduler.getTelemetry(),
    };
    const environmentPoolStats = this._environmentTargetPool?.getTelemetry();
    if (environmentPoolStats) {
      stats.environmentTargetPool = { ...environmentPoolStats };
    }
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
      // Query sets are device-scoped; drop on loss.
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
      // Pooled buffers are bound to the dead device.
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
      // The indirect-args staging buffer is device-scoped.
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
      // The staging and readback caches hold device buffers.
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
   * Centralising the cache is what lets cross-renderer variants — the same
   * depth-cast layout used by both CSM and point-light shadows, for instance —
   * share a single pipeline instead of each feature renderer keeping its own
   * local map.
   *
   * The cache key covers depth, blend, stencil, cull and polygon-offset state,
   * multisample count, per-target colour format and write mask, depth format,
   * and the vertex-buffer layout signature, so two pipelines differing in any
   * of those fields materialize as distinct pipeline objects.
   */
  get webgpuPipelineCache(): WebGPURenderPipelineCache | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (!this._webgpuPipelineCache && this._device) {
      // Pass the context's async monitor so every async pipeline creation
      // publishes wakeup events. The monitor getter is lazy and returns the
      // same instance across device-loss cycles, so wiring it in the
      // constructor is safe: the cache is recreated on device loss and picks
      // up the same monitor.
      this._webgpuPipelineCache = new WebGPURenderPipelineCache(
        this._device,
        this._id,
        undefined,
        this.asyncResources,
      );
      // Drop the pipeline cache on device loss so the next access rebuilds
      // against the recovered device.
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
   * Async resource registry for this context. Returns the same instance for
   * the lifetime of the context: it survives device loss, where only inflight
   * tokens are reset and subscribers stay attached. Producers — the pipeline
   * caches, the image-decode helper, the shader-module cache — call
   * `monitor.begin`, `resolve` and `reject`; consumers, typically the attached
   * Scene, call `monitor.subscribe`.
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
   * Per-context async-resource telemetry. Attached eagerly when the monitor is
   * first created — see the `asyncResources` getter — so events fired before
   * the first read are not lost. Survives device loss for the same reason the
   * monitor does: the subscriber stays attached and only inflight tokens are
   * reset on `monitor.reset`.
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
    // Body lives in `WebGPUContextCullerPool.ts`.
    return getGpuCullerExt(this);
  }

  /**
   * Return the GPU culler instance for opaque-pass frustum `idx`. Frustum 0
   * reuses
   * the original `gpuCuller` so single-frustum scenes don't pay
   * extra VRAM; frustums 1..N get their own lazy-init instances so
   * their `prepareReadback` calls in the same encoder don't clobber
   * each other's staging buffers.
   *
   * Returns `null` if init is still pending or the device is gone.
   */
  public getGPUCullerForOpaqueFrustum(idx: number): GPUCullerInstance | null {
    // Body lives in `WebGPUContextCullerPool.ts`.
    return getGpuCullerForOpaqueFrustumExt(this, idx);
  }

  /**
   * Per-cascade GPU culler instances for the CSM shadow cast. Each cascade
   * gets its own `_visibilityBuffer` and `_readbackBuffer` so the per-cascade
   * `prepareReadback` calls do not collide in one encoder. Lazily initialized
   * on the first request per cascade index.
   *
   * The dispatch is live: `WebGPUCSMCastPass` packs per-cascade cull planes
   * with `packCascadeCullPlanes` — a correctness-safe cube-around-sphere
   * over-include rather than a tight Gribb-Hartmann extraction — runs the
   * hysteresis gate, dispatches this culler, and filters the cast list by the
   * prior frame's readback.
   */
  public getGPUCullerForCascade(idx: number): GPUCullerInstance | null {
    // Body lives in `WebGPUContextCullerPool.ts`.
    return getGpuCullerForCascadeExt(this, idx);
  }

  /**
   * Second GPU frustum culler, used exclusively for the translucent pass.
   * Gives translucent its own
   * `_visibilityBuffer` + `_readbackBuffer` so its `prepareReadback`
   * doesn't clobber the opaque pass's pending readback in the same
   * encoder. Same lazy-init pattern as `gpuCuller`.
   */
  get gpuCullerTranslucent(): GPUCullerInstance | null {
    // Body lives in `WebGPUContextCullerPool.ts`.
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
  private _detachPointCloudLOD(): WebGPUPointCloudLODProcessorInstance | null {
    this._pointCloudLODInitializationToken++;
    this._pointCloudLODInitializing = false;
    this._pointCloudLODInitializationError = null;
    this._pointCloudLODInitializationErrorReported = false;
    const processor = this._pointCloudLOD;
    this._pointCloudLOD = null;
    return processor;
  }

  get pointCloudLOD(): WebGPUPointCloudLODProcessorInstance | null {
    if (this._isDeviceUnavailable) {
      return null;
    }
    if (
      !this._pointCloudLOD &&
      this._device &&
      !this._pointCloudLODInitializing &&
      !this._pointCloudLODInitializationError
    ) {
      const device = this._device;
      const resourceGeneration = this._deviceResourceGeneration;
      const initializationToken = ++this._pointCloudLODInitializationToken;
      this._pointCloudLODInitializing = true;
      void import("./WebGPUPointCloudLODProcessor.js")
        .then(async ({ WebGPUPointCloudLODProcessor }) => {
          const processor = new WebGPUPointCloudLODProcessor(device, {
            label: `ctx-${this._id}`,
            useDecoupledScan:
              this._options.useDeterministicPointCloudLOD ?? false,
            asyncResourceMonitor: this.asyncResources,
          });
          try {
            await processor.initialize();
          } catch (error) {
            processor.destroy();
            throw error;
          }

          const tokenIsCurrent =
            this._pointCloudLODInitializationToken === initializationToken;
          if (
            !tokenIsCurrent ||
            this._device !== device ||
            this._deviceResourceGeneration !== resourceGeneration ||
            this._isDestroyed ||
            this._isTerminallyLost
          ) {
            processor.destroy();
            if (tokenIsCurrent) {
              this._pointCloudLODInitializing = false;
            }
            return;
          }

          this._pointCloudLOD = processor;
          this._pointCloudLODInitializing = false;
        })
        .catch((e: unknown) => {
          if (this._pointCloudLODInitializationToken !== initializationToken) {
            return;
          }
          //>>includeStart('debug', pragmas.debug);
          console.warn(
            `[CesiumJS:webgpu:ctx-${this._id}] Point cloud LOD init failed:`,
            e,
          );
          //>>includeEnd('debug');
          this._pointCloudLODInitializing = false;
          if (!this._pointCloudLODInitializationErrorReported) {
            console.error(
              `[CesiumJS:webgpu:ctx-${this._id}] Point cloud LOD initialization failed:`,
              e,
            );
            this._pointCloudLODInitializationErrorReported = true;
          }
          this._pointCloudLODInitializationError = e;
        });
    }
    return this._pointCloudLOD;
  }

  /**
   * Get frame statistics
   * @returns {object} Statistics object
   */
  getStatistics(): WebGPUFrameStatistics {
    // Body lives in `WebGPUFrameStatistics.ts`.
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
  // Device Loss Recovery — delegated to WebGPUDeviceLossRecovery through the
  // DeviceLossRecoveryHost interface.
  // ====================================================================================

  /**
   * Set up device loss handler by creating and configuring a
   * WebGPUDeviceLossRecovery instance that implements all recovery logic.
   * @private
   */
  private _setupDeviceLostHandler(): void {
    if (!this._device) return;
    // The host-adapter literal lives in `WebGPUContextDeviceLoss.ts`; this
    // wrapper keeps the call site on the class.
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
  // Public underscore: shared with the device-loss host-adapter.
  public _reconfigureCanvas(): void {
    // Body lives in `WebGPUContextCanvasConfig.ts`.
    reconfigureCanvasExt(this);
  }

  /**
   * Apply the canvas config with a fallback path for a browser that rejects
   * HDR-only fields. The body lives in `WebGPUContextCanvasConfig.ts`, which
   * documents the fallback chain: extended toneMapping, then rgba16float,
   * then SDR.
   */
  private _applyCanvasConfig(): void {
    applyCanvasConfigExt(this);
  }

  /**
   * Request an HDR-output canvas. Matches
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
    // Body lives in `WebGPUContextCanvasConfig.ts`.
    setHDRCanvasOutputExt(this, enabled);
  }

  /** Current canvas-output HDR state. */
  public get hdrCanvasOutput(): boolean {
    return this._hdrCanvasOutput;
  }

  /**
   * Destroy auxiliary culler instances idle for at least
   * `IDLE_DECAY_FRAMES`. Called at
   * IDLE_DECAY_CHECK_INTERVAL-frame intervals from `beginFrame()`.
   *
   * Sweep order: per-frustum (idx >= 1, since 0 reuses _gpuCuller),
   * per-cascade, then translucent culler, then the main _gpuCuller.
   * Each destroy nullifies the slot so the lazy getter reallocates
   * on demand.
   */
  private _reapIdleAuxCullers(): void {
    // Body lives in `WebGPUContextCullerPool.ts`.
    reapIdleAuxCullersExt(this);
  }

  /**
   * Register a callback fired when the HDR canvas configure fails and the
   * context demotes itself to SDR. Scene.js installs one so its
   * `_useHDRCanvasOutput` flag stays in sync with the canvas reality, and the
   * returned unsubscribe function lets it clean up at destruction.
   *
   * Several Scenes can share one Context — split-screen, picture-in-picture —
   * and each registers its own listener; all of them fire on demotion.
   *
   * `null` is not a "clear all listeners" value: a single-slot design that
   * accepted it would let one Scene's cleanup remove every other Scene's
   * listener. Per-listener cleanup goes through the returned unsubscribe
   * function, and clearing all listeners, as at context teardown, goes
   * through `clearAllHDRFallbackListeners()`.
   *
   * @param {Function|null} listener Called with the new HDR state on demotion.
   * @returns {Function|null} The unsubscribe function, or null when `listener`
   *   was nullish.
   */
  public setHDRFallbackListener(
    listener: ((newValue: boolean) => void) | null,
  ): (() => void) | null {
    // Body lives in `WebGPUContextCanvasConfig.ts`.
    return setHDRFallbackListenerExt(this, listener);
  }

  /**
   * Clear every registered HDR fallback listener. Used at context teardown,
   * and kept distinct from `setHDRFallbackListener(null)` so a Scene removing
   * only its own listener cannot trigger it by accident.
   */
  public clearAllHDRFallbackListeners(): void {
    // Body lives in `WebGPUContextCanvasConfig.ts`.
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
      .register("modelCameraArena", () => {
        // Detach before invalidation: even if a fallback buffer throws during
        // destroy, the next frame cannot reacquire this old-page arena. The
        // registry continues to uniformAllocator below independently.
        const modelCameraArena = this._modelCameraArena;
        this._modelCameraArena = null;
        modelCameraArena?.invalidate();
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
      .register("pointCloudLOD", () => {
        this._detachPointCloudLOD()?.destroy();
      })
      .register("performanceManager", () => {
        const performanceManager = this._performanceManager;
        if (performanceManager) {
          this._performanceManagerConfig = { ...performanceManager.config };
          this._performanceManager = null;
          performanceManager.destroy();
        }
      })
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
  // Public underscore: shared with the device-loss host-adapter.
  public _clearAllCaches(previousDevice?: GPUDevice | null): void {
    // Jobs are exact `(GPUDevice, resourceGeneration)` work. Recovery swaps
    // `_device` before entering this hook, so discard the old tuple before any
    // cache/subscriber can lazily create resources on the replacement device.
    // This must not depend on `mipmapGenerator` ever having been touched.
    this._pendingTextureMipJobs.length = 0;
    this._pendingTextureMipJobKeys = new WeakMap();

    // A device-loss edge abandons the current encoder permanently. Reject
    // frame-owned readbacks immediately; request-render scenes may never start
    // another frame, and terminal loss has no future frame by definition.
    this._drainAfterCommandEncoderSubmitCallbacks(false);
    this._drainAfterFrameSubmitCallbacks(false);
    this._currentRenderPassEncoder = null;
    this._activePassTarget = null;
    this._currentCommandEncoder = null;
    this._currentTextureView = null;

    // Per-cache try/catch and named error logs live inside the registry.
    // What stays inline:
    //   - effects-cache lease transfer — moves this context from the lost
    //     physical device generation to the recovered one.
    //   - `_fireDeviceInvalidated` — the side-effect that notifies
    //     external subscribers AFTER all caches drop their stale
    //     handles.
    this._cacheRegistry.clearAll();

    // The globe renderer's per-context, per-frame effects memo
    // (`_globeEffectsHandle`) is a context expando pinning a bind group and
    // shadowMap, clipping and tileProvider references from the lost device
    // generation. Drop it on invalidation so recovery cannot reuse a
    // stale-device bind group. It is intra-frame by design and rebuilt next
    // frame, so nulling it here is safe by construction.
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
    // and textures belong to the old device generation. Release every
    // registered native allocation, including unbound resources. Texture
    // sources are deliberately not retained by the compatibility layer;
    // higher-level owners must recreate them after recovery.
    let firstLostNativeCleanupError: unknown;
    let hasLostNativeCleanupError = false;
    const continueLostNativeCleanupAfter = (cleanup: () => void): void => {
      try {
        cleanup();
      } catch (error) {
        if (!hasLostNativeCleanupError) {
          firstLostNativeCleanupError = error;
          hasLostNativeCleanupError = true;
        }
      }
    };
    continueLostNativeCleanupAfter(() =>
      this._gl.invalidateCompatibilityTextureHandles(),
    );
    continueLostNativeCleanupAfter(() =>
      this._gl.invalidateCompatibilityBufferHandles(),
    );

    // Recovery has already swapped `_device` before reaching this hook.
    // Move the validation lease off the lost device and onto the recovered
    // generation; `_installShaderValidation` releases the old lease first.
    // Candidate setup remains fatal: unlike old-native destruction, failure
    // here means the replacement device is not fully initialized.
    if (this._device) {
      this._installShaderValidation(this._device);
    }

    // Recovery swaps `_device` before entering this hook. Move only this
    // context's effects-cache ownership from the lost generation to the new
    // one. A pooled device may have multiple contexts, so the old entry is
    // destroyed only after every context has released it; the new entry must
    // never be force-cleared here.
    if (previousDevice && previousDevice !== this._device) {
      continueLostNativeCleanupAfter(() =>
        releaseEffectsPlaceholderCacheForContext(previousDevice, this),
      );
    }
    if (this._device) {
      retainEffectsPlaceholderCacheForContext(this._device, this);
    }

    // The replacement device may expose byte-identical formats and limits, but
    // none of its native objects are compatible with the previous device.
    // Advance even if a lost native's destroy() threw. Every compatibility
    // handle detached its old tuple before destruction, so leaving the epoch
    // unchanged would make recovery consumers mistake failure reporting for a
    // still-valid resource lifetime.
    this._deviceResourceGeneration += 1;
    this._environmentDemandRegistry.reset(this._deviceResourceGeneration);
    this._environmentRefreshCoordinator.reset(this._deviceResourceGeneration);
    // Every queued refresh described work against the lost device.
    // Drop the queue; each producer re-derives a MANDATORY post-recovery
    // request from its own invalidated cache, so nothing is lost. The pool
    // destroys its entire cache for the old generation before it can hand out
    // an object the replacement device cannot use.
    this._environmentRefreshScheduler.reset(this._deviceResourceGeneration);
    if (this._environmentTargetPool !== null && this._device) {
      this._environmentTargetPool.adopt(
        this._device,
        this._deviceResourceGeneration,
      );
    }

    // Fire the invalidation event so every
    // subscribed subsystem / feature renderer / per-object cache
    // drops its stale GPU handles. The context-level caches above
    // cover the `WebGPUContext`-owned set; subscribers cover
    // subsystem-owned (`_renderBundleManager`, `_timestampProfiler`,
    // `_storageBufferPool`, `_mipmapGenerator`) and external
    // (effect bind-group caches, module-level WeakMaps) state that
    // the context can't reach directly.
    this._fireDeviceInvalidated();

    if (hasLostNativeCleanupError) {
      // Cleanup of objects owned by an already-lost device is diagnostic only.
      // Propagating it would make DeviceLossRecovery roll back an otherwise
      // healthy candidate after the new generation was already published.
      // lint-debug-pragmas-allow: recovery cleanup diagnostic must survive production builds
      console.warn(
        "[WebGPU] Recovered with an old-device cleanup error:",
        firstLostNativeCleanupError,
      );
    }
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

  // Device-invalidation subscriber registry. The body lives in
  // `WebGPUDeviceInvalidationBus`; the public `onDeviceInvalidated` method and
  // the private `_fireDeviceInvalidated` keep the subscription surface on the
  // context, where its internal call sites and `WebGPUSceneRenderer` address
  // it.
  private _deviceInvalidationBus = new WebGPUDeviceInvalidationBus(
    () => this.id,
  );

  // Resource-cache registry. Populated by
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
