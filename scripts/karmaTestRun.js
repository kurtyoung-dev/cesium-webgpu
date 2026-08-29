import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Result policy for the browser unit-test task. Keep these values explicit so
 * a Karma dependency update cannot turn an empty or failing suite into a
 * successful Gulp task.
 */
export const strictKarmaResultConfig = Object.freeze({
  failOnEmptyTestSuite: true,
  failOnFailingTestSuite: true,
});

const edgeProfileNamePattern = /^karma-edge-\d+-\d+$/;

function getEdgeProfileDirectories(config) {
  const customLaunchers = config?.customLaunchers;
  const browsers = config?.browsers;
  if (
    customLaunchers === undefined ||
    !Array.isArray(browsers) ||
    browsers.length === 0
  ) {
    return [];
  }

  const selectedBrowsers = new Set(browsers);
  const tempDirectory = path.resolve(tmpdir());
  const profileDirectories = new Set();

  for (const [name, launcher] of Object.entries(customLaunchers)) {
    if (!selectedBrowsers.has(name) || !Array.isArray(launcher?.flags)) {
      continue;
    }

    for (const flag of launcher.flags) {
      if (typeof flag !== "string" || !flag.startsWith("--user-data-dir=")) {
        continue;
      }

      const profileDirectory = path.resolve(
        flag.slice("--user-data-dir=".length),
      );
      const parentDirectory = path.dirname(profileDirectory);
      const sameParent =
        process.platform === "win32"
          ? parentDirectory.toLowerCase() === tempDirectory.toLowerCase()
          : parentDirectory === tempDirectory;
      if (
        sameParent &&
        edgeProfileNamePattern.test(path.basename(profileDirectory))
      ) {
        profileDirectories.add(profileDirectory);
      }
    }
  }

  return [...profileDirectories];
}

async function removeEdgeProfileDirectories(profileDirectories) {
  await Promise.all(
    profileDirectories.map((profileDirectory) =>
      rm(profileDirectory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  );
}

function browserCollectionToArray(browsers) {
  const result = [];
  if (Array.isArray(browsers)) {
    return browsers;
  }
  if (typeof browsers?.forEach === "function") {
    browsers.forEach((browser) => result.push(browser));
  }
  return result;
}

function formatBrowser(browser) {
  return browser?.fullName ?? browser?.name ?? browser?.id ?? "unknown browser";
}

/**
 * @typedef {object} CompletionFailures
 * @property {string[]} failures Human-readable reasons the run is not accepted.
 * @property {boolean} emptySuiteCleanly True when the ONLY thing wrong with an
 *   otherwise fully-completed, single-cause run is that zero browser tests
 *   executed — i.e. every browser finished its lifecycle normally, no
 *   infrastructure or disconnect/error signal fired, and the aggregate counts
 *   are valid but sum to zero (Karma's own exit code 1 for this exact case,
 *   under the pinned `failOnEmptyTestSuite: true`, is treated as expected,
 *   not as an additional failure). This is the signal a `--includeName`/
 *   `--grep` pattern under which zero specs EXECUTED produces (Q-83) — which
 *   includes both "matched no spec name" and "matched only specs Karma
 *   reports as skipped"; it cannot tell those apart. Computed independently
 *   of `failures`'s text so a caller can react to the SHAPE of the failure,
 *   not by pattern-matching a message.
 * @property {number|null} skippedCount Karma's reported `results.skipped`
 *   count, when the run produced aggregate results and it was an integer;
 *   `null` otherwise. Cannot disambiguate a zero-match run from a
 *   matched-only-skipped-specs run (a real zero-match sets it to the whole
 *   spec count too), but is worth surfacing to whoever reads the message.
 */

/**
 * @returns {CompletionFailures}
 */
function getCompletionFailures(state, exitCode, failTaskOnError) {
  const failures = [];
  const run = state.run;
  if (run === undefined) {
    failures.push("Karma's done callback fired before a run_complete event.");
    return { failures, emptySuiteCleanly: false, skippedCount: null };
  }

  const runBrowsers = browserCollectionToArray(run.browsers);
  if (runBrowsers.length === 0) {
    failures.push("run_complete reported no captured browsers.");
  }

  let everyBrowserLifecycleClean = runBrowsers.length > 0;
  for (const browser of runBrowsers) {
    const missingEvents = [];
    if (!state.registeredBrowsers.has(browser)) {
      missingEvents.push("browser_register");
    }
    if (!state.startedBrowsers.has(browser)) {
      missingEvents.push("browser_start");
    }
    if (!state.completedBrowsers.has(browser)) {
      missingEvents.push("browser_complete_with_no_more_retries");
    }
    if (missingEvents.length > 0) {
      failures.push(
        `${formatBrowser(browser)} has an incomplete lifecycle (missing ${missingEvents.join(
          ", ",
        )}).`,
      );
      everyBrowserLifecycleClean = false;
    }
    if (browser?.disconnectsCount > 0 || browser?.lastResult?.disconnected) {
      failures.push(`${formatBrowser(browser)} disconnected during the run.`);
      everyBrowserLifecycleClean = false;
    }
    if (browser?.lastResult?.error) {
      failures.push(`${formatBrowser(browser)} reported a browser error.`);
      everyBrowserLifecycleClean = false;
    }
  }

  if (state.infrastructureFailures.length > 0) {
    failures.push(...state.infrastructureFailures);
  }

  const results = run.results;
  let emptySuiteCleanly = false;
  if (results === undefined || results === null) {
    failures.push("run_complete did not provide aggregate results.");
  } else {
    if (results.disconnected) {
      failures.push("Karma aggregate results report a disconnected browser.");
    }
    if (results.error) {
      failures.push("Karma aggregate results report a browser error.");
    }

    const successCount = results.success;
    const failedCount = results.failed;
    const validCounts =
      Number.isInteger(successCount) &&
      successCount >= 0 &&
      Number.isInteger(failedCount) &&
      failedCount >= 0;
    if (!validCounts) {
      failures.push("run_complete reported malformed browser test counts.");
    } else {
      if (successCount + failedCount === 0) {
        failures.push("Karma completed without executing any browser tests.");
      }
      if (failTaskOnError && failedCount > 0) {
        failures.push(`${failedCount} browser test(s) failed.`);
      }
    }

    const suiteFailureOptOut =
      !failTaskOnError && validCounts && failedCount > 0;
    // Karma's own `calculateExitCode` (node_modules/karma/lib/browser_collection.js)
    // returns 1 -- not 0 -- for a completed run with zero executed tests
    // whenever `failOnEmptyTestSuite` is set, which `strictKarmaResultConfig`
    // pins true. Both the aggregate `results.exitCode` and the done-callback
    // `exitCode` carry that 1. Treat it as EXPECTED, the same way
    // `suiteFailureOptOut` already treats its own opt-out 1, so an empty-suite
    // run is reported through its dedicated "Karma completed without
    // executing any browser tests." failure alone -- without this, the exit-
    // code checks below ALSO fire, `exitCodesClean` is never true for an empty
    // suite, and `emptySuiteCleanly` (and therefore the Q-83 zero-match
    // reclassification in `runKarmaTestServer`) can never be reached.
    const emptySuiteExpected = validCounts && successCount + failedCount === 0;
    const expectedExitCode = (code) =>
      code === 0 ||
      (suiteFailureOptOut && code === 1) ||
      (emptySuiteExpected && code === 1);
    let exitCodesClean = true;
    if (!Number.isInteger(results.exitCode)) {
      failures.push("run_complete reported a malformed exit code.");
      exitCodesClean = false;
    } else if (!expectedExitCode(results.exitCode)) {
      failures.push(`run_complete reported exit code ${results.exitCode}.`);
      exitCodesClean = false;
    }

    if (!Number.isInteger(exitCode)) {
      failures.push("Karma's done callback reported a malformed exit code.");
      exitCodesClean = false;
    } else if (!expectedExitCode(exitCode)) {
      failures.push(`Karma's done callback reported exit code ${exitCode}.`);
      exitCodesClean = false;
    }

    emptySuiteCleanly =
      everyBrowserLifecycleClean &&
      state.infrastructureFailures.length === 0 &&
      !results.disconnected &&
      !results.error &&
      validCounts &&
      successCount + failedCount === 0 &&
      exitCodesClean;
  }

  return {
    failures,
    emptySuiteCleanly,
    skippedCount: Number.isInteger(results?.skipped) ? results.skipped : null,
  };
}

/**
 * Raised instead of the generic acceptance error when a `--includeName` /
 * `--grep` pattern left zero specs EXECUTED (Karma's success+failed===0
 * signal) and nothing else about the run was wrong (Q-83). Both cases used
 * to reject with the same generic Error and the same eventual process exit
 * code, so a typo'd filter and a genuine failing suite were indistinguishable
 * from the exit code or from grepping CI log tails for anything other than
 * the exact English sentence.
 *
 * NOT the same claim as "the pattern matched no suite": Karma's signal
 * cannot tell that apart from "the pattern matched only specs Karma reports
 * as skipped" (`xit()`/`xdescribe()`/pending, or specs this fork's
 * offline/WebGPU lanes truthfully skip when their prerequisite is absent) —
 * both land in `results.skipped`, not `success` or `failed`. The message
 * says so and reports the skipped count when Karma provided one.
 */
export class IncludeNameZeroMatchError extends Error {
  constructor(pattern, skippedCount) {
    const skippedText = Number.isInteger(skippedCount)
      ? `, ${skippedCount} spec(s) reported skipped`
      : "";
    super(
      `includeName selected 0 runnable specs (pattern: ${JSON.stringify(pattern ?? "")}${skippedText}). ` +
        "--includeName/--grep is compared against each spec's full Jasmine " +
        "name (its describe-block path plus the it() name): a PLAIN pattern " +
        "is matched as an ESCAPED-LITERAL SUBSTRING of that name, not a " +
        "regular expression — only a pattern written as /pattern/flags is a " +
        "live regex. The pattern reported above is the post-strip EFFECTIVE " +
        "one (a trailing 'Spec' and/or '.js' is stripped before matching). " +
        "Zero specs ran because either the pattern matched no spec name, or " +
        "it matched only specs Karma reports as skipped — check both before " +
        "assuming a typo: a suite's describe(...)/it(...) text, and whether " +
        "this fork's offline or WebGPU lane is truthfully skipping on this " +
        "machine.",
    );
    this.name = "IncludeNameZeroMatchError";
    this.code = "INCLUDE_NAME_ZERO_MATCH";
  }
}

/**
 * Starts a Karma server and accepts only a completed browser lifecycle before
 * settling the promise expected by Gulp.
 *
 * @param {typeof import("karma").Server} KarmaServer Karma's Server class.
 * @param {object} config Parsed Karma configuration.
 * @param {object} [options] Run options.
 * @param {boolean} [options.failTaskOnError=true] Reject on a non-zero suite exit. Infrastructure failures always reject.
 * @param {string} [options.nameFilter] The `--includeName`/`--grep` pattern
 *   this run was launched with, if any. When supplied AND the run completes
 *   with an otherwise-clean zero-EXECUTED-test result (every browser's
 *   lifecycle finished normally, no infrastructure/disconnect/error signal,
 *   valid counts summing to zero, Karma's own exit-1-for-empty-suite treated
 *   as expected rather than an extra failure), the rejection is an
 *   {@link IncludeNameZeroMatchError} instead of the generic acceptance error
 *   (Q-83) — callers that want a distinct process exit code for "the filter
 *   selected zero runnable specs" (as opposed to a genuine suite/
 *   infrastructure failure) can branch on that class. That state does NOT
 *   mean "the pattern matched no suite" specifically — it also covers a
 *   pattern that matched only specs Karma reports as skipped.
 * @returns {Promise<void>} Resolves only when the accepted run completes.
 */
export function runKarmaTestServer(
  KarmaServer,
  config,
  { failTaskOnError = true, nameFilter } = {},
) {
  return new Promise((resolve, reject) => {
    const state = {
      registeredBrowsers: new Set(),
      startedBrowsers: new Set(),
      completedBrowsers: new Set(),
      infrastructureFailures: [],
      run: undefined,
    };
    const profileDirectories = getEdgeProfileDirectories(config);
    let finalizing = false;

    const finalize = async (exitCode, startError) => {
      if (finalizing) {
        return;
      }
      finalizing = true;

      const { failures, emptySuiteCleanly, skippedCount } =
        getCompletionFailures(state, exitCode, failTaskOnError);
      // Captured BEFORE the start-error unshift and the cleanup push below,
      // so a startup failure or a profile-cleanup failure riding alongside
      // an empty result always falls through to the generic path — only a
      // SINGLE-CAUSE empty-EXECUTED-tests run is eligible to be reclassified
      // as a filter that selected zero runnable specs.
      const isPureZeroMatch =
        startError === undefined &&
        emptySuiteCleanly &&
        typeof nameFilter === "string" &&
        nameFilter.length > 0;
      if (startError !== undefined) {
        failures.unshift(`Karma server failed to start: ${String(startError)}`);
      }

      try {
        await removeEdgeProfileDirectories(profileDirectories);
      } catch (error) {
        failures.push(
          `Could not remove the Edge test profile: ${String(error)}`,
        );
      }

      if (failures.length > 0) {
        if (isPureZeroMatch && failures.length === 1) {
          const zeroMatchError = new IncludeNameZeroMatchError(
            nameFilter,
            skippedCount,
          );
          // The unmistakable line: distinct wording from every other
          // acceptance failure, and printed unconditionally so it survives
          // even if a caller only inspects stdout/stderr rather than the
          // rejected error's class or `.code`.
          console.error(zeroMatchError.message);
          reject(zeroMatchError);
          return;
        }
        reject(
          new Error(
            `Karma test run was not accepted:\n- ${failures.join("\n- ")}`,
          ),
        );
        return;
      }
      resolve();
    };

    let server;
    try {
      server = new KarmaServer(config, function doneCallback(exitCode) {
        void finalize(exitCode);
      });
    } catch (error) {
      void finalize(undefined, error);
      return;
    }

    server.on("browser_register", (browser) => {
      state.registeredBrowsers.add(browser);
    });
    server.on("browser_start", (browser) => {
      state.startedBrowsers.add(browser);
    });
    server.on("browser_complete_with_no_more_retries", (browser) => {
      state.completedBrowsers.add(browser);
    });
    server.on("browser_error", (browser, error) => {
      state.infrastructureFailures.push(
        `${formatBrowser(browser)} emitted browser_error: ${String(error)}`,
      );
    });
    server.on("browser_process_failure", (browser) => {
      state.infrastructureFailures.push(
        `${formatBrowser(browser)} failed before completing its browser process.`,
      );
    });
    server.on("browser_restart_failure", (browser) => {
      state.infrastructureFailures.push(
        `${formatBrowser(browser)} could not restart after a disconnect.`,
      );
    });
    server.on("run_complete", (browsers, results) => {
      state.run = { browsers, results };
    });

    try {
      const startResult = server.start();
      Promise.resolve(startResult).catch((error) => {
        void finalize(undefined, error);
      });
    } catch (error) {
      void finalize(undefined, error);
    }
  });
}
