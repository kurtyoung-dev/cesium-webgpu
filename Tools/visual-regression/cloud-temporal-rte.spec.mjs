import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CLOUD_TEMPORAL_RESET_DECK_BOUNDS,
  CLOUD_TEMPORAL_RESET_FRAME_GAP,
  CLOUD_TEMPORAL_RESET_INITIAL,
  CLOUD_TEMPORAL_RESET_MISSING_TRANSFORM,
  CLOUD_TEMPORAL_RESET_MORPH,
  CLOUD_TEMPORAL_RESET_MULTI_DECK,
  CLOUD_TEMPORAL_RESET_NONE,
  CLOUD_TEMPORAL_RESET_PROJECTION,
  CLOUD_TEMPORAL_RESET_REACTIVATED,
  CLOUD_TEMPORAL_RESET_RESOURCE,
  CLOUD_TEMPORAL_RESET_SCENE_MODE,
  CLOUD_TEMPORAL_RESET_TELEPORT,
  classifyCloudTemporalHistoryReset,
  cloudTemporalResetStartsGeneration,
  commitCloudTemporalHistoryState,
} from "../../packages/engine/Source/Renderer/WebGPU/WebGPUCloudTemporalHistory.ts";

const WGS84_A = 6378137.0;
const WGS84_B = 6356752.314245179;
const DECK_BOTTOM = 1500.0;
const DECK_TOP = 4000.0;
const DECK_MID = 0.5 * (DECK_BOTTOM + DECK_TOP);
const CAMERA_HEIGHT = 20_000.0;
const ORBIT_HEIGHT = 18_000_000.0;

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const rendererPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUProceduralCloudRenderer.ts",
);
const shaderPath = path.join(
  root,
  "packages/engine/Source/Shaders/WebGPU/Environment/CloudTemporalResolve.wgsl",
);
const helperPath = path.join(
  root,
  "packages/engine/Source/Renderer/WebGPU/WebGPUCloudTemporalHistory.ts",
);

const rendererSource = fs.readFileSync(rendererPath, "utf8");
const shaderSource = fs.readFileSync(shaderPath, "utf8");
const helperSource = fs.readFileSync(helperPath, "utf8");

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

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function dotF32(left, right) {
  return addF32(
    addF32(multiplyF32(left[0], right[0]), multiplyF32(left[1], right[1])),
    multiplyF32(left[2], right[2]),
  );
}

function magnitude(vector) {
  return Math.sqrt(dot(vector, vector));
}

function normalize(vector) {
  const inverseMagnitude = 1.0 / magnitude(vector);
  return vector.map((component) => component * inverseMagnitude);
}

function divideVector(left, right) {
  return [left[0] / right[0], left[1] / right[1], left[2] / right[2]];
}

function divideVectorF32(left, right) {
  return [
    divideF32(left[0], right[0]),
    divideF32(left[1], right[1]),
    divideF32(left[2], right[2]),
  ];
}

function addScaled(vector, direction, scale) {
  return [
    vector[0] + direction[0] * scale,
    vector[1] + direction[1] * scale,
    vector[2] + direction[2] * scale,
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
  const eccentricitySquared = 1.0 - (WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
  const primeVerticalRadius =
    WGS84_A / Math.sqrt(1.0 - eccentricitySquared * sinLatitude * sinLatitude);

  return [
    (primeVerticalRadius + height) * cosLatitude * cosLongitude,
    (primeVerticalRadius + height) * cosLatitude * sinLongitude,
    (primeVerticalRadius * (1.0 - eccentricitySquared) + height) * sinLatitude,
  ];
}

function rayEllipsoidIntersect(origin, direction, axes) {
  const scaledOrigin = divideVector(origin, axes);
  const scaledDirection = divideVector(direction, axes);
  const a = dot(scaledDirection, scaledDirection);
  const closestT = -dot(scaledOrigin, scaledDirection) / a;
  const closest = addScaled(scaledOrigin, scaledDirection, closestT);
  const halfChordSquared = (1.0 - dot(closest, closest)) / a;
  assert.ok(halfChordSquared >= 0.0, "reference ray must hit");
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
    const [encodedHigh, encodedLow] = encode(component);
    high.push(Math.fround(-encodedHigh));
    low.push(Math.fround(-encodedLow));
  }
  return { high, low };
}

/**
 * f32-faithful model of the intended temporal-shell RTE intersection.
 *
 * The current camera is the local origin. The ellipsoid center is supplied as
 * encoded negative-camera high/low parts, so no full-ECEF f32 anchor is formed.
 */
function rayEllipsoidIntersectRteF32(direction, centerHigh, centerLow, axes) {
  const directionF32 = direction.map(Math.fround);
  const axesF32 = axes.map(Math.fround);
  const directionScaled = divideVectorF32(directionF32, axesF32);
  const highScaled = divideVectorF32(centerHigh, axesF32);
  const lowScaled = divideVectorF32(centerLow, axesF32);
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
      subtractF32(multiplyF32(directionScaled[0], closestT), highScaled[0]),
      lowScaled[0],
    ),
    subtractF32(
      subtractF32(multiplyF32(directionScaled[1], closestT), highScaled[1]),
      lowScaled[1],
    ),
    subtractF32(
      subtractF32(multiplyF32(directionScaled[2], closestT), highScaled[2]),
      lowScaled[2],
    ),
  ];
  const halfChordSquared = divideF32(
    subtractF32(1.0, dotF32(closest, closest)),
    a,
  );
  assert.ok(halfChordSquared >= 0.0, "RTE ray must hit");
  const halfChord = Math.fround(Math.sqrt(halfChordSquared));
  return [subtractF32(closestT, halfChord), addF32(closestT, halfChord)];
}

function nearestNonnegativeRoot(roots) {
  if (roots[0] > 0.0) {
    return roots[0];
  }
  if (roots[1] > 0.0) {
    return roots[1];
  }
  return -1.0;
}

function legacyRawEcefSphereHitF32(camera, direction, radius) {
  const origin = camera.map(Math.fround);
  const ray = direction.map(Math.fround);
  const tClosest = Math.fround(-dotF32(origin, ray));
  const closest = [
    addF32(origin[0], multiplyF32(ray[0], tClosest)),
    addF32(origin[1], multiplyF32(ray[1], tClosest)),
    addF32(origin[2], multiplyF32(ray[2], tClosest)),
  ];
  const halfChordSquared = subtractF32(
    multiplyF32(radius, radius),
    dotF32(closest, closest),
  );
  if (halfChordSquared < 0.0) {
    return -1.0;
  }
  const halfChord = Math.fround(Math.sqrt(halfChordSquared));
  const near = subtractF32(tClosest, halfChord);
  const far = addF32(tClosest, halfChord);
  return near > 0.0 ? near : far > 0.0 ? far : -1.0;
}

function directionForScaledClosestApproach(camera, axes, closestScaledRadius) {
  const scaledCamera = divideVector(camera, axes);
  const radial = normalize(scaledCamera);
  const seed = Math.abs(radial[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const projection = dot(seed, radial);
  const tangent = normalize(
    seed.map((component, index) => component - projection * radial[index]),
  );
  const scaledCameraRadius = magnitude(scaledCamera);
  const sinAngle = closestScaledRadius / scaledCameraRadius;
  const cosAngle = Math.sqrt(1.0 - sinAngle * sinAngle);
  const scaledDirection = radial.map(
    (component, index) => -cosAngle * component + sinAngle * tangent[index],
  );
  return normalize(
    scaledDirection.map((component, index) => component * axes[index]),
  );
}

function freshState() {
  return {
    initialized: false,
    temporalActive: false,
    transformValid: false,
    lastHistoryFrameNumber: -1,
    cameraX: 0,
    cameraY: 0,
    cameraZ: 0,
    sceneMode: 3,
    morphing: false,
    projectionType: 0,
    deckBottom: DECK_BOTTOM,
    deckTop: DECK_TOP,
    multiDeck: false,
  };
}

function sample(overrides = {}) {
  return {
    frameNumber: 1,
    temporalActive: true,
    transformValid: true,
    cameraX: WGS84_A + 800.0,
    cameraY: 0,
    cameraZ: 0,
    sceneMode: 3,
    morphing: false,
    projectionType: 0,
    deckBottom: DECK_BOTTOM,
    deckTop: DECK_TOP,
    multiDeck: false,
    ...overrides,
  };
}

function expectOnlyReason(baseState, nextSample, expectedReason) {
  assert.equal(
    classifyCloudTemporalHistoryReset(baseState, nextSample),
    expectedReason,
  );
  commitCloudTemporalHistoryState(baseState, nextSample, true);
  const following = { ...nextSample, frameNumber: nextSample.frameNumber + 1 };
  assert.equal(
    classifyCloudTemporalHistoryReset(baseState, following),
    CLOUD_TEMPORAL_RESET_NONE,
    "one discontinuity must seed exactly one history frame",
  );
}

test("desired WGS84/RTE temporal anchor is bounded at equator, dateline, and poles", () => {
  const fixtures = [
    { name: "equator", latitude: 0, longitude: 0, down: [-1, 0, 0] },
    {
      name: "antimeridian",
      latitude: 0,
      longitude: 180,
      down: [1, 0, 0],
    },
    {
      name: "north pole",
      latitude: 90,
      longitude: 45,
      down: [0, 0, -1],
    },
    {
      name: "south pole",
      latitude: -90,
      longitude: -45,
      down: [0, 0, 1],
    },
  ];
  const axes = shellAxes(DECK_MID);

  for (const fixture of fixtures) {
    const camera = wgs84Cartesian(
      fixture.latitude,
      fixture.longitude,
      CAMERA_HEIGHT,
    );
    const reference = nearestNonnegativeRoot(
      rayEllipsoidIntersect(camera, fixture.down, axes),
    );
    const center = encodedNegativeCenter(camera);
    const rte = nearestNonnegativeRoot(
      rayEllipsoidIntersectRteF32(fixture.down, center.high, center.low, axes),
    );

    assert.ok(reference > 0.0, `${fixture.name}: reference hit`);
    assert.ok(rte > 0.0, `${fixture.name}: RTE hit`);
    assert.ok(
      Math.abs(rte - reference) <= 1.0,
      `${fixture.name}: ${Math.abs(rte - reference)}m root error`,
    );
  }
});

test("desired WGS84/RTE temporal anchor remains bounded near the orbit horizon", () => {
  const camera = wgs84Cartesian(35.0, 179.999, ORBIT_HEIGHT);
  const axes = shellAxes(DECK_MID);
  const direction = directionForScaledClosestApproach(camera, axes, 0.999999);
  const reference = nearestNonnegativeRoot(
    rayEllipsoidIntersect(camera, direction, axes),
  );
  const center = encodedNegativeCenter(camera);
  const rte = nearestNonnegativeRoot(
    rayEllipsoidIntersectRteF32(direction, center.high, center.low, axes),
  );

  assert.ok(reference > 0.0);
  assert.ok(rte > 0.0);
  assert.ok(
    Math.abs(rte - reference) <= 512.0,
    `near-grazing temporal root error ${Math.abs(rte - reference)}m`,
  );
});

test("legacy raw-ECEF equatorial-sphere anchor fails the polar WGS84 fixture", () => {
  const camera = wgs84Cartesian(90.0, 0.0, CAMERA_HEIGHT);
  const direction = [0, 0, -1];
  const reference = nearestNonnegativeRoot(
    rayEllipsoidIntersect(camera, direction, shellAxes(DECK_MID)),
  );
  const legacy = legacyRawEcefSphereHitF32(
    camera,
    direction,
    Math.fround(WGS84_A + DECK_MID),
  );

  assert.ok(Math.abs(reference - 17_250.0) < 1e-4);
  assert.ok(
    legacy - reference > 10_000_000.0,
    `legacy polar anchor unexpectedly looked valid: ${legacy}m vs ${reference}m`,
  );
});

test("coarse history classifier handles one-shot discontinuities and current-only morphs", () => {
  const initialState = freshState();
  const first = sample();
  assert.equal(
    classifyCloudTemporalHistoryReset(initialState, first),
    CLOUD_TEMPORAL_RESET_INITIAL,
  );
  commitCloudTemporalHistoryState(initialState, first, true);

  const cases = [
    {
      name: "frame gap",
      mutate: { frameNumber: 3 },
      reason: CLOUD_TEMPORAL_RESET_FRAME_GAP,
    },
    {
      name: "teleport",
      mutate: { frameNumber: 2, cameraY: 50_001.0 },
      reason: CLOUD_TEMPORAL_RESET_TELEPORT,
    },
    {
      name: "scene mode",
      mutate: { frameNumber: 2, sceneMode: 2 },
      reason: CLOUD_TEMPORAL_RESET_SCENE_MODE,
    },
    {
      name: "projection change",
      mutate: { frameNumber: 2, projectionType: 1 },
      reason: CLOUD_TEMPORAL_RESET_PROJECTION,
    },
    {
      name: "deck bottom",
      mutate: { frameNumber: 2, deckBottom: 1600.0 },
      reason: CLOUD_TEMPORAL_RESET_DECK_BOUNDS,
    },
    {
      name: "deck top",
      mutate: { frameNumber: 2, deckTop: 4200.0 },
      reason: CLOUD_TEMPORAL_RESET_DECK_BOUNDS,
    },
    {
      name: "multi-deck topology",
      mutate: { frameNumber: 2, multiDeck: true },
      reason: CLOUD_TEMPORAL_RESET_MULTI_DECK,
    },
  ];

  for (const fixture of cases) {
    const state = freshState();
    commitCloudTemporalHistoryState(state, first, true);
    expectOnlyReason(state, sample(fixture.mutate), fixture.reason);
  }

  // Morphing is intentionally current-only rather than a one-frame reset:
  // every morph frame has incompatible geometry, and the first stable frame
  // must seed once before ordinary accumulation resumes.
  const morphState = freshState();
  commitCloudTemporalHistoryState(morphState, first, true);
  const morphFrame = sample({ frameNumber: 2, morphing: true });
  assert.equal(
    classifyCloudTemporalHistoryReset(morphState, morphFrame),
    CLOUD_TEMPORAL_RESET_MORPH,
  );
  commitCloudTemporalHistoryState(morphState, morphFrame, true);
  const persistentMorph = sample({ frameNumber: 3, morphing: true });
  assert.equal(
    classifyCloudTemporalHistoryReset(morphState, persistentMorph),
    CLOUD_TEMPORAL_RESET_MORPH,
  );
  commitCloudTemporalHistoryState(morphState, persistentMorph, true);
  const firstStable = sample({ frameNumber: 4, morphing: false });
  assert.equal(
    classifyCloudTemporalHistoryReset(morphState, firstStable),
    CLOUD_TEMPORAL_RESET_MORPH,
  );
  commitCloudTemporalHistoryState(morphState, firstStable, true);
  assert.equal(
    classifyCloudTemporalHistoryReset(
      morphState,
      sample({ frameNumber: 5, morphing: false }),
    ),
    CLOUD_TEMPORAL_RESET_NONE,
  );

  const missingState = freshState();
  commitCloudTemporalHistoryState(missingState, first, true);
  const missingReasons = classifyCloudTemporalHistoryReset(
    missingState,
    sample({ frameNumber: 2, transformValid: false }),
  );
  assert.equal(missingReasons, CLOUD_TEMPORAL_RESET_MISSING_TRANSFORM);

  const reactivatedState = freshState();
  commitCloudTemporalHistoryState(reactivatedState, first, true);
  commitCloudTemporalHistoryState(
    reactivatedState,
    sample({ frameNumber: 2, temporalActive: false }),
    false,
  );
  const reactivated = sample({ frameNumber: 3 });
  const reactivatedReasons = classifyCloudTemporalHistoryReset(
    reactivatedState,
    reactivated,
  );
  assert.ok((reactivatedReasons & CLOUD_TEMPORAL_RESET_REACTIVATED) !== 0);
  assert.ok((reactivatedReasons & CLOUD_TEMPORAL_RESET_FRAME_GAP) !== 0);
  commitCloudTemporalHistoryState(reactivatedState, reactivated, true);
  assert.equal(
    classifyCloudTemporalHistoryReset(
      reactivatedState,
      sample({ frameNumber: 4 }),
    ),
    CLOUD_TEMPORAL_RESET_NONE,
  );
});

test("bounded camera, clock, and wind evolution do not flush coarse history", () => {
  const state = freshState();
  const first = sample();
  commitCloudTemporalHistoryState(state, first, true);
  const continuous = sample({
    frameNumber: 2,
    cameraY: 49_999.0,
    timeSeconds: 10_000.0,
    windX: -0.25,
    windY: 0.9682458,
    windSpeed: 80.0,
  });

  assert.equal(
    classifyCloudTemporalHistoryReset(state, continuous),
    CLOUD_TEMPORAL_RESET_NONE,
  );
});

test("reset generations distinguish adjacent causes without recounting persistent reasons", () => {
  assert.equal(
    cloudTemporalResetStartsGeneration(0, CLOUD_TEMPORAL_RESET_INITIAL),
    true,
  );
  assert.equal(
    cloudTemporalResetStartsGeneration(
      CLOUD_TEMPORAL_RESET_INITIAL,
      CLOUD_TEMPORAL_RESET_INITIAL,
    ),
    false,
  );
  assert.equal(
    cloudTemporalResetStartsGeneration(
      CLOUD_TEMPORAL_RESET_MORPH,
      CLOUD_TEMPORAL_RESET_MORPH | CLOUD_TEMPORAL_RESET_PROJECTION,
    ),
    true,
  );
  assert.equal(
    cloudTemporalResetStartsGeneration(
      CLOUD_TEMPORAL_RESET_MORPH | CLOUD_TEMPORAL_RESET_PROJECTION,
      CLOUD_TEMPORAL_RESET_MORPH,
    ),
    false,
  );
});

test("the hot classifier and commit helpers contain no per-call allocation syntax", () => {
  const classifierStart = helperSource.indexOf(
    "export function classifyCloudTemporalHistoryReset",
  );
  const commitStart = helperSource.indexOf(
    "export function commitCloudTemporalHistoryState",
  );
  assert.ok(classifierStart >= 0 && commitStart > classifierStart);

  const hotSource = helperSource.slice(classifierStart);
  assert.doesNotMatch(hotSource, /\bnew\s+/);
  assert.doesNotMatch(hotSource, /\.slice\s*\(|\.map\s*\(|\.filter\s*\(/);
  assert.doesNotMatch(hotSource, /\[\s*(?:\]|\.\.\.)/);
});

test("renderer consumes the C13-05 classifier and its own prior RTE camera state", () => {
  assert.match(
    rendererSource,
    /from\s+["'].\/WebGPUCloudTemporalHistory\.js["']/,
    "renderer must import the coarse history classifier",
  );
  assert.match(
    rendererSource,
    /classifyCloudTemporalHistoryReset\s*\(/,
    "renderer must classify the frame before sampling history",
  );
  assert.match(
    rendererSource,
    /commitCloudTemporalHistoryState\s*\(/,
    "renderer must commit only the transform that wrote history",
  );
  assert.match(
    rendererSource,
    /previousViewProjectionRelativeToEye/,
    "absolute previousViewProjection is not a planetary temporal transform",
  );
  assert.match(
    rendererSource,
    /inverse\(P \* Vrot\) = inverse\(Vrot\) \* inverse\(P\)/,
  );
  // C13-09 EXTRACTED this composition into `resolveCloudInverseCurrentVpRte`
  // so its reconstruction attachment producer uses the SAME current-ray
  // transform rather than a second copy. The C13-05 property is unchanged and
  // is now pinned at the ONE site that computes it: the cheap
  // inverse-view x inverse-projection composition, never a general inversion
  // of the relative-to-eye matrix.
  const temporalTransformBlock = rendererSource.slice(
    rendererSource.indexOf("function resolveCloudInverseCurrentVpRte("),
    rendererSource.indexOf("function cloudCameraPairIsFinite("),
  );
  assert.ok(
    temporalTransformBlock.length > 0,
    "the inverse current VP-RTE helper must exist",
  );
  assert.match(
    temporalTransformBlock,
    /Matrix4\.multiply\(\s*scratchInverseViewRelativeToEye,\s*inverseProjection/,
  );
  assert.doesNotMatch(
    temporalTransformBlock,
    /Matrix4\.inverse\s*\(/,
    "a general inversion of the relative-to-eye matrix is the form C13-05 rejected",
  );
  assert.match(
    rendererSource,
    /const inverseCurrentVpRteValid =\s*matrix4IsFinite\(previousVpRte\) &&\s*resolveCloudInverseCurrentVpRte\(\s*temporalReprojectionSupported,/,
    "the temporal resolve must consume the shared helper AND keep its own previous-transform requirement",
  );
  assert.match(
    rendererSource,
    /const temporalReprojectionSupported\s*=\s*!temporalProjectionOrthographic\s*&&\s*frameState\.mode\s*!==\s*SceneMode\.MORPHING;/,
    "orthographic/morph frames must stay on direct half-res output until per-pixel ray origins exist",
  );
  assert.match(
    rendererSource,
    /let temporalActive\s*=\s*cloudPreset\.temporalEnabled\s*&&\s*halfResActive\s*&&\s*temporalReprojectionSupported;/,
    "unsupported projections must not allocate/execute temporal history",
  );
  assert.match(
    rendererSource,
    /temporalActive \? CLOUD_QF_TEMPORAL : 0/,
    "unsupported projections must not animate the temporal-only ray phase",
  );
  assert.match(
    temporalTransformBlock,
    /matrix4HasNonZeroEntry\(inverseProjection as Matrix4\)/,
    "UniformState's zero inverse-projection sentinel must not reach WGSL",
  );
  assert.doesNotMatch(
    temporalTransformBlock,
    /Matrix4\.inverse\(/,
    "perspective reprojection should compose existing inverse transforms",
  );
  assert.match(
    rendererSource,
    /temporalHistoryPendingResetReasons\s*\|=\s*CLOUD_TEMPORAL_RESET_RESOURCE/,
    "history texture reallocation must be an explicit reset generation",
  );
  assert.equal(CLOUD_TEMPORAL_RESET_RESOURCE, 1 << 10);
  assert.match(
    rendererSource,
    /cloudTemporalResetStartsGeneration\s*\(/,
    "adjacent distinct reset reasons must not collapse into one generation",
  );
});

test("temporal layout stays within one 256-byte row and bind groups are not allocated per frame", () => {
  assert.match(rendererSource, /const TEMPORAL_UNIFORM_FLOATS = 60;/);
  const structStart = shaderSource.indexOf("struct TemporalUniforms {");
  const structEnd = shaderSource.indexOf("};", structStart);
  assert.ok(structStart >= 0 && structEnd > structStart);
  const uniformStruct = shaderSource.slice(structStart, structEnd);
  assert.equal(
    [...uniformStruct.matchAll(/mat4x4<f32>/g)].length,
    2,
    "temporal layout must carry exactly two matrices",
  );
  assert.equal(
    [...uniformStruct.matchAll(/vec4<f32>/g)].length,
    7,
    "60-float layout requires exactly seven packed vec4 rows",
  );

  const ensureStart = rendererSource.indexOf(
    "function ensureTemporalResources(",
  );
  const executeStart = rendererSource.indexOf(
    "// C13-05 — compare with the last frame",
  );
  const temporalPassStart = rendererSource.indexOf(
    "const temporalPass = encoder.beginRenderPass",
    executeStart,
  );
  assert.ok(ensureStart >= 0 && executeStart > ensureStart);
  assert.ok(temporalPassStart > executeStart);
  assert.match(
    rendererSource.slice(ensureStart, executeStart),
    /cache\.temporalBindGroups\[readIndex\]\s*=\s*device\.createBindGroup/,
  );
  assert.doesNotMatch(
    rendererSource.slice(executeStart, temporalPassStart),
    /device\.createBindGroup/,
    "hot temporal resolve must select a cached parity bind group",
  );
});

test("temporal shader uses WGS84 camera-relative anchors and never rebuilds raw ECEF", () => {
  assert.match(shaderSource, /previousViewProjectionRelativeToEye/);
  assert.match(shaderSource, /cameraDelta/);
  assert.match(shaderSource, /encodedCameraHigh/);
  assert.match(shaderSource, /encodedCameraLow/);
  assert.match(shaderSource, /cloudShellAxes/);
  assert.match(shaderSource, /rayEllipsoidIntersectRTE/);
  assert.match(shaderSource, /previousEyeRelative/);
  assert.doesNotMatch(
    shaderSource,
    /let\s+worldAnchor\s*=\s*camPos\s*\+\s*rd\s*\*\s*tHit/,
  );
  assert.doesNotMatch(
    shaderSource,
    /previousViewProjection\s*\*\s*vec4<f32>\(\s*worldAnchor/,
  );
  const offscreenReject = shaderSource.indexOf("previousUv.x < 0.0");
  const neighborhoodFetch = shaderSource.indexOf(
    "var neighborhoodMin = current;",
  );
  assert.ok(
    offscreenReject >= 0 && neighborhoodFetch > offscreenReject,
    "the 3x3 clamp must run only after history reprojection is valid",
  );
});

test("temporal RTE shader passes naga validation", async () => {
  const nagaDirectory = path.join(
    root,
    "Tools/shader-pipeline/naga-wasm-tools",
  );
  const naga = await import(
    pathToFileURL(path.join(nagaDirectory, "naga_wasm_tools.js")).href
  );
  await naga.default({
    module_or_path: fs.readFileSync(
      path.join(nagaDirectory, "naga_wasm_tools_bg.wasm"),
    ),
  });
  assert.doesNotThrow(() => naga.validate_wgsl(shaderSource));
});
