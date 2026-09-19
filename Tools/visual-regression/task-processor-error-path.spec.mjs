// TaskProcessor worker-failure contract.
// @purpose Prove a worker `error` or `messageerror` settles the task it was carrying, releases the active-task slot it held, and that a cached web-assembly init rejects instead of waiting forever.
// @status ACTIVE
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const coreDir = path.join(repoRoot, "packages", "engine", "Source", "Core");

// The module graph reads `document.location` (RequestScheduler) and
// `document.createElement` + `window.location` (isCrossOriginUrl). Those three
// properties are the entire browser surface TaskProcessor needs; the anchor
// stub keeps host and protocol constant so every worker URL reads same-origin.
globalThis.document = {
  location: { href: "http://localhost/" },
  createElement: () => ({ href: "", host: "localhost", protocol: "http:" }),
};
globalThis.window = { location: { href: "http://localhost/" } };

class StubWorker {
  static created = [];

  constructor(url) {
    this.url = url;
    this.posted = [];
    this.terminated = false;
    this.listeners = { message: [], error: [], messageerror: [] };
    StubWorker.created.push(this);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type, listener) {
    const registered = this.listeners[type] ?? [];
    const index = registered.indexOf(listener);
    if (index !== -1) {
      registered.splice(index, 1);
    }
  }

  postMessage(message) {
    if (this.throwOnPost) {
      const error = new Error(
        "Failed to execute 'postMessage' on 'Worker': could not be cloned.",
      );
      error.name = "DataCloneError";
      throw error;
    }
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type, event) {
    for (const listener of [...(this.listeners[type] ?? [])]) {
      listener(event);
    }
    // A real worker dispatches to the `on<type>` property as well; the
    // capability probe subscribes that way.
    this[`on${type}`]?.(event);
  }

  listenerCount(type) {
    return (this.listeners[type] ?? []).length;
  }
}

globalThis.Worker = StubWorker;

const importCore = async (name) =>
  (await import(pathToFileURL(path.join(coreDir, `${name}.js`)).href)).default;

const TaskProcessor = await importCore("TaskProcessor");
const FeatureDetection = await importCore("FeatureDetection");
const RuntimeError = await importCore("RuntimeError");

// Answer the transferable-array feature probe so no worker is spawned for it.
TaskProcessor._canTransferArrayBuffer = false;

const consoleErrors = [];
console.error = (...args) => {
  consoleErrors.push(args.join(" "));
};

// An `error` event carries `preventDefault`; marking it handled is what keeps a
// failure the engine has already reported off the page's global error handler.
function makeErrorEvent(fields) {
  const event = { ...fields, preventDefaultCalls: 0 };
  event.preventDefault = () => {
    event.preventDefaultCalls += 1;
  };
  return event;
}

const TIMED_OUT = Symbol("timed out");

async function waitUntil(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("a worker error rejects the task it was carrying and releases its slot", async () => {
  const processor = new TaskProcessor("errorWorker.js", 1);
  const worker = new StubWorker("errorWorker.js");
  processor._worker = worker;

  const promise = processor.scheduleTask({ value: 1 });
  assert.notEqual(promise, undefined);
  assert.equal(processor._activeTasks, 1);

  await waitUntil(() => worker.listenerCount("error") === 1);

  worker.emit("error", {
    message: "Failed to load worker script",
    filename: "http://localhost/Workers/errorWorker.js",
  });

  const outcome = await settleWithin(promise, 1000);
  assert.notEqual(outcome, TIMED_OUT, "the task promise never settled");
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason instanceof RuntimeError, true);
  assert.match(outcome.reason.message, /errorWorker\.js/u);
  assert.match(outcome.reason.message, /Failed to load worker script/u);
  assert.equal(processor._activeTasks, 0);
  assert.deepEqual(
    {
      message: worker.listenerCount("message"),
      error: worker.listenerCount("error"),
      messageerror: worker.listenerCount("messageerror"),
    },
    { message: 0, error: 0, messageerror: 0 },
  );
});

test("the processor still accepts work after a failure consumed its only slot", async () => {
  const processor = new TaskProcessor("errorWorker.js", 1);
  const worker = new StubWorker("errorWorker.js");
  processor._worker = worker;

  const failing = processor.scheduleTask({ value: 1 });
  await waitUntil(() => worker.listenerCount("error") === 1);
  worker.emit("error", { message: "boom" });
  const failure = await settleWithin(failing, 1000);
  assert.notEqual(failure, TIMED_OUT, "the first task never settled");
  assert.equal(failure.status, "rejected");

  const second = processor.scheduleTask({ value: 2 });
  assert.notEqual(
    second,
    undefined,
    "the maximum-active-tasks slot was never released",
  );
  await waitUntil(() => worker.listenerCount("message") === 1);
  const secondId = worker.posted[worker.posted.length - 1]?.id;
  worker.emit("message", { data: { id: secondId, result: "second result" } });

  const outcome = await settleWithin(second, 1000);
  assert.notEqual(outcome, TIMED_OUT, "the second task promise never settled");
  assert.deepEqual(outcome, { status: "fulfilled", value: "second result" });
  assert.equal(processor._activeTasks, 0);
  // A task that succeeds has to give back all three of its listeners, not just
  // the one that fired, or a long-lived worker accumulates them per task.
  assert.deepEqual(
    {
      message: worker.listenerCount("message"),
      error: worker.listenerCount("error"),
      messageerror: worker.listenerCount("messageerror"),
    },
    { message: 0, error: 0, messageerror: 0 },
  );
});

test("a worker that dies while the transferable probe is pending still rejects", async () => {
  // The real `canTransferArrayBuffer()` is uncached on first use: it builds a
  // second worker, posts to it and waits for the reply. A worker whose script
  // 404s fires its one `error` event during that window, and the event is not
  // replayed — so a task that subscribes only after the probe resolves waits
  // forever. The pending promise below stands in for that first-use round trip.
  const previousProbe = TaskProcessor._canTransferArrayBuffer;
  TaskProcessor._canTransferArrayBuffer = new Promise((resolve) => {
    setTimeout(() => resolve(true), 60);
  });
  try {
    const processor = new TaskProcessor("racingWorker.js", 1);
    const worker = new StubWorker("racingWorker.js");
    processor._worker = worker;

    const promise = processor.scheduleTask({ value: 1 });
    // Dispatched immediately, while the probe is still pending, and delivered
    // only to whoever is already subscribed.
    worker.emit("error", { message: "Failed to load worker script" });

    const outcome = await settleWithin(promise, 2000);
    assert.notEqual(
      outcome,
      TIMED_OUT,
      "the task promise never settled: the worker error arrived before the task subscribed",
    );
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason instanceof RuntimeError, true);
    assert.match(outcome.reason.message, /racingWorker\.js/u);
    assert.equal(processor._activeTasks, 0);
  } finally {
    TaskProcessor._canTransferArrayBuffer = previousProbe;
  }
});

test("a capability probe whose worker fails does not strand the tasks behind it", async () => {
  const previousProbe = TaskProcessor._canTransferArrayBuffer;
  // undefined is the first-use state: the probe builds a worker of its own,
  // posts a typed array to it and waits for the round trip.
  TaskProcessor._canTransferArrayBuffer = undefined;
  StubWorker.created.length = 0;
  try {
    const processor = new TaskProcessor("taskWorker.js", 4);
    const worker = new StubWorker("taskWorker.js");
    processor._worker = worker;

    const failing = processor.scheduleTask({ value: 1 });
    const probe = StubWorker.created[StubWorker.created.length - 1];
    assert.notEqual(probe, worker, "the probe built no worker of its own");

    probe.emit("error", { message: "the probe worker failed to load" });
    worker.emit("error", { message: "Failed to load worker script" });

    const failure = await settleWithin(failing, 2000);
    assert.notEqual(
      failure,
      TIMED_OUT,
      "the task promise never settled behind a failed capability probe",
    );
    assert.equal(failure.status, "rejected");
    assert.equal(failure.reason instanceof RuntimeError, true);
    assert.match(failure.reason.message, /taskWorker\.js/u);

    // The probe answered "no transferables", so a healthy task still completes.
    const healthy = processor.scheduleTask({ value: 2 });
    const posted = await waitUntil(() => worker.posted.length > 0);
    assert.equal(posted, true, "the message was never posted to the worker");
    const message = worker.posted[worker.posted.length - 1];
    assert.equal(message.canTransferArrayBuffer, false);
    worker.emit("message", { data: { id: message.id, result: "done" } });

    const outcome = await settleWithin(healthy, 2000);
    assert.notEqual(outcome, TIMED_OUT, "the healthy task never settled");
    assert.deepEqual(outcome, { status: "fulfilled", value: "done" });
    assert.equal(processor._activeTasks, 0);
  } finally {
    TaskProcessor._canTransferArrayBuffer = previousProbe;
  }
});

test("a capability probe that never answers does not strand a failing task", async () => {
  const previousProbe = TaskProcessor._canTransferArrayBuffer;
  // A probe worker that loads but never replies: no error, no message. The
  // task behind it cannot be made to complete, but it must still be able to
  // report its own worker's failure.
  TaskProcessor._canTransferArrayBuffer = new Promise(() => {});
  try {
    const processor = new TaskProcessor("silentProbeWorker.js", 1);
    const worker = new StubWorker("silentProbeWorker.js");
    processor._worker = worker;

    const promise = processor.scheduleTask({ value: 1 });
    worker.emit("error", { message: "Failed to load worker script" });

    const outcome = await settleWithin(promise, 2000);
    assert.notEqual(
      outcome,
      TIMED_OUT,
      "the task promise was withheld until a probe that never answers",
    );
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason instanceof RuntimeError, true);
    assert.equal(processor._activeTasks, 0);
  } finally {
    TaskProcessor._canTransferArrayBuffer = previousProbe;
  }
});

test("a postMessage that throws rejects the task and releases everything it held", async () => {
  const previousProbe = TaskProcessor._canTransferArrayBuffer;
  // Out-of-band probe: the post happens in a later turn, which is the only
  // route on which no listener has fired by the time the task has to settle.
  TaskProcessor._canTransferArrayBuffer = new Promise((resolve) => {
    setTimeout(() => resolve(true), 20);
  });
  try {
    const processor = new TaskProcessor("uncloneableWorker.js", 1);
    const worker = new StubWorker("uncloneableWorker.js");
    worker.throwOnPost = true;
    processor._worker = worker;

    const promise = processor.scheduleTask({ value: 1 });
    const outcome = await settleWithin(promise, 2000);
    assert.notEqual(
      outcome,
      TIMED_OUT,
      "the task promise never settled after postMessage threw",
    );
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason.name, "DataCloneError");
    assert.equal(processor._activeTasks, 0);
    assert.deepEqual(
      {
        message: worker.listenerCount("message"),
        error: worker.listenerCount("error"),
        messageerror: worker.listenerCount("messageerror"),
      },
      { message: 0, error: 0, messageerror: 0 },
    );

    // The slot came back, so the processor still takes work.
    const next = processor.scheduleTask({ value: 2 });
    assert.notEqual(next, undefined);
    await settleWithin(next, 500);
  } finally {
    TaskProcessor._canTransferArrayBuffer = previousProbe;
  }
});

test("a worker error is marked handled and reported once, on both paths", async () => {
  const before = consoleErrors.length;

  const processor = new TaskProcessor("markedWorker.js", 1);
  const worker = new StubWorker("markedWorker.js");
  processor._worker = worker;

  const promise = processor.scheduleTask({ value: 1 });
  const taskEvent = makeErrorEvent({
    message: "Failed to load worker script",
    filename: "http://localhost/Workers/markedWorker.js",
  });
  worker.emit("error", taskEvent);

  const outcome = await settleWithin(promise, 2000);
  assert.equal(outcome.status, "rejected");
  assert.equal(
    taskEvent.preventDefaultCalls,
    1,
    "the task path left the worker error to the page's global handler",
  );
  assert.deepEqual(consoleErrors.slice(before).length, 1);
  assert.match(consoleErrors[before], /markedWorker\.js/u);
  assert.match(consoleErrors[before], /Failed to load worker script/u);

  // The same on the web assembly init path.
  const wasmBefore = consoleErrors.length;
  const supportsWebAssembly = FeatureDetection.supportsWebAssembly;
  FeatureDetection.supportsWebAssembly = () => false;
  try {
    const wasmProcessor = new TaskProcessor("markedWasmWorker.js");
    const wasmPromise = wasmProcessor.initWebAssemblyModule({
      fallbackModulePath: "ThirdParty/fallback.js",
    });
    await waitUntil(() => typeof wasmProcessor._worker?.onerror === "function");
    const wasmEvent = makeErrorEvent({
      message: "Failed to load module script",
    });
    wasmProcessor._worker.onerror(wasmEvent);

    const wasmOutcome = await settleWithin(wasmPromise, 2000);
    assert.equal(wasmOutcome.status, "rejected");
    assert.equal(
      wasmEvent.preventDefaultCalls,
      1,
      "the web assembly init left the worker error to the page's global handler",
    );
    assert.deepEqual(consoleErrors.slice(wasmBefore).length, 1);
    assert.match(consoleErrors[wasmBefore], /markedWasmWorker\.js/u);
  } finally {
    FeatureDetection.supportsWebAssembly = supportsWebAssembly;
  }
});

test("the worker-error reports are outside every debug pragma block", async () => {
  // The other cases here read behaviour; this one reads the source, because
  // what it pins is a build-time property: a pragma block is an ordinary
  // comment at runtime, so a release build is the only place a wrapped
  // console.error goes missing, and by then a dead worker reports nothing at
  // all. The build's own spec asserts the mirror of this for a debug-only
  // literal that must NOT survive.
  const source = await readFile(path.join(coreDir, "TaskProcessor.js"), "utf8");

  const blocks = [
    ...source.matchAll(
      /\/\/>>includeStart\(\s*['"]debug['"][\s\S]*?\/\/>>includeEnd\(\s*['"]debug['"]\s*\)\s*;?/gu,
    ),
  ].map((match) => [match.index, match.index + match[0].length]);

  const reports = [...source.matchAll(/console\.error\(/gu)]
    .map((match) => match.index)
    .filter((index) =>
      source
        .slice(Math.max(0, index - 600), index)
        .includes("workerErrorMessage("),
    );

  assert.equal(
    reports.length,
    2,
    "expected one worker-error report on the task path and one on the web assembly init path",
  );

  for (const index of reports) {
    const line = source.slice(0, index).split(/\r?\n/u).length;
    const wrapped = blocks.some(
      ([start, end]) => index >= start && index < end,
    );
    assert.equal(
      wrapped,
      false,
      `the worker-error report at TaskProcessor.js:${line} sits inside a debug pragma block, so a release build strips it and a worker that cannot load reports nothing`,
    );
  }
});

test("an undeserializable message rejects the task instead of stranding it", async () => {
  const processor = new TaskProcessor("messageErrorWorker.js", 1);
  const worker = new StubWorker("messageErrorWorker.js");
  processor._worker = worker;

  const promise = processor.scheduleTask({ value: 1 });
  await waitUntil(() => worker.listenerCount("messageerror") === 1);
  worker.emit("messageerror", {});

  const outcome = await settleWithin(promise, 1000);
  assert.notEqual(outcome, TIMED_OUT, "the task promise never settled");
  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.reason instanceof RuntimeError, true);
  assert.match(outcome.reason.message, /messageErrorWorker\.js/u);
  assert.equal(processor._activeTasks, 0);
});

test("a web assembly init rejects when its worker errors", async () => {
  const supportsWebAssembly = FeatureDetection.supportsWebAssembly;
  // The fallback path keeps the init off the network: no binary is fetched.
  FeatureDetection.supportsWebAssembly = () => false;
  try {
    const processor = new TaskProcessor("wasmWorker.js");
    const promise = processor.initWebAssemblyModule({
      fallbackModulePath: "ThirdParty/fallback.js",
    });

    await waitUntil(() => typeof processor._worker?.onerror === "function");
    processor._worker.onerror?.({ message: "Failed to load module script" });

    const outcome = await settleWithin(promise, 1000);
    assert.notEqual(
      outcome,
      TIMED_OUT,
      "the cached web assembly promise never settled",
    );
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason instanceof RuntimeError, true);
    assert.match(outcome.reason.message, /wasmWorker\.js/u);
    assert.match(outcome.reason.message, /Failed to load module script/u);

    // The cached promise is the one every caller shares, so it has to stay
    // settled rather than hand a second caller a pending promise.
    const cached = await settleWithin(
      processor.initWebAssemblyModule({}),
      1000,
    );
    assert.equal(cached.status, "rejected");
  } finally {
    FeatureDetection.supportsWebAssembly = supportsWebAssembly;
  }
});
