// Static Node coverage for the Gulp/Karma completion bridge. No browser is
// launched: FakeKarmaServer emits the lifecycle events produced by Karma.
// @purpose Static coverage of the Gulp/Karma completion bridge via a fake Karma server: strict result config, retries, disconnect/error exit codes.
// @status ACTIVE
//
// Run with: node scripts/__tests__/karmaTestRun.spec.mjs

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  IncludeNameZeroMatchError,
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

  // Q-83: a `--includeName`/`--grep` pattern under which zero specs EXECUTE
  // produces a SPECIFIC real Karma signal -- `results.success + results.failed
  // === 0` AND `results.exitCode === 1` AND the done-callback exit code is
  // `1` too. Karma's own `calculateExitCode`
  // (node_modules/karma/lib/browser_collection.js) returns 1, never 0, for a
  // zero-executed run whenever `failOnEmptyTestSuite` is set, and this file
  // pins that true via `strictKarmaResultConfig`. A fixture using `exitCode:
  // 0` (this file's `createResults` default) is a state real Karma cannot
  // produce for this case and would certify nothing; every case below uses
  // the real shape (station-3 review pass 1: the original four cases used
  // `exitCode: 0` and so never reached `runKarmaTestServer`'s reclassification
  // branch at all -- exercised only via the mutation battery further below).
  // The two must still be DISTINGUISHABLE to a caller so a typo'd filter
  // isn't confused with a genuine test failure. `nameFilter` is the
  // discriminator.

  function zeroExecutedResults(overrides = {}) {
    return createResults({
      success: 0,
      failed: 0,
      skipped: 17422,
      exitCode: 1,
      ...overrides,
    });
  }

  {
    // The clean case: nameFilter supplied, nothing else wrong, on the REAL
    // zero-executed Karma signal (exitCode 1 on both results and the done
    // callback) -> the dedicated error class, not the generic one.
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            results: zeroExecutedResults(),
            exitCode: 1,
          });
        }),
        {},
        { nameFilter: "NoSuchSuiteAnywhere" },
      ),
      (error) => {
        assert.ok(
          error instanceof IncludeNameZeroMatchError,
          "must reject with IncludeNameZeroMatchError, not the generic error",
        );
        assert.match(error.message, /includeName selected 0 runnable specs/);
        assert.match(error.message, /NoSuchSuiteAnywhere/);
        assert.match(error.message, /17422 spec\(s\) reported skipped/);
        // Neither the old, refuted wording nor its own retracted "regular
        // expression" claim may reappear (station-3 review pass 1).
        assert.doesNotMatch(error.message, /matched 0 suites/);
        assert.doesNotMatch(
          error.message,
          /is a regular expression tested against/,
        );
        assert.match(error.message, /ESCAPED-LITERAL SUBSTRING/);
        assert.equal(error.code, "INCLUDE_NAME_ZERO_MATCH");
        return true;
      },
      "a name filter under which zero specs executed is its own distinguishable error, on the REAL Karma exit-1 signal",
    );
  }

  {
    // Without a nameFilter, the same real zero-executed signal stays the
    // GENERIC error -- the reclassification must not swallow the ordinary
    // empty-suite case.
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            results: zeroExecutedResults(),
            exitCode: 1,
          });
        }),
        {},
        {},
      ),
      (error) => {
        assert.equal(
          error instanceof IncludeNameZeroMatchError,
          false,
          "an unfiltered empty suite must not be reclassified",
        );
        assert.match(error.message, /without executing any browser tests/);
        assert.doesNotMatch(error.message, /selected 0 runnable specs/);
        return true;
      },
      "a real zero-executed run with no nameFilter keeps the generic acceptance error",
    );
  }

  {
    // A nameFilter is supplied, but the run ALSO had a real problem
    // (disconnected browser) alongside the real zero-executed signal: the
    // single-cause gate must fall through to the generic error, not hide
    // the disconnect behind "selected 0 runnable specs".
    const browser = createBrowser({
      disconnectsCount: 1,
      lastResult: { disconnected: true, error: false },
    });
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            browser,
            results: zeroExecutedResults(),
            exitCode: 1,
          });
        }),
        {},
        { nameFilter: "SomePattern" },
      ),
      (error) => {
        assert.equal(
          error instanceof IncludeNameZeroMatchError,
          false,
          "a disconnect alongside a zero-executed result must not be hidden as a zero-match",
        );
        assert.match(error.message, /disconnected during the run/);
        return true;
      },
      "a nameFilter cannot mask a real infrastructure failure riding with it",
    );
  }

  {
    // The empty-suite reclassification is unconditional on failTaskOnError,
    // matching the existing "opt-out never permits an empty run" contract.
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            results: zeroExecutedResults(),
            exitCode: 1,
          });
        }),
        {},
        { failTaskOnError: false, nameFilter: "AnotherPattern" },
      ),
      (error) => error instanceof IncludeNameZeroMatchError,
      "failTaskOnError:false does not exempt a real zero-executed run either",
    );
  }

  {
    // Pins the `validCounts` conjunct of `emptySuiteCleanly` (station-3
    // review pass 1, mutation M5: forcing `getCompletionFailures` to always
    // return `emptySuiteCleanly: true` regardless of its real computation).
    // `success + failed === 0` here too (-1 + 1), so a check that only
    // looked at the SUM would misclassify this as zero-executed; only
    // `validCounts` catches it. Exit codes are left at 0 (the default) --
    // NOT 1 -- so `expectedExitCode` is satisfied by the `code === 0`
    // disjunct regardless of `validCounts`/`emptySuiteExpected`, and exactly
    // one failure string is pushed ("malformed browser test counts"),
    // giving `failures.length === 1`. That means the `failures.length === 1`
    // gate (M2) does NOT save this case on its own -- only `validCounts`
    // inside `emptySuiteCleanly` does, so under M5 this run would incorrectly
    // become an `IncludeNameZeroMatchError` while the real code correctly
    // keeps it generic.
    await assert.rejects(
      runKarmaTestServer(
        makeFakeKarmaServer((server, done) => {
          emitCompleteLifecycle(server, done, {
            results: createResults({ success: -1, failed: 1 }),
          });
        }),
        {},
        { nameFilter: "AnyPattern" },
      ),
      (error) => {
        assert.equal(
          error instanceof IncludeNameZeroMatchError,
          false,
          "malformed counts must never be reclassified as a zero-match, even with a nameFilter and a single failure string",
        );
        assert.match(error.message, /malformed browser test counts/);
        return true;
      },
      "malformed counts summing to zero are not a zero-match -- pins the validCounts conjunct of emptySuiteCleanly (M5)",
    );
  }

  // M2 (dropping the `failures.length === 1` gate from `isPureZeroMatch &&
  // failures.length === 1`): the one scenario that gate uniquely covers is
  // `removeEdgeProfileDirectories` genuinely failing (a real `fs.rm`
  // rejection) while `getCompletionFailures` independently reports
  // `emptySuiteCleanly: true` -- every OTHER push into `failures` is tied
  // 1:1 to one of `emptySuiteCleanly`'s own conjuncts, so this cleanup push
  // (which happens strictly after `getCompletionFailures` returns) is
  // architecturally the only gap. Three techniques (open write handle,
  // read-only chmod, NUL-byte path) all failed to construct it (station-3
  // review pass 1). Station-3 review pass 2 found a fourth that works:
  // holding the profile directory as THIS PROCESS'S OWN CWD -- Windows
  // refuses to remove a directory that is the current working directory
  // (EBUSY). POSIX permits removing the CWD, so this only discriminates on
  // win32; CI is ubuntu-latest (`.github/workflows/dev.yml`), so the case is
  // guarded and records a truthful skip there rather than running a
  // technique that would not discriminate.
  if (process.platform === "win32") {
    const profileDirectory = path.join(
      tmpdir(),
      `karma-edge-${Date.now()}-${process.pid}`,
    );
    await mkdir(profileDirectory, { recursive: true });
    const originalCwd = process.cwd();
    process.chdir(profileDirectory);
    try {
      await assert.rejects(
        runKarmaTestServer(
          makeFakeKarmaServer((server, done) => {
            emitCompleteLifecycle(server, done, {
              results: zeroExecutedResults(),
              exitCode: 1,
            });
          }),
          edgeProfileConfig(profileDirectory),
          { nameFilter: "AnyPattern" },
        ),
        (error) => {
          assert.equal(
            error instanceof IncludeNameZeroMatchError,
            false,
            "a genuine Edge-profile-cleanup failure alongside a zero-executed result must not be hidden as a zero-match -- pins the failures.length===1 gate (M2)",
          );
          assert.match(error.message, /Could not remove the Edge test profile/);
          return true;
        },
        "holding the profile directory as this process's CWD makes cleanup genuinely fail (Windows EBUSY, resource busy or locked), which the failures.length===1 gate must not swallow into a false zero-match",
      );
    } finally {
      process.chdir(originalCwd);
      await rm(profileDirectory, { recursive: true, force: true });
    }
  } else {
    console.log(
      `M2 CWD-hold case: skipped (windows-only technique; process.platform is "${process.platform}")`,
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
