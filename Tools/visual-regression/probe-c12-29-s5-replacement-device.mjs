#!/usr/bin/env node
/**
 * Genuine C12-29 S5 replacement-device recovery certification.
 *
 * The only loss trigger in this probe is Chromium's normal GPU-process
 * termination hook, exposed by exactly --enable-gpu-benchmarking.  The probe
 * never calls GPUDevice.destroy and never invokes a crash hook.  A loss whose
 * reason is "destroyed" is archived as STRUCTURAL, never counted as recovery.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  C12_29_S5_REPLACEMENT_CONFIG,
  C12_29_S5_REPLACEMENT_CONTRACT,
  C12_29_S5_REPLACEMENT_CONTROL_PHASES,
  C12_29_S5_REPLACEMENT_LOCAL_FILES,
  C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA,
  C12_29_S5_REPLACEMENT_PHASES,
  C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA,
  C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
  C12_29_S5_REPLACEMENT_SCHEMA,
  C12_29_S5_REPLACEMENT_SERVED_FILES,
  C12_29_S5_REPLACEMENT_SOURCE_FILES,
  C12_29_S5_REPLACEMENT_WEBGPU_PHASES,
  createC1229S5ReplacementErrorArtifact,
  createC1229S5ReplacementErrorDiagnostics,
  exitCodeForC1229S5ReplacementStatus,
  foldC1229S5ReplacementDeviceGate,
  isC1229S5ReplacementUuidV4,
  materializeC1229S5ReplacementEvidence,
  stableC1229S5ReplacementJson,
  validateC1229S5ReplacementFinalArtifact,
  validateC1229S5ReplacementPageProgress,
} from "./lib/c12-29-s5-replacement-device-gate.mjs";
import { inspectBuildSourceIdentity } from "./lib/build-source-identity.mjs";
import {
  armWebGPUDevices,
  collectGateErrors,
  errorGateInit,
} from "../lib/webgpu-error-gate.mjs";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "../..");
const buildEntryPath = path.join(
  repositoryRoot,
  "Build/CesiumUnminified/index.js",
);
const buildSourceMapPath = `${buildEntryPath}.map`;
const runtimePath = "/Build/CesiumUnminified/index.js";
const viewerPath = "/Apps/CesiumViewer/index.html";
const defaultBase = process.env.PROBE_BASE ?? "http://localhost:8080";
const defaultOutputDirectory = path.resolve(
  process.env.C12_29_S5_REPLACEMENT_OUTPUT_DIR ??
    path.join(toolDirectory, "output/c12-29-s5-replacement-device-v5"),
);
const WATCHDOG_MS = C12_29_S5_REPLACEMENT_CONFIG.watchdogMs;
const CONTEXT_DEVICE_LOSS_CONSOLE =
  /^\[WebGPU\] Device lost \(reason: (?!destroyed\b)([^)]+)\): (.*)$/u;
const POOL_DEVICE_LOSS_CONSOLE =
  /^\[CesiumJS:WebGPUDevicePool\] Device lost: (\S+) — (.*)$/u;
const SESSION_CLOSE_TIMEOUT_MS = 15_000;
const BROWSER_CLOSE_TIMEOUT_MS = 30_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonBytes = (value) =>
  Buffer.from(`${stableC1229S5ReplacementJson(value, 2)}\n`);
const asError = (value, fallback) =>
  value instanceof Error ? value : new Error(String(value ?? fallback));

export function validateC1229S5ReplacementLoopbackBase(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("--base must be an uncredentialed loopback HTTP URL");
  }
  return { origin: url.origin, href: url.href };
}

export function createC1229S5ReplacementArtifactPaths(
  runId,
  outputDirectory = defaultOutputDirectory,
) {
  if (!isC1229S5ReplacementUuidV4(runId)) {
    throw new Error("replacement-device runId must be a UUID v4");
  }
  const directory = path.resolve(outputDirectory);
  return {
    directory,
    archive: path.join(directory, `${runId}.json`),
    running: path.join(directory, `${runId}.running.json`),
    latest: path.join(directory, "latest.json"),
    lock: path.join(directory, "active.lock.json"),
  };
}

function assertC1229S5ReplacementArtifactPaths(paths, runId) {
  const expected = createC1229S5ReplacementArtifactPaths(
    runId,
    paths?.directory,
  );
  for (const key of ["directory", "archive", "running", "latest", "lock"]) {
    if (paths?.[key] !== expected[key]) {
      throw new Error(
        `replacement-device ${key} path is not owned by run ${runId}`,
      );
    }
  }
}

function readBytesIfPresent(file, operations = fs) {
  try {
    const value = operations.readFileSync(file);
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function exactBytes(file, expected, label, operations = fs) {
  const actual = readBytesIfPresent(file, operations);
  if (!actual || !actual.equals(Buffer.from(expected))) {
    throw new Error(`${label} bytes differ from owned canonical bytes`);
  }
  return actual;
}

function exclusive(file, bytes, operations = fs) {
  operations.writeFileSync(file, bytes, { flag: "wx" });
  exactBytes(file, bytes, path.basename(file), operations);
}

function restoreExclusive(file, bytes, label, operations) {
  try {
    exclusive(file, bytes, operations);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    exactBytes(file, bytes, label, operations);
  }
}

export function beginC1229S5ReplacementEvidenceRun(
  paths,
  runId,
  operations = fs,
) {
  assertC1229S5ReplacementArtifactPaths(paths, runId);
  operations.mkdirSync(paths.directory, { recursive: true });
  const priorLatest = readBytesIfPresent(paths.latest, operations);
  if (priorLatest) {
    const prior = JSON.parse(priorLatest.toString("utf8"));
    const valid = validateC1229S5ReplacementFinalArtifact(prior);
    if (!valid.ok) {
      throw new Error(
        `prior latest is not finalized valid evidence: ${valid.reasons.join("; ")}`,
      );
    }
    const canonicalPrior = jsonBytes(prior);
    if (!priorLatest.equals(canonicalPrior)) {
      throw new Error(
        "prior latest is not canonical replacement-device evidence",
      );
    }
    exactBytes(
      path.join(paths.directory, `${prior.runId}.json`),
      canonicalPrior,
      "prior immutable replacement-device archive",
      operations,
    );
  }
  const lock = {
    schema: "c12-29-s5-replacement-device-run-lock-v1",
    runId,
    pid: process.pid,
  };
  const lockBytes = jsonBytes(lock);
  exclusive(paths.lock, lockBytes, operations);
  const running = {
    schema: C12_29_S5_REPLACEMENT_SCHEMA,
    runId,
    incomplete: true,
    status: "RUNNING",
    phase: "preflight",
  };
  const runningBytes = jsonBytes(running);
  try {
    exclusive(paths.running, runningBytes, operations);
  } catch (error) {
    try {
      exactBytes(paths.lock, lockBytes, "replacement-device lock", operations);
      operations.unlinkSync(paths.lock);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "RUNNING creation and lock cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
  return { runId, lockBytes, runningBytes, priorLatest };
}

function replaceLatestOwned(paths, bytes, ownership, operations) {
  exactBytes(
    paths.lock,
    ownership.lockBytes,
    "replacement-device lock before latest publication",
    operations,
  );
  const current = readBytesIfPresent(paths.latest, operations);
  const prior = ownership.priorLatest;
  if (
    (current === undefined) !== (prior === undefined) ||
    (current && !current.equals(prior))
  ) {
    throw new Error(
      "canonical latest changed after this run acquired its lock",
    );
  }
  if (!current) {
    exclusive(paths.latest, bytes, operations);
    return;
  }
  const receipt = `${paths.latest}.${randomUUID()}.receipt`;
  operations.renameSync(paths.latest, receipt);
  let claimed;
  try {
    claimed = exactBytes(receipt, prior, "claimed prior latest", operations);
    exclusive(paths.latest, bytes, operations);
    operations.unlinkSync(receipt);
  } catch (error) {
    try {
      if (!readBytesIfPresent(paths.latest, operations)) {
        restoreExclusive(
          paths.latest,
          claimed ?? prior,
          "restored prior latest",
          operations,
        );
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "latest publication and restoration failed",
        { cause: restoreError },
      );
    }
    throw error;
  }
}

function releaseOwnedLock(paths, ownership, operations) {
  exactBytes(
    paths.lock,
    ownership.lockBytes,
    "replacement-device lock before release",
    operations,
  );
  const receipt = `${paths.lock}.${randomUUID()}.receipt`;
  operations.renameSync(paths.lock, receipt);
  try {
    exactBytes(
      receipt,
      ownership.lockBytes,
      "claimed replacement-device lock",
      operations,
    );
    operations.unlinkSync(receipt);
  } catch (error) {
    try {
      if (!readBytesIfPresent(paths.lock, operations)) {
        restoreExclusive(
          paths.lock,
          ownership.lockBytes,
          "restored replacement-device lock",
          operations,
        );
      }
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "lock release and restoration failed",
        { cause: restoreError },
      );
    }
    throw error;
  }
}

export function finalizeC1229S5ReplacementEvidence(
  paths,
  artifact,
  ownership,
  operations = fs,
) {
  let materialized;
  try {
    materialized = materializeC1229S5ReplacementEvidence(artifact);
  } catch (error) {
    throw new Error(
      `refusing non-materializable final artifact: ${String(error?.message ?? error)}`,
      { cause: error },
    );
  }
  if (materialized?.runId !== ownership?.runId) {
    throw new Error(
      "replacement-device artifact runId does not match owned evidence run",
    );
  }
  assertC1229S5ReplacementArtifactPaths(paths, ownership.runId);
  const valid = validateC1229S5ReplacementFinalArtifact(materialized);
  if (!valid.ok)
    throw new Error(
      `refusing invalid final artifact: ${valid.reasons.join("; ")}`,
    );
  exactBytes(
    paths.lock,
    ownership.lockBytes,
    "replacement-device finalization lock",
    operations,
  );
  exactBytes(
    paths.running,
    ownership.runningBytes,
    "replacement-device RUNNING record",
    operations,
  );
  const bytes = jsonBytes(materialized);
  const roundTrip = JSON.parse(bytes.toString("utf8"));
  const roundTripValid = validateC1229S5ReplacementFinalArtifact(roundTrip);
  if (!roundTripValid.ok || !jsonBytes(roundTrip).equals(bytes)) {
    throw new Error(
      `refusing non-round-tripping final artifact: ${roundTripValid.reasons.join("; ")}`,
    );
  }
  exclusive(paths.archive, bytes, operations);
  let runningRemoved = false;
  try {
    replaceLatestOwned(paths, bytes, ownership, operations);
    exactBytes(
      paths.archive,
      bytes,
      "replacement-device immutable archive",
      operations,
    );
    exactBytes(
      paths.latest,
      bytes,
      "replacement-device canonical latest",
      operations,
    );
    operations.unlinkSync(paths.running);
    runningRemoved = true;
    releaseOwnedLock(paths, ownership, operations);
  } catch (error) {
    error.retainReplacementRunning = true;
    if (runningRemoved) {
      try {
        restoreExclusive(
          paths.running,
          ownership.runningBytes,
          "restored replacement-device RUNNING record",
          operations,
        );
      } catch (restoreError) {
        const aggregate = new AggregateError(
          [error, restoreError],
          "final publication and RUNNING restoration failed",
          { cause: restoreError },
        );
        aggregate.retainReplacementRunning = true;
        throw aggregate;
      }
    }
    throw error;
  }
  return {
    archive: paths.archive,
    latest: paths.latest,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

/** Install the descriptor-exact method patch used by the retained-capture audit. */
export function installC1229S5ReplacementMethodPatch() {
  const w = /** @type {any} */ (window);
  if (w.__withC1229S5ReplacementMethodPatch) return;
  const descriptorsEqual = (left, right) => {
    if (left === undefined || right === undefined) return left === right;
    return (
      left.configurable === right.configurable &&
      left.enumerable === right.enumerable &&
      "value" in left === "value" in right &&
      ("value" in left
        ? Object.is(left.value, right.value) && left.writable === right.writable
        : Object.is(left.get, right.get) && Object.is(left.set, right.set))
    );
  };
  w.__withC1229S5ReplacementMethodPatch = async (
    target,
    key,
    replacement,
    operation,
  ) => {
    if (
      (typeof target !== "object" && typeof target !== "function") ||
      target === null ||
      typeof key !== "string" ||
      typeof replacement !== "function" ||
      typeof operation !== "function"
    ) {
      throw new TypeError(
        "replacement-device method patch arguments are invalid",
      );
    }
    const ownBefore = Object.getOwnPropertyDescriptor(target, key);
    const resolvedBefore = Reflect.get(target, key);
    if (typeof resolvedBefore !== "function") {
      throw new TypeError(`replacement-device ${key} is not callable`);
    }
    const patchedDescriptor =
      ownBefore && "value" in ownBefore
        ? { ...ownBefore, value: replacement }
        : {
            value: replacement,
            writable: true,
            enumerable: ownBefore?.enumerable ?? false,
            configurable: ownBefore?.configurable ?? true,
          };
    let operationResult;
    let operationError;
    let operationFailed = false;
    try {
      // The mutation is inside the guarded operation: every exit after the
      // first write reaches the exact descriptor restoration below.
      Object.defineProperty(target, key, patchedDescriptor);
      if (Reflect.get(target, key) !== replacement) {
        throw new Error(`replacement-device ${key} patch did not install`);
      }
      operationResult = await operation(resolvedBefore);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    let restorationError;
    try {
      if (ownBefore === undefined) {
        if (!Reflect.deleteProperty(target, key)) {
          throw new Error(
            `replacement-device inherited ${key} patch could not be removed`,
          );
        }
      } else {
        Object.defineProperty(target, key, ownBefore);
      }
      const ownAfter = Object.getOwnPropertyDescriptor(target, key);
      if (
        !descriptorsEqual(ownAfter, ownBefore) ||
        !Object.is(Reflect.get(target, key), resolvedBefore)
      ) {
        throw new Error(
          `replacement-device ${key} descriptor was not restored exactly`,
        );
      }
    } catch (error) {
      restorationError = error;
    }
    if (restorationError !== undefined) {
      throw restorationError;
    }
    if (operationFailed) {
      throw operationError;
    }
    return operationResult;
  };
}

/**
 * Page-init native ledger.  It wraps only observation seams and forwards every
 * native call with the original receiver/arguments.  No WebGPU object is
 * created by the instrumentation itself.
 */
export function installC1229S5ReplacementNativeLedger() {
  const w = /** @type {any} */ (window);
  if (w.__c1229S5ReplacementNative) return;
  const state = {
    ordinal: 0,
    stage: "startup",
    deviceSerial: 0,
    bufferSerial: 0,
    bindGroupSerial: 0,
    encoderSerial: 0,
    passSerial: 0,
    commandBufferSerial: 0,
    devices: [],
    buffers: [],
    bindGroups: [],
    writes: [],
    writeMeta: [],
    binds: [],
    bindMeta: [],
    encoders: [],
    passes: [],
    commandBuffers: [],
    submissions: [],
    marks: [],
    counters: {
      requestDevice: 0,
      armedAtAcquisition: 0,
      createBuffer: 0,
      createBindGroup: 0,
      writeBuffer: 0,
      setBindGroup: 0,
      createCommandEncoder: 0,
      beginRenderPass: 0,
      finishCommandEncoder: 0,
      submit: 0,
    },
    deviceMap: new WeakMap(),
    queueMap: new WeakMap(),
    bufferMap: new WeakMap(),
    bindGroupMap: new WeakMap(),
    encoderMap: new WeakMap(),
    passMap: new WeakMap(),
    commandBufferMap: new WeakMap(),
    proofReceiptMap: new WeakMap(),
  };
  const next = () => ++state.ordinal;
  const mark = (kind) => {
    const entry = { kind, ordinal: next(), stage: state.stage };
    state.marks.push(entry);
    return entry.ordinal;
  };
  const deviceInfo = (device, role) => {
    if (!device) return null;
    let info = state.deviceMap.get(device);
    if (!info) {
      info = {
        token: `device-${++state.deviceSerial}`,
        role: role ?? null,
        firstOrdinal: next(),
        armedAtAcquisition: false,
        createBufferCount: 0,
        createBindGroupCount: 0,
      };
      state.deviceMap.set(device, info);
      state.devices.push(info);
      try {
        state.queueMap.set(device.queue, info);
      } catch {
        /* diagnostic only */
      }
    }
    if (role) info.role = role;
    return info;
  };
  const bytesOf = (data, dataOffset = 0, size) => {
    let source;
    let unitBytes = 1;
    if (data instanceof ArrayBuffer) source = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) {
      source = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      // WebGPU defines dataOffset/size in typed-array elements, but in bytes
      // for ArrayBuffer/DataView. Preserve the native call's exact unit law.
      unitBytes = Number(data.BYTES_PER_ELEMENT ?? 1);
    } else return new Uint8Array();
    const start = Math.max(0, Number(dataOffset) || 0) * unitBytes;
    const end =
      size === undefined
        ? source.byteLength
        : Math.min(
            source.byteLength,
            start + Math.max(0, Number(size) || 0) * unitBytes,
          );
    return source.slice(start, end);
  };
  const wrap = (prototype, name, factory) => {
    if (!prototype || typeof prototype[name] !== "function") return false;
    const original = prototype[name];
    if (original.__c1229S5ReplacementWrapped) return true;
    const replacement = factory(original);
    Object.defineProperty(replacement, "__c1229S5ReplacementWrapped", {
      value: true,
    });
    prototype[name] = replacement;
    return prototype[name] === replacement;
  };

  // Arm every newly acquired device before the requestDevice promise is
  // released to Cesium. This closes the otherwise-unobserved D0 construction
  // and D1 recovery-initialization intervals for uncaptured GPU errors.
  const adapterWrapped = wrap(
    w.GPUAdapter?.prototype,
    "requestDevice",
    (original) =>
      function () {
        state.counters.requestDevice++;
        const requested = Reflect.apply(original, this, arguments);
        return Promise.resolve(requested).then((device) => {
          const info = deviceInfo(device);
          const arm = w.__armWebGPUDevice;
          if (typeof arm !== "function") {
            throw new Error(
              "replacement-device error gate was unavailable at acquisition",
            );
          }
          arm(device, `replacement-${info.token}`);
          if (device.__gateArmed !== true) {
            throw new Error(
              "replacement-device error gate did not arm acquired device",
            );
          }
          info.armedAtAcquisition = true;
          state.counters.armedAtAcquisition++;
          return device;
        });
      },
  );

  const deviceWrapped =
    wrap(
      w.GPUDevice?.prototype,
      "createBuffer",
      (original) =>
        function (descriptor) {
          const device = deviceInfo(this);
          const buffer = Reflect.apply(original, this, arguments);
          const record = {
            token: `buffer-${++state.bufferSerial}`,
            deviceToken: device?.token ?? "unowned",
            label: String(descriptor?.label ?? ""),
            size: Number(descriptor?.size ?? 0),
            usage: Number(descriptor?.usage ?? 0),
            createdOrdinal: next(),
            createdStage: state.stage,
            destroyedOrdinal: null,
            destroyCount: 0,
          };
          state.counters.createBuffer++;
          if (device) device.createBufferCount++;
          state.bufferMap.set(buffer, record);
          state.buffers.push(record);
          return buffer;
        },
    ) &&
    wrap(
      w.GPUDevice?.prototype,
      "createBindGroup",
      (original) =>
        function (descriptor) {
          const device = deviceInfo(this);
          const bindGroup = Reflect.apply(original, this, arguments);
          const entries = Array.from(descriptor?.entries ?? []).map((entry) => {
            const resource = entry?.resource;
            const buffer = resource?.buffer;
            const record = buffer ? state.bufferMap.get(buffer) : null;
            return {
              binding: Number(entry?.binding),
              bufferToken: record?.token ?? null,
              offset: Number(resource?.offset ?? 0),
              size: Number(resource?.size ?? 0),
            };
          });
          const record = {
            token: `bind-group-${++state.bindGroupSerial}`,
            deviceToken: device?.token ?? "unowned",
            createdOrdinal: next(),
            createdStage: state.stage,
            entries,
          };
          state.counters.createBindGroup++;
          if (device) device.createBindGroupCount++;
          state.bindGroupMap.set(bindGroup, record);
          state.bindGroups.push(record);
          return bindGroup;
        },
    ) &&
    wrap(
      w.GPUDevice?.prototype,
      "createCommandEncoder",
      (original) =>
        function (descriptor) {
          const device = deviceInfo(this);
          const encoder = Reflect.apply(original, this, arguments);
          const record = {
            token: `encoder-${++state.encoderSerial}`,
            deviceToken: device?.token ?? "unowned",
            label: String(descriptor?.label ?? ""),
            createdOrdinal: next(),
          };
          state.counters.createCommandEncoder++;
          state.encoderMap.set(encoder, record);
          state.encoders.push(record);
          return encoder;
        },
    );

  const commandEncoderWrapped =
    wrap(
      w.GPUCommandEncoder?.prototype,
      "beginRenderPass",
      (original) =>
        function (descriptor) {
          const encoder = state.encoderMap.get(this);
          const pass = Reflect.apply(original, this, arguments);
          const record = {
            token: `pass-${++state.passSerial}`,
            deviceToken: encoder?.deviceToken ?? "unowned",
            commandEncoderToken: encoder?.token ?? "untracked",
            label: String(descriptor?.label ?? ""),
            beginOrdinal: next(),
          };
          state.counters.beginRenderPass++;
          state.passMap.set(pass, record);
          state.passes.push(record);
          return pass;
        },
    ) &&
    wrap(
      w.GPUCommandEncoder?.prototype,
      "finish",
      (original) =>
        function () {
          const encoder = state.encoderMap.get(this);
          const commandBuffer = Reflect.apply(original, this, arguments);
          const record = {
            token: `command-buffer-${++state.commandBufferSerial}`,
            deviceToken: encoder?.deviceToken ?? "unowned",
            commandEncoderToken: encoder?.token ?? "untracked",
            finishOrdinal: next(),
            stage: state.stage,
          };
          state.counters.finishCommandEncoder++;
          state.commandBufferMap.set(commandBuffer, record);
          state.commandBuffers.push(record);
          return commandBuffer;
        },
    );

  const queueWrapped =
    wrap(
      w.GPUQueue?.prototype,
      "writeBuffer",
      (original) =>
        function (buffer, bufferOffset, data, dataOffset, size) {
          const result = Reflect.apply(original, this, arguments);
          const ordinal = next();
          const resource = state.bufferMap.get(buffer);
          const device = state.queueMap.get(this);
          // Retain bytes only for UNIFORM buffers. The ownership/order ledger
          // still records every successful write below, while texture/storage
          // uploads can be many MiB and are irrelevant to binding-2 proof.
          const uniformUsage = Number(w.GPUBufferUsage?.UNIFORM ?? 64);
          const bytes =
            resource && (resource.usage & uniformUsage) !== 0
              ? bytesOf(data, dataOffset, size)
              : null;
          const write = {
            ordinal,
            stage: state.stage,
            deviceToken: device?.token ?? "unowned",
            bufferToken: resource?.token ?? "untracked",
            offset: Number(bufferOffset ?? 0),
            bytes,
          };
          if (bytes !== null) state.writes.push(write);
          state.writeMeta.push({
            ordinal: write.ordinal,
            stage: write.stage,
            deviceToken: write.deviceToken,
            bufferToken: write.bufferToken,
          });
          if (state.writes.length > 512)
            state.writes.splice(0, state.writes.length - 512);
          state.counters.writeBuffer++;
          return result;
        },
    ) &&
    wrap(
      w.GPUQueue?.prototype,
      "submit",
      (original) =>
        function (commandBuffers) {
          const device = state.queueMap.get(this);
          // Production submits arrays. Snapshot an array without consuming a
          // caller-provided one-shot iterable before the native WebIDL layer.
          const buffers = Array.isArray(commandBuffers)
            ? commandBuffers.slice()
            : null;
          const result = Reflect.apply(original, this, arguments);
          const ordinal = next();
          state.submissions.push({
            ordinal,
            stage: state.stage,
            deviceToken: device?.token ?? "unowned",
            commandBufferTokens: (buffers ?? []).map(
              (buffer) =>
                state.commandBufferMap.get(buffer)?.token ?? "untracked",
            ),
          });
          state.counters.submit++;
          return result;
        },
    );

  const bufferWrapped = wrap(
    w.GPUBuffer?.prototype,
    "destroy",
    (original) =>
      function () {
        const result = Reflect.apply(original, this, arguments);
        const record = state.bufferMap.get(this);
        if (record) {
          record.destroyCount++;
          const ordinal = next();
          record.destroyedOrdinal ??= ordinal;
        }
        return result;
      },
  );

  const renderPassWrapped = wrap(
    w.GPURenderPassEncoder?.prototype,
    "setBindGroup",
    (original) =>
      function (
        index,
        bindGroup,
        dynamicOffsets,
        dynamicOffsetsStart,
        dynamicOffsetsLength,
      ) {
        const result = Reflect.apply(original, this, arguments);
        const record = state.bindGroupMap.get(bindGroup);
        const pass = state.passMap.get(this);
        let offsets = [];
        if (
          dynamicOffsets &&
          typeof dynamicOffsets[Symbol.iterator] === "function"
        ) {
          offsets = Array.from(dynamicOffsets, Number);
          if (dynamicOffsetsStart !== undefined) {
            const start = Number(dynamicOffsetsStart) || 0;
            const length =
              dynamicOffsetsLength === undefined
                ? offsets.length - start
                : Number(dynamicOffsetsLength);
            offsets = offsets.slice(start, start + length);
          }
        }
        const bind = {
          ordinal: next(),
          stage: state.stage,
          group: Number(index),
          bindGroupToken: record?.token ?? "untracked",
          deviceToken: record?.deviceToken ?? "unowned",
          dynamicOffsets: offsets,
          passToken: pass?.token ?? "untracked",
          passLabel: pass?.label ?? "",
          commandEncoderToken: pass?.commandEncoderToken ?? "untracked",
        };
        state.binds.push(bind);
        state.bindMeta.push({
          ordinal: bind.ordinal,
          stage: bind.stage,
          group: bind.group,
          bindGroupToken: bind.bindGroupToken,
          deviceToken: bind.deviceToken,
        });
        if (state.binds.length > 2048)
          state.binds.splice(0, state.binds.length - 2048);
        state.counters.setBindGroup++;
        return result;
      },
  );

  const proof = (role, expectedPayload, requirements = {}) => {
    const {
      requiredBindGroupToken = null,
      requiredDynamicOffsets = null,
      descriptorOrdinal = null,
      requiredPassLabel = null,
      requireScenePass = false,
      requireCapturePass = false,
      minimumBindOrdinal = 0,
    } = requirements;
    const device = state.devices.find((entry) => entry.role === role);
    const expected = Array.from(expectedPayload, Math.fround);
    for (let index = state.binds.length - 1; index >= 0; index--) {
      const bind = state.binds[index];
      if (bind.group !== 0 || bind.deviceToken !== device?.token) continue;
      if (bind.ordinal < minimumBindOrdinal) continue;
      if (descriptorOrdinal !== null && bind.ordinal <= descriptorOrdinal)
        continue;
      if (
        requiredBindGroupToken !== null &&
        bind.bindGroupToken !== requiredBindGroupToken
      ) {
        continue;
      }
      if (
        requiredDynamicOffsets !== null &&
        (bind.dynamicOffsets.length !== requiredDynamicOffsets.length ||
          !bind.dynamicOffsets.every((value, offsetIndex) =>
            Object.is(value, requiredDynamicOffsets[offsetIndex]),
          ))
      ) {
        continue;
      }
      if (requiredPassLabel !== null && bind.passLabel !== requiredPassLabel)
        continue;
      if (
        requireScenePass &&
        !/^(?:Scene Main|Scene Framebuffer) Render Pass$/u.test(bind.passLabel)
      )
        continue;
      if (
        requireCapturePass &&
        !/^DynEnvMap Capture Face [0-5]$/u.test(bind.passLabel)
      )
        continue;
      const group = state.bindGroups.find(
        (entry) => entry.token === bind.bindGroupToken,
      );
      const entry = group?.entries.find(
        (candidate) => candidate.binding === 2 && candidate.size === 64,
      );
      if (!entry?.bufferToken || bind.dynamicOffsets.length !== 3) continue;
      const dynamicOffset = bind.dynamicOffsets[2];
      const commandBuffer = state.commandBuffers.find(
        (candidate) =>
          candidate.commandEncoderToken === bind.commandEncoderToken &&
          candidate.deviceToken === device.token &&
          candidate.finishOrdinal > bind.ordinal,
      );
      if (!commandBuffer) continue;
      const submission = state.submissions.find(
        (candidate) =>
          candidate.deviceToken === device.token &&
          candidate.ordinal > commandBuffer.finishOrdinal &&
          candidate.commandBufferTokens.includes(commandBuffer.token),
      );
      if (!submission) continue;
      const effectiveOffset = entry.offset + dynamicOffset;
      const effectiveEnd = effectiveOffset + 64;
      for (
        let writeIndex = state.writes.length - 1;
        writeIndex >= 0;
        writeIndex--
      ) {
        const write = state.writes[writeIndex];
        if (write.ordinal <= bind.ordinal) continue;
        if (write.ordinal >= submission.ordinal) continue;
        if (write.bufferToken !== entry.bufferToken) continue;
        const writeEnd = write.offset + write.bytes.byteLength;
        if (write.offset >= effectiveEnd || writeEnd <= effectiveOffset)
          continue;
        // The most recent write touching the selected 64-byte range must
        // cover it in full. Otherwise an older full upload could mask a later
        // partial overwrite and falsely certify bytes no longer bound.
        if (write.offset > effectiveOffset || writeEnd < effectiveEnd) break;
        // Queue writes after encoder.finish can affect execution, but they do
        // not satisfy this packet's stronger retained-command chronology. A
        // newer touching write after finish also invalidates any older upload.
        if (write.ordinal >= commandBuffer.finishOrdinal) break;
        const relative = effectiveOffset - write.offset;
        const bytes = write.bytes.slice(relative, relative + 64);
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        const observed = Array.from({ length: 16 }, (_, component) =>
          view.getFloat32(component * 4, true),
        );
        const exact = observed.every((value, component) =>
          Object.is(value, expected[component]),
        );
        const proofValue = {
          role,
          deviceToken: device.token,
          bufferToken: entry.bufferToken,
          bindGroupToken: group.token,
          group: 0,
          binding: 2,
          bindingSize: entry.size,
          bindingOffset: entry.offset,
          dynamicOffset,
          dynamicOffsets: [...bind.dynamicOffsets],
          alignment:
            Number(
              w.navigator?.gpu
                ? role === "D0"
                  ? w.viewer?.scene?.context?._device?.limits
                      ?.minUniformBufferOffsetAlignment
                  : w.viewer?.scene?.context?._device?.limits
                      ?.minUniformBufferOffsetAlignment
                : 256,
            ) || 256,
          descriptorOrdinal,
          passLabel: bind.passLabel,
          renderPassToken: bind.passToken,
          commandEncoderToken: bind.commandEncoderToken,
          commandBufferToken: commandBuffer.token,
          bindOrdinal: bind.ordinal,
          finishOrdinal: commandBuffer.finishOrdinal,
          uploadOrdinal: write.ordinal,
          uploadOffset: write.offset,
          uploadByteLength: write.bytes.byteLength,
          submitOrdinal: submission.ordinal,
          expectedPayload: expected,
          observedPayload: observed,
          payloadExact: exact,
          ownedByDevice:
            group.deviceToken === device.token &&
            state.buffers.find(
              (candidate) => candidate.token === entry.bufferToken,
            )?.deviceToken === device.token &&
            write.deviceToken === device.token,
          coveredByUpload: true,
        };
        state.proofReceiptMap.set(proofValue, {
          role,
          device: {
            token: device.token,
            firstOrdinal: device.firstOrdinal,
            armedAtAcquisition: device.armedAtAcquisition,
          },
          bind: {
            ordinal: bind.ordinal,
            stage: bind.stage,
            group: bind.group,
            deviceToken: bind.deviceToken,
            bindGroupToken: bind.bindGroupToken,
            dynamicOffsets: [...bind.dynamicOffsets],
            renderPassToken: bind.passToken,
            passLabel: bind.passLabel,
            commandEncoderToken: bind.commandEncoderToken,
          },
          upload: {
            ordinal: write.ordinal,
            stage: write.stage,
            deviceToken: write.deviceToken,
            bufferToken: write.bufferToken,
            offset: write.offset,
            byteLength: write.bytes.byteLength,
            effectiveOffset,
            observedPayload: [...observed],
          },
          finish: {
            ordinal: commandBuffer.finishOrdinal,
            stage: commandBuffer.stage,
            deviceToken: commandBuffer.deviceToken,
            commandEncoderToken: commandBuffer.commandEncoderToken,
            commandBufferToken: commandBuffer.token,
          },
          submit: {
            ordinal: submission.ordinal,
            stage: submission.stage,
            deviceToken: submission.deviceToken,
            commandBufferTokens: [...submission.commandBufferTokens],
          },
        });
        return proofValue;
      }
    }
    throw new Error(
      `no exact group-0/binding-2 64-byte upload proof for ${role}`,
    );
  };

  const resource = (role, proofValue) => {
    const buffer = state.buffers.find(
      (entry) => entry.token === proofValue.bufferToken,
    );
    return {
      role,
      deviceToken: buffer.deviceToken,
      bufferToken: proofValue.bufferToken,
      createdOrdinal: buffer.createdOrdinal,
      destroyedOrdinal: buffer.destroyedOrdinal,
      destroyCount: buffer.destroyCount,
      boundOrdinals: state.bindMeta
        .filter(
          (entry) =>
            entry.deviceToken === proofValue.deviceToken &&
            entry.bindGroupToken === proofValue.bindGroupToken,
        )
        .map((entry) => entry.ordinal),
      writeOrdinals: state.writeMeta
        .filter((entry) => entry.bufferToken === proofValue.bufferToken)
        .map((entry) => entry.ordinal),
    };
  };

  const receipt = (role, proofValue, resourceValue) => {
    const selected = state.proofReceiptMap.get(proofValue);
    if (!selected || selected.role !== role) {
      throw new Error(`native ${role} proof has no retained event receipt`);
    }
    return {
      role,
      device: { ...selected.device },
      buffer: {
        deviceToken: resourceValue.deviceToken,
        bufferToken: resourceValue.bufferToken,
        createdOrdinal: resourceValue.createdOrdinal,
        destroyedOrdinal: resourceValue.destroyedOrdinal,
        destroyCount: resourceValue.destroyCount,
      },
      bind: {
        ...selected.bind,
        dynamicOffsets: [...selected.bind.dynamicOffsets],
      },
      upload: {
        ...selected.upload,
        observedPayload: [...selected.upload.observedPayload],
      },
      finish: { ...selected.finish },
      submit: {
        ...selected.submit,
        commandBufferTokens: [...selected.submit.commandBufferTokens],
      },
    };
  };

  w.__c1229S5ReplacementNative = {
    installedBeforeViewer: !w.viewer,
    instrumentation: {
      deviceWrapped,
      queueWrapped,
      bufferWrapped,
      renderPassWrapped,
    },
    trackDevice(device, role) {
      return deviceInfo(device, role)?.token ?? null;
    },
    bindGroupToken(bindGroup) {
      return state.bindGroupMap.get(bindGroup)?.token ?? null;
    },
    setStage(stage) {
      state.stage = String(stage);
    },
    mark,
    proof,
    resource,
    finalize(beforeProof, afterProof) {
      const d0 = state.devices.find((entry) => entry.role === "D0");
      const d1 = state.devices.find((entry) => entry.role === "D1");
      const d0Resource = resource("D0", beforeProof);
      const d1Resource = resource("D1", afterProof);
      const ordinal = (kind) =>
        state.marks.find((entry) => entry.kind === kind)?.ordinal ?? 0;
      const lossOrdinal = ordinal("loss");
      const invalidationOrdinal = ordinal("invalidation");
      const healthyOrdinal = ordinal("healthy");
      const firstD1CreateOrdinal = Math.min(
        ...state.buffers
          .filter((entry) => entry.deviceToken === d1.token)
          .map((entry) => entry.createdOrdinal),
      );
      const postLoss = (entry) => entry.ordinal > lossOrdinal;
      const retirement = {
        lossOrdinal,
        oldDestroyOrdinal: d0Resource.destroyedOrdinal ?? 0,
        invalidationOrdinal,
        healthyOrdinal,
        firstD1CreateOrdinal,
        oldDestroyCount: d0Resource.destroyCount,
        postLossD0CreateCount: state.buffers.filter(
          (entry) =>
            entry.deviceToken === d0.token &&
            entry.createdOrdinal > lossOrdinal,
        ).length,
        postLossD0WriteCount: state.writeMeta.filter(
          (entry) => entry.deviceToken === d0.token && postLoss(entry),
        ).length,
        postLossD0BindCount: state.bindMeta.filter(
          (entry) => entry.deviceToken === d0.token && postLoss(entry),
        ).length,
        invalidationCount: state.marks.filter(
          (entry) => entry.kind === "invalidation",
        ).length,
        ordered:
          lossOrdinal > 0 &&
          d0Resource.destroyedOrdinal > lossOrdinal &&
          d0Resource.destroyedOrdinal <= invalidationOrdinal &&
          invalidationOrdinal < healthyOrdinal &&
          firstD1CreateOrdinal > lossOrdinal &&
          firstD1CreateOrdinal <= healthyOrdinal,
      };
      return {
        schema: "c12-29-s5-replacement-device-native-resource-ledger-v5",
        instrumentation: {
          installedBeforeViewer: this.installedBeforeViewer,
          adapterPrototypeWrapped: adapterWrapped,
          devicePrototypeWrapped: deviceWrapped,
          commandEncoderPrototypeWrapped: commandEncoderWrapped,
          queuePrototypeWrapped: queueWrapped,
          bufferPrototypeWrapped: bufferWrapped,
          renderPassPrototypeWrapped: renderPassWrapped,
          createBufferCalls: state.counters.createBuffer,
          createBindGroupCalls: state.counters.createBindGroup,
          writeBufferCalls: state.counters.writeBuffer,
          setBindGroupCalls: state.counters.setBindGroup,
          createCommandEncoderCalls: state.counters.createCommandEncoder,
          beginRenderPassCalls: state.counters.beginRenderPass,
          finishCommandEncoderCalls: state.counters.finishCommandEncoder,
          submitCalls: state.counters.submit,
          requestDeviceCalls: state.counters.requestDevice,
          armedAtAcquisitionCalls: state.counters.armedAtAcquisition,
        },
        devices: [d0, d1].map((entry, index) => ({
          role: index === 0 ? "D0" : "D1",
          token: entry.token,
          firstOrdinal: entry.firstOrdinal,
          armedAtAcquisition: entry.armedAtAcquisition,
          createBufferCount: entry.createBufferCount,
          createBindGroupCount: entry.createBindGroupCount,
        })),
        binding2: {
          group: 0,
          binding: 2,
          byteLength: 64,
          floatCount: 16,
          before: beforeProof,
          after: afterProof,
        },
        resources: { d0Binding2: d0Resource, d1Binding2: d1Resource },
        retirement,
        sequence: {
          marks: state.marks.map(({ kind, ordinal, stage }) => ({
            kind,
            ordinal,
            stage,
          })),
          receipts: [
            receipt("D0", beforeProof, d0Resource),
            receipt("D1", afterProof, d1Resource),
          ],
        },
      };
    },
  };
}

const MEASURE_C1229_S5_REPLACEMENT_SESSION = async (contract) => {
  const startedAt = performance.now();
  const progress = {
    schema: contract.progressSchema,
    renderer: contract.renderer,
    currentPhase: "preflight",
    completedPhases: [],
    step: "start",
    elapsedMs: 0,
  };
  globalThis.__c1229S5ReplacementProgress = progress;
  const mark = (phase, step) => {
    progress.currentPhase = phase;
    progress.step = step;
    progress.elapsedMs = performance.now() - startedAt;
  };
  const complete = (phase) => {
    progress.completedPhases.push(phase);
    mark(phase, "complete");
  };
  const C = await import(contract.runtimePath);
  const existing = globalThis.viewer;
  if (existing && !existing.isDestroyed?.()) {
    existing.useDefaultRenderLoop = false;
    existing.destroy();
  }
  const container = document.getElementById("cesiumContainer");
  if (!container) throw new Error("CesiumViewer container is unavailable");
  container.innerHTML = "";
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    width: `${contract.viewport.width}px`,
    height: `${contract.viewport.height}px`,
  });
  const terrainRequests = [];
  const tilingScheme = new C.GeographicTilingScheme({
    ellipsoid: C.Ellipsoid.WGS84,
  });
  const provider = new C.CustomHeightmapTerrainProvider({
    width: contract.terrainWidth,
    height: contract.terrainHeight,
    tilingScheme,
    callback(x, y, level) {
      terrainRequests.push({ x, y, level });
      const heights = new Float32Array(
        contract.terrainWidth * contract.terrainHeight,
      );
      heights.fill(contract.terrainMeters);
      return heights;
    },
  });
  const globe = new C.Globe(C.Ellipsoid.WGS84);
  const options = {
    globe,
    terrainProvider: provider,
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    selectionIndicator: false,
    infoBox: false,
    skyBox: false,
    skyAtmosphere: false,
    requestRenderMode: false,
    creditContainer: document.createElement("div"),
  };
  const viewer =
    contract.renderer === "webgpu"
      ? await C.Viewer.createAsync(container, {
          ...options,
          contextOptions: { renderer: "webgpu" },
        })
      : new C.Viewer(container, options);
  globalThis.viewer = viewer;
  viewer.useDefaultRenderLoop = false;
  viewer.resolutionScale = 1;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const context = scene.context;
  const actualRenderer = context.isWebGPU ? "webgpu" : "webgl";
  if (actualRenderer !== contract.renderer)
    throw new Error(
      `renderer resolved ${actualRenderer}, expected ${contract.renderer}`,
    );
  scene.requestRenderMode = false;
  scene.highDynamicRange = false;
  scene.sunBloom = false;
  scene.taaEnabled = false;
  scene.backgroundColor = C.Color.BLACK;
  if (scene.fog) scene.fog.enabled = false;
  if (scene.postProcessStages?.fxaa)
    scene.postProcessStages.fxaa.enabled = false;
  if (scene.postProcessStages?.bloom)
    scene.postProcessStages.bloom.enabled = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  globe.enableLighting = false;
  globe.showGroundAtmosphere = false;
  globe.showWaterEffect = false;
  globe.maximumScreenSpaceError = contract.maximumScreenSpaceError;
  const grid = new C.GridImageryProvider({
    tilingScheme,
    cells: 1,
    color: C.Color.fromBytes(238, 238, 238, 255),
    glowColor: C.Color.fromBytes(180, 180, 180, 255),
    backgroundColor: C.Color.fromBytes(210, 210, 210, 255),
  });
  viewer.imageryLayers.removeAll();
  viewer.imageryLayers.addImageryProvider(grid);
  const lighting = globe.atmosphericConditions?.lighting;
  if (!lighting || !("enableEclipseGlobeShadow" in lighting))
    throw new Error("S5 controls are unavailable");
  lighting.enableEclipse = true;
  lighting.eclipseAutoExposure = false;
  lighting.enableEclipseGlobeShadow = true;
  if ("enableEclipseHorizonTwilight" in lighting)
    lighting.enableEclipseHorizonTwilight = false;
  const pinnedTime = C.JulianDate.fromIso8601(contract.eventIso);
  viewer.clock.currentTime = pinnedTime.clone();
  viewer.clock.startTime = pinnedTime.clone();
  viewer.clock.stopTime = pinnedTime.clone();
  viewer.clock.shouldAnimate = false;
  viewer.clock.multiplier = 0;
  const preloadStart = C.JulianDate.addHours(
    pinnedTime,
    -1,
    new C.JulianDate(),
  );
  const preloadStop = C.JulianDate.addHours(pinnedTime, 1, new C.JulianDate());
  await C.Transforms.preloadIcrfFixed(
    new C.TimeInterval({ start: preloadStart, stop: preloadStop }),
  );
  const matrix = C.Transforms.computeIcrfToFixedMatrix(
    pinnedTime,
    new C.Matrix3(),
  );
  if (!matrix) throw new Error("ICRF-to-fixed matrix is unavailable");
  const sunI =
    C.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      pinnedTime,
      new C.Cartesian3(),
    );
  const moonI =
    C.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(
      pinnedTime,
      new C.Cartesian3(),
    );
  const sun = C.Matrix3.multiplyByVector(matrix, sunI, new C.Cartesian3());
  const moon = C.Matrix3.multiplyByVector(matrix, moonI, new C.Cartesian3());
  const direction = C.Cartesian3.normalize(
    C.Cartesian3.subtract(moon, sun, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const radii = C.Ellipsoid.WGS84.radii;
  const inv2 = {
    x: 1 / (radii.x * radii.x),
    y: 1 / (radii.y * radii.y),
    z: 1 / (radii.z * radii.z),
  };
  const qa =
    direction.x ** 2 * inv2.x +
    direction.y ** 2 * inv2.y +
    direction.z ** 2 * inv2.z;
  const qb =
    2 *
    (moon.x * direction.x * inv2.x +
      moon.y * direction.y * inv2.y +
      moon.z * direction.z * inv2.z);
  const qc =
    moon.x ** 2 * inv2.x + moon.y ** 2 * inv2.y + moon.z ** 2 * inv2.z - 1;
  const disc = qb * qb - 4 * qa * qc;
  if (!(disc >= 0)) throw new Error("eclipse axis misses WGS84");
  const roots = [
    (-qb - Math.sqrt(disc)) / (2 * qa),
    (-qb + Math.sqrt(disc)) / (2 * qa),
  ]
    .filter((root) => root > 0)
    .sort((a, b) => a - b);
  if (!roots.length) throw new Error("eclipse axis has no forward WGS84 root");
  const surface = C.Cartesian3.add(
    moon,
    C.Cartesian3.multiplyByScalar(direction, roots[0], new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const centre = C.Ellipsoid.WGS84.cartesianToCartographic(
    surface,
    new C.Cartographic(),
  );
  const destination = C.Ellipsoid.WGS84.cartographicToCartesian(
    new C.Cartographic(
      centre.longitude,
      centre.latitude,
      contract.cameraHeightMeters,
    ),
  );
  const target = C.Ellipsoid.WGS84.cartographicToCartesian(
    new C.Cartographic(
      centre.longitude,
      centre.latitude,
      contract.terrainMeters,
    ),
  );
  const enu = C.Transforms.eastNorthUpToFixedFrame(
    target,
    C.Ellipsoid.WGS84,
    new C.Matrix4(),
  );
  const north4 = C.Matrix4.getColumn(enu, 1, new C.Cartesian4());
  const cameraDirection = C.Cartesian3.normalize(
    C.Cartesian3.subtract(target, destination, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const north = new C.Cartesian3(north4.x, north4.y, north4.z);
  const right = C.Cartesian3.normalize(
    C.Cartesian3.cross(cameraDirection, north, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  const up = C.Cartesian3.normalize(
    C.Cartesian3.cross(right, cameraDirection, new C.Cartesian3()),
    new C.Cartesian3(),
  );
  scene.camera.frustum.fov = C.Math.toRadians(contract.cameraFovDegrees);
  scene.camera.setView({
    destination,
    orientation: { direction: cameraDirection, up },
  });

  const nextFrame = () =>
    new Promise((resolve) => requestAnimationFrame(resolve));
  const render = () => scene.render(pinnedTime);
  const selectedTiles = () => [
    ...(globe._surface?.tileProvider?._quadtree?._tilesToRender ?? []),
  ];
  const selectedIds = () =>
    selectedTiles()
      .map((tile) => `${tile.level}/${tile.x}/${tile.y}`)
      .sort();
  const payload = () => {
    const block = scene.frameState?.eclipseGlobeShadow;
    if (!block) return [];
    return [
      block.sunDirectionAndInvRange.x,
      block.sunDirectionAndInvRange.y,
      block.sunDirectionAndInvRange.z,
      block.sunDirectionAndInvRange.w,
      block.moonDirectionDeltaAndInvRange.x,
      block.moonDirectionDeltaAndInvRange.y,
      block.moonDirectionDeltaAndInvRange.z,
      block.moonDirectionDeltaAndInvRange.w,
      block.params.x,
      block.params.y,
      block.params.z,
      block.params.w,
      block.params2.x,
      block.params2.y,
      block.params2.z,
      block.params2.w,
    ].map(Math.fround);
  };
  const active = () =>
    scene.frameState?.eclipseGlobeShadowPrepared === true &&
    scene.frameState?.eclipseGlobeShadow?.params?.x > 0.5 &&
    selectedTiles().length > 0;
  const settle = async (predicate, maximum, label) => {
    for (let frame = 0; frame < maximum; frame++) {
      render();
      if (predicate()) return frame + 1;
      await nextFrame();
    }
    throw new Error(`${label} did not settle in ${maximum} frames`);
  };
  const capture = async (label) => {
    render();
    const dataUrl = canvas.toDataURL("image/png");
    const scratch = document.createElement("canvas");
    scratch.width = contract.sampleWidth;
    scratch.height = contract.sampleHeight;
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, contract.sampleWidth, contract.sampleHeight);
    const rgba = Array.from(
      ctx.getImageData(0, 0, contract.sampleWidth, contract.sampleHeight).data,
    );
    let nonBlackPixels = 0;
    let luminance = 0;
    for (let index = 0; index < rgba.length; index += 4) {
      if (rgba[index] || rgba[index + 1] || rgba[index + 2]) nonBlackPixels++;
      luminance +=
        0.2126 * rgba[index] +
        0.7152 * rgba[index + 1] +
        0.0722 * rgba[index + 2];
    }
    return {
      label,
      width: canvas.width,
      height: canvas.height,
      dataUrl,
      nonBlackPixels,
      meanLuminance: luminance / (contract.sampleWidth * contract.sampleHeight),
      sampleRgba: rgba,
    };
  };
  const snapshot = async (label) => ({
    frameNumber: scene.frameState.frameNumber,
    selectionRevision: scene.frameState.eclipseGlobeShadowSelectionRevision,
    surfaceRadius: scene.frameState.eclipseGlobeShadowSurfaceRadius,
    selectedTileIds: selectedIds(),
    providerToken: "provider-1",
    s5: {
      prepared: scene.frameState.eclipseGlobeShadowPrepared === true,
      revision: scene.frameState.eclipseGlobeShadow.revision,
      gate: scene.frameState.eclipseGlobeShadow.params.x,
      payload: payload(),
    },
    image: await capture(label),
  });
  const sameArray = (left, right) =>
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));
  const imageDelta = (left, right) => {
    let absolute = 0;
    let changed = 0;
    for (let i = 0; i < left.length; i += 4) {
      const delta =
        Math.abs(left[i] - right[i]) +
        Math.abs(left[i + 1] - right[i + 1]) +
        Math.abs(left[i + 2] - right[i + 2]);
      absolute += delta / 3;
      if (delta > 9) changed++;
    }
    return {
      meanAbsoluteDelta: absolute / (left.length / 4),
      changedPixelShare: changed / (left.length / 4),
    };
  };
  await settle(
    active,
    contract.maximumSettleFrames,
    `${contract.renderer} active S5 terrain`,
  );
  const owner = {
    scene,
    context,
    canvas,
    canvasContext: context._context,
    view: scene._view,
    globe,
    provider,
  };

  if (contract.renderer === "webgl") {
    mark(contract.controlPhases[0], "capture-before-gap");
    const before = await snapshot("control-before");
    complete(contract.controlPhases[0]);
    mark(contract.controlPhases[1], "request-animation-frame-gap");
    const gapStart = performance.now();
    for (let frame = 0; frame < contract.controlGapFrames; frame++)
      await nextFrame();
    await settle(
      active,
      contract.maximumSettleFrames,
      "WebGL post-gap S5 terrain",
    );
    const afterGap = await snapshot("control-after-gap");
    const gapElapsed = performance.now() - gapStart;
    complete(contract.controlPhases[1]);
    const delta = imageDelta(
      before.image.sampleRgba,
      afterGap.image.sampleRgba,
    );
    return {
      renderer: "webgl",
      progress,
      before,
      afterGap,
      gap: {
        requestedFrames: contract.controlGapFrames,
        observedFrames: contract.controlGapFrames,
        elapsedMs: gapElapsed,
        triggerInvocations: 0,
      },
      continuity: {
        sameScene: scene === owner.scene,
        sameContext: scene.context === owner.context,
        sameCanvas: scene.canvas === owner.canvas,
        sameView: scene._view === owner.view,
        sameProvider: globe.terrainProvider === owner.provider,
        frameAdvanced: afterGap.frameNumber > before.frameNumber,
        terrainExact: sameArray(
          before.selectedTileIds,
          afterGap.selectedTileIds,
        ),
        s5PayloadExact: sameArray(before.s5.payload, afterGap.s5.payload),
        renderComparable:
          delta.meanAbsoluteDelta <= contract.controlMaximumMeanAbsoluteDelta &&
          delta.changedPixelShare <= contract.controlMaximumChangedPixelShare,
      },
      listenersRemoved: true,
    };
  }

  const native = globalThis.__c1229S5ReplacementNative;
  if (!native)
    throw new Error(
      "native resource ledger was not installed before viewer construction",
    );
  const oldDevice = context._device;
  const oldAdapter = context._adapter;
  const oldGeneration = context.resourceGeneration;
  native.trackDevice(oldDevice, "D0");
  globalThis.__armWebGPUDevice?.(oldDevice, "replacement-D0");

  const modelPosition = C.Ellipsoid.WGS84.cartographicToCartesian(
    new C.Cartographic(
      centre.longitude,
      centre.latitude,
      contract.terrainMeters + 100,
    ),
  );
  const model = await C.Model.fromGltfAsync({
    url: contract.tinyModelRoute,
    modelMatrix: C.Transforms.eastNorthUpToFixedFrame(
      modelPosition,
      C.Ellipsoid.WGS84,
    ),
    scale: 1,
  });
  scene.primitives.add(model);
  await settle(
    () => model.ready === true,
    contract.maximumSettleFrames,
    "pre-loss retained model",
  );
  const manager = model.environmentMapManager;
  manager.enabled = true;
  manager.enableSceneCapture = false;
  render();
  owner.model = model;
  owner.manager = manager;

  mark(contract.webgpuPhases[0], "inspect-normal-termination-hook");
  const benchmark = globalThis.chrome?.gpuBenchmarking;
  const methodValue = benchmark?.terminateGpuProcessNormally;
  const eligibility = {
    secureContext: globalThis.isSecureContext === true,
    navigatorGpu: Boolean(navigator.gpu),
    objectPath: "chrome.gpuBenchmarking",
    objectPresent: Boolean(benchmark),
    method: "terminateGpuProcessNormally",
    methodType:
      typeof methodValue === "function"
        ? "function"
        : methodValue === undefined
          ? "undefined"
          : "other",
    launchFlag: "--enable-gpu-benchmarking",
    eligible:
      globalThis.isSecureContext === true &&
      Boolean(navigator.gpu) &&
      Boolean(benchmark) &&
      typeof methodValue === "function",
  };
  complete(contract.webgpuPhases[0]);
  if (!eligibility.eligible) {
    return {
      renderer: "webgpu",
      progress,
      classification: "hook-unavailable",
      eligibility,
      before: null,
      trigger: null,
      loss: null,
      recovery: null,
      identity: null,
      generations: null,
      invalidation: null,
      ledger: null,
      terrain: null,
      render: null,
      pick: null,
      capture: null,
      listenersRemoved: true,
    };
  }

  const recoveryEvents = [];
  const invalidationOrdinals = [];
  const removeLoss = context.onDeviceLost((info) =>
    recoveryEvents.push({
      reason: String(info.reason ?? "unknown"),
      state: String(info.state ?? "unknown"),
      willRecover: Boolean(info.willRecover),
    }),
  );
  const removeInvalidation = context.onDeviceInvalidated(() =>
    invalidationOrdinals.push(native.mark("invalidation")),
  );
  let listenersRemoved = false;
  try {
    mark(contract.webgpuPhases[1], "capture-D0-carrier-and-terrain");
    native.setStage("before-loss");
    const before = await snapshot("webgpu-before-loss");
    const beforeProof = native.proof("D0", before.s5.payload, {
      requireScenePass: true,
    });
    complete(contract.webgpuPhases[1]);

    mark(contract.webgpuPhases[2], "invoke-normal-GPU-process-termination");
    native.setStage("loss-pending");
    const lossStart = performance.now();
    const lossPromise = oldDevice.lost.then((info) => {
      native.setStage("after-loss");
      native.mark("loss");
      return {
        reason: String(info?.reason ?? "unknown"),
        message: String(info?.message ?? ""),
      };
    });
    let invoked = 0;
    let returned = false;
    console.info(contract.recoveryIntervalBeginMarker);
    invoked++;
    Reflect.apply(methodValue, benchmark, []);
    returned = true;
    const lossInfo = await Promise.race([
      lossPromise,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "normal GPU-process termination did not resolve D0 device.lost",
              ),
            ),
          contract.maximumRecoveryMs,
        ),
      ),
    ]);
    const loss = {
      observed: true,
      reason: lossInfo.reason,
      message: lossInfo.message,
      recoverable: lossInfo.reason !== "destroyed",
      eventCount: 1,
      elapsedMs: performance.now() - lossStart,
      classification:
        lossInfo.reason === "destroyed"
          ? "destroyed-terminal-not-replacement"
          : "replacement",
    };
    const trigger = {
      objectPath: "chrome.gpuBenchmarking",
      method: "terminateGpuProcessNormally",
      invocations: invoked,
      returned,
      destroyCalls: 0,
      crashHookCalls: 0,
      onlyAuthorizedTrigger: invoked === 1,
    };
    if (lossInfo.reason === "destroyed") {
      console.info(contract.recoveryIntervalEndMarker);
      complete(contract.webgpuPhases[2]);
      removeLoss();
      removeInvalidation();
      listenersRemoved = true;
      return {
        renderer: "webgpu",
        progress,
        classification: "destroyed-not-replacement",
        eligibility,
        before,
        trigger,
        loss,
        recovery: null,
        identity: null,
        generations: null,
        invalidation: null,
        ledger: null,
        terrain: null,
        render: null,
        pick: null,
        capture: null,
        listenersRemoved,
      };
    }

    const recoveryStart = performance.now();
    for (;;) {
      if (
        context._device &&
        context._device !== oldDevice &&
        context.resourceGeneration === oldGeneration + 1 &&
        String(context.deviceLossState).toLowerCase() === "healthy" &&
        recoveryEvents.some((entry) => entry.reason === "recovered")
      )
        break;
      if (performance.now() - recoveryStart > contract.maximumRecoveryMs)
        throw new Error("replacement device did not become healthy in time");
      await nextFrame();
    }
    complete(contract.webgpuPhases[2]);

    mark(contract.webgpuPhases[3], "bind-fresh-D1-generation");
    const newDevice = context._device;
    const newAdapter = context._adapter;
    native.trackDevice(newDevice, "D1");
    globalThis.__armWebGPUDevice?.(newDevice, "replacement-D1");
    native.mark("healthy");
    native.setStage("replacement-healthy");
    console.info(contract.recoveryIntervalEndMarker);
    const recovery = {
      healthy: String(context.deviceLossState).toLowerCase() === "healthy",
      state: String(context.deviceLossState),
      attempts: context.recoveryAttempts,
      elapsedMs: performance.now() - recoveryStart,
      deviceLostEvents: recoveryEvents.filter(
        (entry) => entry.reason !== "recovered",
      ).length,
      recoveredEvents: recoveryEvents.filter(
        (entry) => entry.reason === "recovered",
      ).length,
    };
    const identity = {
      sameScene: scene === owner.scene,
      sameContext: scene.context === owner.context,
      sameCanvas: scene.canvas === owner.canvas,
      sameCanvasContext: context._context === owner.canvasContext,
      sameView: scene._view === owner.view,
      sameGlobe: scene.globe === owner.globe,
      sameProvider: globe.terrainProvider === owner.provider,
      sameModel: model === owner.model,
      sameManager: manager === owner.manager,
      freshAdapter: newAdapter !== oldAdapter,
      freshDevice: newDevice !== oldDevice,
    };
    const generations = {
      before: oldGeneration,
      after: context.resourceGeneration,
      delta: context.resourceGeneration - oldGeneration,
    };
    const lossMark = native.mark("retirement-observed");
    void lossMark;
    complete(contract.webgpuPhases[3]);

    mark(contract.webgpuPhases[4], "render-terrain-S5-on-D1");
    await settle(
      () =>
        active() &&
        selectedIds().join("|") === before.selectedTileIds.join("|"),
      contract.maximumSettleFrames,
      "D1 terrain/S5 continuity",
    );
    const after = await snapshot("webgpu-replacement-render");
    const delta = imageDelta(before.image.sampleRgba, after.image.sampleRgba);
    const terrain = {
      before,
      after,
      sameProvider: globe.terrainProvider === owner.provider,
      selectedIdsExact: sameArray(
        before.selectedTileIds,
        after.selectedTileIds,
      ),
      surfaceRadiusExact: Object.is(before.surfaceRadius, after.surfaceRadius),
      s5PayloadExact: sameArray(before.s5.payload, after.s5.payload),
      activeBoth: before.s5.gate > 0.5 && after.s5.gate > 0.5,
    };
    const renderResult = {
      beforeImage: before.image,
      afterImage: after.image,
      meanAbsoluteDelta: delta.meanAbsoluteDelta,
      changedPixelShare: delta.changedPixelShare,
      comparable:
        delta.meanAbsoluteDelta <=
          contract.replacementMaximumMeanAbsoluteDelta &&
        delta.changedPixelShare <= contract.replacementMaximumChangedPixelShare,
      nonVacuous:
        before.image.nonBlackPixels >= contract.minimumNonBlackSamplePixels &&
        after.image.nonBlackPixels >= contract.minimumNonBlackSamplePixels,
    };
    complete(contract.webgpuPhases[4]);

    mark(contract.webgpuPhases[5], "real-scene-pickAsync-on-D1");
    const pickableBefore = globe.pickable;
    globe.pickable = true;
    render();
    let pickSettled = false;
    let picked;
    let pickError;
    const operation = scene.pickAsync(
      new C.Cartesian2(canvas.width / 2, canvas.height / 2),
    );
    operation.then(
      (value) => {
        picked = value;
        pickSettled = true;
      },
      (error) => {
        pickError = error;
        pickSettled = true;
      },
    );
    let pickFrames = 0;
    while (!pickSettled && pickFrames < contract.maximumPickFrames) {
      render();
      pickFrames++;
      await nextFrame();
    }
    globe.pickable = pickableBefore;
    if (!pickSettled)
      throw new Error("replacement scene.pickAsync did not settle");
    if (pickError) throw pickError;
    const pick = {
      method: "scene.pickAsync",
      invoked: true,
      awaited: true,
      settled: pickSettled,
      renderPumpFrames: pickFrames,
      resultKind: picked?.primitive === globe ? "globe" : typeof picked,
      resultPrimitiveIdentity: picked?.primitive === globe,
      sameScene: scene === owner.scene,
      sameContext: scene.context === owner.context,
      s5Active: scene.frameState.eclipseGlobeShadow?.params?.x > 0.5,
      generation: context.resourceGeneration,
    };
    complete(contract.webgpuPhases[5]);

    mark(contract.webgpuPhases[6], "manager-driven-retained-capture-on-D1");
    context._options.webgpu ??= {};
    context._options.webgpu.sceneCaptureReflections = true;
    // Correlate one descriptor produced by the retained-capture path with the
    // exact native setBindGroup/writeBuffer proof. A generic D1 main-frame
    // bind is insufficient to certify the capture carrier.
    for (let frame = 0; frame < 4; frame++) {
      render();
      await nextFrame();
    }
    const captureGlobeRenderer =
      context._webgpuSceneCaptureSources?.globeRenderer;
    const originalCaptureCommands =
      captureGlobeRenderer?.getOrCreateCaptureTileCommands;
    if (typeof originalCaptureCommands !== "function") {
      throw new Error("retained-capture globe command producer is unavailable");
    }
    const withMethodPatch = globalThis.__withC1229S5ReplacementMethodPatch;
    if (typeof withMethodPatch !== "function") {
      throw new Error("retained-capture method-patch guard is unavailable");
    }
    const captureDescriptors = [];
    const captureWrapper = function (...args) {
      const commands = originalCaptureCommands.apply(this, args);
      for (const command of commands ?? []) {
        const offsets = Array.from(
          command.bindGroup0DynamicOffsets ?? [],
          Number,
        );
        captureDescriptors.push({
          bindGroupToken: native.bindGroupToken(command.bindGroups?.[0]),
          dynamicOffsets: offsets,
          descriptorOrdinal: native.mark("capture-descriptor"),
          positiveDraw: command.indexCount > 0,
        });
      }
      return commands;
    };
    let captureFrames = 0;
    let captureProof;
    let captureDescriptor;
    await withMethodPatch(
      captureGlobeRenderer,
      "getOrCreateCaptureTileCommands",
      captureWrapper,
      async () => {
        const captureStartOrdinal = native.mark("capture-native-start");
        native.setStage("replacement-capture");
        manager.enableSceneCapture = true;
        manager.reset();
        while (
          manager._webgpuCache?.lastSceneCaptureResult !== 2 &&
          captureFrames < contract.maximumCaptureFrames
        ) {
          render();
          captureFrames++;
          await nextFrame();
        }
        captureDescriptor = [...captureDescriptors]
          .reverse()
          .find(
            (entry) =>
              entry.positiveDraw &&
              typeof entry.bindGroupToken === "string" &&
              entry.dynamicOffsets.length === 3 &&
              entry.dynamicOffsets.every(Number.isInteger) &&
              Number.isInteger(entry.descriptorOrdinal),
          );
        if (!captureDescriptor) {
          throw new Error(
            "retained capture emitted no witnessed terrain command",
          );
        }
        captureProof = native.proof("D1", after.s5.payload, {
          requiredBindGroupToken: captureDescriptor.bindGroupToken,
          requiredDynamicOffsets: captureDescriptor.dynamicOffsets,
          descriptorOrdinal: captureDescriptor.descriptorOrdinal,
          requireCapturePass: true,
          minimumBindOrdinal: captureStartOrdinal,
        });
      },
    );
    const captureSources = context._webgpuSceneCaptureSources;
    const captureSelected = [
      ...(captureSources?.tileProvider?._quadtree?._tilesToRender ?? []),
    ];
    const captureStatus = manager._webgpuCache?.lastSceneCaptureResult ?? 0;
    const submitted = captureStatus === 2;
    const removed = scene.primitives.remove(model);
    render();
    const capture = {
      managerDriven: true,
      directHelperCall: false,
      sameModel: model === owner.model,
      sameManager: manager === owner.manager,
      submitted,
      statusCode: captureStatus,
      settleFrames: captureFrames,
      selectedTileCount: captureSelected.length,
      s5Active: scene.frameState.eclipseGlobeShadow?.params?.x > 0.5,
      generation: context.resourceGeneration,
      d1Binding2Observed:
        captureProof.deviceToken === native.trackDevice(newDevice, "D1") &&
        captureProof.bindGroupToken === captureDescriptor.bindGroupToken &&
        captureProof.descriptorOrdinal ===
          captureDescriptor.descriptorOrdinal &&
        captureProof.dynamicOffsets.every((value, index) =>
          Object.is(value, captureDescriptor.dynamicOffsets[index]),
        ) &&
        /^DynEnvMap Capture Face [0-5]$/u.test(captureProof.passLabel) &&
        captureProof.bindOrdinal > captureDescriptor.descriptorOrdinal &&
        captureProof.bindOrdinal < captureProof.uploadOrdinal &&
        captureProof.uploadOrdinal < captureProof.finishOrdinal &&
        captureProof.finishOrdinal < captureProof.submitOrdinal,
      modelRemoved: removed && !scene.primitives.contains(model),
      modelDestroyed: model.isDestroyed?.() === true,
      captureSourcesCleared:
        context._webgpuSceneCaptureModels == null ||
        !context._webgpuSceneCaptureModels?.includes?.(model),
    };
    complete(contract.webgpuPhases[6]);

    removeLoss();
    removeInvalidation();
    listenersRemoved = true;
    const ledgerWithSequence = native.finalize(beforeProof, captureProof);
    return {
      renderer: "webgpu",
      progress,
      classification: "eligible-replacement",
      eligibility,
      before,
      trigger,
      loss,
      recovery,
      identity,
      generations,
      invalidation: {
        count: invalidationOrdinals.length,
        ordinals: invalidationOrdinals,
        afterLossBeforeHealthy:
          invalidationOrdinals.length === 1 &&
          invalidationOrdinals[0] > ledgerWithSequence.retirement.lossOrdinal &&
          invalidationOrdinals[0] <
            ledgerWithSequence.retirement.healthyOrdinal,
      },
      ledgerWithSequence,
      terrain,
      render: renderResult,
      pick,
      capture,
      listenersRemoved,
    };
  } finally {
    if (!listenersRemoved) {
      try {
        removeLoss();
      } catch {
        /* preserve primary error */
      }
      try {
        removeInvalidation();
      } catch {
        /* preserve primary error */
      }
    }
  }
};

function fileIdentity(relativePath) {
  const bytes = fs.readFileSync(path.join(repositoryRoot, relativePath));
  return {
    path: relativePath,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
}

async function servedIdentity(origin, relativePath) {
  const url = new URL(`/${relativePath}`, origin);
  const response = await fetch(url, { cache: "no-store", redirect: "error" });
  if (!response.ok)
    throw new Error(`${url.href} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    path: relativePath,
    url: url.href,
    status: response.status,
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
  };
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

function collectLocalFiles() {
  return C12_29_S5_REPLACEMENT_LOCAL_FILES.map(fileIdentity);
}

async function collectProvenanceStart(baseIdentity, launch) {
  const localStart = collectLocalFiles();
  const served = [];
  for (const file of C12_29_S5_REPLACEMENT_SERVED_FILES)
    served.push(await servedIdentity(baseIdentity.origin, file));
  const identity = inspectBuildSourceIdentity({
    sourceMapPath: buildSourceMapPath,
    sourceFiles: C12_29_S5_REPLACEMENT_SOURCE_FILES.map((file) =>
      path.join(repositoryRoot, file),
    ),
  });
  const servedMatchesLocal = C12_29_S5_REPLACEMENT_SERVED_FILES.every(
    (servedPath) => {
      const local = localStart.find((entry) => entry.path === servedPath);
      const response = served.find((entry) => entry.path === servedPath);
      return (
        local?.byteLength === response?.byteLength &&
        local?.sha256 === response?.sha256
      );
    },
  );
  return {
    schema: C12_29_S5_REPLACEMENT_PROVENANCE_SCHEMA,
    gitHead: safeGitHead(),
    localStart,
    localEnd: [],
    served,
    buildSourceIdentity: {
      ok: identity.ok,
      sourceMapByteLength: identity.sourceMapByteLength,
      sourceMapSha256: identity.sourceMapSha256,
      entryCount: identity.entries.length,
      entries: identity.entries.map((entry, index) => {
        const sourcePath = C12_29_S5_REPLACEMENT_SOURCE_FILES[index];
        const local = localStart.find((item) => item.path === sourcePath);
        return {
          path: sourcePath,
          sourceMapEntry: entry.sourceMapEntry ?? null,
          currentByteLength: entry.currentByteLength ?? local?.byteLength ?? 0,
          embeddedByteLength: entry.embeddedByteLength ?? null,
          currentSha256: entry.currentSha256,
          embeddedSha256: entry.embeddedSha256 ?? null,
          exact: entry.exact,
          reason: entry.reason,
        };
      }),
      reasons: identity.reasons,
    },
    stable: false,
    buildEntryMatchesServed:
      localStart.find(
        (entry) => entry.path === "Build/CesiumUnminified/index.js",
      )?.sha256 ===
        served.find((entry) => entry.path === "Build/CesiumUnminified/index.js")
          ?.sha256 &&
      localStart.find(
        (entry) => entry.path === "Build/CesiumUnminified/index.js",
      )?.byteLength ===
        served.find((entry) => entry.path === "Build/CesiumUnminified/index.js")
          ?.byteLength,
    servedMatchesLocal,
    launch,
  };
}

function finishProvenance(provenance) {
  provenance.localEnd = collectLocalFiles();
  provenance.stable =
    stableC1229S5ReplacementJson(provenance.localStart) ===
    stableC1229S5ReplacementJson(provenance.localEnd);
  return provenance;
}

function enrichImage(image) {
  const match = /^data:image\/png;base64,(.+)$/u.exec(image.dataUrl);
  if (!match) throw new Error(`${image.label} did not return a PNG data URL`);
  const bytes = Buffer.from(match[1], "base64");
  const rest = { ...image };
  delete rest.dataUrl;
  return { ...rest, byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

function enrichMeasurementImages(measured) {
  if (measured.before?.image?.dataUrl)
    measured.before.image = enrichImage(measured.before.image);
  if (measured.afterGap?.image?.dataUrl)
    measured.afterGap.image = enrichImage(measured.afterGap.image);
  if (measured.terrain) {
    if (measured.terrain.before?.image?.dataUrl)
      measured.terrain.before.image = enrichImage(
        measured.terrain.before.image,
      );
    if (measured.terrain.after?.image?.dataUrl)
      measured.terrain.after.image = enrichImage(measured.terrain.after.image);
  }
  if (measured.render) {
    measured.render.beforeImage = measured.terrain.before.image;
    measured.render.afterImage = measured.terrain.after.image;
  }
  // WebGPU's pre-loss snapshot is the same value later embedded in terrain.
  if (measured.before && measured.terrain)
    measured.before = measured.terrain.before;
  if (measured.ledgerWithSequence) {
    measured.ledger = measured.ledgerWithSequence;
    delete measured.ledgerWithSequence;
  }
  return measured;
}

function sessionContract(renderer) {
  return {
    renderer,
    runtimePath,
    progressSchema: C12_29_S5_REPLACEMENT_PAGE_PROGRESS_SCHEMA,
    controlPhases: [...C12_29_S5_REPLACEMENT_CONTROL_PHASES],
    webgpuPhases: [...C12_29_S5_REPLACEMENT_WEBGPU_PHASES],
    eventIso: C12_29_S5_REPLACEMENT_CONFIG.eventIso,
    viewport: { ...C12_29_S5_REPLACEMENT_CONFIG.viewport },
    terrainWidth: C12_29_S5_REPLACEMENT_CONFIG.terrainWidth,
    terrainHeight: C12_29_S5_REPLACEMENT_CONFIG.terrainHeight,
    terrainMeters: C12_29_S5_REPLACEMENT_CONFIG.terrainMeters,
    maximumScreenSpaceError:
      C12_29_S5_REPLACEMENT_CONFIG.maximumScreenSpaceError,
    cameraHeightMeters: C12_29_S5_REPLACEMENT_CONFIG.cameraHeightMeters,
    cameraFovDegrees: C12_29_S5_REPLACEMENT_CONFIG.cameraFovDegrees,
    controlGapFrames: C12_29_S5_REPLACEMENT_CONFIG.controlGapFrames,
    maximumSettleFrames: C12_29_S5_REPLACEMENT_CONFIG.maximumSettleFrames,
    maximumRecoveryMs: C12_29_S5_REPLACEMENT_CONFIG.maximumRecoveryMs,
    maximumPickFrames: C12_29_S5_REPLACEMENT_CONFIG.maximumPickFrames,
    maximumCaptureFrames: C12_29_S5_REPLACEMENT_CONFIG.maximumCaptureFrames,
    sampleWidth: C12_29_S5_REPLACEMENT_CONFIG.sampleWidth,
    sampleHeight: C12_29_S5_REPLACEMENT_CONFIG.sampleHeight,
    minimumNonBlackSamplePixels:
      C12_29_S5_REPLACEMENT_CONFIG.minimumNonBlackSamplePixels,
    controlMaximumMeanAbsoluteDelta:
      C12_29_S5_REPLACEMENT_CONFIG.controlMaximumMeanAbsoluteDelta,
    controlMaximumChangedPixelShare:
      C12_29_S5_REPLACEMENT_CONFIG.controlMaximumChangedPixelShare,
    replacementMaximumMeanAbsoluteDelta:
      C12_29_S5_REPLACEMENT_CONFIG.replacementMaximumMeanAbsoluteDelta,
    replacementMaximumChangedPixelShare:
      C12_29_S5_REPLACEMENT_CONFIG.replacementMaximumChangedPixelShare,
    tinyModelRoute: C12_29_S5_REPLACEMENT_CONFIG.tinyModelRoute,
    recoveryIntervalBeginMarker:
      C12_29_S5_REPLACEMENT_CONFIG.recoveryIntervalBeginMarker,
    recoveryIntervalEndMarker:
      C12_29_S5_REPLACEMENT_CONFIG.recoveryIntervalEndMarker,
  };
}

async function closeBounded(
  instance,
  label,
  timeoutMs = SESSION_CLOSE_TIMEOUT_MS,
) {
  if (!instance)
    return { label, attempted: false, closed: true, timedOut: false };
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
        () => resolve({ closed: false, timedOut: true }),
        timeoutMs,
      );
    }),
  ]);
  clearTimeout(timer);
  return { label, attempted: true, ...result };
}

function progressFrom(value, renderer) {
  const candidate = value && JSON.parse(JSON.stringify(value));
  return validateC1229S5ReplacementPageProgress(candidate).ok &&
    candidate.renderer === renderer
    ? candidate
    : null;
}

async function captureWatchdogCheckpoint(watchdogState) {
  const current = watchdogState?.current;
  if (!current?.renderer) return null;
  let progress = current.pageProgress ?? null;
  if (current.page && !current.page.isClosed?.()) {
    let timer;
    try {
      const raw = await Promise.race([
        current.page.evaluate(
          () => globalThis.__c1229S5ReplacementProgress ?? null,
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), 2_000);
        }),
      ]);
      progress = progressFrom(raw, current.renderer) ?? progress;
    } catch {
      /* retain the last already-materialized checkpoint */
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    stage: current.renderer === "webgl" ? "control-page" : "webgpu-page",
    phase: progress?.currentPhase ?? "preflight",
    renderer: current.renderer,
    kind: "timeout",
    timeoutMs: null,
    pageProgress: progress,
  };
}

async function runBrowserSession(
  browser,
  renderer,
  baseIdentity,
  watchdogState,
) {
  const browserContext = await browser.newContext({
    viewport: { ...C12_29_S5_REPLACEMENT_CONFIG.viewport },
    deviceScaleFactor: 1,
  });
  const externalRequests = [];
  const failedRequests = [];
  const httpErrors = [];
  const pageErrors = [];
  const consoleErrors = [];
  const expectedRecoveryConsole = [];
  const expectedPoolRecoveryConsole = [];
  const recoveryConsoleInterval = {
    beginCount: 0,
    endCount: 0,
    openAtEnd: false,
  };
  const pending = new Set();
  await browserContext.route("**/*", async (route) => {
    let url;
    try {
      url = new URL(route.request().url());
    } catch {
      await route.continue();
      return;
    }
    if (/^https?:$/u.test(url.protocol) && url.origin !== baseIdentity.origin) {
      externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  const page = await browserContext.newPage();
  if (watchdogState) {
    watchdogState.current = {
      renderer,
      page,
      browserContext,
      pending,
      pageProgress: null,
    };
  }
  await page.addInitScript(errorGateInit);
  if (renderer === "webgpu") {
    await page.addInitScript(installC1229S5ReplacementMethodPatch);
    await page.addInitScript(installC1229S5ReplacementNativeLedger);
  }
  page.on("request", (request) => pending.add(request));
  const settle = (request) => pending.delete(request);
  page.on("requestfinished", settle);
  page.on("requestfailed", (request) => {
    settle(request);
    if (!externalRequests.includes(request.url()))
      failedRequests.push(request.url());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      httpErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    if (
      renderer === "webgpu" &&
      text === C12_29_S5_REPLACEMENT_CONFIG.recoveryIntervalBeginMarker
    ) {
      recoveryConsoleInterval.beginCount++;
      if (recoveryConsoleInterval.openAtEnd) {
        consoleErrors.push("duplicate recovery-console interval begin marker");
      }
      recoveryConsoleInterval.openAtEnd = true;
      return;
    }
    if (
      renderer === "webgpu" &&
      text === C12_29_S5_REPLACEMENT_CONFIG.recoveryIntervalEndMarker
    ) {
      recoveryConsoleInterval.endCount++;
      if (!recoveryConsoleInterval.openAtEnd) {
        consoleErrors.push("recovery-console interval ended while closed");
      }
      recoveryConsoleInterval.openAtEnd = false;
      return;
    }
    if (message.type() !== "error" && message.type() !== "warning") return;
    if (
      renderer === "webgpu" &&
      recoveryConsoleInterval.openAtEnd &&
      CONTEXT_DEVICE_LOSS_CONSOLE.test(text)
    ) {
      expectedRecoveryConsole.push(text);
    } else if (
      renderer === "webgpu" &&
      recoveryConsoleInterval.openAtEnd &&
      POOL_DEVICE_LOSS_CONSOLE.test(text)
    ) {
      expectedPoolRecoveryConsole.push(text);
    } else {
      // Every non-allowlisted error/warning is evidence. Silently filtering a
      // message by vocabulary would permit an unrelated runtime fault to pass.
      consoleErrors.push(`${message.type()}: ${text}`);
    }
  });
  let measured;
  let primaryError;
  let capturedProgress = null;
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
    if (renderer === "webgpu") await armWebGPUDevices(page);
    measured = await Promise.race([
      page.evaluate(
        MEASURE_C1229_S5_REPLACEMENT_SESSION,
        sessionContract(renderer),
      ),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`${renderer} replacement-device page timeout`)),
          C12_29_S5_REPLACEMENT_CONFIG.pageTimeoutMs,
        ),
      ),
    ]);
    capturedProgress = progressFrom(measured.progress, renderer);
    if (watchdogState?.current)
      watchdogState.current.pageProgress = capturedProgress;
  } catch (error) {
    primaryError = error;
    try {
      capturedProgress = progressFrom(
        await page.evaluate(
          () => globalThis.__c1229S5ReplacementProgress ?? null,
        ),
        renderer,
      );
      if (watchdogState?.current)
        watchdogState.current.pageProgress = capturedProgress;
    } catch {
      /* page may be gone */
    }
  }
  let gate = { errors: [], deviceLost: null, armedDevices: 0 };
  if (!primaryError && renderer === "webgpu") {
    gate = await collectGateErrors(page);
    // D0 loss is expected and independently classified. The shared gate keeps
    // its first non-destroyed loss string; it is not an unexpected D1 loss.
    if (
      measured.classification === "eligible-replacement" &&
      gate.deviceLost ===
        `[replacement-${measured.ledgerWithSequence.devices[0].token}] device lost: reason=${measured.loss.reason} message=${measured.loss.message}`
    ) {
      gate.deviceLost = null;
    }
  }
  const pageClose = await closeBounded(page, `${renderer} page`);
  const contextClose = await closeBounded(
    browserContext,
    `${renderer} context`,
  );
  const runtime = {
    schema: C12_29_S5_REPLACEMENT_RUNTIME_DIAGNOSTICS_SCHEMA,
    renderer,
    pageErrors,
    consoleErrors,
    expectedRecoveryConsole,
    expectedPoolRecoveryConsole,
    recoveryConsoleInterval,
    gpuErrors: gate.errors,
    unexpectedDeviceLoss: gate.deviceLost,
    externalRequests,
    failedRequests,
    httpErrors,
    pendingRequests: pending.size,
    armedDevices: gate.armedDevices,
  };
  if (primaryError || !pageClose.closed || !contextClose.closed) {
    const errors = [
      primaryError,
      pageClose.timedOut
        ? new Error(`${renderer} page close timed out`)
        : pageClose.error,
      contextClose.timedOut
        ? new Error(`${renderer} context close timed out`)
        : contextClose.error,
    ]
      .filter(Boolean)
      .map((value) => asError(value, `${renderer} session failed`));
    const error =
      errors.length === 1
        ? errors[0]
        : new AggregateError(errors, `${renderer} session and cleanup failed`);
    const primaryTimedOut =
      Boolean(primaryError) && /timeout/iu.test(primaryError.message);
    const cleanupTimedOut = pageClose.timedOut || contextClose.timedOut;
    error.c1229Replacement = {
      stage: renderer === "webgl" ? "control-page" : "webgpu-page",
      phase: capturedProgress?.currentPhase ?? "preflight",
      renderer,
      kind:
        primaryTimedOut || cleanupTimedOut
          ? "timeout"
          : primaryError
            ? "exception"
            : "cleanup",
      timeoutMs: primaryTimedOut
        ? C12_29_S5_REPLACEMENT_CONFIG.pageTimeoutMs
        : cleanupTimedOut
          ? SESSION_CLOSE_TIMEOUT_MS
          : null,
      pageProgress: capturedProgress,
    };
    if (watchdogState) watchdogState.current = null;
    throw error;
  }
  enrichMeasurementImages(measured);
  measured.runtime = runtime;
  measured.cleanup =
    renderer === "webgl"
      ? {
          complete:
            pageClose.closed && contextClose.closed && pending.size === 0,
          pageClosed: pageClose.closed,
          contextClosed: contextClose.closed,
          pendingRequestsDrained: pending.size === 0,
        }
      : {
          complete:
            pageClose.closed &&
            contextClose.closed &&
            pending.size === 0 &&
            measured.listenersRemoved,
          pageClosed: pageClose.closed,
          contextClosed: contextClose.closed,
          pendingRequestsDrained: pending.size === 0,
          listenersRemoved: measured.listenersRemoved,
        };
  delete measured.listenersRemoved;
  if (watchdogState) watchdogState.current = null;
  return measured;
}

export async function withC1229S5ReplacementWatchdog(
  operation,
  onTimeout,
  timeoutMs = WATCHDOG_MS,
) {
  let timer;
  let timingOut = false;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          (value) => (timingOut ? new Promise(() => {}) : value),
          (error) =>
            timingOut ? new Promise(() => {}) : Promise.reject(error),
        ),
      new Promise((_, reject) => {
        timer = setTimeout(async () => {
          timingOut = true;
          let cleanup;
          try {
            cleanup = await onTimeout();
          } catch (closeError) {
            const error = new AggregateError(
              [
                new Error(
                  `replacement-device watchdog expired after ${timeoutMs} ms`,
                ),
                closeError,
              ],
              "watchdog and browser close failed",
            );
            error.c1229Replacement = {
              stage: "watchdog",
              phase: "preflight",
              renderer: null,
              kind: "timeout",
              timeoutMs,
              pageProgress: null,
            };
            error.retainReplacementRunning = true;
            reject(error);
            return;
          }
          const checkpoint = cleanup?.checkpoint ?? null;
          const cleanupComplete = cleanup?.cleanupComplete === true;
          const error = new Error(
            cleanupComplete
              ? `replacement-device watchdog expired after ${timeoutMs} ms`
              : `replacement-device watchdog expired after ${timeoutMs} ms and cleanup remained unproven`,
          );
          error.c1229Replacement = checkpoint
            ? { ...checkpoint, kind: "timeout", timeoutMs }
            : {
                stage: "watchdog",
                phase: "preflight",
                renderer: null,
                kind: "timeout",
                timeoutMs,
                pageProgress: null,
              };
          if (!cleanupComplete) error.retainReplacementRunning = true;
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runC1229S5ReplacementDeviceProbe(options = {}) {
  const operations = options.operations ?? fs;
  const launchBrowser =
    options.launchBrowser ??
    ((launchOptions) => chromium.launch(launchOptions));
  const runId = options.runId ?? randomUUID();
  const paths = createC1229S5ReplacementArtifactPaths(
    runId,
    options.outputDirectory,
  );
  const baseIdentity = validateC1229S5ReplacementLoopbackBase(
    options.base ?? defaultBase,
  );
  let ownership;
  let browser;
  const watchdogState = { current: null };
  try {
    ownership = beginC1229S5ReplacementEvidenceRun(paths, runId, operations);
    const launch = {
      channel: process.env.PROBE_BROWSER_CHANNEL || "msedge",
      headless: process.env.PROBE_HEADED !== "1",
      args: [C12_29_S5_REPLACEMENT_CONFIG.launchFlag],
    };
    const provenance = await collectProvenanceStart(baseIdentity, launch);
    try {
      browser = await launchBrowser({ ...launch });
    } catch (caught) {
      const error =
        caught instanceof Error ? caught : new Error(String(caught));
      error.c1229Replacement = {
        stage: "browser-launch",
        phase: "preflight",
        renderer: null,
        kind: "exception",
        timeoutMs: null,
        pageProgress: null,
      };
      throw error;
    }
    const sessions = await withC1229S5ReplacementWatchdog(
      async () => {
        const control = await runBrowserSession(
          browser,
          "webgl",
          baseIdentity,
          watchdogState,
        );
        const webgpu = await runBrowserSession(
          browser,
          "webgpu",
          baseIdentity,
          watchdogState,
        );
        return { control, webgpu };
      },
      async () => {
        const checkpoint = await captureWatchdogCheckpoint(watchdogState);
        const pending = watchdogState.current?.pending;
        const closing = browser;
        browser = undefined;
        const closed = await closeBounded(
          closing,
          "watchdog browser",
          BROWSER_CLOSE_TIMEOUT_MS,
        );
        const pendingRequestsDrained = (pending?.size ?? 0) === 0;
        watchdogState.current = null;
        return {
          cleanupComplete: closed.closed && pendingRequestsDrained,
          checkpoint,
          closed,
          pendingRequestsDrained,
        };
      },
      options.watchdogMs ?? WATCHDOG_MS,
    );
    const closing = browser;
    browser = undefined;
    const browserClose = await closeBounded(
      closing,
      "replacement-device browser",
      BROWSER_CLOSE_TIMEOUT_MS,
    );
    if (!browserClose.closed) {
      const error = asError(
        browserClose.error,
        "replacement-device browser close timed out",
      );
      error.c1229Replacement = {
        stage: "node",
        phase: "preflight",
        renderer: null,
        kind: browserClose.timedOut ? "timeout" : "cleanup",
        timeoutMs: browserClose.timedOut ? BROWSER_CLOSE_TIMEOUT_MS : null,
        pageProgress: null,
      };
      error.retainReplacementRunning = true;
      throw error;
    }
    finishProvenance(provenance);
    const report = {
      schema: C12_29_S5_REPLACEMENT_SCHEMA,
      runId,
      incomplete: false,
      contract: C12_29_S5_REPLACEMENT_CONTRACT,
      phaseOrder: [...C12_29_S5_REPLACEMENT_PHASES],
      provenance,
      control: sessions.control,
      webgpu: sessions.webgpu,
      cleanup: {
        complete:
          browserClose.closed &&
          sessions.control.cleanup.complete &&
          sessions.webgpu.cleanup.complete,
        browserClosed: browserClose.closed,
        contextsClosed:
          sessions.control.cleanup.contextClosed &&
          sessions.webgpu.cleanup.contextClosed,
        pagesClosed:
          sessions.control.cleanup.pageClosed &&
          sessions.webgpu.cleanup.pageClosed,
      },
    };
    const verdict = foldC1229S5ReplacementDeviceGate(report);
    const artifact = {
      ...report,
      status: verdict.status,
      exitCode: verdict.exitCode,
      reasons: {
        structural: verdict.structuralReasons,
        failures: verdict.failureReasons,
      },
      checks: verdict.checks,
    };
    const valid = validateC1229S5ReplacementFinalArtifact(artifact);
    if (!valid.ok)
      throw new Error(
        `replacement-device self-validation failed: ${valid.reasons.join("; ")}`,
      );
    const publication = finalizeC1229S5ReplacementEvidence(
      paths,
      artifact,
      ownership,
      operations,
    );
    return { artifact, publication, paths };
  } catch (caught) {
    let error = caught;
    if (browser) {
      const closing = browser;
      browser = undefined;
      const closed = await closeBounded(
        closing,
        "replacement-device error browser",
        BROWSER_CLOSE_TIMEOUT_MS,
      );
      if (!closed.closed) {
        const aggregate = new AggregateError(
          [error, closed.error ?? new Error("browser close timed out")],
          "probe and browser cleanup failed",
        );
        aggregate.c1229Replacement = error?.c1229Replacement ?? {
          stage: "node",
          phase: "preflight",
          renderer: null,
          kind: closed.timedOut ? "timeout" : "cleanup",
          timeoutMs: closed.timedOut ? BROWSER_CLOSE_TIMEOUT_MS : null,
          pageProgress: null,
        };
        aggregate.retainReplacementRunning = true;
        error = aggregate;
      }
    }
    if (!ownership || error?.retainReplacementRunning) throw error;
    const detail = error.c1229Replacement ?? {};
    const rawMessage = String(error?.message ?? error ?? "");
    const boundedMessage =
      rawMessage.length > 0
        ? rawMessage.slice(0, 4096)
        : "Unknown replacement-device probe error";
    const diagnostics = createC1229S5ReplacementErrorDiagnostics({
      stage: detail.stage ?? "node",
      phase: detail.phase ?? "preflight",
      renderer: detail.renderer ?? null,
      kind: detail.kind ?? "exception",
      message: boundedMessage,
      stack:
        typeof error?.stack === "string" ? error.stack.slice(0, 16_384) : null,
      timeoutMs: detail.timeoutMs ?? null,
      pageProgress: detail.pageProgress ?? null,
    });
    const artifact = createC1229S5ReplacementErrorArtifact(runId, diagnostics);
    const publication = finalizeC1229S5ReplacementEvidence(
      paths,
      artifact,
      ownership,
      operations,
    );
    return { artifact, publication, paths, error };
  }
}

function usage() {
  console.log(
    `Usage: node Tools/visual-regression/probe-c12-29-s5-replacement-device.mjs [--base URL] [--output-directory DIR] [--headed]\n\nRequires an already-running loopback server and a current Build/CesiumUnminified build.`,
  );
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = () => {
      const next = argv[++index];
      if (!next) throw new Error(`${argument} requires a value`);
      return next;
    };
    if (argument === "--base") options.base = value();
    else if (argument === "--output-directory")
      options.outputDirectory = path.resolve(value());
    else if (argument === "--headed") process.env.PROBE_HEADED = "1";
    else if (argument === "--help") {
      usage();
      process.exit(0);
    } else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

async function main() {
  const result = await runC1229S5ReplacementDeviceProbe(
    parseArguments(process.argv.slice(2)),
  );
  console.log(
    JSON.stringify(
      {
        status: result.artifact.status,
        exitCode: result.artifact.exitCode,
        runId: result.artifact.runId,
        archive: result.publication.archive,
        sha256: result.publication.sha256,
      },
      null,
      2,
    ),
  );
  process.exitCode = exitCodeForC1229S5ReplacementStatus(
    result.artifact.status,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
