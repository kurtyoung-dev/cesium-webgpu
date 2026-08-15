import {
  BoundingRectangle,
  Cartesian3,
  CesiumWidget,
  JulianDate,
  Matrix3,
  Matrix4,
  Moon,
  RuntimeError,
  Transforms,
} from "../../index.js";

import CelestialEphemerisProvider from "../../Source/Core/CelestialEphemerisProvider.js";
import Simon1994EphemerisProvider from "../../Source/Core/Simon1994EphemerisProvider.js";
import createScene from "../../../../Specs/createScene.js";

const testProvenance = Object.freeze({ id: "scene-frame-test" });
const testTimePolicy = Object.freeze({ id: "scene-frame-test-time" });

class SceneEphemerisProvider extends CelestialEphemerisProvider {
  constructor(id, marker) {
    super();
    this._id = id;
    this._marker = marker;
    this.calls = 0;
    // Mutable so a spec can model a provider whose result changes without a
    // time change (an ICRF data arrival, for example) between the render frame
    // and a pick mini-frame that reuses the same frame number.
    this.revisionValue = 1;
  }

  get id() {
    return this._id;
  }

  get revision() {
    return this.revisionValue;
  }

  get provenance() {
    return testProvenance;
  }

  get timePolicy() {
    return testTimePolicy;
  }

  get outputAllocationStable() {
    return true;
  }

  get thirdPartyTemporaryFree() {
    return true;
  }

  compute(time, result) {
    ++this.calls;
    const marker = this._marker;
    Cartesian3.fromElements(
      150000000000.0 + marker,
      20000000000.0,
      30000000000.0,
      result.sunPositionWC,
    );
    Cartesian3.fromElements(
      400000000.0 + marker,
      -50000000.0,
      60000000.0,
      result.moonPositionWC,
    );
    return CelestialEphemerisProvider.finalizeResult(
      result,
      this,
      `SCENE_TEST_${this._id}`,
    );
  }
}

describe("Scene celestial ephemeris integration", function () {
  it("constructs a distinct default Simon provider for each Scene", function () {
    const first = createScene();
    const second = createScene();
    try {
      expect(first.celestialEphemerisProvider).toEqual(
        jasmine.any(Simon1994EphemerisProvider),
      );
      expect(second.celestialEphemerisProvider).toEqual(
        jasmine.any(Simon1994EphemerisProvider),
      );
      expect(first.celestialEphemerisProvider).not.toBe(
        second.celestialEphemerisProvider,
      );
    } finally {
      first.destroyForSpecs();
      second.destroyForSpecs();
    }
  });

  it("defers A-to-B-to-A swaps and shares one lineage across consumers and logical Views", function () {
    const scene = createScene();
    const first = new SceneEphemerisProvider("A", 1.0);
    const second = new SceneEphemerisProvider("B", 2.0);
    const time = JulianDate.fromIso8601("2026-08-12T12:00:00Z");
    let secondaryView;
    try {
      scene.moon = new Moon({ variant: Moon.Variant.SMALL });
      scene.celestialEphemerisProvider = first;
      scene.renderForSpecs(time);

      const frameState = scene.frameState;
      const sample = frameState.celestialEphemerisSample;
      const sunIdentity = sample.sunPositionWC;
      const moonIdentity = sample.moonPositionWC;
      expect(first.calls).toBe(1);
      expect(second.calls).toBe(0);
      expect(frameState.eclipseState.sunPositionWC).toEqual(
        sample.sunPositionWC,
      );
      expect(frameState.eclipseState.sunPositionWC).not.toBe(
        sample.sunPositionWC,
      );
      expect(frameState.eclipseState.moonPositionWC).toEqual(
        sample.moonPositionWC,
      );
      expect(frameState.eclipseState.moonPositionWC).not.toBe(
        sample.moonPositionWC,
      );
      expect(scene.context.uniformState.sunPositionWC).toEqual(
        sample.sunPositionWC,
      );
      expect(scene.context.uniformState.sunPositionWC).not.toBe(
        sample.sunPositionWC,
      );
      expect(
        Matrix4.getTranslation(
          scene.moon._ellipsoidPrimitive.modelMatrix,
          new Cartesian3(),
        ),
      ).toEqual(sample.moonPositionWC);

      scene._renderRequested = false;
      scene.celestialEphemerisProvider = second;
      scene.celestialEphemerisProvider = first;
      expect(scene.celestialEphemerisProvider).toBe(first);
      expect(scene._activeCelestialEphemerisProvider).toBe(first);
      expect(scene._renderRequested).toBe(true);

      scene.pickForSpecs();
      secondaryView = scene.createView(
        scene.camera,
        BoundingRectangle.clone(scene.defaultView.viewport),
      );
      scene.view = secondaryView;
      scene.updateFrameState();
      frameState.passes.offscreen = true;
      scene.context.uniformState.update(frameState);
      scene.view = scene.defaultView;
      scene.updateFrameState();
      expect(first.calls).toBe(1);
      expect(second.calls).toBe(0);
      expect(frameState.celestialEphemerisSample).toBe(sample);

      scene.celestialEphemerisProvider = second;
      scene.updateFrameState();
      expect(scene._activeCelestialEphemerisProvider).toBe(first);
      expect(first.calls).toBe(1);
      expect(second.calls).toBe(0);

      scene.renderForSpecs(time);
      expect(scene._activeCelestialEphemerisProvider).toBe(second);
      expect(first.calls).toBe(1);
      expect(second.calls).toBe(1);
      expect(frameState.celestialEphemerisSample).toBe(sample);
      expect(sample.sunPositionWC).toBe(sunIdentity);
      expect(sample.moonPositionWC).toBe(moonIdentity);
      expect(sample.providerId).toBe("B");
      expect(frameState.eclipseState.sunPositionWC).toEqual(
        sample.sunPositionWC,
      );
      expect(scene.context.uniformState.sunPositionWC).toEqual(
        sample.sunPositionWC,
      );
      expect(
        Matrix4.getTranslation(
          scene.moon._ellipsoidPrimitive.modelMatrix,
          new Cartesian3(),
        ),
      ).toEqual(sample.moonPositionWC);
    } finally {
      if (secondaryView) {
        scene.view = scene.defaultView;
        secondaryView.destroy();
      }
      scene.destroyForSpecs();
    }
  });

  it("snapshots a central-body override for the implicit provider and restores publication next frame", function () {
    const canonicalTransform =
      Transforms._computeIcrfToCentralBodyFixedMatrixDefault;
    let transformACalls = 0;
    let transformBCalls = 0;
    function transformA(time, result) {
      expect(this).toBe(Transforms);
      ++transformACalls;
      return Matrix3.fromRotationZ(0.25, result);
    }
    function transformB(time, result) {
      ++transformBCalls;
      return Matrix3.fromRotationZ(0.5, result);
    }

    Transforms.computeIcrfToCentralBodyFixedMatrix = transformA;
    const scene = createScene();
    const time = JulianDate.fromIso8601("2026-08-12T12:00:00Z");
    try {
      scene.moon = new Moon({ variant: Moon.Variant.SMALL });
      scene.renderForSpecs(time);
      const frameState = scene.frameState;
      expect(frameState.celestialEphemerisSample).toBeUndefined();
      expect(scene._activeCelestialEphemerisLegacyTransformActive).toBe(true);
      expect(scene._activeCelestialEphemerisLegacyTransform).toBe(transformA);
      expect(frameState._celestialEphemerisLegacyTransform).toBe(transformA);
      expect(transformACalls).toBeGreaterThanOrEqual(1);

      const callsBeforeReplacement = transformACalls;
      Transforms.computeIcrfToCentralBodyFixedMatrix = transformB;
      scene.updateFrameState();
      scene.context.uniformState.update(frameState);
      expect(frameState.celestialEphemerisSample).toBeUndefined();
      expect(scene._activeCelestialEphemerisLegacyTransform).toBe(transformA);
      expect(frameState._celestialEphemerisLegacyTransform).toBe(transformA);
      expect(transformACalls).toBe(callsBeforeReplacement + 1);
      expect(transformBCalls).toBe(0);

      Transforms.computeIcrfToCentralBodyFixedMatrix = canonicalTransform;
      scene.renderForSpecs(time);
      expect(scene._activeCelestialEphemerisLegacyTransformActive).toBe(false);
      expect(scene._activeCelestialEphemerisLegacyTransform).toBeUndefined();
      expect(frameState._celestialEphemerisLegacyTransform).toBeUndefined();
      expect(frameState.celestialEphemerisSample.providerId).toBe(
        "cesium-simon1994-ecef",
      );

      Transforms.computeIcrfToCentralBodyFixedMatrix = undefined;
      expect(function () {
        scene.renderForSpecs(time);
      }).toThrowDeveloperError();
      expect(scene._activeCelestialEphemerisLegacyTransformActive).toBe(true);
      expect(frameState.celestialEphemerisSample).toBeUndefined();

      Transforms.computeIcrfToCentralBodyFixedMatrix = canonicalTransform;
      scene.renderForSpecs(time);
      expect(frameState.celestialEphemerisSample.providerId).toBe(
        "cesium-simon1994-ecef",
      );
    } finally {
      Transforms.computeIcrfToCentralBodyFixedMatrix = canonicalTransform;
      scene.destroyForSpecs();
    }
  });

  it("promotes the exact implicit provider to explicit ECEF ownership on the next frame", function () {
    const canonicalTransform =
      Transforms._computeIcrfToCentralBodyFixedMatrixDefault;
    function centralBodyOverride(time, result) {
      return Matrix3.fromRotationZ(0.25, result);
    }

    Transforms.computeIcrfToCentralBodyFixedMatrix = centralBodyOverride;
    const scene = createScene();
    const explicitProvider = new SceneEphemerisProvider("EXPLICIT", 4.0);
    const explicitScene = createScene();
    const time = JulianDate.fromIso8601("2026-08-12T12:00:00Z");
    try {
      scene.renderForSpecs(time);
      const ownedDefault = scene.celestialEphemerisProvider;
      expect(scene._activeCelestialEphemerisProviderIsImplicit).toBe(true);
      expect(scene.frameState.celestialEphemerisSample).toBeUndefined();

      scene._renderRequested = false;
      scene.celestialEphemerisProvider = ownedDefault;
      expect(scene._celestialEphemerisProviderIsImplicit).toBe(false);
      expect(scene._activeCelestialEphemerisProviderIsImplicit).toBe(true);
      expect(scene._renderRequested).toBe(true);
      scene.updateFrameState();
      expect(scene._activeCelestialEphemerisProviderIsImplicit).toBe(true);
      expect(scene.frameState.celestialEphemerisSample).toBeUndefined();

      scene.renderForSpecs(time);
      expect(scene._activeCelestialEphemerisProvider).toBe(ownedDefault);
      expect(scene._activeCelestialEphemerisProviderIsImplicit).toBe(false);
      expect(scene.frameState.celestialEphemerisSample.providerId).toBe(
        "cesium-simon1994-ecef",
      );

      // Once explicit, even a malformed legacy hook is irrelevant to this
      // ready ECEF provider and cannot suppress its next frame.
      Transforms.computeIcrfToCentralBodyFixedMatrix = undefined;
      scene.renderForSpecs(time);
      expect(scene.frameState.celestialEphemerisSample.providerId).toBe(
        "cesium-simon1994-ecef",
      );

      explicitScene.celestialEphemerisProvider = explicitProvider;
      explicitScene.renderForSpecs(time);
      expect(explicitScene._activeCelestialEphemerisProviderIsImplicit).toBe(
        false,
      );
      expect(explicitScene.frameState.celestialEphemerisSample.providerId).toBe(
        "EXPLICIT",
      );
      expect(explicitProvider.calls).toBe(1);
    } finally {
      Transforms.computeIcrfToCentralBodyFixedMatrix = canonicalTransform;
      scene.destroyForSpecs();
      explicitScene.destroyForSpecs();
    }
  });

  it("defers a mid-frame provider revision advance to the next frame instead of throwing into pick", function () {
    const scene = createScene();
    const provider = new SceneEphemerisProvider("REV", 5.0);
    const time = JulianDate.fromIso8601("2026-08-14T12:00:00Z");
    try {
      scene.celestialEphemerisProvider = provider;
      scene.renderForSpecs(time);

      const frameState = scene.frameState;
      const sample = frameState.celestialEphemerisSample;
      const sunIdentity = sample.sunPositionWC;
      const publishedSunX = sample.sunPositionWC.x;
      expect(provider.calls).toBe(1);
      expect(sample.providerRevision).toBe(1);

      // The provider's own revision advances after the render frame published,
      // with the frame number unchanged. A pick mini-frame re-prepares the same
      // logical frame and must not surface that as a caller error.
      provider.revisionValue = 2;

      expect(function () {
        scene.pickForSpecs();
      }).not.toThrow();
      expect(scene.frameState.celestialEphemerisSample).toBe(sample);
      expect(sample.sunPositionWC).toBe(sunIdentity);
      expect(sample.sunPositionWC.x).toBe(publishedSunX);
      expect(sample.providerRevision).toBe(1);
      expect(provider.calls).toBe(1);

      // Repeated preparations inside the same frame stay on that one lineage.
      scene.updateFrameState();
      expect(scene.frameState.celestialEphemerisSample).toBe(sample);
      expect(provider.calls).toBe(1);

      // The transition lands on the next frame, which recomputes exactly once.
      scene.renderForSpecs(time);
      expect(provider.calls).toBe(2);
      expect(scene.frameState.celestialEphemerisSample).toBe(sample);
      expect(sample.providerRevision).toBe(2);
      expect(sample.sunPositionWC).toBe(sunIdentity);
    } finally {
      scene.destroyForSpecs();
    }
  });

  it("still rejects a mid-frame transform-branch change after publication", function () {
    const scene = createScene();
    const provider = new SceneEphemerisProvider("BRANCH", 6.0);
    const time = JulianDate.fromIso8601("2026-08-14T12:00:00Z");
    try {
      scene.celestialEphemerisProvider = provider;
      scene.renderForSpecs(time);
      expect(provider.calls).toBe(1);

      // Negative control for the deferral above: a drift the retained sample
      // cannot absorb must still be refused rather than silently served.
      const frameState = scene.frameState;
      frameState._celestialEphemerisCacheTransformBranch = "OTHER_BRANCH";
      expect(function () {
        frameState._updateCelestialEphemeris(provider, frameState.time);
      }).toThrowError(
        RuntimeError,
        "The celestial ephemeris changed after publication for this frame.",
      );
    } finally {
      scene.destroyForSpecs();
    }
  });

  it("rejects an unready thenable atomically", function () {
    const scene = createScene();
    const original = scene.celestialEphemerisProvider;
    try {
      expect(function () {
        scene.celestialEphemerisProvider = {
          then: function () {},
        };
      }).toThrowDeveloperError();
      expect(scene.celestialEphemerisProvider).toBe(original);
      expect(scene._activeCelestialEphemerisProvider).toBe(original);
    } finally {
      scene.destroyForSpecs();
    }
  });

  it("forwards the ready provider through CesiumWidget", function () {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const provider = new SceneEphemerisProvider("WIDGET", 3.0);
    let widget;
    try {
      widget = new CesiumWidget(container, {
        celestialEphemerisProvider: provider,
        useDefaultRenderLoop: false,
      });
      expect(widget.scene.celestialEphemerisProvider).toBe(provider);
      expect(widget.scene.frameState.celestialEphemerisSample.providerId).toBe(
        "WIDGET",
      );
      expect(provider.calls).toBe(1);
    } finally {
      if (widget) {
        widget.destroy();
      }
      document.body.removeChild(container);
    }
  });
});
