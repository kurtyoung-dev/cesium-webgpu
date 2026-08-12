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

function getCompletionFailures(state, exitCode, failTaskOnError) {
  const failures = [];
  const run = state.run;
  if (run === undefined) {
    failures.push("Karma's done callback fired before a run_complete event.");
    return failures;
  }

  const runBrowsers = browserCollectionToArray(run.browsers);
  if (runBrowsers.length === 0) {
    failures.push("run_complete reported no captured browsers.");
  }

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
    }
    if (browser?.disconnectsCount > 0 || browser?.lastResult?.disconnected) {
      failures.push(`${formatBrowser(browser)} disconnected during the run.`);
    }
    if (browser?.lastResult?.error) {
      failures.push(`${formatBrowser(browser)} reported a browser error.`);
    }
  }

  if (state.infrastructureFailures.length > 0) {
    failures.push(...state.infrastructureFailures);
  }

  const results = run.results;
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
    if (!Number.isInteger(results.exitCode)) {
      failures.push("run_complete reported a malformed exit code.");
    } else if (
      results.exitCode !== 0 &&
      !(suiteFailureOptOut && results.exitCode === 1)
    ) {
      failures.push(`run_complete reported exit code ${results.exitCode}.`);
    }

    if (!Number.isInteger(exitCode)) {
      failures.push("Karma's done callback reported a malformed exit code.");
    } else if (exitCode !== 0 && !(suiteFailureOptOut && exitCode === 1)) {
      failures.push(`Karma's done callback reported exit code ${exitCode}.`);
    }
  }

  return failures;
}

/**
 * Starts a Karma server and accepts only a completed browser lifecycle before
 * settling the promise expected by Gulp.
 *
 * @param {typeof import("karma").Server} KarmaServer Karma's Server class.
 * @param {object} config Parsed Karma configuration.
 * @param {object} [options] Run options.
 * @param {boolean} [options.failTaskOnError=true] Reject on a non-zero suite exit. Infrastructure failures always reject.
 * @returns {Promise<void>} Resolves only when the accepted run completes.
 */
export function runKarmaTestServer(
  KarmaServer,
  config,
  { failTaskOnError = true } = {},
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

      const failures = getCompletionFailures(state, exitCode, failTaskOnError);
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
