import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { URL } from "node:url";

import AstronomyEngineEphemerisProvider from "../../Source/Core/AstronomyEngineEphemerisProvider.js";
import Cartesian3 from "../../Source/Core/Cartesian3.js";
import Cartographic from "../../Source/Core/Cartographic.js";
import CelestialEphemerisProvider from "../../Source/Core/CelestialEphemerisProvider.js";
import computeEclipseDiscGeometry, {
  createEclipseDiscGeometry,
  EclipseDiscPhase,
} from "../../Source/Core/EclipseDiscGeometry.js";
import EclipseLocalCircumstances from "../../Source/Core/EclipseLocalCircumstances.js";
import Ellipsoid from "../../Source/Core/Ellipsoid.js";
import JulianDate from "../../Source/Core/JulianDate.js";
import CesiumMath from "../../Source/Core/Math.js";

const ANALYTIC_PROVENANCE = Object.freeze({
  id: "analytic-eclipse-spec-v1",
  outputFrame: "ECEF",
  outputUnits: "metres",
  eventSpecificCorrections: false,
  angularRadiusCorrections: false,
});
const ANALYTIC_TIME_POLICY = Object.freeze({
  id: "cesium-julian-date-tai/analytic-spec",
  inputTimeScale: "TAI",
});
const ANALYTIC_BRANCH = "ANALYTIC_TO_ECEF";
const FIRST_TRANSITION_BRANCH = "ANALYTIC_FIRST_TRANSITION_TO_ECEF";
const DEFAULT_HALF_BRACKET_SECONDS = 3000.0;

const solverSource = readFileSync(
  new URL("../../Source/Core/EclipseLocalCircumstances.js", import.meta.url),
  "utf8",
);

class AnalyticEphemerisProvider extends CelestialEphemerisProvider {
  constructor(options) {
    super();
    this._epoch = JulianDate.clone(options.epoch);
    this._observerPositionWC = Cartesian3.clone(options.observerPositionWC);
    this._observerNormalWC = Cartesian3.clone(options.observerNormalWC);
    this._tangentWC = new Cartesian3();
    if (Math.abs(this._observerNormalWC.z) < 0.9) {
      this._tangentWC.x = -this._observerNormalWC.y;
      this._tangentWC.y = this._observerNormalWC.x;
      this._tangentWC.z = 0.0;
    } else {
      this._tangentWC.x = 1.0;
      this._tangentWC.y = 0.0;
      this._tangentWC.z = 0.0;
    }
    Cartesian3.normalize(this._tangentWC, this._tangentWC);
    this._solarAngularRadius = options.solarAngularRadius ?? 0.01;
    this._lunarAngularRadius = options.lunarAngularRadius ?? 0.009;
    this._minimumSeparation = options.minimumSeparation ?? 0.005;
    this._angularRate = options.angularRate ?? 0.00001;
    this._sunCenterElevation =
      options.sunCenterElevation ?? CesiumMath.PI_OVER_TWO;
    this._revision = 1;
    this._provenance = ANALYTIC_PROVENANCE;
    this._timePolicy = ANALYTIC_TIME_POLICY;
    this._branch = ANALYTIC_BRANCH;
    this._hostility = options.hostility;
    this._publishedResult = options.publishedResult;
    this._reentrantAttempt = options.reentrantAttempt;
    this.calls = 0;
  }

  get id() {
    return "analytic-eclipse-spec";
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
    CelestialEphemerisProvider.validateResult(result);
    const sunPositionWC = result.sunPositionWC;
    const moonPositionWC = result.moonPositionWC;
    ++this.calls;

    if (this._hostility === "first-revision-transition" && this.calls === 1) {
      ++this._revision;
      this._branch = FIRST_TRANSITION_BRANCH;
    } else if (this._hostility === "revision-drift" && this.calls === 3) {
      ++this._revision;
    } else if (this._hostility === "provenance-drift" && this.calls === 3) {
      this._provenance = Object.freeze({ id: "drifted-provenance" });
    } else if (this._hostility === "branch-drift" && this.calls === 3) {
      this._branch = "DRIFTED_TO_ECEF";
    } else if (this._hostility === "replace-vector" && this.calls === 1) {
      result.sunPositionWC = new Cartesian3();
    } else if (this._hostility === "mutate-time" && this.calls === 1) {
      JulianDate.addSeconds(time, 1.0, time);
    } else if (
      this._hostility === "mutate-published-result-and-throw" &&
      this.calls === 1
    ) {
      const publishedResult = this._publishedResult;
      publishedResult.valid = true;
      publishedResult.hasEclipse = true;
      publishedResult.kind = EclipseDiscPhase.TOTAL;
      publishedResult.evaluationCount = 123456;
      publishedResult.firstContact.valid = true;
      publishedResult.firstContact.separation = 123.0;
      publishedResult.firstContact.sunDirectionWC.x = 456.0;
      publishedResult.maximum.valid = true;
      publishedResult.maximum.separation = 789.0;
      throw new Error("hostile published-result mutation");
    } else if (this._hostility === "reentrant" && this.calls === 1) {
      this._reentrantAttempt();
    }

    const offsetSeconds = JulianDate.secondsDifference(time, this._epoch);
    let separation = Math.hypot(
      this._minimumSeparation,
      this._angularRate * offsetSeconds,
    );
    if (
      this._hostility === "contact-discontinuity" &&
      offsetSeconds < -1000.0
    ) {
      separation += 0.03;
    }
    const sunZenithDistance = CesiumMath.PI_OVER_TWO - this._sunCenterElevation;
    const moonZenithDistance = sunZenithDistance + separation;
    const sunCosine = Math.cos(sunZenithDistance);
    const sunSine = Math.sin(sunZenithDistance);
    const moonCosine = Math.cos(moonZenithDistance);
    const moonSine = Math.sin(moonZenithDistance);
    const sunDistance =
      CesiumMath.SOLAR_RADIUS / Math.sin(this._solarAngularRadius);
    const moonDistance =
      CesiumMath.LUNAR_RADIUS / Math.sin(this._lunarAngularRadius);
    const normal = this._observerNormalWC;
    const tangent = this._tangentWC;

    sunPositionWC.x =
      this._observerPositionWC.x +
      sunDistance * (sunCosine * normal.x + sunSine * tangent.x);
    sunPositionWC.y =
      this._observerPositionWC.y +
      sunDistance * (sunCosine * normal.y + sunSine * tangent.y);
    sunPositionWC.z =
      this._observerPositionWC.z +
      sunDistance * (sunCosine * normal.z + sunSine * tangent.z);
    moonPositionWC.x =
      this._observerPositionWC.x +
      moonDistance * (moonCosine * normal.x + moonSine * tangent.x);
    moonPositionWC.y =
      this._observerPositionWC.y +
      moonDistance * (moonCosine * normal.y + moonSine * tangent.y);
    moonPositionWC.z =
      this._observerPositionWC.z +
      moonDistance * (moonCosine * normal.z + moonSine * tangent.z);

    if (this._hostility === "nonfinite" && this.calls === 1) {
      moonPositionWC.z = Number.NaN;
    }

    const finalized = CelestialEphemerisProvider.finalizeResult(
      result,
      this,
      this._branch,
    );
    if (this._hostility === "replace-sample" && this.calls === 1) {
      return { ...finalized };
    }
    return finalized;
  }
}

function makeAnalyticSetup(options = {}) {
  const observer =
    options.observer ?? Cartographic.fromDegrees(-80.0851, 42.1292, 250.0);
  const ellipsoid = options.ellipsoid ?? Ellipsoid.WGS84;
  const epoch = options.epoch ?? JulianDate.fromIso8601("2024-04-08T19:18:11Z");
  const observerPositionWC = ellipsoid.cartographicToCartesian(
    observer,
    new Cartesian3(),
  );
  const observerNormalWC = ellipsoid.geodeticSurfaceNormalCartographic(
    observer,
    new Cartesian3(),
  );
  const provider = new AnalyticEphemerisProvider({
    epoch,
    observerPositionWC,
    observerNormalWC,
    solarAngularRadius: options.solarAngularRadius,
    lunarAngularRadius: options.lunarAngularRadius,
    minimumSeparation: options.minimumSeparation,
    angularRate: options.angularRate,
    sunCenterElevation: options.sunCenterElevation,
    hostility: options.hostility,
    publishedResult: options.publishedResult,
    reentrantAttempt: options.reentrantAttempt,
  });
  const halfBracketSeconds =
    options.halfBracketSeconds ?? DEFAULT_HALF_BRACKET_SECONDS;
  const startTime = JulianDate.addSeconds(
    epoch,
    -halfBracketSeconds,
    new JulianDate(),
  );
  const stopTime = JulianDate.addSeconds(
    epoch,
    halfBracketSeconds,
    new JulianDate(),
  );
  return {
    observer,
    ellipsoid,
    epoch,
    provider,
    startTime,
    stopTime,
  };
}

function solveAnalytic(options = {}, result) {
  const setup = makeAnalyticSetup(options);
  const solver = new EclipseLocalCircumstances(setup.provider);
  result = result ?? EclipseLocalCircumstances.createResult();
  solver.compute(
    {
      observer: setup.observer,
      ellipsoid: options.omitEllipsoid ? undefined : setup.ellipsoid,
      startTime: setup.startTime,
      stopTime: setup.stopTime,
    },
    result,
  );
  return { ...setup, solver, result };
}

function eventOffset(event, epoch) {
  return JulianDate.secondsDifference(event.time, epoch);
}

function assertContactOrder(result) {
  assert.ok(
    JulianDate.compare(result.firstContact.time, result.maximum.time) < 0,
  );
  assert.ok(
    JulianDate.compare(result.maximum.time, result.fourthContact.time) < 0,
  );
  if (result.secondContact.valid) {
    assert.ok(
      JulianDate.compare(result.firstContact.time, result.secondContact.time) <
        0,
    );
    assert.ok(
      JulianDate.compare(result.secondContact.time, result.maximum.time) < 0,
    );
    assert.ok(
      JulianDate.compare(result.maximum.time, result.thirdContact.time) < 0,
    );
    assert.ok(
      JulianDate.compare(result.thirdContact.time, result.fourthContact.time) <
        0,
    );
  }
}

function close(actual, expected, epsilon) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} differs from ${expected} by more than ${epsilon}`,
  );
}

test("local circumstances remain pure Core with allocation-stable branded sampling", () => {
  assert.doesNotMatch(solverSource, /astronomy-engine|AstronomyEngine/);
  assert.doesNotMatch(
    solverSource,
    /Search(?:Local|Global)SolarEclipse|SearchMoonPhase/,
  );
  assert.doesNotMatch(solverSource, /Object\.getOwnPropertyDescriptor/);
  assert.match(
    solverSource,
    /CelestialEphemerisProvider\.validateResult\(sample\)/,
  );
});

test("solver returns ordered analytic partial contacts and geometric elevations", () => {
  const { epoch, provider, result } = solveAnalytic({
    lunarAngularRadius: 0.009,
    minimumSeparation: 0.005,
  });
  assert.equal(result.valid, true);
  assert.equal(result.hasEclipse, true);
  assert.equal(result.kind, EclipseDiscPhase.PARTIAL);
  assert.equal(result.firstContact.valid, true);
  assert.equal(result.secondContact.valid, false);
  assert.equal(result.maximum.valid, true);
  assert.equal(result.thirdContact.valid, false);
  assert.equal(result.fourthContact.valid, true);
  assertContactOrder(result);
  close(eventOffset(result.maximum, epoch), 0.0, 0.05);

  const expectedContact = Math.sqrt(0.019 * 0.019 - 0.005 * 0.005) / 0.00001;
  close(eventOffset(result.firstContact, epoch), -expectedContact, 0.06);
  close(eventOffset(result.fourthContact, epoch), expectedContact, 0.06);
  assert.ok(Math.abs(result.firstContact.externalGap) < 6.0e-7);
  assert.ok(Math.abs(result.fourthContact.externalGap) < 6.0e-7);
  close(result.partialDurationSeconds, 2.0 * expectedContact, 0.12);
  close(result.maximum.sunCenterElevation, CesiumMath.PI_OVER_TWO, 1.0e-13);
  close(result.maximum.sunUpperLimbElevation, CesiumMath.PI_OVER_TWO, 1.0e-13);
  assert.equal(result.providerId, provider.id);
  assert.equal(result.providerRevision, provider.revision);
  assert.equal(result.provenance, provider.provenance);
  assert.equal(result.timePolicy, provider.timePolicy);
  assert.equal(result.transformBranch, ANALYTIC_BRANCH);
  assert.equal(result.toleranceSeconds, 0.05);
  assert.equal(result.evaluationCount, provider.calls);
  assert.ok(result.evaluationCount <= 90);
});

test("solver publishes a bounded physical solar-disc elevation at the horizon", () => {
  const { result } = solveAnalytic({
    lunarAngularRadius: 0.009,
    minimumSeparation: 0.005,
    sunCenterElevation: 0.0,
  });

  close(result.maximum.sunCenterElevation, 0.0, 1.0e-13);
  close(
    result.maximum.sunUpperLimbElevation,
    result.maximum.solarAngularRadius,
    1.0e-13,
  );
  assert.ok(result.maximum.sunUpperLimbElevation <= CesiumMath.PI_OVER_TWO);
});

test("solver resolves analytic total and annular internal contacts", () => {
  const cases = [
    {
      name: "total",
      lunarAngularRadius: 0.012,
      kind: EclipseDiscPhase.TOTAL,
      gap: "totalGap",
    },
    {
      name: "annular",
      lunarAngularRadius: 0.008,
      kind: EclipseDiscPhase.ANNULAR,
      gap: "annularGap",
    },
  ];

  for (const eclipseCase of cases) {
    const { epoch, provider, result } = solveAnalytic({
      lunarAngularRadius: eclipseCase.lunarAngularRadius,
      minimumSeparation: 0.001,
    });
    assert.equal(result.kind, eclipseCase.kind, eclipseCase.name);
    assert.equal(result.secondContact.valid, true, eclipseCase.name);
    assert.equal(result.thirdContact.valid, true, eclipseCase.name);
    assertContactOrder(result);

    const expectedExternal =
      Math.sqrt((0.01 + eclipseCase.lunarAngularRadius) ** 2 - 0.001 ** 2) /
      0.00001;
    const expectedInternal =
      Math.sqrt(
        Math.abs(0.01 - eclipseCase.lunarAngularRadius) ** 2 - 0.001 ** 2,
      ) / 0.00001;
    close(eventOffset(result.firstContact, epoch), -expectedExternal, 0.06);
    close(eventOffset(result.secondContact, epoch), -expectedInternal, 0.06);
    close(eventOffset(result.thirdContact, epoch), expectedInternal, 0.06);
    close(eventOffset(result.fourthContact, epoch), expectedExternal, 0.06);
    assert.ok(
      Math.abs(result.secondContact[eclipseCase.gap]) < 6.0e-7,
      eclipseCase.name,
    );
    assert.ok(
      Math.abs(result.thirdContact[eclipseCase.gap]) < 6.0e-7,
      eclipseCase.name,
    );
    close(result.centralDurationSeconds, 2.0 * expectedInternal, 0.12);
    assert.equal(result.evaluationCount, provider.calls);
    assert.ok(result.evaluationCount <= 140, eclipseCase.name);
  }
});

test("solver preserves exact midpoint roots for external and central contacts", () => {
  const setup = makeAnalyticSetup();
  const cases = [
    { name: "external", gapKind: 0, gapProperty: "externalGap" },
    { name: "central total", gapKind: 1, gapProperty: "totalGap" },
    { name: "central annular", gapKind: 2, gapProperty: "annularGap" },
  ];

  for (const rootCase of cases) {
    const solver = new EclipseLocalCircumstances(setup.provider);
    solver._evaluate = (offsetSeconds) => {
      const gap = offsetSeconds - 5.0;
      return {
        externalGap: gap,
        totalGap: gap,
        annularGap: gap,
      };
    };
    solver._storeEvent = (offsetSeconds, event) => {
      event.externalGap = offsetSeconds - 5.0;
      event.totalGap = offsetSeconds - 5.0;
      event.annularGap = offsetSeconds - 5.0;
      return event;
    };

    const root = solver._bisect(0.0, 10.0, -5.0, 5.0, rootCase.gapKind);
    assert.equal(root, 5.0, rootCase.name);
    assert.equal(solver._rootLeft, root, rootCase.name);
    assert.equal(solver._rootRight, root, rootCase.name);
    assert.equal(solver._rootLeftValue, 0.0, rootCase.name);
    assert.equal(solver._rootRightValue, 0.0, rootCase.name);
    assert.equal(solver._rootGapKind, rootCase.gapKind, rootCase.name);

    const event = {
      externalGap: Number.NaN,
      totalGap: Number.NaN,
      annularGap: Number.NaN,
    };
    assert.doesNotThrow(
      () => solver._storeContact(root, event, rootCase.gapKind),
      rootCase.name,
    );
    assert.equal(event[rootCase.gapProperty], 0.0, rootCase.name);
  }
});

test("solver returns a valid no-eclipse conjunction without contact events", () => {
  const { epoch, result } = solveAnalytic({
    lunarAngularRadius: 0.009,
    minimumSeparation: 0.025,
  });
  assert.equal(result.valid, true);
  assert.equal(result.hasEclipse, false);
  assert.equal(result.kind, EclipseDiscPhase.NONE);
  assert.equal(result.firstContact.valid, false);
  assert.equal(result.secondContact.valid, false);
  assert.equal(result.maximum.valid, true);
  assert.equal(result.thirdContact.valid, false);
  assert.equal(result.fourthContact.valid, false);
  close(eventOffset(result.maximum, epoch), 0.0, 0.05);
  assert.ok(result.maximum.externalGap > 0.0);
  assert.equal(result.partialDurationSeconds, 0.0);
  assert.equal(result.centralDurationSeconds, 0.0);
  assert.ok(result.evaluationCount <= 40);
});

test("solver has a deterministic evaluation count for identical inputs", () => {
  const setup = makeAnalyticSetup({
    lunarAngularRadius: 0.012,
    minimumSeparation: 0.001,
  });
  const solver = new EclipseLocalCircumstances(setup.provider);
  const first = EclipseLocalCircumstances.createResult();
  const second = EclipseLocalCircumstances.createResult();
  const options = {
    observer: setup.observer,
    ellipsoid: setup.ellipsoid,
    startTime: setup.startTime,
    stopTime: setup.stopTime,
  };
  solver.compute(options, first);
  solver.compute(options, second);

  assert.equal(second.evaluationCount, first.evaluationCount);
  assert.equal(second.kind, first.kind);
  assert.equal(
    JulianDate.secondsDifference(
      second.firstContact.time,
      first.firstContact.time,
    ),
    0.0,
  );
  assert.equal(
    JulianDate.secondsDifference(second.maximum.time, first.maximum.time),
    0.0,
  );
  assert.equal(
    JulianDate.secondsDifference(
      second.fourthContact.time,
      first.fourthContact.time,
    ),
    0.0,
  );
});

test("solver rejects reentrant compute and remains reusable", () => {
  const setup = makeAnalyticSetup({
    hostility: "reentrant",
    lunarAngularRadius: 0.009,
    minimumSeparation: 0.005,
  });
  const solver = new EclipseLocalCircumstances(setup.provider);
  const result = EclipseLocalCircumstances.createResult();
  const reentrantResult = EclipseLocalCircumstances.createResult();
  const maximumTimeIdentity = result.maximum.time;
  const options = {
    observer: setup.observer,
    ellipsoid: setup.ellipsoid,
    startTime: setup.startTime,
    stopTime: setup.stopTime,
  };
  let reentrantAttempts = 0;
  setup.provider._reentrantAttempt = () => {
    ++reentrantAttempts;
    assert.throws(
      () => solver.compute(options, reentrantResult),
      /cannot be called reentrantly/,
    );
  };

  assert.equal(solver.compute(options, result), result);
  assert.equal(result.valid, true);
  assert.equal(result.kind, EclipseDiscPhase.PARTIAL);
  assert.equal(reentrantResult.valid, false);
  assert.equal(reentrantResult.evaluationCount, 0);
  assert.equal(reentrantAttempts, 1);

  assert.equal(solver.compute(options, result), result);
  assert.equal(result.valid, true);
  assert.equal(result.maximum.time, maximumTimeIdentity);
  assert.equal(reentrantAttempts, 1);
});

test("solver rejects aliased caller-owned time and vector storage", () => {
  const setup = makeAnalyticSetup();
  const solver = new EclipseLocalCircumstances(setup.provider);
  const sharedTime = EclipseLocalCircumstances.createResult();
  sharedTime.secondContact.time = sharedTime.firstContact.time;
  assert.throws(
    () =>
      solver.compute(
        {
          observer: setup.observer,
          startTime: setup.startTime,
          stopTime: setup.stopTime,
        },
        sharedTime,
      ),
    /JulianDate objects must be distinct/,
  );

  const sharedVector = EclipseLocalCircumstances.createResult();
  sharedVector.thirdContact.sunDirectionWC =
    sharedVector.firstContact.sunDirectionWC;
  assert.throws(
    () =>
      solver.compute(
        {
          observer: setup.observer,
          startTime: setup.startTime,
          stopTime: setup.stopTime,
        },
        sharedVector,
      ),
    /Cartesian objects must be distinct/,
  );
});

test("solver preserves result, event, time, and vector identities across reuse and clears stale contacts", () => {
  const setup = makeAnalyticSetup({
    lunarAngularRadius: 0.012,
    minimumSeparation: 0.001,
  });
  const solver = new EclipseLocalCircumstances(setup.provider);
  const result = EclipseLocalCircumstances.createResult();
  const identities = {
    result,
    observerPositionWC: result.observerPositionWC,
    observerNormalWC: result.observerNormalWC,
    ellipsoidRadii: result.ellipsoidRadii,
    firstContact: result.firstContact,
    firstTime: result.firstContact.time,
    firstSunDirection: result.firstContact.sunDirectionWC,
    firstMoonDirection: result.firstContact.moonDirectionWC,
    secondContact: result.secondContact,
    secondTime: result.secondContact.time,
    maximum: result.maximum,
    maximumTime: result.maximum.time,
    thirdContact: result.thirdContact,
    fourthContact: result.fourthContact,
  };

  assert.equal(
    solver.compute(
      {
        observer: setup.observer,
        ellipsoid: setup.ellipsoid,
        startTime: setup.startTime,
        stopTime: setup.stopTime,
      },
      result,
    ),
    identities.result,
  );
  assert.equal(result.kind, EclipseDiscPhase.TOTAL);
  assert.equal(result.secondContact.valid, true);
  assert.equal(result.thirdContact.valid, true);

  setup.provider._lunarAngularRadius = 0.009;
  setup.provider._minimumSeparation = 0.005;
  ++setup.provider._revision;
  solver.compute(
    {
      observer: setup.observer,
      ellipsoid: setup.ellipsoid,
      startTime: setup.startTime,
      stopTime: setup.stopTime,
    },
    result,
  );
  assert.equal(result.kind, EclipseDiscPhase.PARTIAL);
  assert.equal(result.observerPositionWC, identities.observerPositionWC);
  assert.equal(result.observerNormalWC, identities.observerNormalWC);
  assert.equal(result.ellipsoidRadii, identities.ellipsoidRadii);
  assert.equal(result.firstContact, identities.firstContact);
  assert.equal(result.firstContact.time, identities.firstTime);
  assert.equal(
    result.firstContact.sunDirectionWC,
    identities.firstSunDirection,
  );
  assert.equal(
    result.firstContact.moonDirectionWC,
    identities.firstMoonDirection,
  );
  assert.equal(result.secondContact, identities.secondContact);
  assert.equal(result.secondContact.time, identities.secondTime);
  assert.equal(result.maximum, identities.maximum);
  assert.equal(result.maximum.time, identities.maximumTime);
  assert.equal(result.thirdContact, identities.thirdContact);
  assert.equal(result.fourthContact, identities.fourthContact);
  assert.equal(result.secondContact.valid, false);
  assert.equal(result.thirdContact.valid, false);
  assert.equal(result.secondContact.time.dayNumber, 0);
  assert.equal(result.secondContact.time.secondsOfDay, 0.0);
  assert.equal(Number.isNaN(result.secondContact.separation), true);
  assert.deepEqual(result.secondContact.sunDirectionWC, Cartesian3.ZERO);
  assert.deepEqual(result.thirdContact.moonDirectionWC, Cartesian3.ZERO);

  const retainedStartTime = result.startTime;
  const retainedStopTime = result.stopTime;
  solver.compute(
    {
      observer: setup.observer,
      ellipsoid: setup.ellipsoid,
      startTime: retainedStartTime,
      stopTime: retainedStopTime,
    },
    result,
  );
  assert.equal(result.startTime, retainedStartTime);
  assert.equal(result.stopTime, retainedStopTime);
  assert.equal(result.valid, true);
});

test("solver supports default, polar, antimeridian, triaxial, height, day, and leap boundaries", () => {
  const cases = [
    {
      name: "default ellipsoid and north pole",
      observer: Cartographic.fromDegrees(12.0, 90.0, 1000.0),
      ellipsoid: Ellipsoid.default,
      omitEllipsoid: true,
      epoch: JulianDate.fromIso8601("2024-04-08T23:59:59.9Z"),
    },
    {
      name: "antimeridian and leap boundary",
      observer: Cartographic.fromDegrees(180.0, -25.0, -50.0),
      ellipsoid: Ellipsoid.WGS84,
      epoch: JulianDate.fromIso8601("2017-01-01T00:00:00Z"),
    },
    {
      name: "custom triaxial ellipsoid and finite height",
      observer: Cartographic.fromDegrees(-179.999, 35.0, 123.5),
      ellipsoid: new Ellipsoid(7000000.0, 6000000.0, 5000000.0),
      epoch: JulianDate.fromIso8601("2026-08-12T00:00:00Z"),
    },
  ];

  for (const boundaryCase of cases) {
    const { epoch, result } = solveAnalytic({
      ...boundaryCase,
      lunarAngularRadius: 0.009,
      minimumSeparation: 0.005,
    });
    const expectedPosition = boundaryCase.ellipsoid.cartographicToCartesian(
      boundaryCase.observer,
      new Cartesian3(),
    );
    const expectedNormal =
      boundaryCase.ellipsoid.geodeticSurfaceNormalCartographic(
        boundaryCase.observer,
        new Cartesian3(),
      );
    assert.equal(result.valid, true, boundaryCase.name);
    assert.equal(result.kind, EclipseDiscPhase.PARTIAL, boundaryCase.name);
    assert.ok(
      Cartesian3.equalsEpsilon(
        result.observerPositionWC,
        expectedPosition,
        1.0e-9,
      ),
      boundaryCase.name,
    );
    assert.ok(
      Cartesian3.equalsEpsilon(
        result.observerNormalWC,
        expectedNormal,
        1.0e-15,
      ),
      boundaryCase.name,
    );
    assert.deepEqual(
      result.ellipsoidRadii,
      boundaryCase.ellipsoid.radii,
      boundaryCase.name,
    );
    assert.equal(result.observerHeight, boundaryCase.observer.height);
    close(eventOffset(result.maximum, epoch), 0.0, 0.05);
  }
});

test("solver rejects invalid and unpadded brackets before publishing a result", () => {
  const setup = makeAnalyticSetup({
    lunarAngularRadius: 0.012,
    minimumSeparation: 0.001,
  });
  const solver = new EclipseLocalCircumstances(setup.provider);
  const result = EclipseLocalCircumstances.createResult();
  const insideStart = JulianDate.addSeconds(
    setup.epoch,
    -100.0,
    new JulianDate(),
  );
  const insideStop = JulianDate.addSeconds(
    setup.epoch,
    100.0,
    new JulianDate(),
  );
  assert.throws(
    () =>
      solver.compute(
        {
          observer: setup.observer,
          ellipsoid: setup.ellipsoid,
          startTime: insideStart,
          stopTime: insideStop,
        },
        result,
      ),
    /strictly outside external contact/,
  );
  assert.equal(result.valid, false);
  assert.equal(result.hasEclipse, false);

  const tooLongStop = JulianDate.addSeconds(
    setup.startTime,
    36.0 * 60.0 * 60.0 + 0.01,
    new JulianDate(),
  );
  assert.throws(
    () =>
      solver.compute(
        {
          observer: setup.observer,
          ellipsoid: setup.ellipsoid,
          startTime: setup.startTime,
          stopTime: tooLongStop,
        },
        result,
      ),
    /no longer than 36 hours/,
  );
  assert.equal(result.evaluationCount, 0);

  assert.throws(
    () =>
      solver.compute(
        {
          observer: setup.observer,
          ellipsoid: setup.ellipsoid,
          startTime: setup.stopTime,
          stopTime: setup.startTime,
        },
        result,
      ),
    /positive, padded/,
  );
});

test("solver rejects non-finite observer and ellipsoid inputs", () => {
  const setup = makeAnalyticSetup();
  const solver = new EclipseLocalCircumstances(setup.provider);
  const result = EclipseLocalCircumstances.createResult();
  assert.throws(
    () =>
      solver.compute(
        {
          observer: new Cartographic(0.0, 0.0, Number.NaN),
          startTime: setup.startTime,
          stopTime: setup.stopTime,
        },
        result,
      ),
    /height must be finite/,
  );
  assert.throws(
    () =>
      solver.compute(
        {
          observer: setup.observer,
          ellipsoid: new Ellipsoid(1.0, 1.0, 0.0),
          startTime: setup.startTime,
          stopTime: setup.stopTime,
        },
        result,
      ),
    /finite, positive radii/,
  );
});

test("solver accepts a branch-sensitive revision established by the first sample", () => {
  const { provider, result } = solveAnalytic({
    hostility: "first-revision-transition",
    lunarAngularRadius: 0.009,
    minimumSeparation: 0.005,
  });
  assert.equal(result.valid, true);
  assert.equal(result.kind, EclipseDiscPhase.PARTIAL);
  assert.equal(result.providerRevision, 2);
  assert.equal(result.providerRevision, provider.revision);
  assert.equal(result.transformBranch, FIRST_TRANSITION_BRANCH);
});

test("solver aborts on provider declaration drift, identity violations, time mutation, and non-finite vectors", () => {
  const hostileCases = [
    { hostility: "revision-drift", message: /revision.*drifted/ },
    { hostility: "provenance-drift", message: /declaration changed/ },
    { hostility: "branch-drift", message: /transform branch drifted/ },
    { hostility: "replace-vector", message: /read only|Cannot assign/ },
    { hostility: "replace-sample", message: /replaced caller-owned/ },
    { hostility: "mutate-time", message: /mutated.*evaluation time/ },
    { hostility: "nonfinite", message: /non-finite position/ },
  ];

  for (const hostileCase of hostileCases) {
    const setup = makeAnalyticSetup({
      hostility: hostileCase.hostility,
      lunarAngularRadius: 0.009,
      minimumSeparation: 0.005,
    });
    const solver = new EclipseLocalCircumstances(setup.provider);
    const result = EclipseLocalCircumstances.createResult();
    assert.throws(
      () =>
        solver.compute(
          {
            observer: setup.observer,
            ellipsoid: setup.ellipsoid,
            startTime: setup.startTime,
            stopTime: setup.stopTime,
          },
          result,
        ),
      hostileCase.message,
      hostileCase.hostility,
    );
    assert.equal(result.valid, false, hostileCase.hostility);
    assert.equal(result.hasEclipse, false, hostileCase.hostility);
    assert.ok(result.evaluationCount >= 1, hostileCase.hostility);
  }
});

test("solver rejects a discontinuous sign change as a false contact root", () => {
  const setup = makeAnalyticSetup({
    hostility: "contact-discontinuity",
    lunarAngularRadius: 0.012,
    minimumSeparation: 0.001,
  });
  const result = EclipseLocalCircumstances.createResult();
  assert.throws(
    () =>
      new EclipseLocalCircumstances(setup.provider).compute(
        {
          observer: setup.observer,
          ellipsoid: setup.ellipsoid,
          startTime: setup.startTime,
          stopTime: setup.stopTime,
        },
        result,
      ),
    /contact root failed.*residual audit/,
  );
  assert.equal(result.valid, false);
  assert.equal(result.firstContact.valid, false);
  assert.ok(result.evaluationCount > 0);
});

test("a thrown provider cannot forge success or bypass failure clearing", () => {
  const result = EclipseLocalCircumstances.createResult();
  const setup = makeAnalyticSetup({
    hostility: "mutate-published-result-and-throw",
    publishedResult: result,
    lunarAngularRadius: 0.012,
    minimumSeparation: 0.001,
  });
  const solver = new EclipseLocalCircumstances(setup.provider);
  const options = {
    observer: setup.observer,
    ellipsoid: setup.ellipsoid,
    startTime: setup.startTime,
    stopTime: setup.stopTime,
  };

  assert.throws(
    () => solver.compute(options, result),
    /hostile published-result mutation/,
  );
  assert.equal(result.valid, false);
  assert.equal(result.hasEclipse, false);
  assert.equal(result.kind, EclipseDiscPhase.NONE);
  assert.equal(result.evaluationCount, 1);
  assert.equal(result.providerId, undefined);
  for (const event of [
    result.firstContact,
    result.secondContact,
    result.maximum,
    result.thirdContact,
    result.fourthContact,
  ]) {
    assert.equal(event.valid, false);
    assert.equal(event.time.dayNumber, 0);
    assert.equal(event.time.secondsOfDay, 0.0);
    assert.equal(Number.isNaN(event.separation), true);
    assert.deepEqual(event.sunDirectionWC, Cartesian3.ZERO);
    assert.deepEqual(event.moonDirectionWC, Cartesian3.ZERO);
  }

  assert.equal(solver.compute(options, result), result);
  assert.equal(result.valid, true);
  assert.equal(result.kind, EclipseDiscPhase.TOTAL);
});

test("a failed reused solve clears every partially published event", () => {
  const good = makeAnalyticSetup({
    lunarAngularRadius: 0.012,
    minimumSeparation: 0.001,
  });
  const result = EclipseLocalCircumstances.createResult();
  new EclipseLocalCircumstances(good.provider).compute(
    {
      observer: good.observer,
      ellipsoid: good.ellipsoid,
      startTime: good.startTime,
      stopTime: good.stopTime,
    },
    result,
  );
  assert.equal(result.valid, true);
  assert.equal(result.secondContact.valid, true);

  const hostile = makeAnalyticSetup({
    hostility: "branch-drift",
    lunarAngularRadius: 0.012,
    minimumSeparation: 0.001,
  });
  assert.throws(
    () =>
      new EclipseLocalCircumstances(hostile.provider).compute(
        {
          observer: hostile.observer,
          ellipsoid: hostile.ellipsoid,
          startTime: hostile.startTime,
          stopTime: hostile.stopTime,
        },
        result,
      ),
    /transform branch drifted/,
  );
  assert.equal(result.valid, false);
  assert.equal(result.hasEclipse, false);
  assert.equal(result.firstContact.valid, false);
  assert.equal(result.secondContact.valid, false);
  assert.equal(result.maximum.valid, false);
  assert.equal(result.thirdContact.valid, false);
  assert.equal(result.fourthContact.valid, false);
  assert.deepEqual(result.maximum.sunDirectionWC, Cartesian3.ZERO);
  assert.equal(result.providerId, undefined);
  assert.equal(result.evaluationCount, 3);
});

test("canonical-radius point geometry is total at all four requested observations", async () => {
  const provider = await AstronomyEngineEphemerisProvider.create();
  const sample = CelestialEphemerisProvider.createSample();
  const geometry = createEclipseDiscGeometry();
  const observerPositionWC = new Cartesian3();
  const observations = [
    {
      name: "Luarca, Spain",
      iso8601: "2026-08-12T18:26:50Z",
      longitude: -6.5353,
      latitude: 43.5433,
    },
    {
      name: "Reykjavik, Iceland",
      iso8601: "2026-08-12T17:48:47.1Z",
      longitude: -21.9426,
      latitude: 64.1466,
    },
    {
      name: "Erie, Pennsylvania",
      iso8601: "2024-04-08T19:18:11Z",
      longitude: -80.0851,
      latitude: 42.1292,
    },
    {
      name: "Torreon, Mexico",
      iso8601: "2024-04-08T18:19:41Z",
      longitude: -103.4068,
      latitude: 25.5428,
    },
  ];

  for (const observation of observations) {
    const observerPosition = Ellipsoid.WGS84.cartographicToCartesian(
      Cartographic.fromDegrees(observation.longitude, observation.latitude),
      observerPositionWC,
    );
    provider.compute(JulianDate.fromIso8601(observation.iso8601), sample);
    computeEclipseDiscGeometry(sample, observerPosition, geometry);
    assert.equal(geometry.solarRadius, 695500000.0, observation.name);
    assert.equal(geometry.lunarRadius, 1737400.0, observation.name);
    assert.equal(geometry.phase, EclipseDiscPhase.TOTAL, observation.name);
    assert.ok(geometry.totalGap < 0.0, observation.name);
    assert.equal(geometry.obscuration, 1.0, observation.name);
  }
});

test("high-precision full solves resolve one 2024 and one 2026 total eclipse", async () => {
  const events = [
    {
      name: "Erie 2024",
      observer: Cartographic.fromDegrees(-80.0851, 42.1292, 0.0),
      startTime: JulianDate.fromIso8601("2024-04-08T17:00:00Z"),
      stopTime: JulianDate.fromIso8601("2024-04-08T21:00:00Z"),
    },
    {
      name: "Luarca 2026",
      observer: Cartographic.fromDegrees(-6.5353, 43.5433, 0.0),
      startTime: JulianDate.fromIso8601("2026-08-12T16:00:00Z"),
      stopTime: JulianDate.fromIso8601("2026-08-12T20:00:00Z"),
    },
  ];

  for (const event of events) {
    const provider = await AstronomyEngineEphemerisProvider.create();
    const solver = new EclipseLocalCircumstances(provider);
    const result = EclipseLocalCircumstances.createResult();
    solver.compute(
      {
        observer: event.observer,
        ellipsoid: Ellipsoid.WGS84,
        startTime: event.startTime,
        stopTime: event.stopTime,
      },
      result,
    );
    assert.equal(result.valid, true, event.name);
    assert.equal(result.hasEclipse, true, event.name);
    assert.equal(result.kind, EclipseDiscPhase.TOTAL, event.name);
    assert.equal(result.secondContact.valid, true, event.name);
    assert.equal(result.thirdContact.valid, true, event.name);
    assertContactOrder(result);
    assert.ok(result.partialDurationSeconds > 100.0, event.name);
    assert.ok(result.centralDurationSeconds > 1.0, event.name);
    assert.ok(Math.abs(result.firstContact.externalGap) < 2.0e-7, event.name);
    assert.ok(Math.abs(result.fourthContact.externalGap) < 2.0e-7, event.name);
    assert.equal(result.solarRadius, 695500000.0, event.name);
    assert.equal(result.providerId, provider.id, event.name);
    assert.equal(result.providerRevision, provider.revision, event.name);
    assert.equal(result.provenance, provider.provenance, event.name);
    assert.equal(result.timePolicy, provider.timePolicy, event.name);
    assert.equal(
      result.transformBranch,
      "GEOVECTOR_EQJ_TO_EQD_TO_ECEF_NEGATIVE_GAST",
      event.name,
    );
    assert.ok(result.evaluationCount <= 150, event.name);
  }
});
