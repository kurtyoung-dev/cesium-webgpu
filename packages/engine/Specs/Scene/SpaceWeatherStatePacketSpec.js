import {
  auroraOvalIntensityScale,
  freezeSpaceWeatherPacket,
  isStaleSpaceWeatherUpdate,
  spaceWeatherAuthorityOf,
  spaceWeatherFreshness,
  spaceWeatherPacketAgeSeconds,
  validateSpaceWeatherPacket,
} from "../../Source/Scene/SpaceWeather/SpaceWeatherPacket.js";
import {
  ManualSpaceWeatherDriver,
  SPACE_WEATHER_PRESETS,
} from "../../Source/Scene/SpaceWeather/ManualSpaceWeatherDriver.js";
import {
  SPACE_WEATHER_FILL_VALUE,
  SPACE_WEATHER_PACKET_VERSION,
  SpaceWeatherAuthority,
  SpaceWeatherField,
} from "../../Source/Scene/SpaceWeather/SpaceWeatherTypes.js";

describe("Scene/SpaceWeather/SpaceWeatherStatePacket", function () {
  // The assertions here read values that came out of the modules: a packet
  // field, a validation message, a counter, a serialized sequence. The packet is
  // what both renderers will consume, so its contract is pinned by its output
  // and not by the shape of the code that produces it.

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

  function ovalField(authority, overrides) {
    return Object.assign(
      {
        authority: authority,
        frame: "geomagnetic",
        hemisphere: "north",
        gridWidth: 2,
        gridHeight: 2,
        intensity: new Float32Array([0.0, 0.25, 0.5, 1.0]),
        bounds: {
          west: -Math.PI,
          south: 0.0,
          east: Math.PI,
          north: Math.PI / 2.0,
        },
        intensityScale: "normalized",
        frameEpoch: 2025.0,
      },
      overrides,
    );
  }

  function withoutFlare(packet) {
    const copy = Object.assign({}, packet);
    delete copy.flare;
    return JSON.stringify(copy);
  }

  it("yields the documented values for every preset", function () {
    const expected = {
      quiet: { kpIndex: 1, activity: 1.0 / 9.0, bzNanoTesla: -1 },
      moderate: { kpIndex: 5, activity: 5.0 / 9.0, bzNanoTesla: -8 },
      severe: { kpIndex: 8, activity: 8.0 / 9.0, bzNanoTesla: -25 },
    };
    Object.keys(expected).forEach(function (name) {
      const values = expected[name];
      expect(SPACE_WEATHER_PRESETS[name].kpIndex).toBe(values.kpIndex);
      expect(SPACE_WEATHER_PRESETS[name].activity).toBe(values.activity);
      expect(SPACE_WEATHER_PRESETS[name].bzNanoTesla).toBe(values.bzNanoTesla);

      const driver = new ManualSpaceWeatherDriver({
        enabled: true,
        preset: name,
      });
      const packet = driver.sampleAt(0.0);
      expect(packet.version).toBe(SPACE_WEATHER_PACKET_VERSION);
      expect(packet.provenance.kind).toBe("manual");
      expect(packet.provenance.label).toBe(name);
      expect(packet.geomagnetic.activity).toBe(values.activity);
      expect(packet.geomagnetic.kpIndex).toBe(values.kpIndex);
      expect(packet.geomagnetic.bzNanoTesla).toBe(values.bzNanoTesla);
      expect(packet.geomagnetic.authority).toBe(SpaceWeatherAuthority.MANUAL);
      expect(validateSpaceWeatherPacket(packet).valid).toBe(true);
    });
  });

  it("moves activity and the planetary index together under a continuous override", function () {
    const driver = new ManualSpaceWeatherDriver({ enabled: true });
    driver.setActivity(0.5);
    let packet = driver.sampleAt(0.0);
    expect(packet.geomagnetic.activity).toBe(0.5);
    expect(packet.geomagnetic.kpIndex).toBe(4.5);
    expect(driver.preset).toBeUndefined();

    driver.setKpIndex(9.0);
    packet = driver.sampleAt(0.0);
    expect(packet.geomagnetic.activity).toBe(1.0);
    expect(packet.geomagnetic.kpIndex).toBe(9.0);

    expect(function () {
      driver.setActivity(1.5);
    }).toThrowDeveloperError();
    expect(function () {
      driver.setKpIndex(Number.NaN);
    }).toThrowDeveloperError();
  });

  it("replays a scripted timeline byte-identically", function () {
    const epochMs = 1700000000000;
    const timeline = [
      { timeSeconds: 0, preset: "quiet" },
      { timeSeconds: 60, kpIndex: 5, dstNanoTesla: -40 },
      { timeSeconds: 120, preset: "severe", dstNanoTesla: -180 },
    ];
    const times = [-10, 0, 15, 30, 60, 90, 120, 600];

    function run() {
      const driver = new ManualSpaceWeatherDriver({
        enabled: true,
        epochMs: epochMs,
      });
      driver.setTimeline(timeline);
      return times.map(function (t) {
        return JSON.stringify(driver.sampleAt(t));
      });
    }

    expect(run()).toEqual(run());

    const driver = new ManualSpaceWeatherDriver({
      enabled: true,
      epochMs: epochMs,
    });
    driver.setTimeline(timeline);
    times.forEach(function (t) {
      const packet = driver.sampleAt(t);
      // The observation instant is arithmetic on the sample time, never a clock
      // read, which is what makes the replay reproducible.
      expect(packet.observedTimeMs).toBe(epochMs + t * 1000);
      expect(packet.forecastTimeMs).toBe(packet.observedTimeMs);
    });

    expect(driver.sampleAt(30).geomagnetic.activity).toBe(
      (1.0 / 9.0 + 5.0 / 9.0) / 2.0,
    );
    expect(driver.sampleAt(-10).geomagnetic.activity).toBe(1.0 / 9.0);
    expect(driver.sampleAt(600).geomagnetic.activity).toBe(8.0 / 9.0);
    expect(driver.sampleAt(0).geomagnetic.dstNanoTesla).toBeUndefined();
    expect(driver.sampleAt(90).geomagnetic.dstNanoTesla).toBe(-110);
  });

  it("holds discrete state from the step at or before the sample", function () {
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

    // Strictly between two steps the activity scalar interpolates while the
    // preset label and the flare are held from the earlier neighbour. Reading
    // either from the later one is an off-by-one that no arithmetic assertion
    // can see, because the interpolated scalars are unaffected by it.
    const between = driver.sampleAt(30);
    expect(between.geomagnetic.activity).toBeGreaterThan(1.0 / 9.0);
    expect(between.geomagnetic.activity).toBeLessThan(8.0 / 9.0);
    expect(between.provenance.label).toBe("quiet");
    expect(between.flare.flareClass).toBe("C");
    expect(between.flare.magnitude).toBe(2);

    // A step's own instant belongs to that step, not to the interval before it.
    expect(driver.sampleAt(60).provenance.label).toBe("severe");
    expect(driver.sampleAt(60).flare.flareClass).toBe("X");

    // A step that declares no flare clears it from its own instant forward, and
    // the clearing never reaches backwards into the interval before it.
    expect(driver.sampleAt(90).flare.flareClass).toBe("X");
    expect(driver.sampleAt(120).flare).toBeUndefined();
    expect(driver.sampleAt(600).provenance.label).toBe("moderate");
  });

  it("refuses a malformed script", function () {
    const driver = new ManualSpaceWeatherDriver({ enabled: true });
    expect(function () {
      driver.setTimeline([
        { timeSeconds: 0, preset: "quiet" },
        { timeSeconds: 0, preset: "severe" },
      ]);
    }).toThrowDeveloperError();
    expect(function () {
      driver.setTimeline([{ timeSeconds: 0 }]);
    }).toThrowDeveloperError();
    expect(function () {
      driver.setTimeline([{ timeSeconds: Number.NaN, preset: "quiet" }]);
    }).toThrowDeveloperError();
  });

  it("costs nothing while disabled", function () {
    const counts = {};
    const restore = [];
    ["setTimeout", "setInterval", "requestAnimationFrame", "fetch"].forEach(
      function (name) {
        const original = globalThis[name];
        if (typeof original !== "function") {
          return;
        }
        counts[name] = 0;
        globalThis[name] = function () {
          counts[name] += 1;
          return original.apply(this, arguments);
        };
        restore.push(function () {
          globalThis[name] = original;
        });
      },
    );
    const originalDateNow = Date.now;
    counts["Date.now"] = 0;
    Date.now = function () {
      counts["Date.now"] += 1;
      return originalDateNow.call(Date);
    };
    restore.push(function () {
      Date.now = originalDateNow;
    });

    let driver;
    const returned = [];
    try {
      driver = new ManualSpaceWeatherDriver();
      expect(driver.enabled).toBe(false);
      expect(driver.packetsBuilt).toBe(0);
      driver.setPreset("severe");
      driver.setDstOverride(-250);
      driver.setFlare({ flareClass: "X", magnitude: 4.2 });
      driver.setTimeline([
        { timeSeconds: 0, preset: "quiet" },
        { timeSeconds: 10, preset: "severe" },
      ]);
      for (let i = 0; i < 1000; ++i) {
        returned.push(driver.sampleAt(i * 0.25));
      }
    } finally {
      restore.reverse().forEach(function (undo) {
        undo();
      });
    }

    returned.forEach(function (value) {
      expect(value).toBeUndefined();
    });
    expect(driver.packetsBuilt).toBe(0);
    expect(driver.getDiagnostics().packetsBuilt).toBe(0);
    Object.keys(counts).forEach(function (name) {
      expect(counts[name]).toBe(0);
    });

    driver.enabled = true;
    expect(driver.sampleAt(5.0)).toBeDefined();
    expect(driver.packetsBuilt).toBe(1);
  });

  it("produces every state with the network primitives removed", function () {
    const removed = ["fetch", "XMLHttpRequest", "WebSocket", "EventSource"];
    const originals = {};
    removed.forEach(function (name) {
      originals[name] = globalThis[name];
      globalThis[name] = function () {
        throw new Error(`${name} must not be reached`);
      };
    });
    try {
      const driver = new ManualSpaceWeatherDriver({ enabled: true });
      ["quiet", "moderate", "severe"].forEach(function (preset) {
        driver.setPreset(preset);
        driver.setFlare({ flareClass: "M", magnitude: 1.5 });
        driver.setSolarWind({ sourceName: "fixture", speedKmPerSecond: 700 });
        expect(validateSpaceWeatherPacket(driver.sampleAt(42.0)).valid).toBe(
          true,
        );
      });
      driver.setTimeline([
        { timeSeconds: 0, preset: "quiet" },
        { timeSeconds: 30, preset: "severe" },
      ]);
      expect(validateSpaceWeatherPacket(driver.sampleAt(15.0)).valid).toBe(
        true,
      );
      expect(driver.packetsBuilt).toBe(4);
    } finally {
      removed.forEach(function (name) {
        globalThis[name] = originals[name];
      });
    }
  });

  it("keeps the flare channel and the geomagnetic channel independent", function () {
    const driver = new ManualSpaceWeatherDriver({
      enabled: true,
      preset: "moderate",
    });
    const withoutAnyFlare = driver.sampleAt(0.0);
    expect(withoutAnyFlare.flare).toBeUndefined();

    driver.setFlare({
      flareClass: "X",
      magnitude: 9.3,
      longBandFluxWattsPerSquareMeter: 9.3e-4,
    });
    const withX = driver.sampleAt(0.0);
    expect(withX.flare.flareClass).toBe("X");
    expect(withX.flare.authority).toBe(SpaceWeatherAuthority.MANUAL);
    expect(withoutFlare(withX)).toEqual(withoutFlare(withoutAnyFlare));
    expect(withX.geomagnetic.activity).toBe(5.0 / 9.0);

    driver.setFlare({ flareClass: "A", magnitude: 1.0 });
    expect(withoutFlare(driver.sampleAt(0.0))).toEqual(withoutFlare(withX));

    driver.setFlare(undefined);
    driver.setKpIndex(9.0);
    const storm = driver.sampleAt(0.0);
    expect(storm.flare).toBeUndefined();
    expect(storm.geomagnetic.activity).toBe(1.0);

    const synthetic = Object.assign(basePacket(), {
      oval: ovalField(SpaceWeatherAuthority.SYNTHETIC),
    });
    const withFlare = Object.assign({}, synthetic, {
      flare: {
        authority: SpaceWeatherAuthority.GOES,
        flareClass: "X",
        magnitude: 9.9,
      },
    });
    expect(auroraOvalIntensityScale(withFlare)).toBe(
      auroraOvalIntensityScale(synthetic),
    );
    expect(auroraOvalIntensityScale(withFlare)).toBe(0.5);
  });

  it("lets a model-authored oval own its own intensity", function () {
    const packet = basePacket();
    expect(auroraOvalIntensityScale(packet)).toBe(0.5);

    const synthetic = Object.assign({}, packet, {
      oval: ovalField(SpaceWeatherAuthority.SYNTHETIC),
    });
    expect(auroraOvalIntensityScale(synthetic)).toBe(0.5);
    expect(spaceWeatherAuthorityOf(synthetic, SpaceWeatherField.OVAL)).toBe(
      SpaceWeatherAuthority.SYNTHETIC,
    );

    const modelled = Object.assign({}, packet, {
      oval: ovalField(SpaceWeatherAuthority.OVATION),
    });
    expect(auroraOvalIntensityScale(modelled)).toBe(1.0);
    expect(spaceWeatherAuthorityOf(modelled, SpaceWeatherField.OVAL)).toBe(
      SpaceWeatherAuthority.OVATION,
    );
  });

  it("reports an authority per field", function () {
    const driver = new ManualSpaceWeatherDriver({ enabled: true });
    driver.setDstOverride(-120);
    driver.setFlare({ flareClass: "C", magnitude: 3.0 });
    driver.setSolarWind({ speedKmPerSecond: 500 });
    const packet = driver.sampleAt(0.0);
    expect(spaceWeatherAuthorityOf(packet, SpaceWeatherField.ACTIVITY)).toBe(
      SpaceWeatherAuthority.MANUAL,
    );
    expect(spaceWeatherAuthorityOf(packet, SpaceWeatherField.DST)).toBe(
      SpaceWeatherAuthority.CALLER,
    );
    expect(spaceWeatherAuthorityOf(packet, SpaceWeatherField.FLARE)).toBe(
      SpaceWeatherAuthority.MANUAL,
    );
    expect(spaceWeatherAuthorityOf(packet, SpaceWeatherField.SOLAR_WIND)).toBe(
      SpaceWeatherAuthority.MANUAL,
    );
    expect(
      spaceWeatherAuthorityOf(packet, SpaceWeatherField.OVAL),
    ).toBeUndefined();

    driver.setDstOverride(undefined);
    const cleared = driver.sampleAt(0.0);
    expect(cleared.geomagnetic.dstNanoTesla).toBeUndefined();
    expect(
      spaceWeatherAuthorityOf(cleared, SpaceWeatherField.DST),
    ).toBeUndefined();
  });

  it("accepts a ring-current index only from the caller", function () {
    const driver = new ManualSpaceWeatherDriver({ enabled: true });
    driver.setDstOverride(-320);
    const packet = driver.sampleAt(0.0);
    expect(packet.geomagnetic.dstNanoTesla).toBe(-320);
    expect(packet.geomagnetic.dstAuthority).toBe(SpaceWeatherAuthority.CALLER);
    expect(validateSpaceWeatherPacket(packet).valid).toBe(true);

    ["kp", "rtsw", "ovation", "goes", "synthetic", "manual"].forEach(
      function (authority) {
        const forged = basePacket();
        forged.geomagnetic.dstNanoTesla = -320;
        forged.geomagnetic.dstAuthority = authority;
        const result = validateSpaceWeatherPacket(forged);
        expect(result.valid).toBe(false);
        expect(result.errors.join("\n")).toContain("geomagnetic.dstAuthority");
      },
    );

    const orphan = basePacket();
    orphan.geomagnetic.dstAuthority = SpaceWeatherAuthority.CALLER;
    expect(validateSpaceWeatherPacket(orphan).valid).toBe(false);
  });

  it("rejects malformed versions", function () {
    [undefined, 0, 2, "1", null, 1.5, Number.NaN].forEach(function (version) {
      const packet = basePacket();
      packet.version = version;
      const result = validateSpaceWeatherPacket(packet);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("version: expected 1");
    });
    expect(validateSpaceWeatherPacket(basePacket()).valid).toBe(true);
    expect(validateSpaceWeatherPacket(undefined).valid).toBe(false);
    expect(validateSpaceWeatherPacket([]).valid).toBe(false);
  });

  it("rejects non-finite and range-invalid values", function () {
    const cases = [
      [
        "geomagnetic.activity",
        function (p) {
          p.geomagnetic.activity = Number.NaN;
        },
      ],
      [
        "geomagnetic.activity",
        function (p) {
          p.geomagnetic.activity = 1.0001;
        },
      ],
      [
        "geomagnetic.kpIndex",
        function (p) {
          p.geomagnetic.kpIndex = 9.5;
        },
      ],
      [
        "geomagnetic.bzNanoTesla",
        function (p) {
          p.geomagnetic.bzNanoTesla = Number.POSITIVE_INFINITY;
        },
      ],
      [
        "geomagnetic.authority",
        function (p) {
          p.geomagnetic.authority = "kyoto";
        },
      ],
      [
        "provenance.sourceId",
        function (p) {
          p.provenance.sourceId = "";
        },
      ],
      [
        "provenance.kind",
        function (p) {
          p.provenance.kind = "guess";
        },
      ],
      [
        "provenance.validitySeconds",
        function (p) {
          p.provenance.validitySeconds = 0;
        },
      ],
      [
        "observedTimeMs",
        function (p) {
          p.observedTimeMs = "1000";
        },
      ],
      [
        "forecastTimeMs",
        function (p) {
          p.forecastTimeMs = p.observedTimeMs - 1;
        },
      ],
    ];
    cases.forEach(function (entry) {
      const packet = basePacket();
      entry[1](packet);
      const result = validateSpaceWeatherPacket(packet);
      expect(result.valid).toBe(false);
      expect(result.errors.join("\n")).toContain(entry[0]);
    });
  });

  it("rejects the feed fill value by name", function () {
    const packet = basePacket();
    packet.solarWind = {
      authority: SpaceWeatherAuthority.RTSW,
      speedKmPerSecond: SPACE_WEATHER_FILL_VALUE,
    };
    expect(validateSpaceWeatherPacket(packet).errors.join("\n")).toContain(
      "fill value",
    );

    packet.solarWind.speedKmPerSecond = 450;
    packet.solarWind.bzGsmNanoTesla = SPACE_WEATHER_FILL_VALUE;
    expect(validateSpaceWeatherPacket(packet).valid).toBe(false);

    packet.solarWind.bzGsmNanoTesla = -12;
    expect(validateSpaceWeatherPacket(packet).valid).toBe(true);
  });

  it("rejects an inconsistent oval grid", function () {
    const shortBuffer = Object.assign({}, basePacket(), {
      oval: ovalField(SpaceWeatherAuthority.SYNTHETIC, {
        intensity: new Float32Array([0.0, 1.0, 0.0]),
      }),
    });
    expect(validateSpaceWeatherPacket(shortBuffer).errors.join("\n")).toContain(
      "does not equal gridWidth * gridHeight",
    );

    const outOfRange = Object.assign({}, basePacket(), {
      oval: ovalField(SpaceWeatherAuthority.SYNTHETIC, {
        intensity: new Float32Array([0.0, 1.0, 0.0, 1.5]),
      }),
    });
    expect(validateSpaceWeatherPacket(outOfRange).errors.join("\n")).toContain(
      "normalized grid",
    );

    const rawWithoutCeiling = Object.assign({}, basePacket(), {
      oval: ovalField(SpaceWeatherAuthority.OVATION, {
        intensityScale: "raw",
        intensity: new Float32Array([0.0, 4.0, 11.0, 16.0]),
      }),
    });
    expect(
      validateSpaceWeatherPacket(rawWithoutCeiling).errors.join("\n"),
    ).toContain("oval.rawMaximum");

    const rawWithCeiling = Object.assign({}, basePacket(), {
      oval: ovalField(SpaceWeatherAuthority.OVATION, {
        intensityScale: "raw",
        rawMaximum: 16.0,
        intensity: new Float32Array([0.0, 4.0, 11.0, 16.0]),
      }),
    });
    expect(validateSpaceWeatherPacket(rawWithCeiling).valid).toBe(true);
  });

  it("requires a geomagnetic oval to declare its field-model epoch", function () {
    // The field model's epoch has to be explicit and replaceable rather than
    // hidden in a constant, which is only mechanical if an epoch-less
    // geomagnetic grid is refused.
    const withoutEpoch = Object.assign({}, basePacket(), {
      oval: ovalField(SpaceWeatherAuthority.SYNTHETIC, {
        frame: "geomagnetic",
        frameEpoch: undefined,
      }),
    });
    const result = validateSpaceWeatherPacket(withoutEpoch);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain("oval.frameEpoch");
    expect(result.errors.join("\n")).toContain(
      "geomagnetic frame must declare",
    );

    const withEpoch = Object.assign({}, basePacket(), {
      oval: ovalField(SpaceWeatherAuthority.SYNTHETIC, {
        frame: "geomagnetic",
        frameEpoch: 2025.0,
      }),
    });
    expect(validateSpaceWeatherPacket(withEpoch).valid).toBe(true);

    const geographic = Object.assign({}, basePacket(), {
      oval: ovalField(SpaceWeatherAuthority.OVATION, {
        frame: "geographic",
        frameEpoch: undefined,
      }),
    });
    expect(validateSpaceWeatherPacket(geographic).valid).toBe(true);

    const nonFinite = Object.assign({}, basePacket(), {
      oval: ovalField(SpaceWeatherAuthority.OVATION, {
        frame: "geographic",
        frameEpoch: Number.NaN,
      }),
    });
    expect(validateSpaceWeatherPacket(nonFinite).valid).toBe(false);
    expect(validateSpaceWeatherPacket(nonFinite).errors.join("\n")).toContain(
      "finite decimal year",
    );
  });

  it("treats a source moving backwards in time as stale", function () {
    const driver = new ManualSpaceWeatherDriver({
      enabled: true,
      sourceId: "feed",
    });
    const current = driver.sampleAt(120.0);
    expect(isStaleSpaceWeatherUpdate(current, driver.sampleAt(60.0))).toBe(
      true,
    );
    expect(isStaleSpaceWeatherUpdate(current, driver.sampleAt(180.0))).toBe(
      false,
    );
    expect(isStaleSpaceWeatherUpdate(current, current)).toBe(false);

    const other = new ManualSpaceWeatherDriver({
      enabled: true,
      sourceId: "other",
    }).sampleAt(0.0);
    expect(isStaleSpaceWeatherUpdate(current, other)).toBe(false);
  });

  it("derives age and freshness from a supplied instant", function () {
    const packet = freezeSpaceWeatherPacket(
      Object.assign({}, basePacket(), {
        observedTimeMs: 10000,
        forecastTimeMs: 10000,
        provenance: {
          sourceId: "fixture",
          kind: "observed",
          validitySeconds: 60,
        },
      }),
    );
    expect(spaceWeatherPacketAgeSeconds(packet, 10000)).toBe(0);
    expect(spaceWeatherPacketAgeSeconds(packet, 70000)).toBe(60);
    expect(spaceWeatherPacketAgeSeconds(packet, 4000)).toBe(-6);

    expect(spaceWeatherFreshness(packet, 10000)).toBe("fresh");
    expect(spaceWeatherFreshness(packet, 70000)).toBe("fresh");
    expect(spaceWeatherFreshness(packet, 70001)).toBe("aging");
    expect(spaceWeatherFreshness(packet, 130000)).toBe("aging");
    expect(spaceWeatherFreshness(packet, 130001)).toBe("stale");
    expect(spaceWeatherFreshness(packet, 0)).toBe("fresh");

    // A frozen packet cannot be aged by writing to it. The write throws under
    // strict mode and is silently dropped otherwise, so the assertion is on the
    // value that survives rather than on the throw.
    try {
      packet.observedTimeMs = 0;
    } catch (error) {
      expect(error instanceof TypeError).toBe(true);
    }
    expect(packet.observedTimeMs).toBe(10000);
  });
});
