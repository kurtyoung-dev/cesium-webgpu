import {
  hasEnvironmentalEffectDemand,
  shouldExecuteWebGPUSceneFrame,
} from "../../../Source/Renderer/WebGPU/WebGPUSceneRendererEnvironmentDemand.js";

describe("Renderer/WebGPU/WebGPUSceneRenderer environment demand", function () {
  function makeScene() {
    return {
      _enableSSR: false,
      _enableNPROutlines: false,
      _enableContactShadows: false,
      _enableWeather: false,
      globe: {
        defaultCloudCollection: {
          renderMode: 0,
          volumetric: { enabled: false },
        },
      },
      _frameState: {
        atmosphericConditions: {
          volumetricFog: { enabled: false },
          effects: { groundFog: { enabled: false } },
        },
      },
    };
  }

  it("keeps the true-empty/no-effect fast path", function () {
    const scene = makeScene();
    const context = { hasVolumetricCloudRequest: false };

    expect(hasEnvironmentalEffectDemand(scene, context)).toBe(false);
    expect(shouldExecuteWebGPUSceneFrame(0, scene, context)).toBe(false);
  });

  it("always executes a frame that has a command frustum", function () {
    expect(shouldExecuteWebGPUSceneFrame(1, makeScene(), {})).toBe(true);
  });

  it("executes an empty frame for the managed volumetric cloud deck", function () {
    const scene = makeScene();
    scene.globe.defaultCloudCollection.renderMode = 1;
    scene.globe.defaultCloudCollection.volumetric.enabled = true;

    expect(hasEnvironmentalEffectDemand(scene, {})).toBe(true);
    expect(shouldExecuteWebGPUSceneFrame(0, scene, {})).toBe(true);
  });

  it("does not treat a disabled managed cloud deck as work", function () {
    const scene = makeScene();
    scene.globe.defaultCloudCollection.renderMode = 1;

    expect(hasEnvironmentalEffectDemand(scene, {})).toBe(false);
    expect(shouldExecuteWebGPUSceneFrame(0, scene, {})).toBe(false);
  });

  it("executes an empty frame for a user-published volumetric deck without consuming it", function () {
    let reads = 0;
    const context = {
      get hasVolumetricCloudRequest() {
        reads++;
        return true;
      },
      consumeVolumetricCloudRequest: jasmine.createSpy("consume"),
    };

    expect(shouldExecuteWebGPUSceneFrame(0, makeScene(), context)).toBe(true);
    expect(reads).toBe(1);
    expect(context.consumeVolumetricCloudRequest).not.toHaveBeenCalled();
  });

  it("recognizes every non-cloud environmental consumer", function () {
    const activate = [
      (scene) => {
        scene._enableSSR = true;
      },
      (scene) => {
        scene._enableNPROutlines = true;
      },
      (scene) => {
        scene._enableContactShadows = true;
      },
      (scene) => {
        scene._enableWeather = true;
      },
      (scene) => {
        scene._frameState.atmosphericConditions.volumetricFog.enabled = true;
      },
      (scene) => {
        scene._frameState.atmosphericConditions.effects.groundFog.enabled = true;
      },
    ];

    for (const enable of activate) {
      const scene = makeScene();
      enable(scene);
      expect(shouldExecuteWebGPUSceneFrame(0, scene, {})).toBe(true);
    }
  });
});
