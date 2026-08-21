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
import type { WebGPUPostProcessPipeline } from "./WebGPUPostProcessPipeline.js";
import type { WebGPUSceneFramebuffer } from "./WebGPUSceneFramebuffer.js";
import type { WebGPURenderFrameConfig } from "./WebGPUSceneRenderer.js";
import { hasEnvironmentalEffectDemand } from "./WebGPUSceneRendererEnvironmentDemand.js";

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
  _executeEnvironmentalEffects(config: WebGPURenderFrameConfig): void;
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

  // Post-processing performs tonemapping, FXAA, and the required scene-to-canvas blit.
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

  // Environmental effects need a display-space reflection source after
  // tonemapping and FXAA. Snapshotting the canvas avoids reading and writing
  // the same WebGPU texture in one render pass, without requiring a
  // dual-buffered swap chain or another accumulation target. The full-screen
  // copy is skipped unless an effect will consume it.
  //
  // Demand includes pending work from a user-owned volumetric
  // `CloudCollection`, not only the managed default collection, matching the
  // empty-frustum scheduler's non-consuming query.
  const _anyEnvEffectEnabled = hasEnvironmentalEffectDemand(
    config.scene,
    context,
  );
  const _ppCtx = context as unknown as {
    _currentTextureView?: GPUTextureView | null;
    _currentCommandEncoder?: GPUCommandEncoder | null;
    _postProcessSnapshotTexture?: GPUTexture | null;
    _postProcessSnapshotWidth?: number;
    _postProcessSnapshotHeight?: number;
    getCurrentTexture?: () => GPUTexture | null;
  };
  const ppEncoder = _ppCtx._currentCommandEncoder;
  const ppSnapshot = _ppCtx._postProcessSnapshotTexture;
  if (_anyEnvEffectEnabled && ppEncoder && ppSnapshot) {
    // Texture copies cannot be encoded while a render pass is active.
    context.endCurrentRenderPass?.();
    const canvasTex = (
      context as unknown as {
        _context?: { getCurrentTexture: () => GPUTexture };
      }
    )._context?.getCurrentTexture();
    if (canvasTex) {
      ppEncoder.copyTextureToTexture(
        { texture: canvasTex },
        { texture: ppSnapshot },
        {
          width: _ppCtx._postProcessSnapshotWidth!,
          height: _ppCtx._postProcessSnapshotHeight!,
          depthOrArrayLayers: 1,
        },
      );
    }
  }

  // Environmental effects run after post-processing so their canvas writes
  // composite over, rather than get overwritten by, the scene-color blit.
  // Effects that still sample `_sceneColorView` read raw HDR scene color while
  // writing display-space output over the tonemapped canvas. This is suitable
  // for the current edge, reflection-overlay, and cloud composites because
  // their output colors are already display-space values. A reflection path
  // that needs strict color-space consistency must instead sample the
  // post-processed snapshot.
  host._executeEnvironmentalEffects(config);

  // The model renderer publishes transmission demand during scene update.
  // Clear it only after all per-frustum captures have consumed it; clearing it
  // at frame start would erase the current frame's signal. The next update
  // then begins clean, and frames without transmissive models skip capture.
  context._sceneHasTransmission = false;
}
