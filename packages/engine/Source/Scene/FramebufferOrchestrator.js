import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import PixelDatatype from "../Renderer/PixelDatatype.js";
import SunPostProcess from "./SunPostProcess.js";

/**
 * FBO lifecycle management: setup, clear, and resolve for globe depth,
 * OIT, post-processing, sun bloom, invert classification, and globe translucency.
 *
 * Extracted from Scene.js (Phase 4 of decomposition plan).
 * @private
 */

/**
 * Update and clear all framebuffers needed for the current frame.
 * Handles globe depth, OIT, post-process, sun bloom, invert classification,
 * edge visibility, and globe translucency framebuffers.
 *
 * @param {Scene} scene
 * @param {PassState} passState
 * @param {Color} clearColor
 * @private
 */
function updateAndClearFramebuffers(scene, passState, clearColor) {
  const context = scene._context;
  const frameState = scene._frameState;
  const environmentState = scene._environmentState;
  const view = scene._view;

  if (context.updateAndClearFramebuffers(scene, passState, clearColor)) {
    return;
  }

  const passes = frameState.passes;
  const picking = passes.pick || passes.pickVoxel;
  if (defined(view.globeDepth)) {
    view.globeDepth.picking = picking;
    view.globeDepth.snapping = passes.snap;
  }
  const useWebVR = environmentState.useWebVR;

  environmentState.originalFramebuffer = passState.framebuffer;

  // `SunPostProcess` is a WebGL-only post-process pipeline. The WebGPU scene
  // renderer never invokes it (sun bloom on WebGPU lives inside
  // `WebGPUPostProcessPipeline` / Bloom or LensFlare). Without this guard,
  // every WebGPU viewer with `scene.sunBloom = true` would allocate a
  // `SunPostProcess` instance that is never used, leaking the WebGL
  // framebuffer + shader resources on each toggle.
  //
  // Gated on the capability getter `supportsLegacySunBloom` (true on WebGL,
  // false on WebGPU) rather than on `isWebGPU`, so external code branches on
  // capability rather than backend identity.
  const supportsLegacySunBloom = context?.supportsLegacySunBloom !== false;
  // The datatype `SunPostProcess` must be built with. Resolved the same way
  // `SceneFramebuffer.update` resolves its own, because the scene renders
  // into that pipeline's framebuffer whenever sun bloom is on: an 8-bit
  // choice here clamps the whole HDR frame (see the constructor's vacuity
  // note). Fixed at construction, so a `highDynamicRange` flip has to
  // reconstruct — which is what the second block below does.
  const sunBloomPixelDatatype = scene._hdr
    ? context.halfFloatingPointTexture
      ? PixelDatatype.HALF_FLOAT
      : PixelDatatype.FLOAT
    : PixelDatatype.UNSIGNED_BYTE;
  if (defined(scene.sun) && scene.sunBloom !== scene._sunBloom) {
    if (scene.sunBloom && !useWebVR && supportsLegacySunBloom) {
      scene._sunPostProcess = new SunPostProcess(sunBloomPixelDatatype);
    } else if (defined(scene._sunPostProcess)) {
      scene._sunPostProcess = scene._sunPostProcess.destroy();
    }

    scene._sunBloom = scene.sunBloom;
  } else if (!defined(scene.sun) && defined(scene._sunPostProcess)) {
    scene._sunPostProcess = scene._sunPostProcess.destroy();
    scene._sunBloom = false;
  }
  // Rebuild on an HDR flip. `PostProcessStage._pixelDatatype` has no setter
  // and the stage's texture cache keys on it, so the only way to move this
  // pipeline between dynamic ranges is to construct a new one. Compared
  // against the instance's own recorded datatype rather than against a new
  // `scene._*` mirror field, so there is no second source of truth to drift.
  if (
    defined(scene._sunPostProcess) &&
    scene._sunPostProcess.pixelDatatype !== sunBloomPixelDatatype
  ) {
    scene._sunPostProcess.destroy();
    scene._sunPostProcess = new SunPostProcess(sunBloomPixelDatatype);
  }

  const clear = scene._clearColorCommand;
  Color.clone(clearColor, clear.color);
  clear.execute(context, passState);

  const useGlobeDepthFramebuffer = (environmentState.useGlobeDepthFramebuffer =
    defined(view.globeDepth));
  if (useGlobeDepthFramebuffer) {
    view.globeDepth.update(
      context,
      passState,
      view.viewport,
      scene.msaaSamples,
      scene._hdr,
      environmentState.clearGlobeDepth,
    );
    view.globeDepth.clear(context, passState, clearColor);
  }

  const oit = view.oit;
  const useOIT = (environmentState.useOIT =
    !picking && defined(oit) && oit.isSupported());
  if (useOIT) {
    oit.update(
      context,
      passState,
      view.globeDepth.colorFramebufferManager,
      scene._hdr,
      scene.msaaSamples,
    );
    oit.clear(context, passState, clearColor);
    environmentState.useOIT = oit.isSupported();
  }

  const postProcess = scene.postProcessStages;
  // WebGPU always renders to an offscreen framebuffer — the post-process
  // pipeline is the ONLY path that blits it to the canvas. Without it
  // the canvas stays black. WebGL only needs post-processing when an
  // effect is actually enabled.
  const hasEffects =
    scene._hdr ||
    postProcess.length > 0 ||
    postProcess.ambientOcclusion.enabled ||
    postProcess.fxaa.enabled ||
    postProcess.bloom.enabled;
  // Audit 2026-05-02: switched the second disjunct from
  // `context.isWebGPU === true` to the existing `requiresSceneRenderer`
  // capability getter (true on WebGPU, false on WebGL). Same semantic —
  // backends that can't blit directly to the canvas need the post-
  // process chain even when no effects are enabled.
  let usePostProcess = (environmentState.usePostProcess =
    !picking && (context.requiresSceneRenderer === true || hasEffects));
  environmentState.usePostProcessSelected = false;
  if (usePostProcess) {
    view.sceneFramebuffer.update(
      context,
      view.viewport,
      scene._hdr,
      scene.msaaSamples,
    );
    view.sceneFramebuffer.clear(context, passState, clearColor);

    postProcess.update(context, frameState.useLogDepth, scene._hdr);
    postProcess.clear(context);

    // Backends that own the canvas blit via their scene renderer
    // (currently WebGPU) must keep usePostProcess=true even when the
    // WebGL PostProcessStageCollection reports ready=false (no stages
    // active). Audit 2026-05-02: routed through `requiresSceneRenderer`
    // capability getter rather than `isWebGPU` per CLAUDE.md §2.
    const requiresPostProcessForBlit = context.requiresSceneRenderer === true;
    usePostProcess = environmentState.usePostProcess =
      requiresPostProcessForBlit || postProcess.ready;
    environmentState.usePostProcessSelected =
      usePostProcess && postProcess.hasSelected;
  }

  // Depth-prepass + normal G-buffer scaffolding. Gated on
  // `frameState.useDeferredLighting`, which defaults false. With the flag
  // off this is a no-op; with the flag on the G-buffer is allocated and
  // cleared so a later producer pass has a target. The producer + consumer
  // wiring is not yet built; this only carves out the resource slot.
  const useDeferredLighting =
    !picking &&
    frameState.useDeferredLighting === true &&
    view.gBufferFramebuffer !== undefined;
  environmentState.useDeferredLighting = useDeferredLighting;
  if (useDeferredLighting) {
    view.gBufferFramebuffer.update(
      context,
      view.viewport,
      scene._hdr,
      scene.msaaSamples,
    );
    view.gBufferFramebuffer.clear(context, passState);
  }

  if (environmentState.isSunVisible && scene.sunBloom && !useWebVR) {
    // `frameState` threaded through so the `SolarHalo` stage can read
    // the halo state `Sun.update` published this frame.
    passState.framebuffer = scene._sunPostProcess.update(passState, frameState);
    scene._sunPostProcess.clear(context, passState, clearColor);
  } else if (useGlobeDepthFramebuffer) {
    passState.framebuffer = view.globeDepth.framebuffer;
  } else if (usePostProcess) {
    passState.framebuffer = view.sceneFramebuffer.framebuffer;
  }

  if (defined(passState.framebuffer)) {
    clear.execute(context, passState);
  }

  const useInvertClassification = (environmentState.useInvertClassification =
    !picking && defined(passState.framebuffer) && scene.invertClassification);

  const useEdgeFramebuffer = !picking && scene._enableEdgeVisibility;
  if (useEdgeFramebuffer) {
    view.edgeFramebuffer.update(context, view.viewport, scene._hdr);
  }

  // Update planar fill ID framebuffer
  const usePlanarFillIdFramebuffer = !picking && scene._enablePlanarFillId;
  if (usePlanarFillIdFramebuffer) {
    view.planarFillIdFramebuffer.update(context, view.viewport, scene._hdr);
  } else if (!picking) {
    // Release GPU resources while unused; recreated on demand by update().
    view.planarFillIdFramebuffer.releaseResources();
  }

  if (useInvertClassification) {
    let depthFramebuffer;
    if (frameState.invertClassificationColor.alpha === 1.0) {
      if (useGlobeDepthFramebuffer) {
        depthFramebuffer = view.globeDepth.framebuffer;
      }
    }

    if (defined(depthFramebuffer) || context.depthTexture) {
      scene._invertClassification.previousFramebuffer = depthFramebuffer;
      scene._invertClassification.update(
        context,
        scene.msaaSamples,
        view.globeDepth.colorFramebufferManager,
      );
      scene._invertClassification.clear(context, passState);

      if (frameState.invertClassificationColor.alpha < 1.0 && useOIT) {
        const command = scene._invertClassification.unclassifiedCommand;
        const derivedCommands = command.derivedCommands;
        derivedCommands.oit = oit.createDerivedCommands(
          command,
          context,
          derivedCommands.oit,
        );
      }
    } else {
      environmentState.useInvertClassification = false;
    }
  }

  if (scene._globeTranslucencyState.translucent) {
    view.globeTranslucencyFramebuffer.updateAndClear(
      scene._hdr,
      view.viewport,
      context,
      passState,
    );
  }
}

/**
 * Resolve framebuffers after rendering: OIT composite, translucent tile
 * classification, post-processing pipeline, and globe depth copy.
 *
 * @param {Scene} scene
 * @param {PassState} passState
 * @private
 */
function resolveFramebuffers(scene, passState) {
  const context = scene._context;
  if (context.resolveFramebuffers(scene, passState)) {
    return;
  }
  const environmentState = scene._environmentState;
  const view = scene._view;
  const { globeDepth, translucentTileClassification } = view;
  if (defined(globeDepth)) {
    globeDepth.prepareColorTextures(context);
  }

  const {
    useOIT,
    useGlobeDepthFramebuffer,
    usePostProcess,
    originalFramebuffer,
  } = environmentState;

  const globeFramebuffer = useGlobeDepthFramebuffer
    ? globeDepth.colorFramebufferManager
    : undefined;
  const sceneFramebuffer = view.sceneFramebuffer._colorFramebuffer;
  const idFramebuffer = view.sceneFramebuffer.idFramebuffer;

  if (useOIT) {
    passState.framebuffer = usePostProcess
      ? sceneFramebuffer.framebuffer
      : originalFramebuffer;
    view.oit.execute(context, passState);
  }

  if (
    translucentTileClassification.hasTranslucentDepth &&
    translucentTileClassification.isSupported()
  ) {
    translucentTileClassification.execute(scene, passState);
  }

  if (usePostProcess) {
    view.sceneFramebuffer.prepareColorTextures(context);
    let inputFramebuffer = sceneFramebuffer;
    if (useGlobeDepthFramebuffer && !useOIT) {
      inputFramebuffer = globeFramebuffer;
    }

    const postProcess = scene.postProcessStages;
    const colorTexture = inputFramebuffer.getColorTexture(0);
    const idTexture = idFramebuffer.getColorTexture(0);
    const depthTexture = (
      globeFramebuffer ?? sceneFramebuffer
    ).getDepthStencilTexture();
    postProcess.execute(context, colorTexture, depthTexture, idTexture);
    postProcess.copy(context, originalFramebuffer);
  }

  if (!useOIT && !usePostProcess && useGlobeDepthFramebuffer) {
    passState.framebuffer = originalFramebuffer;
    globeDepth.executeCopyColor(context, passState);
  }
}

export { updateAndClearFramebuffers, resolveFramebuffers };

// Namespace default export for build system barrel compatibility
const FramebufferOrchestrator = {
  updateAndClearFramebuffers,
  resolveFramebuffers,
};
export default FramebufferOrchestrator;
