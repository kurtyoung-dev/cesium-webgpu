import Cartesian3 from "../Core/Cartesian3.js";
import Matrix4 from "../Core/Matrix4.js";
import OrthographicFrustum from "../Core/OrthographicFrustum.js";
import OrthographicOffCenterFrustum from "../Core/OrthographicOffCenterFrustum.js";
import SceneMode from "./SceneMode.js";

// Keep this aligned with the existing TAA and motion-blur teleport gate. The
// shared View history owns the decision now so every temporal consumer sees
// the same reset result.
const TELEPORT_DISTANCE = 50000.0;
const TELEPORT_DISTANCE_SQUARED = TELEPORT_DISTANCE * TELEPORT_DISTANCE;

function isOrthographic(frustum) {
  return (
    frustum instanceof OrthographicFrustum ||
    frustum instanceof OrthographicOffCenterFrustum
  );
}

/**
 * Creates allocation-stable temporal camera history for one logical View.
 *
 * The `presented*` fields describe the last frame that reached the explicit
 * presentation boundary. The `pending*` fields are staged by the main render
 * before auxiliary/pass cameras can re-enter UniformState, then committed only
 * after that frame is successfully submitted. Picks, ray queries, shadow
 * cameras, and environment-capture cameras never call either mutator.
 *
 * @returns {object} Per-View temporal history.
 * @private
 */
function createViewTemporalHistory() {
  const history = {
    presentedViewProjection: Matrix4.clone(Matrix4.IDENTITY),
    presentedViewProjectionRelativeToEye: Matrix4.clone(Matrix4.IDENTITY),
    presentedCameraPosition: new Cartesian3(),
    pendingViewProjection: new Matrix4(),
    pendingViewProjectionRelativeToEye: new Matrix4(),
    pendingCameraPosition: new Cartesian3(),
    initialized: false,
    pending: false,
    pendingFrameNumber: undefined,
    pendingPresentationToken: undefined,
    pendingPresentationEpoch: undefined,
    presentedFrameNumber: undefined,
    presentedPresentationToken: undefined,
    presentedPresentationEpoch: undefined,
    nextPresentationToken: 0,
    presentationEpoch: 0,
    submittedPresentationToken: undefined,
    submittedPresentationEpoch: undefined,
    submissionCallback: undefined,
    presentedMode: undefined,
    presentedMapProjection: undefined,
    presentedOrthographic: undefined,
    pendingMode: undefined,
    pendingMapProjection: undefined,
    pendingOrthographic: undefined,
  };

  // One bound callback per View, never one closure per frame. The callback is
  // armed with primitive token/epoch fields immediately after beginFrame and
  // resolved by an explicit-command context at its queue-submit boundary.
  history.submissionCallback =
    resolvePresentedViewTemporalHistorySubmission.bind(undefined, history);
  return history;
}

/**
 * Copies the last presented state into context-local UniformState results.
 * The result objects are retained by UniformState, so this allocates nothing.
 *
 * @param {object} history Per-View temporal history.
 * @param {Matrix4} viewProjectionResult Destination for the full VP.
 * @param {Matrix4} viewProjectionRelativeToEyeResult Destination for VP_RTE.
 * @param {Cartesian3} cameraPositionResult Destination for the camera position.
 * @returns {boolean} Whether the View has a previously presented frame.
 * @private
 */
function readViewTemporalHistory(
  history,
  viewProjectionResult,
  viewProjectionRelativeToEyeResult,
  cameraPositionResult,
) {
  Matrix4.clone(history.presentedViewProjection, viewProjectionResult);
  Matrix4.clone(
    history.presentedViewProjectionRelativeToEye,
    viewProjectionRelativeToEyeResult,
  );
  Cartesian3.clone(history.presentedCameraPosition, cameraPositionResult);
  return history.initialized;
}

/**
 * Determines whether the last presented state can be reprojected into the
 * current prepared state. This is read-only; auxiliary updates may ask the
 * question repeatedly without advancing or invalidating the View's history.
 *
 * @param {object} history Per-View temporal history.
 * @param {object} frameState Current frame state.
 * @returns {boolean} Whether temporal reprojection is valid.
 * @private
 */
function isViewTemporalHistoryValid(history, frameState) {
  if (!history.initialized || frameState.mode === SceneMode.MORPHING) {
    return false;
  }

  const camera = frameState.camera;
  if (
    history.presentedMode !== frameState.mode ||
    history.presentedMapProjection !== frameState.mapProjection ||
    history.presentedOrthographic !== isOrthographic(camera.frustum)
  ) {
    return false;
  }

  const currentPosition = camera.positionWC;
  const previousPosition = history.presentedCameraPosition;
  const deltaX = currentPosition.x - previousPosition.x;
  const deltaY = currentPosition.y - previousPosition.y;
  const deltaZ = currentPosition.z - previousPosition.z;
  return (
    deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ <=
    TELEPORT_DISTANCE_SQUARED
  );
}

/**
 * Begins a unique logical presentation for this View. This identity is
 * independent of the engine-visible frame number, which wraps and can repeat
 * while an intermittently scheduled View still retains older history.
 *
 * @param {object} history Per-View temporal history.
 * @returns {number} The new presentation token. Its epoch is stored in
 *          `history.presentationEpoch` without allocating a pair object.
 * @private
 */
function beginViewTemporalHistoryPresentation(history) {
  let presentationToken = history.nextPresentationToken;
  let presentationEpoch = history.presentationEpoch;

  // Both words stay exactly representable forever. At the astronomically rare
  // full-pair wrap, skip either identity that is still live rather than
  // treating a new presentation as a duplicate/stale callback.
  do {
    if (presentationToken === Number.MAX_SAFE_INTEGER) {
      presentationToken = 1;
      presentationEpoch =
        presentationEpoch === Number.MAX_SAFE_INTEGER
          ? 0
          : presentationEpoch + 1;
    } else {
      presentationToken++;
    }
  } while (
    (history.pending &&
      history.pendingPresentationToken === presentationToken &&
      history.pendingPresentationEpoch === presentationEpoch) ||
    (history.initialized &&
      history.presentedPresentationToken === presentationToken &&
      history.presentedPresentationEpoch === presentationEpoch)
  );

  history.nextPresentationToken = presentationToken;
  history.presentationEpoch = presentationEpoch;
  return presentationToken;
}

/**
 * Stages the current main-view state exactly once for one logical
 * presentation. Staging is separate from committing so a render failure
 * cannot make an unpresented camera the next frame's history.
 *
 * @param {object} history Per-View temporal history.
 * @param {object} uniformState Prepared main-view UniformState.
 * @param {object} frameState Current frame state.
 * @param {number} presentationToken Per-View logical presentation token.
 * @param {number} presentationEpoch Token epoch.
 * @returns {boolean} Whether a new pending state was staged.
 * @private
 */
function stagePresentedViewTemporalHistory(
  history,
  uniformState,
  frameState,
  presentationToken,
  presentationEpoch,
) {
  const frameNumber = frameState.frameNumber;
  if (
    (history.pending &&
      history.pendingPresentationToken === presentationToken &&
      history.pendingPresentationEpoch === presentationEpoch) ||
    (history.initialized &&
      history.presentedPresentationToken === presentationToken &&
      history.presentedPresentationEpoch === presentationEpoch)
  ) {
    return false;
  }

  Matrix4.clone(uniformState.viewProjection, history.pendingViewProjection);
  Matrix4.clone(
    uniformState.viewProjectionRelativeToEye,
    history.pendingViewProjectionRelativeToEye,
  );
  Cartesian3.clone(uniformState.cameraPosition, history.pendingCameraPosition);
  history.pendingFrameNumber = frameNumber;
  history.pendingPresentationToken = presentationToken;
  history.pendingPresentationEpoch = presentationEpoch;
  history.pendingMode = frameState.mode;
  history.pendingMapProjection = frameState.mapProjection;
  history.pendingOrthographic = isOrthographic(frameState.camera.frustum);
  history.pending = true;
  return true;
}

/**
 * Commits one exact staged presentation only at its successful submission
 * boundary. Duplicate/stale callbacks are harmless and allocate nothing.
 *
 * @param {object} history Per-View temporal history.
 * @param {number} presentationToken Per-View logical presentation token.
 * @param {number} presentationEpoch Token epoch.
 * @returns {boolean} Whether history advanced.
 * @private
 */
function commitPresentedViewTemporalHistory(
  history,
  presentationToken,
  presentationEpoch,
) {
  if (
    !history.pending ||
    history.pendingPresentationToken !== presentationToken ||
    history.pendingPresentationEpoch !== presentationEpoch
  ) {
    return false;
  }

  Matrix4.clone(history.pendingViewProjection, history.presentedViewProjection);
  Matrix4.clone(
    history.pendingViewProjectionRelativeToEye,
    history.presentedViewProjectionRelativeToEye,
  );
  Cartesian3.clone(
    history.pendingCameraPosition,
    history.presentedCameraPosition,
  );
  history.presentedFrameNumber = history.pendingFrameNumber;
  history.presentedPresentationToken = presentationToken;
  history.presentedPresentationEpoch = presentationEpoch;
  history.presentedMode = history.pendingMode;
  history.presentedMapProjection = history.pendingMapProjection;
  history.presentedOrthographic = history.pendingOrthographic;
  history.initialized = true;
  history.pending = false;
  history.pendingFrameNumber = undefined;
  history.pendingPresentationToken = undefined;
  history.pendingPresentationEpoch = undefined;
  return true;
}

/**
 * Discards one exact staged presentation when its frame is abandoned before
 * submission. A stale failure callback cannot erase a newer pending frame.
 *
 * @param {object} history Per-View temporal history.
 * @param {number} presentationToken Per-View logical presentation token.
 * @param {number} presentationEpoch Token epoch.
 * @returns {boolean} Whether a pending stage was discarded.
 * @private
 */
function discardPresentedViewTemporalHistory(
  history,
  presentationToken,
  presentationEpoch,
) {
  if (
    !history.pending ||
    history.pendingPresentationToken !== presentationToken ||
    history.pendingPresentationEpoch !== presentationEpoch
  ) {
    return false;
  }

  history.pending = false;
  history.pendingFrameNumber = undefined;
  history.pendingPresentationToken = undefined;
  history.pendingPresentationEpoch = undefined;
  return true;
}

function resolvePresentedViewTemporalHistorySubmission(history, submitted) {
  const presentationToken = history.submittedPresentationToken;
  const presentationEpoch = history.submittedPresentationEpoch;
  history.submittedPresentationToken = undefined;
  history.submittedPresentationEpoch = undefined;

  if (submitted) {
    return commitPresentedViewTemporalHistory(
      history,
      presentationToken,
      presentationEpoch,
    );
  }
  return discardPresentedViewTemporalHistory(
    history,
    presentationToken,
    presentationEpoch,
  );
}

/**
 * Arms the context's existing logical-frame submission callback with the
 * current pending View token. The callback commits immediately after the
 * command buffer reaches queue.submit, even if later endFrame bookkeeping
 * throws. Rejection means there is no active submit owner, so the stage is
 * discarded instead of being mistaken for a presented frame.
 *
 * @param {object} history Per-View temporal history.
 * @param {object} context Active graphics context.
 * @returns {boolean} Whether the active frame accepted the callback.
 * @private
 */
function enqueuePresentedViewTemporalHistoryCommit(history, context) {
  if (
    !history.pending ||
    typeof context.enqueueAfterFrameSubmit !== "function"
  ) {
    return false;
  }

  const presentationToken = history.pendingPresentationToken;
  const presentationEpoch = history.pendingPresentationEpoch;
  history.submittedPresentationToken = presentationToken;
  history.submittedPresentationEpoch = presentationEpoch;

  let accepted;
  try {
    accepted = context.enqueueAfterFrameSubmit(history.submissionCallback);
  } catch (error) {
    history.submittedPresentationToken = undefined;
    history.submittedPresentationEpoch = undefined;
    discardPresentedViewTemporalHistory(
      history,
      presentationToken,
      presentationEpoch,
    );
    throw error;
  }

  if (!accepted) {
    history.submittedPresentationToken = undefined;
    history.submittedPresentationEpoch = undefined;
    discardPresentedViewTemporalHistory(
      history,
      presentationToken,
      presentationEpoch,
    );
  }
  return accepted;
}

export {
  beginViewTemporalHistoryPresentation,
  commitPresentedViewTemporalHistory,
  createViewTemporalHistory,
  discardPresentedViewTemporalHistory,
  enqueuePresentedViewTemporalHistoryCommit,
  isViewTemporalHistoryValid,
  readViewTemporalHistory,
  stagePresentedViewTemporalHistory,
};
