/**
 * Shared input helper functions for ScreenSpaceCameraController.
 * Used across 2D, Columbus View, and 3D input modes.
 *
 * @private
 */
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import HeadingPitchRoll from "../Core/HeadingPitchRoll.js";
import IntersectionTests from "../Core/IntersectionTests.js";
import CesiumMath from "../Core/Math.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import Plane from "../Core/Plane.js";
import Ray from "../Core/Ray.js";
import SceneMode from "./SceneMode.js";
import SceneTransforms from "./SceneTransforms.js";

// ---- pickPosition ----

const pickGlobeScratchRay = new Ray();
const scratchDepthIntersection = new Cartesian3();
const scratchRayIntersection = new Cartesian3();

// Resolve the best pick position from depth and ray results.
// Rejects undefined, NaN, or zero-distance results.
function _resolvePickResult(
  depthIntersection,
  rayIntersection,
  cameraPosition,
  result,
) {
  // Validate depth intersection
  if (
    defined(depthIntersection) &&
    (isNaN(depthIntersection.x) ||
      isNaN(depthIntersection.y) ||
      isNaN(depthIntersection.z))
  ) {
    depthIntersection = undefined;
  }

  // Validate ray intersection
  if (
    defined(rayIntersection) &&
    (isNaN(rayIntersection.x) ||
      isNaN(rayIntersection.y) ||
      isNaN(rayIntersection.z))
  ) {
    rayIntersection = undefined;
  }

  const pickDistance = defined(depthIntersection)
    ? Cartesian3.distance(depthIntersection, cameraPosition)
    : Number.POSITIVE_INFINITY;
  const rayDistance = defined(rayIntersection)
    ? Cartesian3.distance(rayIntersection, cameraPosition)
    : Number.POSITIVE_INFINITY;

  // Reject zero or near-zero distances (camera inside terrain)
  if (pickDistance < 1.0 && rayDistance < 1.0) {
    return undefined;
  }

  if (pickDistance < rayDistance) {
    return Cartesian3.clone(depthIntersection, result);
  }

  return defined(rayIntersection)
    ? Cartesian3.clone(rayIntersection, result)
    : undefined;
}

// Pending async pick result — used when depth readback is async.
// The camera controller checks this via _pendingPickPosition.
let _pendingPickResult;
let _pendingPickReady = false;

export function pickPosition(controller, mousePosition, result) {
  const scene = controller._scene;
  const globe = controller._globe;
  const camera = scene.camera;

  let depthIntersection;
  let depthResultOrPromise;
  if (scene.pickPositionSupported) {
    depthResultOrPromise = scene.pickPositionWorldCoordinates(
      mousePosition,
      scratchDepthIntersection,
    );
  }

  // If the depth result is a Promise (async readback), chain the ray pick
  // onto the .then() so both operate at the same temporal point.
  if (
    defined(depthResultOrPromise) &&
    typeof depthResultOrPromise.then === "function"
  ) {
    // Fire-and-forget: when depth resolves, compute final pick position
    depthResultOrPromise.then((depthResult) => {
      if (!defined(globe)) {
        _pendingPickResult = depthResult;
        _pendingPickReady = true;
        return;
      }
      const cullBackFaces = !controller._cameraUnderground;
      const ray = camera.getPickRay(mousePosition, pickGlobeScratchRay);
      const rayIntersection = globe.pickWorldCoordinates(
        ray,
        scene,
        cullBackFaces,
        scratchRayIntersection,
      );
      _pendingPickResult = _resolvePickResult(
        depthResult,
        rayIntersection,
        camera.positionWC,
        result,
      );
      _pendingPickReady = true;
    });

    // Return the last resolved async result if available, otherwise
    // fall through to synchronous ray-only pick as immediate fallback.
    if (_pendingPickReady) {
      _pendingPickReady = false;
      const pending = _pendingPickResult;
      _pendingPickResult = undefined;
      if (defined(pending)) {
        return Cartesian3.clone(pending, result);
      }
    }
    // Fall through to ray-only pick below
    depthIntersection = undefined;
  } else {
    depthIntersection = depthResultOrPromise;
  }

  if (!defined(globe)) {
    return defined(depthIntersection)
      ? Cartesian3.clone(depthIntersection, result)
      : undefined;
  }

  const cullBackFaces = !controller._cameraUnderground;
  const ray = camera.getPickRay(mousePosition, pickGlobeScratchRay);
  const rayIntersection = globe.pickWorldCoordinates(
    ray,
    scene,
    cullBackFaces,
    scratchRayIntersection,
  );

  return _resolvePickResult(
    depthIntersection,
    rayIntersection,
    camera.positionWC,
    result,
  );
}

// ---- Distance helpers ----

const scratchDistanceCartographic = new Cartographic();

export function getDistanceFromSurface(controller) {
  const ellipsoid = controller._ellipsoid;
  const scene = controller._scene;
  const camera = scene.camera;
  const mode = scene.mode;

  let height = 0.0;
  if (mode === SceneMode.SCENE3D) {
    const cartographic = ellipsoid.cartesianToCartographic(
      camera.position,
      scratchDistanceCartographic,
    );
    if (defined(cartographic)) {
      height = cartographic.height;
    }
  } else {
    height = camera.position.z;
  }
  const globeHeight = controller._scene.globeHeight ?? 0.0;
  return Math.abs(globeHeight - height);
}

const scratchSurfaceNormal = new Cartesian3();

export function getZoomDistanceUnderground(controller, ray) {
  const origin = ray.origin;
  const direction = ray.direction;
  const distanceFromSurface = getDistanceFromSurface(controller);

  const surfaceNormal = Cartesian3.normalize(origin, scratchSurfaceNormal);
  let strength = Math.abs(Cartesian3.dot(surfaceNormal, direction));
  strength = Math.max(strength, 0.5) * 2.0;
  return distanceFromSurface * strength;
}

export function getTiltCenterUnderground(
  controller,
  ray,
  pickedPosition,
  result,
) {
  let distance = Cartesian3.distance(ray.origin, pickedPosition);
  const distanceFromSurface = getDistanceFromSurface(controller);

  const maximumDistance = CesiumMath.clamp(
    distanceFromSurface * 5.0,
    controller._minimumUndergroundPickDistance,
    controller._maximumUndergroundPickDistance,
  );

  if (distance > maximumDistance) {
    distance = Math.min(distance, distanceFromSurface / 5.0);
    distance = Math.max(distance, 100.0);
  }

  return Ray.getPoint(ray, distance, result);
}

export function getStrafeStartPositionUnderground(
  controller,
  ray,
  pickedPosition,
  result,
) {
  let distance;
  if (!defined(pickedPosition)) {
    distance = getDistanceFromSurface(controller);
  } else {
    distance = Cartesian3.distance(ray.origin, pickedPosition);
    if (distance > controller._maximumUndergroundPickDistance) {
      distance = getDistanceFromSurface(controller);
    }
  }

  return Ray.getPoint(ray, distance, result);
}

// ---- Strafe ----

const scratchStrafeRay = new Ray();
const scratchStrafePlane = new Plane(Cartesian3.UNIT_X, 0.0);
const scratchStrafeIntersection = new Cartesian3();
const scratchStrafeDirection = new Cartesian3();
const scratchInertialDelta = new Cartesian2();

export function strafe(controller, movement, strafeStartPosition) {
  const scene = controller._scene;
  const camera = scene.camera;

  const ray = camera.getPickRay(movement.endPosition, scratchStrafeRay);

  let direction = Cartesian3.clone(camera.direction, scratchStrafeDirection);
  if (scene.mode === SceneMode.COLUMBUS_VIEW) {
    Cartesian3.fromElements(direction.z, direction.x, direction.y, direction);
  }

  const plane = Plane.fromPointNormal(
    strafeStartPosition,
    direction,
    scratchStrafePlane,
  );
  const intersection = IntersectionTests.rayPlane(
    ray,
    plane,
    scratchStrafeIntersection,
  );
  if (!defined(intersection)) {
    return;
  }

  direction = Cartesian3.subtract(strafeStartPosition, intersection, direction);
  if (scene.mode === SceneMode.COLUMBUS_VIEW) {
    Cartesian3.fromElements(direction.y, direction.z, direction.x, direction);
  }

  Cartesian3.add(camera.position, direction, camera.position);
}

export function continueStrafing(controller, movement) {
  const originalEndPosition = movement.endPosition;
  const inertialDelta = Cartesian2.subtract(
    movement.endPosition,
    movement.startPosition,
    scratchInertialDelta,
  );
  const endPosition = controller._strafeEndMousePosition;
  Cartesian2.add(endPosition, inertialDelta, endPosition);
  movement.endPosition = endPosition;
  strafe(controller, movement, controller._strafeStartPosition);
  movement.endPosition = originalEndPosition;
}

// ---- handleZoom ----

const scratchZoomPickRay = new Ray();
const scratchPickCartesian = new Cartesian3();
const scratchZoomOffset = new Cartesian2();
const scratchZoomDirection = new Cartesian3();
const scratchCenterPixel = new Cartesian2();
const scratchCenterPosition = new Cartesian3();
const scratchPositionNormal = new Cartesian3();
const scratchPickNormal = new Cartesian3();
const scratchZoomAxis = new Cartesian3();
const scratchCameraPositionNormal = new Cartesian3();
const scratchTargetNormal = new Cartesian3();
const scratchCameraPosition = new Cartesian3();
const scratchCameraUpNormal = new Cartesian3();
const scratchCameraRightNormal = new Cartesian3();
const scratchForwardNormal = new Cartesian3();
const scratchPositionToTarget = new Cartesian3();
const scratchPositionToTargetNormal = new Cartesian3();
const scratchPan = new Cartesian3();
const scratchCenterMovement = new Cartesian3();
const scratchCenter = new Cartesian3();
const scratchCartesian = new Cartesian3();
const scratchCartesianTwo = new Cartesian3();
const scratchCartesianThree = new Cartesian3();
const scratchZoomViewOptions = {
  orientation: new HeadingPitchRoll(),
};

export function handleZoom(
  object,
  startPosition,
  movement,
  zoomFactor,
  distanceMeasure,
  unitPositionDotDirection,
) {
  let percentage = 1.0;
  if (defined(unitPositionDotDirection)) {
    percentage = CesiumMath.clamp(
      Math.abs(unitPositionDotDirection),
      0.25,
      1.0,
    );
  }

  const diff = movement.endPosition.y - movement.startPosition.y;

  const approachingSurface = diff > 0;
  const minHeight = approachingSurface
    ? object.minimumZoomDistance * percentage
    : 0;
  const maxHeight = object.maximumZoomDistance;

  const minDistance = distanceMeasure - minHeight;
  let zoomRate = zoomFactor * minDistance;
  zoomRate = CesiumMath.clamp(
    zoomRate,
    object._minimumZoomRate,
    object._maximumZoomRate,
  );

  let rangeWindowRatio = diff / object._scene.canvas.clientHeight;
  rangeWindowRatio = Math.min(rangeWindowRatio, object.maximumMovementRatio);
  let distance = zoomRate * rangeWindowRatio;

  if (
    object.enableCollisionDetection ||
    object.minimumZoomDistance === 0.0 ||
    !defined(object._globe)
  ) {
    if (distance > 0.0 && Math.abs(distanceMeasure - minHeight) < 1.0) {
      return;
    }
    if (distance < 0.0 && Math.abs(distanceMeasure - maxHeight) < 1.0) {
      return;
    }
    if (distanceMeasure - distance < minHeight) {
      distance = distanceMeasure - minHeight - 1.0;
    } else if (distanceMeasure - distance > maxHeight) {
      distance = distanceMeasure - maxHeight;
    }
  }

  const scene = object._scene;
  const camera = scene.camera;
  const mode = scene.mode;

  const orientation = scratchZoomViewOptions.orientation;
  orientation.heading = camera.heading;
  orientation.pitch = camera.pitch;
  orientation.roll = camera.roll;

  const sameStartPosition =
    movement.inertiaEnabled ??
    Cartesian2.equals(startPosition, object._zoomMouseStart);
  let zoomingOnVector = object._zoomingOnVector;
  let rotatingZoom = object._rotatingZoom;
  let pickedPosition;

  if (!sameStartPosition) {
    object._zoomMouseStart = Cartesian2.clone(
      startPosition,
      object._zoomMouseStart,
    );

    if (defined(object._globe) && mode === SceneMode.SCENE2D) {
      pickedPosition = camera.getPickRay(
        startPosition,
        scratchZoomPickRay,
      ).origin;
      pickedPosition = Cartesian3.fromElements(
        pickedPosition.y,
        pickedPosition.z,
        pickedPosition.x,
      );
    } else if (defined(object._globe)) {
      pickedPosition = pickPosition(
        object,
        startPosition,
        scratchPickCartesian,
      );
    }

    if (defined(pickedPosition)) {
      object._useZoomWorldPosition = true;
      object._zoomWorldPosition = Cartesian3.clone(
        pickedPosition,
        object._zoomWorldPosition,
      );
    } else {
      object._useZoomWorldPosition = false;
    }

    zoomingOnVector = object._zoomingOnVector = false;
    rotatingZoom = object._rotatingZoom = false;
    object._zoomingUnderground = object._cameraUnderground;
  }

  if (!object._useZoomWorldPosition) {
    camera.zoomIn(distance);
    return;
  }

  let zoomOnVector = mode === SceneMode.COLUMBUS_VIEW;

  if (camera.positionCartographic.height < 2000000) {
    rotatingZoom = true;
  }

  if (!sameStartPosition || rotatingZoom) {
    if (mode === SceneMode.SCENE2D) {
      const worldPosition = object._zoomWorldPosition;
      const endPosition = camera.position;

      if (
        !Cartesian3.equals(worldPosition, endPosition) &&
        camera.positionCartographic.height < object._maxCoord.x * 2.0
      ) {
        const savedX = camera.position.x;
        const direction = Cartesian3.subtract(
          worldPosition,
          endPosition,
          scratchZoomDirection,
        );
        Cartesian3.normalize(direction, direction);
        const d =
          (Cartesian3.distance(worldPosition, endPosition) * distance) /
          (camera.getMagnitude() * 0.5);
        camera.move(direction, d * 0.5);

        if (
          (camera.position.x < 0.0 && savedX > 0.0) ||
          (camera.position.x > 0.0 && savedX < 0.0)
        ) {
          pickedPosition = camera.getPickRay(
            startPosition,
            scratchZoomPickRay,
          ).origin;
          pickedPosition = Cartesian3.fromElements(
            pickedPosition.y,
            pickedPosition.z,
            pickedPosition.x,
          );
          object._zoomWorldPosition = Cartesian3.clone(
            pickedPosition,
            object._zoomWorldPosition,
          );
        }
      }
    } else if (mode === SceneMode.SCENE3D) {
      const cameraPositionNormal = Cartesian3.normalize(
        camera.position,
        scratchCameraPositionNormal,
      );
      if (
        object._cameraUnderground ||
        object._zoomingUnderground ||
        (camera.positionCartographic.height < 3000.0 &&
          Math.abs(Cartesian3.dot(camera.direction, cameraPositionNormal)) <
            0.6)
      ) {
        zoomOnVector = true;
      } else {
        const canvas = scene.canvas;
        const centerPixel = scratchCenterPixel;
        centerPixel.x = canvas.clientWidth / 2;
        centerPixel.y = canvas.clientHeight / 2;
        const centerPosition = pickPosition(
          object,
          centerPixel,
          scratchCenterPosition,
        );

        if (!defined(centerPosition)) {
          zoomOnVector = true;
        } else if (camera.positionCartographic.height < 1000000) {
          if (Cartesian3.dot(camera.direction, cameraPositionNormal) >= -0.5) {
            zoomOnVector = true;
          } else {
            const cameraPosition = scratchCameraPosition;
            Cartesian3.clone(camera.position, cameraPosition);
            const target = object._zoomWorldPosition;

            let targetNormal = scratchTargetNormal;
            targetNormal = Cartesian3.normalize(target, targetNormal);

            if (Cartesian3.dot(targetNormal, cameraPositionNormal) < 0.0) {
              return;
            }

            const center = scratchCenter;
            const forward = scratchForwardNormal;
            Cartesian3.clone(camera.direction, forward);
            Cartesian3.add(
              cameraPosition,
              Cartesian3.multiplyByScalar(forward, 1000, scratchCartesian),
              center,
            );

            const positionToTarget = scratchPositionToTarget;
            const positionToTargetNormal = scratchPositionToTargetNormal;
            Cartesian3.subtract(target, cameraPosition, positionToTarget);
            Cartesian3.normalize(positionToTarget, positionToTargetNormal);

            const alphaDot = Cartesian3.dot(
              cameraPositionNormal,
              positionToTargetNormal,
            );
            if (alphaDot >= 0.0) {
              object._zoomMouseStart.x = -1;
              return;
            }
            const alpha = Math.acos(-alphaDot);
            const cameraDistance = Cartesian3.magnitude(cameraPosition);
            const targetDistance = Cartesian3.magnitude(target);
            const remainingDistance = cameraDistance - distance;
            const positionToTargetDistance =
              Cartesian3.magnitude(positionToTarget);

            const gamma = Math.asin(
              CesiumMath.clamp(
                (positionToTargetDistance / targetDistance) * Math.sin(alpha),
                -1.0,
                1.0,
              ),
            );
            const delta = Math.asin(
              CesiumMath.clamp(
                (remainingDistance / targetDistance) * Math.sin(alpha),
                -1.0,
                1.0,
              ),
            );
            const beta = gamma - delta + alpha;

            const up = scratchCameraUpNormal;
            Cartesian3.normalize(cameraPosition, up);
            let right = scratchCameraRightNormal;
            right = Cartesian3.cross(positionToTargetNormal, up, right);
            right = Cartesian3.normalize(right, right);

            Cartesian3.normalize(
              Cartesian3.cross(up, right, scratchCartesian),
              forward,
            );

            Cartesian3.multiplyByScalar(
              Cartesian3.normalize(center, scratchCartesian),
              Cartesian3.magnitude(center) - distance,
              center,
            );
            Cartesian3.normalize(cameraPosition, cameraPosition);
            Cartesian3.multiplyByScalar(
              cameraPosition,
              remainingDistance,
              cameraPosition,
            );

            const pMid = scratchPan;
            Cartesian3.multiplyByScalar(
              Cartesian3.add(
                Cartesian3.multiplyByScalar(
                  up,
                  Math.cos(beta) - 1,
                  scratchCartesianTwo,
                ),
                Cartesian3.multiplyByScalar(
                  forward,
                  Math.sin(beta),
                  scratchCartesianThree,
                ),
                scratchCartesian,
              ),
              remainingDistance,
              pMid,
            );
            Cartesian3.add(cameraPosition, pMid, cameraPosition);

            Cartesian3.normalize(center, up);
            Cartesian3.normalize(
              Cartesian3.cross(up, right, scratchCartesian),
              forward,
            );

            const cMid = scratchCenterMovement;
            Cartesian3.multiplyByScalar(
              Cartesian3.add(
                Cartesian3.multiplyByScalar(
                  up,
                  Math.cos(beta) - 1,
                  scratchCartesianTwo,
                ),
                Cartesian3.multiplyByScalar(
                  forward,
                  Math.sin(beta),
                  scratchCartesianThree,
                ),
                scratchCartesian,
              ),
              Cartesian3.magnitude(center),
              cMid,
            );
            Cartesian3.add(center, cMid, center);

            Cartesian3.clone(cameraPosition, camera.position);
            Cartesian3.normalize(
              Cartesian3.subtract(center, cameraPosition, scratchCartesian),
              camera.direction,
            );
            Cartesian3.clone(camera.direction, camera.direction);
            Cartesian3.cross(camera.direction, camera.up, camera.right);
            Cartesian3.cross(camera.right, camera.direction, camera.up);

            camera.setView(scratchZoomViewOptions);
            return;
          }
        } else {
          const positionNormal = Cartesian3.normalize(
            centerPosition,
            scratchPositionNormal,
          );
          const pickedNormal = Cartesian3.normalize(
            object._zoomWorldPosition,
            scratchPickNormal,
          );
          const dotProduct = Cartesian3.dot(pickedNormal, positionNormal);

          if (dotProduct > 0.0 && dotProduct < 1.0) {
            const angle = CesiumMath.acosClamped(dotProduct);
            const axis = Cartesian3.cross(
              pickedNormal,
              positionNormal,
              scratchZoomAxis,
            );
            const denom =
              Math.abs(angle) > CesiumMath.toRadians(20.0)
                ? camera.positionCartographic.height * 0.75
                : camera.positionCartographic.height - distance;
            const scalar = distance / denom;
            camera.rotate(axis, angle * scalar);
          }
        }
      }
    }

    object._rotatingZoom = !zoomOnVector;
  }

  if ((!sameStartPosition && zoomOnVector) || zoomingOnVector) {
    let ray;
    const zoomMouseStart = SceneTransforms.worldToWindowCoordinates(
      scene,
      object._zoomWorldPosition,
      scratchZoomOffset,
    );
    if (
      mode !== SceneMode.COLUMBUS_VIEW &&
      Cartesian2.equals(startPosition, object._zoomMouseStart) &&
      defined(zoomMouseStart)
    ) {
      ray = camera.getPickRay(zoomMouseStart, scratchZoomPickRay);
    } else {
      ray = camera.getPickRay(startPosition, scratchZoomPickRay);
    }

    const rayDirection = ray.direction;
    if (mode === SceneMode.COLUMBUS_VIEW || mode === SceneMode.SCENE2D) {
      Cartesian3.fromElements(
        rayDirection.y,
        rayDirection.z,
        rayDirection.x,
        rayDirection,
      );
    }

    camera.move(rayDirection, distance);
    object._zoomingOnVector = true;
  } else {
    camera.zoomIn(distance);
  }

  if (!object._cameraUnderground) {
    camera.setView(scratchZoomViewOptions);
  }
}

// ---- rotate3D ----

export function rotate3D(
  controller,
  startPosition,
  movement,
  constrainedAxis,
  rotateOnlyVertical,
  rotateOnlyHorizontal,
) {
  rotateOnlyVertical = rotateOnlyVertical ?? false;
  rotateOnlyHorizontal = rotateOnlyHorizontal ?? false;

  const scene = controller._scene;
  const camera = scene.camera;
  const canvas = scene.canvas;

  const oldAxis = camera.constrainedAxis;
  if (defined(constrainedAxis)) {
    camera.constrainedAxis = constrainedAxis;
  }

  const rho = Cartesian3.magnitude(camera.position);
  let rotateRate =
    controller._rotateFactor * (rho - controller._rotateRateRangeAdjustment);

  if (rotateRate > controller._maximumRotateRate) {
    rotateRate = controller._maximumRotateRate;
  }
  if (rotateRate < controller._minimumRotateRate) {
    rotateRate = controller._minimumRotateRate;
  }

  let phiWindowRatio =
    (movement.startPosition.x - movement.endPosition.x) / canvas.clientWidth;
  let thetaWindowRatio =
    (movement.startPosition.y - movement.endPosition.y) / canvas.clientHeight;
  phiWindowRatio = Math.min(phiWindowRatio, controller.maximumMovementRatio);
  thetaWindowRatio = Math.min(
    thetaWindowRatio,
    controller.maximumMovementRatio,
  );

  const deltaPhi = rotateRate * phiWindowRatio * Math.PI * 2.0;
  let deltaTheta = rotateRate * thetaWindowRatio * Math.PI;

  if (defined(constrainedAxis) && defined(controller.maximumTiltAngle)) {
    const maximumTiltAngle = controller.maximumTiltAngle;
    const dotProduct = Cartesian3.dot(camera.direction, constrainedAxis);
    const tilt = Math.PI - Math.acos(dotProduct) + deltaTheta;
    if (tilt > maximumTiltAngle) {
      deltaTheta -= tilt - maximumTiltAngle;
    }
  }

  if (!rotateOnlyVertical) {
    camera.rotateRight(deltaPhi);
  }
  if (!rotateOnlyHorizontal) {
    camera.rotateUp(deltaTheta);
  }

  camera.constrainedAxis = oldAxis;
}

// ---- look3D ----

const look3DStartPos = new Cartesian2();
const look3DEndPos = new Cartesian2();
const look3DStartRay = new Ray();
const look3DEndRay = new Ray();
const look3DNegativeRot = new Cartesian3();
const look3DTan = new Cartesian3();

export function look3D(controller, startPosition, movement, rotationAxis) {
  const scene = controller._scene;
  const camera = scene.camera;

  const startPos = look3DStartPos;
  startPos.x = movement.startPosition.x;
  startPos.y = 0.0;
  const endPos = look3DEndPos;
  endPos.x = movement.endPosition.x;
  endPos.y = 0.0;

  let startRay = camera.getPickRay(startPos, look3DStartRay);
  let endRay = camera.getPickRay(endPos, look3DEndRay);
  let angle = 0.0;
  let start;
  let end;

  if (camera.frustum instanceof OrthographicFrustum) {
    start = startRay.origin;
    end = endRay.origin;
    Cartesian3.add(camera.direction, start, start);
    Cartesian3.add(camera.direction, end, end);
    Cartesian3.subtract(start, camera.position, start);
    Cartesian3.subtract(end, camera.position, end);
    Cartesian3.normalize(start, start);
    Cartesian3.normalize(end, end);
  } else {
    start = startRay.direction;
    end = endRay.direction;
  }

  let dot = Cartesian3.dot(start, end);
  if (dot < 1.0) {
    angle = Math.acos(dot);
  }
  angle = movement.startPosition.x > movement.endPosition.x ? -angle : angle;

  const horizontalRotationAxis = controller._horizontalRotationAxis;
  if (defined(rotationAxis)) {
    camera.look(rotationAxis, -angle);
  } else if (defined(horizontalRotationAxis)) {
    camera.look(horizontalRotationAxis, -angle);
  } else {
    camera.lookLeft(angle);
  }

  startPos.x = 0.0;
  startPos.y = movement.startPosition.y;
  endPos.x = 0.0;
  endPos.y = movement.endPosition.y;

  startRay = camera.getPickRay(startPos, look3DStartRay);
  endRay = camera.getPickRay(endPos, look3DEndRay);
  angle = 0.0;

  if (camera.frustum instanceof OrthographicFrustum) {
    start = startRay.origin;
    end = endRay.origin;
    Cartesian3.add(camera.direction, start, start);
    Cartesian3.add(camera.direction, end, end);
    Cartesian3.subtract(start, camera.position, start);
    Cartesian3.subtract(end, camera.position, end);
    Cartesian3.normalize(start, start);
    Cartesian3.normalize(end, end);
  } else {
    start = startRay.direction;
    end = endRay.direction;
  }

  dot = Cartesian3.dot(start, end);
  if (dot < 1.0) {
    angle = Math.acos(dot);
  }
  angle = movement.startPosition.y > movement.endPosition.y ? -angle : angle;

  rotationAxis = rotationAxis ?? horizontalRotationAxis;
  if (defined(rotationAxis)) {
    const direction = camera.direction;
    const negativeRotationAxis = Cartesian3.negate(
      rotationAxis,
      look3DNegativeRot,
    );
    const northParallel = Cartesian3.equalsEpsilon(
      direction,
      rotationAxis,
      CesiumMath.EPSILON2,
    );
    const southParallel = Cartesian3.equalsEpsilon(
      direction,
      negativeRotationAxis,
      CesiumMath.EPSILON2,
    );
    if (!northParallel && !southParallel) {
      dot = Cartesian3.dot(direction, rotationAxis);
      let angleToAxis = CesiumMath.acosClamped(dot);
      if (angle > 0 && angle > angleToAxis) {
        angle = angleToAxis - CesiumMath.EPSILON4;
      }

      dot = Cartesian3.dot(direction, negativeRotationAxis);
      angleToAxis = CesiumMath.acosClamped(dot);
      if (angle < 0 && -angle > angleToAxis) {
        angle = -angleToAxis + CesiumMath.EPSILON4;
      }

      const tangent = Cartesian3.cross(rotationAxis, direction, look3DTan);
      camera.look(tangent, angle);
    } else if ((northParallel && angle < 0) || (southParallel && angle > 0)) {
      camera.look(camera.right, -angle);
    }
  } else {
    camera.lookUp(angle);
  }
}

// ---- pan3D ----

const pan3DP0 = Cartesian4.clone(Cartesian4.UNIT_W);
const pan3DP1 = Cartesian4.clone(Cartesian4.UNIT_W);
const pan3DTemp0 = new Cartesian3();
const pan3DTemp1 = new Cartesian3();
const pan3DTemp2 = new Cartesian3();
const pan3DTemp3 = new Cartesian3();
const pan3DStartMousePosition = new Cartesian2();
const pan3DEndMousePosition = new Cartesian2();
const pan3DDiffMousePosition = new Cartesian2();
const pan3DPixelDimensions = new Cartesian2();
const panRay = new Ray();
const scratchPanCartographic = new Cartographic();

export function pan3D(controller, startPosition, movement, ellipsoid) {
  const scene = controller._scene;
  const camera = scene.camera;

  const startMousePosition = Cartesian2.clone(
    movement.startPosition,
    pan3DStartMousePosition,
  );
  const endMousePosition = Cartesian2.clone(
    movement.endPosition,
    pan3DEndMousePosition,
  );
  const height = ellipsoid.cartesianToCartographic(
    camera.positionWC,
    scratchPanCartographic,
  ).height;

  let p0, p1;

  if (
    !movement.inertiaEnabled &&
    height < controller._minimumPickingTerrainHeight
  ) {
    p0 = Cartesian3.clone(controller._panLastWorldPosition, pan3DP0);

    if (
      !defined(controller._globe) &&
      !Cartesian2.equalsEpsilon(
        startMousePosition,
        controller._panLastMousePosition,
      )
    ) {
      p0 = pickPosition(controller, startMousePosition, pan3DP0);
    }

    if (!defined(controller._globe) && defined(p0)) {
      const toCenter = Cartesian3.subtract(p0, camera.positionWC, pan3DTemp1);
      const toCenterProj = Cartesian3.multiplyByScalar(
        camera.directionWC,
        Cartesian3.dot(camera.directionWC, toCenter),
        pan3DTemp1,
      );
      const distanceToNearPlane = Cartesian3.magnitude(toCenterProj);
      const pixelDimensions = camera.frustum.getPixelDimensions(
        scene.drawingBufferWidth,
        scene.drawingBufferHeight,
        distanceToNearPlane,
        scene.pixelRatio,
        pan3DPixelDimensions,
      );

      const dragDelta = Cartesian2.subtract(
        endMousePosition,
        startMousePosition,
        pan3DDiffMousePosition,
      );

      const right = Cartesian3.multiplyByScalar(
        camera.rightWC,
        dragDelta.x * pixelDimensions.x,
        pan3DTemp1,
      );

      const cameraPositionNormal = Cartesian3.normalize(
        camera.positionWC,
        scratchCameraPositionNormal,
      );
      const endPickDirection = camera.getPickRay(
        endMousePosition,
        panRay,
      ).direction;
      const endPickProj = Cartesian3.subtract(
        endPickDirection,
        Cartesian3.projectVector(endPickDirection, camera.rightWC, pan3DTemp2),
        pan3DTemp2,
      );
      const angle = Cartesian3.angleBetween(endPickProj, camera.directionWC);
      let forward = 1.0;
      if (defined(camera.frustum.fov)) {
        forward = Math.max(Math.tan(angle), 0.1);
      }
      let dot = Math.abs(
        Cartesian3.dot(camera.directionWC, cameraPositionNormal),
      );
      const magnitude =
        ((-dragDelta.y * pixelDimensions.y * 2.0) / Math.sqrt(forward)) *
        (1.0 - dot);
      const direction = Cartesian3.multiplyByScalar(
        endPickDirection,
        magnitude,
        pan3DTemp2,
      );

      dot = Math.abs(Cartesian3.dot(camera.upWC, cameraPositionNormal));
      const up = Cartesian3.multiplyByScalar(
        camera.upWC,
        -dragDelta.y * (1.0 - dot) * pixelDimensions.y,
        pan3DTemp3,
      );

      p1 = Cartesian3.add(p0, right, pan3DP1);
      p1 = Cartesian3.add(p1, direction, p1);
      p1 = Cartesian3.add(p1, up, p1);

      Cartesian3.clone(p1, controller._panLastWorldPosition);
      Cartesian2.clone(endMousePosition, controller._panLastMousePosition);
    }
  }

  if (!defined(p0) || !defined(p1)) {
    p0 = camera.pickEllipsoid(startMousePosition, ellipsoid, pan3DP0);
    p1 = camera.pickEllipsoid(endMousePosition, ellipsoid, pan3DP1);
  }

  if (!defined(p0) || !defined(p1)) {
    controller._rotating = true;
    rotate3D(controller, startPosition, movement);
    return;
  }

  p0 = camera.worldToCameraCoordinates(p0, p0);
  p1 = camera.worldToCameraCoordinates(p1, p1);

  if (!defined(camera.constrainedAxis)) {
    Cartesian3.normalize(p0, p0);
    Cartesian3.normalize(p1, p1);
    const dot = Cartesian3.dot(p0, p1);
    const axis = Cartesian3.cross(p0, p1, pan3DTemp0);

    if (
      dot < 1.0 &&
      !Cartesian3.equalsEpsilon(axis, Cartesian3.ZERO, CesiumMath.EPSILON14)
    ) {
      const angle = Math.acos(dot);
      camera.rotate(axis, angle);
    }
  } else {
    const basis0 = camera.constrainedAxis;
    const basis1 = Cartesian3.mostOrthogonalAxis(basis0, pan3DTemp0);
    Cartesian3.cross(basis1, basis0, basis1);
    Cartesian3.normalize(basis1, basis1);
    const basis2 = Cartesian3.cross(basis0, basis1, pan3DTemp1);

    const startRho = Cartesian3.magnitude(p0);
    const startDot = Cartesian3.dot(basis0, p0);
    const startTheta = Math.acos(startDot / startRho);
    const startRej = Cartesian3.multiplyByScalar(basis0, startDot, pan3DTemp2);
    Cartesian3.subtract(p0, startRej, startRej);
    Cartesian3.normalize(startRej, startRej);

    const endRho = Cartesian3.magnitude(p1);
    const endDot = Cartesian3.dot(basis0, p1);
    const endTheta = Math.acos(endDot / endRho);
    const endRej = Cartesian3.multiplyByScalar(basis0, endDot, pan3DTemp3);
    Cartesian3.subtract(p1, endRej, endRej);
    Cartesian3.normalize(endRej, endRej);

    let startPhi = Math.acos(Cartesian3.dot(startRej, basis1));
    if (Cartesian3.dot(startRej, basis2) < 0) {
      startPhi = CesiumMath.TWO_PI - startPhi;
    }

    let endPhi = Math.acos(Cartesian3.dot(endRej, basis1));
    if (Cartesian3.dot(endRej, basis2) < 0) {
      endPhi = CesiumMath.TWO_PI - endPhi;
    }

    const deltaPhi = startPhi - endPhi;

    let east;
    if (
      Cartesian3.equalsEpsilon(basis0, camera.position, CesiumMath.EPSILON2)
    ) {
      east = camera.right;
    } else {
      east = Cartesian3.cross(basis0, camera.position, pan3DTemp0);
    }

    const planeNormal = Cartesian3.cross(basis0, east, pan3DTemp0);
    const side0 = Cartesian3.dot(
      planeNormal,
      Cartesian3.subtract(p0, basis0, pan3DTemp1),
    );
    const side1 = Cartesian3.dot(
      planeNormal,
      Cartesian3.subtract(p1, basis0, pan3DTemp1),
    );

    let deltaTheta;
    if (side0 > 0 && side1 > 0) {
      deltaTheta = endTheta - startTheta;
    } else if (side0 > 0 && side1 <= 0) {
      if (Cartesian3.dot(camera.position, basis0) > 0) {
        deltaTheta = -startTheta - endTheta;
      } else {
        deltaTheta = startTheta + endTheta;
      }
    } else {
      deltaTheta = startTheta - endTheta;
    }

    camera.rotateRight(deltaPhi);
    camera.rotateUp(deltaTheta);
  }
}

// Namespace default export for build system barrel compatibility
const SSCCInputHelpers = {
  pickPosition,
  getDistanceFromSurface,
  getZoomDistanceUnderground,
  getTiltCenterUnderground,
  getStrafeStartPositionUnderground,
  strafe,
  continueStrafing,
  handleZoom,
  rotate3D,
  look3D,
  pan3D,
};
export default SSCCInputHelpers;
