import BoundingRectangle from "../../Source/Core/BoundingRectangle.js";
import Cartesian3 from "../../Source/Core/Cartesian3.js";
import GeographicProjection from "../../Source/Core/GeographicProjection.js";
import Matrix3 from "../../Source/Core/Matrix3.js";
import Matrix4 from "../../Source/Core/Matrix4.js";
import OrthographicOffCenterFrustum from "../../Source/Core/OrthographicOffCenterFrustum.js";
import PerspectiveFrustum from "../../Source/Core/PerspectiveFrustum.js";
import Camera from "../../Source/Scene/Camera.js";
import {
  beginSecondaryViewportSegment,
  execute2DViewportCommands,
  executeWebVRCommands,
} from "../../Source/Scene/ViewportExecutor.js";

function cloneFrustum(frustum) {
  const clone = frustum.clone();
  if (Object.hasOwn(frustum, "xOffset")) {
    clone.xOffset = frustum.xOffset;
  }
  if (Object.hasOwn(frustum, "yOffset")) {
    clone.yOffset = frustum.yOffset;
  }
  return clone;
}

function expectFrustumToBeRestored(frustum, identity, values) {
  expect(frustum).toBe(identity);
  expect(frustum.equals(values)).toBe(true);
  expect(frustum.xOffset).toBe(values.xOffset);
  expect(frustum.yOffset).toBe(values.yOffset);
}

function create2DFixture() {
  const viewport = new BoundingRectangle(3.0, 4.0, 100.0, 80.0);
  const viewportValues = BoundingRectangle.clone(viewport);
  const passState = { viewport };

  const scene = {
    drawingBufferHeight: 80,
    drawingBufferWidth: 100,
    mapProjection: new GeographicProjection(),
  };
  const camera = new Camera(scene);
  Cartesian3.clone(new Cartesian3(4.0, 10.0, 12.0), camera.position);
  Cartesian3.clone(new Cartesian3(0.0, 0.0, -1.0), camera.direction);
  Cartesian3.clone(new Cartesian3(0.0, 1.0, 0.0), camera.up);
  Cartesian3.clone(new Cartesian3(1.0, 0.0, 0.0), camera.right);
  const transform = Matrix4.fromRotationTranslation(
    Matrix3.fromRotationZ(Math.PI * 0.25),
  );
  camera._setTransform(transform);

  const frustum = new OrthographicOffCenterFrustum();
  frustum.left = -20.0;
  frustum.right = 20.0;
  frustum.bottom = -10.0;
  frustum.top = 10.0;
  frustum.near = 0.1;
  frustum.far = 100.0;
  camera.frustum = frustum;

  const position = camera.position;
  const direction = camera.direction;
  const up = camera.up;
  const right = camera.right;
  const cameraTransform = camera.transform;
  const positionValues = Cartesian3.clone(position);
  const directionValues = Cartesian3.clone(direction);
  const upValues = Cartesian3.clone(up);
  const rightValues = Cartesian3.clone(right);
  const positionWCValues = Cartesian3.clone(camera.positionWC);
  const directionWCValues = Cartesian3.clone(camera.directionWC);
  const upWCValues = Cartesian3.clone(camera.upWC);
  const transformValues = Matrix4.clone(cameraTransform);
  const frustumValues = cloneFrustum(frustum);

  const cullingVolume = { name: "original-2D-culling-volume" };
  const uniformUpdates = [];
  const frameState = {
    camera,
    cullingVolume,
  };
  const uniformState = {
    update(updatedFrameState) {
      uniformUpdates.push({
        cullingVolume: updatedFrameState.cullingVolume,
        direction: Cartesian3.clone(camera.direction),
        directionWC: Cartesian3.clone(camera.directionWC),
        frustum: cloneFrustum(camera.frustum),
        position: Cartesian3.clone(camera.position),
        positionWC: Cartesian3.clone(camera.positionWC),
        transform: Matrix4.clone(camera.transform),
        up: Cartesian3.clone(camera.up),
        upWC: Cartesian3.clone(camera.upWC),
      });
    },
  };
  const cpuPhases = [];
  frameState._cpuSceneProfileFrameNumber = 41;
  frameState._cpuSceneProfileRenderer = {
    setCpuScenePhase(frameNumber, phase) {
      expect(frameNumber).toBe(41);
      cpuPhases.push(phase);
      return true;
    },
  };
  scene.camera = camera;
  scene.context = {
    clipSpaceConvention: undefined,
    uniformState,
  };
  scene.frameState = frameState;
  scene.mapProjection = {
    project(cartographic, result) {
      return Cartesian3.fromElements(10.0, 10.0, 0.0, result);
    },
  };
  scene._is2DViewportSplit = "original-split";
  scene._exec2DSceneFbLoad = "original-load";
  scene._exec2DDeferComposite = "original-defer";

  function expectRestored(expectUniforms = true) {
    expect(passState.viewport).toBe(viewport);
    expect(passState.viewport).toEqual(viewportValues);
    expect(camera.position).toBe(position);
    expect(camera.position).toEqual(positionValues);
    expect(camera.direction).toBe(direction);
    expect(camera.direction).toEqual(directionValues);
    expect(camera.up).toBe(up);
    expect(camera.up).toEqual(upValues);
    expect(camera.right).toBe(right);
    expect(camera.right).toEqual(rightValues);
    expect(camera.transform).toBe(cameraTransform);
    expect(Matrix4.equals(camera.transform, transformValues)).toBe(true);
    expect(camera.positionWC).toEqual(positionWCValues);
    expect(camera.directionWC).toEqual(directionWCValues);
    expect(camera.upWC).toEqual(upWCValues);
    expectFrustumToBeRestored(camera.frustum, frustum, frustumValues);
    expect(frameState.cullingVolume).toBe(cullingVolume);
    expect(scene._is2DViewportSplit).toBe("original-split");
    expect(scene._exec2DSceneFbLoad).toBe("original-load");
    expect(scene._exec2DDeferComposite).toBe("original-defer");
    expect(cpuPhases[cpuPhases.length - 1]).toBe("visibilityCommandPrep");

    if (!expectUniforms) {
      return;
    }
    const finalUniformUpdate = uniformUpdates[uniformUpdates.length - 1];
    expect(finalUniformUpdate.cullingVolume).toBe(cullingVolume);
    expect(finalUniformUpdate.position).toEqual(positionValues);
    expect(Matrix4.equals(finalUniformUpdate.transform, transformValues)).toBe(
      true,
    );
    expect(finalUniformUpdate.direction).toEqual(directionValues);
    expect(finalUniformUpdate.up).toEqual(upValues);
    expect(finalUniformUpdate.positionWC).toEqual(positionWCValues);
    expect(finalUniformUpdate.directionWC).toEqual(directionWCValues);
    expect(finalUniformUpdate.upWC).toEqual(upWCValues);
    expect(finalUniformUpdate.frustum.equals(frustumValues)).toBe(true);
  }

  return {
    cullingVolume,
    cpuPhases,
    expectRestored,
    camera,
    passState,
    scene,
    uniformState,
  };
}

function createWebVRFixture() {
  const viewport = new BoundingRectangle(7.0, 8.0, 120.0, 60.0);
  const viewportValues = BoundingRectangle.clone(viewport);
  const passState = { viewport };

  const position = new Cartesian3(10.0, 20.0, 30.0);
  const direction = new Cartesian3(0.0, 0.0, -1.0);
  const up = new Cartesian3(0.0, 1.0, 0.0);
  const right = new Cartesian3(1.0, 0.0, 0.0);
  const positionValues = Cartesian3.clone(position);
  const directionValues = Cartesian3.clone(direction);
  const upValues = Cartesian3.clone(up);
  const rightValues = Cartesian3.clone(right);
  const transform = Matrix4.fromTranslation(new Cartesian3(2.0, 3.0, 4.0));
  const transformValues = Matrix4.clone(transform);
  const frustum = new PerspectiveFrustum({
    aspectRatio: 2.0,
    fov: 1.0,
    near: 1.0,
    far: 500.0,
    xOffset: 0.25,
    yOffset: -0.125,
  });
  const frustumValues = cloneFrustum(frustum);

  const camera = {
    position,
    direction,
    up,
    right,
    frustum,
    transform,
    _transform: transform,
    _setTransform(value) {
      Matrix4.clone(value, this._transform);
    },
  };
  const savedCamera = {
    position: new Cartesian3(),
    direction: new Cartesian3(),
    up: new Cartesian3(),
    right: new Cartesian3(),
    transform: new Matrix4(),
  };

  const cullingVolume = { name: "original-WebVR-culling-volume" };
  const uniformCameraUpdates = [];
  const uniformState = {
    updateCamera(updatedCamera) {
      uniformCameraUpdates.push({
        direction: Cartesian3.clone(updatedCamera.direction),
        frustum: cloneFrustum(updatedCamera.frustum),
        position: Cartesian3.clone(updatedCamera.position),
        right: Cartesian3.clone(updatedCamera.right),
        transform: Matrix4.clone(updatedCamera.transform),
        up: Cartesian3.clone(updatedCamera.up),
      });
    },
    updatePass: jasmine.createSpy("updatePass"),
  };
  const frameState = {
    camera,
    commandList: [],
    context: {
      executeComputeCommands: jasmine.createSpy("executeComputeCommands"),
      uniformState,
    },
    cullingVolume,
    passes: {
      pick: false,
      pickVoxel: false,
    },
    shadowMaps: [],
    shadowState: {
      lastDirtyTime: 0,
      lightShadowMaps: [],
      shadowMaps: [],
      shadowsEnabled: false,
    },
  };
  const cpuPhases = [];
  frameState._cpuSceneProfileFrameNumber = 73;
  frameState._cpuSceneProfileRenderer = {
    setCpuScenePhase(frameNumber, phase) {
      expect(frameNumber).toBe(73);
      cpuPhases.push(phase);
      return true;
    },
  };
  const scene = {
    context: frameState.context,
    frameState,
    _frameState: frameState,
    _cameraVR: savedCamera,
    _computeCommandList: [],
    _computeEngine: {},
    _environmentState: {
      renderTranslucentDepthForPick: true,
    },
    _groundPrimitives: {
      update: jasmine.createSpy("groundPrimitivesUpdate"),
    },
    _primitives: {
      update: jasmine.createSpy("primitivesUpdate"),
    },
    _view: {
      camera,
      createPotentiallyVisibleSet: jasmine.createSpy(
        "createPotentiallyVisibleSet",
      ),
    },
    _is2DViewportSplit: "original-split",
    _exec2DSceneFbLoad: "original-load",
    _exec2DDeferComposite: "original-defer",
  };

  function expectRestored(expectUniforms = true) {
    expect(passState.viewport).toBe(viewport);
    expect(passState.viewport).toEqual(viewportValues);
    expect(camera.position).toBe(position);
    expect(camera.position).toEqual(positionValues);
    expect(camera.direction).toBe(direction);
    expect(camera.direction).toEqual(directionValues);
    expect(camera.up).toBe(up);
    expect(camera.up).toEqual(upValues);
    expect(camera.right).toBe(right);
    expect(camera.right).toEqual(rightValues);
    expect(camera.transform).toBe(transform);
    expect(Matrix4.equals(camera.transform, transformValues)).toBe(true);
    expectFrustumToBeRestored(camera.frustum, frustum, frustumValues);
    expect(frameState.cullingVolume).toBe(cullingVolume);
    expect(scene._is2DViewportSplit).toBe("original-split");
    expect(scene._exec2DSceneFbLoad).toBe("original-load");
    expect(scene._exec2DDeferComposite).toBe("original-defer");
    expect(cpuPhases[cpuPhases.length - 1]).toBe("visibilityCommandPrep");

    if (!expectUniforms) {
      return;
    }
    const finalUniformUpdate =
      uniformCameraUpdates[uniformCameraUpdates.length - 1];
    expect(finalUniformUpdate.position).toEqual(positionValues);
    expect(finalUniformUpdate.direction).toEqual(directionValues);
    expect(finalUniformUpdate.up).toEqual(upValues);
    expect(finalUniformUpdate.right).toEqual(rightValues);
    expect(Matrix4.equals(finalUniformUpdate.transform, transformValues)).toBe(
      true,
    );
    expect(finalUniformUpdate.frustum.equals(frustumValues)).toBe(true);
    expect(finalUniformUpdate.frustum.xOffset).toBe(frustumValues.xOffset);
    expect(finalUniformUpdate.frustum.yOffset).toBe(frustumValues.yOffset);
  }

  return {
    cullingVolume,
    cpuPhases,
    expectRestored,
    camera,
    passState,
    scene,
    uniformState,
  };
}

describe("Scene/ViewportExecutor", function () {
  it("segments the frame-local context before a wrapped second viewport", function () {
    const sceneContextBoundary = jasmine.createSpy("sceneContextBoundary");
    const frameContextBoundary = jasmine.createSpy("frameContextBoundary");
    const scene = {
      context: { beginSecondaryViewport: sceneContextBoundary },
      frameState: {
        context: { beginSecondaryViewport: frameContextBoundary },
      },
      _is2DViewportSplit: true,
    };

    beginSecondaryViewportSegment(false, scene);

    expect(frameContextBoundary).toHaveBeenCalledTimes(1);
    expect(sceneContextBoundary).not.toHaveBeenCalled();
  });

  it("does not segment a first or non-wrapped viewport", function () {
    const boundary = jasmine.createSpy("boundary");
    const scene = {
      frameState: { context: { beginSecondaryViewport: boundary } },
      _is2DViewportSplit: true,
    };

    beginSecondaryViewportSegment(true, scene);
    scene._is2DViewportSplit = false;
    beginSecondaryViewportSegment(false, scene);

    expect(boundary).not.toHaveBeenCalled();
  });

  for (const throwOnViewport of [1, 2]) {
    it(`restores 2D state when viewport ${throwOnViewport} throws and recovers`, function () {
      const fixture = create2DFixture();
      const primaryError = new Error(`2D viewport ${throwOnViewport}`);
      let executionCount = 0;
      const throwingExecutor = function (firstViewport, scene, passState) {
        executionCount++;
        scene._exec2DSceneFbLoad = !firstViewport;
        scene._exec2DDeferComposite = firstViewport;
        if (executionCount === throwOnViewport) {
          scene.camera.position = new Cartesian3(91.0, 92.0, 93.0);
          scene.camera.direction = new Cartesian3(1.0, 0.0, 0.0);
          scene.camera.up = new Cartesian3(0.0, 0.0, 1.0);
          scene.camera.right = new Cartesian3(0.0, 1.0, 0.0);
          scene.camera._transform = Matrix4.clone(Matrix4.IDENTITY);
          scene.camera.frustum = scene.camera.frustum.clone();
          scene.frameState.cullingVolume = { name: "mutated-2D-culling" };
          passState.viewport = new BoundingRectangle(90.0, 90.0, 9.0, 9.0);
          throw primaryError;
        }
      };

      let thrownError;
      try {
        execute2DViewportCommands(
          fixture.scene,
          fixture.passState,
          throwingExecutor,
        );
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBe(primaryError);
      expect(executionCount).toBe(throwOnViewport);
      fixture.expectRestored();

      const controlViewports = [];
      execute2DViewportCommands(
        fixture.scene,
        fixture.passState,
        function (firstViewport, scene, passState) {
          controlViewports.push({
            firstViewport,
            viewport: BoundingRectangle.clone(passState.viewport),
            position: Cartesian3.clone(scene.camera.position),
            frustum: cloneFrustum(scene.camera.frustum),
          });
          scene._exec2DSceneFbLoad = !firstViewport;
          scene._exec2DDeferComposite = firstViewport;
        },
      );

      expect(controlViewports.length).toBe(2);
      expect(controlViewports[0].firstViewport).toBe(true);
      expect(controlViewports[1].firstViewport).toBe(false);
      expect(controlViewports[0].viewport).toEqual(
        new BoundingRectangle(3.0, 4.0, 50.0, 80.0),
      );
      expect(controlViewports[1].viewport).toEqual(
        new BoundingRectangle(53.0, 4.0, 50.0, 80.0),
      );
      expect(controlViewports[0].position).toEqualEpsilon(
        new Cartesian3(4.0, 10.0, 12.0),
        1e-14,
      );
      expect(controlViewports[1].position).toEqualEpsilon(
        new Cartesian3(-4.0, 10.0, 12.0),
        1e-14,
      );
      expect(controlViewports[0].frustum.left).toBe(-20.0);
      expect(controlViewports[0].frustum.right).toBe(0.0);
      expect(controlViewports[1].frustum.left).toBe(0.0);
      expect(controlViewports[1].frustum.right).toBe(20.0);
      fixture.expectRestored();
    });
  }

  for (const throwOnEye of [1, 2]) {
    it(`restores WebVR state when eye ${throwOnEye} throws and recovers`, function () {
      const fixture = createWebVRFixture();
      const primaryError = new Error(`WebVR eye ${throwOnEye}`);
      let executionCount = 0;
      const throwingExecutor = function (scene, passState) {
        executionCount++;
        scene._is2DViewportSplit = true;
        scene._exec2DSceneFbLoad = true;
        scene._exec2DDeferComposite = true;
        if (executionCount === throwOnEye) {
          scene._view.camera.position = new Cartesian3(81.0, 82.0, 83.0);
          scene._view.camera.direction = new Cartesian3(1.0, 0.0, 0.0);
          scene._view.camera.up = new Cartesian3(0.0, 0.0, 1.0);
          scene._view.camera.right = new Cartesian3(0.0, 1.0, 0.0);
          scene._view.camera._transform = Matrix4.clone(Matrix4.IDENTITY);
          scene._view.camera.frustum = scene._view.camera.frustum.clone();
          scene.frameState.cullingVolume = { name: "mutated-WebVR-culling" };
          passState.viewport = new BoundingRectangle(80.0, 80.0, 8.0, 8.0);
          throw primaryError;
        }
      };

      let thrownError;
      try {
        executeWebVRCommands(
          fixture.scene,
          fixture.passState,
          undefined,
          throwingExecutor,
        );
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBe(primaryError);
      expect(executionCount).toBe(throwOnEye);
      fixture.expectRestored();

      const controlEyes = [];
      executeWebVRCommands(
        fixture.scene,
        fixture.passState,
        undefined,
        function (scene, passState) {
          controlEyes.push(BoundingRectangle.clone(passState.viewport));
          scene._is2DViewportSplit = true;
          scene._exec2DSceneFbLoad = true;
          scene._exec2DDeferComposite = true;
        },
      );

      expect(controlEyes.length).toBe(2);
      expect(controlEyes[0]).toEqual(
        new BoundingRectangle(0.0, 0.0, 60.0, 60.0),
      );
      expect(controlEyes[1]).toEqual(
        new BoundingRectangle(60.0, 0.0, 60.0, 60.0),
      );
      fixture.expectRestored();
    });
  }

  it("isolates nested 2D viewport transactions by execution depth", function () {
    const outer = create2DFixture();
    const inner = create2DFixture();
    let outerExecutions = 0;
    let innerExecutions = 0;

    execute2DViewportCommands(
      outer.scene,
      outer.passState,
      function (firstViewport) {
        outerExecutions++;
        if (firstViewport) {
          execute2DViewportCommands(inner.scene, inner.passState, function () {
            innerExecutions++;
          });
        }
      },
    );

    expect(outerExecutions).toBe(2);
    expect(innerExecutions).toBe(2);
    outer.expectRestored();
    inner.expectRestored();
  });

  it("isolates nested WebVR transactions by execution depth", function () {
    const outer = createWebVRFixture();
    const inner = createWebVRFixture();
    let outerExecutions = 0;
    let innerExecutions = 0;

    executeWebVRCommands(outer.scene, outer.passState, undefined, function () {
      outerExecutions++;
      if (outerExecutions === 1) {
        executeWebVRCommands(
          inner.scene,
          inner.passState,
          undefined,
          function () {
            innerExecutions++;
          },
        );
      }
    });

    expect(outerExecutions).toBe(2);
    expect(innerExecutions).toBe(2);
    outer.expectRestored();
    inner.expectRestored();
  });

  it("does not roll back legitimate WebVR prelude mutations when the prelude throws", function () {
    const fixture = createWebVRFixture();
    const preludeError = new Error("WebVR primitive prelude error");
    const replacementPosition = new Cartesian3(42.0, 43.0, 44.0);
    const replacementViewport = new BoundingRectangle(12.0, 13.0, 140.0, 70.0);
    fixture.scene._primitives.update = function () {
      fixture.camera.position = replacementPosition;
      fixture.passState.viewport = replacementViewport;
      throw preludeError;
    };

    let thrownError;
    try {
      executeWebVRCommands(fixture.scene, fixture.passState, undefined);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBe(preludeError);
    expect(fixture.camera.position).toBe(replacementPosition);
    expect(fixture.passState.viewport).toBe(replacementViewport);
    expect(fixture.cpuPhases[fixture.cpuPhases.length - 1]).toBe(
      "visibilityCommandPrep",
    );
  });

  it("keeps backgroundColor as the third WebVR argument", function () {
    const fixture = createWebVRFixture();
    let backgroundCalls = 0;
    let executorCalls = 0;
    const backgroundColor = function () {
      backgroundCalls++;
      throw new Error("backgroundColor called as executor");
    };

    executeWebVRCommands(
      fixture.scene,
      fixture.passState,
      backgroundColor,
      function () {
        executorCalls++;
      },
    );

    expect(backgroundCalls).toBe(0);
    expect(executorCalls).toBe(2);
    fixture.expectRestored();
  });

  it("propagates a cleanup error after a successful 2D body", function () {
    const fixture = create2DFixture();
    const cleanupError = new Error("2D cleanup-only error");
    const originalUpdate = fixture.uniformState.update;
    fixture.uniformState.update = function (frameState) {
      if (frameState.cullingVolume === fixture.cullingVolume) {
        throw cleanupError;
      }
      originalUpdate(frameState);
    };

    let thrownError;
    try {
      execute2DViewportCommands(
        fixture.scene,
        fixture.passState,
        function () {},
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBe(cleanupError);
    fixture.expectRestored(false);
  });

  it("restores absent scene transaction flags without creating own properties", function () {
    const fixture = create2DFixture();
    delete fixture.scene._is2DViewportSplit;
    delete fixture.scene._exec2DSceneFbLoad;
    delete fixture.scene._exec2DDeferComposite;

    execute2DViewportCommands(
      fixture.scene,
      fixture.passState,
      function (firstViewport, scene) {
        scene._is2DViewportSplit = true;
        scene._exec2DSceneFbLoad = !firstViewport;
        scene._exec2DDeferComposite = firstViewport;
      },
    );

    expect(Object.hasOwn(fixture.scene, "_is2DViewportSplit")).toBe(false);
    expect(Object.hasOwn(fixture.scene, "_exec2DSceneFbLoad")).toBe(false);
    expect(Object.hasOwn(fixture.scene, "_exec2DDeferComposite")).toBe(false);
    expect(fixture.cpuPhases[fixture.cpuPhases.length - 1]).toBe(
      "visibilityCommandPrep",
    );
  });

  it("preserves a 2D render error when uniform restoration also throws", function () {
    const fixture = create2DFixture();
    const primaryError = new Error("primary 2D render error");
    const cleanupError = new Error("2D uniform cleanup error");
    const originalUpdate = fixture.uniformState.update;
    fixture.uniformState.update = function (frameState) {
      if (frameState.cullingVolume === fixture.cullingVolume) {
        throw cleanupError;
      }
      originalUpdate(frameState);
    };

    let thrownError;
    try {
      execute2DViewportCommands(fixture.scene, fixture.passState, function () {
        throw primaryError;
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBe(primaryError);
    fixture.expectRestored(false);
  });

  it("preserves a WebVR render error when uniform restoration also throws", function () {
    const fixture = createWebVRFixture();
    const primaryError = new Error("primary WebVR render error");
    fixture.uniformState.updateCamera = function () {
      throw new Error("WebVR uniform cleanup error");
    };

    let thrownError;
    try {
      executeWebVRCommands(
        fixture.scene,
        fixture.passState,
        undefined,
        function () {
          throw primaryError;
        },
      );
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBe(primaryError);
    fixture.expectRestored(false);
  });
});
