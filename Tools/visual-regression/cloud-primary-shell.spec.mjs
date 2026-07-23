import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import CloudVolumetrics from "../../packages/engine/Source/Scene/CloudVolumetrics.js";

const WGS84_A = 6378137.0;
const WGS84_B = 6356752.314245179;
const DECK_BOTTOM = 1500.0;
const DECK_TOP = 4000.0;
const CAMERA_HEIGHT = 20000.0;
const ORBIT_HEIGHT = 18_000_000.0;

// These are root-distance tolerances, not claims about cloud-surface altitude
// accuracy. At an 18,000 km camera height the roots themselves are roughly
// 18-31 million metres, where one f32 ULP is already 2 m. A nadir ray remains
// well-conditioned, while near-horizon discriminant cancellation amplifies
// f32 error as the half-chord approaches zero. Exact tangency is deliberately
// excluded: a correctly-rounded f32 discriminant may land on either side of
// zero there, so it cannot be used as a precision oracle.
const ORBIT_NADIR_ROOT_TOLERANCE_METERS = 4.0;
const ORBIT_NEAR_HORIZON_ROOT_TOLERANCE_METERS = 64.0;
const ORBIT_GRAZING_ROOT_TOLERANCE_METERS = 512.0;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const shaderPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/ProceduralClouds.wgsl",
);
const rendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function addScaled(a, b, scale) {
  return [
    a[0] + b[0] * scale,
    a[1] + b[1] * scale,
    a[2] + b[2] * scale,
  ];
}

function divide(a, b) {
  return [a[0] / b[0], a[1] / b[1], a[2] / b[2]];
}

function magnitude(a) {
  return Math.sqrt(dot(a, a));
}

function normalize(a) {
  const inverseMagnitude = 1.0 / magnitude(a);
  return [
    a[0] * inverseMagnitude,
    a[1] * inverseMagnitude,
    a[2] * inverseMagnitude,
  ];
}

function addF32(left, right) {
  return Math.fround(Math.fround(left) + Math.fround(right));
}

function subtractF32(left, right) {
  return Math.fround(Math.fround(left) - Math.fround(right));
}

function multiplyF32(left, right) {
  return Math.fround(Math.fround(left) * Math.fround(right));
}

function divideF32(left, right) {
  return Math.fround(Math.fround(left) / Math.fround(right));
}

function dotF32(left, right) {
  return addF32(
    addF32(
      multiplyF32(left[0], right[0]),
      multiplyF32(left[1], right[1]),
    ),
    multiplyF32(left[2], right[2]),
  );
}

function divideVectorF32(left, right) {
  return [
    divideF32(left[0], right[0]),
    divideF32(left[1], right[1]),
    divideF32(left[2], right[2]),
  ];
}

function shellAxes(height) {
  return [WGS84_A + height, WGS84_A + height, WGS84_B + height];
}

function wgs84Cartesian(latitudeDegrees, longitudeDegrees, height) {
  const latitude = (latitudeDegrees * Math.PI) / 180.0;
  const longitude = (longitudeDegrees * Math.PI) / 180.0;
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const sinLongitude = Math.sin(longitude);
  const cosLongitude = Math.cos(longitude);
  const eccentricitySquared =
    1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
  const primeVerticalRadius =
    WGS84_A /
    Math.sqrt(1.0 - eccentricitySquared * sinLatitude * sinLatitude);

  return [
    (primeVerticalRadius + height) * cosLatitude * cosLongitude,
    (primeVerticalRadius + height) * cosLatitude * sinLongitude,
    (primeVerticalRadius * (1.0 - eccentricitySquared) + height) *
      sinLatitude,
  ];
}

function rayEllipsoidIntersect(origin, direction, axes) {
  const originScaled = divide(origin, axes);
  const directionScaled = divide(direction, axes);
  const a = dot(directionScaled, directionScaled);
  const closestT = -dot(originScaled, directionScaled) / a;
  const closest = addScaled(originScaled, directionScaled, closestT);
  const halfChordSquared = (1.0 - dot(closest, closest)) / a;
  assert.ok(halfChordSquared >= 0.0, "ray must intersect the shell");
  const halfChord = Math.sqrt(halfChordSquared);
  return [closestT - halfChord, closestT + halfChord];
}

function encode(value) {
  const high =
    Math.sign(value) * Math.floor(Math.abs(value) / 65536.0) * 65536.0;
  return [Math.fround(high), Math.fround(value - high)];
}

function encodedNegativeCenter(camera) {
  const high = [];
  const low = [];
  for (const component of camera) {
    const encoded = encode(component);
    high.push(Math.fround(-encoded[0]));
    low.push(Math.fround(-encoded[1]));
  }
  return { high, low };
}

/**
 * Numeric oracle for `rayEllipsoidIntersectRTE` in ProceduralClouds.wgsl.
 *
 * JavaScript normally evaluates every expression as f64, which made the old
 * oracle substantially more accurate than the shader it claimed to model.
 * Round the uniform inputs and every arithmetic operation to f32, including
 * vector divisions, dot-product lanes, the discriminant, sqrt, and final root
 * add/subtract. This models the non-contracted operation sequence authored in
 * WGSL; a driver may contract a dot product, so browser evidence remains the
 * final authority.
 */
function rayEllipsoidIntersectRteF32(
  direction,
  centerHigh,
  centerLow,
  axes,
) {
  const directionF32 = direction.map(Math.fround);
  const centerHighF32 = centerHigh.map(Math.fround);
  const centerLowF32 = centerLow.map(Math.fround);
  const axesF32 = axes.map(Math.fround);
  const directionScaled = divideVectorF32(directionF32, axesF32);
  const highScaled = divideVectorF32(centerHighF32, axesF32);
  const lowScaled = divideVectorF32(centerLowF32, axesF32);
  const a = Math.max(
    dotF32(directionScaled, directionScaled),
    Math.fround(1e-20),
  );
  const closestT = divideF32(
    addF32(
      dotF32(directionScaled, highScaled),
      dotF32(directionScaled, lowScaled),
    ),
    a,
  );
  const closest = [
    subtractF32(
      subtractF32(
        multiplyF32(directionScaled[0], closestT),
        highScaled[0],
      ),
      lowScaled[0],
    ),
    subtractF32(
      subtractF32(
        multiplyF32(directionScaled[1], closestT),
        highScaled[1],
      ),
      lowScaled[1],
    ),
    subtractF32(
      subtractF32(
        multiplyF32(directionScaled[2], closestT),
        highScaled[2],
      ),
      lowScaled[2],
    ),
  ];
  const halfChordSquared = divideF32(
    subtractF32(1.0, dotF32(closest, closest)),
    a,
  );
  assert.ok(halfChordSquared >= 0.0, "RTE ray must intersect the shell");
  const halfChord = Math.fround(Math.sqrt(Math.fround(halfChordSquared)));
  return [
    subtractF32(closestT, halfChord),
    addF32(closestT, halfChord),
  ];
}

/**
 * Build a world-space direction whose line has a chosen closest approach to
 * the unit sphere after ellipsoid scaling. `closestScaledRadius < 1` is a
 * bounded hit; exactly 1 would be a tangent and is intentionally not tested.
 */
function directionForScaledClosestApproach(
  camera,
  axes,
  closestScaledRadius,
  tangentSeed,
) {
  const scaledCamera = divide(camera, axes);
  const scaledCameraDirection = normalize(scaledCamera);
  const seedProjection = dot(tangentSeed, scaledCameraDirection);
  const tangent = normalize(
    tangentSeed.map(
      (component, index) =>
        component - seedProjection * scaledCameraDirection[index],
    ),
  );
  const scaledCameraRadius = magnitude(scaledCamera);
  const sinAngle = closestScaledRadius / scaledCameraRadius;
  const cosAngle = Math.sqrt(1.0 - sinAngle * sinAngle);
  const scaledDirection = scaledCameraDirection.map(
    (component, index) =>
      -cosAngle * component + sinAngle * tangent[index],
  );
  return normalize(
    scaledDirection.map((component, index) => component * axes[index]),
  );
}

function shellHeightFraction(position, innerAxes, outerAxes) {
  const innerScaled = divide(position, innerAxes);
  const outerScaled = divide(position, outerAxes);
  const fromInner = Math.max(dot(innerScaled, innerScaled) - 1.0, 0.0);
  const toOuter = Math.max(1.0 - dot(outerScaled, outerScaled), 0.0);
  return Math.min(
    Math.max(fromInner / Math.max(fromInner + toOuter, 1e-7), 0.0),
    1.0,
  );
}

test("the old equatorial sphere misclassifies a polar 20 km camera below the deck", () => {
  const camera = wgs84Cartesian(90.0, 0.0, CAMERA_HEIGHT);
  const oldSphericalAltitude = magnitude(camera) - WGS84_A;

  assert.ok(
    oldSphericalAltitude < DECK_BOTTOM,
    `expected old spherical altitude below ${DECK_BOTTOM}m, got ${oldSphericalAltitude}m`,
  );
  assert.ok(CAMERA_HEIGHT > DECK_TOP);
});

test("WGS84 shell intersections cover equator, antimeridian, and both poles", () => {
  const locations = [
    {
      name: "equator",
      camera: wgs84Cartesian(0.0, 0.0, CAMERA_HEIGHT),
      down: [-1, 0, 0],
    },
    {
      name: "antimeridian",
      camera: wgs84Cartesian(0.0, 180.0, CAMERA_HEIGHT),
      down: [1, 0, 0],
    },
    {
      name: "north pole",
      camera: wgs84Cartesian(90.0, 0.0, CAMERA_HEIGHT),
      down: [0, 0, -1],
    },
    {
      name: "south pole",
      camera: wgs84Cartesian(-90.0, 0.0, CAMERA_HEIGHT),
      down: [0, 0, 1],
    },
  ];

  for (const { name, camera, down } of locations) {
    const outer = rayEllipsoidIntersect(camera, down, shellAxes(DECK_TOP));
    const inner = rayEllipsoidIntersect(camera, down, shellAxes(DECK_BOTTOM));
    const center = encodedNegativeCenter(camera);
    const outerRte = rayEllipsoidIntersectRteF32(
      down,
      center.high,
      center.low,
      shellAxes(DECK_TOP),
    );
    const innerRte = rayEllipsoidIntersectRteF32(
      down,
      center.high,
      center.low,
      shellAxes(DECK_BOTTOM),
    );

    assert.ok(
      Math.abs(outer[0] - 16000.0) < 1e-4,
      `${name}: legacy outer root`,
    );
    assert.ok(
      Math.abs(inner[0] - 18500.0) < 1e-4,
      `${name}: legacy inner root`,
    );
    assert.ok(
      Math.abs(outerRte[0] - 16000.0) < 1.0,
      `${name}: RTE outer root`,
    );
    assert.ok(
      Math.abs(innerRte[0] - 18500.0) < 1.0,
      `${name}: RTE inner root`,
    );
    assert.ok(outerRte[0] < innerRte[0], `${name}: near interval ordering`);
  }
});

test("below, inside, and above-deck cameras select the near visible interval", () => {
  const cases = [
    {
      name: "below",
      height: 800.0,
      direction: [1, 0, 0],
      expected: [700.0, 3200.0],
    },
    {
      name: "inside",
      height: 2200.0,
      direction: [1, 0, 0],
      expected: [0.0, 1800.0],
    },
    {
      name: "above",
      height: 9000.0,
      direction: [-1, 0, 0],
      expected: [5000.0, 7500.0],
    },
  ];

  for (const { name, height, direction, expected } of cases) {
    const camera = wgs84Cartesian(0.0, 0.0, height);
    const outer = rayEllipsoidIntersect(
      camera,
      direction,
      shellAxes(DECK_TOP),
    );
    const inner = rayEllipsoidIntersect(
      camera,
      direction,
      shellAxes(DECK_BOTTOM),
    );
    let interval;
    if (height < DECK_BOTTOM) {
      interval = [Math.max(inner[1], 0.0), outer[1]];
    } else if (height > DECK_TOP) {
      interval = [Math.max(outer[0], 0.0), inner[0]];
    } else {
      interval = [0.0, outer[1]];
    }

    assert.ok(
      Math.abs(interval[0] - expected[0]) < 1e-4,
      `${name}: interval start`,
    );
    assert.ok(
      Math.abs(interval[1] - expected[1]) < 1e-4,
      `${name}: interval end`,
    );
  }
});

test("high/low RTE f32 roots stay bounded for an 18,000 km nadir ray", () => {
  const camera = wgs84Cartesian(35.0, 179.999, ORBIT_HEIGHT);
  const direction = normalize(camera.map((component) => -component));
  const center = encodedNegativeCenter(camera);
  let worstRootError = 0.0;

  for (const height of [DECK_BOTTOM, DECK_TOP]) {
    const axes = shellAxes(height);
    const reference = rayEllipsoidIntersect(camera, direction, axes);
    const rte = rayEllipsoidIntersectRteF32(
      direction,
      center.high,
      center.low,
      axes,
    );

    assert.ok(reference[0] > 0.0);
    worstRootError = Math.max(
      worstRootError,
      Math.abs(rte[0] - reference[0]),
      Math.abs(rte[1] - reference[1]),
    );
  }

  assert.ok(
    worstRootError <= ORBIT_NADIR_ROOT_TOLERANCE_METERS,
    `18,000 km nadir root error ${worstRootError}m exceeded ${ORBIT_NADIR_ROOT_TOLERANCE_METERS}m`,
  );
});

test("18,000 km near-horizon and grazing RTE f32 roots have bounded non-tangent error", () => {
  const camera = wgs84Cartesian(35.0, 179.999, ORBIT_HEIGHT);
  const center = encodedNegativeCenter(camera);
  const tangentSeeds = [
    [0.0, 0.0, 1.0],
    [0.0, 1.0, 0.0],
  ];
  const cases = [
    {
      name: "near horizon",
      // Leaves a substantial (~90 km) half-chord in scaled-shell terms.
      closestScaledRadius: 0.9999,
      tolerance: ORBIT_NEAR_HORIZON_ROOT_TOLERANCE_METERS,
    },
    {
      name: "near grazing",
      // Leaves only a roughly 9 km half-chord. This is close enough to expose
      // discriminant cancellation, but remains bounded away from tangency.
      closestScaledRadius: 0.999999,
      tolerance: ORBIT_GRAZING_ROOT_TOLERANCE_METERS,
    },
  ];

  for (const testCase of cases) {
    let worstRootError = 0.0;
    for (const height of [DECK_BOTTOM, DECK_TOP]) {
      const axes = shellAxes(height);
      for (const tangentSeed of tangentSeeds) {
        const direction = directionForScaledClosestApproach(
          camera,
          axes,
          testCase.closestScaledRadius,
          tangentSeed,
        );
        const reference = rayEllipsoidIntersect(camera, direction, axes);
        const rte = rayEllipsoidIntersectRteF32(
          direction,
          center.high,
          center.low,
          axes,
        );

        assert.ok(reference[0] > 0.0, `${testCase.name}: reference hit`);
        assert.ok(rte[0] > 0.0, `${testCase.name}: f32 hit`);
        assert.ok(rte[0] < rte[1], `${testCase.name}: ordered f32 roots`);
        worstRootError = Math.max(
          worstRootError,
          Math.abs(rte[0] - reference[0]),
          Math.abs(rte[1] - reference[1]),
        );
      }
    }

    assert.ok(
      worstRootError <= testCase.tolerance,
      `${testCase.name} root error ${worstRootError}m exceeded ${testCase.tolerance}m`,
    );
  }
});

test("oblate height fractions preserve both deck boundaries without square roots", () => {
  for (const axis of [0, 2]) {
    const bottom = [0, 0, 0];
    const middle = [0, 0, 0];
    const top = [0, 0, 0];
    bottom[axis] = shellAxes(DECK_BOTTOM)[axis];
    middle[axis] = shellAxes((DECK_BOTTOM + DECK_TOP) * 0.5)[axis];
    top[axis] = shellAxes(DECK_TOP)[axis];

    assert.equal(
      shellHeightFraction(
        bottom,
        shellAxes(DECK_BOTTOM),
        shellAxes(DECK_TOP),
      ),
      0.0,
    );
    assert.ok(
      Math.abs(
        shellHeightFraction(
          middle,
          shellAxes(DECK_BOTTOM),
          shellAxes(DECK_TOP),
        ) - 0.5,
      ) < 0.001,
    );
    assert.equal(
      shellHeightFraction(top, shellAxes(DECK_BOTTOM), shellAxes(DECK_TOP)),
      1.0,
    );
  }
});

test("planetary cloud precision defaults on and retains an explicit false A/B route", () => {
  assert.equal(new CloudVolumetrics().cloudHighPrecision, true);
  assert.equal(
    new CloudVolumetrics({ cloudHighPrecision: false }).cloudHighPrecision,
    false,
  );
});

test("visible WGSL uses oblate intersections while the bounded shadow path is unchanged", () => {
  const shader = fs.readFileSync(shaderPath, "utf8");
  const visibleMarch = shader.slice(
    shader.indexOf("fn marchDeck("),
    shader.indexOf("fn multiDeckEnabled()"),
  );
  const shadowMarch = shader.slice(shader.indexOf("fn cloudShadowMain("));

  assert.match(shader, /planetPolarRadius:\s*f32/);
  assert.match(shader, /cameraGeodeticHeight:\s*f32/);
  assert.match(visibleMarch, /rayEllipsoidIntersectRTE\(/);
  assert.match(visibleMarch, /rayEllipsoidIntersect\(rayOrigin/);
  assert.match(
    visibleMarch,
    /let cameraAltitude = cloud\.cameraGeodeticHeight;/,
  );
  assert.doesNotMatch(visibleMarch, /raySphereIntersect/);
  assert.doesNotMatch(visibleMarch, /rteRadialDistance/);
  assert.match(shadowMarch, /raySphereIntersect\(columnPoint/);
});

test("renderer reuses uniform padding and keeps the 148-float layout stable", () => {
  const renderer = fs.readFileSync(rendererPath, "utf8");

  assert.match(renderer, /const CLOUD_UNIFORM_FLOATS = 148;/);
  assert.match(
    renderer,
    /data\[offset\+\+\] = WGS84_POLAR_RADIUS;[\s\S]*data\[offset\+\+\] = cameraHeightM;/,
  );
  assert.match(renderer, /\.cloudHighPrecision !== false;/);
});
