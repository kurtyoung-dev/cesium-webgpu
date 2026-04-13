import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
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
  }
  const useWebVR = environmentState.useWebVR;

  environmentState.originalFramebuffer = passState.framebuffer;

  if (defined(scene.sun) && scene.sunBloom !== scene._sunBloom) {
    if (scene.sunBloom && !useWebVR) {
      scene._sunPostProcess = new SunPostProcess();
    } else if (defined(scene._sunPostProcess)) {
      scene._sunPostProcess = scene._sunPostProcess.destroy();
    }

    scene._sunBloom = scene.sunBloom;
  } else if (!defined(scene.sun) && defined(scene._sunPostProcess)) {
    scene._sunPostProcess = scene._sunPostProcess.destroy();
    scene._sunBloom = false;
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
  let usePostProcess = (environmentState.usePostProcess =
    !picking && (context.isWebGPU === true || hasEffects));
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

    // WebGPU must keep usePostProcess=true even when the WebGL
    // PostProcessStageCollection reports ready=false (no stages active).
    // The WebGPU scene renderer's post-process pipeline handles the
    // canvas blit independently of the WebGL stage collection.
    const isWebGPU = context.isWebGPU === true;
    usePostProcess = environmentState.usePostProcess =
      isWebGPU || postProcess.ready;
    environmentState.usePostProcessSelected =
      usePostProcess && postProcess.hasSelected;
  }

  if (environmentState.isSunVisible && scene.sunBloom && !useWebVR) {
    passState.framebuffer = scene._sunPostProcess.update(passState);
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
