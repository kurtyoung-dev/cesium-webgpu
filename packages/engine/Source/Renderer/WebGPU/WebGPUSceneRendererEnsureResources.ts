/**
 * Allocates, resizes, and changes the format of every framebuffer consumed by
 * the scene pass chain:
 *
 * - The scene framebuffer (`WebGPUSceneFramebuffer`) owns the main color,
 *   depth, and ID targets. Its color format switches between an HDR format and
 *   the canvas format with `useHDR`.
 * - OIT (`WebGPUOIT`) owns the accumulation and revealage targets for
 *   order-independent transparency. It is allocated only when both the Scene
 *   request and the renderer safety gate are enabled.
 * - The edge MRT framebuffer (`WebGPUEdgeFramebuffer`) is allocated only while
 *   `_enableEdgeVisibility` is enabled.
 * - The translucent tile classification framebuffer
 *   (`WebGPUTranslucentTileClassification`) lazily allocates single-sampled
 *   depth, packed-depth, and color targets.
 * - The globe depth framebuffer (`WebGPUGlobeDepth`) is created when
 *   `useGlobeDepthFramebuffer` is enabled.
 * - The depth plane (`WebGPUDepthPlane`) is created when `useDepthPlane` is
 *   enabled and routes its pipelines through the central render-pipeline
 *   cache.
 * - The post-process pipeline (`WebGPUPostProcessPipeline`) owns the ping-pong,
 *   tonemapping, FXAA, and auto-exposure chain that blits the scene framebuffer
 *   to the canvas. It is rebuilt after an HDR change so its intermediate
 *   textures use the scene's format.
 *
 * Initial mount, canvas resize, and an HDR toggle each recreate the scene
 * framebuffer. Treating an HDR change like a resize prevents the scene color
 * target and its dependent OIT, edge, refraction, and velocity textures from
 * retaining incompatible formats.
 *
 * A single `context.onDeviceInvalidated` subscription drops the framebuffers
 * and caches during device-loss recovery. The next resource-ensure pass
 * rebuilds them against the replacement device.
 *
 * @module WebGPUSceneRendererEnsureResources
 */

import type { WebGPUContext } from "./WebGPUContext.js";
import { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import { WebGPUEdgeFramebuffer } from "./WebGPUEdgeFramebuffer.js";
import { WebGPUTranslucentTileClassification } from "./WebGPUTranslucentTileClassification.js";
import { WebGPUOIT } from "./WebGPUOIT.js";
import { WebGPUGlobeDepth } from "./WebGPUGlobeDepth.js";
import { WebGPUDepthPlane } from "./WebGPUDepthPlane.js";
import { getWebGPUPickColorFormat } from "./WebGPUPickFramebuffer.js";
import { isWebGPULogDepthActive } from "./WebGPULogDepth.js";
import { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";
import { configureWebGPUPostProcessPipeline } from "./WebGPUPostProcessStageCollection.js";
import type { WebGPUDebugDepthOverlay } from "./WebGPUDebugDepthOverlay.js";
import type { WebGPUDebugFrustumOverlay } from "./WebGPUDebugFrustumOverlay.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";

/**
 * The SceneRenderer surface used by the resource-ensure helper. Every field is
 * both read and written.
 */
export interface EnsureResourcesHost {
  // Frame-buffer slots (read+write)
  _sceneFramebuffer: WebGPUSceneFramebuffer | null;
  _edgeFramebuffer: WebGPUEdgeFramebuffer | null;
  _translucentTileClassification: WebGPUTranslucentTileClassification | null;
  _oit: WebGPUOIT | null;
  _webgpuOITEnabled: boolean;
  _lastOITRequested: boolean;
  _globeDepth: WebGPUGlobeDepth | null;
  _depthPlane: WebGPUDepthPlane | null;
  _postProcess: WebGPUPostProcessPipeline | null;

  // Debug overlays — written only by the device-invalidation
  // subscriber callback (set to null on device loss so next frame
  // rebuilds them).
  _debugDepthOverlay: WebGPUDebugDepthOverlay | null;
  _debugFrustumOverlay: WebGPUDebugFrustumOverlay | null;

  // Allocation epochs for the compute-side caches. Written here only by the
  // device-invalidation subscriber callback, which returns them to their
  // pre-allocation values so the guards that read them stop reporting the dead
  // device's allocations as current.
  _hiZAllocated: boolean;
  _hiZAllocatedFor: { width: number; height: number; capacity: number };
  _sortKeysAllocatedFor: number;
  _clusteredLightingDispatcher: { destroy(): void } | null;

  // Lifecycle state
  _initialized: boolean;
  _width: number;
  _height: number;
  _lastHDR: boolean | null;
  _deviceInvalidationUnsub: (() => void) | null;
}

export interface EnsureDepthPlaneHost {
  _depthPlane: WebGPUDepthPlane | null;
}

/**
 * Ensure only the depth-plane resource family. The pick mini-frame uses this
 * path after device recovery so it never has to invoke the full scene-FBO and
 * post-process allocator merely to obtain an attachment-compatible plane.
 */
export function ensureDepthPlane(
  host: EnsureDepthPlaneHost,
  config: WebGPURenderFrameConfig,
): void {
  const { context, scene } = config;
  const device: GPUDevice | undefined = context._device;
  if (!device || !config.useDepthPlane) {
    return;
  }

  const desiredFormat: GPUTextureFormat =
    context.scenePipelineFormat ?? context.presentationFormat ?? "bgra8unorm";
  const desiredDepthFormat: GPUTextureFormat =
    context.depthFormat ?? "depth24plus-stencil8";
  const desiredSampleCount = context._msaaSamples ?? 1;
  const desiredPickFormat = getWebGPUPickColorFormat(context);
  const desiredLogDepth = isWebGPULogDepthActive(
    context,
    (scene as unknown as { _frameState?: { useLogDepth?: boolean } })
      ._frameState,
  );
  const current = host._depthPlane;
  if (
    current &&
    (!current.isForDevice(device) ||
      current._colorFormat !== desiredFormat ||
      current._depthFormat !== desiredDepthFormat ||
      current._sampleCount !== desiredSampleCount ||
      current._pickColorFormat !== desiredPickFormat ||
      current._logDepth !== desiredLogDepth)
  ) {
    current.destroy();
    host._depthPlane = null;
  }

  if (host._depthPlane) {
    return;
  }

  const next = new WebGPUDepthPlane();
  try {
    next.initialize(
      device,
      desiredDepthFormat,
      desiredFormat,
      context.webgpuPipelineCache ?? null,
      desiredSampleCount,
      desiredLogDepth,
      desiredPickFormat,
    );
    host._depthPlane = next;
  } catch (error) {
    next.destroy();
    throw error;
  }
}

/**
 * Returns whether native WebGPU OIT resources may be allocated. Exported so
 * `WebGPUUnsafeDefaultsSpec` can pin the gate without standing up a device;
 * it has no other caller outside this module.
 */
export function shouldAllocateWebGPUOIT(
  requested: boolean,
  safetyGateEnabled: boolean,
): boolean {
  return requested === true && safetyGateEnabled === true;
}

/**
 * Allocate / resize / format-toggle every framebuffer the scene pass
 * chain reads from. Idempotent — framebuffer `update()` methods compare their
 * current resource identity before reallocating. Dependent targets receive the
 * live state every frame because `prepareFrame()` may already have consumed
 * the renderer-level HDR/MSAA drift before this later ensure step runs.
 *
 * @param host - The owning SceneRenderer.
 * @param config - Render-frame config from `executeCommands`.
 */
export function ensureResources(
  host: EnsureResourcesHost,
  config: WebGPURenderFrameConfig,
): void {
  const { context, scene } = config;
  const device: GPUDevice | undefined = context._device;
  if (!device) {
    return;
  }

  // Subscribe once so device invalidation drops every SceneRenderer-owned GPU
  // resource. The next resource-ensure pass rebuilds them against the
  // replacement device.
  if (!host._deviceInvalidationUnsub) {
    host._deviceInvalidationUnsub = context.onDeviceInvalidated(() => {
      host._sceneFramebuffer = null;
      host._edgeFramebuffer = null;
      host._translucentTileClassification = null;
      host._oit = null;
      host._globeDepth = null;
      host._depthPlane = null;
      host._postProcess = null;
      host._debugDepthOverlay = null;
      host._debugFrustumOverlay = null;
      host._initialized = false;

      // Allocation epochs are separate from the resource slots above: they are
      // plain booleans and size records, so nulling a framebuffer does not
      // reach them. Their guards compare against a requested size or count and
      // stay satisfied across a recovery, which would skip the reallocation
      // that the replacement device needs. Reset them to their pre-allocation
      // values so the next frame rebuilds against the live device.
      host._hiZAllocated = false;
      host._hiZAllocatedFor = { width: 0, height: 0, capacity: 0 };
      host._sortKeysAllocatedFor = 0;

      // The clustered-lighting dispatcher captured the dead device at
      // construction and is only rebuilt when this field is empty.
      const clusteredLightingDispatcher = host._clusteredLightingDispatcher;
      host._clusteredLightingDispatcher = null;
      if (clusteredLightingDispatcher) {
        try {
          clusteredLightingDispatcher.destroy();
        } catch {
          // A lost device can reject native teardown; the field is already
          // cleared, so the next frame builds a replacement regardless.
        }
      }

      // Clear per-object caches that are not covered by the subsystem registry.
      // A scene object removed from a primitive collection during recovery can
      // remain reachable while holding handles from the invalid device, so the
      // scene graph is walked immediately.
      clearPerObjectCaches(scene);

      // Invalidation fires only from the recovery hook, and only after the
      // replacement device has been published - so this is the moment a new
      // device exists and nothing has drawn on it. Everything nulled above is
      // rebuilt by the next frame, and under request-render mode there is no
      // other reason for one: without this the canvas keeps the black it was
      // left with until some unrelated input asks for a redraw.
      scene?.requestRender?.();
    });
  }

  const canvas: HTMLCanvasElement | OffscreenCanvas | undefined =
    context._canvas;
  const width = canvas?.width ?? 1;
  const height = canvas?.height ?? 1;
  const needsResize = width !== host._width || height !== host._height;
  const hdr = config.useHDR ?? false;
  // Treat an HDR change as a recreate trigger because it changes the scene
  // framebuffer color format between an HDR format and the canvas format. A
  // same-resolution toggle must also rebuild dependent OIT, edge, refraction,
  // and velocity textures.
  const hdrChanged = host._lastHDR !== null && host._lastHDR !== hdr;
  const needsRecreate = !host._initialized || needsResize || hdrChanged;
  // Capture the first-initialization edge before `_initialized` is set below.
  // Deterministic pipeline prewarming runs exactly once, after the scene
  // framebuffer attachment formats are known; context initialization occurs
  // before those formats are available.
  const firstInit = !host._initialized;
  host._lastHDR = hdr;
  const numSamples: number = context._msaaSamples ?? 1;
  const canvasFormat: GPUTextureFormat =
    context.presentationFormat ?? "bgra8unorm";

  // Scene framebuffer (main color + depth + ID targets)
  if (!host._sceneFramebuffer) {
    host._sceneFramebuffer = new WebGPUSceneFramebuffer();
  }
  if (needsRecreate) {
    host._sceneFramebuffer.update(
      device,
      width,
      height,
      hdr,
      numSamples,
      canvasFormat,
    );
    // Updating the scene framebuffer destroys its old refraction texture and
    // view. Clear the published view so the model renderer binds the white
    // placeholder until the next capture pass publishes a replacement.
    context._refractionSceneView = null;
  }
  // Keep the context color format synchronized with the scene framebuffer.
  // Invert classification and OIT use it when allocating their targets; a
  // stale canvas-format value would make their pipelines incompatible with an
  // HDR scene target.
  const previousSceneColorFormat = context._sceneColorFormat;
  context._sceneColorFormat =
    host._sceneFramebuffer.colorFormat ?? context._sceneColorFormat;
  const sceneColorFormat: GPUTextureFormat =
    host._sceneFramebuffer.colorFormat ?? "bgra8unorm";

  // Publish the scene color view for environmental effects and the translucent
  // pass. The single-sampled depth view is published separately below.
  context._sceneColorView =
    host._sceneFramebuffer.colorTarget?.getColorTextureView?.(0) ?? null;
  // `depthSampleableView` is single-sampled in both modes: the depth aspect
  // view in single-sample mode and the resolve target populated by the
  // post-frustum chain in MSAA mode. Environmental effects, ambient occlusion,
  // and depth of field can therefore use the same context slot.
  const _ctxWithDepth = context as unknown as {
    _depthStencilView: GPUTextureView | null;
  };
  _ctxWithDepth._depthStencilView =
    host._sceneFramebuffer.depthSampleableView ?? null;

  // Allocate the post-process snapshot at canvas size and format. It holds a
  // copy of the post-processed canvas content for environmental effects to
  // sample during reflection and compositing, keeping `copyTextureToTexture`
  // layout-compatible.
  const canvasW = (context._canvas?.width ?? 1) | 0;
  const canvasH = (context._canvas?.height ?? 1) | 0;
  const ppFormat = context.presentationFormat ?? "bgra8unorm";
  const snapshotOwner = context as unknown as {
    _postProcessSnapshotDevice?: GPUDevice | null;
  };
  const needsSnapshotRealloc =
    !context._postProcessSnapshotTexture ||
    snapshotOwner._postProcessSnapshotDevice !== device ||
    context._postProcessSnapshotWidth !== canvasW ||
    context._postProcessSnapshotHeight !== canvasH;
  if (needsSnapshotRealloc && canvasW > 0 && canvasH > 0) {
    context._postProcessSnapshotTexture?.destroy();
    context._postProcessSnapshotTexture = device.createTexture({
      label: "PostProcessSnapshot",
      size: { width: canvasW, height: canvasH, depthOrArrayLayers: 1 },
      format: ppFormat,
      // This texture is side A of the environmental-effects ping-pong graph. It
      // is copied from the canvas first and can become the target of the second
      // or fourth full-screen effect. The compositor always renders into the
      // side opposite the sampled texture.
      usage:
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.RENDER_ATTACHMENT,
      sampleCount: 1,
    });
    context._postProcessSnapshotView =
      context._postProcessSnapshotTexture.createView({
        label: "PostProcessSnapshot view",
      });
    context._postProcessSnapshotWidth = canvasW;
    context._postProcessSnapshotHeight = canvasH;
    snapshotOwner._postProcessSnapshotDevice = device;
  }

  // Increment the scene-pipeline format generation whenever the scene color
  // format changes. Renderers use the generation to rebuild cached
  // scene-target pipelines; retaining them across an HDR toggle would produce
  // validation errors and black writes for sky, globe, model, and primitive
  // draws.
  if (
    context._sceneColorFormat !== undefined &&
    context._sceneColorFormat !== previousSceneColorFormat
  ) {
    context._scenePipelineFormatGeneration += 1;
    // Invalidate render bundles whose baked pipeline formats no longer match
    // the active scene framebuffer.
    context.renderBundleManager?.invalidateAll?.();
  }

  // Preserve the public Scene OIT request while independently gating native
  // WebGPU MRT allocation. The translucent pass retains a complete alpha
  // fallback when this gate is disabled.
  host._lastOITRequested = config.useOIT === true;
  const useContainedWebGPUOIT = shouldAllocateWebGPUOIT(
    host._lastOITRequested,
    host._webgpuOITEnabled,
  );
  if (useContainedWebGPUOIT && !host._oit) {
    host._oit = new WebGPUOIT(context);
  }
  if (useContainedWebGPUOIT && host._oit) {
    // Pass the current sample count so the OIT composite pipeline matches the
    // scene framebuffer whenever OIT is enabled. This runs every frame because
    // `prepareFrame` may already have consumed renderer-level drift, while
    // `WebGPUOIT.update` is allocation-idempotent for an unchanged tuple.
    host._oit.update(device, width, height, numSamples);
  }

  // Allocate the edge MRT framebuffer only when `_enableEdgeVisibility` is
  // enabled. No downstream path reads its three color textures or depth-stencil
  // target otherwise. Turning the flag on mid-session allocates on the next
  // update; turning it off does not release, since the framebuffer lives
  // until the renderer is destroyed.
  const enableEdgeVisibility = !!(
    scene as unknown as { _enableEdgeVisibility?: boolean }
  )._enableEdgeVisibility;
  if (enableEdgeVisibility && !host._edgeFramebuffer) {
    host._edgeFramebuffer = new WebGPUEdgeFramebuffer();
  }
  if (host._edgeFramebuffer) {
    host._edgeFramebuffer.update(
      device,
      width,
      height,
      numSamples,
      sceneColorFormat,
    );
  }

  // Allocate the translucent-classification framebuffer on first resource
  // initialization. Its depth, packed-depth, and color targets are
  // single-sampled; per-frame work remains gated on `hasTranslucentDepth`, so
  // inactive scenes pay only the allocation cost.
  if (!host._translucentTileClassification) {
    host._translucentTileClassification =
      new WebGPUTranslucentTileClassification();
  }
  if (host._translucentTileClassification) {
    host._translucentTileClassification.update(
      device,
      width,
      height,
      sceneColorFormat,
    );
  }

  // Globe depth framebuffer
  if (config.useGlobeDepthFramebuffer && !host._globeDepth) {
    host._globeDepth = new WebGPUGlobeDepth({ timestampProvider: context });
  }
  if (host._globeDepth) {
    host._globeDepth.update(
      device,
      width,
      height,
      hdr,
      numSamples,
      canvasFormat,
    );
  }

  // Keep this after scene framebuffer update: that step publishes the exact
  // HDR/SDR scene attachment format consumed by the scene pipeline variant.
  ensureDepthPlane(host, config);

  // Rebuild the post-process pipeline when HDR mode changes because its
  // ping-pong texture formats and every stage target format depend on that
  // mode. Destroying the pipeline lets initialization reconstruct the matching
  // textures and stage chain. The pipeline null check ahead of the comparison
  // is what skips the initial mount, when there is nothing to rebuild.
  if (
    host._postProcess &&
    (host._postProcess as unknown as { _hdr: boolean })._hdr !== hdr
  ) {
    host._postProcess.destroy();
    host._postProcess = null;
    // Drop the context's cache-statistics back-reference with the pipeline.
    // Initialization below re-registers it if the pipeline is recreated.
    context._postProcessCacheStatsSource = null;
  }

  // Post-processing pipeline
  if (config.usePostProcess && !host._postProcess) {
    host._postProcess = new WebGPUPostProcessPipeline(context);
    // Expose the pipeline's bind-group cache counters through the context
    // without making the context import the post-process graph.
    context._postProcessCacheStatsSource = host._postProcess;
    const canvasFormat: GPUTextureFormat =
      context.presentationFormat ?? "bgra8unorm";
    // HDR ping-pong textures use `rgba16float` so the scene's dynamic range
    // survives bloom, tonemapping, and color grading. Only the final blit
    // converts to the canvas swap-chain format; canvas-format intermediates
    // would clamp values to [0, 1] and make tonemapping ineffective.
    host._postProcess.initialize(device, width, height, canvasFormat, hdr);
    // Add default stages
    // Enable f16 only when both the opt-in and the device-granted feature are
    // present. Gating on the opt-in alone would defer the unsupported-device
    // fallback to asynchronous compilation; this gate selects f32 before
    // compilation.
    const useShaderF16 = !!(
      context &&
      context.useShaderF16 &&
      context.hasFeature("shader-f16")
    );
    // Tonemap stage selects the hand-tuned half-precision variant when
    // opted in. Default mode/exposure/gamma are unchanged.
    host._postProcess.addTonemapping(
      device,
      canvasFormat,
      undefined,
      undefined,
      undefined,
      useShaderF16,
    );
    // TAA is added lazily when `scene.taaEnabled` becomes true.
    // `configureWebGPUPostProcessPipeline` below gates creation on the live
    // `pipeline.taaEffect` slot.
    host._postProcess.addFXAA(device, canvasFormat, useShaderF16);
    // Registered in both HDR and SDR so enabling it is a flag flip rather
    // than a pipeline rebuild. It stays disabled until
    // `configureWebGPUPostProcessPipeline` below syncs
    // `PostProcessStageCollection.autoExposure`, which is false by default to
    // match WebGL — so the reduction does not dispatch at defaults and costs
    // nothing until a user opts in.
    //
    // Pass the central compute-pipeline cache so auto-exposure uses it for both
    // pipeline creations.
    host._postProcess.addAutoExposure(
      device,
      undefined,
      context?.webgpuComputePipelineCache ?? null,
    );
  }
  if (host._postProcess && needsResize) {
    host._postProcess.resize(width, height);
  }

  // Sync post-processing stage state from CesiumJS PostProcessStageCollection
  // to the WebGPU pipeline. This lazily initializes bloom/AO/DoF on first enable
  // and syncs enable/disable + tonemapping mode each frame.
  if (host._postProcess && config.scene?.postProcessStages) {
    const canvasFormat: GPUTextureFormat =
      context.presentationFormat ?? "bgra8unorm";
    configureWebGPUPostProcessPipeline(
      host._postProcess,
      config.scene.postProcessStages,
      device,
      canvasFormat,
      config.scene,
    );
  }

  host._width = width;
  host._height = height;
  host._initialized = true;

  // Start compiling deterministic render pipelines once the scene framebuffer
  // attachment formats are resolved. This is fire-and-forget: it never blocks
  // the frame, and failures preserve the lazy first-use path.
  if (firstInit) {
    prewarmDeterministicPipelines(host, config);
  }
}

/**
 * Starts deterministic pipeline compilation once the scene framebuffer color,
 * depth, and sample-count formats are known. Context initialization occurs
 * before those preconditions are available.
 *
 * Eligible renderers route their variants through the central asynchronous
 * pipeline cache. The depth plane is currently eligible and also prewarms
 * during initialization, so cached and pending keys make this call idempotent.
 * Sky atmosphere, globe-depth copying, and post-process identity, tonemapping,
 * and FXAA pipelines still use private synchronous creation and cannot
 * participate until they use the central cache.
 *
 * Fire-and-forget. A prewarm failure never escapes `ensureResources`; lazy
 * first use remains the correctness path.
 */
function prewarmDeterministicPipelines(
  host: EnsureResourcesHost,
  config: WebGPURenderFrameConfig,
): void {
  const { context } = config;
  const pipelineCache = context.webgpuPipelineCache ?? null;
  if (!pipelineCache) {
    return;
  }
  try {
    let warmed = 0;
    // Depth plane — the one deterministic renderer already on the central
    // cache. `prewarm` warms its color + pick variants (idempotent).
    warmed += host._depthPlane?.prewarm(pipelineCache) ?? 0;

    // Record how many pipelines were warmed at the resource-ready point before
    // the frame's draw; boot-prewarm probes read this counter.
    const ctxCounter = context as unknown as {
      _deterministicPrewarmCount?: number;
    };
    ctxCounter._deterministicPrewarmCount =
      (ctxCounter._deterministicPrewarmCount ?? 0) + warmed;
  } catch {
    // Prewarm is a pure optimization — a failure to warm must never break the
    // frame. The lazy first-use path still builds the pipeline correctly.
  }
}

/**
 * Clears the `_webgpuCache` slot on per-object owners reachable from the scene
 * (primitives, collections, shadow map, and post-process stages). The
 * device-invalidation handler calls this so orphaned but still reachable caches
 * drop stale GPU handles during recovery.
 *
 * What gets cleared:
 *
 * - `scene.primitives` collection — recursively walked; every member
 *   with `._webgpuCache` is cleared. Includes both leaf primitives
 *   (Models, GroundPrimitive, etc.) and nested PrimitiveCollections.
 * - `scene.groundPrimitives` collection (separate primitive set in
 *   Cesium for terrain-classified primitives).
 * - `scene.shadowMap` — single object with own `_webgpuCache`.
 * - `scene.postProcessStages` — collection-level cache.
 *
 * Owner-feature-renderer destroy/recreate flows still run on the next
 * update tick; this is defensive cleanup for the window between
 * device-loss event and the next render frame.
 *
 * @private
 */
function clearPerObjectCaches(
  scene:
    | {
        primitives?: unknown;
        groundPrimitives?: unknown;
        shadowMap?: unknown;
        postProcessStages?: unknown;
      }
    | undefined,
): void {
  if (!scene) return;
  walkAndClear(scene.primitives);
  walkAndClear(scene.groundPrimitives);
  // Singletons / non-collection owners.
  clearOne(scene.shadowMap);
  clearOne(scene.postProcessStages);
}

interface WebGPUCacheOwner {
  _webgpuCache?: unknown;
  length?: number;
  get?: (i: number) => unknown;
}

function walkAndClear(node: unknown): void {
  if (!node) return;
  const owner = node as WebGPUCacheOwner;
  // Leaf with its own cache — clear it.
  clearOne(owner);
  // Collection-shape duck-type: { length, get(i) }. Cesium
  // PrimitiveCollection follows this shape; recurse into children.
  if (typeof owner.length === "number" && typeof owner.get === "function") {
    const len = owner.length;
    for (let i = 0; i < len; i++) {
      try {
        walkAndClear(owner.get(i));
      } catch {
        // A child throwing during cache clearing must not block the rest of the
        // walk. The next render tick will rediscover and clean it up through the
        // owning feature renderer.
      }
    }
  }
}

function clearOne(node: unknown): void {
  if (!node) return;
  const owner = node as WebGPUCacheOwner;
  if (owner._webgpuCache !== undefined) {
    owner._webgpuCache = undefined;
  }
}
