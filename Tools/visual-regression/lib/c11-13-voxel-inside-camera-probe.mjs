import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import sharp from "sharp";

export const OUTER_WATCHDOG_GRACE_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
export const WATCHDOG_MS = Number(process.env.C11_13_WATCHDOG_MS ?? 300_000);
if (
  !Number.isFinite(WATCHDOG_MS) ||
  WATCHDOG_MS <= 0 ||
  WATCHDOG_MS > MAX_TIMER_MS - OUTER_WATCHDOG_GRACE_MS
) {
  throw new Error(
    "STRUCTURAL: C11_13_WATCHDOG_MS must be a positive, non-clamping timer duration",
  );
}

export const BACKENDS = Object.freeze(["webgl", "webgpu"]);
export const COMMAND_NAMES = Object.freeze([
  "color",
  "objectPick",
  "cellPick",
  "velocity",
]);
export const ERROR_LANE_NAMES = Object.freeze([
  "consoleErrors",
  "consoleWarnings",
  "pageErrors",
  "pageCrashes",
  "dialogs",
  "requestFailures",
  "badResponses",
  "malformedResponseUrls",
  "nonBaseRequests",
  "nonBaseResponses",
  "nonBaseWebSockets",
  "responseBodyErrors",
  "cleanupErrors",
  "instrumentationFailures",
  "gpuErrors",
  "deviceLosses",
  "unhandledRejections",
  "windowErrors",
]);
export const WAYPOINTS = Object.freeze([
  Object.freeze({
    id: "outside-positive-initial",
    factor: 1.05,
    inside: false,
  }),
  Object.freeze({ id: "inside-positive-near", factor: 0.9, inside: true }),
  Object.freeze({ id: "inside-positive-deep", factor: 0.55, inside: true }),
  Object.freeze({ id: "inside-negative-deep", factor: -0.55, inside: true }),
  Object.freeze({ id: "inside-negative-near", factor: -0.9, inside: true }),
  Object.freeze({ id: "outside-negative", factor: -1.05, inside: false }),
  Object.freeze({ id: "outside-positive-return", factor: 1.05, inside: false }),
]);

export const PIXEL_TOLERANCES = Object.freeze({
  nonBlackThreshold: 18,
  minimumNonBlackPixels: 512,
  minimumNonBlackFraction: 0.0007,
  minimumInteriorNonBlackPixels: 64,
  minimumCenterPatchNonBlackPixels: 1,
  minimumCenterPixelMaximum: 18,
  minimumGreenDominance: 12,
  minimumFootprintIou: 0.6,
  minimumFootprintRatio: 0.65,
  maximumFootprintRatio: 1.54,
  minimumBoundingBoxRatio: 0.65,
  maximumBoundingBoxRatio: 1.54,
  maximumMeanColorL1: 60,
});

const VIEWPORT = Object.freeze({ width: 960, height: 720 });
const STABILITY_ATTEMPTS = 8;
const STABILITY_STREAK = 3;
const STABILITY_FRAMES = 8;

export function normalizeProbeBase(value) {
  let base;
  try {
    base = new URL(value);
  } catch {
    throw new Error("STRUCTURAL: invalid probe base URL");
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    base.username !== "" ||
    base.password !== "" ||
    base.pathname !== "/" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new Error(
      "STRUCTURAL: probe base must be a bare HTTP(S) origin without credentials, path, query, or fragment",
    );
  }
  return base.origin;
}

/**
 * Validate the live canvas rectangle against the fixed capture viewport.
 *
 * @param {unknown} value
 * @param {{width: number, height: number}} viewport
 * @returns {{x: number, y: number, width: number, height: number}}
 */
export function normalizeCanvasClip(value, viewport = VIEWPORT) {
  const clip = {
    x: Number(value?.x),
    y: Number(value?.y),
    width: Number(value?.width),
    height: Number(value?.height),
  };
  if (
    !Object.values(clip).every(Number.isFinite) ||
    clip.x < 0 ||
    clip.y < 0 ||
    clip.width <= 0 ||
    clip.height <= 0 ||
    !Number.isFinite(viewport?.width) ||
    !Number.isFinite(viewport?.height) ||
    clip.x + clip.width > viewport.width ||
    clip.y + clip.height > viewport.height
  ) {
    throw new Error("STRUCTURAL: canvas screenshot clip is invalid");
  }
  return clip;
}

/**
 * Decode the immutable PNG frozen synchronously after the final in-page
 * render. This avoids both deferred GPU-canvas reads and Chrome's screenshot
 * surface capture, which can hang on an active canvas.
 *
 * @param {unknown} value
 * @returns {Buffer}
 */
export function decodeCanvasPngDataUrl(value) {
  const prefix = "data:image/png;base64,";
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error("STRUCTURAL: canvas capture is not a PNG data URL");
  }
  const bytes = Buffer.from(value.slice(prefix.length), "base64");
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (
    bytes.length <= pngSignature.length ||
    !bytes.subarray(0, 8).equals(pngSignature)
  ) {
    throw new Error("STRUCTURAL: canvas capture has no valid PNG payload");
  }
  return bytes;
}

const BASE = normalizeProbeBase(
  process.env.PROBE_BASE ?? "http://localhost:8080",
);
const BASE_ORIGIN = new URL(BASE).origin;
const HARNESS_ROUTE =
  "/Tools/visual-regression/c11-13-voxel-inside-camera-harness.html";
const OUTPUT_ROOT = path.resolve(
  "Tools/visual-regression/output/c11-13-voxel-inside-camera",
);
const EVIDENCE_DIR = path.resolve("Tools/visual-regression/output/performance");
const CANONICAL_ARTIFACT = path.join(
  EVIDENCE_DIR,
  "c11-13-voxel-inside-camera.json",
);
const FIRST_RED_ARTIFACT = path.join(
  EVIDENCE_DIR,
  "c11-13-voxel-inside-camera.first-red.json",
);

const LOCAL_PATHS = Object.freeze({
  harnessHtml: path.resolve(
    "Tools/visual-regression/c11-13-voxel-inside-camera-harness.html",
  ),
  harnessModule: path.resolve(
    "Tools/visual-regression/c11-13-voxel-inside-camera-harness.mjs",
  ),
  providerFixture: path.resolve(
    "Tools/visual-regression/fixtures/voxel-octree-l3.mjs",
  ),
  physicalPolicy: path.resolve(
    "Tools/visual-regression/c11-13-voxel-inside-camera-probe.spec.mjs",
  ),
  productionPolicy: path.resolve(
    "Tools/visual-regression/voxel-inside-camera-policy.spec.mjs",
  ),
  probeEntry: path.resolve(
    "Tools/visual-regression/probe-c11-13-voxel-inside-camera.mjs",
  ),
  probeImplementation: path.resolve(
    "Tools/visual-regression/lib/c11-13-voxel-inside-camera-probe.mjs",
  ),
  rendererSource: path.resolve(
    "packages/engine/Source/Renderer/WebGPU/WebGPUVoxelRenderer.ts",
  ),
  rendererSpec: path.resolve(
    "packages/engine/Specs/Renderer/WebGPU/WebGPUVoxelRendererSpec.js",
  ),
  cesiumEntry: path.resolve("Source/Cesium.js"),
  engineBundle: path.resolve("packages/engine/Build/Unminified/index.js"),
  engineWgslBundle: path.resolve(
    "packages/engine/Build/Unminified/index-wgsl.js",
  ),
  widgetsBundle: path.resolve("packages/widgets/Build/Unminified/index.js"),
  widgetsCss: path.resolve("Build/CesiumUnminified/Widgets/widgets.css"),
});

const TRACKED_RUNTIME_PATHS = new Map([
  [HARNESS_ROUTE, LOCAL_PATHS.harnessHtml],
  [
    "/Tools/visual-regression/c11-13-voxel-inside-camera-harness.mjs",
    LOCAL_PATHS.harnessModule,
  ],
  [
    "/Tools/visual-regression/fixtures/voxel-octree-l3.mjs",
    LOCAL_PATHS.providerFixture,
  ],
  ["/Source/Cesium.js", LOCAL_PATHS.cesiumEntry],
  ["/packages/engine/Build/Unminified/index.js", LOCAL_PATHS.engineBundle],
  [
    "/packages/engine/Build/Unminified/index-wgsl.js",
    LOCAL_PATHS.engineWgslBundle,
  ],
  ["/packages/widgets/Build/Unminified/index.js", LOCAL_PATHS.widgetsBundle],
  ["/Build/CesiumUnminified/Widgets/widgets.css", LOCAL_PATHS.widgetsCss],
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function relativePath(filePath) {
  return path.relative(process.cwd(), filePath).replaceAll("\\", "/");
}

function hashFile(filePath) {
  try {
    const bytes = fs.readFileSync(filePath);
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      path: relativePath(filePath),
      bytes: bytes.length,
      sha256: sha256(bytes),
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    return {
      exists: false,
      path: relativePath(filePath),
      bytes: null,
      sha256: null,
      mtimeMs: null,
      error: error?.code ?? error?.message ?? String(error),
    };
  }
}

function collectLocalProvenance() {
  return Object.fromEntries(
    Object.entries(LOCAL_PATHS).map(([name, filePath]) => [
      name,
      hashFile(filePath),
    ]),
  );
}

export function provenanceStable(start, end) {
  const names = Object.keys(start ?? {});
  return (
    names.length > 0 &&
    names.length === Object.keys(end ?? {}).length &&
    names.every(
      (name) =>
        start?.[name]?.exists === true &&
        end?.[name]?.exists === true &&
        start[name].bytes === end[name].bytes &&
        start[name].sha256 === end[name].sha256,
    )
  );
}

export function assessBuildProvenance(provenance, sourceText, bundleText) {
  const failures = [];
  if (
    !Object.values(provenance ?? {}).every(
      (entry) =>
        entry?.exists === true &&
        entry?.bytes > 0 &&
        /^[0-9A-F]{64}$/u.test(entry?.sha256 ?? ""),
    )
  ) {
    failures.push(
      "one or more required source/build/probe/provider files are absent",
    );
  }
  if (
    !(provenance?.engineBundle?.mtimeMs >= provenance?.rendererSource?.mtimeMs)
  ) {
    failures.push("engine bundle predates the C11-13 renderer source");
  }
  for (const sentinel of [
    "VOXEL_PROXY_REVERSED_FIRST_INDEX",
    "computeVoxelProxyFirstIndex",
    "updateVoxelProxyCommandFirstIndices",
    'indexFormat: "uint16"',
  ]) {
    if (!sourceText?.includes(sentinel)) {
      failures.push(`renderer source lacks ${sentinel}`);
    }
    if (!bundleText?.includes(sentinel)) {
      failures.push(`engine build lacks ${sentinel}`);
    }
  }
  return { pass: failures.length === 0, failures };
}

export function assessWatchdogOrdering(artifactWatchdogMs, outerWatchdogMs) {
  return (
    Number.isFinite(artifactWatchdogMs) &&
    artifactWatchdogMs > 0 &&
    Number.isFinite(outerWatchdogMs) &&
    outerWatchdogMs >= artifactWatchdogMs + OUTER_WATCHDOG_GRACE_MS &&
    outerWatchdogMs <= MAX_TIMER_MS
  );
}

export function isBaseOrigin(value, baseOrigin = BASE_ORIGIN) {
  try {
    return new URL(value, baseOrigin).origin === new URL(baseOrigin).origin;
  } catch {
    return false;
  }
}

function redactQueriesInString(value) {
  return value.replace(/\?([^\s#"'<>]*)/g, (_match, query) => {
    if (query.length === 0) return "?";
    return `?${query
      .split("&")
      .map((field) => {
        if (field.length === 0) return field;
        const equalsIndex = field.indexOf("=");
        const name = equalsIndex === -1 ? field : field.slice(0, equalsIndex);
        return `${name}=[REDACTED]`;
      })
      .join("&")}`;
  });
}

export function redactOutputPayload(value) {
  if (typeof value === "string") return redactQueriesInString(value);
  if (Array.isArray(value)) return value.map(redactOutputPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactOutputPayload(entry),
      ]),
    );
  }
  return value;
}

function serializeJson(payload) {
  return `${JSON.stringify(redactOutputPayload(payload), null, 2)}\n`;
}

export function atomicReplace(filePath, bytes, operations = fs) {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    operations.writeFileSync(temporary, bytes, { flag: "wx" });
    operations.renameSync(temporary, filePath);
  } finally {
    try {
      operations.rmSync(temporary, { force: true });
    } catch {
      // Cleanup is best-effort; preserve the original write/rename failure.
    }
  }
}

export function createImmutable(filePath, bytes, operations = fs) {
  operations.writeFileSync(filePath, bytes, { flag: "wx" });
}

function firstRedFingerprint() {
  return hashFile(FIRST_RED_ARTIFACT);
}

export function preserveFirstRed(
  filePath,
  bytes,
  operations = fs,
  hash = hashFile,
) {
  try {
    createImmutable(filePath, bytes, operations);
    return { written: true, ...hash(filePath) };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { written: false, ...hash(filePath) };
    }
    throw error;
  }
}

function addCheck(checks, name, pass, actual, expected) {
  checks.push({ name, pass: Boolean(pass), actual, expected });
}

export function assessBackendAuthority(backend, authority, gate) {
  const failures = [];
  if (authority?.requestedRenderer !== backend) {
    failures.push("requested renderer mismatch");
  }
  if (authority?.rendererType !== backend) {
    failures.push("actual renderer type mismatch/fallback");
  }
  if (authority?.canvasCount !== 1) {
    failures.push("isolated harness must own exactly one canvas");
  }
  if (!(authority?.canvasWidth > 0 && authority?.canvasHeight > 0)) {
    failures.push("canvas has no drawing-buffer area");
  }
  if (gate?.installed !== true || gate?.instrumentationFailures?.length !== 0) {
    failures.push("native instrumentation is unavailable or failed");
  }
  if (backend === "webgl") {
    if (
      authority?.isWebGL !== true ||
      authority?.isWebGPU !== false ||
      authority?.webgl2 !== true ||
      authority?.nativeWebGL2 !== true
    ) {
      failures.push("WebGL lane is not authoritative native WebGL2");
    }
    if (gate?.requestDeviceCalls !== 0 || gate?.armedDevices !== 0) {
      failures.push("WebGL lane requested a WebGPU device");
    }
    if (!(gate?.webglDrawCalls > 0)) {
      failures.push("WebGL lane did not issue a native draw");
    }
  } else if (backend === "webgpu") {
    if (
      authority?.isWebGPU !== true ||
      authority?.isWebGL !== false ||
      authority?.nativeDevice !== true ||
      authority?.nativeCanvasContext !== true
    ) {
      failures.push("WebGPU lane is not authoritative native WebGPU");
    }
    if (!(gate?.requestDeviceCalls >= 1 && gate?.armedDevices >= 1)) {
      failures.push("WebGPU device acquisition was not observed and armed");
    }
  } else {
    failures.push(`unknown backend ${backend}`);
  }
  return { pass: failures.length === 0, failures };
}

export function assessProviderEvidence(provider, primitive) {
  const failures = [];
  if (
    provider?.fixture !== "voxel-octree-l3" ||
    provider?.availableLevelsConstant !== 3 ||
    provider?.availableLevels !== 3 ||
    provider?.tileConstant !== 4 ||
    JSON.stringify(provider?.dimensions) !== "[4,4,4]" ||
    JSON.stringify(provider?.names) !== '["color"]' ||
    JSON.stringify(provider?.types) !== '["VEC4"]' ||
    JSON.stringify(provider?.componentTypes) !== '["FLOAT32"]' ||
    provider?.shape !== "BOX" ||
    provider?.metadataOrder !== 1 ||
    provider?.earthRadius !== 6378137.0
  ) {
    failures.push(
      "the exact self-contained voxel-octree-l3 contract is absent",
    );
  }
  if (
    primitive?.ready !== true ||
    primitive?.show !== true ||
    primitive?.nearestSampling !== true ||
    primitive?.screenSpaceError !== 1.0e12 ||
    primitive?.customShaderHasGlsl !== true ||
    primitive?.customShaderHasWgsl !== true
  ) {
    failures.push("voxel primitive/custom-shader authority is incomplete");
  }
  return { pass: failures.length === 0, failures };
}

export function assessCommandSnapshot(snapshot, expectedFirstIndex) {
  const failures = [];
  if (snapshot?.allMaterialized !== true) {
    failures.push("all four WebGPU commands were not materialized");
  }
  for (const name of COMMAND_NAMES) {
    const command = snapshot?.commands?.[name];
    if (!command || command.present !== true) {
      failures.push(`${name} command is missing`);
      continue;
    }
    if (command.firstIndex !== expectedFirstIndex) {
      failures.push(
        `${name} firstIndex was ${command.firstIndex}, expected ${expectedFirstIndex}`,
      );
    }
    if (
      command.indexCount !== 36 ||
      command.indexFormat !== "uint16" ||
      command.indexed !== true
    ) {
      failures.push(`${name} is not an indexed 36/uint16 proxy draw`);
    }
  }
  if (
    snapshot?.objectPickAttached !== true ||
    snapshot?.cellPickAttached !== true ||
    snapshot?.velocityAttached !== true
  ) {
    failures.push("one or more lazy command variants were not attached");
  }
  if (
    snapshot?.usingRealData !== true ||
    snapshot?.uploadPhase !== "done" ||
    !/userCustomShader#/u.test(snapshot?.colorDescriptorName ?? "")
  ) {
    failures.push(
      "real provider data/user shader pipeline is not authoritative",
    );
  }
  return { pass: failures.length === 0, failures };
}

export function assessPixelEvidence(metrics) {
  const failures = [];
  if (
    !(metrics?.width > 0 && metrics?.height > 0) ||
    metrics?.pixelCount !== metrics?.width * metrics?.height
  ) {
    failures.push("pixel dimensions are invalid");
  }
  if (
    !(metrics?.nonBlackPixels >= PIXEL_TOLERANCES.minimumNonBlackPixels) ||
    !(metrics?.nonBlackFraction >= PIXEL_TOLERANCES.minimumNonBlackFraction)
  ) {
    failures.push("voxel footprint is black/vacuous");
  }
  if (
    !(
      metrics?.interiorNonBlackPixels >=
      PIXEL_TOLERANCES.minimumInteriorNonBlackPixels
    )
  ) {
    failures.push(
      "interior image region contains no meaningful voxel evidence",
    );
  }
  if (
    !(
      metrics?.centerPatchNonBlackPixels >=
      PIXEL_TOLERANCES.minimumCenterPatchNonBlackPixels
    ) ||
    !(metrics?.centerPixelMaximum >= PIXEL_TOLERANCES.minimumCenterPixelMaximum)
  ) {
    failures.push("camera-axis center pixels do not prove an interior ray hit");
  }
  if (!(
    metrics?.boundingBox?.width >= 16 && metrics?.boundingBox?.height >= 16
  )) {
    failures.push("voxel footprint bounding box is degenerate");
  }
  if (!(metrics?.greenDominance >= PIXEL_TOLERANCES.minimumGreenDominance)) {
    failures.push("the authored green custom-shader color is absent");
  }
  if (!/^[0-9A-F]{64}$/u.test(metrics?.rawSha256 ?? "")) {
    failures.push("raw pixel SHA-256 is absent");
  }
  return { pass: failures.length === 0, failures };
}

export function assessCrossBackendEvidence(comparison) {
  const failures = [];
  if (comparison?.comparable !== true) {
    failures.push("backend captures are not dimensionally comparable");
  }
  if (!(comparison?.bothNonVacuous === true)) {
    failures.push(
      "cross-backend evidence is vacuous (black-black or one black)",
    );
  }
  if (!(comparison?.footprintIou >= PIXEL_TOLERANCES.minimumFootprintIou)) {
    failures.push("cross-backend footprint IoU is below tolerance");
  }
  if (
    !(comparison?.footprintRatio >= PIXEL_TOLERANCES.minimumFootprintRatio) ||
    !(comparison?.footprintRatio <= PIXEL_TOLERANCES.maximumFootprintRatio)
  ) {
    failures.push("cross-backend footprint ratio is outside tolerance");
  }
  for (const ratio of [
    comparison?.boundingBoxWidthRatio,
    comparison?.boundingBoxHeightRatio,
  ]) {
    if (
      !(ratio >= PIXEL_TOLERANCES.minimumBoundingBoxRatio) ||
      !(ratio <= PIXEL_TOLERANCES.maximumBoundingBoxRatio)
    ) {
      failures.push("cross-backend bounding-box ratio is outside tolerance");
      break;
    }
  }
  if (!(comparison?.meanColorL1 <= PIXEL_TOLERANCES.maximumMeanColorL1)) {
    failures.push("cross-backend mean color delta is outside tolerance");
  }
  return { pass: failures.length === 0, failures };
}

export function assessWaypointSequence(waypointResults) {
  const failures = [];
  const ids = Object.keys(waypointResults ?? {});
  const expectedIds = WAYPOINTS.map((waypoint) => waypoint.id);
  if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) {
    failures.push("waypoint result order/coverage is not the exact ladder");
  }
  for (const waypoint of WAYPOINTS) {
    const result = waypointResults?.[waypoint.id];
    for (const backend of BACKENDS) {
      const evidence = result?.backends?.[backend]?.evidence?.waypoint;
      if (
        evidence?.id !== waypoint.id ||
        evidence?.factor !== waypoint.factor ||
        evidence?.inside !== waypoint.inside ||
        evidence?.expectedFirstIndex !== (waypoint.inside ? 36 : 0)
      ) {
        failures.push(`${backend}/${waypoint.id} waypoint authority is wrong`);
      }
    }
  }
  return { pass: failures.length === 0, failures };
}

export function assessOutsideReturn(waypointResults, backend) {
  const first =
    waypointResults?.["outside-positive-initial"]?.backends?.[backend];
  const returned =
    waypointResults?.["outside-positive-return"]?.backends?.[backend];
  const failures = [];
  if (
    !first?.metrics?.rawSha256 ||
    first.metrics.rawSha256 !== returned?.metrics?.rawSha256
  ) {
    failures.push("outside-return raw pixel bytes differ from initial outside");
  }
  if (
    JSON.stringify(
      stableCommandSignature(
        first?.evidence?.waypoint?.commandSnapshot ?? null,
      ),
    ) !==
    JSON.stringify(
      stableCommandSignature(
        returned?.evidence?.waypoint?.commandSnapshot ?? null,
      ),
    )
  ) {
    failures.push(
      "outside-return command snapshot differs from initial outside",
    );
  }
  return { pass: failures.length === 0, failures };
}

function stableCommandSignature(snapshot) {
  if (!snapshot) return null;
  return {
    commands: snapshot.commands,
    allMaterialized: snapshot.allMaterialized,
    objectPickAttached: snapshot.objectPickAttached,
    cellPickAttached: snapshot.cellPickAttached,
    velocityAttached: snapshot.velocityAttached,
    usingRealData: snapshot.usingRealData,
    uploadPhase: snapshot.uploadPhase,
    colorDescriptorName: snapshot.colorDescriptorName,
  };
}

export function errorLanesAreEmpty(errors) {
  if (!errors || typeof errors !== "object" || Array.isArray(errors)) {
    return false;
  }
  const names = Object.keys(errors);
  return (
    names.length === ERROR_LANE_NAMES.length &&
    names.every((name) => ERROR_LANE_NAMES.includes(name)) &&
    ERROR_LANE_NAMES.every(
      (name) =>
        Object.prototype.hasOwnProperty.call(errors, name) &&
        Array.isArray(errors[name]) &&
        errors[name].length === 0,
    )
  );
}

export function buildProbeChecks(result) {
  const checks = [];
  const sequence = assessWaypointSequence(result?.waypoints);
  addCheck(
    checks,
    "exact seven-waypoint diagonal transition ladder completed",
    sequence.pass,
    sequence.failures,
    WAYPOINTS,
  );

  for (const backend of BACKENDS) {
    const lane = result?.lanes?.[backend];
    const authority = assessBackendAuthority(
      backend,
      lane?.final?.authority,
      lane?.gate,
    );
    addCheck(
      checks,
      `${backend} strict backend authority`,
      lane?.navigationStatus === 200 && authority.pass,
      {
        navigationStatus: lane?.navigationStatus,
        authority: lane?.final?.authority,
        gate: lane?.gate,
        failures: authority.failures,
      },
      "HTTP 200 and concrete non-fallback native backend",
    );
    const provider = assessProviderEvidence(
      lane?.final?.provider,
      lane?.final?.primitive,
    );
    addCheck(
      checks,
      `${backend} exact voxel-octree-l3 provider and dual-language shader`,
      provider.pass,
      provider.failures,
      "3 levels, 4^3 VEC4/FLOAT32 color, ready deterministic primitive",
    );
  }

  for (const waypoint of WAYPOINTS) {
    const waypointResult = result?.waypoints?.[waypoint.id];
    for (const backend of BACKENDS) {
      const capture = waypointResult?.backends?.[backend];
      const pixels = assessPixelEvidence(capture?.metrics);
      addCheck(
        checks,
        `${backend}/${waypoint.id} nonblack interior pixel evidence`,
        pixels.pass && capture?.stability?.stabilized === true,
        {
          metrics: capture?.metrics,
          stability: capture?.stability,
          failures: pixels.failures,
        },
        "three identical raw frames and a bounded green center-crossing footprint",
      );
      addCheck(
        checks,
        `${backend}/${waypoint.id} screenshot is canvas-only`,
        capture?.metrics?.width === capture?.evidence?.authority?.canvasWidth &&
          capture?.metrics?.height ===
            capture?.evidence?.authority?.canvasHeight,
        {
          screenshot: [capture?.metrics?.width, capture?.metrics?.height],
          canvas: [
            capture?.evidence?.authority?.canvasWidth,
            capture?.evidence?.authority?.canvasHeight,
          ],
        },
        "identical dimensions",
      );
    }
    const commandAssessment = assessCommandSnapshot(
      waypointResult?.backends?.webgpu?.evidence?.waypoint?.commandSnapshot,
      waypoint.inside ? 36 : 0,
    );
    addCheck(
      checks,
      `webgpu/${waypoint.id} all four commands select ${waypoint.inside ? 36 : 0}`,
      commandAssessment.pass,
      commandAssessment.failures,
      "color/object-pick/cell-pick/velocity present, attached, uint16 36-index draw",
    );
    const cross = assessCrossBackendEvidence(waypointResult?.crossBackend);
    addCheck(
      checks,
      `${waypoint.id} WebGL/WebGPU footprint and color parity`,
      cross.pass,
      { comparison: waypointResult?.crossBackend, failures: cross.failures },
      PIXEL_TOLERANCES,
    );
  }

  for (const backend of BACKENDS) {
    const outside = assessOutsideReturn(result?.waypoints, backend);
    addCheck(
      checks,
      `${backend} +1.05R outside return is byte-identical`,
      outside.pass,
      outside.failures,
      "identical raw pixel SHA-256 and command snapshot",
    );
  }

  addCheck(
    checks,
    "all console/page/device/external-request lanes are empty",
    errorLanesAreEmpty(result?.errors),
    result?.errors,
    "all arrays empty",
  );
  return checks;
}

function installRuntimeGate() {
  if (globalThis.__c1113RuntimeGate) return;
  const gate = {
    installed: true,
    requestDeviceCalls: 0,
    armedDevices: 0,
    webglDrawCalls: 0,
    instrumentationFailures: [],
    gpuErrors: [],
    deviceLosses: [],
    unhandledRejections: [],
    windowErrors: [],
  };
  globalThis.__c1113RuntimeGate = gate;

  function textOf(value) {
    try {
      return value?.message ?? String(value);
    } catch {
      return "<unprintable>";
    }
  }

  function patchDraw(prototype, name) {
    if (!prototype || typeof prototype[name] !== "function") return;
    try {
      const original = prototype[name];
      prototype[name] = function (...args) {
        gate.webglDrawCalls += 1;
        return original.apply(this, args);
      };
      if (prototype[name] === original) {
        throw new Error(`${name} assignment did not stick`);
      }
    } catch (error) {
      gate.instrumentationFailures.push(`${name}: ${textOf(error)}`);
    }
  }

  for (const prototype of [
    globalThis.WebGLRenderingContext?.prototype,
    globalThis.WebGL2RenderingContext?.prototype,
  ]) {
    for (const name of [
      "drawElements",
      "drawElementsInstanced",
      "drawArrays",
      "drawArraysInstanced",
    ]) {
      patchDraw(prototype, name);
    }
  }

  const armed = new WeakSet();
  const adapterPrototype = globalThis.GPUAdapter?.prototype;
  if (
    adapterPrototype &&
    typeof adapterPrototype.requestDevice === "function"
  ) {
    try {
      const original = adapterPrototype.requestDevice;
      adapterPrototype.requestDevice = function (...args) {
        gate.requestDeviceCalls += 1;
        return original.apply(this, args).then((device) => {
          if (!armed.has(device)) {
            armed.add(device);
            gate.armedDevices += 1;
            device.addEventListener?.("uncapturederror", (event) => {
              gate.gpuErrors.push(textOf(event?.error ?? event));
            });
            device.lost
              ?.then((info) => {
                if (info?.reason !== "destroyed") {
                  gate.deviceLosses.push({
                    reason: info?.reason ?? null,
                    message: info?.message ?? "",
                  });
                }
              })
              .catch((error) => gate.deviceLosses.push(textOf(error)));
          }
          return device;
        });
      };
      if (adapterPrototype.requestDevice === original) {
        throw new Error("requestDevice assignment did not stick");
      }
    } catch (error) {
      gate.instrumentationFailures.push(`requestDevice: ${textOf(error)}`);
    }
  }

  globalThis.addEventListener("unhandledrejection", (event) => {
    gate.unhandledRejections.push(textOf(event.reason));
  });
  globalThis.addEventListener("error", (event) => {
    gate.windowErrors.push(textOf(event.error ?? event.message));
  });
  globalThis.addEventListener(
    "webglcontextlost",
    (event) => {
      gate.deviceLosses.push({
        reason: "webglcontextlost",
        message: event.statusMessage ?? "",
      });
    },
    true,
  );
  globalThis.addEventListener(
    "webglcontextcreationerror",
    (event) => {
      gate.deviceLosses.push({
        reason: "webglcontextcreationerror",
        message: event.statusMessage ?? "",
      });
    },
    true,
  );
}

function runtimeGateSnapshot() {
  const gate = globalThis.__c1113RuntimeGate;
  if (!gate) return null;
  return {
    installed: gate.installed === true,
    requestDeviceCalls: gate.requestDeviceCalls,
    armedDevices: gate.armedDevices,
    webglDrawCalls: gate.webglDrawCalls,
    instrumentationFailures: [...gate.instrumentationFailures],
    gpuErrors: structuredClone(gate.gpuErrors),
    deviceLosses: structuredClone(gate.deviceLosses),
    unhandledRejections: structuredClone(gate.unhandledRejections),
    windowErrors: structuredClone(gate.windowErrors),
  };
}

async function analyzePng(pngBytes) {
  const { data, info } = await sharp(pngBytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;
  const mask = new Uint8Array(pixelCount);
  const threshold = PIXEL_TOLERANCES.nonBlackThreshold;
  const interiorMinX = Math.floor(info.width * 0.2);
  const interiorMaxX = Math.ceil(info.width * 0.8);
  const interiorMinY = Math.floor(info.height * 0.2);
  const interiorMaxY = Math.ceil(info.height * 0.8);
  const centerX = Math.floor(info.width / 2);
  const centerY = Math.floor(info.height / 2);
  let nonBlackPixels = 0;
  let interiorNonBlackPixels = 0;
  let centerPatchNonBlackPixels = 0;
  let minX = info.width;
  let minY = info.height;
  let maxX = -1;
  let maxY = -1;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const pixel = y * info.width + x;
      const offset = pixel * info.channels;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      if (Math.max(red, green, blue) < threshold) continue;
      mask[pixel] = 1;
      nonBlackPixels += 1;
      sumR += red;
      sumG += green;
      sumB += blue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      if (
        x >= interiorMinX &&
        x < interiorMaxX &&
        y >= interiorMinY &&
        y < interiorMaxY
      ) {
        interiorNonBlackPixels += 1;
      }
      if (Math.abs(x - centerX) <= 4 && Math.abs(y - centerY) <= 4) {
        centerPatchNonBlackPixels += 1;
      }
    }
  }

  const centerOffset = (centerY * info.width + centerX) * info.channels;
  const meanRgb =
    nonBlackPixels > 0
      ? [sumR, sumG, sumB].map((value) => value / nonBlackPixels)
      : [0, 0, 0];
  return {
    mask,
    metrics: {
      width: info.width,
      height: info.height,
      channels: info.channels,
      pixelCount,
      rawBytes: data.length,
      rawSha256: sha256(data),
      pngBytes: pngBytes.length,
      pngSha256: sha256(pngBytes),
      nonBlackPixels,
      nonBlackFraction: nonBlackPixels / pixelCount,
      interiorNonBlackPixels,
      centerPatchNonBlackPixels,
      centerPixelRgb: [
        data[centerOffset],
        data[centerOffset + 1],
        data[centerOffset + 2],
      ],
      centerPixelMaximum: Math.max(
        data[centerOffset],
        data[centerOffset + 1],
        data[centerOffset + 2],
      ),
      meanRgb,
      greenDominance: meanRgb[1] - Math.max(meanRgb[0], meanRgb[2]),
      boundingBox:
        nonBlackPixels > 0
          ? {
              minX,
              minY,
              maxX,
              maxY,
              width: maxX - minX + 1,
              height: maxY - minY + 1,
            }
          : null,
    },
  };
}

export function compareBackendCaptures(webgl, webgpu) {
  const comparable =
    webgl?.metrics?.width === webgpu?.metrics?.width &&
    webgl?.metrics?.height === webgpu?.metrics?.height &&
    webgl?.mask?.length === webgpu?.mask?.length &&
    webgl?.mask?.length > 0;
  if (!comparable) {
    return {
      comparable: false,
      bothNonVacuous: false,
      intersectionPixels: 0,
      unionPixels: 0,
      footprintIou: 0,
      footprintRatio: null,
      boundingBoxWidthRatio: null,
      boundingBoxHeightRatio: null,
      meanColorL1: Number.POSITIVE_INFINITY,
    };
  }
  let intersectionPixels = 0;
  let unionPixels = 0;
  for (let pixel = 0; pixel < webgl.mask.length; pixel += 1) {
    const gl = webgl.mask[pixel] === 1;
    const gpu = webgpu.mask[pixel] === 1;
    if (gl && gpu) intersectionPixels += 1;
    if (gl || gpu) unionPixels += 1;
  }
  const webglPixels = webgl.metrics.nonBlackPixels;
  const webgpuPixels = webgpu.metrics.nonBlackPixels;
  const bothNonVacuous =
    webglPixels >= PIXEL_TOLERANCES.minimumNonBlackPixels &&
    webgpuPixels >= PIXEL_TOLERANCES.minimumNonBlackPixels;
  return {
    comparable: true,
    bothNonVacuous,
    intersectionPixels,
    unionPixels,
    footprintIou: unionPixels > 0 ? intersectionPixels / unionPixels : 0,
    footprintRatio: webglPixels > 0 ? webgpuPixels / webglPixels : null,
    boundingBoxWidthRatio:
      webgl.metrics.boundingBox?.width > 0
        ? webgpu.metrics.boundingBox?.width / webgl.metrics.boundingBox.width
        : null,
    boundingBoxHeightRatio:
      webgl.metrics.boundingBox?.height > 0
        ? webgpu.metrics.boundingBox?.height / webgl.metrics.boundingBox.height
        : null,
    meanColorL1: webgl.metrics.meanRgb.reduce(
      (sum, channel, index) =>
        sum + Math.abs(channel - webgpu.metrics.meanRgb[index]),
      0,
    ),
  };
}

async function installPageObservers(
  page,
  backend,
  errors,
  runtimeResponses,
  responseTasks,
) {
  await page.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (!isBaseOrigin(requestUrl)) {
      errors.nonBaseRequests.push({ backend, url: requestUrl });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  page.on("console", (message) => {
    const record = {
      backend,
      type: message.type(),
      text: message.text(),
      location: message.location(),
    };
    if (message.type() === "error") errors.consoleErrors.push(record);
    if (message.type() === "warning") errors.consoleWarnings.push(record);
  });
  page.on("pageerror", (error) => {
    errors.pageErrors.push({ backend, message: error.message });
  });
  page.on("crash", () => {
    errors.pageCrashes.push({ backend, message: "page crashed" });
  });
  page.on("websocket", (socket) => {
    if (!isBaseOrigin(socket.url())) {
      errors.nonBaseWebSockets.push({ backend, url: socket.url() });
    }
  });
  page.on("dialog", async (dialog) => {
    errors.dialogs.push({
      backend,
      type: dialog.type(),
      message: dialog.message(),
    });
    await dialog.dismiss();
  });
  page.on("requestfailed", (request) => {
    errors.requestFailures.push({
      backend,
      url: request.url(),
      error: request.failure()?.errorText ?? "unknown",
    });
  });
  page.on("response", (response) => {
    let parsed;
    try {
      parsed = new URL(response.url());
    } catch {
      errors.malformedResponseUrls.push({ backend, url: response.url() });
      return;
    }
    if (parsed.origin !== BASE_ORIGIN) {
      errors.nonBaseResponses.push({ backend, url: response.url() });
      return;
    }
    if (response.status() >= 400) {
      errors.badResponses.push({
        backend,
        url: response.url(),
        status: response.status(),
      });
    }
    const localPath = TRACKED_RUNTIME_PATHS.get(parsed.pathname);
    if (!localPath) return;
    const task = response
      .body()
      .then((body) => {
        runtimeResponses.push({
          backend,
          pathname: parsed.pathname,
          status: response.status(),
          bytes: body.length,
          sha256: sha256(body),
          localSha256: hashFile(localPath).sha256,
        });
      })
      .catch((error) => {
        errors.responseBodyErrors.push({
          backend,
          pathname: parsed.pathname,
          message: error?.message ?? String(error),
        });
      });
    responseTasks.push(task);
  });
}

async function waitForHarness(page) {
  await page.waitForFunction(
    () => {
      const status = globalThis.__c1113VoxelInsideHarness?.state?.status;
      return status === "READY" || status === "ERROR";
    },
    undefined,
    { timeout: 90_000 },
  );
  const evidence = await page.evaluate(() =>
    globalThis.__c1113VoxelInsideHarness.getEvidence(),
  );
  if (evidence.status !== "READY" || evidence.errors.length !== 0) {
    throw new Error(
      `STRUCTURAL: voxel harness failed to boot: ${JSON.stringify(evidence.errors)}`,
    );
  }
  return evidence;
}

async function openLanes(context, errors, runtimeResponses, responseTasks) {
  const lanes = {};
  for (const backend of BACKENDS) {
    const page = await context.newPage();
    await installPageObservers(
      page,
      backend,
      errors,
      runtimeResponses,
      responseTasks,
    );
    const route = `${BASE}${HARNESS_ROUTE}?renderer=${backend}`;
    const navigation = await page.goto(route, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    lanes[backend] = {
      backend,
      page,
      route,
      navigationStatus: navigation?.status() ?? null,
      initial: await waitForHarness(page),
    };
  }
  return lanes;
}

async function captureWaypoint(lane, waypoint, runDirectory) {
  const prepared = await lane.page.evaluate((waypointId) => {
    return globalThis.__c1113VoxelInsideHarness.prepareWaypoint(waypointId);
  }, waypoint.id);
  const canvas = lane.page.locator("#cesiumContainer canvas");
  if ((await canvas.count()) !== 1) {
    throw new Error(
      `STRUCTURAL: ${lane.backend}/${waypoint.id} did not expose exactly one canvas`,
    );
  }

  let priorHash = null;
  let identicalStreak = 0;
  let finalCapture;
  const attempts = [];
  for (let attempt = 1; attempt <= STABILITY_ATTEMPTS; attempt += 1) {
    const captured = await lane.page.evaluate((frameCount) => {
      return globalThis.__c1113VoxelInsideHarness.capturePixels(frameCount);
    }, STABILITY_FRAMES);
    if (!captured?.capture || !captured?.evidence) {
      throw new Error(
        "STRUCTURAL: same-task capture omitted pixels or matching evidence",
      );
    }
    const capture = captured.capture;
    const clip = normalizeCanvasClip(capture.clip);
    if (
      capture.drawingBufferWidth !== clip.width ||
      capture.drawingBufferHeight !== clip.height ||
      capture.nativeDrawingBufferWidth !== capture.drawingBufferWidth ||
      capture.nativeDrawingBufferHeight !== capture.drawingBufferHeight
    ) {
      throw new Error(
        "STRUCTURAL: canvas/native drawing buffer and viewport dimensions differ",
      );
    }
    const png = decodeCanvasPngDataUrl(capture.dataUrl);
    const analyzed = await analyzePng(png);
    if (
      analyzed.metrics.width !== capture.drawingBufferWidth ||
      analyzed.metrics.height !== capture.drawingBufferHeight
    ) {
      throw new Error(
        "STRUCTURAL: decoded PNG dimensions differ from the drawing buffer",
      );
    }
    identicalStreak =
      analyzed.metrics.rawSha256 === priorHash ? identicalStreak + 1 : 1;
    priorHash = analyzed.metrics.rawSha256;
    attempts.push({
      attempt,
      rawSha256: analyzed.metrics.rawSha256,
      pngSha256: analyzed.metrics.pngSha256,
      nonBlackPixels: analyzed.metrics.nonBlackPixels,
      identicalStreak,
    });
    finalCapture = { png, ...analyzed, evidence: captured.evidence };
    if (identicalStreak >= STABILITY_STREAK) break;
  }
  if (!finalCapture) {
    throw new Error(
      `STRUCTURAL: ${lane.backend}/${waypoint.id} had no capture`,
    );
  }
  const screenshotPath = path.join(
    runDirectory,
    `${String(WAYPOINTS.indexOf(waypoint)).padStart(2, "0")}-${waypoint.id}-${lane.backend}.png`,
  );
  createImmutable(screenshotPath, finalCapture.png);
  const finalEvidence = finalCapture.evidence;
  return {
    public: {
      screenshot: relativePath(screenshotPath),
      screenshotFile: hashFile(screenshotPath),
      metrics: finalCapture.metrics,
      stability: {
        stabilized: identicalStreak >= STABILITY_STREAK,
        requiredIdenticalStreak: STABILITY_STREAK,
        framesPerAttempt: STABILITY_FRAMES,
        attempts,
      },
      evidence: { ...finalEvidence, waypoint: prepared.waypoint },
    },
    mask: finalCapture.mask,
    metrics: finalCapture.metrics,
  };
}

function createErrorLanes() {
  return Object.fromEntries(ERROR_LANE_NAMES.map((name) => [name, []]));
}

function collectRuntimeGateErrors(lanes, errors) {
  for (const backend of BACKENDS) {
    const gate = lanes[backend]?.gate;
    for (const kind of [
      "instrumentationFailures",
      "gpuErrors",
      "deviceLosses",
      "unhandledRejections",
      "windowErrors",
    ]) {
      for (const diagnostic of gate?.[kind] ?? []) {
        errors[kind].push({ backend, diagnostic });
      }
    }
  }
}

async function executeProbe(runDirectory, launchBrowser, browserControl) {
  const errors = createErrorLanes();
  const runtimeResponses = [];
  const responseTasks = [];
  let browser;
  let context;
  let result;
  let contextClosed = false;
  let browserClosed = false;
  try {
    browser = await launchBrowser();
    browserControl.browser = browser;
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      serviceWorkers: "block",
    });
    await context.addInitScript(installRuntimeGate);
    const liveLanes = await openLanes(
      context,
      errors,
      runtimeResponses,
      responseTasks,
    );

    const waypoints = {};
    for (const waypoint of WAYPOINTS) {
      const internal = {};
      const backends = {};
      for (const backend of BACKENDS) {
        internal[backend] = await captureWaypoint(
          liveLanes[backend],
          waypoint,
          runDirectory,
        );
        backends[backend] = internal[backend].public;
      }
      waypoints[waypoint.id] = {
        factor: waypoint.factor,
        inside: waypoint.inside,
        expectedFirstIndex: waypoint.inside ? 36 : 0,
        backends,
        crossBackend: compareBackendCaptures(internal.webgl, internal.webgpu),
      };
    }

    await Promise.allSettled(responseTasks);
    await Promise.all(
      BACKENDS.map((backend) =>
        liveLanes[backend].page.evaluate(
          () => new Promise((resolve) => setTimeout(resolve, 0)),
        ),
      ),
    );
    await Promise.allSettled(responseTasks);

    const lanes = {};
    for (const backend of BACKENDS) {
      lanes[backend] = {
        backend,
        route: liveLanes[backend].route,
        navigationStatus: liveLanes[backend].navigationStatus,
        initial: liveLanes[backend].initial,
        final: await liveLanes[backend].page.evaluate(() =>
          globalThis.__c1113VoxelInsideHarness.getEvidence(),
        ),
        gate: await liveLanes[backend].page.evaluate(runtimeGateSnapshot),
      };
    }
    collectRuntimeGateErrors(lanes, errors);

    result = {
      browserConfig: {
        browser: "Microsoft Edge",
        headless: process.env.PROBE_HEADED !== "1",
        viewport: VIEWPORT,
        harness: "isolated strict-backend Tools-only pages",
        waypointStability: {
          attempts: STABILITY_ATTEMPTS,
          requiredIdenticalStreak: STABILITY_STREAK,
          framesPerAttempt: STABILITY_FRAMES,
        },
      },
      routes: Object.fromEntries(
        BACKENDS.map((backend) => [backend, liveLanes[backend].route]),
      ),
      lanes,
      waypoints,
      runtimeResponses,
      errors,
      checks: [],
      cleanup: {
        contextClosed: false,
        browserClosed: false,
        errors: [],
      },
    };
    result.checks = buildProbeChecks(result);

    const screenshotPaths = WAYPOINTS.flatMap((waypoint) =>
      BACKENDS.map(
        (backend) => waypoints[waypoint.id].backends[backend].screenshot,
      ),
    );
    addCheck(
      result.checks,
      "all fourteen screenshots are immutable unique run paths",
      new Set(screenshotPaths).size === WAYPOINTS.length * BACKENDS.length &&
        screenshotPaths.every((filePath) =>
          filePath.includes(path.basename(runDirectory)),
        ),
      screenshotPaths,
      "14 distinct paths beneath the unique run UUID",
    );

    for (const [pathname, localPath] of TRACKED_RUNTIME_PATHS) {
      const matches = runtimeResponses.filter(
        (response) => response.pathname === pathname,
      );
      const local = hashFile(localPath);
      addCheck(
        result.checks,
        `served bytes match ${pathname}`,
        local.exists === true &&
          matches.length >= 1 &&
          matches.every(
            (response) =>
              response.status === 200 &&
              response.bytes === local.bytes &&
              response.sha256 === local.sha256 &&
              response.localSha256 === local.sha256,
          ),
        matches,
        { responseCount: ">=1", status: 200, ...local },
      );
    }
  } finally {
    if (context) {
      try {
        await context.close();
        contextClosed = true;
      } catch (error) {
        errors.cleanupErrors.push({
          resource: "browser-context",
          message: error?.message ?? String(error),
        });
      }
    }
    if (browser) {
      try {
        await browser.close();
        browserClosed = true;
      } catch (error) {
        errors.cleanupErrors.push({
          resource: "browser",
          message: error?.message ?? String(error),
        });
      }
    }
    browserControl.contextClosed = contextClosed;
    browserControl.browserClosed = browserClosed;
    browserControl.cleanupErrors = structuredClone(errors.cleanupErrors);
    browserControl.browser = null;
    if (result) {
      result.cleanup.contextClosed = contextClosed;
      result.cleanup.browserClosed = browserClosed;
      result.cleanup.errors = structuredClone(errors.cleanupErrors);
      const errorLaneCheck = result.checks.find(
        (check) =>
          check.name ===
          "all console/page/device/external-request lanes are empty",
      );
      if (errorLaneCheck) {
        errorLaneCheck.pass = errorLanesAreEmpty(errors);
        errorLaneCheck.actual = errors;
      }
      addCheck(
        result.checks,
        "browser context and browser are closed during probe cleanup",
        contextClosed && browserClosed,
        result.cleanup,
        { contextClosed: true, browserClosed: true },
      );
    }
  }
  return result;
}

export async function withWatchdog(
  task,
  browserControl,
  watchdogMs = WATCHDOG_MS,
) {
  if (!Number.isFinite(watchdogMs) || watchdogMs <= 0) {
    throw new Error("STRUCTURAL: watchdog duration must be positive");
  }
  browserControl.watchdogCleanupErrors ??= [];
  let timer;
  const observedTask = Promise.resolve(task).then(
    (value) => ({ kind: "fulfilled", value }),
    (error) => ({ kind: "rejected", error }),
  );
  try {
    const winner = await Promise.race([
      observedTask,
      new Promise((resolve) => {
        timer = setTimeout(() => {
          resolve({ kind: "watchdog" });
        }, watchdogMs);
      }),
    ]);
    if (winner.kind === "fulfilled") {
      browserControl.probeTaskDrained = true;
      return winner.value;
    }
    if (winner.kind === "rejected") {
      browserControl.probeTaskDrained = true;
      throw winner.error;
    }

    browserControl.watchdogTimedOut = true;
    const browser = browserControl.browser;
    if (browser) {
      browserControl.watchdogCloseAttempted = true;
      try {
        await browser.close();
        browserControl.watchdogBrowserClosed = true;
      } catch (error) {
        browserControl.watchdogCleanupErrors.push({
          resource: "browser",
          message: error?.message ?? String(error),
        });
      }
    }

    // Do not let the timeout branch race ahead to immutable artifact
    // publication. Closing Edge causes executeProbe to enter its finally; this
    // await drains that losing task, including context/browser close evidence.
    // If driver cleanup itself hangs, the entry point's later outer watchdog
    // terminates the process without publishing a falsely complete artifact.
    const settledProbe = await observedTask;
    browserControl.probeTaskDrained = true;
    const cleanupDetail =
      settledProbe.kind === "rejected"
        ? `; drained probe error: ${settledProbe.error?.message ?? String(settledProbe.error)}`
        : "; drained probe after timeout";
    throw new Error(`WATCHDOG: exceeded ${watchdogMs} ms${cleanupDetail}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function runVoxelInsideCameraProbe(launchBrowser) {
  if (typeof launchBrowser !== "function") {
    throw new Error("STRUCTURAL: launchBrowser callback is required");
  }
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const runDirectory = path.join(OUTPUT_ROOT, runId);
  fs.mkdirSync(runDirectory, { recursive: false });
  const runArtifact = path.join(
    EVIDENCE_DIR,
    `c11-13-voxel-inside-camera.run-${runId}.json`,
  );
  const firstRedAtStart = firstRedFingerprint();
  const startProvenance = collectLocalProvenance();
  atomicReplace(
    CANONICAL_ARTIFACT,
    serializeJson({
      schema: 1,
      campaign: "C11-13",
      probe: "voxel camera-inside strict dual-backend waypoint acceptance",
      runId,
      status: "RUNNING",
      incomplete: true,
      startedAt,
      baseUrl: BASE,
      startProvenance,
      firstRedAtStart,
    }),
  );

  let artifact;
  let exitCode;
  const browserControl = {
    browser: null,
    watchdogTimedOut: false,
    watchdogCloseAttempted: false,
    watchdogBrowserClosed: false,
    probeTaskDrained: false,
    watchdogCleanupErrors: [],
    contextClosed: false,
    browserClosed: false,
    cleanupErrors: [],
  };
  try {
    const result = await withWatchdog(
      executeProbe(runDirectory, launchBrowser, browserControl),
      browserControl,
    );
    result.cleanup.watchdog = {
      timedOut: browserControl.watchdogTimedOut,
      closeAttempted: browserControl.watchdogCloseAttempted,
      browserClosed: browserControl.watchdogBrowserClosed,
      probeTaskDrained: browserControl.probeTaskDrained,
      errors: browserControl.watchdogCleanupErrors,
    };
    const endProvenance = collectLocalProvenance();
    addCheck(
      result.checks,
      "source, build, probe, policy, harness, and provider bytes stayed stable",
      provenanceStable(startProvenance, endProvenance),
      { start: startProvenance, end: endProvenance },
      "all required start/end SHA-256 values identical",
    );
    const buildAssessment = assessBuildProvenance(
      endProvenance,
      fs.readFileSync(LOCAL_PATHS.rendererSource, "utf8"),
      fs.readFileSync(LOCAL_PATHS.engineBundle, "utf8"),
    );
    addCheck(
      result.checks,
      "served engine build contains and postdates the exact C11-13 source",
      buildAssessment.pass,
      { provenance: endProvenance, failures: buildAssessment.failures },
      "fresh build with all four C11-13 source/build sentinels",
    );
    const firstRedBeforeFinalize = firstRedFingerprint();
    addCheck(
      result.checks,
      "pre-existing first-red stayed byte-identical during the run",
      firstRedAtStart.exists === firstRedBeforeFinalize.exists &&
        firstRedAtStart.bytes === firstRedBeforeFinalize.bytes &&
        firstRedAtStart.sha256 === firstRedBeforeFinalize.sha256,
      { start: firstRedAtStart, end: firstRedBeforeFinalize },
      "identical existence, byte count, and SHA-256",
    );
    const failures = result.checks.filter((check) => !check.pass);
    const status = failures.length === 0 ? "PASS" : "FAIL";
    exitCode = status === "PASS" ? 0 : 1;
    artifact = {
      schema: 1,
      campaign: "C11-13",
      probe: "voxel camera-inside strict dual-backend waypoint acceptance",
      runId,
      status,
      incomplete: false,
      exitCode,
      startedAt,
      completedAt: new Date().toISOString(),
      baseUrl: BASE,
      startProvenance,
      endProvenance,
      provenanceStable: provenanceStable(startProvenance, endProvenance),
      firstRedAtStart,
      ...result,
      failures,
    };
  } catch (error) {
    const message = error?.stack ?? String(error);
    const structural = /STRUCTURAL:/u.test(message);
    exitCode = structural ? 3 : 2;
    artifact = {
      schema: 1,
      campaign: "C11-13",
      probe: "voxel camera-inside strict dual-backend waypoint acceptance",
      runId,
      status: structural ? "STRUCTURAL" : "ERROR",
      incomplete: false,
      exitCode,
      startedAt,
      completedAt: new Date().toISOString(),
      baseUrl: BASE,
      startProvenance,
      firstRedAtStart,
      cleanup: {
        contextClosed: browserControl.contextClosed,
        browserClosed: browserControl.browserClosed,
        watchdog: {
          timedOut: browserControl.watchdogTimedOut,
          closeAttempted: browserControl.watchdogCloseAttempted,
          browserClosed: browserControl.watchdogBrowserClosed,
          probeTaskDrained: browserControl.probeTaskDrained,
          errors: browserControl.watchdogCleanupErrors,
        },
        errors: browserControl.cleanupErrors,
      },
      error: message,
    };
  }

  const artifactBytes = serializeJson(artifact);
  createImmutable(runArtifact, artifactBytes);
  atomicReplace(CANONICAL_ARTIFACT, artifactBytes);
  const runHash = hashFile(runArtifact);
  const canonicalHash = hashFile(CANONICAL_ARTIFACT);
  if (
    runHash.bytes !== canonicalHash.bytes ||
    runHash.sha256 !== canonicalHash.sha256
  ) {
    throw new Error("canonical artifact is not byte-identical to run archive");
  }
  const firstRed =
    artifact.status === "PASS"
      ? null
      : preserveFirstRed(FIRST_RED_ARTIFACT, artifactBytes);
  console.log(
    serializeJson({
      campaign: artifact.campaign,
      runId,
      status: artifact.status,
      exitCode,
      artifact: canonicalHash,
      immutableRunArtifact: runHash,
      firstRed,
      failures: artifact.failures ?? [artifact.error],
    }).trimEnd(),
  );
  process.exitCode = exitCode;
  return artifact;
}
