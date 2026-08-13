import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import mergeSort from "../Core/mergeSort.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import PerspectiveFrustum from "../Core/PerspectiveFrustum.js";
import PerspectiveOffCenterFrustum from "../Core/PerspectiveOffCenterFrustum.js";
import ClearCommand from "../Renderer/ClearCommand.js";
import Pass from "../Renderer/Pass.js";
import { normalizeCommandOrderingList } from "../Renderer/CommandOrdering.js";
import {
  backToFront,
  backToFrontSplats,
  obtainTranslucentCommandExecutionFunction,
} from "./CommandSorter.js";
import { prependUniqueEnvironmentCommands } from "./EnvironmentCommandList.js";
import { debugShowBoundingVolume } from "./SceneDebug.js";
import { renderEnvironment } from "./EnvironmentRenderer.js";
import SceneMode from "./SceneMode.js";

/**
 * Multi-frustum command execution pipeline. Handles per-pass dispatch,
 * shadow map cast commands, compute commands, and overlay commands.
 *
 * Extracted from Scene.js (Phase 5 of decomposition plan).
 * @private
 */

function isExecutableEnvironmentCommand(command) {
  return defined(command) && typeof command.execute === "function";
}

function appendUniqueEnvironmentCommand(
  commands,
  length,
  command,
  scene,
  label,
) {
  if (isExecutableEnvironmentCommand(command)) {
    for (let i = 0; i < length; i++) {
      if (commands[i] === command) {
        return length;
      }
    }
    commands[length] = command;
    return length + 1;
  }

  if (defined(command) && !scene._envDiagLogged) {
    console.warn(`[WebGPU:EnvInject] ${label} skipped: no execute method`);
  }
  return length;
}

function executeCommand(command, scene, passState, debugFramebuffer) {
  const frameState = scene._frameState;
  const context = scene._context;

  if (defined(scene.debugCommandFilter) && !scene.debugCommandFilter(command)) {
    return;
  }

  if (command instanceof ClearCommand) {
    command.execute(context, passState);
    return;
  }

  if (scene._alternateSceneRenderer) {
    context.executeDrawCommand(command, scene, passState, debugFramebuffer);
    return;
  }

  if (command.debugShowBoundingVolume && defined(command.boundingVolume)) {
    debugShowBoundingVolume(command, scene, passState, debugFramebuffer);
  }

  if (frameState.useLogDepth && defined(command.derivedCommands.logDepth)) {
    command = command.derivedCommands.logDepth.command;
  }

  const passes = frameState.passes;
  if (
    !passes.pick &&
    !passes.pickVoxel &&
    !passes.depth &&
    scene._hdr &&
    command._moonPhysicalDepthRoute !== true &&
    defined(command.derivedCommands) &&
    defined(command.derivedCommands.hdr)
  ) {
    command = command.derivedCommands.hdr.command;
  }

  if (passes.pick || passes.depth) {
    if (passes.pick && !passes.depth) {
      if (frameState.passes.snap) {
        // Depth is cleared between far-to-near frustum slices while payload
        // color is preserved. A snapless winner must therefore write a zero
        // payload as well as depth, or a farther snap target survives through
        // nearer terrain. The occluder variant preserves the existing
        // depth-only shader's discard/log-depth semantics and changes only its
        // color write. Ordinary pick/depth passes never select this variant.
        if (
          defined(command.snapId) &&
          defined(command.derivedCommands.snapping)
        ) {
          command = command.derivedCommands.snapping.snapCommand;
          command.execute(context, passState);
        } else if (
          !defined(command.snapId) &&
          defined(command.derivedCommands.snappingOccluder?.occluderCommand)
        ) {
          command = command.derivedCommands.snappingOccluder.occluderCommand;
          command.execute(context, passState);
        } else if (defined(command.derivedCommands.depth)) {
          command = command.derivedCommands.depth.depthOnlyCommand;
          command.execute(context, passState);
        }
        return;
      }
      if (
        frameState.pickingMetadata &&
        defined(command.derivedCommands.pickingMetadata)
      ) {
        command = command.derivedCommands.pickingMetadata.pickMetadataCommand;
        command.execute(context, passState);
        return;
      }
      if (
        !frameState.pickingMetadata &&
        defined(command.derivedCommands.picking)
      ) {
        command = command.derivedCommands.picking.pickCommand;
        command.execute(context, passState);
        return;
      }
    } else if (defined(command.derivedCommands.depth)) {
      command = command.derivedCommands.depth.depthOnlyCommand;
      command.execute(context, passState);
      return;
    }
  }

  if (scene.debugShowCommands || scene.debugShowFrustums) {
    scene._debugInspector.executeDebugShowFrustumsCommand(
      scene,
      command,
      passState,
    );
    return;
  }

  if (
    frameState.shadowState.lightShadowsEnabled &&
    command.receiveShadows &&
    defined(command.derivedCommands.shadows)
  ) {
    command.derivedCommands.shadows.receiveCommand.execute(context, passState);
  } else {
    command.execute(context, passState);
  }
}

function executeIdCommand(command, scene, passState) {
  const { derivedCommands } = command;
  if (!defined(derivedCommands)) {
    return;
  }

  const frameState = scene._frameState;
  const context = scene._context;

  if (frameState.useLogDepth && defined(derivedCommands.logDepth)) {
    command = derivedCommands.logDepth.command;
  }

  const { picking, pickingMetadata, depth } = command.derivedCommands;
  if (defined(pickingMetadata)) {
    command = derivedCommands.pickingMetadata.pickMetadataCommand;
    command.execute(context, passState);
  }
  if (defined(picking)) {
    command = picking.pickCommand;
    command.execute(context, passState);
  } else if (defined(depth)) {
    command = depth.depthOnlyCommand;
    command.execute(context, passState);
  }
}

function performVoxelsPass(scene, passState, frustumCommands) {
  scene.context.uniformState.updatePass(Pass.VOXELS);

  const commands = frustumCommands.commands[Pass.VOXELS];
  commands.length = frustumCommands.indices[Pass.VOXELS];

  normalizeCommandOrderingList(commands);
  mergeSort(commands, backToFront, scene.camera.positionWC);

  for (let i = 0; i < commands.length; ++i) {
    executeCommand(commands[i], scene, passState);
  }
}

function performGaussianSplatPass(scene, passState, frustumCommands) {
  scene.context.uniformState.updatePass(Pass.GAUSSIAN_SPLATS);

  const commands = frustumCommands.commands[Pass.GAUSSIAN_SPLATS];
  commands.length = frustumCommands.indices[Pass.GAUSSIAN_SPLATS];

  normalizeCommandOrderingList(commands);
  mergeSort(commands, backToFrontSplats, scene.camera.positionWC);

  for (let i = 0; i < commands.length; ++i) {
    executeCommand(commands[i], scene, passState);
  }
}

const scratchPerspectiveFrustum = new PerspectiveFrustum();
const scratchPerspectiveOffCenterFrustum = new PerspectiveOffCenterFrustum();
const scratchOrthographicFrustum = new OrthographicFrustum();
const scratchOrthographicOffCenterFrustum = new OrthographicOffCenterFrustum();

function createWorkingFrustum(camera) {
  const { frustum } = camera;
  if (defined(frustum.fov)) {
    return frustum.clone(scratchPerspectiveFrustum);
  }
  if (typeof frustum.getInfiniteProjectionMatrix === "function") {
    return frustum.clone(scratchPerspectiveOffCenterFrustum);
  }
  if (defined(frustum.width)) {
    return frustum.clone(scratchOrthographicFrustum);
  }
  return frustum.clone(scratchOrthographicOffCenterFrustum);
}

function performTranslucentPass(scene, passState, frustumCommands) {
  const { frameState, context } = scene;
  const { pick, pickVoxel } = frameState.passes;
  const picking = pick || pickVoxel;

  let invertClassification;
  if (
    !picking &&
    scene._environmentState.useInvertClassification &&
    frameState.invertClassificationColor.alpha < 1.0
  ) {
    invertClassification = scene._invertClassification;
  }

  const executeTranslucentCommands =
    obtainTranslucentCommandExecutionFunction(scene);

  context.uniformState.updatePass(Pass.TRANSLUCENT);
  const commands = frustumCommands.commands[Pass.TRANSLUCENT];
  commands.length = frustumCommands.indices[Pass.TRANSLUCENT];
  executeTranslucentCommands(
    scene,
    executeCommand,
    passState,
    commands,
    invertClassification,
  );
}

function performTranslucent3DTilesClassification(
  scene,
  passState,
  frustumCommands,
) {
  const { translucentTileClassification, globeDepth } = scene._view;
  const has3DTilesClassificationCommands =
    frustumCommands.indices[Pass.CESIUM_3D_TILE_CLASSIFICATION] > 0;
  if (
    !has3DTilesClassificationCommands ||
    !translucentTileClassification.isSupported()
  ) {
    return;
  }

  const commands = frustumCommands.commands[Pass.TRANSLUCENT];
  translucentTileClassification.executeTranslucentCommands(
    scene,
    executeCommand,
    passState,
    commands,
    globeDepth.depthStencilTexture,
  );
  translucentTileClassification.executeClassificationCommands(
    scene,
    executeCommand,
    passState,
    frustumCommands,
  );
}

function performCesium3DTileEdgesPass(scene, passState, frustumCommands) {
  scene.context.uniformState.updatePass(Pass.CESIUM_3D_TILE_EDGES);

  const originalFramebuffer = passState.framebuffer;

  scene.context.uniformState.edgeColorTexture = scene.context.defaultTexture;
  scene.context.uniformState.edgeIdTexture = scene.context.defaultTexture;
  scene.context.uniformState.edgeDepthTexture = scene.context.defaultTexture;

  if (
    scene._enableEdgeVisibility &&
    defined(scene._view) &&
    defined(scene._view.edgeFramebuffer)
  ) {
    passState.framebuffer = scene._view.edgeFramebuffer.framebuffer;
  }

  const commands = frustumCommands.commands[Pass.CESIUM_3D_TILE_EDGES];
  const commandCount = frustumCommands.indices[Pass.CESIUM_3D_TILE_EDGES];

  if (
    scene._enableEdgeVisibility &&
    defined(scene._view) &&
    defined(scene._view.edgeFramebuffer)
  ) {
    const clearCommand = scene._view.edgeFramebuffer.getClearCommand(
      new Color(0.0, 0.0, 0.0, 0.0),
    );
    clearCommand.execute(scene.context, passState);
  }

  for (let j = 0; j < commandCount; ++j) {
    executeCommand(commands[j], scene, passState);
  }

  passState.framebuffer = originalFramebuffer;
}

/**
 * Execute the planar fill feature-ID pre-pass.
 *
 * Non-behind planar fill geometry writes its per-fragment feature ID into the
 * planar fill ID framebuffer. This allows behind fills in the main 3D tile
 * pass to check whether the existing pixel belongs to the same logical object.
 *
 * @param {Scene} scene
 * @param {PassState} passState
 * @param {FrustumCommands} frustumCommands
 * @private
 */
function performPlanarFillIdPass(scene, passState, frustumCommands) {
  const { context } = scene;
  const { uniformState } = context;

  uniformState.updatePass(Pass.CESIUM_3D_TILE_PLANAR_FILL_ID);

  // Default to a blank texture so shaders always have something to sample.
  uniformState.planarFillIdTexture = context.defaultTexture;

  const view = scene._view;
  const fb = view && view.planarFillIdFramebuffer;

  const commands = frustumCommands.commands[Pass.CESIUM_3D_TILE_PLANAR_FILL_ID];
  const commandCount =
    frustumCommands.indices[Pass.CESIUM_3D_TILE_PLANAR_FILL_ID];

  if (commandCount === 0) {
    return;
  }

  if (scene._enablePlanarFillId && defined(fb) && defined(fb.framebuffer)) {
    const originalFramebuffer = passState.framebuffer;
    passState.framebuffer = fb.framebuffer;

    // Clear to (0,0,0,0) — feature ID 0 means "no planar fill here".
    const clearCommand = fb.getClearCommand(new Color(0.0, 0.0, 0.0, 0.0));
    clearCommand.execute(context, passState);

    for (let j = 0; j < commandCount; ++j) {
      executeCommand(commands[j], scene, passState);
    }

    passState.framebuffer = originalFramebuffer;
  }
}

// EDGES_ONLY 3D-Tile edge rendering: ported from upstream Scene.js during the
// v1.142 merge (Scene.js was decomposed into this module, so upstream's new
// direct-edge pass had to be re-homed here). Unlike performCesium3DTileEdgesPass
// (which renders into the MRT edge framebuffer for compositing), this draws the
// CESIUM_3D_TILE_EDGES_DIRECT commands straight to the main framebuffer, on top
// of opaque surfaces — used by Model/Tileset edgeDisplayMode === EDGES_ONLY.
function performCesium3DTileEdgesDirectPass(scene, passState, frustumCommands) {
  scene.context.uniformState.updatePass(Pass.CESIUM_3D_TILE_EDGES_DIRECT);

  const commands = frustumCommands.commands[Pass.CESIUM_3D_TILE_EDGES_DIRECT];
  const commandCount =
    frustumCommands.indices[Pass.CESIUM_3D_TILE_EDGES_DIRECT];

  for (let j = 0; j < commandCount; ++j) {
    executeCommand(commands[j], scene, passState);
  }
}

/**
 * The core multi-frustum command execution loop. Iterates frustums far-to-near,
 * executing all render passes (globe, terrain classification, 3D tiles, opaque,
 * translucent, voxels, gaussian splats) within each frustum.
 */
function executeCommands(scene, passState) {
  const { camera, context, frameState } = scene;
  const { uniformState } = context;

  uniformState.updateCamera(camera);

  // Ensure planar fill ID texture is always available (even during edge pass)
  // so that shaders referencing czm_planarFillIdTexture never see undefined.
  uniformState.planarFillIdTexture = context.defaultTexture;

  const frustum = createWorkingFrustum(camera);
  frustum.near = camera.frustum.near;
  frustum.far = camera.frustum.far;

  const passes = frameState.passes;
  const picking = passes.pick || passes.pickVoxel;

  // renderEnvironment uses direct .execute(context, passState) calls that
  // require an active WebGL context. When the WebGPU alternate scene renderer
  // is active, environment commands are injected into the farthest frustum's
  // ENVIRONMENT pass slot so they execute within the WebGPU render pass.
  if (!picking && !scene._alternateSceneRenderer) {
    renderEnvironment(scene, passState, executeCommand);
  }

  if (scene._alternateSceneRenderer) {
    const envState = scene._environmentState;

    // Inject environment commands into the farthest frustum so the WebGPU
    // scene renderer finds them via _executePassCommands(Pass.ENVIRONMENT).
    // These commands were created by feature renderers during updateEnvironment()
    // but stored on environmentState instead of frameState.commandList.
    // Only inject commands that are actual WebGPU draw commands — WebGL
    // fallback commands would crash when executed in a WebGPU render pass.
    if (!picking) {
      const frustumCommandsList = scene._view.frustumCommandsList;
      if (frustumCommandsList.length > 0) {
        const farthest = frustumCommandsList[frustumCommandsList.length - 1];
        const envCmds = farthest.commands[Pass.ENVIRONMENT];
        let envIdx = farthest.indices[Pass.ENVIRONMENT];
        const envFromCommandList = envIdx;

        // Inject any command that has an execute method. The WebGPU
        // scene renderer's executeBatch handles both WebGPU commands
        // (via command.execute(renderPass)) and WebGL-style commands
        // (via command.execute(context, passState)) transparently.
        //
        // Core environment renderers are return-only. The identity scan is
        // retained for third-party/legacy feature renderers that may still
        // publish through both routes, but lives in a module helper so this
        // hot path allocates neither a closure nor a scratch array per frame.
        //
        // Background layers (skyBox cubemap + bright-star starfield) draw
        // BEHIND the atmosphere, followed by sun, moon and panoramas. Prepend
        // the two possible background commands ahead of any legacy binned
        // environment commands without allocating a temporary list.
        envIdx = prependUniqueEnvironmentCommands(
          envCmds,
          envIdx,
          envState.skyBoxCommand,
          envState.starFieldCommand,
        );
        if (envState.isSkyAtmosphereVisible) {
          envIdx = appendUniqueEnvironmentCommand(
            envCmds,
            envIdx,
            envState.skyAtmosphereCommand,
            scene,
            "skyAtmosphere",
          );
        }
        if (envState.isSunVisible) {
          envIdx = appendUniqueEnvironmentCommand(
            envCmds,
            envIdx,
            envState.sunDrawCommand,
            scene,
            "sun",
          );
        }
        if (envState.isMoonVisible) {
          envIdx = appendUniqueEnvironmentCommand(
            envCmds,
            envIdx,
            envState.moonCommand,
            scene,
            "moon",
          );
        }

        // Panorama commands (CubeMapPanorama instances not using returnCommand)
        const panoramaCommandList = frameState.panoramaCommandList;
        for (let p = 0; p < panoramaCommandList.length; p++) {
          envIdx = appendUniqueEnvironmentCommand(
            envCmds,
            envIdx,
            panoramaCommandList[p],
            scene,
            "panorama",
          );
        }

        const envCount = envIdx - envFromCommandList;

        // Log on first inject, and again when skyBox command appears (async cubemap load)
        const hasSkyBox = defined(envState.skyBoxCommand);
        if (!scene._envDiagLogged || (hasSkyBox && !scene._envSkyBoxSeen)) {
          if (hasSkyBox) {
            scene._envSkyBoxSeen = true;
          }
          scene._envDiagLogged = true;
          console.log(
            `[WebGPU:EnvInject] Injected ${envCount} env commands ` +
              `(${envFromCommandList} already in frustum from commandList). ` +
              `skyBox=${hasSkyBox} ` +
              `skyAtmo=${envState.isSkyAtmosphereVisible} ` +
              `sun=${envState.isSunVisible} ` +
              `moon=${envState.isMoonVisible} ` +
              `panoramas=${panoramaCommandList.length}`,
          );
        }

        farthest.indices[Pass.ENVIRONMENT] = envIdx;
      }
    }

    // BUG-3 — SCENE2D infinite-scroll wrap accumulation. `executeCommandsInViewport`
    // sets these per-call so the WebGPU renderer accumulates both viewport halves
    // into one scene framebuffer and blits once: `sceneFbLoad` (preserve the prior
    // half instead of clearing) on the second half, `deferComposite` (skip the
    // post-process blit) on the first half. Consume + reset so non-2D / single
    // renders (which never set them) always see the default single-pass behavior.
    const sceneFbLoad = scene._exec2DSceneFbLoad === true;
    const deferComposite = scene._exec2DDeferComposite === true;
    scene._exec2DSceneFbLoad = false;
    scene._exec2DDeferComposite = false;

    scene._alternateSceneRenderer.executeCommands({
      scene,
      context,
      passState,
      backgroundColor: frameState.backgroundColor,
      picking,
      useGlobeDepthFramebuffer: envState.useGlobeDepthFramebuffer,
      clearGlobeDepth: envState.clearGlobeDepth,
      useOIT: envState.useOIT,
      useDepthPlane: envState.useDepthPlane,
      useInvertClassification: envState.useInvertClassification,
      usePostProcess: envState.usePostProcess,
      useHDR: scene._hdr,
      shadowState: frameState.shadowState,
      sceneFbLoad,
      deferComposite,
    });
    return;
  }

  const {
    clearGlobeDepth,
    renderTranslucentDepthForPick,
    useDepthPlane,
    useGlobeDepthFramebuffer,
    useInvertClassification,
    usePostProcessSelected,
  } = scene._environmentState;

  const {
    globeDepth,
    globeTranslucencyFramebuffer,
    sceneFramebuffer,
    frustumCommandsList,
  } = scene._view;
  const numFrustums = frustumCommandsList.length;

  const globeTranslucencyState = scene._globeTranslucencyState;
  const clearDepth = scene._depthClearCommand;
  const clearStencil = scene._stencilClearCommand;
  const clearClassificationStencil = scene._classificationStencilClearCommand;
  const depthPlane = scene._depthPlane;

  const height2D = camera.position.z;

  function performPass(frustumCommands, passId) {
    uniformState.updatePass(passId);
    const commands = frustumCommands.commands[passId];
    const commandCount = frustumCommands.indices[passId];
    for (let j = 0; j < commandCount; ++j) {
      executeCommand(commands[j], scene, passState);
    }
    return commandCount;
  }

  function performIdPass(frustumCommands, passId) {
    uniformState.updatePass(passId);
    const commands = frustumCommands.commands[passId];
    const commandCount = frustumCommands.indices[passId];
    for (let j = 0; j < commandCount; ++j) {
      executeIdCommand(commands[j], scene, passState);
    }
  }

  for (let i = 0; i < numFrustums; ++i) {
    const index = numFrustums - i - 1;
    const frustumCommands = frustumCommandsList[index];

    if (scene.mode === SceneMode.SCENE2D) {
      camera.position.z = height2D - frustumCommands.near + 1.0;
      frustum.far = Math.max(1.0, frustumCommands.far - frustumCommands.near);
      frustum.near = 1.0;
      uniformState.update(frameState);
      uniformState.updateFrustum(frustum);
    } else {
      frustum.near =
        index !== 0
          ? frustumCommands.near * scene.opaqueFrustumNearOffset
          : frustumCommands.near;
      frustum.far = frustumCommands.far;
      uniformState.updateFrustum(frustum);
    }

    clearDepth.execute(context, passState);

    if (context.stencilBuffer) {
      clearStencil.execute(context, passState);
    }

    if (globeTranslucencyState.translucent) {
      uniformState.updatePass(Pass.GLOBE);
      globeTranslucencyState.executeGlobeCommands(
        frustumCommands,
        executeCommand,
        globeTranslucencyFramebuffer,
        scene,
        passState,
      );
    } else {
      performPass(frustumCommands, Pass.GLOBE);
    }

    if (useGlobeDepthFramebuffer) {
      globeDepth.executeCopyDepth(context, passState);
    }

    if (!renderTranslucentDepthForPick) {
      if (globeTranslucencyState.translucent) {
        uniformState.updatePass(Pass.TERRAIN_CLASSIFICATION);
        globeTranslucencyState.executeGlobeClassificationCommands(
          frustumCommands,
          executeCommand,
          globeTranslucencyFramebuffer,
          scene,
          passState,
        );
      } else {
        performPass(frustumCommands, Pass.TERRAIN_CLASSIFICATION);
      }
    }

    if (clearGlobeDepth) {
      clearDepth.execute(context, passState);
      if (useDepthPlane) {
        depthPlane.execute(context, passState);
      }
    }

    let commandCount;

    performCesium3DTileEdgesPass(scene, passState, frustumCommands);

    if (
      scene._enableEdgeVisibility &&
      defined(scene._view) &&
      defined(scene._view.edgeFramebuffer)
    ) {
      const colorTexture = scene._view.edgeFramebuffer.colorTexture;
      if (defined(colorTexture)) {
        scene.context.uniformState.edgeColorTexture = colorTexture;
      } else {
        scene.context.uniformState.edgeColorTexture =
          scene.context.defaultTexture;
      }

      const idTexture = scene._view.edgeFramebuffer.idTexture;
      if (defined(idTexture)) {
        scene.context.uniformState.edgeIdTexture = idTexture;
      } else {
        scene.context.uniformState.edgeIdTexture = scene.context.defaultTexture;
      }

      const edgeDepthTexture = scene._view.edgeFramebuffer.depthTexture;
      if (defined(edgeDepthTexture)) {
        scene.context.uniformState.edgeDepthTexture = edgeDepthTexture;
      } else {
        scene.context.uniformState.edgeDepthTexture =
          scene.context.defaultTexture;
      }
    } else {
      scene.context.uniformState.edgeColorTexture =
        scene.context.defaultTexture;
      scene.context.uniformState.edgeIdTexture = scene.context.defaultTexture;
      scene.context.uniformState.edgeDepthTexture =
        scene.context.defaultTexture;
    }

    // Planar fill feature-ID pre-pass: write feature IDs from non-behind
    // planar fill geometry so that behind fills can test same-object.
    performPlanarFillIdPass(scene, passState, frustumCommands);

    if (
      scene._enablePlanarFillId &&
      defined(scene._view) &&
      defined(scene._view.planarFillIdFramebuffer)
    ) {
      const pfIdTexture = scene._view.planarFillIdFramebuffer.idTexture;
      uniformState.planarFillIdTexture = defined(pfIdTexture)
        ? pfIdTexture
        : context.defaultTexture;
    } else {
      uniformState.planarFillIdTexture = context.defaultTexture;
    }

    if (!useInvertClassification || picking || renderTranslucentDepthForPick) {
      commandCount = performPass(frustumCommands, Pass.CESIUM_3D_TILE);

      if (commandCount > 0) {
        if (useGlobeDepthFramebuffer) {
          globeDepth.prepareColorTextures(context, clearGlobeDepth);
          globeDepth.executeUpdateDepth(
            context,
            passState,
            globeDepth.depthStencilTexture,
          );
        }

        if (!renderTranslucentDepthForPick) {
          commandCount = performPass(
            frustumCommands,
            Pass.CESIUM_3D_TILE_CLASSIFICATION,
          );
        }
      }
    } else {
      scene._invertClassification.clear(context, passState);

      const opaqueClassificationFramebuffer = passState.framebuffer;
      passState.framebuffer = scene._invertClassification._fbo.framebuffer;

      // Draw normally
      performPass(frustumCommands, Pass.CESIUM_3D_TILE);

      if (useGlobeDepthFramebuffer) {
        scene._invertClassification.prepareTextures(context);
        globeDepth.executeUpdateDepth(
          context,
          passState,
          scene._invertClassification._fbo.getDepthStencilTexture(),
        );
      }

      commandCount = performPass(
        frustumCommands,
        Pass.CESIUM_3D_TILE_CLASSIFICATION_IGNORE_SHOW,
      );

      passState.framebuffer = opaqueClassificationFramebuffer;

      scene._invertClassification.executeClassified(context, passState);
      if (frameState.invertClassificationColor.alpha === 1.0) {
        scene._invertClassification.executeUnclassified(context, passState);
      }

      if (commandCount > 0 && context.stencilBuffer) {
        clearClassificationStencil.execute(context, passState);
      }

      commandCount = performPass(
        frustumCommands,
        Pass.CESIUM_3D_TILE_CLASSIFICATION,
      );
    }

    if (commandCount > 0 && context.stencilBuffer) {
      clearStencil.execute(context, passState);
    }

    performVoxelsPass(scene, passState, frustumCommands);

    performPass(frustumCommands, Pass.OPAQUE);

    // Draw direct edges (EDGES_ONLY mode) after opaque surfaces
    performCesium3DTileEdgesDirectPass(scene, passState, frustumCommands);

    performGaussianSplatPass(scene, passState, frustumCommands);

    if (index !== 0 && scene.mode !== SceneMode.SCENE2D) {
      frustum.near = frustumCommands.near;
      uniformState.updateFrustum(frustum);
    }

    performTranslucentPass(scene, passState, frustumCommands);

    performTranslucent3DTilesClassification(scene, passState, frustumCommands);

    if (
      context.depthTexture &&
      scene.useDepthPicking &&
      (useGlobeDepthFramebuffer || renderTranslucentDepthForPick)
    ) {
      const pickDepth = scene._picking.getPickDepth(scene, index);
      pickDepth.update(context, globeDepth.depthStencilTexture);
      pickDepth.executeCopyDepth(context, passState);
    }

    if (picking || !usePostProcessSelected) {
      continue;
    }

    const originalFramebuffer = passState.framebuffer;
    passState.framebuffer = sceneFramebuffer.getIdFramebuffer();

    frustum.near =
      index !== 0
        ? frustumCommands.near * scene.opaqueFrustumNearOffset
        : frustumCommands.near;
    frustum.far = frustumCommands.far;
    uniformState.updateFrustum(frustum);

    if (globeTranslucencyState.translucent) {
      uniformState.updatePass(Pass.GLOBE);
      globeTranslucencyState.executeGlobeCommands(
        frustumCommands,
        executeIdCommand,
        globeTranslucencyFramebuffer,
        scene,
        passState,
      );
    } else {
      performIdPass(frustumCommands, Pass.GLOBE);
    }

    if (clearGlobeDepth) {
      clearDepth.framebuffer = passState.framebuffer;
      clearDepth.execute(context, passState);
      clearDepth.framebuffer = undefined;
    }

    if (clearGlobeDepth && useDepthPlane) {
      depthPlane.execute(context, passState);
    }

    performIdPass(frustumCommands, Pass.CESIUM_3D_TILE);
    performIdPass(frustumCommands, Pass.OPAQUE);
    performIdPass(frustumCommands, Pass.TRANSLUCENT);

    passState.framebuffer = originalFramebuffer;
  }
}

function executeComputeCommands(scene) {
  scene.context.uniformState.updatePass(Pass.COMPUTE);

  const context = scene._context;
  context.executeComputeCommands(
    scene._computeCommandList,
    scene._environmentState.sunComputeCommand,
    scene._computeEngine,
  );
}

function executeOverlayCommands(scene, passState) {
  scene.context.uniformState.updatePass(Pass.OVERLAY);

  const context = scene.context;
  const commandList = scene._overlayCommandList;
  for (let i = 0; i < commandList.length; ++i) {
    commandList[i].execute(context, passState);
  }
}

// C10-10-SHADOW-CAST-SINGLE-SWEEP — build the per-cascade cast lists from the
// caster sublist collected during the single PVS walk
// (`View.createPotentiallyVisibleSet` → `frameState.shadowState.casterCommands`),
// doing ONLY the shadow-map light-frustum + per-cascade culling here.
//
// The old implementation re-scanned the entire `frameState.commandList` for
// EVERY shadow map, re-ran `scene.updateDerivedCommands` on every command,
// allocated a `shadowedPasses` array per call, and linear-`.includes`-tested
// each command's pass — all duplicating the walk the PVS pass already made. The
// sublist already excludes non-casters and non-shadowed passes, and every entry
// is ready for its backend: WebGL commands carry the derived cast command built
// by `insertIntoBin` or View's off-camera path, while native WebGPU commands
// remain raw and carry `_shadowCast*` layout/resource tags. So the only work
// left per caster is the light/cascade `isVisible` culling, which needs the
// shadow-map volumes (computed after PVS) and therefore stays here (INV-3).
function insertShadowCastCommands(scene, casters, shadowMap) {
  const { shadowMapCullingVolume, isPointLight, passes } = shadowMap;
  const numberOfPasses = passes.length;

  for (let i = 0; i < casters.length; ++i) {
    const command = casters[i];

    // Light-frustum cull (INV-3) — the only per-caster test left.
    if (!scene.isVisible(shadowMapCullingVolume, command)) {
      continue;
    }

    if (isPointLight) {
      for (let k = 0; k < numberOfPasses; ++k) {
        const pass = passes[k];
        const faceCullingVolume = pass.cullingVolume;
        if (
          !defined(faceCullingVolume) ||
          scene.isVisible(faceCullingVolume, command)
        ) {
          pass.commandList.push(command);
        }
      }
    } else if (numberOfPasses === 1) {
      passes[0].commandList.push(command);
    } else {
      let wasVisible = false;
      for (let j = numberOfPasses - 1; j >= 0; --j) {
        const cascadeVolume = passes[j].cullingVolume;
        if (scene.isVisible(cascadeVolume, command)) {
          passes[j].commandList.push(command);
          wasVisible = true;
        } else if (wasVisible) {
          break;
        }
      }
    }
  }
}

function executeShadowMapCastCommands(scene) {
  const { shadowState } = scene.frameState;
  const { shadowsEnabled, shadowMaps } = shadowState;

  if (!shadowsEnabled) {
    return;
  }

  // C10-10 — the caster sublist the PVS walk collected this frame. Conservative
  // no-op if PVS did not run or shadows were toggled off mid-frame (Trap T-5).
  const casters = shadowState.casterCommands;
  if (!defined(casters)) {
    return;
  }

  const context = scene._context;

  // NEW-CSM-CAST-NO-DISPATCH-VIEWER (Batch 296) — populate the per-pass
  // cast command lists for BOTH backends here, BEFORE delegating GPU
  // dispatch. The population is fully backend-agnostic: it runs
  // `scene.updateDerivedCommands` (which builds the per-shadow-map cast
  // derived commands), frustum/cascade-culls each caster via
  // `scene.isVisible`, and pushes the visible casters into
  // `shadowMap.passes[j].commandList`.
  //
  // Previously this ran ONLY on the WebGL fall-through path below — the
  // WebGPU context's `executeShadowMapCastCommands` returns `true` and the
  // old `if (...) return;` short-circuited the function before the
  // population loop, so `shadowMap.passes[j].commandList` was always empty
  // when the WebGPU cast pass iterated it. Result: zero WebGPU shadow
  // casters reached the cast pass (`csmRenderer._castDispatches` stayed 0)
  // and nothing cast a shadow, on both the single shadow map and the CSM
  // path. Hoisting the backend-neutral light/cascade population fixes both:
  // WebGPU consumes raw commands with `_shadowCast*` tags, while WebGL
  // consumes the derived cast commands prepared during PVS.
  for (let i = 0; i < shadowMaps.length; ++i) {
    const shadowMap = shadowMaps[i];
    if (shadowMap.outOfView) {
      continue;
    }
    const { passes } = shadowMap;
    for (let j = 0; j < passes.length; ++j) {
      passes[j].commandList.length = 0;
    }
    insertShadowCastCommands(scene, casters, shadowMap);
  }

  // Backend dispatch. WebGPU consumes the populated `passes[].commandList`
  // (raw WebGPUDrawCommands carry their own cast vertex buffers + cast
  // layout metadata) and returns `true`. WebGL returns `false` and falls
  // through to the per-pass execute loop, which dispatches the per-shadow-
  // map DERIVED cast command (`command.derivedCommands.shadows.castCommands[i]`).
  if (context.executeShadowMapCastCommands(scene)) {
    return;
  }

  const { uniformState } = context;

  for (let i = 0; i < shadowMaps.length; ++i) {
    const shadowMap = shadowMaps[i];
    if (shadowMap.outOfView) {
      continue;
    }

    const { passes } = shadowMap;
    for (let j = 0; j < passes.length; ++j) {
      const pass = shadowMap.passes[j];
      const { camera, commandList } = pass;
      uniformState.updateCamera(camera);
      shadowMap.updatePass(context, j);
      for (let k = 0; k < commandList.length; ++k) {
        const command = commandList[k];
        uniformState.updatePass(command.pass);
        const castCommand = command.derivedCommands.shadows.castCommands[i];
        executeCommand(castCommand, scene, pass.passState);
      }
    }
  }
}

export {
  executeCommand,
  executeCommands,
  executeComputeCommands,
  executeOverlayCommands,
  executeShadowMapCastCommands,
};

// Namespace default export for build system barrel compatibility
const SceneRenderer = {
  executeCommand,
  executeCommands,
  executeComputeCommands,
  executeOverlayCommands,
  executeShadowMapCastCommands,
};
export default SceneRenderer;
