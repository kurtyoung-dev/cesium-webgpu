import Cartesian3 from "../Core/Cartesian3.js";
import Cartographic from "../Core/Cartographic.js";
import defined from "../Core/defined.js";
import CesiumMath from "../Core/Math.js";
import Matrix3 from "../Core/Matrix3.js";
import Matrix4 from "../Core/Matrix4.js";
import EncodedCartesian3 from "../Core/EncodedCartesian3.js";
import Simon1994PlanetaryPositions from "../Core/Simon1994PlanetaryPositions.js";
import Transforms from "../Core/Transforms.js";
import SceneMode from "../Scene/SceneMode.js";

/**
 * Lazy-computation and setup helpers for UniformState.
 *
 * These functions implement the dirty-flag pattern: each derived uniform
 * (modelView, inverseProjection, normal, etc.) is recomputed only when its
 * inputs have changed. Extracted from UniformState.js to keep the main
 * class under 1000 lines.
 *
 * @private
 */

// --- Setter helpers (mark dirty flags when inputs change) ---

function setView(uniformState, matrix) {
  Matrix4.clone(matrix, uniformState._view);
  Matrix4.getMatrix3(matrix, uniformState._viewRotation);

  uniformState._view3DDirty = true;
  uniformState._inverseView3DDirty = true;
  uniformState._modelViewDirty = true;
  uniformState._modelView3DDirty = true;
  uniformState._modelViewRelativeToEyeDirty = true;
  uniformState._inverseModelViewDirty = true;
  uniformState._inverseModelView3DDirty = true;
  uniformState._viewProjectionDirty = true;
  uniformState._viewProjectionRelativeToEyeDirty = true;
  uniformState._inverseViewProjectionDirty = true;
  uniformState._modelViewProjectionDirty = true;
  uniformState._modelViewProjectionRelativeToEyeDirty = true;
  uniformState._modelViewInfiniteProjectionDirty = true;
  uniformState._normalDirty = true;
  uniformState._inverseNormalDirty = true;
  uniformState._normal3DDirty = true;
  uniformState._inverseNormal3DDirty = true;
}

function setInverseView(uniformState, matrix) {
  Matrix4.clone(matrix, uniformState._inverseView);
  Matrix4.getMatrix3(matrix, uniformState._inverseViewRotation);
}

function setProjection(uniformState, matrix) {
  Matrix4.clone(matrix, uniformState._projection);

  uniformState._inverseProjectionDirty = true;
  uniformState._viewProjectionDirty = true;
  uniformState._viewProjectionRelativeToEyeDirty = true;
  uniformState._inverseViewProjectionDirty = true;
  uniformState._modelViewProjectionDirty = true;
  uniformState._modelViewProjectionRelativeToEyeDirty = true;
}

function setInfiniteProjection(uniformState, matrix) {
  Matrix4.clone(matrix, uniformState._infiniteProjection);
  uniformState._modelViewInfiniteProjectionDirty = true;
}

// --- Camera setup ---

const surfacePositionScratch = new Cartesian3();
const enuTransformScratch = new Matrix4();
const enuRotationScratch = new Matrix3();

function setCamera(uniformState, camera) {
  Cartesian3.clone(camera.positionWC, uniformState._cameraPosition);
  Cartesian3.clone(camera.directionWC, uniformState._cameraDirection);
  Cartesian3.clone(camera.rightWC, uniformState._cameraRight);
  Cartesian3.clone(camera.upWC, uniformState._cameraUp);

  const ellipsoid = uniformState._ellipsoid;
  let surfacePosition;

  const positionCartographic = camera.positionCartographic;
  if (!defined(positionCartographic)) {
    uniformState._eyeHeight = -ellipsoid.maximumRadius;
    if (Cartesian3.magnitude(camera.positionWC) > 0.0) {
      uniformState._eyeEllipsoidNormalEC = Cartesian3.normalize(
        camera.positionWC,
        uniformState._eyeEllipsoidNormalEC,
      );
    }
    surfacePosition = ellipsoid.scaleToGeodeticSurface(
      camera.positionWC,
      surfacePositionScratch,
    );
  } else {
    uniformState._eyeHeight = positionCartographic.height;
    uniformState._eyeCartographic = Cartesian3.fromElements(
      positionCartographic.longitude,
      positionCartographic.latitude,
      positionCartographic.height,
      uniformState._eyeCartographic,
    );
    uniformState._eyeEllipsoidNormalEC =
      ellipsoid.geodeticSurfaceNormalCartographic(
        positionCartographic,
        uniformState._eyeEllipsoidNormalEC,
      );
    surfacePosition = Cartesian3.fromRadians(
      positionCartographic.longitude,
      positionCartographic.latitude,
      0.0,
      ellipsoid,
      surfacePositionScratch,
    );
  }

  uniformState._encodedCameraPositionMCDirty = true;

  if (!defined(surfacePosition)) {
    return;
  }

  uniformState._eyeEllipsoidNormalEC = Matrix3.multiplyByVector(
    uniformState._viewRotation,
    uniformState._eyeEllipsoidNormalEC,
    uniformState._eyeEllipsoidNormalEC,
  );

  const enuToWorld = Transforms.eastNorthUpToFixedFrame(
    surfacePosition,
    ellipsoid,
    enuTransformScratch,
  );
  uniformState._enuToModel = Matrix4.multiplyTransformation(
    uniformState.inverseModel,
    enuToWorld,
    uniformState._enuToModel,
  );
  uniformState._modelToEnu = Matrix4.inverseTransformation(
    uniformState._enuToModel,
    uniformState._modelToEnu,
  );

  const enuToWorldRotation = Matrix4.getRotation(
    enuToWorld,
    enuRotationScratch,
  );
  const enuToView = Matrix3.multiply(
    uniformState._viewRotation,
    enuToWorldRotation,
    enuRotationScratch,
  );
  uniformState._eyeToEnu = Matrix3.transpose(enuToView, uniformState._eyeToEnu);

  if (
    !CesiumMath.equalsEpsilon(
      ellipsoid._radii.x,
      ellipsoid._radii.y,
      CesiumMath.EPSILON15,
    )
  ) {
    return;
  }

  uniformState._eyeEllipsoidCurvature = ellipsoid.getLocalCurvature(
    surfacePosition,
    uniformState._eyeEllipsoidCurvature,
  );
}

// --- Sun/Moon directions ---

const transformMatrix = new Matrix3();
const sunCartographicScratch = new Cartographic();

function setSunAndMoonDirections(uniformState, frameState) {
  const celestialEphemerisSample = frameState.celestialEphemerisSample;
  let position;
  if (defined(celestialEphemerisSample)) {
    position = Cartesian3.clone(
      celestialEphemerisSample.sunPositionWC,
      uniformState._sunPositionWC,
    );
  } else {
    // Scene normally publishes the shared Earth-fixed sample above. It
    // deliberately suppresses that sample when its implicit provider meets a
    // documented central-body override; use Scene's logical-frame snapshot in
    // that case. Bare/private FrameStates retain the current public hook.
    const centralBodyTransform =
      frameState._celestialEphemerisLegacyTransform ??
      Transforms.computeIcrfToCentralBodyFixedMatrix;
    centralBodyTransform.call(Transforms, frameState.time, transformMatrix);
    position =
      Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        frameState.time,
        uniformState._sunPositionWC,
      );
    Matrix3.multiplyByVector(transformMatrix, position, position);
  }

  Cartesian3.normalize(position, uniformState._sunDirectionWC);

  position = Matrix3.multiplyByVector(
    uniformState.viewRotation3D,
    position,
    uniformState._sunDirectionEC,
  );
  Cartesian3.normalize(position, position);

  if (defined(celestialEphemerisSample)) {
    position = Cartesian3.clone(
      celestialEphemerisSample.moonPositionWC,
      uniformState._moonDirectionEC,
    );
  } else {
    position =
      Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        frameState.time,
        uniformState._moonDirectionEC,
      );
    Matrix3.multiplyByVector(transformMatrix, position, position);
  }

  // World space is captured from this unrotated fixed-frame position, into a
  // separate output, before the view rotation below. Normalising in place or
  // un-rotating afterwards would both move the low bits of the eye-space
  // vector that existing shader consumers already sample.
  //
  // Published here rather than left to `frameState.moonDirectionWC`, which
  // `Moon.update` writes: Scene calls `uniformState.update` first and
  // `updateEnvironment` — and so `Moon.update` — some eighty lines later, and
  // that method returns without publishing when the Moon is hidden. A scene
  // light reading it would be a frame behind at best and frozen at worst.
  // Both are the same quantity, from the same sample.
  Cartesian3.normalize(position, uniformState._moonDirectionWC);

  Matrix3.multiplyByVector(uniformState.viewRotation3D, position, position);
  Cartesian3.normalize(position, position);

  const projection = frameState.mapProjection;
  const ellipsoid = projection.ellipsoid;
  const sunCartographic = ellipsoid.cartesianToCartographic(
    uniformState._sunPositionWC,
    sunCartographicScratch,
  );
  projection.project(sunCartographic, uniformState._sunPositionColumbusView);
}

// --- Lazy clean functions (dirty-flag pattern) ---

function cleanViewport(uniformState) {
  if (uniformState._viewportDirty) {
    const v = uniformState._viewport;
    Matrix4.computeOrthographicOffCenter(
      v.x,
      v.x + v.width,
      v.y,
      v.y + v.height,
      0.0,
      1.0,
      uniformState._viewportOrthographicMatrix,
      uniformState._clipSpaceConvention,
    );
    Matrix4.computeViewportTransformation(
      v,
      0.0,
      1.0,
      uniformState._viewportTransformation,
    );
    uniformState._viewportDirty = false;
  }
}

function cleanInverseProjection(uniformState) {
  if (uniformState._inverseProjectionDirty) {
    uniformState._inverseProjectionDirty = false;

    if (
      uniformState._mode !== SceneMode.SCENE2D &&
      uniformState._mode !== SceneMode.MORPHING &&
      !uniformState._orthographicIn3D
    ) {
      Matrix4.inverse(
        uniformState._projection,
        uniformState._inverseProjection,
      );
    } else {
      Matrix4.clone(Matrix4.ZERO, uniformState._inverseProjection);
    }
  }
}

function cleanModelView(uniformState) {
  if (uniformState._modelViewDirty) {
    uniformState._modelViewDirty = false;
    Matrix4.multiplyTransformation(
      uniformState._view,
      uniformState._model,
      uniformState._modelView,
    );
  }
}

function cleanModelView3D(uniformState) {
  if (uniformState._modelView3DDirty) {
    uniformState._modelView3DDirty = false;
    Matrix4.multiplyTransformation(
      uniformState.view3D,
      uniformState._model,
      uniformState._modelView3D,
    );
  }
}

function cleanInverseModelView(uniformState) {
  if (uniformState._inverseModelViewDirty) {
    uniformState._inverseModelViewDirty = false;
    Matrix4.inverse(uniformState.modelView, uniformState._inverseModelView);
  }
}

function cleanInverseModelView3D(uniformState) {
  if (uniformState._inverseModelView3DDirty) {
    uniformState._inverseModelView3DDirty = false;
    Matrix4.inverse(uniformState.modelView3D, uniformState._inverseModelView3D);
  }
}

function cleanViewProjection(uniformState) {
  if (uniformState._viewProjectionDirty) {
    uniformState._viewProjectionDirty = false;
    Matrix4.multiply(
      uniformState._projection,
      uniformState._view,
      uniformState._viewProjection,
    );
  }
}

function cleanInverseViewProjection(uniformState) {
  if (uniformState._inverseViewProjectionDirty) {
    uniformState._inverseViewProjectionDirty = false;
    Matrix4.inverse(
      uniformState.viewProjection,
      uniformState._inverseViewProjection,
    );
  }
}

function cleanModelViewProjection(uniformState) {
  if (uniformState._modelViewProjectionDirty) {
    uniformState._modelViewProjectionDirty = false;
    Matrix4.multiply(
      uniformState._projection,
      uniformState.modelView,
      uniformState._modelViewProjection,
    );
  }
}

// Scratch for cleanViewProjectionRelativeToEye. Reused across calls to
// avoid GC pressure; single-threaded so safe.
const viewRteScratch = new Float64Array(16);

function cleanViewProjectionRelativeToEye(uniformState) {
  if (uniformState._viewProjectionRelativeToEyeDirty) {
    uniformState._viewProjectionRelativeToEyeDirty = false;

    // Build view-with-translation-zeroed (view RTE for identity model).
    // Column-major: translation sits in elements 12..14.
    const v = uniformState._view;
    const vRte = viewRteScratch;
    for (let i = 0; i < 16; i++) {
      vRte[i] = v[i];
    }
    vRte[12] = 0.0;
    vRte[13] = 0.0;
    vRte[14] = 0.0;

    Matrix4.multiply(
      uniformState._projection,
      vRte,
      uniformState._viewProjectionRelativeToEye,
    );
  }
}

function cleanModelViewRelativeToEye(uniformState) {
  if (uniformState._modelViewRelativeToEyeDirty) {
    uniformState._modelViewRelativeToEyeDirty = false;

    const mv = uniformState.modelView;
    const mvRte = uniformState._modelViewRelativeToEye;
    mvRte[0] = mv[0];
    mvRte[1] = mv[1];
    mvRte[2] = mv[2];
    mvRte[3] = mv[3];
    mvRte[4] = mv[4];
    mvRte[5] = mv[5];
    mvRte[6] = mv[6];
    mvRte[7] = mv[7];
    mvRte[8] = mv[8];
    mvRte[9] = mv[9];
    mvRte[10] = mv[10];
    mvRte[11] = mv[11];
    mvRte[12] = 0.0;
    mvRte[13] = 0.0;
    mvRte[14] = 0.0;
    mvRte[15] = mv[15];
  }
}

function cleanInverseModelViewProjection(uniformState) {
  if (uniformState._inverseModelViewProjectionDirty) {
    uniformState._inverseModelViewProjectionDirty = false;
    Matrix4.inverse(
      uniformState.modelViewProjection,
      uniformState._inverseModelViewProjection,
    );
  }
}

function cleanModelViewProjectionRelativeToEye(uniformState) {
  if (uniformState._modelViewProjectionRelativeToEyeDirty) {
    uniformState._modelViewProjectionRelativeToEyeDirty = false;
    Matrix4.multiply(
      uniformState._projection,
      uniformState.modelViewRelativeToEye,
      uniformState._modelViewProjectionRelativeToEye,
    );
  }
}

function cleanModelViewInfiniteProjection(uniformState) {
  if (uniformState._modelViewInfiniteProjectionDirty) {
    uniformState._modelViewInfiniteProjectionDirty = false;
    Matrix4.multiply(
      uniformState._infiniteProjection,
      uniformState.modelView,
      uniformState._modelViewInfiniteProjection,
    );
  }
}

function cleanNormal(uniformState) {
  if (uniformState._normalDirty) {
    uniformState._normalDirty = false;
    const m = uniformState._normal;
    Matrix4.getMatrix3(uniformState.inverseModelView, m);
    Matrix3.transpose(m, m);
  }
}

function cleanNormal3D(uniformState) {
  if (uniformState._normal3DDirty) {
    uniformState._normal3DDirty = false;
    const m = uniformState._normal3D;
    Matrix4.getMatrix3(uniformState.inverseModelView3D, m);
    Matrix3.transpose(m, m);
  }
}

function cleanInverseNormal(uniformState) {
  if (uniformState._inverseNormalDirty) {
    uniformState._inverseNormalDirty = false;
    const m = uniformState._inverseNormal;
    Matrix4.getMatrix3(uniformState.modelView, m);
    Matrix3.transpose(m, m);
  }
}

function cleanInverseNormal3D(uniformState) {
  if (uniformState._inverseNormal3DDirty) {
    uniformState._inverseNormal3DDirty = false;
    const m = uniformState._inverseNormal3D;
    Matrix4.getMatrix3(uniformState.modelView3D, m);
    Matrix3.transpose(m, m);
  }
}

const cameraPositionMC = new Cartesian3();

function cleanEncodedCameraPositionMC(uniformState) {
  if (uniformState._encodedCameraPositionMCDirty) {
    uniformState._encodedCameraPositionMCDirty = false;
    Matrix4.multiplyByPoint(
      uniformState.inverseModel,
      uniformState._cameraPosition,
      cameraPositionMC,
    );
    EncodedCartesian3.fromCartesian(
      cameraPositionMC,
      uniformState._encodedCameraPositionMC,
    );
  }
}

// --- 2D-to-3D view matrix conversion ---

const view2Dto3DPScratch = new Cartesian3();
const view2Dto3DRScratch = new Cartesian3();
const view2Dto3DUScratch = new Cartesian3();
const view2Dto3DDScratch = new Cartesian3();
const view2Dto3DCartographicScratch = new Cartographic();
const view2Dto3DCartesian3Scratch = new Cartesian3();
const view2Dto3DMatrix4Scratch = new Matrix4();

function view2Dto3D(
  position2D,
  direction2D,
  right2D,
  up2D,
  frustum2DWidth,
  mode,
  projection,
  result,
) {
  const p = view2Dto3DPScratch;
  p.x = position2D.y;
  p.y = position2D.z;
  p.z = position2D.x;

  const r = view2Dto3DRScratch;
  r.x = right2D.y;
  r.y = right2D.z;
  r.z = right2D.x;

  const u = view2Dto3DUScratch;
  u.x = up2D.y;
  u.y = up2D.z;
  u.z = up2D.x;

  const d = view2Dto3DDScratch;
  d.x = direction2D.y;
  d.y = direction2D.z;
  d.z = direction2D.x;

  if (mode === SceneMode.SCENE2D) {
    p.z = frustum2DWidth * 0.5;
  }

  const cartographic = projection.unproject(p, view2Dto3DCartographicScratch);
  cartographic.longitude = CesiumMath.clamp(
    cartographic.longitude,
    -Math.PI,
    Math.PI,
  );
  cartographic.latitude = CesiumMath.clamp(
    cartographic.latitude,
    -CesiumMath.PI_OVER_TWO,
    CesiumMath.PI_OVER_TWO,
  );
  const ellipsoid = projection.ellipsoid;
  const position3D = ellipsoid.cartographicToCartesian(
    cartographic,
    view2Dto3DCartesian3Scratch,
  );

  const enuToFixed = Transforms.eastNorthUpToFixedFrame(
    position3D,
    ellipsoid,
    view2Dto3DMatrix4Scratch,
  );

  Matrix4.multiplyByPointAsVector(enuToFixed, r, r);
  Matrix4.multiplyByPointAsVector(enuToFixed, u, u);
  Matrix4.multiplyByPointAsVector(enuToFixed, d, d);

  if (!defined(result)) {
    result = new Matrix4();
  }

  result[0] = r.x;
  result[1] = u.x;
  result[2] = -d.x;
  result[3] = 0.0;
  result[4] = r.y;
  result[5] = u.y;
  result[6] = -d.y;
  result[7] = 0.0;
  result[8] = r.z;
  result[9] = u.z;
  result[10] = -d.z;
  result[11] = 0.0;
  result[12] = -Cartesian3.dot(r, position3D);
  result[13] = -Cartesian3.dot(u, position3D);
  result[14] = Cartesian3.dot(d, position3D);
  result[15] = 1.0;

  return result;
}

function updateView3D(uniformState) {
  if (uniformState._view3DDirty) {
    if (uniformState._mode === SceneMode.SCENE3D) {
      Matrix4.clone(uniformState._view, uniformState._view3D);
    } else {
      view2Dto3D(
        uniformState._cameraPosition,
        uniformState._cameraDirection,
        uniformState._cameraRight,
        uniformState._cameraUp,
        uniformState._frustum2DWidth,
        uniformState._mode,
        uniformState._mapProjection,
        uniformState._view3D,
      );
    }
    Matrix4.getMatrix3(uniformState._view3D, uniformState._viewRotation3D);
    uniformState._view3DDirty = false;
  }
}

function updateInverseView3D(uniformState) {
  if (uniformState._inverseView3DDirty) {
    Matrix4.inverseTransformation(
      uniformState.view3D,
      uniformState._inverseView3D,
    );
    Matrix4.getMatrix3(
      uniformState._inverseView3D,
      uniformState._inverseViewRotation3D,
    );
    uniformState._inverseView3DDirty = false;
  }
}

export {
  setView,
  setInverseView,
  setProjection,
  setInfiniteProjection,
  setCamera,
  setSunAndMoonDirections,
  cleanViewport,
  cleanInverseProjection,
  cleanModelView,
  cleanModelView3D,
  cleanInverseModelView,
  cleanInverseModelView3D,
  cleanViewProjection,
  cleanViewProjectionRelativeToEye,
  cleanInverseViewProjection,
  cleanModelViewProjection,
  cleanModelViewRelativeToEye,
  cleanInverseModelViewProjection,
  cleanModelViewProjectionRelativeToEye,
  cleanModelViewInfiniteProjection,
  cleanNormal,
  cleanNormal3D,
  cleanInverseNormal,
  cleanInverseNormal3D,
  cleanEncodedCameraPositionMC,
  updateView3D,
  updateInverseView3D,
};

// Namespace default export for build system barrel compatibility
const UniformStateComputations = {
  setView,
  setInverseView,
  setProjection,
  setInfiniteProjection,
  setCamera,
  setSunAndMoonDirections,
  cleanViewport,
  cleanInverseProjection,
  cleanModelView,
  cleanModelView3D,
  cleanInverseModelView,
  cleanInverseModelView3D,
  cleanViewProjection,
  cleanViewProjectionRelativeToEye,
  cleanInverseViewProjection,
  cleanModelViewProjection,
  cleanModelViewRelativeToEye,
  cleanInverseModelViewProjection,
  cleanModelViewProjectionRelativeToEye,
  cleanModelViewInfiniteProjection,
  cleanNormal,
  cleanNormal3D,
  cleanInverseNormal,
  cleanInverseNormal3D,
  cleanEncodedCameraPositionMC,
  updateView3D,
  updateInverseView3D,
};
export default UniformStateComputations;
