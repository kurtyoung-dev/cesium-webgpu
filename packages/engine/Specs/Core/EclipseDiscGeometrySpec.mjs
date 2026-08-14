import assert from "node:assert/strict";
import test from "node:test";

import Cartesian3 from "../../Source/Core/Cartesian3.js";
import computeEclipseDiscGeometry, {
  clearEclipseDiscGeometry,
  createEclipseDiscGeometry,
  EclipseDiscPhase,
} from "../../Source/Core/EclipseDiscGeometry.js";
import CesiumMath from "../../Source/Core/Math.js";

const observer = new Cartesian3(6378137.0, -1200.0, 800.0);

function setTopocentricPosition(
  target,
  angularOffset,
  angularRadius,
  physicalRadius,
) {
  const distance = physicalRadius / Math.sin(angularRadius);
  target.x = observer.x + distance * Math.cos(angularOffset);
  target.y = observer.y + distance * Math.sin(angularOffset);
  target.z = observer.z;
}

function makeSample(
  separation,
  solarAngularRadius = 0.01,
  lunarAngularRadius = 0.009,
) {
  const sample = {
    sunPositionWC: new Cartesian3(),
    moonPositionWC: new Cartesian3(),
  };
  setTopocentricPosition(
    sample.sunPositionWC,
    0.0,
    solarAngularRadius,
    CesiumMath.SOLAR_RADIUS,
  );
  setTopocentricPosition(
    sample.moonPositionWC,
    separation,
    lunarAngularRadius,
    CesiumMath.LUNAR_RADIUS,
  );
  return sample;
}

function compute(
  separation,
  solarAngularRadius,
  lunarAngularRadius,
  result = createEclipseDiscGeometry(),
) {
  return computeEclipseDiscGeometry(
    makeSample(separation, solarAngularRadius, lunarAngularRadius),
    observer,
    result,
  );
}

function close(actual, expected, epsilon = 1.0e-13) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${actual} differs from ${expected} by more than ${epsilon}`,
  );
}

test("disc geometry publishes the exact Cesium radii and preserves caller identities", () => {
  const result = createEclipseDiscGeometry();
  const resultIdentity = result;
  const sunDirectionIdentity = result.sunDirectionWC;
  const moonDirectionIdentity = result.moonDirectionWC;

  assert.equal(compute(0.005, 0.01, 0.009, result), resultIdentity);
  assert.equal(result.sunDirectionWC, sunDirectionIdentity);
  assert.equal(result.moonDirectionWC, moonDirectionIdentity);
  assert.equal(result.solarRadius, CesiumMath.SOLAR_RADIUS);
  assert.equal(result.lunarRadius, CesiumMath.LUNAR_RADIUS);
  assert.equal(result.solarRadius, 695700000.0);
  assert.equal(result.lunarRadius, 1737400.0);
  close(result.solarAngularRadius, 0.01);
  close(result.lunarAngularRadius, 0.009);
  close(result.separation, 0.005);
  assert.equal(result.valid, true);

  clearEclipseDiscGeometry(result);
  assert.equal(result, resultIdentity);
  assert.equal(result.sunDirectionWC, sunDirectionIdentity);
  assert.equal(result.moonDirectionWC, moonDirectionIdentity);
  assert.equal(result.phase, EclipseDiscPhase.NONE);
  assert.equal(result.valid, false);
  assert.equal(Number.isNaN(result.separation), true);
  assert.deepEqual(result.sunDirectionWC, Cartesian3.ZERO);
  assert.deepEqual(result.moonDirectionWC, Cartesian3.ZERO);
});

test("disc geometry classifies analytic none, partial, total, and annular cases", () => {
  const none = compute(0.021, 0.01, 0.009);
  assert.equal(none.phase, EclipseDiscPhase.NONE);
  assert.equal(none.moonInFront, true);
  assert.ok(none.externalGap > 0.0);
  assert.equal(none.magnitude, 0.0);
  assert.equal(none.obscuration, 0.0);

  const partial = compute(0.005, 0.01, 0.009);
  assert.equal(partial.phase, EclipseDiscPhase.PARTIAL);
  assert.ok(partial.externalGap < 0.0);
  assert.ok(partial.totalGap > 0.0);
  assert.ok(partial.annularGap > 0.0);
  close(partial.rawMagnitude, 0.7);
  close(partial.magnitude, 0.7);
  assert.ok(partial.obscuration > 0.0 && partial.obscuration < 1.0);

  const total = compute(0.001, 0.01, 0.012);
  assert.equal(total.phase, EclipseDiscPhase.TOTAL);
  assert.ok(total.totalGap < 0.0);
  assert.ok(total.rawMagnitude > 1.0);
  assert.equal(total.magnitude, total.rawMagnitude);
  assert.ok(total.magnitude > 1.0);
  assert.equal(total.obscuration, 1.0);

  const annular = compute(0.001, 0.01, 0.008);
  assert.equal(annular.phase, EclipseDiscPhase.ANNULAR);
  assert.ok(annular.annularGap < 0.0);
  assert.ok(annular.rawMagnitude < 1.0);
  close(annular.obscuration, 0.64, 2.0e-13);
});

test("disc geometry uses strict central classification at tangency", () => {
  const commonDistanceScale = 100.0;
  const equalRadiusInternalTangency = computeEclipseDiscGeometry(
    {
      sunPositionWC: new Cartesian3(
        CesiumMath.SOLAR_RADIUS * commonDistanceScale,
        0.0,
        0.0,
      ),
      moonPositionWC: new Cartesian3(
        CesiumMath.LUNAR_RADIUS * commonDistanceScale,
        0.0,
        0.0,
      ),
    },
    Cartesian3.ZERO,
    createEclipseDiscGeometry(),
  );
  close(equalRadiusInternalTangency.totalGap, 0.0);
  close(equalRadiusInternalTangency.annularGap, 0.0);
  assert.equal(equalRadiusInternalTangency.phase, EclipseDiscPhase.PARTIAL);
  assert.equal(equalRadiusInternalTangency.magnitude, 1.0);
  assert.equal(equalRadiusInternalTangency.obscuration, 1.0);

  const immediatelyInsideExternalContact = compute(
    0.019 - 1.0e-10,
    0.01,
    0.009,
  );
  const immediatelyOutsideExternalContact = compute(
    0.019 + 1.0e-10,
    0.01,
    0.009,
  );
  assert.equal(
    immediatelyInsideExternalContact.phase,
    EclipseDiscPhase.PARTIAL,
  );
  assert.equal(immediatelyOutsideExternalContact.phase, EclipseDiscPhase.NONE);
});

test("disc separation uses stable atan2 geometry and observer-subtracted vectors", () => {
  const result = compute(1.0e-12, 0.01, 0.009);
  close(result.separation, 1.0e-12, 1.0e-16);
  close(Cartesian3.magnitude(result.sunDirectionWC), 1.0, 1.0e-15);
  close(Cartesian3.magnitude(result.moonDirectionWC), 1.0, 1.0e-15);
  close(result.sunDirectionWC.x, 1.0, 1.0e-15);
  close(result.sunDirectionWC.y, 0.0, 1.0e-15);
  close(result.moonDirectionWC.y, 1.0e-12, 1.0e-16);

  const sample = makeSample(0.004, 0.01, 0.009);
  const translatedObserver = new Cartesian3(
    observer.x + 1000000.0,
    observer.y - 2000000.0,
    observer.z + 3000000.0,
  );
  sample.sunPositionWC.x += 1000000.0;
  sample.sunPositionWC.y -= 2000000.0;
  sample.sunPositionWC.z += 3000000.0;
  sample.moonPositionWC.x += 1000000.0;
  sample.moonPositionWC.y -= 2000000.0;
  sample.moonPositionWC.z += 3000000.0;
  const translated = computeEclipseDiscGeometry(
    sample,
    translatedObserver,
    createEclipseDiscGeometry(),
  );
  close(translated.separation, 0.004);
  close(translated.solarAngularRadius, 0.01);
  close(translated.lunarAngularRadius, 0.009);
});

test("disc obscuration is the geometric circle-lens area", () => {
  const result = compute(0.01, 0.01, 0.01);
  const expected = 2.0 / 3.0 - Math.sqrt(3.0) / (2.0 * Math.PI);
  close(result.obscuration, expected, 2.0e-13);
});

test("disc geometry reports a rearward Moon as no solar eclipse", () => {
  const sample = makeSample(0.0, 0.01, 0.00001);
  const result = computeEclipseDiscGeometry(
    sample,
    observer,
    createEclipseDiscGeometry(),
  );
  assert.equal(result.moonInFront, false);
  assert.equal(result.phase, EclipseDiscPhase.NONE);
  assert.equal(result.magnitude, result.rawMagnitude);
  assert.ok(result.magnitude > 0.0);
  assert.equal(result.obscuration, 0.0);
  assert.ok(result.rawMagnitude > 0.0);
});

test("disc geometry rejects aliases, non-finite inputs, and interior observers", () => {
  const sample = makeSample(0.0, 0.01, 0.009);
  const aliased = createEclipseDiscGeometry();
  aliased.moonDirectionWC = aliased.sunDirectionWC;
  assert.throws(
    () => computeEclipseDiscGeometry(sample, observer, aliased),
    /must be distinct/,
  );

  sample.sunPositionWC.x = Number.NaN;
  assert.throws(
    () =>
      computeEclipseDiscGeometry(sample, observer, createEclipseDiscGeometry()),
    /finite components/,
  );

  const nearSample = {
    sunPositionWC: new Cartesian3(observer.x + 1.0, observer.y, observer.z),
    moonPositionWC: new Cartesian3(observer.x, observer.y + 1.0, observer.z),
  };
  assert.throws(
    () =>
      computeEclipseDiscGeometry(
        nearSample,
        observer,
        createEclipseDiscGeometry(),
      ),
    /outside both apparent-body spheres/,
  );
});
