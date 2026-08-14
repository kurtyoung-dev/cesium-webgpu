import {
  Cartesian3,
  Matrix4,
  OrthographicFrustum,
  SceneMode,
} from "../../index.js";
import {
  beginViewTemporalHistoryPresentation,
  commitPresentedViewTemporalHistory,
  createViewTemporalHistory,
  enqueuePresentedViewTemporalHistoryCommit,
  isViewTemporalHistoryValid,
  readViewTemporalHistory,
  stagePresentedViewTemporalHistory,
} from "../../Source/Scene/ViewTemporalHistory.js";
import { WebGPUContext } from "../../Source/Renderer/WebGPU/WebGPUContext.js";
import createCamera from "../../../../Specs/createCamera.js";
import createContext from "../../../../Specs/createContext.js";
import createFrameState from "../../../../Specs/createFrameState.js";

describe("Scene/ViewTemporalHistory", function () {
  let context;

  beforeAll(function () {
    context = createContext();
  });

  afterAll(function () {
    context.destroyForSpecs();
  });

  function createUniformState(seed) {
    return {
      viewProjection: Matrix4.fromTranslation(
        new Cartesian3(seed, seed + 1.0, seed + 2.0),
        new Matrix4(),
      ),
      viewProjectionRelativeToEye: Matrix4.fromTranslation(
        new Cartesian3(-seed, seed * 2.0, -seed * 3.0),
        new Matrix4(),
      ),
      cameraPosition: new Cartesian3(seed * 10.0, seed * 20.0, seed * 30.0),
    };
  }

  function createTemporalFrameState(
    frameNumber,
    mapProjection,
    position,
    mode = SceneMode.SCENE3D,
    frustum = {},
  ) {
    return {
      frameNumber: frameNumber,
      mode: mode,
      mapProjection: mapProjection,
      camera: {
        positionWC: position,
        frustum: frustum,
      },
    };
  }

  function readHistory(history) {
    const result = {
      viewProjection: new Matrix4(),
      viewProjectionRelativeToEye: new Matrix4(),
      cameraPosition: new Cartesian3(),
    };
    result.initialized = readViewTemporalHistory(
      history,
      result.viewProjection,
      result.viewProjectionRelativeToEye,
      result.cameraPosition,
    );
    return result;
  }

  function stageHistory(history, uniformState, frameState) {
    const presentationToken = beginViewTemporalHistoryPresentation(history);
    const presentationEpoch = history.presentationEpoch;
    return {
      presentationToken: presentationToken,
      presentationEpoch: presentationEpoch,
      staged: stagePresentedViewTemporalHistory(
        history,
        uniformState,
        frameState,
        presentationToken,
        presentationEpoch,
      ),
    };
  }

  function commitHistory(history, presentation) {
    return commitPresentedViewTemporalHistory(
      history,
      presentation.presentationToken,
      presentation.presentationEpoch,
    );
  }

  it("preserves first-frame identity and advances only at commit", function () {
    const history = createViewTemporalHistory();
    const projection = {};
    const firstRead = readHistory(history);

    expect(firstRead.initialized).toBeFalse();
    expect(firstRead.viewProjection).toEqual(Matrix4.IDENTITY);
    expect(firstRead.viewProjectionRelativeToEye).toEqual(Matrix4.IDENTITY);
    expect(firstRead.cameraPosition).toEqual(Cartesian3.ZERO);

    const presentedViewProjection = history.presentedViewProjection;
    const presentedViewProjectionRelativeToEye =
      history.presentedViewProjectionRelativeToEye;
    const presentedCameraPosition = history.presentedCameraPosition;
    const pendingViewProjection = history.pendingViewProjection;
    const pendingViewProjectionRelativeToEye =
      history.pendingViewProjectionRelativeToEye;
    const pendingCameraPosition = history.pendingCameraPosition;
    const submissionCallback = history.submissionCallback;

    const current = createUniformState(1.0);
    const frameState = createTemporalFrameState(
      7,
      projection,
      current.cameraPosition,
    );
    const presentation = stageHistory(history, current, frameState);
    expect(presentation.staged).toBeTrue();
    expect(
      stagePresentedViewTemporalHistory(
        history,
        createUniformState(99.0),
        frameState,
        presentation.presentationToken,
        presentation.presentationEpoch,
      ),
    ).toBeFalse();
    expect(
      commitPresentedViewTemporalHistory(
        history,
        presentation.presentationToken + 1,
        presentation.presentationEpoch,
      ),
    ).toBeFalse();

    // Staging is not presentation. Readers still see the first-frame values.
    expect(readHistory(history).initialized).toBeFalse();
    expect(commitHistory(history, presentation)).toBeTrue();
    expect(commitHistory(history, presentation)).toBeFalse();

    const committed = readHistory(history);
    expect(committed.initialized).toBeTrue();
    expect(committed.viewProjection).toEqual(current.viewProjection);
    expect(committed.viewProjectionRelativeToEye).toEqual(
      current.viewProjectionRelativeToEye,
    );
    expect(committed.cameraPosition).toEqual(current.cameraPosition);

    // Every mutable value is constructor-owned and reused across frames.
    expect(history.presentedViewProjection).toBe(presentedViewProjection);
    expect(history.presentedViewProjectionRelativeToEye).toBe(
      presentedViewProjectionRelativeToEye,
    );
    expect(history.presentedCameraPosition).toBe(presentedCameraPosition);
    expect(history.pendingViewProjection).toBe(pendingViewProjection);
    expect(history.pendingViewProjectionRelativeToEye).toBe(
      pendingViewProjectionRelativeToEye,
    );
    expect(history.pendingCameraPosition).toBe(pendingCameraPosition);
    expect(history.submissionCallback).toBe(submissionCallback);
  });

  it("commits at queue submit even when endFrame throws afterward", function () {
    const history = createViewTemporalHistory();
    const current = createUniformState(12.0);
    const frameState = createTemporalFrameState(12, {}, current.cameraPosition);
    const presentation = stageHistory(history, current, frameState);
    const webgpuContext = new WebGPUContext(
      document.createElement("canvas"),
      {},
    );
    const commandBuffer = {};
    const encoder = {
      finish: jasmine
        .createSpy("encoder.finish")
        .and.returnValue(commandBuffer),
    };
    const submit = jasmine.createSpy("queue.submit");
    webgpuContext._device = {
      queue: {
        submit: submit,
      },
    };
    webgpuContext._currentCommandEncoder = encoder;
    webgpuContext._timestampProfiler = {
      afterSubmit: function () {
        throw new Error("post-submit bookkeeping failed");
      },
    };

    expect(
      enqueuePresentedViewTemporalHistoryCommit(history, webgpuContext),
    ).toBeTrue();
    expect(function () {
      webgpuContext.endFrame();
    }).toThrowError("post-submit bookkeeping failed");

    expect(submit).toHaveBeenCalledOnceWith([commandBuffer]);
    expect(history.pending).toBeFalse();
    expect(history.presentedPresentationToken).toBe(
      presentation.presentationToken,
    );
    expect(history.presentedPresentationEpoch).toBe(
      presentation.presentationEpoch,
    );
    const committed = readHistory(history);
    expect(committed.initialized).toBeTrue();
    expect(committed.viewProjection).toEqual(current.viewProjection);
    expect(committed.cameraPosition).toEqual(current.cameraPosition);

    webgpuContext._timestampProfiler = null;
    webgpuContext._device = null;
    webgpuContext.destroy();
  });

  it("distinguishes repeated frame numbers across token wrap", function () {
    const history = createViewTemporalHistory();
    const projection = {};
    const first = createUniformState(13.0);
    const firstPresentation = stageHistory(
      history,
      first,
      createTemporalFrameState(7, projection, first.cameraPosition),
    );
    expect(commitHistory(history, firstPresentation)).toBeTrue();

    // An intermittently scheduled View can encounter the same bounded global
    // frame number again. Presentation identity, rather than frameNumber, must
    // admit and commit its newer state.
    const repeated = createUniformState(14.0);
    const repeatedPresentation = stageHistory(
      history,
      repeated,
      createTemporalFrameState(7, projection, repeated.cameraPosition),
    );
    expect(repeatedPresentation.staged).toBeTrue();
    expect(commitHistory(history, repeatedPresentation)).toBeTrue();
    expect(readHistory(history).viewProjection).toEqual(
      repeated.viewProjection,
    );

    // Force the low token to wrap onto the first presentation's token. The
    // advanced epoch keeps the pair unique, including against stale callbacks.
    const priorEpoch = history.presentationEpoch;
    history.nextPresentationToken = Number.MAX_SAFE_INTEGER;
    const wrapped = createUniformState(15.0);
    const wrappedPresentation = stageHistory(
      history,
      wrapped,
      createTemporalFrameState(7, projection, wrapped.cameraPosition),
    );
    expect(wrappedPresentation.presentationToken).toBe(1);
    expect(wrappedPresentation.presentationEpoch).toBe(priorEpoch + 1);
    expect(wrappedPresentation.staged).toBeTrue();
    expect(
      commitPresentedViewTemporalHistory(
        history,
        firstPresentation.presentationToken,
        firstPresentation.presentationEpoch,
      ),
    ).toBeFalse();
    expect(commitHistory(history, wrappedPresentation)).toBeTrue();
    expect(history.presentedFrameNumber).toBe(7);
    expect(readHistory(history).viewProjection).toEqual(wrapped.viewProjection);

    // A full two-word wrap also stays exact and skips a still-presented pair.
    const collisionHistory = createViewTemporalHistory();
    const collisionFirst = createUniformState(16.0);
    const collisionFirstPresentation = stageHistory(
      collisionHistory,
      collisionFirst,
      createTemporalFrameState(7, projection, collisionFirst.cameraPosition),
    );
    expect(collisionFirstPresentation.presentationToken).toBe(1);
    expect(collisionFirstPresentation.presentationEpoch).toBe(0);
    expect(
      commitHistory(collisionHistory, collisionFirstPresentation),
    ).toBeTrue();
    collisionHistory.nextPresentationToken = Number.MAX_SAFE_INTEGER;
    collisionHistory.presentationEpoch = Number.MAX_SAFE_INTEGER;
    const afterFullWrap = createUniformState(17.0);
    const afterFullWrapPresentation = stageHistory(
      collisionHistory,
      afterFullWrap,
      createTemporalFrameState(7, projection, afterFullWrap.cameraPosition),
    );
    expect(afterFullWrapPresentation.presentationToken).toBe(2);
    expect(afterFullWrapPresentation.presentationEpoch).toBe(0);
    expect(afterFullWrapPresentation.staged).toBeTrue();
    expect(
      commitHistory(collisionHistory, afterFullWrapPresentation),
    ).toBeTrue();
    expect(readHistory(collisionHistory).viewProjection).toEqual(
      afterFullWrap.viewProjection,
    );
  });

  it("keeps auxiliary reads from changing staged or presented history", function () {
    const history = createViewTemporalHistory();
    const projection = {};
    const mainA = createUniformState(2.0);
    const frameA = createTemporalFrameState(
      1,
      projection,
      mainA.cameraPosition,
    );
    const presentationA = stageHistory(history, mainA, frameA);
    commitHistory(history, presentationA);

    const mainB = createUniformState(3.0);
    const frameB = createTemporalFrameState(
      2,
      projection,
      mainB.cameraPosition,
    );
    const presentationB = stageHistory(history, mainB, frameB);

    // Pick/offscreen/pass-camera preparation can reload the prior frame any
    // number of times, but it has no mutation capability and cannot commit B.
    for (let i = 0; i < 4; i++) {
      const auxiliaryRead = readHistory(history);
      expect(auxiliaryRead.viewProjection).toEqual(mainA.viewProjection);
      expect(auxiliaryRead.cameraPosition).toEqual(mainA.cameraPosition);
      expect(history.presentedFrameNumber).toBe(1);
    }

    expect(commitHistory(history, presentationB)).toBeTrue();
    const nextRead = readHistory(history);
    expect(nextRead.viewProjection).toEqual(mainB.viewProjection);
    expect(nextRead.cameraPosition).toEqual(mainB.cameraPosition);
  });

  it("makes UniformState updates prepare-only and pass cameras history-neutral", function () {
    const history = createViewTemporalHistory();
    const mainCamera = createCamera();
    const frameState = createFrameState(context, mainCamera, 1);
    frameState.view = {
      _temporalHistory: history,
    };

    const uniformState = context.uniformState;
    uniformState.update(frameState);
    expect(uniformState.previousViewProjection).toEqual(Matrix4.IDENTITY);
    expect(uniformState.previousCameraPosition).toEqual(Cartesian3.ZERO);
    expect(uniformState.temporalHistoryValid).toBeFalse();

    const firstPresentation = stageHistory(history, uniformState, frameState);
    commitHistory(history, firstPresentation);
    const committedViewProjection = Matrix4.clone(
      history.presentedViewProjection,
    );
    const committedCameraPosition = Cartesian3.clone(
      history.presentedCameraPosition,
    );

    mainCamera.position.x += 10.0;
    frameState.frameNumber = 2;
    uniformState.update(frameState);
    expect(uniformState.previousViewProjection).toEqual(
      committedViewProjection,
    );
    expect(uniformState.previousCameraPosition).toEqual(
      committedCameraPosition,
    );
    expect(uniformState.temporalHistoryValid).toBeTrue();

    const previousViewProjection = Matrix4.clone(
      uniformState.previousViewProjection,
    );
    const previousCameraPosition = Cartesian3.clone(
      uniformState.previousCameraPosition,
    );
    const passCamera = createCamera({
      offset: new Cartesian3(-100000.0, 0.0, 0.0),
    });

    // updateCamera is deliberately pass-local: it changes current camera
    // uniforms but never the View's previous presented values.
    uniformState.updateCamera(passCamera);
    expect(uniformState.previousViewProjection).toEqual(previousViewProjection);
    expect(uniformState.previousCameraPosition).toEqual(previousCameraPosition);
    expect(history.presentedViewProjection).toEqual(committedViewProjection);
    expect(history.presentedCameraPosition).toEqual(committedCameraPosition);

    // A full auxiliary update may prepare an incompatible camera in the same
    // shared UniformState. Restoring the main camera reloads the same View
    // history; neither call advances it or turns it into current/current.
    frameState.camera = passCamera;
    uniformState.update(frameState);
    expect(uniformState.temporalHistoryValid).toBeFalse();
    frameState.camera = mainCamera;
    uniformState.update(frameState);
    expect(uniformState.previousViewProjection).toEqual(
      committedViewProjection,
    );
    expect(uniformState.previousCameraPosition).toEqual(
      committedCameraPosition,
    );
    expect(uniformState.temporalHistoryValid).toBeTrue();
    expect(history.presentedFrameNumber).toBe(1);
  });

  it("keeps two logical Views independent", function () {
    const projection = {};
    const historyA = createViewTemporalHistory();
    const historyB = createViewTemporalHistory();
    const stateA = createUniformState(4.0);
    const stateB = createUniformState(8.0);

    const presentationA = stageHistory(
      historyA,
      stateA,
      createTemporalFrameState(11, projection, stateA.cameraPosition),
    );
    const presentationB = stageHistory(
      historyB,
      stateB,
      createTemporalFrameState(11, projection, stateB.cameraPosition),
    );
    commitHistory(historyB, presentationB);
    commitHistory(historyA, presentationA);

    expect(readHistory(historyA).viewProjection).toEqual(stateA.viewProjection);
    expect(readHistory(historyB).viewProjection).toEqual(stateB.viewProjection);
    expect(historyA.presentedViewProjection).not.toBe(
      historyB.presentedViewProjection,
    );
  });

  it("invalidates first frame, teleport, morph, mode and projection changes", function () {
    const history = createViewTemporalHistory();
    const projection = {};
    const initial = createUniformState(0.0);
    const initialFrame = createTemporalFrameState(
      1,
      projection,
      Cartesian3.ZERO,
    );

    expect(isViewTemporalHistoryValid(history, initialFrame)).toBeFalse();
    const initialPresentation = stageHistory(history, initial, initialFrame);
    commitHistory(history, initialPresentation);

    expect(
      isViewTemporalHistoryValid(
        history,
        createTemporalFrameState(
          2,
          projection,
          new Cartesian3(50000.0, 0.0, 0.0),
        ),
      ),
    ).toBeTrue();
    expect(
      isViewTemporalHistoryValid(
        history,
        createTemporalFrameState(
          2,
          projection,
          new Cartesian3(50000.01, 0.0, 0.0),
        ),
      ),
    ).toBeFalse();
    expect(
      isViewTemporalHistoryValid(
        history,
        createTemporalFrameState(
          2,
          projection,
          Cartesian3.ZERO,
          SceneMode.MORPHING,
        ),
      ),
    ).toBeFalse();
    expect(
      isViewTemporalHistoryValid(
        history,
        createTemporalFrameState(
          2,
          projection,
          Cartesian3.ZERO,
          SceneMode.SCENE2D,
        ),
      ),
    ).toBeFalse();
    expect(
      isViewTemporalHistoryValid(
        history,
        createTemporalFrameState(2, {}, Cartesian3.ZERO),
      ),
    ).toBeFalse();

    const orthographic = new OrthographicFrustum({
      width: 10.0,
      aspectRatio: 1.0,
      near: 1.0,
      far: 100.0,
    });
    expect(
      isViewTemporalHistoryValid(
        history,
        createTemporalFrameState(
          2,
          projection,
          Cartesian3.ZERO,
          SceneMode.SCENE3D,
          orthographic,
        ),
      ),
    ).toBeFalse();

    // The invalid frame seeds the new projection; the following frame is
    // compatible again rather than remaining permanently invalid.
    const reset = createUniformState(5.0);
    const resetFrame = createTemporalFrameState(
      2,
      projection,
      reset.cameraPosition,
      SceneMode.SCENE3D,
      orthographic,
    );
    const resetPresentation = stageHistory(history, reset, resetFrame);
    commitHistory(history, resetPresentation);
    expect(
      isViewTemporalHistoryValid(
        history,
        createTemporalFrameState(
          3,
          projection,
          reset.cameraPosition,
          SceneMode.SCENE3D,
          orthographic,
        ),
      ),
    ).toBeTrue();
  });
});
