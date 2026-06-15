import ApproximateTerrainHeights from "../Core/ApproximateTerrainHeights.js";
import BoundingRectangle from "../Core/BoundingRectangle.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import oneTimeWarning from "../Core/oneTimeWarning.js";
import Ray from "../Core/Ray.js";
import Cesium3DTilePass from "./Cesium3DTilePass.js";
import Cesium3DTilePassState from "./Cesium3DTilePassState.js";
import PrimitiveCollection from "./PrimitiveCollection.js";

const offscreenDefaultWidth = 0.1;

const mostDetailedPreloadTilesetPassState = new Cesium3DTilePassState({
  pass: Cesium3DTilePass.MOST_DETAILED_PRELOAD,
});

const mostDetailedPickTilesetPassState = new Cesium3DTilePassState({
  pass: Cesium3DTilePass.MOST_DETAILED_PICK,
});

const pickTilesetPassState = new Cesium3DTilePassState({
  pass: Cesium3DTilePass.PICK,
});

// ---- Scratch variables ----

const scratchRight = new Cartesian3();
const scratchUp = new Cartesian3();
const scratchRectangle = new BoundingRectangle(0.0, 0.0, 3.0, 3.0);

import Color from "../Core/Color.js";
const scratchColorZero = new Color(0.0, 0.0, 0.0, 0.0);

const scratchSurfacePosition = new Cartesian3();
const scratchSurfaceNormal = new Cartesian3();
const scratchSurfaceRay = new Ray();
const scratchCartographic = new Cartographic();

// ---- MostDetailedRayPick ----

function MostDetailedRayPick(ray, width, tilesets) {
  this.ray = ray;
  this.width = width;
  this.tilesets = tilesets;
  this.ready = false;
  const pick = this;
  this.promise = new Promise((resolve) => {
    pick._completePick = () => {
      resolve();
    };
  });
}

// ---- Camera setup ----

function updateOffscreenCameraFromRay(picking, ray, width, camera) {
  const direction = ray.direction;
  const orthogonalAxis = Cartesian3.mostOrthogonalAxis(direction, scratchRight);
  const right = Cartesian3.cross(direction, orthogonalAxis, scratchRight);
  const up = Cartesian3.cross(direction, right, scratchUp);

  camera.position = ray.origin;
  camera.direction = direction;
  camera.up = up;
  camera.right = right;

  camera.frustum.width = width ?? offscreenDefaultWidth;
  return camera.frustum.computeCullingVolume(
    camera.positionWC,
    camera.directionWC,
    camera.upWC,
  );
}

// ---- Most detailed ray pick update ----

function updateMostDetailedRayPick(picking, scene, rayPick) {
  const frameState = scene.frameState;

  const { ray, width, tilesets } = rayPick;

  const camera = picking._pickOffscreenView.camera;
  const cullingVolume = updateOffscreenCameraFromRay(
    picking,
    ray,
    width,
    camera,
  );

  const tilesetPassState = mostDetailedPreloadTilesetPassState;
  tilesetPassState.camera = camera;
  tilesetPassState.cullingVolume = cullingVolume;

  let ready = true;
  const tilesetsLength = tilesets.length;
  for (let i = 0; i < tilesetsLength; ++i) {
    const tileset = tilesets[i];
    if (tileset.show && scene.primitives.contains(tileset)) {
      tileset.updateForPass(frameState, tilesetPassState);
      ready = ready && tilesetPassState.ready;
    }
  }

  if (ready) {
    rayPick._completePick();
  }

  return ready;
}

// ---- Tileset collection ----

function getTilesets(primitives, objectsToExclude, tilesets) {
  for (let i = 0; i < primitives.length; ++i) {
    const primitive = primitives.get(i);
    if (primitive.show) {
      if (defined(primitive.isCesium3DTileset)) {
        if (
          !defined(objectsToExclude) ||
          !objectsToExclude.includes(primitive)
        ) {
          tilesets.push(primitive);
        }
      } else if (primitive instanceof PrimitiveCollection) {
        getTilesets(primitive, objectsToExclude, tilesets);
      }
    }
  }
}

// ---- Launch most detailed ----

function launchMostDetailedRayPick(
  picking,
  scene,
  ray,
  objectsToExclude,
  width,
  callback,
) {
  const tilesets = [];
  getTilesets(scene.primitives, objectsToExclude, tilesets);
  if (tilesets.length === 0) {
    return Promise.resolve(callback());
  }

  const rayPick = new MostDetailedRayPick(ray, width, tilesets);
  picking._mostDetailedRayPicks.push(rayPick);
  return rayPick.promise.then(function () {
    return callback();
  });
}

// ---- Exclusion check ----

function isExcluded(object, objectsToExclude) {
  if (
    !defined(object) ||
    !defined(objectsToExclude) ||
    objectsToExclude.length === 0
  ) {
    return false;
  }
  return (
    objectsToExclude.includes(object) ||
    objectsToExclude.includes(object.primitive) ||
    objectsToExclude.includes(object.id)
  );
}

// ---- Ray intersection ----

function getRayIntersection(
  picking,
  scene,
  ray,
  objectsToExclude,
  width,
  requirePosition,
  mostDetailed,
) {
  const { context, frameState } = scene;
  const uniformState = context.uniformState;

  // NEW-PICK-RAY-ASYNC (Phase 6) — the synchronous depth-readback block below
  // (per-frustum LINEAR reconstruction off the offscreen pickFramebuffer's
  // PickDepth) cannot recover a position on contexts without synchronous
  // readback (WebGPU): the offscreen ray-pick PickDepth instances never
  // receive update() and the shared globe-depth texture is LOG-encoded against
  // the MAIN camera frustum, so getDepth returns a cold/stale value and
  // `position` stays undefined.
  //
  // sampleHeight / clampToHeight no longer reach this code on WebGPU — Picking
  // routes them through _reconstructHeightSurfaceWebGPU (main-scene-depth
  // reuse, Batch 252 reconstruction) instead. pickFromRay over an ARBITRARY
  // ray still needs an offscreen ray-render + per-view async depth packing,
  // which is not yet built; it returns the object hit (the offscreen
  // pickFramebuffer object readback works, one frame stale) but a `position`
  // of undefined. Surface that scope limit once rather than failing silently.
  if (!context.supportsSynchronousReadback) {
    oneTimeWarning(
      "WebGPU.pickFromRay.noPosition",
      "Scene.pickFromRay returns a hit object but no `position` on WebGPU: " +
        "the offscreen arbitrary-ray depth path is not implemented for " +
        "asynchronous-readback backends (tracked as NEW-PICK-RAY-ASYNC). " +
        "Scene.sampleHeight / Scene.clampToHeight DO work on WebGPU (they " +
        "reuse the main scene depth); use the *MostDetailed async variants, " +
        "or sampleTerrainMostDetailed, for arbitrary-ray height queries.",
    );
  }

  const view = picking._pickOffscreenView;
  scene.view = view;

  updateOffscreenCameraFromRay(picking, ray, width, view.camera);

  const drawingBufferRectangle = BoundingRectangle.clone(
    view.viewport,
    scratchRectangle,
  );

  const passState = view.pickFramebuffer.begin(
    drawingBufferRectangle,
    view.viewport,
  );

  scene.jobScheduler.disableThisFrame();

  scene.updateFrameState();
  frameState.invertClassification = false;
  frameState.passes.pick = true;
  frameState.passes.offscreen = true;

  if (mostDetailed) {
    frameState.tilesetPassState = mostDetailedPickTilesetPassState;
  } else {
    frameState.tilesetPassState = pickTilesetPassState;
  }

  uniformState.update(frameState);

  scene.updateEnvironment();
  scene.updateAndExecuteCommands(passState, scratchColorZero);
  scene.resolveFramebuffers(passState);

  let position;
  const object = view.pickFramebuffer.end(drawingBufferRectangle, 1)[0];

  if (scene.context.depthTexture) {
    const { frustumCommandsList } = view;
    const numFrustums = frustumCommandsList.length;
    for (let i = 0; i < numFrustums; ++i) {
      const pickDepth = picking.getPickDepth(scene, i);
      const depth = pickDepth.getDepth(context, 0, 0);
      if (!defined(depth)) {
        continue;
      }
      if (depth > 0.0 && depth < 1.0) {
        const renderedFrustum = frustumCommandsList[i];
        const near =
          renderedFrustum.near *
          (i !== 0 ? scene.opaqueFrustumNearOffset : 1.0);
        const far = renderedFrustum.far;
        const distance = near + depth * (far - near);
        position = Ray.getPoint(ray, distance);
        break;
      }
    }
  }

  scene.view = scene.defaultView;
  context.endFrame();

  if (defined(object) || defined(position)) {
    return {
      object: object,
      position: position,
      exclude:
        (!defined(position) && requirePosition) ||
        isExcluded(object, objectsToExclude),
    };
  }
}

// ---- Drill pick from ray ----

import ShowGeometryInstanceAttribute from "../Core/ShowGeometryInstanceAttribute.js";
import Cesium3DTileFeature from "./Cesium3DTileFeature.js";

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

function drillPickLoop(pickCallback, limit) {
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
    const attributes = pickedAttributes[i];
    attributes.show = ShowGeometryInstanceAttribute.toValue(
      true,
      attributes.show,
    );
  }

  for (let i = 0; i < pickedFeatures.length; ++i) {
    pickedFeatures[i].show = true;
  }

  return results;
}

function drillPickFromRayHelper(
  picking,
  scene,
  ray,
  limit,
  objectsToExclude,
  width,
  requirePosition,
  mostDetailed,
) {
  const pickCallback = function () {
    const pickResult = getRayIntersection(
      picking,
      scene,
      ray,
      objectsToExclude,
      width,
      requirePosition,
      mostDetailed,
    );
    return pickResult ? [pickResult] : undefined;
  };
  return drillPickLoop(pickCallback, limit);
}

function pickFromRay(
  picking,
  scene,
  ray,
  objectsToExclude,
  width,
  requirePosition,
  mostDetailed,
) {
  const results = drillPickFromRayHelper(
    picking,
    scene,
    ray,
    1,
    objectsToExclude,
    width,
    requirePosition,
    mostDetailed,
  );
  if (results.length > 0) {
    return results[0];
  }
}

// ---- Promise deferral ----

function deferPromiseUntilPostRender(scene, promise) {
  return new Promise((resolve, reject) => {
    promise
      .then(function (result) {
        const removeCallback = scene.postRender.addEventListener(function () {
          removeCallback();
          resolve(result);
        });
        scene.requestRender();
      })
      .catch(function (error) {
        reject(error);
      });
  });
}

// ---- Height sampling ----

function getRayForSampleHeight(scene, cartographic) {
  const ellipsoid = scene.ellipsoid;
  const height = ApproximateTerrainHeights._defaultMaxTerrainHeight;
  const surfaceNormal = ellipsoid.geodeticSurfaceNormalCartographic(
    cartographic,
    scratchSurfaceNormal,
  );
  const surfacePosition = Cartographic.toCartesian(
    cartographic,
    ellipsoid,
    scratchSurfacePosition,
  );
  const surfaceRay = scratchSurfaceRay;
  surfaceRay.origin = surfacePosition;
  surfaceRay.direction = surfaceNormal;
  const ray = new Ray();
  Ray.getPoint(surfaceRay, height, ray.origin);
  Cartesian3.negate(surfaceNormal, ray.direction);
  return ray;
}

function getRayForClampToHeight(scene, cartesian) {
  const ellipsoid = scene.ellipsoid;
  const cartographic = Cartographic.fromCartesian(
    cartesian,
    ellipsoid,
    scratchCartographic,
  );
  return getRayForSampleHeight(scene, cartographic);
}

function getHeightFromCartesian(scene, cartesian) {
  const ellipsoid = scene.ellipsoid;
  const cartographic = Cartographic.fromCartesian(
    cartesian,
    ellipsoid,
    scratchCartographic,
  );
  return cartographic.height;
}

function sampleHeightMostDetailed(
  picking,
  scene,
  cartographic,
  objectsToExclude,
  width,
) {
  const ray = getRayForSampleHeight(scene, cartographic);
  return launchMostDetailedRayPick(
    picking,
    scene,
    ray,
    objectsToExclude,
    width,
    function () {
      const pickResult = pickFromRay(
        picking,
        scene,
        ray,
        objectsToExclude,
        width,
        true,
        true,
      );
      if (defined(pickResult)) {
        return getHeightFromCartesian(scene, pickResult.position);
      }
    },
  );
}

function clampToHeightMostDetailed(
  picking,
  scene,
  cartesian,
  objectsToExclude,
  width,
  result,
) {
  const ray = getRayForClampToHeight(scene, cartesian);
  return launchMostDetailedRayPick(
    picking,
    scene,
    ray,
    objectsToExclude,
    width,
    function () {
      const pickResult = pickFromRay(
        picking,
        scene,
        ray,
        objectsToExclude,
        width,
        true,
        true,
      );
      if (defined(pickResult)) {
        return Cartesian3.clone(pickResult.position, result);
      }
    },
  );
}

export {
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
};

// Namespace default export for build system barrel compatibility
const PickingRayHelpers = {
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
};
export default PickingRayHelpers;
