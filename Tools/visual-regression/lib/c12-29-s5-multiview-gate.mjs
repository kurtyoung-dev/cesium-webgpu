import { types as utilTypes } from "node:util";

import { exitCodeForS5StatusOrStructural as exitCodeForC1229S5MultiviewStatus } from "./verdict-exit-gate.mjs";
// A hand-written SHA-256 lived here so the fold could run "anywhere". Nothing
// ever ran it outside Node, and a second implementation of a hash is a second
// thing that can disagree with the bytes the evidence was banked under.
import { sha256 } from "./visual-gate-policy.mjs";

/**
 * Frozen policy for the C12-29 S5 same-context logical-View certification
 * shard.
 *
 * This gate intentionally makes a narrow claim. Cesium's native
 * `Scene.render` currently resets `scene._view` to `scene._defaultView`; the
 * packet therefore exercises A -> B -> A through a Tools-owned,
 * scheduler-shaped preparation seam and records
 * `engineSchedulerAvailable: false`. It must never be cited as proof that the
 * engine already schedules arbitrary Views for presentation.
 */

export const C12_29_S5_MULTIVIEW_SCHEMA = "c12-29-s5-multiview-evidence-v3";
export const C12_29_S5_MULTIVIEW_PAGE_SCHEMA =
  "c12-29-s5-multiview-page-progress-v3";
export const C12_29_S5_MULTIVIEW_DIAGNOSTICS_SCHEMA =
  "c12-29-s5-multiview-runtime-diagnostics-v3";

export const C12_29_S5_MULTIVIEW_RENDERERS = Object.freeze(["webgl", "webgpu"]);

export const C12_29_S5_MULTIVIEW_PHASES = Object.freeze([
  "eligibility-provenance",
  "context-default-view-baseline",
  "logical-view-a-prepare-capture",
  "logical-view-b-prepare-capture",
  "logical-view-a-reentry-capture",
  "a-b-a-isolation-fold",
  "real-offscreen-ray-pick-view",
  "post-pick-default-view-restoration",
  "webgl-vr-left-eye-observation",
  "webgl-vr-right-eye-center-anchor-fold",
  "webgpu-vr-synchronous-rejection-control",
  "cleanup-publication",
]);

export const C12_29_S5_MULTIVIEW_OUTPUT_DIRECTORY =
  "Tools/visual-regression/output/c12-29-s5-multiview";
export const C12_29_S5_MULTIVIEW_ARTIFACT_PREFIX =
  "campaign12-c12-29-s5-multiview";

export const C12_29_S5_MULTIVIEW_WEBGPU_VR_ERROR =
  "scene.useWebVR is not yet supported on this backend. " +
  "The per-eye viewport split requires plumbing passState.viewport " +
  "through the backend's scene renderer (WebGPU currently hard-codes " +
  "the full-canvas viewport).";

export const C12_29_S5_MULTIVIEW_WORKLOAD = Object.freeze({
  claim: "same-context-logical-view-isolation-only",
  scheduler: "tools-owned-scheduler-shaped-pick-preparation-v1",
  engineSchedulerAvailable: false,
  nativeArbitraryViewSchedulingClaimed: false,
  sceneRenderResetsDefaultView: true,
  eventIso: "2024-04-08T18:17:16Z",
  viewport: Object.freeze({ width: 960, height: 640 }),
  viewA: Object.freeze({
    longitudeDegrees: -96.797,
    latitudeDegrees: 32.7767,
    heightMeters: 1_600_000,
    headingDegrees: 0,
    pitchDegrees: -90,
    rollDegrees: 0,
    cameraFovDegrees: 50,
    cameraNearMeters: 1,
    cameraFarMeters: 500_000_000,
    viewport: Object.freeze({ x: 0, y: 0, width: 960, height: 640 }),
  }),
  viewB: Object.freeze({
    longitudeDegrees: 2.3522,
    latitudeDegrees: 48.8566,
    heightMeters: 2_300_000,
    headingDegrees: 21,
    pitchDegrees: -78,
    rollDegrees: 0,
    cameraFovDegrees: 42,
    cameraNearMeters: 1,
    cameraFarMeters: 500_000_000,
    viewport: Object.freeze({ x: 96, y: 64, width: 768, height: 512 }),
  }),
  maximumSettleFrames: 360,
  requiredStableFrames: 3,
  maximumRayPickAttempts: 6,
  rayWidthMeters: 1_000,
  maximumRayPositionDeltaMeters: 10,
  minimumStereoEyeSeparationMeters: 0.01,
  captureMethod: "tools-owned-state-and-retained-command-snapshot-v2",
  webglStereoMethod:
    "scene.useWebVR+real-two-eye-camera-and-passState-viewport-observation-v1",
  webgpuStereoMethod:
    "synchronous-useWebVR-setter-rejection-with-state-identity-control-v1",
});

/** Exact semantic and acquisition provenance boundary. */
export const C12_29_S5_MULTIVIEW_SOURCE_FILES = Object.freeze([
  "packages/engine/Source/Core/BoundingRectangle.js",
  "packages/engine/Source/Core/Cartesian2.js",
  "packages/engine/Source/Core/Cartesian3.js",
  "packages/engine/Source/Core/Cartographic.js",
  "packages/engine/Source/Core/DeveloperError.js",
  "packages/engine/Source/Core/OrthographicFrustum.js",
  "packages/engine/Source/Core/PerspectiveFrustum.js",
  "packages/engine/Source/Core/Ray.js",
  "packages/engine/Source/Core/Transforms.js",
  "packages/engine/Source/Renderer/GraphicsContext.ts",
  "packages/engine/Source/Renderer/UniformState.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUContext.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeEclipseUniforms.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceCameraUB.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUGlobeSurfaceRenderer.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPURingBufferAllocator.ts",
  "packages/engine/Source/Scene/Camera.js",
  "packages/engine/Source/Scene/CameraHelpers.js",
  "packages/engine/Source/Scene/EclipseGlobeShadow.js",
  "packages/engine/Source/Scene/EclipseState.js",
  "packages/engine/Source/Scene/Globe.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProvider.js",
  "packages/engine/Source/Scene/GlobeSurfaceTileProviderRendering.js",
  "packages/engine/Source/Scene/Picking.js",
  "packages/engine/Source/Scene/PickingRayHelpers.js",
  "packages/engine/Source/Scene/QuadtreePrimitive.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Scene/View.js",
  "packages/engine/Source/Scene/ViewportExecutor.js",
  "packages/engine/Source/Shaders/GlobeFS.glsl",
  "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
  "Tools/visual-regression/lib/build-source-identity.mjs",
  "Tools/visual-regression/lib/c12-29-s5-multiview-gate.mjs",
  "Tools/visual-regression/c12-29-s5-multiview-gate.spec.mjs",
  "Tools/visual-regression/probe-c12-29-s5-multiview.mjs",
  "Tools/lib/webgpu-error-gate.mjs",
]);

export const C12_29_S5_MULTIVIEW_BUILD_SOURCE_FILES = Object.freeze(
  C12_29_S5_MULTIVIEW_SOURCE_FILES.filter(
    (file) =>
      !file.startsWith("Tools/") &&
      !file.endsWith(".glsl") &&
      !file.endsWith(".wgsl"),
  ),
);

export const C12_29_S5_MULTIVIEW_BUILD_SOURCE_MAP =
  "Build/CesiumUnminified/index.js.map";

const FINAL_STATUSES = Object.freeze(["PASS", "FAIL", "STRUCTURAL", "ERROR"]);
const FINAL_STATUS_SET = new Set(FINAL_STATUSES);
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDENTITY =
  /^(?:context|canvas|view|state|shadow|snapshot|properties|command|carrier|camera|buffer|queue|encoder|passEncoder|commandBuffer|getter|renderer|manager|tileProvider)-[1-9]\d*$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const MAX_DIAGNOSTIC_JSON = 65_536;
const MAX_DIAGNOSTIC_DEPTH = 8;
const MAX_DIAGNOSTIC_KEYS = 64;
const MAX_DIAGNOSTIC_ARRAY = 128;
const MAX_DIAGNOSTIC_STRING = 2_048;
const MAX_REASONS = 64;
const MAX_REASON_LENGTH = 512;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum;
}

function validIsoTimestamp(value) {
  if (typeof value !== "string" || !ISO.test(value)) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function exactKeys(value, keys) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      utilTypes.isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const actual = Reflect.ownKeys(value);
    if (
      actual.length !== keys.length ||
      actual.some((key) => typeof key !== "string")
    ) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor !== undefined &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable === true
      );
    });
  } catch {
    return false;
  }
}

function cloneMultiviewJsonSafe(value, location = "$", ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        `multiview JSON-safe value rejects a lossy number at ${location}`,
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(
      `multiview JSON-safe value rejects ${typeof value} at ${location}`,
    );
  }
  try {
    if (ancestors.has(value)) {
      throw new TypeError(
        `multiview JSON-safe value rejects a cycle at ${location}`,
      );
    }
    if (utilTypes.isProxy(value)) {
      throw new TypeError(
        `multiview JSON-safe value rejects a Proxy at ${location}`,
      );
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && ![Object.prototype, null].includes(prototype))
    ) {
      throw new TypeError(
        `multiview JSON-safe value rejects a custom prototype at ${location}`,
      );
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError(
        `multiview JSON-safe value rejects a symbol key at ${location}`,
      );
    }
    ancestors.add(value);
    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 1_000_000 ||
        lengthDescriptor.enumerable !== false ||
        lengthDescriptor.configurable !== false ||
        keys.length !== lengthDescriptor.value + 1 ||
        keys.at(-1) !== "length"
      ) {
        throw new TypeError(
          `multiview JSON-safe value rejects a noncanonical array at ${location}`,
        );
      }
      const clone = [];
      for (let index = 0; index < lengthDescriptor.value; index++) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (
          keys[index] !== key ||
          descriptor === undefined ||
          !Object.hasOwn(descriptor, "value") ||
          descriptor.enumerable !== true
        ) {
          throw new TypeError(
            `multiview JSON-safe value rejects holes, accessors, or hidden keys at ${location}[${index}]`,
          );
        }
        clone.push(
          cloneMultiviewJsonSafe(
            descriptor.value,
            `${location}[${index}]`,
            ancestors,
          ),
        );
      }
      ancestors.delete(value);
      return clone;
    }
    const clone = {};
    for (const key of [...keys].sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError(
          `multiview JSON-safe value rejects accessors or hidden keys at ${location}.${key}`,
        );
      }
      Object.defineProperty(clone, key, {
        value: cloneMultiviewJsonSafe(
          descriptor.value,
          `${location}.${key}`,
          ancestors,
        ),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    ancestors.delete(value);
    return clone;
  } catch (error) {
    ancestors.delete(value);
    if (
      error instanceof TypeError &&
      /^multiview JSON-safe value/u.test(error.message)
    ) {
      throw error;
    }
    throw new TypeError(
      `multiview JSON-safe value is not inspectable at ${location}`,
      { cause: error },
    );
  }
}

function sameOrdered(left, right) {
  return (
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function allDistinct(values) {
  return new Set(values).size === values.length;
}

function boundedString(value, maximum = MAX_DIAGNOSTIC_STRING) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function numericArray(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    Object.keys(value).length === length &&
    value.every(finite)
  );
}

function vectorDistance(left, right) {
  if (!numericArray(left, 3) || !numericArray(right, 3)) return Infinity;
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function byteArray(value, length = 64) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    Object.keys(value).length === value.length &&
    value.every((entry) => integer(entry) && entry <= 255)
  );
}

function float32PayloadFromBytes(bytes) {
  if (!byteArray(bytes)) return null;
  const data = Uint8Array.from(bytes);
  const view = new DataView(data.buffer);
  return Array.from({ length: 16 }, (_, index) =>
    Math.fround(view.getFloat32(index * 4, true)),
  );
}

function jsonEqual(left, right) {
  return stableC1229S5MultiviewJson(left) === stableC1229S5MultiviewJson(right);
}

function boundedPlainJson(value, depth = 0, seen = new Set()) {
  if (value === null || typeof value === "boolean") return true;
  if (finite(value)) return true;
  if (typeof value === "string") return value.length <= MAX_DIAGNOSTIC_STRING;
  if (typeof value !== "object" || depth > MAX_DIAGNOSTIC_DEPTH) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  let ok;
  if (Array.isArray(value)) {
    ok =
      value.length <= MAX_DIAGNOSTIC_ARRAY &&
      Object.keys(value).length === value.length &&
      value.every((entry) => boundedPlainJson(entry, depth + 1, seen));
  } else {
    const keys = Object.keys(value);
    ok =
      Object.getPrototypeOf(value) === Object.prototype &&
      keys.length <= MAX_DIAGNOSTIC_KEYS &&
      keys.every(
        (key) =>
          key.length <= 128 && boundedPlainJson(value[key], depth + 1, seen),
      );
  }
  seen.delete(value);
  return ok;
}

function validateReasonArray(value) {
  return (
    Array.isArray(value) &&
    value.length <= MAX_REASONS &&
    Object.keys(value).length === value.length &&
    value.every(
      (reason) =>
        typeof reason === "string" && reason.length <= MAX_REASON_LENGTH,
    )
  );
}

function push(reasons, condition, reason) {
  if (!condition) reasons.push(reason);
}

function validIdentity(value, prefix) {
  return (
    typeof value === "string" &&
    IDENTITY.test(value) &&
    (prefix === undefined || value.startsWith(`${prefix}-`))
  );
}

function validViewport(value) {
  return (
    exactKeys(value, ["x", "y", "width", "height"]) &&
    finite(value.x) &&
    finite(value.y) &&
    finite(value.width) &&
    finite(value.height) &&
    value.width > 0 &&
    value.height > 0
  );
}

function validCamera(value) {
  return (
    exactKeys(value, [
      "cameraId",
      "positionWC",
      "directionWC",
      "upWC",
      "rightWC",
      "viewMatrix",
      "projectionMatrix",
    ]) &&
    validIdentity(value.cameraId, "camera") &&
    numericArray(value.positionWC, 3) &&
    numericArray(value.directionWC, 3) &&
    numericArray(value.upWC, 3) &&
    numericArray(value.rightWC, 3) &&
    numericArray(value.viewMatrix, 16) &&
    numericArray(value.projectionMatrix, 16)
  );
}

function validFrustum(value) {
  return (
    exactKeys(value, [
      "constructor",
      "near",
      "far",
      "aspectRatio",
      "fov",
      "width",
      "xOffset",
      "yOffset",
    ]) &&
    boundedString(value.constructor, 128) &&
    finite(value.near) &&
    finite(value.far) &&
    value.near > 0 &&
    value.far > value.near &&
    (value.aspectRatio === null || finite(value.aspectRatio)) &&
    (value.fov === null || finite(value.fov)) &&
    (value.width === null || finite(value.width)) &&
    (value.xOffset === null || finite(value.xOffset)) &&
    (value.yOffset === null || finite(value.yOffset))
  );
}

const WGS84_XY_RADIUS = 6_378_137.0;
const WGS84_Z_RADIUS = 6_356_752.314245179;
const GEOMETRY_ABSOLUTE_EPSILON = 1e-7;
const GEOMETRY_RELATIVE_EPSILON = 1e-13;

function nearlyEqual(left, right, absolute = GEOMETRY_ABSOLUTE_EPSILON) {
  return (
    Math.abs(left - right) <=
    Math.max(
      absolute,
      GEOMETRY_RELATIVE_EPSILON * Math.max(Math.abs(left), Math.abs(right)),
    )
  );
}

function arrayNearlyEqual(left, right, absolute = GEOMETRY_ABSOLUTE_EPSILON) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => nearlyEqual(value, right[index], absolute))
  );
}

function dot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function subtract(left, right) {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function addScaled(origin, direction, scale) {
  return origin.map((value, index) => value + direction[index] * scale);
}

function magnitude(value) {
  return Math.sqrt(dot(value, value));
}

function normalize(value) {
  const length = magnitude(value);
  return value.map((entry) => entry / length);
}

function geodeticPosition(requestedView, heightMeters) {
  const longitude = (requestedView.longitudeDegrees * Math.PI) / 180;
  const latitude = (requestedView.latitudeDegrees * Math.PI) / 180;
  const normal = [
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude),
  ];
  const radiiSquared = [
    WGS84_XY_RADIUS * WGS84_XY_RADIUS,
    WGS84_XY_RADIUS * WGS84_XY_RADIUS,
    WGS84_Z_RADIUS * WGS84_Z_RADIUS,
  ];
  const scaledNormal = normal.map(
    (entry, index) => entry * radiiSquared[index],
  );
  const gamma = Math.sqrt(dot(normal, scaledNormal));
  return scaledNormal.map(
    (entry, index) => entry / gamma + normal[index] * heightMeters,
  );
}

function requestedCameraAxes(requestedView) {
  const heading = (requestedView.headingDegrees * Math.PI) / 180;
  const pitch = (requestedView.pitchDegrees * Math.PI) / 180;
  const position = geodeticPosition(requestedView, requestedView.heightMeters);
  // Camera.setView3D asks eastNorthUpToFixedFrame for a frame centered at the
  // off-surface destination. The engine's ENU generator obtains its up axis
  // from Ellipsoid.geodeticSurfaceNormal(destination), not directly from the
  // input cartographic latitude/longitude.
  const geodeticUp = normalize([
    position[0] / (WGS84_XY_RADIUS * WGS84_XY_RADIUS),
    position[1] / (WGS84_XY_RADIUS * WGS84_XY_RADIUS),
    position[2] / (WGS84_Z_RADIUS * WGS84_Z_RADIUS),
  ]);
  const east = normalize([-position[1], position[0], 0]);
  const north = [
    geodeticUp[1] * east[2] - geodeticUp[2] * east[1],
    geodeticUp[2] * east[0] - geodeticUp[0] * east[2],
    geodeticUp[0] * east[1] - geodeticUp[1] * east[0],
  ];
  const combine = (eastScale, northScale, upScale) =>
    east.map(
      (entry, index) =>
        entry * eastScale +
        north[index] * northScale +
        geodeticUp[index] * upScale,
    );
  return {
    direction: normalize(
      combine(
        Math.cos(pitch) * Math.sin(heading),
        Math.cos(pitch) * Math.cos(heading),
        Math.sin(pitch),
      ),
    ),
    up: normalize(
      combine(
        -Math.sin(pitch) * Math.sin(heading),
        -Math.sin(pitch) * Math.cos(heading),
        Math.cos(pitch),
      ),
    ),
    right: normalize(combine(Math.cos(heading), -Math.sin(heading), 0)),
  };
}

function expectedViewMatrix(camera) {
  const position = camera.positionWC;
  const direction = camera.directionWC;
  const up = camera.upWC;
  const right = camera.rightWC;
  return [
    right[0],
    up[0],
    -direction[0],
    0,
    right[1],
    up[1],
    -direction[1],
    0,
    right[2],
    up[2],
    -direction[2],
    0,
    -dot(right, position),
    -dot(up, position),
    dot(direction, position),
    1,
  ];
}

function expectedPerspectiveProjection(frustum) {
  const fovy =
    frustum.aspectRatio <= 1
      ? frustum.fov
      : Math.atan(Math.tan(frustum.fov * 0.5) / frustum.aspectRatio) * 2;
  let top = frustum.near * Math.tan(fovy * 0.5);
  let bottom = -top;
  let right = frustum.aspectRatio * top;
  let left = -right;
  right += frustum.xOffset;
  left += frustum.xOffset;
  top += frustum.yOffset;
  bottom += frustum.yOffset;
  const near = frustum.near;
  const far = frustum.far;
  return [
    (2 * near) / (right - left),
    0,
    0,
    0,
    0,
    (2 * near) / (top - bottom),
    0,
    0,
    (right + left) / (right - left),
    (top + bottom) / (top - bottom),
    -(far + near) / (far - near),
    -1,
    0,
    0,
    (-2 * far * near) / (far - near),
    0,
  ];
}

function matchesRequestedPerspectiveFrustum(capture, requestedView) {
  const requestedAspectRatio =
    requestedView.viewport.width / requestedView.viewport.height;
  const requestedFovRadians = (requestedView.cameraFovDegrees * Math.PI) / 180;
  const expectedPosition = geodeticPosition(
    requestedView,
    requestedView.heightMeters,
  );
  const expectedAxes = requestedCameraAxes(requestedView);
  return (
    capture.frustum.constructor === "PerspectiveFrustum" &&
    capture.frustum.aspectRatio === requestedAspectRatio &&
    capture.frustum.fov === requestedFovRadians &&
    capture.frustum.near === requestedView.cameraNearMeters &&
    capture.frustum.far === requestedView.cameraFarMeters &&
    capture.frustum.xOffset === 0 &&
    capture.frustum.yOffset === 0 &&
    jsonEqual(capture.viewport, requestedView.viewport) &&
    arrayNearlyEqual(capture.camera.positionWC, expectedPosition, 1e-6) &&
    arrayNearlyEqual(
      capture.camera.directionWC,
      expectedAxes.direction,
      1e-13,
    ) &&
    arrayNearlyEqual(capture.camera.upWC, expectedAxes.up, 1e-13) &&
    arrayNearlyEqual(capture.camera.rightWC, expectedAxes.right, 1e-13) &&
    nearlyEqual(magnitude(capture.camera.directionWC), 1, 1e-13) &&
    nearlyEqual(magnitude(capture.camera.upWC), 1, 1e-13) &&
    nearlyEqual(magnitude(capture.camera.rightWC), 1, 1e-13) &&
    nearlyEqual(
      dot(capture.camera.directionWC, capture.camera.upWC),
      0,
      1e-13,
    ) &&
    nearlyEqual(
      dot(capture.camera.directionWC, capture.camera.rightWC),
      0,
      1e-13,
    ) &&
    nearlyEqual(dot(capture.camera.upWC, capture.camera.rightWC), 0, 1e-13) &&
    arrayNearlyEqual(
      capture.camera.viewMatrix,
      expectedViewMatrix(capture.camera),
      1e-7,
    ) &&
    arrayNearlyEqual(
      capture.camera.projectionMatrix,
      expectedPerspectiveProjection(capture.frustum),
      1e-14,
    )
  );
}

function validEclipseState(value) {
  return (
    exactKeys(value, [
      "enabled",
      "valid",
      "sunVisibleFraction",
      "earthOcclusionFraction",
      "moonObscuration",
      "sceneLightFactor",
    ]) &&
    typeof value.enabled === "boolean" &&
    typeof value.valid === "boolean" &&
    finite(value.sunVisibleFraction) &&
    finite(value.earthOcclusionFraction) &&
    finite(value.moonObscuration) &&
    finite(value.sceneLightFactor)
  );
}

function validShadowPayload(value) {
  return (
    exactKeys(value, [
      "active",
      "revision",
      "sunDirectionAndInvRange",
      "moonDirectionDeltaAndInvRange",
      "params",
      "params2",
      "packedF32",
    ]) &&
    typeof value.active === "boolean" &&
    integer(value.revision) &&
    numericArray(value.sunDirectionAndInvRange, 4) &&
    numericArray(value.moonDirectionDeltaAndInvRange, 4) &&
    numericArray(value.params, 4) &&
    numericArray(value.params2, 4) &&
    numericArray(value.packedF32, 16) &&
    jsonEqual(
      value.packedF32,
      [
        ...value.sunDirectionAndInvRange,
        ...value.moonDirectionDeltaAndInvRange,
        ...value.params,
        ...value.params2,
      ].map(Math.fround),
    )
  );
}

function validEclipseCapture(value) {
  return (
    exactKeys(value, [
      "stateObjectId",
      "shadowObjectId",
      "state",
      "shadow",
      "prepared",
      "selectionRevision",
      "surfaceRadius",
    ]) &&
    validIdentity(value.stateObjectId, "state") &&
    validIdentity(value.shadowObjectId, "shadow") &&
    validEclipseState(value.state) &&
    validShadowPayload(value.shadow) &&
    typeof value.prepared === "boolean" &&
    integer(value.selectionRevision, 1) &&
    finite(value.surfaceRadius) &&
    value.surfaceRadius > 6_000_000
  );
}

function validWebglCommandReceipt(value) {
  return (
    exactKeys(value, [
      "kind",
      "uniformMapId",
      "pooledUniformMapId",
      "propertiesOverlayId",
      "pooledPropertiesId",
      "getterId",
      "snapshotObjectId",
      "sourceShadowObjectId",
      "snapshotDistinctFromSource",
      "snapshotFrozen",
      "snapshotPayloadFrozen",
      "snapshotWrapperExact",
      "carrierPropertiesDescriptorExact",
      "propertiesOverlayDistinctFromPooled",
      "propertiesPrototypeExact",
      "onlyEclipseOwnProperty",
      "nonS5UniformDescriptorsExact",
      "nonS5ResolvedValueExact",
      "resolvedPayload",
    ]) &&
    value.kind === "webgl-production-uniform-resolver" &&
    validIdentity(value.uniformMapId, "carrier") &&
    validIdentity(value.pooledUniformMapId, "carrier") &&
    validIdentity(value.propertiesOverlayId, "properties") &&
    validIdentity(value.pooledPropertiesId, "properties") &&
    validIdentity(value.getterId, "getter") &&
    validIdentity(value.snapshotObjectId, "snapshot") &&
    validIdentity(value.sourceShadowObjectId, "shadow") &&
    typeof value.snapshotDistinctFromSource === "boolean" &&
    typeof value.snapshotFrozen === "boolean" &&
    typeof value.snapshotPayloadFrozen === "boolean" &&
    typeof value.snapshotWrapperExact === "boolean" &&
    typeof value.carrierPropertiesDescriptorExact === "boolean" &&
    typeof value.propertiesOverlayDistinctFromPooled === "boolean" &&
    typeof value.propertiesPrototypeExact === "boolean" &&
    typeof value.onlyEclipseOwnProperty === "boolean" &&
    typeof value.nonS5UniformDescriptorsExact === "boolean" &&
    typeof value.nonS5ResolvedValueExact === "boolean" &&
    numericArray(value.resolvedPayload, 16)
  );
}

function validWebgpuCommandReceipt(value) {
  return (
    exactKeys(value, [
      "kind",
      "rendererClass",
      "rendererId",
      "managerId",
      "tileProviderId",
      "publishedTileProviderExact",
      "bindGroupId",
      "bufferId",
      "baseOffset",
      "dynamicOffset",
      "absoluteOffset",
      "size",
      "allocationEpoch",
      "viewId",
      "shadowRevision",
      "selectionRevision",
      "prepareCallCount",
      "managerResultExact",
      "bindGroupResourceExact",
      "uploadSource",
      "stagingReceiptExact",
      "allocatorDirtyRangeFlush",
      "flushQueueId",
      "flushBufferId",
      "flushOffset",
      "flushSize",
      "flushSliceOffset",
      "flushSliceBytes",
      "flushSequence",
      "frameEncoderId",
      "renderPassEncoderId",
      "renderPassFrameEncoderId",
      "consumedCommandId",
      "consumedBindGroupId",
      "consumedDynamicOffsets",
      "bindSequence",
      "drawSequence",
      "drawKind",
      "drawCount",
      "renderPassOwnedByFrameEncoder",
      "drawConsumedCommandExact",
      "submittedCommandBufferId",
      "finishedFrameEncoderId",
      "finishSequence",
      "submitQueueId",
      "submitSequence",
      "submitCommandBufferCount",
      "submitContainsOwningCommandBuffer",
      "owningSubmitObserved",
      "submittedAfterFlush",
      "submittedAfterDraw",
      "uploadReceiptExact",
      "uploadBytes",
      "uploadSha256",
    ]) &&
    value.kind === "webgpu-binding-2-upload" &&
    value.rendererClass === "WebGPUGlobeSurfaceRenderer" &&
    validIdentity(value.rendererId, "renderer") &&
    validIdentity(value.managerId, "manager") &&
    validIdentity(value.tileProviderId, "tileProvider") &&
    value.publishedTileProviderExact === true &&
    validIdentity(value.bindGroupId, "carrier") &&
    validIdentity(value.bufferId, "buffer") &&
    value.baseOffset === 0 &&
    integer(value.dynamicOffset) &&
    value.absoluteOffset === value.baseOffset + value.dynamicOffset &&
    value.size === 64 &&
    integer(value.allocationEpoch) &&
    validIdentity(value.viewId, "view") &&
    integer(value.shadowRevision) &&
    integer(value.selectionRevision, 1) &&
    integer(value.prepareCallCount, 1) &&
    value.managerResultExact === true &&
    value.bindGroupResourceExact === true &&
    value.uploadSource === "allocator-staging+dirty-range-queue-write" &&
    value.stagingReceiptExact === true &&
    value.allocatorDirtyRangeFlush === true &&
    validIdentity(value.flushQueueId, "queue") &&
    value.flushBufferId === value.bufferId &&
    integer(value.flushOffset) &&
    integer(value.flushSize, 64) &&
    integer(value.flushSliceOffset) &&
    value.flushSliceOffset === value.absoluteOffset - value.flushOffset &&
    value.flushOffset <= value.absoluteOffset &&
    value.flushOffset + value.flushSize >= value.absoluteOffset + value.size &&
    byteArray(value.flushSliceBytes) &&
    jsonEqual(value.flushSliceBytes, value.uploadBytes) &&
    integer(value.flushSequence, 1) &&
    validIdentity(value.frameEncoderId, "encoder") &&
    validIdentity(value.renderPassEncoderId, "passEncoder") &&
    value.renderPassFrameEncoderId === value.frameEncoderId &&
    validIdentity(value.consumedCommandId, "command") &&
    value.consumedBindGroupId === value.bindGroupId &&
    Array.isArray(value.consumedDynamicOffsets) &&
    value.consumedDynamicOffsets.length === 3 &&
    value.consumedDynamicOffsets.every((entry) => integer(entry)) &&
    value.consumedDynamicOffsets[2] === value.dynamicOffset &&
    integer(value.bindSequence, 1) &&
    integer(value.drawSequence, 1) &&
    value.drawSequence > value.bindSequence &&
    value.flushSequence > value.drawSequence &&
    value.drawKind === "drawIndexed" &&
    integer(value.drawCount, 1) &&
    value.renderPassOwnedByFrameEncoder === true &&
    value.drawConsumedCommandExact === true &&
    validIdentity(value.submittedCommandBufferId, "commandBuffer") &&
    value.finishedFrameEncoderId === value.frameEncoderId &&
    integer(value.finishSequence, 1) &&
    value.finishSequence > value.flushSequence &&
    value.submitQueueId === value.flushQueueId &&
    integer(value.submitSequence, 1) &&
    value.submitSequence > value.finishSequence &&
    integer(value.submitCommandBufferCount, 1) &&
    value.submitContainsOwningCommandBuffer === true &&
    value.owningSubmitObserved === true &&
    value.submittedAfterFlush === true &&
    value.submittedAfterDraw === true &&
    value.uploadReceiptExact === true &&
    byteArray(value.uploadBytes) &&
    SHA256.test(value.uploadSha256) &&
    value.uploadSha256 === sha256(Uint8Array.from(value.uploadBytes))
  );
}

function validCommandCapture(value, renderer) {
  if (
    !exactKeys(value, [
      "kind",
      "commandId",
      "ownerIsGlobe",
      "carrierId",
      "eclipseDynamicOffset",
      "resolvedPayload",
      "backendReceipt",
    ]) ||
    !validIdentity(value.commandId, "command") ||
    typeof value.ownerIsGlobe !== "boolean" ||
    !validIdentity(value.carrierId, "carrier") ||
    !integer(value.eclipseDynamicOffset) ||
    !numericArray(value.resolvedPayload, 16)
  ) {
    return false;
  }
  return renderer === "webgl"
    ? value.kind === "webgl-production-uniform-resolver" &&
        validWebglCommandReceipt(value.backendReceipt)
    : value.kind === "webgpu-bind-group-dynamic-offset" &&
        validWebgpuCommandReceipt(value.backendReceipt);
}

function validCommandViewCoherence(command, eclipse, viewId, renderer) {
  if (renderer === "webgl") {
    const receipt = command.backendReceipt;
    return (
      receipt.uniformMapId === command.carrierId &&
      receipt.sourceShadowObjectId === eclipse.shadowObjectId &&
      jsonEqual(receipt.resolvedPayload, command.resolvedPayload) &&
      jsonEqual(command.resolvedPayload, eclipse.shadow.packedF32)
    );
  }
  const receipt = command.backendReceipt;
  return (
    receipt.bindGroupId === command.carrierId &&
    receipt.consumedCommandId === command.commandId &&
    receipt.dynamicOffset === command.eclipseDynamicOffset &&
    receipt.viewId === viewId &&
    receipt.shadowRevision === eclipse.shadow.revision &&
    receipt.selectionRevision === eclipse.selectionRevision &&
    jsonEqual(
      float32PayloadFromBytes(receipt.uploadBytes),
      command.resolvedPayload,
    ) &&
    jsonEqual(command.resolvedPayload, eclipse.shadow.packedF32)
  );
}

function validViewCapture(value, renderer) {
  return (
    exactKeys(value, [
      "label",
      "viewId",
      "constructorIsView",
      "contextId",
      "canvasId",
      "defaultViewId",
      "isDefaultView",
      "frameStateViewId",
      "frameNumber",
      "camera",
      "frustum",
      "viewport",
      "eclipse",
      "command",
    ]) &&
    new Set(["A-before", "B", "A-after"]).has(value.label) &&
    validIdentity(value.viewId, "view") &&
    typeof value.constructorIsView === "boolean" &&
    validIdentity(value.contextId, "context") &&
    validIdentity(value.canvasId, "canvas") &&
    validIdentity(value.defaultViewId, "view") &&
    typeof value.isDefaultView === "boolean" &&
    validIdentity(value.frameStateViewId, "view") &&
    integer(value.frameNumber, 1) &&
    validCamera(value.camera) &&
    validFrustum(value.frustum) &&
    validViewport(value.viewport) &&
    validEclipseCapture(value.eclipse) &&
    validCommandCapture(value.command, renderer) &&
    validCommandViewCoherence(
      value.command,
      value.eclipse,
      value.viewId,
      renderer,
    )
  );
}

function validBaseline(value, renderer) {
  return (
    exactKeys(value, [
      "renderer",
      "contextId",
      "canvasId",
      "defaultViewId",
      "defaultCameraId",
      "defaultEclipseStateObjectId",
      "defaultEclipseShadowObjectId",
      "currentViewId",
      "frameStateViewId",
      "sameContextCanvas",
      "supportsStereoViewport",
      "canvas",
    ]) &&
    value.renderer === renderer &&
    validIdentity(value.contextId, "context") &&
    validIdentity(value.canvasId, "canvas") &&
    validIdentity(value.defaultViewId, "view") &&
    validIdentity(value.defaultCameraId, "camera") &&
    validIdentity(value.defaultEclipseStateObjectId, "state") &&
    validIdentity(value.defaultEclipseShadowObjectId, "shadow") &&
    validIdentity(value.currentViewId, "view") &&
    validIdentity(value.frameStateViewId, "view") &&
    typeof value.sameContextCanvas === "boolean" &&
    typeof value.supportsStereoViewport === "boolean" &&
    exactKeys(value.canvas, ["width", "height"]) &&
    integer(value.canvas.width, 1) &&
    integer(value.canvas.height, 1)
  );
}

function validWebglRetainedReceipt(value) {
  return (
    exactKeys(value, [
      "kind",
      "beforeGetterId",
      "afterBGetterId",
      "afterAReentryGetterId",
      "bGetterId",
      "beforeSnapshotObjectId",
      "afterBSnapshotObjectId",
      "afterAReentrySnapshotObjectId",
      "bSnapshotObjectId",
    ]) &&
    value.kind === "webgl-retained-uniform-map" &&
    validIdentity(value.beforeGetterId, "getter") &&
    validIdentity(value.afterBGetterId, "getter") &&
    validIdentity(value.afterAReentryGetterId, "getter") &&
    validIdentity(value.bGetterId, "getter") &&
    validIdentity(value.beforeSnapshotObjectId, "snapshot") &&
    validIdentity(value.afterBSnapshotObjectId, "snapshot") &&
    validIdentity(value.afterAReentrySnapshotObjectId, "snapshot") &&
    validIdentity(value.bSnapshotObjectId, "snapshot")
  );
}

function validWebgpuRetainedReceipt(value) {
  if (
    !exactKeys(value, [
      "kind",
      "beforeRendererId",
      "afterBRendererId",
      "afterAReentryRendererId",
      "bRendererId",
      "beforeManagerId",
      "afterBManagerId",
      "afterAReentryManagerId",
      "bManagerId",
      "beforeBufferId",
      "afterBBufferId",
      "afterAReentryBufferId",
      "bBufferId",
      "beforeAbsoluteOffset",
      "afterBAbsoluteOffset",
      "afterAReentryAbsoluteOffset",
      "bAbsoluteOffset",
      "beforeSize",
      "afterBSize",
      "afterAReentrySize",
      "bSize",
      "beforeUploadBytes",
      "afterBUploadBytes",
      "afterAReentryUploadBytes",
      "bUploadBytes",
      "beforeUploadSha256",
      "afterBUploadSha256",
      "afterAReentryUploadSha256",
      "bUploadSha256",
      "aSliceUnchangedAfterB",
      "aSliceUnchangedAfterAReentry",
      "aAndBNonOverlapping",
    ]) ||
    value.kind !== "webgpu-retained-binding-2-slice" ||
    !validIdentity(value.beforeRendererId, "renderer") ||
    value.afterBRendererId !== value.beforeRendererId ||
    value.afterAReentryRendererId !== value.beforeRendererId ||
    value.bRendererId !== value.beforeRendererId ||
    !validIdentity(value.beforeManagerId, "manager") ||
    value.afterBManagerId !== value.beforeManagerId ||
    value.afterAReentryManagerId !== value.beforeManagerId ||
    value.bManagerId !== value.beforeManagerId ||
    !validIdentity(value.beforeBufferId, "buffer") ||
    value.afterBBufferId !== value.beforeBufferId ||
    value.afterAReentryBufferId !== value.beforeBufferId ||
    !validIdentity(value.bBufferId, "buffer") ||
    !integer(value.beforeAbsoluteOffset) ||
    value.afterBAbsoluteOffset !== value.beforeAbsoluteOffset ||
    value.afterAReentryAbsoluteOffset !== value.beforeAbsoluteOffset ||
    !integer(value.bAbsoluteOffset) ||
    value.beforeSize !== 64 ||
    value.afterBSize !== 64 ||
    value.afterAReentrySize !== 64 ||
    value.bSize !== 64 ||
    !byteArray(value.beforeUploadBytes) ||
    !byteArray(value.afterBUploadBytes) ||
    !byteArray(value.afterAReentryUploadBytes) ||
    !byteArray(value.bUploadBytes) ||
    !SHA256.test(value.beforeUploadSha256) ||
    !SHA256.test(value.afterBUploadSha256) ||
    !SHA256.test(value.afterAReentryUploadSha256) ||
    !SHA256.test(value.bUploadSha256)
  ) {
    return false;
  }
  const computedNonOverlap =
    value.beforeBufferId !== value.bBufferId ||
    value.beforeAbsoluteOffset + value.beforeSize <= value.bAbsoluteOffset ||
    value.bAbsoluteOffset + value.bSize <= value.beforeAbsoluteOffset;
  return (
    value.beforeUploadSha256 ===
      sha256(Uint8Array.from(value.beforeUploadBytes)) &&
    value.afterBUploadSha256 ===
      sha256(Uint8Array.from(value.afterBUploadBytes)) &&
    value.afterAReentryUploadSha256 ===
      sha256(Uint8Array.from(value.afterAReentryUploadBytes)) &&
    value.bUploadSha256 === sha256(Uint8Array.from(value.bUploadBytes)) &&
    value.aSliceUnchangedAfterB ===
      jsonEqual(value.beforeUploadBytes, value.afterBUploadBytes) &&
    value.aSliceUnchangedAfterB === true &&
    value.aSliceUnchangedAfterAReentry ===
      jsonEqual(value.beforeUploadBytes, value.afterAReentryUploadBytes) &&
    value.aSliceUnchangedAfterAReentry === true &&
    value.aAndBNonOverlapping === computedNonOverlap &&
    value.aAndBNonOverlapping === true
  );
}

function validRetainedCommand(value, renderer) {
  return (
    exactKeys(value, [
      "kind",
      "beforeCommandId",
      "afterBCommandId",
      "afterAReentryCommandId",
      "bCommandId",
      "beforeCarrierId",
      "afterBCarrierId",
      "afterAReentryCarrierId",
      "bCarrierId",
      "beforeOffset",
      "afterBOffset",
      "afterAReentryOffset",
      "bOffset",
      "beforePayload",
      "afterBPayload",
      "afterAReentryPayload",
      "bPayload",
      "resolvesA",
      "resolvesAAfterReentry",
      "doesNotResolveB",
      "backendReceipt",
    ]) &&
    value.kind ===
      (renderer === "webgl"
        ? "webgl-production-uniform-resolver"
        : "webgpu-bind-group-dynamic-offset") &&
    validIdentity(value.beforeCommandId, "command") &&
    validIdentity(value.afterBCommandId, "command") &&
    validIdentity(value.afterAReentryCommandId, "command") &&
    validIdentity(value.bCommandId, "command") &&
    validIdentity(value.beforeCarrierId, "carrier") &&
    validIdentity(value.afterBCarrierId, "carrier") &&
    validIdentity(value.afterAReentryCarrierId, "carrier") &&
    validIdentity(value.bCarrierId, "carrier") &&
    integer(value.beforeOffset) &&
    integer(value.afterBOffset) &&
    integer(value.afterAReentryOffset) &&
    integer(value.bOffset) &&
    numericArray(value.beforePayload, 16) &&
    numericArray(value.afterBPayload, 16) &&
    numericArray(value.afterAReentryPayload, 16) &&
    numericArray(value.bPayload, 16) &&
    value.resolvesA === jsonEqual(value.beforePayload, value.afterBPayload) &&
    value.resolvesAAfterReentry ===
      jsonEqual(value.beforePayload, value.afterAReentryPayload) &&
    value.doesNotResolveB === !jsonEqual(value.afterBPayload, value.bPayload) &&
    (renderer === "webgl"
      ? validWebglRetainedReceipt(value.backendReceipt)
      : validWebgpuRetainedReceipt(value.backendReceipt))
  );
}

function validIsolation(value, renderer) {
  return (
    exactKeys(value, [
      "sequence",
      "toolsSchedulerOwned",
      "engineSchedulerAvailable",
      "nativeSceneRenderUsed",
      "sameContext",
      "sameCanvas",
      "defaultViewStable",
      "viewsDistinct",
      "camerasDistinct",
      "frustumsDistinct",
      "viewportsDistinct",
      "viewOwnedStateDistinct",
      "viewOwnedShadowDistinct",
      "aCameraStable",
      "aFrustumStable",
      "aViewportStable",
      "aStatePayloadStable",
      "aShadowPayloadStable",
      "aRevisionStable",
      "aSelectionRevisionProgressed",
      "bPayloadDistinct",
      "retainedACommand",
    ]) &&
    sameOrdered(value.sequence, ["A", "B", "A"]) &&
    value.toolsSchedulerOwned === true &&
    value.engineSchedulerAvailable === false &&
    value.nativeSceneRenderUsed === false &&
    [
      "sameContext",
      "sameCanvas",
      "defaultViewStable",
      "viewsDistinct",
      "camerasDistinct",
      "frustumsDistinct",
      "viewportsDistinct",
      "viewOwnedStateDistinct",
      "viewOwnedShadowDistinct",
      "aCameraStable",
      "aFrustumStable",
      "aViewportStable",
      "aStatePayloadStable",
      "aShadowPayloadStable",
      "aRevisionStable",
      "aSelectionRevisionProgressed",
      "bPayloadDistinct",
    ].every((key) => typeof value[key] === "boolean") &&
    validRetainedCommand(value.retainedACommand, renderer)
  );
}

function validRetainedBackendCoherence(
  retained,
  aCommand,
  bCommand,
  aReentryCommand,
  renderer,
) {
  const receipt = retained.backendReceipt;
  if (renderer === "webgl") {
    return (
      receipt.beforeGetterId === aCommand.backendReceipt.getterId &&
      receipt.afterBGetterId === aCommand.backendReceipt.getterId &&
      receipt.afterAReentryGetterId === aCommand.backendReceipt.getterId &&
      receipt.bGetterId === bCommand.backendReceipt.getterId &&
      receipt.beforeSnapshotObjectId ===
        aCommand.backendReceipt.snapshotObjectId &&
      receipt.afterBSnapshotObjectId ===
        aCommand.backendReceipt.snapshotObjectId &&
      receipt.afterAReentrySnapshotObjectId ===
        aCommand.backendReceipt.snapshotObjectId &&
      receipt.bSnapshotObjectId === bCommand.backendReceipt.snapshotObjectId &&
      aReentryCommand.backendReceipt.snapshotObjectId !==
        aCommand.backendReceipt.snapshotObjectId
    );
  }
  const a = aCommand.backendReceipt;
  const b = bCommand.backendReceipt;
  return (
    receipt.beforeRendererId === a.rendererId &&
    receipt.afterBRendererId === a.rendererId &&
    receipt.afterAReentryRendererId === a.rendererId &&
    receipt.bRendererId === b.rendererId &&
    receipt.beforeManagerId === a.managerId &&
    receipt.afterBManagerId === a.managerId &&
    receipt.afterAReentryManagerId === a.managerId &&
    receipt.bManagerId === b.managerId &&
    receipt.beforeBufferId === a.bufferId &&
    receipt.afterBBufferId === a.bufferId &&
    receipt.afterAReentryBufferId === a.bufferId &&
    receipt.bBufferId === b.bufferId &&
    receipt.beforeAbsoluteOffset === a.absoluteOffset &&
    receipt.afterBAbsoluteOffset === a.absoluteOffset &&
    receipt.afterAReentryAbsoluteOffset === a.absoluteOffset &&
    receipt.bAbsoluteOffset === b.absoluteOffset &&
    receipt.beforeSize === a.size &&
    receipt.afterBSize === a.size &&
    receipt.afterAReentrySize === a.size &&
    receipt.bSize === b.size &&
    jsonEqual(receipt.beforeUploadBytes, a.uploadBytes) &&
    jsonEqual(receipt.bUploadBytes, b.uploadBytes) &&
    receipt.beforeUploadSha256 === a.uploadSha256 &&
    receipt.bUploadSha256 === b.uploadSha256 &&
    jsonEqual(
      float32PayloadFromBytes(receipt.afterBUploadBytes),
      retained.afterBPayload,
    ) &&
    jsonEqual(
      float32PayloadFromBytes(receipt.afterAReentryUploadBytes),
      retained.afterAReentryPayload,
    ) &&
    receipt.afterAReentryUploadSha256 === receipt.beforeUploadSha256
  );
}

function validRay(value) {
  const requested = C12_29_S5_MULTIVIEW_WORKLOAD.viewA;
  const expectedOrigin = geodeticPosition(requested, requested.heightMeters);
  const expectedTarget = geodeticPosition(requested, 0);
  const expectedDirection = normalize(subtract(expectedTarget, expectedOrigin));
  return (
    exactKeys(value, ["origin", "direction", "widthMeters"]) &&
    numericArray(value.origin, 3) &&
    numericArray(value.direction, 3) &&
    arrayNearlyEqual(value.origin, expectedOrigin, 1e-6) &&
    arrayNearlyEqual(value.direction, expectedDirection, 1e-13) &&
    nearlyEqual(magnitude(value.direction), 1, 1e-13) &&
    finite(value.widthMeters) &&
    value.widthMeters === C12_29_S5_MULTIVIEW_WORKLOAD.rayWidthMeters
  );
}

function rayWgs84Interval(ray) {
  const scaledOrigin = [
    ray.origin[0] / WGS84_XY_RADIUS,
    ray.origin[1] / WGS84_XY_RADIUS,
    ray.origin[2] / WGS84_Z_RADIUS,
  ];
  const scaledDirection = [
    ray.direction[0] / WGS84_XY_RADIUS,
    ray.direction[1] / WGS84_XY_RADIUS,
    ray.direction[2] / WGS84_Z_RADIUS,
  ];
  const q2 = dot(scaledOrigin, scaledOrigin);
  const qw = dot(scaledOrigin, scaledDirection);
  const w2 = dot(scaledDirection, scaledDirection);
  const discriminant = qw * qw - w2 * (q2 - 1);
  if (!(discriminant >= 0) || !(w2 > 0)) return null;
  const root = Math.sqrt(discriminant);
  return {
    start: (-qw - root) / w2,
    stop: (-qw + root) / w2,
  };
}

function validOffscreen(value, renderer) {
  const expectedPolicy =
    renderer === "webgl"
      ? "sync-position-only-globe"
      : "known-webgpu-no-position-globe";
  const resultPolicyExact =
    renderer === "webgl"
      ? value?.supportsSynchronousReadback === true &&
        value?.hit === true &&
        value?.hitGlobe === true &&
        value?.objectPresent === false &&
        numericArray(value?.position, 3)
      : value?.supportsSynchronousReadback === false &&
        value?.hit === false &&
        value?.hitGlobe === false &&
        value?.objectPresent === false &&
        value?.position === null;
  return (
    exactKeys(value, [
      "viewId",
      "defaultViewId",
      "cameraId",
      "defaultCameraId",
      "constructorIsView",
      "distinctFromDefault",
      "orthographicFrustum",
      "realViewObservedDuringUpdate",
      "frameStateViewIdDuringUpdate",
      "frameStateCameraIdDuringUpdate",
      "eclipseStateObjectId",
      "defaultEclipseStateObjectId",
      "eclipseShadowObjectId",
      "defaultEclipseShadowObjectId",
      "ray",
      "attempts",
      "supportsSynchronousReadback",
      "resultPolicy",
      "hit",
      "hitGlobe",
      "objectPresent",
      "position",
      "cpuEllipsoidInterval",
      "cpuIntersectionPosition",
      "geometricGlobeHit",
      "geometricPosition",
    ]) &&
    validIdentity(value.viewId, "view") &&
    validIdentity(value.defaultViewId, "view") &&
    validIdentity(value.cameraId, "camera") &&
    validIdentity(value.defaultCameraId, "camera") &&
    typeof value.constructorIsView === "boolean" &&
    typeof value.distinctFromDefault === "boolean" &&
    typeof value.orthographicFrustum === "boolean" &&
    typeof value.realViewObservedDuringUpdate === "boolean" &&
    validIdentity(value.frameStateViewIdDuringUpdate, "view") &&
    validIdentity(value.frameStateCameraIdDuringUpdate, "camera") &&
    validIdentity(value.eclipseStateObjectId, "state") &&
    validIdentity(value.defaultEclipseStateObjectId, "state") &&
    validIdentity(value.eclipseShadowObjectId, "shadow") &&
    validIdentity(value.defaultEclipseShadowObjectId, "shadow") &&
    validRay(value.ray) &&
    integer(value.attempts, 1) &&
    value.attempts <= C12_29_S5_MULTIVIEW_WORKLOAD.maximumRayPickAttempts &&
    value.resultPolicy === expectedPolicy &&
    resultPolicyExact &&
    typeof value.hit === "boolean" &&
    typeof value.hitGlobe === "boolean" &&
    typeof value.objectPresent === "boolean" &&
    (value.position === null || numericArray(value.position, 3)) &&
    exactKeys(value.cpuEllipsoidInterval, ["start", "stop"]) &&
    finite(value.cpuEllipsoidInterval.start) &&
    finite(value.cpuEllipsoidInterval.stop) &&
    value.cpuEllipsoidInterval.start >= 0 &&
    value.cpuEllipsoidInterval.stop > value.cpuEllipsoidInterval.start &&
    numericArray(value.cpuIntersectionPosition, 3) &&
    (() => {
      const expectedInterval = rayWgs84Interval(value.ray);
      return (
        expectedInterval !== null &&
        nearlyEqual(
          value.cpuEllipsoidInterval.start,
          expectedInterval.start,
          1e-6,
        ) &&
        nearlyEqual(
          value.cpuEllipsoidInterval.stop,
          expectedInterval.stop,
          1e-6,
        ) &&
        arrayNearlyEqual(
          value.cpuIntersectionPosition,
          addScaled(
            value.ray.origin,
            value.ray.direction,
            expectedInterval.start,
          ),
          1e-5,
        )
      );
    })() &&
    value.geometricGlobeHit === true &&
    numericArray(value.geometricPosition, 3) &&
    vectorDistance(value.geometricPosition, value.cpuIntersectionPosition) <=
      C12_29_S5_MULTIVIEW_WORKLOAD.maximumRayPositionDeltaMeters &&
    (renderer === "webgl"
      ? vectorDistance(value.position, value.cpuIntersectionPosition) <=
        C12_29_S5_MULTIVIEW_WORKLOAD.maximumRayPositionDeltaMeters
      : value.position === null)
  );
}

function validRestoration(value) {
  return (
    exactKeys(value, [
      "sceneViewId",
      "defaultViewId",
      "frameStateViewId",
      "frameStateCameraId",
      "defaultCameraId",
      "uniformCameraPosition",
      "defaultCameraPosition",
      "eclipseStateObjectId",
      "defaultEclipseStateObjectId",
      "eclipseShadowObjectId",
      "defaultEclipseShadowObjectId",
      "allAliasesRestored",
    ]) &&
    validIdentity(value.sceneViewId, "view") &&
    validIdentity(value.defaultViewId, "view") &&
    validIdentity(value.frameStateViewId, "view") &&
    validIdentity(value.frameStateCameraId, "camera") &&
    validIdentity(value.defaultCameraId, "camera") &&
    numericArray(value.uniformCameraPosition, 3) &&
    numericArray(value.defaultCameraPosition, 3) &&
    validIdentity(value.eclipseStateObjectId, "state") &&
    validIdentity(value.defaultEclipseStateObjectId, "state") &&
    validIdentity(value.eclipseShadowObjectId, "shadow") &&
    validIdentity(value.defaultEclipseShadowObjectId, "shadow") &&
    typeof value.allAliasesRestored === "boolean"
  );
}

function validEye(value, side) {
  return (
    exactKeys(value, [
      "side",
      "cameraPosition",
      "xOffset",
      "viewport",
      "eclipseStateObjectId",
      "eclipseShadowObjectId",
      "shadowRevision",
      "shadowPayload",
    ]) &&
    value.side === side &&
    numericArray(value.cameraPosition, 3) &&
    finite(value.xOffset) &&
    validViewport(value.viewport) &&
    validIdentity(value.eclipseStateObjectId, "state") &&
    validIdentity(value.eclipseShadowObjectId, "shadow") &&
    integer(value.shadowRevision) &&
    numericArray(value.shadowPayload, 16)
  );
}

function validWebglVr(value) {
  if (value === null) return false;
  return (
    exactKeys(value, [
      "method",
      "supported",
      "centerCameraPosition",
      "centerCameraRight",
      "centerStateObjectId",
      "centerShadowObjectId",
      "centerShadowPayload",
      "left",
      "right",
      "twoEyesObserved",
      "distinctViewports",
      "symmetricEyePositions",
      "symmetricFrustumOffsets",
      "sharedCenterAnchoredS5",
      "centerCameraRestored",
      "useWebVRRestoredFalse",
    ]) &&
    value.method === C12_29_S5_MULTIVIEW_WORKLOAD.webglStereoMethod &&
    typeof value.supported === "boolean" &&
    numericArray(value.centerCameraPosition, 3) &&
    numericArray(value.centerCameraRight, 3) &&
    nearlyEqual(magnitude(value.centerCameraRight), 1, 1e-13) &&
    validIdentity(value.centerStateObjectId, "state") &&
    validIdentity(value.centerShadowObjectId, "shadow") &&
    numericArray(value.centerShadowPayload, 16) &&
    validEye(value.left, "left") &&
    validEye(value.right, "right") &&
    [
      "twoEyesObserved",
      "distinctViewports",
      "symmetricEyePositions",
      "symmetricFrustumOffsets",
      "sharedCenterAnchoredS5",
      "centerCameraRestored",
      "useWebVRRestoredFalse",
    ].every((key) => typeof value[key] === "boolean")
  );
}

function validWebgpuVr(value) {
  if (value === null) return false;
  return (
    exactKeys(value, [
      "method",
      "supportsStereoViewport",
      "before",
      "error",
      "synchronous",
      "renderCalls",
      "pngSideEffects",
      "gpuSideEffects",
      "after",
      "stateUnchanged",
    ]) &&
    value.method === C12_29_S5_MULTIVIEW_WORKLOAD.webgpuStereoMethod &&
    typeof value.supportsStereoViewport === "boolean" &&
    validWebgpuRejectState(value.before) &&
    exactKeys(value.error, ["name", "message"]) &&
    boundedString(value.error.name, 256) &&
    boundedString(value.error.message) &&
    typeof value.synchronous === "boolean" &&
    integer(value.renderCalls) &&
    integer(value.pngSideEffects) &&
    integer(value.gpuSideEffects) &&
    validWebgpuRejectState(value.after) &&
    typeof value.stateUnchanged === "boolean"
  );
}

function validWebgpuRejectState(value) {
  return (
    exactKeys(value, [
      "useWebVR",
      "sceneViewId",
      "defaultViewId",
      "cameraId",
      "cameraPosition",
      "frustum",
      "cameraVrPresent",
      "deviceOrientationControllerPresent",
      "creditVisibility",
      "frameNumber",
      "commandCount",
      "canvasFingerprint",
    ]) &&
    typeof value.useWebVR === "boolean" &&
    validIdentity(value.sceneViewId, "view") &&
    validIdentity(value.defaultViewId, "view") &&
    validIdentity(value.cameraId, "camera") &&
    numericArray(value.cameraPosition, 3) &&
    validFrustum(value.frustum) &&
    typeof value.cameraVrPresent === "boolean" &&
    typeof value.deviceOrientationControllerPresent === "boolean" &&
    typeof value.creditVisibility === "string" &&
    integer(value.frameNumber, 1) &&
    integer(value.commandCount) &&
    exactKeys(value.canvasFingerprint, ["byteLength", "sha256"]) &&
    integer(value.canvasFingerprint.byteLength, 1) &&
    SHA256.test(value.canvasFingerprint.sha256)
  );
}

function validPageProgress(value, renderer, finalPhase) {
  return (
    exactKeys(value, [
      "schema",
      "renderer",
      "phase",
      "phaseOrdinal",
      "completedPhases",
      "incomplete",
      "checkpoint",
    ]) &&
    value.schema === C12_29_S5_MULTIVIEW_PAGE_SCHEMA &&
    value.renderer === renderer &&
    C12_29_S5_MULTIVIEW_PHASES.includes(value.phase) &&
    value.phase === finalPhase &&
    value.phaseOrdinal === C12_29_S5_MULTIVIEW_PHASES.indexOf(finalPhase) + 1 &&
    Array.isArray(value.completedPhases) &&
    Object.keys(value.completedPhases).length ===
      value.completedPhases.length &&
    value.completedPhases.length === value.phaseOrdinal &&
    sameOrdered(
      value.completedPhases,
      C12_29_S5_MULTIVIEW_PHASES.slice(0, value.phaseOrdinal),
    ) &&
    value.incomplete === false &&
    exactKeys(value.checkpoint, [
      "engineSchedulerAvailable",
      "sceneRenderResetsDefaultView",
      "contextId",
      "canvasId",
      "defaultViewId",
      "defaultCameraId",
      "defaultEclipseStateObjectId",
      "defaultEclipseShadowObjectId",
    ]) &&
    value.checkpoint.engineSchedulerAvailable === false &&
    value.checkpoint.sceneRenderResetsDefaultView === true &&
    validIdentity(value.checkpoint.contextId, "context") &&
    validIdentity(value.checkpoint.canvasId, "canvas") &&
    validIdentity(value.checkpoint.defaultViewId, "view") &&
    validIdentity(value.checkpoint.defaultCameraId, "camera") &&
    validIdentity(value.checkpoint.defaultEclipseStateObjectId, "state") &&
    validIdentity(value.checkpoint.defaultEclipseShadowObjectId, "shadow")
  );
}

function validRuntime(value) {
  return (
    exactKeys(value, [
      "pageErrors",
      "consoleErrors",
      "gpuErrors",
      "deviceLost",
      "armedDevices",
      "ignoredConsoleErrors",
    ]) &&
    ["pageErrors", "consoleErrors", "gpuErrors", "ignoredConsoleErrors"].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].length <= 32 &&
        Object.keys(value[key]).length === value[key].length &&
        value[key].every((entry) => boundedString(entry)),
    ) &&
    typeof value.deviceLost === "boolean" &&
    integer(value.armedDevices)
  );
}

function validTransport(value) {
  return (
    exactKeys(value, [
      "loopback",
      "sameOriginOnly",
      "externalRequests",
      "failedRequests",
      "httpErrors",
    ]) &&
    typeof value.loopback === "boolean" &&
    typeof value.sameOriginOnly === "boolean" &&
    ["externalRequests", "failedRequests", "httpErrors"].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].length <= 32 &&
        Object.keys(value[key]).length === value[key].length &&
        value[key].every((entry) => boundedString(entry)),
    )
  );
}

function validSessionCleanup(value) {
  return (
    exactKeys(value, [
      "complete",
      "secondaryViewDestroyed",
      "sceneViewRestored",
      "useWebVRFalse",
      "instrumentationRestored",
      "pageClosed",
      "contextClosed",
      "timersCleared",
      "pendingRequests",
      "pageCloseTimedOut",
      "contextCloseTimedOut",
    ]) &&
    [
      "complete",
      "secondaryViewDestroyed",
      "sceneViewRestored",
      "useWebVRFalse",
      "instrumentationRestored",
      "pageClosed",
      "contextClosed",
      "timersCleared",
      "pageCloseTimedOut",
      "contextCloseTimedOut",
    ].every((key) => typeof value[key] === "boolean") &&
    integer(value.pendingRequests)
  );
}

function validateSession(session, expectedRenderer) {
  const reasons = [];
  push(
    reasons,
    exactKeys(session, [
      "renderer",
      "status",
      "progress",
      "baseline",
      "views",
      "isolation",
      "offscreenRayPick",
      "restoration",
      "webglVr",
      "webgpuVr",
      "runtime",
      "transport",
      "cleanup",
    ]),
    `${expectedRenderer}: session keys are not exact`,
  );
  if (reasons.length > 0) return reasons;
  push(
    reasons,
    session.renderer === expectedRenderer,
    `${expectedRenderer}: renderer drift`,
  );
  push(
    reasons,
    FINAL_STATUS_SET.has(session.status),
    `${expectedRenderer}: page status is not final`,
  );
  push(
    reasons,
    validPageProgress(
      session.progress,
      expectedRenderer,
      "cleanup-publication",
    ),
    `${expectedRenderer}: page progress is invalid`,
  );
  push(
    reasons,
    validBaseline(session.baseline, expectedRenderer),
    `${expectedRenderer}: baseline is invalid`,
  );
  push(
    reasons,
    exactKeys(session.views, ["aBefore", "b", "aAfter"]),
    `${expectedRenderer}: view capture keys are not exact`,
  );
  if (exactKeys(session.views, ["aBefore", "b", "aAfter"])) {
    push(
      reasons,
      validViewCapture(session.views.aBefore, expectedRenderer),
      `${expectedRenderer}: A-before capture is invalid`,
    );
    push(
      reasons,
      session.views.aBefore?.label === "A-before",
      `${expectedRenderer}: A-before label is invalid`,
    );
    push(
      reasons,
      validViewCapture(session.views.b, expectedRenderer),
      `${expectedRenderer}: B capture is invalid`,
    );
    push(
      reasons,
      session.views.b?.label === "B",
      `${expectedRenderer}: B label is invalid`,
    );
    push(
      reasons,
      validViewCapture(session.views.aAfter, expectedRenderer),
      `${expectedRenderer}: A-after capture is invalid`,
    );
    push(
      reasons,
      session.views.aAfter?.label === "A-after",
      `${expectedRenderer}: A-after label is invalid`,
    );
  }
  push(
    reasons,
    validIsolation(session.isolation, expectedRenderer),
    `${expectedRenderer}: isolation fold is invalid`,
  );
  push(
    reasons,
    validOffscreen(session.offscreenRayPick, expectedRenderer),
    `${expectedRenderer}: offscreen ray pick is invalid`,
  );
  push(
    reasons,
    validRestoration(session.restoration),
    `${expectedRenderer}: default-view restoration is invalid`,
  );
  push(
    reasons,
    expectedRenderer === "webgl"
      ? validWebglVr(session.webglVr) && session.webgpuVr === null
      : session.webglVr === null && validWebgpuVr(session.webgpuVr),
    `${expectedRenderer}: stereo lane is invalid`,
  );
  push(
    reasons,
    validRuntime(session.runtime),
    `${expectedRenderer}: runtime ledger is invalid`,
  );
  push(
    reasons,
    validTransport(session.transport),
    `${expectedRenderer}: transport ledger is invalid`,
  );
  push(
    reasons,
    validSessionCleanup(session.cleanup),
    `${expectedRenderer}: cleanup ledger is invalid`,
  );
  return reasons;
}

function validProvenance(value) {
  if (
    !exactKeys(value, [
      "localStable",
      "servedEntryExact",
      "buildSourceExact",
      "localFiles",
      "runtimeEntry",
      "buildSourceMap",
      "servedEntries",
      "reasons",
    ]) ||
    typeof value.localStable !== "boolean" ||
    typeof value.servedEntryExact !== "boolean" ||
    typeof value.buildSourceExact !== "boolean" ||
    !validateReasonArray(value.reasons) ||
    !Array.isArray(value.localFiles) ||
    value.localFiles.length !== C12_29_S5_MULTIVIEW_SOURCE_FILES.length ||
    !exactKeys(value.runtimeEntry, ["byteLength", "sha256"]) ||
    !integer(value.runtimeEntry.byteLength, 1) ||
    !SHA256.test(value.runtimeEntry.sha256) ||
    !exactKeys(value.buildSourceMap, ["byteLength", "sha256"]) ||
    !integer(value.buildSourceMap.byteLength, 1) ||
    !SHA256.test(value.buildSourceMap.sha256) ||
    !Array.isArray(value.servedEntries) ||
    value.servedEntries.length !== C12_29_S5_MULTIVIEW_RENDERERS.length
  ) {
    return false;
  }
  const filesOk = C12_29_S5_MULTIVIEW_SOURCE_FILES.every((file, index) => {
    const entry = value.localFiles[index];
    return (
      exactKeys(entry, ["file", "byteLength", "sha256"]) &&
      entry.file === file &&
      integer(entry.byteLength, 1) &&
      SHA256.test(entry.sha256)
    );
  });
  const entriesOk = C12_29_S5_MULTIVIEW_RENDERERS.every((renderer, index) => {
    const entry = value.servedEntries[index];
    return (
      exactKeys(entry, ["renderer", "status", "byteLength", "sha256"]) &&
      entry.renderer === renderer &&
      entry.status === 200 &&
      integer(entry.byteLength, 1) &&
      SHA256.test(entry.sha256) &&
      entry.byteLength === value.runtimeEntry.byteLength &&
      entry.sha256 === value.runtimeEntry.sha256
    );
  });
  return filesOk && entriesOk;
}

function validClaim(value) {
  return (
    exactKeys(value, [
      "scope",
      "scheduler",
      "engineSchedulerAvailable",
      "nativeArbitraryViewSchedulingClaimed",
      "sceneRenderResetsDefaultView",
    ]) &&
    value.scope === C12_29_S5_MULTIVIEW_WORKLOAD.claim &&
    value.scheduler === C12_29_S5_MULTIVIEW_WORKLOAD.scheduler &&
    value.engineSchedulerAvailable === false &&
    value.nativeArbitraryViewSchedulingClaimed === false &&
    value.sceneRenderResetsDefaultView === true
  );
}

function validGlobalCleanup(value) {
  return (
    exactKeys(value, [
      "complete",
      "browserClosed",
      "contextsClosed",
      "timersCleared",
      "pendingRequests",
      "lockReleased",
    ]) &&
    [
      "complete",
      "browserClosed",
      "contextsClosed",
      "timersCleared",
      "lockReleased",
    ].every((key) => typeof value[key] === "boolean") &&
    integer(value.pendingRequests)
  );
}

function validateReportCore(report) {
  const structuralReasons = [];
  if (
    !exactKeys(report, [
      "schema",
      "runId",
      "artifactName",
      "startedAt",
      "completedAt",
      "incomplete",
      "claim",
      "workload",
      "provenance",
      "sessions",
      "crossBackend",
      "cleanup",
    ])
  ) {
    return ["report keys are not exact"];
  }
  push(
    structuralReasons,
    report.schema === C12_29_S5_MULTIVIEW_SCHEMA,
    "schema drift",
  );
  push(
    structuralReasons,
    UUID_V4.test(report.runId ?? ""),
    "runId is not UUID v4",
  );
  push(
    structuralReasons,
    report.artifactName === `${report.runId}.json`,
    "artifactName is not run-bound",
  );
  push(
    structuralReasons,
    validIsoTimestamp(report.startedAt),
    "startedAt is invalid",
  );
  push(
    structuralReasons,
    validIsoTimestamp(report.completedAt),
    "completedAt is invalid",
  );
  push(
    structuralReasons,
    validIsoTimestamp(report.startedAt) &&
      validIsoTimestamp(report.completedAt) &&
      Date.parse(report.completedAt) >= Date.parse(report.startedAt),
    "completion precedes start",
  );
  push(
    structuralReasons,
    report.incomplete === false,
    "final report is incomplete",
  );
  push(
    structuralReasons,
    validClaim(report.claim),
    "claim is widened or malformed",
  );
  push(
    structuralReasons,
    jsonEqual(report.workload, C12_29_S5_MULTIVIEW_WORKLOAD),
    "workload drift",
  );
  push(
    structuralReasons,
    validProvenance(report.provenance),
    "provenance is invalid",
  );
  push(
    structuralReasons,
    Array.isArray(report.sessions) &&
      report.sessions.length === 2 &&
      Object.keys(report.sessions).length === 2,
    "sessions are not exact",
  );
  if (Array.isArray(report.sessions) && report.sessions.length === 2) {
    for (let index = 0; index < C12_29_S5_MULTIVIEW_RENDERERS.length; index++) {
      structuralReasons.push(
        ...validateSession(
          report.sessions[index],
          C12_29_S5_MULTIVIEW_RENDERERS[index],
        ),
      );
    }
  }
  push(
    structuralReasons,
    exactKeys(report.crossBackend, [
      "sameWorkload",
      "sameClaim",
      "bothSameContextIsolation",
      "bothRayPickRealView",
      "stereoPolicyComplementary",
    ]) &&
      Object.values(report.crossBackend).every(
        (entry) => typeof entry === "boolean",
      ),
    "cross-backend fold shape is invalid",
  );
  push(
    structuralReasons,
    validGlobalCleanup(report.cleanup),
    "global cleanup is invalid",
  );
  return structuralReasons;
}

function deriveAcceptance(report) {
  const sessionPasses = (session, renderer) => {
    if (validateSession(session, renderer).length !== 0) return false;
    const views = session.views;
    const isolation = session.isolation;
    const offscreen = session.offscreenRayPick;
    const restoration = session.restoration;
    const runtime = session.runtime;
    const transport = session.transport;
    const cleanup = session.cleanup;
    const retained = isolation.retainedACommand;
    const captures = [views.aBefore, views.b, views.aAfter];
    const webglSnapshotIsolation =
      renderer !== "webgl" ||
      (allDistinct(captures.map((capture) => capture.command.commandId)) &&
        allDistinct(captures.map((capture) => capture.command.carrierId)) &&
        allDistinct(
          captures.map(
            (capture) => capture.command.backendReceipt.snapshotObjectId,
          ),
        ) &&
        captures.every(
          (capture) =>
            capture.command.backendReceipt.snapshotDistinctFromSource ===
              true &&
            capture.command.backendReceipt.snapshotFrozen === true &&
            capture.command.backendReceipt.snapshotPayloadFrozen === true &&
            capture.command.backendReceipt.snapshotWrapperExact === true &&
            capture.command.backendReceipt.carrierPropertiesDescriptorExact ===
              true &&
            capture.command.backendReceipt
              .propertiesOverlayDistinctFromPooled === true &&
            capture.command.backendReceipt.propertiesPrototypeExact === true &&
            capture.command.backendReceipt.onlyEclipseOwnProperty === true &&
            capture.command.backendReceipt.nonS5UniformDescriptorsExact ===
              true &&
            capture.command.backendReceipt.nonS5ResolvedValueExact === true &&
            capture.command.carrierId !==
              capture.command.backendReceipt.pooledUniformMapId &&
            capture.command.backendReceipt.propertiesOverlayId !==
              capture.command.backendReceipt.pooledPropertiesId,
        ));
    const common =
      session.status === "PASS" &&
      session.baseline.sameContextCanvas === true &&
      session.progress.checkpoint.contextId === session.baseline.contextId &&
      session.progress.checkpoint.canvasId === session.baseline.canvasId &&
      session.progress.checkpoint.defaultViewId ===
        session.baseline.defaultViewId &&
      session.progress.checkpoint.defaultCameraId ===
        session.baseline.defaultCameraId &&
      session.progress.checkpoint.defaultEclipseStateObjectId ===
        session.baseline.defaultEclipseStateObjectId &&
      session.progress.checkpoint.defaultEclipseShadowObjectId ===
        session.baseline.defaultEclipseShadowObjectId &&
      session.baseline.currentViewId === session.baseline.defaultViewId &&
      session.baseline.frameStateViewId === session.baseline.defaultViewId &&
      session.baseline.canvas.width ===
        C12_29_S5_MULTIVIEW_WORKLOAD.viewport.width &&
      session.baseline.canvas.height ===
        C12_29_S5_MULTIVIEW_WORKLOAD.viewport.height &&
      session.baseline.supportsStereoViewport === (renderer === "webgl") &&
      captures.every(
        (capture) =>
          capture.contextId === session.baseline.contextId &&
          capture.canvasId === session.baseline.canvasId &&
          capture.defaultViewId === session.baseline.defaultViewId,
      ) &&
      allDistinct(captures.map((capture) => capture.command.commandId)) &&
      webglSnapshotIsolation &&
      views.aBefore.constructorIsView === true &&
      views.b.constructorIsView === true &&
      views.aAfter.constructorIsView === true &&
      views.aBefore.isDefaultView === true &&
      views.b.isDefaultView === false &&
      views.aAfter.isDefaultView === true &&
      views.aBefore.viewId === session.baseline.defaultViewId &&
      views.aAfter.viewId === session.baseline.defaultViewId &&
      views.aBefore.camera.cameraId === session.baseline.defaultCameraId &&
      views.aAfter.camera.cameraId === session.baseline.defaultCameraId &&
      views.b.camera.cameraId !== session.baseline.defaultCameraId &&
      views.b.camera.cameraId !== views.aBefore.camera.cameraId &&
      views.aBefore.eclipse.stateObjectId ===
        session.baseline.defaultEclipseStateObjectId &&
      views.aAfter.eclipse.stateObjectId ===
        session.baseline.defaultEclipseStateObjectId &&
      views.aBefore.eclipse.shadowObjectId ===
        session.baseline.defaultEclipseShadowObjectId &&
      views.aAfter.eclipse.shadowObjectId ===
        session.baseline.defaultEclipseShadowObjectId &&
      views.aBefore.frameStateViewId === views.aBefore.viewId &&
      views.b.frameStateViewId === views.b.viewId &&
      views.aAfter.frameStateViewId === views.aAfter.viewId &&
      views.aBefore.command.ownerIsGlobe === true &&
      views.b.command.ownerIsGlobe === true &&
      views.aAfter.command.ownerIsGlobe === true &&
      views.aBefore.eclipse.prepared === true &&
      views.b.eclipse.prepared === true &&
      views.aAfter.eclipse.prepared === true &&
      views.aBefore.contextId === views.b.contextId &&
      views.b.contextId === views.aAfter.contextId &&
      views.aBefore.canvasId === views.b.canvasId &&
      views.b.canvasId === views.aAfter.canvasId &&
      views.aBefore.defaultViewId === views.b.defaultViewId &&
      views.b.defaultViewId === views.aAfter.defaultViewId &&
      views.aBefore.viewId !== views.b.viewId &&
      views.aBefore.viewId === views.aAfter.viewId &&
      matchesRequestedPerspectiveFrustum(
        views.aBefore,
        C12_29_S5_MULTIVIEW_WORKLOAD.viewA,
      ) &&
      matchesRequestedPerspectiveFrustum(
        views.b,
        C12_29_S5_MULTIVIEW_WORKLOAD.viewB,
      ) &&
      matchesRequestedPerspectiveFrustum(
        views.aAfter,
        C12_29_S5_MULTIVIEW_WORKLOAD.viewA,
      ) &&
      !jsonEqual(views.aBefore.camera, views.b.camera) &&
      !jsonEqual(views.aBefore.frustum, views.b.frustum) &&
      !jsonEqual(views.aBefore.viewport, views.b.viewport) &&
      views.aBefore.eclipse.stateObjectId !== views.b.eclipse.stateObjectId &&
      views.aBefore.eclipse.shadowObjectId !== views.b.eclipse.shadowObjectId &&
      views.aBefore.eclipse.stateObjectId ===
        views.aAfter.eclipse.stateObjectId &&
      views.aBefore.eclipse.shadowObjectId ===
        views.aAfter.eclipse.shadowObjectId &&
      jsonEqual(views.aBefore.camera, views.aAfter.camera) &&
      jsonEqual(views.aBefore.frustum, views.aAfter.frustum) &&
      jsonEqual(views.aBefore.viewport, views.aAfter.viewport) &&
      jsonEqual(views.aBefore.eclipse.state, views.aAfter.eclipse.state) &&
      jsonEqual(views.aBefore.eclipse.shadow, views.aAfter.eclipse.shadow) &&
      views.aBefore.eclipse.shadow.revision ===
        views.aAfter.eclipse.shadow.revision &&
      views.aAfter.eclipse.selectionRevision >=
        views.aBefore.eclipse.selectionRevision &&
      (!jsonEqual(views.aBefore.eclipse.state, views.b.eclipse.state) ||
        !jsonEqual(views.aBefore.eclipse.shadow, views.b.eclipse.shadow)) &&
      [
        "sameContext",
        "sameCanvas",
        "defaultViewStable",
        "viewsDistinct",
        "camerasDistinct",
        "frustumsDistinct",
        "viewportsDistinct",
        "viewOwnedStateDistinct",
        "viewOwnedShadowDistinct",
        "aCameraStable",
        "aFrustumStable",
        "aViewportStable",
        "aStatePayloadStable",
        "aShadowPayloadStable",
        "aRevisionStable",
        "aSelectionRevisionProgressed",
        "bPayloadDistinct",
      ].every((key) => isolation[key] === true) &&
      retained.beforeCommandId === views.aBefore.command.commandId &&
      retained.afterBCommandId === retained.beforeCommandId &&
      retained.afterAReentryCommandId === retained.beforeCommandId &&
      retained.bCommandId === views.b.command.commandId &&
      retained.beforeCarrierId === views.aBefore.command.carrierId &&
      retained.afterBCarrierId === retained.beforeCarrierId &&
      retained.afterAReentryCarrierId === retained.beforeCarrierId &&
      retained.bCarrierId === views.b.command.carrierId &&
      retained.beforeOffset === views.aBefore.command.eclipseDynamicOffset &&
      retained.afterBOffset === retained.beforeOffset &&
      retained.afterAReentryOffset === retained.beforeOffset &&
      retained.bOffset === views.b.command.eclipseDynamicOffset &&
      jsonEqual(
        retained.beforePayload,
        views.aBefore.command.resolvedPayload,
      ) &&
      jsonEqual(retained.bPayload, views.b.command.resolvedPayload) &&
      jsonEqual(retained.afterAReentryPayload, retained.beforePayload) &&
      retained.resolvesA === true &&
      retained.resolvesAAfterReentry === true &&
      retained.doesNotResolveB === true &&
      validRetainedBackendCoherence(
        retained,
        views.aBefore.command,
        views.b.command,
        views.aAfter.command,
        renderer,
      ) &&
      offscreen.viewId !== offscreen.defaultViewId &&
      offscreen.defaultViewId === session.baseline.defaultViewId &&
      offscreen.cameraId !== offscreen.defaultCameraId &&
      offscreen.defaultCameraId === session.baseline.defaultCameraId &&
      offscreen.constructorIsView === true &&
      offscreen.distinctFromDefault === true &&
      offscreen.orthographicFrustum === true &&
      offscreen.realViewObservedDuringUpdate === true &&
      offscreen.frameStateViewIdDuringUpdate === offscreen.viewId &&
      offscreen.frameStateCameraIdDuringUpdate === offscreen.cameraId &&
      offscreen.eclipseStateObjectId !==
        offscreen.defaultEclipseStateObjectId &&
      offscreen.defaultEclipseStateObjectId ===
        session.baseline.defaultEclipseStateObjectId &&
      offscreen.eclipseShadowObjectId !==
        offscreen.defaultEclipseShadowObjectId &&
      offscreen.defaultEclipseShadowObjectId ===
        session.baseline.defaultEclipseShadowObjectId &&
      offscreen.geometricGlobeHit === true &&
      restoration.sceneViewId === restoration.defaultViewId &&
      restoration.defaultViewId === session.baseline.defaultViewId &&
      restoration.frameStateViewId === restoration.defaultViewId &&
      restoration.frameStateCameraId === restoration.defaultCameraId &&
      restoration.defaultCameraId === session.baseline.defaultCameraId &&
      jsonEqual(
        restoration.uniformCameraPosition,
        restoration.defaultCameraPosition,
      ) &&
      restoration.eclipseStateObjectId ===
        restoration.defaultEclipseStateObjectId &&
      restoration.defaultEclipseStateObjectId ===
        session.baseline.defaultEclipseStateObjectId &&
      restoration.eclipseShadowObjectId ===
        restoration.defaultEclipseShadowObjectId &&
      restoration.defaultEclipseShadowObjectId ===
        session.baseline.defaultEclipseShadowObjectId &&
      restoration.allAliasesRestored === true &&
      [
        ...runtime.pageErrors,
        ...runtime.consoleErrors,
        ...runtime.gpuErrors,
        ...runtime.ignoredConsoleErrors,
      ].length === 0 &&
      runtime.deviceLost === false &&
      transport.loopback === true &&
      transport.sameOriginOnly === true &&
      [
        ...transport.externalRequests,
        ...transport.failedRequests,
        ...transport.httpErrors,
      ].length === 0 &&
      cleanup.complete === true &&
      cleanup.secondaryViewDestroyed === true &&
      cleanup.sceneViewRestored === true &&
      cleanup.useWebVRFalse === true &&
      cleanup.instrumentationRestored === true &&
      cleanup.pageClosed === true &&
      cleanup.contextClosed === true &&
      cleanup.timersCleared === true &&
      cleanup.pendingRequests === 0 &&
      cleanup.pageCloseTimedOut === false &&
      cleanup.contextCloseTimedOut === false;
    if (!common) return false;
    if (renderer === "webgl") {
      const vr = session.webglVr;
      const midpoint = vr.left.cameraPosition.map(
        (entry, index) => (entry + vr.right.cameraPosition[index]) * 0.5,
      );
      const expectedLeftViewport = {
        x: 0,
        y: 0,
        width: C12_29_S5_MULTIVIEW_WORKLOAD.viewport.width * 0.5,
        height: C12_29_S5_MULTIVIEW_WORKLOAD.viewport.height,
      };
      const expectedRightViewport = {
        ...expectedLeftViewport,
        x: expectedLeftViewport.width,
      };
      const leftEyeDistance = vectorDistance(
        vr.left.cameraPosition,
        vr.centerCameraPosition,
      );
      const rightEyeDistance = vectorDistance(
        vr.right.cameraPosition,
        vr.centerCameraPosition,
      );
      const eyeSeparation = vectorDistance(
        vr.left.cameraPosition,
        vr.right.cameraPosition,
      );
      const leftDelta = subtract(
        vr.left.cameraPosition,
        vr.centerCameraPosition,
      );
      const rightDelta = subtract(
        vr.right.cameraPosition,
        vr.centerCameraPosition,
      );
      const expectedLeftDelta = vr.centerCameraRight.map(
        (entry) => entry * leftEyeDistance,
      );
      const expectedRightDelta = vr.centerCameraRight.map(
        (entry) => -entry * rightEyeDistance,
      );
      return (
        vr.supported === true &&
        vr.left.xOffset > 0 &&
        vr.right.xOffset < 0 &&
        Math.abs(vr.left.xOffset + vr.right.xOffset) <= 1e-15 &&
        vectorDistance(midpoint, vr.centerCameraPosition) <= 1e-6 &&
        leftEyeDistance >=
          C12_29_S5_MULTIVIEW_WORKLOAD.minimumStereoEyeSeparationMeters * 0.5 &&
        rightEyeDistance >=
          C12_29_S5_MULTIVIEW_WORKLOAD.minimumStereoEyeSeparationMeters * 0.5 &&
        eyeSeparation >=
          C12_29_S5_MULTIVIEW_WORKLOAD.minimumStereoEyeSeparationMeters &&
        Math.abs(leftEyeDistance - rightEyeDistance) <= 1e-6 &&
        arrayNearlyEqual(leftDelta, expectedLeftDelta, 1e-6) &&
        arrayNearlyEqual(rightDelta, expectedRightDelta, 1e-6) &&
        arrayNearlyEqual(
          vr.centerCameraRight,
          views.aAfter.camera.rightWC,
          1e-13,
        ) &&
        jsonEqual(vr.left.viewport, expectedLeftViewport) &&
        jsonEqual(vr.right.viewport, expectedRightViewport) &&
        vr.twoEyesObserved === true &&
        vr.distinctViewports === true &&
        vr.symmetricEyePositions === true &&
        vr.symmetricFrustumOffsets === true &&
        vr.sharedCenterAnchoredS5 === true &&
        vr.centerCameraRestored === true &&
        vr.useWebVRRestoredFalse === true &&
        vr.left.eclipseStateObjectId === vr.centerStateObjectId &&
        vr.right.eclipseStateObjectId === vr.centerStateObjectId &&
        vr.left.eclipseShadowObjectId === vr.centerShadowObjectId &&
        vr.right.eclipseShadowObjectId === vr.centerShadowObjectId &&
        vr.left.shadowRevision === vr.right.shadowRevision &&
        vr.centerStateObjectId === views.aAfter.eclipse.stateObjectId &&
        vr.centerShadowObjectId === views.aAfter.eclipse.shadowObjectId &&
        jsonEqual(
          vr.centerShadowPayload,
          views.aAfter.eclipse.shadow.packedF32,
        ) &&
        jsonEqual(vr.left.shadowPayload, vr.centerShadowPayload) &&
        jsonEqual(vr.right.shadowPayload, vr.centerShadowPayload)
      );
    }
    const vr = session.webgpuVr;
    const receipts = captures.map((capture) => capture.command.backendReceipt);
    const executionIdentitiesUnique =
      allDistinct(receipts.map((receipt) => receipt.allocationEpoch)) &&
      allDistinct(receipts.map((receipt) => receipt.bufferId)) &&
      allDistinct(receipts.map((receipt) => receipt.frameEncoderId)) &&
      allDistinct(receipts.map((receipt) => receipt.renderPassEncoderId)) &&
      allDistinct(receipts.map((receipt) => receipt.submittedCommandBufferId));
    const executionSequences = receipts.flatMap((receipt) => [
      receipt.bindSequence,
      receipt.drawSequence,
      receipt.flushSequence,
      receipt.finishSequence,
      receipt.submitSequence,
    ]);
    const executionSequenceUnique = allDistinct(executionSequences);
    const captureOrderLinear = receipts.every(
      (receipt, index) =>
        index === 0 ||
        receipts[index - 1].submitSequence < receipt.bindSequence,
    );
    return (
      executionIdentitiesUnique &&
      executionSequenceUnique &&
      captureOrderLinear &&
      vr.supportsStereoViewport === false &&
      vr.before.useWebVR === false &&
      vr.after.useWebVR === false &&
      vr.error.name === "DeveloperError" &&
      vr.error.message === C12_29_S5_MULTIVIEW_WEBGPU_VR_ERROR &&
      vr.synchronous === true &&
      vr.renderCalls === 0 &&
      vr.pngSideEffects === 0 &&
      vr.gpuSideEffects === 0 &&
      vr.stateUnchanged === true &&
      jsonEqual(vr.before, vr.after)
    );
  };
  const checks = {
    narrowClaim: validClaim(report?.claim),
    provenance:
      validProvenance(report?.provenance) &&
      report.provenance.localStable === true &&
      report.provenance.servedEntryExact === true &&
      report.provenance.buildSourceExact === true &&
      report.provenance.reasons.length === 0,
    webglSession:
      Array.isArray(report?.sessions) &&
      sessionPasses(report.sessions[0], "webgl"),
    webgpuSession:
      Array.isArray(report?.sessions) &&
      sessionPasses(report.sessions[1], "webgpu"),
    crossBackend:
      exactKeys(report?.crossBackend, [
        "sameWorkload",
        "sameClaim",
        "bothSameContextIsolation",
        "bothRayPickRealView",
        "stereoPolicyComplementary",
      ]) && Object.values(report.crossBackend).every((entry) => entry === true),
    cleanup:
      validGlobalCleanup(report?.cleanup) &&
      report.cleanup.complete === true &&
      report.cleanup.browserClosed === true &&
      report.cleanup.contextsClosed === true &&
      report.cleanup.timersCleared === true &&
      report.cleanup.pendingRequests === 0 &&
      report.cleanup.lockReleased === true,
  };
  return checks;
}

export function isC1229S5MultiviewUuidV4(value) {
  return UUID_V4.test(value ?? "");
}

// The tolerant reader: this gate resolves statuses that arrive from untrusted
// artifact data, where an unreadable tier means the artifact cannot vouch for
// what it saw. The mapping itself is shared with every other S5 gate.
export { exitCodeForC1229S5MultiviewStatus };

export function stableC1229S5MultiviewJson(value, space) {
  const normalized = cloneMultiviewJsonSafe(value);
  const json = JSON.stringify(normalized, null, space);
  if (typeof json !== "string") {
    throw new TypeError("multiview JSON-safe root is not serializable");
  }
  return `${json}${space ? "\n" : ""}`;
}

export function foldC1229S5MultiviewGate(report) {
  try {
    report = JSON.parse(stableC1229S5MultiviewJson(report));
  } catch {
    const checks = deriveAcceptance(null);
    return {
      status: "STRUCTURAL",
      exitCode: exitCodeForC1229S5MultiviewStatus("STRUCTURAL"),
      structuralReasons: ["report is not canonical JSON-safe data"],
      failureReasons: [],
      checks,
    };
  }
  let structuralReasons;
  let checks;
  try {
    structuralReasons = validateReportCore(report);
    checks = deriveAcceptance(report);
  } catch {
    return {
      status: "STRUCTURAL",
      exitCode: exitCodeForC1229S5MultiviewStatus("STRUCTURAL"),
      structuralReasons: ["report validation failed safely"],
      failureReasons: [],
      checks: deriveAcceptance(null),
    };
  }
  const failureReasons = [];
  if (structuralReasons.length === 0) {
    for (const [name, passed] of Object.entries(checks)) {
      if (!passed) failureReasons.push(`${name} acceptance failed`);
    }
  }
  const status =
    structuralReasons.length > 0
      ? "STRUCTURAL"
      : failureReasons.length > 0
        ? "FAIL"
        : "PASS";
  return {
    status,
    exitCode: exitCodeForC1229S5MultiviewStatus(status),
    structuralReasons,
    failureReasons,
    checks,
  };
}

function validateDiagnostics(value) {
  if (!boundedPlainJson(value)) return false;
  let encoded;
  try {
    encoded = stableC1229S5MultiviewJson(value);
  } catch {
    return false;
  }
  return (
    encoded.length <= MAX_DIAGNOSTIC_JSON &&
    exactKeys(value, [
      "schema",
      "renderer",
      "stage",
      "timeoutMs",
      "page",
      "errorName",
      "errorMessage",
    ]) &&
    value.schema === C12_29_S5_MULTIVIEW_DIAGNOSTICS_SCHEMA &&
    (value.renderer === null ||
      C12_29_S5_MULTIVIEW_RENDERERS.includes(value.renderer)) &&
    new Set([
      "preflight",
      "browser",
      "page",
      "watchdog",
      "publication",
      "node",
    ]).has(value.stage) &&
    integer(value.timeoutMs, 1) &&
    (value.page === null ||
      (new Set(["page", "watchdog"]).has(value.stage) &&
        C12_29_S5_MULTIVIEW_RENDERERS.includes(value.renderer) &&
        validPartialPageDiagnostic(value.page, value.renderer))) &&
    boundedString(value.errorName, 256) &&
    boundedString(value.errorMessage)
  );
}

function validPartialPageDiagnostic(value, renderer) {
  return (
    exactKeys(value, [
      "schema",
      "renderer",
      "phase",
      "phaseOrdinal",
      "completedPhases",
      "incomplete",
      "checkpoint",
    ]) &&
    value.schema === C12_29_S5_MULTIVIEW_PAGE_SCHEMA &&
    value.renderer === renderer &&
    C12_29_S5_MULTIVIEW_PHASES.includes(value.phase) &&
    value.phaseOrdinal ===
      C12_29_S5_MULTIVIEW_PHASES.indexOf(value.phase) + 1 &&
    Array.isArray(value.completedPhases) &&
    Object.keys(value.completedPhases).length ===
      value.completedPhases.length &&
    (value.completedPhases.length === value.phaseOrdinal - 1 ||
      value.completedPhases.length === value.phaseOrdinal) &&
    sameOrdered(
      value.completedPhases,
      C12_29_S5_MULTIVIEW_PHASES.slice(0, value.completedPhases.length),
    ) &&
    ((value.incomplete === true &&
      value.completedPhases.length < C12_29_S5_MULTIVIEW_PHASES.length) ||
      (value.incomplete === false &&
        value.phase === "cleanup-publication" &&
        value.phaseOrdinal === C12_29_S5_MULTIVIEW_PHASES.length &&
        value.completedPhases.length === C12_29_S5_MULTIVIEW_PHASES.length)) &&
    exactKeys(value.checkpoint, [
      "engineSchedulerAvailable",
      "sceneRenderResetsDefaultView",
      "contextId",
      "canvasId",
      "defaultViewId",
      "defaultCameraId",
      "defaultEclipseStateObjectId",
      "defaultEclipseShadowObjectId",
    ]) &&
    value.checkpoint.engineSchedulerAvailable === false &&
    value.checkpoint.sceneRenderResetsDefaultView === true &&
    ((value.phaseOrdinal === 1 &&
      value.completedPhases.length === 0 &&
      ([
        "contextId",
        "canvasId",
        "defaultViewId",
        "defaultCameraId",
        "defaultEclipseStateObjectId",
        "defaultEclipseShadowObjectId",
      ].every((key) => value.checkpoint[key] === null) ||
        (validIdentity(value.checkpoint.contextId, "context") &&
          validIdentity(value.checkpoint.canvasId, "canvas") &&
          validIdentity(value.checkpoint.defaultViewId, "view") &&
          validIdentity(value.checkpoint.defaultCameraId, "camera") &&
          validIdentity(
            value.checkpoint.defaultEclipseStateObjectId,
            "state",
          ) &&
          validIdentity(
            value.checkpoint.defaultEclipseShadowObjectId,
            "shadow",
          )))) ||
      ((value.phaseOrdinal > 1 || value.completedPhases.length > 0) &&
        validIdentity(value.checkpoint.contextId, "context") &&
        validIdentity(value.checkpoint.canvasId, "canvas") &&
        validIdentity(value.checkpoint.defaultViewId, "view") &&
        validIdentity(value.checkpoint.defaultCameraId, "camera") &&
        validIdentity(value.checkpoint.defaultEclipseStateObjectId, "state") &&
        validIdentity(value.checkpoint.defaultEclipseShadowObjectId, "shadow")))
  );
}

export function createC1229S5MultiviewErrorArtifact(
  runId,
  error,
  options = {},
) {
  const read = (value, key) => {
    try {
      return value?.[key];
    } catch {
      return undefined;
    }
  };
  const rawName = read(error, "name");
  const rawMessage = read(error, "message");
  let fallbackMessage = "unknown error";
  if (typeof rawMessage !== "string" || rawMessage.length === 0) {
    try {
      fallbackMessage = String(error) || fallbackMessage;
    } catch {
      fallbackMessage = "uninspectable multiview error";
    }
  }
  const errorName =
    typeof rawName === "string" && rawName.length > 0
      ? rawName.slice(0, 256)
      : "Error";
  const errorMessage = (
    typeof rawMessage === "string" && rawMessage.length > 0
      ? rawMessage
      : fallbackMessage
  ).slice(0, MAX_DIAGNOSTIC_STRING);
  const rendererCandidate = read(options, "renderer");
  const renderer = C12_29_S5_MULTIVIEW_RENDERERS.includes(rendererCandidate)
    ? rendererCandidate
    : null;
  const stageCandidate = read(options, "stage");
  const stages = new Set([
    "preflight",
    "browser",
    "page",
    "watchdog",
    "publication",
    "node",
  ]);
  const stage = stages.has(stageCandidate) ? stageCandidate : "node";
  const timeoutCandidate = read(options, "timeoutMs");
  const timeoutMs = integer(timeoutCandidate, 1) ? timeoutCandidate : 540_000;
  const pageCandidate = read(options, "page");
  let page = null;
  if (
    renderer !== null &&
    new Set(["page", "watchdog"]).has(stage) &&
    validPartialPageDiagnostic(pageCandidate, renderer)
  ) {
    page = JSON.parse(stableC1229S5MultiviewJson(pageCandidate));
  }
  return {
    schema: C12_29_S5_MULTIVIEW_SCHEMA,
    runId,
    artifactName: `${runId}.json`,
    incomplete: false,
    status: "ERROR",
    exitCode: exitCodeForC1229S5MultiviewStatus("ERROR"),
    diagnostics: {
      schema: C12_29_S5_MULTIVIEW_DIAGNOSTICS_SCHEMA,
      renderer,
      stage,
      timeoutMs,
      page,
      errorName,
      errorMessage,
    },
  };
}

export function validateC1229S5MultiviewFinalArtifact(artifact) {
  const reasons = [];
  let encoded;
  try {
    encoded = stableC1229S5MultiviewJson(artifact);
    artifact = JSON.parse(encoded);
  } catch (error) {
    return { ok: false, reasons: [error.message] };
  }
  if (!boundedPlainJson(artifact)) {
    return { ok: false, reasons: ["artifact is not bounded plain JSON"] };
  }
  if (encoded.length > 4_000_000)
    reasons.push("artifact exceeds 4 MB JSON bound");
  if (artifact?.status === "ERROR") {
    push(
      reasons,
      exactKeys(artifact, [
        "schema",
        "runId",
        "artifactName",
        "incomplete",
        "status",
        "exitCode",
        "diagnostics",
      ]),
      "ERROR artifact keys are not exact",
    );
    push(
      reasons,
      artifact.schema === C12_29_S5_MULTIVIEW_SCHEMA,
      "ERROR schema drift",
    );
    push(reasons, UUID_V4.test(artifact.runId ?? ""), "ERROR runId is invalid");
    push(
      reasons,
      artifact.artifactName === `${artifact.runId}.json`,
      "ERROR artifactName is invalid",
    );
    push(
      reasons,
      artifact.incomplete === false,
      "ERROR artifact is incomplete",
    );
    push(reasons, artifact.exitCode === 2, "ERROR exit code is not 2");
    push(
      reasons,
      validateDiagnostics(artifact.diagnostics),
      "ERROR diagnostics are invalid",
    );
    return { ok: reasons.length === 0, reasons };
  }
  push(reasons, FINAL_STATUS_SET.has(artifact?.status), "status is not final");
  if (
    !exactKeys(artifact, [
      "schema",
      "runId",
      "artifactName",
      "startedAt",
      "completedAt",
      "incomplete",
      "claim",
      "workload",
      "provenance",
      "sessions",
      "crossBackend",
      "cleanup",
      "status",
      "exitCode",
      "reasons",
      "checks",
    ])
  ) {
    return {
      ok: false,
      reasons: [...reasons, "final artifact keys are not exact"],
    };
  }
  const report = Object.fromEntries(
    Object.entries(artifact).filter(
      ([key]) => !new Set(["status", "exitCode", "reasons", "checks"]).has(key),
    ),
  );
  const verdict = foldC1229S5MultiviewGate(report);
  reasons.push(...verdict.structuralReasons);
  push(
    reasons,
    artifact.status === verdict.status,
    "status does not match fold",
  );
  push(
    reasons,
    artifact.exitCode === verdict.exitCode,
    "exitCode does not match fold",
  );
  push(
    reasons,
    exactKeys(artifact.reasons, ["structural", "failures"]) &&
      validateReasonArray(artifact.reasons.structural) &&
      validateReasonArray(artifact.reasons.failures) &&
      jsonEqual(artifact.reasons.structural, verdict.structuralReasons) &&
      jsonEqual(artifact.reasons.failures, verdict.failureReasons),
    "reason ledger does not match fold",
  );
  push(
    reasons,
    jsonEqual(artifact.checks, verdict.checks),
    "check ledger does not match fold",
  );
  return { ok: reasons.length === 0, reasons };
}
