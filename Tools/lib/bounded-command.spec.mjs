import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runBoundedCommand } from "./bounded-command.mjs";

function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    },
    deliverOverdue(milliseconds) {
      now += milliseconds;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((left, right) => left[1].at - right[1].at);
      for (const [id, timer] of due) {
        timers.delete(id);
        timer.callback();
      }
    },
  };
}

function makeArtifactOperations({
  collision = false,
  failStartAppend = false,
} = {}) {
  const entries = [];
  let opened = 0;
  let closes = 0;
  return {
    entries,
    get opened() {
      return opened;
    },
    get closes() {
      return closes;
    },
    openExclusive(path) {
      if (collision) {
        const error = new Error(`artifact exists: ${path}`);
        error.code = "EEXIST";
        throw error;
      }
      opened += 1;
      return { path };
    },
    append(_handle, bytes) {
      if (failStartAppend && entries.length === 0) {
        throw new Error("start persistence failed");
      }
      entries.push(JSON.parse(bytes));
    },
    close() {
      closes += 1;
    },
  };
}

function makeStream() {
  const stream = new EventEmitter();
  stream.resumeCalls = 0;
  stream.resume = () => {
    stream.resumeCalls += 1;
  };
  stream.destroyCalls = 0;
  stream.destroy = () => {
    stream.destroyCalls += 1;
  };
  return stream;
}

function makeChild() {
  const child = new EventEmitter();
  child.pid = 42;
  child.stdout = makeStream();
  child.stderr = makeStream();
  child.kills = [];
  child.unrefCalls = 0;
  child.unref = () => {
    child.unrefCalls += 1;
  };
  child.stdout.unref = () => {};
  child.stderr.unref = () => {};
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

function options(overrides = {}) {
  return {
    argv: ["fake-tool", "--check"],
    cwd: "F:/fake",
    artifactPath: "F:/artifacts/bounded-command.jsonl",
    timeoutMs: 10,
    terminationGraceMs: 5,
    stdoutMaxBytes: 3,
    stderrMaxBytes: 3,
    startIdentity: { node: "fake-node" },
    clock: makeClock(),
    artifactOperations: makeArtifactOperations(),
    ...overrides,
  };
}

function execute(configuration) {
  const {
    clock,
    artifactOperations,
    spawn,
    seams = {},
    ...command
  } = configuration;
  return runBoundedCommand(command, {
    clock,
    artifactOperations,
    spawn,
    ...seams,
  });
}

async function begin(configuration, child) {
  const result = execute(configuration);
  for (let attempt = 0; attempt < 8; attempt++) {
    await Promise.resolve();
    if (child.listenerCount("close") === 1) {
      return { result };
    }
  }
  throw new Error("fake child listeners were not attached");
}

test("B1 preserves a native nonzero close and records argv/cwd/start identity before the summary", async () => {
  const child = makeChild();
  let spawnInvocation;
  const configuration = options({
    spawn: (...arguments_) => {
      spawnInvocation = arguments_;
      return child;
    },
    summary: () => ({ ok: true }),
  });
  const { result: resultPromise } = await begin(configuration, child);
  child.stdout.emit("data", "ok");
  child.stdout.emit("end");
  child.stderr.emit("end");
  child.emit("close", 7, null);
  const result = await resultPromise;

  assert.equal(result.raw.native.close.exitCode, 7);
  assert.equal(result.raw.native.close.signal, null);
  assert.equal(result.raw.native.directChildState, "exited");
  assert.equal(result.raw.native.descendantQuiescence, "unknown");
  assert.deepEqual(result.raw.command, {
    argv: ["fake-tool", "--check"],
    cwd: "F:/fake",
  });
  assert.deepEqual(result.raw.start.identity, { node: "fake-node" });
  assert.deepEqual(spawnInvocation, [
    "fake-tool",
    ["--check"],
    {
      cwd: "F:/fake",
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ]);
  assert.equal(configuration.artifactOperations.entries[0].kind, "start");
  assert.equal(configuration.artifactOperations.entries[1].kind, "raw");
  assert.equal(result.summary.available, true);
});

test("B2 writes raw facts before a summary transform failure", async () => {
  const child = makeChild();
  const configuration = options({
    spawn: () => child,
    summary: (raw) => {
      assert.equal(configuration.artifactOperations.entries.at(-1).kind, "raw");
      assert.equal(Object.isFrozen(raw), true);
      assert.throws(() => {
        raw.native.close.exitCode = 99;
      }, TypeError);
      throw new Error("summary broke");
    },
  });
  const { result: resultPromise } = await begin(configuration, child);
  child.stdout.unref = () => {
    throw new Error("stdout unref failed");
  };
  child.emit("close", 0, null);
  configuration.clock.advance(5);
  const result = await resultPromise;

  assert.equal(result.summary.available, false);
  assert.equal(result.summary.error.message, "summary broke");
  assert.equal(configuration.artifactOperations.entries.length, 2);
  assert.equal(
    configuration.artifactOperations.entries[1].record.native.close.exitCode,
    0,
  );
  assert.equal(result.raw.streamDrain.timedOut, true);
  assert.equal(result.raw.native.ownershipReleased, true);
  assert.equal(child.stdout.destroyCalls, 1);
  assert.equal(result.raw.lateEvents[0].kind, "direct-handle-release-fallback");
});

test("B3 rejects an artifact collision before spawning", async () => {
  let spawned = false;
  const configuration = options({
    artifactOperations: makeArtifactOperations({ collision: true }),
    spawn: () => {
      spawned = true;
      return makeChild();
    },
  });
  await assert.rejects(execute(configuration), { code: "EEXIST" });
  assert.equal(spawned, false);
});

test("B4 timeout requests direct-child termination, then completes after the bounded force request", async () => {
  const child = makeChild();
  const clock = makeClock();
  const { result: resultPromise } = await begin(
    options({ clock, spawn: () => child }),
    child,
  );
  clock.advance(10);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  clock.advance(5);
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  clock.advance(6);
  const result = await resultPromise;

  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.raw.timeout.expired, true);
  assert.equal(result.raw.timeout.forced, true);
  assert.equal(result.raw.completion.reason, "hard-completion-deadline");
  assert.equal(result.raw.native.close.observed, false);
  assert.equal(result.raw.native.ownershipReleased, true);
  assert.equal(child.unrefCalls, 1);
  assert.equal(result.raw.native.descendantQuiescence, "unknown");
});

test("B5 bounds output while draining, and preserves data/error/end arrival order", async () => {
  const child = makeChild();
  const configuration = options({ spawn: () => child });
  const { result: resultPromise } = await begin(configuration, child);
  child.stdout.emit("data", Buffer.from([0xff, 0x00, 0x61, 0x62, 0x63, 0x64]));
  child.stdout.emit("error", new Error("stdout failure"));
  child.stdout.emit("end");
  child.stderr.emit("data", "xyzzy");
  child.stderr.emit("end");
  child.emit("close", 0, null);
  const result = await resultPromise;

  assert.equal(result.raw.stdout.retainedUtf8, "�\u0000a");
  assert.equal(result.raw.stdout.retainedBase64, "/wBh");
  assert.equal(result.raw.stdout.droppedBytes, 3);
  assert.equal(result.raw.stdout.truncated, true);
  assert.equal(child.stdout.resumeCalls, 1);
  assert.deepEqual(
    result.raw.stdout.events.map((event) => event.kind),
    ["data", "error", "end"],
  );
  assert.equal(result.raw.stdout.error.message, "stdout failure");
  assert.equal(result.raw.stderr.retainedUtf8, "xyz");
  assert.equal(result.raw.stderr.droppedBytes, 2);
});

test("B6 spawn throws and an emitted child error retain bounded native facts", async () => {
  const thrown = await execute(
    options({
      spawn: () => {
        throw new Error("spawn denied");
      },
    }),
  );
  assert.equal(thrown.raw.native.spawned, false);
  assert.equal(thrown.raw.native.spawnError.message, "spawn denied");
  assert.equal(thrown.raw.native.directChildState, "unavailable");

  const child = makeChild();
  const clock = makeClock();
  const configuration = options({ clock, spawn: () => child });
  const { result: resultPromise } = await begin(configuration, child);
  child.emit("error", new Error("child denied"));
  assert.deepEqual(child.kills, ["SIGTERM"]);
  clock.advance(21);
  const errored = await resultPromise;
  assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  assert.equal(errored.raw.native.childError.message, "child denied");
  assert.equal(errored.raw.native.close.observed, false);
  assert.equal(errored.raw.native.directChildState, "unknown");
  assert.equal(errored.raw.native.ownershipReleased, true);
});

test("B7 post-force close and stream outcomes are persisted before summary", async () => {
  const child = makeChild();
  const clock = makeClock();
  let summaryRaw;
  const configuration = options({
    clock,
    spawn: () => child,
    summary: (raw) => {
      summaryRaw = raw;
      return null;
    },
  });
  const { result: resultPromise } = await begin(configuration, child);
  clock.advance(16);
  child.emit("close", null, "SIGKILL");
  child.stdout.emit("end");
  child.stderr.emit("error", new Error("late stderr"));
  const result = await resultPromise;

  assert.equal(result.raw.timeout.forced, true);
  assert.equal(result.raw.native.close.observed, true);
  assert.equal(result.raw.native.close.signal, "SIGKILL");
  assert.equal(result.raw.stdout.ended, true);
  assert.equal(result.raw.stderr.error.message, "late stderr");
  assert.equal(result.raw.native.descendantQuiescence, "unknown");
  assert.equal(
    configuration.artifactOperations.entries.at(-1).record.native.close
      .observed,
    true,
  );
  assert.equal(summaryRaw.native.close.observed, true);
  assert.equal(Object.hasOwn(result, "liveRecord"), false);
});

test("B8 caps stream and drain-error metadata without dropping the corresponding counts", async () => {
  const child = makeChild();
  const configuration = options({
    spawn: () => child,
    stdoutMaxBytes: 0,
    seams: { streamEventCap: 1, lateEventCap: 1 },
  });
  child.stdout.resume = () => {
    throw new Error("drain failed");
  };
  const { result: resultPromise } = await begin(configuration, child);
  child.stdout.emit("data", "a");
  child.stdout.emit("data", "b");
  child.stdout.emit("end");
  child.stderr.emit("end");
  child.emit("close", 0, null);
  const result = await resultPromise;

  assert.equal(result.raw.stdout.eventCount, 3);
  assert.equal(result.raw.stdout.events.length, 1);
  assert.equal(result.raw.stdout.eventsDropped, 2);
  assert.equal(result.raw.stdout.drainErrorCount, 2);
  assert.equal(result.raw.stdout.drainErrors.length, 1);
  assert.equal(result.raw.stdout.drainErrorsDropped, 1);
});

test("B9 start persistence failure closes the artifact handle before any spawn", async () => {
  let spawned = false;
  const artifactOperations = makeArtifactOperations({ failStartAppend: true });
  await assert.rejects(
    execute(
      options({
        artifactOperations,
        spawn: () => {
          spawned = true;
          return makeChild();
        },
      }),
    ),
    /start persistence failed/,
  );
  assert.equal(spawned, false);
  assert.equal(artifactOperations.opened, 1);
  assert.equal(artifactOperations.closes, 1);
});

test("B10 null and undefined child/stream error events remain explicit occurrences", async () => {
  const childErrorChild = makeChild();
  const childErrorConfiguration = options({ spawn: () => childErrorChild });
  const { result: childErrorPromise } = await begin(
    childErrorConfiguration,
    childErrorChild,
  );
  childErrorChild.emit("error", null);
  childErrorChild.stdout.emit("end");
  childErrorChild.stderr.emit("end");
  childErrorChild.emit("close", 0, null);
  const childErrorResult = await childErrorPromise;

  assert.equal(childErrorResult.raw.native.childError.observed, true);
  assert.equal(childErrorResult.raw.native.childError.payload, "null");

  const streamErrorChild = makeChild();
  const streamErrorConfiguration = options({ spawn: () => streamErrorChild });
  const { result: streamErrorPromise } = await begin(
    streamErrorConfiguration,
    streamErrorChild,
  );
  streamErrorChild.stdout.emit("error", undefined);
  streamErrorChild.stdout.emit("end");
  streamErrorChild.stderr.emit("end");
  streamErrorChild.emit("close", 0, null);
  const streamErrorResult = await streamErrorPromise;

  assert.equal(streamErrorResult.raw.stdout.error.observed, true);
  assert.equal(streamErrorResult.raw.stdout.error.payload, "undefined");
});

test("B11 a pipe whose unref and destroy both fail cannot claim ownership release", async () => {
  const child = makeChild();
  const configuration = options({ spawn: () => child });
  child.stdout.unref = () => {
    throw new Error("unref failed");
  };
  child.stdout.destroy = () => {
    throw new Error("destroy failed");
  };
  const { result: resultPromise } = await begin(configuration, child);
  child.emit("close", 0, null);
  configuration.clock.advance(5);
  const result = await resultPromise;

  assert.equal(result.raw.native.ownershipReleased, false);
});

test("B12 direct-child close disarms termination while pipe draining remains bounded", async () => {
  const child = makeChild();
  const clock = makeClock();
  const configuration = options({
    clock,
    spawn: () => child,
    streamDrainTimeoutMs: 20,
    hardCompletionMs: 36,
  });
  const { result: resultPromise } = await begin(configuration, child);
  child.emit("close", 0, null);
  clock.advance(10);

  assert.deepEqual(child.kills, []);
  child.stdout.emit("end");
  child.stderr.emit("end");
  const result = await resultPromise;
  assert.equal(result.raw.streamDrain.completed, true);
  assert.equal(result.raw.streamDrain.timedOut, false);

  const armedChild = makeChild();
  const armedClock = makeClock();
  const armedConfiguration = options({
    clock: armedClock,
    spawn: () => armedChild,
    streamDrainTimeoutMs: 20,
    hardCompletionMs: 36,
  });
  const { result: armedResultPromise } = await begin(
    armedConfiguration,
    armedChild,
  );
  armedClock.advance(10);
  armedChild.emit("close", null, "SIGTERM");
  armedChild.stdout.emit("end");
  armedChild.stderr.emit("end");
  const armedResult = await armedResultPromise;
  armedClock.advance(30);
  assert.deepEqual(armedChild.kills, ["SIGTERM"]);
  assert.equal(armedResult.raw.timeout.forced, false);
});

test("B13 terminal cutoff makes post-cutoff native and stream facts non-archived", async () => {
  const child = makeChild();
  const clock = makeClock();
  const configuration = options({ clock, spawn: () => child });
  const { result: resultPromise } = await begin(configuration, child);
  clock.advance(21);
  const result = await resultPromise;
  const rawBefore = structuredClone(result.raw);
  const artifactBefore = structuredClone(
    configuration.artifactOperations.entries.at(-1).record,
  );
  child.emit("error", new Error("after cutoff"));
  child.stdout.emit("data", "after cutoff");
  child.stdout.emit("error", new Error("after cutoff"));
  child.stderr.emit("end");
  child.emit("close", null, "SIGKILL");

  assert.equal(result.raw.terminal.cutoff, true);
  assert.equal(result.raw.terminal.reason, "hard-completion-deadline");
  assert.equal(result.raw.terminal.cutoffAtMs, 21);
  assert.equal(result.raw.terminal.postCutoffFacts, "not-archived");
  assert.deepEqual(result.raw, rawBefore);
  assert.deepEqual(
    configuration.artifactOperations.entries.at(-1).record,
    artifactBefore,
  );
});

test("B14 hard completion never forces a child whose close was observed", async () => {
  const child = makeChild();
  const clock = makeClock();
  const configuration = options({ clock, spawn: () => child });
  const { result: resultPromise } = await begin(configuration, child);

  clock.deliverOverdue(20);
  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(clock.now(), 20);
  child.emit("close", 0, null);
  clock.advance(1);
  const result = await resultPromise;

  assert.deepEqual(child.kills, ["SIGTERM"]);
  assert.equal(result.raw.timeout.expired, true);
  assert.equal(result.raw.timeout.forced, false);
  assert.equal(result.raw.native.close.observed, true);
  assert.equal(result.raw.native.ownershipReleased, true);
  assert.equal(result.raw.streamDrain.needed, true);
  assert.equal(result.raw.completion.reason, "hard-completion-deadline");
});
