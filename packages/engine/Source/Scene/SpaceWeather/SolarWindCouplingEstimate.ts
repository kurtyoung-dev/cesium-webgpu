/**
 * An activity scalar estimated from the upstream solar wind, for the one case
 * in which no product that measures or indexes geomagnetic activity is
 * available.
 *
 * The estimate is the published empirical relation between the solar wind and
 * the planetary index:
 *
 *     Kp = 0.05 + 2.244e-4 * dPhi/dt + 2.844e-6 * n^(1/2) * v^2
 *     dPhi/dt = v^(4/3) * B_T^(2/3) * sin^(8/3)(theta_c / 2)
 *
 * with `v` the bulk speed in km/s, `n` the proton density per cubic centimetre,
 * `B_T` the transverse field magnitude `sqrt(By^2 + Bz^2)` in nT and `theta_c`
 * the clock angle `atan2(By, Bz)`, both in geocentric solar magnetospheric
 * coordinates (Newell, Sotirelis, Liou and Rich, 2008, "Pairs of solar
 * wind-magnetosphere coupling functions", J. Geophys. Res. 113, A04218, with the
 * merging term of Newell et al., 2007, J. Geophys. Res. 112, A01206; the
 * relation as written above is quoted as equations 1 and 2 of arXiv:1701.06525).
 * The first term is the rate at which field lines open at the magnetopause and
 * the second a viscous term, and both are linear in the relation — so the mean of
 * per-minute estimates is the estimate of the per-minute means, and the averaging
 * window is the only choice this module makes.
 *
 * The magnetometer's own `bt` is the magnitude of all three components and is
 * not `B_T`: the sunward component does not open field lines, and using it
 * would overstate every quiet interval.
 *
 * The index is binned in three-hour intervals, so the estimate that stands in
 * for it averages its drivers over the same interval.
 *
 * What the estimate is not: a measurement, a forecast, or a forcing term. It is
 * carried under its own authority, and the source-authority contract decides
 * when anything reads it.
 *
 * @module Scene/SpaceWeather/SolarWindCouplingEstimate
 */
import { SPACE_WEATHER_RANGES } from "./SpaceWeatherTypes.js";
import { PLANETARY_KP_CADENCE_SECONDS } from "./SpaceWeatherSourceAuthority.js";
import { planetaryKpActivity } from "./PlanetaryKpNormalizer.js";
import type { RealTimeSolarWindReading } from "./RealTimeSolarWindNormalizer.js";

/** The relation's constant term. */
export const NEWELL_KP_INTERCEPT = 0.05;
/** The relation's coefficient on the field-line opening rate. */
export const NEWELL_KP_MERGING_COEFFICIENT = 2.244e-4;
/** The relation's coefficient on the viscous term. */
export const NEWELL_KP_VISCOUS_COEFFICIENT = 2.844e-6;

/**
 * How far back the estimate averages, in seconds: one bin of the index it
 * stands in for.
 */
export const SOLAR_WIND_ESTIMATE_WINDOW_SECONDS = PLANETARY_KP_CADENCE_SECONDS;

const MILLISECONDS_PER_MINUTE = 60000;

/**
 * Rate at which the solar wind opens field lines at the magnetopause, in the
 * relation's own units.
 *
 * @param speedKmPerSecond Bulk speed.
 * @param byGsmNanoTesla Dawn-dusk field component.
 * @param bzGsmNanoTesla North-south field component.
 * @returns The rate; zero for a purely northward or a vanishing field.
 */
export function newellCouplingRate(
  speedKmPerSecond: number,
  byGsmNanoTesla: number,
  bzGsmNanoTesla: number,
): number {
  const transverse = Math.hypot(byGsmNanoTesla, bzGsmNanoTesla);
  if (transverse === 0) {
    return 0;
  }
  const clockAngle = Math.atan2(byGsmNanoTesla, bzGsmNanoTesla);
  return (
    Math.pow(speedKmPerSecond, 4 / 3) *
    Math.pow(transverse, 2 / 3) *
    Math.pow(Math.abs(Math.sin(clockAngle / 2)), 8 / 3)
  );
}

/**
 * The planetary index the relation predicts from its two terms.
 *
 * @param couplingRate The field-line opening rate.
 * @param densityPerCubicCm Proton density.
 * @param speedKmPerSecond Bulk speed.
 * @returns The predicted index, unclamped.
 */
export function newellPlanetaryIndex(
  couplingRate: number,
  densityPerCubicCm: number,
  speedKmPerSecond: number,
): number {
  return (
    NEWELL_KP_INTERCEPT +
    NEWELL_KP_MERGING_COEFFICIENT * couplingRate +
    NEWELL_KP_VISCOUS_COEFFICIENT *
      Math.sqrt(densityPerCubicCm) *
      speedKmPerSecond *
      speedKmPerSecond
  );
}

/** The estimate, and what it was made from. */
export interface SolarWindActivityEstimate {
  /** The predicted planetary index, clamped to the index's own range. */
  estimatedKpIndex: number;
  /** The activity scalar that index stands for. */
  activity: number;
  /** Minutes in the window for which both products had a usable reading. */
  pairedMinutes: number;
  /** Mean field-line opening rate over those minutes. */
  meanCouplingRate: number;
  /** Instant of the newest paired minute, in ms since the Unix epoch. */
  newestMs: number;
  /** Start of the averaging window, in ms since the Unix epoch. */
  windowStartMs: number;
}

/**
 * Estimate the activity scalar from the two solar-wind series.
 *
 * The products stamp their rows independently, so a plasma reading and a field
 * reading are paired by the minute they fall in; a minute either product lacks
 * contributes nothing. Readings later than the deciding instant are never used.
 *
 * @param plasma Ascending plasma readings.
 * @param magnetometer Ascending magnetometer readings.
 * @param nowMs The instant to estimate at, in ms since the Unix epoch.
 * @param windowSeconds How far back to average.
 * @returns The estimate, or `undefined` when no minute in the window is paired.
 */
export function estimateSolarWindActivity(
  plasma: readonly RealTimeSolarWindReading[],
  magnetometer: readonly RealTimeSolarWindReading[],
  nowMs: number,
  windowSeconds: number = SOLAR_WIND_ESTIMATE_WINDOW_SECONDS,
): SolarWindActivityEstimate | undefined {
  const windowStartMs = nowMs - windowSeconds * 1000;
  const fieldByMinute = new Map<number, RealTimeSolarWindReading>();
  for (const reading of magnetometer) {
    if (reading.timeTagMs > windowStartMs && reading.timeTagMs <= nowMs) {
      fieldByMinute.set(
        Math.floor(reading.timeTagMs / MILLISECONDS_PER_MINUTE),
        reading,
      );
    }
  }
  let pairedMinutes = 0;
  let couplingSum = 0;
  let viscousSum = 0;
  let newestMs = Number.NEGATIVE_INFINITY;
  for (const reading of plasma) {
    if (reading.timeTagMs <= windowStartMs || reading.timeTagMs > nowMs) {
      continue;
    }
    const field = fieldByMinute.get(
      Math.floor(reading.timeTagMs / MILLISECONDS_PER_MINUTE),
    );
    if (field === undefined) {
      continue;
    }
    const speed = reading.speedKmPerSecond as number;
    couplingSum += newellCouplingRate(
      speed,
      field.byGsmNanoTesla as number,
      field.bzGsmNanoTesla as number,
    );
    viscousSum +=
      Math.sqrt(reading.densityPerCubicCm as number) * speed * speed;
    ++pairedMinutes;
    newestMs = Math.max(newestMs, reading.timeTagMs, field.timeTagMs);
  }
  if (pairedMinutes === 0) {
    return undefined;
  }
  const meanCouplingRate = couplingSum / pairedMinutes;
  const predicted =
    NEWELL_KP_INTERCEPT +
    NEWELL_KP_MERGING_COEFFICIENT * meanCouplingRate +
    NEWELL_KP_VISCOUS_COEFFICIENT * (viscousSum / pairedMinutes);
  const range = SPACE_WEATHER_RANGES.kpIndex;
  const estimatedKpIndex = Math.min(
    Math.max(predicted, range.minimum),
    range.maximum,
  );
  return {
    estimatedKpIndex: estimatedKpIndex,
    activity: planetaryKpActivity(estimatedKpIndex),
    pairedMinutes: pairedMinutes,
    meanCouplingRate: meanCouplingRate,
    newestMs: newestMs,
    windowStartMs: windowStartMs,
  };
}
