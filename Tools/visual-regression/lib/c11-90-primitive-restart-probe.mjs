// @purpose Shared driver for the C11-90 primitive-restart split harness: probe-base validation, watchdog budget, output/evidence paths, capture helpers.
// @status ACTIVE

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import sharp from "sharp";

export const OUTER_WATCHDOG_GRACE_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

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

const BASE = normalizeProbeBase(
  process.env.PROBE_BASE ?? "http://localhost:8080",
);
const BASE_ORIGIN = new URL(BASE).origin;
const HARNESS_ROUTE =
  "/Tools/visual-regression/c11-90-primitive-restart-harness.html";
const OUTPUT_ROOT = path.resolve(
  "Tools/visual-regression/output/c11-90-primitive-restart",
);
const EVIDENCE_DIR = path.resolve("Tools/visual-regression/output/performance");
const CANONICAL_ARTIFACT = path.join(
  EVIDENCE_DIR,
  "c11-90-primitive-restart-split.json",
);
const FIRST_RED_ARTIFACT = path.join(
  EVIDENCE_DIR,
  "c11-90-primitive-restart-split.first-red.json",
);
const VIEWPORT = Object.freeze({ width: 1000, height: 760 });
const SETTLE_MS = Number(process.env.C11_90_SETTLE_MS ?? 3_000);
export const WATCHDOG_MS = Number(process.env.C11_90_WATCHDOG_MS ?? 240_000);
if (
  !Number.isFinite(WATCHDOG_MS) ||
  WATCHDOG_MS <= 0 ||
  WATCHDOG_MS > MAX_TIMER_MS - OUTER_WATCHDOG_GRACE_MS
) {
  throw new Error(
    "STRUCTURAL: C11_90_WATCHDOG_MS must be a positive, non-clamping timer duration",
  );
}
const BACKENDS = Object.freeze(["webgl", "webgpu"]);

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

export const TOPOLOGY_EXPECTATIONS = Object.freeze({
  "triangle-strips": Object.freeze({
    label: "Triangle Strips",
    primitiveType: 5,
    sourceIndexCount: 98,
    realizedIndexCount: 98,
    webglDrawMode: 5,
    webgpuTopology: "triangle-strip",
    stripIndexFormat: "uint16",
  }),
  "triangle-fans": Object.freeze({
    label: "Triangle Fans",
    primitiveType: 6,
    sourceIndexCount: 98,
    realizedIndexCount: 216,
    webglDrawMode: 6,
    webgpuTopology: "triangle-list",
    stripIndexFormat: null,
  }),
});

const LOCAL_PATHS = Object.freeze({
  demoSource: path.resolve(
    "packages/sandcastle/gallery/khr-mesh-primitive-restart-dev/main.js",
  ),
  servedDemo: path.resolve(
    "Apps/Sandcastle2/gallery/khr-mesh-primitive-restart-dev/main.js",
  ),
  harnessHtml: path.resolve(
    "Tools/visual-regression/c11-90-primitive-restart-harness.html",
  ),
  harnessModule: path.resolve(
    "Tools/visual-regression/c11-90-primitive-restart-harness.mjs",
  ),
  policy: path.resolve(
    "Tools/visual-regression/c11-90-primitive-restart-harness.spec.mjs",
  ),
  probeEntry: path.resolve(
    "Tools/visual-regression/probe-c11-90-primitive-restart-split.mjs",
  ),
  probeImplementation: path.resolve(
    "Tools/visual-regression/lib/c11-90-primitive-restart-probe.mjs",
  ),
  cesiumEntry: path.resolve("Source/Cesium.js"),
  engineBundle: path.resolve("packages/engine/Build/Unminified/index.js"),
  engineWgslBundle: path.resolve(
    "packages/engine/Build/Unminified/index-wgsl.js",
  ),
  widgetsBundle: path.resolve("packages/widgets/Build/Unminified/index.js"),
  stripModel: path.resolve(
    "Apps/SampleData/models/PrimitiveRestart/primitive-restart-triangle-strip.glb",
  ),
  fanModel: path.resolve(
    "Apps/SampleData/models/PrimitiveRestart/primitive-restart-triangle-fan.glb",
  ),
});

const TRACKED_RUNTIME_PATHS = new Map([
  [HARNESS_ROUTE, LOCAL_PATHS.harnessHtml],
  [
    "/Tools/visual-regression/c11-90-primitive-restart-harness.mjs",
    LOCAL_PATHS.harnessModule,
  ],
  ["/Source/Cesium.js", LOCAL_PATHS.cesiumEntry],
  ["/packages/engine/Build/Unminified/index.js", LOCAL_PATHS.engineBundle],
  [
    "/packages/engine/Build/Unminified/index-wgsl.js",
    LOCAL_PATHS.engineWgslBundle,
  ],
  ["/packages/widgets/Build/Unminified/index.js", LOCAL_PATHS.widgetsBundle],
  [
    "/Apps/SampleData/models/PrimitiveRestart/primitive-restart-triangle-strip.glb",
    LOCAL_PATHS.stripModel,
  ],
  [
    "/Apps/SampleData/models/PrimitiveRestart/primitive-restart-triangle-fan.glb",
    LOCAL_PATHS.fanModel,
  ],
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex").toUpperCase();
}

function hashFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    path: path.relative(process.cwd(), filePath).replaceAll("\\", "/"),
    bytes: bytes.length,
    sha256: sha256(bytes),
  };
}

function collectLocalProvenance() {
  return Object.fromEntries(
    Object.entries(LOCAL_PATHS).map(([name, filePath]) => [
      name,
      hashFile(filePath),
    ]),
  );
}

function provenanceStable(start, end) {
  return Object.keys(start).every(
    (name) =>
      start[name]?.bytes === end[name]?.bytes &&
      start[name]?.sha256 === end[name]?.sha256,
  );
}

function redactQueriesInString(value) {
  return value.replace(/\?([^\s#"'<>]*)/g, (_match, query) => {
    if (query.length === 0) return "?";
    const redacted = query
      .split("&")
      .map((field) => {
        if (field.length === 0) return field;
        const equalsIndex = field.indexOf("=");
        const name = equalsIndex === -1 ? field : field.slice(0, equalsIndex);
        return `${name}=[REDACTED]`;
      })
      .join("&");
    return `?${redacted}`;
  });
}

export function redactOutputPayload(value) {
  if (typeof value === "string") {
    return redactQueriesInString(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactOutputPayload);
  }
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
      // Preserve the original write/rename failure; cleanup is best-effort.
    }
  }
}

function createImmutable(filePath, bytes) {
  fs.writeFileSync(filePath, bytes, { flag: "wx" });
}

function firstRedFingerprint() {
  return fs.existsSync(FIRST_RED_ARTIFACT)
    ? { exists: true, ...hashFile(FIRST_RED_ARTIFACT) }
    : {
        exists: false,
        path: path
          .relative(process.cwd(), FIRST_RED_ARTIFACT)
          .replaceAll("\\", "/"),
        bytes: null,
        sha256: null,
      };
}

function preserveFirstRed(bytes) {
  try {
    createImmutable(FIRST_RED_ARTIFACT, bytes);
    return { written: true, ...hashFile(FIRST_RED_ARTIFACT) };
  } catch (error) {
    if (error?.code === "EEXIST") {
      return { written: false, ...hashFile(FIRST_RED_ARTIFACT) };
    }
    throw error;
  }
}

function installRuntimeGate() {
  if (globalThis.__c1190RuntimeGate) return;
  const gate = {
    installed: true,
    requestDeviceCalls: 0,
    armedDevices: 0,
    webglHookedMethods: [],
    gpuPipelineHookedMethods: [],
    webglDrawCalls: [],
    modelPipelineDescriptors: [],
    instrumentationFailures: [],
    gpuErrors: [],
    deviceLosses: [],
    unhandledRejections: [],
    windowErrors: [],
  };
  globalThis.__c1190RuntimeGate = gate;

  function textOf(value) {
    try {
      return value?.message ?? String(value);
    } catch {
      return "<unprintable>";
    }
  }

  gate.resetObservations = () => {
    gate.webglDrawCalls.length = 0;
    gate.modelPipelineDescriptors.length = 0;
  };

  function patchMethod(prototype, name, sink, recorder) {
    if (!prototype || typeof prototype[name] !== "function") return;
    try {
      const original = prototype[name];
      prototype[name] = function (...args) {
        recorder(args);
        return original.apply(this, args);
      };
      if (prototype[name] === original) {
        throw new Error(`${name} assignment did not stick`);
      }
      sink.push(name);
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
      patchMethod(prototype, name, gate.webglHookedMethods, (args) => {
        if (gate.webglDrawCalls.length < 4096) {
          gate.webglDrawCalls.push({
            method: name,
            mode: args[0] ?? null,
            count: args[1] ?? null,
            type: name.startsWith("drawElements") ? (args[2] ?? null) : null,
          });
        }
      });
    }
  }

  for (const name of ["createRenderPipeline", "createRenderPipelineAsync"]) {
    patchMethod(
      globalThis.GPUDevice?.prototype,
      name,
      gate.gpuPipelineHookedMethods,
      (args) => {
        const descriptor = args[0];
        if (
          gate.modelPipelineDescriptors.length < 256 &&
          /^Model PBR(?: |$)/.test(descriptor?.label ?? "")
        ) {
          gate.modelPipelineDescriptors.push({
            method: name,
            label: descriptor.label,
            topology: descriptor.primitive?.topology ?? null,
            stripIndexFormat: descriptor.primitive?.stripIndexFormat ?? null,
          });
        }
      },
    );
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
}

function runtimeGateSnapshot() {
  const gate = globalThis.__c1190RuntimeGate;
  if (!gate) return null;
  return {
    installed: gate.installed === true,
    requestDeviceCalls: gate.requestDeviceCalls,
    armedDevices: gate.armedDevices,
    webglHookedMethods: [...gate.webglHookedMethods],
    gpuPipelineHookedMethods: [...gate.gpuPipelineHookedMethods],
    webglDrawCalls: structuredClone(gate.webglDrawCalls),
    modelPipelineDescriptors: structuredClone(gate.modelPipelineDescriptors),
    instrumentationFailures: [...gate.instrumentationFailures],
    gpuErrors: structuredClone(gate.gpuErrors),
    deviceLosses: structuredClone(gate.deviceLosses),
    unhandledRejections: structuredClone(gate.unhandledRejections),
    windowErrors: structuredClone(gate.windowErrors),
  };
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
  if (gate?.installed !== true || gate.instrumentationFailures?.length !== 0) {
    failures.push("native instrumentation is unavailable or failed");
  }

  if (backend === "webgl") {
    if (
      authority?.isWebGL !== true ||
      authority?.isWebGPU !== false ||
      authority?.webgl2 !== true ||
      authority?.nativeWebGL2 !== true
    ) {
      failures.push("WebGL lane is not an authoritative WebGL2 context");
    }
    if (gate?.requestDeviceCalls !== 0 || gate?.armedDevices !== 0) {
      failures.push("WebGL lane requested a WebGPU device");
    }
    if (!gate?.webglHookedMethods?.includes("drawElements")) {
      failures.push("WebGL draw hooks are incomplete");
    }
  } else if (backend === "webgpu") {
    if (
      authority?.isWebGPU !== true ||
      authority?.isWebGL !== false ||
      authority?.nativeDevice !== true ||
      authority?.nativeCanvasContext !== true
    ) {
      failures.push(
        "WebGPU lane is not an authoritative native WebGPU context",
      );
    }
    if (!(gate?.requestDeviceCalls >= 1 && gate?.armedDevices >= 1)) {
      failures.push("WebGPU device acquisition was not observed and armed");
    }
    if (
      !gate?.gpuPipelineHookedMethods?.includes("createRenderPipeline") ||
      !gate?.gpuPipelineHookedMethods?.includes("createRenderPipelineAsync")
    ) {
      failures.push("WebGPU pipeline hooks are incomplete");
    }
  } else {
    failures.push(`unknown backend ${backend}`);
  }
  return { pass: failures.length === 0, failures };
}

export function assessTopologyAuthority(backend, topologyKey, model, gate) {
  const expectation = TOPOLOGY_EXPECTATIONS[topologyKey];
  const failures = [];
  if (!expectation) {
    return { pass: false, failures: [`unknown topology ${topologyKey}`] };
  }
  if (model?.ready !== true || model?.show !== true) {
    failures.push("model is not ready and visible");
  }
  if (model?.activeTopology !== topologyKey) {
    failures.push("captured model is not the active requested topology");
  }
  if (
    !Array.isArray(model?.runtimePrimitiveTypes) ||
    model.runtimePrimitiveTypes.length !== 1 ||
    model.runtimePrimitiveTypes[0] !== expectation.primitiveType
  ) {
    failures.push("frontend primitive type is missing or wrong");
  }
  if (!(
    Number.isFinite(model?.boundingSphere?.radius) &&
    model.boundingSphere.radius > 0
  )) {
    failures.push("model bounding sphere is vacuous");
  }

  if (backend === "webgl") {
    if (
      !(gate?.webglDrawCalls ?? []).some(
        (call) =>
          call.method === "drawElements" &&
          call.mode === expectation.webglDrawMode &&
          call.count === expectation.sourceIndexCount &&
          call.type === 0x1403,
      )
    ) {
      failures.push(
        "expected active topology was not drawn through indexed WebGL with exactly 98 uint16 indices",
      );
    }
  } else if (backend === "webgpu") {
    const primitives = model?.nativePrimitives ?? [];
    if (primitives.length !== 1) {
      failures.push("expected exactly one realized WebGPU primitive");
    } else {
      const primitive = primitives[0];
      if (
        primitive.topology !== expectation.webgpuTopology ||
        primitive.stripIndexFormat !== expectation.stripIndexFormat ||
        primitive.indexFormat !== "uint16" ||
        primitive.indexCount !== expectation.realizedIndexCount ||
        primitive.hasIndexBuffer !== true ||
        primitive.hasPipeline !== true
      ) {
        failures.push("WebGPU primitive realization is not exact");
      }
    }
    if (
      !(gate?.modelPipelineDescriptors ?? []).some(
        (descriptor) =>
          /^Model PBR \[/.test(descriptor.label) &&
          descriptor.topology === expectation.webgpuTopology &&
          descriptor.stripIndexFormat === expectation.stripIndexFormat,
      )
    ) {
      failures.push("expected native WebGPU model pipeline was not created");
    }
  } else {
    failures.push(`unknown backend ${backend}`);
  }
  return { pass: failures.length === 0, failures };
}

async function imageMetrics(filePath) {
  const { data, info } = await sharp(filePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixelCount = info.width * info.height;
  const mask = new Uint8Array(pixelCount);
  let modelMaskPixels = 0;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * info.channels;
    const colors = [data[offset], data[offset + 1], data[offset + 2]];
    const maximum = Math.max(...colors);
    const minimum = Math.min(...colors);
    if (maximum >= 32 && maximum - minimum <= 42) {
      mask[pixel] = 1;
      modelMaskPixels += 1;
    }
  }

  const significantThreshold = Math.max(64, Math.floor(pixelCount * 0.00005));
  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const components = [];
  for (let seed = 0; seed < pixelCount; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    let head = 0;
    let tail = 0;
    let size = 0;
    let minimumX = info.width;
    let maximumX = -1;
    let minimumY = info.height;
    let maximumY = -1;
    queue[tail++] = seed;
    visited[seed] = 1;
    while (head < tail) {
      const current = queue[head++];
      size += 1;
      const x = current % info.width;
      const y = Math.floor(current / info.width);
      minimumX = Math.min(minimumX, x);
      maximumX = Math.max(maximumX, x);
      minimumY = Math.min(minimumY, y);
      maximumY = Math.max(maximumY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= info.width || ny >= info.height) {
            continue;
          }
          const next = ny * info.width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    if (size >= significantThreshold) {
      const width = maximumX - minimumX + 1;
      const height = maximumY - minimumY + 1;
      components.push({
        pixels: size,
        bounds: { minimumX, maximumX, minimumY, maximumY },
        width,
        height,
        verticalAspect: height / width,
        elongation: Math.max(width / height, height / width),
      });
    }
  }
  components.sort((left, right) => right.pixels - left.pixels);
  const componentSizes = components.map((component) => component.pixels);
  const significantComponentPixels = componentSizes.reduce(
    (sum, size) => sum + size,
    0,
  );
  const componentBalance =
    components.length > 0 ? components.at(-1).pixels / components[0].pixels : 0;
  return {
    width: info.width,
    height: info.height,
    bytes: fs.statSync(filePath).size,
    sha256: sha256(fs.readFileSync(filePath)),
    modelMaskPixels,
    modelMaskFraction: modelMaskPixels / pixelCount,
    significantComponentThreshold: significantThreshold,
    significantComponentCount: components.length,
    significantComponentPixels,
    significantComponentCoverage:
      modelMaskPixels > 0 ? significantComponentPixels / modelMaskPixels : 0,
    significantComponentSizes: componentSizes.slice(0, 16),
    significantComponents: components.slice(0, 16),
    componentBalance,
    largestComponentShare:
      modelMaskPixels > 0 ? (componentSizes[0] ?? 0) / modelMaskPixels : 1,
  };
}

export function assessShapeAuthority(topologyKey, metrics) {
  const failures = [];
  const components = metrics?.significantComponents ?? [];
  if (metrics?.significantComponentCount !== 9 || components.length !== 9) {
    failures.push("restart topology must render exactly nine components");
  }
  if (!(metrics?.componentBalance >= 0.8)) {
    failures.push("the nine restart components are not size-balanced");
  }
  if (!(metrics?.significantComponentCoverage >= 0.9)) {
    failures.push(
      "significant restart components do not cover enough of the model mask",
    );
  }
  if (topologyKey === "triangle-strips") {
    if (
      components.length !== 9 ||
      !components.every((component) => component.verticalAspect >= 2.5)
    ) {
      failures.push("every triangle-strip component must be vertically tall");
    }
  } else if (topologyKey === "triangle-fans") {
    if (
      components.length !== 9 ||
      !components.every((component) => component.elongation <= 1.2)
    ) {
      failures.push("every triangle-fan component must be near-round");
    }
  } else {
    failures.push(`unknown topology ${topologyKey}`);
  }
  return { pass: failures.length === 0, failures };
}

async function imageDifference(pathA, pathB) {
  const [first, second] = await Promise.all(
    [pathA, pathB].map((filePath) =>
      sharp(filePath).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    ),
  );
  if (
    first.info.width !== second.info.width ||
    first.info.height !== second.info.height ||
    first.info.channels !== second.info.channels
  ) {
    return { comparable: false, changedPixels: 0, meanAbsoluteDelta: 0 };
  }
  let changedPixels = 0;
  let absoluteDelta = 0;
  for (
    let offset = 0;
    offset < first.data.length;
    offset += first.info.channels
  ) {
    let maximumDelta = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(
        first.data[offset + channel] - second.data[offset + channel],
      );
      maximumDelta = Math.max(maximumDelta, delta);
      absoluteDelta += delta;
    }
    if (maximumDelta >= 12) changedPixels += 1;
  }
  return {
    comparable: true,
    changedPixels,
    meanAbsoluteDelta:
      absoluteDelta / (first.info.width * first.info.height * 3),
  };
}

function addCheck(checks, name, pass, actual, expected) {
  checks.push({ name, pass: Boolean(pass), actual, expected });
}

export function collectFinalRuntimeGateErrors(finalLaneEvidence) {
  return Object.entries(finalLaneEvidence).flatMap(([backend, lane]) =>
    [
      "gpuErrors",
      "deviceLosses",
      "unhandledRejections",
      "windowErrors",
    ].flatMap((kind) =>
      (lane?.gate?.[kind] ?? []).map((diagnostic) => ({
        backend,
        kind,
        diagnostic,
      })),
    ),
  );
}

export function errorLanesAreEmpty(errors) {
  return Object.values(errors).every(
    (entries) => Array.isArray(entries) && entries.length === 0,
  );
}

async function installPageObservers(page, backend, errors, responses, tasks) {
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
    if (
      (message.type() === "error" || message.type() === "warning") &&
      /validation|GPUValidationError|not compatible|incompatible|device(?: was)? lost|popErrorScope|createRenderPipeline|createBindGroup/i.test(
        message.text(),
      )
    ) {
      errors.consoleValidationErrors.push(record);
    }
  });
  page.on("pageerror", (error) => {
    errors.pageErrors.push({ backend, message: error.message });
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
    let url;
    try {
      url = new URL(response.url());
    } catch {
      errors.malformedResponseUrls.push({
        backend,
        url: response.url(),
      });
      return;
    }
    if (url.origin !== BASE_ORIGIN) {
      errors.nonBaseResponses.push({
        backend,
        url: response.url(),
        status: response.status(),
      });
      return;
    }
    if (response.status() >= 400) {
      errors.badResponses.push({
        backend,
        url: response.url(),
        status: response.status(),
      });
    }
    const localPath = TRACKED_RUNTIME_PATHS.get(url.pathname);
    if (!localPath) return;
    tasks.push(
      response
        .body()
        .then((bytes) => {
          responses.push({
            backend,
            url: response.url(),
            pathname: url.pathname,
            status: response.status(),
            bytes: bytes.length,
            sha256: sha256(bytes),
            localSha256: sha256(fs.readFileSync(localPath)),
          });
        })
        .catch((error) => {
          responses.push({
            backend,
            url: response.url(),
            pathname: url.pathname,
            status: response.status(),
            bodyError: String(error),
          });
        }),
    );
  });
}

async function waitForHarness(page) {
  await page.waitForFunction(
    () =>
      globalThis.__c1190Harness?.state?.status === "READY" ||
      globalThis.__c1190Harness?.state?.status === "ERROR",
    undefined,
    { timeout: 45_000 },
  );
  const evidence = await page.evaluate(() =>
    globalThis.__c1190Harness.getEvidence(),
  );
  if (evidence.status !== "READY") {
    throw new Error(
      `STRUCTURAL: isolated harness boot failed: ${evidence.errors.join("; ")}`,
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
      timeout: 45_000,
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

async function drainFinalEventTurns(lanes) {
  await Promise.all(
    BACKENDS.map((backend) =>
      lanes[backend].page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 0)),
      ),
    ),
  );
}

async function captureTopology(lane, topologyKey, runDirectory) {
  await lane.page.evaluate((key) => {
    return globalThis.__c1190Harness.loadTopology(key);
  }, topologyKey);
  await lane.page.waitForTimeout(SETTLE_MS);
  const screenshotPath = path.join(
    runDirectory,
    `${topologyKey}-${lane.backend}.png`,
  );
  const canvas = lane.page.locator("#cesiumContainer canvas");
  if ((await canvas.count()) !== 1) {
    throw new Error(
      `STRUCTURAL: ${lane.backend} ${topologyKey} did not expose exactly one canvas`,
    );
  }
  await canvas.screenshot({ path: screenshotPath });
  const [evidence, gate] = await Promise.all([
    lane.page.evaluate(() => globalThis.__c1190Harness.getEvidence()),
    lane.page.evaluate(runtimeGateSnapshot),
  ]);
  return {
    screenshot: path
      .relative(process.cwd(), screenshotPath)
      .replaceAll("\\", "/"),
    metrics: await imageMetrics(screenshotPath),
    evidence,
    gate,
  };
}

function addLaneChecks(checks, lanes, finalLaneEvidence) {
  for (const backend of BACKENDS) {
    const lane = lanes[backend];
    addCheck(
      checks,
      `${backend} isolated route returned HTTP 200`,
      lane.navigationStatus === 200,
      lane.navigationStatus,
      200,
    );
    const recreation = lane.recreated?.recreationHistory?.at(-1);
    addCheck(
      checks,
      `${backend} Viewer recreation replaced canvas and graphics context`,
      lane.recreated?.generation === 2 &&
        recreation?.oldViewerDestroyed === true &&
        recreation?.canvasReplaced === true &&
        recreation?.contextReplaced === true &&
        recreation?.oldCanvasDisconnected === true,
      { generation: lane.recreated?.generation, recreation },
      {
        generation: 2,
        oldViewerDestroyed: true,
        canvasReplaced: true,
        contextReplaced: true,
        oldCanvasDisconnected: true,
      },
    );
    const authority = assessBackendAuthority(
      backend,
      finalLaneEvidence[backend].evidence.authority,
      finalLaneEvidence[backend].gate,
    );
    addCheck(
      checks,
      `${backend} backend authority is exact and non-fallback`,
      authority.pass,
      {
        authority: finalLaneEvidence[backend].evidence.authority,
        gate: finalLaneEvidence[backend].gate,
        failures: authority.failures,
      },
      "strict concrete native backend",
    );
  }
}

function addTopologyChecks(checks, topologyResults) {
  for (const [topologyKey, expectation] of Object.entries(
    TOPOLOGY_EXPECTATIONS,
  )) {
    const topologyResult = topologyResults[topologyKey];
    for (const backend of BACKENDS) {
      const result = topologyResult.backends[backend];
      const authority = assessTopologyAuthority(
        backend,
        topologyKey,
        result.evidence.model,
        result.gate,
      );
      addCheck(
        checks,
        `${expectation.label} ${backend} native topology authority`,
        authority.pass,
        {
          model: result.evidence.model,
          webglDrawCalls: result.gate?.webglDrawCalls,
          modelPipelineDescriptors: result.gate?.modelPipelineDescriptors,
          failures: authority.failures,
        },
        backend === "webgl"
          ? { primitiveType: expectation.webglDrawMode, draws: ">=1" }
          : {
              topology: expectation.webgpuTopology,
              stripIndexFormat: expectation.stripIndexFormat,
              indexCount: expectation.realizedIndexCount,
              pipelines: ">=1",
            },
      );
      const metrics = result.metrics;
      addCheck(
        checks,
        `${expectation.label} ${backend} canvas model mask is non-vacuous`,
        metrics.modelMaskPixels >= 1_000 &&
          metrics.modelMaskFraction >= 0.002 &&
          metrics.modelMaskFraction <= 0.65,
        metrics,
        { modelMaskPixels: ">=1000", modelMaskFraction: "0.002-0.65" },
      );
      const shape = assessShapeAuthority(topologyKey, metrics);
      addCheck(
        checks,
        `${expectation.label} ${backend} has exactly nine balanced components with the authored aspect law`,
        shape.pass,
        {
          count: metrics.significantComponentCount,
          components: metrics.significantComponents,
          componentBalance: metrics.componentBalance,
          significantComponentCoverage: metrics.significantComponentCoverage,
          failures: shape.failures,
        },
        topologyKey === "triangle-strips"
          ? {
              count: 9,
              componentBalance: ">=0.8",
              significantComponentCoverage: ">=0.9",
              everyVerticalAspect: ">=2.5",
            }
          : {
              count: 9,
              componentBalance: ">=0.8",
              significantComponentCoverage: ">=0.9",
              everyElongation: "<=1.2",
            },
      );
      addCheck(
        checks,
        `${expectation.label} ${backend} screenshot is canvas-only`,
        metrics.width === result.evidence.authority.canvasWidth &&
          metrics.height === result.evidence.authority.canvasHeight,
        {
          screenshot: [metrics.width, metrics.height],
          canvas: [
            result.evidence.authority.canvasWidth,
            result.evidence.authority.canvasHeight,
          ],
        },
        "identical dimensions",
      );
    }
    const webglPixels = topologyResult.backends.webgl.metrics.modelMaskPixels;
    const webgpuPixels = topologyResult.backends.webgpu.metrics.modelMaskPixels;
    const ratio = webglPixels > 0 ? webgpuPixels / webglPixels : null;
    topologyResult.crossBackendModelMaskRatio = ratio;
    addCheck(
      checks,
      `${expectation.label} cross-backend model-mask ratio is 0.90-1.10`,
      ratio !== null && ratio >= 0.9 && ratio <= 1.1,
      ratio,
      "0.90-1.10",
    );
  }
}

async function executeProbe(runDirectory, launchBrowser, browserControl) {
  const errors = {
    consoleErrors: [],
    consoleValidationErrors: [],
    pageErrors: [],
    dialogs: [],
    requestFailures: [],
    badResponses: [],
    malformedResponseUrls: [],
    nonBaseRequests: [],
    nonBaseResponses: [],
    runtimeGateErrors: [],
  };
  const runtimeResponses = [];
  const responseTasks = [];
  let browser;
  try {
    browser = await launchBrowser();
    browserControl.browser = browser;
    const context = await browser.newContext({ viewport: VIEWPORT });
    await context.addInitScript(installRuntimeGate);
    const lanes = await openLanes(
      context,
      errors,
      runtimeResponses,
      responseTasks,
    );
    for (const lane of Object.values(lanes)) {
      lane.recreated = await lane.page.evaluate(() =>
        globalThis.__c1190Harness.recreateViewer(),
      );
    }

    const topologyResults = {};
    for (const [topologyKey, expectation] of Object.entries(
      TOPOLOGY_EXPECTATIONS,
    )) {
      topologyResults[topologyKey] = { label: expectation.label, backends: {} };
      for (const backend of BACKENDS) {
        topologyResults[topologyKey].backends[backend] = await captureTopology(
          lanes[backend],
          topologyKey,
          runDirectory,
        );
      }
    }
    await Promise.allSettled(responseTasks);
    await drainFinalEventTurns(lanes);
    await Promise.allSettled(responseTasks);

    const finalLaneEvidence = {};
    for (const backend of BACKENDS) {
      finalLaneEvidence[backend] = {
        evidence: await lanes[backend].page.evaluate(() =>
          globalThis.__c1190Harness.getEvidence(),
        ),
        gate: await lanes[backend].page.evaluate(runtimeGateSnapshot),
      };
    }

    const checks = [];
    addLaneChecks(checks, lanes, finalLaneEvidence);
    addTopologyChecks(checks, topologyResults);
    for (const backend of BACKENDS) {
      const difference = await imageDifference(
        path.resolve(
          topologyResults["triangle-strips"].backends[backend].screenshot,
        ),
        path.resolve(
          topologyResults["triangle-fans"].backends[backend].screenshot,
        ),
      );
      topologyResults.topologyDifference ??= {};
      topologyResults.topologyDifference[backend] = difference;
      addCheck(
        checks,
        `${backend} visibly distinguishes strips from fans`,
        difference.comparable && difference.changedPixels >= 1_000,
        difference,
        { comparable: true, changedPixels: ">=1000" },
      );
    }

    const outputPaths = Object.keys(TOPOLOGY_EXPECTATIONS).flatMap(
      (topologyKey) =>
        BACKENDS.map(
          (backend) =>
            topologyResults[topologyKey].backends[backend].screenshot,
        ),
    );
    const runDirectoryName = path.basename(runDirectory);
    addCheck(
      checks,
      "all screenshot outputs are immutable unique run paths",
      new Set(outputPaths).size === outputPaths.length &&
        outputPaths.every((filePath) => filePath.includes(runDirectoryName)),
      outputPaths,
      "four distinct paths beneath the unique run UUID",
    );

    errors.runtimeGateErrors = collectFinalRuntimeGateErrors(finalLaneEvidence);
    addCheck(
      checks,
      "all page, console, promise, validation, GPU, dialog, and request error lanes are empty",
      errorLanesAreEmpty(errors),
      errors,
      "all arrays empty",
    );

    for (const [pathname, localPath] of TRACKED_RUNTIME_PATHS) {
      const matches = runtimeResponses.filter(
        (response) => response.pathname === pathname,
      );
      const localHash = sha256(fs.readFileSync(localPath));
      addCheck(
        checks,
        `served bytes match ${pathname}`,
        matches.length >= 1 &&
          matches.every(
            (response) =>
              response.status === 200 &&
              response.sha256 === localHash &&
              response.localSha256 === localHash,
          ),
        matches,
        { responseCount: ">=1", status: 200, sha256: localHash },
      );
    }

    return {
      browserConfig: {
        browser: "Microsoft Edge",
        headless: process.env.PROBE_HEADED !== "1",
        viewport: VIEWPORT,
        settleMs: SETTLE_MS,
        harness: "isolated strict-backend pages",
        deliberatelyExcludedTopologies: ["Line Strips", "Line Loops"],
      },
      routes: Object.fromEntries(
        BACKENDS.map((backend) => [backend, lanes[backend].route]),
      ),
      laneLifecycle: Object.fromEntries(
        BACKENDS.map((backend) => [
          backend,
          {
            initial: lanes[backend].initial,
            recreated: lanes[backend].recreated,
          },
        ]),
      ),
      finalLaneEvidence,
      topologyResults,
      runtimeResponses,
      errors,
      checks,
    };
  } finally {
    await browser?.close().catch(() => undefined);
    browserControl.browser = null;
  }
}

async function withWatchdog(task, browserControl) {
  let timer;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          void browserControl.browser?.close().catch(() => undefined);
          reject(new Error(`WATCHDOG: exceeded ${WATCHDOG_MS} ms`));
        }, WATCHDOG_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runPrimitiveRestartProbe(launchBrowser) {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  const runDirectory = path.join(OUTPUT_ROOT, runId);
  fs.mkdirSync(runDirectory, { recursive: false });
  const runArtifact = path.join(
    EVIDENCE_DIR,
    `c11-90-primitive-restart-split.run-${runId}.json`,
  );
  const firstRedAtStart = firstRedFingerprint();
  const startProvenance = collectLocalProvenance();
  atomicReplace(
    CANONICAL_ARTIFACT,
    serializeJson({
      schema: 2,
      campaign: "C11-90",
      probe: "primitive restart triangle isolated dual-backend acceptance",
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
  try {
    const browserControl = { browser: null };
    const result = await withWatchdog(
      executeProbe(runDirectory, launchBrowser, browserControl),
      browserControl,
    );
    const endProvenance = collectLocalProvenance();
    addCheck(
      result.checks,
      "demo, harness, policy, probe, assets, and builds stayed stable",
      provenanceStable(startProvenance, endProvenance),
      { start: startProvenance, end: endProvenance },
      "all start/end hashes identical",
    );
    addCheck(
      result.checks,
      "gallery source and served demo remain byte-identical",
      endProvenance.demoSource.sha256 === endProvenance.servedDemo.sha256,
      {
        source: endProvenance.demoSource.sha256,
        served: endProvenance.servedDemo.sha256,
      },
      "identical SHA-256",
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
      schema: 2,
      campaign: "C11-90",
      probe: "primitive restart triangle isolated dual-backend acceptance",
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
    const structural = /STRUCTURAL:/.test(message);
    exitCode = structural ? 3 : 2;
    artifact = {
      schema: 2,
      campaign: "C11-90",
      probe: "primitive restart triangle isolated dual-backend acceptance",
      runId,
      status: structural ? "STRUCTURAL" : "ERROR",
      incomplete: false,
      exitCode,
      startedAt,
      completedAt: new Date().toISOString(),
      baseUrl: BASE,
      startProvenance,
      firstRedAtStart,
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
    artifact.status === "PASS" ? null : preserveFirstRed(artifactBytes);
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
}
