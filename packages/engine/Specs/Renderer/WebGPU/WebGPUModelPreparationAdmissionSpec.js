import BoundingSphere from "../../../Source/Core/BoundingSphere.js";
import Cartesian3 from "../../../Source/Core/Cartesian3.js";
import Cartesian4 from "../../../Source/Core/Cartesian4.js";
import CullingVolume from "../../../Source/Core/CullingVolume.js";
import Matrix4 from "../../../Source/Core/Matrix4.js";
import SceneMode from "../../../Source/Scene/SceneMode.js";
import ShadowMode from "../../../Source/Scene/ShadowMode.js";
import {
  WebGPUModelPreparationDemand,
  WebGPUModelPreparationReason,
  classifyWebGPUModelPreparationDemand,
  consumeWebGPUModelPreparationAdmissionGap,
  getWebGPUModelPreparationStatistics,
  markWebGPUModelPreparationRejected,
  recordWebGPUModelPreparationDecision,
} from "../../../Source/Renderer/WebGPU/WebGPUModelPreparationAdmission.js";
import {
  areWebGPUModelColorPipelinesReady,
  prepareWebGPUModel,
  preparePackedJointHistoryForFrame,
  resolvePreviousMatrixForFrame,
  updateWebGPUModel,
} from "../../../Source/Renderer/WebGPU/WebGPUModelRenderer.js";

describe("Renderer/WebGPU/WebGPUModelPreparationAdmission", function () {
  function makeCullingVolume() {
    return new CullingVolume([
      new Cartesian4(1.0, 0.0, 0.0, 0.0),
      new Cartesian4(1.0, 0.0, 0.0, 100.0),
      new Cartesian4(0.0, 1.0, 0.0, 100.0),
      new Cartesian4(0.0, -1.0, 0.0, 100.0),
      new Cartesian4(0.0, 0.0, 1.0, 100.0),
      // View intentionally drops this sixth/far plane.
      new Cartesian4(-1.0, 0.0, 0.0, 0.0),
    ]);
  }

  function makeModel(centerX = -10.0) {
    const boundingSphere = new BoundingSphere(
      new Cartesian3(centerX, 0.0, 0.0),
      1.0,
    );
    return {
      _cull: true,
      _boundingSphere: boundingSphere,
      boundingSphere: boundingSphere,
      shadows: ShadowMode.DISABLED,
    };
  }

  function makeFrameState() {
    return {
      frameNumber: 7,
      mode: SceneMode.SCENE3D,
      passes: {
        render: true,
        pick: false,
        pickVoxel: false,
        offscreen: false,
      },
      shadowMaps: [],
      cullingVolume: makeCullingVolume(),
    };
  }

  function makeContext() {
    return {
      sceneCaptureReflections: false,
      supportsStereoViewport: false,
    };
  }

  it("rejects only a finite standalone sphere outside View's five-plane volume", function () {
    const outside = classifyWebGPUModelPreparationDemand(
      makeModel(-10.0),
      makeFrameState(),
      makeContext(),
    );
    expect(outside.demand).toBe(WebGPUModelPreparationDemand.REJECTED);
    expect(outside.reason).toBe(WebGPUModelPreparationReason.FRUSTUM_OUTSIDE);

    // The sixth plane rejects x=10, but View omits it. Slice 1 must do the same.
    const insideFivePlanes = classifyWebGPUModelPreparationDemand(
      makeModel(10.0),
      makeFrameState(),
      makeContext(),
    );
    expect(insideFivePlanes.demand).toBe(WebGPUModelPreparationDemand.VIEW);
    expect(insideFivePlanes.reason).toBe(
      WebGPUModelPreparationReason.VIEW_INTERSECTING,
    );
  });

  it("uses Model.update's current internal sphere without invoking the public getter", function () {
    const model = makeModel(-10.0);
    Object.defineProperty(model, "boundingSphere", {
      get: function () {
        throw new Error("public boundingSphere getter was invoked");
      },
    });

    const result = classifyWebGPUModelPreparationDemand(
      model,
      makeFrameState(),
      makeContext(),
    );
    expect(result.demand).toBe(WebGPUModelPreparationDemand.REJECTED);
    expect(result.reason).toBe(WebGPUModelPreparationReason.FRUSTUM_OUTSIDE);
  });

  it("admits capture and active CAST/BOTH shadow demand before camera rejection", function () {
    const frameState = makeFrameState();
    const model = makeModel(-10.0);
    const captureContext = makeContext();
    captureContext.sceneCaptureReflections = true;

    expect(
      classifyWebGPUModelPreparationDemand(model, frameState, captureContext)
        .demand,
    ).toBe(WebGPUModelPreparationDemand.CAPTURE);

    frameState.shadowMaps.push({});
    model.shadows = ShadowMode.ENABLED;
    expect(
      classifyWebGPUModelPreparationDemand(model, frameState, makeContext())
        .demand,
    ).toBe(WebGPUModelPreparationDemand.SHADOW);

    model.shadows = ShadowMode.CAST_ONLY;
    expect(
      classifyWebGPUModelPreparationDemand(model, frameState, makeContext())
        .demand,
    ).toBe(WebGPUModelPreparationDemand.SHADOW);

    model.shadows = ShadowMode.RECEIVE_ONLY;
    expect(
      classifyWebGPUModelPreparationDemand(model, frameState, makeContext())
        .demand,
    ).toBe(WebGPUModelPreparationDemand.REJECTED);
  });

  it("never rejects the exact tile-owned, tile-culled model shape", function () {
    const model = makeModel(-10.0);
    model._content = {};
    model._cull = false;

    const result = classifyWebGPUModelPreparationDemand(
      model,
      makeFrameState(),
      makeContext(),
    );
    expect(result.demand).toBe(WebGPUModelPreparationDemand.CONSERVATIVE);
    expect(result.reason).toBe(WebGPUModelPreparationReason.TILE_OWNED);
  });

  it("falls back for a finite culling plane whose normal is not normalized", function () {
    const frameState = makeFrameState();
    frameState.cullingVolume.planes[0].x = 2.0;

    const result = classifyWebGPUModelPreparationDemand(
      makeModel(),
      frameState,
      makeContext(),
    );
    expect(result.demand).toBe(WebGPUModelPreparationDemand.CONSERVATIVE);
    expect(result.reason).toBe(
      WebGPUModelPreparationReason.CULLING_VOLUME_INVALID,
    );
  });

  it("falls back conservatively for every unsupported or uncertain lane", function () {
    const cases = [
      {
        mutate: (model, frameState) =>
          (frameState.mode = SceneMode.COLUMBUS_VIEW),
        reason: WebGPUModelPreparationReason.NON_3D_MODE,
      },
      {
        mutate: (model, frameState) => (frameState.passes.pick = true),
        reason: WebGPUModelPreparationReason.PICK_PASS,
      },
      {
        mutate: (model, frameState) => (frameState.passes.offscreen = true),
        reason: WebGPUModelPreparationReason.OFFSCREEN_PASS,
      },
      {
        mutate: (model) => (model.classificationType = 0),
        reason: WebGPUModelPreparationReason.CLASSIFIER,
      },
      {
        mutate: (model) => (model._content = {}),
        reason: WebGPUModelPreparationReason.TILE_OWNED,
      },
      {
        mutate: (model) => (model._cull = false),
        reason: WebGPUModelPreparationReason.CULL_DISABLED,
      },
      {
        mutate: (model) => (model._minimumPixelSize = 64.0),
        reason: WebGPUModelPreparationReason.MINIMUM_PIXEL_SIZE,
      },
      {
        mutate: (model) => {
          model._boundingSphere = undefined;
          model.boundingSphere = undefined;
        },
        reason: WebGPUModelPreparationReason.BOUNDS_MISSING,
      },
      {
        mutate: (model) => (model._boundingSphere.radius = Number.NaN),
        reason: WebGPUModelPreparationReason.BOUNDS_INVALID,
      },
      {
        mutate: (model, frameState) =>
          (frameState.cullingVolume.planes[0].x = Number.NaN),
        reason: WebGPUModelPreparationReason.CULLING_VOLUME_INVALID,
      },
      {
        mutate: (model, frameState, context) =>
          (context.supportsStereoViewport = true),
        reason: WebGPUModelPreparationReason.STEREO_UNCERTAIN,
      },
      {
        mutate: (model, frameState, context) =>
          (context.sceneCaptureReflections = undefined),
        reason: WebGPUModelPreparationReason.CAPTURE_UNCERTAIN,
      },
      {
        mutate: (model, frameState) => (frameState.shadowMaps = undefined),
        reason: WebGPUModelPreparationReason.SHADOW_STATE_UNCERTAIN,
      },
      {
        mutate: (model) => (model.shadows = 99),
        reason: WebGPUModelPreparationReason.SHADOW_MODE_UNCERTAIN,
      },
      {
        mutate: (model) => (model.shadows = undefined),
        reason: WebGPUModelPreparationReason.SHADOW_MODE_UNCERTAIN,
      },
      {
        mutate: (model) => (model.shadows = null),
        reason: WebGPUModelPreparationReason.SHADOW_MODE_UNCERTAIN,
      },
      {
        mutate: (model) => (model.shadows = "enabled"),
        reason: WebGPUModelPreparationReason.SHADOW_MODE_UNCERTAIN,
      },
    ];

    for (const testCase of cases) {
      const model = makeModel();
      const frameState = makeFrameState();
      const context = makeContext();
      testCase.mutate(model, frameState, context);
      const result = classifyWebGPUModelPreparationDemand(
        model,
        frameState,
        context,
      );
      expect(result.demand)
        .withContext(testCase.reason)
        .toBe(WebGPUModelPreparationDemand.CONSERVATIVE);
      expect(result.reason).toBe(testCase.reason);
    }
  });

  it("reuses frame-owned counters and resets them on frame-number change", function () {
    const frameState = makeFrameState();
    const context = makeContext();
    context._webgpuModelPreparationDiagnosticsEnabled = true;
    const statistics = getWebGPUModelPreparationStatistics(frameState, context);
    const rejected = classifyWebGPUModelPreparationDemand(
      makeModel(),
      frameState,
      makeContext(),
    );
    const visible = classifyWebGPUModelPreparationDemand(
      makeModel(10.0),
      frameState,
      makeContext(),
    );

    recordWebGPUModelPreparationDecision(statistics, rejected);
    recordWebGPUModelPreparationDecision(statistics, visible);
    expect(statistics.candidates).toBe(2);
    expect(statistics.rejected).toBe(1);
    expect(statistics.viewAdmitted).toBe(1);
    expect(
      statistics.reasons[WebGPUModelPreparationReason.FRUSTUM_OUTSIDE],
    ).toBe(1);

    frameState.frameNumber++;
    const nextFrame = getWebGPUModelPreparationStatistics(frameState, context);
    expect(nextFrame).toBe(statistics);
    expect(nextFrame.frameNumber).toBe(8);
    expect(nextFrame.candidates).toBe(0);
    expect(nextFrame.work.preparationRuns).toBe(0);
  });

  it("marks an allocation-free admission gap and consumes it once", function () {
    const model = {};
    expect(consumeWebGPUModelPreparationAdmissionGap(model)).toBe(false);
    expect(model._webgpuPreparationAdmissionGap).toBeUndefined();
    markWebGPUModelPreparationRejected(model);
    expect(model._webgpuPreparationAdmissionGap).toBe(true);
    expect(consumeWebGPUModelPreparationAdmissionGap(model)).toBe(true);
    expect(model._webgpuPreparationAdmissionGap).toBe(false);
    expect(consumeWebGPUModelPreparationAdmissionGap(model)).toBe(false);
  });

  it("keeps diagnostics allocation-free by default while rejection still works", function () {
    const context = makeContext();
    Object.defineProperty(context, "device", {
      get: function () {
        throw new Error("rejected preparation touched the GPU device");
      },
    });
    const frameState = {
      ...makeFrameState(),
      context: context,
      commandList: [],
    };
    const model = {
      ...makeModel(),
      show: true,
      ready: true,
      modelMatrix: Matrix4.clone(Matrix4.IDENTITY),
    };

    expect(function () {
      updateWebGPUModel(model, frameState);
    }).not.toThrow();
    expect(model._webgpuCache).toBeUndefined();
    expect(model._webgpuPreparationAdmissionGap).toBe(true);
    expect(frameState.commandList.length).toBe(0);
    expect(frameState._webgpuModelPreparationStatistics).toBeUndefined();
    expect(
      getWebGPUModelPreparationStatistics(frameState, context),
    ).toBeUndefined();
  });

  it("reports native color readiness only after every local pipeline settles", function () {
    const pending = new Map();
    const model = {
      _webgpuCache: {
        pipelineCache: { _pendingColorPipelines: pending },
        primitives: {
          first: { pipeline: null },
          second: { pipeline: {} },
        },
      },
    };

    expect(areWebGPUModelColorPipelinesReady({})).toBe(false);
    expect(areWebGPUModelColorPipelinesReady(model)).toBe(false);

    model._webgpuCache.primitives.first.pipeline = {};
    pending.set("variant", Promise.resolve({}));
    expect(areWebGPUModelColorPipelinesReady(model)).toBe(false);

    pending.clear();
    expect(areWebGPUModelColorPipelinesReady(model)).toBe(true);
  });

  it("keeps hidden, tile-owned, and rejected models demand-driven", function () {
    const context = makeContext();
    Object.defineProperty(context, "device", {
      get: function () {
        throw new Error("demand-driven preparation touched the GPU device");
      },
    });
    const frameState = {
      ...makeFrameState(),
      context: context,
      commandList: [],
    };

    const hidden = {
      ...makeModel(10.0),
      show: false,
      ready: false,
      modelMatrix: Matrix4.clone(Matrix4.IDENTITY),
    };
    expect(prepareWebGPUModel(hidden, frameState)).toBe(true);

    const tileOwned = {
      ...hidden,
      show: true,
      _content: {},
    };
    expect(prepareWebGPUModel(tileOwned, frameState)).toBe(true);

    const outside = {
      ...hidden,
      show: true,
      _boundingSphere: makeModel(-10.0)._boundingSphere,
    };
    expect(prepareWebGPUModel(outside, frameState)).toBe(true);
    expect(outside._webgpuCache).toBeUndefined();
    expect(frameState.commandList.length).toBe(0);
  });

  it("records opt-in counters before device/cache/upload/command preparation", function () {
    const context = makeContext();
    context._webgpuModelPreparationDiagnosticsEnabled = true;
    Object.defineProperty(context, "device", {
      get: function () {
        throw new Error("rejected preparation touched the GPU device");
      },
    });
    const frameState = {
      ...makeFrameState(),
      context: context,
      commandList: [],
    };
    const model = {
      ...makeModel(),
      show: true,
      ready: true,
      modelMatrix: Matrix4.clone(Matrix4.IDENTITY),
    };

    expect(function () {
      updateWebGPUModel(model, frameState);
    }).not.toThrow();
    expect(model._webgpuCache).toBeUndefined();
    expect(model._webgpuPreparationAdmissionGap).toBe(true);
    expect(frameState.commandList.length).toBe(0);

    const statistics = getWebGPUModelPreparationStatistics(frameState, context);
    expect(statistics.rejected).toBe(1);
    expect(statistics.work.preparationRuns).toBe(0);
    expect(statistics.work.cameraPacks).toBe(0);
    expect(statistics.work.materialPacks).toBe(0);
    expect(statistics.work.lightPacks).toBe(0);
    expect(statistics.work.commandsEmitted).toBe(0);
  });

  it("resets transform and joint history to current on first readmission", function () {
    const oldMatrix = Matrix4.fromTranslation(new Cartesian3(1.0, 0.0, 0.0));
    const currentMatrix = Matrix4.fromTranslation(
      new Cartesian3(10.0, 0.0, 0.0),
    );
    const host = { prevModelMatrix: Matrix4.clone(oldMatrix) };
    const previous = resolvePreviousMatrixForFrame(
      host,
      "prevModelMatrix",
      currentMatrix,
      true,
    );
    expect(previous).toBe(host.prevModelMatrix);
    expect(Matrix4.equals(previous, currentMatrix)).toBe(true);

    const nodeCache = {
      packedJointMatrices: new Float32Array(Matrix4.toArray(oldMatrix)),
      prevPackedJointMatrices: new Float32Array(Matrix4.toArray(oldMatrix)),
    };
    const runtimeNode = {
      _runtimeSkin: {},
      computedJointMatrices: [currentMatrix],
    };
    preparePackedJointHistoryForFrame(runtimeNode, nodeCache, true);
    expect(Array.from(nodeCache.packedJointMatrices)).toEqual(
      Matrix4.toArray(currentMatrix),
    );
    expect(Array.from(nodeCache.prevPackedJointMatrices)).toEqual(
      Matrix4.toArray(currentMatrix),
    );
  });
});
