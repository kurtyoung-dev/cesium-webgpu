import assert from "node:assert/strict";
import test from "node:test";

import AstronomyEngineTimeAdapter, {
  J2000_TAI_MINUS_UTC_SECONDS,
  toAstronomyEngineUtcDays,
} from "../../Source/Core/AstronomyEngineTimeAdapter.js";
import JulianDate from "../../Source/Core/JulianDate.js";

const secondsPerDay = 86400.0;

test("AstronomyEngineTimeAdapter converts the UTC J2000 epoch exactly", () => {
  const epoch = JulianDate.fromIso8601("2000-01-01T12:00:00Z");

  assert.equal(toAstronomyEngineUtcDays(epoch), 0.0);
  assert.equal(AstronomyEngineTimeAdapter.toUtcDaysSinceJ2000(epoch), 0.0);
  assert.equal(J2000_TAI_MINUS_UTC_SECONDS, 32);
  assert.equal(AstronomyEngineTimeAdapter.j2000TaiMinusUtcSeconds, 32);
});

test("AstronomyEngineTimeAdapter preserves submillisecond numeric precision around J2000", () => {
  const epoch = JulianDate.fromIso8601("2000-01-01T12:00:00Z");
  const before = JulianDate.addSeconds(epoch, -0.000125, new JulianDate());
  const after = JulianDate.addSeconds(epoch, 0.000125, new JulianDate());

  assert.ok(
    Math.abs(toAstronomyEngineUtcDays(before) + 0.000125 / secondsPerDay) <
      1.0e-16,
  );
  assert.ok(
    Math.abs(toAstronomyEngineUtcDays(after) - 0.000125 / secondsPerDay) <
      1.0e-16,
  );
});

test("AstronomyEngineTimeAdapter removes leap-offset changes at a UTC boundary", () => {
  const before = JulianDate.fromIso8601("2016-12-31T23:59:59.5Z");
  const after = JulianDate.fromIso8601("2017-01-01T00:00:00Z");
  const beforeDays = toAstronomyEngineUtcDays(before);
  const afterDays = toAstronomyEngineUtcDays(after);

  // Numeric UTC cannot label 23:59:60. The adjacent representable labels are
  // therefore 0.5 second apart even though TAI elapsed time is 1.5 seconds.
  assert.ok(Math.abs((afterDays - beforeDays) * secondsPerDay - 0.5) < 1.0e-7);
  assert.equal(afterDays, 6209.5);
});

test("AstronomyEngineTimeAdapter rejects the leap-second instant", () => {
  const leapSecond = JulianDate.fromIso8601("2016-12-31T23:59:60Z");

  assert.throws(
    () => toAstronomyEngineUtcDays(leapSecond),
    /cannot represent a leap-second instant/,
  );
});

test("AstronomyEngineTimeAdapter publishes the pinned baseline policy", () => {
  const policy = AstronomyEngineTimeAdapter.policy;

  assert.equal(
    policy.id,
    "astronomy-engine-2.1.19/eqj-eqd-gast/ut1-equals-utc/no-polar-motion/espenak-meeus-delta-t",
  );
  assert.equal(policy.inputTimeScale, "TAI");
  assert.equal(policy.astronomyEngineUtScale, "UTC");
  assert.equal(policy.ut1Policy, "UT1_EQUALS_UTC");
  assert.equal(policy.polarMotionPolicy, "OMITTED");
  assert.equal(policy.deltaTPolicy, "ASTRONOMY_ENGINE_2_1_19_ESPENAK_MEEUS");
  assert.equal(policy.leapSecondPolicy, "REJECT");
  assert.equal(policy.javascriptDateUsedByAdapter, false);
  assert.equal(Object.isFrozen(policy), true);
});

test("AstronomyEngineTimeAdapter rejects absent and non-finite inputs", () => {
  assert.throws(() => toAstronomyEngineUtcDays(undefined), /finite JulianDate/);
  assert.throws(
    () => toAstronomyEngineUtcDays({ dayNumber: Number.NaN, secondsOfDay: 0 }),
    /finite JulianDate/,
  );
});
