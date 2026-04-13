import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import Transforms from "../Core/Transforms.js";
import Pass from "../Renderer/Pass.js";
import Camera from "./Camera.js";
import {
  executeCommands,
  executeComputeCommands,
  executeShadowMapCastCommands,
} from "./SceneRenderer.js";
import { updateDebugFrustumPlanes } from "./SceneDebug.js";
import SceneMode from "./SceneMode.js";

/**
 * 2D/3D/VR viewport dispatch. Manages camera and frustum setup for each
 * viewport configuration, then delegates to SceneRenderer for command execution.
 *
 * Extracted from Scene.js (Phase 5 of decomposition plan).
 * @private
 */

function updateShadowMaps(scene) {
  const frameState = scene._frameState;
  const { passes, shadowState, shadowMaps } = frameState;
  const length = shadowMaps.length;

  const shadowsEnabled =
    length > 0 &&
    !passes.pick &&
    !passes.pickVoxel &&
    scene.mode === SceneMode.SCENE3D;
  if (shadowsEnabled !== shadowState.shadowsEnabled) {
    ++shadowState.lastDirtyTime;
    shadowState.shadowsEnabled = shadowsEnabled;
  }

  shadowState.lightShadowsEnabled = false;

  if (!shadowsEnabled) {
    return;
  }

  for (let j = 0; j < length; ++j) {
    if (shadowMaps[j] !== shadowState.shadowMaps[j]) {
      ++shadowState.lastDirtyTime;
      break;
    }
  }

  shadowState.shadowMaps.length = 0;
  shadowState.lightShadowMaps.length = 0;

  for (let i = 0; i < length; ++i) {
    const shadowMap = shadowMaps[i];
    shadowMap.update(frameState);

    shadowState.shadowMaps.push(shadowMap);

    if (shadowMap.fromLightSource) {
      shadowState.lightShadowMaps.push(shadowMap);
      shadowState.lightShadowsEnabled = true;
    }

    if (shadowMap.dirty) {
      ++shadowState.lastDirtyTime;
      shadowMap.dirty = false;
    }
  }
}

function updateAndRenderPrimitives(scene) {
  const frameState = scene._frameState;

  frameState.edgeVisibilityRequested = false;

  scene._groundPrimitives.update(frameState);
  scene._primitives.update(frameState);

  if (
    frameState.edgeVisibilityRequested &&
    scene._enableEdgeVisibility === false
  ) {
    scene._enableEdgeVisibility = true;
  }

  updateDebugFrustumPlanes(scene);
  updateShadowMaps(scene);

  if (scene._globe) {
    scene._globe.render(frameState);
  }
}

const scratchEyeTranslation = new Cartesian3();

function executeWebVRCommands(scene, passState) {
  const view = scene._view;
  const camera = view.camera;
  const environmentState = scene._environmentState;
  const renderTranslucentDepthForPick =
    environmentState.renderTranslucentDepthForPick;

  updateAndRenderPrimitives(scene);

  view.createPotentiallyVisibleSet(scene);

  executeComputeCommands(scene);

  if (!renderTranslucentDepthForPick) {
    executeShadowMapCastCommands(scene);
  }

  const viewport = passState.viewport;
  viewport.x = 0;
  viewport.y = 0;
  viewport.width = viewport.width * 0.5;

  const savedCamera = Camera.clone(camera, scene._cameraVR);
  savedCamera.frustum = camera.frustum;

  const near = camera.frustum.near;
  const fo = near * (scene.focalLength ?? 5.0);
  const eyeSeparation = scene.eyeSeparation ?? fo / 30.0;
  const eyeTranslation = Cartesian3.multiplyByScalar(
    savedCamera.right,
    eyeSeparation * 0.5,
    scratchEyeTranslation,
  );

  camera.frustum.aspectRatio = viewport.width / viewport.height;

  const offset = (0.5 * eyeSeparation * near) / fo;

  Cartesian3.add(savedCamera.position, eyeTranslation, camera.position);
  camera.frustum.xOffset = offset;

  executeCommands(scene, passState);

  viewport.x = viewport.width;

  Cartesian3.subtract(savedCamera.position, eyeTranslation, camera.position);
  camera.frustum.xOffset = -offset;

  executeCommands(scene, passState);

  Camera.clone(savedCamera, camera);
}

const scratch2DViewportCartographic = new Cartographic(
  Math.PI,
  CesiumMath.PI_OVER_TWO,
);
const scratch2DViewportMaxCoord = new Cartesian3();
const scratch2DViewportSavedPosition = new Cartesian3();
const scratch2DViewportTransform = new Matrix4();
const scratch2DViewportCameraTransform = new Matrix4();
const scratch2DViewportEyePoint = new Cartesian3();
const scratch2DViewportWindowCoords = new Cartesian3();
const scratch2DViewport = new BoundingRectangle();

function execute2DViewportCommands(scene, passState) {
  const { frameState, camera } = scene;
  const { uniformState } = scene.context;

  const originalViewport = passState.viewport;
  const viewport = BoundingRectangle.clone(originalViewport, scratch2DViewport);
  passState.viewport = viewport;

  const maxCartographic = scratch2DViewportCartographic;
  const maxCoord = scratch2DViewportMaxCoord;

  const projection = scene.mapProjection;
  projection.project(maxCartographic, maxCoord);

  const position = Cartesian3.clone(
    camera.position,
    scratch2DViewportSavedPosition,
  );
  const transform = Matrix4.clone(
    camera.transform,
    scratch2DViewportCameraTransform,
  );
  const frustum = camera.frustum.clone();

  camera._setTransform(Matrix4.IDENTITY);

  const viewportTransformation = Matrix4.computeViewportTransformation(
    viewport,
    0.0,
    1.0,
    scratch2DViewportTransform,
  );
  const projectionMatrix = camera.frustum.projectionMatrix;

  const x = camera.positionWC.y;
  const eyePoint = Cartesian3.fromElements(
    CesiumMath.sign(x) * maxCoord.x - x,
    0.0,
    -camera.positionWC.x,
    scratch2DViewportEyePoint,
  );
  const windowCoordinates = Transforms.pointToGLWindowCoordinates(
    projectionMatrix,
    viewportTransformation,
    eyePoint,
    scratch2DViewportWindowCoords,
  );

  windowCoordinates.x = Math.floor(windowCoordinates.x);

  const viewportX = viewport.x;
  const viewportWidth = viewport.width;

  if (
    x === 0.0 ||
    windowCoordinates.x <= viewportX ||
    windowCoordinates.x >= viewportX + viewportWidth
  ) {
    executeCommandsInViewport(true, scene, passState);
  } else if (
    Math.abs(viewportX + viewportWidth * 0.5 - windowCoordinates.x) < 1.0
  ) {
    viewport.width = windowCoordinates.x - viewport.x;

    camera.position.x *= CesiumMath.sign(camera.position.x);

    camera.frustum.right = 0.0;

    frameState.cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    uniformState.update(frameState);

    executeCommandsInViewport(true, scene, passState);

    viewport.x = windowCoordinates.x;

    camera.position.x = -camera.position.x;

    camera.frustum.right = -camera.frustum.left;
    camera.frustum.left = 0.0;

    frameState.cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    uniformState.update(frameState);

    executeCommandsInViewport(false, scene, passState);
  } else if (windowCoordinates.x > viewportX + viewportWidth * 0.5) {
    viewport.width = windowCoordinates.x - viewportX;

    const right = camera.frustum.right;
    camera.frustum.right = maxCoord.x - x;

    frameState.cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    uniformState.update(frameState);

    executeCommandsInViewport(true, scene, passState);

    viewport.x = windowCoordinates.x;
    viewport.width = viewportX + viewportWidth - windowCoordinates.x;

    camera.position.x = -camera.position.x;

    camera.frustum.left = -camera.frustum.right;
    camera.frustum.right = right - camera.frustum.right * 2.0;

    frameState.cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    uniformState.update(frameState);

    executeCommandsInViewport(false, scene, passState);
  } else {
    viewport.x = windowCoordinates.x;
    viewport.width = viewportX + viewportWidth - windowCoordinates.x;

    const left = camera.frustum.left;
    camera.frustum.left = -maxCoord.x - x;

    frameState.cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    uniformState.update(frameState);

    executeCommandsInViewport(true, scene, passState);

    viewport.x = viewportX;
    viewport.width = windowCoordinates.x - viewportX;

    camera.position.x = -camera.position.x;

    camera.frustum.right = -camera.frustum.left;
    camera.frustum.left = left - camera.frustum.left * 2.0;

    frameState.cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    );
    uniformState.update(frameState);

    executeCommandsInViewport(false, scene, passState);
  }

  camera._setTransform(transform);
  Cartesian3.clone(position, camera.position);
  camera.frustum = frustum.clone();
  passState.viewport = originalViewport;
}

/**
 * Execute the draw commands to render the scene into the viewport.
 * If this is the first viewport rendered, the framebuffers will be cleared
 * to the background color.
 *
 * SORT-3: After primitives update, bin commands through the RenderScheduler
 * to populate materialSortId on each DrawCommand. The existing multi-level
 * comparators (frontToBack, backToFront) already read materialSortId — this
 * activation step makes material batching work automatically.
 */
function executeCommandsInViewport(firstViewport, scene, passState) {
  const view = scene._view;
  const { renderTranslucentDepthForPick } = scene._environmentState;

  if (!firstViewport) {
    scene.frameState.commandList.length = 0;
  }

  updateAndRenderPrimitives(scene);

  // SORT-3: Bin commands through RenderScheduler for material sort ID population,
  // then sort all layers for proper render ordering.
  const scheduler = scene._renderScheduler;
  if (scheduler.enabled) {
    const cmdList = scene.frameState.commandList;
    const cmdCount = cmdList.length;
    for (let ci = 0; ci < cmdCount; ci++) {
      const cmd = cmdList[ci];
      scheduler.binCommand(cmd, cmd.pass === Pass.TRANSLUCENT);
    }

    // SORT-FULL: Sort all layer buckets after binning completes.
    // This applies per-layer sort modes (MATERIAL_MESH, BACK_TO_FRONT, etc.)
    // to the commands within each render layer.
    scheduler.sortAllLayers(scene.frameState.camera.positionWC);
  }

  // Octree-accelerated PVS when enabled and command count exceeds threshold
  const octree = scheduler.octree;
  if (octree.enabled) {
    const buildResult = octree.build(
      scene.frameState.commandList,
      scene.frameState.frameNumber,
    );
    if (buildResult.useOctree) {
      // Replace commandList with octree-visible + bypass commands
      const cullingVolume = scene.frameState.cullingVolume;
      const occluder =
        scene.frameState.mode === SceneMode.SCENE3D
          ? scene.frameState.occluder
          : undefined;
      const visible = octree.collectVisible(cullingVolume, occluder);
      // Merge visible octree commands with bypass commands (terrain, 3D Tiles, etc.)
      scene.frameState.commandList.length = 0;
      const bypassList = buildResult.bypassCommands;
      for (let bi = 0; bi < bypassList.length; bi++) {
        scene.frameState.commandList.push(bypassList[bi]);
      }
      for (let vi = 0; vi < visible.length; vi++) {
        scene.frameState.commandList.push(visible[vi]);
      }
    }
  }

  // Occlusion culling (opt-in, requires compute shader support)
  const occlusionCulling = scheduler.occlusionCulling;
  if (occlusionCulling.enabled) {
    occlusionCulling.beginFrame(null);
    const occResult = occlusionCulling.testCommands(
      scene.frameState.commandList,
    );
    // When results are ready, only pass visible commands forward.
    // When not ready (async), all commands pass through (conservative).
    if (occResult.occluded.length > 0) {
      scene.frameState.commandList.length = 0;
      for (let oi = 0; oi < occResult.visible.length; oi++) {
        scene.frameState.commandList.push(occResult.visible[oi]);
      }
    }
  }

  view.createPotentiallyVisibleSet(scene);

  if (firstViewport) {
    executeComputeCommands(scene);
    if (!renderTranslucentDepthForPick) {
      executeShadowMapCastCommands(scene);
    }
  }

  executeCommands(scene, passState);

  // ── GPU-side Hi-Z occlusion dispatch ──────────────────────────────
  //
  // After executeCommands the depth attachment is populated. End the
  // active render pass, dispatch the Hi-Z pyramid build + occlusion
  // test compute passes on the same command encoder, then resume the
  // render pass (if needed for overlays/post-processing downstream).
  //
  // The OcclusionCulling.dispatchGPU method routes through the feature
  // renderer so this code stays backend-agnostic — the encoder and
  // depth view are opaque handles that only the dispatcher understands.
  //
  // scheduleReadback is fire-and-forget: the async mapAsync resolves
  // before the NEXT frame's testCommands() call reads the visibility
  // bits, closing the one-frame-latency loop.
  if (occlusionCulling.enabled) {
    const context = scene.context;
    const encoder = context.currentCommandEncoder;
    const depthView = context.depthOnlyTextureView;

    if (encoder && depthView) {
      // Lazy initialization on first frame with depth available.
      if (!occlusionCulling.isInitialized) {
        occlusionCulling.initialize(
          context,
          context.drawingBufferWidth,
          context.drawingBufferHeight,
        );
      }

      if (occlusionCulling.isInitialized) {
        context.endCurrentRenderPass();

        const camera = scene.frameState.camera;
        const frustum = camera.frustum;
        occlusionCulling.dispatchGPU(encoder, depthView, {
          viewProjection: context.uniformState.viewProjection,
          screenWidth: context.drawingBufferWidth,
          screenHeight: context.drawingBufferHeight,
          nearPlane: frustum.near,
          farPlane: frustum.far,
        });

        occlusionCulling.scheduleReadback();

        context.resumeDefaultRenderPass();
      }
    }
  }
}

export {
  executeCommandsInViewport,
  execute2DViewportCommands,
  executeWebVRCommands,
  updateAndRenderPrimitives,
};

// Namespace default export for build system barrel compatibility
const ViewportExecutor = {
  executeCommandsInViewport,
  execute2DViewportCommands,
  executeWebVRCommands,
  updateAndRenderPrimitives,
};
export default ViewportExecutor;
