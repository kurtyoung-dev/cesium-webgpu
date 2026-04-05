import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import Check from "../Core/Check.js";
import Color from "../Core/Color.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import Matrix4 from "../Core/Matrix4.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import PerspectiveFrustum from "../Core/PerspectiveFrustum.js";
import PerspectiveOffCenterFrustum from "../Core/PerspectiveOffCenterFrustum.js";
import Ray from "../Core/Ray.js";
import ShowGeometryInstanceAttribute from "../Core/ShowGeometryInstanceAttribute.js";
import Camera from "./Camera.js";
import Cesium3DTileFeature from "./Cesium3DTileFeature.js";
import Cesium3DTilePass from "./Cesium3DTilePass.js";
import Cesium3DTilePassState from "./Cesium3DTilePassState.js";
import MetadataPicking from "./MetadataPicking.js";
import PickDepth from "./PickDepth.js";
import SceneMode from "./SceneMode.js";
import SceneTransforms from "./SceneTransforms.js";
import View from "./View.js";
import {
  updateMostDetailedRayPick,
  pickFromRay,
  drillPickFromRayHelper,
  deferPromiseUntilPostRender,
  launchMostDetailedRayPick,
  getRayForSampleHeight,
  getRayForClampToHeight,
  getHeightFromCartesian,
  sampleHeightMostDetailed,
  clampToHeightMostDetailed,
} from "./PickingRayHelpers.js";

const offscreenDefaultWidth = 0.1;

const pickTilesetPassState = new Cesium3DTilePassState({
  pass: Cesium3DTilePass.PICK,
});

/**
 * @private
 */
class Picking {
  constructor(scene) {
    this._mostDetailedRayPicks = [];
    this.pickRenderStateCache = {};
    this._pickPositionCache = {};
    this._pickPositionCacheDirty = false;

    const pickOffscreenViewport = new BoundingRectangle(0, 0, 1, 1);
    const pickOffscreenCamera = new Camera(scene);
    pickOffscreenCamera.frustum = new OrthographicFrustum({
      width: offscreenDefaultWidth,
      aspectRatio: 1.0,
      near: 0.1,
    });

    this._pickOffscreenView = new View(
      scene,
      pickOffscreenCamera,
      pickOffscreenViewport,
    );
  }

  update() {
    this._pickPositionCacheDirty = true;
  }

  getPickDepth(scene, index) {
    const pickDepths = scene.view.pickDepths;
    let pickDepth = pickDepths[index];
    if (!defined(pickDepth)) {
      pickDepth = new PickDepth();
      pickDepths[index] = pickDepth;
    }
    return pickDepth;
  }

  /**
   * @see Picking#pick
   */
  async pickAsync(scene, windowPosition, width, height, limit = 1) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("windowPosition", windowPosition);
    //>>includeEnd('debug');

    const { frameState, defaultView } = scene;
    const { pickFramebuffer } = defaultView;
    const drawingBufferRectangle = scratchRectangle;
    pickBegin(scene, windowPosition, drawingBufferRectangle, width, height);
    let pickedObjects;
    if (defined(pickFramebuffer.endAsync)) {
      pickedObjects = pickFramebuffer.endAsync(
        drawingBufferRectangle,
        frameState,
        limit,
      );
    } else {
      pickedObjects = pickFramebuffer.end(drawingBufferRectangle, limit);
      pickedObjects = Promise.resolve(pickedObjects);
      oneTimeWarning(
        "picking-async-fallback",
        "Fallback to synchronous picking because async operation requires WebGL2 or a context that supports it.",
      );
    }
    pickEnd(scene);
    return pickedObjects;
  }

  pick(scene, windowPosition, width, height, limit = 1) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("windowPosition", windowPosition);
    //>>includeEnd('debug');

    const { defaultView } = scene;
    const { pickFramebuffer } = defaultView;
    const drawingBufferRectangle = scratchRectangle;
    pickBegin(scene, windowPosition, drawingBufferRectangle, width, height);
    const pickedObjects = pickFramebuffer.end(drawingBufferRectangle, limit);
    pickEnd(scene);
    return pickedObjects;
  }

  pickVoxelCoordinate(scene, windowPosition, width, height) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("windowPosition", windowPosition);
    //>>includeEnd('debug');

    const { context, frameState, defaultView } = scene;
    const { viewport, pickFramebuffer } = defaultView;

    scene.view = defaultView;
    viewport.x = 0;
    viewport.y = 0;
    viewport.width = context.drawingBufferWidth;
    viewport.height = context.drawingBufferHeight;

    let passState = defaultView.passState;
    passState.viewport = BoundingRectangle.clone(viewport, passState.viewport);

    const drawingBufferPosition =
      SceneTransforms.transformWindowToDrawingBuffer(
        scene,
        windowPosition,
        scratchPosition,
      );
    const drawingBufferRectangle = computePickingDrawingBufferRectangle(
      context.drawingBufferHeight,
      drawingBufferPosition,
      width,
      height,
      scratchRectangle,
    );

    scene.jobScheduler.disableThisFrame();
    scene.updateFrameState();
    frameState.cullingVolume = getPickCullingVolume(
      scene,
      drawingBufferPosition,
      drawingBufferRectangle.width,
      drawingBufferRectangle.height,
      viewport,
    );
    frameState.invertClassification = false;
    frameState.passes.pickVoxel = true;
    frameState.tilesetPassState = pickTilesetPassState;

    context.uniformState.update(frameState);
    scene.updateEnvironment();

    passState = pickFramebuffer.begin(drawingBufferRectangle, viewport);
    scene.updateAndExecuteCommands(passState, scratchColorZero);
    scene.resolveFramebuffers(passState);

    const voxelInfo = pickFramebuffer.readCenterPixel(drawingBufferRectangle);
    context.endFrame();
    return voxelInfo;
  }

  /**
   * @private
   */
  pickMetadata(scene, windowPosition, pickedMetadataInfo) {
    //>>includeStart('debug', pragmas.debug);
    Check.typeOf.object("windowPosition", windowPosition);
    Check.typeOf.object("pickedMetadataInfo", pickedMetadataInfo);
    //>>includeEnd('debug');

    const { context, frameState, defaultView } = scene;
    const { viewport, pickFramebuffer } = defaultView;

    scene.view = defaultView;
    viewport.x = 0;
    viewport.y = 0;
    viewport.width = context.drawingBufferWidth;
    viewport.height = context.drawingBufferHeight;

    let passState = defaultView.passState;
    passState.viewport = BoundingRectangle.clone(viewport, passState.viewport);

    const drawingBufferPosition =
      SceneTransforms.transformWindowToDrawingBuffer(
        scene,
        windowPosition,
        scratchPosition,
      );
    const drawingBufferRectangle = computePickingDrawingBufferRectangle(
      context.drawingBufferHeight,
      drawingBufferPosition,
      1.0,
      1.0,
      scratchRectangle,
    );

    scene.jobScheduler.disableThisFrame();
    scene.updateFrameState();
    frameState.cullingVolume = getPickCullingVolume(
      scene,
      drawingBufferPosition,
      drawingBufferRectangle.width,
      drawingBufferRectangle.height,
      viewport,
    );
    frameState.invertClassification = false;
    frameState.passes.pick = true;
    frameState.tilesetPassState = pickTilesetPassState;

    frameState.pickingMetadata = true;
    frameState.pickedMetadataInfo = pickedMetadataInfo;
    context.uniformState.update(frameState);
    scene.updateEnvironment();

    passState = pickFramebuffer.begin(drawingBufferRectangle, viewport);
    scene.updateAndExecuteCommands(passState, scratchColorZero);

    const oldOIT = scene._environmentState.useOIT;
    scene._environmentState.useOIT = false;
    scene.resolveFramebuffers(passState);
    scene._environmentState.useOIT = oldOIT;

    const rawMetadataPixel = pickFramebuffer.readCenterPixel(
      drawingBufferRectangle,
    );
    context.endFrame();
    frameState.pickingMetadata = false;

    return MetadataPicking.decodeMetadataValues(
      pickedMetadataInfo.classProperty,
      pickedMetadataInfo.metadataProperty,
      rawMetadataPixel,
    );
  }

  pickPositionWorldCoordinates(scene, windowPosition, result) {
    if (!scene.useDepthPicking) {
      return undefined;
    }

    //>>includeStart('debug', pragmas.debug);
    Check.defined("windowPosition", windowPosition);
    if (!scene.context.depthTexture) {
      throw new DeveloperError(
        "Picking from the depth buffer is not supported. Check pickPositionSupported.",
      );
    }
    //>>includeEnd('debug');

    const cacheKey = windowPosition.toString();

    if (this._pickPositionCacheDirty) {
      this._pickPositionCache = {};
      this._pickPositionCacheDirty = false;
    } else if (Object.hasOwn(this._pickPositionCache, cacheKey)) {
      return Cartesian3.clone(this._pickPositionCache[cacheKey], result);
    }

    const { context, frameState, camera, defaultView } = scene;
    const { uniformState } = context;

    scene.view = defaultView;

    const drawingBufferPosition =
      SceneTransforms.transformWindowToDrawingBuffer(
        scene,
        windowPosition,
        scratchPosition,
      );
    if (scene.pickTranslucentDepth) {
      renderTranslucentDepthForPick(scene, drawingBufferPosition);
    } else {
      scene.updateFrameState();
      uniformState.update(frameState);
      scene.updateEnvironment();
    }
    drawingBufferPosition.y =
      scene.drawingBufferHeight - drawingBufferPosition.y;

    let frustum;
    if (defined(camera.frustum.fov)) {
      frustum = camera.frustum.clone(scratchPerspectiveFrustum);
    } else if (defined(camera.frustum.infiniteProjectionMatrix)) {
      frustum = camera.frustum.clone(scratchPerspectiveOffCenterFrustum);
    } else if (defined(camera.frustum.width)) {
      frustum = camera.frustum.clone(scratchOrthographicFrustum);
    } else {
      frustum = camera.frustum.clone(scratchOrthographicOffCenterFrustum);
    }

    const { frustumCommandsList } = defaultView;
    const numFrustums = frustumCommandsList.length;
    for (let i = 0; i < numFrustums; ++i) {
      const pickDepth = this.getPickDepth(scene, i);
      const depth = pickDepth.getDepth(
        context,
        drawingBufferPosition.x,
        drawingBufferPosition.y,
      );
      if (!defined(depth)) {
        continue;
      }
      if (depth > 0.0 && depth < 1.0) {
        const renderedFrustum = frustumCommandsList[i];
        let height2D;
        if (scene.mode === SceneMode.SCENE2D) {
          height2D = camera.position.z;
          camera.position.z = height2D - renderedFrustum.near + 1.0;
          frustum.far = Math.max(
            1.0,
            renderedFrustum.far - renderedFrustum.near,
          );
          frustum.near = 1.0;
          uniformState.update(frameState);
          uniformState.updateFrustum(frustum);
        } else {
          frustum.near =
            renderedFrustum.near *
            (i !== 0 ? scene.opaqueFrustumNearOffset : 1.0);
          frustum.far = renderedFrustum.far;
          uniformState.updateFrustum(frustum);
        }

        result = SceneTransforms.drawingBufferToWorldCoordinates(
          scene,
          drawingBufferPosition,
          depth,
          result,
        );

        if (scene.mode === SceneMode.SCENE2D) {
          camera.position.z = height2D;
          uniformState.update(frameState);
        }

        this._pickPositionCache[cacheKey] = Cartesian3.clone(result);
        return result;
      }
    }

    this._pickPositionCache[cacheKey] = undefined;
    return undefined;
  }

  pickPosition(scene, windowPosition, result) {
    result = this.pickPositionWorldCoordinates(scene, windowPosition, result);
    if (defined(result) && scene.mode !== SceneMode.SCENE3D) {
      Cartesian3.fromElements(result.y, result.z, result.x, result);
      const projection = scene.mapProjection;
      const ellipsoid = projection.ellipsoid;
      const cart = projection.unproject(
        result,
        scratchPickPositionCartographic,
      );
      ellipsoid.cartographicToCartesian(cart, result);
    }
    return result;
  }

  drillPick(scene, windowPosition, limit, width, height) {
    const pickCallback = (limit) => {
      const pickedObjects = this.pick(
        scene,
        windowPosition,
        width,
        height,
        limit,
      );
      return pickedObjects.map((object) => ({
        object: object,
        position: undefined,
        exclude: false,
      }));
    };
    const objects = drillPick(pickCallback, limit);
    return objects.map((element) => element.object);
  }

  updateMostDetailedRayPicks(scene) {
    const rayPicks = this._mostDetailedRayPicks;
    for (let i = 0; i < rayPicks.length; ++i) {
      if (updateMostDetailedRayPick(this, scene, rayPicks[i])) {
        rayPicks.splice(i--, 1);
      }
    }
  }

  pickFromRay(scene, ray, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("ray", ray);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "Ray intersections are only supported in 3D mode.",
      );
    }
    //>>includeEnd('debug');
    return pickFromRay(this, scene, ray, objectsToExclude, width, false, false);
  }

  drillPickFromRay(scene, ray, limit, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("ray", ray);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "Ray intersections are only supported in 3D mode.",
      );
    }
    //>>includeEnd('debug');
    return drillPickFromRayHelper(
      this,
      scene,
      ray,
      limit,
      objectsToExclude,
      width,
      false,
      false,
    );
  }

  pickFromRayMostDetailed(scene, ray, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("ray", ray);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "Ray intersections are only supported in 3D mode.",
      );
    }
    //>>includeEnd('debug');
    const that = this;
    ray = Ray.clone(ray);
    objectsToExclude = defined(objectsToExclude)
      ? objectsToExclude.slice()
      : objectsToExclude;
    return deferPromiseUntilPostRender(
      scene,
      launchMostDetailedRayPick(
        that,
        scene,
        ray,
        objectsToExclude,
        width,
        function () {
          return pickFromRay(
            that,
            scene,
            ray,
            objectsToExclude,
            width,
            false,
            true,
          );
        },
      ),
    );
  }

  drillPickFromRayMostDetailed(scene, ray, limit, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("ray", ray);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "Ray intersections are only supported in 3D mode.",
      );
    }
    //>>includeEnd('debug');
    const that = this;
    ray = Ray.clone(ray);
    objectsToExclude = defined(objectsToExclude)
      ? objectsToExclude.slice()
      : objectsToExclude;
    return deferPromiseUntilPostRender(
      scene,
      launchMostDetailedRayPick(
        that,
        scene,
        ray,
        objectsToExclude,
        width,
        function () {
          return drillPickFromRayHelper(
            that,
            scene,
            ray,
            limit,
            objectsToExclude,
            width,
            false,
            true,
          );
        },
      ),
    );
  }

  sampleHeight(scene, position, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("position", position);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError("sampleHeight is only supported in 3D mode.");
    }
    if (!scene.sampleHeightSupported) {
      throw new DeveloperError(
        "sampleHeight requires depth texture support. Check sampleHeightSupported.",
      );
    }
    //>>includeEnd('debug');
    const ray = getRayForSampleHeight(scene, position);
    const pickResult = pickFromRay(
      this,
      scene,
      ray,
      objectsToExclude,
      width,
      true,
      false,
    );
    if (defined(pickResult)) {
      return getHeightFromCartesian(scene, pickResult.position);
    }
  }

  clampToHeight(scene, cartesian, objectsToExclude, width, result) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("cartesian", cartesian);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError("clampToHeight is only supported in 3D mode.");
    }
    if (!scene.clampToHeightSupported) {
      throw new DeveloperError(
        "clampToHeight requires depth texture support. Check clampToHeightSupported.",
      );
    }
    //>>includeEnd('debug');
    const ray = getRayForClampToHeight(scene, cartesian);
    const pickResult = pickFromRay(
      this,
      scene,
      ray,
      objectsToExclude,
      width,
      true,
      false,
    );
    if (defined(pickResult)) {
      return Cartesian3.clone(pickResult.position, result);
    }
  }

  sampleHeightMostDetailed(scene, positions, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("positions", positions);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "sampleHeightMostDetailed is only supported in 3D mode.",
      );
    }
    if (!scene.sampleHeightSupported) {
      throw new DeveloperError(
        "sampleHeightMostDetailed requires depth texture support. Check sampleHeightSupported.",
      );
    }
    //>>includeEnd('debug');
    objectsToExclude = defined(objectsToExclude)
      ? objectsToExclude.slice()
      : objectsToExclude;
    const length = positions.length;
    const promises = new Array(length);
    for (let i = 0; i < length; ++i) {
      promises[i] = sampleHeightMostDetailed(
        this,
        scene,
        positions[i],
        objectsToExclude,
        width,
      );
    }
    return deferPromiseUntilPostRender(
      scene,
      Promise.all(promises).then(function (heights) {
        const length = heights.length;
        for (let i = 0; i < length; ++i) {
          positions[i].height = heights[i];
        }
        return positions;
      }),
    );
  }

  clampToHeightMostDetailed(scene, cartesians, objectsToExclude, width) {
    //>>includeStart('debug', pragmas.debug);
    Check.defined("cartesians", cartesians);
    if (scene.mode !== SceneMode.SCENE3D) {
      throw new DeveloperError(
        "clampToHeightMostDetailed is only supported in 3D mode.",
      );
    }
    if (!scene.clampToHeightSupported) {
      throw new DeveloperError(
        "clampToHeightMostDetailed requires depth texture support. Check clampToHeightSupported.",
      );
    }
    //>>includeEnd('debug');
    objectsToExclude = defined(objectsToExclude)
      ? objectsToExclude.slice()
      : objectsToExclude;
    const length = cartesians.length;
    const promises = new Array(length);
    for (let i = 0; i < length; ++i) {
      promises[i] = clampToHeightMostDetailed(
        this,
        scene,
        cartesians[i],
        objectsToExclude,
        width,
        cartesians[i],
      );
    }
    return deferPromiseUntilPostRender(
      scene,
      Promise.all(promises).then(function (clampedCartesians) {
        const length = clampedCartesians.length;
        for (let i = 0; i < length; ++i) {
          cartesians[i] = clampedCartesians[i];
        }
        return cartesians;
      }),
    );
  }

  destroy() {
    this._pickOffscreenView =
      this._pickOffscreenView && this._pickOffscreenView.destroy();
  }
}

// ---- File-scoped helpers (culling volumes) ----

const scratchOrthoPickingFrustum = new OrthographicOffCenterFrustum();
const scratchOrthoOrigin = new Cartesian3();
const scratchOrthoDirection = new Cartesian3();
const scratchOrthoPixelSize = new Cartesian2();
const scratchOrthoPickVolumeMatrix4 = new Matrix4();

function getPickOrthographicCullingVolume(
  scene,
  drawingBufferPosition,
  width,
  height,
  viewport,
) {
  const camera = scene.camera;
  let frustum = camera.frustum;
  const offCenterFrustum = frustum.offCenterFrustum;
  if (defined(offCenterFrustum)) {
    frustum = offCenterFrustum;
  }

  let x = (2.0 * (drawingBufferPosition.x - viewport.x)) / viewport.width - 1.0;
  x *= (frustum.right - frustum.left) * 0.5;
  let y =
    (2.0 * (viewport.height - drawingBufferPosition.y - viewport.y)) /
      viewport.height -
    1.0;
  y *= (frustum.top - frustum.bottom) * 0.5;

  const transform = Matrix4.clone(
    camera.transform,
    scratchOrthoPickVolumeMatrix4,
  );
  camera._setTransform(Matrix4.IDENTITY);

  const origin = Cartesian3.clone(camera.position, scratchOrthoOrigin);
  Cartesian3.multiplyByScalar(camera.right, x, scratchOrthoDirection);
  Cartesian3.add(scratchOrthoDirection, origin, origin);
  Cartesian3.multiplyByScalar(camera.up, y, scratchOrthoDirection);
  Cartesian3.add(scratchOrthoDirection, origin, origin);

  camera._setTransform(transform);

  if (scene.mode === SceneMode.SCENE2D) {
    Cartesian3.fromElements(origin.z, origin.x, origin.y, origin);
  }

  const pixelSize = frustum.getPixelDimensions(
    viewport.width,
    viewport.height,
    1.0,
    1.0,
    scratchOrthoPixelSize,
  );

  const ortho = scratchOrthoPickingFrustum;
  ortho.right = pixelSize.x * 0.5;
  ortho.left = -ortho.right;
  ortho.top = pixelSize.y * 0.5;
  ortho.bottom = -ortho.top;
  ortho.near = frustum.near;
  ortho.far = frustum.far;

  return ortho.computeCullingVolume(origin, camera.directionWC, camera.upWC);
}

const scratchPerspPickingFrustum = new PerspectiveOffCenterFrustum();
const scratchPerspPixelSize = new Cartesian2();

function getPickPerspectiveCullingVolume(
  scene,
  drawingBufferPosition,
  width,
  height,
  viewport,
) {
  const camera = scene.camera;
  const frustum = camera.frustum;
  const near = frustum.near;

  const tanPhi = Math.tan(frustum.fovy * 0.5);
  const tanTheta = frustum.aspectRatio * tanPhi;

  const x =
    (2.0 * (drawingBufferPosition.x - viewport.x)) / viewport.width - 1.0;
  const y =
    (2.0 * (viewport.height - drawingBufferPosition.y - viewport.y)) /
      viewport.height -
    1.0;

  const xDir = x * near * tanTheta;
  const yDir = y * near * tanPhi;

  const pixelSize = frustum.getPixelDimensions(
    viewport.width,
    viewport.height,
    1.0,
    1.0,
    scratchPerspPixelSize,
  );
  const pickWidth = pixelSize.x * width * 0.5;
  const pickHeight = pixelSize.y * height * 0.5;

  const offCenter = scratchPerspPickingFrustum;
  offCenter.top = yDir + pickHeight;
  offCenter.bottom = yDir - pickHeight;
  offCenter.right = xDir + pickWidth;
  offCenter.left = xDir - pickWidth;
  offCenter.near = near;
  offCenter.far = frustum.far;

  return offCenter.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC,
  );
}

function getPickCullingVolume(
  scene,
  drawingBufferPosition,
  width,
  height,
  viewport,
) {
  const frustum = scene.camera.frustum;
  if (
    frustum instanceof OrthographicFrustum ||
    frustum instanceof OrthographicOffCenterFrustum
  ) {
    return getPickOrthographicCullingVolume(
      scene,
      drawingBufferPosition,
      width,
      height,
      viewport,
    );
  }
  return getPickPerspectiveCullingVolume(
    scene,
    drawingBufferPosition,
    width,
    height,
    viewport,
  );
}

// ---- Pick begin/end ----

const scratchRectangle = new BoundingRectangle(0.0, 0.0, 3.0, 3.0);
const scratchPosition = new Cartesian2();
const scratchColorZero = new Color(0.0, 0.0, 0.0, 0.0);

function computePickingDrawingBufferRectangle(
  drawingBufferHeight,
  position,
  width,
  height,
  result,
) {
  result.width = width ?? 3.0;
  result.height = height ?? result.width;
  result.x = position.x - (result.width - 1.0) * 0.5;
  result.y = drawingBufferHeight - position.y - (result.height - 1.0) * 0.5;
  return result;
}

function pickBegin(
  scene,
  windowPosition,
  drawingBufferRectangle,
  width,
  height,
) {
  const { context, frameState, defaultView } = scene;
  const { viewport, pickFramebuffer } = defaultView;

  scene.view = defaultView;
  viewport.x = 0;
  viewport.y = 0;
  viewport.width = context.drawingBufferWidth;
  viewport.height = context.drawingBufferHeight;

  let passState = defaultView.passState;
  passState.viewport = BoundingRectangle.clone(viewport, passState.viewport);

  const drawingBufferPosition = SceneTransforms.transformWindowToDrawingBuffer(
    scene,
    windowPosition,
    scratchPosition,
  );
  computePickingDrawingBufferRectangle(
    context.drawingBufferHeight,
    drawingBufferPosition,
    width,
    height,
    drawingBufferRectangle,
  );

  scene.jobScheduler.disableThisFrame();
  scene.updateFrameState();
  frameState.cullingVolume = getPickCullingVolume(
    scene,
    drawingBufferPosition,
    drawingBufferRectangle.width,
    drawingBufferRectangle.height,
    viewport,
  );
  frameState.invertClassification = false;
  frameState.passes.pick = true;
  frameState.tilesetPassState = pickTilesetPassState;

  context.uniformState.update(frameState);
  scene.updateEnvironment();

  passState = pickFramebuffer.begin(drawingBufferRectangle, viewport);
  scene.updateAndExecuteCommands(passState, scratchColorZero);
  scene.resolveFramebuffers(passState);
}

function pickEnd(scene) {
  scene.context.endFrame();
}

// ---- Translucent depth for pick position ----

function renderTranslucentDepthForPick(scene, drawingBufferPosition) {
  const { defaultView, context, frameState, environmentState } = scene;
  const { viewport, pickDepthFramebuffer } = defaultView;

  scene.view = defaultView;
  viewport.x = 0;
  viewport.y = 0;
  viewport.width = context.drawingBufferWidth;
  viewport.height = context.drawingBufferHeight;

  let passState = defaultView.passState;
  passState.viewport = BoundingRectangle.clone(viewport, passState.viewport);

  scene.clearPasses(frameState.passes);
  frameState.passes.pick = true;
  frameState.passes.depth = true;
  frameState.cullingVolume = getPickCullingVolume(
    scene,
    drawingBufferPosition,
    1,
    1,
    viewport,
  );
  frameState.tilesetPassState = pickTilesetPassState;

  scene.updateEnvironment();
  environmentState.renderTranslucentDepthForPick = true;
  passState = pickDepthFramebuffer.update(
    context,
    drawingBufferPosition,
    viewport,
  );

  scene.updateAndExecuteCommands(passState, scratchColorZero);
  scene.resolveFramebuffers(passState);
  context.endFrame();
}

const scratchPerspectiveFrustum = new PerspectiveFrustum();
const scratchPerspectiveOffCenterFrustum = new PerspectiveOffCenterFrustum();
const scratchOrthographicFrustum = new OrthographicFrustum();
const scratchOrthographicOffCenterFrustum = new OrthographicOffCenterFrustum();
const scratchPickPositionCartographic = new Cartographic();

// ---- Screen-space drill pick ----

function addDrillPickedResults(
  pickedResults,
  limit,
  results,
  pickedPrimitives,
  pickedAttributes,
  pickedFeatures,
) {
  for (const pickedResult of pickedResults) {
    const object = pickedResult.object;
    const position = pickedResult.position;
    const exclude = pickedResult.exclude;

    if (defined(position) && !defined(object)) {
      results.push(pickedResult);
      return true;
    }
    if (!defined(object) || !defined(object.primitive)) {
      return true;
    }
    if (!exclude) {
      results.push(pickedResult);
      if (results.length >= limit) {
        return true;
      }
    }

    const primitive = object.primitive;
    let hasShowAttribute = false;

    if (typeof primitive.getGeometryInstanceAttributes === "function") {
      if (defined(object.id)) {
        const attributes = primitive.getGeometryInstanceAttributes(object.id);
        if (defined(attributes) && defined(attributes.show)) {
          hasShowAttribute = true;
          attributes.show = ShowGeometryInstanceAttribute.toValue(
            false,
            attributes.show,
          );
          pickedAttributes.push(attributes);
        }
      }
    }
    if (object instanceof Cesium3DTileFeature) {
      hasShowAttribute = true;
      object.show = false;
      pickedFeatures.push(object);
    }
    if (!hasShowAttribute) {
      primitive.show = false;
      pickedPrimitives.push(primitive);
    }
  }
}

function drillPick(pickCallback, limit) {
  const results = [];
  const pickedPrimitives = [];
  const pickedAttributes = [];
  const pickedFeatures = [];
  if (!defined(limit)) {
    limit = Number.MAX_VALUE;
  }

  let pickedResults = pickCallback(limit);
  while (defined(pickedResults) && pickedResults.length > 0) {
    const complete = addDrillPickedResults(
      pickedResults,
      limit,
      results,
      pickedPrimitives,
      pickedAttributes,
      pickedFeatures,
    );
    if (complete) {
      break;
    }
    pickedResults = pickCallback(limit - results.length);
  }

  for (let i = 0; i < pickedPrimitives.length; ++i) {
    pickedPrimitives[i].show = true;
  }
  for (let i = 0; i < pickedAttributes.length; ++i) {
    pickedAttributes[i].show = ShowGeometryInstanceAttribute.toValue(
      true,
      pickedAttributes[i].show,
    );
  }
  for (let i = 0; i < pickedFeatures.length; ++i) {
    pickedFeatures[i].show = true;
  }
  return results;
}

export default Picking;
