import {
  hasInjectedEnvironmentContent,
  needsEnvironmentOnlyFrustum,
} from "../../Source/Scene/EnvironmentFrustumDemand.js";

describe("Scene/EnvironmentFrustumDemand", function () {
  const drawCommand = () => ({ execute: function () {} });

  // A scene on the injection convention (an alternate scene renderer is
  // installed) in a render pass, with every environment slot empty.
  function makeScene() {
    return {
      _alternateSceneRenderer: {},
      _environmentState: {
        skyBoxCommand: undefined,
        starFieldCommand: undefined,
        skyAtmosphereCommand: undefined,
        sunDrawCommand: undefined,
        moonCommand: undefined,
        isSkyAtmosphereVisible: false,
        isSunVisible: false,
        isMoonVisible: false,
      },
      _frameState: {
        passes: { render: true },
        panoramaCommandList: [],
      },
    };
  }

  it("reports no demand for an all-off environment", function () {
    expect(hasInjectedEnvironmentContent(makeScene())).toBe(false);
  });

  it("tolerates a missing scene or environment state", function () {
    expect(hasInjectedEnvironmentContent(undefined)).toBe(false);
    expect(hasInjectedEnvironmentContent(null)).toBe(false);
    const scene = makeScene();
    scene._environmentState = undefined;
    expect(hasInjectedEnvironmentContent(scene)).toBe(false);
  });

  it("demands a frustum for each environment element independently", function () {
    const enable = [
      (scene) => {
        scene._environmentState.skyBoxCommand = drawCommand();
      },
      (scene) => {
        scene._environmentState.starFieldCommand = drawCommand();
      },
      (scene) => {
        scene._environmentState.skyAtmosphereCommand = drawCommand();
        scene._environmentState.isSkyAtmosphereVisible = true;
      },
      (scene) => {
        scene._environmentState.sunDrawCommand = drawCommand();
        scene._environmentState.isSunVisible = true;
      },
      (scene) => {
        scene._environmentState.moonCommand = drawCommand();
        scene._environmentState.isMoonVisible = true;
      },
      (scene) => {
        scene._frameState.panoramaCommandList.push(drawCommand());
      },
    ];

    for (const activate of enable) {
      const scene = makeScene();
      activate(scene);
      expect(hasInjectedEnvironmentContent(scene)).toBe(true);
    }
  });

  it("ignores culled atmosphere/sun/moon commands", function () {
    const gated = ["skyAtmosphereCommand", "sunDrawCommand", "moonCommand"];
    for (const slot of gated) {
      const scene = makeScene();
      scene._environmentState[slot] = drawCommand();
      expect(hasInjectedEnvironmentContent(scene)).toBe(false);
    }
  });

  it("ignores commands the injector could not execute", function () {
    const scene = makeScene();
    scene._environmentState.skyBoxCommand = {};
    expect(hasInjectedEnvironmentContent(scene)).toBe(false);
  });

  it("is inert on renderers that execute the environment directly", function () {
    const scene = makeScene();
    scene._alternateSceneRenderer = null;
    scene._environmentState.skyBoxCommand = drawCommand();
    expect(hasInjectedEnvironmentContent(scene)).toBe(false);
  });

  it("is inert outside the render pass", function () {
    const scene = makeScene();
    scene._frameState.passes.render = false;
    scene._environmentState.skyBoxCommand = drawCommand();
    expect(hasInjectedEnvironmentContent(scene)).toBe(false);
  });

  it("only restores the camera window when nothing set near/far", function () {
    const scene = makeScene();
    scene._environmentState.skyBoxCommand = drawCommand();
    // Geometry already produced a valid range — never widen it.
    expect(needsEnvironmentOnlyFrustum(10.0, 1000.0, false, scene)).toBe(false);
    expect(needsEnvironmentOnlyFrustum(10.0, 10.0, true, scene)).toBe(false);
  });

  it("keeps the C10-01 binned-environment fallback", function () {
    const scene = makeScene();
    expect(
      needsEnvironmentOnlyFrustum(
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        true,
        scene,
      ),
    ).toBe(true);
  });

  it("restores the camera window for inject-only environment content", function () {
    const scene = makeScene();
    scene._environmentState.moonCommand = drawCommand();
    scene._environmentState.isMoonVisible = true;
    expect(
      needsEnvironmentOnlyFrustum(
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        false,
        scene,
      ),
    ).toBe(true);
  });

  it("leaves a genuinely empty frame with zero frustums", function () {
    expect(
      needsEnvironmentOnlyFrustum(
        Number.MAX_VALUE,
        -Number.MAX_VALUE,
        false,
        makeScene(),
      ),
    ).toBe(false);
  });
});
