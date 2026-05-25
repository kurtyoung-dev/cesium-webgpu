/**
 * Post-frustum chain extracted from
 * `WebGPUSceneRenderer.executeCommands`.
 *
 * Batch 141 of the audit-recommended SceneRenderer decomposition —
 * Slice D (final slice) of the executeCommands four-slice plan
 * (see `migration_doc/BATCH_138_PLAN_EXECUTE_COMMANDS_SLICE_PLAN.md`).
 *
 * Tail of the frame, after the per-frustum loop closes:
 *
 *   - Pass 12 OVERLAY (runs once, not per-frustum).
 *   - Depth plane render (when `!clearGlobeDepth`).
 *   - Environmental effects (clouds, SSR, weather, volumetric fog —
 *     extracted in Batch 134, called here via the wrapper).
 *   - InvertClassification composite (Batch 39 — back-onto-scene-color
 *     after the main scene pass ends + resolves).
 *   - Velocity pass (Batch 106 / TAA Slice 2e — collects
 *     `cmd.velocityCommand` from the model renderer when
 *     `frameState.taaEnabled === true`).
 *   - Post-processing (REQUIRED on WebGPU — blits the scene
 *     framebuffer to the canvas).
 *   - `context._sceneHasTransmission = false` (Batch 107 cleanup —
 *     model renderer sets it during `update()`, we reset at frame
 *     end so next frame's `update()` starts clean).
 *   - `perfManager.endFrame()` (flushes indirect draws + collects
 *     profiling counters; pairs with `beginFrame()` at the top of
 *     executeCommands).
 *
 * @module WebGPUSceneRendererPostFrustumChain
 */

import type { WebGPUContext } from "./WebGPUContext.js";
import type { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";
import type { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";

/** SceneRenderer surface the post-frustum chain reaches back to. */
export interface PostFrustumChainHost {
  // Field reads
  _postProcess: WebGPUPostProcessPipeline | null;
  _sceneFramebuffer: WebGPUSceneFramebuffer | null;
  // Pragma-stripped log-once guard (production builds elide both the
  // declaration and reads/writes here)
  _ppDebugLogged: boolean;

  // Method callbacks
  _executeOverlayPass(
    frustumCommandsList: CesiumFrustumCommands[],
    config: WebGPURenderFrameConfig,
  ): void;
  _renderDepthPlane(config: WebGPURenderFrameConfig): void;
  _executeEnvironmentalEffects(config: WebGPURenderFrameConfig): void;
  // Phase 8a Slice 2 (Batch 85) — screen-space normal reconstruction.
  // Runs after the scene render pass closes (post environmentalEffects)
  // and before the InvertClassification composite. Gated on
  // `frameState.useDeferredLighting`; no-op when the flag is false
  // (default).
  _executeGBufferProducer(config: WebGPURenderFrameConfig): void;
  _runInvertClassificationComposite(config: WebGPURenderFrameConfig): void;
  _runVelocityPass(config: WebGPURenderFrameConfig): void;
  _runPostProcessing(config: WebGPURenderFrameConfig): void;
}

/** Light-typed surface for the perfManager bookkeeping pair. */
export interface PerfManagerLike {
  endFrame(): void;
}

/**
 * Run the post-frustum tail of the frame. Caller (`executeCommands`
 * on the SceneRenderer) is responsible for the per-frustum loop
 * (Slice C / Batch 140) — this picks up immediately after.
 *
 * @param host - The owning SceneRenderer.
 * @param context - The active WebGPU context (for the
 *   `_sceneHasTransmission` reset).
 * @param config - Render-frame config from `executeCommands`.
 * @param frustumCommandsList - The per-frustum command buckets the
 *   overlay pass reads.
 * @param perfManager - Optional performance manager. Caller passes
 *   the same instance whose `beginFrame()` it called earlier; this
 *   helper invokes `endFrame()`.
 */
export function executePostFrustumChain(
  host: PostFrustumChainHost,
  context: WebGPUContext,
  config: WebGPURenderFrameConfig,
  frustumCommandsList: CesiumFrustumCommands[],
  perfManager: PerfManagerLike | null | undefined,
): void {
  // Pass 12: OVERLAY (runs once, not per-frustum)
  host._executeOverlayPass(frustumCommandsList, config);

  // Depth plane (if enabled, renders after all frustums)
  if (!config.clearGlobeDepth) {
    host._renderDepthPlane(config);
  }

  // Slice 5c-B Batch 127 — `_executeEnvironmentalEffects` MOVED to
  // AFTER `_runPostProcessing` (~L162). Pre-Batch-127 env effects ran
  // here and wrote to `outputView = context.currentTextureView`, then
  // post-process blitted the scene FB color over the canvas and
  // stomped their output. Pre-Batch-127 the env effects chain was
  // ALSO silently skipping due to the `_depthStencilView = null` bug
  // (fixed in Batch 127 Step 1). With both bugs addressed, env
  // effects run + their writes composite over the post-processed
  // canvas via `loadOp="load"`. See PostFrustumChain Batch 127 long
  // comment at the new call site for the full reasoning.

  // Phase 8a Slice 2 (Batch 85) — G-buffer producer. Screen-space
  // normal reconstruction from scene depth. The scene render pass has
  // closed by this point (environmentalEffects runs full-screen
  // composites which require the scene pass to be closed), so depth
  // is final and readable by compute. Gated on
  // `frameState.useDeferredLighting`; the wrapper returns immediately
  // when the flag is false (the default). Slice 3+ wire SSAO/SSR to
  // read from `view.gBufferFramebuffer.normalRoughnessTexture` after
  // this dispatch completes.
  host._executeGBufferProducer(config);

  // C-R8-EDGE-COMPOSITE-PRUNE (Batch 50) — post-process edge composite
  // retired. Model edges now composite inline inside Model FS via
  // `applyEdgeOverlay()` (Batch 48); primitive shaders don't currently
  // emit edges. The edge MRT views are still produced (model emitter
  // runs into the edge FBO) and remain readable from
  // `context._edge*View` for the inline stage. No call here.

  // Migration Session 5 (Batch 85) — Batch 47's composite call removed.
  // The depth-sample classifier (ADR-2026-04-28) draws directly into
  // scene color during the per-frustum CESIUM_3D_TILE_CLASSIFICATION
  // pass, so there is no separate accumulation target to composite
  // back. The accumulation-FBO + composite pipeline scaffolding in
  // WebGPUTranslucentTileClassification was retired in this batch.

  // C-R8-INVERT-CLASS-FBO-REDIRECT (Batch 39) — Composite the
  // InvertClassification classified texture back onto scene color.
  // Runs AFTER the main scene pass ends + resolves (so the target
  // is the single-sample resolved view the composite pipeline is
  // built for) and BEFORE post-processing (so the tonemap/FXAA
  // chain sees the composited scene).
  host._runInvertClassificationComposite(config);

  // TAA Slice 2e (Batch 106) — velocity pass for per-pixel motion
  // vectors. Walks the frustum command lists, collects any
  // `cmd.velocityCommand` (attached by the model renderer when
  // `frameState.taaEnabled === true`), and dispatches them into a
  // dedicated single-target rg16float render pass that shares scene
  // depth read-only. Skipped entirely when no command carries a
  // velocity slot — static scenes / TAA-off frames pay zero cost.
  // Must run AFTER the main scene pass closes (so the depth values
  // are committed) and BEFORE post-process consumes the velocity
  // texture in TAA's `motionTex` binding (Batch 104).
  host._runVelocityPass(config);

  // Post-processing (tonemapping, FXAA, etc.)
  // On WebGPU this is REQUIRED to blit the scene framebuffer to canvas.
  //>>includeStart('debug', pragmas.debug);
  if (!host._ppDebugLogged) {
    host._ppDebugLogged = true;
    console.log(
      `[WebGPU:PostProcess] _runPostProcessing entering: ` +
        `usePostProcess=${config.usePostProcess} ` +
        `_postProcess=${!!host._postProcess} ` +
        `sceneFramebuffer=${!!host._sceneFramebuffer}`,
    );
  }
  //>>includeEnd('debug');
  host._runPostProcessing(config);

  // Slice 5c-B Batch 127 — environmental effects (NPR outlines, SSR,
  // Procedural Clouds, Weather particles, Volumetric Fog). Runs AFTER
  // post-process so their canvas writes composite ON TOP of the
  // post-processed scene color, NOT under it. Pre-fix env effects ran
  // before post-process and wrote to canvas; the post-process blit
  // overwrote their contribution. Post-fix the env effects' write
  // landed on canvas survives to the next frame's present.
  //
  // Color-space note: env effects sample `_sceneColorView` (raw HDR
  // pre-postprocess) for their SOURCE reads (e.g. SSR's reflection
  // source). Their WRITES land on the canvas which already carries
  // the tonemapped + FXAA'd display-space scene. The mismatch is
  // acceptable for the current use cases (NPR edges, SSR overlay,
  // cloud composite) where the WRITE color is computed in
  // display-space anyway (edge color is RGBA8-ish, cloud color is
  // pre-toned). A future batch can re-route SSR's reflection
  // compositing to also use the post-processed scene color as source
  // for color-space consistency.
  host._executeEnvironmentalEffects(config);

  // C-R4-GLTF-KHR-TRANSMISSION (Batch 107) — clear the per-frame
  // transmission signal at the END of executeCommands. The model
  // renderer sets this to `true` during `update()` (which runs
  // BEFORE executeCommands as part of scene update), so resetting
  // at the start would clobber it before the per-frustum capture
  // step gets to read it. Resetting here means next frame's
  // `update()` starts with a clean slate; if no model declares
  // transmission, the capture step early-exits.
  context._sceneHasTransmission = false;

  // Performance infrastructure: end frame — flush indirect draws, collect profiling
  if (perfManager) {
    perfManager.endFrame();
  }
}
