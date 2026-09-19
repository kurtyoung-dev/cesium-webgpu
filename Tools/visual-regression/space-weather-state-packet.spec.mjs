// space-weather-state-packet.spec.mjs — the neutral space-weather packet and its
// deterministic manual driver. Pure Node: no browser, no GPU, no network.
// @purpose Output contract for the backend-neutral space-weather packet: preset values, timeline determinism, zero-cost OFF, per-field authority, flare/geomagnetic independence, validation rejections, staleness.
// @status ACTIVE
//
// WHAT THIS SPEC IS FOR. The queue row's exit gate is a list of things that must
// be REJECTED or must be REPRODUCIBLE, so every assertion below reads a value
// that came out of the real modules: a packet field, a validation message, a
// counter, a serialized packet sequence. None of them greps the source.
//
// THE FOUR OUTPUT CLAIMS, and why each one is phrased the way it is:
//
//   1. DETERMINISM is asserted as arithmetic first (`observedTimeMs` equals
//      `epochMs + timeSeconds * 1000`, exactly) and as sequence equality second.
//      A clock injected into the packet builder breaks the first assertion on
//      every run; sequence equality alone could pass by luck inside one
//      millisecond.
//   2. OFF-COST is asserted by counting the seams, not by reading the source: a
//      disabled driver is sampled a thousand times with `fetch`, the timer
//      family, the animation frame and both clocks replaced by counting spies,
//      and every counter must still read zero alongside `packetsBuilt`.
//   3. CHANNEL INDEPENDENCE is asserted as byte equality of everything outside
//      the flare subtree when only the flare changes. A coupling term of any
//      size moves the geomagnetic scalar, so no tolerance is involved.
//   4. AUTHORITY is asserted through the derived scale, because that is where
//      the rule has a consequence: a model-authored oval must come back with a
//      scale of exactly 1, and a synthetic one with the activity scalar.
//
// RUNNER REQUIREMENT: Node >= 22.18 (built-in TypeScript stripping).
//   node --test Tools/visual-regression/space-weather-state-packet.spec.mjs

import assert from "node:assert/strict";
import test from "node:test";

import { enableEngineTsResolution } from "./lib/engine-ts-resolver.mjs";

enableEngineTsResolution();

const {
  SPACE_WEATHER_FILL_VALUE,
  SPACE_WEATHER_PACKET_VERSION,
  SpaceWeatherAuthority,
  SpaceWeatherField,
} =
  await import("../../packages/engine/Source/Scene/SpaceWeather/SpaceWeatherTypes.ts");
const {
  auroraOvalIntensityScale,
  freezeSpaceWeatherPacket,
  isStaleSpaceWeatherUpdate,
  spaceWeatherAuthorityOf,
  spaceWeatherFreshness,
  spaceWeatherPacketAgeSeconds,
  validateSpaceWeatherPacket,
} =
  await import("../../packages/engine/Source/Scene/SpaceWeather/SpaceWeatherPacket.ts");
const { ManualSpaceWeatherDriver, SPACE_WEATHER_PRESETS } =
  await import("../../packages/engine/Source/Scene/SpaceWeather/ManualSpaceWeatherDriver.ts");

/** A minimal packet that validates, as the starting point for rejection cases. */
function basePacket() {
  return {
    version: SPACE_WEATHER_PACKET_VERSION,
    provenance: {
      sourceId: "fixture",
      kind: "model",
      validitySeconds: 600,
    },
    observedTimeMs: 1000,
    forecastTimeMs: 1000,
    geomagnetic: {
      activity: 0.5,
      authority: SpaceWeatherAuthority.SYNTHETIC,
    },
  };
}

function ovalField(authority, overrides = {}) {
  return {
    authority,
    frame: "geomagnetic",
    hemisphere: "north",
    gridWidth: 2,
    gridHeight: 2,
    intensity: new Float32Array([0, 0.25, 0.5, 1]),
    bounds: { west: -Math.PI, south: 0, east: Math.PI, north: Math.PI / 2 },
    intensityScale: "normalized",
    frameEpoch: 2025.0,
    ...overrides,
  };
}

/** Everything about a packet except its flare subtree, as a comparable string. */
function withoutFlare(packet) {
  const { flare: _flare, ...rest } = packet;
  return JSON.stringify(rest);
}

test("every preset yields its documented packet values", () => {
  const expected = {
    quiet: { kpIndex: 1, activity: 1 / 9, bzNanoTesla: -1 },
    moderate: { kpIndex: 5, activity: 5 / 9, bzNanoTesla: -8 },
    severe: { kpIndex: 8, activity: 8 / 9, bzNanoTesla: -25 },
  };
  for (const [name, values] of Object.entries(expected)) {
    assert.deepEqual(
      { ...SPACE_WEATHER_PRESETS[name] },
      values,
      `${name} preset table`,
    );
    const driver = new ManualSpaceWeatherDriver({
      enabled: true,
      preset: name,
    });
    const packet = driver.sampleAt(0);
    assert.equal(packet.version, SPACE_WEATHER_PACKET_VERSION);
    assert.equal(packet.provenance.kind, "manual");
    assert.equal(packet.provenance.label, name);
    assert.equal(
      packet.geomagnetic.activity,
      values.activity,
      `${name} activity`,
    );
    assert.equal(packet.geomagnetic.kpIndex, values.kpIndex, `${name} index`);
    assert.equal(
      packet.geomagnetic.bzNanoTesla,
      values.bzNanoTesla,
      `${name} bz`,
    );
    assert.equal(packet.geomagnetic.authority, SpaceWeatherAuthority.MANUAL);
    assert.equal(
      validateSpaceWeatherPacket(packet).valid,
      true,
      `${name} valid`,
    );
  }
  // The three presets must be distinguishable, or "every visual state" is one state.
  const activities = Object.values(expected).map((v) => v.activity);
  assert.equal(new Set(activities).size, 3);
});

test("the continuous override moves activity and the index together", () => {
  const driver = new ManualSpaceWeatherDriver({ enabled: true });
  driver.setActivity(0.5);
  let packet = driver.sampleAt(0);
  assert.equal(packet.geomagnetic.activity, 0.5);
  assert.equal(packet.geomagnetic.kpIndex, 4.5);
  assert.equal(driver.preset, undefined);

  driver.setKpIndex(9);
  packet = driver.sampleAt(0);
  assert.equal(packet.geomagnetic.activity, 1);
  assert.equal(packet.geomagnetic.kpIndex, 9);

  assert.throws(() => driver.setActivity(1.5), /within \[0, 1\]/);
  assert.throws(() => driver.setKpIndex(Number.NaN), /finite/);
});

test("the timeline is deterministic: same inputs, byte-identical sequence", () => {
  const epochMs = 1_700_000_000_000;
  const timeline = [
    { timeSeconds: 0, preset: "quiet" },
    { timeSeconds: 60, kpIndex: 5, dstNanoTesla: -40 },
    { timeSeconds: 120, preset: "severe", dstNanoTesla: -180 },
  ];
  const times = [-10, 0, 15, 30, 60, 90, 120, 600];

  const run = () => {
    const driver = new ManualSpaceWeatherDriver({ enabled: true, epochMs });
    driver.setTimeline(timeline);
    return times.map((t) => JSON.stringify(driver.sampleAt(t)));
  };

  const first = run();
  // A busy wait long enough that a wall-clock read would land in a different
  // millisecond; the sequences must still agree.
  const spinUntil = Date.now() + 3;
  while (Date.now() < spinUntil) {
    /* deliberate spin */
  }
  const second = run();
  assert.deepEqual(second, first, "two runs of the same script must agree");

  const driver = new ManualSpaceWeatherDriver({ enabled: true, epochMs });
  driver.setTimeline(timeline);
  for (const t of times) {
    const packet = driver.sampleAt(t);
    assert.equal(
      packet.observedTimeMs,
      epochMs + t * 1000,
      `observedTimeMs at t=${t} is the epoch plus the sample time, with no clock read`,
    );
    assert.equal(packet.forecastTimeMs, packet.observedTimeMs);
  }

  // Interpolation between the first two steps, and hold outside the script.
  const midpoint = driver.sampleAt(30);
  assert.equal(midpoint.geomagnetic.activity, (1 / 9 + 5 / 9) / 2);
  assert.equal(driver.sampleAt(-10).geomagnetic.activity, 1 / 9);
  assert.equal(driver.sampleAt(600).geomagnetic.activity, 8 / 9);
  // A ring-current value only appears on the steps that declare one, and it is
  // always stamped as caller-owned.
  assert.equal(driver.sampleAt(0).geomagnetic.dstNanoTesla, undefined);
  assert.equal(driver.sampleAt(90).geomagnetic.dstNanoTesla, -110);
  assert.equal(
    spaceWeatherAuthorityOf(driver.sampleAt(90), SpaceWeatherField.DST),
    SpaceWeatherAuthority.CALLER,
  );
});

test("the timeline holds discrete state from the step at or before the sample", () => {
  const driver = new ManualSpaceWeatherDriver({ enabled: true });
  driver.setTimeline([
    {
      timeSeconds: 0,
      preset: "quiet",
      flare: { flareClass: "C", magnitude: 2 },
    },
    {
      timeSeconds: 60,
      preset: "severe",
      flare: { flareClass: "X", magnitude: 9 },
    },
    { timeSeconds: 120, preset: "moderate" },
  ]);

  // Strictly between two steps the activity scalar interpolates while the preset
  // label and the flare are held from the earlier neighbour. Reading either from
  // the later one is an off-by-one that no arithmetic assertion can see, because
  // the interpolated scalars are unaffected by it.
  const between = driver.sampleAt(30);
  assert.ok(
    between.geomagnetic.activity > 1 / 9 &&
      between.geomagnetic.activity < 8 / 9,
    "the sample is strictly inside the interpolated interval",
  );
  assert.equal(between.provenance.label, "quiet");
  assert.equal(between.flare.flareClass, "C");
  assert.equal(between.flare.magnitude, 2);

  // A step's own instant belongs to that step, not to the interval before it.
  assert.equal(driver.sampleAt(60).provenance.label, "severe");
  assert.equal(driver.sampleAt(60).flare.flareClass, "X");

  // A step that declares no flare clears it from its own instant forward, and
  // the clearing never reaches backwards into the interval before it.
  assert.equal(driver.sampleAt(90).flare.flareClass, "X");
  assert.equal(driver.sampleAt(120).flare, undefined);
  assert.equal(driver.sampleAt(600).provenance.label, "moderate");
});

test("the timeline refuses a malformed script", () => {
  const driver = new ManualSpaceWeatherDriver({ enabled: true });
  assert.throws(
    () =>
      driver.setTimeline([
        { timeSeconds: 0, preset: "quiet" },
        { timeSeconds: 0, preset: "severe" },
      ]),
    /greater than the previous/,
  );
  assert.throws(
    () => driver.setTimeline([{ timeSeconds: 0 }]),
    /exactly one of preset, activity or kpIndex/,
  );
  assert.throws(
    () => driver.setTimeline([{ timeSeconds: Number.NaN, preset: "quiet" }]),
    /finite/,
  );
});

test("default off costs nothing: no packet, no job, no request, no clock", () => {
  const seams = [
    ["fetch", globalThis],
    ["setTimeout", globalThis],
    ["setInterval", globalThis],
    ["setImmediate", globalThis],
    ["queueMicrotask", globalThis],
    ["requestAnimationFrame", globalThis],
  ];
  const counts = new Map();
  const restore = [];
  for (const [name, host] of seams) {
    const original = host[name];
    if (typeof original !== "function") {
      continue;
    }
    counts.set(name, 0);
    host[name] = function countingSeam(...args) {
      counts.set(name, counts.get(name) + 1);
      return original.apply(this, args);
    };
    restore.push(() => {
      host[name] = original;
    });
  }
  const originalDateNow = Date.now;
  const originalPerformanceNow = performance.now;
  counts.set("Date.now", 0);
  counts.set("performance.now", 0);
  Date.now = function countingDateNow() {
    counts.set("Date.now", counts.get("Date.now") + 1);
    return originalDateNow.call(Date);
  };
  performance.now = function countingPerformanceNow() {
    counts.set("performance.now", counts.get("performance.now") + 1);
    return originalPerformanceNow.call(performance);
  };
  restore.push(() => {
    Date.now = originalDateNow;
    performance.now = originalPerformanceNow;
  });

  let driver;
  let returns;
  try {
    driver = new ManualSpaceWeatherDriver();
    assert.equal(driver.enabled, false, "disabled is the default");
    assert.equal(driver.packetsBuilt, 0, "construction builds no packet");
    driver.setPreset("severe");
    driver.setDstOverride(-250);
    driver.setFlare({ flareClass: "X", magnitude: 4.2 });
    driver.setTimeline([
      { timeSeconds: 0, preset: "quiet" },
      { timeSeconds: 10, preset: "severe" },
    ]);
    returns = new Set();
    for (let i = 0; i < 1000; ++i) {
      returns.add(driver.sampleAt(i * 0.25));
    }
  } finally {
    for (const undo of restore.reverse()) {
      undo();
    }
  }

  assert.deepEqual(
    [...returns],
    [undefined],
    "every disabled sample is undefined",
  );
  assert.equal(driver.packetsBuilt, 0, "a disabled driver allocates no packet");
  assert.equal(driver.getDiagnostics().packetsBuilt, 0);
  for (const [name, count] of counts) {
    assert.equal(count, 0, `${name} must not be reached while disabled`);
  }

  // Enabling is the only thing that changes, and it still reaches no seam.
  driver.enabled = true;
  assert.notEqual(driver.sampleAt(5), undefined);
  assert.equal(driver.packetsBuilt, 1);
});

test("every visual state is reachable with the network primitives removed", () => {
  const removed = [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "Worker",
    "EventSource",
  ];
  const originals = new Map();
  for (const name of removed) {
    originals.set(name, globalThis[name]);
    globalThis[name] = function refuseNetwork() {
      throw new Error(`${name} must not be reached`);
    };
  }
  try {
    const driver = new ManualSpaceWeatherDriver({ enabled: true });
    for (const preset of ["quiet", "moderate", "severe"]) {
      driver.setPreset(preset);
      driver.setFlare({ flareClass: "M", magnitude: 1.5 });
      driver.setSolarWind({ sourceName: "fixture", speedKmPerSecond: 700 });
      const packet = driver.sampleAt(42);
      assert.equal(validateSpaceWeatherPacket(packet).valid, true, preset);
    }
    driver.setTimeline([
      { timeSeconds: 0, preset: "quiet" },
      { timeSeconds: 30, preset: "severe" },
    ]);
    assert.equal(validateSpaceWeatherPacket(driver.sampleAt(15)).valid, true);
    assert.equal(driver.packetsBuilt, 4);
  } finally {
    for (const [name, original] of originals) {
      globalThis[name] = original;
    }
  }
});

test("the flare channel and the geomagnetic channel move independently", () => {
  const driver = new ManualSpaceWeatherDriver({
    enabled: true,
    preset: "moderate",
  });
  const withoutAnyFlare = driver.sampleAt(0);
  assert.equal(withoutAnyFlare.flare, undefined);

  driver.setFlare({
    flareClass: "X",
    magnitude: 9.3,
    longBandFluxWattsPerSquareMeter: 9.3e-4,
  });
  const withX = driver.sampleAt(0);
  assert.equal(withX.flare.flareClass, "X");
  assert.equal(withX.flare.authority, SpaceWeatherAuthority.MANUAL);
  assert.equal(
    withoutFlare(withX),
    withoutFlare(withoutAnyFlare),
    "adding the largest flare class must leave every other field byte-identical",
  );
  assert.equal(withX.geomagnetic.activity, 5 / 9);

  driver.setFlare({ flareClass: "A", magnitude: 1 });
  const withA = driver.sampleAt(0);
  assert.equal(
    withoutFlare(withA),
    withoutFlare(withX),
    "changing flare class must leave every other field byte-identical",
  );

  // The reverse direction: a storm does not invent a flare.
  driver.setFlare(undefined);
  driver.setKpIndex(9);
  const storm = driver.sampleAt(0);
  assert.equal(storm.flare, undefined);
  assert.equal(storm.geomagnetic.activity, 1);

  // And the derived oval scale, the only place activity reaches geometry, is
  // unmoved by a flare.
  const synthetic = {
    ...basePacket(),
    oval: ovalField(SpaceWeatherAuthority.SYNTHETIC),
  };
  const scaleWithout = auroraOvalIntensityScale(synthetic);
  const scaleWith = auroraOvalIntensityScale({
    ...synthetic,
    flare: {
      authority: SpaceWeatherAuthority.GOES,
      flareClass: "X",
      magnitude: 9.9,
    },
  });
  assert.equal(scaleWith, scaleWithout);
  assert.equal(scaleWith, 0.5);
});

test("a model-authored oval owns its own intensity", () => {
  const packet = basePacket();
  assert.equal(
    auroraOvalIntensityScale(packet),
    0.5,
    "no oval: activity scales",
  );

  const synthetic = {
    ...packet,
    oval: ovalField(SpaceWeatherAuthority.SYNTHETIC),
  };
  assert.equal(
    auroraOvalIntensityScale(synthetic),
    0.5,
    "synthetic: activity scales",
  );
  assert.equal(
    spaceWeatherAuthorityOf(synthetic, SpaceWeatherField.OVAL),
    SpaceWeatherAuthority.SYNTHETIC,
  );

  const modelled = {
    ...packet,
    oval: ovalField(SpaceWeatherAuthority.OVATION),
  };
  assert.equal(
    auroraOvalIntensityScale(modelled),
    1,
    "a model grid must not be multiplied by the activity scalar a second time",
  );
  assert.equal(
    spaceWeatherAuthorityOf(modelled, SpaceWeatherField.OVAL),
    SpaceWeatherAuthority.OVATION,
  );
});

test("every field reports its own authority", () => {
  const driver = new ManualSpaceWeatherDriver({ enabled: true });
  driver.setDstOverride(-120);
  driver.setFlare({ flareClass: "C", magnitude: 3 });
  driver.setSolarWind({ speedKmPerSecond: 500 });
  const packet = driver.sampleAt(0);
  assert.equal(
    spaceWeatherAuthorityOf(packet, SpaceWeatherField.ACTIVITY),
    SpaceWeatherAuthority.MANUAL,
  );
  assert.equal(
    spaceWeatherAuthorityOf(packet, SpaceWeatherField.DST),
    SpaceWeatherAuthority.CALLER,
  );
  assert.equal(
    spaceWeatherAuthorityOf(packet, SpaceWeatherField.FLARE),
    SpaceWeatherAuthority.MANUAL,
  );
  assert.equal(
    spaceWeatherAuthorityOf(packet, SpaceWeatherField.SOLAR_WIND),
    SpaceWeatherAuthority.MANUAL,
  );
  assert.equal(
    spaceWeatherAuthorityOf(packet, SpaceWeatherField.OVAL),
    undefined,
    "an absent field has no authority",
  );

  driver.setDstOverride(undefined);
  const cleared = driver.sampleAt(0);
  assert.equal(cleared.geomagnetic.dstNanoTesla, undefined);
  assert.equal(
    spaceWeatherAuthorityOf(cleared, SpaceWeatherField.DST),
    undefined,
  );
});

test("the ring-current override is the only route, and it is caller-owned", () => {
  const driver = new ManualSpaceWeatherDriver({ enabled: true });
  driver.setDstOverride(-320);
  const packet = driver.sampleAt(0);
  assert.equal(packet.geomagnetic.dstNanoTesla, -320);
  assert.equal(packet.geomagnetic.dstAuthority, SpaceWeatherAuthority.CALLER);
  assert.equal(validateSpaceWeatherPacket(packet).valid, true);

  // A packet that claims any other authority for it is refused, so a built-in
  // provider cannot be introduced without failing the contract.
  for (const authority of [
    "kp",
    "rtsw",
    "ovation",
    "goes",
    "synthetic",
    "manual",
  ]) {
    const forged = basePacket();
    forged.geomagnetic.dstNanoTesla = -320;
    forged.geomagnetic.dstAuthority = authority;
    const result = validateSpaceWeatherPacket(forged);
    assert.equal(result.valid, false, `authority ${authority} must be refused`);
    assert.match(result.errors.join("\n"), /geomagnetic\.dstAuthority/);
  }

  const orphan = basePacket();
  orphan.geomagnetic.dstAuthority = SpaceWeatherAuthority.CALLER;
  assert.equal(validateSpaceWeatherPacket(orphan).valid, false);
});

test("validation rejects malformed versions", () => {
  for (const version of [undefined, 0, 2, "1", null, 1.5, Number.NaN]) {
    const packet = basePacket();
    packet.version = version;
    const result = validateSpaceWeatherPacket(packet);
    assert.equal(result.valid, false, `version ${String(version)}`);
    assert.match(result.errors[0], /^version: expected 1/);
  }
  assert.equal(validateSpaceWeatherPacket(basePacket()).valid, true);
  assert.equal(validateSpaceWeatherPacket(undefined).valid, false);
  assert.equal(validateSpaceWeatherPacket([]).valid, false);
});

test("validation rejects non-finite and out-of-range values", () => {
  const cases = [
    ["geomagnetic.activity", (p) => (p.geomagnetic.activity = Number.NaN)],
    ["geomagnetic.activity", (p) => (p.geomagnetic.activity = 1.0001)],
    ["geomagnetic.activity", (p) => (p.geomagnetic.activity = -0.0001)],
    ["geomagnetic.kpIndex", (p) => (p.geomagnetic.kpIndex = 9.5)],
    ["geomagnetic.bzNanoTesla", (p) => (p.geomagnetic.bzNanoTesla = Infinity)],
    ["geomagnetic.authority", (p) => (p.geomagnetic.authority = "kyoto")],
    ["provenance.sourceId", (p) => (p.provenance.sourceId = "")],
    ["provenance.kind", (p) => (p.provenance.kind = "guess")],
    ["provenance.validitySeconds", (p) => (p.provenance.validitySeconds = 0)],
    ["observedTimeMs", (p) => (p.observedTimeMs = "1000")],
    ["forecastTimeMs", (p) => (p.forecastTimeMs = p.observedTimeMs - 1)],
  ];
  for (const [path, mutate] of cases) {
    const packet = basePacket();
    mutate(packet);
    const result = validateSpaceWeatherPacket(packet);
    assert.equal(result.valid, false, path);
    assert.match(
      result.errors.join("\n"),
      new RegExp(path.replace(/\./g, "\\.")),
    );
  }
});

test("validation rejects the feed fill value by name", () => {
  const packet = basePacket();
  packet.solarWind = {
    authority: SpaceWeatherAuthority.RTSW,
    speedKmPerSecond: SPACE_WEATHER_FILL_VALUE,
  };
  const result = validateSpaceWeatherPacket(packet);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /fill value/);

  packet.solarWind.speedKmPerSecond = 450;
  packet.solarWind.bzGsmNanoTesla = SPACE_WEATHER_FILL_VALUE;
  assert.equal(validateSpaceWeatherPacket(packet).valid, false);

  packet.solarWind.bzGsmNanoTesla = -12;
  assert.equal(validateSpaceWeatherPacket(packet).valid, true);
});

test("validation rejects an inconsistent oval grid", () => {
  const shortBuffer = {
    ...basePacket(),
    oval: ovalField(SpaceWeatherAuthority.SYNTHETIC, {
      intensity: new Float32Array([0, 1, 0]),
    }),
  };
  let result = validateSpaceWeatherPacket(shortBuffer);
  assert.equal(result.valid, false);
  assert.match(
    result.errors.join("\n"),
    /does not equal gridWidth \* gridHeight/,
  );

  const outOfRange = {
    ...basePacket(),
    oval: ovalField(SpaceWeatherAuthority.SYNTHETIC, {
      intensity: new Float32Array([0, 1, 0, 1.5]),
    }),
  };
  result = validateSpaceWeatherPacket(outOfRange);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /normalized grid/);

  // A raw grid must declare its ceiling, because the source unit is not stated.
  const rawWithoutCeiling = {
    ...basePacket(),
    oval: ovalField(SpaceWeatherAuthority.OVATION, {
      intensityScale: "raw",
      intensity: new Float32Array([0, 4, 11, 16]),
    }),
  };
  result = validateSpaceWeatherPacket(rawWithoutCeiling);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /oval\.rawMaximum/);

  const rawWithCeiling = {
    ...basePacket(),
    oval: ovalField(SpaceWeatherAuthority.OVATION, {
      intensityScale: "raw",
      rawMaximum: 16,
      intensity: new Float32Array([0, 4, 11, 16]),
    }),
  };
  assert.equal(validateSpaceWeatherPacket(rawWithCeiling).valid, true);
});

test("a geomagnetic oval must declare its field-model epoch", () => {
  // The epic requires the field model's epoch to be explicit and replaceable
  // rather than hidden in a constant. That is only mechanical if an epoch-less
  // geomagnetic grid is refused, so this asserts the refusal and its reason.
  const withoutEpoch = {
    ...basePacket(),
    oval: ovalField(SpaceWeatherAuthority.SYNTHETIC, {
      frame: "geomagnetic",
      frameEpoch: undefined,
    }),
  };
  const result = validateSpaceWeatherPacket(withoutEpoch);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /oval\.frameEpoch/);
  assert.match(result.errors.join("\n"), /geomagnetic frame must declare/);

  const withEpoch = {
    ...basePacket(),
    oval: ovalField(SpaceWeatherAuthority.SYNTHETIC, {
      frame: "geomagnetic",
      frameEpoch: 2025.0,
    }),
  };
  assert.equal(validateSpaceWeatherPacket(withEpoch).valid, true);

  // A geographic grid is placed by no field model, so it owes no epoch.
  const geographic = {
    ...basePacket(),
    oval: ovalField(SpaceWeatherAuthority.OVATION, {
      frame: "geographic",
      frameEpoch: undefined,
    }),
  };
  assert.equal(validateSpaceWeatherPacket(geographic).valid, true);

  // A declared epoch is still checked for finiteness in either frame.
  const nonFinite = {
    ...basePacket(),
    oval: ovalField(SpaceWeatherAuthority.OVATION, {
      frame: "geographic",
      frameEpoch: Number.NaN,
    }),
  };
  assert.equal(validateSpaceWeatherPacket(nonFinite).valid, false);
  assert.match(
    validateSpaceWeatherPacket(nonFinite).errors.join("\n"),
    /finite decimal year/,
  );
});

test("a source moving backwards in time is a stale update", () => {
  const driver = new ManualSpaceWeatherDriver({
    enabled: true,
    sourceId: "feed",
  });
  const current = driver.sampleAt(120);
  const older = driver.sampleAt(60);
  const newer = driver.sampleAt(180);
  assert.equal(isStaleSpaceWeatherUpdate(current, older), true);
  assert.equal(isStaleSpaceWeatherUpdate(current, newer), false);
  assert.equal(isStaleSpaceWeatherUpdate(current, current), false);

  // A different source is never stale here: choosing between sources is an
  // authority question, not a freshness one. This is also what keeps the rule
  // from being applied to the rows of a newest-first feed.
  const other = new ManualSpaceWeatherDriver({
    enabled: true,
    sourceId: "other",
  }).sampleAt(0);
  assert.equal(isStaleSpaceWeatherUpdate(current, other), false);
});

test("age and freshness are derived from a supplied instant", () => {
  const packet = freezeSpaceWeatherPacket({
    ...basePacket(),
    observedTimeMs: 10_000,
    forecastTimeMs: 10_000,
    provenance: { sourceId: "fixture", kind: "observed", validitySeconds: 60 },
  });
  assert.equal(spaceWeatherPacketAgeSeconds(packet, 10_000), 0);
  assert.equal(spaceWeatherPacketAgeSeconds(packet, 70_000), 60);
  assert.equal(spaceWeatherPacketAgeSeconds(packet, 4_000), -6);

  assert.equal(spaceWeatherFreshness(packet, 10_000), "fresh");
  assert.equal(spaceWeatherFreshness(packet, 70_000), "fresh");
  assert.equal(spaceWeatherFreshness(packet, 70_001), "aging");
  assert.equal(spaceWeatherFreshness(packet, 130_000), "aging");
  assert.equal(spaceWeatherFreshness(packet, 130_001), "stale");
  assert.equal(
    spaceWeatherFreshness(packet, 0),
    "fresh",
    "a forecast is not stale",
  );

  // The packet is frozen, so a consumer cannot age it by writing to it.
  assert.throws(() => {
    packet.observedTimeMs = 0;
  }, TypeError);
});
