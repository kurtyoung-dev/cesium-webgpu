import assert from "node:assert/strict";
import test from "node:test";

import {
  DeltaT_EspenakMeeus as deltaTEspenakMeeus,
  SetDeltaTFunction as setDeltaTFunction,
} from "astronomy-engine";

import AstronomyEngineEphemerisProvider from "../../Source/Core/AstronomyEngineEphemerisProvider.js";
import AstronomyEngineTimeAdapter from "../../Source/Core/AstronomyEngineTimeAdapter.js";
import Cartesian3 from "../../Source/Core/Cartesian3.js";
import Cartographic from "../../Source/Core/Cartographic.js";
import CelestialEphemerisProvider from "../../Source/Core/CelestialEphemerisProvider.js";
import Ellipsoid from "../../Source/Core/Ellipsoid.js";
import JulianDate from "../../Source/Core/JulianDate.js";
import Matrix3 from "../../Source/Core/Matrix3.js";
import Simon1994EphemerisProvider from "../../Source/Core/Simon1994EphemerisProvider.js";
import Transforms from "../../Source/Core/Transforms.js";

const solarRadiusMetres = 695700000.0;
const lunarRadiusMetres = 1737400.0;

function relativeError(actual, expected) {
  return Math.abs((actual - expected) / expected);
}

function apparentDiscObscuration(sample, longitude, latitude) {
  const observer = Ellipsoid.WGS84.cartographicToCartesian(
    Cartographic.fromDegrees(longitude, latitude),
  );
  const sun = Cartesian3.subtract(
    sample.sunPositionWC,
    observer,
    new Cartesian3(),
  );
  const moon = Cartesian3.subtract(
    sample.moonPositionWC,
    observer,
    new Cartesian3(),
  );
  const sunAngularRadius = Math.asin(
    solarRadiusMetres / Cartesian3.magnitude(sun),
  );
  const moonAngularRadius = Math.asin(
    lunarRadiusMetres / Cartesian3.magnitude(moon),
  );
  Cartesian3.normalize(sun, sun);
  Cartesian3.normalize(moon, moon);
  const separation = Math.acos(
    Math.min(1.0, Math.max(-1.0, Cartesian3.dot(sun, moon))),
  );

  if (separation <= moonAngularRadius - sunAngularRadius) {
    return 1.0;
  }
  if (separation >= moonAngularRadius + sunAngularRadius) {
    return 0.0;
  }

  const sunSquared = sunAngularRadius * sunAngularRadius;
  const moonSquared = moonAngularRadius * moonAngularRadius;
  const separationSquared = separation * separation;
  const sunAngle = Math.acos(
    Math.min(
      1.0,
      Math.max(
        -1.0,
        (separationSquared + sunSquared - moonSquared) /
          (2.0 * separation * sunAngularRadius),
      ),
    ),
  );
  const moonAngle = Math.acos(
    Math.min(
      1.0,
      Math.max(
        -1.0,
        (separationSquared + moonSquared - sunSquared) /
          (2.0 * separation * moonAngularRadius),
      ),
    ),
  );
  const lens =
    sunSquared * sunAngle +
    moonSquared * moonAngle -
    0.5 *
      Math.sqrt(
        Math.max(
          0.0,
          (-separation + sunAngularRadius + moonAngularRadius) *
            (separation + sunAngularRadius - moonAngularRadius) *
            (separation - sunAngularRadius + moonAngularRadius) *
            (separation + sunAngularRadius + moonAngularRadius),
        ),
      );
  return lens / (Math.PI * sunSquared);
}

test("CelestialEphemerisProvider is abstract and creates distinct output vectors", () => {
  assert.throws(
    () => new CelestialEphemerisProvider(),
    /interface and should not be called directly/,
  );

  const first = CelestialEphemerisProvider.createSample();
  const second = CelestialEphemerisProvider.createSample();
  assert.notEqual(first, second);
  assert.notEqual(first.sunPositionWC, first.moonPositionWC);
  assert.notEqual(first.sunPositionWC, second.sunPositionWC);
  assert.notEqual(first.moonPositionWC, second.moonPositionWC);
});

test("Simon1994EphemerisProvider retains caller identities and reports its transform branch", () => {
  const provider = new Simon1994EphemerisProvider();
  const result = CelestialEphemerisProvider.createSample();
  const sunIdentity = result.sunPositionWC;
  const moonIdentity = result.moonPositionWC;
  const time = JulianDate.fromIso8601("2024-04-08T19:18:11Z");

  assert.equal(provider.compute(time, result), result);
  assert.equal(result.sunPositionWC, sunIdentity);
  assert.equal(result.moonPositionWC, moonIdentity);
  assert.match(
    result.transformBranch,
    /^SIMON1994_(ICRF_TO_FIXED|TEME_TO_PSEUDO_FIXED)_/,
  );
  assert.equal(result.referenceFrame, "ECEF");
  assert.equal(result.units, "metres");
  assert.equal(result.providerId, provider.id);
  assert.equal(result.providerRevision, 1);
  assert.equal(result.outputAllocationStable, true);
  assert.equal(result.thirdPartyTemporaryFree, true);
  assert.equal(provider.provenance.sampleValidationTemporaryFree, true);
  assert.ok(
    relativeError(Cartesian3.magnitude(result.sunPositionWC), 1.49825e11) <
      0.001,
  );
  assert.ok(
    relativeError(Cartesian3.magnitude(result.moonPositionWC), 3.5985e8) <
      0.002,
  );

  const firstSun = Cartesian3.clone(result.sunPositionWC);
  const firstMoon = Cartesian3.clone(result.moonPositionWC);
  provider.compute(time, result);
  assert.deepEqual(result.sunPositionWC, firstSun);
  assert.deepEqual(result.moonPositionWC, firstMoon);
});

test("Simon1994EphemerisProvider reports both ICRF and TEME branches", () => {
  const originalIcrf = Transforms.computeIcrfToFixedMatrix;
  const originalTeme = Transforms.computeTemeToPseudoFixedMatrix;
  const time = JulianDate.fromIso8601("2024-04-08T19:18:11Z");
  const provider = new Simon1994EphemerisProvider();
  const result = CelestialEphemerisProvider.createSample();

  try {
    Transforms.computeIcrfToFixedMatrix = function (date, matrixResult) {
      assert.equal(date, time);
      return Matrix3.clone(Matrix3.IDENTITY, matrixResult);
    };
    Transforms.computeTemeToPseudoFixedMatrix = function () {
      throw new Error("TEME must not run when ICRF is available");
    };
    provider.compute(time, result);
    assert.equal(result.transformBranch, "SIMON1994_ICRF_TO_FIXED_IAU2006_XYS");
    assert.equal(result.providerRevision, 2);
    assert.equal(provider.revision, 2);

    Transforms.computeIcrfToFixedMatrix = function () {
      return undefined;
    };
    Transforms.computeTemeToPseudoFixedMatrix = function (date, matrixResult) {
      assert.equal(date, time);
      return Matrix3.clone(Matrix3.IDENTITY, matrixResult);
    };
    provider.compute(time, result);
    assert.equal(
      result.transformBranch,
      "SIMON1994_TEME_TO_PSEUDO_FIXED_IAU1982_GMST",
    );
    assert.equal(result.providerRevision, 1);
    assert.equal(provider.revision, 1);
  } finally {
    Transforms.computeIcrfToFixedMatrix = originalIcrf;
    Transforms.computeTemeToPseudoFixedMatrix = originalTeme;
  }
});

test("Simon1994EphemerisProvider invalidates a retained TEME cache key when ICRF becomes available", () => {
  const originalIcrf = Transforms.computeIcrfToFixedMatrix;
  const originalTeme = Transforms.computeTemeToPseudoFixedMatrix;
  const time = JulianDate.fromIso8601("2024-04-08T19:18:11Z");
  const provider = new Simon1994EphemerisProvider();
  const result = CelestialEphemerisProvider.createSample();
  let icrfReady = false;

  try {
    Transforms.computeIcrfToFixedMatrix = function (date, matrixResult) {
      assert.equal(JulianDate.equals(date, time), true);
      if (!icrfReady) {
        return undefined;
      }
      return Matrix3.fromRotationZ(0.25, matrixResult);
    };
    Transforms.computeTemeToPseudoFixedMatrix = function (date, matrixResult) {
      assert.equal(JulianDate.equals(date, time), true);
      return Matrix3.clone(Matrix3.IDENTITY, matrixResult);
    };

    provider.compute(time, result);
    const fallbackSun = Cartesian3.clone(result.sunPositionWC);
    const fallbackCacheKey = `${time.dayNumber}/${time.secondsOfDay}/${provider.revision}`;
    assert.equal(
      result.transformBranch,
      "SIMON1994_TEME_TO_PSEUDO_FIXED_IAU1982_GMST",
    );
    assert.equal(result.providerRevision, 1);

    // Models Transforms.preloadIcrfFixed resolving while simulation time stays
    // fixed. The retained provider must expose a new cache key before compute.
    icrfReady = true;
    const icrfCacheKey = `${time.dayNumber}/${time.secondsOfDay}/${provider.revision}`;
    assert.notEqual(icrfCacheKey, fallbackCacheKey);
    assert.equal(provider.revision, 2);

    provider.compute(time, result);
    assert.equal(result.transformBranch, "SIMON1994_ICRF_TO_FIXED_IAU2006_XYS");
    assert.equal(result.providerRevision, 2);
    assert.equal(provider.revision, 2);
    assert.notDeepEqual(result.sunPositionWC, fallbackSun);
  } finally {
    Transforms.computeIcrfToFixedMatrix = originalIcrf;
    Transforms.computeTemeToPseudoFixedMatrix = originalTeme;
  }
});

test("createSample brands and hardens every output, component, and metadata slot", () => {
  const result = CelestialEphemerisProvider.createSample();
  const sunPositionWC = result.sunPositionWC;
  const moonPositionWC = result.moonPositionWC;

  assert.equal(Object.isSealed(result), true);
  assert.equal(Object.isSealed(sunPositionWC), true);
  assert.equal(Object.isSealed(moonPositionWC), true);

  for (const name of ["sunPositionWC", "moonPositionWC"]) {
    const descriptor = Object.getOwnPropertyDescriptor(result, name);
    assert.equal(descriptor.configurable, false, name);
    assert.equal(descriptor.writable, false, name);
    assert.ok(Object.hasOwn(descriptor, "value"), name);
  }
  for (const vector of [sunPositionWC, moonPositionWC]) {
    for (const name of ["x", "y", "z"]) {
      const descriptor = Object.getOwnPropertyDescriptor(vector, name);
      assert.equal(descriptor.configurable, false, name);
      assert.equal(descriptor.writable, true, name);
      assert.ok(Object.hasOwn(descriptor, "value"), name);
    }
  }
  for (const name of [
    "providerId",
    "providerRevision",
    "provenance",
    "timePolicy",
    "referenceFrame",
    "units",
    "transformBranch",
    "outputAllocationStable",
    "thirdPartyTemporaryFree",
  ]) {
    const descriptor = Object.getOwnPropertyDescriptor(result, name);
    assert.equal(descriptor.configurable, false, name);
    assert.equal(descriptor.writable, true, name);
    assert.ok(Object.hasOwn(descriptor, "value"), name);
  }

  assert.throws(() => {
    result.sunPositionWC = moonPositionWC;
  }, TypeError);
  assert.throws(
    () => Object.defineProperty(result, "providerId", { set() {} }),
    TypeError,
  );
  assert.throws(
    () =>
      Object.defineProperty(sunPositionWC, "x", {
        get() {
          return 0.0;
        },
      }),
    TypeError,
  );
});

test("providers reject custom, inherited, and proxy samples before property reads", async () => {
  const providers = [
    new Simon1994EphemerisProvider(),
    await AstronomyEngineEphemerisProvider.create(),
  ];
  const time = JulianDate.fromIso8601("2024-04-08T19:18:11Z");

  for (const provider of providers) {
    let getterReads = 0;
    const custom = {
      get sunPositionWC() {
        getterReads++;
        return new Cartesian3();
      },
      get moonPositionWC() {
        getterReads++;
        return new Cartesian3();
      },
    };
    assert.throws(
      () => provider.compute(time, custom),
      /must be returned by CelestialEphemerisProvider\.createSample/,
      provider.id,
    );
    assert.equal(getterReads, 0, provider.id);

    const inherited = Object.create(CelestialEphemerisProvider.createSample());
    assert.throws(
      () => provider.compute(time, inherited),
      /must be returned by CelestialEphemerisProvider\.createSample/,
      provider.id,
    );

    let proxyTraps = 0;
    const proxy = new Proxy(CelestialEphemerisProvider.createSample(), {
      get() {
        proxyTraps++;
        throw new Error("sample properties must not be read");
      },
      getOwnPropertyDescriptor() {
        proxyTraps++;
        throw new Error("sample descriptors must not be read");
      },
    });
    assert.throws(
      () => provider.compute(time, proxy),
      /must be returned by CelestialEphemerisProvider\.createSample/,
      provider.id,
    );
    assert.equal(proxyTraps, 0, provider.id);
  }
});

test("brand validation and finalization do not query property descriptors", () => {
  const result = CelestialEphemerisProvider.createSample();
  const declaration = Object.freeze({ id: "test" });
  const provider = {
    id: "test-provider",
    revision: 0,
    provenance: declaration,
    timePolicy: declaration,
    outputAllocationStable: true,
    thirdPartyTemporaryFree: true,
  };
  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  let descriptorQueries = 0;

  try {
    Object.getOwnPropertyDescriptor = function (...args) {
      descriptorQueries++;
      return originalGetOwnPropertyDescriptor.apply(Object, args);
    };
    CelestialEphemerisProvider.validateResult(result);
    assert.equal(
      CelestialEphemerisProvider.finalizeResult(result, provider, "TEST"),
      result,
    );
  } finally {
    Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
  }

  assert.equal(descriptorQueries, 0);
});

test("Simon1994EphemerisProvider rejects reentrant compute without corrupting its outer state", () => {
  const originalIcrf = Transforms.computeIcrfToFixedMatrix;
  const originalTeme = Transforms.computeTemeToPseudoFixedMatrix;
  const outerTime = JulianDate.fromIso8601("2024-04-08T19:18:11Z");
  const innerTime = JulianDate.fromIso8601("2026-08-12T18:26:50Z");
  const provider = new Simon1994EphemerisProvider();
  const outer = CelestialEphemerisProvider.createSample();
  const inner = CelestialEphemerisProvider.createSample();
  let icrfReady = false;
  let reentrantError;

  try {
    Transforms.computeTemeToPseudoFixedMatrix = function (date, matrixResult) {
      assert.equal(JulianDate.equals(date, outerTime), true);
      return Matrix3.clone(Matrix3.IDENTITY, matrixResult);
    };
    let attemptedReentry = false;
    Transforms.computeIcrfToFixedMatrix = function (date, matrixResult) {
      assert.equal(JulianDate.equals(date, outerTime), true);
      if (!attemptedReentry) {
        attemptedReentry = true;
        try {
          provider.compute(innerTime, inner);
        } catch (error) {
          reentrantError = error;
        }
      }
      return icrfReady
        ? Matrix3.clone(Matrix3.IDENTITY, matrixResult)
        : undefined;
    };

    assert.equal(provider.compute(outerTime, outer), outer);
    assert.equal(attemptedReentry, true);
    assert.match(reentrantError?.message, /does not support reentrant compute/);
    assert.equal(
      outer.transformBranch,
      "SIMON1994_TEME_TO_PSEUDO_FIXED_IAU1982_GMST",
    );
    assert.equal(outer.providerRevision, 1);
    assert.equal(inner.providerId, undefined);
    assert.deepEqual(inner.sunPositionWC, Cartesian3.ZERO);
    assert.deepEqual(inner.moonPositionWC, Cartesian3.ZERO);

    icrfReady = true;
    assert.equal(provider.revision, 2);
    assert.equal(outer.providerRevision, 1);
  } finally {
    Transforms.computeIcrfToFixedMatrix = originalIcrf;
    Transforms.computeTemeToPseudoFixedMatrix = originalTeme;
  }
});

test("Simon1994EphemerisProvider rejects non-finite computed vectors", () => {
  const originalIcrf = Transforms.computeIcrfToFixedMatrix;
  const provider = new Simon1994EphemerisProvider();
  const result = CelestialEphemerisProvider.createSample();
  const time = JulianDate.fromIso8601("2024-04-08T19:18:11Z");

  try {
    Transforms.computeIcrfToFixedMatrix = function (date, matrixResult) {
      assert.equal(date, time);
      Matrix3.clone(Matrix3.IDENTITY, matrixResult);
      matrixResult[0] = Number.NaN;
      return matrixResult;
    };
    assert.throws(() => provider.compute(time, result), /non-finite position/);
  } finally {
    Transforms.computeIcrfToFixedMatrix = originalIcrf;
  }
});

test("AstronomyEngineEphemerisProvider is lazy-created and pins provenance", async () => {
  assert.throws(
    () => new AstronomyEngineEphemerisProvider(),
    /Use AstronomyEngineEphemerisProvider.create/,
  );

  const provider = await AstronomyEngineEphemerisProvider.create();
  assert.equal(provider.id, "astronomy-engine-2.1.19-ecef");
  assert.equal(provider.revision, 1);
  assert.equal(provider.outputAllocationStable, true);
  assert.equal(provider.thirdPartyTemporaryFree, false);
  assert.equal(provider.provenance.packageVersion, "2.1.19");
  assert.equal(provider.provenance.astronomicalUnitMetres, 149597870700.0);
  assert.equal(provider.provenance.eventSpecificCorrections, false);
  assert.equal(provider.provenance.angularRadiusCorrections, false);
  assert.equal(provider.provenance.mutatesGlobalDeltaT, false);
  assert.equal(provider.provenance.outputAllocationStable, true);
  assert.equal(provider.provenance.sampleValidationTemporaryFree, true);
  assert.equal(provider.provenance.thirdPartyTemporaryFree, false);
  assert.equal(Object.isFrozen(provider.provenance), true);
  assert.equal(Object.isFrozen(provider.timePolicy), true);
});

test("AstronomyEngineEphemerisProvider retains outputs and is deterministic", async () => {
  const provider = await AstronomyEngineEphemerisProvider.create();
  const time = JulianDate.fromIso8601("2000-01-01T12:00:00Z");
  const result = CelestialEphemerisProvider.createSample();
  const sunIdentity = result.sunPositionWC;
  const moonIdentity = result.moonPositionWC;

  assert.equal(provider.compute(time, result), result);
  assert.equal(result.sunPositionWC, sunIdentity);
  assert.equal(result.moonPositionWC, moonIdentity);
  assert.equal(
    result.transformBranch,
    "GEOVECTOR_EQJ_TO_EQD_TO_ECEF_NEGATIVE_GAST",
  );
  assert.equal(result.outputAllocationStable, true);
  assert.equal(result.thirdPartyTemporaryFree, false);

  // Component fixtures pin EQJ->EQD order, the negative-GAST sign, axes, and
  // exact IAU-2012 AU conversion for astronomy-engine 2.1.19.
  assert.ok(Math.abs(result.sunPositionWC.x - 135361097000.73042) < 1.0);
  assert.ok(Math.abs(result.sunPositionWC.y - 1940133444.177021) < 1.0);
  assert.ok(Math.abs(result.sunPositionWC.z + 57554407771.16586) < 1.0);
  assert.ok(Math.abs(result.moonPositionWC.x - 209385108.01448286) < 0.01);
  assert.ok(Math.abs(result.moonPositionWC.y + 335147739.2109932) < 0.01);
  assert.ok(Math.abs(result.moonPositionWC.z + 76103947.02001451) < 0.01);

  const firstSun = Cartesian3.clone(result.sunPositionWC);
  const firstMoon = Cartesian3.clone(result.moonPositionWC);
  provider.compute(time, result);
  assert.deepEqual(result.sunPositionWC, firstSun);
  assert.deepEqual(result.moonPositionWC, firstMoon);

  const second = CelestialEphemerisProvider.createSample();
  provider.compute(time, second);
  assert.notEqual(second, result);
  assert.notEqual(second.sunPositionWC, result.sunPositionWC);
  assert.notEqual(second.moonPositionWC, result.moonPositionWC);
  assert.deepEqual(second.sunPositionWC, result.sunPositionWC);
  assert.deepEqual(second.moonPositionWC, result.moonPositionWC);
});

test("AstronomyEngineEphemerisProvider fails closed on changed delta-T before caller writes", async () => {
  const provider = await AstronomyEngineEphemerisProvider.create();
  const time = JulianDate.fromIso8601("2026-08-12T18:26:50Z");
  const utcDays = AstronomyEngineTimeAdapter.toUtcDaysSinceJ2000(time);
  const baseline = CelestialEphemerisProvider.createSample();
  const zeroDeltaT = () => 0.0;

  setDeltaTFunction(deltaTEspenakMeeus);
  provider.compute(time, baseline);

  try {
    const assertRejectedWithoutWrites = (deltaTFunction) => {
      const rejected = CelestialEphemerisProvider.createSample();
      Cartesian3.fromElements(1.0, 2.0, 3.0, rejected.sunPositionWC);
      Cartesian3.fromElements(4.0, 5.0, 6.0, rejected.moonPositionWC);
      const rejectedSun = Cartesian3.clone(rejected.sunPositionWC);
      const rejectedMoon = Cartesian3.clone(rejected.moonPositionWC);

      setDeltaTFunction(deltaTFunction);
      assert.throws(
        () => provider.compute(time, rejected),
        /global delta-T function no longer matches/,
      );
      assert.deepEqual(rejected.sunPositionWC, rejectedSun);
      assert.deepEqual(rejected.moonPositionWC, rejectedMoon);
      assert.equal(rejected.providerId, undefined);
      assert.equal(rejected.providerRevision, undefined);
    };

    assertRejectedWithoutWrites(zeroDeltaT);

    // This mutant passes the root-time equality check but diverges at the
    // backdated light-time samples created by GeoVector. The pinned AddDays
    // subclass must detect it before either caller-owned vector is written.
    assertRejectedWithoutWrites((ut) =>
      ut === utcDays ? deltaTEspenakMeeus(ut) : 0.0,
    );

    assertRejectedWithoutWrites(zeroDeltaT);
    assert.equal(
      provider.timePolicy.deltaTPolicy,
      "ASTRONOMY_ENGINE_2_1_19_ESPENAK_MEEUS",
    );
  } finally {
    setDeltaTFunction(deltaTEspenakMeeus);
  }

  const restored = CelestialEphemerisProvider.createSample();
  assert.equal(provider.compute(time, restored), restored);
});

test("AstronomyEngine vectors produce total obscuration at the four requested observers", async () => {
  const provider = await AstronomyEngineEphemerisProvider.create();
  const result = CelestialEphemerisProvider.createSample();
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
    provider.compute(JulianDate.fromIso8601(observation.iso8601), result);
    const obscuration = apparentDiscObscuration(
      result,
      observation.longitude,
      observation.latitude,
    );
    assert.equal(obscuration, 1.0, observation.name);
    assert.ok(
      Cartesian3.magnitude(result.sunPositionWC) > 1.47e11 &&
        Cartesian3.magnitude(result.sunPositionWC) < 1.53e11,
      observation.name,
    );
    assert.ok(
      Cartesian3.magnitude(result.moonPositionWC) > 3.5e8 &&
        Cartesian3.magnitude(result.moonPositionWC) < 4.1e8,
      observation.name,
    );
  }
});
