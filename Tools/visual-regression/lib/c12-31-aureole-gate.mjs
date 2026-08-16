/**
 * Pure, browser-independent acceptance policy for the bounded C12-31 L1-L4
 * natural-solar-aureole certificate.
 * @purpose Gate-predicate library for the C12-31 sky-aureole certification lane, pairing probe-sky-aureole-anchor with its spec.
 * @status ACTIVE
 *
 * The browser probe records requested and observed state. This module owns the
 * exact topology, independently checks the WGS84 camera/Sun relationships,
 * decodes the persisted PNG bytes, and folds the evidence fail closed.
 *
 * Unrepaired findings (handoff §5)
 *
 * The independent review that put this tuple on hold raised eight findings.
 * Two are still OPEN, and nothing in this module or its probe closes them.
 * Read any PASS from this gate as silent on both:
 *
 *   #4 OPEN - prior latest is not required to be byte-identical to its UUID
 *      archive. beginC1231AureoleEvidence re-parses the prior .latest.json and
 *      re-folds it through validateC1231AureoleFinalArtifact, but never reads
 *      <prefix>.<prior.runId>.json and compares bytes, so a rewritten
 *      predecessor that still folds clean is accepted. The retained-first-red
 *      path does make exactly that archive comparison; latest does not.
 *   #6 OPEN - browser/context/page acquisition and teardown are unbounded and
 *      carry no observed-closure proof. Launch, newPage, page.close and
 *      browser.close are awaited with no per-operation timeout, no closure
 *      observation reaches the artifact, and the single whole-process watchdog
 *      exits without proving anything closed.
 *
 * Their two neighbours ARE repaired, recorded here so a later reader does not
 * re-open them:
 *
 *   #5 REPAIRED (this file) - the source map is folded, not merely recorded.
 *      buildMap is a member of C12_31_AUREOLE_PROVENANCE_KEYS, so
 *      validateProvenance demands an exact key set, a valid fingerprint at both
 *      start and end, and start-equals-end bytes for it; and it re-derives every
 *      buildSourceIdentity entry against the independently recorded local
 *      fingerprints rather than trusting the probe's own ok flag.
 *   #7 REPAIRED (probe-sky-aureole-anchor.mjs, the runProbe catch) - a failure
 *      after lock acquisition re-asserts the owned RUNNING bytes and calls
 *      releaseC1231AureoleLock inside its own try/catch, so the lock is handed
 *      back and a release failure is logged instead of masking the original
 *      error. The watchdog-timeout path still exits without releasing; that
 *      residual belongs to #6, not to #7.
 */

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { exitCodeForS5Status } from "./verdict-exit-gate.mjs";

export const C12_31_AUREOLE_SCHEMA = "c12-31-aureole-evidence-v1";
export const C12_31_AUREOLE_DIAGNOSTICS_SCHEMA =
  "c12-31-aureole-runtime-diagnostics-v1";
export const C12_31_AUREOLE_SCOPE = "C12-31-L1-L4-core-only";
export const C12_31_AUREOLE_RENDERERS = Object.freeze(["webgl", "webgpu"]);
export const C12_31_AUREOLE_SHOTS = Object.freeze([
  "toward",
  "left60",
  "right60",
  "anti",
  "night",
]);
export const C12_31_AUREOLE_VIEWPORT = Object.freeze({
  width: 1024,
  height: 640,
});
export const C12_31_AUREOLE_SITE = Object.freeze({
  longitudeDegrees: -80,
  latitudeDegrees: 40,
  heightMeters: 300,
});
export const C12_31_AUREOLE_DAY_ISO = "2026-06-21T15:00:00.000Z";
export const C12_31_AUREOLE_NIGHT_ISO = "2026-06-21T02:30:00.000Z";
export const C12_31_AUREOLE_PITCH_DEGREES = 32;
export const C12_31_AUREOLE_MAX_SETTLE_FRAMES = 120;
export const C12_31_AUREOLE_CAPTURE_METHOD =
  "scene.render+pinned-JulianDate+canvas.toDataURL(image/png)-same-task-once";
export const C12_31_AUREOLE_ARTIFACT_PREFIX = "campaign12-c12-31-aureole";

export const C12_31_AUREOLE_THRESHOLDS = Object.freeze({
  minimumAzimuthContrast: 1.25,
  minimumCentroidOffset: 0.04,
  maximumNightMeanFraction: 0.15,
  maximumNightPeak: 40,
  minimumDayMean: 0.25,
  minimumTowardMean: 1,
  minimumDayPeak: 4,
  minimumTowardPeak: 8,
  minimumDayNonBlackPixels: 64,
});

export const C12_31_AUREOLE_PROVENANCE_KEYS = Object.freeze([
  "probe",
  "gate",
  "spec",
  "identityHelper",
  "buildEntry",
  "buildMap",
  "skyAtmosphere",
  "dynamicLightingType",
  "skyLightSelector",
  "scene",
  "environmentRenderer",
  "webglSkyShader",
  "webglSkyVertexShader",
  "webglSkyCommon",
  "atmosphereCommon",
  "webgpuRenderer",
  "webgpuAtmosphereUniforms",
  "wgslSky",
]);

export const C12_31_AUREOLE_SOURCE_KEYS = Object.freeze([
  "skyAtmosphere",
  "dynamicLightingType",
  "skyLightSelector",
  "scene",
  "environmentRenderer",
  "webglSkyShader",
  "webglSkyVertexShader",
  "webglSkyCommon",
  "atmosphereCommon",
  "webgpuRenderer",
  "webgpuAtmosphereUniforms",
  "wgslSky",
]);

export const C12_31_AUREOLE_PUBLICATION_ORDER = Object.freeze([
  "exclusive-lock",
  "owned-running-latest",
  "uuid-pngs",
  "immutable-run",
  "write-once-first-red-if-red",
  "byte-identical-final-latest",
  "successor-preserving-unlock",
]);

const SHOT_OFFSETS = Object.freeze({
  toward: 0,
  left60: -60,
  right60: 60,
  anti: 180,
  night: 0,
});

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isC1231UuidV4(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
    value ?? "",
  );
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function angularDistanceDegrees(left, right) {
  const delta = Math.abs(normalizedDegrees(left) - normalizedDegrees(right));
  return Math.min(delta, 360 - delta);
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function cross(left, right) {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function subtract(left, right) {
  return left.map((value, index) => value - right[index]);
}

function normalize(vector) {
  const magnitude = Math.hypot(...vector);
  return magnitude > 0 ? vector.map((value) => value / magnitude) : null;
}

function vectorClose(left, right, tolerance) {
  return (
    finiteVector(left, right?.length) &&
    finiteVector(right, left.length) &&
    left.every((value, index) => approximately(value, right[index], tolerance))
  );
}

function wgs84Frame() {
  const longitude = (C12_31_AUREOLE_SITE.longitudeDegrees * Math.PI) / 180;
  const latitude = (C12_31_AUREOLE_SITE.latitudeDegrees * Math.PI) / 180;
  const a = 6_378_137;
  const e2 = 6.6943799901413165e-3;
  const sinLat = Math.sin(latitude);
  const cosLat = Math.cos(latitude);
  const sinLon = Math.sin(longitude);
  const cosLon = Math.cos(longitude);
  const radius = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  const h = C12_31_AUREOLE_SITE.heightMeters;
  const position = [
    (radius + h) * cosLat * cosLon,
    (radius + h) * cosLat * sinLon,
    (radius * (1 - e2) + h) * sinLat,
  ];
  return {
    position,
    east: [-sinLon, cosLon, 0],
    north: [-sinLat * cosLon, -sinLat * sinLon, cosLat],
    up: [cosLat * cosLon, cosLat * sinLon, sinLat],
  };
}

function localToFixed(local, frame) {
  return [0, 1, 2].map(
    (index) =>
      frame.east[index] * local[0] +
      frame.north[index] * local[1] +
      frame.up[index] * local[2],
  );
}

function expectedCameraBasis(headingDegrees) {
  const frame = wgs84Frame();
  const heading = (headingDegrees * Math.PI) / 180;
  const pitch = (C12_31_AUREOLE_PITCH_DEGREES * Math.PI) / 180;
  const directionLocal = [
    Math.sin(heading) * Math.cos(pitch),
    Math.cos(heading) * Math.cos(pitch),
    Math.sin(pitch),
  ];
  const rightLocal = [Math.cos(heading), -Math.sin(heading), 0];
  const upLocal = cross(rightLocal, directionLocal);
  return {
    positionWC: frame.position,
    directionWC: localToFixed(directionLocal, frame),
    rightWC: localToFixed(rightLocal, frame),
    upWC: localToFixed(upLocal, frame),
  };
}

export function requestedAureoleShotState(shotId) {
  if (!C12_31_AUREOLE_SHOTS.includes(shotId)) {
    throw new Error(`unknown C12-31 aureole shot ${String(shotId)}`);
  }
  const night = shotId === "night";
  return {
    timeIso: night ? C12_31_AUREOLE_NIGHT_ISO : C12_31_AUREOLE_DAY_ISO,
    site: { ...C12_31_AUREOLE_SITE },
    camera: {
      headingPolicy: "astronomical-sun-relative",
      headingOffsetDegrees: SHOT_OFFSETS[shotId],
      pitchDegrees: C12_31_AUREOLE_PITCH_DEGREES,
      rollDegrees: 0,
    },
    scene: {
      mode: 3,
      globeShown: true,
      globeTilesRequired: true,
      globeGroundAtmosphereShown: false,
      globeEnableLighting: false,
      skyAtmosphereShown: true,
      skyBoxShown: false,
      starFieldShown: false,
      sunShown: false,
      moonShown: false,
      fogEnabled: false,
      highDynamicRange: false,
      bloomEnabled: false,
      fxaaEnabled: false,
      ambientOcclusionEnabled: false,
      requestRenderMode: false,
      dynamicLightingEnum: 0,
    },
    viewport: { ...C12_31_AUREOLE_VIEWPORT },
    measuredRows: [0, 0.45],
    captureMethod: C12_31_AUREOLE_CAPTURE_METHOD,
  };
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const diagonalDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= diagonalDistance) {
    return left;
  }
  return aboveDistance <= diagonalDistance ? above : upperLeft;
}

function unfilterRgba(inflated, width, height) {
  const stride = width * 4;
  const expectedLength = height * (stride + 1);
  if (inflated.byteLength !== expectedLength) {
    throw new Error(
      `inflated PNG bytes ${inflated.byteLength} != expected ${expectedLength}`,
    );
  }
  const pixels = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[sourceOffset++];
    if (filter > 4) {
      throw new Error(`unsupported PNG row filter ${filter}`);
    }
    for (let x = 0; x < stride; x++) {
      const encoded = inflated[sourceOffset++];
      const target = y * stride + x;
      const left = x >= 4 ? pixels[target - 4] : 0;
      const above = y > 0 ? pixels[target - stride] : 0;
      const upperLeft = y > 0 && x >= 4 ? pixels[target - stride - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      if (filter === 2) predictor = above;
      if (filter === 3) predictor = Math.floor((left + above) / 2);
      if (filter === 4) predictor = paeth(left, above, upperLeft);
      pixels[target] = (encoded + predictor) & 0xff;
    }
  }
  return pixels;
}

export function scoreAureoleRgba(pixels, width, height) {
  const y0 = 0;
  const y1 = Math.floor(height * 0.45);
  let sum = 0;
  let sampleCount = 0;
  let peak = 0;
  let peakX = 0;
  let peakY = 0;
  let weightSum = 0;
  let weightedX = 0;
  let nonBlackPixels = 0;
  let alphaMinimum = 255;
  let alphaMaximum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const alpha = pixels[offset + 3];
      const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
      sum += luminance;
      sampleCount++;
      if (red !== 0 || green !== 0 || blue !== 0) nonBlackPixels++;
      alphaMinimum = Math.min(alphaMinimum, alpha);
      alphaMaximum = Math.max(alphaMaximum, alpha);
      if (luminance > peak) {
        peak = luminance;
        peakX = x;
        peakY = y;
      }
      const weight = Math.pow(luminance / 255, 4);
      weightSum += weight;
      weightedX += weight * (x / (width - 1));
    }
  }
  return {
    measuredRows: [0, 0.45],
    sampleCount,
    mean: sampleCount > 0 ? sum / sampleCount : 0,
    peak,
    peakXFraction: width > 1 ? peakX / (width - 1) : 0,
    peakYFraction: height > 1 ? peakY / (height - 1) : 0,
    centroidX: weightSum > 1e-9 ? weightedX / weightSum : 0.5,
    luminanceWeight: weightSum,
    nonBlackPixels,
    alphaMinimum,
    alphaMaximum,
  };
}

/** Strictly inspect and decode the exact persisted Canvas PNG bytes. */
export function inspectAureolePng(bytesInput) {
  const reasons = [];
  const bytes = Buffer.isBuffer(bytesInput)
    ? bytesInput
    : Buffer.from(bytesInput ?? []);
  if (bytes.byteLength <= PNG_SIGNATURE.byteLength) {
    return { ok: false, reasons: ["PNG is empty or truncated"] };
  }
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, reasons: ["PNG signature is invalid"] };
  }

  let offset = 8;
  let ihdr = null;
  let sawIend = false;
  let idatStarted = false;
  let idatEnded = false;
  const compressed = [];
  const chunkTypes = [];
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) {
      reasons.push("PNG chunk framing is truncated");
      break;
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    const next = crcOffset + 4;
    if (next > bytes.byteLength) {
      reasons.push("PNG chunk length escapes the file");
      break;
    }
    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) {
      reasons.push("PNG chunk type is invalid");
    }
    const data = bytes.subarray(dataStart, dataEnd);
    const expectedCrc = bytes.readUInt32BE(crcOffset);
    const actualCrc = crc32(Buffer.concat([typeBytes, data]));
    if (actualCrc !== expectedCrc) {
      reasons.push(`${type || "unknown"} PNG chunk CRC is invalid`);
    }
    chunkTypes.push(type);
    if (type === "IHDR") {
      if (ihdr !== null || chunkTypes.length !== 1 || length !== 13) {
        reasons.push("PNG must contain one first 13-byte IHDR");
      } else {
        ihdr = {
          width: data.readUInt32BE(0),
          height: data.readUInt32BE(4),
          bitDepth: data[8],
          colorType: data[9],
          compressionMethod: data[10],
          filterMethod: data[11],
          interlaceMethod: data[12],
        };
      }
    } else if (type === "IDAT") {
      if (idatEnded) reasons.push("PNG IDAT chunks are not consecutive");
      idatStarted = true;
      compressed.push(data);
    } else {
      if (idatStarted && type !== "IEND") idatEnded = true;
      if (type === "IEND") {
        if (sawIend || length !== 0) reasons.push("PNG IEND is invalid");
        sawIend = true;
        if (next !== bytes.byteLength) reasons.push("PNG has bytes after IEND");
      } else if ((typeBytes[0] & 0x20) === 0 && type !== "IHDR") {
        reasons.push(`unsupported critical PNG chunk ${type}`);
      }
    }
    offset = next;
    if (type === "IEND") break;
  }

  if (ihdr === null) reasons.push("PNG IHDR is absent");
  if (!idatStarted || compressed.length === 0)
    reasons.push("PNG IDAT is absent");
  if (!sawIend) reasons.push("PNG IEND is absent");
  if (
    ihdr &&
    (ihdr.width !== C12_31_AUREOLE_VIEWPORT.width ||
      ihdr.height !== C12_31_AUREOLE_VIEWPORT.height)
  ) {
    reasons.push("PNG dimensions differ from the frozen viewport");
  }
  if (
    ihdr &&
    (ihdr.bitDepth !== 8 ||
      ihdr.colorType !== 6 ||
      ihdr.compressionMethod !== 0 ||
      ihdr.filterMethod !== 0 ||
      ihdr.interlaceMethod !== 0)
  ) {
    reasons.push("PNG is not non-interlaced 8-bit RGBA with standard methods");
  }

  let pixels;
  if (reasons.length === 0) {
    try {
      const expectedInflatedLength = ihdr.height * (ihdr.width * 4 + 1);
      const inflated = inflateSync(Buffer.concat(compressed), {
        maxOutputLength: expectedInflatedLength,
      });
      pixels = unfilterRgba(inflated, ihdr.width, ihdr.height);
    } catch (error) {
      reasons.push(
        `PNG zlib/scanline decode failed: ${error?.message ?? error}`,
      );
    }
  }
  if (reasons.length > 0) return { ok: false, reasons };

  const metrics = scoreAureoleRgba(pixels, ihdr.width, ihdr.height);
  return {
    ok: true,
    reasons: [],
    proof: {
      signatureValid: true,
      framingValid: true,
      crcValid: true,
      zlibValid: true,
      width: ihdr.width,
      height: ihdr.height,
      bitDepth: ihdr.bitDepth,
      colorType: ihdr.colorType,
      interlaceMethod: ihdr.interlaceMethod,
      chunkTypes,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    },
    metrics,
    pixels,
  };
}

function validFingerprint(value) {
  return (
    value?.exists === true &&
    Number.isInteger(value?.byteLength) &&
    value.byteLength > 0 &&
    /^[0-9a-f]{64}$/u.test(value?.sha256 ?? "")
  );
}

function boundedDiagnosticArray(value) {
  return (
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (entry) =>
        typeof entry === "string" && entry.length > 0 && entry.length <= 4096,
    )
  );
}

function loopbackHost(hostname) {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

function validLoopbackOrigin(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      loopbackHost(parsed.hostname) &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function validConsumedRuntimeUrl(value) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" &&
      loopbackHost(parsed.hostname) &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/Build/CesiumUnminified/index.js" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

function validateCameraAndSun(shot, shotId, reasons, label) {
  const observed = shot?.observedState;
  const camera = observed?.camera;
  const sun = observed?.sunFrame;
  const frame = wgs84Frame();
  if (!finiteVector(camera?.positionWC, 3)) {
    reasons.push(`${label}: camera position is absent or nonfinite`);
  } else if (!vectorClose(camera.positionWC, frame.position, 1e-3)) {
    reasons.push(`${label}: camera position is not the exact WGS84 site`);
  }
  if (
    !finiteVector(sun?.inertialWC, 3) ||
    !finiteVector(sun?.icrfToFixedMatrix, 9) ||
    !finiteVector(sun?.fixedWC, 3) ||
    !finiteVector(sun?.directionWC, 3) ||
    !finiteVector(sun?.localENU, 3) ||
    !finite(sun?.azimuthDegrees) ||
    !finite(sun?.elevationDegrees)
  ) {
    reasons.push(`${label}: astronomical Sun frame is incomplete or nonfinite`);
    return;
  }
  const matrix = sun.icrfToFixedMatrix;
  const inertial = sun.inertialWC;
  const columns = [
    [matrix[0], matrix[1], matrix[2]],
    [matrix[3], matrix[4], matrix[5]],
    [matrix[6], matrix[7], matrix[8]],
  ];
  const determinant = dot(columns[0], cross(columns[1], columns[2]));
  if (
    !columns.every((column) =>
      approximately(Math.hypot(...column), 1, 1e-10),
    ) ||
    !approximately(dot(columns[0], columns[1]), 0, 1e-10) ||
    !approximately(dot(columns[0], columns[2]), 0, 1e-10) ||
    !approximately(dot(columns[1], columns[2]), 0, 1e-10) ||
    !approximately(determinant, 1, 1e-10)
  ) {
    reasons.push(
      `${label}: ICRF-to-fixed matrix is not a proper orthonormal transform`,
    );
  }
  const expectedFixed = [
    matrix[0] * inertial[0] + matrix[3] * inertial[1] + matrix[6] * inertial[2],
    matrix[1] * inertial[0] + matrix[4] * inertial[1] + matrix[7] * inertial[2],
    matrix[2] * inertial[0] + matrix[5] * inertial[1] + matrix[8] * inertial[2],
  ];
  if (!vectorClose(sun.fixedWC, expectedFixed, 1e-2)) {
    reasons.push(
      `${label}: fixed Sun vector is not the reported ICRF transform`,
    );
  }
  const expectedDirection = normalize(subtract(sun.fixedWC, frame.position));
  if (
    !expectedDirection ||
    !vectorClose(sun.directionWC, expectedDirection, 1e-12)
  ) {
    reasons.push(
      `${label}: Sun direction is not the normalized site-to-Sun vector`,
    );
  }
  const expectedLocal = [
    dot(sun.directionWC, frame.east),
    dot(sun.directionWC, frame.north),
    dot(sun.directionWC, frame.up),
  ];
  if (!vectorClose(sun.localENU, expectedLocal, 1e-12)) {
    reasons.push(`${label}: Sun ENU vector is inconsistent with WGS84`);
  }
  const expectedAzimuth = normalizedDegrees(
    (Math.atan2(expectedLocal[0], expectedLocal[1]) * 180) / Math.PI,
  );
  const expectedElevation =
    (Math.asin(Math.max(-1, Math.min(1, expectedLocal[2]))) * 180) / Math.PI;
  if (angularDistanceDegrees(sun.azimuthDegrees, expectedAzimuth) > 1e-9) {
    reasons.push(`${label}: Sun azimuth is inconsistent with its ENU vector`);
  }
  if (!approximately(sun.elevationDegrees, expectedElevation, 1e-9)) {
    reasons.push(`${label}: Sun elevation is inconsistent with its ENU vector`);
  }
  if (
    shotId === "night" ? sun.elevationDegrees > -5 : sun.elevationDegrees < 10
  ) {
    reasons.push(
      `${label}: pinned Sun elevation does not satisfy the lane setup`,
    );
  }

  const expectedHeading = normalizedDegrees(
    sun.azimuthDegrees + SHOT_OFFSETS[shotId],
  );
  if (
    !finite(camera?.headingDegrees) ||
    angularDistanceDegrees(camera.headingDegrees, expectedHeading) > 1e-8 ||
    !approximately(camera?.pitchDegrees, C12_31_AUREOLE_PITCH_DEGREES, 1e-8) ||
    !approximately(camera?.rollDegrees, 0, 1e-8)
  ) {
    reasons.push(
      `${label}: observed camera angles differ from the Sun-relative request`,
    );
  }
  const expectedBasis = expectedCameraBasis(expectedHeading);
  for (const key of ["directionWC", "upWC", "rightWC"]) {
    if (!vectorClose(camera?.[key], expectedBasis[key], 1e-9)) {
      reasons.push(
        `${label}: camera ${key} differs from the WGS84 requested basis`,
      );
    }
  }
  if (
    finiteVector(camera?.directionWC, 3) &&
    finiteVector(camera?.upWC, 3) &&
    finiteVector(camera?.rightWC, 3) &&
    (!approximately(Math.hypot(...camera.directionWC), 1, 1e-10) ||
      !approximately(Math.hypot(...camera.upWC), 1, 1e-10) ||
      !approximately(Math.hypot(...camera.rightWC), 1, 1e-10) ||
      !approximately(dot(camera.directionWC, camera.upWC), 0, 1e-10) ||
      !approximately(dot(camera.directionWC, camera.rightWC), 0, 1e-10) ||
      !approximately(dot(camera.upWC, camera.rightWC), 0, 1e-10))
  ) {
    reasons.push(`${label}: camera basis is not finite orthonormal evidence`);
  }
}

function validateImageAndMetrics(
  shot,
  renderer,
  shotId,
  runId,
  reasons,
  unscored,
) {
  const image = shot?.image;
  const metrics = shot?.metrics;
  const label = `${renderer}/${shotId}`;
  const expectedFile = `${C12_31_AUREOLE_ARTIFACT_PREFIX}.${runId}.${renderer}.${shotId}.png`;
  if (image?.file !== expectedFile) {
    reasons.push(`${label}: image is not the exact UUID PNG filename`);
  }
  const proof = image?.pngProof;
  if (
    proof?.signatureValid !== true ||
    proof?.framingValid !== true ||
    proof?.crcValid !== true ||
    proof?.zlibValid !== true ||
    proof?.width !== C12_31_AUREOLE_VIEWPORT.width ||
    proof?.height !== C12_31_AUREOLE_VIEWPORT.height ||
    proof?.bitDepth !== 8 ||
    proof?.colorType !== 6 ||
    proof?.interlaceMethod !== 0 ||
    !Array.isArray(proof?.chunkTypes) ||
    proof.chunkTypes[0] !== "IHDR" ||
    proof.chunkTypes.at(-1) !== "IEND" ||
    !proof.chunkTypes.includes("IDAT") ||
    !Number.isInteger(proof?.byteLength) ||
    proof.byteLength <= 64 ||
    !/^[0-9a-f]{64}$/u.test(proof?.sha256 ?? "")
  ) {
    reasons.push(
      `${label}: strict PNG framing/dimensions/CRC/zlib proof is invalid`,
    );
  }
  const immutable = image?.immutableFile;
  if (
    !validFingerprint(immutable) ||
    immutable.file !== expectedFile ||
    immutable.byteLength !== proof?.byteLength ||
    immutable.sha256 !== proof?.sha256
  ) {
    reasons.push(`${label}: immutable UUID PNG fingerprint is invalid`);
  }
  if (
    image?.captureSha256 !== proof?.sha256 ||
    image?.scoredSha256 !== proof?.sha256 ||
    image?.captureByteLength !== proof?.byteLength ||
    image?.scoredByteLength !== proof?.byteLength ||
    image?.singleCapture !== true
  ) {
    reasons.push(`${label}: scored bytes are not the one persisted capture`);
  }
  const expectedSamples =
    C12_31_AUREOLE_VIEWPORT.width *
    Math.floor(C12_31_AUREOLE_VIEWPORT.height * 0.45);
  if (
    !sameJson(metrics?.measuredRows, [0, 0.45]) ||
    metrics?.sampleCount !== expectedSamples ||
    !finite(metrics?.mean) ||
    metrics.mean < 0 ||
    metrics.mean > 255 ||
    !finite(metrics?.peak) ||
    metrics.peak < 0 ||
    metrics.peak > 255 ||
    !finite(metrics?.peakXFraction) ||
    metrics.peakXFraction < 0 ||
    metrics.peakXFraction > 1 ||
    !finite(metrics?.peakYFraction) ||
    metrics.peakYFraction < 0 ||
    metrics.peakYFraction > 0.45 ||
    !finite(metrics?.centroidX) ||
    metrics.centroidX < 0 ||
    metrics.centroidX > 1 ||
    !finite(metrics?.luminanceWeight) ||
    metrics.luminanceWeight < 0 ||
    !Number.isInteger(metrics?.nonBlackPixels) ||
    metrics.nonBlackPixels < 0 ||
    metrics.nonBlackPixels > expectedSamples ||
    metrics?.alphaMinimum !== 255 ||
    metrics?.alphaMaximum !== 255
  ) {
    reasons.push(
      `${label}: persisted-image metrics are absent, nonfinite, or invalid`,
    );
    unscored.push(`${label}: no trustworthy persisted-image score`);
  }
}

function validateShot(shot, renderer, shotId, runId, reasons, unscored) {
  const label = `${renderer}/${shotId}`;
  if (shot?.id !== shotId) reasons.push(`${label}: shot identity is not exact`);
  if (!sameJson(shot?.requestedState, requestedAureoleShotState(shotId))) {
    reasons.push(`${label}: requested state differs from the frozen request`);
  }
  const observed = shot?.observedState;
  const expectedTime =
    shotId === "night" ? C12_31_AUREOLE_NIGHT_ISO : C12_31_AUREOLE_DAY_ISO;
  if (
    observed?.timeIso !== expectedTime ||
    observed?.clock?.currentTimeIso !== expectedTime ||
    observed?.clock?.startTimeIso !== expectedTime ||
    observed?.clock?.stopTimeIso !== expectedTime ||
    observed?.clock?.shouldAnimate !== false ||
    observed?.clock?.multiplier !== 0
  ) {
    reasons.push(`${label}: observed pinned clock differs from the request`);
  }
  if (!sameJson(observed?.scene, requestedAureoleShotState(shotId).scene)) {
    reasons.push(`${label}: observed isolation/HDR/effects state differs`);
  }
  validateCameraAndSun(shot, shotId, reasons, label);
  const readiness = shot?.readiness;
  if (
    readiness?.bounded !== true ||
    readiness?.maximumFrames !== C12_31_AUREOLE_MAX_SETTLE_FRAMES ||
    !Number.isInteger(readiness?.frames) ||
    readiness.frames < 0 ||
    readiness.frames > C12_31_AUREOLE_MAX_SETTLE_FRAMES ||
    readiness?.settled !== true ||
    readiness?.globeTilesLoaded !== true ||
    readiness?.icrfToFixedResolved !== true ||
    readiness?.transformMethod !== "Transforms.computeIcrfToFixedMatrix" ||
    readiness?.ecefFallbackUsed !== false
  ) {
    reasons.push(`${label}: bounded readiness/ICRF transform proof is false`);
  }
  const draw = shot?.drawWitness;
  if (
    draw?.armedBeforeCapture !== true ||
    draw?.ownerIsSkyAtmosphere !== true ||
    draw?.commandIsEnvironmentSkyAtmosphere !== true ||
    draw?.skyAtmosphereVisible !== true ||
    !Number.isInteger(draw?.snapshotFrameNumber) ||
    draw.snapshotFrameNumber < 1 ||
    draw?.executedFrameNumber !== draw.snapshotFrameNumber ||
    draw?.postToDataUrlFrameNumber !== draw.snapshotFrameNumber ||
    !Number.isInteger(draw?.executionCountAtSnapshot) ||
    draw.executionCountAtSnapshot < 1 ||
    draw?.witnessSealedBeforeDecode !== true ||
    draw?.executeRestoredBeforeDecode !== true
  ) {
    reasons.push(
      `${label}: current-frame real sky draw-command witness is absent/stale`,
    );
  }
  validateImageAndMetrics(shot, renderer, shotId, runId, reasons, unscored);
}

function validateSession(session, renderer, runId, reasons, errors, unscored) {
  if (
    session?.requestedRenderer !== renderer ||
    session?.observedRenderer !== renderer ||
    session?.rendererTruth !== true
  ) {
    reasons.push(`${renderer}: requested/observed renderer truth failed`);
  }
  const shots = Array.isArray(session?.shots) ? session.shots : [];
  if (
    !sameJson(
      shots.map((shot) => shot?.id),
      C12_31_AUREOLE_SHOTS,
    )
  ) {
    reasons.push(
      `${renderer}: exact ordered shot set is missing, duplicated, or extra`,
    );
  }
  for (const shotId of C12_31_AUREOLE_SHOTS) {
    const matches = shots.filter((shot) => shot?.id === shotId);
    if (matches.length === 1) {
      validateShot(matches[0], renderer, shotId, runId, reasons, unscored);
    } else {
      unscored.push(`${renderer}/${shotId}: exact shot is unavailable`);
    }
  }
  const gate = session?.errorGate;
  if (
    gate?.armedBeforeNavigation !== true ||
    gate?.consoleListenerArmed !== true ||
    gate?.pageErrorListenerArmed !== true ||
    gate?.runtimeErrorListenerArmed !== true ||
    gate?.unhandledRejectionListenerArmed !== true ||
    (renderer === "webgpu" &&
      (gate?.gpuErrorScopesArmed !== true ||
        gate?.uncapturedErrorListenerArmed !== true ||
        gate?.deviceLossListenerArmed !== true)) ||
    (renderer === "webgl" &&
      (gate?.gpuErrorScopesArmed !== null ||
        gate?.uncapturedErrorListenerArmed !== null ||
        gate?.deviceLossListenerArmed !== null))
  ) {
    reasons.push(`${renderer}: renderer error gate was not armed in time`);
  }
  for (const key of [
    "consoleErrors",
    "pageErrors",
    "runtimeErrors",
    "unhandledRejections",
    "gpuErrors",
    "deviceLosses",
  ]) {
    if (!Array.isArray(session?.[key])) {
      reasons.push(`${renderer}: ${key} diagnostics are absent`);
    } else if (session[key].length > 0) {
      errors.push(
        ...session[key].map((entry) => `${renderer}/${key}: ${entry}`),
      );
    }
  }
  const completion = session?.gpuCompletion;
  const expectedMethod =
    renderer === "webgpu"
      ? "GPUQueue.onSubmittedWorkDone"
      : "WebGLRenderingContext.finish";
  if (
    completion?.method !== expectedMethod ||
    completion?.complete !== true ||
    completion?.afterLastCapture !== true ||
    completion?.lateErrorTurns !== 2
  ) {
    reasons.push(
      `${renderer}: GPU completion/late-error drain is not certified`,
    );
  }
}

function validateProvenance(report, reasons) {
  const provenance = report?.provenance;
  const start = provenance?.filesAtStart;
  const end = provenance?.filesAtEnd;
  if (
    !sameJson(
      Object.keys(start ?? {}).sort(),
      [...C12_31_AUREOLE_PROVENANCE_KEYS].sort(),
    ) ||
    !sameJson(
      Object.keys(end ?? {}).sort(),
      [...C12_31_AUREOLE_PROVENANCE_KEYS].sort(),
    )
  ) {
    reasons.push("provenance start/end file key set is not exact");
  }
  for (const key of C12_31_AUREOLE_PROVENANCE_KEYS) {
    if (!validFingerprint(start?.[key]) || !validFingerprint(end?.[key])) {
      reasons.push(`${key}: local provenance fingerprint is invalid`);
    } else if (
      start[key].byteLength !== end[key].byteLength ||
      start[key].sha256 !== end[key].sha256
    ) {
      reasons.push(`${key}: local bytes changed during the run`);
    }
  }
  const sourceIdentity = provenance?.buildSourceIdentity;
  if (sourceIdentity?.ok !== true) {
    reasons.push("build source identity did not pass");
  }
  const entries = Array.isArray(sourceIdentity?.entries)
    ? sourceIdentity.entries
    : [];
  if (
    !sameJson(
      entries.map((entry) => entry?.key),
      C12_31_AUREOLE_SOURCE_KEYS,
    )
  ) {
    reasons.push("build source identity entry set/order is not exact");
  }
  for (const entry of entries) {
    const local = start?.[entry?.key];
    if (
      entry?.exact !== true ||
      entry?.currentByteLength !== local?.byteLength ||
      entry?.currentSha256 !== local?.sha256 ||
      entry?.embeddedByteLength !== local?.byteLength ||
      entry?.embeddedSha256 !== local?.sha256
    ) {
      reasons.push(`${String(entry?.key)}: stale local/build source bytes`);
    }
  }
  const buildEntry = start?.buildEntry;
  const served = Array.isArray(provenance?.servedEntries)
    ? provenance.servedEntries
    : [];
  if (
    !sameJson(
      served.map((entry) => entry?.requestedRenderer),
      C12_31_AUREOLE_RENDERERS,
    )
  ) {
    reasons.push("served runtime identity set/order is not exact");
  }
  for (const entry of served) {
    if (
      entry?.observedRenderer !== entry?.requestedRenderer ||
      entry?.status !== 200 ||
      entry?.byteLength !== buildEntry?.byteLength ||
      entry?.sha256 !== buildEntry?.sha256
    ) {
      reasons.push(
        `${String(entry?.requestedRenderer)}: stale or mismatched served runtime bytes`,
      );
    }
    // The bytes must be the ones the BROWSER consumed, taken off its own
    // response for the runtime script, and the URL it consumed them from must
    // be the loopback build entry. A probe-side fetch of the same URL proves
    // only that the server can serve those bytes, not that the page ran them —
    // the two diverge under any cache, redirect, or service-worker path.
    const consumed = entry?.consumedRuntime;
    if (
      consumed?.observedByBrowser !== true ||
      !validConsumedRuntimeUrl(consumed?.url) ||
      !validLoopbackOrigin(consumed?.origin) ||
      consumed?.status !== 200 ||
      consumed?.fromServiceWorker !== false ||
      consumed?.byteLength !== buildEntry?.byteLength ||
      consumed?.sha256 !== buildEntry?.sha256
    ) {
      reasons.push(
        `${String(entry?.requestedRenderer)}: browser-consumed runtime bytes are unbound`,
      );
    }
    // An offline lane that reached the network is not offline. Both the
    // attempt list and the succeeded list must be present and bounded, and the
    // succeeded list must be empty.
    if (
      !boundedDiagnosticArray(entry?.externalRequests) ||
      !boundedDiagnosticArray(entry?.externalResponsesSucceeded)
    ) {
      reasons.push(
        `${String(entry?.requestedRenderer)}: external transport diagnostics are absent or unbounded`,
      );
    } else if (entry.externalResponsesSucceeded.length > 0) {
      reasons.push(
        `${String(entry?.requestedRenderer)}: external transport succeeded: ${entry.externalResponsesSucceeded.join(", ")}`,
      );
    }
  }
  if (provenance?.stable !== true)
    reasons.push("provenance stability is false");
}

function predicateFailures(report) {
  const failures = [];
  for (const renderer of C12_31_AUREOLE_RENDERERS) {
    const session = report.sessions.find(
      (candidate) => candidate?.requestedRenderer === renderer,
    );
    if (!session || !Array.isArray(session.shots)) continue;
    const byId = new Map(session.shots.map((shot) => [shot.id, shot]));
    if (byId.size !== C12_31_AUREOLE_SHOTS.length) continue;
    const toward = byId.get("toward")?.metrics;
    const left = byId.get("left60")?.metrics;
    const right = byId.get("right60")?.metrics;
    const anti = byId.get("anti")?.metrics;
    const night = byId.get("night")?.metrics;
    if (![toward, left, right, anti, night].every(Boolean)) continue;
    for (const [id, metric] of [
      ["toward", toward],
      ["left60", left],
      ["right60", right],
      ["anti", anti],
    ]) {
      const minimumMean =
        id === "toward"
          ? C12_31_AUREOLE_THRESHOLDS.minimumTowardMean
          : C12_31_AUREOLE_THRESHOLDS.minimumDayMean;
      const minimumPeak =
        id === "toward"
          ? C12_31_AUREOLE_THRESHOLDS.minimumTowardPeak
          : C12_31_AUREOLE_THRESHOLDS.minimumDayPeak;
      if (
        !(metric.mean >= minimumMean) ||
        !(metric.peak >= minimumPeak) ||
        !(
          metric.nonBlackPixels >=
          C12_31_AUREOLE_THRESHOLDS.minimumDayNonBlackPixels
        ) ||
        !(metric.luminanceWeight > 0)
      ) {
        failures.push(`${renderer}/${id}: daytime atmosphere score is vacuous`);
      }
    }
    const contrast = toward.mean / Math.max(1e-6, anti.mean);
    if (!(contrast >= C12_31_AUREOLE_THRESHOLDS.minimumAzimuthContrast)) {
      failures.push(`${renderer}: L1 toward/anti contrast is below 1.25`);
    }
    const brightest = [
      ["toward", toward.mean],
      ["left60", left.mean],
      ["right60", right.mean],
      ["anti", anti.mean],
    ].reduce((best, value) => (value[1] > best[1] ? value : best))[0];
    if (brightest !== "toward") {
      failures.push(`${renderer}: L1 brightest daytime shot is not toward`);
    }
    if (
      !(left.centroidX > 0.5 + C12_31_AUREOLE_THRESHOLDS.minimumCentroidOffset)
    ) {
      failures.push(`${renderer}: L2 left60 centroid is not on the Sun side`);
    }
    if (
      !(right.centroidX < 0.5 - C12_31_AUREOLE_THRESHOLDS.minimumCentroidOffset)
    ) {
      failures.push(`${renderer}: L2 right60 centroid is not on the Sun side`);
    }
    const nightFraction = night.mean / Math.max(1e-6, toward.mean);
    if (
      !(nightFraction <= C12_31_AUREOLE_THRESHOLDS.maximumNightMeanFraction)
    ) {
      failures.push(`${renderer}: L3 night mean fraction exceeds 0.15`);
    }
    if (!(night.peak <= C12_31_AUREOLE_THRESHOLDS.maximumNightPeak)) {
      failures.push(`${renderer}: L3 night peak exceeds 40`);
    }
  }
  return failures;
}

export function evaluateC1231Aureole(report) {
  const structuralReasons = [];
  const errors = [];
  const unscored = [];
  if (report?.schema !== C12_31_AUREOLE_SCHEMA) {
    structuralReasons.push(
      "artifact schema is not the frozen C12-31 aureole schema",
    );
  }
  if (
    report?.scope !== C12_31_AUREOLE_SCOPE ||
    /full/iu.test(report?.scope ?? "")
  ) {
    structuralReasons.push(
      "scope must certify L1-L4 core only, never full C12-31",
    );
  }
  if (!isC1231UuidV4(report?.runId)) {
    structuralReasons.push("runId is not a lowercase UUID v4");
  }
  if (report?.captureMethod !== C12_31_AUREOLE_CAPTURE_METHOD) {
    structuralReasons.push(
      "capture method is not the frozen one-shot same-task method",
    );
  }
  if (!sameJson(report?.viewport, C12_31_AUREOLE_VIEWPORT)) {
    structuralReasons.push("viewport differs from the frozen viewport");
  }
  const sessions = Array.isArray(report?.sessions) ? report.sessions : [];
  if (
    !sameJson(
      sessions.map((session) => session?.requestedRenderer),
      C12_31_AUREOLE_RENDERERS,
    )
  ) {
    structuralReasons.push(
      "exact WebGL+WebGPU session set/order is missing, duplicated, or extra",
    );
  }
  for (const renderer of C12_31_AUREOLE_RENDERERS) {
    const matches = sessions.filter(
      (session) => session?.requestedRenderer === renderer,
    );
    if (matches.length === 1) {
      validateSession(
        matches[0],
        renderer,
        report?.runId,
        structuralReasons,
        errors,
        unscored,
      );
    } else {
      unscored.push(`${renderer}: exact renderer session is unavailable`);
    }
  }
  validateProvenance(report, structuralReasons);
  const lifecycle = report?.lifecycle;
  if (
    lifecycle?.lockOwned !== true ||
    lifecycle?.runningAuthority !== true ||
    lifecycle?.predecessorStable !== true ||
    lifecycle?.firstRedStable !== true ||
    lifecycle?.pngsImmutable !== true ||
    lifecycle?.foreignSuccessorPreserved !== true ||
    !sameJson(lifecycle?.publicationOrder, C12_31_AUREOLE_PUBLICATION_ORDER)
  ) {
    structuralReasons.push(
      "collision-safe evidence lifecycle proof is incomplete",
    );
  }

  const failedPredicates = predicateFailures({ ...report, sessions });
  const status =
    structuralReasons.length > 0 || unscored.length > 0
      ? "STRUCTURAL"
      : errors.length > 0
        ? "ERROR"
        : failedPredicates.length > 0
          ? "FAIL"
          : "PASS";
  // One frozen exit table for the whole fleet - never an in-file copy.
  const exitCode = exitCodeForS5Status(status);
  return {
    status,
    exitCode,
    structuralReasons,
    failedPredicates,
    errors,
    unscored,
  };
}

export function validateC1231AureoleFinalArtifact(report) {
  const evaluation = evaluateC1231Aureole(report);
  const reasons = [];
  if (report?.status !== evaluation.status)
    reasons.push("claimed status differs from the fold");
  if (report?.exitCode !== evaluation.exitCode)
    reasons.push("claimed exitCode differs from the fold");
  if (report?.incomplete !== false)
    reasons.push("final artifact must set incomplete=false");
  const diagnostics = report?.diagnostics;
  if (diagnostics?.schema !== C12_31_AUREOLE_DIAGNOSTICS_SCHEMA) {
    reasons.push("runtime diagnostics schema is not exact");
  }
  for (const key of [
    "structuralReasons",
    "failedPredicates",
    "errors",
    "unscored",
  ]) {
    if (!sameJson(diagnostics?.[key], evaluation[key])) {
      reasons.push(`diagnostics.${key} differs from the independent fold`);
    }
  }
  if (
    report?.status === "PASS" &&
    [
      evaluation.structuralReasons,
      evaluation.failedPredicates,
      evaluation.errors,
      evaluation.unscored,
    ].some((entries) => entries.length !== 0)
  ) {
    reasons.push("PASS contains structural/failure/error/unscored diagnostics");
  }
  return { ok: reasons.length === 0, reasons, evaluation };
}

export function finalizeC1231AureoleReport(report) {
  const evaluation = evaluateC1231Aureole(report);
  return {
    ...report,
    status: evaluation.status,
    exitCode: evaluation.exitCode,
    incomplete: false,
    diagnostics: {
      schema: C12_31_AUREOLE_DIAGNOSTICS_SCHEMA,
      structuralReasons: evaluation.structuralReasons,
      failedPredicates: evaluation.failedPredicates,
      errors: evaluation.errors,
      unscored: evaluation.unscored,
    },
  };
}
