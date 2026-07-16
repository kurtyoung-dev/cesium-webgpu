import Cartesian3 from "../../Source/Core/Cartesian3.js";
import Ellipsoid from "../../Source/Core/Ellipsoid.js";
import FeatureRendererKey from "../../Source/Renderer/FeatureRendererKey.js";
import Atmosphere from "../../Source/Scene/Atmosphere.js";
import SceneMode from "../../Source/Scene/SceneMode.js";
import StarField from "../../Source/Scene/StarField.js";

describe("Scene/StarField", function () {
  const cameraPosition = new Cartesian3(
    Ellipsoid.default.maximumRadius + 1000.0,
    0.0,
    0.0,
  );
  const daySunDirection = new Cartesian3(1.0, 0.0, 0.0);
  const nightSunDirection = new Cartesian3(-1.0, 0.0, 0.0);
  const twilightSolarAltitudeSine = -0.025;
  const twilightSunDirection = new Cartesian3(
    twilightSolarAltitudeSine,
    Math.sqrt(1.0 - twilightSolarAltitudeSine ** 2),
    0.0,
  );

  function createHarness(options) {
    options = options ?? {};
    const returnedCommand = {};
    const featureRenderer = {
      update: jasmine
        .createSpy("featureRenderer.update")
        .and.callFake(function (starField, frameState, commandList) {
          if (options.pushBinnedCommand !== false) {
            commandList.push({});
          }
          return returnedCommand;
        }),
      // C9-06 warm-keep hook: the zero-contribution (daylight) path calls
      // this to build/keep GPU resources warm so the first contributing dusk
      // frame does not cold-start (star pop-in). It never draws.
      prepare: jasmine.createSpy("featureRenderer.prepare"),
    };
    if (options.omitPrepare === true) {
      delete featureRenderer.prepare;
    }
    const getFeatureRenderer = jasmine
      .createSpy("getFeatureRenderer")
      .and.returnValue(featureRenderer);
    const frameState = {
      mode: SceneMode.SCENE3D,
      passes: {
        render: true,
      },
      context: {
        uniformState: {
          sunDirectionWC: options.sunDirection ?? nightSunDirection,
        },
        getFeatureRenderer: getFeatureRenderer,
      },
      camera: {
        positionWC: cameraPosition,
      },
      commandList: [],
      skyAtmosphereVisible: true,
      atmosphere: new Atmosphere(),
    };

    return {
      featureRenderer: featureRenderer,
      frameState: frameState,
      getFeatureRenderer: getFeatureRenderer,
      returnedCommand: returnedCommand,
    };
  }

  function seedStaleState(starField, frameState) {
    frameState.starZenithTransmittance = new Cartesian3(0.1, 0.2, 0.3);
    starField._zenithTransmittance = new Cartesian3(0.4, 0.5, 0.6);
    starField._wasBinned = true;
    starField._effectiveIntensityScale = 123.0;
  }

  function expectClearedState(starField, frameState) {
    expect(frameState.starZenithTransmittance).toBeUndefined();
    expect(starField._zenithTransmittance).toBeUndefined();
    expect(starField.wasBinned).toBe(false);
  }

  function expectValidExtinction(extinction) {
    expect(extinction).toEqual(jasmine.any(Cartesian3));
    for (const component of [extinction.x, extinction.y, extinction.z]) {
      expect(Number.isFinite(component)).toBe(true);
      expect(component).toBeGreaterThanOrEqual(0.0);
      expect(component).toBeLessThanOrEqual(1.0);
    }
  }

  it("skips feature-renderer draw work for an explicit zero intensity, warms via prepare, and clears stale state", function () {
    const starField = new StarField({ intensity: 0.0 });
    const harness = createHarness();
    seedStaleState(starField, harness.frameState);

    expect(starField.update(harness.frameState)).toBeUndefined();

    expect(starField._effectiveIntensityScale).toBe(0.0);
    expectClearedState(starField, harness.frameState);
    expect(harness.getFeatureRenderer).toHaveBeenCalledWith(
      FeatureRendererKey.STAR_FIELD,
    );
    // Warm-keep: prepare runs, draw does not.
    expect(harness.featureRenderer.prepare).toHaveBeenCalledWith(
      starField,
      harness.frameState,
    );
    expect(harness.featureRenderer.update).not.toHaveBeenCalled();
    // A zero-contribution warm-keep must not grow the command list.
    expect(harness.frameState.commandList.length).toBe(0);
  });

  it("skips feature-renderer draw work when the daytime fade reaches exactly zero, warms via prepare", function () {
    const starField = new StarField();
    const harness = createHarness({ sunDirection: daySunDirection });

    expect(starField.update(harness.frameState)).toBeUndefined();

    expect(starField._effectiveIntensityScale).toBe(0.0);
    expect(harness.getFeatureRenderer).toHaveBeenCalledWith(
      FeatureRendererKey.STAR_FIELD,
    );
    expect(harness.featureRenderer.prepare).toHaveBeenCalledTimes(1);
    expect(harness.featureRenderer.update).not.toHaveBeenCalled();
    expect(harness.frameState.commandList.length).toBe(0);
  });

  it("tolerates a feature renderer that exposes no prepare warm-keep hook", function () {
    const starField = new StarField({ intensity: 0.0 });
    const harness = createHarness({ omitPrepare: true });

    expect(function () {
      starField.update(harness.frameState);
    }).not.toThrow();

    expect(starField.update(harness.frameState)).toBeUndefined();
    expect(harness.featureRenderer.update).not.toHaveBeenCalled();
  });

  it("immediately restores dispatch and publishes extinction at night and twilight", function () {
    const starField = new StarField();
    const harness = createHarness({ sunDirection: daySunDirection });

    expect(starField.update(harness.frameState)).toBeUndefined();
    expect(harness.featureRenderer.update).not.toHaveBeenCalled();

    for (const sunDirection of [nightSunDirection, twilightSunDirection]) {
      harness.frameState.context.uniformState.sunDirectionWC = sunDirection;
      harness.frameState.commandList.length = 0;

      expect(starField.update(harness.frameState)).toBe(
        harness.returnedCommand,
      );
      expect(starField._effectiveIntensityScale).toBeGreaterThan(0.0);
      expectValidExtinction(harness.frameState.starZenithTransmittance);
      expectValidExtinction(starField._zenithTransmittance);
      expect(starField.wasBinned).toBe(true);
    }

    expect(harness.featureRenderer.update).toHaveBeenCalledTimes(2);
  });

  it("clears stale state while hidden, outside a render pass, or in 2D and Columbus View", function () {
    const cases = [
      {
        name: "hidden",
        configure: function (starField) {
          starField.show = false;
        },
      },
      {
        name: "non-render pass",
        configure: function (starField, frameState) {
          frameState.passes.render = false;
        },
      },
      {
        name: "2D",
        configure: function (starField, frameState) {
          frameState.mode = SceneMode.SCENE2D;
        },
      },
      {
        name: "Columbus View",
        configure: function (starField, frameState) {
          frameState.mode = SceneMode.COLUMBUS_VIEW;
        },
      },
    ];

    for (const testCase of cases) {
      const starField = new StarField();
      const harness = createHarness();
      seedStaleState(starField, harness.frameState);
      testCase.configure(starField, harness.frameState);

      expect(starField.update(harness.frameState))
        .withContext(testCase.name)
        .toBeUndefined();
      expectClearedState(starField, harness.frameState);
      expect(starField._effectiveIntensityScale)
        .withContext(testCase.name)
        .toBe(0.0);
      expect(harness.getFeatureRenderer)
        .withContext(testCase.name)
        .not.toHaveBeenCalled();
    }
  });

  it("dispatches a negative nonzero effective intensity", function () {
    const starField = new StarField({ intensity: -2.0 });
    const harness = createHarness();

    expect(starField.update(harness.frameState)).toBe(harness.returnedCommand);

    expect(starField._effectiveIntensityScale).toBe(-2.0);
    expect(harness.featureRenderer.update).toHaveBeenCalledTimes(1);
  });

  it("exposes the effective scale during feature-renderer invocation and detects binned work", function () {
    const starField = new StarField({ intensity: 2.5 });
    const harness = createHarness();
    const observedScales = [];
    harness.featureRenderer.update.and.callFake(
      function (primitive, frameState, commandList) {
        observedScales.push(primitive._effectiveIntensityScale);
        commandList.push({});
        return harness.returnedCommand;
      },
    );

    expect(starField.update(harness.frameState)).toBe(harness.returnedCommand);

    expect(observedScales).toEqual([2.5]);
    expect(harness.getFeatureRenderer).toHaveBeenCalledWith(
      FeatureRendererKey.STAR_FIELD,
    );
    expect(harness.featureRenderer.update).toHaveBeenCalledWith(
      starField,
      harness.frameState,
      harness.frameState.commandList,
    );
    expect(starField.wasBinned).toBe(true);

    harness.frameState.commandList.length = 0;
    harness.featureRenderer.update.and.callFake(function (primitive) {
      observedScales.push(primitive._effectiveIntensityScale);
      return harness.returnedCommand;
    });

    expect(starField.update(harness.frameState)).toBe(harness.returnedCommand);
    expect(observedScales).toEqual([2.5, 2.5]);
    expect(starField.wasBinned).toBe(false);
  });
});
