import defined from "../Core/defined.js";
import Pass from "../Renderer/Pass.js";

const READY_LINK_STATE = "ready";

const SelectorBit = {
  USE_LOG_DEPTH: 1 << 4,
  HDR: 1 << 5,
  LIGHT_SHADOWS: 1 << 6,
  RECEIVE_SHADOWS: 1 << 7,
  RENDER_PASS: 1 << 8,
  PICK_PASS: 1 << 9,
  PICK_VOXEL_PASS: 1 << 10,
  DEPTH_PASS: 1 << 11,
  DEBUG_FILTER: 1 << 12,
  DEBUG_COMMANDS: 1 << 13,
  DEBUG_FRUSTUMS: 1 << 14,
};

function getFinalProgramSelector(scene, command) {
  const frameState = scene._frameState;
  const passes = frameState.passes;
  let selector = defined(command.pass) ? command.pass : Pass.NUMBER_OF_PASSES;

  selector |= frameState.useLogDepth ? SelectorBit.USE_LOG_DEPTH : 0;
  selector |= scene._hdr ? SelectorBit.HDR : 0;
  selector |= frameState.shadowState.lightShadowsEnabled
    ? SelectorBit.LIGHT_SHADOWS
    : 0;
  selector |= command.receiveShadows ? SelectorBit.RECEIVE_SHADOWS : 0;
  selector |= passes.render ? SelectorBit.RENDER_PASS : 0;
  selector |= passes.pick ? SelectorBit.PICK_PASS : 0;
  selector |= passes.pickVoxel ? SelectorBit.PICK_VOXEL_PASS : 0;
  selector |= passes.depth ? SelectorBit.DEPTH_PASS : 0;
  selector |= defined(scene.debugCommandFilter) ? SelectorBit.DEBUG_FILTER : 0;
  selector |= scene.debugShowCommands ? SelectorBit.DEBUG_COMMANDS : 0;
  selector |= scene.debugShowFrustums ? SelectorBit.DEBUG_FRUSTUMS : 0;
  return selector;
}

// ShaderCache entries are deliberately lazy: Scene derivation can create base,
// depth, pick, HDR, and shadow programs that the current pass never executes.
// Schedule only the final camera-visible WebGL color executable selected by the
// same log-depth/HDR/shadow order as SceneRenderer.executeCommand.
function scheduleFinalWebGLShaderProgram(scene, command) {
  const frameState = scene._frameState;
  const passes = frameState.passes;

  if (scene._alternateSceneRenderer || command.isWebGPUDrawCommand) {
    return;
  }

  const selector = getFinalProgramSelector(scene, command);
  const baseShaderProgram = command.shaderProgram;
  const memoizedFinalCommand = command._webGLFinalShaderProgramCommand;
  const memoizedFinalShaderProgram =
    defined(memoizedFinalCommand) && memoizedFinalCommand.shaderProgram;
  const memoizedLinkState = memoizedFinalShaderProgram?._linkState;

  // The common path is a clean command whose exact final executable already
  // linked. The final-command identity check catches replacement through the
  // derived command itself without walking the log-depth/HDR/shadow tree.
  if (
    command.dirty === false &&
    command._webGLFinalShaderProgramSelector === selector &&
    command._webGLFinalShaderProgramBase === baseShaderProgram &&
    command._webGLFinalShaderProgram === memoizedFinalShaderProgram &&
    command._webGLFinalShaderProgramLinkState === memoizedLinkState &&
    memoizedLinkState === READY_LINK_STATE
  ) {
    return;
  }

  if (
    !passes.render ||
    passes.pick ||
    passes.pickVoxel ||
    passes.depth ||
    command.pass === Pass.TRANSLUCENT ||
    defined(scene.debugCommandFilter) ||
    scene.debugShowCommands ||
    scene.debugShowFrustums
  ) {
    return;
  }

  let executableCommand = command;
  if (frameState.useLogDepth) {
    const logDepth = executableCommand.derivedCommands?.logDepth;
    if (defined(logDepth)) {
      executableCommand = logDepth.command;
    }
  }
  if (scene._hdr) {
    const hdr = executableCommand.derivedCommands?.hdr;
    if (defined(hdr)) {
      executableCommand = hdr.command;
    }
  }
  if (
    frameState.shadowState.lightShadowsEnabled &&
    executableCommand.receiveShadows
  ) {
    const shadows = executableCommand.derivedCommands?.shadows;
    if (defined(shadows)) {
      executableCommand = shadows.receiveCommand;
    }
  }

  const shaderProgram = executableCommand.shaderProgram;
  const shaderCache = shaderProgram?._cachedShader?.cache;
  if (defined(shaderCache) && shaderProgram._isLinkPending?.() === true) {
    // A derived program can be owned by a different WebGL context than the
    // active FrameState. Only its owning cache may queue or release it. The
    // owner also decides whether parallel compilation is supported.
    shaderCache.scheduleShaderProgramCompilation(shaderProgram);
  }

  command._webGLFinalShaderProgramBase = baseShaderProgram;
  command._webGLFinalShaderProgramCommand = executableCommand;
  command._webGLFinalShaderProgram = shaderProgram;
  command._webGLFinalShaderProgramSelector = selector;
  command._webGLFinalShaderProgramLinkState = shaderProgram?._linkState;
}

export default scheduleFinalWebGLShaderProgram;
