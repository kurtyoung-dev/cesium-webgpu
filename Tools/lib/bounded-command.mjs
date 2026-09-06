import { spawn as nodeSpawn } from "node:child_process";
import { open } from "node:fs/promises";

const DEFAULT_OUTPUT_CAP_BYTES = 1024 * 1024;
const DEFAULT_EVENT_CAP = 64;
const ERROR_TEXT_LIMIT = 2048;

function boundedText(value, fallback) {
  try {
    const text = typeof value === "string" ? value : String(value);
    return text.slice(0, ERROR_TEXT_LIMIT);
  } catch {
    return fallback;
  }
}

function readableField(value, key) {
  try {
    return value?.[key];
  } catch {
    return undefined;
  }
}

function describeError(error) {
  if (error === null) {
    return {
      observed: true,
      payload: "null",
      name: "ErrorEvent",
      message: null,
      code: null,
    };
  }
  if (error === undefined) {
    return {
      observed: true,
      payload: "undefined",
      name: "ErrorEvent",
      message: null,
      code: null,
    };
  }
  const name = readableField(error, "name");
  const message = readableField(error, "message");
  const code = readableField(error, "code");
  return {
    observed: true,
    payload: "present",
    name: typeof name === "string" ? boundedText(name, "Error") : "Error",
    message: boundedText(message ?? error, "unreadable error"),
    code: typeof code === "string" ? boundedText(code, "unknown") : null,
  };
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function requireNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function validateOptions(options) {
  if (!Array.isArray(options?.argv) || options.argv.length === 0) {
    throw new TypeError("argv must be a non-empty array of strings");
  }
  if (!options.argv.every((argument) => typeof argument === "string")) {
    throw new TypeError("argv must contain only strings");
  }
  if (typeof options.cwd !== "string" || options.cwd.length === 0) {
    throw new TypeError("cwd must be a non-empty string");
  }
  if (
    typeof options.artifactPath !== "string" ||
    options.artifactPath.length === 0
  ) {
    throw new TypeError("artifactPath must be a non-empty string");
  }
  requirePositiveInteger(options.timeoutMs, "timeoutMs");
  requireNonNegativeInteger(options.terminationGraceMs, "terminationGraceMs");
  requireNonNegativeInteger(options.stdoutMaxBytes, "stdoutMaxBytes");
  requireNonNegativeInteger(options.stderrMaxBytes, "stderrMaxBytes");
  requireNonNegativeInteger(
    options.streamDrainTimeoutMs,
    "streamDrainTimeoutMs",
  );
  requirePositiveInteger(options.hardCompletionMs, "hardCompletionMs");
  if (
    options.hardCompletionMs <=
    options.timeoutMs +
      options.terminationGraceMs +
      options.streamDrainTimeoutMs
  ) {
    throw new TypeError(
      "hardCompletionMs must exceed timeout and drain deadlines",
    );
  }
  if (options.summary !== undefined && typeof options.summary !== "function") {
    throw new TypeError("summary must be a function when provided");
  }
}

function defaultArtifactOperations() {
  return {
    openExclusive: (artifactPath) => open(artifactPath, "wx"),
    append: (handle, bytes) => handle.writeFile(bytes),
    close: (handle) => handle.close(),
  };
}

function defaultClock() {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

function bytesFor(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
}

function makeStreamFacts() {
  const facts = {
    available: false,
    retainedUtf8: "",
    retainedBase64: "",
    retainedBytes: 0,
    receivedBytes: 0,
    droppedBytes: 0,
    truncated: false,
    ended: false,
    error: null,
    events: [],
    eventCount: 0,
    eventsDropped: 0,
    drainAttempts: 0,
    drainErrors: [],
    drainErrorCount: 0,
    drainErrorsDropped: 0,
  };
  Object.defineProperty(facts, "retainedParts", {
    value: [],
    enumerable: false,
  });
  return facts;
}

function pushCappedEvent(target, field, countField, droppedField, cap, event) {
  target[countField] += 1;
  if (target[field].length < cap) {
    target[field].push(event);
  } else {
    target[droppedField] += 1;
  }
}

function recordEvent(record, clock, kind, detail = null) {
  pushCappedEvent(
    record,
    "lateEvents",
    "lateEventCount",
    "lateEventsDropped",
    record.lateEventCap,
    { atMs: clock.now(), kind, detail },
  );
}

function attachStream({
  stream,
  facts,
  capBytes,
  clock,
  record,
  name,
  onTerminal,
}) {
  if (!stream || typeof stream.on !== "function") {
    return;
  }
  facts.available = true;
  stream.on("data", (chunk) => {
    if (record.completed) return;
    const bytes = bytesFor(chunk);
    pushCappedEvent(
      facts,
      "events",
      "eventCount",
      "eventsDropped",
      record.streamEventCap,
      { atMs: clock.now(), kind: "data", bytes: bytes.length },
    );
    facts.receivedBytes += bytes.length;
    const remaining = Math.max(0, capBytes - facts.retainedBytes);
    if (remaining > 0) {
      const retained = bytes.subarray(0, remaining);
      facts.retainedParts.push(retained);
      facts.retainedBytes += retained.length;
    }
    if (bytes.length > remaining) {
      facts.truncated = true;
      facts.droppedBytes += bytes.length - remaining;
      facts.drainAttempts += 1;
      try {
        stream.resume?.();
      } catch (error) {
        pushCappedEvent(
          facts,
          "drainErrors",
          "drainErrorCount",
          "drainErrorsDropped",
          record.streamEventCap,
          describeError(error),
        );
      }
    }
  });
  stream.on("error", (error) => {
    if (record.completed) return;
    facts.error = describeError(error);
    pushCappedEvent(
      facts,
      "events",
      "eventCount",
      "eventsDropped",
      record.streamEventCap,
      { atMs: clock.now(), kind: "error" },
    );
    onTerminal?.();
  });
  stream.on("end", () => {
    if (record.completed) return;
    facts.ended = true;
    pushCappedEvent(
      facts,
      "events",
      "eventCount",
      "eventsDropped",
      record.streamEventCap,
      { atMs: clock.now(), kind: "end" },
    );
    onTerminal?.();
  });
}

function requestTermination(record, child, signal, clock) {
  const attempt = {
    atMs: clock.now(),
    signal,
    issued: false,
    error: null,
  };
  record.termination.attempts.push(attempt);
  try {
    attempt.issued = child.kill(signal) === true;
  } catch (error) {
    attempt.error = describeError(error);
  }
}

function releaseDirectHandles(child) {
  const handles = [child, child.stdout, child.stderr];
  const unavailable = [];
  const errors = [];
  const destroyedPipes = [];
  for (const [index, handle] of handles.entries()) {
    const name = index === 0 ? "child" : index === 1 ? "stdout" : "stderr";
    if (typeof handle?.unref === "function") {
      try {
        handle.unref();
        continue;
      } catch (error) {
        errors.push(describeError(error));
      }
    }
    if (index > 0 && typeof handle?.destroy === "function") {
      try {
        handle.destroy();
        destroyedPipes.push(name);
        continue;
      } catch (error) {
        errors.push(describeError(error));
        unavailable.push(name);
        continue;
      }
    }
    unavailable.push(name);
  }
  return {
    released: unavailable.length === 0,
    unavailable,
    errors,
    destroyedPipes,
  };
}

function releaseOwnership(record, child, clock) {
  const released = releaseDirectHandles(child);
  record.native.ownershipReleased = released.released;
  if (released.unavailable.length > 0 || released.errors.length > 0) {
    recordEvent(
      record,
      clock,
      released.released
        ? "direct-handle-release-fallback"
        : "direct-handle-release-incomplete",
      released,
    );
  }
}

function rawSnapshot(record) {
  for (const facts of [record.stdout, record.stderr]) {
    if (Array.isArray(facts.retainedParts)) {
      const retained = Buffer.concat(facts.retainedParts);
      facts.retainedUtf8 = retained.toString("utf8");
      facts.retainedBase64 = retained.toString("base64");
    }
  }
  return JSON.parse(JSON.stringify(record));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Run one explicitly described command and archive its bounded direct-child
 * facts. This is a source-check recorder, not a process-tree supervisor.
 */
export async function runBoundedCommand(options, seams = {}) {
  const normalized = {
    ...options,
    stdoutMaxBytes: options?.stdoutMaxBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
    stderrMaxBytes: options?.stderrMaxBytes ?? DEFAULT_OUTPUT_CAP_BYTES,
    streamDrainTimeoutMs:
      options?.streamDrainTimeoutMs ?? options?.terminationGraceMs,
    hardCompletionMs:
      options?.hardCompletionMs ??
      options?.timeoutMs +
        options?.terminationGraceMs +
        (options?.streamDrainTimeoutMs ?? options?.terminationGraceMs) +
        1,
  };
  validateOptions(normalized);
  const clock = seams.clock ?? defaultClock();
  const artifactOperations =
    seams.artifactOperations ?? defaultArtifactOperations();
  if (
    typeof artifactOperations.openExclusive !== "function" ||
    typeof artifactOperations.append !== "function" ||
    typeof artifactOperations.close !== "function"
  ) {
    throw new TypeError(
      "artifactOperations must provide openExclusive, append, and close",
    );
  }
  if (
    !clock ||
    typeof clock.now !== "function" ||
    typeof clock.setTimeout !== "function" ||
    typeof clock.clearTimeout !== "function"
  ) {
    throw new TypeError("clock must provide now, setTimeout, and clearTimeout");
  }
  requireNonNegativeInteger(
    seams.streamEventCap ?? DEFAULT_EVENT_CAP,
    "streamEventCap",
  );
  requireNonNegativeInteger(
    seams.lateEventCap ?? DEFAULT_EVENT_CAP,
    "lateEventCap",
  );

  const startedAtMs = clock.now();
  const record = {
    schemaVersion: 1,
    command: { argv: [...normalized.argv], cwd: normalized.cwd },
    start: { atMs: startedAtMs, identity: normalized.startIdentity ?? null },
    native: {
      spawned: false,
      pid: null,
      spawnError: null,
      childError: null,
      close: { observed: false, atMs: null, exitCode: null, signal: null },
      directChildState: "unavailable",
      descendantQuiescence: "unknown",
      ownershipReleased: false,
    },
    stdout: makeStreamFacts(),
    stderr: makeStreamFacts(),
    timeout: { expired: false, atMs: null, forced: false, forcedAtMs: null },
    streamDrain: {
      timeoutMs: normalized.streamDrainTimeoutMs,
      needed: false,
      completed: false,
      timedOut: false,
      atMs: null,
    },
    termination: { attempts: [] },
    completed: false,
    completion: { reason: null, atMs: null },
    terminal: {
      cutoff: false,
      cutoffAtMs: null,
      reason: null,
      postCutoffFacts: "not-archived",
    },
    lateEvents: [],
    lateEventCount: 0,
    lateEventsDropped: 0,
    lateEventCap: seams.lateEventCap ?? DEFAULT_EVENT_CAP,
    streamEventCap: seams.streamEventCap ?? DEFAULT_EVENT_CAP,
  };

  let artifact;
  try {
    artifact = await artifactOperations.openExclusive(normalized.artifactPath);
  } catch (error) {
    const wrapped = new Error(
      `could not exclusively create artifact ${normalized.artifactPath}`,
      {
        cause: error,
      },
    );
    wrapped.code = error?.code;
    throw wrapped;
  }
  let artifactClosed = false;
  const append = async (entry) => {
    await artifactOperations.append(artifact, `${JSON.stringify(entry)}\n`);
  };
  const closeArtifact = async () => {
    if (!artifactClosed) {
      artifactClosed = true;
      await artifactOperations.close(artifact);
    }
  };

  try {
    await append({ kind: "start", record: rawSnapshot(record) });
    const spawn = seams.spawn ?? nodeSpawn;
    let child;
    try {
      child = spawn(normalized.argv[0], normalized.argv.slice(1), {
        cwd: normalized.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      record.native.spawned = true;
      record.native.pid = Number.isInteger(child?.pid) ? child.pid : null;
      record.native.directChildState = "running";
    } catch (error) {
      record.native.spawnError = describeError(error);
      record.completion = { reason: "spawn-throw", atMs: clock.now() };
    }

    if (child) {
      await new Promise((resolve) => {
        let settled = false;
        let closeObserved = false;
        let timeoutTimer = null;
        let forceTimer = null;
        let streamDrainTimer = null;
        let hardCompletionTimer = null;
        const streamsTerminal = () =>
          [record.stdout, record.stderr].every(
            (facts) => !facts.available || facts.ended || facts.error !== null,
          );
        const finish = (reason) => {
          if (settled) return;
          settled = true;
          if (timeoutTimer !== null) clock.clearTimeout(timeoutTimer);
          if (forceTimer !== null) clock.clearTimeout(forceTimer);
          if (streamDrainTimer !== null) clock.clearTimeout(streamDrainTimer);
          if (hardCompletionTimer !== null) {
            clock.clearTimeout(hardCompletionTimer);
          }
          record.completed = true;
          record.completion = { reason, atMs: clock.now() };
          record.terminal = {
            cutoff: true,
            cutoffAtMs: clock.now(),
            reason,
            postCutoffFacts: "not-archived",
          };
          resolve();
        };
        const finishAfterStreams = () => {
          if (!closeObserved || settled) return;
          if (streamsTerminal()) {
            record.streamDrain.completed = true;
            finish("child-close");
            return;
          }
          if (streamDrainTimer !== null) return;
          record.streamDrain.needed = true;
          streamDrainTimer = clock.setTimeout(() => {
            record.streamDrain.timedOut = true;
            record.streamDrain.atMs = clock.now();
            releaseOwnership(record, child, clock);
            finish("stream-drain-timeout");
          }, normalized.streamDrainTimeoutMs);
        };
        attachStream({
          stream: child.stdout,
          facts: record.stdout,
          capBytes: normalized.stdoutMaxBytes,
          clock,
          record,
          name: "stdout",
          onTerminal: finishAfterStreams,
        });
        attachStream({
          stream: child.stderr,
          facts: record.stderr,
          capBytes: normalized.stderrMaxBytes,
          clock,
          record,
          name: "stderr",
          onTerminal: finishAfterStreams,
        });
        const requestForce = () => {
          record.timeout.forced = true;
          record.timeout.forcedAtMs = clock.now();
          requestTermination(record, child, "SIGKILL", clock);
        };
        timeoutTimer = clock.setTimeout(() => {
          if (settled) return;
          record.timeout.expired = true;
          record.timeout.atMs = clock.now();
          requestTermination(record, child, "SIGTERM", clock);
          forceTimer = clock.setTimeout(
            requestForce,
            normalized.terminationGraceMs,
          );
        }, normalized.timeoutMs);
        hardCompletionTimer = clock.setTimeout(() => {
          if (settled) return;
          if (!closeObserved && !record.timeout.forced) {
            record.timeout.forced = true;
            record.timeout.forcedAtMs = clock.now();
            requestTermination(record, child, "SIGKILL", clock);
          }
          releaseOwnership(record, child, clock);
          record.native.directChildState = record.native.close.observed
            ? "exited"
            : "unknown";
          finish("hard-completion-deadline");
        }, normalized.hardCompletionMs);
        child.once?.("error", (error) => {
          if (record.completed) return;
          record.native.childError = describeError(error);
          record.native.directChildState = "error-observed";
          requestTermination(record, child, "SIGTERM", clock);
          if (timeoutTimer !== null) {
            clock.clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          if (forceTimer === null) {
            forceTimer = clock.setTimeout(
              requestForce,
              normalized.terminationGraceMs,
            );
          }
        });
        child.once?.("close", (exitCode, signal) => {
          if (record.completed) return;
          record.native.close = {
            observed: true,
            atMs: clock.now(),
            exitCode: Number.isInteger(exitCode) ? exitCode : null,
            signal: signal ?? null,
          };
          record.native.directChildState = "exited";
          closeObserved = true;
          if (timeoutTimer !== null) {
            clock.clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
          if (forceTimer !== null) {
            clock.clearTimeout(forceTimer);
            forceTimer = null;
          }
          finishAfterStreams();
        });
      });
    } else {
      record.completed = true;
      record.terminal = {
        cutoff: true,
        cutoffAtMs: clock.now(),
        reason: record.completion.reason ?? "no-child",
        postCutoffFacts: "not-archived",
      };
    }

    const raw = deepFreeze(rawSnapshot(record));
    await append({ kind: "raw", record: raw });
    await closeArtifact();
    let summary = { available: false, value: null, error: null };
    if (normalized.summary) {
      try {
        summary = {
          available: true,
          value: await normalized.summary(deepFreeze(rawSnapshot(raw))),
          error: null,
        };
      } catch (error) {
        summary = {
          available: false,
          value: null,
          error: describeError(error),
        };
      }
    }
    return { artifactPath: normalized.artifactPath, raw, summary };
  } catch (error) {
    try {
      await closeArtifact();
    } catch {
      // Preserve the primary persistence error.
    }
    throw error;
  }
}
