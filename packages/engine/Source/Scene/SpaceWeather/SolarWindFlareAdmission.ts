/**
 * What one answer does to the state {@link SolarWindFlareFeedIngest} holds: for
 * each product, the normalization, the clock rule and the regression rule, as
 * functions of the answer, the held state and the instant.
 *
 * A product's answer is either admitted, as the value the ingest then holds, or
 * refused with a code and a message; nothing held changes on a refusal.
 *
 * Nothing here reads a clock, performs I/O, imports a renderer, or branches on
 * the active backend.
 *
 * @module Scene/SpaceWeather/SolarWindFlareAdmission
 */
import {
  SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS,
  spaceWeatherObservationIsPlausible,
} from "./SpaceWeatherSourceAuthority.js";
import {
  mergeRealTimeSolarWindHistory,
  normalizeRealTimeSolarWindPayload,
  realTimeSolarWindSeriesCredited,
  type RealTimeSolarWindProductValue,
  type RealTimeSolarWindSeries,
} from "./RealTimeSolarWindNormalizer.js";
import {
  goesXraySeriesCredited,
  normalizeGoesInstrumentSources,
  normalizeGoesXrayPayload,
  type GoesInstrumentSources,
  type GoesXraySeries,
} from "./GoesXrayNormalizer.js";
import { SolarWindFlareIngestCode } from "./SolarWindFlareFeedIngestHelpers.js";

/** An answer admitted as the value to hold, or refused and why. */
export type SolarWindFlareAdmission<T> =
  | { status: "ok"; value: T }
  | { status: "refused"; code: string; message: string };

function refused<T>(code: string, message: string): SolarWindFlareAdmission<T> {
  return { status: "refused", code: code, message: message };
}

/**
 * Whether an observation instant is one the clock can credit at an instant: the
 * folder's plausibility rule itself, applied row by row, so the rule has one
 * statement.
 *
 * @param nowMs The deciding instant, in ms since the Unix epoch.
 * @returns The predicate over an observation instant.
 */
export function credibleAt(nowMs: number): (timeTagMs: number) => boolean {
  return (timeTagMs) => spaceWeatherObservationIsPlausible(timeTagMs, nowMs);
}

function aheadOfClock<T>(
  newestMs: number,
  nowMs: number,
): SolarWindFlareAdmission<T> {
  return refused(
    SolarWindFlareIngestCode.IMPLAUSIBLE_TIME,
    `every reading is ahead of ${new Date(nowMs).toISOString()} by more than the ${SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS} s clock-skew tolerance (newest ${new Date(newestMs).toISOString()})`,
  );
}

/**
 * The time-regression rule: an answer whose newest credible instant is older
 * than the one held is refused, while the held instant is itself one the clock
 * can credit.
 *
 * @returns The refusal message, or `undefined` when the answer may replace the
 *   held state.
 */
function regression(
  incomingNewestMs: number,
  heldNewestMs: number | undefined,
  nowMs: number,
): string | undefined {
  if (
    heldNewestMs === undefined ||
    incomingNewestMs >= heldNewestMs ||
    !spaceWeatherObservationIsPlausible(heldNewestMs, nowMs)
  ) {
    return undefined;
  }
  return `newest instant ${new Date(incomingNewestMs).toISOString()} is older than the held ${new Date(heldNewestMs).toISOString()}`;
}

/**
 * Admit the instrument-source mapping.
 *
 * The mapping is the publisher's current statement of which spacecraft serves
 * from when, not an observation: an entry may be scheduled ahead of the clock,
 * and a later statement may retract an entry. Neither the clock rule nor the
 * regression rule applies to it; it is read at an instant.
 *
 * @param payload The decoded answer.
 * @returns The mapping to hold, or the refusal.
 */
export function admitInstrumentSources(
  payload: unknown,
): SolarWindFlareAdmission<GoesInstrumentSources> {
  const result = normalizeGoesInstrumentSources(payload);
  return result.status === "ok"
    ? { status: "ok", value: result.sources }
    : refused(result.error.code, result.error.message);
}

/**
 * Admit one solar-wind product's answer and merge it into the held history.
 *
 * @param payload The decoded answer.
 * @param which Which product it answers.
 * @param held The history held for that product, if any.
 * @param historySeconds How much history to keep.
 * @param nowMs The deciding instant, in ms since the Unix epoch.
 * @returns The merged history to hold, or the refusal.
 */
export function admitSolarWind(
  payload: unknown,
  which: RealTimeSolarWindProductValue,
  held: RealTimeSolarWindSeries | undefined,
  historySeconds: number,
  nowMs: number,
): SolarWindFlareAdmission<RealTimeSolarWindSeries> {
  const result = normalizeRealTimeSolarWindPayload(payload, which);
  if (result.status !== "ok") {
    return refused(result.error.code, result.error.message);
  }
  const credible = credibleAt(nowMs);
  const series = realTimeSolarWindSeriesCredited(result.series, credible);
  if (series === undefined) {
    return aheadOfClock(result.series.newest.timeTagMs, nowMs);
  }
  const regressed = regression(
    series.newest.timeTagMs,
    held?.newest.timeTagMs,
    nowMs,
  );
  if (regressed !== undefined) {
    return refused(SolarWindFlareIngestCode.TIME_REGRESSION, regressed);
  }
  return {
    status: "ok",
    value: mergeRealTimeSolarWindHistory(
      held,
      series,
      historySeconds,
      credible,
    ),
  };
}

/**
 * Admit the X-ray answer.
 *
 * @param payload The decoded answer.
 * @param primarySatellite The primary the mapping names at the instant, if a
 *   mapping is held.
 * @param held The series held, if any.
 * @param nowMs The deciding instant, in ms since the Unix epoch.
 * @returns The series to hold, or the refusal.
 */
export function admitXray(
  payload: unknown,
  primarySatellite: number | undefined,
  held: GoesXraySeries | undefined,
  nowMs: number,
): SolarWindFlareAdmission<GoesXraySeries> {
  const result = normalizeGoesXrayPayload(payload, primarySatellite);
  if (result.status !== "ok") {
    return refused(result.error.code, result.error.message);
  }
  const series = goesXraySeriesCredited(result.series, credibleAt(nowMs));
  if (series === undefined) {
    return aheadOfClock(result.series.newest.timeTagMs, nowMs);
  }
  const regressed = regression(
    series.newest.timeTagMs,
    held?.newest.timeTagMs,
    nowMs,
  );
  if (regressed !== undefined) {
    return refused(SolarWindFlareIngestCode.TIME_REGRESSION, regressed);
  }
  return { status: "ok", value: series };
}
