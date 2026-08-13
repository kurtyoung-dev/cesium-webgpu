#!/usr/bin/env node
/**
 * C12-29 S4 orbital-sunrise browser acceptance.
 *
 * Two fresh browser contexts run the same 400 km circular-orbit sunrise. The
 * normal lane retains the globe and atmosphere for visual review. The
 * certifying blend-neutral lane keeps the atmosphere logically visible (so
 * Sun.js computes extinction) but holds its radiance below one output code and
 * hides every other destination contribution. Sun-hidden controls prove that
 * destination quantizes black, so both blend modes expose the Sun itself.
 *
 * The 181 one-second samples cover a three-minute envelope. Every rendered
 * frame and its direct `scene.canvas.toDataURL("image/png")` capture happen in
 * one page task. There is deliberately no canvas-copy/readback path.
 *
 * Evidence is fail-closed: an invocation first owns `.latest.json` with a
 * RUNNING marker, then publishes a UUID-named immutable run, a create-new
 * write-once first-red when applicable, and only then replaces latest. An
 * interruption or publication failure therefore cannot expose a stale PASS.
 *
 * Requires a current local build and server. This file never builds or starts
 * either dependency itself.
 */

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";
import sharp from "sharp";

import {
  C12_29_S4_CAPTURE_METHOD,
  C12_29_S4_HIDDEN_ANCHORS_KM,
  C12_29_S4_NEUTRAL_SCENE,
  C12_29_S4_NORMAL_ANCHORS_KM,
  C12_29_S4_ORBIT,
  C12_29_S4_RENDERERS,
  C12_29_S4_SAMPLE_OFFSETS_SECONDS,
  C12_29_S4_SCHEMA,
  C12_29_S4_VIEWPORT,
  foldC1229S4Gate,
  isUuidV4,
  sameEvidenceFingerprint,
  validateS4FinalArtifactShape,
} from "./lib/c12-29-s4-orbital-sunrise-gate.mjs";
import {
  assertEvidenceReadableOrAbsent,
  atomicReplaceEvidence,
  compareEvidenceFileSnapshots,
  createImmutableEvidence,
  fingerprintEvidenceFile,
  inspectBuildSourceIdentity,
  preserveFirstRedEvidence,
  snapshotEvidenceFiles,
  validateServedEntryIdentities,
} from "./lib/build-source-identity.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const base = process.env.PROBE_BASE ?? "http://localhost:8080";
const viewerPath = "/Apps/CesiumViewer/index.html";
const runtimePath = "/Build/CesiumUnminified/index.js";
const pinnedIso = C12_29_S4_ORBIT.epochIso;
const viewport = C12_29_S4_VIEWPORT;
const outputDirectory = path.resolve(
  process.env.C12_29_S4_OUTPUT_DIR ??
    path.join(toolDirectory, "output", "c12-29-s4-orbital-sunrise"),
);
const artifactPrefix = "campaign12-c12-29-s4-orbital-sunrise";
const S4_CAMPAIGN = "C12-29 S4";
const S4_PROBE = "orbital-sunrise limb-glow acceptance";
const browserLaunch = Object.freeze({
  channel: "msedge",
  headless: true,
  timeout: 90_000,
  args: ["--enable-unsafe-webgpu", "--use-vulkan", "--disable-cache"],
});
const WATCHDOG_MS = 480_000;
const OUTER_WATCHDOG_GRACE_MS = 60_000;
const PAGE_RUN_TIMEOUT_MS = 390_000;
const TASK_DRAIN_GRACE_MS = 5_000;

const buildEntryPath = path.join(
  repositoryRoot,
  "Build",
  "CesiumUnminified",
  "index.js",
);
const buildSourceMapPath = `${buildEntryPath}.map`;
const identityHelperPath = fileURLToPath(
  new URL("./lib/build-source-identity.mjs", import.meta.url),
);
const gateHelperPath = fileURLToPath(
  new URL("./lib/c12-29-s4-orbital-sunrise-gate.mjs", import.meta.url),
);
const specPath = path.join(
  toolDirectory,
  "c12-29-s4-orbital-sunrise-gate.spec.mjs",
);
const probePath = fileURLToPath(import.meta.url);

function repositoryRoute(file) {
  const relative = path.relative(repositoryRoot, file).replaceAll("\\", "/");
  if (relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`Viewer closure escaped the repository: ${file}`);
  }
  return `/${relative}`;
}

function resolveClosureReference(fromFile, reference) {
  const clean = reference.trim().replace(/^['"]|['"]$/gu, "");
  if (
    clean.length === 0 ||
    /^(?:data:|https?:|#)/iu.test(clean) ||
    clean.startsWith("//")
  ) {
    return null;
  }
  const pathname = clean.replace(/[?#].*$/u, "");
  return pathname.startsWith("/")
    ? path.join(repositoryRoot, pathname.slice(1))
    : path.resolve(path.dirname(fromFile), pathname);
}

function discoverViewerClosure() {
  const entry = path.join(repositoryRoot, "Apps/CesiumViewer/index.html");
  const queue = [{ file: entry, requiredExecution: true, kind: "document" }];
  const files = new Map();
  while (queue.length > 0) {
    const { file, requiredExecution, kind } = queue.shift();
    const route = repositoryRoute(file);
    if (files.has(route)) {
      if (requiredExecution) {
        files.get(route).requiredExecution = true;
      }
      continue;
    }
    const bytes = fs.readFileSync(file);
    files.set(route, { file, requiredExecution, kind });
    if (route === runtimePath) {
      continue;
    }
    const source = bytes.toString("utf8");
    const references = [];
    if (file.endsWith(".html")) {
      for (const match of source.matchAll(/<([a-z][\w:-]*)\b[^>]*>/giu)) {
        const tag = match[0];
        const tagName = match[1].toLowerCase();
        const attribute = tag.match(/\b(?:src|href)\s*=\s*["']([^"']+)["']/iu);
        if (!attribute) {
          continue;
        }
        const rel = tag.match(/\brel\s*=\s*["']([^"']+)["']/iu)?.[1] ?? "";
        references.push({
          reference: attribute[1],
          requiredExecution:
            tagName === "script" ||
            rel
              .split(/\s+/u)
              .some((value) => value.toLowerCase() === "stylesheet"),
          kind: tagName === "script" ? "script" : "html-link",
        });
      }
    } else if (file.endsWith(".js")) {
      for (const match of source.matchAll(
        /\b(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/gu,
      )) {
        references.push({
          reference: match[1],
          requiredExecution: true,
          kind: "script",
        });
      }
    } else if (file.endsWith(".css")) {
      for (const match of source.matchAll(
        /@import\s+(?:url\()?\s*["']?([^"')\s;]+)["']?\s*\)?/giu,
      )) {
        references.push({
          reference: match[1],
          requiredExecution: true,
          kind: "stylesheet",
        });
      }
      for (const match of source.matchAll(
        /\burl\(\s*["']?([^"')\s]+)["']?\s*\)/giu,
      )) {
        references.push({
          reference: match[1],
          requiredExecution: false,
          kind: "style-asset",
        });
      }
    }
    for (const referenceEntry of references) {
      const {
        reference,
        requiredExecution: required,
        kind: referenceKind,
      } = referenceEntry;
      const resolved = resolveClosureReference(file, reference);
      if (!resolved) {
        continue;
      }
      if (!fs.existsSync(resolved)) {
        throw new Error(
          `Viewer closure reference ${reference} from ${repositoryRoute(file)} is missing`,
        );
      }
      queue.push({
        file: resolved,
        requiredExecution: required,
        kind: referenceKind,
      });
    }
  }
  return Object.freeze({
    entries: Object.freeze(Object.fromEntries([...files].sort())),
    requiredExecutionRoutes: Object.freeze(
      [...files]
        .filter(([, value]) => value.requiredExecution)
        .map(([route]) => route)
        .sort(),
    ),
  });
}

const viewerClosureDefinition = discoverViewerClosure();
const viewerRoutes = Object.freeze(
  Object.fromEntries(
    Object.entries(viewerClosureDefinition.entries).map(([route, entry]) => [
      route,
      entry.file,
    ]),
  ),
);
const viewerRequiredExecutionRoutes =
  viewerClosureDefinition.requiredExecutionRoutes;
const viewerRouteRelativeFiles = Object.freeze(
  Object.keys(viewerRoutes).map((route) => route.slice(1)),
);
const viewerRouteEvidenceKeys = Object.freeze(
  Object.fromEntries(
    Object.keys(viewerRoutes).map((route, index) => [
      route,
      `viewerRoute${String(index).padStart(2, "0")}:${route}`,
    ]),
  ),
);

const packetRelativeFiles = Object.freeze([
  "packages/engine/Source/Scene/Sun.js",
  "packages/engine/Source/Scene/computeAtmosphereExtinction.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  "packages/engine/Source/Shaders/SunFS.glsl",
  "packages/engine/Source/Shaders/SunFS.js",
  "Tools/visual-regression/lib/c12-29-s4-orbital-sunrise-gate.mjs",
  "Tools/visual-regression/c12-29-s4-orbital-sunrise-gate.spec.mjs",
  "Tools/visual-regression/probe-c12-29-s4-orbital-sunrise.mjs",
  ...viewerRouteRelativeFiles,
]);

const buildSourceRelativeFiles = Object.freeze([
  "packages/engine/Source/Scene/Sun.js",
  "packages/engine/Source/Scene/computeAtmosphereExtinction.js",
  "packages/engine/Source/Scene/Scene.js",
  "packages/engine/Source/Renderer/WebGPU/WebGPUEnvironmentRenderer.js",
  // Raw GLSL is generated into this module. Raw/generated equality is checked
  // separately, then the generated module is compared with sourcesContent.
  "packages/engine/Source/Shaders/SunFS.js",
]);

const localEvidenceFiles = Object.freeze({
  ...Object.fromEntries(
    packetRelativeFiles.map((file, index) => [
      `packet${String(index).padStart(2, "0")}`,
      path.join(repositoryRoot, file),
    ]),
  ),
  buildEntry: buildEntryPath,
  buildSourceMap: buildSourceMapPath,
  identityHelper: identityHelperPath,
  gateHelper: gateHelperPath,
  focusedSpec: specPath,
  probe: probePath,
  ...Object.fromEntries(
    Object.entries(viewerRoutes).map(([route, file], index) => [
      viewerRouteEvidenceKeys[route],
      file,
    ]),
  ),
});

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function redactQueriesInString(value) {
  const withoutAuthorityCredentials = value.replace(
    /(https?:\/\/)[^\s/@]+@/giu,
    "$1[REDACTED]@",
  );
  return withoutAuthorityCredentials
    .replace(/\?([^\s#"'<>]*)/gu, (_match, query) => {
      if (query.length === 0) {
        return "?";
      }
      return `?${query
        .split("&")
        .map((field) => {
          if (field.length === 0) {
            return field;
          }
          const equals = field.indexOf("=");
          const name = equals < 0 ? field : field.slice(0, equals);
          return `${name}=[REDACTED]`;
        })
        .join("&")}`;
    })
    .replace(/#([^\s"'<>]*)/gu, (match, fragment) =>
      fragment.length === 0 ? match : "#[REDACTED]",
    );
}

export function redactS4OutputPayload(value) {
  if (typeof value === "string") {
    return redactQueriesInString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactS4OutputPayload);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        redactS4OutputPayload(entry),
      ]),
    );
  }
  return value;
}

export const serializeS4Artifact = (value) =>
  `${JSON.stringify(redactS4OutputPayload(value), null, 2)}\n`;

export function validateS4LoopbackBase(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`S4 base is not an absolute URL: ${error.message}`, {
      cause: error,
    });
  }
  const serializedHostname = url.hostname.toLowerCase();
  const hostname =
    serializedHostname.startsWith("[") && serializedHostname.endsWith("]")
      ? serializedHostname.slice(1, -1)
      : serializedHostname;
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    !new Set(["localhost", "127.0.0.1", "::1"]).has(hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !new Set(["", "/"]).has(url.pathname)
  ) {
    throw new Error(
      "S4 base must be credential-free, query-free HTTP(S) on localhost/127.0.0.1/::1",
    );
  }
  return Object.freeze({
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    hostname,
  });
}

const S4_RUNTIME_ROUTE_FETCH_ERROR = "S4_RUNTIME_ROUTE_FETCH_ERROR ";

function isKnownS4SupportResource(entry) {
  const resourceType = entry?.resourceType?.toLowerCase();
  const route = entry?.route ?? "";
  const assetRoute = /^\/Build\/CesiumUnminified\/Assets\//u.test(route);
  const widgetImageRoute =
    /^\/Build\/CesiumUnminified\/Widgets\/Images\//u.test(route);
  const workerRoute = /^\/Build\/CesiumUnminified\/Workers\/[^/]+\.js$/u.test(
    route,
  );
  const scriptWorkerChunkRoute =
    /^\/Build\/CesiumUnminified\/Workers\/chunk-[A-Z0-9]+\.js$/u.test(route);
  return (
    (resourceType === "xmlhttprequest" && assetRoute) ||
    (resourceType === "img" && (assetRoute || widgetImageRoute)) ||
    ((resourceType === "worker" || resourceType === "other") && workerRoute) ||
    (resourceType === "script" && scriptWorkerChunkRoute)
  );
}

function sameS4ResourceLedger(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every(
      (entry, index) =>
        entry?.route === right[index]?.route &&
        entry?.resourceType === right[index]?.resourceType &&
        entry?.sameOrigin === right[index]?.sameOrigin,
    )
  );
}

/**
 * Capture the Viewer execution ledger before issuing explicit identity
 * requests, then hash every registered route through a nonce-isolated URL.
 * This function is deliberately self-contained because Playwright serializes
 * it into the page; optional dependencies exist only for browser-free tests.
 */
export async function captureS4PageRuntimeViewerRoutes({
  viewerRoutePaths,
  requiredViewerRoutePaths,
  requestedRenderer,
  routeFetchNonce,
  origin = globalThis.location?.origin,
  documentPath = globalThis.location?.pathname,
  resourceEntries,
  fetchImpl,
  digestImpl,
}) {
  const entries =
    resourceEntries ?? globalThis.performance?.getEntriesByType("resource");
  const fetchRoute = fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (
    !Array.isArray(viewerRoutePaths) ||
    viewerRoutePaths.length === 0 ||
    !Array.isArray(requiredViewerRoutePaths) ||
    typeof requestedRenderer !== "string" ||
    requestedRenderer.length === 0 ||
    typeof routeFetchNonce !== "string" ||
    routeFetchNonce.length === 0 ||
    typeof origin !== "string" ||
    typeof documentPath !== "string" ||
    !Array.isArray(entries) ||
    typeof fetchRoute !== "function"
  ) {
    throw new Error("S4 page runtime-route identity inputs are malformed");
  }

  const hashBytes = async (bytes) => {
    if (typeof digestImpl === "function") {
      return digestImpl(bytes);
    }
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
  };

  const sameOriginResourceLedger = [
    {
      route: documentPath,
      resourceType: "document",
      sameOrigin: true,
    },
  ];
  for (const entry of entries) {
    try {
      const url = new URL(entry.name);
      if (url.origin === origin) {
        sameOriginResourceLedger.push({
          route: url.pathname,
          resourceType: entry.initiatorType || "other",
          sameOrigin: true,
        });
      }
    } catch {
      // Browser-internal non-URLs cannot cross the evidence origin.
    }
  }

  // The complete same-origin resource record is evidence, but only registered
  // Viewer routes belong to the exact execution closure. Engine data, imagery,
  // and workers are separately retained as support resources.
  const executionLedger = sameOriginResourceLedger.filter((entry) =>
    viewerRoutePaths.includes(entry.route),
  );
  const supportResourceLedger = sameOriginResourceLedger.filter(
    (entry) => !viewerRoutePaths.includes(entry.route),
  );
  const executedResourcePaths = executionLedger.map((entry) => entry.route);
  const executedRouteCounts = Object.fromEntries(
    viewerRoutePaths.map((route) => [
      route,
      executedResourcePaths.filter((path) => path === route).length,
    ]),
  );
  const executedRoutes = [...new Set(executedResourcePaths)].sort();
  const isKnownSupportResource = (entry) => {
    const resourceType = entry.resourceType.toLowerCase();
    const assetRoute = /^\/Build\/CesiumUnminified\/Assets\//u.test(
      entry.route,
    );
    const widgetImageRoute =
      /^\/Build\/CesiumUnminified\/Widgets\/Images\//u.test(entry.route);
    const workerRoute = /^\/Build\/CesiumUnminified\/Workers\/[^/]+\.js$/u.test(
      entry.route,
    );
    const scriptWorkerChunkRoute =
      /^\/Build\/CesiumUnminified\/Workers\/chunk-[A-Z0-9]+\.js$/u.test(
        entry.route,
      );
    return (
      (resourceType === "xmlhttprequest" && assetRoute) ||
      (resourceType === "img" && (assetRoute || widgetImageRoute)) ||
      ((resourceType === "worker" || resourceType === "other") &&
        workerRoute) ||
      (resourceType === "script" && scriptWorkerChunkRoute)
    );
  };
  const unregisteredExecutedRoutes = [
    ...new Set(
      supportResourceLedger
        .filter((entry) => !isKnownSupportResource(entry))
        .map((entry) => entry.route),
    ),
  ].sort();

  const runtimeViewerFetches = [];
  for (const [routeIndex, route] of viewerRoutePaths.entries()) {
    const requestUrl = new URL(route, origin);
    if (
      requestUrl.origin !== origin ||
      requestUrl.pathname !== route ||
      requestUrl.username !== "" ||
      requestUrl.password !== ""
    ) {
      throw new Error(`S4 runtime identity route is not exact: ${route}`);
    }
    requestUrl.search = "";
    requestUrl.hash = "";
    requestUrl.searchParams.set(
      "__s4_identity",
      `${routeFetchNonce}-${routeIndex}`,
    );
    try {
      const response = await fetchRoute(requestUrl.href, {
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
      });
      const bytes = await response.arrayBuffer();
      runtimeViewerFetches.push({
        route,
        ok: response.ok,
        status: response.status,
        byteLength: bytes.byteLength,
        sha256: await hashBytes(bytes),
      });
    } catch (error) {
      const failure = {
        phase: "page-runtime-route-identity",
        renderer: requestedRenderer,
        routeIndex,
        routeOrdinal: routeIndex + 1,
        routeCount: viewerRoutePaths.length,
        route,
        path: requestUrl.pathname,
        url: `${requestUrl.origin}${requestUrl.pathname}?__s4_identity=[REDACTED]`,
        originalError: error?.message ?? String(error),
      };
      throw new Error(
        `S4_RUNTIME_ROUTE_FETCH_ERROR ${JSON.stringify(failure)}`,
        { cause: error },
      );
    }
  }

  return {
    documentPath,
    executedBeforeExplicitFetch: true,
    requiredExecutionRoutes: requiredViewerRoutePaths,
    sameOriginResourceLedger,
    executionLedger,
    supportResourceLedger,
    executedRouteCounts,
    executedRoutes,
    unregisteredExecutedRoutes,
    unexpectedExecutedRoutes: unregisteredExecutedRoutes,
    fetches: runtimeViewerFetches,
  };
}

export function parseS4RuntimeRouteFetchFailure(error) {
  const message = String(error?.message ?? error);
  const marker = message.indexOf(S4_RUNTIME_ROUTE_FETCH_ERROR);
  if (marker < 0) {
    return null;
  }
  const payload = message
    .slice(marker + S4_RUNTIME_ROUTE_FETCH_ERROR.length)
    .split(/\r?\n/u, 1)[0];
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

export async function captureS4ServedViewerRoutes({
  requestContext,
  routes,
  baseOrigin,
  sessionLabel,
}) {
  if (
    !requestContext ||
    typeof requestContext.get !== "function" ||
    !Array.isArray(routes) ||
    routes.length === 0
  ) {
    throw new Error(
      "S4 served-route capture requires a request context and routes",
    );
  }
  const identities = [];
  for (const route of routes) {
    const url = new URL(route, baseOrigin);
    const response = await requestContext.get(url.href, {
      failOnStatusCode: false,
      maxRedirects: 0,
      timeout: 15_000,
    });
    const bytes = await response.body();
    identities.push({
      sessionLabel,
      route,
      url: response.url(),
      ok: response.ok(),
      status: response.status(),
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return identities;
}

function safeGitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

async function boundedPromise(promise, milliseconds, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(new Error(`${label} timed out after ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function createS4ArtifactPaths(directory, runId) {
  if (!isUuidV4(runId)) {
    throw new Error("S4 runId must be a UUID v4 before artifact paths exist");
  }
  const root = path.resolve(directory);
  return Object.freeze({
    runId,
    directory: root,
    latest: path.join(root, `${artifactPrefix}.latest.json`),
    firstRed: path.join(root, `${artifactPrefix}.first-red.json`),
    run: path.join(root, `${artifactPrefix}.run-${runId}.json`),
    lock: path.join(root, `${artifactPrefix}.lock`),
    image(renderer, heightKm) {
      const height = heightKm < 0 ? `m${Math.abs(heightKm)}` : `p${heightKm}`;
      return path.join(
        root,
        `${artifactPrefix}.run-${runId}.${renderer}.normal-${height}km.png`,
      );
    },
  });
}

function assertExactS4ArtifactPaths(paths) {
  if (!isUuidV4(paths?.runId) || typeof paths?.directory !== "string") {
    throw new Error("S4 artifact path identity is malformed");
  }
  const expected = createS4ArtifactPaths(paths.directory, paths.runId);
  for (const key of ["directory", "latest", "firstRed", "run", "lock"]) {
    if (paths?.[key] !== expected[key]) {
      throw new Error(`S4 artifact path identity is not canonical for ${key}`);
    }
  }
  return expected;
}

export function inspectS4PriorLatest(file, operations = fs) {
  let bytes;
  try {
    bytes = operations.readFileSync(file);
  } catch (error) {
    const code = error?.code ?? error?.message ?? String(error);
    return {
      fingerprint: {
        file,
        exists: false,
        byteLength: null,
        sha256: null,
        error: code,
      },
      parsed: null,
      error:
        code === "ENOENT"
          ? null
          : `prior latest cannot be read exactly: ${String(code)}`,
    };
  }

  const fingerprint = {
    file,
    exists: true,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
  let latest;
  try {
    latest = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    return {
      fingerprint,
      parsed: null,
      error: `prior latest JSON is malformed: ${error?.message ?? String(error)}`,
    };
  }
  if (latest?.status === "RUNNING" || latest?.incomplete === true) {
    throw new Error(
      `previous RUNNING marker ${String(latest?.runId)} must be investigated before retry`,
    );
  }
  return { fingerprint, parsed: latest, error: null };
}

function assertOwnedRunningMarker(paths, marker) {
  if (
    marker?.schema !== C12_29_S4_SCHEMA ||
    marker?.campaign !== S4_CAMPAIGN ||
    marker?.probe !== S4_PROBE ||
    marker?.runId !== paths.runId ||
    marker?.status !== "RUNNING" ||
    marker?.incomplete !== true ||
    marker?.authority !== "exclusive-lock" ||
    !new Set(["ACQUIRING", "MEASURING"]).has(marker?.phase) ||
    marker?.supersedesLatest === undefined
  ) {
    throw new Error("RUNNING marker does not own this S4 invocation");
  }
}

function assertFinalizingRunningMarker(paths, marker) {
  assertExactS4ArtifactPaths(paths);
  assertOwnedRunningMarker(paths, marker);
  if (
    marker.phase !== "MEASURING" ||
    marker?.paths?.immutableRun !== paths.run ||
    marker?.paths?.firstRed !== paths.firstRed
  ) {
    throw new Error(
      "RUNNING marker does not contain the exact final S4 path identity",
    );
  }
}

function parseOwnedRunning(bytes, paths, label) {
  let marker;
  try {
    marker = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is malformed: ${error.message}`, {
      cause: error,
    });
  }
  assertOwnedRunningMarker(paths, marker);
  return marker;
}

function assertExactOwnedRunningFile(
  file,
  paths,
  runningMarker,
  label,
  operations = fs,
) {
  assertOwnedRunningMarker(paths, runningMarker);
  const expectedBytes = Buffer.from(serializeS4Artifact(runningMarker));
  const expectedMarker = JSON.parse(expectedBytes.toString("utf8"));
  const actualBytes = Buffer.from(operations.readFileSync(file));
  const actualMarker = parseOwnedRunning(actualBytes, paths, label);
  if (
    actualBytes.byteLength !== expectedBytes.byteLength ||
    sha256(actualBytes) !== sha256(expectedBytes) ||
    JSON.stringify(actualMarker) !== JSON.stringify(expectedMarker)
  ) {
    const error = new Error(
      `${label} differs from the exact serialized owned RUNNING marker`,
    );
    error.code = "S4_RUNNING_AUTHORITY_MISMATCH";
    throw error;
  }
  return actualMarker;
}

function acquireS4RunLock(paths, provisionalMarker, operations = fs) {
  operations.writeFileSync(paths.lock, serializeS4Artifact(provisionalMarker), {
    flag: "wx",
  });
}

function replaceOwnedS4RunLock(paths, marker, operations = fs) {
  parseOwnedRunning(
    operations.readFileSync(paths.lock),
    paths,
    "existing S4 lock",
  );
  atomicReplaceEvidence(paths.lock, serializeS4Artifact(marker), operations);
  parseOwnedRunning(
    operations.readFileSync(paths.lock),
    paths,
    "replaced S4 lock",
  );
}

export function readS4AuthoritativeState(paths, operations = fs) {
  try {
    const bytes = operations.readFileSync(paths.lock);
    const marker = parseOwnedRunning(bytes, paths, "authoritative S4 lock");
    return {
      source: "lock",
      marker,
      incomplete: true,
      fingerprint: {
        file: paths.lock,
        exists: true,
        byteLength: bytes.byteLength,
        sha256: sha256(bytes),
      },
    };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const latest = operations.readFileSync(paths.latest);
  return {
    source: "latest",
    marker: JSON.parse(latest.toString("utf8")),
    incomplete: false,
    fingerprint: {
      file: paths.latest,
      exists: true,
      byteLength: latest.byteLength,
      sha256: sha256(latest),
    },
  };
}

export function releaseS4RunLock(paths, runningMarker, operations = fs) {
  assertExactOwnedRunningFile(
    paths.lock,
    paths,
    runningMarker,
    "S4 lock before release",
    operations,
  );
  operations.unlinkSync(paths.lock);
  try {
    operations.readFileSync(paths.lock);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error("S4 lock remained readable after release");
}

function ensureAuthoritativeRunningLock(paths, runningMarker, operations = fs) {
  try {
    assertExactOwnedRunningFile(
      paths.lock,
      paths,
      runningMarker,
      "retained S4 lock",
      operations,
    );
    return [];
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const expectedBytes = serializeS4Artifact(runningMarker);
  operations.writeFileSync(paths.lock, expectedBytes, { flag: "wx" });
  try {
    assertExactOwnedRunningFile(
      paths.lock,
      paths,
      runningMarker,
      "recreated S4 lock",
      operations,
    );
    return [];
  } catch (verificationError) {
    // The create-new call above completed, so this process owns the blocking
    // file even if the filesystem silently changed its bytes. Repair through
    // an independent atomic-replace path without opening an acquisition gap.
    try {
      atomicReplaceEvidence(paths.lock, expectedBytes, operations);
      assertExactOwnedRunningFile(
        paths.lock,
        paths,
        runningMarker,
        "repaired S4 lock",
        operations,
      );
      return [verificationError];
    } catch (repairError) {
      throw new AggregateError(
        [verificationError, repairError],
        "recreated S4 lock could not be made byte-exact",
        { cause: repairError },
      );
    }
  }
}

function appendS4RecoveryFailure(failures, error) {
  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    failures.push(...error.errors);
    return;
  }
  failures.push(error);
}

function restoreCanonicalS4Running(paths, runningMarker, operations = fs) {
  const expectedBytes = serializeS4Artifact(runningMarker);
  const failures = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      atomicReplaceEvidence(paths.latest, expectedBytes, operations);
      assertExactOwnedRunningFile(
        paths.latest,
        paths,
        runningMarker,
        "restored canonical S4 RUNNING marker",
        operations,
      );
      return failures;
    } catch (error) {
      appendS4RecoveryFailure(failures, error);
      // A rename can complete before a filesystem wrapper reports failure.
      // Accept that state only after an independent exact byte+semantic read.
      try {
        assertExactOwnedRunningFile(
          paths.latest,
          paths,
          runningMarker,
          "restored canonical S4 RUNNING marker",
          operations,
        );
        return failures;
      } catch (verificationError) {
        appendS4RecoveryFailure(failures, verificationError);
      }
    }
  }

  // Use a non-atomic overwrite as an independent last restoration path. The
  // exact lock remains authoritative throughout, so interruption here is
  // fail-closed; the immediate byte+semantic read is still mandatory.
  try {
    operations.writeFileSync(paths.latest, expectedBytes, { flag: "w" });
    assertExactOwnedRunningFile(
      paths.latest,
      paths,
      runningMarker,
      "directly restored canonical S4 RUNNING marker",
      operations,
    );
    return failures;
  } catch (error) {
    appendS4RecoveryFailure(failures, error);
    try {
      assertExactOwnedRunningFile(
        paths.latest,
        paths,
        runningMarker,
        "directly restored canonical S4 RUNNING marker",
        operations,
      );
      return failures;
    } catch (verificationError) {
      appendS4RecoveryFailure(failures, verificationError);
    }
  }

  // If storage repeatedly refuses or silently corrupts RUNNING, remove the
  // mutable final-looking artifact. The retained lock still makes the run
  // fail closed, and an absent latest cannot masquerade as a completed PASS.
  try {
    operations.unlinkSync(paths.latest);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      appendS4RecoveryFailure(failures, error);
    }
  }
  try {
    operations.readFileSync(paths.latest);
    failures.push(
      new Error(
        "canonical S4 latest remained readable after failed RUNNING recovery",
      ),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      appendS4RecoveryFailure(failures, error);
    }
  }
  return failures;
}

function recoverS4RunningAuthority(paths, runningMarker, operations, cause) {
  const failures = [cause];
  try {
    failures.push(
      ...ensureAuthoritativeRunningLock(paths, runningMarker, operations),
    );
  } catch (lockError) {
    // A read/repair failure must not prevent the independent canonical
    // RUNNING restoration below. The existing lock remains authoritative when
    // it cannot be inspected; ENOENT is recreated by the helper above.
    appendS4RecoveryFailure(failures, lockError);
  }
  try {
    failures.push(
      ...restoreCanonicalS4Running(paths, runningMarker, operations),
    );
  } catch (restoreError) {
    appendS4RecoveryFailure(failures, restoreError);
  }
  if (failures.length === 1) {
    throw cause;
  }
  throw new AggregateError(
    failures,
    "S4 final publication failed; RUNNING authority recovery encountered additional failures",
    { cause },
  );
}

export function releaseS4LockOrRestoreRunning(
  paths,
  runningMarker,
  operations = fs,
) {
  assertOwnedRunningMarker(paths, runningMarker);
  try {
    releaseS4RunLock(paths, runningMarker, operations);
  } catch (error) {
    recoverS4RunningAuthority(paths, runningMarker, operations, error);
  }
}

function publishS4Running(paths, marker, operations = fs) {
  assertOwnedRunningMarker(paths, marker);
  atomicReplaceEvidence(paths.latest, serializeS4Artifact(marker), operations);
}

function assertRunningOwnership(paths, runningMarker, operations = fs) {
  assertFinalizingRunningMarker(paths, runningMarker);
  assertExactOwnedRunningFile(
    paths.lock,
    paths,
    runningMarker,
    "authoritative S4 lock",
    operations,
  );
  assertExactOwnedRunningFile(
    paths.latest,
    paths,
    runningMarker,
    "canonical S4 RUNNING marker",
    operations,
  );
}

export function finalizeS4Evidence(
  paths,
  artifact,
  runningMarker,
  operations = fs,
) {
  const shape = validateS4FinalArtifactShape(artifact);
  if (!shape.ok) {
    throw new Error(`malformed final S4 artifact: ${shape.reasons.join("; ")}`);
  }
  assertExactS4ArtifactPaths(paths);
  if (
    artifact.runId !== paths.runId ||
    artifact.runId !== runningMarker?.runId
  ) {
    throw new Error(
      "final S4 artifact runId differs from its canonical path or owned RUNNING identity",
    );
  }
  assertRunningOwnership(paths, runningMarker, operations);
  const bytes = serializeS4Artifact(artifact);
  const expectedFinalFingerprint = {
    byteLength: Buffer.byteLength(bytes),
    sha256: sha256(bytes),
  };
  // Publication order is load-bearing: archive and first-red are durable
  // before a mutable canonical final can replace RUNNING.
  createImmutableEvidence(paths.run, bytes, operations);
  const firstRed =
    artifact.status === "PASS"
      ? null
      : preserveFirstRedEvidence(paths.firstRed, bytes, operations);
  if (
    firstRed?.written === true &&
    (firstRed.exists !== true ||
      firstRed.byteLength !== expectedFinalFingerprint.byteLength ||
      firstRed.sha256 !== expectedFinalFingerprint.sha256)
  ) {
    throw new Error(
      "new first-red S4 artifact differs from the exact serialized final artifact",
    );
  }
  let immutableRun;
  let latest;
  try {
    atomicReplaceEvidence(paths.latest, bytes, operations);
    immutableRun = fingerprintEvidenceFile(paths.run, operations);
    latest = fingerprintEvidenceFile(paths.latest, operations);
    const archiveExact =
      immutableRun.exists === true &&
      immutableRun.byteLength === expectedFinalFingerprint.byteLength &&
      immutableRun.sha256 === expectedFinalFingerprint.sha256;
    const latestExact =
      latest.exists === true &&
      latest.byteLength === expectedFinalFingerprint.byteLength &&
      latest.sha256 === expectedFinalFingerprint.sha256;
    if (
      !archiveExact ||
      !latestExact ||
      !sameEvidenceFingerprint(immutableRun, latest)
    ) {
      throw new Error(
        "archive/latest S4 fingerprints differ from the exact serialized final artifact",
      );
    }
    releaseS4RunLock(paths, runningMarker, operations);
  } catch (error) {
    recoverS4RunningAuthority(paths, runningMarker, operations, error);
  }
  return { immutableRun, latest, firstRed };
}

async function inspectGeneratedSunShader() {
  const rawPath = path.join(
    repositoryRoot,
    "packages/engine/Source/Shaders/SunFS.glsl",
  );
  const generatedPath = path.join(
    repositoryRoot,
    "packages/engine/Source/Shaders/SunFS.js",
  );
  const rawBytes = fs.readFileSync(rawPath);
  const generatedBytes = fs.readFileSync(generatedPath);
  const generated = await import(
    `${pathToFileURL(generatedPath).href}?s4_identity=${randomUUID()}`
  );
  const normalizedRaw = rawBytes.toString("utf8").replaceAll("\r\n", "\n");
  return {
    raw: {
      file: rawPath,
      byteLength: rawBytes.byteLength,
      sha256: sha256(rawBytes),
    },
    generated: {
      file: generatedPath,
      byteLength: generatedBytes.byteLength,
      sha256: sha256(generatedBytes),
    },
    exact:
      typeof generated.default === "string" &&
      generated.default === normalizedRaw,
  };
}

async function collectS4Provenance() {
  const localIdentity = snapshotEvidenceFiles(localEvidenceFiles);
  const reasons = Object.entries(localIdentity)
    .filter(([, identity]) => identity.exists !== true)
    .map(
      ([name, identity]) =>
        `${name}: required identity is unreadable (${String(identity.error)})`,
    );
  let buildSourceIdentity;
  try {
    buildSourceIdentity = inspectBuildSourceIdentity({
      sourceMapPath: buildSourceMapPath,
      sourceFiles: buildSourceRelativeFiles.map((file) =>
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
  reasons.push(
    ...buildSourceIdentity.reasons.map(
      (reason) => `build/source identity: ${reason}`,
    ),
  );

  let generatedSunShader;
  try {
    generatedSunShader = await inspectGeneratedSunShader();
    if (!generatedSunShader.exact) {
      reasons.push("generated SunFS module differs from normalized raw GLSL");
    }
  } catch (error) {
    generatedSunShader = {
      exact: false,
      error: error?.message ?? String(error),
    };
    reasons.push("generated SunFS identity could not be established");
  }

  const gitHead = safeGitHead();
  if (!/^[0-9a-f]{40}$/u.test(gitHead ?? "")) {
    reasons.push("git HEAD identity is unavailable");
  }
  return {
    capturedAt: new Date().toISOString(),
    gitHead,
    packetRelativeFiles: [...packetRelativeFiles],
    localIdentity,
    buildSourceIdentity,
    generatedSunShader,
    ok: reasons.length === 0,
    reasons,
  };
}

function assessS4Provenance(options) {
  const reasons = [];
  if (options.start?.ok !== true) {
    reasons.push(
      `start identity is not exact: ${(options.start?.reasons ?? ["missing"]).join("; ")}`,
    );
  }
  if (options.end?.ok !== true) {
    reasons.push(
      `end identity is not exact: ${(options.end?.reasons ?? ["missing"]).join("; ")}`,
    );
  }
  if (options.start?.gitHead !== options.end?.gitHead) {
    reasons.push("git HEAD changed during the run");
  }
  const localStability = compareEvidenceFileSnapshots(
    options.start?.localIdentity,
    options.end?.localIdentity,
  );
  reasons.push(...localStability.reasons);
  const servedEntryIdentity = validateServedEntryIdentities({
    entries: options.sessions
      .map((session) => session.servedEntry)
      .filter(Boolean),
    expectedLabels: [...C12_29_S4_RENDERERS],
    localEntry: options.start?.localIdentity?.buildEntry,
  });
  reasons.push(...servedEntryIdentity.reasons);

  const localEntry = options.start?.localIdentity?.buildEntry;
  for (const session of options.sessions) {
    const runtime = session.runtimeImportIdentity;
    const runtimeExact =
      runtime?.ok === true &&
      runtime.status === 200 &&
      runtime.byteLength === localEntry?.byteLength &&
      runtime.sha256 === localEntry?.sha256 &&
      runtime.importedModule === true;
    if (!runtimeExact) {
      reasons.push(
        `${session.requestedRenderer}: runtime import bytes differ from the local build entry`,
      );
    }

    const servedRoutes = Array.isArray(session.servedViewerRoutes)
      ? session.servedViewerRoutes
      : [];
    const runtimeRoutes = Array.isArray(
      session.runtimeViewerRouteIdentity?.fetches,
    )
      ? session.runtimeViewerRouteIdentity.fetches
      : [];
    const expectedRoutes = Object.keys(viewerRoutes).sort();
    const requiredExecutionRoutes = [...viewerRequiredExecutionRoutes].sort();
    const executedRoutes = [
      ...(session.runtimeViewerRouteIdentity?.executedRoutes ?? []),
    ].sort();
    const unregisteredExecutedRoutes = [
      ...(session.runtimeViewerRouteIdentity?.unregisteredExecutedRoutes ?? []),
    ].sort();
    const sameOriginResourceLedger = Array.isArray(
      session.runtimeViewerRouteIdentity?.sameOriginResourceLedger,
    )
      ? session.runtimeViewerRouteIdentity.sameOriginResourceLedger
      : [];
    const executionLedger = Array.isArray(
      session.runtimeViewerRouteIdentity?.executionLedger,
    )
      ? session.runtimeViewerRouteIdentity.executionLedger
      : [];
    const supportResourceLedger = Array.isArray(
      session.runtimeViewerRouteIdentity?.supportResourceLedger,
    )
      ? session.runtimeViewerRouteIdentity.supportResourceLedger
      : [];
    const partitionedExecutionLedger = sameOriginResourceLedger.filter(
      (entry) => expectedRoutes.includes(entry?.route),
    );
    const partitionedSupportLedger = sameOriginResourceLedger.filter(
      (entry) => !expectedRoutes.includes(entry?.route),
    );
    const derivedUnregisteredRoutes = [
      ...new Set(
        supportResourceLedger
          .filter((entry) => !isKnownS4SupportResource(entry))
          .map((entry) => entry?.route),
      ),
    ].sort();
    const ledgerCounts = Object.fromEntries(
      expectedRoutes.map((route) => [
        route,
        executionLedger.filter((entry) => entry?.route === route).length,
      ]),
    );
    const routeIdentities = [];
    const closureReasons = [];
    if (
      session.runtimeViewerRouteIdentity?.documentPath !== viewerPath ||
      session.runtimeViewerRouteIdentity?.executedBeforeExplicitFetch !==
        true ||
      JSON.stringify(
        [
          ...(session.runtimeViewerRouteIdentity?.requiredExecutionRoutes ??
            []),
        ].sort(),
      ) !== JSON.stringify(requiredExecutionRoutes) ||
      !requiredExecutionRoutes.every((route) =>
        executedRoutes.includes(route),
      ) ||
      !executedRoutes.every((route) => expectedRoutes.includes(route)) ||
      JSON.stringify(executedRoutes) !==
        JSON.stringify(
          [...new Set(executionLedger.map((entry) => entry?.route))].sort(),
        ) ||
      unregisteredExecutedRoutes.length !== 0 ||
      JSON.stringify(unregisteredExecutedRoutes) !==
        JSON.stringify(derivedUnregisteredRoutes)
    ) {
      closureReasons.push(
        "executed Viewer/CSS/import closure is incomplete, fetched-only, or contains an unregistered runtime route",
      );
    }
    if (
      executionLedger.length === 0 ||
      sameOriginResourceLedger.length === 0 ||
      !sameS4ResourceLedger(partitionedExecutionLedger, executionLedger) ||
      !sameS4ResourceLedger(partitionedSupportLedger, supportResourceLedger) ||
      !sameOriginResourceLedger.every(
        (entry) =>
          typeof entry?.route === "string" &&
          entry.route.startsWith("/") &&
          typeof entry?.resourceType === "string" &&
          entry.resourceType.length > 0 &&
          entry.sameOrigin === true,
      ) ||
      !executionLedger.every(
        (entry) =>
          expectedRoutes.includes(entry?.route) &&
          typeof entry?.resourceType === "string" &&
          entry.resourceType.length > 0 &&
          entry.sameOrigin === true,
      ) ||
      !supportResourceLedger.every(
        (entry) =>
          !expectedRoutes.includes(entry?.route) &&
          isKnownS4SupportResource(entry),
      ) ||
      !requiredExecutionRoutes.every(
        (route) =>
          session.runtimeViewerRouteIdentity?.executedRouteCounts?.[route] ===
            1 && ledgerCounts[route] === 1,
      )
    ) {
      closureReasons.push(
        "same-origin execution ledger is malformed or required routes are not uniquely executed",
      );
    }
    for (const route of expectedRoutes) {
      const local =
        options.start?.localIdentity?.[viewerRouteEvidenceKeys[route]];
      const served = servedRoutes.filter((entry) => entry.route === route);
      const runtimeFetch = runtimeRoutes.filter(
        (entry) => entry.route === route,
      );
      let servedUrlExact;
      try {
        const servedUrl = new URL(served[0]?.url);
        servedUrlExact =
          servedUrl.origin === session.transport?.origin &&
          servedUrl.pathname === route &&
          servedUrl.search === "" &&
          servedUrl.hash === "" &&
          servedUrl.username === "" &&
          servedUrl.password === "";
      } catch {
        servedUrlExact = false;
      }
      routeIdentities.push({
        route,
        local,
        served: served[0] ?? null,
        runtime: runtimeFetch[0] ?? null,
      });
      const routeExact =
        served.length === 1 &&
        servedUrlExact &&
        runtimeFetch.length === 1 &&
        local?.exists === true &&
        served[0].ok === true &&
        served[0].status === 200 &&
        served[0].byteLength === local.byteLength &&
        served[0].sha256 === local.sha256 &&
        runtimeFetch[0].ok === true &&
        runtimeFetch[0].status === 200 &&
        runtimeFetch[0].byteLength === local.byteLength &&
        runtimeFetch[0].sha256 === local.sha256;
      if (!routeExact) {
        closureReasons.push(
          `local/served/runtime route ${route} is absent, duplicated, or not exact`,
        );
      }
    }
    const viewerClosure = {
      expectedRoutes,
      requiredExecutionRoutes,
      conditionalRoutes: expectedRoutes.filter(
        (route) => !requiredExecutionRoutes.includes(route),
      ),
      executedBeforeExplicitFetch:
        session.runtimeViewerRouteIdentity?.executedBeforeExplicitFetch ===
        true,
      sameOriginResourceLedger,
      executionLedger,
      supportResourceLedger,
      executedRoutes,
      fetchedRoutes: runtimeRoutes.map((entry) => entry.route).sort(),
      servedRoutes: servedRoutes.map((entry) => entry.route).sort(),
      unregisteredExecutedRoutes,
      routeIdentities,
      ok: closureReasons.length === 0,
      reasons: closureReasons,
    };
    session.runtimeIdentity = {
      ok: runtimeExact && viewerClosure.ok,
      localEntry,
      servedEntry: session.servedEntry,
      runtimeImport: runtime,
      viewerClosure,
    };
    if (closureReasons.length > 0) {
      reasons.push(
        ...closureReasons.map(
          (reason) => `${session.requestedRenderer}: ${reason}`,
        ),
      );
    }
  }
  if (
    !sameEvidenceFingerprint(options.firstRedAtStart, options.firstRedAtEnd)
  ) {
    reasons.push("write-once first-red artifact changed during the run");
  }
  return {
    ok: reasons.length === 0,
    reasons,
    localStability,
    servedEntryIdentity,
  };
}

function viewerUrl(renderer) {
  const url = new URL(viewerPath, base);
  url.searchParams.set("renderer", renderer);
  url.searchParams.set("offline", "true");
  return url.href;
}

function sRgbToLinear(code) {
  const value = code / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

const linearTable = Object.freeze(
  Array.from({ length: 256 }, (_, code) => sRgbToLinear(code)),
);

async function analyzePngDataUrl(dataUrl) {
  if (
    typeof dataUrl !== "string" ||
    !dataUrl.startsWith("data:image/png;base64,")
  ) {
    throw new Error("same-task capture did not return a PNG data URL");
  }
  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  const { data, info } = await sharp(bytes)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = [0, 0, 0];
  const maxCodeByChannel = [0, 0, 0];
  const aboveFloorPixelsByChannel = [0, 0, 0];
  let maxCode = 0;
  let minimumAlphaCode = 255;
  let maximumAlphaCode = 0;
  let nonBlackPixels = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    let nonBlack = false;
    for (let channel = 0; channel < 3; channel++) {
      const code = data[index + channel];
      rgb[channel] += linearTable[code];
      maxCodeByChannel[channel] = Math.max(maxCodeByChannel[channel], code);
      aboveFloorPixelsByChannel[channel] += Number(code > 1);
      maxCode = Math.max(maxCode, code);
      nonBlack ||= code > 1;
    }
    const alpha = data[index + 3];
    minimumAlphaCode = Math.min(minimumAlphaCode, alpha);
    maximumAlphaCode = Math.max(maximumAlphaCode, alpha);
    nonBlackPixels += Number(nonBlack);
  }
  return {
    bytes,
    image: {
      width: info.width,
      height: info.height,
      pngByteLength: bytes.byteLength,
      pngSha256: sha256(bytes),
      nonBlackPixels,
      maxCode,
      maxCodeByChannel,
      aboveFloorPixelsByChannel,
      minimumAlphaCode,
      maximumAlphaCode,
      linearEnergy: {
        rgb,
        luminance: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2],
      },
    },
  };
}

async function decodeSessionCaptures(session, paths) {
  for (const sample of session.neutral.samples) {
    const decoded = await analyzePngDataUrl(sample.pngDataUrl);
    sample.image = decoded.image;
    delete sample.pngDataUrl;
  }
  for (const hiddenControl of session.neutral.hiddenControls) {
    const hidden = await analyzePngDataUrl(hiddenControl.pngDataUrl);
    hiddenControl.image = hidden.image;
    delete hiddenControl.pngDataUrl;
  }

  for (const capture of session.normal.captures) {
    const decoded = await analyzePngDataUrl(capture.pngDataUrl);
    const imagePath = paths.image(
      session.requestedRenderer,
      capture.targetTangentHeightKm,
    );
    createImmutableEvidence(imagePath, decoded.bytes);
    capture.image = {
      ...decoded.image,
      immutableFile: fingerprintEvidenceFile(imagePath),
    };
    delete capture.pngDataUrl;
  }
}

async function runBackend(
  browser,
  requestedRenderer,
  paths,
  diagnosticSink,
  routeFetchNonce,
) {
  const baseIdentity = validateS4LoopbackBase(base);
  const baseOrigin = baseIdentity.origin;
  const externalRequests = [];
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const httpErrors = [];
  Object.assign(diagnosticSink, {
    requestedRenderer,
    phase: "context-setup",
    servedRoutePhaseStarted: false,
    runtimeRouteFailure: null,
    consoleErrors,
    pageErrors,
    externalRequests,
    failedRequests,
    httpErrors,
  });
  const context = await browser.newContext({ viewport });
  await context.route("**/*", async (route) => {
    let url;
    try {
      url = new URL(route.request().url());
    } catch {
      await route.continue();
      return;
    }
    if (
      /^https?:$/u.test(url.protocol) &&
      (url.origin !== baseOrigin || url.username !== "" || url.password !== "")
    ) {
      externalRequests.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on("response", (response) => {
    let url;
    try {
      url = new URL(response.url());
    } catch {
      return;
    }
    if (response.status() >= 400 && url.pathname !== "/favicon.ico") {
      httpErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  page.on("request", (request) => {
    try {
      const url = new URL(request.url());
      if (/^https?:$/u.test(url.protocol) && url.origin !== baseOrigin) {
        if (!externalRequests.includes(request.url())) {
          externalRequests.push(request.url());
        }
      }
    } catch {
      // Non-URL browser-internal requests do not cross the evidence origin.
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(
      `${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`,
    );
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text().slice(0, 500));
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(String(error?.stack ?? error).slice(0, 1000));
  });

  try {
    await page.goto(viewerUrl(requestedRenderer), {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
    await page.waitForFunction(
      () => Boolean(window.viewer?.scene?.context),
      null,
      { timeout: 90_000 },
    );

    diagnosticSink.phase = "page-runtime-route-identity";
    const runtimeViewerRouteIdentity = await boundedPromise(
      page.evaluate(captureS4PageRuntimeViewerRoutes, {
        viewerRoutePaths: Object.keys(viewerRoutes),
        requiredViewerRoutePaths: [...viewerRequiredExecutionRoutes],
        requestedRenderer,
        routeFetchNonce,
      }),
      90_000,
      `${requestedRenderer} page runtime-route identities`,
    );

    diagnosticSink.phase = "measurement";
    const measured = await boundedPromise(
      page.evaluate(
        async ({
          captureMethod,
          hiddenAnchorsKm,
          normalAnchorsKm,
          offsetsSeconds,
          neutralScene,
          pinnedIso,
          requestedRenderer,
          runtimePath,
          runtimeViewerRouteIdentity,
          viewerPath,
        }) => {
          const C = await import(runtimePath);
          const runtimeEntry = runtimeViewerRouteIdentity.fetches.find(
            (entry) => entry.route === runtimePath,
          );
          const runtimeImportIdentity = {
            ...runtimeEntry,
            importedModule:
              typeof C.Cartesian3 === "function" &&
              typeof C.JulianDate === "function",
          };
          const viewer = window.viewer;
          const scene = viewer.scene;
          const device = scene.context.device ?? scene.context._device;
          const uncapturedErrors = [];
          const deviceLossEvents = [];
          const graphicsCompletion = {
            backend: requestedRenderer,
            queueFenceAttempted: false,
            queueFenceCompleted: false,
            queueFenceError: null,
            errorScopes: [],
            deviceErrorListenerArmed: false,
            deviceLossListenerArmed: false,
            uncapturedErrors,
            deviceLossEvents,
            lateEventTurns: 0,
            finishAttempted: false,
            finishCompleted: false,
            finishError: null,
            getErrorDrained: false,
            getErrorCalls: 0,
            terminalErrorCode: null,
            nonZeroErrorCodes: [],
          };
          if (device) {
            for (const filter of ["validation", "internal", "out-of-memory"]) {
              device.pushErrorScope(filter);
            }
            device.addEventListener?.("uncapturederror", (event) => {
              uncapturedErrors.push(
                `uncapturederror: ${event?.error?.message ?? String(event?.error)}`,
              );
            });
            graphicsCompletion.deviceErrorListenerArmed = true;
            void device.lost.then((info) => {
              deviceLossEvents.push(
                `device-lost: ${info?.reason ?? "unknown"}: ${info?.message ?? ""}`,
              );
            });
            graphicsCompletion.deviceLossListenerArmed = true;
          }

          viewer.useDefaultRenderLoop = false;
          viewer.clock.shouldAnimate = false;
          scene.requestRenderMode = false;
          if (scene.mode !== C.SceneMode.SCENE3D) {
            scene.morphTo3D(0);
          }
          scene.highDynamicRange = false;
          scene.sunBloom = false;
          scene.taaEnabled = false;
          scene.motionBlur = false;
          scene.msaaSamples = 1;
          if (scene.postProcessStages?.fxaa) {
            scene.postProcessStages.fxaa.enabled = false;
          }
          if (scene.postProcessStages?.bloom) {
            scene.postProcessStages.bloom.enabled = false;
          }
          if (scene.postProcessStages?.ambientOcclusion) {
            scene.postProcessStages.ambientOcclusion.enabled = false;
          }
          for (let index = 0; index < scene.postProcessStages.length; index++) {
            scene.postProcessStages.get(index).enabled = false;
          }
          if (scene.globe?.atmosphericConditions?.lighting) {
            scene.globe.atmosphericConditions.lighting.enableEclipse = false;
          }
          scene.moon.show = false;

          const baseTime = C.JulianDate.fromIso8601(pinnedIso);
          await C.Transforms.preloadIcrfFixed(
            new C.TimeInterval({
              start: C.JulianDate.addSeconds(
                baseTime,
                offsetsSeconds[0] - 5,
                new C.JulianDate(),
              ),
              stop: C.JulianDate.addSeconds(
                baseTime,
                offsetsSeconds.at(-1) + 5,
                new C.JulianDate(),
              ),
            }),
          );

          const ellipsoid = scene.globe.ellipsoid;
          const earthRadius = ellipsoid.maximumRadius;
          const orbitRadius = earthRadius + 400_000;
          const shellHeight = 111_000;
          const gravitationalParameter = 3.986004418e14;
          const meanMotion = Math.sqrt(
            gravitationalParameter / orbitRadius ** 3,
          );
          const shellAngle =
            Math.PI - Math.asin((earthRadius + shellHeight) / orbitRadius);

          const bodyScratch = new C.Cartesian3();
          const rotationScratch = new C.Matrix3();
          const sunFixedAt = (time) => {
            const sunIcrf =
              C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
                time,
                bodyScratch,
              );
            let rotation = C.Transforms.computeIcrfToFixedMatrix(
              time,
              rotationScratch,
            );
            if (!rotation) {
              rotation = C.Transforms.computeTemeToPseudoFixedMatrix(
                time,
                rotationScratch,
              );
            }
            return C.Matrix3.multiplyByVector(
              rotation,
              sunIcrf,
              new C.Cartesian3(),
            );
          };

          let registeredSunDirection;
          let registeredTangentAxis;
          let registeredUpAxis;
          const setOrbitalFrame = (offsetSeconds) => {
            const time = C.JulianDate.addSeconds(
              baseTime,
              offsetSeconds,
              new C.JulianDate(),
            );
            viewer.clock.currentTime = C.JulianDate.clone(time);
            const sun = sunFixedAt(time);
            const liveSunDirection = C.Cartesian3.normalize(
              sun,
              new C.Cartesian3(),
            );
            if (!registeredSunDirection) {
              if (offsetSeconds !== 0) {
                throw new Error("S4 orbital basis must be frozen at epoch");
              }
              registeredSunDirection = C.Cartesian3.clone(liveSunDirection);
              const reference =
                Math.abs(registeredSunDirection.z) < 0.9
                  ? C.Cartesian3.UNIT_Z
                  : C.Cartesian3.UNIT_Y;
              registeredTangentAxis = C.Cartesian3.normalize(
                C.Cartesian3.cross(
                  reference,
                  registeredSunDirection,
                  new C.Cartesian3(),
                ),
                new C.Cartesian3(),
              );
              registeredUpAxis = C.Cartesian3.normalize(
                C.Cartesian3.cross(
                  registeredSunDirection,
                  registeredTangentAxis,
                  new C.Cartesian3(),
                ),
                new C.Cartesian3(),
              );
            }
            // Sunrise: as time advances, the ray's tangent radius increases.
            const angle = shellAngle - meanMotion * offsetSeconds;
            const cameraPosition = C.Cartesian3.add(
              C.Cartesian3.multiplyByScalar(
                registeredSunDirection,
                orbitRadius * Math.cos(angle),
                new C.Cartesian3(),
              ),
              C.Cartesian3.multiplyByScalar(
                registeredTangentAxis,
                orbitRadius * Math.sin(angle),
                new C.Cartesian3(),
              ),
              new C.Cartesian3(),
            );
            const viewDirection = C.Cartesian3.normalize(
              C.Cartesian3.subtract(sun, cameraPosition, new C.Cartesian3()),
              new C.Cartesian3(),
            );
            scene.camera.frustum.fov = neutralScene.cameraFovRadians;
            scene.camera.setView({
              destination: cameraPosition,
              orientation: { direction: viewDirection, up: registeredUpAxis },
            });
            return { time, sun, cameraPosition };
          };

          const frozenFrame = setOrbitalFrame(0);
          void frozenFrame;
          const vectorArray = (value) => [value.x, value.y, value.z];

          const snapshotNeutralScene = () => ({
            mode: scene.mode,
            globeShown: scene.globe.show,
            skyAtmosphereShown: scene.skyAtmosphere.show,
            skyAtmosphereVisible: scene.frameState.skyAtmosphereVisible,
            atmosphereLightIntensity:
              scene.skyAtmosphere.atmosphereLightIntensity,
            skyBoxShown: scene.skyBox?.show ?? false,
            starFieldShown: scene.skyBox?.starField?.show ?? false,
            moonShown: scene.moon?.show ?? false,
            sunShown: scene.sun.show,
            backgroundRgba: [
              scene.backgroundColor.red,
              scene.backgroundColor.green,
              scene.backgroundColor.blue,
              scene.backgroundColor.alpha,
            ],
            highDynamicRange: scene.highDynamicRange,
            sunBloom: scene.sunBloom,
            taaEnabled: scene.taaEnabled === true,
            motionBlur: scene.motionBlur === true,
            fxaaEnabled: scene.postProcessStages?.fxaa?.enabled === true,
            bloomEnabled: scene.postProcessStages?.bloom?.enabled === true,
            ambientOcclusionEnabled:
              scene.postProcessStages?.ambientOcclusion?.enabled === true,
            allPostProcessStagesDisabled: Array.from(
              { length: scene.postProcessStages?.length ?? 0 },
              (_, index) => scene.postProcessStages.get(index).enabled,
            ).every((enabled) => enabled === false),
            msaaSamples: scene.msaaSamples,
            cameraFovRadians: scene.camera.frustum.fov,
            enableEclipse:
              scene.globe?.atmosphericConditions?.lighting?.enableEclipse,
            canvasWidth: scene.canvas.width,
            canvasHeight: scene.canvas.height,
          });

          const tangentHeight = (cameraPosition, sun) => {
            const ray = C.Cartesian3.normalize(
              C.Cartesian3.subtract(sun, cameraPosition, new C.Cartesian3()),
              new C.Cartesian3(),
            );
            const along = Math.max(0, -C.Cartesian3.dot(cameraPosition, ray));
            const closest = C.Cartesian3.add(
              cameraPosition,
              C.Cartesian3.multiplyByScalar(ray, along, new C.Cartesian3()),
              new C.Cartesian3(),
            );
            return (C.Cartesian3.magnitude(closest) - earthRadius) / 1000;
          };

          const renderAt = (offsetSeconds, renderCount = 3) => {
            const frame = setOrbitalFrame(offsetSeconds);
            for (let index = 0; index < renderCount; index++) {
              scene.render(frame.time);
            }
            const extinction = scene.frameState.sunAtmosphereExtinction;
            const sourceCamera = scene.camera.positionWC;
            const sourceBody = scene.context.uniformState.sunPositionWC;
            const sourceAtmosphere = scene.atmosphere;
            const result = {
              offsetSeconds,
              orbitPhaseRadians: shellAngle - meanMotion * offsetSeconds,
              tangentHeightKm: tangentHeight(
                scene.camera.positionWC,
                frame.sun,
              ),
              extinction: [extinction.x, extinction.y, extinction.z],
              sunEclipseAlpha: scene.frameState.sunEclipseAlpha,
              sourceInputs: {
                cameraPositionWC: [
                  sourceCamera.x,
                  sourceCamera.y,
                  sourceCamera.z,
                ],
                bodyPositionWC: [sourceBody.x, sourceBody.y, sourceBody.z],
                cameraDirectionWC: vectorArray(scene.camera.directionWC),
                cameraUpWC: vectorArray(scene.camera.upWC),
                timeIso: C.JulianDate.toIso8601(frame.time, 3),
                innerRadius: earthRadius,
                atmosphere: {
                  rayleighCoefficient: [
                    sourceAtmosphere.rayleighCoefficient.x,
                    sourceAtmosphere.rayleighCoefficient.y,
                    sourceAtmosphere.rayleighCoefficient.z,
                  ],
                  mieCoefficient: [
                    sourceAtmosphere.mieCoefficient.x,
                    sourceAtmosphere.mieCoefficient.y,
                    sourceAtmosphere.mieCoefficient.z,
                  ],
                  rayleighScaleHeight: sourceAtmosphere.rayleighScaleHeight,
                  mieScaleHeight: sourceAtmosphere.mieScaleHeight,
                },
              },
              sceneSnapshot: snapshotNeutralScene(),
              // Synchronous and immediately adjacent to the matching render.
              pngDataUrl: scene.canvas.toDataURL("image/png"),
            };
            return result;
          };

          const original = {
            globeShow: scene.globe.show,
            skyShow: scene.skyAtmosphere.show,
            skyIntensity: scene.skyAtmosphere.atmosphereLightIntensity,
            skyBoxShow: scene.skyBox?.show,
            starFieldShow: scene.skyBox?.starField?.show,
            backgroundColor: C.Color.clone(scene.backgroundColor),
            sunShow: scene.sun.show,
          };

          // Blend-neutral metrology: keep skyAtmosphere.show true because that
          // exact visibility state gates Sun.js extinction. Its positive
          // sub-code radiance avoids WebGPU's zero-as-default fallback; every
          // other destination contributor is hidden, and sun-hidden captures
          // prove the result still quantizes black.
          scene.globe.show = false;
          scene.skyAtmosphere.show = true;
          scene.skyAtmosphere.atmosphereLightIntensity =
            neutralScene.atmosphereLightIntensity;
          if (scene.skyBox) {
            scene.skyBox.show = false;
            if (scene.skyBox.starField) {
              scene.skyBox.starField.show = false;
            }
          }
          scene.backgroundColor = C.Color.BLACK;
          scene.sun.show = true;

          // WebGPU's central pipeline cache resolves the Sun render pipeline
          // asynchronously. Render and yield until the environment command
          // proves that exact pipeline has become executable; the scored
          // sweep below remains synchronous render-to-capture per sample.
          const sunPipelineReadiness = {
            renderer: requestedRenderer,
            status: requestedRenderer === "webgpu" ? "PENDING" : "N/A",
            prewarmOffsetSeconds:
              requestedRenderer === "webgpu" ? offsetsSeconds.at(-1) : null,
            attemptedFrames: 0,
            yieldedTurns: 0,
            commandReady: requestedRenderer === "webgpu" ? false : null,
            pipelineReady: requestedRenderer === "webgpu" ? false : null,
            ownerExact: requestedRenderer === "webgpu" ? false : null,
            vertexCount: requestedRenderer === "webgpu" ? null : null,
          };
          if (requestedRenderer === "webgpu") {
            const prewarmFrame = setOrbitalFrame(offsetsSeconds.at(-1));
            while (sunPipelineReadiness.attemptedFrames < 36) {
              scene.render(prewarmFrame.time);
              sunPipelineReadiness.attemptedFrames++;
              const sunCommand = scene.environmentState.sunDrawCommand;
              sunPipelineReadiness.commandReady = Boolean(sunCommand);
              sunPipelineReadiness.pipelineReady = Boolean(
                sunCommand?.pipeline,
              );
              sunPipelineReadiness.ownerExact = sunCommand?.owner === scene.sun;
              sunPipelineReadiness.vertexCount = Number.isInteger(
                sunCommand?.vertexCount,
              )
                ? sunCommand.vertexCount
                : null;
              if (
                sunPipelineReadiness.commandReady &&
                sunPipelineReadiness.pipelineReady &&
                sunPipelineReadiness.ownerExact &&
                sunPipelineReadiness.vertexCount === 6 &&
                sunPipelineReadiness.yieldedTurns >= 1
              ) {
                sunPipelineReadiness.status = "READY";
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 0));
              sunPipelineReadiness.yieldedTurns++;
            }
          }
          const neutralSamples = offsetsSeconds.map((offset) =>
            renderAt(offset),
          );
          const nearest = (target) =>
            neutralSamples.reduce((best, sample) =>
              Math.abs(sample.tangentHeightKm - target) <
              Math.abs(best.tangentHeightKm - target)
                ? sample
                : best,
            );
          scene.sun.show = false;
          const hiddenControls = hiddenAnchorsKm.map((anchor) => {
            const target = nearest(anchor === "clear" ? 115 : anchor);
            const frame = renderAt(target.offsetSeconds);
            return {
              targetTangentHeightKm: anchor,
              offsetSeconds: frame.offsetSeconds,
              tangentHeightKm: frame.tangentHeightKm,
              captureMethod,
              sceneSnapshot: frame.sceneSnapshot,
              pngDataUrl: frame.pngDataUrl,
            };
          });
          scene.sun.show = true;

          // Restore a normal scene and capture the closest physical sample to
          // each pre-registered height. These PNGs are review evidence; all
          // quantitative parity uses the blend-neutral lane above.
          scene.globe.show = original.globeShow;
          scene.skyAtmosphere.show = original.skyShow;
          scene.skyAtmosphere.atmosphereLightIntensity = original.skyIntensity;
          if (scene.skyBox) {
            scene.skyBox.show = original.skyBoxShow;
            if (scene.skyBox.starField) {
              scene.skyBox.starField.show = original.starFieldShow;
            }
          }
          scene.backgroundColor = original.backgroundColor;
          scene.sun.show = original.sunShow;

          const captureSettledNormalFrame = async (frame) => {
            let settledFrames = 0;
            while (settledFrames < 36) {
              scene.render(frame.time);
              settledFrames++;
              const tilesLoaded = scene.globe.tilesLoaded;
              if ((settledFrames >= 8 && tilesLoaded) || settledFrames === 36) {
                // S4_TERMINAL_NORMAL_CAPTURE_START
                const pngDataUrl = scene.canvas.toDataURL("image/png");
                // S4_TERMINAL_NORMAL_CAPTURE_END
                return { pngDataUrl, settledFrames, tilesLoaded };
              }
              // Allow promise-backed EllipsoidTerrainProvider work to settle
              // between nonterminal renders only.
              await new Promise((resolve) => setTimeout(resolve, 0));
            }
            throw new Error("S4 normal settle loop exhausted unexpectedly");
          };

          const normalCaptures = [];
          for (const targetTangentHeightKm of normalAnchorsKm) {
            const target = nearest(targetTangentHeightKm);
            const frame = setOrbitalFrame(target.offsetSeconds);
            const settled = await captureSettledNormalFrame(frame);
            const extinction = scene.frameState.sunAtmosphereExtinction;
            normalCaptures.push({
              targetTangentHeightKm,
              offsetSeconds: target.offsetSeconds,
              tangentHeightKm: tangentHeight(
                scene.camera.positionWC,
                frame.sun,
              ),
              extinction: [extinction.x, extinction.y, extinction.z],
              tilesLoaded: settled.tilesLoaded,
              settledFrames: settled.settledFrames,
              // Captured in the terminal render task; decoding happens later.
              pngDataUrl: settled.pngDataUrl,
            });
          }

          // Drain every submitted capture before snapshotting asynchronous GPU
          // error lanes. The event-turn yield lets uncapturederror/device-loss
          // handlers run after the queue fence but before structured cloning.
          if (device?.queue?.onSubmittedWorkDone) {
            graphicsCompletion.queueFenceAttempted = true;
            try {
              await device.queue.onSubmittedWorkDone();
              graphicsCompletion.queueFenceCompleted = true;
            } catch (error) {
              graphicsCompletion.queueFenceError =
                error?.message ?? String(error);
            }
            for (const filter of ["out-of-memory", "internal", "validation"]) {
              try {
                const error = await device.popErrorScope();
                graphicsCompletion.errorScopes.push({
                  filter,
                  popped: true,
                  error: error ? (error.message ?? String(error)) : null,
                });
              } catch (error) {
                graphicsCompletion.errorScopes.push({
                  filter,
                  popped: false,
                  error: error?.message ?? String(error),
                });
              }
            }
          } else {
            const gl = scene.context._gl;
            graphicsCompletion.finishAttempted = true;
            try {
              gl.finish();
              graphicsCompletion.finishCompleted = true;
            } catch (error) {
              graphicsCompletion.finishError = error?.message ?? String(error);
            }
            let errorCode;
            for (let index = 0; index < 64; index++) {
              errorCode = gl.getError();
              graphicsCompletion.getErrorCalls++;
              if (errorCode === gl.NO_ERROR) {
                graphicsCompletion.getErrorDrained = true;
                break;
              }
              graphicsCompletion.nonZeroErrorCodes.push(errorCode);
            }
            graphicsCompletion.terminalErrorCode = errorCode ?? null;
          }
          for (let turn = 0; turn < 2; turn++) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            graphicsCompletion.lateEventTurns++;
          }

          const graphicsContext = scene.context;
          const adapterInfo = graphicsContext.adapter?.info
            ? {
                vendor: graphicsContext.adapter.info.vendor || "",
                architecture: graphicsContext.adapter.info.architecture || "",
                device: graphicsContext.adapter.info.device || "",
                description: graphicsContext.adapter.info.description || "",
                subgroupMinSize: graphicsContext.adapter.info.subgroupMinSize,
                subgroupMaxSize: graphicsContext.adapter.info.subgroupMaxSize,
              }
            : null;
          const rendererString =
            typeof graphicsContext.getRendererString === "function"
              ? graphicsContext.getRendererString()
              : "";
          return {
            requestedRenderer,
            actualRenderer: scene.context.rendererType,
            runtimeImportIdentity,
            runtimeViewerRouteIdentity,
            gpuProvenance: {
              backend: scene.context.rendererType,
              rendererString,
              adapterInfo,
            },
            graphicsCompletion,
            sunPipelineReadiness,
            deviceErrors: [...uncapturedErrors, ...deviceLossEvents],
            neutral: {
              captureMethod,
              sceneContract: {
                epochIso: pinnedIso,
                innerRadiusMeters: earthRadius,
                orbitAltitudeMeters: 400_000,
                atmosphereShellMeters: shellHeight,
                gravitationalParameter,
                durationSeconds: offsetsSeconds.at(-1) - offsetsSeconds[0],
                stepSeconds: 1,
                ...neutralSamples[0].sceneSnapshot,
                orbitBasis: {
                  sunDirectionWC: vectorArray(registeredSunDirection),
                  tangentAxisWC: vectorArray(registeredTangentAxis),
                  upAxisWC: vectorArray(registeredUpAxis),
                },
              },
              samples: neutralSamples,
              hiddenControls,
            },
            normal: {
              captureMethod,
              sceneContract: {
                globeShown: original.globeShow,
                skyAtmosphereShown: original.skyShow,
                atmosphereLightIntensity: original.skyIntensity,
                hdr: false,
                sunBloom: false,
                msaaSamples: 1,
              },
              captures: normalCaptures,
            },
          };
        },
        {
          captureMethod: C12_29_S4_CAPTURE_METHOD,
          hiddenAnchorsKm: [...C12_29_S4_HIDDEN_ANCHORS_KM],
          normalAnchorsKm: [...C12_29_S4_NORMAL_ANCHORS_KM],
          offsetsSeconds: [...C12_29_S4_SAMPLE_OFFSETS_SECONDS],
          neutralScene: structuredClone(C12_29_S4_NEUTRAL_SCENE),
          pinnedIso,
          requestedRenderer,
          runtimePath,
          runtimeViewerRouteIdentity,
          viewerPath,
        },
      ),
      PAGE_RUN_TIMEOUT_MS,
      `${requestedRenderer} S4 browser session`,
    );
    diagnosticSink.phase = "served-route-identity";
    diagnosticSink.servedRoutePhaseStarted = true;
    const servedViewerRoutes = await boundedPromise(
      captureS4ServedViewerRoutes({
        requestContext: context.request,
        routes: Object.keys(viewerRoutes),
        baseOrigin,
        sessionLabel: requestedRenderer,
      }),
      30_000,
      `${requestedRenderer} served Viewer route identities`,
    );
    const servedEntry = servedViewerRoutes.find(
      (entry) => entry.route === runtimePath,
    );
    const session = {
      ...measured,
      transport: {
        loopbackBaseAccepted: true,
        credentialFreeBase: true,
        sameOriginOnly: externalRequests.length === 0,
        origin: baseIdentity.origin,
        protocol: baseIdentity.protocol,
        hostname: baseIdentity.hostname,
      },
      servedEntry,
      servedViewerRoutes,
      consoleErrors,
      pageErrors,
      externalRequests,
      failedRequests,
      httpErrors,
    };
    diagnosticSink.phase = "capture-decode";
    await decodeSessionCaptures(session, paths);
    diagnosticSink.phase = "complete";
    return session;
  } catch (error) {
    diagnosticSink.runtimeRouteFailure ??=
      parseS4RuntimeRouteFetchFailure(error);
    diagnosticSink.error = String(error?.stack ?? error);
    if (!diagnosticSink.phase.endsWith("-error")) {
      diagnosticSink.phase = `${diagnosticSink.phase}-error`;
    }
    throw error;
  } finally {
    await context.close();
  }
}

export async function withS4Watchdog(
  task,
  browserControl,
  watchdogMs = WATCHDOG_MS,
  drainGraceMs = TASK_DRAIN_GRACE_MS,
) {
  if (
    !Number.isFinite(watchdogMs) ||
    watchdogMs <= 0 ||
    !Number.isFinite(drainGraceMs) ||
    drainGraceMs <= 0
  ) {
    throw new Error("S4 watchdog and drain-grace durations must be positive");
  }
  const observed = Promise.resolve(task).then(
    (value) => ({ kind: "fulfilled", value }),
    (error) => ({ kind: "rejected", error }),
  );
  let timer;
  try {
    const winner = await Promise.race([
      observed,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "watchdog" }), watchdogMs);
      }),
    ]);
    if (winner.kind === "fulfilled") {
      browserControl.taskDrained = true;
      return winner.value;
    }
    if (winner.kind === "rejected") {
      browserControl.taskDrained = true;
      throw winner.error;
    }

    browserControl.watchdogTimedOut = true;
    browserControl.abortController.abort(
      new Error(`S4 WATCHDOG exceeded ${watchdogMs} ms`),
    );
    if (browserControl.browser) {
      browserControl.watchdogCloseAttempted = true;
      try {
        await boundedPromise(
          browserControl.browser.close(),
          drainGraceMs,
          "S4 watchdog browser close",
        );
        browserControl.browser = null;
        browserControl.browserClosed = true;
        browserControl.watchdogBrowserClosed = true;
      } catch (error) {
        browserControl.cleanupErrors.push(error?.message ?? String(error));
      }
    }

    // Browser closure aborts page work. Drain that losing task before an ERROR
    // artifact can replace RUNNING, so no late task can mutate frozen evidence.
    const drained = await Promise.race([
      observed,
      new Promise((resolve) => {
        setTimeout(() => resolve({ kind: "undrained" }), drainGraceMs);
      }),
    ]);
    if (drained.kind === "undrained") {
      browserControl.taskDrained = false;
      browserControl.undrained = true;
      const error = new Error(
        `S4 WATCHDOG exceeded ${watchdogMs} ms and task did not drain within ${drainGraceMs} ms; authoritative RUNNING retained`,
      );
      error.code = "S4_WATCHDOG_UNDRAINED";
      throw error;
    }
    browserControl.taskDrained = true;
    const detail =
      drained.kind === "rejected"
        ? `; drained task error: ${drained.error?.message ?? String(drained.error)}`
        : "; drained task after timeout";
    throw new Error(`S4 WATCHDOG exceeded ${watchdogMs} ms${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function runC1229S4Probe(options = {}) {
  const runId = options.runId ?? randomUUID();
  const paths = createS4ArtifactPaths(
    options.outputDirectory ?? outputDirectory,
    runId,
  );
  const launchBrowser =
    options.launchBrowser ?? ((launch) => chromium.launch(launch));
  const watchdogMs = options.watchdogMs ?? WATCHDOG_MS;
  const operations = options.operations ?? fs;
  const startedAt = new Date().toISOString();
  fs.mkdirSync(paths.directory, { recursive: true });
  const provisionalMarker = {
    schema: C12_29_S4_SCHEMA,
    campaign: S4_CAMPAIGN,
    probe: S4_PROBE,
    runId,
    status: "RUNNING",
    incomplete: true,
    startedAt,
    authority: "exclusive-lock",
    phase: "ACQUIRING",
    supersedesLatest: null,
  };
  acquireS4RunLock(paths, provisionalMarker, operations);

  let priorLatest;
  try {
    priorLatest = inspectS4PriorLatest(paths.latest, operations);
  } catch (error) {
    // A verified prior RUNNING marker is a manual-investigation stop. Preserve
    // that canonical marker; only release the lock acquired by this attempt.
    try {
      releaseS4RunLock(paths, provisionalMarker, operations);
    } catch (releaseError) {
      throw new AggregateError(
        [error, releaseError],
        "prior RUNNING rejection and S4 lock release both failed",
        { cause: releaseError },
      );
    }
    throw error;
  }
  const previousLatest = priorLatest.fingerprint;
  const runningMarker = {
    schema: C12_29_S4_SCHEMA,
    campaign: S4_CAMPAIGN,
    probe: S4_PROBE,
    runId,
    status: "RUNNING",
    incomplete: true,
    startedAt,
    base,
    pinnedIso,
    browserLaunch,
    paths: {
      immutableRun: paths.run,
      firstRed: paths.firstRed,
    },
    authority: "exclusive-lock",
    phase: "MEASURING",
    supersedesLatest: previousLatest,
  };
  replaceOwnedS4RunLock(paths, runningMarker, operations);
  // If this canonical replacement fails, the complete lock remains the
  // authoritative incomplete state and the prior PASS cannot be trusted.
  publishS4Running(paths, runningMarker, operations);

  const browserControl = {
    abortController: new AbortController(),
    browser: null,
    browserAcquired: false,
    browserClosed: false,
    cleanupErrors: [],
    // Preflight has no asynchronous browser task to drain. This flips false
    // immediately before measurement and may return true only through the
    // cooperative watchdog's observed-task settlement path.
    taskDrained: true,
    watchdogTimedOut: false,
    watchdogCloseAttempted: false,
    watchdogBrowserClosed: false,
  };
  const sessions = [];
  const backendDiagnostics = [];
  let firstRedAtStart;
  let startProvenance;
  let artifact;
  let undrainedError;
  try {
    validateS4LoopbackBase(base);
    if (priorLatest.error) {
      throw new Error(priorLatest.error);
    }
    firstRedAtStart = fingerprintEvidenceFile(paths.firstRed);
    assertEvidenceReadableOrAbsent(
      firstRedAtStart,
      "prior S4 first-red artifact",
    );

    browserControl.taskDrained = false;
    const measurement = await withS4Watchdog(
      (async () => {
        startProvenance = await collectS4Provenance();
        browserControl.abortController.signal.throwIfAborted();
        browserControl.browser = await launchBrowser(browserLaunch);
        browserControl.browserAcquired = true;
        for (const renderer of C12_29_S4_RENDERERS) {
          browserControl.abortController.signal.throwIfAborted();
          const diagnostics = { requestedRenderer: renderer };
          backendDiagnostics.push(diagnostics);
          sessions.push(
            await runBackend(
              browserControl.browser,
              renderer,
              paths,
              diagnostics,
              `${runId}-${renderer}-${randomUUID()}`,
            ),
          );
        }
        await browserControl.browser.close();
        browserControl.browser = null;
        browserControl.browserClosed = true;
        browserControl.abortController.signal.throwIfAborted();
        const endProvenance = await collectS4Provenance();
        const firstRedAtEnd = fingerprintEvidenceFile(paths.firstRed);
        assertEvidenceReadableOrAbsent(
          firstRedAtEnd,
          "S4 first-red artifact before finalization",
        );
        return { endProvenance, firstRedAtEnd };
      })(),
      browserControl,
      watchdogMs,
    );

    const provenance = assessS4Provenance({
      start: startProvenance,
      end: measurement.endProvenance,
      sessions,
      firstRedAtStart,
      firstRedAtEnd: measurement.firstRedAtEnd,
    });
    const lifecycle = {
      firstRedAtStart,
      firstRedAtEnd: measurement.firstRedAtEnd,
      firstRedStable: sameEvidenceFingerprint(
        firstRedAtStart,
        measurement.firstRedAtEnd,
      ),
      previousLatest,
    };
    const folded = foldC1229S4Gate({
      schema: C12_29_S4_SCHEMA,
      runId,
      provenance,
      lifecycle,
      sessions,
    });
    artifact = {
      schema: C12_29_S4_SCHEMA,
      campaign: S4_CAMPAIGN,
      probe: S4_PROBE,
      runId,
      status: folded.status,
      incomplete: false,
      exitCode: folded.exitCode,
      startedAt,
      completedAt: new Date().toISOString(),
      base,
      pinnedIso,
      viewport,
      browserLaunch,
      captureMethod: C12_29_S4_CAPTURE_METHOD,
      provenance: {
        start: startProvenance,
        end: measurement.endProvenance,
        assessment: provenance,
      },
      lifecycle,
      cleanup: browserControl,
      sessions,
      verdict: folded,
      pass: folded.pass,
    };
  } catch (error) {
    if (error?.code === "S4_WATCHDOG_UNDRAINED") {
      undrainedError = error;
    } else {
      artifact = {
        schema: C12_29_S4_SCHEMA,
        campaign: S4_CAMPAIGN,
        probe: S4_PROBE,
        runId,
        status: "ERROR",
        incomplete: false,
        exitCode: 2,
        startedAt,
        completedAt: new Date().toISOString(),
        base,
        pinnedIso,
        viewport,
        browserLaunch,
        startProvenance,
        firstRedAtStart,
        sessions,
        backendDiagnostics,
        cleanup: browserControl,
        error: String(error?.stack ?? error),
        pass: false,
      };
    }
  } finally {
    if (browserControl.browser && !undrainedError) {
      try {
        await boundedPromise(
          browserControl.browser.close(),
          TASK_DRAIN_GRACE_MS,
          "S4 final browser cleanup",
        );
        browserControl.browser = null;
        browserControl.browserClosed = true;
      } catch (error) {
        browserControl.cleanupErrors.push(error?.message ?? String(error));
      }
    }
  }

  if (undrainedError) {
    throw undrainedError;
  }

  artifact.cleanup = {
    browserAcquired: browserControl.browserAcquired,
    browserClosed: browserControl.browserClosed,
    errors: browserControl.cleanupErrors,
    taskDrained: browserControl.taskDrained,
    watchdogTimedOut: browserControl.watchdogTimedOut,
    watchdogCloseAttempted: browserControl.watchdogCloseAttempted,
    watchdogBrowserClosed: browserControl.watchdogBrowserClosed,
  };
  const cleanupCertified =
    browserControl.taskDrained === true &&
    browserControl.cleanupErrors.length === 0 &&
    (!browserControl.browserAcquired || browserControl.browserClosed === true);
  if (!cleanupCertified) {
    const error = new Error(
      "S4 browser cleanup is uncertified; authoritative RUNNING retained",
    );
    error.code = "S4_CLEANUP_UNCERTIFIED";
    throw error;
  }
  const publication = finalizeS4Evidence(
    paths,
    artifact,
    runningMarker,
    operations,
  );
  console.log(
    serializeS4Artifact({
      campaign: artifact.campaign,
      runId,
      status: artifact.status,
      exitCode: artifact.exitCode,
      immutableRun: publication.immutableRun,
      latest: publication.latest,
      firstRed: publication.firstRed,
      structuralReasons: artifact.verdict?.structuralReasons ?? [],
      failedPredicates: artifact.verdict?.failedPredicates ?? [],
      error: artifact.error ?? null,
    }).trimEnd(),
  );
  process.exitCode = artifact.exitCode;
  return { artifact, paths, publication };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Last-resort process liveness guard only. The earlier artifact watchdog
  // closes the browser, drains the losing task, and publishes ERROR. This
  // outer grace fires only if the automation library itself cannot drain.
  const watchdog = setTimeout(() => {
    console.error(
      `[probe-c12-29-s4-orbital-sunrise] OUTER WATCHDOG fired after ${WATCHDOG_MS + OUTER_WATCHDOG_GRACE_MS} ms; RUNNING marker retained`,
    );
    process.exit(2);
  }, WATCHDOG_MS + OUTER_WATCHDOG_GRACE_MS);
  watchdog.unref();
  try {
    await runC1229S4Probe();
  } finally {
    clearTimeout(watchdog);
  }
}
