import Cartesian3 from "../../Core/Cartesian3.js";
import EncodedCartesian3 from "../../Core/EncodedCartesian3.js";
import Matrix4 from "../../Core/Matrix4.js";

const scratchModelView = new Matrix4();
const scratchInverseModel = new Matrix4();
const scratchCameraModel = new Cartesian3();
const scratchEncodedCamera = {
  high: new Cartesian3(),
  low: new Cartesian3(),
};

function createPointCloudRteSnapshot() {
  return {
    mvpRelativeToEye: new Matrix4(),
    encodedCameraHigh: new Cartesian3(),
    encodedCameraLow: new Cartesian3(),
  };
}

function clonePointCloudRteSnapshot(source, result) {
  Matrix4.clone(source.mvpRelativeToEye, result.mvpRelativeToEye);
  Cartesian3.clone(source.encodedCameraHigh, result.encodedCameraHigh);
  Cartesian3.clone(source.encodedCameraLow, result.encodedCameraLow);
  return result;
}

/**
 * Build one point-cloud camera/model RTE snapshot. Positions consumed with
 * this snapshot remain in model/local coordinates: the camera is transformed
 * into that same space and the translation-free P*V*M matrix applies only the
 * relative vector. No Earth-scale absolute f32 world position is formed.
 */
function computePointCloudRteSnapshot(
  view,
  projection,
  cameraWorld,
  modelMatrix,
  result,
) {
  const modelView = Matrix4.multiply(view, modelMatrix, scratchModelView);
  modelView[12] = 0.0;
  modelView[13] = 0.0;
  modelView[14] = 0.0;
  Matrix4.multiply(projection, modelView, result.mvpRelativeToEye);

  Matrix4.inverse(modelMatrix, scratchInverseModel);
  Matrix4.multiplyByPoint(scratchInverseModel, cameraWorld, scratchCameraModel);
  EncodedCartesian3.fromCartesian(scratchCameraModel, scratchEncodedCamera);
  Cartesian3.clone(scratchEncodedCamera.high, result.encodedCameraHigh);
  Cartesian3.clone(scratchEncodedCamera.low, result.encodedCameraLow);
  return result;
}

function createPointCloudRteHistory() {
  return {
    current: createPointCloudRteSnapshot(),
    previous: createPointCloudRteSnapshot(),
    frameNumber: -1,
    viewKey: undefined,
    valid: false,
  };
}

/**
 * Advance exactly once per frame and per view identity. Repeated update calls
 * in one frame refresh only the current snapshot, leaving the previous one
 * stable. A first frame, discontinuous frame-number gap/reset, or view switch
 * seeds previous from current so a revisited TimeDynamic frame cannot inherit
 * stale camera/model history from the last time that owner was visible.
 */
function updatePointCloudRteHistory(
  history,
  frameNumber,
  viewKey,
  view,
  projection,
  cameraWorld,
  modelMatrix,
) {
  const reset =
    !history.valid ||
    history.viewKey !== viewKey ||
    frameNumber < history.frameNumber ||
    frameNumber > history.frameNumber + 1;

  if (reset) {
    computePointCloudRteSnapshot(
      view,
      projection,
      cameraWorld,
      modelMatrix,
      history.current,
    );
    clonePointCloudRteSnapshot(history.current, history.previous);
    history.valid = true;
    history.viewKey = viewKey;
    history.frameNumber = frameNumber;
    return history;
  }

  if (frameNumber !== history.frameNumber) {
    clonePointCloudRteSnapshot(history.current, history.previous);
    history.frameNumber = frameNumber;
  }
  computePointCloudRteSnapshot(
    view,
    projection,
    cameraWorld,
    modelMatrix,
    history.current,
  );
  return history;
}

export {
  computePointCloudRteSnapshot,
  createPointCloudRteHistory,
  createPointCloudRteSnapshot,
  updatePointCloudRteHistory,
};

export default {
  computePointCloudRteSnapshot,
  createPointCloudRteHistory,
  createPointCloudRteSnapshot,
  updatePointCloudRteHistory,
};
