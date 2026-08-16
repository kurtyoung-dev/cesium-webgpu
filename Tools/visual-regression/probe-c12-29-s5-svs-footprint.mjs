#!/usr/bin/env node
/**
 * C12-29 S5 absolute NASA-SVS 5073 geospatial-footprint acceptance.
 * @purpose Absolute NASA-SVS 5073 eclipse geospatial-footprint acceptance over the vendored four-row fixture + local QuantizedMesh, serial WebGL/WebGPU
 * @status ACTIVE
 *
 * Runs serial WebGL/WebGPU contexts against the vendored four-row fixture and
 * local QuantizedMesh. It never fetches the network, recentres a result, builds
 * Cesium, or starts a server. A mature lock/receipt lifecycle is used so an
 * interrupted run cannot masquerade as evidence.
 */

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { types as utilTypes } from "node:util";

import { chromium } from "playwright";
import sharp from "sharp";

import {
  C12_29_S5_SVS_BUILD_SOURCE_FILES,
  C12_29_S5_SVS_BUILD_SOURCE_MAP,
  C12_29_S5_SVS_ARTIFACT_PREFIX,
  C12_29_S5_SVS_CAPTURE_LABELS,
  C12_29_S5_SVS_CAPTURE_METHOD,
  C12_29_S5_SVS_CAPTURE_STATES,
  C12_29_S5_SVS_CONTROL,
  C12_29_S5_SVS_DIAGNOSTIC_LIMITS,
  C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
  C12_29_S5_SVS_EPHEMERIS,
  C12_29_S5_SVS_FIXTURE,
  C12_29_S5_SVS_IMAGE_VERIFIER_METHOD,
  C12_29_S5_SVS_PHASES,
  C12_29_S5_SVS_RENDERERS,
  C12_29_S5_SVS_ROWS,
  C12_29_S5_SVS_SCENE,
  C12_29_S5_SVS_SCHEMA,
  C12_29_S5_SVS_SIMON1994_BUDGET_KM,
  C12_29_S5_SVS_SOURCE_EDGE,
  C12_29_S5_SVS_SOURCE_FILES,
  C12_29_S5_SVS_SOURCE_MOTION,
  C12_29_S5_SVS_SUPERSEDED_V4_SCHEMA,
  C12_29_S5_SVS_SUPERSEDED_SCHEMA,
  C12_29_S5_SVS_LEGACY_ERROR_SCHEMA,
  C12_29_S5_SVS_TERRAIN,
  createSvsDiagnosticOverflowMarker,
  deriveSvsWgs84ProjectedLattice,
  exitCodeForSvsStatus,
  foldC1229S5SvsGate,
  isUuidV4,
  summarizeSvsSpatialMetrics,
  validateSupersededSvsV2FinalArtifactShape,
  validateSupersededSvsV3FinalArtifactShape,
  validateSupersededSvsV4FinalArtifactShape,
  validateSupersededSvsV4RunningArtifactShape,
  validateSvsErrorDiagnosticsShape,
  validateSvsFinalArtifactShape,
  validateSvsRunningArtifactShape,
  wgs84GeodesicDistanceKm,
} from "./lib/c12-29-s5-svs-footprint-gate.mjs";
import { parseSvs5073UmbraShapefile } from "./fixtures/nasa-svs-5073/nasa-svs-5073-shapefile.mjs";
import {
  compareEvidenceFileSnapshots,
  createImmutableEvidence,
  fingerprintEvidenceFile,
  inspectBuildSourceIdentity,
  safeGitHead,
  snapshotEvidenceFiles,
  validateServedEntryIdentities,
} from "./lib/build-source-identity.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const probePath = fileURLToPath(import.meta.url);
const helperPath = fileURLToPath(
  new URL("./lib/c12-29-s5-svs-footprint-gate.mjs", import.meta.url),
);
const captureHelperPath = fileURLToPath(
  new URL("./lib/same-task-capture.mjs", import.meta.url),
);
const parserPath = fileURLToPath(
  new URL(
    "./fixtures/nasa-svs-5073/nasa-svs-5073-shapefile.mjs",
    import.meta.url,
  ),
);
const manifestPath = path.join(
  toolDirectory,
  "fixtures/nasa-svs-5073/manifest.json",
);
const specPath = path.join(
  toolDirectory,
  "c12-29-s5-svs-footprint-gate.spec.mjs",
);
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const buildSourceMapPath = path.join(
  repositoryRoot,
  C12_29_S5_SVS_BUILD_SOURCE_MAP,
);
const xysDirectory = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/Assets/IAU2006_XYS",
);
// Resolved on first USE, not on import: the directory is a build output, so
// scanning it at module scope made the probe — and the focused spec that
// imports it for the pure functions beside it — do filesystem work merely to
// be loaded. An absent directory is tolerated here and reported as missing
// evidence downstream, where a reason can be attached to it.
let xysAssetFilesCache;

function xysAssetFiles() {
  xysAssetFilesCache ??= Object.freeze(
    (fs.existsSync(xysDirectory) ? fs.readdirSync(xysDirectory) : [])
      .filter((file) => /^IAU2006_XYS_\d+\.json$/u.test(file))
      .sort((left, right) => left.localeCompare(right)),
  );
  return xysAssetFilesCache;
}
const runtimePath = "/Build/CesiumUnminified/index.js";
const viewerPath = "/Apps/CesiumViewer/index.html";
const base = process.env.PROBE_BASE ?? "http://localhost:8080";
const outputDirectory = path.resolve(
  process.env.C12_29_S5_SVS_OUTPUT_DIR ??
    path.join(toolDirectory, "output/c12-29-s5-svs-footprint"),
);
const artifactPrefix = C12_29_S5_SVS_ARTIFACT_PREFIX;
const WATCHDOG_MS = 540_000;
const PAGE_TIMEOUT_MS = 240_000;
const WATCHDOG_DRAIN_MS = 30_000;
const CLOSE_TIMEOUT_MS = 15_000;
// The in-run watchdog plus its drain, with a minute of slack, is the longest a
// healthy run can legitimately take; past that the process itself is stuck.
const PROCESS_WATCHDOG_MS = WATCHDOG_MS + WATCHDOG_DRAIN_MS + 60_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const svsOwnerships = new WeakMap();

export function createSvsRequestLedger(baseOrigin) {
  const pendingRequests = new Set();
  const externalRequestObjects = new Set();
  const externalRequests = [];
  const failedRequests = [];
  const xysResponses = [];
  const responseBodyTasks = new Set();
  const responseBodyErrors = [];
  const lateEvents = [];
  let requestStartedCount = 0;
  let requestSettledCount = 0;
  let pendingRequestPeak = 0;
  let generation = 0;
  let sealed = false;

  const requestUrl = (request) => {
    try {
      return typeof request?.url === "function"
        ? request.url()
        : String(request?.url ?? "");
    } catch {
      return "<unreadable-request-url>";
    }
  };
  const touch = (kind) => {
    generation++;
    if (sealed) {
      lateEvents.push({ kind, generation });
    }
  };
  const settle = (request, kind) => {
    touch(kind);
    if (pendingRequests.delete(request)) requestSettledCount++;
  };

  const ledger = {
    noteRequest(request) {
      touch("request-started");
      if (!pendingRequests.has(request)) {
        pendingRequests.add(request);
        requestStartedCount++;
        pendingRequestPeak = Math.max(pendingRequestPeak, pendingRequests.size);
      }
    },
    noteExternalRequest(request) {
      touch("external-request");
      externalRequestObjects.add(request);
      externalRequests.push(requestUrl(request));
    },
    noteRequestFinished(request) {
      settle(request, "request-finished");
    },
    noteRequestFailed(request) {
      settle(request, "request-failed");
      if (!externalRequestObjects.has(request)) {
        failedRequests.push(requestUrl(request));
      }
    },
    trackXysResponse({ route, status, body }) {
      touch("xys-response");
      const task = Promise.resolve()
        .then(body)
        .then(
          (bytes) => {
            const immutable = Buffer.from(bytes);
            xysResponses.push({
              route,
              status,
              byteLength: immutable.byteLength,
              sha256: sha256(immutable),
            });
          },
          (error) => {
            responseBodyErrors.push(
              error?.stack ?? error?.message ?? String(error),
            );
          },
        )
        .finally(() => {
          responseBodyTasks.delete(task);
          touch("xys-body-settled");
        });
      responseBodyTasks.add(task);
      return task;
    },
    pendingResponseTasks() {
      return [...responseBodyTasks];
    },
    inspect() {
      return {
        generation,
        sealed,
        pendingRequests: pendingRequests.size,
        requestStartedCount,
        requestSettledCount,
        pendingRequestPeak,
        externalRequests: externalRequests.length,
        failedRequests: failedRequests.length,
        responseBodiesPending: responseBodyTasks.size,
        responseBodyErrors: responseBodyErrors.length,
        lateEvents,
      };
    },
    seal(quiescentStableTurns) {
      const state = ledger.inspect();
      if (
        sealed ||
        state.pendingRequests !== 0 ||
        state.responseBodiesPending !== 0 ||
        state.responseBodyErrors !== 0
      ) {
        throw new Error("SVS request ledger cannot seal before quiescence");
      }
      sealed = true;
      return {
        ledgerMethod: "generation-aware-post-cleanup-response-drain",
        ledgerSealed: true,
        ledgerGeneration: generation,
        quiescentStableTurns,
        postSealTurnObserved: false,
        pendingRequests: 0,
        requestStartedCount,
        requestSettledCount,
        pendingRequestPeak,
        externalRequests: externalRequests.length,
        failedRequests: failedRequests.length,
        responseBodiesPending: 0,
        responseBodyErrors: 0,
        lateEvents,
        xysResponses: [...xysResponses].sort((left, right) =>
          left.route.localeCompare(right.route),
        ),
      };
    },
  };
  return ledger;
}

export async function drainSvsRequestLedger(
  ledger,
  timeoutMs = CLOSE_TIMEOUT_MS,
  requiredStableTurns = 3,
) {
  const deadline = Date.now() + timeoutMs;
  let stableTurns = 0;
  let priorGeneration;
  while (stableTurns < requiredStableTurns) {
    const tasks = ledger.pendingResponseTasks();
    if (tasks.length > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error("SVS response-body drain timed out");
      }
      let timer;
      const drained = await Promise.race([
        Promise.all(tasks).then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (!drained) throw new Error("SVS response-body drain timed out");
    }
    if (Date.now() >= deadline) {
      throw new Error("SVS request-ledger quiescence timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = ledger.inspect();
    if (state.responseBodyErrors !== 0) {
      throw new Error("SVS XYS response body was unreadable");
    }
    const quiescent =
      state.pendingRequests === 0 && state.responseBodiesPending === 0;
    stableTurns =
      quiescent && state.generation === priorGeneration ? stableTurns + 1 : 0;
    priorGeneration = state.generation;
  }
  const snapshot = ledger.seal(requiredStableTurns);
  if (Date.now() >= deadline) {
    throw new Error("SVS request-ledger post-seal turn timed out");
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  snapshot.postSealTurnObserved = true;
  if (snapshot.lateEvents.length !== 0) {
    throw new Error("SVS request event occurred after ledger seal");
  }
  return snapshot;
}

export function validateSvsLoopbackBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`SVS base is not absolute: ${error.message}`, {
      cause: error,
    });
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    !new Set(["localhost", "127.0.0.1", "::1"]).has(host) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !new Set(["", "/"]).has(url.pathname)
  ) {
    throw new Error("SVS evidence base must be credential-free loopback root");
  }
  return { origin: url.origin, href: `${url.origin}/` };
}

export function createSvsArtifactPaths(runId, directory = outputDirectory) {
  if (!isUuidV4(runId)) throw new Error("SVS runId must be UUIDv4");
  return Object.freeze({
    directory,
    run: path.join(directory, `${artifactPrefix}.${runId}.json`),
    latest: path.join(directory, `${artifactPrefix}.latest.json`),
    firstRed: path.join(directory, `${artifactPrefix}.first-red.json`),
    lock: path.join(directory, `${artifactPrefix}.running.lock.json`),
    runningReceipt: path.join(
      directory,
      `${artifactPrefix}.${runId}.running.json`,
    ),
    finalReceipt: path.join(
      directory,
      `${artifactPrefix}.${runId}.receipt.json`,
    ),
  });
}

export function canonicalSvsArtifactBytes(value) {
  const canonicalValue = cloneSvsJsonSafe(value);
  const json = JSON.stringify(
    canonicalValue,
    (key, entry) => {
      if (
        typeof entry === "number" &&
        (!Number.isFinite(entry) || Object.is(entry, -0))
      ) {
        throw new TypeError(
          `SVS canonical JSON rejects non-finite or negative-zero number at ${key || "$"}`,
        );
      }
      return entry;
    },
    2,
  );
  if (typeof json !== "string") {
    throw new TypeError("SVS canonical JSON root is not serializable");
  }
  return Buffer.from(`${json}\n`, "utf8");
}

const artifactBytes = canonicalSvsArtifactBytes;

function cloneSvsJsonSafe(value, path = "$", ancestors = new Set()) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(
        `SVS JSON-safe value rejects non-finite or negative-zero number at ${path}`,
      );
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(
      `SVS JSON-safe value rejects ${typeof value} at ${path}`,
    );
  }
  try {
    if (ancestors.has(value)) {
      throw new TypeError(`SVS JSON-safe value rejects a cycle at ${path}`);
    }
    if (utilTypes.isProxy(value)) {
      throw new TypeError(`SVS JSON-safe value rejects a Proxy at ${path}`);
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && ![Object.prototype, null].includes(prototype))
    ) {
      throw new TypeError(
        `SVS JSON-safe value has a custom prototype at ${path}`,
      );
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string")) {
      throw new TypeError(`SVS JSON-safe value has a symbol key at ${path}`);
    }
    ancestors.add(value);
    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (
        lengthDescriptor === undefined ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        lengthDescriptor.enumerable !== false ||
        !Number.isInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > 1_000_000 ||
        keys.length !== lengthDescriptor.value + 1 ||
        keys.at(-1) !== "length"
      ) {
        throw new TypeError(`SVS JSON-safe array shape differs at ${path}`);
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
            `SVS JSON-safe array rejects holes, accessors, or hidden keys at ${path}[${index}]`,
          );
        }
        clone.push(
          cloneSvsJsonSafe(descriptor.value, `${path}[${index}]`, ancestors),
        );
      }
      ancestors.delete(value);
      return clone;
    }
    const clone = prototype === null ? Object.create(null) : {};
    for (const key of [...keys].sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError(
          `SVS JSON-safe object rejects accessors or non-enumerable keys at ${path}.${key}`,
        );
      }
      Object.defineProperty(clone, key, {
        value: cloneSvsJsonSafe(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    ancestors.delete(value);
    return clone;
  } catch (error) {
    ancestors.delete(value);
    if (error instanceof TypeError && /^SVS JSON-safe/u.test(error.message)) {
      throw error;
    }
    throw new TypeError(`SVS JSON-safe value is not inspectable at ${path}`, {
      cause: error,
    });
  }
}

function svsErrorText(error) {
  for (const key of ["stack", "message"]) {
    try {
      const value = error?.[key];
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      // Continue to the next non-throwing representation.
    }
  }
  try {
    const value = String(error);
    if (value.length > 0) return value;
  } catch {
    // The retained fallback remains deterministic even for a hostile Proxy.
  }
  return "[SVS uninspectable error]";
}

function boundedSvsDiagnosticText(
  value,
  maximumCharacters,
  category,
  allowEmpty = false,
) {
  let text = typeof value === "string" ? value : svsErrorText(value);
  if (!allowEmpty && text.length === 0) {
    text = `[SVS empty ${category}]`;
  }
  if (text.length <= maximumCharacters) return text;
  let omitted = text.length - maximumCharacters;
  let suffix;
  for (let attempt = 0; attempt < 8; attempt++) {
    suffix = `\n[SVS_TRUNCATED ${category} omittedCharacters=${omitted}]`;
    const retainedCharacters = Math.max(0, maximumCharacters - suffix.length);
    const exactOmitted = text.length - retainedCharacters;
    if (exactOmitted === omitted) break;
    omitted = exactOmitted;
  }
  suffix = `\n[SVS_TRUNCATED ${category} omittedCharacters=${omitted}]`;
  return `${text.slice(0, Math.max(0, maximumCharacters - suffix.length))}${suffix}`.slice(
    0,
    maximumCharacters,
  );
}

function normalizeSvsDiagnosticArray(
  value,
  category,
  maximumEntries = C12_29_S5_SVS_DIAGNOSTIC_LIMITS.arrayEntries,
  declaredTotal,
) {
  let entries;
  try {
    entries = cloneSvsJsonSafe(value);
  } catch (error) {
    if (declaredTotal !== undefined) {
      throw new TypeError(
        `SVS ${category} declared diagnostics are unreadable`,
        {
          cause: error,
        },
      );
    }
    return {
      total: 1,
      entries: [
        boundedSvsDiagnosticText(
          `[SVS ${category} capture rejected: ${svsErrorText(error)}]`,
          C12_29_S5_SVS_DIAGNOSTIC_LIMITS.entryCharacters,
          `${category}[capture]`,
          true,
        ),
      ],
    };
  }
  if (!Array.isArray(entries)) {
    if (declaredTotal !== undefined) {
      throw new TypeError(
        `SVS ${category} declared diagnostics are not an array`,
      );
    }
    return {
      total: 1,
      entries: [`[SVS ${category} capture rejected: expected array]`],
    };
  }
  const existingOverflow =
    Number.isSafeInteger(declaredTotal) &&
    declaredTotal > maximumEntries &&
    entries.length === maximumEntries &&
    entries.at(-1) ===
      createSvsDiagnosticOverflowMarker(
        category,
        declaredTotal,
        maximumEntries - 1,
      );
  if (
    declaredTotal !== undefined &&
    (!Number.isSafeInteger(declaredTotal) ||
      declaredTotal < 0 ||
      (!existingOverflow && declaredTotal !== entries.length))
  ) {
    throw new TypeError(`SVS ${category} declared diagnostic count differs`);
  }
  const total = declaredTotal ?? entries.length;
  const retained =
    total > maximumEntries ? Math.max(0, maximumEntries - 1) : total;
  const normalized = entries.slice(0, retained).map((entry, index) => {
    let text = typeof entry === "string" ? entry : svsErrorText(entry);
    if (text.startsWith(`[SVS_OVERFLOW ${category} `)) {
      text = `[SVS_LITERAL]${text}`;
    }
    return boundedSvsDiagnosticText(
      text,
      C12_29_S5_SVS_DIAGNOSTIC_LIMITS.entryCharacters,
      `${category}[${index}]`,
      true,
    );
  });
  if (total > maximumEntries) {
    normalized.push(
      createSvsDiagnosticOverflowMarker(category, total, retained),
    );
  }
  return { total, entries: normalized };
}

function normalizeSvsRuntimeCleanup(cleanup) {
  if (cleanup === null) return null;
  const safe = cloneSvsJsonSafe(cleanup);
  if (!safe || typeof safe !== "object" || Array.isArray(safe)) return safe;
  const sourceErrorCount = safe.errorCount;
  const sourceErrors = safe.errors;
  const normalized = normalizeSvsDiagnosticArray(
    sourceErrors,
    "cleanup.errors",
    C12_29_S5_SVS_DIAGNOSTIC_LIMITS.cleanupEntries,
    sourceErrorCount,
  );
  safe.errors = normalized.entries;
  safe.errorCount = normalized.total;
  return safe;
}

export function createSvsRuntimeErrorDiagnostics({
  renderer,
  runtimeCheckpoint = null,
  checkpointReadError = null,
  pageErrors = [],
  pageErrorCount,
  consoleErrors = [],
  consoleErrorCount,
  originalError,
  stage = "page-session-error",
  cleanup = null,
}) {
  if (
    !C12_29_S5_SVS_RENDERERS.includes(renderer) ||
    typeof stage !== "string" ||
    stage.length === 0
  ) {
    throw new TypeError("SVS runtime diagnostics inputs are invalid");
  }
  const checkpoint = cloneSvsJsonSafe(runtimeCheckpoint);
  if (
    checkpoint !== null &&
    (checkpoint?.schema !== C12_29_S5_SVS_DIAGNOSTICS_SCHEMA ||
      checkpoint?.renderer !== renderer)
  ) {
    throw new TypeError("SVS runtime checkpoint identity differs");
  }
  const normalizedPageErrors = normalizeSvsDiagnosticArray(
    pageErrors,
    "pageErrors",
    C12_29_S5_SVS_DIAGNOSTIC_LIMITS.arrayEntries,
    pageErrorCount,
  );
  const normalizedConsoleErrors = normalizeSvsDiagnosticArray(
    consoleErrors,
    "consoleErrors",
    C12_29_S5_SVS_DIAGNOSTIC_LIMITS.arrayEntries,
    consoleErrorCount,
  );
  const diagnostics = cloneSvsJsonSafe({
    schema: C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
    kind: "runtime-page-session-error",
    renderer,
    stage,
    runtimeCheckpoint: checkpoint,
    checkpointReadError:
      checkpointReadError === null
        ? null
        : boundedSvsDiagnosticText(
            checkpointReadError,
            C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
            "checkpointReadError",
          ),
    pageErrorCount: normalizedPageErrors.total,
    pageErrors: normalizedPageErrors.entries,
    consoleErrorCount: normalizedConsoleErrors.total,
    consoleErrors: normalizedConsoleErrors.entries,
    cleanup: normalizeSvsRuntimeCleanup(cleanup),
    originalError: boundedSvsDiagnosticText(
      originalError,
      C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
      "originalError",
    ),
  });
  const reasons = validateSvsErrorDiagnosticsShape(diagnostics, {
    requireCleanup: cleanup !== null,
  });
  if (reasons.length > 0) {
    throw new TypeError(
      `SVS runtime diagnostics differ: ${reasons.join("; ")}`,
    );
  }
  return diagnostics;
}

export function createSvsOperationalErrorDiagnostics(
  originalError,
  stage = "probe-before-page",
) {
  const diagnostics = cloneSvsJsonSafe({
    schema: C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
    kind: "operational-pre-page-error",
    renderer: null,
    stage,
    runtimeCheckpoint: null,
    checkpointReadError: null,
    pageErrorCount: 0,
    pageErrors: [],
    consoleErrorCount: 0,
    consoleErrors: [],
    cleanup: null,
    originalError: boundedSvsDiagnosticText(
      originalError,
      C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
      "originalError",
    ),
  });
  const reasons = validateSvsErrorDiagnosticsShape(diagnostics);
  if (reasons.length > 0) {
    throw new TypeError(
      `SVS operational diagnostics differ: ${reasons.join("; ")}`,
    );
  }
  return diagnostics;
}

function createSvsCleanupErrorDiagnostics({
  renderer,
  pageErrors,
  consoleErrors,
  cleanup,
  originalError,
}) {
  const normalizedPageErrors = normalizeSvsDiagnosticArray(
    pageErrors,
    "pageErrors",
  );
  const normalizedConsoleErrors = normalizeSvsDiagnosticArray(
    consoleErrors,
    "consoleErrors",
  );
  const diagnostics = cloneSvsJsonSafe({
    schema: C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
    kind: "runtime-session-cleanup-error",
    renderer,
    stage: "session-cleanup-error",
    runtimeCheckpoint: null,
    checkpointReadError: null,
    pageErrorCount: normalizedPageErrors.total,
    pageErrors: normalizedPageErrors.entries,
    consoleErrorCount: normalizedConsoleErrors.total,
    consoleErrors: normalizedConsoleErrors.entries,
    cleanup: normalizeSvsRuntimeCleanup(cleanup),
    originalError: boundedSvsDiagnosticText(
      originalError,
      C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
      "originalError",
    ),
  });
  const reasons = validateSvsErrorDiagnosticsShape(diagnostics);
  if (reasons.length > 0) {
    throw new TypeError(
      `SVS cleanup diagnostics differ: ${reasons.join("; ")}`,
    );
  }
  return diagnostics;
}

export async function retainSvsRuntimeDiagnostics(
  page,
  error,
  { renderer, pageErrors = [], consoleErrors = [], cleanup = null },
) {
  let runtimeCheckpoint = null;
  let checkpointReadError = null;
  try {
    runtimeCheckpoint = await page.evaluate(
      () => globalThis.__c1229SvsRuntimeCheckpoint ?? null,
    );
  } catch (readError) {
    checkpointReadError = readError;
  }
  let diagnostics;
  try {
    diagnostics = createSvsRuntimeErrorDiagnostics({
      renderer,
      runtimeCheckpoint,
      checkpointReadError,
      pageErrors,
      consoleErrors,
      originalError: error,
      cleanup,
    });
  } catch (retentionError) {
    diagnostics = createSvsRuntimeErrorDiagnostics({
      renderer,
      runtimeCheckpoint: null,
      checkpointReadError: new AggregateError(
        [checkpointReadError, retentionError].filter(Boolean),
        "SVS runtime checkpoint retention failed",
      ),
      pageErrors,
      consoleErrors,
      originalError: error,
      cleanup,
    });
  }
  const retainedError =
    error instanceof Error && Object.isExtensible(error)
      ? error
      : new Error(svsErrorText(error), { cause: error });
  retainedError.diagnostics = diagnostics;
  return retainedError;
}

export function createSvsErrorArtifact(
  runId,
  error,
  generatedAt = new Date().toISOString(),
) {
  return {
    schema: C12_29_S5_SVS_SCHEMA,
    runId,
    generatedAt,
    status: "ERROR",
    exitCode: exitCodeForSvsStatus("ERROR"),
    incomplete: false,
    error: boundedSvsDiagnosticText(
      error,
      C12_29_S5_SVS_DIAGNOSTIC_LIMITS.errorCharacters,
      "artifact.error",
    ),
    diagnostics:
      error?.diagnostics === undefined
        ? createSvsOperationalErrorDiagnostics(error)
        : cloneSvsJsonSafe(error.diagnostics),
  };
}

function parseJsonFile(file, operations = fs) {
  try {
    return JSON.parse(operations.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function readExactLatestSnapshot(file, operations = fs) {
  let bytes;
  try {
    bytes = Buffer.from(operations.readFileSync(file));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { file, exists: false, bytes: undefined, value: undefined };
    }
    throw new Error("SVS canonical latest is unreadable", { cause: error });
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("SVS canonical latest is not exact JSON", { cause: error });
  }
  const runningReasons = validateSvsRunningArtifactShape(value);
  const supersededV4RunningReasons =
    validateSupersededSvsV4RunningArtifactShape(value);
  const finalReasons = validateSvsFinalArtifactShape(value);
  const supersededV4Reasons = validateSupersededSvsV4FinalArtifactShape(value);
  const supersededV3Reasons = validateSupersededSvsV3FinalArtifactShape(value);
  const supersededV2Reasons = validateSupersededSvsV2FinalArtifactShape(value);
  if (
    runningReasons.length > 0 &&
    supersededV4RunningReasons.length > 0 &&
    finalReasons.length > 0 &&
    supersededV4Reasons.length > 0 &&
    supersededV3Reasons.length > 0 &&
    supersededV2Reasons.length > 0
  ) {
    throw new Error(
      `SVS canonical latest shape is invalid: RUNNING ${runningReasons.join(
        "; ",
      )}; v4-RUNNING ${supersededV4RunningReasons.join("; ")}; final ${finalReasons.join("; ")}; superseded-v4 ${supersededV4Reasons.join("; ")}; superseded-v3 ${supersededV3Reasons.join("; ")}; superseded-v2 ${supersededV2Reasons.join("; ")}`,
    );
  }
  const supersededV4 = supersededV4Reasons.length === 0;
  const supersededV4Running = supersededV4RunningReasons.length === 0;
  const supersededV3 = supersededV3Reasons.length === 0;
  if (
    (runningReasons.length === 0 ||
      finalReasons.length === 0 ||
      supersededV4 ||
      supersededV4Running ||
      supersededV3) &&
    !bytes.equals(canonicalSvsArtifactBytes(value))
  ) {
    throw new Error("SVS v5/v4/v3 latest is not canonical JSON");
  }
  return {
    file,
    exists: true,
    bytes,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    value,
    supersededV4,
    supersededV4Running,
    supersededV3,
    supersededV2: supersededV2Reasons.length === 0,
  };
}

function publicFirstRedSnapshot(snapshot) {
  return snapshot.exists
    ? {
        file: snapshot.file,
        exists: true,
        byteLength: snapshot.byteLength,
        sha256: snapshot.sha256,
        status: snapshot.value.status,
        runId: snapshot.value.runId,
      }
    : {
        file: snapshot.file,
        exists: false,
        byteLength: null,
        sha256: null,
        error: "ENOENT",
      };
}

function readExactFirstRedSnapshot(file, operations = fs) {
  let bytes;
  try {
    bytes = Buffer.from(operations.readFileSync(file));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { file, exists: false, bytes: undefined };
    }
    throw new Error("SVS first-red integrity is unreadable", { cause: error });
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("SVS retained first-red artifact is not exact JSON", {
      cause: error,
    });
  }
  const reasons = validateSvsFinalArtifactShape(value);
  const supersededV4Reasons = validateSupersededSvsV4FinalArtifactShape(value);
  const supersededV3Reasons = validateSupersededSvsV3FinalArtifactShape(value);
  const supersededV2Reasons = validateSupersededSvsV2FinalArtifactShape(value);
  if (
    (reasons.length > 0 &&
      supersededV4Reasons.length > 0 &&
      supersededV3Reasons.length > 0 &&
      supersededV2Reasons.length > 0) ||
    !new Set(["FAIL", "STRUCTURAL", "ERROR"]).has(value.status)
  ) {
    throw new Error(
      `SVS retained first-red artifact is not exact final red: ${reasons.join("; ")}; superseded-v4 ${supersededV4Reasons.join("; ")}; superseded-v3 ${supersededV3Reasons.join("; ")}; superseded-v2 ${supersededV2Reasons.join("; ")}`,
    );
  }
  if (
    (reasons.length === 0 ||
      supersededV4Reasons.length === 0 ||
      supersededV3Reasons.length === 0) &&
    !bytes.equals(canonicalSvsArtifactBytes(value))
  ) {
    throw new Error("SVS retained v5/v4/v3 first-red is not canonical JSON");
  }
  return {
    file,
    exists: true,
    bytes,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    value,
  };
}

function firstRedSnapshotsEqual(left, right) {
  if (left?.exists !== right?.exists) {
    return false;
  }
  if (left.exists === false) {
    return true;
  }
  return (
    left.exists === true &&
    right.exists === true &&
    left.byteLength === right.byteLength &&
    left.sha256 === right.sha256 &&
    left.bytes.equals(right.bytes)
  );
}

function requireFirstRedSnapshot(paths, expected, operations = fs) {
  const observed = readExactFirstRedSnapshot(paths.firstRed, operations);
  if (!firstRedSnapshotsEqual(observed, expected)) {
    throw new Error("SVS first-red ownership/stability changed");
  }
  return observed;
}

export function inspectSvsPriorState(paths, operations = fs) {
  const lock = parseJsonFile(paths.lock, operations);
  if (lock) throw new Error(`SVS lock already exists for ${lock.runId}`);
  const latestSnapshot = readExactLatestSnapshot(paths.latest, operations);
  const latest = latestSnapshot.exists ? latestSnapshot.value : undefined;
  const firstRedSnapshot = readExactFirstRedSnapshot(
    paths.firstRed,
    operations,
  );
  return {
    latest: latest ?? null,
    latestSnapshot,
    firstRed: publicFirstRedSnapshot(firstRedSnapshot),
    firstRedSnapshot,
  };
}

function writeExclusiveVerified(file, bytes, operations = fs) {
  operations.writeFileSync(file, bytes, { flag: "wx" });
  if (!operations.readFileSync(file).equals(Buffer.from(bytes))) {
    throw new Error(`SVS exclusive write verification failed: ${file}`);
  }
}

function requireExactRecoveryReceipt(
  file,
  expectedBytes,
  expectedRunning,
  operations = fs,
) {
  let observedBytes;
  try {
    observedBytes = Buffer.from(operations.readFileSync(file));
  } catch (error) {
    throw new Error("SVS stale-RUNNING recovery receipt is unreadable", {
      cause: error,
    });
  }
  let observed;
  try {
    observed = JSON.parse(observedBytes.toString("utf8"));
  } catch (error) {
    throw new Error("SVS stale-RUNNING recovery receipt is not exact JSON", {
      cause: error,
    });
  }
  const reasons =
    expectedRunning?.schema === C12_29_S5_SVS_SUPERSEDED_V4_SCHEMA
      ? validateSupersededSvsV4RunningArtifactShape(observed)
      : validateSvsRunningArtifactShape(observed);
  if (
    !observedBytes.equals(Buffer.from(expectedBytes)) ||
    reasons.length > 0 ||
    observed.runId !== expectedRunning.runId ||
    observed.nonce !== expectedRunning.nonce ||
    observed.generatedAt !== expectedRunning.generatedAt
  ) {
    throw new Error(
      `SVS stale-RUNNING recovery receipt differs: ${reasons.join("; ")}`,
    );
  }
  return {
    file,
    byteLength: observedBytes.byteLength,
    sha256: sha256(observedBytes),
  };
}

function ensureExactRecoveryReceipt(
  file,
  expectedBytes,
  expectedRunning,
  operations = fs,
) {
  try {
    writeExclusiveVerified(file, expectedBytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return requireExactRecoveryReceipt(
    file,
    expectedBytes,
    expectedRunning,
    operations,
  );
}

function requireExactSupersededV4Receipt(
  file,
  expectedBytes,
  expectedArtifact,
  operations = fs,
) {
  let observedBytes;
  try {
    observedBytes = Buffer.from(operations.readFileSync(file));
  } catch (error) {
    throw new Error("SVS superseded-v4 receipt is unreadable", {
      cause: error,
    });
  }
  let observed;
  try {
    observed = JSON.parse(observedBytes.toString("utf8"));
  } catch (error) {
    throw new Error("SVS superseded-v4 receipt is not exact JSON", {
      cause: error,
    });
  }
  const reasons = validateSupersededSvsV4FinalArtifactShape(observed);
  if (
    !observedBytes.equals(Buffer.from(expectedBytes)) ||
    !observedBytes.equals(canonicalSvsArtifactBytes(observed)) ||
    reasons.length > 0 ||
    observed.runId !== expectedArtifact.runId ||
    observed.generatedAt !== expectedArtifact.generatedAt ||
    observed.status !== expectedArtifact.status
  ) {
    throw new Error(`SVS superseded-v4 receipt differs: ${reasons.join("; ")}`);
  }
  return {
    file,
    schema: C12_29_S5_SVS_SUPERSEDED_V4_SCHEMA,
    runId: observed.runId,
    status: observed.status,
    byteLength: observedBytes.byteLength,
    sha256: sha256(observedBytes),
  };
}

function ensureExactSupersededV4Receipt(
  file,
  expectedBytes,
  expectedArtifact,
  operations = fs,
) {
  try {
    writeExclusiveVerified(file, expectedBytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return requireExactSupersededV4Receipt(
    file,
    expectedBytes,
    expectedArtifact,
    operations,
  );
}

function requireExactSupersededV3Receipt(
  file,
  expectedBytes,
  expectedArtifact,
  operations = fs,
) {
  let observedBytes;
  try {
    observedBytes = Buffer.from(operations.readFileSync(file));
  } catch (error) {
    throw new Error("SVS superseded-v3 receipt is unreadable", {
      cause: error,
    });
  }
  let observed;
  try {
    observed = JSON.parse(observedBytes.toString("utf8"));
  } catch (error) {
    throw new Error("SVS superseded-v3 receipt is not exact JSON", {
      cause: error,
    });
  }
  const reasons = validateSupersededSvsV3FinalArtifactShape(observed);
  if (
    !observedBytes.equals(Buffer.from(expectedBytes)) ||
    !observedBytes.equals(canonicalSvsArtifactBytes(observed)) ||
    reasons.length > 0 ||
    observed.runId !== expectedArtifact.runId ||
    observed.generatedAt !== expectedArtifact.generatedAt ||
    observed.status !== expectedArtifact.status
  ) {
    throw new Error(`SVS superseded-v3 receipt differs: ${reasons.join("; ")}`);
  }
  return {
    file,
    schema: C12_29_S5_SVS_SUPERSEDED_SCHEMA,
    runId: observed.runId,
    status: observed.status,
    byteLength: observedBytes.byteLength,
    sha256: sha256(observedBytes),
  };
}

function ensureExactSupersededV3Receipt(
  file,
  expectedBytes,
  expectedArtifact,
  operations = fs,
) {
  try {
    writeExclusiveVerified(file, expectedBytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return requireExactSupersededV3Receipt(
    file,
    expectedBytes,
    expectedArtifact,
    operations,
  );
}

function requireExactSupersededV2Receipt(
  file,
  expectedBytes,
  expectedArtifact,
  operations = fs,
) {
  let observedBytes;
  try {
    observedBytes = Buffer.from(operations.readFileSync(file));
  } catch (error) {
    throw new Error("SVS superseded-v2 receipt is unreadable", {
      cause: error,
    });
  }
  let observed;
  try {
    observed = JSON.parse(observedBytes.toString("utf8"));
  } catch (error) {
    throw new Error("SVS superseded-v2 receipt is not exact JSON", {
      cause: error,
    });
  }
  const reasons = validateSupersededSvsV2FinalArtifactShape(observed);
  if (
    !observedBytes.equals(Buffer.from(expectedBytes)) ||
    reasons.length > 0 ||
    observed.runId !== expectedArtifact.runId ||
    observed.generatedAt !== expectedArtifact.generatedAt ||
    observed.status !== expectedArtifact.status
  ) {
    throw new Error(`SVS superseded-v2 receipt differs: ${reasons.join("; ")}`);
  }
  return {
    file,
    schema: C12_29_S5_SVS_LEGACY_ERROR_SCHEMA,
    runId: observed.runId,
    status: observed.status,
    byteLength: observedBytes.byteLength,
    sha256: sha256(observedBytes),
  };
}

function ensureExactSupersededV2Receipt(
  file,
  expectedBytes,
  expectedArtifact,
  operations = fs,
) {
  try {
    writeExclusiveVerified(file, expectedBytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  return requireExactSupersededV2Receipt(
    file,
    expectedBytes,
    expectedArtifact,
    operations,
  );
}

function requireOwnedLock(paths, lockBytes, operations = fs) {
  if (
    !Buffer.isBuffer(lockBytes) ||
    !operations.readFileSync(paths.lock).equals(lockBytes)
  ) {
    throw new Error("SVS lock ownership changed");
  }
}

function readOptionalExactBytes(file, label, operations = fs) {
  try {
    return { exists: true, bytes: Buffer.from(operations.readFileSync(file)) };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, bytes: undefined };
    throw new Error(`SVS ${label} is unreadable`, { cause: error });
  }
}

function removeExactReceipt(file, expectedBytes, label, operations = fs) {
  const expected = Buffer.from(expectedBytes);
  const before = readOptionalExactBytes(file, label, operations);
  if (!before.exists) return;
  if (!before.bytes.equals(expected)) {
    throw new Error(`SVS ${label} identity changed before cleanup`);
  }
  try {
    operations.unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const after = readOptionalExactBytes(file, label, operations);
  if (after.exists) {
    if (!after.bytes.equals(expected)) {
      throw new Error(`SVS ${label} was replaced during cleanup`);
    }
    throw new Error(`SVS ${label} cleanup silently retained the receipt`);
  }
}

function restoreReceiptExclusively(
  receipt,
  canonical,
  expectedBytes,
  label,
  operations = fs,
) {
  const expected = Buffer.from(expectedBytes);
  const receiptBefore = readOptionalExactBytes(receipt, label, operations);
  if (!receiptBefore.exists || !receiptBefore.bytes.equals(expected)) {
    return {
      restored: false,
      error: new Error(`SVS ${label} is not the exact claimed identity`),
    };
  }
  let linkError;
  try {
    // Hard-link creation is exclusive. A newer canonical owner wins EEXIST
    // and can never be overwritten by receipt restoration.
    operations.linkSync(receipt, canonical);
  } catch (error) {
    linkError = error;
  }
  let current = readOptionalExactBytes(
    canonical,
    "canonical latest",
    operations,
  );
  let createError;
  if (!current.exists) {
    try {
      // Some filesystems or injected failure surfaces do not support links.
      // `wx` retains the same no-overwrite property; a write-then-throw is
      // reconciled from the exact bytes below.
      operations.writeFileSync(canonical, expected, { flag: "wx" });
    } catch (error) {
      createError = error;
    }
    current = readOptionalExactBytes(
      canonical,
      "canonical latest after exclusive restore",
      operations,
    );
  }
  if (!current.exists || !current.bytes.equals(expected)) {
    return {
      restored: false,
      error:
        createError ??
        linkError ??
        new Error(`SVS ${label} could not be restored without overwrite`),
    };
  }
  const receiptAfter = readOptionalExactBytes(receipt, label, operations);
  if (!receiptAfter.exists || !receiptAfter.bytes.equals(expected)) {
    return {
      restored: true,
      error: new Error(`SVS ${label} changed after exclusive restoration`),
    };
  }
  try {
    removeExactReceipt(receipt, expected, label, operations);
    return { restored: true, error: undefined };
  } catch (error) {
    return { restored: true, error };
  }
}

function reconcileFailedLatestReplacement(
  paths,
  candidateBytes,
  priorReceipt,
  expectedPriorBytes,
  operations = fs,
) {
  const candidate = Buffer.from(candidateBytes);
  const hasPrior =
    typeof priorReceipt === "string" && expectedPriorBytes !== undefined;
  const expectedPrior = hasPrior ? Buffer.from(expectedPriorBytes) : undefined;
  const cleanupErrors = [];
  let before;
  try {
    before = readOptionalExactBytes(
      paths.latest,
      "failed canonical latest",
      operations,
    );
  } catch (error) {
    cleanupErrors.push(error);
  }

  // A foreign successor never enters a claim/restore cycle. Only the exact
  // candidate published by this invocation may be moved for cleanup.
  if (before?.exists && before.bytes.equals(candidate)) {
    const failedReceipt = `${paths.latest}.failed.${randomUUID()}.receipt`;
    let claimError;
    try {
      operations.renameSync(paths.latest, failedReceipt);
    } catch (error) {
      claimError = error;
    }

    let claimed;
    let canonicalAfterClaim;
    try {
      claimed = readOptionalExactBytes(
        failedReceipt,
        "failed-latest claim receipt",
        operations,
      );
      canonicalAfterClaim = readOptionalExactBytes(
        paths.latest,
        "canonical latest after failed claim",
        operations,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }

    const exactCandidateReceipt =
      claimed?.exists === true && claimed.bytes.equals(candidate);
    let nonCandidateReceiptReconciled = false;
    if (claimed?.exists && !exactCandidateReceipt) {
      // The candidate was replaced between the pre-claim read and rename.
      // Restore that displaced foreign identity exclusively; a still newer
      // canonical owner wins and is never overwritten.
      const restoredForeign = restoreReceiptExclusively(
        failedReceipt,
        paths.latest,
        claimed.bytes,
        "foreign raced failed-latest claim receipt",
        operations,
      );
      if (!restoredForeign.restored || restoredForeign.error) {
        cleanupErrors.push(
          restoredForeign.error ??
            new Error(
              "SVS raced foreign latest could not be restored exclusively",
            ),
        );
      } else {
        nonCandidateReceiptReconciled = true;
      }
    }
    if (exactCandidateReceipt) {
      try {
        removeExactReceipt(
          failedReceipt,
          claimed.bytes,
          "owned failed-latest claim receipt",
          operations,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (canonicalAfterClaim?.exists) {
      if (canonicalAfterClaim.bytes.equals(candidate)) {
        cleanupErrors.push(
          new Error(
            "SVS failed canonical latest still contains the owned candidate",
            { cause: claimError },
          ),
        );
      }
      // A different identity is a foreign successor and remains in place.
    } else if (!exactCandidateReceipt && !nonCandidateReceiptReconciled) {
      cleanupErrors.push(
        new Error(
          "SVS failed-latest claim left neither canonical bytes nor an exact candidate receipt",
          { cause: claimError },
        ),
      );
    }
  }

  let canonical;
  try {
    canonical = readOptionalExactBytes(
      paths.latest,
      "canonical latest after reconciliation",
      operations,
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (canonical?.exists) {
    if (canonical.bytes.equals(candidate)) {
      cleanupErrors.push(
        new Error("SVS owned candidate remains canonical after reconciliation"),
      );
    } else if (hasPrior) {
      try {
        removeExactReceipt(
          priorReceipt,
          expectedPrior,
          "owned prior-latest receipt",
          operations,
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  } else if (canonical && hasPrior) {
    let observedReceipt;
    try {
      observedReceipt = readOptionalExactBytes(
        priorReceipt,
        "prior-latest claim receipt",
        operations,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    const receiptBytes = observedReceipt?.exists
      ? observedReceipt.bytes
      : expectedPrior;
    const receiptIsExpectedPrior = receiptBytes.equals(expectedPrior);
    const restoredPrior = restoreReceiptExclusively(
      priorReceipt,
      paths.latest,
      receiptBytes,
      receiptIsExpectedPrior
        ? "owned prior-latest receipt"
        : "foreign raced prior-latest claim receipt",
      operations,
    );
    if (!restoredPrior.restored || restoredPrior.error) {
      cleanupErrors.push(
        restoredPrior.error ??
          new Error("SVS prior latest could not be restored exclusively"),
      );
    }
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "SVS canonical latest failure reconciliation was not exact",
    );
  }
}

function removeTemporaryAfterFailure(temporary, operations = fs) {
  try {
    if (operations.existsSync(temporary)) operations.unlinkSync(temporary);
    if (operations.existsSync(temporary)) {
      throw new Error("SVS latest temporary cleanup silently retained bytes");
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

function reconcileLatestFailureOrThrow(
  primaryError,
  paths,
  temporary,
  candidateBytes,
  priorReceipt,
  expectedPriorBytes,
  operations,
  message,
) {
  const cleanupErrors = [];
  const temporaryError = removeTemporaryAfterFailure(temporary, operations);
  if (temporaryError) cleanupErrors.push(temporaryError);
  try {
    reconcileFailedLatestReplacement(
      paths,
      candidateBytes,
      priorReceipt,
      expectedPriorBytes,
      operations,
    );
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], message, {
      cause: primaryError,
    });
  }
  throw primaryError;
}

function replaceLatestOwned(
  paths,
  bytes,
  lockBytes,
  tag,
  expectedPriorBytes,
  operations = fs,
) {
  requireOwnedLock(paths, lockBytes, operations);
  const temporary = `${paths.latest}.${tag}.${randomUUID()}.tmp`;
  writeExclusiveVerified(temporary, bytes, operations);
  if (expectedPriorBytes === undefined) {
    try {
      // With no observed prior latest, only an exclusive create is legal. A
      // late owner that wins this pathname is never receipt-claimed or read-
      // then-unlinked by this invocation.
      requireOwnedLock(paths, lockBytes, operations);
      operations.linkSync(temporary, paths.latest);
      requireOwnedLock(paths, lockBytes, operations);
      if (!operations.readFileSync(paths.latest).equals(Buffer.from(bytes))) {
        throw new Error("SVS exclusive canonical latest verification failed");
      }
      operations.unlinkSync(temporary);
      if (operations.existsSync(temporary)) {
        throw new Error("SVS exclusive latest temporary cleanup failed");
      }
      return;
    } catch (error) {
      reconcileLatestFailureOrThrow(
        error,
        paths,
        temporary,
        bytes,
        undefined,
        undefined,
        operations,
        "SVS exclusive latest failed and owned cleanup was not exact",
      );
    }
  }

  const expectedPrior = Buffer.from(expectedPriorBytes);
  const priorReceipt = `${paths.latest}.${tag}.${randomUUID()}.prior`;
  try {
    if (!operations.readFileSync(paths.latest).equals(expectedPrior)) {
      throw new Error("SVS canonical latest changed before owned claim");
    }
    try {
      operations.renameSync(paths.latest, priorReceipt);
    } catch (error) {
      if (
        operations.existsSync(priorReceipt) &&
        !operations.existsSync(paths.latest)
      ) {
        // The rename completed before the injected/operational throw.
      } else {
        throw error;
      }
    }
    if (!operations.readFileSync(priorReceipt).equals(expectedPrior)) {
      throw new Error("SVS canonical latest changed during owned claim");
    }
    requireOwnedLock(paths, lockBytes, operations);
    // Hard-link publication is an atomic exclusive create. A foreign latest
    // inserted after our claim survives with EEXIST instead of being replaced.
    try {
      operations.linkSync(temporary, paths.latest);
    } catch (error) {
      if (
        !operations.existsSync(paths.latest) ||
        !operations.readFileSync(paths.latest).equals(Buffer.from(bytes))
      ) {
        throw error;
      }
    }
    requireOwnedLock(paths, lockBytes, operations);
    if (!operations.readFileSync(paths.latest).equals(Buffer.from(bytes))) {
      throw new Error("SVS canonical latest verification failed");
    }
    operations.unlinkSync(temporary);
    operations.unlinkSync(priorReceipt);
    if (
      operations.existsSync(temporary) ||
      operations.existsSync(priorReceipt)
    ) {
      throw new Error("SVS canonical latest cleanup receipt remains");
    }
  } catch (error) {
    reconcileLatestFailureOrThrow(
      error,
      paths,
      temporary,
      bytes,
      priorReceipt,
      expectedPrior,
      operations,
      "SVS canonical latest replacement failed and reconciliation retained ownership evidence",
    );
  }
}

function releaseOwnedLock(paths, lockBytes, operations = fs) {
  requireOwnedLock(paths, lockBytes, operations);
  const receipt = `${paths.lock}.release.${randomUUID()}.receipt`;
  try {
    operations.renameSync(paths.lock, receipt);
  } catch (error) {
    if (
      !operations.existsSync(receipt) ||
      !operations.readFileSync(receipt).equals(lockBytes)
    ) {
      throw error;
    }
  }
  if (!operations.readFileSync(receipt).equals(lockBytes)) {
    if (!operations.existsSync(paths.lock)) {
      operations.renameSync(receipt, paths.lock);
    }
    throw new Error("SVS lock release claim differs");
  }
  if (operations.existsSync(paths.lock)) {
    throw new Error("SVS new canonical lock appeared during release");
  }
  try {
    operations.unlinkSync(receipt);
  } catch (error) {
    if (operations.existsSync(receipt)) throw error;
  }
  if (operations.existsSync(receipt) || operations.existsSync(paths.lock)) {
    if (!operations.existsSync(paths.lock)) {
      operations.renameSync(receipt, paths.lock);
    }
    throw new Error(
      "SVS lock release could not prove canonical and receipt absence",
    );
  }
}

function snapshotCurrentRedBytes(file, bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  const reasons = validateSvsFinalArtifactShape(value);
  if (
    reasons.length > 0 ||
    !new Set(["FAIL", "STRUCTURAL", "ERROR"]).has(value.status)
  ) {
    throw new Error(
      `SVS current first-red candidate is invalid: ${reasons.join("; ")}`,
    );
  }
  return {
    file,
    exists: true,
    bytes: Buffer.from(bytes),
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    value,
  };
}

function preserveOwnedFirstRed(paths, bytes, baseline, operations = fs) {
  const candidate = snapshotCurrentRedBytes(paths.firstRed, bytes);
  let writeReturned = false;
  let writeError;
  try {
    createImmutableEvidence(paths.firstRed, bytes, operations);
    writeReturned = true;
  } catch (error) {
    writeError = error;
  }
  const retained = readExactFirstRedSnapshot(paths.firstRed, operations);
  if (baseline.exists) {
    if (writeReturned || !firstRedSnapshotsEqual(retained, baseline)) {
      throw new Error(
        "SVS retained first-red changed from its exact baseline",
        {
          cause: writeError,
        },
      );
    }
    if (writeError?.code !== "EEXIST") throw writeError;
    return {
      written: false,
      ...publicFirstRedSnapshot(retained),
      snapshot: retained,
    };
  }
  if (
    writeError?.code === "EEXIST" ||
    !firstRedSnapshotsEqual(retained, candidate)
  ) {
    throw new Error("SVS late first-red owner won the exclusive-create race", {
      cause: writeError,
    });
  }
  if (writeError && !retained.exists) throw writeError;
  return {
    written: true,
    ...publicFirstRedSnapshot(retained),
    snapshot: retained,
  };
}

export function beginSvsEvidenceRun(paths, runId, operations = fs) {
  operations.mkdirSync(paths.directory, { recursive: true });
  const prior = inspectSvsPriorState(paths, operations);
  const nonce = randomUUID();
  const running = {
    schema: C12_29_S5_SVS_SCHEMA,
    runId,
    status: "RUNNING",
    incomplete: true,
    nonce,
    generatedAt: new Date().toISOString(),
  };
  const lock = { ...running, kind: "exclusive-run-lock", released: false };
  const lockBytes = artifactBytes(lock);
  const runningBytes = artifactBytes(running);
  writeExclusiveVerified(paths.lock, lockBytes, operations);
  try {
    writeExclusiveVerified(paths.runningReceipt, runningBytes, operations);
    let recovery = null;
    let supersededV4 = null;
    let supersededV3 = null;
    let supersededV2 = null;
    if (prior.latestSnapshot.supersededV4 === true) {
      const supersededBytes = Buffer.from(prior.latestSnapshot.bytes);
      recovery = `${paths.latest}.superseded-v4-${prior.latest.runId}.json`;
      supersededV4 = ensureExactSupersededV4Receipt(
        recovery,
        supersededBytes,
        prior.latest,
        operations,
      );
    } else if (prior.latestSnapshot.supersededV3 === true) {
      const supersededBytes = Buffer.from(prior.latestSnapshot.bytes);
      recovery = `${paths.latest}.superseded-v3-${prior.latest.runId}.json`;
      supersededV3 = ensureExactSupersededV3Receipt(
        recovery,
        supersededBytes,
        prior.latest,
        operations,
      );
    } else if (prior.latestSnapshot.supersededV2 === true) {
      const supersededBytes = Buffer.from(prior.latestSnapshot.bytes);
      recovery = `${paths.latest}.superseded-v2-${prior.latest.runId}.json`;
      supersededV2 = ensureExactSupersededV2Receipt(
        recovery,
        supersededBytes,
        prior.latest,
        operations,
      );
    } else if (prior.latest?.status === "RUNNING") {
      const recoveredBytes = Buffer.from(prior.latestSnapshot.bytes);
      recovery = `${paths.latest}.recovered-${prior.latest.runId}.json`;
      ensureExactRecoveryReceipt(
        recovery,
        recoveredBytes,
        prior.latest,
        operations,
      );
    }
    const expectedPriorBytes = prior.latestSnapshot.exists
      ? Buffer.from(prior.latestSnapshot.bytes)
      : undefined;
    replaceLatestOwned(
      paths,
      runningBytes,
      lockBytes,
      "running",
      expectedPriorBytes,
      operations,
    );
    if (recovery) {
      if (supersededV4) {
        supersededV4 = requireExactSupersededV4Receipt(
          recovery,
          prior.latestSnapshot.bytes,
          prior.latest,
          operations,
        );
      } else if (supersededV3) {
        supersededV3 = requireExactSupersededV3Receipt(
          recovery,
          prior.latestSnapshot.bytes,
          prior.latest,
          operations,
        );
      } else if (supersededV2) {
        supersededV2 = requireExactSupersededV2Receipt(
          recovery,
          prior.latestSnapshot.bytes,
          prior.latest,
          operations,
        );
      } else {
        requireExactRecoveryReceipt(
          recovery,
          prior.latestSnapshot.bytes,
          prior.latest,
          operations,
        );
      }
    }
    const ownership = {
      prior,
      firstRedBaseline: prior.firstRedSnapshot,
      firstRedBaselineValidated: true,
      running,
      runningBytes,
      lock,
      lockBytes,
      recovery,
      supersededV4,
      supersededV3,
      supersededV2,
    };
    svsOwnerships.set(running, ownership);
    return ownership;
  } catch (error) {
    // Claim and release only our exact lock; a late foreign replacement stays.
    try {
      releaseOwnedLock(paths, lockBytes, operations);
    } catch {
      // Preserve the original failure and any foreign owner state.
    }
    throw error;
  }
}

function requireOwnedSupersessionReceipt(ownership, operations = fs) {
  if (ownership.supersededV4 !== null && ownership.supersededV4 !== undefined) {
    return requireExactSupersededV4Receipt(
      ownership.recovery,
      ownership.prior.latestSnapshot.bytes,
      ownership.prior.latest,
      operations,
    );
  }
  if (ownership.supersededV3 !== null && ownership.supersededV3 !== undefined) {
    return requireExactSupersededV3Receipt(
      ownership.recovery,
      ownership.prior.latestSnapshot.bytes,
      ownership.prior.latest,
      operations,
    );
  }
  if (ownership.supersededV2 !== null && ownership.supersededV2 !== undefined) {
    return requireExactSupersededV2Receipt(
      ownership.recovery,
      ownership.prior.latestSnapshot.bytes,
      ownership.prior.latest,
      operations,
    );
  }
  return null;
}

export function publishSvsFinalArtifact(
  paths,
  artifact,
  ownership,
  operations = fs,
) {
  let publicationStarted = false;
  let firstRedStabilityChecks = 0;
  try {
    ownership = svsOwnerships.get(ownership) ?? ownership;
    const {
      running,
      runningBytes,
      lockBytes,
      firstRedBaseline,
      firstRedBaselineValidated,
    } = ownership;
    requireOwnedLock(paths, lockBytes, operations);
    requireOwnedSupersessionReceipt(ownership, operations);
    if (!operations.readFileSync(paths.latest).equals(runningBytes)) {
      throw new Error("SVS latest is not the owned RUNNING receipt");
    }
    const shapeReasons = validateSvsFinalArtifactShape(artifact);
    if (
      shapeReasons.length > 0 ||
      artifact?.runId !== running.runId ||
      firstRedBaselineValidated !== true
    ) {
      throw new Error(
        `SVS final artifact/lifecycle proof is invalid: ${shapeReasons.join("; ")}`,
      );
    }
    publicationStarted = true;
    requireFirstRedSnapshot(paths, firstRedBaseline, operations);
    firstRedStabilityChecks++;
    const bytes = artifactBytes(artifact);
    try {
      createImmutableEvidence(paths.run, bytes, operations);
    } catch (error) {
      const written = fingerprintEvidenceFile(paths.run, operations);
      if (
        written.exists !== true ||
        written.byteLength !== bytes.byteLength ||
        written.sha256 !== sha256(bytes)
      ) {
        throw error;
      }
    }
    const archive = fingerprintEvidenceFile(paths.run, operations);
    if (
      archive.exists !== true ||
      archive.byteLength !== bytes.byteLength ||
      archive.sha256 !== sha256(bytes)
    ) {
      throw new Error("SVS immutable archive verification failed");
    }
    requireOwnedSupersessionReceipt(ownership, operations);
    let expectedFirstRed = firstRedBaseline;
    let firstRed = {
      written: false,
      ...publicFirstRedSnapshot(firstRedBaseline),
    };
    if (artifact.status !== "PASS") {
      const preserved = preserveOwnedFirstRed(
        paths,
        bytes,
        firstRedBaseline,
        operations,
      );
      expectedFirstRed = preserved.snapshot;
      const { snapshot: _snapshot, ...publicProof } = preserved;
      firstRed = publicProof;
    }
    requireFirstRedSnapshot(paths, expectedFirstRed, operations);
    firstRedStabilityChecks++;
    requireOwnedLock(paths, lockBytes, operations);
    replaceLatestOwned(
      paths,
      bytes,
      lockBytes,
      "final",
      runningBytes,
      operations,
    );
    const latest = fingerprintEvidenceFile(paths.latest, operations);
    if (
      latest.exists !== true ||
      latest.byteLength !== archive.byteLength ||
      latest.sha256 !== archive.sha256
    ) {
      throw new Error("SVS archive/latest identity differs");
    }
    requireOwnedSupersessionReceipt(ownership, operations);
    const receipt = {
      schema: C12_29_S5_SVS_SCHEMA,
      runId: running.runId,
      status: artifact.status,
      incomplete: false,
      archive,
      latestByteIdentical: latest.sha256 === archive.sha256,
    };
    writeExclusiveVerified(
      paths.finalReceipt,
      artifactBytes(receipt),
      operations,
    );
    const firstRedCurrent = requireFirstRedSnapshot(
      paths,
      expectedFirstRed,
      operations,
    );
    firstRedStabilityChecks++;
    if (!operations.readFileSync(paths.latest).equals(bytes)) {
      throw new Error("SVS canonical final latest changed before unlock");
    }
    requireOwnedSupersessionReceipt(ownership, operations);
    requireOwnedLock(paths, lockBytes, operations);
    releaseOwnedLock(paths, lockBytes, operations);
    return {
      archive,
      latest,
      firstRed,
      firstRedStable: firstRedStabilityChecks === 3,
      firstRedStabilityChecks,
      firstRedBaseline: publicFirstRedSnapshot(firstRedBaseline),
      firstRedCurrent: publicFirstRedSnapshot(firstRedCurrent),
      receipt,
    };
  } catch (error) {
    if (publicationStarted) error.retainSvsRunning = true;
    throw error;
  }
}

async function generatedShaderIsExact(rawRelative, generatedRelative) {
  const raw = fs
    .readFileSync(path.join(repositoryRoot, rawRelative), "utf8")
    .replaceAll("\r\n", "\n");
  const generated = await import(
    `${pathToFileURL(path.join(repositoryRoot, generatedRelative)).href}?svs=${randomUUID()}`
  );
  return generated.default === raw;
}

// Built on first USE, not on import: the XYS asset list is read from a build
// output, so materializing this map at module scope made loading the probe an
// act of filesystem inspection.
let evidenceFilesCache;

function evidenceFiles() {
  evidenceFilesCache ??= Object.freeze({
    helper: helperPath,
    captureHelper: captureHelperPath,
    parser: parserPath,
    fixtureManifest: manifestPath,
    spec: specPath,
    probe: probePath,
    buildEntry: buildEntryPath,
    buildSourceMap: buildSourceMapPath,
    ...Object.fromEntries(
      C12_29_S5_SVS_SOURCE_FILES.map((file, index) => [
        `source${String(index).padStart(2, "0")}`,
        path.join(repositoryRoot, file),
      ]),
    ),
    ...Object.fromEntries(
      Object.keys(C12_29_S5_SVS_FIXTURE.members).map((extension) => [
        `fixture${extension}`,
        path.join(
          toolDirectory,
          "fixtures/nasa-svs-5073",
          `${C12_29_S5_SVS_FIXTURE.stem}.${extension}`,
        ),
      ]),
    ),
    terrainLayer: path.join(repositoryRoot, C12_29_S5_SVS_TERRAIN.layer.file),
    terrainTile: path.join(repositoryRoot, C12_29_S5_SVS_TERRAIN.tile.file),
    ...Object.fromEntries(
      xysAssetFiles().map((file) => [
        `xys:${file}`,
        path.join(xysDirectory, file),
      ]),
    ),
  });
  return evidenceFilesCache;
}

async function collectProvenanceSnapshot() {
  const local = snapshotEvidenceFiles(evidenceFiles());
  const reasons = Object.entries(local)
    .filter(([, identity]) => identity.exists !== true)
    .map(([name]) => `${name}: unreadable`);
  let buildSourceIdentity;
  try {
    buildSourceIdentity = inspectBuildSourceIdentity({
      sourceMapPath: buildSourceMapPath,
      sourceFiles: C12_29_S5_SVS_BUILD_SOURCE_FILES.map((file) =>
        path.join(repositoryRoot, file),
      ),
    });
  } catch (error) {
    buildSourceIdentity = {
      ok: false,
      entries: [],
      reasons: [error?.message ?? String(error)],
    };
  }
  reasons.push(...buildSourceIdentity.reasons);
  const generatedShaders = {
    globeFsExact: await generatedShaderIsExact(
      "packages/engine/Source/Shaders/GlobeFS.glsl",
      "packages/engine/Source/Shaders/GlobeFS.js",
    ),
    globeTerrainExact: await generatedShaderIsExact(
      "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.wgsl",
      "packages/engine/Source/Shaders/WebGPU/Globe/GlobeTerrain.js",
    ),
  };
  if (!generatedShaders.globeFsExact || !generatedShaders.globeTerrainExact) {
    reasons.push("raw/generated globe shader identity differs");
  }
  return {
    capturedAt: new Date().toISOString(),
    gitHead: safeGitHead(repositoryRoot),
    local,
    buildSourceIdentity,
    generatedShaders,
    reasons,
    ok: reasons.length === 0,
  };
}

function assessProvenance(start, end, sessions) {
  const stability = compareEvidenceFileSnapshots(start.local, end.local);
  const servedEntry = validateServedEntryIdentities({
    entries: sessions.map((session) => session.servedEntry).filter(Boolean),
    expectedLabels: [...C12_29_S5_SVS_RENDERERS],
    localEntry: start.local.buildEntry,
  });
  const reasons = [
    ...start.reasons,
    ...end.reasons,
    ...stability.reasons,
    ...servedEntry.reasons,
  ];
  for (const session of sessions) {
    for (const entry of session.ephemeris?.xysFiles ?? []) {
      const file = path.basename(entry.route);
      entry.localStart = start.local[`xys:${file}`] ?? null;
      entry.localEnd = end.local[`xys:${file}`] ?? null;
      if (
        entry.localStart?.exists !== true ||
        entry.localEnd?.exists !== true ||
        entry.localStart.byteLength !== entry.byteLength ||
        entry.localEnd.byteLength !== entry.byteLength ||
        entry.localStart.sha256 !== entry.sha256 ||
        entry.localEnd.sha256 !== entry.sha256
      ) {
        reasons.push(`${session.renderer}: served XYS ${file} differs locally`);
      }
    }
  }
  if (start.gitHead !== end.gitHead)
    reasons.push("git HEAD changed during run");
  const relativeEntries = start.buildSourceIdentity.entries.map((entry) => {
    const normalized = String(entry.file).replaceAll("\\", "/");
    const relative = C12_29_S5_SVS_BUILD_SOURCE_FILES.find((candidate) =>
      normalized.endsWith(`/${candidate}`),
    );
    return { ...entry, relativeFile: relative ?? null };
  });
  return {
    ok: reasons.length === 0,
    reasons,
    gitHead: start.gitHead,
    sourceStable: stability.ok && start.gitHead === end.gitHead,
    buildStable: stability.ok,
    servedEntry: servedEntry,
    fixtureSetSha256: C12_29_S5_SVS_FIXTURE.fixtureSetSha256,
    fixtures: Object.fromEntries([
      ["manifest", start.local.fixtureManifest],
      ...Object.keys(C12_29_S5_SVS_FIXTURE.members).map((extension) => [
        extension,
        start.local[`fixture${extension}`],
      ]),
    ]),
    terrain: {
      layer: start.local.terrainLayer,
      tile: start.local.terrainTile,
    },
    buildSourceIdentity: {
      ...start.buildSourceIdentity,
      entries: relativeEntries.map(({ relativeFile: _relative, ...entry }) => ({
        ...entry,
        file: entry.file,
      })),
    },
    generatedShaders: start.generatedShaders,
    xysAssets: Object.fromEntries(
      xysAssetFiles().map((file) => [file, start.local[`xys:${file}`]]),
    ),
  };
}

async function loadFixtureForContract() {
  const fixtureDirectory = path.join(toolDirectory, "fixtures/nasa-svs-5073");
  const manifestBytes = fs.readFileSync(manifestPath);
  if (
    manifestBytes.byteLength !== C12_29_S5_SVS_FIXTURE.manifest.bytes ||
    sha256(manifestBytes) !== C12_29_S5_SVS_FIXTURE.manifest.sha256
  ) {
    throw new Error("SVS fixture manifest differs from frozen pin");
  }
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const manifestRecords = manifest?.selection?.records ?? [];
  const recordsMatch =
    manifest?.schema === C12_29_S5_SVS_FIXTURE.manifest.schema &&
    manifestRecords.length === C12_29_S5_SVS_ROWS.length &&
    manifestRecords.every((record, index) => {
      const expected = C12_29_S5_SVS_ROWS[index];
      return (
        record.role === expected.role &&
        record.iso8601 === expected.iso &&
        record.sourceIndexZeroBased === expected.sourceIndexZeroBased &&
        record.sourceRecordNumber === expected.sourceRecordNumber &&
        record.outputRecordNumber === expected.outputRecordNumber &&
        JSON.stringify(record.centerLonLat) ===
          JSON.stringify(expected.sourceCenter)
      );
    });
  if (!recordsMatch) {
    throw new Error("SVS fixture manifest record identities differ");
  }
  const inputs = Object.fromEntries(
    Object.keys(C12_29_S5_SVS_FIXTURE.members).map((extension) => [
      extension,
      fs.readFileSync(
        path.join(
          fixtureDirectory,
          `${C12_29_S5_SVS_FIXTURE.stem}.${extension}`,
        ),
      ),
    ]),
  );
  const collection = parseSvs5073UmbraShapefile(inputs);
  return collection.features.map((feature, index) => ({
    ...C12_29_S5_SVS_ROWS[index],
    bbox: feature.bbox,
    ring: feature.geometry.coordinates[0],
    properties: feature.properties,
  }));
}

const MEASURE_SVS_SESSION = async (contract, runtimeSpatialSummarizer) => {
  const jsonSafeClone = (value) =>
    JSON.parse(
      JSON.stringify(value, (key, entry) => {
        if (
          typeof entry === "number" &&
          (!Number.isFinite(entry) || Object.is(entry, -0))
        ) {
          throw new TypeError(
            `SVS runtime checkpoint rejects non-finite or negative-zero number at ${key || "$"}`,
          );
        }
        if (
          entry === undefined ||
          new Set(["bigint", "function", "symbol"]).has(typeof entry)
        ) {
          throw new TypeError(
            `SVS runtime checkpoint rejects ${typeof entry} at ${key || "$"}`,
          );
        }
        return entry;
      }),
    );
  const canonicalJsonIdentity = (value) =>
    JSON.stringify(value, (_key, entry) => {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        return Object.fromEntries(
          Object.keys(entry)
            .sort()
            .map((key) => [key, entry[key]]),
        );
      }
      return entry;
    });
  const deepFreeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const entry of Object.values(value)) deepFreeze(entry);
    }
    return value;
  };
  let checkpointState = {
    schema: contract.diagnosticsSchema,
    renderer: contract.renderer,
    sequence: 0,
    phase: null,
    stage: "runtime-import",
    rowIndex: null,
    role: null,
    iso: null,
    measurementKind: null,
    counts: {
      valid: null,
      nasa: null,
      terrain: null,
      classified: null,
      sourceBoundary: null,
      classifiedBoundary: null,
    },
    sourceCentroid: { available: false, lonLat: null },
    measuredCentroid: { available: false, lonLat: null },
    boundary: { comparable: false, unavailableReason: null },
    terrain: {
      transitionRole: null,
      selectedTileIds: [],
      preparedSelectedTileIds: [],
      selectionRevision: null,
      captureFrameNumber: null,
    },
  };
  const publishCheckpoint = (patch) => {
    checkpointState = jsonSafeClone({
      ...checkpointState,
      ...patch,
      sequence: checkpointState.sequence + 1,
    });
    globalThis.__c1229SvsRuntimeCheckpoint = deepFreeze(
      jsonSafeClone(checkpointState),
    );
    return checkpointState;
  };
  publishCheckpoint({ stage: "runtime-import" });
  const C = await import(contract.runtimePath);
  publishCheckpoint({ stage: "viewer-contract" });
  const viewer = globalThis.viewer;
  const scene = viewer?.scene;
  const globe = scene?.globe;
  if (!scene?.context || !globe)
    throw new Error("Viewer scene/globe unavailable");
  const renderer = scene.context.isWebGPU ? "webgpu" : "webgl";
  if (renderer !== contract.renderer) {
    throw new Error(`renderer ${renderer} != requested ${contract.renderer}`);
  }
  if (
    typeof runtimeSpatialSummarizer !== "function" ||
    runtimeSpatialSummarizer.toString() !== contract.spatialSummarizerSource
  ) {
    throw new Error("SVS runtime spatial summarizer source identity differs");
  }
  const requireDegreeLonLat = (value, stage) => {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !value.every(Number.isFinite) ||
      value.some((entry) => Object.is(entry, -0)) ||
      Math.abs(value[0]) > 180 ||
      Math.abs(value[1]) > 90
    ) {
      throw new TypeError(`${stage}: degree lon/lat is invalid`);
    }
    return value;
  };
  const cartographicDistanceKm = (left, right, stage) => {
    requireDegreeLonLat(left, `${stage}/left`);
    requireDegreeLonLat(right, `${stage}/right`);
    const geodesic = new C.EllipsoidGeodesic(
      C.Cartographic.fromDegrees(left[0], left[1]),
      C.Cartographic.fromDegrees(right[0], right[1]),
      globe.ellipsoid,
    );
    const result = geodesic.surfaceDistance / 1000;
    if (!Number.isFinite(result) || Object.is(result, -0) || result < 0) {
      throw new TypeError(`${stage}: geodesic distance is invalid`);
    }
    return result;
  };
  publishCheckpoint({ stage: "runtime-ready" });
  const phases = [];
  const mark = (phase) => {
    if (phases.at(-1) !== phase) phases.push(phase);
    globalThis.__c1229SvsProgress = { renderer, phases: [...phases] };
    publishCheckpoint({ phase, stage: "phase-transition" });
  };
  const errors = {
    page: [],
    console: [],
    gpu: [],
    deviceLost: false,
    gpuCompletion: {
      required: renderer === "webgpu",
      method:
        renderer === "webgpu"
          ? "GPUQueue.onSubmittedWorkDone+two-event-turns"
          : "not-applicable",
      queueSettled: renderer === "webgpu" ? false : null,
      postSubmitTurns: 0,
      timeoutMs:
        renderer === "webgpu" ? contract.scene.cleanupCloseTimeoutMs : null,
    },
  };
  const device = scene.context.device;
  device?.addEventListener?.("uncapturederror", (event) => {
    errors.gpu.push(event?.error?.message ?? String(event?.error));
  });
  if (device?.lost) {
    void device.lost.then(() => {
      errors.deviceLost = true;
    });
  }
  const drainSubmittedGpuWork = async () => {
    if (renderer !== "webgpu") return;
    const queue = device?.queue;
    if (typeof queue?.onSubmittedWorkDone !== "function") {
      throw new Error("WebGPU submitted-work completion is unavailable");
    }
    let timer;
    let settled;
    try {
      settled = await Promise.race([
        queue.onSubmittedWorkDone().then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve(false),
            contract.scene.cleanupCloseTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!settled) throw new Error("WebGPU submitted-work drain timed out");
    errors.gpuCompletion.queueSettled = true;
    for (let turn = 0; turn < 2; turn++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      errors.gpuCompletion.postSubmitTurns++;
    }
  };
  viewer.useDefaultRenderLoop = false;
  viewer.resolutionScale = 1;
  viewer.clock.shouldAnimate = false;
  scene.requestRenderMode = false;
  scene.highDynamicRange = false;
  scene.sunBloom = false;
  scene.taaEnabled = false;
  scene.motionBlur = false;
  scene.msaaSamples = 1;
  scene.fog.enabled = false;
  if (scene.postProcessStages?.fxaa)
    scene.postProcessStages.fxaa.enabled = false;
  if (scene.postProcessStages?.bloom)
    scene.postProcessStages.bloom.enabled = false;
  for (let i = 0; i < scene.postProcessStages.length; i++) {
    scene.postProcessStages.get(i).enabled = false;
  }
  globe.show = true;
  globe.enableLighting = true;
  globe.showGroundAtmosphere = false;
  globe.showWaterEffect = false;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  viewer.imageryLayers.removeAll();
  const lighting = globe.atmosphericConditions?.lighting;
  if (!lighting) throw new Error("eclipse lighting controls unavailable");
  const atmosphericConditions = globe.atmosphericConditions;
  if (atmosphericConditions.clouds) {
    atmosphericConditions.clouds.enableProcedural = false;
    atmosphericConditions.clouds.enableVolumetric = false;
  }
  if (atmosphericConditions.volumetricFog) {
    atmosphericConditions.volumetricFog.enabled = false;
  }
  // Begin from the same neutral state used by every measured white/black/OFF
  // capture.  The enabled pipeline is warmed explicitly after each camera/time
  // transition before any evidence is retained.
  lighting.enableEclipse = false;
  lighting.enableEclipseGlobeShadow = false;
  lighting.eclipseAutoExposure = true;
  if ("enableEclipseHorizonTwilight" in lighting) {
    lighting.enableEclipseHorizonTwilight = false;
  }
  const parserModule = await import(
    new URL(contract.fixtureParserRoute, location.origin).href
  );
  const manifestResponse = await fetch(
    new URL(`${contract.fixtureBaseRoute}manifest.json`, location.origin),
  );
  if (!manifestResponse.ok) {
    throw new Error(`fixture manifest HTTP ${manifestResponse.status}`);
  }
  const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
  const manifestHashBytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", manifestBytes),
  );
  const manifestSha256 = [...manifestHashBytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (
    manifestBytes.byteLength !== contract.fixtureManifest.bytes ||
    manifestSha256 !== contract.fixtureManifest.sha256
  ) {
    throw new Error("fixture manifest bytes differ from frozen pin");
  }
  const fixtureManifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  const manifestRecords = fixtureManifest?.selection?.records ?? [];
  const manifestRecordsMatch =
    fixtureManifest?.schema === contract.fixtureManifest.schema &&
    manifestRecords.length === contract.rows.length &&
    manifestRecords.every((record, index) => {
      const expected = contract.rows[index];
      return (
        record.role === expected.role &&
        record.iso8601 === expected.iso &&
        record.sourceIndexZeroBased === expected.sourceIndexZeroBased &&
        record.sourceRecordNumber === expected.sourceRecordNumber &&
        record.outputRecordNumber === expected.outputRecordNumber &&
        JSON.stringify(record.centerLonLat) ===
          JSON.stringify(expected.sourceCenter)
      );
    });
  if (!manifestRecordsMatch) {
    throw new Error("fixture manifest record identities differ");
  }
  const fixtureInputs = {};
  const fixtureFingerprints = {};
  for (const extension of ["shp", "shx", "dbf", "prj"]) {
    const route = `${contract.fixtureBaseRoute}${contract.fixtureStem}.${extension}`;
    const response = await fetch(new URL(route, location.origin));
    if (!response.ok)
      throw new Error(`fixture ${extension} HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const hashBytes = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    );
    const hash = [...hashBytes]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const expected = contract.fixtureMembers[extension];
    if (bytes.byteLength !== expected.bytes || hash !== expected.sha256) {
      throw new Error(`fixture ${extension} bytes differ from frozen pin`);
    }
    fixtureInputs[extension] = bytes;
    fixtureFingerprints[extension] = {
      byteLength: bytes.byteLength,
      sha256: hash,
    };
  }
  const fixtureCollection =
    parserModule.parseSvs5073UmbraShapefile(fixtureInputs);
  const runtimeRows = contract.rows.map((row, index) => ({
    ...row,
    bbox: fixtureCollection.features[index].bbox,
    ring: fixtureCollection.features[index].geometry.coordinates[0],
    properties: fixtureCollection.features[index].properties,
  }));
  if (
    fixtureCollection.features.length !== 4 ||
    runtimeRows.reduce((sum, row) => sum + row.ring.length, 0) !== 687 ||
    runtimeRows.some(
      (row) =>
        row.properties._shpRecordNumber !== row.outputRecordNumber ||
        row.properties.CenterLon !== row.sourceCenter[0] ||
        row.properties.CenterLat !== row.sourceCenter[1] ||
        row.properties.UTCTime !== row.iso.slice(11, 19),
    )
  ) {
    throw new Error("runtime NASA SVS fixture cardinality differs");
  }
  mark(contract.phases[0]);

  const times = [
    ...runtimeRows.map((row) => row.iso),
    contract.control.iso,
  ].map((iso) => C.JulianDate.fromIso8601(iso));
  await C.Transforms.preloadIcrfFixed(
    new C.TimeInterval({ start: times[0], stop: times.at(-1) }),
  );
  const matrices = times.map((time) =>
    C.Transforms.computeIcrfToFixedMatrix(time, new C.Matrix3()),
  );
  if (matrices.some((matrix) => !matrix)) {
    throw new Error("true ICRF matrix unavailable; TEME is structural only");
  }
  const matrixOrthonormal = (matrix) => {
    const column = (index) => [
      matrix[index * 3],
      matrix[index * 3 + 1],
      matrix[index * 3 + 2],
    ];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const columns = [column(0), column(1), column(2)];
    return columns.every((value, i) =>
      columns.every(
        (other, j) => Math.abs(dot(value, other) - Number(i === j)) <= 1e-12,
      ),
    );
  };
  let maximumSourceEdge = {
    distanceKm: -Infinity,
    method: contract.sourceEdge.method,
    units: contract.sourceEdge.units,
    outputRecordNumber: null,
    edgeIndexZeroBased: null,
    startLonLat: null,
    endLonLat: null,
  };
  runtimeRows.forEach((row, rowIndex) => {
    for (let edgeIndex = 0; edgeIndex < row.ring.length - 1; edgeIndex++) {
      const start = row.ring[edgeIndex];
      const end = row.ring[edgeIndex + 1];
      const distanceKm = cartographicDistanceKm(
        start,
        end,
        `fixture-edge/${row.role}/${edgeIndex}`,
      );
      if (distanceKm > maximumSourceEdge.distanceKm) {
        maximumSourceEdge = {
          distanceKm,
          method: contract.sourceEdge.method,
          units: contract.sourceEdge.units,
          outputRecordNumber: rowIndex + 1,
          edgeIndexZeroBased: edgeIndex,
          startLonLat: start,
          endLonLat: end,
        };
      }
    }
  });
  if (
    Math.abs(
      maximumSourceEdge.distanceKm -
        contract.sourceEdge.maximumAdjacentDistanceKm,
    ) > 1e-9 ||
    maximumSourceEdge.outputRecordNumber !==
      contract.sourceEdge.outputRecordNumber ||
    maximumSourceEdge.edgeIndexZeroBased !==
      contract.sourceEdge.edgeIndexZeroBased
  ) {
    throw new Error("runtime WGS84 maximum fixture edge differs");
  }
  requireDegreeLonLat(runtimeRows[1].sourceCenter, "source-motion/before");
  requireDegreeLonLat(runtimeRows[2].sourceCenter, "source-motion/after");
  const sourceMotionGeodesic = new C.EllipsoidGeodesic(
    C.Cartographic.fromDegrees(...runtimeRows[1].sourceCenter),
    C.Cartographic.fromDegrees(...runtimeRows[2].sourceCenter),
    globe.ellipsoid,
  );
  const sourceMotionDistanceKm = cartographicDistanceKm(
    runtimeRows[1].sourceCenter,
    runtimeRows[2].sourceCenter,
    "source-motion",
  );
  if (!Number.isFinite(sourceMotionGeodesic.startHeading)) {
    throw new TypeError("source-motion: heading is invalid");
  }
  const sourceMotionHeading = sourceMotionGeodesic.startHeading;
  const derivedSourceMotion = {
    vectorDistanceKm: sourceMotionDistanceKm,
    initialHeadingDegrees: C.Math.toDegrees(sourceMotionHeading),
    eastKm: sourceMotionDistanceKm * Math.sin(sourceMotionHeading),
    northKm: sourceMotionDistanceKm * Math.cos(sourceMotionHeading),
    speedKmPerHour:
      (sourceMotionDistanceKm / contract.sourceMotion.seconds) * 3600,
  };
  for (const key of [
    "vectorDistanceKm",
    "initialHeadingDegrees",
    "eastKm",
    "northKm",
    "speedKmPerHour",
  ]) {
    if (
      Math.abs(derivedSourceMotion[key] - contract.sourceMotion[key]) > 1e-9
    ) {
      throw new Error(`runtime WGS84 source motion ${key} differs`);
    }
  }
  mark(contract.phases[1]);

  // ==BEGIN same-task-capture==
  const makeSameTaskCapture = (scene, canvas, timeFn) => {
    const renderNow = () => scene.render(timeFn());
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decodeSnapshot = async (snapshot) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        const decodeFailed = "same-task PNG decode failed";
        image.onload = resolve;
        image.onerror = () => reject(new Error(decodeFailed));
      });
      image.src = snapshot;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const snapshotNow = () => {
      renderNow();
      return canvas.toDataURL("image/png");
    };
    const captureNow = () => {
      const snapshot = snapshotNow();
      return decodeSnapshot(snapshot);
    };
    const grabNow = snapshotNow;
    const settleThen = async (maxFrames, done, capture) => {
      let settled = false;
      for (let k = 0; k < maxFrames; k++) {
        if (typeof done === "function" && done() === true) {
          settled = true;
          break;
        }
        renderNow();
        await new Promise((r) => requestAnimationFrame(r));
      }
      if (!settled && typeof done === "function") {
        settled = done() === true;
      }
      const hasCapture = typeof capture === "function";
      const result = hasCapture ? await capture() : undefined;
      return { settled, result };
    };
    return { renderNow, captureNow, grabNow, settleThen };
  };
  // ==END same-task-capture==

  // ==BEGIN fused-snapshot-capture==
  const makeFusedSnapshotCapture = (scene, canvas, timeFn) => {
    const tmp = document.createElement("canvas");
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    const decode = async (dataUrl) => {
      const image = new Image();
      const loaded = new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("fused PNG decode failed"));
      });
      image.src = dataUrl;
      await loaded;
      tmp.width = image.naturalWidth;
      tmp.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      return ctx.getImageData(0, 0, tmp.width, tmp.height);
    };
    const captureSnapshot = async () => {
      scene.render(timeFn());
      const dataUrl = canvas.toDataURL("image/png");
      const imageData = await decode(dataUrl);
      return { dataUrl, imageData };
    };
    return { captureSnapshot };
  };
  // ==END fused-snapshot-capture==

  let currentTime = times[0];
  const timeFn = () => currentTime;
  const xyz = (value) => ({ x: value.x, y: value.y, z: value.z });
  const captureEphemerisLineage = () => {
    const frameState = scene.frameState;
    const sample = frameState?.celestialEphemerisSample;
    const ephemerisProvider = scene.celestialEphemerisProvider;
    const eclipseState = frameState?.eclipseState;
    const matrix = C.Transforms.computeIcrfToFixedMatrix(
      frameState.time,
      new C.Matrix3(),
    );
    const independentSun = C.Matrix3.multiplyByVector(
      matrix,
      C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
        frameState.time,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const independentMoon = C.Matrix3.multiplyByVector(
      matrix,
      C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
        frameState.time,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    if (
      !sample ||
      !ephemerisProvider ||
      !matrix ||
      !eclipseState?.sunPositionWC ||
      !eclipseState?.moonPositionWC
    ) {
      throw new Error("default Simon ephemeris lineage is absent");
    }
    return {
      frameNumber: frameState.frameNumber,
      clockIso: C.JulianDate.toIso8601(frameState.time),
      provider: {
        constructor: ephemerisProvider.constructor.name,
        id: ephemerisProvider.id,
        revision: ephemerisProvider.revision,
        provenance: { ...ephemerisProvider.provenance },
        timePolicy: { ...ephemerisProvider.timePolicy },
        provenanceFrozen: Object.isFrozen(ephemerisProvider.provenance),
        timePolicyFrozen: Object.isFrozen(ephemerisProvider.timePolicy),
      },
      sample: {
        providerId: sample.providerId,
        providerRevision: sample.providerRevision,
        provenance: { ...sample.provenance },
        timePolicy: { ...sample.timePolicy },
        referenceFrame: sample.referenceFrame,
        units: sample.units,
        transformBranch: sample.transformBranch,
        outputAllocationStable: sample.outputAllocationStable,
        thirdPartyTemporaryFree: sample.thirdPartyTemporaryFree,
        sunPositionWC: xyz(sample.sunPositionWC),
        moonPositionWC: xyz(sample.moonPositionWC),
      },
      independent: {
        method: contract.ephemeris.independentMethod,
        sunPositionWC: xyz(independentSun),
        moonPositionWC: xyz(independentMoon),
        sunDeltaMeters: C.Cartesian3.distance(
          independentSun,
          sample.sunPositionWC,
        ),
        moonDeltaMeters: C.Cartesian3.distance(
          independentMoon,
          sample.moonPositionWC,
        ),
      },
      eclipseState: {
        sunPositionWC: xyz(eclipseState.sunPositionWC),
        moonPositionWC: xyz(eclipseState.moonPositionWC),
        sunDeltaMeters: C.Cartesian3.distance(
          eclipseState.sunPositionWC,
          sample.sunPositionWC,
        ),
        moonDeltaMeters: C.Cartesian3.distance(
          eclipseState.moonPositionWC,
          sample.moonPositionWC,
        ),
        sunStorageDistinct: eclipseState.sunPositionWC !== sample.sunPositionWC,
        moonStorageDistinct:
          eclipseState.moonPositionWC !== sample.moonPositionWC,
      },
      identities: {
        providerIsSceneProvider:
          ephemerisProvider === scene.celestialEphemerisProvider,
        sampleIsFrameStateSample:
          sample === scene.frameState.celestialEphemerisSample,
        sampleProvenanceIsProviderProvenance:
          sample.provenance === ephemerisProvider.provenance,
        sampleTimePolicyIsProviderTimePolicy:
          sample.timePolicy === ephemerisProvider.timePolicy,
      },
    };
  };
  makeSameTaskCapture(scene, scene.canvas, timeFn);
  const { captureSnapshot } = makeFusedSnapshotCapture(
    scene,
    scene.canvas,
    timeFn,
  );
  const objectIds = new WeakMap();
  let nextObjectId = 1;
  const objectId = (value) => {
    if (
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    ) {
      return 0;
    }
    let id = objectIds.get(value);
    if (!id) {
      id = nextObjectId++;
      objectIds.set(value, id);
    }
    return id;
  };
  const quantizedProvider = await C.CesiumTerrainProvider.fromUrl(
    new URL(contract.terrainRoute, location.origin).href,
  );
  let decodedQuantizedMeshCount = 0;
  const requestOriginal =
    quantizedProvider.requestTileGeometry.bind(quantizedProvider);
  quantizedProvider.requestTileGeometry = (...args) => {
    const result = requestOriginal(...args);
    return result?.then((data) => {
      if (data instanceof C.QuantizedMeshTerrainData) {
        decodedQuantizedMeshCount++;
      }
      return data;
    });
  };
  scene.terrainProvider = quantizedProvider;

  const pointInRing = ([x, y], ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };
  const luminanceCode = (data, offset) =>
    0.2126 * data[offset] +
    0.7152 * data[offset + 1] +
    0.0722 * data[offset + 2];
  const tileId = (tile) => `${tile.level}/${tile.x}/${tile.y}`;
  const tileClassification = (tile) => ({
    id: tileId(tile),
    real:
      tile?.data?.terrainData instanceof C.QuantizedMeshTerrainData &&
      Boolean(tile?.data?.mesh) &&
      tile.data.renderedMesh === tile.data.mesh,
    fill: Boolean(
      tile?.data?.fill?.mesh && tile.data.renderedMesh === tile.data.fill.mesh,
    ),
  });
  const contentRecord = (tile) => ({
    tileId: tileId(tile),
    tileObjectId: objectId(tile),
    terrainDataObjectId: objectId(tile?.data?.terrainData),
    renderedMeshObjectId: objectId(tile?.data?.renderedMesh),
    realMeshObjectId: objectId(tile?.data?.mesh),
    fillMeshObjectId: objectId(tile?.data?.fill?.mesh),
  });
  const captureStateObservation = (frameState) => {
    const state = frameState.eclipseState;
    const shadow = frameState.eclipseGlobeShadow;
    return {
      frameNumber: frameState.frameNumber,
      baseColor: [
        globe.baseColor.red,
        globe.baseColor.green,
        globe.baseColor.blue,
        globe.baseColor.alpha,
      ],
      enableEclipse: lighting.enableEclipse,
      enableEclipseGlobeShadow: lighting.enableEclipseGlobeShadow,
      eclipseAutoExposure: lighting.eclipseAutoExposure,
      enableEclipseHorizonTwilight: lighting.enableEclipseHorizonTwilight,
      atmosphericConditionsIdentity:
        frameState.atmosphericConditions === globe.atmosphericConditions,
      eclipseState: {
        enabled: state?.enabled ?? null,
        autoExposure: state?.autoExposure ?? null,
        horizonTwilightEnabled: state?.horizonTwilightEnabled ?? null,
        valid: state?.valid ?? null,
        sunVisibleFraction: state?.sunVisibleFraction ?? null,
        earthOcclusionFraction: state?.earthOcclusionFraction ?? null,
        moonObscuration: state?.moonObscuration ?? null,
        sunAngularRadius: state?.sunAngularRadius ?? null,
        earthAngularRadius: state?.earthAngularRadius ?? null,
        moonAngularRadius: state?.moonAngularRadius ?? null,
        earthSeparation: state?.earthSeparation ?? null,
        moonSeparation: state?.moonSeparation ?? null,
        eclipseMagnitude: state?.eclipseMagnitude ?? null,
      },
      eclipseSceneLightFactor: frameState.eclipseSceneLightFactor ?? null,
      eclipseGlobeShadowPrepared:
        frameState.eclipseGlobeShadowPrepared === true,
      eclipseGlobeShadow: {
        active: shadow?.active ?? null,
        revision: shadow?.revision ?? null,
        sceneLightDimmed: shadow?.sceneLightDimmed ?? null,
        gate: shadow?.params?.x ?? null,
        inverseSceneLightFactor: shadow?.params?.y ?? null,
      },
      mainViewShadowMatches:
        shadow !== undefined && shadow === frameState.view?._eclipseGlobeShadow,
    };
  };
  const applyCaptureState = (label) => {
    const requested = contract.captureStates?.[label];
    if (
      !requested ||
      !Array.isArray(requested.baseColor) ||
      requested.baseColor.length !== 4
    ) {
      throw new Error(`unknown capture state ${label}`);
    }
    globe.baseColor = new C.Color(...requested.baseColor);
    lighting.enableEclipse = requested.enableEclipse;
    lighting.enableEclipseGlobeShadow = requested.enableEclipseGlobeShadow;
    lighting.eclipseAutoExposure = requested.eclipseAutoExposure;
    if ("enableEclipseHorizonTwilight" in lighting) {
      lighting.enableEclipseHorizonTwilight =
        requested.enableEclipseHorizonTwilight;
    }
    return structuredClone(requested);
  };
  const captureStateMatchesRequest = (observed, requested) =>
    observed?.frameNumber !== null &&
    JSON.stringify(observed?.baseColor) ===
      JSON.stringify(requested?.baseColor) &&
    observed?.enableEclipse === requested?.enableEclipse &&
    observed?.enableEclipseGlobeShadow ===
      requested?.enableEclipseGlobeShadow &&
    observed?.eclipseAutoExposure === requested?.eclipseAutoExposure &&
    observed?.enableEclipseHorizonTwilight ===
      requested?.enableEclipseHorizonTwilight &&
    observed?.eclipseState?.autoExposure === requested?.eclipseAutoExposure &&
    observed?.eclipseState?.horizonTwilightEnabled ===
      requested?.enableEclipseHorizonTwilight &&
    observed?.atmosphericConditionsIdentity === true &&
    observed?.eclipseGlobeShadowPrepared === true &&
    observed?.mainViewShadowMatches === true;
  const surfaceProvider =
    globe._surface?.tileProvider ?? globe._surface?._tileProvider;
  if (!surfaceProvider?.showTileThisFrame || !surfaceProvider?.endUpdate) {
    throw new Error("globe surface preparation owner is unavailable");
  }
  let selectionObservation = { frameNumber: null, events: [] };
  const showTileThisFrameOriginal =
    surfaceProvider.showTileThisFrame.bind(surfaceProvider);
  surfaceProvider.showTileThisFrame = (tile, frameState) => {
    const result = showTileThisFrameOriginal(tile, frameState);
    if (selectionObservation.frameNumber !== frameState.frameNumber) {
      selectionObservation = {
        frameNumber: frameState.frameNumber,
        events: [],
      };
    }
    selectionObservation.events.push(
      Object.freeze({
        tile,
        ...tileClassification(tile),
        content: Object.freeze(contentRecord(tile)),
      }),
    );
    return result;
  };
  let preparedObservation;
  const endUpdateOriginal = surfaceProvider.endUpdate.bind(surfaceProvider);
  surfaceProvider.endUpdate = (frameState) => {
    const commandListStart = frameState.commandList.length;
    const selectionEvents =
      selectionObservation.frameNumber === frameState.frameNumber
        ? [...selectionObservation.events]
        : [];
    const result = endUpdateOriginal(frameState);
    const preparedCommands = frameState.commandList
      .slice(commandListStart)
      .filter(
        (command) =>
          command?.pass === C.Pass.GLOBE &&
          Number.isInteger(command?.owner?.level) &&
          Number.isInteger(command?.owner?.x) &&
          Number.isInteger(command?.owner?.y),
      );
    const commandOwners = preparedCommands.map((command) => command.owner);
    const selectedTileIds = [
      ...new Set(selectionEvents.map((event) => event.id)),
    ].sort();
    const selectedRealTileIds = [
      ...new Set(
        selectionEvents.filter((event) => event.real).map((event) => event.id),
      ),
    ].sort();
    const selectedFillTileIds = [
      ...new Set(
        selectionEvents.filter((event) => event.fill).map((event) => event.id),
      ),
    ].sort();
    const preparedCommandOwnerTileIds = [
      ...new Set(commandOwners.map(tileId)),
    ].sort();
    const selectedContent = selectionEvents
      .map((event) => ({ ...event.content }))
      .sort((left, right) => left.tileId.localeCompare(right.tileId));
    const preparedContent = commandOwners
      .map(contentRecord)
      .filter(
        (record, index, records) =>
          records.findIndex((other) => other.tileId === record.tileId) ===
          index,
      )
      .sort((left, right) => left.tileId.localeCompare(right.tileId));
    const preparedRealTileIds = [
      ...new Set(
        commandOwners
          .filter((tile) => tileClassification(tile).real)
          .map(tileId),
      ),
    ].sort();
    const preparedFillTileIds = [
      ...new Set(
        commandOwners
          .filter((tile) => tileClassification(tile).fill)
          .map(tileId),
      ),
    ].sort();
    const drawWitness = {
      renderer,
      frameNumber: frameState.frameNumber,
      commandCount: preparedCommands.length,
      ownerTileIds: [...preparedCommandOwnerTileIds],
      webgl:
        renderer === "webgl"
          ? {
              allCommandsAreWebGl: preparedCommands.every(
                (command) => command?.isWebGPUDrawCommand !== true,
              ),
            }
          : null,
      webgpu:
        renderer === "webgpu"
          ? {
              allCommandsAreWebGpu: preparedCommands.every(
                (command) => command?.isWebGPUDrawCommand === true,
              ),
              allPipelinesPresent: preparedCommands.every(
                (command) => command?.pipeline != null,
              ),
              allIndexCountsPositive: preparedCommands.every(
                (command) =>
                  Number.isInteger(command?.indexCount) &&
                  command.indexCount > 0,
              ),
              allBindGroupCountsExact: preparedCommands.every(
                (command) => command?.bindGroups?.length === 4,
              ),
              allDynamicOffsetCountsExact: preparedCommands.every(
                (command) => command?.bindGroup0DynamicOffsets?.length === 3,
              ),
            }
          : null,
    };
    preparedObservation = {
      capturedInEndUpdate: true,
      selectionRoute:
        "GlobeSurfaceTileProvider.showTileThisFrame/pass-through-events",
      preparationRoute: "frameState.commandList/Pass.GLOBE/command.owner",
      selectionFrameNumber: selectionObservation.frameNumber,
      preparedFrameNumber: frameState.frameNumber,
      selectionEventCount: selectionEvents.length,
      selectionEventsUnique:
        selectionEvents.length ===
        new Set(selectionEvents.map((event) => event.id)).size,
      selectedTileIds,
      selectedRealTileIds,
      selectedFillTileIds,
      preparedCommandCount: preparedCommands.length,
      preparedCommandOwnerTileIds,
      drawWitness,
      captureStateObservation: captureStateObservation(frameState),
      selectedContent,
      preparedContent,
      preparedRealTileIds,
      preparedFillTileIds,
      preparedCommandOwnersMatchSelection:
        commandOwners.every((owner) =>
          selectionEvents.some((event) => event.tile === owner),
        ) &&
        selectionEvents.every((event) =>
          commandOwners.some((owner) => owner === event.tile),
        ),
      selectionRevision: frameState.eclipseGlobeShadowSelectionRevision,
      surfaceRadiusMeters: frameState.eclipseGlobeShadowSurfaceRadius,
      providerContentRevision:
        surfaceProvider._sceneCaptureContentRevision ?? null,
      terrainProviderIdentity: objectId(scene.terrainProvider),
      surfaceProviderIdentity: objectId(surfaceProvider),
      prepared: frameState.eclipseGlobeShadowPrepared === true,
    };
    return result;
  };
  const cameraStateIdentity = () =>
    JSON.stringify({
      position: [
        scene.camera.positionWC.x,
        scene.camera.positionWC.y,
        scene.camera.positionWC.z,
      ],
      direction: [
        scene.camera.directionWC.x,
        scene.camera.directionWC.y,
        scene.camera.directionWC.z,
      ],
      up: [scene.camera.upWC.x, scene.camera.upWC.y, scene.camera.upWC.z],
      right: [
        scene.camera.rightWC.x,
        scene.camera.rightWC.y,
        scene.camera.rightWC.z,
      ],
      fov: scene.camera.frustum.fov,
    });
  const preparedTuple = (transition) => {
    const selectedTileIds = [...(preparedObservation?.selectedTileIds ?? [])];
    const preparedSelectedTileIds = [
      ...(preparedObservation?.preparedCommandOwnerTileIds ?? []),
    ];
    const selectedRealTileIds = [
      ...(preparedObservation?.selectedRealTileIds ?? []),
    ];
    const preparedRealTileIds = [
      ...(preparedObservation?.preparedRealTileIds ?? []),
    ];
    const selectedTileId = selectedRealTileIds[0] ?? null;
    const preparedTileId = preparedRealTileIds[0] ?? null;
    const selectionRevision =
      scene.frameState.eclipseGlobeShadowSelectionRevision ?? null;
    const surfaceRadiusMeters =
      scene.frameState.eclipseGlobeShadowSurfaceRadius ?? null;
    const selectedContent = [
      ...(preparedObservation?.selectedContent ?? []),
    ].map((record) => ({ ...record }));
    const preparedContent = [
      ...(preparedObservation?.preparedContent ?? []),
    ].map((record) => ({ ...record }));
    return {
      prepared: Boolean(
        selectedTileId && preparedTileId && preparedObservation?.prepared,
      ),
      selectionRoute: preparedObservation?.selectionRoute ?? null,
      preparationRoute: preparedObservation?.preparationRoute ?? null,
      selectionFrameNumber: preparedObservation?.selectionFrameNumber ?? null,
      preparedFrameNumber: preparedObservation?.preparedFrameNumber ?? null,
      captureFrameNumber: scene.frameState.frameNumber ?? null,
      selectionEventCount: preparedObservation?.selectionEventCount ?? 0,
      selectionEventsUnique:
        preparedObservation?.selectionEventsUnique === true,
      preparedCommandCount: preparedObservation?.preparedCommandCount ?? 0,
      drawWitness:
        preparedObservation?.drawWitness === undefined
          ? null
          : structuredClone(preparedObservation.drawWitness),
      captureStateObservation:
        preparedObservation?.captureStateObservation === undefined
          ? null
          : structuredClone(preparedObservation.captureStateObservation),
      preparedCommandOwnersMatchSelection:
        preparedObservation?.preparedCommandOwnersMatchSelection === true,
      selectedTileId,
      preparedTileId,
      selectedTileIds,
      preparedSelectedTileIds,
      selectedRealTileIds,
      selectedFillTileIds: [
        ...(preparedObservation?.selectedFillTileIds ?? []),
      ],
      selectedPreparedTileSetsMatch:
        JSON.stringify(selectedTileIds) ===
        JSON.stringify(preparedSelectedTileIds),
      preparedSelectionContainsRealTile:
        selectedTileId !== null && preparedRealTileIds.includes(selectedTileId),
      preparedCapturedInEndUpdate:
        preparedObservation?.capturedInEndUpdate === true,
      preparedRealTileIds,
      preparedFillTileIds: [
        ...(preparedObservation?.preparedFillTileIds ?? []),
      ],
      terrainDataInstanceProof: selectedTileId
        ? "instanceof-C.QuantizedMeshTerrainData"
        : null,
      renderedMeshIsRealMesh:
        selectedTileId !== null && preparedRealTileIds.includes(selectedTileId),
      renderedMeshIsFillMesh:
        selectedTileId !== null &&
        preparedObservation?.preparedFillTileIds?.includes(selectedTileId),
      selectionRevision,
      surfaceRadiusMeters,
      providerSelectionRevision: preparedObservation?.selectionRevision ?? null,
      providerSurfaceRadiusMeters:
        preparedObservation?.surfaceRadiusMeters ?? null,
      selectionRevisionMatches:
        Number.isInteger(selectionRevision) &&
        preparedObservation?.selectionRevision === selectionRevision,
      surfaceRadiusMatches:
        Number.isFinite(surfaceRadiusMeters) &&
        preparedObservation?.surfaceRadiusMeters === surfaceRadiusMeters,
      mainViewShadowMatches:
        scene.frameState.eclipseGlobeShadow ===
        scene.frameState.view?._eclipseGlobeShadow,
      tilesLoadedAfterRender: globe.tilesLoaded === true,
      terrainProviderIdentity:
        preparedObservation?.terrainProviderIdentity ?? null,
      sourceTerrainProviderIdentity: objectId(quantizedProvider),
      sourceTerrainProviderMatches:
        preparedObservation?.terrainProviderIdentity ===
          objectId(quantizedProvider) &&
        scene.terrainProvider === quantizedProvider,
      surfaceProviderIdentity:
        preparedObservation?.surfaceProviderIdentity ?? null,
      providerContentRevision:
        preparedObservation?.providerContentRevision ?? null,
      cameraIdentity: cameraStateIdentity(),
      expectedCameraIdentity: transition?.cameraIdentity ?? null,
      transitionRole: transition?.role ?? null,
      transitionIso: transition?.iso ?? null,
      clockTimeIso: C.JulianDate.toIso8601(viewer.clock.currentTime),
      frameStateTimeIso: C.JulianDate.toIso8601(scene.frameState.time),
      selectedContent,
      preparedContent,
      selectionContentIdentity: canonicalJsonIdentity({
        selected: selectedContent,
        prepared: preparedContent,
      }),
    };
  };
  const fixedVerticalFov = C.Math.toRadians(55);
  const usablePixels =
    contract.scene.viewport.width - 2 * contract.scene.minimumMarginPixels;
  const fixedCameraHeight = Math.max(
    ...runtimeRows.map((row) => {
      const west = row.bbox[0] - contract.scene.cameraGuardDegrees;
      const south = row.bbox[1] - contract.scene.cameraGuardDegrees;
      const east = row.bbox[2] + contract.scene.cameraGuardDegrees;
      const north = row.bbox[3] + contract.scene.cameraGuardDegrees;
      const latitude = row.sourceCenter[1];
      const northSouthMeters = (north - south) * 111_320;
      const eastWestMeters =
        (east - west) * 111_320 * Math.cos(C.Math.toRadians(latitude));
      const requiredSpan = Math.max(northSouthMeters, eastWestMeters);
      return (
        (requiredSpan * contract.scene.viewport.height) /
        (2 * usablePixels * Math.tan(fixedVerticalFov * 0.5))
      );
    }),
  );
  const fixedPixelGroundFootprintKm =
    (2 * fixedCameraHeight * Math.tan(fixedVerticalFov * 0.5)) /
    contract.scene.viewport.height /
    1000;
  if (
    fixedVerticalFov !== contract.scene.verticalFovRadians ||
    fixedCameraHeight !== contract.scene.cameraHeightMeters ||
    fixedPixelGroundFootprintKm !== contract.scene.pixelGroundFootprintKm
  ) {
    throw new Error("derived fixed production camera contract differs");
  }
  const frameCamera = (row) => {
    const bbox = row.bbox;
    const west = bbox[0] - contract.scene.cameraGuardDegrees;
    const south = bbox[1] - contract.scene.cameraGuardDegrees;
    const east = bbox[2] + contract.scene.cameraGuardDegrees;
    const north = bbox[3] + contract.scene.cameraGuardDegrees;
    const lon = row.sourceCenter?.[0] ?? 0.5 * (west + east);
    const lat = row.sourceCenter?.[1] ?? 0.5 * (south + north);
    scene.camera.frustum.fov = fixedVerticalFov;
    const destination = C.Cartesian3.fromDegrees(lon, lat, fixedCameraHeight);
    const surfaceCenter = C.Cartesian3.fromDegrees(
      lon,
      lat,
      0,
      globe.ellipsoid,
    );
    scene.camera.setView({
      destination,
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    // Camera.setView round-trips the requested nadir through local HPR. Near
    // pitch -PI/2 that reconstruction is numerically singular and the applied
    // WC direction can miss the requested surface centre by a few e-8 in
    // 1-dot space. The certification camera must use the exact requested WC
    // ray, while preserving setView's north-oriented roll.
    const requestedDirection = C.Cartesian3.normalize(
      C.Cartesian3.subtract(surfaceCenter, destination, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    const surfaceNormal = globe.ellipsoid.geodeticSurfaceNormal(
      surfaceCenter,
      new C.Cartesian3(),
    );
    let requestedRight = C.Cartesian3.normalize(
      C.Cartesian3.cross(
        C.Cartesian3.UNIT_Z,
        surfaceNormal,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    const requestedUp = C.Cartesian3.normalize(
      C.Cartesian3.cross(
        requestedRight,
        requestedDirection,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    requestedRight = C.Cartesian3.normalize(
      C.Cartesian3.cross(requestedDirection, requestedUp, new C.Cartesian3()),
      requestedRight,
    );
    C.Cartesian3.clone(requestedDirection, scene.camera.direction);
    C.Cartesian3.clone(requestedUp, scene.camera.up);
    C.Cartesian3.clone(requestedRight, scene.camera.right);
    // Commit the public-vector repair through the same Scene update that owns
    // all subsequent camera identity and terrain-readiness observations.
    scene.render(timeFn());
    const positionWC = C.Cartesian3.clone(
      scene.camera.positionWC,
      new C.Cartesian3(),
    );
    const directionWC = C.Cartesian3.clone(
      scene.camera.directionWC,
      new C.Cartesian3(),
    );
    const upWC = C.Cartesian3.clone(scene.camera.upWC, new C.Cartesian3());
    const rightWC = C.Cartesian3.clone(
      scene.camera.rightWC,
      new C.Cartesian3(),
    );
    const targetDirection = C.Cartesian3.normalize(
      C.Cartesian3.subtract(surfaceCenter, positionWC, new C.Cartesian3()),
      new C.Cartesian3(),
    );
    return {
      west,
      south,
      east,
      north,
      lon,
      lat,
      height: fixedCameraHeight,
      fov: fixedVerticalFov,
      cameraIdentity: cameraStateIdentity(),
      basisProof: {
        positionWC: [positionWC.x, positionWC.y, positionWC.z],
        surfaceCenterWC: [surfaceCenter.x, surfaceCenter.y, surfaceCenter.z],
        directionWC: [directionWC.x, directionWC.y, directionWC.z],
        upWC: [upWC.x, upWC.y, upWC.z],
        rightWC: [rightWC.x, rightWC.y, rightWC.z],
        directionMagnitude: C.Cartesian3.magnitude(directionWC),
        upMagnitude: C.Cartesian3.magnitude(upWC),
        rightMagnitude: C.Cartesian3.magnitude(rightWC),
        directionUpDot: C.Cartesian3.dot(directionWC, upWC),
        directionRightDot: C.Cartesian3.dot(directionWC, rightWC),
        upRightDot: C.Cartesian3.dot(upWC, rightWC),
        handedness: C.Cartesian3.dot(
          directionWC,
          C.Cartesian3.cross(upWC, rightWC, new C.Cartesian3()),
        ),
        targetResidual: Math.abs(
          1 - C.Cartesian3.dot(targetDirection, directionWC),
        ),
        capturedAfterSceneRender: true,
      },
    };
  };
  const measureCameraFrame = (row, frame) => {
    let actualMarginPixels = Infinity;
    let allFixtureVerticesProjected = true;
    for (const [longitude, latitude] of row.ring) {
      const point = C.Cartesian3.fromDegrees(
        longitude,
        latitude,
        0,
        globe.ellipsoid,
      );
      const windowPoint = C.SceneTransforms.worldToWindowCoordinates(
        scene,
        point,
        new C.Cartesian2(),
      );
      if (!windowPoint) {
        allFixtureVerticesProjected = false;
        continue;
      }
      actualMarginPixels = Math.min(
        actualMarginPixels,
        windowPoint.x,
        windowPoint.y,
        contract.scene.viewport.width - windowPoint.x,
        contract.scene.viewport.height - windowPoint.y,
      );
    }
    const surfaceCenter = C.Cartesian3.fromDegrees(
      row.sourceCenter[0],
      row.sourceCenter[1],
      0,
      globe.ellipsoid,
    );
    const toCenter = C.Cartesian3.normalize(
      C.Cartesian3.subtract(
        surfaceCenter,
        scene.camera.positionWC,
        new C.Cartesian3(),
      ),
      new C.Cartesian3(),
    );
    return {
      centerLonLat: [...row.sourceCenter],
      mode: contract.scene.cameraMode,
      derivedFromGuardedBbox: true,
      fixedAcrossRows: true,
      allFixtureVerticesProjected,
      actualMarginPixels,
      nadirAlignment: Math.abs(
        1 - C.Cartesian3.dot(toCenter, scene.camera.directionWC),
      ),
      basisProof: structuredClone(frame.basisProof),
      heightMeters: frame.height,
      verticalFovRadians: frame.fov,
    };
  };
  const stableTupleIdentity = (tuple) =>
    JSON.stringify({
      cameraIdentity: tuple.cameraIdentity,
      transitionIso: tuple.transitionIso,
      sourceTerrainProviderIdentity: tuple.sourceTerrainProviderIdentity,
      surfaceProviderIdentity: tuple.surfaceProviderIdentity,
      providerContentRevision: tuple.providerContentRevision,
      selectionContentIdentity: tuple.selectionContentIdentity,
      selectedTileIds: tuple.selectedTileIds,
      preparedSelectedTileIds: tuple.preparedSelectedTileIds,
    });
  const drawWitnessReady = (tuple) => {
    const witness = tuple?.drawWitness;
    if (
      witness?.renderer !== renderer ||
      witness?.frameNumber !== tuple?.captureFrameNumber ||
      !Number.isInteger(witness?.commandCount) ||
      witness.commandCount < 1 ||
      JSON.stringify(witness?.ownerTileIds) !==
        JSON.stringify(tuple?.preparedSelectedTileIds)
    ) {
      return false;
    }
    if (renderer === "webgpu") {
      return (
        witness.webgl === null &&
        witness.webgpu?.allCommandsAreWebGpu === true &&
        witness.webgpu?.allPipelinesPresent === true &&
        witness.webgpu?.allIndexCountsPositive === true &&
        witness.webgpu?.allBindGroupCountsExact === true &&
        witness.webgpu?.allDynamicOffsetCountsExact === true
      );
    }
    return (
      witness.webgpu === null && witness.webgl?.allCommandsAreWebGl === true
    );
  };
  const tupleReady = (tuple) =>
    tuple.tilesLoadedAfterRender === true &&
    tuple.sourceTerrainProviderMatches === true &&
    tuple.prepared === true &&
    tuple.selectionEventsUnique === true &&
    tuple.preparedCommandOwnersMatchSelection === true &&
    tuple.selectedPreparedTileSetsMatch === true &&
    tuple.preparedSelectionContainsRealTile === true &&
    tuple.selectedTileIds.length > 0 &&
    tuple.preparedSelectedTileIds.length > 0 &&
    tuple.selectedFillTileIds.length === 0 &&
    tuple.preparedFillTileIds.length === 0 &&
    drawWitnessReady(tuple) &&
    tuple.captureStateObservation?.frameNumber === tuple.captureFrameNumber &&
    tuple.selectionContentIdentity ===
      canonicalJsonIdentity({
        selected: tuple.selectedContent,
        prepared: tuple.preparedContent,
      }) &&
    JSON.stringify(tuple.selectedContent) ===
      JSON.stringify(tuple.preparedContent);
  const settleTransition = async (transition, maxFrames) => {
    const required = contract.scene.readinessConsecutiveStableFrames;
    let prior;
    let stable = [];
    let renderCount = 0;
    while (renderCount < maxFrames) {
      // Render before the first readiness read. Camera/provider transitions can
      // leave the old view's load queues empty, so a pre-render tilesLoaded
      // check is not evidence for the new view.
      scene.render(timeFn());
      renderCount++;
      const tuple = preparedTuple(transition);
      const identity = stableTupleIdentity(tuple);
      const consecutive =
        prior &&
        identity === prior.identity &&
        tuple.captureFrameNumber === prior.tuple.captureFrameNumber + 1 &&
        tuple.selectionRevision === prior.tuple.selectionRevision + 1;
      stable = tupleReady(tuple)
        ? consecutive
          ? [...stable, { renderOrdinal: renderCount, tuple }].slice(-required)
          : [{ renderOrdinal: renderCount, tuple }]
        : [];
      prior = { identity, tuple };
      if (stable.length === required) break;
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (stable.length !== required) {
      throw new Error(
        `${transition.role} did not produce ${required} consecutive stable render-first terrain frames`,
      );
    }
    const tuple = stable.at(-1).tuple;
    return {
      method: contract.scene.readinessMethod,
      transitionRole: transition.role,
      transitionIso: transition.iso,
      forcedRenderBeforeFirstReadinessCheck: true,
      settled: true,
      boundedMaxFrames: maxFrames,
      renderCount,
      requiredConsecutiveStableFrames: required,
      consecutiveStableFrames: stable.length,
      cameraIdentity: tuple.cameraIdentity,
      sourceTerrainProviderIdentity: tuple.sourceTerrainProviderIdentity,
      surfaceProviderIdentity: tuple.surfaceProviderIdentity,
      providerContentRevision: tuple.providerContentRevision,
      selectionContentIdentity: tuple.selectionContentIdentity,
      lastFrameNumber: tuple.captureFrameNumber,
      lastSelectionRevision: tuple.selectionRevision,
      observations: stable,
    };
  };
  const settleCaptureVariantReadiness = async (transition, maxFrames) => {
    const definitions = [
      { role: "neutral", label: "off" },
      { role: "enabled", label: "on" },
      { role: "restored-neutral", label: "off" },
    ];
    const legs = [];
    for (const definition of definitions) {
      const requested = applyCaptureState(definition.label);
      const readiness = await settleTransition(transition, maxFrames);
      const tuple = readiness.observations.at(-1)?.tuple;
      if (
        !readiness.observations.every((observation) =>
          captureStateMatchesRequest(
            observation?.tuple?.captureStateObservation,
            requested,
          ),
        )
      ) {
        throw new Error(
          `${transition.role}/${definition.role} capture state did not settle`,
        );
      }
      legs.push({
        role: definition.role,
        captureLabel: definition.label,
        requested,
        observed: structuredClone(tuple.captureStateObservation),
        backendDrawWitness: structuredClone(tuple.drawWitness),
        readiness,
      });
    }
    return {
      method:
        "neutral-disabled+enabled-hot+restored-neutral-three-frame-main-globe-readiness",
      transitionRole: transition.role,
      transitionIso: transition.iso,
      legs,
      productCaptureStartsAfterFrame: legs.at(-1).readiness.lastFrameNumber,
    };
  };
  const captureStableSnapshot = async (
    transition,
    stableIdentity,
    captureLabel,
  ) => {
    const requested = applyCaptureState(captureLabel);
    const shot = await captureSnapshot();
    const ephemeris = captureEphemerisLineage();
    const tuple = preparedTuple(transition);
    if (
      !tupleReady(tuple) ||
      tuple.cameraIdentity !== stableIdentity.cameraIdentity ||
      tuple.sourceTerrainProviderIdentity !==
        stableIdentity.sourceTerrainProviderIdentity ||
      tuple.surfaceProviderIdentity !==
        stableIdentity.surfaceProviderIdentity ||
      tuple.providerContentRevision !==
        stableIdentity.providerContentRevision ||
      tuple.selectionContentIdentity !==
        stableIdentity.selectionContentIdentity ||
      !captureStateMatchesRequest(tuple.captureStateObservation, requested)
    ) {
      throw new Error(
        `${transition.role} terrain drifted during fused capture`,
      );
    }
    return {
      ...shot,
      ephemeris,
      tuple,
      stateProof: {
        requested,
        observed: structuredClone(tuple.captureStateObservation),
        backendDrawWitness: structuredClone(tuple.drawWitness),
      },
    };
  };
  const buildLattice = (
    row,
    frame,
    off,
    on,
    white,
    black,
    measurementKind,
    rowIndex,
    terrainCheckpoint,
  ) => {
    const side = contract.scene.latticeSide;
    const valid = [];
    const nasa = [];
    const terrain = [];
    const classified = [];
    const oneCodeBoundary = [];
    const offBrightTerrain = [];
    const worldById = new Map();
    const classifiedPoints = [];
    let duplicates = 0;
    const projected = new Set();
    const projectedPixelIdByValidCell = [];
    publishCheckpoint({
      stage: "lattice-projection",
      rowIndex,
      role: row.role,
      iso: measurementKind === "control" ? contract.control.iso : row.iso,
      measurementKind,
      counts: {
        valid: 0,
        nasa: 0,
        terrain: 0,
        classified: 0,
        sourceBoundary: null,
        classifiedBoundary: null,
      },
      sourceCentroid: { available: false, lonLat: null },
      measuredCentroid: { available: false, lonLat: null },
      boundary: { comparable: false, unavailableReason: null },
      terrain: terrainCheckpoint,
    });
    for (let y = 0; y < side; y++) {
      const lat =
        frame.north - ((y + 0.5) / side) * (frame.north - frame.south);
      for (let x = 0; x < side; x++) {
        const lon = frame.west + ((x + 0.5) / side) * (frame.east - frame.west);
        const id = y * side + x;
        requireDegreeLonLat([lon, lat], `${row.role}/lattice/${id}`);
        const world = C.Cartesian3.fromDegrees(lon, lat, 0, globe.ellipsoid);
        const windowPoint = C.SceneTransforms.worldToWindowCoordinates(
          scene,
          world,
          new C.Cartesian2(),
        );
        if (!windowPoint) continue;
        const px = Math.floor(windowPoint.x);
        const py = Math.floor(windowPoint.y);
        if (px < 0 || py < 0 || px >= off.width || py >= off.height) continue;
        const projectedId = py * off.width + px;
        if (projected.has(projectedId)) {
          duplicates++;
          continue;
        }
        projected.add(projectedId);
        valid.push(id);
        projectedPixelIdByValidCell.push(projectedId);
        worldById.set(id, [lon, lat]);
        if (pointInRing([lon, lat], row.ring)) nasa.push(id);
        const offset = projectedId * 4;
        const response = Math.max(
          Math.abs(white.data[offset] - black.data[offset]),
          Math.abs(white.data[offset + 1] - black.data[offset + 1]),
          Math.abs(white.data[offset + 2] - black.data[offset + 2]),
        );
        if (response <= contract.scene.terrainResponseCodeThreshold) continue;
        terrain.push(id);
        const offLum = luminanceCode(off.data, offset);
        const onLum = luminanceCode(on.data, offset);
        const offPass = offLum >= contract.scene.offMinimumLuminanceCode;
        if (offPass) offBrightTerrain.push(id);
        const ratioPass =
          onLum / Math.max(offLum, 1) <= contract.scene.onOffRatioMaximum;
        if (offPass && ratioPass) {
          classified.push(id);
          classifiedPoints.push([lon, lat]);
        } else if (
          (offPass &&
            !ratioPass &&
            onLum <= offLum * contract.scene.onOffRatioMaximum + 1) ||
          (!offPass &&
            ratioPass &&
            offLum >= contract.scene.offMinimumLuminanceCode - 1)
        ) {
          oneCodeBoundary.push(id);
        }
      }
    }
    publishCheckpoint({
      stage: "lattice-membership-complete",
      counts: {
        valid: valid.length,
        nasa: nasa.length,
        terrain: terrain.length,
        classified: classified.length,
        sourceBoundary: null,
        classifiedBoundary: null,
      },
    });
    const pitchKm = Math.max(
      cartographicDistanceKm(
        [frame.west, frame.lat],
        [frame.west + (frame.east - frame.west) / side, frame.lat],
        `${row.role}/horizontal-pitch`,
      ),
      cartographicDistanceKm(
        [frame.lon, frame.south],
        [frame.lon, frame.south + (frame.north - frame.south) / side],
        `${row.role}/vertical-pitch`,
      ),
    );
    const pixelKm =
      (2 * frame.height * Math.tan(frame.fov * 0.5)) /
      contract.scene.viewport.height /
      1000;
    const budget = {
      ...contract.budgetTemplate,
      latticePitchKm: pitchKm,
      pixelGroundFootprintKm: pixelKm,
    };
    budget.latticeHalfKm = 0.5 * pitchKm;
    budget.pixelHalfKm = 0.5 * pixelKm;
    budget.quantizationKm = budget.latticeHalfKm + budget.pixelHalfKm;
    budget.qKm = budget.sourceMaxAdjacentEdgeKm + budget.quantizationKm;
    budget.boundaryP95LimitKm = budget.qKm;
    budget.boundaryMaximumLimitKm = 2 * budget.qKm;
    budget.centroidLimitKm =
      budget.simon1994BudgetKm +
      budget.sourceMaxAdjacentEdgeKm +
      budget.quantizationKm;
    budget.motionVectorLimitKm = 2 * budget.qKm;
    budget.speedUncertaintyKmPerHour =
      (budget.motionVectorLimitKm / contract.sourceMotion.seconds) * 3600;
    const cellLonLat = valid.map((id) => [id, ...worldById.get(id)]);
    publishCheckpoint({ stage: "spatial-summary" });
    const spatial = runtimeSpatialSummarizer(
      {
        side,
        qKm: budget.qKm,
        measurementKind,
        validProjectedCellIds: valid,
        projectedPixelIdByValidCell,
        nasaInsideCellIds: nasa,
        classifiedCellIds: classified,
        cellLonLat,
      },
      (left, right, stage) =>
        cartographicDistanceKm(left, right, `${row.role}/${stage}`),
    );
    publishCheckpoint({
      stage: "spatial-summary-complete",
      counts: {
        valid: valid.length,
        nasa: nasa.length,
        terrain: terrain.length,
        classified: classified.length,
        sourceBoundary: spatial.boundary.sourceBoundaryCellCount,
        classifiedBoundary: spatial.boundary.classifiedBoundaryCellCount,
      },
      sourceCentroid: {
        available: spatial.centroid.sourceLonLat !== null,
        lonLat: spatial.centroid.sourceLonLat,
      },
      measuredCentroid: {
        available: spatial.centroid.measuredLonLat !== null,
        lonLat: spatial.centroid.measuredLonLat,
      },
      boundary: {
        comparable: spatial.boundary.comparable,
        unavailableReason: spatial.boundary.unavailableReason,
      },
    });
    return {
      budget,
      spatialMeasurementKind: spatial.measurementKind,
      lattice: {
        side,
        candidateCellCount: side ** 2,
        sampling: "cell-centre",
        guardDegrees: contract.scene.cameraGuardDegrees,
        uniqueProjectedCellCount: valid.length,
        validProjectedCellCount: valid.length,
        nasaInsideCount: nasa.length,
        nasaOutsideCount: valid.length - nasa.length,
        duplicateProjectedCellCount: duplicates,
        latticePitchKm: pitchKm,
        pixelGroundFootprintKm: pixelKm,
        validProjectedCellIds: valid,
        projectedPixelIdByValidCell,
        nasaInsideCellIds: nasa,
        terrainCellIds: terrain,
        classifiedCellIds: classified,
        qBoundaryBandCellIds: spatial.qBoundaryBandCellIds,
        cellLonLat,
      },
      mask: {
        method: contract.scene.terrainMaskMethod,
        terrainPixelCount: terrain.length,
        classifiedCellCount: classified.length,
        strictlyClassifiedCellCount: classified.length,
        oneCodeBoundaryCount: oneCodeBoundary.length,
        oneCodeBoundaryCellIds: oneCodeBoundary,
        offBrightTerrainPixelCount: offBrightTerrain.length,
        offBrightTerrainCellIds: offBrightTerrain,
        offMinimumLuminanceCode: contract.scene.offMinimumLuminanceCode,
        onOffRatioMaximum: contract.scene.onOffRatioMaximum,
        allClassifiedMeetOffMinimum: true,
        allClassifiedMeetOnOffRatio: true,
        classificationAppliedOnlyInsideTerrainMask: classified.every((id) =>
          terrain.includes(id),
        ),
      },
      boundary: spatial.boundary,
      centroid: spatial.centroid,
      classifiedPoints,
    };
  };

  const captures = [];
  const rows = [];
  const independentEphemerisDeltas = [];
  currentTime = times[0];
  viewer.clock.currentTime = C.JulianDate.clone(currentTime);
  const providerTransition = {
    role: "terrain-provider",
    iso: runtimeRows[0].iso,
    cameraIdentity: frameCamera(runtimeRows[0]).cameraIdentity,
  };
  applyCaptureState("off");
  const providerReadiness = await settleTransition(
    providerTransition,
    contract.scene.providerReadinessMaxFrames,
  );
  if (!globe.tilesLoaded || decodedQuantizedMeshCount < 1) {
    throw new Error("real QuantizedMesh terrain did not settle");
  }
  for (let index = 0; index < runtimeRows.length; index++) {
    const row = runtimeRows[index];
    publishCheckpoint({
      phase: row.phase,
      stage: "row-transition",
      rowIndex: index,
      role: row.role,
      iso: row.iso,
      measurementKind: "event",
      counts: {
        valid: null,
        nasa: null,
        terrain: null,
        classified: null,
        sourceBoundary: null,
        classifiedBoundary: null,
      },
      sourceCentroid: { available: false, lonLat: null },
      measuredCentroid: { available: false, lonLat: null },
      boundary: { comparable: false, unavailableReason: null },
      terrain: {
        transitionRole: null,
        selectedTileIds: [],
        preparedSelectedTileIds: [],
        selectionRevision: null,
        captureFrameNumber: null,
      },
    });
    currentTime = times[index];
    viewer.clock.currentTime = C.JulianDate.clone(currentTime);
    const frame = frameCamera(row);
    const transition = {
      role: row.role,
      iso: row.iso,
      cameraIdentity: frame.cameraIdentity,
    };
    const variantReadiness = await settleCaptureVariantReadiness(
      transition,
      contract.scene.transitionReadinessMaxFrames,
    );
    const transitionReadiness = variantReadiness.legs.at(-1).readiness;
    const stableIdentity = transitionReadiness.observations.at(-1).tuple;
    publishCheckpoint({
      stage: "transition-readiness-complete",
      terrain: {
        transitionRole: stableIdentity.transitionRole,
        selectedTileIds: [...stableIdentity.selectedTileIds],
        preparedSelectedTileIds: [...stableIdentity.preparedSelectedTileIds],
        selectionRevision: stableIdentity.selectionRevision,
        captureFrameNumber: stableIdentity.captureFrameNumber,
      },
    });
    const cameraFrame = measureCameraFrame(row, frame);
    const whiteShot = await captureStableSnapshot(
      transition,
      stableIdentity,
      "white",
    );
    const blackShot = await captureStableSnapshot(
      transition,
      stableIdentity,
      "black",
    );
    const offShot = await captureStableSnapshot(
      transition,
      stableIdentity,
      "off",
    );
    const onShot = await captureStableSnapshot(
      transition,
      stableIdentity,
      "on",
    );
    const tuple = onShot.tuple;
    const measured = buildLattice(
      row,
      frame,
      offShot.imageData,
      onShot.imageData,
      whiteShot.imageData,
      blackShot.imageData,
      "event",
      index,
      {
        transitionRole: tuple.transitionRole,
        selectedTileIds: [...tuple.selectedTileIds],
        preparedSelectedTileIds: [...tuple.preparedSelectedTileIds],
        selectionRevision: tuple.selectionRevision,
        captureFrameNumber: tuple.captureFrameNumber,
      },
    );
    const imageIds = Object.fromEntries(
      ["white", "black", "off", "on"].map((label) => [
        label,
        crypto.randomUUID(),
      ]),
    );
    independentEphemerisDeltas.push({
      sunMeters: onShot.ephemeris.independent.sunDeltaMeters,
      moonMeters: onShot.ephemeris.independent.moonDeltaMeters,
    });
    rows.push({
      phase: row.phase,
      role: row.role,
      iso: row.iso,
      sourceIndexZeroBased: row.sourceIndexZeroBased,
      sourceRecordNumber: row.sourceRecordNumber,
      outputRecordNumber: row.outputRecordNumber,
      sourceCenter: row.sourceCenter,
      spatialMeasurementKind: measured.spatialMeasurementKind,
      fixtureGeometry: {
        bbox: [...row.bbox],
        ring: row.ring.map((point) => [...point]),
        storedPointCount: row.ring.length,
        canonicalSha256: row.fixtureGeometry.canonicalSha256,
      },
      clock: {
        shouldAnimate: viewer.clock.shouldAnimate,
        currentTimeIso: C.JulianDate.toIso8601(viewer.clock.currentTime),
        renderArgumentIso: row.iso,
        frameStateTimeIso: C.JulianDate.toIso8601(scene.frameState.time),
        exactPinnedFrame: C.JulianDate.equals(
          scene.frameState.time,
          currentTime,
        ),
      },
      cameraFrame,
      terrainTuple: tuple,
      ephemeris: structuredClone(onShot.ephemeris),
      variantReadiness,
      transitionReadiness,
      captureTerrainProofs: [
        { label: "white", ...whiteShot.stateProof, tuple: whiteShot.tuple },
        { label: "black", ...blackShot.stateProof, tuple: blackShot.tuple },
        { label: "off", ...offShot.stateProof, tuple: offShot.tuple },
        { label: "on", ...onShot.stateProof, tuple: onShot.tuple },
      ],
      thresholdOrigin:
        "exact-WGS84-source-edge+half-lattice+half-pixel;40km-Simon1994",
      sourceEdge: contract.sourceEdge,
      iouUsedAsGate: false,
      recentered: false,
      translatedToModel: false,
      metricImageBindings: {
        white: { imageId: imageIds.white },
        black: { imageId: imageIds.black },
        off: { imageId: imageIds.off },
        on: { imageId: imageIds.on },
      },
      ...measured,
    });
    captures.push(
      {
        imageId: imageIds.white,
        label: `${row.role}-white`,
        dataUrl: whiteShot.dataUrl,
        captureMethod: contract.captureMethod,
      },
      {
        imageId: imageIds.black,
        label: `${row.role}-black`,
        dataUrl: blackShot.dataUrl,
        captureMethod: contract.captureMethod,
      },
      {
        imageId: imageIds.off,
        label: `${row.role}-off`,
        dataUrl: offShot.dataUrl,
        captureMethod: contract.captureMethod,
      },
      {
        imageId: imageIds.on,
        label: `${row.role}-on`,
        dataUrl: onShot.dataUrl,
        captureMethod: contract.captureMethod,
      },
    );
    mark(row.phase);
  }

  currentTime = times.at(-1);
  viewer.clock.currentTime = C.JulianDate.clone(currentTime);
  publishCheckpoint({
    phase: contract.control.phase,
    stage: "row-transition",
    rowIndex: runtimeRows.length,
    role: contract.control.role,
    iso: contract.control.iso,
    measurementKind: "control",
    counts: {
      valid: null,
      nasa: null,
      terrain: null,
      classified: null,
      sourceBoundary: null,
      classifiedBoundary: null,
    },
    sourceCentroid: { available: false, lonLat: null },
    measuredCentroid: { available: false, lonLat: null },
    boundary: { comparable: false, unavailableReason: null },
    terrain: {
      transitionRole: null,
      selectedTileIds: [],
      preparedSelectedTileIds: [],
      selectionRevision: null,
      captureFrameNumber: null,
    },
  });
  const controlFrame = frameCamera(runtimeRows[1]);
  const controlTransition = {
    role: contract.control.role,
    iso: contract.control.iso,
    cameraIdentity: controlFrame.cameraIdentity,
  };
  const controlVariantReadiness = await settleCaptureVariantReadiness(
    controlTransition,
    contract.scene.transitionReadinessMaxFrames,
  );
  const controlTransitionReadiness =
    controlVariantReadiness.legs.at(-1).readiness;
  const controlCameraFrame = measureCameraFrame(runtimeRows[1], controlFrame);
  const controlStableIdentity =
    controlTransitionReadiness.observations.at(-1).tuple;
  publishCheckpoint({
    stage: "transition-readiness-complete",
    terrain: {
      transitionRole: controlStableIdentity.transitionRole,
      selectedTileIds: [...controlStableIdentity.selectedTileIds],
      preparedSelectedTileIds: [
        ...controlStableIdentity.preparedSelectedTileIds,
      ],
      selectionRevision: controlStableIdentity.selectionRevision,
      captureFrameNumber: controlStableIdentity.captureFrameNumber,
    },
  });
  const controlWhiteShot = await captureStableSnapshot(
    controlTransition,
    controlStableIdentity,
    "white",
  );
  const controlBlackShot = await captureStableSnapshot(
    controlTransition,
    controlStableIdentity,
    "black",
  );
  const controlOffShot = await captureStableSnapshot(
    controlTransition,
    controlStableIdentity,
    "off",
  );
  const controlOnShot = await captureStableSnapshot(
    controlTransition,
    controlStableIdentity,
    "on",
  );
  const controlTerrainTuple = controlOnShot.tuple;
  const controlMeasured = buildLattice(
    runtimeRows[1],
    controlFrame,
    controlOffShot.imageData,
    controlOnShot.imageData,
    controlWhiteShot.imageData,
    controlBlackShot.imageData,
    "control",
    runtimeRows.length,
    {
      transitionRole: controlTerrainTuple.transitionRole,
      selectedTileIds: [...controlTerrainTuple.selectedTileIds],
      preparedSelectedTileIds: [...controlTerrainTuple.preparedSelectedTileIds],
      selectionRevision: controlTerrainTuple.selectionRevision,
      captureFrameNumber: controlTerrainTuple.captureFrameNumber,
    },
  );
  const controlImageIds = Object.fromEntries(
    ["white", "black", "off", "on"].map((label) => [
      label,
      crypto.randomUUID(),
    ]),
  );
  captures.push(
    {
      imageId: controlImageIds.white,
      label: "noneclipse-control-white",
      dataUrl: controlWhiteShot.dataUrl,
      captureMethod: contract.captureMethod,
    },
    {
      imageId: controlImageIds.black,
      label: "noneclipse-control-black",
      dataUrl: controlBlackShot.dataUrl,
      captureMethod: contract.captureMethod,
    },
    {
      imageId: controlImageIds.off,
      label: "noneclipse-control-off",
      dataUrl: controlOffShot.dataUrl,
      captureMethod: contract.captureMethod,
    },
    {
      imageId: controlImageIds.on,
      label: "noneclipse-control-on",
      dataUrl: controlOnShot.dataUrl,
      captureMethod: contract.captureMethod,
    },
  );
  mark(contract.control.phase);

  const before = rows[1].centroid.measuredLonLat;
  const after = rows[2].centroid.measuredLonLat;
  const sourceHeading = C.Math.toRadians(
    contract.sourceMotion.initialHeadingDegrees,
  );
  let motionMeasurement = {
    comparable: false,
    unavailableReason: "measured-centroid-unavailable",
    measuredDirectionEast: null,
    measuredDirectionNorth: null,
    vectorErrorKm: null,
    measuredSpeedKmPerHour: null,
  };
  if (before !== null && after !== null) {
    requireDegreeLonLat(before, "measured-motion/before");
    requireDegreeLonLat(after, "measured-motion/after");
    const measuredDistanceKm = cartographicDistanceKm(
      before,
      after,
      "measured-motion",
    );
    const measuredHeading = Math.atan2(
      Math.sin(C.Math.toRadians(after[0] - before[0])) *
        Math.cos(C.Math.toRadians(after[1])),
      Math.cos(C.Math.toRadians(before[1])) *
        Math.sin(C.Math.toRadians(after[1])) -
        Math.sin(C.Math.toRadians(before[1])) *
          Math.cos(C.Math.toRadians(after[1])) *
          Math.cos(C.Math.toRadians(after[0] - before[0])),
    );
    motionMeasurement = {
      comparable: true,
      unavailableReason: null,
      measuredDirectionEast: Math.sin(measuredHeading) > 0,
      measuredDirectionNorth: Math.cos(measuredHeading) > 0,
      vectorErrorKm: Math.hypot(
        measuredDistanceKm * Math.sin(measuredHeading) -
          contract.sourceMotion.eastKm,
        measuredDistanceKm * Math.cos(measuredHeading) -
          contract.sourceMotion.northKm,
      ),
      measuredSpeedKmPerHour:
        (measuredDistanceKm / contract.sourceMotion.seconds) * 3600,
    };
  }
  const q = Math.max(rows[1].budget.qKm, rows[2].budget.qKm);
  publishCheckpoint({
    stage: "motion-summary-complete",
    rowIndex: null,
    role: null,
    iso: null,
    measurementKind: null,
  });
  mark(contract.phases[7]);
  await drainSubmittedGpuWork();
  return {
    schema: contract.diagnosticsSchema,
    renderer,
    phaseOrder: phases,
    scene: {
      renderer,
      viewport: contract.scene.viewport,
      cameraMode: contract.scene.cameraMode,
      framingRule: contract.scene.framingRule,
      cameraGuardDegrees: contract.scene.cameraGuardDegrees,
      minimumMarginPixels: contract.scene.minimumMarginPixels,
      actualMarginPixels: Math.min(
        controlCameraFrame.actualMarginPixels,
        ...rows.map((row) => row.cameraFrame.actualMarginPixels),
      ),
      cameraHeightMeters: fixedCameraHeight,
      verticalFovRadians: fixedVerticalFov,
      recentered: false,
      translatedToModel: false,
      fixedCameraHeightAcrossRows: true,
      shouldAnimate: viewer.clock.shouldAnimate,
      requestRenderMode: scene.requestRenderMode,
      hdr: scene.highDynamicRange,
      bloom: scene.postProcessStages?.bloom?.enabled === true,
      taa: scene.taaEnabled === true,
      fxaa: scene.postProcessStages?.fxaa?.enabled === true,
      fog: scene.fog.enabled,
      volumetricFog: atmosphericConditions.volumetricFog?.enabled === true,
      atmosphere:
        scene.skyAtmosphere?.show === true ||
        globe.showGroundAtmosphere === true,
      clouds:
        atmosphericConditions.clouds?.enableProcedural === true ||
        atmosphericConditions.clouds?.enableVolumetric === true,
      water: globe.showWaterEffect,
      eclipseAutoExposure: lighting.eclipseAutoExposure,
    },
    ephemeris: {
      preloadComplete: true,
      matrixMethod: "Transforms.computeIcrfToFixedMatrix",
      allMatricesDefined: matrices.every(Boolean),
      allMatricesFinite: matrices.every((m) =>
        [...Array(9).keys()].every((i) => Number.isFinite(m[i])),
      ),
      allMatricesOrthonormal: matrices.every(matrixOrthonormal),
      temeUsed: false,
      fallbackUsed: false,
      independentSimon1994: true,
      maximumSunPositionDeltaMeters: Math.max(
        ...independentEphemerisDeltas.map((entry) => entry.sunMeters),
      ),
      maximumMoonPositionDeltaMeters: Math.max(
        ...independentEphemerisDeltas.map((entry) => entry.moonMeters),
      ),
      rowLineages: rows.map((row) => ({
        role: row.role,
        iso: row.iso,
        captureFrameNumber: row.terrainTuple.captureFrameNumber,
        lineage: structuredClone(row.ephemeris),
      })),
      xysFiles: [],
    },
    fixtureProof: {
      parser: "parseSvs5073UmbraShapefile",
      manifestSchema: fixtureManifest.schema,
      manifestFingerprint: {
        byteLength: manifestBytes.byteLength,
        sha256: manifestSha256,
      },
      projectionWkt: fixtureCollection.projectionWkt,
      featureCount: fixtureCollection.features.length,
      storedPointCount: runtimeRows.reduce(
        (sum, row) => sum + row.ring.length,
        0,
      ),
      fingerprints: fixtureFingerprints,
      recordIdentities: runtimeRows.map((row) => ({
        sourceIndexZeroBased: row.sourceIndexZeroBased,
        sourceRecordNumber: row.sourceRecordNumber,
        outputRecordNumber: row.outputRecordNumber,
      })),
      manifestRecordIdentities: manifestRecords.map((record) => ({
        sourceIndexZeroBased: record.sourceIndexZeroBased,
        sourceRecordNumber: record.sourceRecordNumber,
        outputRecordNumber: record.outputRecordNumber,
      })),
      maximumSourceEdge,
    },
    terrain: {
      providerClass: "CesiumTerrainProvider",
      terrainDataInstanceProof: "instanceof-C.QuantizedMeshTerrainData",
      decodedQuantizedMeshCount,
      selectedRealMeshCount: rows.reduce(
        (count, row) => count + row.terrainTuple.selectedRealTileIds.length,
        0,
      ),
      preparedRealMeshCount: rows.reduce(
        (count, row) => count + row.terrainTuple.preparedRealTileIds.length,
        0,
      ),
      preparedTupleCount: rows.filter((row) => row.terrainTuple.prepared)
        .length,
      allPreparedTuplesMatchSelected: rows.every(
        (row) =>
          row.terrainTuple.selectedTileId === row.terrainTuple.preparedTileId,
      ),
      allPreparedTuplesReal: rows.every(
        (row) => row.terrainTuple.renderedMeshIsRealMesh,
      ),
      fillMeshCount: rows.reduce(
        (count, row) => count + row.terrainTuple.preparedFillTileIds.length,
        0,
      ),
      surrogateUsed: false,
      ellipsoidOnly: false,
      maskMethod: contract.scene.terrainMaskMethod,
      responseCodeThreshold: contract.scene.terrainResponseCodeThreshold,
      whiteBlackSameCamera: true,
      validWgs84Intersection: true,
      sourceTerrainProviderIdentity: objectId(quantizedProvider),
      surfaceProviderIdentity: objectId(surfaceProvider),
      providerReadiness,
    },
    rows,
    control: {
      phase: contract.control.phase,
      role: contract.control.role,
      iso: contract.control.iso,
      bracketBeforeRole: contract.control.bracketBeforeRole,
      bracketAfterRole: contract.control.bracketAfterRole,
      bracketMidpointIso: contract.control.bracketMidpointIso,
      offsetSeconds: contract.control.offsetSeconds,
      derivation: contract.control.derivation,
      cameraSourceRole: contract.control.cameraSourceRole,
      projectionSourceRole: contract.control.projectionSourceRole,
      terrainSourceRole: contract.control.terrainSourceRole,
      clock: {
        shouldAnimate: viewer.clock.shouldAnimate,
        currentTimeIso: C.JulianDate.toIso8601(viewer.clock.currentTime),
        renderArgumentIso: contract.control.iso,
        frameStateTimeIso: C.JulianDate.toIso8601(scene.frameState.time),
        exactPinnedFrame: C.JulianDate.equals(
          scene.frameState.time,
          currentTime,
        ),
      },
      classifiedCellCount: controlMeasured.mask.classifiedCellCount,
      strictlyClassifiedCellCount:
        controlMeasured.mask.strictlyClassifiedCellCount,
      oneCodeBoundaryCount: controlMeasured.mask.oneCodeBoundaryCount,
      classificationAppliedOnlyInsideTerrainMask:
        controlMeasured.mask.classificationAppliedOnlyInsideTerrainMask,
      spatialMeasurementKind: controlMeasured.spatialMeasurementKind,
      cameraFrame: controlCameraFrame,
      ephemeris: structuredClone(controlOnShot.ephemeris),
      terrainTuple: controlTerrainTuple,
      variantReadiness: controlVariantReadiness,
      transitionReadiness: controlTransitionReadiness,
      captureTerrainProofs: [
        {
          label: "white",
          ...controlWhiteShot.stateProof,
          tuple: controlWhiteShot.tuple,
        },
        {
          label: "black",
          ...controlBlackShot.stateProof,
          tuple: controlBlackShot.tuple,
        },
        {
          label: "off",
          ...controlOffShot.stateProof,
          tuple: controlOffShot.tuple,
        },
        {
          label: "on",
          ...controlOnShot.stateProof,
          tuple: controlOnShot.tuple,
        },
      ],
      lattice: controlMeasured.lattice,
      mask: controlMeasured.mask,
      boundary: controlMeasured.boundary,
      centroid: controlMeasured.centroid,
      metricImageBindings: {
        white: { imageId: controlImageIds.white },
        black: { imageId: controlImageIds.black },
        off: { imageId: controlImageIds.off },
        on: { imageId: controlImageIds.on },
      },
    },
    motion: {
      fromRole: contract.sourceMotion.fromRole,
      toRole: contract.sourceMotion.toRole,
      seconds: contract.sourceMotion.seconds,
      sourceVectorDistanceKm: contract.sourceMotion.vectorDistanceKm,
      sourceInitialHeadingDegrees: contract.sourceMotion.initialHeadingDegrees,
      sourceEastKm: contract.sourceMotion.eastKm,
      sourceNorthKm: contract.sourceMotion.northKm,
      sourceDirection: contract.sourceMotion.direction,
      sourceSpeedKmPerHour: contract.sourceMotion.speedKmPerHour,
      method: contract.sourceMotion.method,
      ...motionMeasurement,
      vectorLimitKm: 2 * q,
      speedUncertaintyKmPerHour:
        ((2 * q) / contract.sourceMotion.seconds) * 3600,
      sourceHeadingRadians: sourceHeading,
    },
    captures,
    capture: {
      method: contract.captureMethod,
      canonicalSameTask: true,
    },
    errors,
  };
};

function pageContract(renderer, rows) {
  return {
    renderer,
    runtimePath,
    diagnosticsSchema: C12_29_S5_SVS_DIAGNOSTICS_SCHEMA,
    spatialSummarizerSource: summarizeSvsSpatialMetrics.toString(),
    phases: [...C12_29_S5_SVS_PHASES],
    rows,
    control: C12_29_S5_SVS_CONTROL,
    captureMethod: C12_29_S5_SVS_CAPTURE_METHOD,
    captureLabels: [...C12_29_S5_SVS_CAPTURE_LABELS],
    captureStates: C12_29_S5_SVS_CAPTURE_STATES,
    terrainRoute: C12_29_S5_SVS_TERRAIN.baseRoute,
    fixtureParserRoute:
      "/Tools/visual-regression/fixtures/nasa-svs-5073/nasa-svs-5073-shapefile.mjs",
    fixtureBaseRoute: C12_29_S5_SVS_FIXTURE.baseRoute,
    fixtureStem: C12_29_S5_SVS_FIXTURE.stem,
    fixtureManifest: C12_29_S5_SVS_FIXTURE.manifest,
    fixtureMembers: C12_29_S5_SVS_FIXTURE.members,
    scene: C12_29_S5_SVS_SCENE,
    sourceEdge: C12_29_S5_SVS_SOURCE_EDGE,
    sourceMotion: C12_29_S5_SVS_SOURCE_MOTION,
    budgetTemplate: {
      sourceMaxAdjacentEdgeKm:
        C12_29_S5_SVS_SOURCE_EDGE.maximumAdjacentDistanceKm,
      simon1994BudgetKm: C12_29_S5_SVS_SIMON1994_BUDGET_KM,
    },
    ephemeris: C12_29_S5_SVS_EPHEMERIS,
  };
}

export function createSvsPageEvaluationSource(renderer, rows) {
  const contractJson = canonicalSvsArtifactBytes(pageContract(renderer, rows))
    .toString("utf8")
    .trimEnd();
  return `(${MEASURE_SVS_SESSION.toString()})(${contractJson},(${summarizeSvsSpatialMetrics.toString()}))`;
}

const canonicalSvsProofIdentity = (value) =>
  JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, entry[key]]),
      );
    }
    return entry;
  });

/** Reclassify one owner directly from decoded immutable PNG bytes in Node. */
export function deriveSvsDecodedImagePrimitives({
  expectedRow,
  owner,
  images,
  decodedByImageId,
  measurementKind,
}) {
  const channels = ["white", "black", "off", "on"];
  const decoded = {};
  const sources = {};
  for (const channel of channels) {
    const binding = owner?.metricImageBindings?.[channel];
    const image = images.find(
      (candidate) => candidate?.imageId === binding?.imageId,
    );
    const raster = decodedByImageId.get(binding?.imageId);
    if (
      !image ||
      !raster ||
      raster.width !== C12_29_S5_SVS_SCENE.viewport.width ||
      raster.height !== C12_29_S5_SVS_SCENE.viewport.height ||
      raster.channels !== 4 ||
      raster.data?.byteLength !== raster.width * raster.height * 4
    ) {
      throw new Error(
        `${owner?.role}/${channel}: immutable PNG RGBA decode differs`,
      );
    }
    decoded[channel] = raster;
    sources[channel] = {
      imageId: image.imageId,
      sha256: image.sha256,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
    };
  }

  const projection = deriveSvsWgs84ProjectedLattice(expectedRow);
  const terrainCellIds = [];
  const classifiedCellIds = [];
  const offBrightTerrainCellIds = [];
  const oneCodeBoundaryCellIds = [];
  const luminanceCode = (data, offset) =>
    0.2126 * data[offset] +
    0.7152 * data[offset + 1] +
    0.0722 * data[offset + 2];
  projection.validProjectedCellIds.forEach((cellId, index) => {
    const offset = projection.projectedPixelIdByValidCell[index] * 4;
    const response = Math.max(
      Math.abs(decoded.white.data[offset] - decoded.black.data[offset]),
      Math.abs(decoded.white.data[offset + 1] - decoded.black.data[offset + 1]),
      Math.abs(decoded.white.data[offset + 2] - decoded.black.data[offset + 2]),
    );
    if (response <= C12_29_S5_SVS_SCENE.terrainResponseCodeThreshold) return;
    terrainCellIds.push(cellId);
    const offLuminance = luminanceCode(decoded.off.data, offset);
    const onLuminance = luminanceCode(decoded.on.data, offset);
    const offPass = offLuminance >= C12_29_S5_SVS_SCENE.offMinimumLuminanceCode;
    if (offPass) offBrightTerrainCellIds.push(cellId);
    const ratioPass =
      onLuminance / Math.max(offLuminance, 1) <=
      C12_29_S5_SVS_SCENE.onOffRatioMaximum;
    if (offPass && ratioPass) {
      classifiedCellIds.push(cellId);
    } else if (
      (offPass &&
        !ratioPass &&
        onLuminance <=
          offLuminance * C12_29_S5_SVS_SCENE.onOffRatioMaximum + 1) ||
      (!offPass &&
        ratioPass &&
        offLuminance >= C12_29_S5_SVS_SCENE.offMinimumLuminanceCode - 1)
    ) {
      oneCodeBoundaryCellIds.push(cellId);
    }
  });
  const terrainSet = new Set(terrainCellIds);
  const rawClassifier = {
    terrainCellIds,
    classifiedCellIds,
    offBrightTerrainCellIds,
    oneCodeBoundaryCellIds,
    terrainPixelCount: terrainCellIds.length,
    classifiedCellCount: classifiedCellIds.length,
    strictlyClassifiedCellCount: classifiedCellIds.length,
    offBrightTerrainPixelCount: offBrightTerrainCellIds.length,
    oneCodeBoundaryCount: oneCodeBoundaryCellIds.length,
    allClassifiedMeetOffMinimum: true,
    allClassifiedMeetOnOffRatio: true,
    classificationAppliedOnlyInsideTerrainMask: classifiedCellIds.every((id) =>
      terrainSet.has(id),
    ),
  };
  const proof = {
    method: C12_29_S5_SVS_IMAGE_VERIFIER_METHOD,
    measurementKind,
    sources,
    projection,
    rawClassifier,
  };
  return {
    ...proof,
    verificationSha256: sha256(canonicalSvsProofIdentity(proof)),
  };
}

async function materializeImages(session, runId, paths) {
  const images = [];
  const decodedByImageId = new Map();
  for (const capture of session.captures) {
    const match = /^data:image\/png;base64,([a-z0-9+/=]+)$/iu.exec(
      capture.dataUrl ?? "",
    );
    if (!match || !isUuidV4(capture.imageId)) {
      throw new Error(`${session.renderer}/${capture.label}: invalid PNG`);
    }
    const bytes = Buffer.from(match[1], "base64");
    const metadata = await sharp(bytes).metadata();
    const fileName = `${artifactPrefix}.${runId}.${capture.imageId}.${session.renderer}.${capture.label}.png`;
    const file = path.join(paths.directory, fileName);
    createImmutableEvidence(file, bytes);
    const immutableBytes = fs.readFileSync(file);
    if (!immutableBytes.equals(bytes)) {
      throw new Error(
        `${session.renderer}/${capture.label}: immutable PNG bytes drifted`,
      );
    }
    const decoded = await sharp(immutableBytes)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    decodedByImageId.set(capture.imageId, {
      data: decoded.data,
      width: decoded.info.width,
      height: decoded.info.height,
      channels: decoded.info.channels,
    });
    images.push({
      imageId: capture.imageId,
      label: capture.label,
      renderer: session.renderer,
      runId,
      file: fileName,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
      width: metadata.width,
      height: metadata.height,
      pngSignatureValid: bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      decoded: metadata.format === "png",
      captureMethod: capture.captureMethod,
    });
  }
  session.images = images;
  const byId = new Map(images.map((image) => [image.imageId, image]));
  const bind = (binding) => {
    const image = byId.get(binding?.imageId);
    const proof = session.rows
      .flatMap((row) => row.captureTerrainProofs)
      .concat(session.control.captureTerrainProofs)
      .find(
        (candidate) =>
          `${candidate.tuple.transitionRole}-${candidate.label}` ===
          image?.label,
      );
    if (!image) throw new Error("metric image binding is absent");
    if (!proof) throw new Error("metric capture terrain proof is absent");
    return {
      imageId: image.imageId,
      sha256: image.sha256,
      byteLength: image.byteLength,
      width: image.width,
      height: image.height,
      captureFrameNumber: proof.tuple.captureFrameNumber,
      selectionRevision: proof.tuple.selectionRevision,
      selectionContentIdentity: proof.tuple.selectionContentIdentity,
    };
  };
  for (const row of session.rows) {
    row.metricImageBindings = Object.fromEntries(
      ["white", "black", "off", "on"].map((channel) => [
        channel,
        bind(row.metricImageBindings[channel]),
      ]),
    );
  }
  session.control.metricImageBindings = Object.fromEntries(
    ["white", "black", "off", "on"].map((channel) => [
      channel,
      bind(session.control.metricImageBindings[channel]),
    ]),
  );
  for (const row of session.rows) {
    const expectedRow = C12_29_S5_SVS_ROWS.find(
      (expected) => expected.role === row.role,
    );
    row.imageDerivedPrimitives = deriveSvsDecodedImagePrimitives({
      expectedRow,
      owner: row,
      images,
      decodedByImageId,
      measurementKind: "event",
    });
  }
  const controlSource = C12_29_S5_SVS_ROWS.find(
    (expected) => expected.role === C12_29_S5_SVS_CONTROL.projectionSourceRole,
  );
  session.control.imageDerivedPrimitives = deriveSvsDecodedImagePrimitives({
    expectedRow: controlSource,
    owner: session.control,
    images,
    decodedByImageId,
    measurementKind: "control",
  });
  delete session.captures;
}

async function runBrowserSession(
  browser,
  renderer,
  baseIdentity,
  runId,
  paths,
  rows,
) {
  const context = await browser.newContext({
    viewport: C12_29_S5_SVS_SCENE.viewport,
    deviceScaleFactor: 1,
  });
  const requestLedger = createSvsRequestLedger(baseIdentity.origin);
  const pageErrors = [];
  const consoleErrors = [];
  await context.route("**/*", async (route) => {
    let url;
    try {
      url = new URL(route.request().url());
    } catch {
      await route.continue();
      return;
    }
    if (/^https?:$/u.test(url.protocol) && url.origin !== baseIdentity.origin) {
      requestLedger.noteExternalRequest(route.request());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("request", (request) => requestLedger.noteRequest(request));
  page.on("requestfinished", (request) =>
    requestLedger.noteRequestFinished(request),
  );
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    requestLedger.noteRequestFailed(request);
  });
  page.on("response", (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (
      url.origin === baseIdentity.origin &&
      /^\/Build\/CesiumUnminified\/Assets\/IAU2006_XYS\/IAU2006_XYS_\d+\.json$/u.test(
        url.pathname,
      )
    ) {
      requestLedger.trackXysResponse({
        route: url.pathname,
        status: response.status(),
        body: () => response.body(),
      });
    }
  });
  let capturedEntry = false;
  const entryPromise = new Promise((resolve, reject) => {
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!capturedEntry && url.pathname === runtimePath) {
        capturedEntry = true;
        void response.body().then(
          (bytes) =>
            resolve({
              sessionLabel: renderer,
              ok: response.ok(),
              status: response.status(),
              byteLength: bytes.byteLength,
              sha256: sha256(bytes),
            }),
          reject,
        );
      }
    });
  });
  const startedAtMs = Date.now();
  let session;
  let sessionError;
  try {
    const url = new URL(viewerPath, baseIdentity.origin);
    url.searchParams.set("renderer", renderer);
    url.searchParams.set("offline", "true");
    await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForFunction(
      () => Boolean(globalThis.viewer?.scene?.context),
      undefined,
      { timeout: 90_000 },
    );
    let pageTimer;
    let measured;
    try {
      measured = await Promise.race([
        page.evaluate(createSvsPageEvaluationSource(renderer, rows)),
        new Promise((_, reject) => {
          pageTimer = setTimeout(
            () => reject(new Error(`${renderer} page timeout`)),
            PAGE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(pageTimer);
    }
    const servedEntry = await entryPromise;
    session = {
      ...measured,
      freshContext: true,
      serialIndex: C12_29_S5_SVS_RENDERERS.indexOf(renderer),
      startedAtMs,
      servedEntry,
      errors: {
        ...measured.errors,
        page: pageErrors,
        console: consoleErrors,
      },
    };
    await materializeImages(session, runId, paths);
  } catch (error) {
    sessionError = await retainSvsRuntimeDiagnostics(page, error, {
      renderer,
      pageErrors,
      consoleErrors,
    });
  }
  const cleanupErrors = [];
  const pageClose = await closeSvsResourceBounded(page, `${renderer} page`);
  const contextClose = await closeSvsResourceBounded(
    context,
    `${renderer} context`,
  );
  for (const close of [pageClose, contextClose]) {
    if (!close.closed) {
      cleanupErrors.push(
        close.error ??
          new Error(
            `${close.label} close expired after ${CLOSE_TIMEOUT_MS} ms`,
          ),
      );
    }
  }
  let ledgerSnapshot;
  try {
    ledgerSnapshot = await drainSvsRequestLedger(requestLedger);
  } catch (error) {
    cleanupErrors.push(error);
  }
  const errorCleanup = sessionError
    ? {
        pageCloseAttempted: pageClose.attempted,
        pageClosed: pageClose.closed,
        pageCloseTimedOut: pageClose.timedOut,
        contextCloseAttempted: contextClose.attempted,
        contextClosed: contextClose.closed,
        contextCloseTimedOut: contextClose.timedOut,
        requestLedgerDrainAttempted: true,
        requestLedgerDrained: ledgerSnapshot !== undefined,
        errorCount: cleanupErrors.length,
        errors: cleanupErrors.map(svsErrorText),
      }
    : null;
  if (sessionError) {
    const retained = sessionError.diagnostics;
    sessionError.diagnostics = createSvsRuntimeErrorDiagnostics({
      renderer,
      runtimeCheckpoint: retained.runtimeCheckpoint,
      checkpointReadError: retained.checkpointReadError,
      pageErrorCount: retained.pageErrorCount,
      pageErrors: retained.pageErrors,
      consoleErrorCount: retained.consoleErrorCount,
      consoleErrors: retained.consoleErrors,
      originalError: retained.originalError,
      stage: retained.stage,
      cleanup: errorCleanup,
    });
  }
  if (session && ledgerSnapshot) {
    session.ephemeris.xysFiles = ledgerSnapshot.xysResponses;
    session.transport = {
      loopbackOnly: ledgerSnapshot.externalRequests === 0,
      externalRequests: ledgerSnapshot.externalRequests,
      failedRequests: ledgerSnapshot.failedRequests,
      ledgerMethod: ledgerSnapshot.ledgerMethod,
      ledgerSealed: ledgerSnapshot.ledgerSealed,
      ledgerGeneration: ledgerSnapshot.ledgerGeneration,
      quiescentStableTurns: ledgerSnapshot.quiescentStableTurns,
      postSealTurnObserved: ledgerSnapshot.postSealTurnObserved,
      responseBodiesPending: ledgerSnapshot.responseBodiesPending,
      responseBodyErrors: ledgerSnapshot.responseBodyErrors,
      lateEvents: ledgerSnapshot.lateEvents,
    };
    session.cleanup = {
      contextClosed: contextClose.closed,
      contextCloseAttempted: contextClose.attempted,
      contextCloseTimedOut: contextClose.timedOut,
      pageClosed: pageClose.closed,
      pageCloseAttempted: pageClose.attempted,
      pageCloseTimedOut: pageClose.timedOut,
      closeTimeoutMs: CLOSE_TIMEOUT_MS,
      pendingRequestsMeasured: true,
      pendingRequests: ledgerSnapshot.pendingRequests,
      requestStartedCount: ledgerSnapshot.requestStartedCount,
      requestSettledCount: ledgerSnapshot.requestSettledCount,
      pendingRequestPeak: ledgerSnapshot.pendingRequestPeak,
      deviceLost: session.errors.deviceLost,
    };
    session.completedAtMs = Date.now();
  }
  if (cleanupErrors.length > 0) {
    if (sessionError) cleanupErrors.unshift(sessionError);
    const aggregate = new AggregateError(
      cleanupErrors,
      `${renderer} page/context cleanup failed`,
    );
    if (sessionError?.diagnostics) {
      aggregate.diagnostics = sessionError.diagnostics;
    } else {
      aggregate.diagnostics = createSvsCleanupErrorDiagnostics({
        renderer,
        pageErrors,
        consoleErrors,
        cleanup: {
          pageCloseAttempted: pageClose.attempted,
          pageClosed: pageClose.closed,
          pageCloseTimedOut: pageClose.timedOut,
          contextCloseAttempted: contextClose.attempted,
          contextClosed: contextClose.closed,
          contextCloseTimedOut: contextClose.timedOut,
          requestLedgerDrainAttempted: true,
          requestLedgerDrained: ledgerSnapshot !== undefined,
          errorCount: cleanupErrors.length,
          errors: cleanupErrors.map(svsErrorText),
        },
        originalError: aggregate,
      });
    }
    throw aggregate;
  }
  if (sessionError) throw sessionError;
  return session;
}

function crossBackendRows(sessions) {
  return C12_29_S5_SVS_ROWS.map((expected, index) => {
    const left = sessions[0].rows[index];
    const right = sessions[1].rows[index];
    const leftSet = new Set(left.lattice.classifiedCellIds);
    const rightSet = new Set(right.lattice.classifiedCellIds);
    const differingCellIds = [...new Set([...leftSet, ...rightSet])]
      .filter((id) => leftSet.has(id) !== rightSet.has(id))
      .sort((a, b) => a - b);
    const qKm = Math.max(left.budget.qKm, right.budget.qKm);
    const dl = left.centroid.measuredLonLat;
    const dr = right.centroid.measuredLonLat;
    const centroidComparable = dl !== null && dr !== null;
    const bands = new Set([
      ...left.lattice.qBoundaryBandCellIds,
      ...right.lattice.qBoundaryBandCellIds,
    ]);
    return {
      role: expected.role,
      differingCellIds,
      differingCellCount: differingCellIds.length,
      allDifferingCellsWithinUnionQBoundaryBands: differingCellIds.every((id) =>
        bands.has(id),
      ),
      centroidComparable,
      centroidUnavailableReason: centroidComparable
        ? null
        : "measured-centroid-unavailable",
      centroidDistanceKm: centroidComparable
        ? wgs84GeodesicDistanceKm(dl, dr)
        : null,
      centroidDistanceMethod: "WGS84-Vincenty-inverse",
      centroidLimitKm: 2 * qKm,
    };
  });
}

export async function withSvsWatchdog(
  task,
  closeOnTimeout,
  timeoutMs = WATCHDOG_MS,
  closeTimeoutMs = CLOSE_TIMEOUT_MS,
  drainTimeoutMs = WATCHDOG_DRAIN_MS,
) {
  const settlement = Promise.resolve()
    .then(task)
    .then(
      (value) => ({ kind: "value", value }),
      (error) => ({ kind: "error", error }),
    );
  let timer;
  const first = await Promise.race([
    settlement,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (first.kind === "value") return first.value;
  if (first.kind === "error") throw first.error;

  let closeError;
  let closeTimer;
  const closeResult = await Promise.race([
    Promise.resolve()
      .then(closeOnTimeout)
      .then(
        () => ({ closed: true }),
        (error) => ({ closed: false, error }),
      ),
    new Promise((resolve) => {
      closeTimer = setTimeout(
        () => resolve({ closed: false, timedOut: true }),
        closeTimeoutMs,
      );
    }),
  ]);
  clearTimeout(closeTimer);
  if (!closeResult.closed) {
    closeError =
      closeResult.error ?? new Error("SVS browser close timeout expired");
  }
  let drainTimer;
  const drained = await Promise.race([
    settlement.then((result) => ({ drained: true, result })),
    new Promise((resolve) => {
      drainTimer = setTimeout(
        () => resolve({ drained: false, result: undefined }),
        drainTimeoutMs,
      );
    }),
  ]);
  clearTimeout(drainTimer);
  const taskDrained = drained.drained;
  const drainedResult = drained.result;
  const error = new Error(
    `SVS browser watchdog expired after ${timeoutMs} ms; task drained=${taskDrained}; browser closed=${closeResult.closed}; close timedOut=${closeResult.timedOut === true}`,
  );
  if (closeError) error.cause = closeError;
  error.watchdog = {
    watchdogTimedOut: true,
    closeCompleted: closeResult.closed,
    closeTimedOut: closeResult.timedOut === true,
    taskDrained,
  };
  if (drainedResult?.kind === "error" && drainedResult.error?.diagnostics) {
    error.diagnostics = cloneSvsJsonSafe(drainedResult.error.diagnostics);
    error.watchdog.inFlightDiagnosticsPreserved = true;
  } else {
    error.diagnostics = createSvsOperationalErrorDiagnostics(
      error,
      "browser-watchdog-error",
    );
    error.watchdog.inFlightDiagnosticsPreserved = false;
  }
  if (!taskDrained || closeResult.closed !== true) {
    error.retainSvsRunning = true;
  }
  throw error;
}

export async function closeSvsResourceBounded(
  instance,
  label,
  timeoutMs = CLOSE_TIMEOUT_MS,
) {
  if (!instance) {
    return {
      label,
      attempted: false,
      closed: true,
      timedOut: false,
      error: undefined,
    };
  }
  let timer;
  const result = await Promise.race([
    Promise.resolve()
      .then(() => instance.close())
      .then(
        () => ({ closed: true, timedOut: false }),
        (error) => ({ closed: false, timedOut: false, error }),
      ),
    new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ closed: false, timedOut: true, error: undefined }),
        timeoutMs,
      );
    }),
  ]);
  clearTimeout(timer);
  return { label, attempted: true, ...result };
}

async function closeBrowserBounded(instance, timeoutMs = CLOSE_TIMEOUT_MS) {
  const result = await closeSvsResourceBounded(instance, "browser", timeoutMs);
  if (!result.closed) {
    const error =
      result.error ??
      new Error(`SVS browser close expired after ${timeoutMs} ms`);
    error.retainSvsRunning = true;
    error.cleanup = result;
    throw error;
  }
  return result;
}

export async function runC1229S5SvsProbe(options = {}) {
  const operations = options.operations ?? fs;
  const launchBrowser =
    options.launchBrowser ?? ((launch) => chromium.launch(launch));
  const runId = options.runId ?? randomUUID();
  const paths = createSvsArtifactPaths(runId, options.outputDirectory);
  const baseIdentity = validateSvsLoopbackBase(options.base ?? base);
  let running;
  let ownership;
  let browser;
  let browserCleanup;
  try {
    ownership = beginSvsEvidenceRun(paths, runId, operations);
    ({ running } = ownership);
    const start = await collectProvenanceSnapshot();
    const rows = await loadFixtureForContract();
    browser = await launchBrowser({ channel: "msedge", headless: true });
    const sessions = await withSvsWatchdog(
      async () => {
        const measured = [];
        for (const renderer of C12_29_S5_SVS_RENDERERS) {
          measured.push(
            await runBrowserSession(
              browser,
              renderer,
              baseIdentity,
              runId,
              paths,
              rows,
            ),
          );
        }
        return measured;
      },
      async () => {
        const closing = browser;
        browser = undefined;
        await closeBrowserBounded(closing);
      },
      options.watchdogMs ?? WATCHDOG_MS,
    );
    const closing = browser;
    browser = undefined;
    browserCleanup = await closeBrowserBounded(closing);
    const end = await collectProvenanceSnapshot();
    const firstRedCurrentSnapshot = requireFirstRedSnapshot(
      paths,
      ownership.firstRedBaseline,
      operations,
    );
    const report = {
      schema: C12_29_S5_SVS_SCHEMA,
      runId,
      lifecycle: {
        firstRedStable: firstRedSnapshotsEqual(
          ownership.firstRedBaseline,
          firstRedCurrentSnapshot,
        ),
        firstRedBaselineValidated: ownership.firstRedBaselineValidated,
        firstRedBaseline: ownership.prior.firstRed,
        firstRedCurrent: publicFirstRedSnapshot(firstRedCurrentSnapshot),
        browserCleanup: {
          attempted: browserCleanup.attempted,
          closed: browserCleanup.closed,
          timedOut: browserCleanup.timedOut,
          closeTimeoutMs: CLOSE_TIMEOUT_MS,
        },
        lockCreatedExclusively: true,
        runningReceiptCreatedExclusively: true,
        foreignOwnerPreserved: true,
        recoveryInspected: true,
        runningPublishedBeforeBrowser: true,
        immutableBeforeLatest: true,
        latestBeforeUnlock: true,
        lockOwnedByRun: true,
        archiveLatestByteIdentical: true,
        runningReceipt: running,
        finalReceipt: {
          schema: C12_29_S5_SVS_SCHEMA,
          runId,
          status: "FAIL",
          incomplete: false,
          publicationProtocol:
            "exclusive-lock+write-once-receipts+claim-verify-latest+foreign-preserving-unlock",
        },
        finalStatus: "FAIL",
        lock: {
          runId,
          nonce: running.nonce,
          released: true,
          releaseAfterLatestVerified: true,
        },
        priorStateInspected: true,
        publicationOrder: [
          "LOCK",
          "RUNNING",
          "ARCHIVE",
          "FIRST_RED",
          "LATEST",
          "RECEIPT",
          "UNLOCK",
        ],
      },
      provenance: assessProvenance(start, end, sessions),
      sessions,
      crossBackend: crossBackendRows(sessions),
    };
    // The receipt records the exact protocol; the publication function then
    // behaviorally proves archive/latest byte identity before releasing lock.
    const provisional = foldC1229S5SvsGate(report);
    report.lifecycle.finalStatus = provisional.status;
    report.lifecycle.finalReceipt.status = provisional.status;
    report.lifecycle.publicationOrder =
      provisional.status === "PASS"
        ? ["LOCK", "RUNNING", "ARCHIVE", "LATEST", "RECEIPT", "UNLOCK"]
        : [
            "LOCK",
            "RUNNING",
            "ARCHIVE",
            "FIRST_RED",
            "LATEST",
            "RECEIPT",
            "UNLOCK",
          ];
    const verdict = foldC1229S5SvsGate(report);
    const artifact = {
      schema: C12_29_S5_SVS_SCHEMA,
      runId,
      generatedAt: new Date().toISOString(),
      status: verdict.status,
      exitCode: verdict.exitCode,
      incomplete: false,
      report: { ...report, ...verdict },
    };
    const publication = publishSvsFinalArtifact(
      paths,
      artifact,
      ownership,
      operations,
    );
    return { artifact, publication, paths };
  } catch (error) {
    let browserCloseError;
    if (browser) {
      const closing = browser;
      browser = undefined;
      try {
        await closeBrowserBounded(closing);
      } catch (closeError) {
        browserCloseError = closeError;
      }
    }
    if (browserCloseError) {
      error.retainSvsRunning = true;
      error.browserCloseError =
        browserCloseError?.stack ??
        browserCloseError?.message ??
        String(browserCloseError);
      throw error;
    }
    if (!running || error?.retainSvsRunning === true) throw error;
    const artifact = createSvsErrorArtifact(runId, error);
    const publication = publishSvsFinalArtifact(
      paths,
      artifact,
      ownership,
      operations,
    );
    return { artifact, publication, paths };
  } finally {
    // Last-resort reclamation. Both paths above clear `browser` before handing
    // the handle to `closeBrowserBounded`, so this only runs when something
    // left the loop without doing either — the leak a `finally` is the only
    // construct that can cover.
    if (browser !== undefined) {
      try {
        await browser.close();
      } catch {
        // The verdict (or the primary error) is already decided and reported;
        // a failure here must not replace it.
      }
      browser = undefined;
    }
  }
}

async function main() {
  // Terminating watchdog. `withSvsWatchdog` only REJECTS the task it wraps,
  // which needs the event loop to come back to it; a wedged page loop never
  // yields, so nothing but `process.exit` ends the run. `unref` keeps the timer
  // from extending a healthy one.
  const processWatchdog = setTimeout(() => {
    console.error(
      `[probe-c12-29-s5-svs-footprint] process watchdog fired after ` +
        `${PROCESS_WATCHDOG_MS} ms; the in-run watchdog did not settle`,
    );
    process.exit(2);
  }, PROCESS_WATCHDOG_MS);
  processWatchdog.unref?.();
  try {
    const result = await runC1229S5SvsProbe();
    console.log(
      JSON.stringify(
        {
          runId: result.artifact.runId,
          status: result.artifact.status,
          exitCode: result.artifact.exitCode,
          artifact: result.paths.run,
        },
        null,
        2,
      ),
    );
    process.exitCode = result.artifact.exitCode;
  } finally {
    clearTimeout(processWatchdog);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === probePath) {
  await main();
}
