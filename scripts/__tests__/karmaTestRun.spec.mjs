// Static Node coverage for the Gulp/Karma completion bridge. No browser is
// launched: FakeKarmaServer emits the lifecycle events produced by Karma.
//
// Run with: node scripts/__tests__/karmaTestRun.spec.mjs

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  runKarmaTestServer,
  strictKarmaResultConfig,
} from "../karmaTestRun.js";

let browserId = 0;

function createBrowser(overrides = {}) {
  browserId++;
  return {
    id: `browser-${browserId}`,
    fullName: `Edge Headless ${browserId}`,
    disconnectsCount: 0,
    lastResult: {
      disconnected: false,
      error: false,
    },
    ...overrides,
  };
}

function createResults(overrides = {}) {
  return {
    success: 1,
    failed: 0,
    skipped: 0,
    error: false,
    disconnected: false,
    exitCode: 0,
    ...overrides,
  };
}

function emitCompleteLifecycle(server, done, options = {}) {
  const browser = options.browser ?? createBrowser();
  server.emit("browser_register", browser);
  if (options.emitStart !== false) {
    server.emit("browser_start", browser, { total: 1 });
  }
  if (options.emitTerminalComplete !== false) {
    server.emit("browser_complete_with_no_more_retries", browser);
  }
  server.emit(
    "run_complete",
    options.browsers ?? [browser],
    options.results ?? createResults(),
  );
  done(options.exitCode ?? 0);
}

function makeFakeKarmaServer(scenario, state = {}) {
  return class FakeKarmaServer extends EventEmitter {
    constructor(config, done) {
      super();
      state.config = config;
      state.done = done;
    }

    start() {
      state.started = true;
      return scenario(this, state.done);
    }
  };
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function edgeProfileConfig(profileDirectory) {
  return {
    browsers: ["EdgeHeadlessCI"],
    customLaunchers: {
      EdgeHeadlessCI: {
        flags: [`--user-data-dir=${profileDirectory}`],
      },
    },
  };
}

async function run() {
  assert.deepEqual(strictKarmaResultConfig, {
    failOnEmptyTestSuite: true,
    failOnFailingTestSuite: true,
  });

  {
    const state = {};
    await runKarmaTestServer(
      makeFakeKarmaServer((server, done) => {
        emitCompleteLifecycle(server, done);
      }, state),
      { name: "success" },
    );
    assert.equal(state.started, true, "a successful Karma run starts");
    assert.deepEqual(state.config, { name: "success" });
  }

  {
    const state = {};
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          assert.ok(server instanceof EventEmitter);
          done(0);
        }, state),
        {},
      ),
      /done callback fired before a run_complete event/,
      "a zero callback cannot turn an absent browser run into success",
    );
    assert.equal(state.started, true);
  }

  for (const missingEvent of ["browser_start", "terminal completion"]) {
    const state = {};
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            emitStart: missingEvent !== "browser_start",
            emitTerminalComplete: missingEvent !== "terminal completion",
          });
        }, state),
        {},
      ),
      /incomplete lifecycle/,
      `${missingEvent} is required for a completed run`,
    );
  }

  {
    const browser = createBrowser({
      disconnectsCount: 1,
      lastResult: { disconnected: true, error: false },
    });
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            browser,
            results: createResults({ disconnected: true }),
          });
        }),
        {},
      ),
      /disconnected during the run/,
      "a disconnected browser fails even if the done callback reports zero",
    );
  }

  for (const failureEvent of [
    "browser_error",
    "browser_process_failure",
    "browser_restart_failure",
  ]) {
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          const browser = createBrowser();
          server.emit(failureEvent, browser, "synthetic failure");
          emitCompleteLifecycle(server, done, { browser });
        }),
        {},
      ),
      /synthetic failure|failed before completing|could not restart/,
      `${failureEvent} cannot be hidden by a later zero exit code`,
    );
  }

  {
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            results: createResults({ success: 0, failed: 1, exitCode: 1 }),
            exitCode: 1,
          });
        }),
        {},
      ),
      /1 browser test\(s\) failed/,
      "a completed failing suite rejects by default",
    );
  }

  {
    await runKarmaTestServer(
      makeFakeKarmaServer((server, done) => {
        emitCompleteLifecycle(server, done, {
          results: createResults({ success: 0, failed: 1, exitCode: 1 }),
          exitCode: 1,
        });
      }),
      {},
      { failTaskOnError: false },
    );
  }

  {
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            results: createResults({ success: 0 }),
          });
        }),
        {},
        { failTaskOnError: false },
      ),
      /without executing any browser tests/,
      "the suite-failure opt-out never permits an empty run",
    );
  }

  for (const [source, resultExitCode, callbackExitCode, expectedMessage] of [
    ["aggregate", 1, 0, /run_complete reported exit code 1/],
    ["callback", 0, 1, /done callback reported exit code 1/],
  ]) {
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            results: createResults({ success: 1, exitCode: resultExitCode }),
            exitCode: callbackExitCode,
          });
        }),
        {},
        { failTaskOnError: false },
      ),
      expectedMessage,
      `an unexplained nonzero ${source} exit is not a suite-failure opt-out`,
    );
  }

  {
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            results: createResults({ success: undefined }),
          });
        }),
        {},
        { failTaskOnError: false },
      ),
      /malformed browser test counts/,
      "the suite-failure opt-out never permits malformed aggregate counts",
    );
  }

  {
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            results: createResults({ success: 0 }),
          });
        }),
        {},
      ),
      /without executing any browser tests/,
      "an empty suite cannot satisfy the completion contract",
    );
  }

  {
    const profileDirectory = path.join(
      tmpdir(),
      `karma-edge-${Date.now()}-${process.pid}`,
    );
    await mkdir(profileDirectory, { recursive: true });
    await runKarmaTestServer(
      makeFakeKarmaServer((server, done) => {
        emitCompleteLifecycle(server, done);
      }),
      edgeProfileConfig(profileDirectory),
    );
    assert.equal(
      await pathExists(profileDirectory),
      false,
      "the exact per-run Edge profile is reaped before success resolves",
    );
  }

  {
    const profileDirectory = path.join(
      tmpdir(),
      `karma-edge-${Date.now() + 1}-${process.pid}`,
    );
    await mkdir(profileDirectory, { recursive: true });
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          assert.ok(server instanceof EventEmitter);
          done(0);
        }),
        edgeProfileConfig(profileDirectory),
      ),
      /done callback fired before a run_complete event/,
    );
    assert.equal(
      await pathExists(profileDirectory),
      false,
      "the Edge profile is also reaped after a rejected run",
    );
  }

  {
    const unrelatedDirectory = path.join(
      tmpdir(),
      `not-karma-edge-${Date.now()}-${process.pid}`,
    );
    await mkdir(unrelatedDirectory, { recursive: true });
    try {
      await runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done);
        }),
        edgeProfileConfig(unrelatedDirectory),
      );
      assert.equal(
        await pathExists(unrelatedDirectory),
        true,
        "cleanup is confined to uniquely named karma-edge profiles",
      );
    } finally {
      await rm(unrelatedDirectory, { recursive: true, force: true });
    }
  }

  {
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer(() => Promise.reject(new Error("start exploded"))),
        {},
      ),
      /Karma server failed to start: Error: start exploded/,
      "an asynchronous server-start failure rejects",
    );
  }

  {
    const profileDirectory = path.join(
      tmpdir(),
      `karma-edge-${Date.now() + 2}-${process.pid}`,
    );
    await mkdir(profileDirectory, { recursive: true });
    class ThrowingKarmaServer {
      constructor() {
        throw new Error("constructor exploded");
      }
    }
    await assert.rejects(
      runKarmaTestServer(
        ThrowingKarmaServer,
        edgeProfileConfig(profileDirectory),
      ),
      /Karma server failed to start: Error: constructor exploded/,
      "a synchronous server-construction failure rejects",
    );
    assert.equal(
      await pathExists(profileDirectory),
      false,
      "profile cleanup also runs when server construction fails",
    );
  }

  console.log("karmaTestRun policy: all checks passed");
}

await run();
