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

  // ───────────────────────────────────────────────────────────────────────
  // Q-119 — the verdict must not depend on which signal arrived last.
  //
  // Three byte-identical `gulp test --includeName ZZZNOMATCH` runs exited 0,
  // 3 and 3. The exit code was being decided by the state that happened to
  // have arrived when Karma's done callback fired: a `run_complete` or a
  // terminal `browser_complete_with_no_more_retries` that landed a moment
  // later turned a zero-match (3) into a generic acceptance failure (1), and
  // a done callback that never arrived at all left this promise pending — the
  // Gulp task never settled, no exit code was ever set, and the process
  // exited 0 with nothing printed. That last one is the 0.
  //
  // These fixtures drive the same zero-executed run under every arrival order
  // and require ONE verdict from all of them. The controls below require that
  // the verdict is still earned: a disconnect, a genuine suite failure and a
  // passing run each keep their own outcome.
  // ───────────────────────────────────────────────────────────────────────
  {
    const newBrowser = () =>
      createBrowser({ id: "ordering", fullName: "Edge Headless (ordering)" });
    const zeroExecuted = () => zeroExecutedResults();

    async function settleOutcome(scenario, { config, ...options } = {}) {
      const captured = { error: [], warn: [] };
      const realError = console.error;
      const realWarn = console.warn;
      console.error = (message) => captured.error.push(String(message));
      console.warn = (message) => captured.warn.push(String(message));

      let outcome = { kind: "pending", captured };
      const settled = runKarmaTestServer(
        makeFakeKarmaServer(scenario),
        config ?? {},
        {
          nameFilter: "ZZZNOMATCH",
          lateEventGraceMs: 20,
          doneCallbackTimeoutMs: 60,
          ...options,
        },
      )
        .then(() => {
          outcome = { kind: "resolved", captured };
        })
        .catch((error) => {
          outcome = {
            kind:
              error instanceof IncludeNameZeroMatchError
                ? "zero-match"
                : "generic",
            message: error.message,
            captured,
          };
        });

      try {
        // A budget, not a wait: whatever the outcome is, it must be reached
        // well inside this. Exceeding it IS the pending failure.
        await Promise.race([
          settled,
          new Promise((resolveRace) => setTimeout(resolveRace, 1000)),
        ]);
      } finally {
        console.error = realError;
        console.warn = realWarn;
      }
      return outcome;
    }

    const orderings = {
      "canonical: lifecycle, run_complete, done": (server, done) => {
        const browser = newBrowser();
        server.emit("browser_register", browser);
        server.emit("browser_start", browser, { total: 0 });
        server.emit("browser_complete_with_no_more_retries", browser);
        server.emit("run_complete", [browser], zeroExecuted());
        done(1);
      },
      "done before run_complete": (server, done) => {
        const browser = newBrowser();
        server.emit("browser_register", browser);
        server.emit("browser_start", browser, { total: 0 });
        server.emit("browser_complete_with_no_more_retries", browser);
        done(1);
        server.emit("run_complete", [browser], zeroExecuted());
      },
      "done before the terminal browser_complete": (server, done) => {
        const browser = newBrowser();
        server.emit("browser_register", browser);
        server.emit("browser_start", browser, { total: 0 });
        server.emit("run_complete", [browser], zeroExecuted());
        done(1);
        server.emit("browser_complete_with_no_more_retries", browser);
      },
      "the terminal browser_complete a tick after done": (server, done) => {
        const browser = newBrowser();
        server.emit("browser_register", browser);
        server.emit("browser_start", browser, { total: 0 });
        server.emit("run_complete", [browser], zeroExecuted());
        done(1);
        setTimeout(
          () => server.emit("browser_complete_with_no_more_retries", browser),
          5,
        );
      },
      "run_complete a tick after done": (server, done) => {
        const browser = newBrowser();
        server.emit("browser_register", browser);
        server.emit("browser_start", browser, { total: 0 });
        server.emit("browser_complete_with_no_more_retries", browser);
        done(1);
        setTimeout(
          () => server.emit("run_complete", [browser], zeroExecuted()),
          5,
        );
      },
      "done carries 0 while the counts are zero": (server, done) => {
        const browser = newBrowser();
        server.emit("browser_register", browser);
        server.emit("browser_start", browser, { total: 0 });
        server.emit("browser_complete_with_no_more_retries", browser);
        server.emit("run_complete", [browser], zeroExecuted());
        done(0);
      },
      "done fires twice with different codes": (server, done) => {
        const browser = newBrowser();
        server.emit("browser_register", browser);
        server.emit("browser_start", browser, { total: 0 });
        server.emit("browser_complete_with_no_more_retries", browser);
        server.emit("run_complete", [browser], zeroExecuted());
        done(1);
        done(0);
      },
      "done never arrives at all": (server) => {
        const browser = newBrowser();
        server.emit("browser_register", browser);
        server.emit("browser_start", browser, { total: 0 });
        server.emit("browser_complete_with_no_more_retries", browser);
        server.emit("run_complete", [browser], zeroExecuted());
      },
    };

    // Every ordering is measured BEFORE anything is asserted, so a failure
    // reports the whole map — which is the actual finding. Asserting inside
    // the loop would stop at the first divergent ordering and hide the one
    // that never settles at all.
    const verdicts = {};
    const announced = {};
    for (const [name, scenario] of Object.entries(orderings)) {
      const outcome = await settleOutcome(scenario);
      verdicts[name] = outcome.kind;
      announced[name] = outcome.captured.error.some((line) =>
        line.includes("includeName selected 0 runnable specs"),
      );
    }

    const oneVerdict = Object.fromEntries(
      Object.keys(orderings).map((name) => [name, "zero-match"]),
    );
    assert.deepEqual(
      verdicts,
      oneVerdict,
      "the same zero-executed run must reach the same verdict under every " +
        'arrival order ("pending" is the silent exit 0: no verdict, no exit ' +
        "code, no output)",
    );
    assert.deepEqual(
      announced,
      Object.fromEntries(Object.keys(orderings).map((name) => [name, true])),
      "every ordering must still print the unmistakable line",
    );

    // The missing done callback is an anomaly even though the run is fully
    // described without it, so it is reported rather than absorbed silently.
    const withoutDone = await settleOutcome(
      orderings["done never arrives at all"],
    );
    assert.ok(
      withoutDone.captured.warn.some((line) =>
        line.includes("never invoked its done callback"),
      ),
      "classifying without the done callback must say so",
    );

    // Controls. A verdict that every ordering reaches is only worth having if
    // it is still earned.
    const disconnected = await settleOutcome((server, done) => {
      const browser = newBrowser();
      browser.disconnectsCount = 1;
      server.emit("browser_register", browser);
      server.emit("browser_start", browser, { total: 0 });
      server.emit("browser_complete_with_no_more_retries", browser);
      server.emit("run_complete", [browser], zeroExecuted());
      done(1);
    });
    assert.equal(
      disconnected.kind,
      "generic",
      "a disconnect riding along with an empty suite is not a zero-match",
    );

    const realFailure = await settleOutcome((server, done) => {
      const browser = newBrowser();
      server.emit("browser_register", browser);
      server.emit("browser_start", browser, { total: 0 });
      server.emit("browser_complete_with_no_more_retries", browser);
      server.emit(
        "run_complete",
        [browser],
        createResults({ success: 10, failed: 2, exitCode: 1 }),
      );
      done(1);
    });
    assert.equal(
      realFailure.kind,
      "generic",
      "a genuinely failing suite keeps the generic acceptance error",
    );

    const passing = await settleOutcome((server, done) => {
      const browser = newBrowser();
      server.emit("browser_register", browser);
      server.emit("browser_start", browser, { total: 1 });
      server.emit("browser_complete_with_no_more_retries", browser);
      server.emit("run_complete", [browser], createResults({ success: 12 }));
      done(0);
    });
    assert.equal(passing.kind, "resolved", "a passing run still resolves");

    // A run that produces no signal at all must not be reported as anything:
    // the watchdog is armed by `run_complete`, so there is nothing to classify
    // from, and inventing a verdict here would be the opposite defect.
    const silent = await settleOutcome(() => {});
    assert.equal(
      silent.kind,
      "pending",
      "a server that emits nothing must not be given a verdict",
    );

    // `gulp test --debug` runs with `singleRun: false`, and Karma's executor
    // emits `run_complete` after EVERY run — watch-mode runs included — while
    // only a single run goes on to `_close` and therefore to the done
    // callback. Pending is the CORRECT outcome there: the headed browser is
    // meant to stay up until the developer closes it. A watchdog that armed
    // anyway would classify a live session about thirty seconds in, reject a
    // debug run that is not failing, print a shutdown warning where none
    // applies, and — because the classification also reaps the Edge profile —
    // delete the profile directory the browser is running out of.
    const watchProfile = path.join(
      tmpdir(),
      `karma-edge-${Date.now() + 3}-${process.pid}`,
    );
    await mkdir(watchProfile, { recursive: true });
    try {
      const watchMode = await settleOutcome(
        (server) => {
          const browser = newBrowser();
          server.emit("browser_register", browser);
          server.emit("browser_start", browser, { total: 0 });
          server.emit("browser_complete_with_no_more_retries", browser);
          server.emit("run_complete", [browser], zeroExecuted());
        },
        { config: { ...edgeProfileConfig(watchProfile), singleRun: false } },
      );
      // All three observations are taken before anything is asserted, so a
      // regression reports every way it harmed the session rather than only
      // the first.
      assert.deepEqual(
        {
          verdict: watchMode.kind,
          warnings: watchMode.captured.warn.length,
          profileSurvives: await pathExists(watchProfile),
        },
        { verdict: "pending", warnings: 0, profileSurvives: true },
        "a watch-mode session must be left running, unwarned, with the " +
          "browser profile it is running out of still on disk",
      );
    } finally {
      await rm(watchProfile, { recursive: true, force: true });
    }
  }

  console.log("karmaTestRun policy: all checks passed");
}

await run();
