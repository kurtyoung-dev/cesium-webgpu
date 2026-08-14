/**
 * Per-frame resource allocation/resize extracted from
 * `WebGPUSceneRenderer._ensureResources`.
 *
 * Batch 142 of the audit-recommended SceneRenderer decomposition.
 * Moves the 268-line resource-allocation block — the highest blast-
 * radius extraction left in the SceneRenderer — to a focused module.
 *
 * Allocates / resizes / format-toggles every framebuffer the scene
 * pass chain reads from:
 *
 *   - **Scene framebuffer** (`WebGPUSceneFramebuffer`): main color +
 *     depth + ID targets. Format flips between `rgba16float` (HDR) /
 *     canvas format (SDR) on `useHDR` toggle.
 *   - **OIT** (`WebGPUOIT`): accumulation + revealage MRT for
 *     order-independent transparency. FAR-003 contains allocation behind
 *     a renderer-owned comparison gate even when Scene requests OIT.
 *   - **Edge MRT framebuffer** (`WebGPUEdgeFramebuffer`): allocated
 *     only when `_enableEdgeVisibility` is on. C-R8-EDGE-FBO Batch 44.
 *   - **Translucent tile classification framebuffer**
 *     (`WebGPUTranslucentTileClassification`): allocated lazily; small
 *     resources (1 depth + 1 packed-depth + 1 color, all
 *     single-sample). C-R8-TRANSLUCENT-TILE-CLASS Batch 47.
 *   - **Globe depth framebuffer** (`WebGPUGlobeDepth`): created when
 *     `useGlobeDepthFramebuffer && !_globeDepth`.
 *   - **Depth plane** (`WebGPUDepthPlane`): created when
 *     `useDepthPlane && !_depthPlane`. Routes through central
 *     pipeline cache (C-R7-RENDERER-MIGRATION Batch 56).
 *   - **Post-process pipeline** (`WebGPUPostProcessPipeline`): the
 *     ping-pong + tonemapping + FXAA + AutoExposure (HDR) chain that
 *     blits scene FB to canvas. Destroyed + rebuilt on HDR toggle so
 *     the ping-pong textures get the right format (Batch 110).
 *
 * Three triggers cause a recreate cycle:
 *
 *   1. Initial mount (`!_initialized`).
 *   2. Canvas resize (width/height changed).
 *   3. HDR toggle at runtime — Batch 109's gate. Without this, a
 *      same-resolution `scene.useHDR` flip would leave the scene
 *      framebuffer's color format stale and dependent textures (OIT,
 *      edge MRT, refraction, velocity) out of sync.
 *
 * Also subscribes once (per SceneRenderer lifetime) to
 * `context.onDeviceInvalidated` so all the framebuffers + caches get
 * dropped during device-loss recovery — next frame's
 * `_ensureResources` rebuilds them against the new device.
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
 * The SceneRenderer surface the resource-ensure helper reaches back
 * to. Every field here is read AND written — that's the whole point.
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

/** FAR-003 pure policy helper, exported for no-allocation regression tests. */
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

  // C-R12 (Batch 33) — subscribe once to device-invalidation events
  // so SceneRenderer-owned resources (scene framebuffer, OIT,
  // globeDepth, depth plane, post-process pipeline, debug overlays)
  // are dropped during recovery. Next frame's `_ensureResources`
  // rebuilds them against the new device.
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

      // C-R12-PER-OBJECT-CACHES (Batch 197) — extend the device-loss
      // recovery walk to per-Model / per-Collection / per-PostProcess
      // object caches. Subsystem-level caches (Bloom/AO/DoF/GodRays/
      // AutoExposure/scene FB) are wired via the registry above.
      // Per-object caches like `model._webgpuCache`,
      // `collection._webgpuCache`, `shadowMap._webgpuCache`, etc. typically
      // get rebuilt next frame via the owning feature renderer's destroy
      // + recreate flow — but a model that's been removed from primitives
      // mid-recovery would otherwise hold zombie handles to dead-device
      // resources. Belt-and-suspenders correctness: walk the scene now.
      clearPerObjectCaches(scene);
    });
  }

  const canvas: HTMLCanvasElement | OffscreenCanvas | undefined =
    context._canvas;
  const width = canvas?.width ?? 1;
  const height = canvas?.height ?? 1;
  const needsResize = width !== host._width || height !== host._height;
  const hdr = config.useHDR ?? false;
  // Batch 109 — HDR toggle gate. A runtime change to `scene.useHDR`
  // flips the scene-FB color format between `rgba16float` (or
  // `rg11b10ufloat`) and the canvas format. Without this gate the
  // outer `if (!_initialized || needsResize)` block below would
  // never fire on a same-resolution HDR toggle, leaving the
  // scene-FB's color format stale + the dependent textures (OIT
  // accumulation, edge MRT, refraction capture, velocity capture)
  // out of sync. Treat HDR change as equivalent to a resize for
  // gating purposes.
  const hdrChanged = host._lastHDR !== null && host._lastHDR !== hdr;
  const needsRecreate = !host._initialized || needsResize || hdrChanged;
  // C10-07 — capture the first-init edge before `host._initialized` is set at
  // the tail. The deterministic-boot prewarm fires exactly once, after the
  // scene-FB attachment formats have resolved (the site the C10-06 Step-C.2
  // deferral identified as where formats ARE known).
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
    // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — `_sceneFramebuffer.update`
    // destroys the old refraction texture (and view) on resize / HDR
    // toggle. Clear the published view on the context so the model
    // renderer doesn't try to bind it on the next frame; `null` here
    // makes the model bind-group rebuild fall through to the white
    // placeholder until the next capture pass publishes a new view.
    context._refractionSceneView = null;
  }
  // C-R8-INVERT-HDR (Batch 41) — keep `context._sceneColorFormat`
  // in sync with the scene framebuffer's actual color format. Feature
  // renderers (InvertClassification, OIT) read this so their own
  // texture allocations pick `rgba16float` when the scene is HDR and
  // the canvas format otherwise. Previously this field was declared
  // on the context but never assigned, leaving it stuck at the
  // default `"bgra8unorm"` and producing format mismatches when
  // scene-facing pipelines composited against HDR targets.
  const previousSceneColorFormat = context._sceneColorFormat;
  context._sceneColorFormat =
    host._sceneFramebuffer.colorFormat ?? context._sceneColorFormat;
  const sceneColorFormat: GPUTextureFormat =
    host._sceneFramebuffer.colorFormat ?? "bgra8unorm";

  // Slice 5c-B Batch 127 — wire scene-FB views onto context. Pre-fix:
  // `_sceneColorView` + `_depthStencilView` were declared on
  // WebGPUContext as `public X = null` and NEVER assigned anywhere
  // (verified via repo-wide grep 2026-05-25). Consumers (env effects,
  // translucent pass) read the always-null defaults and silently
  // skipped. Same "field declared but never assigned" pattern as
  // `_sceneColorFormat` above — both pre-dated this bug.
  //
  // Single-sample depth: `depthSampleableView` is the
  // single-sample-resolved view. MSAA case: `depthSampleableView` is
  // null and we leave `_depthStencilView` null too — env effects
  // continue to skip with MSAA on until Step 5 (MSAA depth resolve)
  // lands. Step 5 is gated on the env-effects target chain reorder
  // (Step 4) so single-sample is the right initial proof point.
  context._sceneColorView =
    host._sceneFramebuffer.colorTarget?.getColorTextureView?.(0) ?? null;
  // Slice 5c-B Batch 128 — `depthSampleableView` now returns the
  // resolved single-sample view in BOTH single-sample mode (existing
  // aspect view) and MSAA mode (new resolve target populated by
  // PostFrustumChain's resolveDepthMSAA dispatch). The Batch 127 gate
  // on `_msaaSamples === 1` is no longer needed — env effects + AO
  // + DoF work in default MSAA=4 scenes too.
  const _ctxWithDepth = context as unknown as {
    _depthStencilView: GPUTextureView | null;
  };
  _ctxWithDepth._depthStencilView =
    host._sceneFramebuffer.depthSampleableView ?? null;

  // Slice 5c-B Batch 129 — post-process snapshot texture. Allocated/
  // reallocated when the canvas size changes. Holds a copy of the
  // post-processed canvas content for env effects to sample as their
  // reflection/composite SOURCE. Canvas-sized + canvas-format so the
  // copyTextureToTexture dispatch in PostFrustumChain is layout-
  // compatible.
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
      // C11-60 — this is side A of the environmental-effects ping-pong graph.
      // It is copied from the canvas first, then may become a render target for
      // the second/fourth full-screen effect. Sampling and attachment use never
      // overlap in one pass because the compositor always selects the opposite
      // side as its target.
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

  // Batch 110 — bump the scene pipeline format generation when the
  // scene color format actually changes. Renderers caching pipelines
  // that target scene FB observe the bump and clear+rebuild their
  // local caches against the new `scenePipelineFormat`. Without this,
  // a runtime HDR toggle (rgba16float ↔ canvas format) leaves cached
  // pipelines pointing at the OLD format, producing validation
  // warnings + black scene-FB writes for sky / globe / model /
  // primitive draws.
  if (
    context._sceneColorFormat !== undefined &&
    context._sceneColorFormat !== previousSceneColorFormat
  ) {
    context._scenePipelineFormatGeneration += 1;
    // AUDIT_2026_05_02 B.20 — invalidate cached render bundles whose
    // baked pipeline formats no longer match the active scene FB.
    context.renderBundleManager?.invalidateAll?.();
  }

  // FAR-003: preserve the public Scene OIT request while independently
  // containing the unsafe native WebGPU MRT path. The alpha fallback in the
  // translucent pass remains complete when this gate is false.
  host._lastOITRequested = config.useOIT === true;
  const useContainedWebGPUOIT = shouldAllocateWebGPUOIT(
    host._lastOITRequested,
    host._webgpuOITEnabled,
  );
  if (useContainedWebGPUOIT && !host._oit) {
    host._oit = new WebGPUOIT(context);
  }
  if (useContainedWebGPUOIT && host._oit) {
    // Session 65 Batch 33 — pass MSAA sample count so the OIT
    // composite pipeline matches the scene FB's sample count when
    // the bridge re-enables. This intentionally runs every frame: the
    // renderer-level drift was already consumed by `prepareFrame`, while
    // WebGPUOIT.update is itself allocation-idempotent for an unchanged tuple.
    host._oit.update(device, width, height, numSamples);
  }

  // C-R8-EDGE-FBO (Batch 44) — edge MRT framebuffer. Allocated only
  // when the scene opts in via `_enableEdgeVisibility`; nothing
  // downstream looks at it otherwise, so idle scenes don't pay for
  // 3 color textures + depth-stencil. Lazy = first-touch, so if the
  // flag toggles on mid-session the next update() call allocates.
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

  // C-R8-TRANSLUCENT-TILE-CLASS (Batch 47) — translucent classification
  // framebuffer. Allocated lazily on first scene-init; resources are
  // small (one depth, one packed-depth, one color — all single-sample)
  // and the per-frame dispatch is gated on `hasTranslucentDepth` so
  // idle scenes pay only the allocation, not the per-frame work.
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

  // Batch 110 (in progress) — when HDR mode toggles at runtime, the
  // post-process pipeline's ping-pong textures (rgba16float ↔ canvas
  // format) and every stage's pipeline target format must rebuild.
  // The cheapest correct path is to destroy the whole pipeline and
  // let the first-init block below recreate it with the new HDR
  // setting + the matching stage chain (e.g., `addAutoExposure`
  // only fires in HDR mode).
  //
  // Detection: the pipeline tracks its own `_hdr` mode internally
  // and we compare against the new `hdr` argument. Skipped on
  // initial mount so the first-init block runs normally.
  if (
    host._postProcess &&
    (host._postProcess as unknown as { _hdr: boolean })._hdr !== hdr
  ) {
    host._postProcess.destroy();
    host._postProcess = null;
    // C11-174 — drop the context's cache-stats back-reference with the
    // pipeline (re-registered below if the pipeline is recreated).
    context._postProcessCacheStatsSource = null;
  }

  // Post-processing pipeline
  if (config.usePostProcess && !host._postProcess) {
    host._postProcess = new WebGPUPostProcessPipeline(context);
    // C11-174 — register the pipeline's bind-group cache-stats surface so
    // `WebGPUContext.getRendererStatistics()` can expose the counters
    // without importing the post-process pipeline graph.
    context._postProcessCacheStatsSource = host._postProcess;
    const canvasFormat: GPUTextureFormat =
      context.presentationFormat ?? "bgra8unorm";
    // HDR pipeline fix: when `scene.highDynamicRange=true`, the
    // ping-pong textures use `rgba16float` so the full dynamic range
    // from the scene framebuffer survives through bloom / tonemapping
    // / color grading. Only the final blit down-casts to the canvas
    // swap chain format (bgra8unorm). Without this, every post-process
    // stage was silently clamping HDR values to [0,1] and tonemapping
    // was a mathematical no-op.
    host._postProcess.initialize(device, width, height, canvasFormat, hdr);
    // Add default stages
    // Phase 5 WGF-3 / PARITY-F16-POSTPROCESS: resolve the f16 opt-in
    // once, double-gated like the multi-pass effects — the opt-in flag
    // AND the device actually granting `shader-f16`. Single-gating on
    // the flag alone made a non-granting device rely on the async
    // _compileStage fallback; the double gate selects f32 up front.
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
    // TAA is added lazily when scene.taaEnabled = true (not default) —
    // the lazy-add lives in `configureWebGPUPostProcessPipeline` below,
    // gated on the live `pipeline.taaEffect` slot (Batch 244,
    // NEW-TAA-EFFECT-NEVER-ADDED; this comment used to describe a
    // lazy-add that didn't exist anywhere).
    host._postProcess.addFXAA(device, canvasFormat, useShaderF16);
    // AUDIT_2026_05_02 B.14 — auto-exposure was previously gated behind
    // `if (hdr)` only, but SDR scenes still need adaptive exposure for
    // day/night cycles (the moon → sun → night transition can take
    // luminance from 1.0 → ~0.001 over a clock advance and an SDR
    // viewer with `enableMoonLight = true` would go fully black with
    // no recovery). Always-on autoexposure is cheap (one compute pass)
    // and lets the tone-mapper see a useful exposure value regardless
    // of HDR vs SDR.
    //
    // C-R7-COMPUTE-PIPELINE-CACHE (Batch 76) — pipe the central
    // compute pipeline cache through so AutoExposure routes its two
    // pipeline creations through it.
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

  // C10-07-ASYNC-MODEL-PIPELINES / NEW-WEBGPU-BOOT-DETERMINISTIC-PIPELINE-PREWARM
  // — kick the deterministic-boot render-pipeline set's async compile as soon
  // as the scene-FB attachment formats resolve (this step). Fire-and-forget:
  // never awaited, never blocks the frame, no-op on failure.
  if (firstInit) {
    prewarmDeterministicPipelines(host, config);
  }
}

/**
 * C10-07 — the deterministic-boot pipeline prewarm the C10-06 Step-C.2 deferral
 * (`NEW-WEBGPU-BOOT-DETERMINISTIC-PIPELINE-PREWARM`) left for this slice. It
 * runs once, at the first `ensureResources`, where the scene-FB
 * color/depth/sampleCount are already known — the exact precondition the
 * deferral required and that context `_initialize` could not satisfy.
 *
 * It routes the deterministic pipelines that resolve through the central async
 * cache to `WebGPURenderPipelineCache.warm()` / `preloadBatch()` — the
 * previously-0-caller preload machinery (S8-1 "built and never wired"). Today
 * the depth plane is the eligible deterministic renderer already migrated to
 * the central cache; it self-warms in `initialize`, so this call is idempotent
 * for it (the cache dedupes cached/pending keys) and confirms the deterministic
 * set is compiled-ahead of the frame's draw. The remaining SYNC deterministic
 * pipelines (SkyAtmosphere, GlobeDepth depth-copy, PostProcess
 * identity/tonemap/FXAA) still resolve through private `device.createRenderPipeline`
 * calls and must be migrated to the central cache per-renderer (guide H5 Step-4)
 * before they can register here — tracked as the immediate follow-on.
 *
 * Fire-and-forget (INV-06-2 / T-06-b): never awaited. A throw never escapes
 * `ensureResources`.
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

    // Observable counter (read by probe-c10-07 / boot prewarm probes) proving
    // the hook fired at the resources-ready step before the frame's draw.
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
 * C-R12-PER-OBJECT-CACHES (Batch 197) — clears the `_webgpuCache` slot
 * on per-object owners reachable from the scene (primitives,
 * collections, shadow map, post-process stages). Called from the
 * device-invalidation event handler in `ensureResources` so any
 * orphan-but-still-reachable caches drop their stale GPU handles
 * during recovery.
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
        // Defensive: a child throwing during cache clear shouldn't
        // block the rest of the walk. The next render tick will
        // re-discover and clean up via the owning FR.
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
