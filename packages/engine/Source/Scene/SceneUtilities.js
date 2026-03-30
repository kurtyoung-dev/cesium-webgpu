/**
 * Pure utility functions extracted from Scene.js. These compute values from
 * scene state without side effects (except scratch variable reuse).
 *
 * @private
 */
import BoundingSphere from "../Core/BoundingSphere.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import JulianDate from "../Core/JulianDate.js";
import Occluder from "../Core/Occluder.js";
import SceneMode from "./SceneMode.js";
import PrimitiveCollection from "./PrimitiveCollection.js";

const scratchOccluderBoundingSphere = new BoundingSphere();
let scratchOccluder;

function getOccluder(scene) {
  if (
    scene._mode !== SceneMode.SCENE3D ||
    !scene.globe?.show ||
    scene._cameraUnderground ||
    scene._globeTranslucencyState.translucent
  ) {
    return undefined;
  }

  scratchOccluderBoundingSphere.radius =
    scene.ellipsoid.minimumRadius + scene.frameState.minimumTerrainHeight;
  scratchOccluder = Occluder.fromBoundingSphere(
    scratchOccluderBoundingSphere,
    scene.camera.positionWC,
    scratchOccluder,
  );

  return scratchOccluder;
}

function updateFrameNumber(scene, frameNumber, time) {
  const frameState = scene._frameState;
  frameState.frameNumber = frameNumber;
  frameState.time = JulianDate.clone(time, frameState.time);
}

function getGlobeHeight(scene) {
  if (scene.mode === SceneMode.MORPHING) {
    return;
  }
  const cartographic = scene.camera.positionCartographic;
  return scene.getHeight(cartographic);
}

function getMaxPrimitiveHeight(primitive, cartographic, scene) {
  let maxHeight = Number.NEGATIVE_INFINITY;

  if (primitive instanceof PrimitiveCollection) {
    const length = primitive.length;
    for (let i = 0; i < length; ++i) {
      const subPrimitive = primitive.get(i);
      const subHeight = getMaxPrimitiveHeight(
        subPrimitive,
        cartographic,
        scene,
      );
      if (defined(subHeight) && subHeight > maxHeight) {
        maxHeight = subHeight;
      }
    }
  } else if (
    primitive.isCesium3DTileset &&
    primitive.show &&
    primitive.enableCollision
  ) {
    const result = primitive.getHeight(cartographic, scene);
    if (defined(result) && result > maxHeight) {
      return result;
    }
  }

  return maxHeight;
}

const updateHeightScratchCartographic = new Cartographic();

function isCameraUnderground(scene) {
  const camera = scene.camera;
  const mode = scene._mode;
  const cameraController = scene._screenSpaceCameraController;
  const cartographic = camera.positionCartographic;

  if (!defined(cartographic)) {
    return false;
  }

  if (!cameraController.onMap() && cartographic.height < 0.0) {
    return true;
  }

  if (mode === SceneMode.SCENE2D || mode === SceneMode.MORPHING) {
    return false;
  }

  const globeHeight = scene._globeHeight;
  return defined(globeHeight) && cartographic.height < globeHeight;
}

function callAfterRenderFunctions(scene) {
  const functions = scene._frameState.afterRender;
  const functionsCpy = functions.slice();
  functions.length = 0;

  for (let i = 0; i < functionsCpy.length; ++i) {
    const shouldRequestRender = functionsCpy[i]();
    if (shouldRequestRender) {
      scene.requestRender();
    }
  }
}

export {
  callAfterRenderFunctions,
  getGlobeHeight,
  getMaxPrimitiveHeight,
  getOccluder,
  isCameraUnderground,
  updateFrameNumber,
  updateHeightScratchCartographic,
};

// Namespace default export for build system barrel compatibility
const SceneUtilities = {
  callAfterRenderFunctions,
  getGlobeHeight,
  getMaxPrimitiveHeight,
  getOccluder,
  isCameraUnderground,
  updateFrameNumber,
  updateHeightScratchCartographic,
};
export default SceneUtilities;
