import assert from "node:assert/strict";
import test from "node:test";

import Cartesian3 from "../../Source/Core/Cartesian3.js";
import CelestialEphemerisProvider from "../../Source/Core/CelestialEphemerisProvider.js";
import GeographicProjection from "../../Source/Core/GeographicProjection.js";
import JulianDate from "../../Source/Core/JulianDate.js";
import Matrix3 from "../../Source/Core/Matrix3.js";
import Matrix4 from "../../Source/Core/Matrix4.js";
import Simon1994EphemerisProvider from "../../Source/Core/Simon1994EphemerisProvider.js";
import Simon1994PlanetaryPositions from "../../Source/Core/Simon1994PlanetaryPositions.js";
import Transforms from "../../Source/Core/Transforms.js";
import FrameState from "../../Source/Scene/FrameState.js";
import Moon from "../../Source/Scene/Moon.js";
import SceneMode from "../../Source/Scene/SceneMode.js";
import { setSunAndMoonDirections } from "../../Source/Renderer/UniformStateComputations.js";

const defaultProvenance = Object.freeze({ id: "frame-test-provenance" });
const defaultTimePolicy = Object.freeze({ id: "frame-test-time-policy" });

class InstrumentedProvider extends CelestialEphemerisProvider {
  constructor(id = "frame-test") {
    super();
    this._id = id;
    this._revision = 1;
    this._provenance = defaultProvenance;
    this._timePolicy = defaultTimePolicy;
    this.branch = "TEST_BRANCH_A";
    this.calls = 0;
    this.fail = false;
    this.nan = false;
    this.onCompute = undefined;
  }

  get id() {
    return this._id;
  }

  get revision() {
    return this._revision;
  }

  get provenance() {
    return this._provenance;
  }

  get timePolicy() {
    return this._timePolicy;
  }

  get outputAllocationStable() {
    return true;
  }

  get thirdPartyTemporaryFree() {
    return true;
  }

  compute(time, result) {
    ++this.calls;
    if (this.onCompute) {
      this.onCompute(time, result);
    }
    if (this.fail) {
      result.sunPositionWC.x = -999.0;
      throw new Error("provider failure");
    }
    const base = time.dayNumber * 1000.0 + time.secondsOfDay + this._revision;
    result.sunPositionWC.x = this.nan ? Number.NaN : base;
    result.sunPositionWC.y = base + 1.0;
    result.sunPositionWC.z = base + 2.0;
    result.moonPositionWC.x = base + 3.0;
    result.moonPositionWC.y = base + 4.0;
    result.moonPositionWC.z = base + 5.0;
    return CelestialEphemerisProvider.finalizeResult(result, this, this.branch);
  }
}

function createTime(seconds = 0.0) {
  return new JulianDate(2461000, seconds);
}

test("FrameState shares one allocation-stable sample across Views, passes, and modes", () => {
  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new InstrumentedProvider();
  const time = createTime(123.25);
  frameState.frameNumber = 11;

  const sample = frameState._updateCelestialEphemeris(provider, time);
  const sunIdentity = sample.sunPositionWC;
  const moonIdentity = sample.moonPositionWC;

  const cases = [
    {
      view: "main",
      render: true,
      pick: false,
      offscreen: false,
      mode: SceneMode.SCENE3D,
    },
    {
      view: "pick",
      render: false,
      pick: true,
      offscreen: false,
      mode: SceneMode.SCENE3D,
    },
    {
      view: "capture",
      render: false,
      pick: false,
      offscreen: true,
      mode: SceneMode.SCENE3D,
    },
    {
      view: "2d",
      render: true,
      pick: false,
      offscreen: false,
      mode: SceneMode.SCENE2D,
    },
    {
      view: "columbus",
      render: true,
      pick: false,
      offscreen: false,
      mode: SceneMode.COLUMBUS_VIEW,
    },
  ];

  for (const entry of cases) {
    frameState.view = entry.view;
    frameState.passes.render = entry.render;
    frameState.passes.pick = entry.pick;
    frameState.passes.offscreen = entry.offscreen;
    frameState.mode = entry.mode;
    const reused = frameState._updateCelestialEphemeris(
      provider,
      JulianDate.clone(time),
    );
    assert.strictEqual(reused, sample);
    assert.strictEqual(reused.sunPositionWC, sunIdentity);
    assert.strictEqual(reused.moonPositionWC, moonIdentity);
  }

  assert.equal(provider.calls, 1);
  assert.strictEqual(frameState.celestialEphemerisSample, sample);
});

test("FrameState default Simon lineage is numerically identical to the legacy derivation", () => {
  const canonicalTransformDescriptor = Object.getOwnPropertyDescriptor(
    Transforms,
    "_computeIcrfToCentralBodyFixedMatrixDefault",
  );
  assert.strictEqual(
    canonicalTransformDescriptor.value,
    Transforms.computeIcrfToCentralBodyFixedMatrix,
  );
  assert.equal(canonicalTransformDescriptor.writable, false);
  assert.equal(canonicalTransformDescriptor.configurable, false);
  assert.equal(canonicalTransformDescriptor.enumerable, false);

  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new Simon1994EphemerisProvider();
  const time = JulianDate.fromIso8601("2024-04-08T19:18:11Z");
  frameState.frameNumber = 1;
  const sample = frameState._updateCelestialEphemeris(provider, time);

  const transform = Transforms.computeIcrfToCentralBodyFixedMatrix(
    time,
    new Matrix3(),
  );
  const legacySun =
    Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time);
  Matrix3.multiplyByVector(transform, legacySun, legacySun);
  const legacyMoon =
    Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(time);
  Matrix3.multiplyByVector(transform, legacyMoon, legacyMoon);

  assert.deepEqual(sample.sunPositionWC, legacySun);
  assert.deepEqual(sample.moonPositionWC, legacyMoon);
});

test("FrameState cache keys exact time, provider identity, revision, and transform branch", () => {
  const frameState = new FrameState(undefined, undefined, undefined);
  const first = new InstrumentedProvider("same-id");
  const second = new InstrumentedProvider("same-id");
  const time = createTime(10.0);
  frameState.frameNumber = 1;

  const sample = frameState._updateCelestialEphemeris(first, time);
  assert.equal(first.calls, 1);

  frameState.frameNumber = 2;
  frameState._updateCelestialEphemeris(first, createTime(10.0000000001));
  assert.equal(first.calls, 2);

  ++first._revision;
  first.branch = "TEST_BRANCH_B";
  frameState.frameNumber = 3;
  frameState._updateCelestialEphemeris(first, createTime(10.0000000001));
  assert.equal(first.calls, 3);
  assert.equal(sample.transformBranch, "TEST_BRANCH_B");

  frameState.frameNumber = 4;
  frameState._updateCelestialEphemeris(second, createTime(10.0000000001));
  assert.equal(second.calls, 1);
  assert.strictEqual(frameState.celestialEphemerisSample, sample);
});

test("FrameState defers a same-frame revision advance and applies it on the next logical frame", () => {
  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new InstrumentedProvider();
  const time = createTime(40.0);
  frameState.frameNumber = 7;
  const sample = frameState._updateCelestialEphemeris(provider, time);
  const publishedSunX = sample.sunPositionWC.x;

  // The provider's revision advances asynchronously after publication. Pick,
  // snap, and offscreen preparations reuse this frame number, so the retained
  // sample is served unchanged rather than the transition being reported as a
  // caller error.
  ++provider._revision;
  provider.branch = "TEST_BRANCH_B";
  const deferred = frameState._updateCelestialEphemeris(provider, time);
  assert.strictEqual(deferred, sample);
  assert.strictEqual(frameState.celestialEphemerisSample, sample);
  assert.equal(sample.providerRevision, 1);
  assert.equal(sample.transformBranch, "TEST_BRANCH_A");
  assert.equal(sample.sunPositionWC.x, publishedSunX);
  assert.equal(provider.calls, 1);

  // Every further preparation in the same frame stays on that one lineage.
  assert.strictEqual(
    frameState._updateCelestialEphemeris(provider, time),
    sample,
  );
  assert.equal(provider.calls, 1);

  frameState.frameNumber = 8;
  const recovered = frameState._updateCelestialEphemeris(provider, time);
  assert.equal(provider.calls, 2);
  assert.equal(recovered.providerRevision, 2);
  assert.equal(recovered.transformBranch, "TEST_BRANCH_B");

  // Negative control: the deferral is scoped to the revision alone. A drift the
  // retained sample cannot absorb — here a different provider object — is still
  // refused after publication.
  const other = new InstrumentedProvider("frame-test-other");
  assert.throws(
    () => frameState._updateCelestialEphemeris(other, time),
    /changed after publication/,
  );
  assert.equal(other.calls, 0);
  assert.equal(frameState.celestialEphemerisSample, undefined);
});

test("FrameState hit audit rejects vector and declaration spoofing", () => {
  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new InstrumentedProvider();
  const time = createTime(50.0);
  frameState.frameNumber = 4;
  const sample = frameState._updateCelestialEphemeris(provider, time);

  sample.sunPositionWC.x += 1.0;
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, time),
    /changed after publication/,
  );
  assert.equal(provider.calls, 1);
  assert.equal(frameState.celestialEphemerisSample, undefined);

  frameState.frameNumber = 5;
  frameState._updateCelestialEphemeris(provider, time);
  const spoofedProvenance = Object.freeze({ id: "spoofed" });
  provider._provenance = spoofedProvenance;
  sample.provenance = spoofedProvenance;
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, time),
    /changed after publication/,
  );
  assert.equal(provider.calls, 2);
  assert.equal(frameState.celestialEphemerisSample, undefined);
});

test("FrameState clears stale publication on throw or NaN and recovers with the same storage", () => {
  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new InstrumentedProvider();
  const time = createTime(60.0);
  frameState.frameNumber = 1;
  const sample = frameState._updateCelestialEphemeris(provider, time);
  const sunIdentity = sample.sunPositionWC;
  const moonIdentity = sample.moonPositionWC;

  frameState.frameNumber = 2;
  provider.fail = true;
  provider.onCompute = () => {
    assert.equal(frameState.celestialEphemerisSample, undefined);
  };
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, createTime(61.0)),
    /provider failure/,
  );
  assert.equal(frameState.celestialEphemerisSample, undefined);

  provider.fail = false;
  provider.onCompute = undefined;
  const recovered = frameState._updateCelestialEphemeris(
    provider,
    createTime(61.0),
  );
  assert.strictEqual(recovered, sample);
  assert.strictEqual(recovered.sunPositionWC, sunIdentity);
  assert.strictEqual(recovered.moonPositionWC, moonIdentity);

  frameState.frameNumber = 3;
  provider.nan = true;
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, createTime(62.0)),
    /non-finite position/,
  );
  assert.equal(frameState.celestialEphemerisSample, undefined);
  provider.nan = false;
  assert.strictEqual(
    frameState._updateCelestialEphemeris(provider, createTime(62.0)),
    sample,
  );
});

test("FrameState generation rejects swallowed reentrancy and then recovers", () => {
  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new InstrumentedProvider();
  const time = createTime(70.0);
  frameState.frameNumber = 1;
  provider.onCompute = () => {
    try {
      frameState._updateCelestialEphemeris(provider, time);
    } catch {
      // A hostile provider may swallow the inner exception. The outer
      // generation check must still reject its apparently valid result.
    }
  };

  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, time),
    /reentrant call invalidated/,
  );
  assert.equal(frameState.celestialEphemerisSample, undefined);

  provider.onCompute = undefined;
  const recovered = frameState._updateCelestialEphemeris(provider, time);
  assert.strictEqual(recovered, frameState._celestialEphemerisSampleIdentity);
  assert.equal(provider.calls, 2);
});

test("FrameState guards compute accessors and post-compute declaration getters", () => {
  const accessorFrameState = new FrameState(undefined, undefined, undefined);
  const accessorProvider = new InstrumentedProvider("accessor");
  const accessorTime = createTime(75.0);
  accessorFrameState.frameNumber = 1;
  const stableCompute = InstrumentedProvider.prototype.compute;
  let accessorReentered = false;
  Object.defineProperty(accessorProvider, "compute", {
    configurable: true,
    get() {
      if (!accessorReentered) {
        accessorReentered = true;
        try {
          accessorFrameState._updateCelestialEphemeris(
            accessorProvider,
            accessorTime,
          );
        } catch {
          // Swallow the nested error to exercise the outer generation audit.
        }
      }
      return stableCompute;
    },
  });
  assert.throws(
    () =>
      accessorFrameState._updateCelestialEphemeris(
        accessorProvider,
        accessorTime,
      ),
    /reentrant call invalidated/,
  );
  assert.equal(accessorFrameState.celestialEphemerisSample, undefined);

  const swapFrameState = new FrameState(undefined, undefined, undefined);
  const swapProvider = new InstrumentedProvider("swap");
  const swapTime = createTime(76.0);
  swapFrameState.frameNumber = 1;
  let computeReads = 0;
  const alternateCompute = function (time, result) {
    return stableCompute.call(this, time, result);
  };
  Object.defineProperty(swapProvider, "compute", {
    configurable: true,
    get() {
      return ++computeReads === 1 ? stableCompute : alternateCompute;
    },
  });
  assert.throws(
    () => swapFrameState._updateCelestialEphemeris(swapProvider, swapTime),
    /declaration changed/,
  );
  assert.equal(swapFrameState.celestialEphemerisSample, undefined);

  class PostGetterProvider extends InstrumentedProvider {
    constructor() {
      super("post-getter");
      this._armedResult = undefined;
    }

    get revision() {
      if (this._armedResult) {
        this._armedResult.sunPositionWC.x = Number.NaN;
        this._armedResult = undefined;
      }
      return this._revision;
    }

    compute(time, result) {
      const returned = super.compute(time, result);
      this._armedResult = result;
      return returned;
    }
  }

  const getterFrameState = new FrameState(undefined, undefined, undefined);
  const getterProvider = new PostGetterProvider();
  getterFrameState.frameNumber = 1;
  assert.throws(
    () =>
      getterFrameState._updateCelestialEphemeris(
        getterProvider,
        createTime(77.0),
      ),
    /changed during post-compute provider validation/,
  );
  assert.equal(getterFrameState.celestialEphemerisSample, undefined);
});

test("FrameState freezes returned vectors, branch, and revision against post-compute getter forgery", () => {
  class FinitePayloadForgeryProvider extends InstrumentedProvider {
    constructor() {
      super("finite-payload-forgery");
      this._armedResult = undefined;
    }

    get revision() {
      if (this._armedResult) {
        this._armedResult.sunPositionWC.x += 1.0;
        this._armedResult.moonPositionWC.z -= 1.0;
        this._armedResult.transformBranch = "FORGED_FINITE_BRANCH";
        this._armedResult = undefined;
      }
      return this._revision;
    }

    compute(time, result) {
      const returned = super.compute(time, result);
      this._armedResult = result;
      return returned;
    }
  }

  const payloadFrameState = new FrameState(undefined, undefined, undefined);
  const payloadProvider = new FinitePayloadForgeryProvider();
  payloadFrameState.frameNumber = 1;
  assert.throws(
    () =>
      payloadFrameState._updateCelestialEphemeris(
        payloadProvider,
        createTime(77.25),
      ),
    /changed during post-compute provider validation/,
  );
  assert.equal(payloadFrameState.celestialEphemerisSample, undefined);

  class MatchingRevisionForgeryProvider extends InstrumentedProvider {
    constructor() {
      super("matching-revision-forgery");
      this._armedResult = undefined;
    }

    get revision() {
      if (this._armedResult) {
        ++this._revision;
        this._armedResult.providerRevision = this._revision;
        this._armedResult = undefined;
      }
      return this._revision;
    }

    compute(time, result) {
      const returned = super.compute(time, result);
      this._armedResult = result;
      return returned;
    }
  }

  const revisionFrameState = new FrameState(undefined, undefined, undefined);
  const revisionProvider = new MatchingRevisionForgeryProvider();
  revisionFrameState.frameNumber = 1;
  assert.throws(
    () =>
      revisionFrameState._updateCelestialEphemeris(
        revisionProvider,
        createTime(77.5),
      ),
    /changed during post-compute provider validation/,
  );
  assert.equal(revisionFrameState.celestialEphemerisSample, undefined);
});

test("FrameState accepts a revision transition completed inside compute", () => {
  class ComputeRevisionTransitionProvider extends InstrumentedProvider {
    compute(time, result) {
      ++this._revision;
      return super.compute(time, result);
    }
  }

  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new ComputeRevisionTransitionProvider(
    "compute-revision-transition",
  );
  frameState.frameNumber = 1;
  const sample = frameState._updateCelestialEphemeris(
    provider,
    createTime(77.75),
  );
  assert.equal(provider.calls, 1);
  assert.equal(provider.revision, 2);
  assert.equal(sample.providerRevision, 2);
  assert.equal(frameState._celestialEphemerisCacheProviderRevision, 2);
});

test("FrameState rejects provider-side caller time and frame mutation on misses and hits", () => {
  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new InstrumentedProvider();
  const time = createTime(78.0);
  frameState.time = time;
  frameState.frameNumber = 1;
  frameState._updateCelestialEphemeris(provider, time);

  let mutateHit = true;
  Object.defineProperty(provider, "compute", {
    configurable: true,
    get() {
      if (mutateHit) {
        time.secondsOfDay += 1.0;
      }
      return InstrumentedProvider.prototype.compute;
    },
  });
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, time),
    /mutated the FrameState frame or simulation time/,
  );
  assert.equal(frameState.celestialEphemerisSample, undefined);

  mutateHit = false;
  time.secondsOfDay = 78.0;
  frameState.frameNumber = 2;
  frameState._updateCelestialEphemeris(provider, time);
  const stableTime = JulianDate.clone(time);
  const stableFrameNumber = frameState.frameNumber;
  Object.defineProperty(provider, "provenance", {
    configurable: true,
    get() {
      frameState.frameNumber = stableFrameNumber + 1;
      return defaultProvenance;
    },
  });
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, stableTime),
    /mutated the FrameState frame or simulation time/,
  );
  assert.equal(frameState.celestialEphemerisSample, undefined);
});

test("FrameState logical-frame token cannot retain a rejection across frame-number reuse", () => {
  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new InstrumentedProvider();
  const time = createTime(80.0);

  frameState.frameNumber = 1;
  const sample = frameState._updateCelestialEphemeris(provider, time);
  // Drift the retained sample away from its cache so the frame is genuinely
  // rejected; a revision advance alone is deferred, not rejected.
  sample.sunPositionWC.x += 1.0;
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, time),
    /changed after publication/,
  );

  frameState.frameNumber = 2;
  frameState._updateCelestialEphemeris(provider, time);
  frameState.frameNumber = 1;
  const afterWrap = frameState._updateCelestialEphemeris(provider, time);
  assert.strictEqual(afterWrap, frameState._celestialEphemerisSampleIdentity);
  assert.equal(provider.calls, 2);
});

test("FrameState requires sample revision to match the post-compute provider revision", () => {
  class DriftingProvider extends InstrumentedProvider {
    compute(time, result) {
      const sample = super.compute(time, result);
      ++this._revision;
      return sample;
    }
  }

  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new DriftingProvider();
  frameState.frameNumber = 1;
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, createTime(90.0)),
    /does not truthfully match/,
  );
  assert.equal(frameState.celestialEphemerisSample, undefined);
});

test("UniformStateComputations clones the shared vectors and retains its bare fallback", () => {
  const sample = CelestialEphemerisProvider.createSample();
  Cartesian3.fromElements(
    150000000000.0,
    20000000000.0,
    30000000000.0,
    sample.sunPositionWC,
  );
  Cartesian3.fromElements(
    400000000.0,
    -50000000.0,
    60000000.0,
    sample.moonPositionWC,
  );
  const uniformState = {
    _sunPositionWC: new Cartesian3(),
    _sunDirectionWC: new Cartesian3(),
    _sunDirectionEC: new Cartesian3(),
    _moonDirectionEC: new Cartesian3(),
    _sunPositionColumbusView: new Cartesian3(),
    viewRotation3D: Matrix3.clone(Matrix3.IDENTITY),
  };
  const frameState = {
    celestialEphemerisSample: sample,
    time: createTime(100.0),
    mapProjection: new GeographicProjection(),
  };

  setSunAndMoonDirections(uniformState, frameState);
  assert.notStrictEqual(uniformState._sunPositionWC, sample.sunPositionWC);
  assert.deepEqual(uniformState._sunPositionWC, sample.sunPositionWC);
  const expectedMoonDirection = Cartesian3.normalize(
    sample.moonPositionWC,
    new Cartesian3(),
  );
  assert.deepEqual(uniformState._moonDirectionEC, expectedMoonDirection);

  uniformState._sunPositionWC.x = 1.0;
  assert.equal(sample.sunPositionWC.x, 150000000000.0);

  frameState.celestialEphemerisSample = undefined;
  setSunAndMoonDirections(uniformState, frameState);
  assert.equal(Number.isFinite(uniformState._sunPositionWC.x), true);
  assert.equal(Number.isFinite(uniformState._moonDirectionEC.x), true);
  assert.equal(frameState.mapProjection instanceof GeographicProjection, true);
});

test("Moon copies the shared lunar vector into its established model storage", () => {
  for (const constructorName of [
    "HTMLCanvasElement",
    "HTMLImageElement",
    "HTMLVideoElement",
    "ImageBitmap",
    "OffscreenCanvas",
  ]) {
    if (typeof globalThis[constructorName] === "undefined") {
      globalThis[constructorName] = class {};
    }
  }

  const sample = CelestialEphemerisProvider.createSample();
  Cartesian3.fromElements(
    150000000000.0,
    20000000000.0,
    30000000000.0,
    sample.sunPositionWC,
  );
  Cartesian3.fromElements(
    400000000.0,
    -50000000.0,
    60000000.0,
    sample.moonPositionWC,
  );

  const frameState = new FrameState(undefined, undefined, undefined);
  frameState.time = createTime(110.0);
  frameState.celestialEphemerisSample = sample;
  frameState.mapProjection = new GeographicProjection();
  frameState.mode = SceneMode.SCENE3D;
  frameState.camera = undefined;
  frameState.globeVisible = false;
  frameState.skyAtmosphereVisible = false;
  frameState.atmosphericConditions = undefined;
  frameState.context = {
    uniformState: {
      sunDirectionWC: Cartesian3.normalize(
        sample.sunPositionWC,
        new Cartesian3(),
      ),
      sunPositionWC: Cartesian3.clone(sample.sunPositionWC),
      gamma: 2.2,
    },
    getFeatureRenderer() {
      return {
        update() {},
      };
    },
  };

  const moon = new Moon({ variant: Moon.Variant.SMALL });
  moon.update(frameState, { clearGlobeDepth: false });
  const modelTranslation = Matrix4.getTranslation(
    moon._ellipsoidPrimitive.modelMatrix,
    new Cartesian3(),
  );
  assert.deepEqual(modelTranslation, sample.moonPositionWC);
  assert.notStrictEqual(modelTranslation, sample.moonPositionWC);
  modelTranslation.x = 0.0;
  assert.equal(sample.moonPositionWC.x, 400000000.0);
});

test("FrameState snapshots the Uniform legacy hook while Moon retains its fixed path", () => {
  for (const constructorName of [
    "HTMLCanvasElement",
    "HTMLImageElement",
    "HTMLVideoElement",
    "ImageBitmap",
    "OffscreenCanvas",
  ]) {
    if (typeof globalThis[constructorName] === "undefined") {
      globalThis[constructorName] = class {};
    }
  }

  const frameState = new FrameState(undefined, undefined, undefined);
  const provider = new InstrumentedProvider("legacy-gate");
  const time = createTime(120.0);
  frameState.time = time;
  frameState.frameNumber = 1;
  frameState.mapProjection = new GeographicProjection();
  frameState.mode = SceneMode.SCENE3D;
  frameState.camera = undefined;
  frameState.globeVisible = false;
  frameState.skyAtmosphereVisible = false;
  frameState.atmosphericConditions = undefined;
  frameState._updateCelestialEphemeris(provider, time);
  assert.equal(provider.calls, 1);

  const transformMatrixA = Matrix3.fromRotationZ(0.25);
  let transformACalls = 0;
  let transformBCalls = 0;
  function transformA(date, result) {
    assert.strictEqual(this, Transforms);
    assert.strictEqual(date, time);
    ++transformACalls;
    return Matrix3.clone(transformMatrixA, result);
  }
  function transformB(date, result) {
    assert.strictEqual(date, time);
    ++transformBCalls;
    return Matrix3.clone(Matrix3.IDENTITY, result);
  }

  frameState.frameNumber = 2;
  assert.equal(
    frameState._updateCelestialEphemeris(provider, time, true, transformA),
    undefined,
  );
  assert.equal(frameState.celestialEphemerisSample, undefined);
  assert.equal(provider.calls, 1);

  const uniformState = {
    _sunPositionWC: new Cartesian3(),
    _sunDirectionWC: new Cartesian3(),
    _sunDirectionEC: new Cartesian3(),
    _moonDirectionEC: new Cartesian3(),
    _sunPositionColumbusView: new Cartesian3(),
    viewRotation3D: Matrix3.clone(Matrix3.IDENTITY),
  };
  frameState.context = {
    uniformState: {
      sunDirectionWC: new Cartesian3(1.0, 0.0, 0.0),
      sunPositionWC: new Cartesian3(1.0, 0.0, 0.0),
      gamma: 2.2,
    },
    getFeatureRenderer() {
      return {
        update() {},
      };
    },
  };

  const originalTransform = Transforms.computeIcrfToCentralBodyFixedMatrix;
  Transforms.computeIcrfToCentralBodyFixedMatrix = transformB;
  try {
    setSunAndMoonDirections(uniformState, frameState);
    const expectedSun =
      Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time);
    Matrix3.multiplyByVector(transformMatrixA, expectedSun, expectedSun);
    assert.deepEqual(uniformState._sunPositionWC, expectedSun);

    const moon = new Moon({ variant: Moon.Variant.SMALL });
    moon.update(frameState, { clearGlobeDepth: false });
    const expectedMoon =
      Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(time);
    let moonTransform = Transforms.computeIcrfToFixedMatrix(
      time,
      new Matrix3(),
    );
    if (moonTransform === undefined) {
      moonTransform = Transforms.computeTemeToPseudoFixedMatrix(
        time,
        new Matrix3(),
      );
    }
    Matrix3.multiplyByVector(moonTransform, expectedMoon, expectedMoon);
    assert.deepEqual(
      Matrix4.getTranslation(
        moon._ellipsoidPrimitive.modelMatrix,
        new Cartesian3(),
      ),
      expectedMoon,
    );
  } finally {
    Transforms.computeIcrfToCentralBodyFixedMatrix = originalTransform;
  }

  assert.equal(transformACalls, 1);
  assert.equal(transformBCalls, 0);
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, time),
    /changed after legacy consumption/,
  );
  frameState.frameNumber = 3;
  assert.strictEqual(
    frameState._updateCelestialEphemeris(provider, time),
    frameState._celestialEphemerisSampleIdentity,
  );
  assert.equal(provider.calls, 2);

  frameState.frameNumber = 4;
  assert.throws(
    () => frameState._updateCelestialEphemeris(provider, time, true, undefined),
    /legacyTransform/,
  );
  assert.equal(frameState.celestialEphemerisSample, undefined);
  assert.equal(provider.calls, 2);

  // The rejected argument is validated before any state is written, so the
  // frame is not left marked legacy-consumed and a corrected retry inside the
  // SAME frame is accepted instead of reporting an override change.
  const retryTransform = function (retryDate, matrixResult) {
    assert.equal(retryDate, time);
    return Matrix3.clone(Matrix3.IDENTITY, matrixResult);
  };
  assert.equal(
    frameState._updateCelestialEphemeris(provider, time, true, retryTransform),
    undefined,
  );
  assert.strictEqual(
    frameState._celestialEphemerisLegacyTransform,
    retryTransform,
  );
  assert.equal(provider.calls, 2);

  frameState.frameNumber = 5;
  frameState._updateCelestialEphemeris(provider, time);
  assert.equal(provider.calls, 3);
});
