import Resource from "../../Source/Core/Resource.js";
import {
  OVATION_LONGITUDE_COUNT,
  OVATION_SAMPLE_COUNT,
  OvationPolePolicy,
  OvationRejectionCode,
  normalizeOvationPayload,
  ovationColumnForLongitude,
  ovationSourceIndex,
} from "../../Source/Scene/SpaceWeather/OvationGridNormalizer.js";
import {
  PLANETARY_KP_FIELD,
  PlanetaryKpProduct,
  PlanetaryKpRejectionCode,
  normalizePlanetaryKpPayload,
  parseSpaceWeatherTimeTag,
} from "../../Source/Scene/SpaceWeather/PlanetaryKpNormalizer.js";
import {
  OVATION_VALIDITY_CEILING_SECONDS,
  OVATION_VALIDITY_FLOOR_SECONDS,
  PLANETARY_KP_CADENCE_SECONDS,
  SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS,
  SpaceWeatherOvalOwner,
  SpaceWeatherOwnershipReason,
  ovalAuthorityFor,
  ovalForcingMultiplier,
  ovationFreshness,
  ovationValiditySeconds,
  resolveOvalOwnership,
  spaceWeatherForecastLeadSeconds,
  spaceWeatherObservationIsPlausible,
} from "../../Source/Scene/SpaceWeather/SpaceWeatherSourceAuthority.js";
import { SpaceWeatherFeedIngest } from "../../Source/Scene/SpaceWeather/SpaceWeatherFeedIngest.js";
import {
  auroraOvalIntensityScale,
  validateSpaceWeatherPacket,
} from "../../Source/Scene/SpaceWeather/SpaceWeatherPacket.js";

describe("Scene/SpaceWeather/SpaceWeatherFeedIngest", function () {
  // The assertions here read values that came out of the modules against the
  // byte-frozen captures in Specs/Data/SpaceWeather: a sample at a named grid
  // cell, a rejection code, a counter, a packet field. The captures are pinned
  // by SHA-256 in their sidecar README, so a number below moving means either
  // the normalization changed or the fixture did.

  const OBSERVED_MS = Date.parse("2026-09-19T12:40:00Z");
  const FORECAST_MS = Date.parse("2026-09-19T13:42:00Z");
  const MEASURED_LEAD_SECONDS = 3720;
  const OVATION_URL = "test://ovation";
  const KP_URL = "test://kp";

  let ovationFixture;
  let kpObservedFixture;
  let kpForecastFixture;

  beforeAll(async function () {
    ovationFixture = await Resource.fetchJson({
      url: "Data/SpaceWeather/ovation_aurora_latest.json",
    });
    kpObservedFixture = await Resource.fetchJson({
      url: "Data/SpaceWeather/noaa-planetary-k-index.json",
    });
    kpForecastFixture = await Resource.fetchJson({
      url: "Data/SpaceWeather/noaa-planetary-k-index-forecast.json",
    });
  });

  function wireSample(payload, longitudeDegrees, latitudeDegrees) {
    return payload.coordinates[
      ovationSourceIndex(longitudeDegrees, latitudeDegrees)
    ][2];
  }

  function gridSample(field, row, column) {
    return field.intensity[row * field.gridWidth + column];
  }

  function syntheticOvationPayload(options) {
    const coordinates = [];
    for (let longitude = 0; longitude < OVATION_LONGITUDE_COUNT; ++longitude) {
      for (let latitude = -90; latitude <= 90; ++latitude) {
        coordinates.push([
          longitude,
          latitude,
          options.sample(longitude, latitude),
        ]);
      }
    }
    return {
      "Observation Time": options.observationTime ?? "2026-09-19T12:40:00Z",
      "Forecast Time": options.forecastTime ?? "2026-09-19T13:42:00Z",
      "Data Format": "[Longitude, Latitude, Aurora]",
      coordinates: coordinates,
      type: "MultiPoint",
    };
  }

  function kpRowsAt(instantMs, kp) {
    return [
      {
        time_tag: new Date(instantMs - PLANETARY_KP_CADENCE_SECONDS * 1000)
          .toISOString()
          .replace(/\.\d{3}Z$/, ""),
        Kp: kp,
        a_running: 5,
        station_count: 8,
      },
      {
        time_tag: new Date(instantMs).toISOString().replace(/\.\d{3}Z$/, ""),
        Kp: kp,
        a_running: 5,
        station_count: 8,
      },
    ];
  }

  function scriptedTransport() {
    const calls = [];
    const queue = new Map();
    return {
      calls: calls,
      enqueue: function (url, value) {
        if (!queue.has(url)) {
          queue.set(url, []);
        }
        queue.get(url).push(value);
      },
      fetchJson: function (url, signal) {
        calls.push({ url: url, signal: signal });
        const pending = queue.get(url);
        const next =
          pending !== undefined && pending.length > 0
            ? pending.shift()
            : undefined;
        if (next === undefined) {
          return Promise.reject(new Error(`no scripted response for ${url}`));
        }
        if (next && typeof next.then === "function") {
          return next;
        }
        return Promise.resolve(next);
      },
    };
  }

  function makeIngest(transport, overrides) {
    return new SpaceWeatherFeedIngest({
      fetchJson: transport.fetchJson,
      ovationUrl: OVATION_URL,
      planetaryKpUrl: KP_URL,
      setTimeoutFunction: function () {
        return 1;
      },
      clearTimeoutFunction: function () {},
      ...overrides,
    });
  }

  /** A promise whose settlement the caller drives. */
  function deferred() {
    let resolve;
    const promise = new Promise(function (res) {
      resolve = res;
    });
    return { promise: promise, resolve: resolve };
  }

  it("normalizes the captured snapshot to its declared grid, times and range", function () {
    const result = normalizeOvationPayload(ovationFixture);
    expect(result.status).toBe("ok");
    const snapshot = result.snapshot;

    expect(snapshot.observedTimeMs).toBe(OBSERVED_MS);
    expect(snapshot.forecastTimeMs).toBe(FORECAST_MS);
    expect(snapshot.leadSeconds).toBe(MEASURED_LEAD_SECONDS);
    expect(snapshot.observedMaximum).toBe(16);
    expect(snapshot.nonZeroSampleCount).toBe(15897);

    const field = snapshot.field;
    expect(field.intensity.length).toBe(OVATION_SAMPLE_COUNT);
    expect(field.gridWidth).toBe(360);
    expect(field.gridHeight).toBe(181);
    expect(field.authority).toBe("ovation");
    expect(field.frame).toBe("geographic");
    expect(field.hemisphere).toBe("both");
    // The product publishes no unit and no ceiling, so the integers are carried
    // through and only the snapshot's own maximum is declared.
    expect(field.intensityScale).toBe("raw");
    expect(field.rawMaximum).toBe(16);
    expect(field.bounds.west).toBe(-Math.PI);
    expect((field.bounds.east * 180) / Math.PI).toBe(179);
  });

  it("reads the forecast lead from the payload rather than from a constant", function () {
    const snapshot = normalizeOvationPayload(ovationFixture).snapshot;
    expect(snapshot.leadSeconds).toBe(3720);
    expect(snapshot.leadSeconds).not.toBe(30 * 60);
    expect(snapshot.leadSeconds).not.toBe(94 * 60);
    expect(ovationValiditySeconds(snapshot)).toBe(3720);

    const longer = normalizeOvationPayload(
      syntheticOvationPayload({
        observationTime: "2026-09-19T00:00:00Z",
        forecastTime: "2026-09-19T01:34:00Z",
        sample: function () {
          return 0;
        },
      }),
    ).snapshot;
    expect(longer.leadSeconds).toBe(94 * 60);

    // The documented zero-lead fallback is legitimate and must not expire on
    // arrival, so — and only then — the floor applies.
    const zeroLead = normalizeOvationPayload(
      syntheticOvationPayload({
        observationTime: "2026-09-19T00:00:00Z",
        forecastTime: "2026-09-19T00:00:00Z",
        sample: function () {
          return 0;
        },
      }),
    ).snapshot;
    expect(zeroLead.leadSeconds).toBe(0);
    expect(ovationValiditySeconds(zeroLead)).toBe(
      OVATION_VALIDITY_FLOOR_SECONDS,
    );

    expect(
      spaceWeatherForecastLeadSeconds({
        observedTimeMs: OBSERVED_MS,
        forecastTimeMs: FORECAST_MS,
      }),
    ).toBe(MEASURED_LEAD_SECONDS);
  });

  it("rotates the wire array so the grid begins at the antimeridian", function () {
    const field = normalizeOvationPayload(ovationFixture).snapshot.field;

    expect(ovationColumnForLongitude(180)).toBe(0);
    expect(ovationColumnForLongitude(359)).toBe(179);
    expect(ovationColumnForLongitude(0)).toBe(180);
    expect(ovationColumnForLongitude(179)).toBe(359);

    const latitude = -65;
    const row = 90 - latitude;
    expect(gridSample(field, row, 0)).toBe(
      wireSample(ovationFixture, 180, latitude),
    );
    expect(gridSample(field, row, 179)).toBe(
      wireSample(ovationFixture, 359, latitude),
    );
    expect(gridSample(field, row, 180)).toBe(
      wireSample(ovationFixture, 0, latitude),
    );
    expect(gridSample(field, row, 359)).toBe(
      wireSample(ovationFixture, 179, latitude),
    );
    // Those columns do not all carry the same value, so the expectations above
    // can fail.
    expect(gridSample(field, row, 0)).toBe(6);
    expect(gridSample(field, row, 179)).toBe(0);
    expect(field.bounds.west).toBeLessThan(field.bounds.east);
  });

  it("resolves the pole duplicates by a stated policy, and refuses the capture when agreement is required", function () {
    const south = [];
    for (let longitude = 0; longitude < OVATION_LONGITUDE_COUNT; ++longitude) {
      south.push(wireSample(ovationFixture, longitude, -90));
    }
    // Measured, not assumed: the live product disagrees with itself here.
    expect(new Set(south).size).toBe(6);
    expect(south.reduce((a, b) => a + b, 0)).toBe(1418);

    const mean = normalizeOvationPayload(ovationFixture).snapshot;
    expect(mean.polePolicy).toBe("mean");
    expect(mean.southPoleAgreed).toBe(false);
    expect(mean.northPoleAgreed).toBe(true);
    expect(gridSample(mean.field, 180, 0)).toBe(Math.fround(1418 / 360));

    expect(
      gridSample(
        normalizeOvationPayload(ovationFixture, {
          polePolicy: OvationPolePolicy.MAXIMUM,
        }).snapshot.field,
        180,
        0,
      ),
    ).toBe(5);
    expect(
      gridSample(
        normalizeOvationPayload(ovationFixture, {
          polePolicy: OvationPolePolicy.MINIMUM,
        }).snapshot.field,
        180,
        0,
      ),
    ).toBe(0);

    // The resolved pole is written to all 360 columns, so the pole is one place.
    const northRow = new Set();
    const southRow = new Set();
    for (let column = 0; column < OVATION_LONGITUDE_COUNT; ++column) {
      northRow.add(gridSample(mean.field, 0, column));
      southRow.add(gridSample(mean.field, 180, column));
    }
    expect(northRow.size).toBe(1);
    expect(southRow.size).toBe(1);

    const required = normalizeOvationPayload(ovationFixture, {
      polePolicy: OvationPolePolicy.REQUIRE_AGREEMENT,
    });
    expect(required.status).toBe("refused");
    expect(required.error.code).toBe(OvationRejectionCode.POLE_DISAGREEMENT);
  });

  it("refuses a short, reordered or non-integer grid and builds nothing", function () {
    const complete = syntheticOvationPayload({
      sample: function () {
        return 1;
      },
    });

    const short = {
      ...complete,
      coordinates: complete.coordinates.slice(0, -1),
    };
    expect(normalizeOvationPayload(short).error.code).toBe(
      OvationRejectionCode.COORDINATE_COUNT,
    );
    expect(normalizeOvationPayload(short).snapshot).toBeUndefined();

    const reordered = { ...complete, coordinates: [...complete.coordinates] };
    const first = reordered.coordinates[0];
    reordered.coordinates[0] = reordered.coordinates[1];
    reordered.coordinates[1] = first;
    expect(normalizeOvationPayload(reordered).error.code).toBe(
      OvationRejectionCode.GRID_ORDER,
    );

    const fractional = { ...complete, coordinates: [...complete.coordinates] };
    fractional.coordinates[500] = [2, -52, 3.5];
    expect(normalizeOvationPayload(fractional).error.code).toBe(
      OvationRejectionCode.NON_INTEGER,
    );
  });

  it("refuses each required auroral key when it is removed, renamed or retyped", function () {
    const complete = syntheticOvationPayload({
      sample: function () {
        return 1;
      },
    });
    const cases = [
      ["Observation Time", OvationRejectionCode.OBSERVATION_TIME],
      ["Forecast Time", OvationRejectionCode.FORECAST_TIME],
      ["coordinates", OvationRejectionCode.COORDINATES_MISSING],
    ];
    for (const entry of cases) {
      const key = entry[0];
      const code = entry[1];

      const removed = { ...complete };
      delete removed[key];
      expect(normalizeOvationPayload(removed).error.code).toBe(code);

      const renamed = { ...complete };
      renamed[`${key}_v2`] = renamed[key];
      delete renamed[key];
      expect(normalizeOvationPayload(renamed).error.code).toBe(code);

      expect(
        normalizeOvationPayload({ ...complete, [key]: 12345 }).error.code,
      ).toBe(code);
    }
  });

  it("reads each planetary-index product through its own field name and refuses the swap", function () {
    expect(PLANETARY_KP_FIELD.observed).toBe("Kp");
    expect(PLANETARY_KP_FIELD.forecast).toBe("kp");

    const observed = normalizePlanetaryKpPayload(
      kpObservedFixture,
      PlanetaryKpProduct.OBSERVED,
    );
    expect(observed.status).toBe("ok");
    expect(observed.series.readings.length).toBe(60);
    expect(observed.series.newest.kpIndex).toBe(1.33);

    const forecast = normalizePlanetaryKpPayload(
      kpForecastFixture,
      PlanetaryKpProduct.FORECAST,
    );
    expect(forecast.status).toBe("ok");
    expect(forecast.series.readings.length).toBe(81);
    expect(forecast.series.newest.observationState).toBe("predicted");

    const observedAsForecast = normalizePlanetaryKpPayload(
      kpObservedFixture,
      PlanetaryKpProduct.FORECAST,
    );
    expect(observedAsForecast.status).toBe("refused");
    expect(observedAsForecast.error.code).toBe(
      PlanetaryKpRejectionCode.FIELD_MISSING,
    );

    const forecastAsObserved = normalizePlanetaryKpPayload(
      kpForecastFixture,
      PlanetaryKpProduct.OBSERVED,
    );
    expect(forecastAsObserved.status).toBe("refused");
    expect(forecastAsObserved.error.code).toBe(
      PlanetaryKpRejectionCode.FIELD_MISSING,
    );
  });

  it("reads a zoneless feed timestamp as UTC", function () {
    expect(parseSpaceWeatherTimeTag("2026-09-19T09:00:00")).toBe(
      Date.parse("2026-09-19T09:00:00Z"),
    );
    expect(parseSpaceWeatherTimeTag("2026-09-19T09:00:00+02:00")).toBe(
      Date.parse("2026-09-19T07:00:00Z"),
    );
    expect(kpObservedFixture[kpObservedFixture.length - 1].time_tag).toBe(
      "2026-09-19T09:00:00",
    );
  });

  it("normalizes row order before concluding anything from time", function () {
    const ascending = normalizePlanetaryKpPayload(
      kpObservedFixture,
      PlanetaryKpProduct.OBSERVED,
    ).series;
    const descending = normalizePlanetaryKpPayload(
      [...kpObservedFixture].reverse(),
      PlanetaryKpProduct.OBSERVED,
    ).series;
    expect(descending.newest.timeTagMs).toBe(ascending.newest.timeTagMs);
    expect(descending.readings.map((r) => r.timeTagMs)).toEqual(
      ascending.readings.map((r) => r.timeTagMs),
    );
  });

  it("measures freshness against the horizon the snapshot declares", function () {
    const snapshot = normalizeOvationPayload(ovationFixture).snapshot;
    const lead = MEASURED_LEAD_SECONDS * 1000;
    expect(ovationFreshness(snapshot, OBSERVED_MS)).toBe("fresh");
    expect(ovationFreshness(snapshot, OBSERVED_MS + lead)).toBe("fresh");
    expect(ovationFreshness(snapshot, OBSERVED_MS + lead + 1)).toBe("aging");
    expect(ovationFreshness(snapshot, OBSERVED_MS + 2 * lead + 1)).toBe(
      "stale",
    );
  });

  it("moves ownership in both directions and reports each transition", function () {
    const snapshot = normalizeOvationPayload(ovationFixture).snapshot;
    const staleMs = OBSERVED_MS + 2 * MEASURED_LEAD_SECONDS * 1000 + 1;

    const acquired = resolveOvalOwnership({
      previousOwner: SpaceWeatherOvalOwner.NONE,
      ovation: snapshot,
      kpAvailable: true,
      nowMs: OBSERVED_MS,
    });
    expect(acquired.owner).toBe("ovation");
    expect(acquired.reason).toBe(SpaceWeatherOwnershipReason.OVATION_CURRENT);
    expect(acquired.changed).toBe(true);

    const handedOff = resolveOvalOwnership({
      previousOwner: SpaceWeatherOvalOwner.OVATION,
      ovation: snapshot,
      kpAvailable: true,
      nowMs: staleMs,
    });
    expect(handedOff.owner).toBe("kp");
    expect(handedOff.reason).toBe(SpaceWeatherOwnershipReason.OVATION_STALE);
    expect(handedOff.changed).toBe(true);

    const returned = resolveOvalOwnership({
      previousOwner: SpaceWeatherOvalOwner.KP,
      ovation: snapshot,
      kpAvailable: true,
      nowMs: OBSERVED_MS,
    });
    expect(returned.owner).toBe("ovation");
    expect(returned.changed).toBe(true);

    const nothing = resolveOvalOwnership({
      previousOwner: SpaceWeatherOvalOwner.KP,
      ovation: undefined,
      kpAvailable: false,
      nowMs: OBSERVED_MS,
    });
    expect(nothing.owner).toBe("none");
    expect(nothing.reason).toBe(SpaceWeatherOwnershipReason.NO_SOURCE);

    expect(ovalAuthorityFor("ovation")).toBe("ovation");
    expect(ovalAuthorityFor("kp")).toBe("synthetic");
    expect(ovalAuthorityFor("none")).toBeUndefined();
  });

  it("never multiplies an active auroral field, on either path", function () {
    const activities = [0, 0.25, 1 / 3, 0.5, 1];
    for (const activity of activities) {
      expect(ovalForcingMultiplier("ovation", activity)).toBe(1);
      expect(ovalForcingMultiplier("kp", activity)).toBe(activity);
    }

    const field = normalizeOvationPayload(ovationFixture).snapshot.field;
    expect(
      auroraOvalIntensityScale({
        geomagnetic: { activity: 0.5, authority: "kp" },
        oval: field,
      }),
    ).toBe(1);
    expect(
      auroraOvalIntensityScale({
        geomagnetic: { activity: 0.5, authority: "kp" },
        oval: { ...field, authority: "synthetic" },
      }),
    ).toBe(0.5);
  });

  it("issues nothing until it is started, and its render read issues nothing ever", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    expect(transport.calls.length).toBe(0);
    expect(ingest.latest()).toBeUndefined();
    expect(ingest.diagnostics.requestsIssued).toBe(0);

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.start(OBSERVED_MS);
    expect(transport.calls.length).toBe(2);
    expect(ingest.diagnostics.ovalOwner).toBe("ovation");

    const first = ingest.latest();
    const before = ingest.diagnostics;
    for (let i = 0; i < 1000; ++i) {
      // Identity, not equality: a read that rebuilt the packet would allocate.
      // Compared as a boolean so a failure reports the claim rather than dumping
      // two 65,160-sample grids.
      expect(ingest.latest() === first).toBe(true);
    }
    const after = ingest.diagnostics;
    expect(after.requestsIssued).toBe(before.requestsIssued);
    expect(after.payloadsParsed).toBe(before.payloadsParsed);
    expect(after.gridsAllocated).toBe(before.gridsAllocated);
    expect(after.packetsBuilt).toBe(before.packetsBuilt);
    expect(transport.calls.length).toBe(2);
    ingest.destroy();
  });

  it("discards a superseded result that completes out of order", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);

    let resolveOldOvation;
    let resolveOldKp;
    transport.enqueue(
      OVATION_URL,
      new Promise(function (resolve) {
        resolveOldOvation = resolve;
      }),
    );
    transport.enqueue(
      KP_URL,
      new Promise(function (resolve) {
        resolveOldKp = resolve;
      }),
    );
    const firstCycle = ingest.refreshOnce(OBSERVED_MS);

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    const newest = ingest.latest();
    expect(newest.observedTimeMs).toBe(OBSERVED_MS);

    resolveOldOvation(
      syntheticOvationPayload({
        observationTime: "2026-09-19T06:00:00Z",
        forecastTime: "2026-09-19T07:00:00Z",
        sample: function () {
          return 9;
        },
      }),
    );
    resolveOldKp(kpRowsAt(Date.parse("2026-09-19T06:00:00Z"), 8));
    await firstCycle;

    expect(ingest.latest() === newest).toBe(true);
    expect(ingest.diagnostics.supersededResultsDiscarded).toBe(1);
    expect(ingest.diagnostics.packetsBuilt).toBe(1);
    ingest.destroy();
  });

  it("keeps the last good packet when a payload is refused", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    const good = ingest.latest();

    spyOn(console, "error");
    transport.enqueue(OVATION_URL, {
      "Observation Time": "2026-09-19T12:45:00Z",
    });
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS + 1000);

    expect(ingest.latest().oval === good.oval).toBe(true);
    expect(ingest.diagnostics.lastFailure.code).toBe(
      OvationRejectionCode.FORECAST_TIME,
    );
    expect(console.error).toHaveBeenCalled();
    ingest.destroy();
  });

  it("hands the oval to the index when the snapshot goes stale, and takes it back", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    const staleMs = OBSERVED_MS + 2 * MEASURED_LEAD_SECONDS * 1000 + 1;

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    const owned = ingest.latest();
    expect(owned.oval.authority).toBe("ovation");
    expect(owned.geomagnetic.activity).toBe(3 / 9);
    expect(validateSpaceWeatherPacket(owned).valid).toBe(true);
    // The published samples are the payload's integers, unscaled.
    expect(owned.oval.intensity[144 * OVATION_LONGITUDE_COUNT + 314]).toBe(16);
    expect(auroraOvalIntensityScale(owned)).toBe(1);

    spyOn(console, "error");
    transport.enqueue(OVATION_URL, Promise.reject(new Error("503")));
    transport.enqueue(KP_URL, kpRowsAt(staleMs, 6));
    await ingest.refreshOnce(staleMs);

    expect(ingest.diagnostics.ovalOwner).toBe("kp");
    expect(ingest.diagnostics.ownershipTransitions).toBe(2);
    const fallback = ingest.latest();
    expect(fallback.oval).toBeUndefined();
    expect(fallback.geomagnetic.kpIndex).toBe(6);
    expect(fallback.provenance.validitySeconds).toBe(
      PLANETARY_KP_CADENCE_SECONDS,
    );
    expect(validateSpaceWeatherPacket(fallback).valid).toBe(true);

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    expect(ingest.diagnostics.ovalOwner).toBe("ovation");
    expect(ingest.diagnostics.ownershipTransitions).toBe(3);
    ingest.destroy();
  });

  it("releases the ownership decision on destroy, not only the packet", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    expect(ingest.latestOwnership().owner).toBe("ovation");
    expect(ingest.diagnostics.ovalOwner).toBe("ovation");

    ingest.destroy();

    expect(ingest.latest()).toBeUndefined();
    expect(ingest.latestOwnership()).toBeUndefined();
    expect(ingest.diagnostics.ovalOwner).toBe("none");
  });

  it("disarms its timer on destroy and refuses to restart", async function () {
    const transport = scriptedTransport();
    const armed = [];
    const cleared = [];
    const ingest = new SpaceWeatherFeedIngest({
      fetchJson: transport.fetchJson,
      ovationUrl: OVATION_URL,
      planetaryKpUrl: KP_URL,
      setTimeoutFunction: function (handler, timeoutMs) {
        armed.push(timeoutMs);
        return armed.length;
      },
      clearTimeoutFunction: function (handle) {
        cleared.push(handle);
      },
    });

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.start(OBSERVED_MS);
    expect(armed.length).toBe(1);
    expect(armed[0]).toBe(60000);

    ingest.destroy();
    expect(cleared.length).toBe(1);
    expect(ingest.isRunning).toBe(false);
    expect(ingest.latest()).toBeUndefined();

    const callsAfterDestroy = transport.calls.length;
    await ingest.start(OBSERVED_MS);
    await ingest.refreshOnce(OBSERVED_MS);
    expect(transport.calls.length).toBe(callsAfterDestroy);
    expect(armed.length).toBe(1);
  });

  // The ten specs below are the browser twin of the Node suite's lifecycle and
  // clock section: the abort that pairs with the reissue, the timer's identity,
  // a transport that fails before it returns, the instant a tick happens at, and
  // the ways a published state can move backwards.

  it("aborts the signal of a cycle a stop, a destroy or a reissue abandons", async function () {
    const transport = scriptedTransport();
    const reissue = makeIngest(transport);
    const heldOvation = deferred();
    transport.enqueue(OVATION_URL, heldOvation.promise);
    transport.enqueue(KP_URL, deferred().promise);
    reissue.refreshOnce(OBSERVED_MS);
    const firstCycle = transport.calls.slice(0, 2);
    expect(
      firstCycle.map(function (call) {
        return call.signal.aborted;
      }),
    ).toEqual([false, false]);

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await reissue.refreshOnce(OBSERVED_MS + 1000);
    expect(
      firstCycle.map(function (call) {
        return call.signal.aborted;
      }),
    ).toEqual([true, true]);
    heldOvation.resolve(ovationFixture);
    reissue.destroy();

    const stopTransport = scriptedTransport();
    const onStop = makeIngest(stopTransport);
    stopTransport.enqueue(OVATION_URL, deferred().promise);
    stopTransport.enqueue(KP_URL, deferred().promise);
    onStop.refreshOnce(OBSERVED_MS);
    onStop.stop();
    expect(
      stopTransport.calls.map(function (call) {
        return call.signal.aborted;
      }),
    ).toEqual([true, true]);
    onStop.destroy();

    const destroyTransport = scriptedTransport();
    const onDestroy = makeIngest(destroyTransport);
    destroyTransport.enqueue(OVATION_URL, deferred().promise);
    destroyTransport.enqueue(KP_URL, deferred().promise);
    onDestroy.refreshOnce(OBSERVED_MS);
    onDestroy.destroy();
    expect(
      destroyTransport.calls.map(function (call) {
        return call.signal.aborted;
      }),
    ).toEqual([true, true]);
  });

  it("leaves one timer when started twice, and stops when stopped", async function () {
    const transport = scriptedTransport();
    const armed = new Map();
    const cleared = new Set();
    const fired = new Set();
    let nextHandle = 1;
    const ingest = makeIngest(transport, {
      setTimeoutFunction: function (handler) {
        const handle = nextHandle++;
        armed.set(handle, handler);
        return handle;
      },
      clearTimeoutFunction: function (handle) {
        cleared.add(handle);
      },
    });
    const liveHandles = function () {
      return [...armed.keys()].filter(function (handle) {
        return !cleared.has(handle) && !fired.has(handle);
      });
    };

    for (let start = 0; start < 2; ++start) {
      transport.enqueue(OVATION_URL, ovationFixture);
      transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
      await ingest.start(OBSERVED_MS);
    }
    expect(liveHandles().length).toBe(1);

    const callsAtStop = transport.calls.length;
    ingest.stop();
    expect(ingest.isRunning).toBe(false);
    expect(liveHandles()).toEqual([]);

    // An orphaned handle re-arms itself, so it would issue requests here. The
    // chain is bounded so a leak fails an expectation rather than hanging karma.
    for (let chain = 0; chain < 5 && liveHandles().length > 0; ++chain) {
      const handle = liveHandles()[0];
      fired.add(handle);
      armed.get(handle)();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(transport.calls.length).toBe(callsAtStop);
    expect(ingest.isRunning).toBe(false);
    ingest.destroy();
  });

  it("refuses a transport that throws where it stands rather than raising it", async function () {
    const ingest = makeIngest(scriptedTransport(), {
      fetchJson: function () {
        throw new TypeError("options.url is required, actual value was 7");
      },
    });

    spyOn(console, "error");
    let raised;
    await ingest.refreshOnce(OBSERVED_MS).catch(function (error) {
      raised = error;
    });

    expect(raised).toBeUndefined();
    expect(ingest.diagnostics.payloadsRefused).toBe(2);
    expect(ingest.diagnostics.lastFailure.code).toBe("transport");
    expect(ingest.diagnostics.lastFailure.message).toMatch(/options\.url/);
    expect(console.error.calls.count()).toBe(1);
    expect(ingest.latest()).toBeUndefined();
    ingest.destroy();
  });

  it("reads the instant a poll tick happened at, so a suspended host hands off", async function () {
    const transport = scriptedTransport();
    let tick;
    let wallMs = OBSERVED_MS;
    const ingest = makeIngest(transport, {
      setTimeoutFunction: function (handler) {
        tick = handler;
        return 1;
      },
      nowFunction: function () {
        return wallMs;
      },
    });

    const answer = function () {
      transport.enqueue(OVATION_URL, ovationFixture);
      transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    };
    answer();
    await ingest.start(OBSERVED_MS);
    expect(ingest.diagnostics.ovalOwner).toBe("ovation");

    // The 60 s timer fires three times across 135 minutes of real time; the
    // snapshot never changes, so only the wall clock moves.
    const observed = [];
    const minutes = [45, 90, 135];
    for (let i = 0; i < minutes.length; ++i) {
      wallMs = OBSERVED_MS + minutes[i] * 60000;
      answer();
      tick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      observed.push([
        minutes[i],
        ingest.diagnostics.ovalOwner,
        ingest.latestOwnership().ovationFreshness,
      ]);
    }

    expect(observed).toEqual([
      [45, "ovation", "fresh"],
      [90, "ovation", "aging"],
      [135, "kp", "stale"],
    ]);
    expect(ingest.diagnostics.ownershipTransitions).toBe(2);
    expect(ingest.latestOwnership().reason).toBe("ovation-stale");
    ingest.destroy();
  });

  it("refuses a response carrying an older snapshot than the one it holds", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    const held = ingest.latest();

    spyOn(console, "error");
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        observationTime: "2026-09-19T11:40:00Z",
        forecastTime: "2026-09-19T12:42:00Z",
        sample: function () {
          return 9;
        },
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS + 60000);

    expect(ingest.latest().oval).toBe(held.oval);
    expect(ingest.latest().observedTimeMs).toBe(OBSERVED_MS);
    expect(ingest.diagnostics.lastFailure.product).toBe("ovation");
    expect(ingest.diagnostics.lastFailure.code).toBe("time-regression");
    expect(ingest.diagnostics.payloadsRefused).toBe(1);
    expect(ingest.diagnostics.supersededResultsDiscarded).toBe(0);

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS - 6 * 3600 * 1000, 8));
    await ingest.refreshOnce(OBSERVED_MS + 120000);
    expect(ingest.diagnostics.lastFailure.product).toBe("kp");
    expect(ingest.diagnostics.lastFailure.code).toBe("time-regression");
    expect(ingest.latest().geomagnetic.kpIndex).toBe(3);
    ingest.destroy();
  });

  it("abandons the cycle in flight when stopped rather than letting it publish", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    const held = ingest.latest();

    const inFlight = deferred();
    transport.enqueue(OVATION_URL, inFlight.promise);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    const cycle = ingest.refreshOnce(OBSERVED_MS + 1000);

    spyOn(console, "error");
    ingest.stop();
    inFlight.resolve(
      syntheticOvationPayload({
        observationTime: "2026-09-19T14:00:00Z",
        forecastTime: "2026-09-19T15:00:00Z",
        sample: function () {
          return 9;
        },
      }),
    );
    await cycle;

    expect(ingest.latest()).toBe(held);
    expect(ingest.diagnostics.packetsBuilt).toBe(1);
    expect(ingest.diagnostics.supersededResultsDiscarded).toBe(1);
    expect(ingest.diagnostics.payloadsRefused).toBe(0);
    expect(ingest.diagnostics.lastFailure).toBeUndefined();
    expect(console.error).not.toHaveBeenCalled();
    ingest.destroy();
  });

  it("refuses a snapshot whose packet fails the schema and hands the oval to the index", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);

    // Number.isInteger accepts 1e308 and the grid then stores Infinity, which
    // the packet schema refuses.
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        sample: function (longitude, latitude) {
          return longitude === 12 && latitude === 30 ? 1e308 : 1;
        },
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));

    spyOn(console, "error");
    await ingest.refreshOnce(OBSERVED_MS);

    expect(ingest.diagnostics.lastFailure.product).toBe("ovation");
    expect(ingest.diagnostics.lastFailure.code).toBe("invalid-packet");
    expect(ingest.diagnostics.lastFailure.message).toMatch(
      /oval\.intensity\[\d+\]: must be a finite number/,
    );

    const published = ingest.latest();
    expect(ingest.diagnostics.ovalOwner).toBe("kp");
    expect(ingest.latestOwnership().reason).toBe("ovation-absent");
    expect(published.oval).toBeUndefined();
    expect(published.provenance.sourceId).toBe("noaa-planetary-kp");
    expect(validateSpaceWeatherPacket(published).valid).toBe(true);
    expect(ingest.diagnostics.packetsBuilt).toBe(1);
    ingest.destroy();
  });

  it("refuses a negative aurora sample", function () {
    let smallest = Infinity;
    for (let i = 0; i < ovationFixture.coordinates.length; ++i) {
      const sample = ovationFixture.coordinates[i][2];
      if (sample < smallest) {
        smallest = sample;
      }
    }
    expect(smallest).toBe(0);

    const result = normalizeOvationPayload(
      syntheticOvationPayload({
        sample: function (longitude, latitude) {
          return longitude === 200 && latitude === -65 ? -7 : 4;
        },
      }),
    );
    expect(result.status).toBe("refused");
    expect(result.error.code).toBe(OvationRejectionCode.NEGATIVE_SAMPLE);
    expect(result.error.message).toMatch(/must not be negative, received -7/);
  });

  it("resolves a disagreeing north pole by the same policy as the south", function () {
    // The capture disagrees at the south pole and is uniform at the north, so
    // this grid varies the north duplicates: 120 each of 0, 1 and 2.
    const payload = syntheticOvationPayload({
      sample: function (longitude, latitude) {
        return latitude === 90 ? longitude % 3 : 0;
      },
    });

    const cases = [
      [OvationPolePolicy.MEAN, 1],
      [OvationPolePolicy.MAXIMUM, 2],
      [OvationPolePolicy.MINIMUM, 0],
    ];
    for (let i = 0; i < cases.length; ++i) {
      const result = normalizeOvationPayload(payload, {
        polePolicy: cases[i][0],
      });
      expect(result.status).toBe("ok");
      for (let column = 0; column < OVATION_LONGITUDE_COUNT; ++column) {
        expect(gridSample(result.snapshot.field, 0, column)).toBe(cases[i][1]);
      }
      expect(result.snapshot.northPoleAgreed).toBe(false);
      expect(result.snapshot.southPoleAgreed).toBe(true);
    }

    const refused = normalizeOvationPayload(payload, {
      polePolicy: OvationPolePolicy.REQUIRE_AGREEMENT,
    });
    expect(refused.status).toBe("refused");
    expect(refused.error.code).toBe(OvationRejectionCode.POLE_DISAGREEMENT);
    expect(refused.error.message).toMatch(/north/);
  });

  it("publishes the ownership decision beside the packet, including when nobody owns", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    expect(ingest.latestOwnership()).toBeUndefined();

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    const owned = ingest.latestOwnership();
    expect(owned.owner).toBe("ovation");
    expect(owned.reason).toBe("ovation-current");
    expect(Object.isFrozen(owned)).toBe(true);

    // Both sources are past their own horizons, so nobody owns the oval, yet the
    // last good packet deliberately stays and a consumer is still handed a grid.
    const disownedMs = OBSERVED_MS + 10 * 3600 * 1000;
    spyOn(console, "error");
    transport.enqueue(OVATION_URL, undefined);
    transport.enqueue(KP_URL, undefined);
    await ingest.refreshOnce(disownedMs);

    const disowned = ingest.latestOwnership();
    expect(disowned.owner).toBe("none");
    expect(disowned.previousOwner).toBe("ovation");
    expect(disowned.reason).toBe("ovation-stale");
    expect(disowned.ovationFreshness).toBe("stale");
    expect(disowned.kpVisible).toBe(false);
    expect(ingest.latest().oval.authority).toBe("ovation");
    expect(ingest.diagnostics.packetsBuilt).toBe(1);
    ingest.destroy();
  });

  it("refuses a payload stamped ahead of the clock and takes the next real one", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    spyOn(console, "error");

    // A publisher clock in the wrong year, which is what a time tag typo looks
    // like from here: the grid is complete and every sample is a valid integer,
    // so the instant is the only thing wrong with it.
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        observationTime: "2027-09-19T12:40:00Z",
        forecastTime: "2027-09-19T13:42:00Z",
        sample: function () {
          return 9;
        },
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);

    expect(ingest.diagnostics.lastFailure.product).toBe("ovation");
    expect(ingest.diagnostics.lastFailure.code).toBe("implausible-time");
    expect(ingest.diagnostics.ovalOwner).toBe("kp");
    expect(ingest.latest().oval).toBeUndefined();

    // A rule that let the year-ahead instant stand would make every real
    // snapshot after it "older", and refuse them all for ever.
    for (let cycle = 1; cycle <= 3; ++cycle) {
      transport.enqueue(OVATION_URL, ovationFixture);
      transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
      await ingest.refreshOnce(OBSERVED_MS + cycle * 1000);
    }
    expect(ingest.latest().oval.authority).toBe("ovation");
    expect(ingest.latest().observedTimeMs).toBe(OBSERVED_MS);
    expect(ingest.diagnostics.payloadsRefused).toBe(1);

    // The index product, stamped the same way.
    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(Date.parse("2027-09-19T12:00:00Z"), 8));
    await ingest.refreshOnce(OBSERVED_MS + 180000);
    expect(ingest.diagnostics.lastFailure.product).toBe("kp");
    expect(ingest.diagnostics.lastFailure.code).toBe("implausible-time");
    expect(ingest.latest().geomagnetic.kpIndex).toBe(3);

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS + 240000, 7));
    await ingest.refreshOnce(OBSERVED_MS + 300000);
    expect(ingest.latest().geomagnetic.kpIndex).toBe(7);
    expect(console.error.calls.count()).toBe(2);
    ingest.destroy();
  });

  it("does not credit an observation instant ahead of the clock, and names it apart from a stale one", async function () {
    const snapshot = {
      observedTimeMs: OBSERVED_MS,
      forecastTimeMs: FORECAST_MS,
    };
    const toleranceMs = SPACE_WEATHER_CLOCK_SKEW_TOLERANCE_SECONDS * 1000;

    // Inside the tolerance the disagreement is ordinary skew.
    const skewedMs = OBSERVED_MS - toleranceMs;
    expect(spaceWeatherObservationIsPlausible(OBSERVED_MS, skewedMs)).toBe(
      true,
    );
    expect(ovationFreshness(snapshot, skewedMs)).toBe("fresh");

    // One second past it, the instant cannot be one anything was observed at.
    const impossibleMs = skewedMs - 1000;
    expect(spaceWeatherObservationIsPlausible(OBSERVED_MS, impossibleMs)).toBe(
      false,
    );
    expect(ovationFreshness(snapshot, impossibleMs)).toBe("stale");

    // The forecast instant leads the clock in every one of these cases and is
    // never what is bounded: it is the lead itself.
    expect(FORECAST_MS).toBeGreaterThan(OBSERVED_MS);
    expect(ovationFreshness(snapshot, OBSERVED_MS)).toBe("fresh");

    const impossible = resolveOvalOwnership({
      previousOwner: SpaceWeatherOvalOwner.OVATION,
      ovation: snapshot,
      kpAvailable: true,
      nowMs: impossibleMs,
    });
    expect(impossible.owner).toBe("kp");
    expect(impossible.reason).toBe(
      SpaceWeatherOwnershipReason.OVATION_AHEAD_OF_CLOCK,
    );
    expect(impossible.ovationFreshness).toBe("stale");

    const old = resolveOvalOwnership({
      previousOwner: SpaceWeatherOvalOwner.OVATION,
      ovation: snapshot,
      kpAvailable: true,
      nowMs: OBSERVED_MS + 3 * MEASURED_LEAD_SECONDS * 1000,
    });
    expect(old.reason).toBe(SpaceWeatherOwnershipReason.OVATION_STALE);

    // ...and through the ingest, for state accepted while the clock agreed and
    // still held when the clock is corrected backwards: both products stop being
    // credited rather than reading current for ever off a negative age.
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    expect(ingest.latestOwnership().reason).toBe("ovation-current");

    const correctedMs = OBSERVED_MS - 2 * 3600 * 1000;
    spyOn(console, "error");
    // The product does not answer this cycle, so the held snapshot is all there
    // is to judge, and the index answers with the bins that exist on the
    // corrected clock -- every one of them older than the bin being held.
    transport.enqueue(OVATION_URL, undefined);
    transport.enqueue(KP_URL, kpRowsAt(correctedMs - 3600 * 1000, 5));
    await ingest.refreshOnce(correctedMs);

    const decided = ingest.latestOwnership();
    expect(decided.owner).toBe("kp");
    expect(decided.reason).toBe("ovation-ahead-of-clock");
    expect(decided.ovationFreshness).toBe("stale");
    expect(ingest.latest()).toBeDefined();
    expect(ingest.latest().geomagnetic.kpIndex).toBe(5);

    // A held instant that cannot be real must not outrank the instants that can,
    // so the next snapshot replaces it even though it is the older of the two.
    // This is the whole of the recovery: nothing waits for destroy().
    const recoveredMs = correctedMs - 600000;
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        observationTime: new Date(recoveredMs).toISOString(),
        forecastTime: new Date(
          recoveredMs + MEASURED_LEAD_SECONDS * 1000,
        ).toISOString(),
        sample: function () {
          return 5;
        },
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(correctedMs - 3600 * 1000, 5));
    await ingest.refreshOnce(correctedMs + 1000);

    expect(ingest.latest().observedTimeMs).toBe(recoveredMs);
    expect(ingest.latestOwnership().owner).toBe("ovation");
    expect(ingest.latestOwnership().reason).toBe("ovation-current");
    expect(ingest.diagnostics.lastFailure.code).toBe("transport");
    ingest.destroy();
  });

  it("stops when the stop is raised inside the tick's own cycle, and stays stopped for a late callback", async function () {
    const armed = new Map();
    const cleared = new Set();
    let nextHandle = 1;
    let calls = 0;
    let stopOnNextCall = false;
    // Declared before the transport closes over it; the closure only runs from
    // start(), by which point the binding is initialized.
    const ingest = makeIngest(scriptedTransport(), {
      fetchJson: function (url) {
        ++calls;
        // The transport is called synchronously from the tick, so anything it
        // does to the ingest happens while that tick is still between clearing
        // its handle and arming the next one.
        if (stopOnNextCall) {
          stopOnNextCall = false;
          ingest.stop();
        }
        return Promise.resolve(
          url === OVATION_URL ? ovationFixture : kpRowsAt(OBSERVED_MS, 3),
        );
      },
      setTimeoutFunction: function (handler) {
        const handle = nextHandle++;
        armed.set(handle, handler);
        return handle;
      },
      clearTimeoutFunction: function (handle) {
        cleared.add(handle);
      },
    });

    await ingest.start(OBSERVED_MS);
    stopOnNextCall = true;
    armed.get(1)();
    for (let turn = 0; turn < 6; ++turn) {
      await Promise.resolve();
    }

    expect(ingest.isRunning).toBe(false);
    const liveAfterStop = Array.from(armed.keys()).filter(function (handle) {
      return handle !== 1 && !cleared.has(handle);
    });
    expect(liveAfterStop).toEqual([]);

    // The second door: a host delivering a callback whose handle was cleared.
    const callsAfterStop = calls;
    armed.get(1)();
    for (let turn = 0; turn < 6; ++turn) {
      await Promise.resolve();
    }
    expect(calls).toBe(callsAfterStop);
    expect(ingest.isRunning).toBe(false);

    // A manual refresh is not a restart, and does not re-arm.
    await ingest.refreshOnce(OBSERVED_MS + 60000);
    expect(calls).toBeGreaterThan(callsAfterStop);
    expect(ingest.isRunning).toBe(false);
    ingest.destroy();
  });

  it("refuses a rejection reason that cannot describe itself like any other", async function () {
    const shapes = [
      [
        "a reason with no prototype",
        function () {
          return Object.create(null);
        },
      ],
      [
        "a reason whose toString throws",
        function () {
          return {
            toString: function () {
              throw new Error("this reason refuses to be read");
            },
          };
        },
      ],
    ];

    // One spy for the whole case: Jasmine refuses a second spy on a method it
    // is already watching, so the counter is reset between shapes instead.
    const consoleError = spyOn(console, "error");

    for (const shape of shapes) {
      const label = shape[0];
      const makeReason = shape[1];
      let tick;
      const ingest = makeIngest(scriptedTransport(), {
        fetchJson: function () {
          return Promise.reject(makeReason());
        },
        setTimeoutFunction: function (handler) {
          tick = handler;
          return 1;
        },
        // Both cycles land inside one throttle window, so the single diagnostic
        // asserted below is the throttle behaving and not the clock drifting.
        nowFunction: function () {
          return OBSERVED_MS;
        },
      });
      const unhandled = [];
      const onUnhandled = function (event) {
        unhandled.push(event.reason);
      };
      window.addEventListener("unhandledrejection", onUnhandled);
      consoleError.calls.reset();
      let raised;
      try {
        await ingest.start(OBSERVED_MS).catch(function (error) {
          raised = error;
        });
        // And through the poll tick, which discards the promise it starts, so a
        // throw two frames inside the cycle has no caller left to reach.
        tick();
        for (let turn = 0; turn < 8; ++turn) {
          await Promise.resolve();
        }
        await new Promise(function (resolve) {
          setTimeout(resolve, 10);
        });
      } finally {
        window.removeEventListener("unhandledrejection", onUnhandled);
      }

      expect(raised).withContext(label).toBeUndefined();
      expect(unhandled).withContext(label).toEqual([]);
      expect(ingest.diagnostics.payloadsRefused).withContext(label).toBe(4);
      expect(ingest.diagnostics.lastFailure.code).toBe("transport");
      expect(typeof ingest.diagnostics.lastFailure.message).toBe("string");
      expect(consoleError.calls.count()).withContext(label).toBe(1);
      expect(ingest.latest()).toBeUndefined();
      ingest.destroy();
    }
  });

  it("leaves a successor armed on every poll tick, so the chain continues", async function () {
    const transport = scriptedTransport();
    const armed = [];
    const cleared = new Set();
    const fired = new Set();
    let nextHandle = 1;
    const ingest = makeIngest(transport, {
      setTimeoutFunction: function (handler) {
        const handle = nextHandle++;
        armed.push({ handle: handle, handler: handler });
        return handle;
      },
      clearTimeoutFunction: function (handle) {
        cleared.add(handle);
      },
    });
    const live = function () {
      return armed.filter(function (entry) {
        return !cleared.has(entry.handle) && !fired.has(entry.handle);
      });
    };

    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.start(OBSERVED_MS);
    expect(armed.length).toBe(1);

    // Fire only what is currently armed, which is how a timer behaves and is the
    // only way to observe whether a tick produced a successor. Re-using one
    // captured handler cannot: it reports what a tick reads, never whether ticks
    // go on arriving.
    for (let round = 1; round <= 3; ++round) {
      const pending = live();
      expect(pending.length)
        .withContext(`the poll chain stopped after tick ${round - 1}`)
        .toBe(1);
      transport.enqueue(OVATION_URL, ovationFixture);
      transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
      fired.add(pending[0].handle);
      pending[0].handler();
      for (let turn = 0; turn < 6; ++turn) {
        await Promise.resolve();
      }
      expect(armed.length).toBe(round + 1);
      expect(ingest.diagnostics.requestsIssued).toBe(round + 1);
    }

    expect(ingest.isRunning).toBe(true);
    expect(live().length).toBe(1);
    ingest.destroy();
  });

  it("goes on reporting a refused feed across cycles, and a clock step cannot silence it", async function () {
    const ingest = makeIngest(scriptedTransport(), {
      fetchJson: function () {
        return Promise.reject(new Error("the product is unreachable"));
      },
    });
    const consoleError = spyOn(console, "error");

    await ingest.refreshOnce(OBSERVED_MS);
    expect(consoleError.calls.count()).toBe(1);

    // Inside the window the feed is refused and not reported again.
    await ingest.refreshOnce(OBSERVED_MS + 30000);
    expect(consoleError.calls.count()).toBe(1);

    // At the window the throttle opens again. The poll interval and the throttle
    // interval are the same 60 s, so a broken feed that only reported strictly
    // past the window would report exactly once and then never.
    await ingest.refreshOnce(OBSERVED_MS + 60000);
    expect(consoleError.calls.count()).toBe(2);
    await ingest.refreshOnce(OBSERVED_MS + 120000);
    expect(consoleError.calls.count()).toBe(3);

    // A clock correction steps the instant a day forward and then back. The
    // stamp is an instant on that clock, so an unbounded throttle would sit a
    // day in the future and silence the feed for a day.
    await ingest.refreshOnce(OBSERVED_MS + 24 * 3600 * 1000);
    expect(consoleError.calls.count()).toBe(4);
    await ingest.refreshOnce(OBSERVED_MS + 180000);
    expect(consoleError.calls.count()).toBe(5);
    await ingest.refreshOnce(OBSERVED_MS + 240000);
    expect(consoleError.calls.count()).toBe(6);

    expect(ingest.diagnostics.payloadsRefused).toBe(14);
    ingest.destroy();
  });

  it("applies a revision at the same observation instant, on both products", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        sample: function () {
          return 2;
        },
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);
    expect(gridSample(ingest.latest().oval, 90, 0)).toBe(2);
    expect(ingest.latest().geomagnetic.kpIndex).toBe(3);

    // Both products revise a value in place rather than only appending: the
    // observed index capture carries a station_count that differs between bins
    // (7 for sixteen of its sixty rows, 8 for the rest), so a bin's value is one
    // the product firms up as stations report. The refusal is about instants
    // moving backwards, and an instant that repeats has not moved.
    transport.enqueue(
      OVATION_URL,
      syntheticOvationPayload({
        sample: function () {
          return 7;
        },
      }),
    );
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 8));
    await ingest.refreshOnce(OBSERVED_MS + 60000);

    expect(gridSample(ingest.latest().oval, 90, 0)).toBe(7);
    expect(ingest.latest().geomagnetic.kpIndex).toBe(8);
    expect(ingest.latest().observedTimeMs).toBe(OBSERVED_MS);
    expect(ingest.diagnostics.payloadsRefused).toBe(0);
    expect(ingest.diagnostics.packetsBuilt).toBe(2);
    ingest.destroy();
  });

  it("carries the pole policy it was constructed with into the grid it publishes", async function () {
    // The capture's south pole disagrees with itself, so the policy the caller
    // chose is readable in the sample the ingest publishes -- and
    // require-agreement refuses this capture outright, which is the evidence
    // that the option is carried rather than defaulted.
    spyOn(console, "error");

    async function byPolicy(policy) {
      const transport = scriptedTransport();
      const ingest = makeIngest(transport, { polePolicy: policy });
      transport.enqueue(OVATION_URL, ovationFixture);
      transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
      await ingest.start(OBSERVED_MS);
      const published = ingest.latest();
      const read = {
        owner: ingest.diagnostics.ovalOwner,
        code:
          ingest.diagnostics.lastFailure === undefined
            ? undefined
            : ingest.diagnostics.lastFailure.code,
        sample:
          published.oval === undefined
            ? undefined
            : gridSample(published.oval, 180, 0),
      };
      ingest.destroy();
      return read;
    }

    expect((await byPolicy(OvationPolePolicy.MAXIMUM)).sample).toBe(5);
    expect((await byPolicy(OvationPolePolicy.MINIMUM)).sample).toBe(0);
    expect((await byPolicy(OvationPolePolicy.MEAN)).sample).toBe(
      Math.fround(1418 / 360),
    );
    expect((await byPolicy(undefined)).sample).toBe(Math.fround(1418 / 360));

    const required = await byPolicy(OvationPolePolicy.REQUIRE_AGREEMENT);
    expect(required.owner).toBe("kp");
    expect(required.code).toBe(OvationRejectionCode.POLE_DISAGREEMENT);
    expect(required.sample).toBeUndefined();

    // A capture refused over its poles is a refused payload like any other, so
    // it reaches the console once and only the refusing policy produces one.
    expect(console.error.calls.count()).toBe(1);
    expect(console.error.calls.argsFor(0)[0]).toContain(
      OvationRejectionCode.POLE_DISAGREEMENT,
    );
  });

  it("publishes the provenance the snapshot declares, not a constant", async function () {
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    transport.enqueue(OVATION_URL, ovationFixture);
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.start(OBSERVED_MS);

    const published = ingest.latest();
    expect(published.provenance.sourceId).toBe("ovation");
    expect(published.provenance.kind).toBe("forecast");
    expect(published.observedTimeMs).toBe(OBSERVED_MS);
    expect(published.forecastTimeMs).toBe(FORECAST_MS);
    expect(spaceWeatherForecastLeadSeconds(published)).toBe(
      MEASURED_LEAD_SECONDS,
    );
    // The horizon every downstream freshness read measures against is the lead
    // this payload declared -- not the floor, and not a constant named after
    // the product.
    expect(published.provenance.validitySeconds).toBe(MEASURED_LEAD_SECONDS);
    expect(MEASURED_LEAD_SECONDS).not.toBe(OVATION_VALIDITY_FLOOR_SECONDS);
    ingest.destroy();
  });

  it("credits a declared horizon between the two bounds and reports a bounded one", async function () {
    // The rule first, as arithmetic: a snapshot that declares no lead would
    // expire on arrival, one that declares an impossible lead would never
    // expire, and the capture's own measured lead is between the two and
    // untouched.
    expect(
      ovationValiditySeconds({
        observedTimeMs: OBSERVED_MS,
        forecastTimeMs: FORECAST_MS,
      }),
    ).toBe(MEASURED_LEAD_SECONDS);
    expect(
      ovationValiditySeconds({
        observedTimeMs: OBSERVED_MS,
        forecastTimeMs: OBSERVED_MS,
      }),
    ).toBe(OVATION_VALIDITY_FLOOR_SECONDS);
    expect(MEASURED_LEAD_SECONDS).toBeLessThan(
      OVATION_VALIDITY_CEILING_SECONDS,
    );

    // A year typo in Forecast Time: the lead reads 31,539,720 s, which is the
    // number that would otherwise say how long to keep believing the
    // observation.
    const TYPO_LEAD_SECONDS = 31539720;
    spyOn(console, "error");
    const transport = scriptedTransport();
    const ingest = makeIngest(transport);
    function typedPayload() {
      return syntheticOvationPayload({
        sample: function () {
          return 4;
        },
        forecastTime: "2027-09-19T13:42:00Z",
      });
    }

    transport.enqueue(OVATION_URL, typedPayload());
    transport.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.refreshOnce(OBSERVED_MS);

    // The capture is kept and published whole -- a wrong forecast instant says
    // nothing about the grid beside it, and both instants are published as they
    // were declared. What is bounded is how long the observation is believed.
    const published = ingest.latest();
    expect(ingest.diagnostics.payloadsRefused).toBe(0);
    expect(ingest.diagnostics.ovalOwner).toBe("ovation");
    expect(gridSample(published.oval, 90, 0)).toBe(4);
    expect(published.forecastTimeMs).toBe(Date.parse("2027-09-19T13:42:00Z"));
    expect(spaceWeatherForecastLeadSeconds(published)).toBe(TYPO_LEAD_SECONDS);
    expect(ingest.diagnostics.ovationLeadSeconds).toBe(TYPO_LEAD_SECONDS);
    expect(ingest.diagnostics.ovationHorizonSeconds).toBe(
      OVATION_VALIDITY_CEILING_SECONDS,
    );
    expect(published.provenance.validitySeconds).toBe(
      OVATION_VALIDITY_CEILING_SECONDS,
    );

    // And it expires on the bounded horizon rather than a year on: twice the
    // ceiling past the observation, the model no longer owns the oval.
    const expiredMs =
      OBSERVED_MS + 2 * OVATION_VALIDITY_CEILING_SECONDS * 1000 + 1;
    transport.enqueue(OVATION_URL, typedPayload());
    transport.enqueue(KP_URL, kpRowsAt(expiredMs, 3));
    await ingest.refreshOnce(expiredMs);

    expect(ingest.diagnostics.ovalOwner).toBe("kp");
    expect(ingest.latestOwnership().reason).toBe("ovation-stale");
    expect(ingest.latestOwnership().ovationFreshness).toBe("stale");
    expect(ingest.latest().oval).toBeUndefined();

    // Once per cycle that declares it, at the refusal log's rate: the operator
    // is told which number was declared and which one is credited instead.
    expect(console.error.calls.count()).toBe(2);
    expect(console.error.calls.argsFor(0)[0]).toContain(
      `${TYPO_LEAD_SECONDS} s forecast lead`,
    );
    expect(console.error.calls.argsFor(0)[0]).toContain(
      `${OVATION_VALIDITY_CEILING_SECONDS} s`,
    );
    ingest.destroy();
  });

  it("cannot have its published decision frozen by a transport that never settles", async function () {
    // One good cycle, then a transport that ignores its abort signal and never
    // answers. Nothing completes again, so every statement the ingest makes
    // about its own freshness from here on comes from the clock alone.
    const scripted = scriptedTransport();
    let settles = true;
    let hungRequests = 0;
    let tick;
    let wallMs = OBSERVED_MS;
    const ingest = makeIngest(scripted, {
      fetchJson: function (url, signal) {
        if (settles) {
          return scripted.fetchJson(url, signal);
        }
        ++hungRequests;
        return new Promise(function () {});
      },
      setTimeoutFunction: function (handler) {
        tick = handler;
        return 1;
      },
      nowFunction: function () {
        return wallMs;
      },
    });

    scripted.enqueue(OVATION_URL, ovationFixture);
    scripted.enqueue(KP_URL, kpRowsAt(OBSERVED_MS, 3));
    await ingest.start(OBSERVED_MS);
    expect(ingest.diagnostics.ovalOwner).toBe("ovation");
    expect(ingest.diagnostics.payloadsParsed).toBe(2);
    settles = false;

    // 62 minutes of declared horizon, stale past twice it, and the index bin
    // stops being current past twice its own three-hour cadence -- so the three
    // readings below are the three states a month of silence passes through,
    // every one of them reached without a single response.
    const seen = [];
    for (const minutes of [60, 130, 400]) {
      wallMs = OBSERVED_MS + minutes * 60000;
      tick();
      for (let turn = 0; turn < 6; ++turn) {
        await Promise.resolve();
      }
      const ownership = ingest.latestOwnership();
      seen.push([
        minutes,
        ingest.diagnostics.ovalOwner,
        ownership.ovationFreshness,
        ownership.reason,
      ]);
    }

    expect(seen).toEqual([
      [60, "ovation", "fresh", "ovation-current"],
      [130, "kp", "stale", "ovation-stale"],
      [400, "none", "stale", "ovation-stale"],
    ]);
    expect(ingest.diagnostics.ownershipTransitions).toBe(3);
    // Nothing arrived: no payload was parsed after the first cycle, and every
    // request issued since is still outstanding.
    expect(ingest.diagnostics.payloadsParsed).toBe(2);
    expect(hungRequests).toBe(6);
    // The handoff republishes once, so the grid the model has disowned stops
    // being served; the dark state has nothing to publish and keeps the last
    // one.
    expect(ingest.diagnostics.packetsBuilt).toBe(2);
    expect(ingest.latest().oval).toBeUndefined();
    expect(ingest.latest().geomagnetic.kpIndex).toBe(3);
    // Nothing was stopped: it is still polling.
    expect(ingest.isRunning).toBe(true);
    ingest.destroy();
  });
});
