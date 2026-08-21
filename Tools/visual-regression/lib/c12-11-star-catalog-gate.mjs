/**
 * Browser-free policy and evidence validator for the C12-11 star-catalog
 * certification lane.
 *
 * @purpose Fail-closed contract, verdict fold, PNG envelope and artifact validation for the C12-11 star-catalog lane; the probe cannot self-attest.
 * @status ACTIVE
 *
 * Acquisition belongs to probe-stars-catalog.mjs.  This module owns the
 * immutable contract, fail-closed verdict fold, PNG envelope validation, and
 * final-artifact validation so the browser script cannot self-attest a pass.
 */

import { createHash } from "node:crypto";
import { S5_STATUS_EXIT_CODES } from "./verdict-exit-gate.mjs";
import { inflateSync } from "node:zlib";

export const C12_11_STAR_CATALOG_SCHEMA =
  "c12-11-star-catalog-certification-evidence-v1";
export const C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA =
  "c12-11-star-catalog-runtime-diagnostics-v1";
export const C12_11_STAR_CATALOG_PROVENANCE_SCHEMA =
  "c12-11-star-catalog-provenance-v1";
export const C12_11_STAR_CATALOG_LOCK_SCHEMA =
  "c12-11-star-catalog-run-lock-v1";

export const C12_11_STAR_CATALOG_RENDERER = "webgpu";
export const C12_11_STAR_CATALOG_RUNTIME_PATH =
  "/Build/CesiumUnminified/index.js";
export const C12_11_STAR_CATALOG_VIEWER_PATH = "/Apps/CesiumViewer/index.html";
export const C12_11_STAR_CATALOG_BUILD_SOURCE_MAP =
  "Build/CesiumUnminified/index.js.map";
export const C12_11_STAR_CATALOG_OUTPUT_DIRECTORY =
  "Tools/visual-regression/output/c12-11-star-catalog";
export const C12_11_STAR_CATALOG_G3_REPORT =
  "Tools/visual-regression/output/celestial-g3.json";

export const C12_11_STAR_CATALOG_SCENE = Object.freeze({
  timeIso: "2026-06-21T00:00:00Z",
  viewport: Object.freeze({ width: 1024, height: 768 }),
  cameraAltitudeMeters: 8_000_000,
  siriusRaDegrees: 101.287,
  siriusDecDegrees: -16.716,
  brightThreshold: 40,
  centerHalfWidthFraction: 0.12,
  aimTolerancePixels: 6,
  highIntensity: 3.0,
  warmupFrames: 20,
  settleFrames: 8,
  offlinePrediction: Object.freeze({
    resolvedSources: 1,
    plateauRepresentative: Object.freeze({ x: 511, y: 383 }),
    description:
      "star-point-census-live synthetic Sirius splat at the 1024x768 even-pixel centre",
  }),
});

export const C12_11_STAR_CATALOG_CAPTURE_LABELS = Object.freeze([
  "off",
  "sirius",
  "blank",
  "bright",
]);

export const C12_11_STAR_CATALOG_CHECK_KEYS = Object.freeze([
  "A_sprites_add_resolved_sirius_source_at_aim",
  "B_sirius_aimed_box_is_brighter_than_blank",
  "C_sirius_source_present_and_blank_source_absent",
  "D_intensity_3_increases_bright_pixels",
  "E_live_starField_hook_present",
  "F_zero_runtime_page_console_webgpu_device_loss_errors",
  "G_cubemap_only_resolved_sources_le_2",
]);

// These are the four Batch-837 instrument-red images.  They are historical
// evidence, not mutable output names.  The hardened probe fingerprints them at
// both evidence boundaries and never opens any one for writing or deletion.
export const C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS = Object.freeze([
  Object.freeze({
    path: "Tools/visual-regression/output/stars-catalog/webgpu-blank.png",
    byteLength: 186_081,
    sha256: "d4b5d7152bf34afb5c061efbcf9a1aa0975dfcd4633af5df15a26167bde12a0e",
  }),
  Object.freeze({
    path: "Tools/visual-regression/output/stars-catalog/webgpu-bright.png",
    byteLength: 143_393,
    sha256: "4266bc11554369b05e56ca8d82347492b233b508bdfb77627fc3dafed250a206",
  }),
  Object.freeze({
    path: "Tools/visual-regression/output/stars-catalog/webgpu-off.png",
    byteLength: 138_390,
    sha256: "bd9c8ceb5edef45dbd7e004585c8a2fad2197d34f3457034e7ec847554132fdc",
  }),
  Object.freeze({
    path: "Tools/visual-regression/output/stars-catalog/webgpu-sirius.png",
    byteLength: 141_540,
    sha256: "4f7e9b60fa1891176c50d44a398dceb9fa4ea97d83f6b329fa8a0d80c9181ffb",
  }),
]);

// Raw shader sources and generated shader modules are both pinned locally.
// Only JavaScript/TypeScript modules participate in source-map identity.
export const C12_11_STAR_CATALOG_SOURCE_FILES = Object.freeze([
  "packages/engine/Source/Scene/BrightStarCatalog.js",
  "packages/engine/Source/Scene/StarFieldMath.ts",
  "packages/engine/Source/Scene/StarField.js",
  "packages/engine/Source/Scene/SkyBox.js",
  "packages/engine/Source/Scene/CubeMapPanorama.js",
  "packages/engine/Source/Scene/EnvironmentRenderer.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Renderer/FeatureRendererKey.js",
  "packages/engine/Source/Renderer/WebGLStarFieldRenderer.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUFeatureRenderers.ts",
  "packages/engine/Source/Renderer/WebGPU/WebGPUStarFieldRenderer.ts",
  "packages/engine/Source/Shaders/StarFieldVS.glsl",
  "packages/engine/Source/Shaders/StarFieldVS.js",
  "packages/engine/Source/Shaders/StarFieldFS.glsl",
  "packages/engine/Source/Shaders/StarFieldFS.js",
  "packages/engine/Source/Shaders/WebGPU/Catalog/StarField.wgsl",
  "packages/engine/Source/Shaders/WebGPU/Catalog/StarField.js",
  "Tools/lib/webgpu-error-gate.mjs",
  "Tools/skybox-bake/starmap-census.mjs",
  "Tools/visual-regression/star-point-census-live.spec.mjs",
  "Tools/visual-regression/skybox-diffuse-seam.spec.mjs",
  "Tools/visual-regression/lib/build-source-identity.mjs",
  "Tools/visual-regression/lib/c12-11-star-catalog-gate.mjs",
  "Tools/visual-regression/c12-11-star-catalog-gate.spec.mjs",
  "Tools/visual-regression/probe-stars-catalog.mjs",
]);

export const C12_11_STAR_CATALOG_BUILD_SOURCE_FILES = Object.freeze(
  C12_11_STAR_CATALOG_SOURCE_FILES.filter(
    (file) =>
      file.startsWith("packages/engine/Source/") &&
      (file.endsWith(".js") || file.endsWith(".ts")),
  ),
);

export const C12_11_STAR_CATALOG_G3_PREREQUISITE_FILES = Object.freeze([
  "Tools/visual-regression/probe-celestial-gates.mjs",
  "Tools/visual-regression/lib/celestial-g3-gate.mjs",
  "Tools/visual-regression/celestial-g3-gate.spec.mjs",
  C12_11_STAR_CATALOG_G3_REPORT,
]);

export const C12_11_STAR_CATALOG_EXIT_CODE = S5_STATUS_EXIT_CODES;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const FINAL_STATUSES = new Set(["PASS", "FAIL", "STRUCTURAL"]);

export const sha256C1211 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function isC1211UuidV4(value) {
  return typeof value === "string" && UUID_V4.test(value);
}

export function exitCodeForC1211StarCatalogStatus(status) {
  return Object.hasOwn(C12_11_STAR_CATALOG_EXIT_CODE, status)
    ? C12_11_STAR_CATALOG_EXIT_CODE[status]
    : C12_11_STAR_CATALOG_EXIT_CODE.ERROR;
}

function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("star-catalog evidence contains a non-finite number");
    return value;
  }
  if (Array.isArray(value))
    return value.map((entry) => canonicalize(entry, seen));
  if (typeof value !== "object")
    throw new TypeError("star-catalog evidence is not JSON-compatible");
  if (seen.has(value)) throw new TypeError("star-catalog evidence is cyclic");
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined)
      throw new TypeError(`star-catalog evidence field ${key} is undefined`);
    result[key] = canonicalize(entry, seen);
  }
  seen.delete(value);
  return result;
}

export function stableC1211StarCatalogJson(value, space = 0) {
  return JSON.stringify(canonicalize(value), null, space);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function exactArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => Object.is(entry, expected[index]))
  );
}

function stringArray(value) {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function boundedStringArray(value) {
  return (
    stringArray(value) &&
    value.length <= 32 &&
    value.every((entry) => entry.length <= 4096)
  );
}

function validHash(value) {
  return typeof value === "string" && SHA256.test(value);
}

function validIdentity(value, expectedPath) {
  return (
    exactKeys(value, ["path", "byteLength", "sha256"]) &&
    value.path === expectedPath &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0 &&
    validHash(value.sha256)
  );
}

function validServedRuntimeUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.pathname === C12_11_STAR_CATALOG_RUNTIME_PATH &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function sameJson(left, right) {
  try {
    return (
      stableC1211StarCatalogJson(left) === stableC1211StarCatalogJson(right)
    );
  } catch {
    return false;
  }
}

function readU32(bytes, offset) {
  return bytes.readUInt32BE(offset);
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit++)
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
  }
  let value = 0xffffffff;
  for (const byte of bytes)
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Validate PNG framing, all chunk CRCs, IHDR dimensions, and terminal IEND. */
export function inspectC1211Png(bytesLike) {
  const bytes = Buffer.from(bytesLike ?? []);
  const reasons = [];
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature)) {
    return {
      ok: false,
      width: null,
      height: null,
      reasons: ["PNG signature is invalid"],
    };
  }
  let offset = 8;
  let width = null;
  let height = null;
  let ihdrCount = 0;
  let idatCount = 0;
  let iendCount = 0;
  let terminalIend = false;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      reasons.push("PNG chunk extends beyond the file");
      break;
    }
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = readU32(bytes, offset + 8 + length);
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (expectedCrc !== actualCrc)
      reasons.push(`${type} PNG chunk CRC is invalid`);
    if (type === "IHDR") {
      ihdrCount += 1;
      if (offset !== 8 || length !== 13)
        reasons.push("PNG IHDR placement/length is invalid");
      else {
        width = readU32(data, 0);
        height = readU32(data, 4);
        if (
          data[8] !== 8 ||
          data[9] !== 6 ||
          data[10] !== 0 ||
          data[11] !== 0 ||
          data[12] !== 0
        )
          reasons.push(
            "PNG is not canonical 8-bit RGBA/non-interlaced evidence",
          );
      }
    } else if (type === "IDAT") {
      idatCount += 1;
    } else if (type === "IEND") {
      iendCount += 1;
      if (length !== 0) reasons.push("PNG IEND is non-empty");
      terminalIend = end === bytes.length;
      break;
    }
    offset = end;
  }
  if (ihdrCount !== 1) reasons.push("PNG must contain exactly one IHDR");
  if (idatCount < 1) reasons.push("PNG contains no IDAT data");
  if (iendCount !== 1 || !terminalIend)
    reasons.push("PNG has no terminal IEND");
  if (
    width !== C12_11_STAR_CATALOG_SCENE.viewport.width ||
    height !== C12_11_STAR_CATALOG_SCENE.viewport.height
  )
    reasons.push("PNG dimensions differ from the frozen 1024x768 viewport");
  return { ok: reasons.length === 0, width, height, reasons };
}

function paethPredictor(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) return left;
  return upDistance <= upLeftDistance ? up : upLeft;
}

/** Decode the exact 8-bit RGBA PNG envelope accepted above. */
export function decodeC1211RgbaPng(bytesLike) {
  const bytes = Buffer.from(bytesLike ?? []);
  const inspected = inspectC1211Png(bytes);
  if (!inspected.ok)
    throw new Error(
      `cannot decode invalid C12-11 PNG: ${inspected.reasons.join("; ")}`,
    );
  const compressed = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT")
      compressed.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === "IEND") break;
  }
  const width = inspected.width;
  const height = inspected.height;
  const bytesPerPixel = 4;
  const stride = width * bytesPerPixel;
  const expectedInflatedBytes = (stride + 1) * height;
  const filtered = inflateSync(Buffer.concat(compressed), {
    maxOutputLength: expectedInflatedBytes,
  });
  if (filtered.byteLength !== expectedInflatedBytes)
    throw new Error("C12-11 PNG inflated byte length is invalid");
  const rgba = Buffer.allocUnsafe(stride * height);
  let input = 0;
  for (let y = 0; y < height; y++) {
    const filter = filtered[input++];
    if (filter > 4)
      throw new Error(`unsupported C12-11 PNG row filter ${filter}`);
    const row = y * stride;
    const prior = row - stride;
    for (let x = 0; x < stride; x++) {
      const raw = filtered[input++];
      const left = x >= bytesPerPixel ? rgba[row + x - bytesPerPixel] : 0;
      const up = y > 0 ? rgba[prior + x] : 0;
      const upLeft =
        y > 0 && x >= bytesPerPixel ? rgba[prior + x - bytesPerPixel] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paethPredictor(left, up, upLeft);
      rgba[row + x] = (raw + predictor) & 0xff;
    }
  }
  return { data: rgba, width, height };
}

export function expectedC1211CaptureFilename(runId, label) {
  if (!isC1211UuidV4(runId))
    throw new TypeError("capture runId must be UUID v4");
  if (!C12_11_STAR_CATALOG_CAPTURE_LABELS.includes(label))
    throw new TypeError(`unknown C12-11 capture label ${String(label)}`);
  return `${runId}-${C12_11_STAR_CATALOG_RENDERER}-${label}.png`;
}

export function validateC1211G3Prerequisite(value) {
  const reasons = [];
  if (!exactKeys(value, ["files", "report", "foldVerified", "stable", "valid"]))
    reasons.push("G3 prerequisite shape is invalid");
  if (
    !Array.isArray(value?.files) ||
    value.files.length !== C12_11_STAR_CATALOG_G3_PREREQUISITE_FILES.length
  )
    reasons.push("G3 prerequisite file identities are incomplete");
  else {
    for (let index = 0; index < value.files.length; index++) {
      if (
        !validIdentity(
          value.files[index],
          C12_11_STAR_CATALOG_G3_PREREQUISITE_FILES[index],
        )
      )
        reasons.push(`G3 prerequisite identity ${index} is invalid`);
    }
  }
  const report = value?.report;
  if (
    !exactKeys(report, [
      "gate",
      "verdict",
      "exitCode",
      "pass",
      "failures",
      "structural",
      "assetFingerprints",
      "backendPass",
    ]) ||
    report?.gate !== "G3" ||
    report?.verdict !== "PASS" ||
    report?.exitCode !== 0 ||
    report?.pass !== true ||
    !exactArray(report?.failures, []) ||
    !exactArray(report?.structural, []) ||
    !exactKeys(report?.backendPass, ["webgl", "webgpu"]) ||
    report?.backendPass?.webgl !== true ||
    report?.backendPass?.webgpu !== true ||
    !exactKeys(report?.assetFingerprints, ["webgl", "webgpu"]) ||
    !validHash(report?.assetFingerprints?.webgl) ||
    report?.assetFingerprints?.webgl !== report?.assetFingerprints?.webgpu
  ) {
    reasons.push("G3 prerequisite report is not an exact both-backend PASS");
  }
  if (
    value?.foldVerified !== true ||
    value?.stable !== true ||
    value?.valid !== true
  )
    reasons.push("G3 prerequisite identity was not stable and prevalidated");
  return { ok: reasons.length === 0, reasons };
}

export function summarizeC1211G3Report(report) {
  return {
    gate: report?.gate ?? null,
    verdict: report?.verdict ?? null,
    exitCode: report?.exitCode ?? null,
    pass: report?.pass ?? null,
    failures: Array.isArray(report?.failures) ? [...report.failures] : null,
    structural: Array.isArray(report?.structural)
      ? [...report.structural]
      : null,
    assetFingerprints: {
      webgl: report?.backends?.webgl?.assetFingerprint ?? null,
      webgpu: report?.backends?.webgpu?.assetFingerprint ?? null,
    },
    backendPass: {
      webgl: report?.backends?.webgl?.pass ?? null,
      webgpu: report?.backends?.webgpu?.pass ?? null,
    },
  };
}

function validateIdentityList(value, expectedPaths, label) {
  const reasons = [];
  if (!Array.isArray(value) || value.length !== expectedPaths.length) {
    reasons.push(`${label} identity list is incomplete`);
    return reasons;
  }
  for (let index = 0; index < expectedPaths.length; index++) {
    if (!validIdentity(value[index], expectedPaths[index]))
      reasons.push(`${label} identity ${expectedPaths[index]} is invalid`);
  }
  return reasons;
}

export function validateC1211StarCatalogProvenance(value) {
  const reasons = [];
  if (
    !exactKeys(value, [
      "schema",
      "gitHead",
      "localStart",
      "localEnd",
      "localStable",
      "buildSourceIdentity",
      "servedEntry",
      "g3Prerequisite",
      "protectedHistorical",
    ])
  )
    reasons.push("provenance top-level shape is invalid");
  if (value?.schema !== C12_11_STAR_CATALOG_PROVENANCE_SCHEMA)
    reasons.push("provenance schema is invalid");
  if (value?.gitHead !== null && !/^[0-9a-f]{40}$/u.test(value?.gitHead ?? ""))
    reasons.push("git HEAD identity is invalid");
  reasons.push(
    ...validateIdentityList(
      value?.localStart,
      C12_11_STAR_CATALOG_SOURCE_FILES,
      "source start",
    ),
  );
  reasons.push(
    ...validateIdentityList(
      value?.localEnd,
      C12_11_STAR_CATALOG_SOURCE_FILES,
      "source end",
    ),
  );
  if (
    value?.localStable !== true ||
    !sameJson(value?.localStart, value?.localEnd)
  )
    reasons.push("source identities changed during the run");
  const build = value?.buildSourceIdentity;
  if (
    !exactKeys(build, [
      "ok",
      "sourceMapByteLength",
      "sourceMapSha256",
      "buildEntryByteLength",
      "buildEntrySha256",
      "endSourceMapByteLength",
      "endSourceMapSha256",
      "endBuildEntryByteLength",
      "endBuildEntrySha256",
      "stable",
      "entries",
      "reasons",
    ]) ||
    build?.ok !== true ||
    !(build?.sourceMapByteLength > 0) ||
    !validHash(build?.sourceMapSha256) ||
    !(build?.buildEntryByteLength > 0) ||
    !validHash(build?.buildEntrySha256) ||
    build?.endSourceMapByteLength !== build?.sourceMapByteLength ||
    build?.endSourceMapSha256 !== build?.sourceMapSha256 ||
    build?.endBuildEntryByteLength !== build?.buildEntryByteLength ||
    build?.endBuildEntrySha256 !== build?.buildEntrySha256 ||
    build?.stable !== true ||
    !exactArray(build?.reasons, []) ||
    !Array.isArray(build?.entries) ||
    build.entries.length !== C12_11_STAR_CATALOG_BUILD_SOURCE_FILES.length
  )
    reasons.push("build/source identity is incomplete or not exact");
  else {
    for (let index = 0; index < build.entries.length; index++) {
      const entry = build.entries[index];
      const sourceStart = value?.localStart?.find(
        (candidate) => candidate?.path === entry?.path,
      );
      if (
        !exactKeys(entry, [
          "path",
          "sourceMapEntry",
          "currentByteLength",
          "embeddedByteLength",
          "currentSha256",
          "embeddedSha256",
          "exact",
          "reason",
        ]) ||
        entry.path !== C12_11_STAR_CATALOG_BUILD_SOURCE_FILES[index] ||
        typeof entry.sourceMapEntry !== "string" ||
        !(entry.currentByteLength > 0) ||
        entry.currentByteLength !== entry.embeddedByteLength ||
        !validHash(entry.currentSha256) ||
        entry.currentSha256 !== entry.embeddedSha256 ||
        entry.currentByteLength !== sourceStart?.byteLength ||
        entry.currentSha256 !== sourceStart?.sha256 ||
        entry.exact !== true ||
        entry.reason !== null
      )
        reasons.push(
          `build/source identity ${C12_11_STAR_CATALOG_BUILD_SOURCE_FILES[index]} is invalid`,
        );
    }
  }
  const served = value?.servedEntry;
  if (
    !exactKeys(served, [
      "path",
      "url",
      "status",
      "byteLength",
      "sha256",
      "matchesLocalBuildEntry",
    ]) ||
    served?.path !== "Build/CesiumUnminified/index.js" ||
    !validServedRuntimeUrl(served?.url) ||
    served?.status !== 200 ||
    !(served?.byteLength > 0) ||
    !validHash(served?.sha256) ||
    served?.matchesLocalBuildEntry !== true ||
    served?.byteLength !== build?.buildEntryByteLength ||
    served?.sha256 !== build?.buildEntrySha256
  )
    reasons.push("served runtime entry identity is invalid");
  const g3 = validateC1211G3Prerequisite(value?.g3Prerequisite);
  reasons.push(...g3.reasons);
  const historical = value?.protectedHistorical;
  if (
    !exactKeys(historical, ["before", "after", "stable"]) ||
    historical?.stable !== true
  ) {
    reasons.push("protected historical evidence boundary is invalid");
  } else {
    for (const [boundary, list] of [
      ["before", historical.before],
      ["after", historical.after],
    ]) {
      reasons.push(
        ...validateIdentityList(
          list,
          C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS.map(
            (entry) => entry.path,
          ),
          `protected ${boundary}`,
        ),
      );
      if (Array.isArray(list)) {
        for (
          let index = 0;
          index < C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS.length;
          index++
        ) {
          const expected = C12_11_STAR_CATALOG_PROTECTED_HISTORICAL_PNGS[index];
          const actual = list[index];
          if (
            actual?.byteLength !== expected.byteLength ||
            actual?.sha256 !== expected.sha256
          )
            reasons.push(
              `protected historical PNG ${expected.path} no longer has its frozen bytes`,
            );
        }
      }
    }
    if (!sameJson(historical.before, historical.after))
      reasons.push("protected historical PNGs changed during the run");
  }
  return { ok: reasons.length === 0, reasons };
}

function validRuntimeErrors(value) {
  return (
    exactKeys(value, [
      "console",
      "page",
      "request",
      "response",
      "webgpu",
      "deviceLoss",
    ]) &&
    boundedStringArray(value.console) &&
    boundedStringArray(value.page) &&
    boundedStringArray(value.request) &&
    boundedStringArray(value.response) &&
    boundedStringArray(value.webgpu) &&
    (value.deviceLoss === null ||
      (typeof value.deviceLoss === "string" && value.deviceLoss.length <= 4096))
  );
}

function validErrorRuntime(value) {
  if (value === null) return true;
  if (!exactKeys(value, ["errors", "gpuGate", "cleanup"])) return false;
  if (!validRuntimeErrors(value.errors)) return false;
  if (
    value.gpuGate !== null &&
    (!exactKeys(value.gpuGate, ["found", "armed", "total"]) ||
      !["found", "armed", "total"].every(
        (key) =>
          Number.isSafeInteger(value.gpuGate[key]) && value.gpuGate[key] >= 0,
      ))
  )
    return false;
  return (
    exactKeys(value.cleanup, [
      "pageClosed",
      "browserClosed",
      "timedOut",
      "errors",
    ]) &&
    typeof value.cleanup.pageClosed === "boolean" &&
    typeof value.cleanup.browserClosed === "boolean" &&
    typeof value.cleanup.timedOut === "boolean" &&
    boundedStringArray(value.cleanup.errors)
  );
}

function validMetrics(value) {
  const integerKeys = [
    "offBright",
    "onBright",
    "brightBright",
    "siriusCenter",
    "blankCenter",
    "offCenter",
    "siriusPoints",
    "offPoints",
    "blankPoints",
  ];
  if (!exactKeys(value, [...integerKeys, "siriusAimPx"])) return false;
  return (
    integerKeys.every(
      (key) => Number.isSafeInteger(value[key]) && value[key] >= 0,
    ) &&
    (value.siriusAimPx === null ||
      (Number.isFinite(value.siriusAimPx) && value.siriusAimPx >= 0))
  );
}

function validateCaptureBindings(report) {
  const reasons = [];
  const bindings = report?.captureBindings;
  const captures = report?.runtime?.captures;
  if (
    !Array.isArray(bindings) ||
    bindings.length !== C12_11_STAR_CATALOG_CAPTURE_LABELS.length
  )
    return ["capture bindings are incomplete"];
  if (
    !captures ||
    typeof captures !== "object" ||
    Array.isArray(captures) ||
    JSON.stringify(Object.keys(captures).sort()) !==
      JSON.stringify([...C12_11_STAR_CATALOG_CAPTURE_LABELS].sort())
  )
    return ["runtime capture observations are incomplete"];
  const names = new Set();
  for (
    let index = 0;
    index < C12_11_STAR_CATALOG_CAPTURE_LABELS.length;
    index++
  ) {
    const label = C12_11_STAR_CATALOG_CAPTURE_LABELS[index];
    const binding = bindings[index];
    const capture = captures[label];
    const expectedFilename = isC1211UuidV4(report?.runId)
      ? expectedC1211CaptureFilename(report.runId, label)
      : null;
    if (
      !exactKeys(binding, [
        "runId",
        "renderer",
        "label",
        "file",
        "byteLength",
        "sha256",
        "width",
        "height",
      ]) ||
      binding?.runId !== report?.runId ||
      binding?.renderer !== C12_11_STAR_CATALOG_RENDERER ||
      binding?.label !== label ||
      binding?.file !== expectedFilename ||
      !(binding?.byteLength > 0) ||
      !validHash(binding?.sha256) ||
      binding?.width !== C12_11_STAR_CATALOG_SCENE.viewport.width ||
      binding?.height !== C12_11_STAR_CATALOG_SCENE.viewport.height
    )
      reasons.push(`${label} capture binding is invalid`);
    if (
      !exactKeys(capture, ["label", "width", "height", "sha256"]) ||
      capture?.label !== label ||
      capture?.width !== binding?.width ||
      capture?.height !== binding?.height ||
      capture?.sha256 !== binding?.sha256
    )
      reasons.push(`${label} runtime capture does not bind the immutable PNG`);
    if (names.has(binding?.file))
      reasons.push(`${label} capture filename is duplicated`);
    names.add(binding?.file);
  }
  return reasons;
}

export function foldC1211StarCatalogGate(report) {
  if (report?.runtime?.completed !== true) {
    return {
      status: "ERROR",
      exitCode: C12_11_STAR_CATALOG_EXIT_CODE.ERROR,
      checks: Object.fromEntries(
        C12_11_STAR_CATALOG_CHECK_KEYS.map((key) => [key, false]),
      ),
      structuralReasons: [],
      failureReasons: ["the WebGPU star-catalog runtime lane did not complete"],
    };
  }
  const structuralReasons = [];
  if (!isC1211UuidV4(report?.runId))
    structuralReasons.push("runId is not UUID v4");
  if (
    !sameJson(report?.contract, {
      renderer: C12_11_STAR_CATALOG_RENDERER,
      runtimePath: C12_11_STAR_CATALOG_RUNTIME_PATH,
      viewerPath: C12_11_STAR_CATALOG_VIEWER_PATH,
      captureLabels: [...C12_11_STAR_CATALOG_CAPTURE_LABELS],
      scene: C12_11_STAR_CATALOG_SCENE,
    })
  )
    structuralReasons.push("frozen C12-11 contract is missing or changed");
  structuralReasons.push(
    ...validateC1211StarCatalogProvenance(report?.provenance).reasons,
  );
  structuralReasons.push(...validateCaptureBindings(report));
  if (
    !exactKeys(report?.runtime, [
      "completed",
      "renderer",
      "hasStarField",
      "metrics",
      "captures",
      "diagnostics",
      "errors",
      "gpuGate",
    ]) ||
    report?.runtime?.renderer !== C12_11_STAR_CATALOG_RENDERER ||
    typeof report?.runtime?.hasStarField !== "boolean"
  )
    structuralReasons.push("runtime evidence shape or renderer is invalid");
  if (!validMetrics(report?.runtime?.metrics))
    structuralReasons.push(
      "star-catalog measurements are malformed or non-finite",
    );
  if (!validRuntimeErrors(report?.runtime?.errors))
    structuralReasons.push("runtime error capture is malformed");
  if (
    !exactKeys(report?.runtime?.gpuGate, ["found", "armed", "total"]) ||
    !Number.isSafeInteger(report?.runtime?.gpuGate?.found) ||
    report.runtime.gpuGate.found < 1 ||
    !Number.isSafeInteger(report?.runtime?.gpuGate?.total) ||
    report.runtime.gpuGate.total < 1 ||
    !Number.isSafeInteger(report?.runtime?.gpuGate?.armed) ||
    report.runtime.gpuGate.armed < 0
  )
    structuralReasons.push(
      "WebGPU device error gate did not reach and arm a live device",
    );
  if (
    !exactKeys(report?.cleanup, [
      "pageClosed",
      "browserClosed",
      "timedOut",
      "errors",
    ]) ||
    report?.cleanup?.pageClosed !== true ||
    report?.cleanup?.browserClosed !== true ||
    report?.cleanup?.timedOut !== false ||
    !exactArray(report?.cleanup?.errors, [])
  )
    structuralReasons.push(
      "bounded browser/page cleanup did not complete cleanly",
    );

  const metrics = validMetrics(report?.runtime?.metrics)
    ? report.runtime.metrics
    : {};
  const errors = validRuntimeErrors(report?.runtime?.errors)
    ? report.runtime.errors
    : {
        console: ["missing"],
        page: [],
        request: [],
        response: [],
        webgpu: [],
        deviceLoss: null,
      };
  const checks = {
    A_sprites_add_resolved_sirius_source_at_aim:
      metrics.siriusPoints > metrics.offPoints &&
      metrics.siriusPoints >= 1 &&
      Number.isFinite(metrics.siriusAimPx) &&
      metrics.siriusAimPx <= C12_11_STAR_CATALOG_SCENE.aimTolerancePixels,
    B_sirius_aimed_box_is_brighter_than_blank:
      metrics.siriusCenter > metrics.blankCenter,
    C_sirius_source_present_and_blank_source_absent:
      metrics.siriusPoints >= 1 && metrics.blankPoints === 0,
    D_intensity_3_increases_bright_pixels:
      metrics.brightBright > metrics.onBright,
    E_live_starField_hook_present: report?.runtime?.hasStarField === true,
    F_zero_runtime_page_console_webgpu_device_loss_errors:
      errors.console.length === 0 &&
      errors.page.length === 0 &&
      errors.request.length === 0 &&
      errors.response.length === 0 &&
      errors.webgpu.length === 0 &&
      errors.deviceLoss === null,
    G_cubemap_only_resolved_sources_le_2: metrics.offPoints <= 2,
  };
  const failureReasons = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([key]) => key);
  const status =
    structuralReasons.length > 0
      ? "STRUCTURAL"
      : failureReasons.length > 0
        ? "FAIL"
        : "PASS";
  return {
    status,
    exitCode: exitCodeForC1211StarCatalogStatus(status),
    checks,
    structuralReasons,
    failureReasons,
  };
}

export function createC1211StarCatalogErrorArtifact(runId, diagnostics) {
  return {
    schema: C12_11_STAR_CATALOG_SCHEMA,
    runId,
    incomplete: false,
    status: "ERROR",
    exitCode: C12_11_STAR_CATALOG_EXIT_CODE.ERROR,
    diagnostics: {
      ...diagnostics,
      runtime: diagnostics?.runtime ?? null,
    },
  };
}

export function validateC1211StarCatalogFinalArtifact(artifact) {
  const reasons = [];
  if (artifact?.status === "ERROR") {
    if (
      !exactKeys(artifact, [
        "schema",
        "runId",
        "incomplete",
        "status",
        "exitCode",
        "diagnostics",
      ])
    )
      reasons.push("ERROR artifact top-level shape is invalid");
    if (
      artifact?.schema !== C12_11_STAR_CATALOG_SCHEMA ||
      !isC1211UuidV4(artifact?.runId) ||
      artifact?.incomplete !== false ||
      artifact?.exitCode !== C12_11_STAR_CATALOG_EXIT_CODE.ERROR
    )
      reasons.push("ERROR artifact identity/status is invalid");
    const d = artifact?.diagnostics;
    if (
      !exactKeys(d, [
        "schema",
        "stage",
        "message",
        "stack",
        "timeoutMs",
        "runtime",
      ]) ||
      d?.schema !== C12_11_STAR_CATALOG_DIAGNOSTICS_SCHEMA ||
      typeof d?.stage !== "string" ||
      d.stage.length === 0 ||
      typeof d?.message !== "string" ||
      d.message.length === 0 ||
      d.message.length > 4096 ||
      (d?.stack !== null &&
        (typeof d.stack !== "string" || d.stack.length > 16384)) ||
      (d?.timeoutMs !== null &&
        (!Number.isSafeInteger(d.timeoutMs) || d.timeoutMs <= 0)) ||
      !validErrorRuntime(d?.runtime)
    )
      reasons.push("ERROR diagnostics are invalid");
    return { ok: reasons.length === 0, reasons };
  }
  if (!FINAL_STATUSES.has(artifact?.status))
    reasons.push("final status is invalid");
  if (
    !exactKeys(artifact, [
      "schema",
      "runId",
      "incomplete",
      "status",
      "exitCode",
      "contract",
      "provenance",
      "captureBindings",
      "runtime",
      "cleanup",
      "checks",
      "reasons",
    ])
  )
    reasons.push("final artifact top-level shape is invalid");
  if (
    artifact?.schema !== C12_11_STAR_CATALOG_SCHEMA ||
    !isC1211UuidV4(artifact?.runId) ||
    artifact?.incomplete !== false
  )
    reasons.push("final artifact identity is invalid");
  const verdict = foldC1211StarCatalogGate(artifact);
  if (
    artifact?.status !== verdict.status ||
    artifact?.exitCode !== verdict.exitCode
  )
    reasons.push("final artifact verdict does not match the fail-closed fold");
  if (!sameJson(artifact?.checks, verdict.checks))
    reasons.push("final artifact checks do not match the fold");
  if (
    !exactKeys(artifact?.reasons, ["structural", "failures"]) ||
    !sameJson(artifact?.reasons?.structural, verdict.structuralReasons) ||
    !sameJson(artifact?.reasons?.failures, verdict.failureReasons)
  )
    reasons.push("final artifact reasons do not match the fold");
  return { ok: reasons.length === 0, reasons };
}

export function materializeC1211StarCatalogArtifact(report) {
  const verdict = foldC1211StarCatalogGate(report);
  return {
    schema: C12_11_STAR_CATALOG_SCHEMA,
    runId: report.runId,
    incomplete: false,
    status: verdict.status,
    exitCode: verdict.exitCode,
    contract: report.contract,
    provenance: report.provenance,
    captureBindings: report.captureBindings,
    runtime: report.runtime,
    cleanup: report.cleanup,
    checks: verdict.checks,
    reasons: {
      structural: verdict.structuralReasons,
      failures: verdict.failureReasons,
    },
  };
}
