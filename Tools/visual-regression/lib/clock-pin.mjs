/**
 * The opt-in clock pin a probe applies after its viewer is up.
 * @purpose Piece for probes with no clock of their own: validates a --clock ISO instant at flag-parse time, pins the viewer's frozen clock to it over pageSetClock, reads it back (and again at the end of the run) and refuses loudly when the page has no viewer, the Cesium module does not load or the clock reads anything but the requested instant.
 * @status ACTIVE
 *
 * The pin is applied ONLY when the flag is given; `DAYLIGHT_CLOCK_ISO` is the
 * instant the landing rigs pin (a US view is lit at it), offered as a value to
 * pass, never a default. The runtime's flag table has no validating kind, so
 * `clockFlagExitCode` checks the flag from the probe's entry point, before
 * `runProbe` is reached, so no browser has started when a bad value is refused.
 *
 * @module Tools/visual-regression/lib/clock-pin
 */

import { CLOCK_STEPS_MODULE_URL, pageSetClock } from "./clock-steps.mjs";
import { PROBE_EXIT_CODES, ProbeRefusal } from "./probe-refusal.mjs";

/** The landing rigs' pinned instant. */
export const DAYLIGHT_CLOCK_ISO = "2026-06-21T18:00:00Z";

/** The `descriptor.args.extraOptions` entry that declares the flag. */
export const CLOCK_OPTION = Object.freeze({
  flag: "--clock",
  key: "clock",
  kind: "string",
});

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.0+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {string} value Raw `--clock` value.
 * @returns {string} The instant as `YYYY-MM-DDTHH:MM:SSZ`.
 * @throws {TypeError} Not an ISO 8601 instant with a zone, to the second.
 */
export function parseClockIso(value) {
  const match = ISO_INSTANT.exec(String(value));
  const ms = match === null ? NaN : Date.parse(value);
  const [year, month, day] = (match ?? []).slice(1, 4).map(Number);
  const calendarOk =
    match !== null &&
    new Date(Date.UTC(year, month - 1, day)).getUTCDate() === day;
  if (!Number.isFinite(ms) || !calendarOk) {
    throw new TypeError(
      `--clock must be an ISO 8601 instant with a zone, to the second, e.g. ${DAYLIGHT_CLOCK_ISO} (got "${value}")`,
    );
  }
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/**
 * @param {string[]} argv Arguments after the script name.
 * @returns {string|null} The validated instant, or null when no `--clock`.
 * @throws {TypeError} A `--clock` with no value or an unparseable one.
 */
export function clockFlagValue(argv) {
  let found = null;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== CLOCK_OPTION.flag) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new TypeError("--clock requires a value");
    }
    found = parseClockIso(next);
  }
  return found;
}

/**
 * PAGE SIDE. The viewer's clock, to the second. Self-contained; the Cesium
 * namespace comes from `moduleUrl`.
 *
 * @param {{moduleUrl: string}} args
 * @returns {Promise<{ok: boolean, observed?: string, reason?: string}>}
 */
export async function pageReadClock({ moduleUrl }) {
  const viewer = /** @type {any} */ (globalThis).viewer;
  if (!viewer) return { ok: false, reason: "the page has no viewer" };
  let C;
  try {
    C = await import(moduleUrl);
  } catch (error) {
    return { ok: false, reason: `the Cesium module did not load: ${error}` };
  }
  return {
    ok: true,
    observed: C.JulianDate.toIso8601(viewer.clock.currentTime, 0),
  };
}

function confirm(requested, answer, reason) {
  if (!answer?.ok) {
    throw new ProbeRefusal(
      reason,
      `the clock could not be read at ${requested}: ${answer?.reason ?? "no answer from the page"}`,
      { requested, answer: answer ?? null },
    );
  }
  if (Date.parse(answer.observed) !== Date.parse(requested)) {
    throw new ProbeRefusal(
      reason,
      `the clock reads ${answer.observed}, not the requested ${requested}`,
      { requested, observed: answer.observed },
    );
  }
  return answer.observed;
}

/**
 * Pin the viewer's clock to `iso` and read it back.
 *
 * @param {{evaluate: Function}} page
 * @param {string} iso Validated by {@link parseClockIso}.
 * @returns {Promise<{requested: string, observed: string}>}
 * @throws {ProbeRefusal} `clock-pin-failed` when the clock cannot be set or
 *   does not read back as requested.
 */
export async function pinClock(page, iso, moduleUrl = CLOCK_STEPS_MODULE_URL) {
  const requested = parseClockIso(iso);
  const answer = await page.evaluate(pageSetClock, {
    iso: requested,
    moduleUrl,
  });
  return {
    requested,
    observed: confirm(requested, answer, "clock-pin-failed"),
  };
}

/**
 * Read the clock again after the run's own page work and refuse if it moved.
 *
 * @param {{evaluate: Function}} page
 * @param {{requested: string, observed: string}} pin From {@link pinClock}.
 * @returns {Promise<{requested: string, observed: string, observedAtEnd: string}>}
 * @throws {ProbeRefusal} `clock-pin-lost` when the clock is no longer the pin.
 */
export async function assertClockHeld(
  page,
  pin,
  moduleUrl = CLOCK_STEPS_MODULE_URL,
) {
  const answer = await page.evaluate(pageReadClock, { moduleUrl });
  return {
    ...pin,
    observedAtEnd: confirm(pin.requested, answer, "clock-pin-lost"),
  };
}

/**
 * The entry point's pre-check: a bad `--clock` is a caller error (exit 2),
 * reported on stderr before any browser starts. Used as
 * `clockFlagExitCode(name) ?? (await runProbe(descriptor))`.
 *
 * @param {string} probeName For the message.
 * @param {string[]} [argv] Arguments after the script name.
 * @returns {number|null} The exit code, or null when the flag is absent or good.
 */
export function clockFlagExitCode(probeName, argv = process.argv.slice(2)) {
  try {
    clockFlagValue(argv);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    process.stderr.write(`${probeName}: ${error.message}
`);
    return PROBE_EXIT_CODES.ERROR;
  }
  return null;
}
