/**
 * Result policy for the browser unit-test task. Keep these values explicit so
 * a Karma dependency update cannot turn an empty or failing suite into a
 * successful Gulp task.
 */
export const strictKarmaResultConfig = Object.freeze({
  failOnEmptyTestSuite: true,
  failOnFailingTestSuite: true,
});

/**
 * Starts a Karma server and converts its completion exit code into the
 * promise contract expected by Gulp.
 *
 * @param {typeof import("karma").Server} KarmaServer Karma's Server class.
 * @param {object} config Parsed Karma configuration.
 * @param {object} [options] Run options.
 * @param {boolean} [options.failTaskOnError=true] Reject on a non-zero exit.
 * @returns {Promise<void>} Resolves only when the accepted run completes.
 */
export function runKarmaTestServer(
  KarmaServer,
  config,
  { failTaskOnError = true } = {},
) {
  return new Promise((resolve, reject) => {
    const server = new KarmaServer(config, function doneCallback(exitCode) {
      if (failTaskOnError && exitCode !== 0) {
        reject(new Error(`Karma test run failed with exit code ${exitCode}.`));
        return;
      }

      resolve();
    });
    server.start();
  });
}
