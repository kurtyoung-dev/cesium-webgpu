/**
 * Helper functions for Camera.js — view setup, rectangle positioning, pick ray,
 * ellipsoid picking, flight utilities, and view rectangle computation.
 *
 * Extracted from Camera.js to keep the main class under 1000 lines.
 * All functions take `camera` as the first parameter.
 *
 * @private
 */
import Cartesian2 from "../Core/Cartesian2.js";
import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import DeveloperError from "../Core/DeveloperError.js";
import EasingFunction from "../Core/EasingFunction.js";
import EllipsoidGeodesic from "../Core/EllipsoidGeodesic.js";
import HeadingPitchRange from "../Core/HeadingPitchRange.js";
import IntersectionTests from "../Core/IntersectionTests.js";
import CesiumMath from "../Core/Math.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import Quaternion from "../Core/Quaternion.js";
import Ray from "../Core/Ray.js";
import Rectangle from "../Core/Rectangle.js";
import Transforms from "../Core/Transforms.js";
import { getHeading, getPitch } from "./CameraInternals.js";
import MapMode2D from "./MapMode2D.js";
import SceneMode from "./SceneMode.js";

// ---- setView helpers ----

const scratchSetViewCartesian = new Cartesian3();
const scratchSetViewTransform1 = new Matrix4();
const scratchSetViewTransform2 = new Matrix4();
const scratchSetViewQuaternion = new Quaternion();
const scratchSetViewMatrix3 = new Matrix3();
const scratchSetViewCartographic = new Cartographic();

/**
 * @private
 */
export function setView3D(camera, position, hpr) {
  //>>includeStart('debug', pragmas.debug);
  if (isNaN(position.x) || isNaN(position.y) || isNaN(position.z)) {
    throw new DeveloperError("position has a NaN component");
  }
  //>>includeEnd('debug');
  const currentTransform = Matrix4.clone(
    camera.transform,
    scratchSetViewTransform1,
  );
  const localTransform = Transforms.eastNorthUpToFixedFrame(
    position,
    camera._projection.ellipsoid,
    scratchSetViewTransform2,
  );
  camera._setTransform(localTransform);

  Cartesian3.clone(Cartesian3.ZERO, camera.position);
  hpr.heading = hpr.heading - CesiumMath.PI_OVER_TWO;

  const rotQuat = Quaternion.fromHeadingPitchRoll(
    hpr,
    scratchSetViewQuaternion,
  );
  const rotMat = Matrix3.fromQuaternion(rotQuat, scratchSetViewMatrix3);

  Matrix3.getColumn(rotMat, 0, camera.direction);
  Matrix3.getColumn(rotMat, 2, camera.up);
  Cartesian3.cross(camera.direction, camera.up, camera.right);

  camera._setTransform(currentTransform);
  camera._adjustOrthographicFrustum(true);
}

/**
 * @private
 */
export function setViewCV(camera, position, hpr, convert) {
  const currentTransform = Matrix4.clone(
    camera.transform,
    scratchSetViewTransform1,
  );
  camera._setTransform(Matrix4.IDENTITY);

  if (!Cartesian3.equals(position, camera.positionWC)) {
    if (convert) {
      const projection = camera._projection;
      const cartographic = projection.ellipsoid.cartesianToCartographic(
        position,
        scratchSetViewCartographic,
      );
      position = projection.project(cartographic, scratchSetViewCartesian);
    }
    Cartesian3.clone(position, camera.position);
  }
  hpr.heading = hpr.heading - CesiumMath.PI_OVER_TWO;

  const rotQuat = Quaternion.fromHeadingPitchRoll(
    hpr,
    scratchSetViewQuaternion,
  );
  const rotMat = Matrix3.fromQuaternion(rotQuat, scratchSetViewMatrix3);

  Matrix3.getColumn(rotMat, 0, camera.direction);
  Matrix3.getColumn(rotMat, 2, camera.up);
  Cartesian3.cross(camera.direction, camera.up, camera.right);

  camera._setTransform(currentTransform);
  camera._adjustOrthographicFrustum(true);
}

/**
 * @private
 */
export function setView2D(camera, position, hpr, convert) {
  const currentTransform = Matrix4.clone(
    camera.transform,
    scratchSetViewTransform1,
  );
  camera._setTransform(Matrix4.IDENTITY);

  if (!Cartesian3.equals(position, camera.positionWC)) {
    if (convert) {
      const projection = camera._projection;
      const cartographic = projection.ellipsoid.cartesianToCartographic(
        position,
        scratchSetViewCartographic,
      );
      position = projection.project(cartographic, scratchSetViewCartesian);
    }

    Cartesian2.clone(position, camera.position);

    const newLeft = -position.z * 0.5;
    const newRight = -newLeft;

    const frustum = camera.frustum;
    if (newRight > newLeft) {
      const ratio = frustum.top / frustum.right;
      frustum.right = newRight;
      frustum.left = newLeft;
      frustum.top = frustum.right * ratio;
      frustum.bottom = -frustum.top;
    }
  }

  if (camera._scene.mapMode2D === MapMode2D.ROTATE) {
    hpr.heading = hpr.heading - CesiumMath.PI_OVER_TWO;
    hpr.pitch = -CesiumMath.PI_OVER_TWO;
    hpr.roll = 0.0;
    const rotQuat = Quaternion.fromHeadingPitchRoll(
      hpr,
      scratchSetViewQuaternion,
    );
    const rotMat = Matrix3.fromQuaternion(rotQuat, scratchSetViewMatrix3);

    Matrix3.getColumn(rotMat, 2, camera.up);
    Cartesian3.cross(camera.direction, camera.up, camera.right);
  }

  camera._setTransform(currentTransform);
}

const scratchToHPRDirection = new Cartesian3();
const scratchToHPRUp = new Cartesian3();
const scratchToHPRRight = new Cartesian3();
const scratchHPRMatrix1 = new Matrix4();
const scratchHPRMatrix2 = new Matrix4();

/**
 * @private
 */
export function directionUpToHeadingPitchRoll(
  camera,
  position,
  orientation,
  result,
) {
  const direction = Cartesian3.clone(
    orientation.direction,
    scratchToHPRDirection,
  );
  const up = Cartesian3.clone(orientation.up, scratchToHPRUp);

  if (camera._scene.mode === SceneMode.SCENE3D) {
    const ellipsoid = camera._projection.ellipsoid;
    const transform = Transforms.eastNorthUpToFixedFrame(
      position,
      ellipsoid,
      scratchHPRMatrix1,
    );
    const invTransform = Matrix4.inverseTransformation(
      transform,
      scratchHPRMatrix2,
    );

    Matrix4.multiplyByPointAsVector(invTransform, direction, direction);
    Matrix4.multiplyByPointAsVector(invTransform, up, up);
  }

  const right = Cartesian3.cross(direction, up, scratchToHPRRight);

  result.pitch = getPitch(direction);

  // setView3D rebuilds the basis from this triple as
  //   direction = (cos(pitch)sin(heading), cos(pitch)cos(heading), sin(pitch))
  // with the roll appearing as the tilt of `right` out of the local horizontal,
  // so taking the azimuth from `direction` and the roll from `right` inverts
  // that for every orientation which still has a horizontal direction component.
  // The camera's own heading getter cannot work this way - a straight-down view
  // has no usable horizontal component - so it reads the azimuth off `up`
  // throughout a wide band around the local vertical, which drops the roll and,
  // for a view pointed above the horizon, names an azimuth half a turn from the
  // one asked for. An explicit direction has to survive the round trip, so
  // invert the rebuild directly rather than reusing the getters.
  // The roll below divides `up` by a quantity of the order of the zenith angle,
  // and a caller's near-vertical `up` carries absolute error around 1e-8, so
  // the threshold must keep the horizontal component well above that noise:
  // 1e-12 on the squared magnitude admits directions from a microradian off the
  // vertical, where the roll is stable, and leaves only the vertical itself to
  // the fallback.
  const horizontalMagnitudeSquared =
    direction.x * direction.x + direction.y * direction.y;
  if (horizontalMagnitudeSquared > CesiumMath.EPSILON12) {
    result.heading =
      CesiumMath.TWO_PI -
      CesiumMath.zeroToTwoPi(
        Math.atan2(direction.y, direction.x) - CesiumMath.PI_OVER_TWO,
      );
    result.roll = CesiumMath.zeroToTwoPi(
      Math.atan2(-right.z, up.z) + CesiumMath.TWO_PI,
    );
  } else {
    // Along the local vertical the azimuth survives only in `up`, and heading
    // and roll become the same rotation, so all of it goes into heading. Which
    // azimuth `up` stands for flips with the hemisphere the view points into.
    result.heading = getHeading(direction, up);
    result.roll = 0.0;
    if (direction.z > 0.0) {
      result.heading = CesiumMath.zeroToTwoPi(result.heading + CesiumMath.PI);
    }
  }

  return result;
}

// ---- Orthographic frustum width ----

const scratchAdjustOrthographicFrustumMousePosition = new Cartesian2();
const scratchPickRay = new Ray();
const scratchRayIntersection = new Cartesian3();
const scratchDepthIntersection = new Cartesian3();

/**
 * @private
 */
export function calculateOrthographicFrustumWidth(camera) {
  if (!Matrix4.equals(Matrix4.IDENTITY, camera.transform)) {
    return Cartesian3.magnitude(camera.position);
  }

  const scene = camera._scene;
  const globe = scene.globe;

  const mousePosition = scratchAdjustOrthographicFrustumMousePosition;
  mousePosition.x = scene.drawingBufferWidth / scene.pixelRatio / 2.0;
  mousePosition.y = scene.drawingBufferHeight / scene.pixelRatio / 2.0;

  let rayIntersection;
  if (defined(globe)) {
    const ray = camera.getPickRay(mousePosition, scratchPickRay);
    rayIntersection = globe.pickWorldCoordinates(
      ray,
      scene,
      true,
      scratchRayIntersection,
    );
  }

  let depthIntersection;
  if (scene.pickPositionSupported) {
    depthIntersection = scene.pickPositionWorldCoordinates(
      mousePosition,
      scratchDepthIntersection,
    );
  }

  let distance;
  if (defined(rayIntersection) || defined(depthIntersection)) {
    const depthDistance = defined(depthIntersection)
      ? Cartesian3.distance(depthIntersection, camera.positionWC)
      : Number.POSITIVE_INFINITY;
    const rayDistance = defined(rayIntersection)
      ? Cartesian3.distance(rayIntersection, camera.positionWC)
      : Number.POSITIVE_INFINITY;
    distance = Math.min(depthDistance, rayDistance);
  } else {
    distance = Math.max(camera.positionCartographic.height, 0.0);
  }
  return distance;
}

// ---- Rectangle camera position helpers ----

const viewRectangle3DCartographic1 = new Cartographic();
const viewRectangle3DCartographic2 = new Cartographic();
const viewRectangle3DNorthEast = new Cartesian3();
const viewRectangle3DSouthWest = new Cartesian3();
const viewRectangle3DNorthWest = new Cartesian3();
const viewRectangle3DSouthEast = new Cartesian3();
const viewRectangle3DNorthCenter = new Cartesian3();
const viewRectangle3DSouthCenter = new Cartesian3();
const viewRectangle3DCenter = new Cartesian3();
const viewRectangle3DEquator = new Cartesian3();
const defaultRF = {
  direction: new Cartesian3(),
  right: new Cartesian3(),
  up: new Cartesian3(),
};
let viewRectangle3DEllipsoidGeodesic;

function computeD(direction, upOrRight, corner, tanThetaOrPhi) {
  const opposite = Math.abs(Cartesian3.dot(upOrRight, corner));
  return opposite / tanThetaOrPhi - Cartesian3.dot(direction, corner);
}

/**
 * @private
 */
export function rectangleCameraPosition3D(
  camera,
  rectangle,
  result,
  updateCamera,
) {
  const ellipsoid = camera._projection.ellipsoid;
  const cameraRF = updateCamera ? camera : defaultRF;

  const { north, south, west } = rectangle;
  let { east } = rectangle;

  if (west > east) {
    east += CesiumMath.TWO_PI;
  }

  const longitude = (west + east) * 0.5;
  let latitude;
  if (
    south < -CesiumMath.PI_OVER_TWO + CesiumMath.RADIANS_PER_DEGREE &&
    north > CesiumMath.PI_OVER_TWO - CesiumMath.RADIANS_PER_DEGREE
  ) {
    latitude = 0.0;
  } else {
    const northCartographic = viewRectangle3DCartographic1;
    northCartographic.longitude = longitude;
    northCartographic.latitude = north;
    northCartographic.height = 0.0;

    const southCartographic = viewRectangle3DCartographic2;
    southCartographic.longitude = longitude;
    southCartographic.latitude = south;
    southCartographic.height = 0.0;

    let ellipsoidGeodesic = viewRectangle3DEllipsoidGeodesic;
    if (
      !defined(ellipsoidGeodesic) ||
      ellipsoidGeodesic.ellipsoid !== ellipsoid
    ) {
      viewRectangle3DEllipsoidGeodesic = ellipsoidGeodesic =
        new EllipsoidGeodesic(undefined, undefined, ellipsoid);
    }

    ellipsoidGeodesic.setEndPoints(northCartographic, southCartographic);
    latitude = ellipsoidGeodesic.interpolateUsingFraction(
      0.5,
      viewRectangle3DCartographic1,
    ).latitude;
  }

  const centerCartographic = viewRectangle3DCartographic1;
  centerCartographic.longitude = longitude;
  centerCartographic.latitude = latitude;
  centerCartographic.height = 0.0;

  const center = ellipsoid.cartographicToCartesian(
    centerCartographic,
    viewRectangle3DCenter,
  );

  const cart = viewRectangle3DCartographic1;
  cart.longitude = east;
  cart.latitude = north;
  const northEast = ellipsoid.cartographicToCartesian(
    cart,
    viewRectangle3DNorthEast,
  );
  cart.longitude = west;
  const northWest = ellipsoid.cartographicToCartesian(
    cart,
    viewRectangle3DNorthWest,
  );
  cart.longitude = longitude;
  const northCenter = ellipsoid.cartographicToCartesian(
    cart,
    viewRectangle3DNorthCenter,
  );
  cart.latitude = south;
  const southCenter = ellipsoid.cartographicToCartesian(
    cart,
    viewRectangle3DSouthCenter,
  );
  cart.longitude = east;
  const southEast = ellipsoid.cartographicToCartesian(
    cart,
    viewRectangle3DSouthEast,
  );
  cart.longitude = west;
  const southWest = ellipsoid.cartographicToCartesian(
    cart,
    viewRectangle3DSouthWest,
  );

  Cartesian3.subtract(northWest, center, northWest);
  Cartesian3.subtract(southEast, center, southEast);
  Cartesian3.subtract(northEast, center, northEast);
  Cartesian3.subtract(southWest, center, southWest);
  Cartesian3.subtract(northCenter, center, northCenter);
  Cartesian3.subtract(southCenter, center, southCenter);

  const direction = ellipsoid.geodeticSurfaceNormal(center, cameraRF.direction);
  Cartesian3.negate(direction, direction);
  const right = Cartesian3.cross(direction, Cartesian3.UNIT_Z, cameraRF.right);
  Cartesian3.normalize(right, right);
  const up = Cartesian3.cross(right, direction, cameraRF.up);

  let d;
  if (camera.frustum instanceof OrthographicFrustum) {
    const width = Math.max(
      Cartesian3.distance(northEast, northWest),
      Cartesian3.distance(southEast, southWest),
    );
    const height = Math.max(
      Cartesian3.distance(northEast, southEast),
      Cartesian3.distance(northWest, southWest),
    );

    let rightScalar;
    let topScalar;
    const offCenterFrustum = camera.frustum._offCenterFrustum;
    const ratio = offCenterFrustum.right / offCenterFrustum.top;
    const heightRatio = height * ratio;
    if (width > heightRatio) {
      rightScalar = width;
      topScalar = rightScalar / ratio;
    } else {
      topScalar = height;
      rightScalar = heightRatio;
    }

    d = Math.max(rightScalar, topScalar);
  } else {
    const tanPhi = Math.tan(camera.frustum.fovy * 0.5);
    const tanTheta = camera.frustum.aspectRatio * tanPhi;

    d = Math.max(
      computeD(direction, up, northWest, tanPhi),
      computeD(direction, up, southEast, tanPhi),
      computeD(direction, up, northEast, tanPhi),
      computeD(direction, up, southWest, tanPhi),
      computeD(direction, up, northCenter, tanPhi),
      computeD(direction, up, southCenter, tanPhi),
      computeD(direction, right, northWest, tanTheta),
      computeD(direction, right, southEast, tanTheta),
      computeD(direction, right, northEast, tanTheta),
      computeD(direction, right, southWest, tanTheta),
      computeD(direction, right, northCenter, tanTheta),
      computeD(direction, right, southCenter, tanTheta),
    );

    if (south < 0 && north > 0) {
      const equatorCartographic = viewRectangle3DCartographic1;
      equatorCartographic.longitude = west;
      equatorCartographic.latitude = 0.0;
      equatorCartographic.height = 0.0;
      let equatorPosition = ellipsoid.cartographicToCartesian(
        equatorCartographic,
        viewRectangle3DEquator,
      );
      Cartesian3.subtract(equatorPosition, center, equatorPosition);
      d = Math.max(
        d,
        computeD(direction, up, equatorPosition, tanPhi),
        computeD(direction, right, equatorPosition, tanTheta),
      );

      equatorCartographic.longitude = east;
      equatorPosition = ellipsoid.cartographicToCartesian(
        equatorCartographic,
        viewRectangle3DEquator,
      );
      Cartesian3.subtract(equatorPosition, center, equatorPosition);
      d = Math.max(
        d,
        computeD(direction, up, equatorPosition, tanPhi),
        computeD(direction, right, equatorPosition, tanTheta),
      );
    }
  }

  return Cartesian3.add(
    center,
    Cartesian3.multiplyByScalar(direction, -d, viewRectangle3DEquator),
    result,
  );
}

const viewRectangleCVCartographic = new Cartographic();
const viewRectangleCVNorthEast = new Cartesian3();
const viewRectangleCVSouthWest = new Cartesian3();

/**
 * @private
 */
export function rectangleCameraPositionColumbusView(camera, rectangle, result) {
  const projection = camera._projection;
  if (rectangle.west > rectangle.east) {
    rectangle = Rectangle.MAX_VALUE;
  }
  const transform = camera._actualTransform;
  const invTransform = camera._actualInvTransform;

  const cart = viewRectangleCVCartographic;
  cart.longitude = rectangle.east;
  cart.latitude = rectangle.north;
  const northEast = projection.project(cart, viewRectangleCVNorthEast);
  Matrix4.multiplyByPoint(transform, northEast, northEast);
  Matrix4.multiplyByPoint(invTransform, northEast, northEast);

  cart.longitude = rectangle.west;
  cart.latitude = rectangle.south;
  const southWest = projection.project(cart, viewRectangleCVSouthWest);
  Matrix4.multiplyByPoint(transform, southWest, southWest);
  Matrix4.multiplyByPoint(invTransform, southWest, southWest);

  result.x = (northEast.x - southWest.x) * 0.5 + southWest.x;
  result.y = (northEast.y - southWest.y) * 0.5 + southWest.y;

  if (defined(camera.frustum.fovy)) {
    const tanPhi = Math.tan(camera.frustum.fovy * 0.5);
    const tanTheta = camera.frustum.aspectRatio * tanPhi;
    result.z =
      Math.max(
        (northEast.x - southWest.x) / tanTheta,
        (northEast.y - southWest.y) / tanPhi,
      ) * 0.5;
  } else {
    const width = northEast.x - southWest.x;
    const height = northEast.y - southWest.y;
    result.z = Math.max(width, height);
  }

  return result;
}

const viewRectangle2DCartographic = new Cartographic();
const viewRectangle2DNorthEast = new Cartesian3();
const viewRectangle2DSouthWest = new Cartesian3();

/**
 * @private
 */
export function rectangleCameraPosition2D(camera, rectangle, result) {
  const projection = camera._projection;

  let east = rectangle.east;
  if (rectangle.west > rectangle.east) {
    if (camera._scene.mapMode2D === MapMode2D.INFINITE_SCROLL) {
      east += CesiumMath.TWO_PI;
    } else {
      rectangle = Rectangle.MAX_VALUE;
      east = rectangle.east;
    }
  }

  let cart = viewRectangle2DCartographic;
  cart.longitude = east;
  cart.latitude = rectangle.north;
  const northEast = projection.project(cart, viewRectangle2DNorthEast);
  cart.longitude = rectangle.west;
  cart.latitude = rectangle.south;
  const southWest = projection.project(cart, viewRectangle2DSouthWest);

  const width = Math.abs(northEast.x - southWest.x) * 0.5;
  let height = Math.abs(northEast.y - southWest.y) * 0.5;

  let right, top;
  const ratio = camera.frustum.right / camera.frustum.top;
  const heightRatio = height * ratio;
  if (width > heightRatio) {
    right = width;
    top = right / ratio;
  } else {
    top = height;
    right = heightRatio;
  }

  height = Math.max(2.0 * right, 2.0 * top);

  result.x = (northEast.x - southWest.x) * 0.5 + southWest.x;
  result.y = (northEast.y - southWest.y) * 0.5 + southWest.y;

  cart = projection.unproject(result, cart);
  cart.height = height;
  result = projection.project(cart, result);

  return result;
}

// ---- Pick ellipsoid helpers ----

const pickEllipsoid3DRay = new Ray();

/**
 * @private
 */
export function pickEllipsoid3D(camera, windowPosition, ellipsoid, result) {
  const ray = camera.getPickRay(windowPosition, pickEllipsoid3DRay);
  const intersection = IntersectionTests.rayEllipsoid(ray, ellipsoid);
  if (!intersection) {
    return undefined;
  }

  const t = intersection.start > 0.0 ? intersection.start : intersection.stop;
  return Ray.getPoint(ray, t, result);
}

const pickEllipsoid2DRay = new Ray();

/**
 * @private
 */
export function pickMap2D(camera, windowPosition, projection, result) {
  const ray = camera.getPickRay(windowPosition, pickEllipsoid2DRay);
  let position = ray.origin;
  position = Cartesian3.fromElements(position.y, position.z, 0.0, position);
  const cart = projection.unproject(position);

  if (
    cart.latitude < -CesiumMath.PI_OVER_TWO ||
    cart.latitude > CesiumMath.PI_OVER_TWO
  ) {
    return undefined;
  }

  return projection.ellipsoid.cartographicToCartesian(cart, result);
}

const pickEllipsoidCVRay = new Ray();

/**
 * @private
 */
export function pickMapColumbusView(
  camera,
  windowPosition,
  projection,
  result,
) {
  const ray = camera.getPickRay(windowPosition, pickEllipsoidCVRay);
  const scalar = -ray.origin.x / ray.direction.x;
  Ray.getPoint(ray, scalar, result);

  const cart = projection.unproject(new Cartesian3(result.y, result.z, 0.0));

  if (
    cart.latitude < -CesiumMath.PI_OVER_TWO ||
    cart.latitude > CesiumMath.PI_OVER_TWO ||
    cart.longitude < -Math.PI ||
    cart.longitude > Math.PI
  ) {
    return undefined;
  }

  return projection.ellipsoid.cartographicToCartesian(cart, result);
}

// ---- getPickRay helpers ----

const pickPerspCenter = new Cartesian3();
const pickPerspXDir = new Cartesian3();
const pickPerspYDir = new Cartesian3();

/**
 * @private
 */
export function getPickRayPerspective(camera, windowPosition, result) {
  const canvas = camera._scene.canvas;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  const tanPhi = Math.tan(camera.frustum.fovy * 0.5);
  const tanTheta = camera.frustum.aspectRatio * tanPhi;
  const near = camera.frustum.near;

  const x = (2.0 / width) * windowPosition.x - 1.0;
  const y = (2.0 / height) * (height - windowPosition.y) - 1.0;

  const position = camera.positionWC;
  Cartesian3.clone(position, result.origin);

  const nearCenter = Cartesian3.multiplyByScalar(
    camera.directionWC,
    near,
    pickPerspCenter,
  );
  Cartesian3.add(position, nearCenter, nearCenter);
  const xDir = Cartesian3.multiplyByScalar(
    camera.rightWC,
    x * near * tanTheta,
    pickPerspXDir,
  );
  const yDir = Cartesian3.multiplyByScalar(
    camera.upWC,
    y * near * tanPhi,
    pickPerspYDir,
  );
  const direction = Cartesian3.add(nearCenter, xDir, result.direction);
  Cartesian3.add(direction, yDir, direction);
  Cartesian3.subtract(direction, position, direction);
  Cartesian3.normalize(direction, direction);

  return result;
}

const scratchDirection = new Cartesian3();

/**
 * @private
 */
export function getPickRayOrthographic(camera, windowPosition, result) {
  const canvas = camera._scene.canvas;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;

  let frustum = camera.frustum;
  const offCenterFrustum = frustum.offCenterFrustum;
  if (defined(offCenterFrustum)) {
    frustum = offCenterFrustum;
  }
  let x = (2.0 / width) * windowPosition.x - 1.0;
  x *= (frustum.right - frustum.left) * 0.5;
  let y = (2.0 / height) * (height - windowPosition.y) - 1.0;
  y *= (frustum.top - frustum.bottom) * 0.5;

  const origin = result.origin;
  Cartesian3.clone(camera.positionWC, origin);

  Cartesian3.multiplyByScalar(camera.rightWC, x, scratchDirection);
  Cartesian3.add(scratchDirection, origin, origin);
  Cartesian3.multiplyByScalar(camera.upWC, y, scratchDirection);
  Cartesian3.add(scratchDirection, origin, origin);

  Cartesian3.clone(camera.directionWC, result.direction);

  if (
    camera._mode === SceneMode.SCENE2D &&
    camera._scene.mapMode2D === MapMode2D.INFINITE_SCROLL
  ) {
    const maxHorizontal = camera._maxCoord.x;
    origin.y =
      CesiumMath.mod(origin.y + maxHorizontal, 2.0 * maxHorizontal) -
      maxHorizontal;
  }

  return result;
}

// ---- computeViewRectangle helpers ----

const scratchCartesian3_1 = new Cartesian3();
const scratchCartesian3_2 = new Cartesian3();
const scratchCartesian3_3 = new Cartesian3();
const scratchCartesian3_4 = new Cartesian3();
const horizonPoints = [
  new Cartesian3(),
  new Cartesian3(),
  new Cartesian3(),
  new Cartesian3(),
];

/**
 * @private
 */
export function computeHorizonQuad(camera, ellipsoid) {
  const radii = ellipsoid.radii;
  const p = camera.positionWC;

  const q = Cartesian3.multiplyComponents(
    ellipsoid.oneOverRadii,
    p,
    scratchCartesian3_1,
  );

  const qMagnitude = Cartesian3.magnitude(q);
  const qUnit = Cartesian3.normalize(q, scratchCartesian3_2);

  let eUnit;
  let nUnit;
  if (
    Cartesian3.equalsEpsilon(qUnit, Cartesian3.UNIT_Z, CesiumMath.EPSILON10)
  ) {
    eUnit = new Cartesian3(0, 1, 0);
    nUnit = new Cartesian3(0, 0, 1);
  } else {
    eUnit = Cartesian3.normalize(
      Cartesian3.cross(Cartesian3.UNIT_Z, qUnit, scratchCartesian3_3),
      scratchCartesian3_3,
    );
    nUnit = Cartesian3.normalize(
      Cartesian3.cross(qUnit, eUnit, scratchCartesian3_4),
      scratchCartesian3_4,
    );
  }

  const wMagnitude = Math.sqrt(Cartesian3.magnitudeSquared(q) - 1.0);

  const center = Cartesian3.multiplyByScalar(
    qUnit,
    1.0 / qMagnitude,
    scratchCartesian3_1,
  );
  const scalar = wMagnitude / qMagnitude;
  const eastOffset = Cartesian3.multiplyByScalar(
    eUnit,
    scalar,
    scratchCartesian3_2,
  );
  const northOffset = Cartesian3.multiplyByScalar(
    nUnit,
    scalar,
    scratchCartesian3_3,
  );

  const upperLeft = Cartesian3.add(center, northOffset, horizonPoints[0]);
  Cartesian3.subtract(upperLeft, eastOffset, upperLeft);
  Cartesian3.multiplyComponents(radii, upperLeft, upperLeft);

  const lowerLeft = Cartesian3.subtract(center, northOffset, horizonPoints[1]);
  Cartesian3.subtract(lowerLeft, eastOffset, lowerLeft);
  Cartesian3.multiplyComponents(radii, lowerLeft, lowerLeft);

  const lowerRight = Cartesian3.subtract(center, northOffset, horizonPoints[2]);
  Cartesian3.add(lowerRight, eastOffset, lowerRight);
  Cartesian3.multiplyComponents(radii, lowerRight, lowerRight);

  const upperRight = Cartesian3.add(center, northOffset, horizonPoints[3]);
  Cartesian3.add(upperRight, eastOffset, upperRight);
  Cartesian3.multiplyComponents(radii, upperRight, upperRight);

  return horizonPoints;
}

const scratchPickCartesian2 = new Cartesian2();
const scratchRectCartesian = new Cartesian3();
const cartoArray = [
  new Cartographic(),
  new Cartographic(),
  new Cartographic(),
  new Cartographic(),
];

/**
 * @private
 */
export function addToResult(
  x,
  y,
  index,
  camera,
  ellipsoid,
  computedHorizonQuad,
) {
  scratchPickCartesian2.x = x;
  scratchPickCartesian2.y = y;
  const r = camera.pickEllipsoid(
    scratchPickCartesian2,
    ellipsoid,
    scratchRectCartesian,
  );
  if (defined(r)) {
    cartoArray[index] = ellipsoid.cartesianToCartographic(r, cartoArray[index]);
    return 1;
  }
  cartoArray[index] = ellipsoid.cartesianToCartographic(
    computedHorizonQuad[index],
    cartoArray[index],
  );
  return 0;
}

/**
 * Access to the shared cartoArray used by addToResult.
 * @private
 */
export { cartoArray };

// ---- Flight helpers ----

const scratchLookAtHeadingPitchRangeQuaternion1 = new Quaternion();
const scratchLookAtHeadingPitchRangeQuaternion2 = new Quaternion();
const scratchHeadingPitchRangeMatrix3 = new Matrix3();

/**
 * @private
 */
export function offsetFromHeadingPitchRange(heading, pitch, range, result) {
  pitch = CesiumMath.clamp(
    pitch,
    -CesiumMath.PI_OVER_TWO,
    CesiumMath.PI_OVER_TWO,
  );
  heading = CesiumMath.zeroToTwoPi(heading) - CesiumMath.PI_OVER_TWO;

  const pitchQuat = Quaternion.fromAxisAngle(
    Cartesian3.UNIT_Y,
    -pitch,
    scratchLookAtHeadingPitchRangeQuaternion1,
  );
  const headingQuat = Quaternion.fromAxisAngle(
    Cartesian3.UNIT_Z,
    -heading,
    scratchLookAtHeadingPitchRangeQuaternion2,
  );
  const rotQuat = Quaternion.multiply(headingQuat, pitchQuat, headingQuat);
  const rotMatrix = Matrix3.fromQuaternion(
    rotQuat,
    scratchHeadingPitchRangeMatrix3,
  );

  const offset = Cartesian3.clone(Cartesian3.UNIT_X, result);
  Matrix3.multiplyByVector(rotMatrix, offset, offset);
  Cartesian3.negate(offset, offset);
  Cartesian3.multiplyByScalar(offset, range, offset);
  return offset;
}

/**
 * @private
 */
export function distanceToBoundingSphere3D(camera, radius) {
  const frustum = camera.frustum;
  const tanPhi = Math.tan(frustum.fovy * 0.5);
  const tanTheta = frustum.aspectRatio * tanPhi;
  return Math.max(radius / tanTheta, radius / tanPhi);
}

/**
 * @private
 */
export function distanceToBoundingSphere2D(camera, radius) {
  let frustum = camera.frustum;
  const offCenterFrustum = frustum.offCenterFrustum;
  if (defined(offCenterFrustum)) {
    frustum = offCenterFrustum;
  }

  let right, top;
  const ratio = frustum.right / frustum.top;
  const heightRatio = radius * ratio;
  if (radius > heightRatio) {
    right = radius;
    top = right / ratio;
  } else {
    top = radius;
    right = heightRatio;
  }

  return Math.max(right, top) * 1.5;
}

const MINIMUM_ZOOM = 100.0;

/**
 * @private
 */
export function adjustBoundingSphereOffset(camera, boundingSphere, offset) {
  offset = HeadingPitchRange.clone(
    defined(offset) ? offset : camera.constructor.DEFAULT_OFFSET,
  );

  const minimumZoom =
    camera._scene.screenSpaceCameraController.minimumZoomDistance;
  const maximumZoom =
    camera._scene.screenSpaceCameraController.maximumZoomDistance;
  const range = offset.range;
  if (!defined(range) || range === 0.0) {
    const radius = boundingSphere.radius;
    if (radius === 0.0) {
      offset.range = MINIMUM_ZOOM;
    } else if (
      camera.frustum instanceof OrthographicFrustum ||
      camera._mode === SceneMode.SCENE2D
    ) {
      offset.range = distanceToBoundingSphere2D(camera, radius);
    } else {
      offset.range = distanceToBoundingSphere3D(camera, radius);
    }
    offset.range = CesiumMath.clamp(offset.range, minimumZoom, maximumZoom);
  }

  return offset;
}

const normalScratch = new Cartesian3();
const centerScratch = new Cartesian3();
const posScratch = new Cartesian3();
const scratchCartesian3Subtract = new Cartesian3();

function createAnimationTemplateCV(
  camera,
  position,
  center,
  maxX,
  maxY,
  duration,
) {
  const newPosition = Cartesian3.clone(position);

  if (center.y > maxX) {
    newPosition.y -= center.y - maxX;
  } else if (center.y < -maxX) {
    newPosition.y += -maxX - center.y;
  }

  if (center.z > maxY) {
    newPosition.z -= center.z - maxY;
  } else if (center.z < -maxY) {
    newPosition.z += -maxY - center.z;
  }

  function updateCV(value) {
    const interp = Cartesian3.lerp(
      position,
      newPosition,
      value.time,
      new Cartesian3(),
    );
    camera.worldToCameraCoordinatesPoint(interp, camera.position);
  }
  return {
    easingFunction: EasingFunction.EXPONENTIAL_OUT,
    startObject: {
      time: 0.0,
    },
    stopObject: {
      time: 1.0,
    },
    duration: duration,
    update: updateCV,
  };
}

/**
 * @private
 */
export function createAnimationCV(camera, duration) {
  let position = camera.position;
  const direction = camera.direction;

  const normal = camera.worldToCameraCoordinatesVector(
    Cartesian3.UNIT_X,
    normalScratch,
  );
  const scalar =
    -Cartesian3.dot(normal, position) / Cartesian3.dot(normal, direction);
  const center = Cartesian3.add(
    position,
    Cartesian3.multiplyByScalar(direction, scalar, centerScratch),
    centerScratch,
  );
  camera.cameraToWorldCoordinatesPoint(center, center);

  position = camera.cameraToWorldCoordinatesPoint(camera.position, posScratch);

  const tanPhi = Math.tan(camera.frustum.fovy * 0.5);
  const tanTheta = camera.frustum.aspectRatio * tanPhi;
  const distToC = Cartesian3.magnitude(
    Cartesian3.subtract(position, center, scratchCartesian3Subtract),
  );
  const dWidth = tanTheta * distToC;
  const dHeight = tanPhi * distToC;

  const mapWidth = camera._maxCoord.x;
  const mapHeight = camera._maxCoord.y;

  const maxX = Math.max(dWidth - mapWidth, mapWidth);
  const maxY = Math.max(dHeight - mapHeight, mapHeight);

  if (
    position.z < -maxX ||
    position.z > maxX ||
    position.y < -maxY ||
    position.y > maxY
  ) {
    const translateX = center.y < -maxX || center.y > maxX;
    const translateY = center.z < -maxY || center.z > maxY;
    if (translateX || translateY) {
      return createAnimationTemplateCV(
        camera,
        position,
        center,
        maxX,
        maxY,
        duration,
      );
    }
  }

  return undefined;
}

// Namespace default export for build system barrel compatibility
const CameraHelpers = {
  setView3D,
  setViewCV,
  setView2D,
  directionUpToHeadingPitchRoll,
  calculateOrthographicFrustumWidth,
  rectangleCameraPosition3D,
  rectangleCameraPositionColumbusView,
  rectangleCameraPosition2D,
  pickEllipsoid3D,
  pickMap2D,
  pickMapColumbusView,
  getPickRayPerspective,
  getPickRayOrthographic,
  computeHorizonQuad,
  addToResult,
  offsetFromHeadingPitchRange,
  distanceToBoundingSphere3D,
  distanceToBoundingSphere2D,
  adjustBoundingSphereOffset,
  createAnimationCV,
  cartoArray,
};
export default CameraHelpers;
