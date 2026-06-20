/**
 * Environment rendering extracted from Scene.js. Handles sky box,
 * sky atmosphere, sun, moon, and panorama command execution.
 *
 * @private
 */
import defined from "../Core/defined.js";
import Pass from "../Renderer/Pass.js";

/**
 * Execute environment commands (sky, atmosphere, sun, moon, panorama).
 * Called after uniformState is set to the ENVIRONMENT pass.
 *
 * @param {Scene} scene
 * @param {PassState} passState
 * @param {Function} executeCommand The command execution function from SceneRenderer.
 * @private
 */
function renderEnvironment(scene, passState, executeCommand) {
  const { context, environmentState, view } = scene;

  context.uniformState.updatePass(Pass.ENVIRONMENT);

  if (defined(environmentState.skyBoxCommand)) {
    executeCommand(environmentState.skyBoxCommand, scene, passState);
  }

  // Track V-C — bright-star catalog starfield (NEW-STARS-BRIGHT-CATALOG-
  // WEBGL-FALLBACK). Drawn right AFTER the SkyBox cubemap so the additive
  // HDR stars land ON TOP of the (often opaque, dark) cubemap rather than
  // being overwritten by it, and BEFORE the sky atmosphere / sun / moon so
  // those still occlude the stars. Gated on the cubemap existing by Scene
  // (mirrors the WebGPU injection ordering in SceneRenderer.js). No-op when
  // no STAR_FIELD feature renderer is registered.
  if (defined(environmentState.starFieldCommand)) {
    executeCommand(environmentState.starFieldCommand, scene, passState);
  }

  if (environmentState.isSkyAtmosphereVisible) {
    executeCommand(environmentState.skyAtmosphereCommand, scene, passState);
  }

  if (environmentState.isSunVisible) {
    environmentState.sunDrawCommand.execute(context, passState);
    if (scene.sunBloom && !environmentState.useWebVR) {
      let framebuffer;
      if (environmentState.useGlobeDepthFramebuffer) {
        framebuffer = view.globeDepth.framebuffer;
      } else if (environmentState.usePostProcess) {
        framebuffer = view.sceneFramebuffer.framebuffer;
      } else {
        framebuffer = environmentState.originalFramebuffer;
      }
      scene._sunPostProcess.execute(context);
      scene._sunPostProcess.copy(context, framebuffer);
      passState.framebuffer = framebuffer;
    }
  }

  if (environmentState.isMoonVisible) {
    environmentState.moonCommand.execute(context, passState);
  }

  // Execute panorama commands — accept any command that has an execute method
  const panoramaCommandList = scene.frameState.panoramaCommandList;
  for (let i = panoramaCommandList.length - 1; i >= 0; i--) {
    const panoramaCommand = panoramaCommandList[i];
    if (
      defined(panoramaCommand.shaderProgram) ||
      defined(panoramaCommand.pipeline)
    ) {
      executeCommand(panoramaCommandList[i], scene, passState);
    } else {
      panoramaCommandList.splice(i, 1);
    }
  }
}

export { renderEnvironment };

// Namespace default export for build system barrel compatibility
const EnvironmentRenderer = {
  renderEnvironment,
};
export default EnvironmentRenderer;
