/**
 * Pure acceptance policy for C12-29 S4 (orbital-sunrise limb glow).
 *
 * The browser driver owns capture, decoding, provenance, and evidence
 * publication. This module owns only immutable constants and deterministic
 * verdict arithmetic so every browser-dependent premise can be attacked by a
 * Node test without launching a browser.
 */

export const C12_29_S4_SCHEMA = "c12-29-s4-orbital-sunrise-evidence-v1";

export const C12_29_S4_RENDERERS = Object.freeze(["webgl", "webgpu"]);

export const C12_29_S4_CAPTURE_METHOD =
  "scene.canvas.toDataURL(image/png)-same-task";

export const C12_29_S4_SAMPLE_OFFSETS_SECONDS = Object.freeze(
  Array.from({ length: 181 }, (_, index) => index - 90),
);

export const C12_29_S4_TANGENT_ANCHORS_KM = Object.freeze([
  60, 40, 25, 15, 10, 0,
]);

export const C12_29_S4_NORMAL_ANCHORS_KM = Object.freeze([
  -20, 0, 10, 25, 60, 120, 200,
]);

export const C12_29_S4_HIDDEN_ANCHORS_KM = Object.freeze([
  60,
  40,
  25,
  15,
  10,
  0,
  "clear",
]);

export const C12_29_S4_ORBIT = Object.freeze({
  epochIso: "2026-06-21T12:00:00.000Z",
  innerRadiusMeters: 6_378_137,
  altitudeMeters: 400_000,
  atmosphereShellMeters: 111_000,
  gravitationalParameter: 3.986004418e14,
  durationSeconds: 180,
  stepSeconds: 1,
});

export const C12_29_S4_ATMOSPHERE = Object.freeze({
  rayleighCoefficient: Object.freeze([5.5e-6, 13e-6, 28.4e-6]),
  mieCoefficient: Object.freeze([21e-6, 21e-6, 21e-6]),
  rayleighScaleHeight: 10_000,
  mieScaleHeight: 3_200,
});

export const C12_29_S4_VIEWPORT = Object.freeze({ width: 960, height: 540 });

export const C12_29_S4_NEUTRAL_SCENE = Object.freeze({
  mode: 3,
  globeShown: false,
  skyAtmosphereShown: true,
  skyAtmosphereVisible: true,
  // WebGPU's sky renderer resolves a numeric zero through its legacy
  // `value || 50.0` fallback. Keep the neutral destination positive but far
  // below one 8-bit code so both backends exercise the live atmosphere path
  // while the sun-hidden captures independently prove the canvas stays black.
  atmosphereLightIntensity: 1e-12,
  skyBoxShown: false,
  starFieldShown: false,
  moonShown: false,
  sunShown: true,
  backgroundRgba: Object.freeze([0, 0, 0, 1]),
  highDynamicRange: false,
  sunBloom: false,
  taaEnabled: false,
  motionBlur: false,
  fxaaEnabled: false,
  bloomEnabled: false,
  ambientOcclusionEnabled: false,
  allPostProcessStagesDisabled: true,
  msaaSamples: 1,
  cameraFovRadians: Math.PI / 30,
  enableEclipse: false,
  canvasWidth: C12_29_S4_VIEWPORT.width,
  canvasHeight: C12_29_S4_VIEWPORT.height,
});

export const C12_29_S4_BANDS = Object.freeze({
  tangentAnchorMaximumErrorKm: 2.0,
  minimumTangentHeightKm: -20.0,
  maximumTangentHeightKm: 180.0,
  clearIdentityMinimumHeightKm: 115.0,
  sourceMonotonicTolerance: 1e-12,
  sourceParityTolerance: 1e-12,
  sourceReferenceTolerance: 1e-12,
  reddeningAt25KmMinimum: 3.0,
  reddeningAt10KmMinimum: 100.0,
  renderedMonotonicDropFraction: 0.02,
  renderedMaximumStepFraction: 0.1,
  renderedParityFraction: 0.05,
  minimumTransitionSeconds: 5.0,
  maximumTransitionSeconds: 90.0,
  transitionLowFraction: 0.02,
  transitionHighFraction: 0.98,
  minimumClearLinearEnergy: 1.0,
  minimumClearChannelLinearEnergy: 0.25,
  minimumClearNonBlackPixels: 64,
  renderedReddeningAt25KmMinimum: 2.0,
  renderedReddeningAt10KmMinimum: 10.0,
  renderedColorFloorFraction: 1e-6,
  renderedColorRatioReversalFraction: 0.1,
  minimumRenderedColorSamples: 20,
  hiddenMaximumCode: 1,
  hiddenMaximumNonBlackPixels: 16,
  minimumParitySamples: 8,
  minimumChannelSupportPixels: 64,
  minimumChannelParitySamples: 8,
  minimumLuminanceParitySamples: 8,
  orbitRadiusToleranceMeters: 1e-4,
  orbitPositionToleranceMeters: 1e-3,
  orbitPhaseToleranceRadians: 1e-10,
  tangentRecomputeToleranceKm: 1e-8,
  unitVectorTolerance: 1e-10,
  orthogonalityTolerance: 1e-10,
  atmosphereTolerance: 1e-15,
  renderedSourceLogRatioTolerance: 1.25,
});

const INDEPENDENT_EXTINCTION_STEPS = 16;

/**
 * Independent scalar port of the shipped midpoint extinction integration.
 * The browser records every scalar premise; this policy recomputes the
 * expected value without trusting frameState.sunAtmosphereExtinction.
 */
export function computeIndependentExtinction(input) {
  const camera = input?.cameraPositionWC;
  const body = input?.bodyPositionWC;
  const atmosphere = input?.atmosphere;
  const rayleigh = atmosphere?.rayleighCoefficient;
  const mie = atmosphere?.mieCoefficient;
  const innerRadius = input?.innerRadius;
  if (
    !finiteVector(camera, 3) ||
    !finiteVector(body, 3) ||
    !finiteVector(rayleigh, 3) ||
    !finiteVector(mie, 3) ||
    !finite(atmosphere?.rayleighScaleHeight) ||
    atmosphere.rayleighScaleHeight <= 0 ||
    !finite(atmosphere?.mieScaleHeight) ||
    atmosphere.mieScaleHeight <= 0 ||
    !finite(innerRadius) ||
    innerRadius <= 0
  ) {
    return null;
  }

  const direction = body.map((value, index) => value - camera[index]);
  const bodyDistance = Math.hypot(...direction);
  if (!(bodyDistance > 0)) {
    return [1, 1, 1];
  }
  for (let index = 0; index < 3; index++) {
    direction[index] /= bodyDistance;
  }
  const outerRadius = innerRadius + 111_000;
  const b =
    2 * camera.reduce((sum, value, index) => sum + value * direction[index], 0);
  const cameraRadiusSq = camera.reduce((sum, value) => sum + value * value, 0);
  const c = cameraRadiusSq - outerRadius * outerRadius;
  const discriminant = b * b - 4 * c;
  if (discriminant <= 0) {
    return [1, 1, 1];
  }
  const root = Math.sqrt(discriminant);
  const entry = Math.max((-b - root) * 0.5, 0);
  const exit = Math.min((-b + root) * 0.5, bodyDistance);
  if (exit <= entry) {
    return [1, 1, 1];
  }

  const stepLength = (exit - entry) / INDEPENDENT_EXTINCTION_STEPS;
  let rayleighDepth = 0;
  let mieDepth = 0;
  for (let step = 0; step < INDEPENDENT_EXTINCTION_STEPS; step++) {
    const distance = entry + (step + 0.5) * stepLength;
    const position = camera.map(
      (value, index) => value + direction[index] * distance,
    );
    const height = Math.max(Math.hypot(...position) - innerRadius, 0);
    rayleighDepth +=
      Math.exp(-height / atmosphere.rayleighScaleHeight) * stepLength;
    mieDepth += Math.exp(-height / atmosphere.mieScaleHeight) * stepLength;
  }
  return rayleigh.map((coefficient, channel) =>
    Math.exp(-(coefficient * rayleighDepth + mie[channel] * mieDepth)),
  );
}

export function isUuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value ?? "",
  );
}

export function sameEvidenceFingerprint(left, right) {
  if (left?.exists === true && right?.exists === true) {
    return left.byteLength === right.byteLength && left.sha256 === right.sha256;
  }
  return (
    left?.exists === false &&
    left.error === "ENOENT" &&
    right?.exists === false &&
    right.error === "ENOENT"
  );
}

export function exitCodeForS4Status(status) {
  if (status === "PASS") {
    return 0;
  }
  if (status === "FAIL") {
    return 1;
  }
  if (status === "ERROR") {
    return 2;
  }
  if (status === "STRUCTURAL") {
    return 3;
  }
  throw new Error(`unknown S4 evidence status ${String(status)}`);
}

export function validateS4FinalArtifactShape(artifact) {
  const reasons = [];
  if (artifact?.schema !== C12_29_S4_SCHEMA) {
    reasons.push("artifact schema is not the frozen S4 schema");
  }
  if (!isUuidV4(artifact?.runId)) {
    reasons.push("artifact runId is not an immutable UUID v4 identity");
  }
  if (!new Set(["PASS", "FAIL", "STRUCTURAL", "ERROR"]).has(artifact?.status)) {
    reasons.push("artifact status is not final");
  }
  if (artifact?.incomplete !== false) {
    reasons.push("final artifact must set incomplete=false");
  }
  try {
    if (artifact?.exitCode !== exitCodeForS4Status(artifact?.status)) {
      reasons.push("artifact exitCode disagrees with its final status");
    }
  } catch (error) {
    reasons.push(error.message);
  }
  return { ok: reasons.length === 0, reasons };
}

function finite(value) {
  return Number.isFinite(value);
}

function finiteVector(value, length) {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((component) => finite(component))
  );
}

function approximately(left, right, tolerance) {
  return finite(left) && finite(right) && Math.abs(left - right) <= tolerance;
}

function vectorLength(value) {
  return Math.hypot(...value);
}

function normalized(value) {
  const length = vectorLength(value);
  return length > 0 ? value.map((component) => component / length) : null;
}

function dot(left, right) {
  return left.reduce(
    (sum, component, index) => sum + component * right[index],
    0,
  );
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function maximumVectorDelta(left, right) {
  return Math.max(
    ...left.map((component, index) => Math.abs(component - right[index])),
  );
}

function expectedIsoAtOffset(offsetSeconds) {
  return new Date(
    Date.parse(C12_29_S4_ORBIT.epochIso) + offsetSeconds * 1000,
  ).toISOString();
}

function exactAtmosphere(atmosphere) {
  return (
    finiteVector(atmosphere?.rayleighCoefficient, 3) &&
    finiteVector(atmosphere?.mieCoefficient, 3) &&
    atmosphere.rayleighCoefficient.every((value, index) =>
      approximately(
        value,
        C12_29_S4_ATMOSPHERE.rayleighCoefficient[index],
        C12_29_S4_BANDS.atmosphereTolerance,
      ),
    ) &&
    atmosphere.mieCoefficient.every((value, index) =>
      approximately(
        value,
        C12_29_S4_ATMOSPHERE.mieCoefficient[index],
        C12_29_S4_BANDS.atmosphereTolerance,
      ),
    ) &&
    atmosphere.rayleighScaleHeight ===
      C12_29_S4_ATMOSPHERE.rayleighScaleHeight &&
    atmosphere.mieScaleHeight === C12_29_S4_ATMOSPHERE.mieScaleHeight
  );
}

function validOrbitBasis(basis) {
  const sun = basis?.sunDirectionWC;
  const tangent = basis?.tangentAxisWC;
  const up = basis?.upAxisWC;
  if (
    !finiteVector(sun, 3) ||
    !finiteVector(tangent, 3) ||
    !finiteVector(up, 3)
  ) {
    return false;
  }
  const tolerance = C12_29_S4_BANDS.unitVectorTolerance;
  return (
    approximately(vectorLength(sun), 1, tolerance) &&
    approximately(vectorLength(tangent), 1, tolerance) &&
    approximately(vectorLength(up), 1, tolerance) &&
    Math.abs(dot(sun, tangent)) <= tolerance &&
    Math.abs(dot(sun, up)) <= tolerance &&
    Math.abs(dot(tangent, up)) <= tolerance &&
    maximumVectorDelta(normalized(cross(sun, tangent)), up) <= tolerance
  );
}

function exactNeutralSceneContract(contract) {
  const exact = {
    epochIso: C12_29_S4_ORBIT.epochIso,
    innerRadiusMeters: C12_29_S4_ORBIT.innerRadiusMeters,
    orbitAltitudeMeters: C12_29_S4_ORBIT.altitudeMeters,
    atmosphereShellMeters: C12_29_S4_ORBIT.atmosphereShellMeters,
    gravitationalParameter: C12_29_S4_ORBIT.gravitationalParameter,
    durationSeconds: C12_29_S4_ORBIT.durationSeconds,
    stepSeconds: C12_29_S4_ORBIT.stepSeconds,
    ...C12_29_S4_NEUTRAL_SCENE,
  };
  return (
    Object.entries(exact).every(([key, value]) => {
      if (Array.isArray(value)) {
        return (
          Array.isArray(contract?.[key]) &&
          contract[key].length === value.length &&
          contract[key].every((entry, index) => entry === value[index])
        );
      }
      return contract?.[key] === value;
    }) && validOrbitBasis(contract?.orbitBasis)
  );
}

function exactNeutralSnapshot(snapshot, sunShown) {
  const expected = { ...C12_29_S4_NEUTRAL_SCENE, sunShown };
  return Object.entries(expected).every(([key, value]) => {
    if (key === "cameraFovRadians") {
      return approximately(snapshot?.[key], value, 1e-14);
    }
    if (Array.isArray(value)) {
      return (
        Array.isArray(snapshot?.[key]) &&
        snapshot[key].length === value.length &&
        snapshot[key].every((entry, index) => entry === value[index])
      );
    }
    return snapshot?.[key] === value;
  });
}

function validDecodedImage(image) {
  if (
    image?.width !== C12_29_S4_VIEWPORT.width ||
    image?.height !== C12_29_S4_VIEWPORT.height ||
    !Number.isInteger(image?.pngByteLength) ||
    image.pngByteLength <= 64 ||
    !/^[0-9a-f]{64}$/u.test(image?.pngSha256 ?? "") ||
    !Number.isInteger(image?.nonBlackPixels) ||
    image.nonBlackPixels < 0 ||
    !Number.isInteger(image?.maxCode) ||
    image.maxCode < 0 ||
    image.maxCode > 255 ||
    !finiteVector(image?.maxCodeByChannel, 3) ||
    !image.maxCodeByChannel.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    ) ||
    !finiteVector(image?.aboveFloorPixelsByChannel, 3) ||
    !image.aboveFloorPixelsByChannel.every(
      (value) => Number.isInteger(value) && value >= 0,
    ) ||
    image?.minimumAlphaCode !== 255 ||
    image?.maximumAlphaCode !== 255 ||
    !finiteVector(image?.linearEnergy?.rgb, 3) ||
    !image.linearEnergy.rgb.every((value) => value >= 0) ||
    !finite(image?.linearEnergy?.luminance)
  ) {
    return false;
  }
  const expectedLuminance =
    0.2126 * image.linearEnergy.rgb[0] +
    0.7152 * image.linearEnergy.rgb[1] +
    0.0722 * image.linearEnergy.rgb[2];
  return approximately(
    image.linearEnergy.luminance,
    expectedLuminance,
    Math.max(1e-12, Math.abs(expectedLuminance) * 1e-12),
  );
}

function validImmutableImage(image) {
  const immutable = image?.immutableFile;
  return (
    validDecodedImage(image) &&
    immutable?.exists === true &&
    immutable.byteLength === image.pngByteLength &&
    immutable.sha256 === image.pngSha256
  );
}

function validateOrbitSample(sample, contract) {
  const reasons = [];
  const source = sample?.sourceInputs;
  const camera = source?.cameraPositionWC;
  const body = source?.bodyPositionWC;
  const direction = source?.cameraDirectionWC;
  const up = source?.cameraUpWC;
  const basis = contract?.orbitBasis;
  if (
    !finiteVector(camera, 3) ||
    !finiteVector(body, 3) ||
    !finiteVector(direction, 3) ||
    !finiteVector(up, 3) ||
    !validOrbitBasis(basis)
  ) {
    return ["orbital source vectors or frozen basis are malformed"];
  }

  if (source.timeIso !== expectedIsoAtOffset(sample.offsetSeconds)) {
    reasons.push("sample time is not epoch plus its exact offset");
  }
  if (source.innerRadius !== C12_29_S4_ORBIT.innerRadiusMeters) {
    reasons.push("sample inner radius is not the frozen WGS84 radius");
  }
  if (!exactAtmosphere(source.atmosphere)) {
    reasons.push("sample atmosphere is not the frozen default atmosphere");
  }

  const radius =
    C12_29_S4_ORBIT.innerRadiusMeters + C12_29_S4_ORBIT.altitudeMeters;
  const cameraRadius = vectorLength(camera);
  if (
    Math.abs(cameraRadius - radius) > C12_29_S4_BANDS.orbitRadiusToleranceMeters
  ) {
    reasons.push("camera is not on the exact 400 km circular orbit");
  }
  const meanMotion = Math.sqrt(
    C12_29_S4_ORBIT.gravitationalParameter / radius ** 3,
  );
  const shellAngle =
    Math.PI -
    Math.asin(
      (C12_29_S4_ORBIT.innerRadiusMeters +
        C12_29_S4_ORBIT.atmosphereShellMeters) /
        radius,
    );
  const expectedPhase = shellAngle - meanMotion * sample.offsetSeconds;
  const measuredPhase = Math.atan2(
    dot(camera, basis.tangentAxisWC),
    dot(camera, basis.sunDirectionWC),
  );
  if (
    !approximately(
      sample?.orbitPhaseRadians,
      expectedPhase,
      C12_29_S4_BANDS.orbitPhaseToleranceRadians,
    ) ||
    !approximately(
      measuredPhase,
      expectedPhase,
      C12_29_S4_BANDS.orbitPhaseToleranceRadians,
    )
  ) {
    reasons.push("camera phase is not the registered circular-orbit phase");
  }
  const expectedCamera = basis.sunDirectionWC.map(
    (component, index) =>
      radius *
      (component * Math.cos(expectedPhase) +
        basis.tangentAxisWC[index] * Math.sin(expectedPhase)),
  );
  if (
    maximumVectorDelta(camera, expectedCamera) >
    C12_29_S4_BANDS.orbitPositionToleranceMeters
  ) {
    reasons.push("camera vector differs from the frozen orbital basis");
  }

  const ray = normalized(body.map((value, index) => value - camera[index]));
  if (!ray) {
    reasons.push("Sun ray direction is degenerate");
    return reasons;
  }
  const along = Math.max(0, -dot(camera, ray));
  const closest = camera.map((value, index) => value + ray[index] * along);
  const tangentKm =
    (vectorLength(closest) - C12_29_S4_ORBIT.innerRadiusMeters) / 1000;
  if (
    !approximately(
      sample?.tangentHeightKm,
      tangentKm,
      C12_29_S4_BANDS.tangentRecomputeToleranceKm,
    )
  ) {
    reasons.push("reported tangent height differs from the camera/Sun ray");
  }
  if (
    maximumVectorDelta(direction, ray) > C12_29_S4_BANDS.unitVectorTolerance
  ) {
    reasons.push("camera direction is not aimed at the live Sun");
  }
  if (
    !approximately(
      vectorLength(direction),
      1,
      C12_29_S4_BANDS.unitVectorTolerance,
    ) ||
    !approximately(vectorLength(up), 1, C12_29_S4_BANDS.unitVectorTolerance) ||
    Math.abs(dot(direction, up)) > C12_29_S4_BANDS.orthogonalityTolerance
  ) {
    reasons.push("camera direction/up are not an orthonormal view frame");
  }
  return reasons;
}

function nearestSample(samples, targetHeightKm) {
  let best;
  for (const sample of samples) {
    const errorKm = Math.abs(sample.tangentHeightKm - targetHeightKm);
    if (!best || errorKm < best.errorKm) {
      best = { sample, errorKm };
    }
  }
  return best;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) * 0.5
    : ordered[middle];
}

function exactOffsets(samples) {
  return (
    samples.length === C12_29_S4_SAMPLE_OFFSETS_SECONDS.length &&
    samples.every(
      (sample, index) =>
        sample.offsetSeconds === C12_29_S4_SAMPLE_OFFSETS_SECONDS[index],
    )
  );
}

function validAdapterIdentity(session) {
  const gpu = session?.gpuProvenance;
  if (
    gpu?.backend !== session?.actualRenderer ||
    typeof gpu?.rendererString !== "string" ||
    gpu.rendererString.length === 0
  ) {
    return false;
  }
  if (session.actualRenderer !== "webgpu") {
    return true;
  }
  const info = gpu.adapterInfo;
  return [
    info?.vendor,
    info?.architecture,
    info?.device,
    info?.description,
  ].some((value) => typeof value === "string" && value.length > 0);
}

function sameUniqueStrings(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.length === right.length &&
    left.every((value) => right.includes(value))
  );
}

function validRuntimeClosure(session) {
  const closure = session?.runtimeIdentity?.viewerClosure;
  const expected = closure?.expectedRoutes;
  const required = closure?.requiredExecutionRoutes;
  const conditional = closure?.conditionalRoutes;
  const executed = closure?.executedRoutes;
  const sameOriginLedger = closure?.sameOriginResourceLedger;
  const ledger = closure?.executionLedger;
  const supportLedger = closure?.supportResourceLedger;
  if (
    session?.runtimeIdentity?.ok !== true ||
    !Array.isArray(expected) ||
    expected.length < 10 ||
    new Set(expected).size !== expected.length ||
    !expected.includes("/Apps/CesiumViewer/index.html") ||
    !expected.includes("/Apps/CesiumViewer/CesiumViewer.js") ||
    !expected.includes("/Apps/CesiumViewer/CesiumViewer.css") ||
    !expected.includes("/Build/CesiumUnminified/index.js") ||
    !expected.some(
      (route) => route.startsWith("/Source/Widgets/") && route.endsWith(".css"),
    ) ||
    closure?.executedBeforeExplicitFetch !== true ||
    !Array.isArray(required) ||
    required.length < 8 ||
    !Array.isArray(conditional) ||
    !sameUniqueStrings([...required, ...conditional], expected) ||
    !Array.isArray(executed) ||
    new Set(executed).size !== executed.length ||
    !required.every((route) => executed.includes(route)) ||
    !executed.every((route) => expected.includes(route)) ||
    !sameUniqueStrings(executed, [
      ...new Set(ledger?.map((entry) => entry?.route) ?? []),
    ]) ||
    !sameUniqueStrings(closure?.fetchedRoutes, expected) ||
    !sameUniqueStrings(closure?.servedRoutes, expected) ||
    !Array.isArray(closure?.unregisteredExecutedRoutes) ||
    closure.unregisteredExecutedRoutes.length !== 0 ||
    !Array.isArray(sameOriginLedger) ||
    sameOriginLedger.length < ledger?.length ||
    !Array.isArray(ledger) ||
    ledger.length < required.length ||
    !ledger.every(
      (entry) =>
        expected.includes(entry?.route) &&
        typeof entry?.resourceType === "string" &&
        entry.resourceType.length > 0 &&
        entry.sameOrigin === true,
    ) ||
    !Array.isArray(supportLedger) ||
    sameOriginLedger.length !== ledger.length + supportLedger.length ||
    !sameOriginLedger.every(
      (entry) =>
        typeof entry?.route === "string" &&
        entry.route.startsWith("/") &&
        typeof entry?.resourceType === "string" &&
        entry.resourceType.length > 0 &&
        entry.sameOrigin === true,
    ) ||
    !sameOriginLedger.every((entry, index) => {
      const partition = expected.includes(entry.route) ? ledger : supportLedger;
      const priorMatches = sameOriginLedger
        .slice(0, index)
        .filter(
          (candidate) =>
            expected.includes(candidate.route) ===
            expected.includes(entry.route),
        ).length;
      const match = partition[priorMatches];
      return (
        match?.route === entry.route &&
        match?.resourceType === entry.resourceType &&
        match?.sameOrigin === entry.sameOrigin
      );
    }) ||
    !supportLedger.every((entry) => {
      const resourceType = entry?.resourceType?.toLowerCase();
      const route = entry?.route ?? "";
      const assetRoute = /^\/Build\/CesiumUnminified\/Assets\//u.test(route);
      const widgetImageRoute =
        /^\/Build\/CesiumUnminified\/Widgets\/Images\//u.test(route);
      const workerRoute =
        /^\/Build\/CesiumUnminified\/Workers\/[^/]+\.js$/u.test(route);
      const scriptWorkerChunkRoute =
        /^\/Build\/CesiumUnminified\/Workers\/chunk-[A-Z0-9]+\.js$/u.test(
          route,
        );
      return (
        !expected.includes(entry?.route) &&
        ((resourceType === "xmlhttprequest" && assetRoute) ||
          (resourceType === "img" && (assetRoute || widgetImageRoute)) ||
          ((resourceType === "worker" || resourceType === "other") &&
            workerRoute) ||
          (resourceType === "script" && scriptWorkerChunkRoute))
      );
    }) ||
    !required.every(
      (route) => ledger.filter((entry) => entry.route === route).length === 1,
    ) ||
    !Array.isArray(closure?.routeIdentities) ||
    closure.routeIdentities.length !== expected.length ||
    !sameUniqueStrings(
      closure.routeIdentities.map((identity) => identity?.route),
      expected,
    )
  ) {
    return false;
  }
  return closure.routeIdentities.every(
    (identity) =>
      expected.includes(identity?.route) &&
      identity?.local?.exists === true &&
      identity?.served?.ok === true &&
      identity?.runtime?.ok === true &&
      identity.served.status === 200 &&
      identity.runtime.status === 200 &&
      identity.local.byteLength === identity.served.byteLength &&
      identity.local.byteLength === identity.runtime.byteLength &&
      identity.local.sha256 === identity.served.sha256 &&
      identity.local.sha256 === identity.runtime.sha256 &&
      /^[0-9a-f]{64}$/u.test(identity.local.sha256 ?? ""),
  );
}

function validSunPipelineReadiness(session) {
  const readiness = session?.sunPipelineReadiness;
  if (session?.actualRenderer !== "webgpu") {
    return (
      readiness?.renderer === "webgl" &&
      readiness?.status === "N/A" &&
      readiness?.prewarmOffsetSeconds === null &&
      readiness?.attemptedFrames === 0 &&
      readiness?.yieldedTurns === 0 &&
      readiness?.commandReady === null &&
      readiness?.pipelineReady === null &&
      readiness?.ownerExact === null &&
      readiness?.vertexCount === null
    );
  }
  return (
    readiness?.renderer === "webgpu" &&
    readiness?.status === "READY" &&
    readiness?.prewarmOffsetSeconds ===
      C12_29_S4_SAMPLE_OFFSETS_SECONDS.at(-1) &&
    Number.isInteger(readiness?.attemptedFrames) &&
    readiness.attemptedFrames >= 2 &&
    readiness.attemptedFrames <= 36 &&
    Number.isInteger(readiness?.yieldedTurns) &&
    readiness.yieldedTurns >= 1 &&
    readiness.yieldedTurns < readiness.attemptedFrames &&
    readiness?.commandReady === true &&
    readiness?.pipelineReady === true &&
    readiness?.ownerExact === true &&
    readiness?.vertexCount === 6
  );
}

function validGraphicsCompletion(session) {
  const completion = session?.graphicsCompletion;
  if (session?.actualRenderer === "webgpu") {
    const scopes = completion?.errorScopes;
    return (
      completion?.backend === "webgpu" &&
      completion?.queueFenceAttempted === true &&
      completion?.queueFenceCompleted === true &&
      completion?.queueFenceError === null &&
      Array.isArray(scopes) &&
      scopes.length === 3 &&
      ["out-of-memory", "internal", "validation"].every(
        (filter, index) =>
          scopes[index]?.filter === filter &&
          scopes[index]?.popped === true &&
          scopes[index]?.error === null,
      ) &&
      completion?.deviceErrorListenerArmed === true &&
      completion?.deviceLossListenerArmed === true &&
      Array.isArray(completion?.uncapturedErrors) &&
      completion.uncapturedErrors.length === 0 &&
      Array.isArray(completion?.deviceLossEvents) &&
      completion.deviceLossEvents.length === 0 &&
      Number.isInteger(completion?.lateEventTurns) &&
      completion.lateEventTurns >= 2
    );
  }
  return (
    completion?.backend === "webgl" &&
    completion?.finishAttempted === true &&
    completion?.finishCompleted === true &&
    completion?.finishError === null &&
    completion?.getErrorDrained === true &&
    completion?.terminalErrorCode === 0 &&
    Number.isInteger(completion?.getErrorCalls) &&
    completion.getErrorCalls >= 1 &&
    Array.isArray(completion?.nonZeroErrorCodes) &&
    completion.nonZeroErrorCodes.length === 0
  );
}

function imageLuminance(sample) {
  return sample?.image?.linearEnergy?.luminance;
}

function imageRgb(sample) {
  return sample?.image?.linearEnergy?.rgb;
}

function summarizeNeutralLane(lane) {
  const samples = Array.isArray(lane?.samples) ? lane.samples : [];
  const structural = [];
  const product = [];
  const metrics = {};

  if (lane?.captureMethod !== C12_29_S4_CAPTURE_METHOD) {
    structural.push("blend-neutral lane did not use direct same-task capture");
  }
  if (!exactOffsets(samples)) {
    structural.push(
      "blend-neutral lane does not contain the exact 181-second sweep",
    );
  }
  if (!exactNeutralSceneContract(lane?.sceneContract)) {
    structural.push(
      "blend-neutral declared scene/orbit contract is not the frozen S4 contract",
    );
  }
  if (
    !samples.every(
      (sample) =>
        finite(sample?.tangentHeightKm) &&
        finite(sample?.orbitPhaseRadians) &&
        finiteVector(sample?.extinction, 3) &&
        finite(sample?.sunEclipseAlpha) &&
        computeIndependentExtinction(sample?.sourceInputs) !== null &&
        validDecodedImage(sample?.image) &&
        exactNeutralSnapshot(sample?.sceneSnapshot, true),
    )
  ) {
    structural.push(
      "blend-neutral lane contains malformed, wrong-sized, or non-neutral live samples",
    );
  }
  if (!samples.every((sample) => sample?.sunEclipseAlpha === 1)) {
    structural.push(
      "blend-neutral lane was confounded by a non-identity eclipse alpha",
    );
  }
  if (
    exactOffsets(samples) &&
    validOrbitBasis(lane?.sceneContract?.orbitBasis)
  ) {
    const orbitReasons = new Set(
      samples.flatMap((sample) =>
        validateOrbitSample(sample, lane.sceneContract),
      ),
    );
    structural.push(...orbitReasons);
  }
  if (structural.length > 0) {
    return { structural, product, metrics, samples };
  }

  const tangentHeights = samples.map((sample) => sample.tangentHeightKm);
  metrics.minimumTangentHeightKm = Math.min(...tangentHeights);
  metrics.maximumTangentHeightKm = Math.max(...tangentHeights);
  metrics.tangentHeightMonotone = samples.every(
    (sample, index) =>
      index === 0 ||
      sample.tangentHeightKm >= samples[index - 1].tangentHeightKm - 1e-6,
  );
  if (
    metrics.minimumTangentHeightKm > C12_29_S4_BANDS.minimumTangentHeightKm ||
    metrics.maximumTangentHeightKm < C12_29_S4_BANDS.maximumTangentHeightKm ||
    !metrics.tangentHeightMonotone
  ) {
    structural.push(
      "physical tangent-height sweep did not span the registered sunrise envelope",
    );
  }

  metrics.anchorErrorsKm = {};
  for (const heightKm of C12_29_S4_TANGENT_ANCHORS_KM) {
    const nearest = nearestSample(samples, heightKm);
    metrics.anchorErrorsKm[String(heightKm)] = nearest.errorKm;
    if (nearest.errorKm > C12_29_S4_BANDS.tangentAnchorMaximumErrorKm) {
      structural.push(`no sample reaches the ${heightKm} km tangent anchor`);
    }
  }

  const hiddenControls = Array.isArray(lane?.hiddenControls)
    ? lane.hiddenControls
    : [];
  metrics.hiddenControlCount = hiddenControls.length;
  metrics.hiddenMaximumCode = Math.max(
    -Infinity,
    ...hiddenControls.map((control) => control?.image?.maxCode ?? Infinity),
  );
  metrics.hiddenMaximumNonBlackPixels = Math.max(
    -Infinity,
    ...hiddenControls.map(
      (control) => control?.image?.nonBlackPixels ?? Infinity,
    ),
  );
  const hiddenExact =
    hiddenControls.length === C12_29_S4_HIDDEN_ANCHORS_KM.length &&
    hiddenControls.every((control, index) => {
      const anchor = C12_29_S4_HIDDEN_ANCHORS_KM[index];
      const targetHeightKm =
        anchor === "clear"
          ? C12_29_S4_BANDS.clearIdentityMinimumHeightKm
          : anchor;
      const nearest = nearestSample(samples, targetHeightKm).sample;
      return (
        control?.targetTangentHeightKm === anchor &&
        control?.offsetSeconds === nearest.offsetSeconds &&
        approximately(
          control?.tangentHeightKm,
          nearest.tangentHeightKm,
          C12_29_S4_BANDS.tangentRecomputeToleranceKm,
        ) &&
        control?.captureMethod === C12_29_S4_CAPTURE_METHOD &&
        exactNeutralSnapshot(control?.sceneSnapshot, false) &&
        validDecodedImage(control?.image) &&
        control.image.maxCode <= C12_29_S4_BANDS.hiddenMaximumCode &&
        control.image.nonBlackPixels <=
          C12_29_S4_BANDS.hiddenMaximumNonBlackPixels &&
        control.image.aboveFloorPixelsByChannel.every((count) => count === 0)
      );
    });
  if (!hiddenExact) {
    structural.push(
      "registered sun-hidden 60/40/25/15/10/0/clear controls are not exact black same-task captures",
    );
  }

  let sourceMonotone = true;
  let worstSourceReferenceDelta = 0;
  for (let index = 1; index < samples.length; index++) {
    for (let channel = 0; channel < 3; channel++) {
      if (
        samples[index].extinction[channel] +
          C12_29_S4_BANDS.sourceMonotonicTolerance <
        samples[index - 1].extinction[channel]
      ) {
        sourceMonotone = false;
      }
    }
  }
  for (const sample of samples) {
    const reference = computeIndependentExtinction(sample.sourceInputs);
    for (let channel = 0; channel < 3; channel++) {
      worstSourceReferenceDelta = Math.max(
        worstSourceReferenceDelta,
        Math.abs(sample.extinction[channel] - reference[channel]),
      );
    }
  }
  metrics.sourceMonotone = sourceMonotone;
  metrics.worstSourceReferenceDelta = worstSourceReferenceDelta;
  if (!sourceMonotone) {
    product.push("source extinction reverses during sunrise");
  }
  if (worstSourceReferenceDelta > C12_29_S4_BANDS.sourceReferenceTolerance) {
    product.push(
      "published source extinction differs from the independent scalar recomputation",
    );
  }

  const clearSamples = samples.filter(
    (sample) =>
      sample.tangentHeightKm >= C12_29_S4_BANDS.clearIdentityMinimumHeightKm,
  );
  metrics.clearIdentitySampleCount = clearSamples.length;
  metrics.clearIdentityExact =
    clearSamples.length >= 8 &&
    clearSamples.every((sample) =>
      sample.extinction.every((value) => value === 1),
    );
  if (!metrics.clearIdentityExact) {
    product.push("extinction is not exact identity above the atmosphere shell");
  }

  const anchor25 = nearestSample(samples, 25).sample.extinction;
  const anchor10 = nearestSample(samples, 10).sample.extinction;
  metrics.reddeningAt25Km =
    anchor25[0] / Math.max(anchor25[2], Number.MIN_VALUE);
  metrics.reddeningAt10Km =
    anchor10[0] / Math.max(anchor10[2], Number.MIN_VALUE);
  if (
    !(metrics.reddeningAt25Km > C12_29_S4_BANDS.reddeningAt25KmMinimum) ||
    !(metrics.reddeningAt10Km > C12_29_S4_BANDS.reddeningAt10KmMinimum)
  ) {
    product.push("grazing reddening is absent or below the registered anchors");
  }

  const energies = samples.map(imageLuminance);
  const peak = median(clearSamples.map(imageLuminance));
  const clearNonBlackPixels = median(
    clearSamples.map((sample) => sample.image.nonBlackPixels),
  );
  metrics.clearPeakLinearEnergy = peak;
  metrics.clearPeakNonBlackPixels = clearNonBlackPixels;
  if (
    peak < C12_29_S4_BANDS.minimumClearLinearEnergy ||
    clearNonBlackPixels < C12_29_S4_BANDS.minimumClearNonBlackPixels
  ) {
    structural.push(
      "blend-neutral clear Sun lacks robust multi-frame pixel support",
    );
  } else {
    const clearRgb = [0, 1, 2].map((channel) =>
      median(clearSamples.map((sample) => imageRgb(sample)[channel])),
    );
    const clearSupport = [0, 1, 2].map((channel) =>
      median(
        clearSamples.map(
          (sample) => sample.image.aboveFloorPixelsByChannel[channel],
        ),
      ),
    );
    metrics.clearChannelLinearEnergy = clearRgb;
    metrics.clearChannelSupportPixels = clearSupport;
    if (
      clearRgb.some(
        (energy) => energy < C12_29_S4_BANDS.minimumClearChannelLinearEnergy,
      ) ||
      clearSupport.some(
        (count) => count < C12_29_S4_BANDS.minimumChannelSupportPixels,
      )
    ) {
      structural.push(
        "blend-neutral clear Sun lacks robust per-channel support",
      );
      return { structural, product, metrics, samples };
    }

    const normalizedRgb = (sample) =>
      imageRgb(sample).map((energy, channel) => energy / clearRgb[channel]);
    const renderedRatio = (sample) => {
      const normalized = normalizedRgb(sample);
      return (
        normalized[0] /
        Math.max(normalized[2], C12_29_S4_BANDS.renderedColorFloorFraction)
      );
    };
    const anchorSamples = [25, 10].map(
      (height) => nearestSample(samples, height).sample,
    );
    const renderedRatios = anchorSamples.map(renderedRatio);
    const sourceRatios = anchorSamples.map(
      (sample) =>
        sample.extinction[0] / Math.max(sample.extinction[2], Number.MIN_VALUE),
    );
    const predictedBlueCodes = anchorSamples.map(
      (sample) => 255 * sample.extinction[2],
    );
    const redSupport = anchorSamples.map(
      (sample) => sample.image.aboveFloorPixelsByChannel[0],
    );
    const blueSupport = anchorSamples.map(
      (sample) => sample.image.aboveFloorPixelsByChannel[2],
    );
    metrics.renderedReddeningAt25Km = renderedRatios[0];
    metrics.renderedReddeningAt10Km = renderedRatios[1];
    metrics.renderedAnchorRedSupportPixels = redSupport;
    metrics.renderedAnchorBlueSupportPixels = blueSupport;
    metrics.predictedAnchorBlueCodes = predictedBlueCodes;
    const tenKmBlueIsSubCode = predictedBlueCodes[1] < 0.5;
    metrics.renderedSourceLogRatioDelta = [
      Math.abs(Math.log(renderedRatios[0]) - Math.log(sourceRatios[0])),
      tenKmBlueIsSubCode
        ? null
        : Math.abs(Math.log(renderedRatios[1]) - Math.log(sourceRatios[1])),
    ];
    const tenKmObservableContract = tenKmBlueIsSubCode
      ? blueSupport[1] === 0 && anchorSamples[1].image.maxCodeByChannel[2] === 0
      : blueSupport[1] >= C12_29_S4_BANDS.minimumChannelSupportPixels &&
        finite(metrics.renderedSourceLogRatioDelta[1]) &&
        metrics.renderedSourceLogRatioDelta[1] <=
          C12_29_S4_BANDS.renderedSourceLogRatioTolerance;
    if (
      !(renderedRatios[0] > C12_29_S4_BANDS.renderedReddeningAt25KmMinimum) ||
      !(renderedRatios[1] > C12_29_S4_BANDS.renderedReddeningAt10KmMinimum) ||
      redSupport.some(
        (count) => count < C12_29_S4_BANDS.minimumChannelSupportPixels,
      ) ||
      blueSupport[0] < C12_29_S4_BANDS.minimumChannelSupportPixels ||
      !tenKmObservableContract ||
      !finite(metrics.renderedSourceLogRatioDelta[0]) ||
      metrics.renderedSourceLogRatioDelta[0] >
        C12_29_S4_BANDS.renderedSourceLogRatioTolerance
    ) {
      product.push(
        "decoded rendered Sun lacks supported source-derived red-over-blue anchors",
      );
    }

    const colorSamples = samples.filter((sample) => {
      const normalized = normalizedRgb(sample);
      return (
        sample.tangentHeightKm >= 25 &&
        sample.tangentHeightKm <=
          C12_29_S4_BANDS.clearIdentityMinimumHeightKm &&
        normalized[0] >= C12_29_S4_BANDS.renderedColorFloorFraction &&
        normalized[2] >= C12_29_S4_BANDS.renderedColorFloorFraction &&
        sample.image.aboveFloorPixelsByChannel[0] >=
          C12_29_S4_BANDS.minimumChannelSupportPixels &&
        sample.image.aboveFloorPixelsByChannel[2] >=
          C12_29_S4_BANDS.minimumChannelSupportPixels
      );
    });
    let worstColorRatioReversal = 0;
    for (let index = 1; index < colorSamples.length; index++) {
      const previous = renderedRatio(colorSamples[index - 1]);
      const current = renderedRatio(colorSamples[index]);
      worstColorRatioReversal = Math.max(
        worstColorRatioReversal,
        (current - previous) / Math.max(previous, Number.MIN_VALUE),
      );
    }
    metrics.renderedColorSampleCount = colorSamples.length;
    metrics.renderedWorstColorRatioReversalFraction = worstColorRatioReversal;
    if (
      colorSamples.length < C12_29_S4_BANDS.minimumRenderedColorSamples ||
      worstColorRatioReversal >
        C12_29_S4_BANDS.renderedColorRatioReversalFraction
    ) {
      product.push(
        "decoded rendered red-over-blue development reverses or lacks robust support",
      );
    }

    let worstDrop = 0;
    let largestRise = 0;
    for (let index = 1; index < energies.length; index++) {
      const delta = (energies[index] - energies[index - 1]) / peak;
      worstDrop = Math.max(worstDrop, -delta);
      largestRise = Math.max(largestRise, delta);
    }
    metrics.renderedWorstDropFraction = worstDrop;
    metrics.renderedMaximumStepFraction = largestRise;
    if (worstDrop > C12_29_S4_BANDS.renderedMonotonicDropFraction) {
      product.push(
        "rendered sunrise curve reverses beyond the quantization allowance",
      );
    }
    if (largestRise > C12_29_S4_BANDS.renderedMaximumStepFraction) {
      product.push(
        "rendered sunrise contains a greater-than-10%-of-peak one-second step",
      );
    }

    const normalized = energies.map((energy) => energy / peak);
    const low = normalized.findIndex(
      (value) => value >= C12_29_S4_BANDS.transitionLowFraction,
    );
    const high = normalized.findIndex(
      (value) => value >= C12_29_S4_BANDS.transitionHighFraction,
    );
    metrics.transitionSeconds =
      low >= 0 && high >= low
        ? samples[high].offsetSeconds - samples[low].offsetSeconds
        : null;
    if (
      !finite(metrics.transitionSeconds) ||
      metrics.transitionSeconds < C12_29_S4_BANDS.minimumTransitionSeconds ||
      metrics.transitionSeconds > C12_29_S4_BANDS.maximumTransitionSeconds
    ) {
      product.push(
        "rendered sunrise lacks a bounded multi-second development interval",
      );
    }
  }

  return { structural, product, metrics, samples };
}

function summarizeNormalLane(lane) {
  const captures = Array.isArray(lane?.captures) ? lane.captures : [];
  const structural = [];
  const product = [];
  const metrics = {};
  if (lane?.captureMethod !== C12_29_S4_CAPTURE_METHOD) {
    structural.push("normal lane did not use direct same-task capture");
  }
  if (
    captures.length !== C12_29_S4_NORMAL_ANCHORS_KM.length ||
    !captures.every(
      (capture, index) =>
        capture.targetTangentHeightKm === C12_29_S4_NORMAL_ANCHORS_KM[index] &&
        Math.abs(capture.tangentHeightKm - capture.targetTangentHeightKm) <=
          C12_29_S4_BANDS.tangentAnchorMaximumErrorKm &&
        capture?.tilesLoaded === true &&
        Number.isInteger(capture?.settledFrames) &&
        capture.settledFrames >= 8 &&
        validImmutableImage(capture?.image),
    )
  ) {
    structural.push(
      "normal lane is missing a loaded, immutable registered visual-review anchor",
    );
  } else {
    const clear = captures.at(-1);
    metrics.clearNonBlackPixels = clear.image.nonBlackPixels;
    if (
      clear.image.nonBlackPixels < C12_29_S4_BANDS.minimumClearNonBlackPixels
    ) {
      product.push("normal appearance lane is black at the clear-sun anchor");
    }
  }
  return { structural, product, metrics };
}

function compareBackends(left, right) {
  const structural = [];
  const product = [];
  const metrics = {
    worstSourceExtinctionDelta: 0,
    worstPairedTangentDeltaKm: 0,
    worstPairedOrbitPhaseDeltaRadians: 0,
    rendered: Object.fromEntries(
      ["luminance", "red", "green", "blue"].map((name) => [
        name,
        { comparableCount: 0, transitionComparableCount: 0, worstDelta: 0 },
      ]),
    ),
  };
  const a = left.samples;
  const b = right.samples;
  if (!exactOffsets(a) || !exactOffsets(b)) {
    structural.push(
      "backend sweeps cannot be paired by their exact time offsets",
    );
    return { structural, product, metrics };
  }

  const peaks = [left, right].map((summary) => ({
    luminance: summary.metrics.clearPeakLinearEnergy,
    rgb: summary.metrics.clearChannelLinearEnergy,
  }));
  const renderedKeys = ["luminance", "red", "green", "blue"];
  for (let index = 0; index < a.length; index++) {
    metrics.worstPairedTangentDeltaKm = Math.max(
      metrics.worstPairedTangentDeltaKm,
      Math.abs(a[index].tangentHeightKm - b[index].tangentHeightKm),
    );
    metrics.worstPairedOrbitPhaseDeltaRadians = Math.max(
      metrics.worstPairedOrbitPhaseDeltaRadians,
      Math.abs(a[index].orbitPhaseRadians - b[index].orbitPhaseRadians),
    );
    for (let channel = 0; channel < 3; channel++) {
      metrics.worstSourceExtinctionDelta = Math.max(
        metrics.worstSourceExtinctionDelta,
        Math.abs(a[index].extinction[channel] - b[index].extinction[channel]),
      );
    }

    const valuesA = [
      imageLuminance(a[index]) / peaks[0].luminance,
      ...imageRgb(a[index]).map(
        (value, channel) => value / peaks[0].rgb[channel],
      ),
    ];
    const valuesB = [
      imageLuminance(b[index]) / peaks[1].luminance,
      ...imageRgb(b[index]).map(
        (value, channel) => value / peaks[1].rgb[channel],
      ),
    ];
    const supported = [
      a[index].image.nonBlackPixels >=
        C12_29_S4_BANDS.minimumChannelSupportPixels &&
        b[index].image.nonBlackPixels >=
          C12_29_S4_BANDS.minimumChannelSupportPixels,
      ...[0, 1, 2].map(
        (channel) =>
          a[index].image.aboveFloorPixelsByChannel[channel] >=
            C12_29_S4_BANDS.minimumChannelSupportPixels &&
          b[index].image.aboveFloorPixelsByChannel[channel] >=
            C12_29_S4_BANDS.minimumChannelSupportPixels,
      ),
    ];
    for (let valueIndex = 0; valueIndex < renderedKeys.length; valueIndex++) {
      if (!supported[valueIndex]) {
        continue;
      }
      const entry = metrics.rendered[renderedKeys[valueIndex]];
      entry.comparableCount++;
      entry.worstDelta = Math.max(
        entry.worstDelta,
        Math.abs(valuesA[valueIndex] - valuesB[valueIndex]),
      );
      if (
        [valuesA[valueIndex], valuesB[valueIndex]].some(
          (value) =>
            value >= C12_29_S4_BANDS.transitionLowFraction &&
            value <= C12_29_S4_BANDS.transitionHighFraction,
        )
      ) {
        entry.transitionComparableCount++;
      }
    }
  }

  if (
    metrics.worstSourceExtinctionDelta > C12_29_S4_BANDS.sourceParityTolerance
  ) {
    product.push("WebGL/WebGPU source extinction is not numerically identical");
  }
  if (
    metrics.worstPairedTangentDeltaKm >
      C12_29_S4_BANDS.tangentRecomputeToleranceKm ||
    metrics.worstPairedOrbitPhaseDeltaRadians >
      C12_29_S4_BANDS.orbitPhaseToleranceRadians
  ) {
    structural.push("WebGL/WebGPU orbit height/phase samples are not paired");
  }
  for (const key of renderedKeys) {
    const entry = metrics.rendered[key];
    const minimum =
      key === "luminance"
        ? C12_29_S4_BANDS.minimumLuminanceParitySamples
        : C12_29_S4_BANDS.minimumChannelParitySamples;
    if (
      entry.comparableCount < minimum ||
      entry.transitionComparableCount < 2
    ) {
      structural.push(
        `too few robust ${key} samples cover rendered backend parity and transition`,
      );
    } else if (entry.worstDelta > C12_29_S4_BANDS.renderedParityFraction) {
      product.push(
        `blend-neutral WebGL/WebGPU rendered ${key} curves differ by more than 5%`,
      );
    }
  }
  return { structural, product, metrics };
}

/**
 * Fold a complete decoded report. Structural blindness outranks a measurable
 * product failure, matching the fleet's 0/1/2/3 exit contract. Operational
 * exceptions never enter this fold; the driver publishes them as ERROR/2.
 */
export function foldC1229S4Gate(report) {
  const structuralReasons = [];
  const failedPredicates = [];
  const metrics = { sessions: {}, parity: null };

  if (report?.schema !== C12_29_S4_SCHEMA) {
    structuralReasons.push("report schema is not the frozen S4 schema");
  }
  if (!isUuidV4(report?.runId)) {
    structuralReasons.push("runId is not an immutable UUID v4 identity");
  }
  if (report?.provenance?.ok !== true) {
    structuralReasons.push(
      ...(report?.provenance?.reasons?.length
        ? report.provenance.reasons.map((reason) => `provenance: ${reason}`)
        : ["exact source/build/served/runtime provenance is absent"]),
    );
  }
  if (report?.lifecycle?.firstRedStable !== true) {
    structuralReasons.push("write-once first-red bytes changed during the run");
  }

  const sessions = Array.isArray(report?.sessions) ? report.sessions : [];
  const byRenderer = new Map();
  for (const renderer of C12_29_S4_RENDERERS) {
    const matches = sessions.filter(
      (session) => session?.requestedRenderer === renderer,
    );
    if (matches.length !== 1) {
      structuralReasons.push(
        `${renderer}: expected one fresh browser session, received ${matches.length}`,
      );
    } else {
      byRenderer.set(renderer, matches[0]);
    }
  }
  if (sessions.length !== C12_29_S4_RENDERERS.length) {
    structuralReasons.push(
      "unexpected browser sessions are present or required sessions were dropped",
    );
  }

  const neutralSummaries = new Map();
  for (const [renderer, session] of byRenderer) {
    if (session.actualRenderer !== renderer) {
      structuralReasons.push(
        `${renderer}: requested renderer resolved as ${String(session.actualRenderer)}`,
      );
    }
    if (!validAdapterIdentity(session)) {
      structuralReasons.push(
        `${renderer}: renderer/adapter identity is incomplete`,
      );
    }
    if (!validRuntimeClosure(session)) {
      structuralReasons.push(
        `${renderer}: served/runtime Viewer, CSS-import, and build closure is not exact`,
      );
    }
    if (!validSunPipelineReadiness(session)) {
      structuralReasons.push(
        `${renderer}: Sun pipeline readiness was not durably established before the scored sweep`,
      );
    }
    if (
      session?.transport?.loopbackBaseAccepted !== true ||
      session?.transport?.credentialFreeBase !== true ||
      session?.transport?.sameOriginOnly !== true ||
      typeof session?.transport?.origin !== "string"
    ) {
      structuralReasons.push(
        `${renderer}: evidence transport is not credential-free loopback same-origin HTTP(S)`,
      );
    }
    if (!validGraphicsCompletion(session)) {
      structuralReasons.push(
        `${renderer}: graphics queue/error-scope or WebGL finish/error drain is incomplete`,
      );
    }
    for (const [field, label] of [
      ["externalRequests", "external requests"],
      ["failedRequests", "failed requests"],
      ["httpErrors", "HTTP errors"],
    ]) {
      if (!Array.isArray(session[field]) || session[field].length !== 0) {
        structuralReasons.push(
          `${renderer}: ${label} invalidate the offline run`,
        );
      }
    }
    for (const [field, label] of [
      ["consoleErrors", "console errors"],
      ["pageErrors", "page errors"],
      ["deviceErrors", "device/GPU errors"],
    ]) {
      if (!Array.isArray(session[field]) || session[field].length !== 0) {
        failedPredicates.push(`${renderer}: ${label} were observed`);
      }
    }

    const neutral = summarizeNeutralLane(session.neutral);
    const normal = summarizeNormalLane(session.normal);
    structuralReasons.push(
      ...neutral.structural.map((reason) => `${renderer}: ${reason}`),
      ...normal.structural.map((reason) => `${renderer}: ${reason}`),
    );
    failedPredicates.push(
      ...neutral.product.map((reason) => `${renderer}: ${reason}`),
      ...normal.product.map((reason) => `${renderer}: ${reason}`),
    );
    neutralSummaries.set(renderer, neutral);
    metrics.sessions[renderer] = {
      neutral: neutral.metrics,
      normal: normal.metrics,
    };
  }

  if (
    neutralSummaries.has("webgl") &&
    neutralSummaries.has("webgpu") &&
    neutralSummaries.get("webgl").structural.length === 0 &&
    neutralSummaries.get("webgpu").structural.length === 0
  ) {
    const parity = compareBackends(
      neutralSummaries.get("webgl"),
      neutralSummaries.get("webgpu"),
    );
    structuralReasons.push(...parity.structural);
    failedPredicates.push(...parity.product);
    metrics.parity = parity.metrics;
  } else {
    structuralReasons.push(
      "backend parity is unscored because a blend-neutral lane is blind",
    );
  }

  const uniqueStructural = [...new Set(structuralReasons)];
  const uniqueFailures = [...new Set(failedPredicates)];
  const status =
    uniqueStructural.length > 0
      ? "STRUCTURAL"
      : uniqueFailures.length > 0
        ? "FAIL"
        : "PASS";
  return {
    status,
    exitCode: exitCodeForS4Status(status),
    pass: status === "PASS",
    structuralReasons: uniqueStructural,
    failedPredicates: uniqueFailures,
    metrics,
  };
}
