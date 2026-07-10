/**
 * Mode-specific input handlers for ScreenSpaceCameraController.
 * Provides update2D, updateCV, and update3D functions.
 *
 * @private
 */
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import Ellipsoid from "../Core/Ellipsoid.js";
import IntersectionTests from "../Core/IntersectionTests.js";
import CesiumMath from "../Core/Math.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import Plane from "../Core/Plane.js";
import Quaternion from "../Core/Quaternion.js";
import Ray from "../Core/Ray.js";
import Transforms from "../Core/Transforms.js";
import MapMode2D from "./MapMode2D.js";
import {
  pickPosition,
  getZoomDistanceUnderground,
  getTiltCenterUnderground,
  getStrafeStartPositionUnderground,
  continueStrafing,
  strafe,
  handleZoom,
  rotate3D,
  look3D,
  pan3D,
} from "./SSCCInputHelpers.js";

// ---- 2D Mode ----

const translate2DStart = new Ray();
const translate2DEnd = new Ray();
const scratchTranslateP0 = new Cartesian3();

function translate2D(controller, startPosition, movement) {
  const scene = controller._scene;
  const camera = scene.camera;
  let start = camera.getPickRay(
    movement.startPosition,
    translate2DStart,
  ).origin;
  let end = camera.getPickRay(movement.endPosition, translate2DEnd).origin;

  start = Cartesian3.fromElements(start.y, start.z, start.x, start);
  end = Cartesian3.fromElements(end.y, end.z, end.x, end);

  const direction = Cartesian3.subtract(start, end, scratchTranslateP0);
  const distance = Cartesian3.magnitude(direction);

  if (distance > 0.0) {
    Cartesian3.normalize(direction, direction);
    camera.move(direction, distance);
  }
}

function zoom2D(controller, startPosition, movement) {
  if (defined(movement.distance)) {
    movement = movement.distance;
  }
  const scene = controller._scene;
  const camera = scene.camera;
  handleZoom(
    controller,
    startPosition,
    movement,
    controller.zoomFactor,
    camera.getMagnitude(),
  );
}

const twist2DStart = new Cartesian2();
const twist2DEnd = new Cartesian2();

function twist2D(controller, startPosition, movement) {
  if (defined(movement.angleAndHeight)) {
    singleAxisTwist2D(controller, startPosition, movement.angleAndHeight);
    return;
  }

  const scene = controller._scene;
  const camera = scene.camera;
  const canvas = scene.canvas;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  let start = twist2DStart;
  start.x = (2.0 / width) * movement.startPosition.x - 1.0;
  start.y = (2.0 / height) * (height - movement.startPosition.y) - 1.0;
  start = Cartesian2.normalize(start, start);

  let end = twist2DEnd;
  end.x = (2.0 / width) * movement.endPosition.x - 1.0;
  end.y = (2.0 / height) * (height - movement.endPosition.y) - 1.0;
  end = Cartesian2.normalize(end, end);

  let startTheta = CesiumMath.acosClamped(start.x);
  if (start.y < 0) {
    startTheta = CesiumMath.TWO_PI - startTheta;
  }
  let endTheta = CesiumMath.acosClamped(end.x);
  if (end.y < 0) {
    endTheta = CesiumMath.TWO_PI - endTheta;
  }
  const theta = endTheta - startTheta;
  camera.twistRight(theta);
}

function singleAxisTwist2D(controller, startPosition, movement) {
  let rotateRate =
    controller._rotateFactor * controller._rotateRateRangeAdjustment;

  if (rotateRate > controller._maximumRotateRate) {
    rotateRate = controller._maximumRotateRate;
  }
  if (rotateRate < controller._minimumRotateRate) {
    rotateRate = controller._minimumRotateRate;
  }

  const scene = controller._scene;
  const camera = scene.camera;
  const canvas = scene.canvas;

  let phiWindowRatio =
    (movement.endPosition.x - movement.startPosition.x) / canvas.clientWidth;
  phiWindowRatio = Math.min(phiWindowRatio, controller.maximumMovementRatio);

  const deltaPhi = rotateRate * phiWindowRatio * Math.PI * 4.0;
  camera.twistRight(deltaPhi);
}

export function update2D(controller) {
  const rotatable2D = controller._scene.mapMode2D === MapMode2D.ROTATE;
  if (!Matrix4.equals(Matrix4.IDENTITY, controller._scene.camera.transform)) {
    controller._reactToInput(
      controller.enableZoom,
      controller.zoomEventTypes,
      zoom2D,
      controller.inertiaZoom,
      "_lastInertiaZoomMovement",
    );
    if (rotatable2D) {
      controller._reactToInput(
        controller.enableRotate,
        controller.translateEventTypes,
        twist2D,
        controller.inertiaSpin,
        "_lastInertiaSpinMovement",
      );
    }
  } else {
    controller._reactToInput(
      controller.enableTranslate,
      controller.translateEventTypes,
      translate2D,
      controller.inertiaTranslate,
      "_lastInertiaTranslateMovement",
    );
    controller._reactToInput(
      controller.enableZoom,
      controller.zoomEventTypes,
      zoom2D,
      controller.inertiaZoom,
      "_lastInertiaZoomMovement",
    );
    if (rotatable2D) {
      controller._reactToInput(
        controller.enableRotate,
        controller.tiltEventTypes,
        twist2D,
        controller.inertiaSpin,
        "_lastInertiaTiltMovement",
      );
    }
  }
}

// ---- Columbus View Mode ----

const translateCVStartRay = new Ray();
const translateCVEndRay = new Ray();
const translateCVStartPos = new Cartesian3();
const translateCVEndPos = new Cartesian3();
const translateCVDifference = new Cartesian3();
const translateCVOrigin = new Cartesian3();
const translateCVPlane = new Plane(Cartesian3.UNIT_X, 0.0);
const translateCVStartMouse = new Cartesian2();
const translateCVEndMouse = new Cartesian2();

function translateCV(controller, startPosition, movement) {
  if (!Cartesian3.equals(startPosition, controller._translateMousePosition)) {
    controller._looking = false;
  }
  if (!Cartesian3.equals(startPosition, controller._strafeMousePosition)) {
    controller._strafing = false;
  }
  if (controller._looking) {
    look3D(controller, startPosition, movement);
    return;
  }
  if (controller._strafing) {
    continueStrafing(controller, movement);
    return;
  }

  const scene = controller._scene;
  const camera = scene.camera;
  const cameraUnderground = controller._cameraUnderground;
  const startMouse = Cartesian2.clone(
    movement.startPosition,
    translateCVStartMouse,
  );
  const endMouse = Cartesian2.clone(movement.endPosition, translateCVEndMouse);
  let startRay = camera.getPickRay(startMouse, translateCVStartRay);

  const origin = Cartesian3.clone(Cartesian3.ZERO, translateCVOrigin);
  const normal = Cartesian3.UNIT_X;

  let globePos;
  if (camera.position.z < controller._minimumPickingTerrainHeight) {
    globePos = pickPosition(controller, startMouse, translateCVStartPos);
    if (defined(globePos)) {
      origin.x = globePos.x;
    }
  }

  if (
    cameraUnderground ||
    (origin.x > camera.position.z && defined(globePos))
  ) {
    let pickPos = globePos;
    if (cameraUnderground) {
      pickPos = getStrafeStartPositionUnderground(
        controller,
        startRay,
        globePos,
        translateCVStartPos,
      );
    }
    Cartesian2.clone(startPosition, controller._strafeMousePosition);
    Cartesian2.clone(startPosition, controller._strafeEndMousePosition);
    Cartesian3.clone(pickPos, controller._strafeStartPosition);
    controller._strafing = true;
    strafe(controller, movement, controller._strafeStartPosition);
    return;
  }

  const plane = Plane.fromPointNormal(origin, normal, translateCVPlane);
  startRay = camera.getPickRay(startMouse, translateCVStartRay);
  const startPlanePos = IntersectionTests.rayPlane(
    startRay,
    plane,
    translateCVStartPos,
  );
  const endRay = camera.getPickRay(endMouse, translateCVEndRay);
  const endPlanePos = IntersectionTests.rayPlane(
    endRay,
    plane,
    translateCVEndPos,
  );

  if (!defined(startPlanePos) || !defined(endPlanePos)) {
    controller._looking = true;
    look3D(controller, startPosition, movement);
    Cartesian2.clone(startPosition, controller._translateMousePosition);
    return;
  }

  const diff = Cartesian3.subtract(
    startPlanePos,
    endPlanePos,
    translateCVDifference,
  );
  const temp = diff.x;
  diff.x = diff.y;
  diff.y = diff.z;
  diff.z = temp;
  const mag = Cartesian3.magnitude(diff);
  if (mag > CesiumMath.EPSILON6) {
    Cartesian3.normalize(diff, diff);
    camera.move(diff, mag);
  }
}

const rotateCVWindowPos = new Cartesian2();
const rotateCVWindowRay = new Ray();
const rotateCVCenter = new Cartesian3();
const rotateCVVerticalCenter = new Cartesian3();
const rotateCVTransform = new Matrix4();
const rotateCVVerticalTransform = new Matrix4();
const rotateCVOrigin = new Cartesian3();
const rotateCVPlane = new Plane(Cartesian3.UNIT_X, 0.0);
const rotateCVCartesian3 = new Cartesian3();
const rotateCVCart = new Cartographic();
const rotateCVOldTransform = new Matrix4();
const rotateCVQuaternion = new Quaternion();
const rotateCVMatrix = new Matrix3();
const tilt3DCartesian3 = new Cartesian3();
const scratchRadii = new Cartesian3();
const scratchEllipsoid = new Ellipsoid();

function rotateCV(controller, startPosition, movement) {
  if (defined(movement.angleAndHeight)) {
    movement = movement.angleAndHeight;
  }
  if (!Cartesian2.equals(startPosition, controller._tiltCenterMousePosition)) {
    controller._tiltCVOffMap = false;
    controller._looking = false;
  }
  if (controller._looking) {
    look3D(controller, startPosition, movement);
    return;
  }
  const scene = controller._scene;
  const camera = scene.camera;

  if (
    controller._tiltCVOffMap ||
    !controller.onMap() ||
    Math.abs(camera.position.z) > controller._minimumPickingTerrainHeight
  ) {
    controller._tiltCVOffMap = true;
    rotateCVOnPlane(controller, startPosition, movement);
  } else {
    rotateCVOnTerrain(controller, startPosition, movement);
  }
}

function rotateCVOnPlane(controller, startPosition, movement) {
  const scene = controller._scene;
  const camera = scene.camera;
  const canvas = scene.canvas;

  const windowPosition = rotateCVWindowPos;
  windowPosition.x = canvas.clientWidth / 2;
  windowPosition.y = canvas.clientHeight / 2;
  const ray = camera.getPickRay(windowPosition, rotateCVWindowRay);
  const normal = Cartesian3.UNIT_X;
  const position = ray.origin;
  const direction = ray.direction;
  let scalar;
  const normalDotDirection = Cartesian3.dot(normal, direction);
  if (Math.abs(normalDotDirection) > CesiumMath.EPSILON6) {
    scalar = -Cartesian3.dot(normal, position) / normalDotDirection;
  }
  if (!defined(scalar) || scalar <= 0.0) {
    controller._looking = true;
    look3D(controller, startPosition, movement);
    Cartesian2.clone(startPosition, controller._tiltCenterMousePosition);
    return;
  }

  const center = Cartesian3.multiplyByScalar(direction, scalar, rotateCVCenter);
  Cartesian3.add(position, center, center);

  const projection = scene.mapProjection;
  const ellipsoid = projection.ellipsoid;

  Cartesian3.fromElements(center.y, center.z, center.x, center);
  const cart = projection.unproject(center, rotateCVCart);
  ellipsoid.cartographicToCartesian(cart, center);

  const transform = Transforms.eastNorthUpToFixedFrame(
    center,
    ellipsoid,
    rotateCVTransform,
  );

  const oldGlobe = controller._globe;
  const oldEllipsoid = controller._ellipsoid;
  controller._globe = undefined;
  controller._ellipsoid = Ellipsoid.UNIT_SPHERE;
  controller._rotateFactor = 1.0;
  controller._rotateRateRangeAdjustment = 1.0;

  const oldTransform = Matrix4.clone(camera.transform, rotateCVOldTransform);
  camera._setTransform(transform);

  rotate3D(controller, startPosition, movement, Cartesian3.UNIT_Z);

  camera._setTransform(oldTransform);
  controller._globe = oldGlobe;
  controller._ellipsoid = oldEllipsoid;

  const radius = oldEllipsoid.maximumRadius;
  controller._rotateFactor = 1.0 / radius;
  controller._rotateRateRangeAdjustment = radius;
}

function rotateCVOnTerrain(controller, startPosition, movement) {
  const scene = controller._scene;
  const camera = scene.camera;
  const cameraUnderground = controller._cameraUnderground;

  let center;
  let ray;
  const normal = Cartesian3.UNIT_X;

  if (Cartesian2.equals(startPosition, controller._tiltCenterMousePosition)) {
    center = Cartesian3.clone(controller._tiltCenter, rotateCVCenter);
  } else {
    if (camera.position.z < controller._minimumPickingTerrainHeight) {
      center = pickPosition(controller, startPosition, rotateCVCenter);
    }
    if (!defined(center)) {
      ray = camera.getPickRay(startPosition, rotateCVWindowRay);
      const position = ray.origin;
      const direction = ray.direction;
      let scalar;
      const normalDotDirection = Cartesian3.dot(normal, direction);
      if (Math.abs(normalDotDirection) > CesiumMath.EPSILON6) {
        scalar = -Cartesian3.dot(normal, position) / normalDotDirection;
      }
      if (!defined(scalar) || scalar <= 0.0) {
        controller._looking = true;
        look3D(controller, startPosition, movement);
        Cartesian2.clone(startPosition, controller._tiltCenterMousePosition);
        return;
      }
      center = Cartesian3.multiplyByScalar(direction, scalar, rotateCVCenter);
      Cartesian3.add(position, center, center);
    }
    if (cameraUnderground) {
      if (!defined(ray)) {
        ray = camera.getPickRay(startPosition, rotateCVWindowRay);
      }
      getTiltCenterUnderground(controller, ray, center, center);
    }
    Cartesian2.clone(startPosition, controller._tiltCenterMousePosition);
    Cartesian3.clone(center, controller._tiltCenter);
  }

  const canvas = scene.canvas;
  const windowPosition = rotateCVWindowPos;
  windowPosition.x = canvas.clientWidth / 2;
  windowPosition.y = controller._tiltCenterMousePosition.y;
  ray = camera.getPickRay(windowPosition, rotateCVWindowRay);

  const origin = Cartesian3.clone(Cartesian3.ZERO, rotateCVOrigin);
  origin.x = center.x;

  const plane = Plane.fromPointNormal(origin, normal, rotateCVPlane);
  const verticalCenter = IntersectionTests.rayPlane(
    ray,
    plane,
    rotateCVVerticalCenter,
  );

  const projection = camera._projection;
  const ellipsoid = projection.ellipsoid;

  Cartesian3.fromElements(center.y, center.z, center.x, center);
  let cart = projection.unproject(center, rotateCVCart);
  ellipsoid.cartographicToCartesian(cart, center);

  const transform = Transforms.eastNorthUpToFixedFrame(
    center,
    ellipsoid,
    rotateCVTransform,
  );

  let verticalTransform;
  if (defined(verticalCenter)) {
    Cartesian3.fromElements(
      verticalCenter.y,
      verticalCenter.z,
      verticalCenter.x,
      verticalCenter,
    );
    cart = projection.unproject(verticalCenter, rotateCVCart);
    ellipsoid.cartographicToCartesian(cart, verticalCenter);
    verticalTransform = Transforms.eastNorthUpToFixedFrame(
      verticalCenter,
      ellipsoid,
      rotateCVVerticalTransform,
    );
  } else {
    verticalTransform = transform;
  }

  const oldGlobe = controller._globe;
  const oldEllipsoid = controller._ellipsoid;
  controller._globe = undefined;
  controller._ellipsoid = Ellipsoid.UNIT_SPHERE;
  controller._rotateFactor = 1.0;
  controller._rotateRateRangeAdjustment = 1.0;

  let constrainedAxis = Cartesian3.UNIT_Z;
  const oldTransform = Matrix4.clone(camera.transform, rotateCVOldTransform);
  camera._setTransform(transform);

  const tangent = Cartesian3.cross(
    Cartesian3.UNIT_Z,
    Cartesian3.normalize(camera.position, rotateCVCartesian3),
    rotateCVCartesian3,
  );
  const dot = Cartesian3.dot(camera.right, tangent);

  rotate3D(controller, startPosition, movement, constrainedAxis, false, true);

  camera._setTransform(verticalTransform);
  if (dot < 0.0) {
    const movementDelta = movement.startPosition.y - movement.endPosition.y;
    if (
      (cameraUnderground && movementDelta < 0.0) ||
      (!cameraUnderground && movementDelta > 0.0)
    ) {
      constrainedAxis = undefined;
    }
    const oldConstrainedAxis = camera.constrainedAxis;
    camera.constrainedAxis = undefined;
    rotate3D(controller, startPosition, movement, constrainedAxis, true, false);
    camera.constrainedAxis = oldConstrainedAxis;
  } else {
    rotate3D(controller, startPosition, movement, constrainedAxis, true, false);
  }

  if (defined(camera.constrainedAxis)) {
    const right = Cartesian3.cross(
      camera.direction,
      camera.constrainedAxis,
      tilt3DCartesian3,
    );
    if (
      !Cartesian3.equalsEpsilon(right, Cartesian3.ZERO, CesiumMath.EPSILON6)
    ) {
      if (Cartesian3.dot(right, camera.right) < 0.0) {
        Cartesian3.negate(right, right);
      }
      Cartesian3.cross(right, camera.direction, camera.up);
      Cartesian3.cross(camera.direction, camera.up, camera.right);
      Cartesian3.normalize(camera.up, camera.up);
      Cartesian3.normalize(camera.right, camera.right);
    }
  }

  camera._setTransform(oldTransform);
  controller._globe = oldGlobe;
  controller._ellipsoid = oldEllipsoid;
  const radius = oldEllipsoid.maximumRadius;
  controller._rotateFactor = 1.0 / radius;
  controller._rotateRateRangeAdjustment = radius;

  const originalPosition = Cartesian3.clone(
    camera.positionWC,
    rotateCVCartesian3,
  );

  if (controller.enableCollisionDetection) {
    controller._adjustHeightForTerrain(true);
  }

  if (!Cartesian3.equals(camera.positionWC, originalPosition)) {
    camera._setTransform(verticalTransform);
    camera.worldToCameraCoordinatesPoint(originalPosition, originalPosition);
    const magSqrd = Cartesian3.magnitudeSquared(originalPosition);
    if (Cartesian3.magnitudeSquared(camera.position) > magSqrd) {
      Cartesian3.normalize(camera.position, camera.position);
      Cartesian3.multiplyByScalar(
        camera.position,
        Math.sqrt(magSqrd),
        camera.position,
      );
    }
    const angle = Cartesian3.angleBetween(originalPosition, camera.position);
    const axis = Cartesian3.cross(
      originalPosition,
      camera.position,
      originalPosition,
    );
    Cartesian3.normalize(axis, axis);
    const quaternion = Quaternion.fromAxisAngle(
      axis,
      angle,
      rotateCVQuaternion,
    );
    const rotation = Matrix3.fromQuaternion(quaternion, rotateCVMatrix);
    Matrix3.multiplyByVector(rotation, camera.direction, camera.direction);
    Matrix3.multiplyByVector(rotation, camera.up, camera.up);
    Cartesian3.cross(camera.direction, camera.up, camera.right);
    Cartesian3.cross(camera.right, camera.direction, camera.up);
    camera._setTransform(oldTransform);
  }
}

const zoomCVWindowPos = new Cartesian2();
const zoomCVWindowRay = new Ray();
const zoomCVIntersection = new Cartesian3();

function zoomCV(controller, startPosition, movement) {
  if (defined(movement.distance)) {
    movement = movement.distance;
  }
  const scene = controller._scene;
  const camera = scene.camera;
  const canvas = scene.canvas;
  const cameraUnderground = controller._cameraUnderground;

  let windowPosition;
  if (cameraUnderground) {
    windowPosition = startPosition;
  } else {
    windowPosition = zoomCVWindowPos;
    windowPosition.x = canvas.clientWidth / 2;
    windowPosition.y = canvas.clientHeight / 2;
  }

  const ray = camera.getPickRay(windowPosition, zoomCVWindowRay);
  const height = camera.position.z;

  let intersection;
  if (height < controller._minimumPickingTerrainHeight) {
    intersection = pickPosition(controller, windowPosition, zoomCVIntersection);
  }

  let distance;
  if (defined(intersection)) {
    distance = Cartesian3.distance(ray.origin, intersection);
  }
  if (cameraUnderground) {
    const distanceUnderground = getZoomDistanceUnderground(
      controller,
      ray,
      height,
    );
    if (defined(distance)) {
      distance = Math.min(distance, distanceUnderground);
    } else {
      distance = distanceUnderground;
    }
  }
  if (!defined(distance)) {
    const normal = Cartesian3.UNIT_X;
    distance =
      -Cartesian3.dot(normal, ray.origin) /
      Cartesian3.dot(normal, ray.direction);
  }

  handleZoom(
    controller,
    startPosition,
    movement,
    controller.zoomFactor,
    distance,
  );
}

export function updateCV(controller) {
  const scene = controller._scene;
  const camera = scene.camera;

  if (!Matrix4.equals(Matrix4.IDENTITY, camera.transform)) {
    controller._reactToInput(
      controller.enableRotate,
      controller.rotateEventTypes,
      rotate3D,
      controller.inertiaSpin,
      "_lastInertiaSpinMovement",
    );
    controller._reactToInput(
      controller.enableZoom,
      controller.zoomEventTypes,
      zoom3DHandler,
      controller.inertiaZoom,
      "_lastInertiaZoomMovement",
    );
  } else {
    const tweens = controller._tweens;
    if (controller._aggregator.anyButtonDown) {
      tweens.removeAll();
    }

    controller._reactToInput(
      controller.enableTilt,
      controller.tiltEventTypes,
      rotateCV,
      controller.inertiaSpin,
      "_lastInertiaTiltMovement",
    );
    controller._reactToInput(
      controller.enableTranslate,
      controller.translateEventTypes,
      translateCV,
      controller.inertiaTranslate,
      "_lastInertiaTranslateMovement",
    );
    controller._reactToInput(
      controller.enableZoom,
      controller.zoomEventTypes,
      zoomCV,
      controller.inertiaZoom,
      "_lastInertiaZoomMovement",
    );
    controller._reactToInput(
      controller.enableLook,
      controller.lookEventTypes,
      look3D,
    );

    if (
      !controller._aggregator.anyButtonDown &&
      !tweens.contains(controller._tween)
    ) {
      const tween = camera.createCorrectPositionTween(
        controller.bounceAnimationTime,
      );
      if (defined(tween)) {
        controller._tween = tweens.add(tween);
      }
    }
    tweens.update();
  }
}

// ---- 3D Mode ----

const spin3DPick = new Cartesian3();
const scratchCartographic = new Cartographic();
const scratchLookUp = new Cartesian3();
const scratchNormal = new Cartesian3();
const scratchMousePosition = new Cartesian3();

function spin3D(controller, startPosition, movement) {
  const scene = controller._scene;
  const camera = scene.camera;
  const cameraUnderground = controller._cameraUnderground;
  let ellipsoid = controller._ellipsoid;

  if (!Matrix4.equals(camera.transform, Matrix4.IDENTITY)) {
    rotate3D(controller, startPosition, movement);
    return;
  }

  let magnitude;
  let radii;

  const up = ellipsoid.geodeticSurfaceNormal(camera.position, scratchLookUp);

  if (Cartesian2.equals(startPosition, controller._rotateMousePosition)) {
    if (controller._looking) {
      look3D(controller, startPosition, movement, up);
    } else if (controller._rotating) {
      rotate3D(controller, startPosition, movement);
    } else if (controller._strafing) {
      continueStrafing(controller, movement);
    } else {
      if (
        Cartesian3.magnitude(camera.position) <
        Cartesian3.magnitude(controller._rotateStartPosition)
      ) {
        return;
      }
      magnitude = Cartesian3.magnitude(controller._rotateStartPosition);
      radii = scratchRadii;
      radii.x = radii.y = radii.z = magnitude;
      ellipsoid = Ellipsoid.fromCartesian3(radii, scratchEllipsoid);
      pan3D(controller, startPosition, movement, ellipsoid);
    }
    return;
  }
  controller._looking = false;
  controller._rotating = false;
  controller._strafing = false;

  const height = ellipsoid.cartesianToCartographic(
    camera.positionWC,
    scratchCartographic,
  ).height;
  const globe = controller._globe;

  if (defined(globe) && height < controller._minimumPickingTerrainHeight) {
    const mousePos = pickPosition(
      controller,
      movement.startPosition,
      scratchMousePosition,
    );
    if (defined(mousePos)) {
      let strafing;
      const ray = camera.getPickRay(
        movement.startPosition,
        pickGlobeScratchRay,
      );

      if (cameraUnderground) {
        strafing = true;
        getStrafeStartPositionUnderground(controller, ray, mousePos, mousePos);
      } else {
        const normal = ellipsoid.geodeticSurfaceNormal(mousePos, scratchNormal);
        const tangentPick =
          Math.abs(Cartesian3.dot(ray.direction, normal)) < 0.05;
        if (tangentPick) {
          strafing = true;
        } else {
          strafing =
            Cartesian3.magnitude(camera.position) <
            Cartesian3.magnitude(mousePos);
        }
      }

      if (strafing) {
        Cartesian2.clone(startPosition, controller._strafeEndMousePosition);
        Cartesian3.clone(mousePos, controller._strafeStartPosition);
        controller._strafing = true;
        strafe(controller, movement, controller._strafeStartPosition);
      } else {
        magnitude = Cartesian3.magnitude(mousePos);
        radii = scratchRadii;
        radii.x = radii.y = radii.z = magnitude;
        ellipsoid = Ellipsoid.fromCartesian3(radii, scratchEllipsoid);
        pan3D(controller, startPosition, movement, ellipsoid);
        Cartesian3.clone(mousePos, controller._rotateStartPosition);
      }
    } else {
      controller._looking = true;
      look3D(controller, startPosition, movement, up);
    }
  } else if (
    defined(
      camera.pickEllipsoid(
        movement.startPosition,
        controller._ellipsoid,
        spin3DPick,
      ),
    )
  ) {
    pan3D(controller, startPosition, movement, controller._ellipsoid);
    Cartesian3.clone(spin3DPick, controller._rotateStartPosition);
  } else if (height > controller._minimumTrackBallHeight) {
    controller._rotating = true;
    rotate3D(controller, startPosition, movement);
  } else {
    controller._looking = true;
    look3D(controller, startPosition, movement, up);
  }

  Cartesian2.clone(startPosition, controller._rotateMousePosition);
}

const pickGlobeScratchRay = new Ray();
const zoom3DUnitPosition = new Cartesian3();
const zoom3DCartographic = new Cartographic();
let preIntersectionDistance = 0;

function zoom3DHandler(controller, startPosition, movement) {
  if (defined(movement.distance)) {
    movement = movement.distance;
  }
  const inertiaMovement = movement.inertiaEnabled;

  const ellipsoid = controller._ellipsoid;
  const scene = controller._scene;
  const camera = scene.camera;
  const canvas = scene.canvas;
  const cameraUnderground = controller._cameraUnderground;

  let windowPosition;
  if (cameraUnderground) {
    windowPosition = startPosition;
  } else {
    windowPosition = zoomCVWindowPos;
    windowPosition.x = canvas.clientWidth / 2;
    windowPosition.y = canvas.clientHeight / 2;
  }

  const ray = camera.getPickRay(windowPosition, zoomCVWindowRay);
  let intersection;
  const height = ellipsoid.cartesianToCartographic(
    camera.position,
    zoom3DCartographic,
  ).height;

  const approachingCollision =
    Math.abs(preIntersectionDistance) <
    controller.minimumPickingTerrainDistanceWithInertia;
  const needPickGlobe = inertiaMovement
    ? approachingCollision
    : height < controller._minimumPickingTerrainHeight;
  if (needPickGlobe) {
    intersection = pickPosition(controller, windowPosition, zoomCVIntersection);
  }

  let distance;
  if (defined(intersection)) {
    distance = Cartesian3.distance(ray.origin, intersection);
  }

  // In tracking/lookAt mode (_globe is undefined), pickPosition can hit terrain
  // behind the intended target. Ignore farther picks to prevent zoom snap.
  if (!defined(controller._globe) && defined(distance)) {
    const targetDistance = camera.getMagnitude();
    if (targetDistance < distance) {
      distance = undefined;
    }
  }

  if (defined(distance)) {
    preIntersectionDistance = distance;
  }

  if (cameraUnderground) {
    const distanceUnderground = getZoomDistanceUnderground(
      controller,
      ray,
      height,
    );
    if (defined(distance)) {
      distance = Math.min(distance, distanceUnderground);
    } else {
      distance = distanceUnderground;
    }
  }

  if (!defined(distance)) {
    distance = height;
  }

  const unitPosition = Cartesian3.normalize(
    camera.position,
    zoom3DUnitPosition,
  );
  handleZoom(
    controller,
    startPosition,
    movement,
    controller.zoomFactor,
    distance,
    Cartesian3.dot(unitPosition, camera.direction),
  );
}

const tilt3DWindowPos = new Cartesian2();
const tilt3DRay = new Ray();
const tilt3DCenter = new Cartesian3();
const tilt3DVerticalCenter = new Cartesian3();
const tilt3DTransform = new Matrix4();
const tilt3DVerticalTransform = new Matrix4();
const tilt3DOldTransform = new Matrix4();
const tilt3DQuaternion = new Quaternion();
const tilt3DMatrix = new Matrix3();
const tilt3DCart = new Cartographic();
const tilt3DLookUp = new Cartesian3();

function tilt3D(controller, startPosition, movement) {
  const scene = controller._scene;
  const camera = scene.camera;
  if (!Matrix4.equals(camera.transform, Matrix4.IDENTITY)) {
    return;
  }
  if (defined(movement.angleAndHeight)) {
    movement = movement.angleAndHeight;
  }
  if (!Cartesian2.equals(startPosition, controller._tiltCenterMousePosition)) {
    controller._tiltOnEllipsoid = false;
    controller._looking = false;
  }
  if (controller._looking) {
    const up = controller._ellipsoid.geodeticSurfaceNormal(
      camera.position,
      tilt3DLookUp,
    );
    look3D(controller, startPosition, movement, up);
    return;
  }

  const ellipsoid = controller._ellipsoid;
  const cartographic = ellipsoid.cartesianToCartographic(
    camera.position,
    tilt3DCart,
  );

  if (
    controller._tiltOnEllipsoid ||
    cartographic.height > controller._minimumCollisionTerrainHeight
  ) {
    controller._tiltOnEllipsoid = true;
    tilt3DOnEllipsoid(controller, startPosition, movement);
  } else {
    tilt3DOnTerrain(controller, startPosition, movement);
  }
}

const tilt3DOnEllipsoidCartographic = new Cartographic();

function tilt3DOnEllipsoid(controller, startPosition, movement) {
  const ellipsoid = controller._ellipsoid;
  const scene = controller._scene;
  const camera = scene.camera;
  const minHeight = controller.minimumZoomDistance * 0.25;
  const height = ellipsoid.cartesianToCartographic(
    camera.positionWC,
    tilt3DOnEllipsoidCartographic,
  ).height;
  if (
    height - minHeight - 1.0 < CesiumMath.EPSILON3 &&
    movement.endPosition.y - movement.startPosition.y < 0
  ) {
    return;
  }

  const canvas = scene.canvas;
  const windowPosition = tilt3DWindowPos;
  windowPosition.x = canvas.clientWidth / 2;
  windowPosition.y = canvas.clientHeight / 2;
  const ray = camera.getPickRay(windowPosition, tilt3DRay);

  let center;
  const intersection = IntersectionTests.rayEllipsoid(ray, ellipsoid);
  if (defined(intersection)) {
    center = Ray.getPoint(ray, intersection.start, tilt3DCenter);
  } else if (height > controller._minimumTrackBallHeight) {
    const grazingAltitudeLocation = IntersectionTests.grazingAltitudeLocation(
      ray,
      ellipsoid,
    );
    if (!defined(grazingAltitudeLocation)) {
      return;
    }
    const grazingAltitudeCart = ellipsoid.cartesianToCartographic(
      grazingAltitudeLocation,
      tilt3DCart,
    );
    grazingAltitudeCart.height = 0.0;
    center = ellipsoid.cartographicToCartesian(
      grazingAltitudeCart,
      tilt3DCenter,
    );
  } else {
    controller._looking = true;
    const up = controller._ellipsoid.geodeticSurfaceNormal(
      camera.position,
      tilt3DLookUp,
    );
    look3D(controller, startPosition, movement, up);
    Cartesian2.clone(startPosition, controller._tiltCenterMousePosition);
    return;
  }

  const transform = Transforms.eastNorthUpToFixedFrame(
    center,
    ellipsoid,
    tilt3DTransform,
  );
  const oldGlobe = controller._globe;
  const oldEllipsoid = controller._ellipsoid;
  controller._globe = undefined;
  controller._ellipsoid = Ellipsoid.UNIT_SPHERE;
  controller._rotateFactor = 1.0;
  controller._rotateRateRangeAdjustment = 1.0;

  const oldTransform = Matrix4.clone(camera.transform, tilt3DOldTransform);
  camera._setTransform(transform);
  rotate3D(controller, startPosition, movement, Cartesian3.UNIT_Z);
  camera._setTransform(oldTransform);
  controller._globe = oldGlobe;
  controller._ellipsoid = oldEllipsoid;
  const radius = oldEllipsoid.maximumRadius;
  controller._rotateFactor = 1.0 / radius;
  controller._rotateRateRangeAdjustment = radius;
}

function tilt3DOnTerrain(controller, startPosition, movement) {
  const ellipsoid = controller._ellipsoid;
  const scene = controller._scene;
  const camera = scene.camera;
  const cameraUnderground = controller._cameraUnderground;

  let center;
  let ray;
  let intersection;

  if (Cartesian2.equals(startPosition, controller._tiltCenterMousePosition)) {
    center = Cartesian3.clone(controller._tiltCenter, tilt3DCenter);
  } else {
    center = pickPosition(controller, startPosition, tilt3DCenter);
    if (!defined(center)) {
      ray = camera.getPickRay(startPosition, tilt3DRay);
      intersection = IntersectionTests.rayEllipsoid(ray, ellipsoid);
      if (!defined(intersection)) {
        const cartographic = ellipsoid.cartesianToCartographic(
          camera.position,
          tilt3DCart,
        );
        if (cartographic.height <= controller._minimumTrackBallHeight) {
          controller._looking = true;
          const up = controller._ellipsoid.geodeticSurfaceNormal(
            camera.position,
            tilt3DLookUp,
          );
          look3D(controller, startPosition, movement, up);
          Cartesian2.clone(startPosition, controller._tiltCenterMousePosition);
        }
        return;
      }
      center = Ray.getPoint(ray, intersection.start, tilt3DCenter);
    }
    if (cameraUnderground) {
      if (!defined(ray)) {
        ray = camera.getPickRay(startPosition, tilt3DRay);
      }
      getTiltCenterUnderground(controller, ray, center, center);
    }
    Cartesian2.clone(startPosition, controller._tiltCenterMousePosition);
    Cartesian3.clone(center, controller._tiltCenter);
  }

  const canvas = scene.canvas;
  const windowPosition = tilt3DWindowPos;
  windowPosition.x = canvas.clientWidth / 2;
  windowPosition.y = controller._tiltCenterMousePosition.y;
  ray = camera.getPickRay(windowPosition, tilt3DRay);

  const mag = Cartesian3.magnitude(center);
  const radii = Cartesian3.fromElements(mag, mag, mag, scratchRadii);
  const newEllipsoid = Ellipsoid.fromCartesian3(radii, scratchEllipsoid);
  intersection = IntersectionTests.rayEllipsoid(ray, newEllipsoid);
  if (!defined(intersection)) {
    return;
  }

  const t =
    Cartesian3.magnitude(ray.origin) > mag
      ? intersection.start
      : intersection.stop;
  const verticalCenter = Ray.getPoint(ray, t, tilt3DVerticalCenter);

  const transform = Transforms.eastNorthUpToFixedFrame(
    center,
    ellipsoid,
    tilt3DTransform,
  );
  const verticalTransform = Transforms.eastNorthUpToFixedFrame(
    verticalCenter,
    newEllipsoid,
    tilt3DVerticalTransform,
  );

  const oldGlobe = controller._globe;
  const oldEllipsoid = controller._ellipsoid;
  controller._globe = undefined;
  controller._ellipsoid = Ellipsoid.UNIT_SPHERE;
  controller._rotateFactor = 1.0;
  controller._rotateRateRangeAdjustment = 1.0;

  let constrainedAxis = Cartesian3.UNIT_Z;
  const oldTransform = Matrix4.clone(camera.transform, tilt3DOldTransform);
  camera._setTransform(verticalTransform);

  const tangent = Cartesian3.cross(
    verticalCenter,
    camera.positionWC,
    tilt3DCartesian3,
  );
  const dot = Cartesian3.dot(camera.rightWC, tangent);

  if (dot < 0.0) {
    const movementDelta = movement.startPosition.y - movement.endPosition.y;
    if (
      (cameraUnderground && movementDelta < 0.0) ||
      (!cameraUnderground && movementDelta > 0.0)
    ) {
      constrainedAxis = undefined;
    }
    const oldConstrainedAxis = camera.constrainedAxis;
    camera.constrainedAxis = undefined;
    rotate3D(controller, startPosition, movement, constrainedAxis, true, false);
    camera.constrainedAxis = oldConstrainedAxis;
  } else {
    rotate3D(controller, startPosition, movement, constrainedAxis, true, false);
  }

  camera._setTransform(transform);
  rotate3D(controller, startPosition, movement, constrainedAxis, false, true);

  if (defined(camera.constrainedAxis)) {
    const right = Cartesian3.cross(
      camera.direction,
      camera.constrainedAxis,
      tilt3DCartesian3,
    );
    if (
      !Cartesian3.equalsEpsilon(right, Cartesian3.ZERO, CesiumMath.EPSILON6)
    ) {
      if (Cartesian3.dot(right, camera.right) < 0.0) {
        Cartesian3.negate(right, right);
      }
      Cartesian3.cross(right, camera.direction, camera.up);
      Cartesian3.cross(camera.direction, camera.up, camera.right);
      Cartesian3.normalize(camera.up, camera.up);
      Cartesian3.normalize(camera.right, camera.right);
    }
  }

  camera._setTransform(oldTransform);
  controller._globe = oldGlobe;
  controller._ellipsoid = oldEllipsoid;
  const radius = oldEllipsoid.maximumRadius;
  controller._rotateFactor = 1.0 / radius;
  controller._rotateRateRangeAdjustment = radius;

  const originalPosition = Cartesian3.clone(
    camera.positionWC,
    tilt3DCartesian3,
  );

  if (controller.enableCollisionDetection) {
    controller._adjustHeightForTerrain(true);
  }

  if (!Cartesian3.equals(camera.positionWC, originalPosition)) {
    camera._setTransform(verticalTransform);
    camera.worldToCameraCoordinatesPoint(originalPosition, originalPosition);
    const magSqrd = Cartesian3.magnitudeSquared(originalPosition);
    if (Cartesian3.magnitudeSquared(camera.position) > magSqrd) {
      Cartesian3.normalize(camera.position, camera.position);
      Cartesian3.multiplyByScalar(
        camera.position,
        Math.sqrt(magSqrd),
        camera.position,
      );
    }
    const angle = Cartesian3.angleBetween(originalPosition, camera.position);
    const axis = Cartesian3.cross(
      originalPosition,
      camera.position,
      originalPosition,
    );
    Cartesian3.normalize(axis, axis);
    const quaternion = Quaternion.fromAxisAngle(axis, angle, tilt3DQuaternion);
    const rotation = Matrix3.fromQuaternion(quaternion, tilt3DMatrix);
    Matrix3.multiplyByVector(rotation, camera.direction, camera.direction);
    Matrix3.multiplyByVector(rotation, camera.up, camera.up);
    Cartesian3.cross(camera.direction, camera.up, camera.right);
    Cartesian3.cross(camera.right, camera.direction, camera.up);
    camera._setTransform(oldTransform);
  }
}

export function update3D(controller) {
  controller._reactToInput(
    controller.enableRotate,
    controller.rotateEventTypes,
    spin3D,
    controller.inertiaSpin,
    "_lastInertiaSpinMovement",
  );
  controller._reactToInput(
    controller.enableZoom,
    controller.zoomEventTypes,
    zoom3DHandler,
    controller.inertiaZoom,
    "_lastInertiaZoomMovement",
  );
  controller._reactToInput(
    controller.enableTilt,
    controller.tiltEventTypes,
    tilt3D,
    controller.inertiaSpin,
    "_lastInertiaTiltMovement",
  );
  controller._reactToInput(
    controller.enableLook,
    controller.lookEventTypes,
    look3D,
  );
}

// Namespace default export for build system barrel compatibility
const SSCCModeHandlers = {
  update2D,
  updateCV,
  update3D,
};
export default SSCCModeHandlers;
