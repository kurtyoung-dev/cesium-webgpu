/**
 * Internal helper functions for Camera.js — core update, transform, and math logic.
 *
 * Extracted from Camera.js to keep the main class under 1000 lines.
 * All functions take `camera` as the first parameter.
 *
 * @private
 */
import Cartesian3 from "../Core/Cartesian3.js";
import Cartesian4 from "../Core/Cartesian4.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import getTimestamp from "../Core/getTimestamp.js";
import CesiumMath from "../Core/Math.js";
import Matrix4 from "../Core/Matrix4.js";
import DeveloperError from "../Core/DeveloperError.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import Transforms from "../Core/Transforms.js";
import MapMode2D from "./MapMode2D.js";
import SceneMode from "./SceneMode.js";

/**
 * @private
 */
export function updateViewMatrix(camera) {
  Matrix4.computeView(
    camera._position,
    camera._direction,
    camera._up,
    camera._right,
    camera._viewMatrix,
  );
  Matrix4.multiply(
    camera._viewMatrix,
    camera._actualInvTransform,
    camera._viewMatrix,
  );
  Matrix4.inverseTransformation(camera._viewMatrix, camera._invViewMatrix);
}

/**
 * @private
 */
export function updateCameraDeltas(camera) {
  if (!defined(camera._oldPositionWC)) {
    camera._oldPositionWC = Cartesian3.clone(
      camera.positionWC,
      camera._oldPositionWC,
    );
  } else {
    camera.positionWCDeltaMagnitudeLastFrame = camera.positionWCDeltaMagnitude;
    const delta = Cartesian3.subtract(
      camera.positionWC,
      camera._oldPositionWC,
      camera._oldPositionWC,
    );
    camera.positionWCDeltaMagnitude = Cartesian3.magnitude(delta);
    camera._oldPositionWC = Cartesian3.clone(
      camera.positionWC,
      camera._oldPositionWC,
    );

    if (camera.positionWCDeltaMagnitude > 0.0) {
      camera.timeSinceMoved = 0.0;
      camera._lastMovedTimestamp = getTimestamp();
    } else {
      camera.timeSinceMoved =
        Math.max(getTimestamp() - camera._lastMovedTimestamp, 0.0) / 1000.0;
    }
  }
}

function convertTransformForColumbusView(camera) {
  Transforms.basisTo2D(
    camera._projection,
    camera._transform,
    camera._actualTransform,
  );
}

const scratchCartographic = new Cartographic();
const scratchCartesian3Projection = new Cartesian3();
const scratchCartesian3 = new Cartesian3();
const scratchCartesian4Origin = new Cartesian4();
const scratchCartesian4NewOrigin = new Cartesian4();
const scratchCartesian4NewXAxis = new Cartesian4();
const scratchCartesian4NewYAxis = new Cartesian4();
const scratchCartesian4NewZAxis = new Cartesian4();

function convertTransformFor2D(camera) {
  const projection = camera._projection;
  const ellipsoid = projection.ellipsoid;

  const origin = Matrix4.getColumn(
    camera._transform,
    3,
    scratchCartesian4Origin,
  );
  const cartographic = ellipsoid.cartesianToCartographic(
    origin,
    scratchCartographic,
  );

  const projectedPosition = projection.project(
    cartographic,
    scratchCartesian3Projection,
  );
  const newOrigin = scratchCartesian4NewOrigin;
  newOrigin.x = projectedPosition.z;
  newOrigin.y = projectedPosition.x;
  newOrigin.z = projectedPosition.y;
  newOrigin.w = 1.0;

  const newZAxis = Cartesian4.clone(
    Cartesian4.UNIT_X,
    scratchCartesian4NewZAxis,
  );

  const xAxis = Cartesian4.add(
    Matrix4.getColumn(camera._transform, 0, scratchCartesian3),
    origin,
    scratchCartesian3,
  );
  ellipsoid.cartesianToCartographic(xAxis, cartographic);

  projection.project(cartographic, projectedPosition);
  const newXAxis = scratchCartesian4NewXAxis;
  newXAxis.x = projectedPosition.z;
  newXAxis.y = projectedPosition.x;
  newXAxis.z = projectedPosition.y;
  newXAxis.w = 0.0;

  Cartesian3.subtract(newXAxis, newOrigin, newXAxis);
  newXAxis.x = 0.0;

  const newYAxis = scratchCartesian4NewYAxis;
  if (Cartesian3.magnitudeSquared(newXAxis) > CesiumMath.EPSILON10) {
    Cartesian3.cross(newZAxis, newXAxis, newYAxis);
  } else {
    const yAxis = Cartesian4.add(
      Matrix4.getColumn(camera._transform, 1, scratchCartesian3),
      origin,
      scratchCartesian3,
    );
    ellipsoid.cartesianToCartographic(yAxis, cartographic);

    projection.project(cartographic, projectedPosition);
    newYAxis.x = projectedPosition.z;
    newYAxis.y = projectedPosition.x;
    newYAxis.z = projectedPosition.y;
    newYAxis.w = 0.0;

    Cartesian3.subtract(newYAxis, newOrigin, newYAxis);
    newYAxis.x = 0.0;

    if (Cartesian3.magnitudeSquared(newYAxis) < CesiumMath.EPSILON10) {
      Cartesian4.clone(Cartesian4.UNIT_Y, newXAxis);
      Cartesian4.clone(Cartesian4.UNIT_Z, newYAxis);
    }
  }

  Cartesian3.cross(newYAxis, newZAxis, newXAxis);
  Cartesian3.normalize(newXAxis, newXAxis);
  Cartesian3.cross(newZAxis, newXAxis, newYAxis);
  Cartesian3.normalize(newYAxis, newYAxis);

  Matrix4.setColumn(
    camera._actualTransform,
    0,
    newXAxis,
    camera._actualTransform,
  );
  Matrix4.setColumn(
    camera._actualTransform,
    1,
    newYAxis,
    camera._actualTransform,
  );
  Matrix4.setColumn(
    camera._actualTransform,
    2,
    newZAxis,
    camera._actualTransform,
  );
  Matrix4.setColumn(
    camera._actualTransform,
    3,
    newOrigin,
    camera._actualTransform,
  );
}

const scratchCartesian = new Cartesian3();

/**
 * Updates all derived camera properties (world-space position, direction, etc.)
 * from the public position/direction/up/right properties.
 * @private
 */
export function updateMembers(camera) {
  const mode = camera._mode;

  let heightChanged = false;
  let height = 0.0;
  if (mode === SceneMode.SCENE2D) {
    height = camera.frustum.right - camera.frustum.left;
    heightChanged = height !== camera._positionCartographic.height;
  }

  let position = camera._position;
  const positionChanged =
    !Cartesian3.equals(position, camera.position) || heightChanged;
  if (positionChanged) {
    position = Cartesian3.clone(camera.position, camera._position);
  }

  let direction = camera._direction;
  const directionChanged = !Cartesian3.equals(direction, camera.direction);
  if (directionChanged) {
    Cartesian3.normalize(camera.direction, camera.direction);
    direction = Cartesian3.clone(camera.direction, camera._direction);
  }

  let up = camera._up;
  const upChanged = !Cartesian3.equals(up, camera.up);
  if (upChanged) {
    Cartesian3.normalize(camera.up, camera.up);
    up = Cartesian3.clone(camera.up, camera._up);
  }

  let right = camera._right;
  const rightChanged = !Cartesian3.equals(right, camera.right);
  if (rightChanged) {
    Cartesian3.normalize(camera.right, camera.right);
    right = Cartesian3.clone(camera.right, camera._right);
  }

  const transformChanged = camera._transformChanged || camera._modeChanged;
  camera._transformChanged = false;

  if (transformChanged) {
    Matrix4.inverseTransformation(camera._transform, camera._invTransform);

    if (
      camera._mode === SceneMode.COLUMBUS_VIEW ||
      camera._mode === SceneMode.SCENE2D
    ) {
      if (Matrix4.equals(Matrix4.IDENTITY, camera._transform)) {
        Matrix4.clone(camera.constructor.TRANSFORM_2D, camera._actualTransform);
      } else if (camera._mode === SceneMode.COLUMBUS_VIEW) {
        convertTransformForColumbusView(camera);
      } else {
        convertTransformFor2D(camera);
      }
    } else {
      Matrix4.clone(camera._transform, camera._actualTransform);
    }

    Matrix4.inverseTransformation(
      camera._actualTransform,
      camera._actualInvTransform,
    );

    camera._modeChanged = false;
  }

  const transform = camera._actualTransform;

  if (positionChanged || transformChanged) {
    camera._positionWC = Matrix4.multiplyByPoint(
      transform,
      position,
      camera._positionWC,
    );

    if (mode === SceneMode.SCENE3D || mode === SceneMode.MORPHING) {
      camera._positionCartographic =
        camera._projection.ellipsoid.cartesianToCartographic(
          camera._positionWC,
          camera._positionCartographic,
        );
    } else {
      const positionENU = scratchCartesian;
      positionENU.x = camera._positionWC.y;
      positionENU.y = camera._positionWC.z;
      positionENU.z = camera._positionWC.x;

      if (mode === SceneMode.SCENE2D) {
        positionENU.z = height;
      }

      camera._projection.unproject(positionENU, camera._positionCartographic);
    }
  }

  if (directionChanged || upChanged || rightChanged) {
    const det = Cartesian3.dot(
      direction,
      Cartesian3.cross(up, right, scratchCartesian),
    );
    if (Math.abs(1.0 - det) > CesiumMath.EPSILON2) {
      const invUpMag = 1.0 / Cartesian3.magnitudeSquared(up);
      const scalar = Cartesian3.dot(up, direction) * invUpMag;
      const w0 = Cartesian3.multiplyByScalar(
        direction,
        scalar,
        scratchCartesian,
      );
      up = Cartesian3.normalize(
        Cartesian3.subtract(up, w0, camera._up),
        camera._up,
      );
      Cartesian3.clone(up, camera.up);

      right = Cartesian3.cross(direction, up, camera._right);
      Cartesian3.clone(right, camera.right);
    }
  }

  if (directionChanged || transformChanged) {
    camera._directionWC = Matrix4.multiplyByPointAsVector(
      transform,
      direction,
      camera._directionWC,
    );
    Cartesian3.normalize(camera._directionWC, camera._directionWC);
  }

  if (upChanged || transformChanged) {
    camera._upWC = Matrix4.multiplyByPointAsVector(transform, up, camera._upWC);
    Cartesian3.normalize(camera._upWC, camera._upWC);
  }

  if (rightChanged || transformChanged) {
    camera._rightWC = Matrix4.multiplyByPointAsVector(
      transform,
      right,
      camera._rightWC,
    );
    Cartesian3.normalize(camera._rightWC, camera._rightWC);
  }

  if (
    positionChanged ||
    directionChanged ||
    upChanged ||
    rightChanged ||
    transformChanged
  ) {
    updateViewMatrix(camera);
  }
}

/**
 * @private
 */
export function getHeading(direction, up) {
  let heading;
  if (
    !CesiumMath.equalsEpsilon(Math.abs(direction.z), 1.0, CesiumMath.EPSILON3)
  ) {
    heading = Math.atan2(direction.y, direction.x) - CesiumMath.PI_OVER_TWO;
  } else {
    heading = Math.atan2(up.y, up.x) - CesiumMath.PI_OVER_TWO;
  }

  return CesiumMath.TWO_PI - CesiumMath.zeroToTwoPi(heading);
}

/**
 * @private
 */
export function getPitch(direction) {
  return CesiumMath.PI_OVER_TWO - CesiumMath.acosClamped(direction.z);
}

/**
 * @private
 */
export function getRoll(direction, up, right) {
  let roll = 0.0;
  if (
    !CesiumMath.equalsEpsilon(Math.abs(direction.z), 1.0, CesiumMath.EPSILON3)
  ) {
    roll = Math.atan2(-right.z, up.z);
    roll = CesiumMath.zeroToTwoPi(roll + CesiumMath.TWO_PI);
  }

  return roll;
}

/**
 * Clamps a 2D camera position to the map bounds.
 * @private
 */
export function clampMove2D(camera, position) {
  const rotatable2D = camera._scene.mapMode2D === MapMode2D.ROTATE;
  const maxProjectedX = camera._maxCoord.x;
  const maxProjectedY = camera._maxCoord.y;

  let minX;
  let maxX;
  if (rotatable2D) {
    maxX = maxProjectedX;
    minX = -maxX;
  } else {
    maxX = position.x - maxProjectedX * 2.0;
    minX = position.x + maxProjectedX * 2.0;
  }

  if (position.x > maxProjectedX) {
    position.x = maxX;
  }
  if (position.x < -maxProjectedX) {
    position.x = minX;
  }

  if (position.y > maxProjectedY) {
    position.y = maxProjectedY;
  }
  if (position.y < -maxProjectedY) {
    position.y = -maxProjectedY;
  }
}

/**
 * Zooms a 2D camera by adjusting the orthographic frustum.
 * @private
 */
export function zoom2D(camera, amount) {
  const frustum = camera.frustum;

  //>>includeStart('debug', pragmas.debug);
  if (
    !(frustum instanceof OrthographicOffCenterFrustum) ||
    !defined(frustum.left) ||
    !defined(frustum.right) ||
    !defined(frustum.bottom) ||
    !defined(frustum.top)
  ) {
    throw new DeveloperError(
      "The camera frustum is expected to be orthographic for 2D camera control.",
    );
  }
  //>>includeEnd('debug');

  let ratio;
  amount = amount * 0.5;

  if (
    Math.abs(frustum.top) + Math.abs(frustum.bottom) >
    Math.abs(frustum.left) + Math.abs(frustum.right)
  ) {
    let newTop = frustum.top - amount;
    let newBottom = frustum.bottom + amount;

    let maxBottom = camera._maxCoord.y;
    if (camera._scene.mapMode2D === MapMode2D.ROTATE) {
      maxBottom *= camera.maximumZoomFactor;
    }

    if (newBottom > maxBottom) {
      newBottom = maxBottom;
      newTop = -maxBottom;
    }

    if (newTop <= newBottom) {
      newTop = 1.0;
      newBottom = -1.0;
    }

    ratio = frustum.right / frustum.top;
    frustum.top = newTop;
    frustum.bottom = newBottom;
    frustum.right = frustum.top * ratio;
    frustum.left = -frustum.right;
  } else {
    let newRight = frustum.right - amount;
    let newLeft = frustum.left + amount;

    let maxRight = camera._maxCoord.x;
    if (camera._scene.mapMode2D === MapMode2D.ROTATE) {
      maxRight *= camera.maximumZoomFactor;
    }

    if (newRight > maxRight) {
      newRight = maxRight;
      newLeft = -maxRight;
    }

    if (newRight <= newLeft) {
      newRight = 1.0;
      newLeft = -1.0;
    }
    ratio = frustum.top / frustum.right;
    frustum.right = newRight;
    frustum.left = newLeft;
    frustum.top = frustum.right * ratio;
    frustum.bottom = -frustum.top;
  }
}

/**
 * @private
 */
export function zoom3D(camera, amount) {
  camera.move(camera.direction, amount);
}

const rotateVertScratchP = new Cartesian3();
const rotateVertScratchA = new Cartesian3();
const rotateVertScratchTan = new Cartesian3();
const rotateVertScratchNegate = new Cartesian3();

/**
 * Rotates the camera vertically, respecting constrainedAxis limits.
 * @private
 */
export function rotateVertical(camera, angle) {
  const position = camera.position;
  if (
    defined(camera.constrainedAxis) &&
    !Cartesian3.equalsEpsilon(
      camera.position,
      Cartesian3.ZERO,
      CesiumMath.EPSILON2,
    )
  ) {
    const p = Cartesian3.normalize(position, rotateVertScratchP);
    const northParallel = Cartesian3.equalsEpsilon(
      p,
      camera.constrainedAxis,
      CesiumMath.EPSILON2,
    );
    const southParallel = Cartesian3.equalsEpsilon(
      p,
      Cartesian3.negate(camera.constrainedAxis, rotateVertScratchNegate),
      CesiumMath.EPSILON2,
    );
    if (!northParallel && !southParallel) {
      const constrainedAxis = Cartesian3.normalize(
        camera.constrainedAxis,
        rotateVertScratchA,
      );

      let dot = Cartesian3.dot(p, constrainedAxis);
      let angleToAxis = CesiumMath.acosClamped(dot);
      if (angle > 0 && angle > angleToAxis) {
        angle = angleToAxis - CesiumMath.EPSILON4;
      }

      dot = Cartesian3.dot(
        p,
        Cartesian3.negate(constrainedAxis, rotateVertScratchNegate),
      );
      angleToAxis = CesiumMath.acosClamped(dot);
      if (angle < 0 && -angle > angleToAxis) {
        angle = -angleToAxis + CesiumMath.EPSILON4;
      }

      const tangent = Cartesian3.cross(
        constrainedAxis,
        p,
        rotateVertScratchTan,
      );
      camera.rotate(tangent, angle);
    } else if ((northParallel && angle < 0) || (southParallel && angle > 0)) {
      camera.rotate(camera.right, angle);
    }
  } else {
    camera.rotate(camera.right, angle);
  }
}

/**
 * @private
 */
export function rotateHorizontal(camera, angle) {
  if (defined(camera.constrainedAxis)) {
    camera.rotate(camera.constrainedAxis, angle);
  } else {
    camera.rotate(camera.up, angle);
  }
}

// Namespace default export for build system barrel compatibility
const CameraInternals = {
  updateViewMatrix,
  updateCameraDeltas,
  updateMembers,
  getHeading,
  getPitch,
  getRoll,
  clampMove2D,
  zoom2D,
  zoom3D,
  rotateVertical,
  rotateHorizontal,
};
export default CameraInternals;
