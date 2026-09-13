const F = Math.fround;

const BACKING_WIDTH = 512;
const BACKING_HEIGHT = 512;
const RAY_WIDTH = 256;
const RAY_HEIGHT = 256;
const COLOR_BYTE = 25;
const COLOR_NORMALIZED_F32 = F(COLOR_BYTE / 255);
const F32_UNIT_ROUNDOFF = 2 ** -24;
const GAMMA_70 = (70 * F32_UNIT_ROUNDOFF) / (1 - 70 * F32_UNIT_ROUNDOFF);
const EPSILON_UV = 2 * GAMMA_70;
const MARGIN_UV = 1 / BACKING_WIDTH + EPSILON_UV;

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export const C13_42_GODRAY_FIXTURE = deepFreeze({
  backingWidth: BACKING_WIDTH,
  backingHeight: BACKING_HEIGHT,
  rayWidth: RAY_WIDTH,
  rayHeight: RAY_HEIGHT,
  colorByte: COLOR_BYTE,
  colorBytes: [COLOR_BYTE, COLOR_BYTE, COLOR_BYTE, 255],
  colorNormalizedF32: COLOR_NORMALIZED_F32,
  frustum: { aspectRatio: 1, fov: Math.PI / 3, near: 1, far: 10000 },
  camera: {
    heightAboveMaximumRadius: 1000,
    forward: [1, 0, 0],
    up: [0, 0, 1],
    right: [0, -1, 0],
  },
  sun: {
    uv: [0.75, 0.25],
    distance: 1.5e11,
    horizontalSlope: 0.28867513459481287,
    verticalSlope: 0.28867513459481287,
  },
  config: {
    density: 0.96,
    decay: 0.95,
    weight: 0.5,
    exposure: 0.15,
    sampleCount: 64,
    occlusionFarCutoff: 0.9,
  },
  emitter: {
    u0: 3 / 8,
    u1: 7 / 8,
    v0: 3 / 16,
    v1: 11 / 16,
    frontDistance: 9500,
    thickness: 100,
  },
  occluder: {
    u0: 1 / 2,
    u1: 21 / 32,
    v0: 3 / 8,
    v1: 19 / 32,
    frontDistance: 200,
    thickness: 1,
  },
  controls: {
    "emitter-only": { occluder: false, exposure: 0.15 },
    "far-depth": {
      occluder: true,
      occluderFrontDistance: 9200,
      occluderThickness: 100,
      exposure: 0.15,
    },
    "full-cover": {
      occluder: true,
      useEmitterHull: true,
      occluderFrontDistance: 200,
      occluderThickness: 1,
      exposure: 0.15,
    },
    "exposure-zero": {
      occluder: true,
      occluderFrontDistance: 200,
      occluderThickness: 1,
      exposure: 0,
    },
  },
  rounding: {
    f32UnitRoundoff: F32_UNIT_ROUNDOFF,
    gamma70: GAMMA_70,
    epsilonUV: EPSILON_UV,
    marginUV: MARGIN_UV,
  },
  thresholds: null,
  providerIntegration: {
    status: "STRUCTURAL",
    implemented: false,
    reason: "provider, scene, and browser integration are not implemented",
  },
});

// A counter-clockwise square that contains the whole [0,1] UV square with room
// to spare, so every march tap classifies "inside" rather than "excluded": the
// classifier widens each edge by MARGIN_UV and also tests the four bilinear
// taps, and a hull flush with the UV square would put edge pixels in the
// ambiguous band. Containing the square is the point — the control's premise is
// that EVERY sampled source pixel carries the same value.
const UNIFORM_SKY_HULL = deepFreeze([
  [-1, -1],
  [2, -1],
  [2, 2],
  [-1, 2],
]);

/**
 * The constant-input discriminator from
 * `migration_doc/audits/2026-09-06_CLOUD_WAVE_RAY_ENERGY_SOURCE_NOTES.md`:
 * every sampled source pixel carries the same linear value `C`, depth
 * classifies every sample as sky, and cloud transmittance is exactly one.
 *
 * Under that input the march geometry cancels out — every tap is inside the
 * emitter and unoccluded — so the accumulated ray reduces to
 * `C * exposure * weight * sum(decay^i, i = 0..N-1)`, a quantity that RISES
 * with N. `bankedAdditiveMultipliers` records that quantity per unit `C` at the
 * four sample counts the source notes measured.
 *
 * Those four numbers are the DEFECT being characterised, not a target. They are
 * the BEFORE of C13-45's energy law. A lane whose arithmetic disagrees with them
 * reports a REFUTED premise; it does not edit them to make a spec pass.
 *
 * The banked values are f64 ("direct JavaScript arithmetic", per the notes).
 * `traceF32Ray` accumulates in f32, so it reproduces them to within f32
 * accumulation roundoff and NOT exactly; a consumer states and derives its own
 * tolerance rather than adopting one from here.
 */
export const UNIFORM_SKY_CONTROL = deepFreeze({
  id: "uniform-sky",
  C: COLOR_NORMALIZED_F32,
  emitterHull: UNIFORM_SKY_HULL,
  occluderHull: null,
  depthClass: "sky",
  cloudTransmittance: 1,
  decay: C13_42_GODRAY_FIXTURE.config.decay,
  weight: C13_42_GODRAY_FIXTURE.config.weight,
  exposure: C13_42_GODRAY_FIXTURE.config.exposure,
  bankedAdditiveMultipliers: {
    16: 0.839809997,
    32: 1.2094327733,
    64: 1.4437137912,
    128: 1.4978879085,
  },
  bankedSource:
    "migration_doc/audits/2026-09-06_CLOUD_WAVE_RAY_ENERGY_SOURCE_NOTES.md",
  bankedPrecision: "f64",
});

function finiteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be finite`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function vector3(value, name) {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new TypeError(`${name} must contain three components`);
  }
  return value.map((component, index) =>
    finiteNumber(component, `${name}[${index}]`),
  );
}

function point2(value, name) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some((component) => !Number.isFinite(component))
  ) {
    throw new TypeError(`${name} must be a finite two-component point`);
  }
  return [value[0], value[1]];
}

function add3(left, right) {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]];
}

function subtract3(left, right) {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function scale3(vector, scalar) {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
}

function dot3(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross3(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function magnitude3(vector) {
  return Math.hypot(vector[0], vector[1], vector[2]);
}

function normalize3(vector, name) {
  const magnitude = magnitude3(vector);
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new RangeError(`${name} must be nonzero`);
  }
  return scale3(vector, 1 / magnitude);
}

function validateCamera(camera) {
  if (!camera || typeof camera !== "object") {
    throw new TypeError("camera is required");
  }
  const position = vector3(camera.position, "camera.position");
  const forward = normalize3(
    vector3(camera.forward, "camera.forward"),
    "forward",
  );
  const up = normalize3(vector3(camera.up, "camera.up"), "up");
  const right = normalize3(vector3(camera.right, "camera.right"), "right");
  for (const [name, value] of [
    ["forward/up", dot3(forward, up)],
    ["forward/right", dot3(forward, right)],
    ["up/right", dot3(up, right)],
  ]) {
    if (Math.abs(value) > 1e-12) {
      throw new RangeError(`camera ${name} basis is not orthogonal`);
    }
  }
  const expectedRight = normalize3(cross3(forward, up), "camera handedness");
  if (
    expectedRight.some(
      (component, index) => Math.abs(component - right[index]) > 1e-12,
    )
  ) {
    throw new RangeError("camera basis must be right-handed");
  }
  return { position, forward, up, right };
}

export function createFixtureCamera(maximumRadius) {
  finiteNumber(maximumRadius, "maximumRadius");
  if (maximumRadius <= 0) {
    throw new RangeError("maximumRadius must be positive");
  }
  return deepFreeze({
    position: [
      maximumRadius + C13_42_GODRAY_FIXTURE.camera.heightAboveMaximumRadius,
      0,
      0,
    ],
    forward: [...C13_42_GODRAY_FIXTURE.camera.forward],
    up: [...C13_42_GODRAY_FIXTURE.camera.up],
    right: [...C13_42_GODRAY_FIXTURE.camera.right],
    frustum: { ...C13_42_GODRAY_FIXTURE.frustum },
  });
}

export function createFixtureSunPosition(camera) {
  const basis = validateCamera(camera);
  const sun = C13_42_GODRAY_FIXTURE.sun;
  const direction = normalize3(
    add3(
      add3(basis.forward, scale3(basis.right, sun.horizontalSlope)),
      scale3(basis.up, sun.verticalSlope),
    ),
    "sun direction",
  );
  return deepFreeze(add3(basis.position, scale3(direction, sun.distance)));
}

function validateRectangle(rectangle) {
  if (!rectangle || typeof rectangle !== "object") {
    throw new TypeError("rectangle is required");
  }
  const result = {
    u0: finiteNumber(rectangle.u0, "rectangle.u0"),
    u1: finiteNumber(rectangle.u1, "rectangle.u1"),
    v0: finiteNumber(rectangle.v0, "rectangle.v0"),
    v1: finiteNumber(rectangle.v1, "rectangle.v1"),
  };
  if (
    result.u0 < 0 ||
    result.u1 > 1 ||
    result.v0 < 0 ||
    result.v1 > 1 ||
    result.u0 >= result.u1 ||
    result.v0 >= result.v1
  ) {
    throw new RangeError("rectangle must be ordered inside normalized UV");
  }
  return result;
}

export function createBoxFromProjectedRectangle({
  camera,
  rectangle,
  frontDistance,
  thickness,
}) {
  const basis = validateCamera(camera);
  const rect = validateRectangle(rectangle);
  finiteNumber(frontDistance, "frontDistance");
  finiteNumber(thickness, "thickness");
  const { near, far, fov } = C13_42_GODRAY_FIXTURE.frustum;
  if (
    frontDistance < near ||
    frontDistance + thickness > far ||
    thickness <= 0
  ) {
    throw new RangeError("box must fit inside the fixture frustum");
  }
  const tangent = Math.tan(fov / 2);
  const x0 = frontDistance * tangent * (2 * rect.u0 - 1);
  const x1 = frontDistance * tangent * (2 * rect.u1 - 1);
  const y0 = frontDistance * tangent * (1 - 2 * rect.v1);
  const y1 = frontDistance * tangent * (1 - 2 * rect.v0);
  const width = x1 - x0;
  const height = y1 - y0;
  const center = add3(
    add3(
      add3(basis.position, scale3(basis.right, (x0 + x1) / 2)),
      scale3(basis.up, (y0 + y1) / 2),
    ),
    scale3(basis.forward, frontDistance + thickness / 2),
  );
  const depthAxis = scale3(basis.forward, -1);
  const corners = [];
  for (const xSign of [-1, 1]) {
    for (const ySign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        corners.push(
          add3(
            add3(
              add3(center, scale3(basis.right, (xSign * width) / 2)),
              scale3(basis.up, (ySign * height) / 2),
            ),
            scale3(depthAxis, (zSign * thickness) / 2),
          ),
        );
      }
    }
  }
  return deepFreeze({
    axes: {
      x: basis.right,
      y: basis.up,
      z: depthAxis,
      columns: [basis.right, basis.up, depthAxis],
    },
    center,
    corners,
    width,
    height,
    thickness,
    dimensions: [width, height, thickness],
    frontFaceDistance: frontDistance,
    rectangle: rect,
  });
}

export function projectWorld(camera, world) {
  const basis = validateCamera(camera);
  const point = vector3(world, "world");
  const relative = subtract3(point, basis.position);
  const depth = dot3(relative, basis.forward);
  if (!Number.isFinite(depth) || depth <= 0) {
    throw new RangeError("point must be in front of the camera");
  }
  const tangent = Math.tan(C13_42_GODRAY_FIXTURE.frustum.fov / 2);
  const ndcX = dot3(relative, basis.right) / (depth * tangent);
  const ndcY = dot3(relative, basis.up) / (depth * tangent);
  const x = 0.5 * ndcX + 0.5;
  const y = 0.5 - 0.5 * ndcY;
  return deepFreeze({
    x,
    y,
    uv: [x, y],
    ndc: [ndcX, ndcY],
    depth,
  });
}

function cross2(origin, left, right) {
  return (
    (left[0] - origin[0]) * (right[1] - origin[1]) -
    (left[1] - origin[1]) * (right[0] - origin[0])
  );
}

export function convexHullFromProjectedCorners(corners) {
  if (!Array.isArray(corners) || corners.length < 3) {
    throw new TypeError("at least three projected corners are required");
  }
  const unique = new Map();
  for (const [index, value] of corners.entries()) {
    const point = point2(value, `corners[${index}]`);
    unique.set(`${point[0]}:${point[1]}`, point);
  }
  const points = [...unique.values()].sort(
    (left, right) => left[0] - right[0] || left[1] - right[1],
  );
  if (points.length < 3) {
    throw new RangeError("projected corners must span an area");
  }
  const lower = [];
  for (const point of points) {
    while (
      lower.length >= 2 &&
      cross2(lower.at(-2), lower.at(-1), point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper = [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    while (
      upper.length >= 2 &&
      cross2(upper.at(-2), upper.at(-1), point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  if (hull.length < 3) {
    throw new RangeError("projected corners must form a convex hull");
  }
  return deepFreeze(hull.map((point) => [...point]));
}

function projectedCornerObservations(corners, name) {
  if (!Array.isArray(corners) || corners.length !== 8) {
    throw new TypeError(`${name} must contain exactly eight projected corners`);
  }
  return corners.map((corner, index) => point2(corner, `${name}[${index}]`));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function axisTaps(coordinate, size) {
  const texel = clamp(coordinate, 0, 1) * size - 0.5;
  const low = Math.floor(texel);
  const fraction = texel - low;
  const taps = new Map();
  for (const [index, weight] of [
    [clamp(low, 0, size - 1), 1 - fraction],
    [clamp(low + 1, 0, size - 1), fraction],
  ]) {
    if (weight > 0) {
      taps.set(index, (taps.get(index) ?? 0) + weight);
    }
  }
  return [...taps].map(([index, weight]) => ({ index, weight }));
}

function linearSamplerTexels(uv, width, height) {
  const xTaps = axisTaps(uv[0], width);
  const yTaps = axisTaps(uv[1], height);
  const texels = [];
  for (const y of yTaps) {
    for (const x of xTaps) {
      texels.push({ x: x.index, y: y.index, weight: x.weight * y.weight });
    }
  }
  return texels;
}

export function linearSamplerFootprint(uv, width, height) {
  const point = point2(uv, "uv");
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  const texels = linearSamplerTexels(point, width, height);
  return deepFreeze({
    uv: { x: clamp(point[0], 0, 1), y: clamp(point[1], 0, 1) },
    texels,
  });
}

function validateHull(hull, name) {
  if (!Array.isArray(hull) || hull.length < 3) {
    throw new TypeError(`${name} must contain at least three points`);
  }
  const points = hull.map((point, index) => point2(point, `${name}[${index}]`));
  let area2 = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area2 += current[0] * next[1] - current[1] * next[0];
  }
  if (area2 <= 0) {
    throw new RangeError(`${name} must be counter-clockwise and nondegenerate`);
  }
  return points;
}

function edgeSlackXY(edgeStart, edgeEnd, x, y) {
  const dx = edgeEnd[0] - edgeStart[0];
  const dy = edgeEnd[1] - edgeStart[1];
  return (
    (dx * (y - edgeStart[1]) - dy * (x - edgeStart[0])) /
    (Math.abs(dx) + Math.abs(dy))
  );
}

function classifyProjectedHullSamplePrepared(uv, hull) {
  const qx = clamp(uv[0], 0, 1);
  const qy = clamp(uv[1], 0, 1);
  const texelX = qx * BACKING_WIDTH - 0.5;
  const texelY = qy * BACKING_HEIGHT - 0.5;
  const lowX = Math.floor(texelX);
  const lowY = Math.floor(texelY);
  const fractionX = texelX - lowX;
  const fractionY = texelY - lowY;
  const x0 = clamp(lowX, 0, BACKING_WIDTH - 1);
  const x1 = clamp(lowX + 1, 0, BACKING_WIDTH - 1);
  const y0 = clamp(lowY, 0, BACKING_HEIGHT - 1);
  const y1 = clamp(lowY + 1, 0, BACKING_HEIGHT - 1);
  let safelyInside = true;
  let safelyOutside = false;
  for (let index = 0; index < hull.length; index += 1) {
    const start = hull[index];
    const end = hull[(index + 1) % hull.length];
    const qSlack = edgeSlackXY(start, end, qx, qy);
    if (qSlack <= MARGIN_UV) {
      safelyInside = false;
    }
    let allTapsOutside = qSlack < -MARGIN_UV;
    for (let yIndex = 0; yIndex < 2; yIndex += 1) {
      const yWeight = yIndex === 0 ? 1 - fractionY : fractionY;
      if (yWeight === 0) continue;
      const texelYIndex = yIndex === 0 ? y0 : y1;
      for (let xIndex = 0; xIndex < 2; xIndex += 1) {
        const xWeight = xIndex === 0 ? 1 - fractionX : fractionX;
        if (xWeight === 0) continue;
        const texelXIndex = xIndex === 0 ? x0 : x1;
        const slack = edgeSlackXY(
          start,
          end,
          (texelXIndex + 0.5) / BACKING_WIDTH,
          (texelYIndex + 0.5) / BACKING_HEIGHT,
        );
        if (slack <= 0) {
          safelyInside = false;
        }
        if (slack >= 0) {
          allTapsOutside = false;
        }
      }
    }
    if (allTapsOutside) {
      safelyOutside = true;
    }
  }
  return safelyInside ? "inside" : safelyOutside ? "outside" : "excluded";
}

export function classifyProjectedHullSample(uv, hull) {
  const point = point2(uv, "uv");
  const prepared = validateHull(hull, "hull");
  return classifyProjectedHullSamplePrepared(point, prepared);
}

export function classifyLinearDepth(
  distance,
  far = C13_42_GODRAY_FIXTURE.frustum.far,
  cutoff = C13_42_GODRAY_FIXTURE.config.occlusionFarCutoff,
) {
  finiteNumber(distance, "distance");
  finiteNumber(far, "far");
  finiteNumber(cutoff, "cutoff");
  if (distance < 0 || far <= 0 || cutoff < 0 || cutoff > 1) {
    throw new RangeError("depth arguments are outside the fixture range");
  }
  return distance >= far * cutoff ? "sky" : "occluded";
}

function resolveControl(control, emitterHull, occluderHull) {
  if (control === "near-occluder") {
    if (occluderHull === null) {
      throw new TypeError(
        "near-occluder requires explicit occluder projected corners",
      );
    }
    return {
      occluderHull,
      occluderFrontDistance: C13_42_GODRAY_FIXTURE.occluder.frontDistance,
      exposure: C13_42_GODRAY_FIXTURE.config.exposure,
    };
  }
  const descriptor = C13_42_GODRAY_FIXTURE.controls[control];
  if (!descriptor) {
    throw new RangeError(`unsupported control: ${control}`);
  }
  if (
    descriptor.occluder &&
    !descriptor.useEmitterHull &&
    occluderHull === null
  ) {
    throw new TypeError(
      `${control} requires explicit occluder projected corners`,
    );
  }
  return {
    occluderHull: descriptor.occluder
      ? descriptor.useEmitterHull
        ? emitterHull
        : occluderHull
      : null,
    occluderFrontDistance:
      descriptor.occluderFrontDistance ??
      C13_42_GODRAY_FIXTURE.occluder.frontDistance,
    exposure: descriptor.exposure,
  };
}

function traceF32RayPrepared(
  pixelX,
  pixelY,
  emitterHull,
  occluderHull,
  occluderFrontDistance,
  exposure,
  retainTaps = true,
  sampleCount = C13_42_GODRAY_FIXTURE.config.sampleCount,
) {
  const config = C13_42_GODRAY_FIXTURE.config;
  const px = F((pixelX + 0.5) / RAY_WIDTH);
  const py = F((pixelY + 0.5) / RAY_HEIGHT);
  const sx = F(C13_42_GODRAY_FIXTURE.sun.uv[0]);
  const sy = F(C13_42_GODRAY_FIXTURE.sun.uv[1]);
  const density = F(config.density);
  // The march spans the same `density` fraction of the pixel-to-sun segment for
  // every N, so N subdivides a fixed path instead of extending one. That is why
  // N is a quality control in GEOMETRY, and why the accumulation below still
  // makes it a brightness control in ENERGY — the defect C13-45 characterises.
  const scale = F(density / F(sampleCount));
  const dx = F(F(sx - px) * scale);
  const dy = F(F(sy - py) * scale);
  const blockingOccluder =
    occluderHull !== null &&
    classifyLinearDepth(occluderFrontDistance) !== "sky";
  const taps = [];
  let qx = px;
  let qy = py;
  let illumDecay = F(1);
  let baseline = F(0);
  let main = F(0);
  let excluded = false;
  let affected = false;
  for (let index = 0; index < sampleCount; index += 1) {
    qx = F(qx + dx);
    qy = F(qy + dy);
    const emitter = classifyProjectedHullSamplePrepared([qx, qy], emitterHull);
    const occluder = blockingOccluder
      ? classifyProjectedHullSamplePrepared([qx, qy], occluderHull)
      : "outside";
    const tapExcluded = emitter === "excluded" || occluder === "excluded";
    const sourceInside = emitter === "inside";
    const baselineIsSky = true;
    const mainIsSky = occluder !== "inside";
    excluded ||= tapExcluded;
    affected ||= sourceInside && occluder === "inside";
    const baselineSample = F(
      F(COLOR_NORMALIZED_F32 * Number(sourceInside && baselineIsSky)) * F(1),
    );
    const mainSample = F(
      F(COLOR_NORMALIZED_F32 * Number(sourceInside && mainIsSky)) * F(1),
    );
    const gain = F(F(config.weight) * illumDecay);
    baseline = F(baseline + F(baselineSample * gain));
    main = F(main + F(mainSample * gain));
    if (retainTaps) {
      taps.push({
        index: index + 1,
        uv: { x: qx, y: qy },
        emitter,
        occluder,
        isSky: mainIsSky,
        baselineIsSky,
      });
    }
    illumDecay = F(illumDecay * F(config.decay));
  }
  const baselineOut = F(baseline * F(exposure));
  const mainOut = F(main * F(exposure));
  return {
    status: excluded ? "excluded" : "analytic",
    excluded,
    affected,
    taps,
    diagnostics: excluded
      ? null
      : {
          baseline: baselineOut,
          main: mainOut,
          deficit: baselineOut - mainOut,
        },
  };
}

export function traceF32Ray(
  pixelX,
  pixelY,
  {
    emitterHull,
    occluderHull = null,
    occluderFrontDistance = C13_42_GODRAY_FIXTURE.occluder.frontDistance,
    exposure = C13_42_GODRAY_FIXTURE.config.exposure,
    sampleCount = C13_42_GODRAY_FIXTURE.config.sampleCount,
  } = {},
) {
  if (!Number.isInteger(pixelX) || pixelX < 0 || pixelX >= RAY_WIDTH) {
    throw new RangeError("pixelX is outside the ray target");
  }
  if (!Number.isInteger(pixelY) || pixelY < 0 || pixelY >= RAY_HEIGHT) {
    throw new RangeError("pixelY is outside the ray target");
  }
  const emitter = validateHull(emitterHull, "emitterHull");
  const occluder =
    occluderHull === null ? null : validateHull(occluderHull, "occluderHull");
  finiteNumber(occluderFrontDistance, "occluderFrontDistance");
  finiteNumber(exposure, "exposure");
  if (exposure < 0) {
    throw new RangeError("exposure must be nonnegative");
  }
  positiveInteger(sampleCount, "sampleCount");
  return traceF32RayPrepared(
    pixelX,
    pixelY,
    emitter,
    occluder,
    occluderFrontDistance,
    exposure,
    true,
    sampleCount,
  );
}

export function refuseF16Amplitude() {
  throw new RangeError(
    "f16 amplitude requires a separately identified binary16 emulator",
  );
}

function interpolateHalf(values, footprint) {
  let result = F(0);
  for (const tap of footprint.texels) {
    const value = values[tap.y * RAY_WIDTH + tap.x];
    result = F(result + F(value * F(tap.weight)));
  }
  return result;
}

export function deriveFixtureMasks({
  emitterProjectedCorners,
  occluderProjectedCorners = null,
  control = "near-occluder",
  backingWidth = BACKING_WIDTH,
  backingHeight = BACKING_HEIGHT,
  amplitudeFormat = "f32",
  sampleCount = C13_42_GODRAY_FIXTURE.config.sampleCount,
} = {}) {
  if (backingWidth !== BACKING_WIDTH || backingHeight !== BACKING_HEIGHT) {
    throw new RangeError("the fixture requires a 512 by 512 backing buffer");
  }
  positiveInteger(sampleCount, "sampleCount");
  if (amplitudeFormat === "f16") {
    refuseF16Amplitude();
  }
  if (amplitudeFormat !== "f32" && amplitudeFormat !== "geometry-only") {
    throw new RangeError("amplitudeFormat must be f32 or geometry-only");
  }
  const emitterHull = convexHullFromProjectedCorners(
    projectedCornerObservations(
      emitterProjectedCorners,
      "emitterProjectedCorners",
    ),
  );
  const suppliedOccluderHull =
    occluderProjectedCorners === null
      ? null
      : convexHullFromProjectedCorners(
          projectedCornerObservations(
            occluderProjectedCorners,
            "occluderProjectedCorners",
          ),
        );
  const resolved = resolveControl(control, emitterHull, suppliedOccluderHull);
  if (resolved.occluderHull === undefined) {
    throw new TypeError(
      `${control} requires explicit occluder projected corners`,
    );
  }
  const halfLength = RAY_WIDTH * RAY_HEIGHT;
  const affectedHalf = new Uint8Array(halfLength);
  const excludedHalf = new Uint8Array(halfLength);
  const baselineHalf =
    amplitudeFormat === "f32" ? new Float32Array(halfLength) : null;
  const mainHalf =
    amplitudeFormat === "f32" ? new Float32Array(halfLength) : null;
  const deficitHalf =
    amplitudeFormat === "f32" ? new Float32Array(halfLength) : null;
  for (let y = 0; y < RAY_HEIGHT; y += 1) {
    for (let x = 0; x < RAY_WIDTH; x += 1) {
      const offset = y * RAY_WIDTH + x;
      const trace = traceF32RayPrepared(
        x,
        y,
        emitterHull,
        resolved.occluderHull,
        resolved.occluderFrontDistance,
        resolved.exposure,
        false,
        sampleCount,
      );
      affectedHalf[offset] = Number(trace.affected);
      excludedHalf[offset] = Number(trace.excluded);
      if (trace.diagnostics !== null && baselineHalf !== null) {
        baselineHalf[offset] = trace.diagnostics.baseline;
        mainHalf[offset] = trace.diagnostics.main;
        deficitHalf[offset] = trace.diagnostics.deficit;
      }
    }
  }
  const fullLength = BACKING_WIDTH * BACKING_HEIGHT;
  const fullSupport = new Uint8Array(fullLength);
  const fullZero = new Uint8Array(fullLength);
  const fullExcluded = new Uint8Array(fullLength);
  const fullDeficit =
    amplitudeFormat === "f32" ? new Float32Array(fullLength) : null;
  for (let y = 0; y < BACKING_HEIGHT; y += 1) {
    for (let x = 0; x < BACKING_WIDTH; x += 1) {
      const offset = y * BACKING_WIDTH + x;
      const uv = [(x + 0.5) / BACKING_WIDTH, (y + 0.5) / BACKING_HEIGHT];
      const texels = linearSamplerTexels(uv, RAY_WIDTH, RAY_HEIGHT);
      const excluded = texels.some(
        (tap) => excludedHalf[tap.y * RAY_WIDTH + tap.x] !== 0,
      );
      fullExcluded[offset] = Number(excluded);
      if (excluded) {
        continue;
      }
      const support = texels.some(
        (tap) => affectedHalf[tap.y * RAY_WIDTH + tap.x] !== 0,
      );
      let deficit = resolved.exposure === 0 ? 0 : Number(support);
      if (deficitHalf !== null) {
        deficit = interpolateHalf(deficitHalf, { texels });
        fullDeficit[offset] = deficit;
      }
      fullSupport[offset] = Number(deficit > 0);
      fullZero[offset] = Number(deficit === 0);
    }
  }
  return {
    status: "analytic-only",
    control,
    sampleCount,
    rayWidth: RAY_WIDTH,
    rayHeight: RAY_HEIGHT,
    affectedHalf,
    excludedHalf,
    baselineHalf,
    mainHalf,
    deficitHalf,
    fullSupport,
    fullZero,
    fullExcluded,
    fullDeficit,
    emitterHull,
    occluderHull: resolved.occluderHull,
    thresholds: null,
    providerIntegration: C13_42_GODRAY_FIXTURE.providerIntegration,
  };
}

// ---------------------------------------------------------------------------
// Capture-side geometry (C13-42f).
//
// `deriveFixtureMasks` above is the ANALYTIC fixture: it refuses any backing
// buffer that is not 512 by 512 (`backingWidth !== BACKING_WIDTH` throws), it
// marches its own synthetic emitter/occluder boxes, and it publishes
// `fullSupport` / `fullZero` / `fullExcluded` / `fullDeficit`. None of that is
// what `analyzeGodRayImages` consumes: that function requires six masks named
// `valid`, `emitter`, `occluder`, `ground`, `behindCamera` and `border`, each
// exactly `onImage.width * onImage.height` long
// (`c13-42-reproduction-contract.mjs:1416-1426`), and the C13-42 probe's
// captures are the browser's own canvas — 1600 by 800 in four of the six banked
// 2026-09-09 runs, 571 by 383 in a fifth, and no PNG at all from the sixth;
// none of them 512 by 512. So the fixture's masks cannot be handed to the
// probe's cell construction: wrong vocabulary, wrong resolution, wrong scene.
//
// These functions are the capture-side counterpart. They derive the six masks
// `analyzeGodRayImages` actually asks for from the only god-ray geometry the
// running page publishes — the effect's realized `sunScreenU` / `sunScreenV`
// and its sun-usable determination — plus the capture's own dimensions.
// ---------------------------------------------------------------------------

/**
 * The outermost texel ring of a capture. A linear sampler at the outermost
 * texel centre has its neighbour taps clamped (`axisTaps` above clamps to
 * `[0, size - 1]`), so the value there is not a pure function of the scene.
 * That is a property of the sampler, not a tuned margin, which is why it is 1
 * and not a number someone picked.
 */
export const CAPTURE_BORDER_TEXELS = 1;

/**
 * Convert the god-ray effect's screen UV to capture pixel coordinates.
 *
 * The convention is the shader's, read at the source rather than assumed:
 * `GodRayGenerate.wgsl:148` builds the fullscreen-triangle varying as
 * `out.uv = vec2<f32>((x + 1.0) * 0.5, (1.0 - y) * 0.5)` with `y` in NDC, so
 * `uv.y == 0` is the TOP of the frame. A PNG's rows run top-down too, and
 * `analyzeGodRayImages` indexes pixels as `y = floor(index / width)`, so
 * `y = v * height` needs no flip.
 *
 * The sun may legitimately project outside `[0,1]` — `setSunScreenUV`'s own
 * documentation says an off-screen but in-front sun still drives a directional
 * glow — so a UV outside the frame is reported, not refused.
 *
 * @param {{sunScreenU: number, sunScreenV: number, width: number, height: number}} input
 * @returns {{x: number, y: number, insideFrame: boolean}} Pixel-space emitter.
 */
export function projectedEmitterPixels({
  sunScreenU,
  sunScreenV,
  width,
  height,
} = {}) {
  finiteNumber(sunScreenU, "sunScreenU");
  finiteNumber(sunScreenV, "sunScreenV");
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  const x = sunScreenU * width;
  const y = sunScreenV * height;
  return deepFreeze({
    x,
    y,
    insideFrame: x >= 0 && x <= width && y >= 0 && y <= height,
  });
}

function validateCaptureMask(mask, name, pixels) {
  if (mask === null || mask === undefined) return null;
  if (typeof mask.length !== "number" || mask.length !== pixels) {
    throw new RangeError(`${name} must cover exactly ${pixels} pixels`);
  }
  const copy = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    copy[index] = mask[index] ? 1 : 0;
  }
  return copy;
}

/**
 * Build the six masks `analyzeGodRayImages` requires, at capture resolution.
 *
 * What each mask means here, and where its content comes from:
 *
 * - `border` — the outermost `borderTexels` ring (see `CAPTURE_BORDER_TEXELS`).
 * - `valid` — EVERY captured pixel, border included. `analyzeGodRayImages`
 *   skips a pixel outside `valid` before it attributes any leakage
 *   (`if (!maskAt(masks.valid, …)) continue;`), so a `valid` that excluded the
 *   border ring would make `leakageEnergy.border` structurally zero — the one
 *   figure the border mask exists to produce. Nothing on a capture is
 *   unmeasurable; the ring is MARKED by `border`, not removed from the metric.
 * - `emitter` — the texels the shaft origin itself reads: the projected
 *   emitter's own bilinear sampler footprint, via `linearSamplerFootprint`, so
 *   the mask is the sampler's, not a disc of chosen radius. Empty when the sun
 *   projects outside the frame, which is a legal state.
 * - `behindCamera` — whole-frame. When the caller's sun-usable determination is
 *   false (`WebGPUGodRayEffect.setSunScreenUV`'s `usable`, false when the sun is
 *   behind the camera, non-finite, or grazing), NO pixel of the frame carries a
 *   sun-derived shaft, so the mask is all ones and every positive delta is
 *   attributed to that.
 * - `ground`, `occluder` — NOT derivable from a capture plus a sun UV. They are
 *   scene-geometry regions, and nothing the page publishes today identifies
 *   them per pixel. They are filled with zeros ONLY when the caller supplies
 *   nothing, and every such mask is named in `provenance.structurallyEmpty` so
 *   a receipt can never be read as "occluder leakage measured zero" when the
 *   truth is "no occluder region was identified". This is the named gap
 *   (Principle 9), not a silent one: supplying real masks here is the next
 *   concrete step for occluder/ground leakage, and until it lands those two
 *   leakage figures are structurally zero and must not be thresholded.
 *
 * @param {object} input
 * @param {number} input.width Capture width in pixels.
 * @param {number} input.height Capture height in pixels.
 * @param {{x: number, y: number}} input.emitter Projected emitter, pixel space.
 * @param {boolean} input.sunUsable The caller's sun-usable determination.
 * @param {number} [input.borderTexels] Ring width; defaults to the sampler's 1.
 * @param {ArrayLike<number>} [input.groundMask] Per-pixel ground region, if known.
 * @param {ArrayLike<number>} [input.occluderMask] Per-pixel occluder region, if known.
 * @returns {object} `{width, height, pixels, masks, provenance}`.
 */
export function deriveGodRayCaptureMasks({
  width,
  height,
  emitter,
  sunUsable = true,
  borderTexels = CAPTURE_BORDER_TEXELS,
  groundMask = null,
  occluderMask = null,
} = {}) {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  if (!Number.isInteger(borderTexels) || borderTexels < 0) {
    throw new RangeError("borderTexels must be a nonnegative integer");
  }
  if (2 * borderTexels >= Math.min(width, height)) {
    throw new RangeError("borderTexels would leave no valid region");
  }
  if (typeof sunUsable !== "boolean") {
    throw new TypeError("sunUsable must be a boolean determination");
  }
  const point = point2([emitter?.x, emitter?.y], "emitter");
  const pixels = width * height;
  const valid = new Uint8Array(pixels);
  const border = new Uint8Array(pixels);
  const emitterMask = new Uint8Array(pixels);
  const behindCamera = new Uint8Array(pixels);
  if (!sunUsable) behindCamera.fill(1);
  valid.fill(1);
  let borderPixels = 0;
  for (let y = 0; y < height; y += 1) {
    const edgeRow = y < borderTexels || y >= height - borderTexels;
    for (let x = 0; x < width; x += 1) {
      const edge = edgeRow || x < borderTexels || x >= width - borderTexels;
      if (edge) {
        border[y * width + x] = 1;
        borderPixels += 1;
      }
    }
  }
  let emitterTexels = 0;
  const emitterInsideFrame =
    point[0] >= 0 && point[0] <= width && point[1] >= 0 && point[1] <= height;
  if (emitterInsideFrame) {
    const footprint = linearSamplerFootprint(
      [point[0] / width, point[1] / height],
      width,
      height,
    );
    for (const tap of footprint.texels) {
      const offset = tap.y * width + tap.x;
      if (emitterMask[offset] === 0) {
        emitterMask[offset] = 1;
        emitterTexels += 1;
      }
    }
  }
  const ground = validateCaptureMask(groundMask, "groundMask", pixels);
  const occluder = validateCaptureMask(occluderMask, "occluderMask", pixels);
  const structurallyEmpty = [];
  if (ground === null) structurallyEmpty.push("ground");
  if (occluder === null) structurallyEmpty.push("occluder");
  return {
    width,
    height,
    pixels,
    masks: {
      valid,
      emitter: emitterMask,
      occluder: occluder ?? new Uint8Array(pixels),
      ground: ground ?? new Uint8Array(pixels),
      behindCamera,
      border,
    },
    provenance: deepFreeze({
      borderTexels,
      borderPixels,
      borderSource:
        "the outermost texel ring, where the linear sampler's neighbour taps are clamped",
      validPixels: pixels,
      validSource:
        "every captured pixel; the border ring is marked, not excluded, so its leakage stays measurable",
      emitterTexels,
      emitterInsideFrame,
      emitterSource: "the projected emitter's bilinear sampler footprint",
      sunUsable,
      behindCameraSource: sunUsable
        ? "the caller reported a usable sun, so no pixel is attributed to a behind-camera sun"
        : "the caller reported an unusable sun, so the whole frame is attributed to it",
      structurallyEmpty,
      structurallyEmptyReason:
        structurallyEmpty.length === 0
          ? null
          : "no per-pixel scene-geometry region is published by the page, so these leakage figures are structurally zero and must not be thresholded",
    }),
  };
}

/**
 * The shaft direction `analyzeGodRayImages` should be measured against.
 *
 * That function reduces the positive OFF-to-ON delta to an energy-weighted
 * circular mean of `atan2(y - emitter.y, x - emitter.x)` over the valid region,
 * then reports `angularDistance(meanAngle, expectedDirectionRadians)`. The
 * expectation must therefore be the SAME estimator evaluated on the same
 * geometry with the energy held uniform: where the circular mean would sit if
 * the shaft energy were spread evenly over every valid pixel. Anything else
 * compares two different estimators and calls the difference an error.
 *
 * Nothing here is tuned. The only refusal is structural: when the resultant
 * vector is exactly zero the mean bearing does not exist (`Math.atan2(0, 0)`
 * returns a finite 0 that means nothing), so the direction is reported as
 * unresolvable and the caller must supply no god-ray geometry at all rather
 * than publish a number with no content.
 *
 * `conditioning` is the resultant length in `[0, 1]`: 1 when every valid pixel
 * lies on one bearing from the emitter, approaching 0 as the valid region
 * surrounds the emitter symmetrically and the mean stops carrying direction. No
 * floor is imposed on it here — like every other C13-42 threshold it is OWED to
 * the first calibration runs (`CHARACTERIZATION_THRESHOLD_DERIVATION`), so it is
 * published for that derivation instead of being invented now.
 *
 * @param {object} input
 * @param {number} input.width Capture width in pixels.
 * @param {number} input.height Capture height in pixels.
 * @param {{x: number, y: number}} input.emitter Projected emitter, pixel space.
 * @param {ArrayLike<number>} [input.valid] Valid mask; defaults to every pixel.
 * @returns {{resolvable: boolean, radians: number|null, conditioning: number,
 *   validPixels: number, reason: string|null}} The expectation.
 */
export function expectedShaftDirectionRadians({
  width,
  height,
  emitter,
  valid = null,
} = {}) {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  const point = point2([emitter?.x, emitter?.y], "emitter");
  const pixels = width * height;
  if (valid !== null && valid.length !== pixels) {
    throw new RangeError(`valid must cover exactly ${pixels} pixels`);
  }
  let sumCos = 0;
  let sumSin = 0;
  let validPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * width + x;
      if (valid !== null && !valid[offset]) continue;
      const dx = x - point[0];
      const dy = y - point[1];
      if (dx === 0 && dy === 0) continue;
      const inverseRadius = 1 / Math.hypot(dx, dy);
      sumCos += dx * inverseRadius;
      sumSin += dy * inverseRadius;
      validPixels += 1;
    }
  }
  if (validPixels === 0) {
    return deepFreeze({
      resolvable: false,
      radians: null,
      conditioning: 0,
      validPixels: 0,
      reason: "the valid region carries no pixel away from the emitter",
    });
  }
  const resultant = Math.hypot(sumCos, sumSin);
  if (resultant === 0) {
    return deepFreeze({
      resolvable: false,
      radians: null,
      conditioning: 0,
      validPixels,
      reason:
        "the valid region surrounds the emitter symmetrically, so no mean bearing exists",
    });
  }
  return deepFreeze({
    resolvable: true,
    radians: Math.atan2(sumSin, sumCos),
    conditioning: resultant / validPixels,
    validPixels,
    reason: null,
  });
}
