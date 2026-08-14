import DeveloperError from "./DeveloperError.js";
import GregorianDate from "./GregorianDate.js";
import JulianDate from "./JulianDate.js";
import TimeConstants from "./TimeConstants.js";
import TimeStandard from "./TimeStandard.js";

const J2000_DAY_NUMBER = 2451545;
const J2000_TAI_MINUS_UTC_SECONDS = 32;

// 2000-01-01T12:00:00 UTC represented directly in Cesium's internal TAI
// storage. Keeping this numeric avoids a JavaScript Date conversion or its
// millisecond rounding on the precision-critical adapter path.
const j2000UtcAsTai = new JulianDate(
  J2000_DAY_NUMBER,
  J2000_TAI_MINUS_UTC_SECONDS,
  TimeStandard.TAI,
);
const gregorianScratch = new GregorianDate();

/**
 * Frozen time-scale declaration for Astronomy Engine 2.1.19 samples.
 * Astronomy Engine's built-in Espenak/Meeus delta-T remains untouched.
 *
 * @type {object}
 */
const ASTRONOMY_ENGINE_TIME_POLICY = Object.freeze({
  id: "astronomy-engine-2.1.19/eqj-eqd-gast/ut1-equals-utc/no-polar-motion/espenak-meeus-delta-t",
  inputTimeScale: "TAI",
  astronomyEngineUtScale: "UTC",
  ut1Policy: "UT1_EQUALS_UTC",
  polarMotionPolicy: "OMITTED",
  deltaTPolicy: "ASTRONOMY_ENGINE_2_1_19_ESPENAK_MEEUS",
  leapSecondPolicy: "REJECT",
  javascriptDateUsedByAdapter: false,
});

/**
 * Converts a Cesium {@link JulianDate}, stored internally as TAI, to Astronomy
 * Engine's numeric UTC days since the J2000 noon epoch.
 *
 * TAI elapsed seconds include inserted leap seconds. Astronomy Engine's
 * numeric UTC day count does not represent a labelled `23:59:60`, so the
 * change in TAI-UTC since J2000 is subtracted exactly. A time inside the leap
 * second itself is rejected instead of being rounded onto an adjacent UTC
 * instant.
 *
 * This adapter deliberately does not construct or inspect a JavaScript Date.
 * Astronomy Engine may construct its own Date as a diagnostic field when its
 * public `AstroTime(number)` constructor is invoked later; calculations use
 * the numeric `ut` and `tt` fields.
 *
 * @param {JulianDate} time Cesium simulation time.
 * @returns {number} Numeric UTC days since 2000-01-01T12:00:00 UTC.
 */
function toAstronomyEngineUtcDays(time) {
  if (
    time === undefined ||
    !Number.isFinite(time.dayNumber) ||
    !Number.isFinite(time.secondsOfDay)
  ) {
    throw new DeveloperError("time must be a finite JulianDate.");
  }

  JulianDate.toGregorianDate(time, gregorianScratch);
  if (gregorianScratch.isLeapSecond) {
    throw new DeveloperError(
      "Astronomy Engine numeric UTC cannot represent a leap-second instant.",
    );
  }

  const taiElapsedSeconds = JulianDate.secondsDifference(time, j2000UtcAsTai);
  const leapOffsetChange =
    JulianDate.computeTaiMinusUtc(time) - J2000_TAI_MINUS_UTC_SECONDS;
  return (taiElapsedSeconds - leapOffsetChange) / TimeConstants.SECONDS_PER_DAY;
}

const AstronomyEngineTimeAdapter = Object.freeze({
  policy: ASTRONOMY_ENGINE_TIME_POLICY,
  j2000TaiMinusUtcSeconds: J2000_TAI_MINUS_UTC_SECONDS,
  toUtcDaysSinceJ2000: toAstronomyEngineUtcDays,
});

export {
  ASTRONOMY_ENGINE_TIME_POLICY,
  J2000_TAI_MINUS_UTC_SECONDS,
  toAstronomyEngineUtcDays,
};
export default AstronomyEngineTimeAdapter;
