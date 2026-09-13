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

/**
 * Recover the hit distance from the offscreen render's depth, synchronously.
 *
 * Runs INSIDE the offscreen render's try block, while `scene.view` is still the
 * offscreen view, because `picking.getPickDepth` resolves against the current
 * view and `readPixels` reads the framebuffer this pass just wrote.
 *
 * @private
 */
function recoverRayPositionSync(picking, scene, ray, view) {
  const { context } = scene;
  if (!context.depthTexture) {
    return undefined;
  }
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
        renderedFrustum.near * (i !== 0 ? scene.opaqueFrustumNearOffset : 1.0);
      const far = renderedFrustum.far;
      const distance = near + depth * (far - near);
      return Ray.getPoint(ray, distance);
    }
  }
  return undefined;
}

/**
 * The same recovery for a backend whose readback cannot complete inside the
 * call: await one readback per frustum slice and take the nearest hit.
 *
 * Runs AFTER the offscreen render's `context.endFrame()`, so the copy the pick
 * pass encoded has been submitted. Reads the offscreen view's `PickDepth`
 * instances directly rather than through `picking.getPickDepth`, because
 * `scene.view` is the default view again by now — and reads only instances the
 * producer actually populated, so a slice that published nothing answers
 * "no hit" instead of a stale one.
 *
 * ## Which frustum the depth is encoded against
 *
 * The synchronous path above inverts each slice's own near/far, because that
 * is what WebGL rasterised with: `czm_projection` resolves per draw, so the
 * per-slice projection `Scene.executeCommands` installs reaches the shader.
 *
 * This path inverts the CAMERA's frustum instead. On an asynchronous-readback
 * backend the projection is baked into each command's `mvpRelativeToEye` while
 * primitives are updated — before the potentially-visible set exists, so before
 * any slice does — and the per-slice update that follows changes `UniformState`
 * without changing the bytes the draw already owns. Every slice therefore
 * rasterises in the camera's frustum. `Picking.pickPositionWorldCoordinates`
 * states the same rule for the main view and reconstructs the same way.
 *
 * The offscreen camera is orthographic, so `frameState.useLogDepth` is false
 * and that encoding is linear across the camera's whole range: with `Picking`'s
 * 0.1-to-5e8 offscreen frustum, one part in 2^24 is 30 m, which is why the
 * producer publishes the depth verbatim in `r32float` rather than through the
 * 24-bit RGBA8 pack the slice-reconstructed consumers share.
 *
 * @private
 */
async function recoverRayPositionAsync(picking, scene, ray) {
  const { context } = scene;
  if (!context.depthTexture) {
    return undefined;
  }
  const view = picking._pickOffscreenView;
  const frustum = view.camera.frustum;
  const near = frustum.near;
  const far = frustum.far;
  if (!defined(near) || !defined(far) || !(far > near)) {
    return undefined;
  }
  const numFrustums = view.frustumCommandsList.length;
  let nearestDistance;
  for (let i = 0; i < numFrustums; ++i) {
    const pickDepth = view.pickDepths[i];
    if (!defined(pickDepth) || typeof pickDepth.readDepthAsync !== "function") {
      continue;
    }
    const depth = await pickDepth.readDepthAsync(context, 0, 0);
    if (!defined(depth)) {
      continue;
    }
    if (depth > 0.0 && depth < 1.0) {
      const distance = near + depth * (far - near);
      //>>includeStart('debug', pragmas.debug);
      // The numbers that decide the answer, including the slice bounds this
      // depth is NOT encoded against: a distance that lands outside them is
      // the signature of the two frames having diverged again.
      const slice = view.frustumCommandsList[i];
      console.log(
        `[WebGPU:RayPick] slice ${i} depth ${depth.toExponential(6)} encode ` +
          `${near.toFixed(2)}..${far.toFixed(2)} distance ${distance.toFixed(3)} ` +
          `sliceBand ${slice?.near?.toFixed(2)}..${slice?.far?.toFixed(2)}`,
      );
      //>>includeEnd('debug');
      // Slices are ordered near to far, so the first hit is normally the
      // nearest; keep the minimum anyway, so a slice that publishes an
      // out-of-order depth cannot make the answer farther than a hit already
      // found rather than merely wrong.
      if (!defined(nearestDistance) || distance < nearestDistance) {
        nearestDistance = distance;
      }
    }
  }
  if (!defined(nearestDistance)) {
    return undefined;
  }
  return Ray.getPoint(ray, nearestDistance);
}

/**
 * Assemble the pick record from what the render and the depth recovery found.
 * @private
 */
function assembleRayIntersection(
  object,
  position,
  objectsToExclude,
  requirePosition,
) {
  if (!defined(object) && !defined(position)) {
    return undefined;
  }
  return {
    object: object,
    position: position,
    exclude:
      (!defined(position) && requirePosition) ||
      isExcluded(object, objectsToExclude),
  };
}

function getRayIntersection(
  picking,
  scene,
  ray,
  objectsToExclude,
  width,
  requirePosition,
  mostDetailed,
) {
  const { context } = scene;

  // The synchronous depth-readback below cannot recover a position on a
  // context without synchronous readback: the packed depth the offscreen
  // render publishes is read back through `mapAsync`, which cannot complete
  // inside this call. `sampleHeight` / `clampToHeight` avoid this code there by
  // reusing the main scene depth, and their *MostDetailed variants take the
  // asynchronous form of this function (they return promises and can wait).
  // `pickFromRay` over an arbitrary ray is synchronous and has neither escape:
  // it returns the object hit but a `position` of undefined. Surface that scope
  // limit once rather than failing silently.
  if (!context.supportsSynchronousReadback) {
    oneTimeWarning(
      "WebGPU.pickFromRay.noPosition",
      "Scene.pickFromRay returns a hit object but no `position` on WebGPU: " +
        "recovering it needs the offscreen ray depth, whose readback is " +
        "asynchronous, and this call cannot wait. Scene.sampleHeight, " +
        "Scene.clampToHeight and the *MostDetailed height queries are " +
        "unaffected. For CPU terrain-only height queries, use " +
        "sampleTerrainMostDetailed.",
    );
  }

  const rendered = renderOffscreenRayPick(
    picking,
    scene,
    ray,
    width,
    mostDetailed,
    recoverRayPositionSync,
  );
  return assembleRayIntersection(
    rendered.object,
    rendered.position,
    objectsToExclude,
    requirePosition,
  );
}

/**
 * Render the scene into the offscreen ray view and report what it hit.
 *
 * `recoverPosition` is invoked inside the render's try block, before the view
 * and frame state are restored, so a synchronous depth recovery observes the
 * same state it always did. A caller that recovers depth asynchronously omits
 * it and reads the published depth after this returns.
 *
 * @private
 */
function renderOffscreenRayPick(
  picking,
  scene,
  ray,
  width,
  mostDetailed,
  recoverPosition,
) {
  const { context, frameState } = scene;
  const uniformState = context.uniformState;

  const view = picking._pickOffscreenView;
  scene.view = view;
  let hadPrimaryError = false;
  let primaryError;
  let hadCleanupError = false;
  let cleanupError;
  let result;
  try {
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

    const object = view.pickFramebuffer.end(drawingBufferRectangle, 1)[0];
    const position = defined(recoverPosition)
      ? recoverPosition(picking, scene, ray, view)
      : undefined;

    result = { object: object, position: position };
  } catch (error) {
    hadPrimaryError = true;
    primaryError = error;
  } finally {
    // The offscreen View borrows Scene's one mutable FrameState/UniformState.
    // Restore all three owners even when command generation, readback, or
    // submission throws; otherwise the next default-view translucent-depth
    // pick can render with the offscreen camera and eclipse block.
    scene.view = scene.defaultView;
    try {
      context.endFrame();
    } catch (error) {
      hadCleanupError = true;
      cleanupError = error;
    }
    try {
      scene.updateFrameState();
      uniformState.update(frameState);
    } catch (error) {
      if (!hadCleanupError) {
        hadCleanupError = true;
        cleanupError = error;
      }
    }
  }

  // Preserve the original render/readback exception. A cleanup failure is
  // surfaced only when it is the first failure.
  if (hadPrimaryError) {
    throw primaryError;
  }
  if (hadCleanupError) {
    throw cleanupError;
  }
  return result;
}

/**
 * The asynchronous form of {@link getRayIntersection}, for a backend whose
 * offscreen ray depth can only be read back after the frame is submitted.
 *
 * `context.offscreenRayDepthRequested` is raised only around this render, so
 * the pick pass publishes a readable depth for THIS query and an ordinary
 * `scene.pick` still encodes nothing extra. It is lowered in a `finally`: a
 * render that throws must not leave every later pick paying for a publication
 * nobody reads.
 *
 * SERIALIZED against every other offscreen ray pick on this `Picking`. The one
 * offscreen view, its frustum slices and its published depth targets are shared
 * state: a batch of thirty height queries resolves its callbacks in a single
 * microtask drain, so without this every render would run before the first
 * readback landed and all thirty points would read the LAST render's depth
 * against the LAST render's slice bounds. That measured as thirty nearly
 * identical heights, 24 m from WebGL's, on a surface whose real relief is 20 m.
 *
 * @private
 */
function getRayIntersectionAsync(
  picking,
  scene,
  ray,
  objectsToExclude,
  width,
  requirePosition,
  mostDetailed,
) {
  const run = () =>
    executeRayIntersectionAsync(
      picking,
      scene,
      ray,
      objectsToExclude,
      width,
      requirePosition,
      mostDetailed,
    );
  const previous = picking._offscreenRayPickChain ?? Promise.resolve();
  const queued = previous.then(run, run);
  // The chain tail must never carry a rejection, or one failed pick would
  // reject every later one.
  picking._offscreenRayPickChain = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

/**
 * One offscreen ray pick: render, then await this render's own depth.
 * @private
 */
async function executeRayIntersectionAsync(
  picking,
  scene,
  ray,
  objectsToExclude,
  width,
  requirePosition,
  mostDetailed,
) {
  const { context } = scene;
  let rendered;
  context.offscreenRayDepthRequested = true;
  try {
    rendered = renderOffscreenRayPick(
      picking,
      scene,
      ray,
      width,
      mostDetailed,
      undefined,
    );
  } finally {
    context.offscreenRayDepthRequested = false;
  }

  const position = await recoverRayPositionAsync(picking, scene, ray);
  return assembleRayIntersection(
    rendered.object,
    position,
    objectsToExclude,
    requirePosition,
  );
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

/**
 * {@link drillPickLoop} for a pick callback that returns a promise.
 *
 * Identical rules — the same `addDrillPickedResults`, the same hide-and-repick
 * iteration, the same restoration of every `show` it touched — awaiting each
 * iteration instead of calling it synchronously. Kept as a sibling rather than
 * folded into `drillPickLoop` so the synchronous loop every existing caller
 * uses keeps its exact shape.
 *
 * @private
 */
async function drillPickLoopAsync(pickCallback, limit) {
  const results = [];
  const pickedPrimitives = [];
  const pickedAttributes = [];
  const pickedFeatures = [];
  if (!defined(limit)) {
    limit = Number.MAX_VALUE;
  }

  try {
    let pickedResults = await pickCallback(limit);
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
      pickedResults = await pickCallback(limit - results.length);
    }
  } finally {
    // A rejected pick must not leave primitives hidden for the rest of the
    // session; the synchronous loop cannot throw between its hide and its
    // restore, but an awaited one can be rejected at any iteration.
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

/**
 * {@link drillPickFromRayHelper} over the asynchronous ray intersection.
 * @private
 */
function drillPickFromRayAsyncHelper(
  picking,
  scene,
  ray,
  limit,
  objectsToExclude,
  width,
  requirePosition,
  mostDetailed,
) {
  const pickCallback = async function () {
    const pickResult = await getRayIntersectionAsync(
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
  return drillPickLoopAsync(pickCallback, limit);
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

/**
 * {@link pickFromRay} for a backend whose offscreen ray depth is read back
 * asynchronously. Only the promise-returning `*MostDetailed` height queries
 * reach this — the synchronous `Scene.pickFromRay` cannot wait.
 * @private
 */
async function pickFromRayAsync(
  picking,
  scene,
  ray,
  objectsToExclude,
  width,
  requirePosition,
  mostDetailed,
) {
  const results = await drillPickFromRayAsyncHelper(
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
  return undefined;
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
      // Where the offscreen ray depth can only be read back after the frame is
      // submitted, take the asynchronous chain: this query returns a promise,
      // so unlike the synchronous `Scene.sampleHeight` it can wait. A
      // synchronous pick here returns `undefined` for every point in the batch,
      // which the caller then writes into its own array as a hole.
      if (!scene.context.supportsSynchronousReadback) {
        return pickFromRayAsync(
          picking,
          scene,
          ray,
          objectsToExclude,
          width,
          true,
          true,
        ).then(function (pickResult) {
          return defined(pickResult)
            ? getHeightFromCartesian(scene, pickResult.position)
            : undefined;
        });
      }
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
) {
  const ray = getRayForClampToHeight(scene, cartesian);
  return launchMostDetailedRayPick(
    picking,
    scene,
    ray,
    objectsToExclude,
    width,
    function () {
      // See the note in sampleHeightMostDetailed: a synchronous pick recovers
      // no depth where the readback is asynchronous, and the caller's
      // documented contract then replaces each of its own Cartesians with a
      // hole.
      if (!scene.context.supportsSynchronousReadback) {
        return pickFromRayAsync(
          picking,
          scene,
          ray,
          objectsToExclude,
          width,
          true,
          true,
        ).then(function (pickResult) {
          // A fresh instance, never a caller-owned object — the batch around
          // this one is still in flight.
          return defined(pickResult)
            ? Cartesian3.clone(pickResult.position)
            : undefined;
        });
      }
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
        // A fresh instance, never a caller-owned object: the batch that drives
        // this is still running its other picks, and `pickResult.position` is
        // owned by the pick machinery.
        return Cartesian3.clone(pickResult.position);
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
