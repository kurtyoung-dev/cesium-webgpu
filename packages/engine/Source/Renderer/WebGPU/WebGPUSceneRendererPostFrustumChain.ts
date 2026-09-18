/**
 * Runs the tail of `WebGPUSceneRenderer.executeCommands` after the
 * per-frustum loop has finished.
 *
 * Tail of the frame, after the per-frustum loop closes:
 *
 *   - The overlay pass, which runs once rather than per frustum.
 *   - Depth plane render (when `!clearGlobeDepth`).
 *   - Screen-space normal reconstruction and invert-classification
 *     compositing after scene depth and color are final.
 *   - The velocity pass, which collects `cmd.velocityCommand` from the model
 *     renderer when `frameState.taaEnabled === true`.
 *   - Post-processing, which is the WebGPU path that blits the scene
 *     framebuffer to the canvas.
 *   - Environmental effects composited over the post-processed canvas.
 *   - Reset of `context._sceneHasTransmission` after every consumer has read
 *     the signal established during scene update.
 * Performance finalization runs from `WebGPUContext.endFrame()` after every
 * render pass has ended and immediately before the command encoder finishes.
 *
 * @module WebGPUSceneRendererPostFrustumChain
 */

import type { WebGPUContext } from "./WebGPUContext.js";
import FeatureRendererKey from "../FeatureRendererKey.js";
import type { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";
import type { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";
import { hasEnvironmentalEffectDemand } from "./WebGPUSceneRendererEnvironmentDemand.js";
import {
  invalidateCloudFrameMask,
  reportCloudLifecycleError,
} from "./WebGPUProceduralCloudRenderer.js";
import {
  beginResolvedCloudFrameAttempt,
  finishResolvedCloudFrameAttempt,
  isPreparedCloudFrameOutcome,
  publishResolvedCloudFrameIbl,
  resolveCloudFramePlan,
  type CloudFrameNegativeReason,
  type CloudFrameOutcomeNegativeReason,
  type CloudFramePreparationOutcome,
  type EnvironmentalCloudFrameOutcome,
  type ProceduralCloudFrameRenderer,
  type ResolvedCloudFramePlan,
} from "./WebGPUSceneRendererEnvironmentalEffects.js";

/** SceneRenderer surface the post-frustum chain reaches back to. */
export interface PostFrustumChainHost {
  // State read by the chain.
  _postProcess: WebGPUPostProcessPipeline | null;
  _sceneFramebuffer: WebGPUSceneFramebuffer | null;
  // Production builds elide this log-once guard and all of its accesses.
  _ppDebugLogged: boolean;

  // Operations supplied by the owning renderer.
  _executeOverlayPass(
    frustumCommandsList: CesiumFrustumCommands[],
    config: WebGPURenderFrameConfig,
  ): void;
  _renderDepthPlane(
    config: WebGPURenderFrameConfig,
    passKind: "scene" | "pick",
  ): void;
  _executeEnvironmentalEffects(
    config: WebGPURenderFrameConfig,
    cloudFrame: EnvironmentalCloudFrameOutcome,
  ): void;
  // Reconstructs screen-space normals after the scene pass closes and before
  // invert-classification compositing. It is a no-op unless
  // `frameState.useDeferredLighting` is true.
  _executeGBufferProducer(config: WebGPURenderFrameConfig): void;
  _runInvertClassificationComposite(config: WebGPURenderFrameConfig): void;
  _runVelocityPass(config: WebGPURenderFrameConfig): void;
  // Draws red wireframes for commands with `debugShowBoundingVolume`. It opens
  // no pass when no command is flagged, leaving ordinary frames unchanged.
  _executeBoundingVolumeDebugPass(config: WebGPURenderFrameConfig): void;
  _runPostProcessing(config: WebGPURenderFrameConfig): void;
  // Resolves multisampled scene color only when a consumer needs it.
  _ensureSceneColorResolved(context: WebGPUContext): void;
}

function asCloudFramePreparationOutcome(
  value: unknown,
): CloudFramePreparationOutcome | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const outcome = value as Partial<CloudFramePreparationOutcome>;
  if (
    (outcome.kind !== "prepared" && outcome.kind !== "negative") ||
    !outcome.plan
  ) {
    return null;
  }
  return outcome as CloudFramePreparationOutcome;
}

function finishCloudFrameAttempt(
  attempt: unknown,
  reason: CloudFrameNegativeReason,
): CloudFramePreparationOutcome | null {
  return asCloudFramePreparationOutcome(
    finishResolvedCloudFrameAttempt(attempt, reason),
  );
}

function createCloudFrameOutcome(
  plan: ResolvedCloudFramePlan,
  renderer: ProceduralCloudFrameRenderer | null,
  preparation: CloudFramePreparationOutcome | null,
  negativeReason: CloudFrameOutcomeNegativeReason | null,
  displaySnapshotView: GPUTextureView | null = null,
): EnvironmentalCloudFrameOutcome {
  return Object.freeze({
    plan,
    renderer,
    preparation,
    negativeReason,
    displaySnapshotView,
  });
}

/**
 * Runs the post-frustum tail of the frame. The caller is responsible for
 * completing the per-frustum loop first.
 *
 * @param host - The owning SceneRenderer.
 * @param context - The active WebGPU context (for the
 *   `_sceneHasTransmission` reset).
 * @param config - Render-frame config from `executeCommands`.
 * @param frustumCommandsList - The per-frustum command buckets the
 *   overlay pass reads.
 */
export function executePostFrustumChain(
  host: PostFrustumChainHost,
  context: WebGPUContext,
  config: WebGPURenderFrameConfig,
  frustumCommandsList: CesiumFrustumCommands[],
): void {
  // The overlay pass runs once rather than once per frustum.
  host._executeOverlayPass(frustumCommandsList, config);

  // The depth plane renders after all frustums.
  if (!config.clearGlobeDepth) {
    host._renderDepthPlane(config, "scene");
  }

  // Single-sample depth is already sampleable, so its resolve is a no-op.
  // Multisampled depth is copied from sample zero by a fullscreen pass into a
  // single-sample `r16float` target used by ambient occlusion, depth of field,
  // and environmental effects.
  //
  // The resolve runs after the scene and globe-depth passes commit depth, and
  // before post-processing or environmental effects read it.
  const _ssceneFB = host._sceneFramebuffer as unknown as {
    resolveDepthMSAA?: (encoder: GPUCommandEncoder) => void;
  } | null;
  const _ssEncoder = (
    context as unknown as { _currentCommandEncoder?: GPUCommandEncoder }
  )._currentCommandEncoder;
  if (_ssceneFB?.resolveDepthMSAA && _ssEncoder) {
    // A new resolve pass cannot be recorded while another render pass owns
    // the encoder. Downstream stages open the pass they need afterwards.
    context.endCurrentRenderPass?.();
    _ssceneFB.resolveDepthMSAA(_ssEncoder);
  }

  // Screen-space normal reconstruction needs final, readable scene depth, so
  // it runs after the scene pass closes. The wrapper returns immediately when
  // deferred lighting is disabled. Consumers read the resulting
  // `view.gBufferFramebuffer.normalRoughnessTexture` after this dispatch.
  host._executeGBufferProducer(config);

  // Model edges composite inline in the model fragment shader through
  // `applyEdgeOverlay()`. Primitive shaders do not emit edges, so the edge MRT
  // views remain available to the inline stage without a separate
  // post-process composite here.

  // The depth-sample classifier draws directly into scene color during the
  // per-frustum tile-classification pass. It therefore has no accumulation
  // target that needs a separate composite in this chain.

  // Invert-classification targets the single-sample resolved scene color. It
  // must run after the main scene pass ends and before tonemapping and FXAA so
  // the post-process chain sees the classified pixels.
  host._runInvertClassificationComposite(config);

  // The velocity pass collects `cmd.velocityCommand` entries into a dedicated
  // `rg16float` target while sharing scene depth read-only. It runs after scene
  // depth is committed and before temporal antialiasing reads `motionTex`. A
  // frame with no velocity commands queues no work.
  host._runVelocityPass(config);

  // Bounding-volume wireframes draw into resolved scene color after the main
  // pass closes and before post-processing blits it to the canvas. The method
  // opens no pass when no command is flagged.
  host._executeBoundingVolumeDebugPass(config);

  // Post-processing always reads the single-sample scene-color view and is the
  // WebGPU path that reaches the canvas. Resolving here keeps the default path
  // to one resolve after the frustum loop. The call is inert without
  // multisampling and when an earlier consumer already resolved the current
  // contents; omitting it would leave multisampled frames black.
  host._ensureSceneColorResolved(context);

  // Clear publication before request resolution or a starting lazy lookup. A
  // skipped, cold, failed, or culled attempt must never expose the prior mask.
  const godRayEffect = host._postProcess?.godRayEffect;
  godRayEffect?.setCloudTransmittanceView(null);
  invalidateCloudFrameMask(context);

  // `scene.godRayCloudAware` is the application-set opt-in for cloud-aware god
  // rays; the engine deliberately writes it nowhere — the application is its
  // only producer. It is declared on `CesiumScene` (cesium-js-types.d.ts) so this
  // read is typed rather than an `as unknown as {…}` expando. Unset, the
  // expression is false and the cloud mask is never requested.
  const cloudAwareRequested =
    godRayEffect?.enabled === true && config.scene.godRayCloudAware === true;
  const cloudPlan = resolveCloudFramePlan(config, cloudAwareRequested);
  let cloudAttempt: unknown = null;
  let cloudAttemptFailed = false;
  if (cloudPlan.active) {
    try {
      cloudAttempt = beginResolvedCloudFrameAttempt(config, cloudPlan);
    } catch (error: unknown) {
      cloudAttemptFailed = true;
      reportCloudLifecycleError(
        context,
        "Procedural cloud attempt failed.",
        error,
      );
    }
  }
  publishResolvedCloudFrameIbl(config, cloudPlan);

  let cloudRenderer: ProceduralCloudFrameRenderer | null = null;
  let cloudPreparation: CloudFramePreparationOutcome | null = null;
  let cloudNegativeReason: CloudFrameOutcomeNegativeReason | null =
    cloudPlan.active ? null : "inactive";

  if (cloudAttemptFailed) {
    cloudNegativeReason = "preparation-failed";
  } else if (cloudPlan.active && !context.device) {
    cloudNegativeReason = "missing-device";
    cloudPreparation = finishCloudFrameAttempt(
      cloudAttempt,
      cloudNegativeReason,
    );
  } else if (cloudPlan.active && !context._currentCommandEncoder) {
    cloudNegativeReason = "missing-encoder";
    cloudPreparation = finishCloudFrameAttempt(
      cloudAttempt,
      cloudNegativeReason,
    );
  } else if (cloudPlan.active && !context._sceneColorView) {
    cloudNegativeReason = "missing-raw-color";
    cloudPreparation = finishCloudFrameAttempt(
      cloudAttempt,
      cloudNegativeReason,
    );
  } else if (cloudPlan.active && !context._depthStencilView) {
    cloudNegativeReason = "missing-depth";
    cloudPreparation = finishCloudFrameAttempt(
      cloudAttempt,
      cloudNegativeReason,
    );
  } else if (cloudPlan.active) {
    const readiness = context.getFeatureRendererReadiness(
      FeatureRendererKey.PROCEDURAL_CLOUDS,
    );
    if (readiness.kind === "ready") {
      const renderer = readiness.renderer as ProceduralCloudFrameRenderer;
      if (renderer.prepareCloudFrameAndEncodeMask) {
        cloudRenderer = renderer;
        try {
          cloudPreparation = asCloudFramePreparationOutcome(
            renderer.prepareCloudFrameAndEncodeMask(
              context,
              config.scene._frameState,
              cloudAttempt,
              context._sceneColorView,
              context._depthStencilView,
              cloudPlan.config!,
              cloudPlan.captureRequested,
            ),
          );
          if (cloudPreparation?.kind === "negative") {
            cloudNegativeReason =
              cloudPreparation.reason ?? "resource-not-ready";
          } else if (cloudPreparation?.kind === "prepared") {
            cloudNegativeReason = null;
          } else {
            cloudNegativeReason = "resource-not-ready";
            cloudPreparation = finishCloudFrameAttempt(
              cloudAttempt,
              "resource-not-ready",
            );
          }
        } catch (error: unknown) {
          cloudNegativeReason = "preparation-failed";
          reportCloudLifecycleError(
            context,
            "Procedural cloud preparation failed.",
            error,
          );
          try {
            cloudPreparation = finishCloudFrameAttempt(
              cloudAttempt,
              "resource-not-ready",
            );
          } catch (finalizationError: unknown) {
            reportCloudLifecycleError(
              context,
              "Procedural cloud preparation finalization failed.",
              finalizationError,
            );
          }
        }
      } else {
        cloudNegativeReason = "feature-not-ready";
        cloudPreparation = finishCloudFrameAttempt(
          cloudAttempt,
          cloudNegativeReason,
        );
      }
    } else {
      cloudNegativeReason = "feature-not-ready";
      cloudPreparation = finishCloudFrameAttempt(
        cloudAttempt,
        cloudNegativeReason,
      );
    }
  }

  let cloudFrame = createCloudFrameOutcome(
    cloudPlan,
    cloudRenderer,
    cloudPreparation,
    cloudNegativeReason,
  );
  try {
    if (cloudPlan.captureRequested && isPreparedCloudFrameOutcome(cloudFrame)) {
      godRayEffect?.setCloudTransmittanceView(cloudPreparation!.maskView);
    }

    // Post-processing performs tonemapping, FXAA, and the required
    // scene-to-canvas blit.
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
    if (cloudRenderer?.completePreparedCloudMask && cloudPreparation) {
      cloudRenderer.completePreparedCloudMask(cloudPreparation);
    }

    // Full-screen environmental stages consume only a snapshot copied from
    // this frame's post-processed canvas. A prepared cloud keeps demand alive
    // after its user request has been consumed above.
    const preparedLateVisibleCandidate =
      isPreparedCloudFrameOutcome(cloudFrame);
    const _anyEnvEffectEnabled =
      hasEnvironmentalEffectDemand(config.scene, context) ||
      preparedLateVisibleCandidate;
    const _ppCtx = context as unknown as {
      _currentCommandEncoder?: GPUCommandEncoder | null;
      _postProcessSnapshotTexture?: GPUTexture | null;
      _postProcessSnapshotView?: GPUTextureView | null;
      _postProcessSnapshotWidth?: number;
      _postProcessSnapshotHeight?: number;
    };
    const ppEncoder = _ppCtx._currentCommandEncoder;
    const ppSnapshot = _ppCtx._postProcessSnapshotTexture;
    let copiedSnapshotView: GPUTextureView | null = null;
    if (
      _anyEnvEffectEnabled &&
      ppEncoder &&
      ppSnapshot &&
      _ppCtx._postProcessSnapshotView &&
      (_ppCtx._postProcessSnapshotWidth ?? 0) > 0 &&
      (_ppCtx._postProcessSnapshotHeight ?? 0) > 0
    ) {
      // Texture copies cannot be encoded while a render pass is active.
      context.endCurrentRenderPass?.();
      const canvasTex = (
        context as unknown as {
          _context?: { getCurrentTexture: () => GPUTexture };
        }
      )._context?.getCurrentTexture();
      if (canvasTex) {
        try {
          ppEncoder.copyTextureToTexture(
            { texture: canvasTex },
            { texture: ppSnapshot },
            {
              width: _ppCtx._postProcessSnapshotWidth!,
              height: _ppCtx._postProcessSnapshotHeight!,
              depthOrArrayLayers: 1,
            },
          );
          copiedSnapshotView = _ppCtx._postProcessSnapshotView;
        } catch (error: unknown) {
          reportCloudLifecycleError(
            context,
            "Environmental snapshot copy failed.",
            error,
          );
        }
      }
    }

    cloudFrame = createCloudFrameOutcome(
      cloudPlan,
      cloudRenderer,
      cloudPreparation,
      cloudNegativeReason,
      copiedSnapshotView,
    );

    // Environmental effects run after post-processing so their canvas writes
    // composite over, rather than get overwritten by, the scene-color blit.
    host._executeEnvironmentalEffects(config, cloudFrame);
  } finally {
    if (cloudRenderer?.cancelPreparedCloudFrame && cloudPreparation) {
      try {
        cloudRenderer.cancelPreparedCloudFrame(cloudPreparation);
      } catch (error: unknown) {
        reportCloudLifecycleError(
          context,
          "Procedural cloud finalization failed.",
          error,
        );
      }
    }

    // The model renderer publishes transmission demand during scene update.
    // Clear it only after all per-frustum captures have consumed it.
    context._sceneHasTransmission = false;
  }
}
