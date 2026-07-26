import {
  Atmosphere,
  BoundingSphere,
  Cartesian3,
  Color,
  Ellipsoid,
  Math as CesiumMath,
  SceneMode,
  Sun,
} from "../../index.js";

import createScene from "../../../../Specs/createScene.js";

describe(
  "Scene/Sun",
  function () {
    let scene;
    const backgroundColor = [255, 0, 0, 255];

    beforeAll(function () {
      scene = createScene();
      scene.backgroundColor = Color.unpack(backgroundColor);
    });

    afterAll(function () {
      scene.destroyForSpecs();
    });

    beforeEach(function () {
      scene.mode = SceneMode.SCENE3D;
    });

    afterEach(function () {
      scene.sun = undefined;
    });

    function viewSun(camera, uniformState) {
      const sunPosition = uniformState.sunPositionWC;
      const bounds = new BoundingSphere(sunPosition, CesiumMath.SOLAR_RADIUS);
      camera.viewBoundingSphere(bounds);
    }

    function createFeatureRendererHarness() {
      const innerRadius = Ellipsoid.default.maximumRadius;
      const drawCommand = {};
      const featureRenderer = {
        update: jasmine
          .createSpy("featureRenderer.update")
          .and.returnValue(drawCommand),
      };
      const frameState = {
        mode: SceneMode.SCENE3D,
        passes: {
          render: true,
        },
        context: {
          uniformState: {
            sunPositionWC: new Cartesian3(
              innerRadius + 1000.0,
              384400000.0,
              0.0,
            ),
          },
          getFeatureRenderer: jasmine
            .createSpy("getFeatureRenderer")
            .and.returnValue(featureRenderer),
        },
        camera: {
          positionWC: new Cartesian3(innerRadius + 1000.0, 0.0, 0.0),
        },
        commandList: [],
        skyAtmosphereVisible: true,
        atmosphere: new Atmosphere(),
      };

      return {
        featureRenderer: featureRenderer,
        frameState: frameState,
      };
    }

    function updateWithFeatureRenderer(sun, frameState) {
      const commandListLength = frameState.commandList.length;
      const commands = sun.update(frameState);
      const featureRenderer =
        frameState.context.getFeatureRenderer.calls.mostRecent().returnValue;
      expect(commands.drawCommand).toBe(
        featureRenderer.update.calls.mostRecent().returnValue,
      );
      expect(frameState.commandList.length).toBe(commandListLength);
    }

    it("draws in 3D", function () {
      expect(scene).toRender(backgroundColor);
      scene.sun = new Sun();
      scene.sun.glowFactor = 100;
      scene.render();

      viewSun(scene.camera, scene.context.uniformState);
      expect(scene).notToRender(backgroundColor);
    });

    it("draws in Columbus view", function () {
      expect(scene).toRender(backgroundColor);
      scene.mode = SceneMode.COLUMBUS_VIEW;
      scene.sun = new Sun();
      scene.render();

      viewSun(scene.camera, scene.context.uniformState);
      expect(scene).notToRender(backgroundColor);
    });

    it("does not render when show is false", function () {
      expect(scene).toRender(backgroundColor);
      scene.sun = new Sun();
      scene.render();
      scene.sun.show = false;

      viewSun(scene.camera, scene.context.uniformState);
      expect(scene).toRender(backgroundColor);
    });

    it("does not render in 2D", function () {
      expect(scene).toRender(backgroundColor);
      scene.mode = SceneMode.SCENE2D;
      scene.sun = new Sun();
      scene.render();

      viewSun(scene.camera, scene.context.uniformState);
      expect(scene).toRender(backgroundColor);
    });

    it("does not render without a render pass", function () {
      scene.sun = new Sun();
      scene.render();

      viewSun(scene.camera, scene.context.uniformState);
      scene.frameState.passes.render = false;
      const command = scene.sun.update(scene.frameState, scene.view.passState);
      expect(command).not.toBeDefined();
    });

    it("can set glow factor", function () {
      const sun = (scene.sun = new Sun());
      sun.glowFactor = 0.0;
      expect(sun.glowFactor).toEqual(0.0);
      sun.glowFactor = 2.0;
      expect(sun.glowFactor).toEqual(2.0);
    });

    it("draws without lens flare", function () {
      expect(scene).toRender(backgroundColor);
      scene.sun = new Sun();
      scene.sun.glowFactor = 0.0;
      scene.renderForSpecs();

      viewSun(scene.camera, scene.context.uniformState);
      expect(scene).notToRender(backgroundColor);
    });

    it("uses the exact-input extinction cache through the feature-renderer path", function () {
      const sun = new Sun();
      const harness = createFeatureRendererHarness();
      const frameState = harness.frameState;

      updateWithFeatureRenderer(sun, frameState);
      expect(sun._atmosphereExtinctionCache.computations).toBe(1);
      expect(sun._atmosphereExtinctionCache.hits).toBe(0);
      expect(frameState.sunAtmosphereExtinction).not.toEqual(Cartesian3.ONE);

      const frameStateResult = frameState.sunAtmosphereExtinction;
      const primitiveResult = sun._atmosphereExtinction;
      const expected = Cartesian3.clone(frameStateResult);
      frameStateResult.x = -1.0;
      primitiveResult.y = -1.0;

      updateWithFeatureRenderer(sun, frameState);

      expect(sun._atmosphereExtinctionCache.computations).toBe(1);
      expect(sun._atmosphereExtinctionCache.hits).toBe(1);
      expect(frameState.sunAtmosphereExtinction).toBe(frameStateResult);
      expect(sun._atmosphereExtinction).toBe(primitiveResult);
      expect(frameStateResult).not.toBe(primitiveResult);
      expect(frameStateResult).toEqual(expected);
      expect(primitiveResult).toEqual(expected);
      expect(harness.featureRenderer.update).toHaveBeenCalledTimes(2);
    });

    it("returns one feature-renderer command without binning a duplicate", function () {
      const sun = new Sun();
      const harness = createFeatureRendererHarness();

      const commands = sun.update(harness.frameState);

      expect(commands.drawCommand).toBe(
        harness.featureRenderer.update.calls.mostRecent().returnValue,
      );
      expect(harness.frameState.commandList).toEqual([]);
      expect(harness.featureRenderer.update).toHaveBeenCalledWith(
        sun,
        harness.frameState,
      );
    });

    it("invalidates Sun extinction for exact public scalar and in-place vector mutations", function () {
      const sun = new Sun();
      const frameState = createFeatureRendererHarness().frameState;

      updateWithFeatureRenderer(sun, frameState);
      const frameStateResult = frameState.sunAtmosphereExtinction;
      const primitiveResult = sun._atmosphereExtinction;
      const mutations = [
        function () {
          frameState.camera.positionWC.x += 1.0;
        },
        function () {
          frameState.context.uniformState.sunPositionWC.y += 1.0;
        },
        function () {
          frameState.atmosphere.rayleighScaleHeight += 1.0;
        },
      ];

      for (let i = 0; i < mutations.length; ++i) {
        mutations[i]();
        updateWithFeatureRenderer(sun, frameState);
        expect(sun._atmosphereExtinctionCache.computations)
          .withContext(`public scalar mutation ${i}`)
          .toBe(i + 2);
        expect(frameState.sunAtmosphereExtinction).toBe(frameStateResult);
        expect(sun._atmosphereExtinction).toBe(primitiveResult);
      }

      const previousRed = frameStateResult.x;
      frameState.atmosphere.rayleighCoefficient.x *= 2.0;
      updateWithFeatureRenderer(sun, frameState);

      expect(sun._atmosphereExtinctionCache.computations).toBe(5);
      expect(frameStateResult.x).not.toBe(previousRed);
      expect(primitiveResult).toEqual(frameStateResult);
    });

    it("publishes exact identity while atmosphere is hidden and recomputes when restored", function () {
      const sun = new Sun();
      const frameState = createFeatureRendererHarness().frameState;

      updateWithFeatureRenderer(sun, frameState);
      const enabledResult = Cartesian3.clone(
        frameState.sunAtmosphereExtinction,
      );
      expect(enabledResult).not.toEqual(Cartesian3.ONE);

      frameState.skyAtmosphereVisible = false;
      updateWithFeatureRenderer(sun, frameState);
      expect(frameState.sunAtmosphereExtinction).toEqual(Cartesian3.ONE);
      expect(sun._atmosphereExtinction).toEqual(Cartesian3.ONE);
      expect(sun._atmosphereExtinctionCache.computations).toBe(1);

      updateWithFeatureRenderer(sun, frameState);
      expect(frameState.sunAtmosphereExtinction).toEqual(Cartesian3.ONE);
      expect(sun._atmosphereExtinctionCache.hits).toBe(1);

      frameState.skyAtmosphereVisible = true;
      updateWithFeatureRenderer(sun, frameState);
      expect(sun._atmosphereExtinctionCache.computations).toBe(2);
      expect(frameState.sunAtmosphereExtinction).toEqual(enabledResult);
      expect(sun._atmosphereExtinction).toEqual(enabledResult);
    });

    it("isDestroyed", function () {
      const sun = new Sun();
      expect(sun.isDestroyed()).toEqual(false);
      sun.destroy();
      expect(sun.isDestroyed()).toEqual(true);
    });
  },
  "WebGL",
);
