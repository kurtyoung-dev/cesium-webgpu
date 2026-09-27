import Resource from "../../Source/Core/Resource.js";
import {
  RealTimeSolarWindExclusion,
  RealTimeSolarWindRejectionCode,
  normalizeRealTimeSolarWindPayload,
} from "../../Source/Scene/SpaceWeather/RealTimeSolarWindNormalizer.js";
import {
  GoesXrayExclusion,
  GoesXrayRejectionCode,
  classifySolarXrayFlux,
  goesXrayPrimaryAt,
  normalizeGoesInstrumentSources,
  normalizeGoesXrayPayload,
} from "../../Source/Scene/SpaceWeather/GoesXrayNormalizer.js";
import { estimateSolarWindActivity } from "../../Source/Scene/SpaceWeather/SolarWindCouplingEstimate.js";
import {
  FlareOmission,
  SolarWindFlareEventType,
  SolarWindFlareFeedIngest,
  SolarWindFlareIngestCode,
} from "../../Source/Scene/SpaceWeather/SolarWindFlareFeedIngest.js";
import { SpaceWeatherFeedIngest } from "../../Source/Scene/SpaceWeather/SpaceWeatherFeedIngest.js";
import {
  auroraOvalIntensityScale,
  validateSpaceWeatherPacket,
} from "../../Source/Scene/SpaceWeather/SpaceWeatherPacket.js";

describe("Scene/SpaceWeather/SolarWindFlareFeedIngest", function () {
  // The assertions read values that came out of the modules against the
  // byte-frozen captures in Specs/Data/SpaceWeather, or against payloads derived
  // from them by a stated edit. The captures are pinned by SHA-256 in their
  // sidecar README, so a number below moving means either the normalization
  // changed or the fixture did.

  const NOW = Date.parse("2026-09-26T16:23:04Z");
  const MAG_NEWEST = Date.parse("2026-09-26T16:14:00Z");
  const WIND_NEWEST = Date.parse("2026-09-26T16:13:00Z");
  const XRAY_NEWEST = Date.parse("2026-09-26T16:17:00Z");
  const MINUTE = 60000;
  const RTSW_ACTIVITY = 1.8944571571040658 / 9;
  const URL_MAG = "test://mag";
  const URL_WIND = "test://wind";
  const URL_XRAY = "test://xray";
  const URL_SOURCES = "test://sources";

  let mag;
  let wind;
  let xrays;
  let sources;
  let ovation;

  beforeAll(async function () {
    const load = (name) =>
      Resource.fetchJson({ url: `Data/SpaceWeather/${name}` });
    mag = await load("rtsw_mag_1m.json");
    wind = await load("rtsw_wind_1m.json");
    xrays = await load("xrays-1-day.json");
    sources = await load("instrument-sources.json");
    ovation = await load("ovation_aurora_latest.json");
  });

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function utc(tag) {
    return Date.parse(/Z$/.test(tag) ? tag : `${tag}Z`);
  }

  function asServedAt(payload, instantMs) {
    return copy(payload).filter(function (row) {
      return utc(row.time_tag) <= instantMs;
    });
  }

  function feed(answers) {
    const calls = [];
    const current = Object.assign({}, answers);
    return {
      calls: calls,
      set: function (url, answer) {
        current[url] = answer;
      },
      fetchJson: function (url, signal) {
        calls.push({ url: url, signal: signal });
        const answer = current[url];
        if (answer === undefined) {
          return Promise.reject(new Error(`nothing served at ${url}`));
        }
        if (typeof answer === "function") {
          return answer();
        }
        return Promise.resolve(answer);
      },
    };
  }

  function capturedFeed() {
    const answers = {};
    answers[URL_MAG] = mag;
    answers[URL_WIND] = wind;
    answers[URL_XRAY] = xrays;
    answers[URL_SOURCES] = sources;
    return feed(answers);
  }

  function makeIngest(transport, overrides) {
    const timers = [];
    const ingest = new SolarWindFlareFeedIngest(
      Object.assign(
        {
          fetchJson: transport.fetchJson,
          magnetometerUrl: URL_MAG,
          plasmaUrl: URL_WIND,
          xrayUrl: URL_XRAY,
          instrumentSourcesUrl: URL_SOURCES,
          setTimeoutFunction: function (handler, delay) {
            timers.push({ handler: handler, delay: delay, cleared: false });
            return timers.length;
          },
          clearTimeoutFunction: function (handle) {
            timers[handle - 1].cleared = true;
          },
        },
        overrides,
      ),
    );
    return { ingest: ingest, timers: timers };
  }

  function fixedAuthority(packet, owner) {
    return {
      latest: function () {
        return packet;
      },
      latestOwnership: function () {
        return Object.freeze({
          owner: owner,
          reason: "ovation-current",
          previousOwner: owner,
          changed: false,
          kpVisible: false,
        });
      },
    };
  }

  async function realAuthority(kp) {
    const tag = function (ms) {
      return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "");
    };
    const kpAt = Date.parse("2026-09-26T15:00:00Z");
    const answers = {
      "test://ovation": Object.assign({}, ovation, {
        "Observation Time": "2026-09-26T16:10:00Z",
        "Forecast Time": "2026-09-26T17:12:00Z",
      }),
      "test://kp":
        kp === undefined
          ? []
          : [
              {
                time_tag: tag(kpAt - 10800000),
                Kp: kp,
                a_running: 5,
                station_count: 8,
              },
              { time_tag: tag(kpAt), Kp: kp, a_running: 5, station_count: 8 },
            ],
    };
    const authority = new SpaceWeatherFeedIngest({
      fetchJson: function (url) {
        return Promise.resolve(answers[url]);
      },
      ovationUrl: "test://ovation",
      planetaryKpUrl: "test://kp",
      setTimeoutFunction: function () {
        return 1;
      },
      clearTimeoutFunction: function () {},
    });
    spyOn(console, "error");
    await authority.refreshOnce(NOW);
    console.error.calls.reset();
    return authority;
  }

  it("normalizes the frozen magnetometer capture to the active source's minutes, fill-flagged rows included", function () {
    const series = normalizeRealTimeSolarWindPayload(
      mag,
      "magnetometer",
    ).series;
    expect(series.rowsRead).toBe(3860);
    expect(series.inactiveRows).toBe(2425);
    expect(series.readings.length).toBe(1435);
    expect(
      mag.filter(function (row) {
        return row.active === true && row.max_data_flag === -9999;
      }).length,
    ).toBe(1435);
    expect(series.newest.timeTagMs).toBe(MAG_NEWEST);
    expect(series.newest.bzGsmNanoTesla).toBe(2.82);
    expect(series.gaps).toEqual([]);
  });

  it("keeps the plasma capture's measured gaps, in ascending order whatever the wire order", function () {
    const series = normalizeRealTimeSolarWindPayload(wind, "plasma").series;
    expect(series.readings.length).toBe(1431);
    expect(series.gaps).toEqual([{ seconds: 120, count: 3 }]);
    expect(series.newest.timeTagMs).toBe(WIND_NEWEST);
    expect(utc(wind[0].time_tag)).toBeGreaterThan(
      utc(wind[wind.length - 1].time_tag),
    );
    const reversed = normalizeRealTimeSolarWindPayload(
      copy(wind).reverse(),
      "plasma",
    ).series;
    expect(reversed.readings).toEqual(series.readings);
  });

  it("excludes a measured fill by name and a range fault by range", function () {
    const filled = copy(mag);
    const index = filled.findIndex(function (row) {
      return row.active === true;
    });
    filled[index].bz_gsm = -9999;
    expect(
      normalizeRealTimeSolarWindPayload(filled, "magnetometer").series.excluded[
        RealTimeSolarWindExclusion.FILL_VALUE
      ],
    ).toBe(1);
    filled[index].bz_gsm = 250;
    const ranged = normalizeRealTimeSolarWindPayload(filled, "magnetometer")
      .series.excluded;
    expect(ranged[RealTimeSolarWindExclusion.OUT_OF_RANGE]).toBe(1);
    expect(ranged[RealTimeSolarWindExclusion.FILL_VALUE]).toBe(0);
  });

  it("refuses a payload with nothing usable", function () {
    const result = normalizeRealTimeSolarWindPayload(
      copy(mag).map(function (row) {
        return Object.assign({}, row, { active: false });
      }),
      "magnetometer",
    );
    expect(result.status).toBe("refused");
    expect(result.error.code).toBe(
      RealTimeSolarWindRejectionCode.NO_USABLE_ROWS,
    );
  });

  it("splits the X-ray capture into bands and reports its dropouts", function () {
    const series = normalizeGoesXrayPayload(xrays, 18).series;
    expect(series.longBand.length).toBe(1352);
    expect(series.shortBand.length).toBe(1352);
    expect(series.excluded[GoesXrayExclusion.DROPOUT]).toBe(172);
    expect(
      series.dropouts.map(function (run) {
        return run.minutes;
      }),
    ).toEqual([20, 66]);
    expect(series.newest.timeTagMs).toBe(XRAY_NEWEST);
    expect(series.newest.flux).toBe(4.905103878627415e-7);
  });

  it("reads the instrument-source mapping at an instant and filters to its primary", function () {
    const mapping = normalizeGoesInstrumentSources(sources).sources;
    expect(goesXrayPrimaryAt(mapping, NOW)).toBe(18);
    expect(goesXrayPrimaryAt(mapping, Date.parse("2026-09-22T15:00:00Z"))).toBe(
      19,
    );
    const result = normalizeGoesXrayPayload(xrays, 19);
    expect(result.status).toBe("refused");
    expect(result.error.code).toBe(GoesXrayRejectionCode.NO_USABLE_ROWS);
  });

  it("classifies flux on the decade scale", function () {
    expect(classifySolarXrayFlux(1e-5)).toEqual({
      flareClass: "M",
      magnitude: 1,
    });
    expect(classifySolarXrayFlux(4.905103878627415e-7).flareClass).toBe("B");
    expect(classifySolarXrayFlux(5e-9)).toBeUndefined();
  });

  it("estimates activity from the frozen solar wind", function () {
    const estimate = estimateSolarWindActivity(
      normalizeRealTimeSolarWindPayload(wind, "plasma").series.readings,
      normalizeRealTimeSolarWindPayload(mag, "magnetometer").series.readings,
      WIND_NEWEST,
    );
    expect(estimate.pairedMinutes).toBe(179);
    expect(estimate.estimatedKpIndex).toBeCloseTo(1.8944571571040658, 12);
  });

  it("issues nothing until started", async function () {
    const transport = capturedFeed();
    const made = makeIngest(transport);
    expect(transport.calls.length).toBe(0);
    expect(made.ingest.latest()).toBeUndefined();
    await made.ingest.start(NOW);
    expect(transport.calls.length).toBe(4);
    expect(made.timers[0].delay).toBe(60000);
    made.ingest.destroy();
  });

  it("with no authority publishes the solar-wind estimate as the activity scalar and no oval", async function () {
    const made = makeIngest(capturedFeed());
    await made.ingest.start(NOW);
    const packet = made.ingest.latest();
    expect(validateSpaceWeatherPacket(packet).valid).toBe(true);
    expect(packet.oval).toBeUndefined();
    expect(packet.geomagnetic.authority).toBe("rtsw");
    expect(packet.geomagnetic.activity).toBeCloseTo(RTSW_ACTIVITY, 12);
    expect(packet.flare.flareClass).toBe("B");
    expect(packet.solarWind.speedKmPerSecond).toBe(470.6);
    made.ingest.destroy();
  });

  it("carries a model-owned oval through by identity under the index's scalar", async function () {
    const authority = await realAuthority(3);
    const base = authority.latest();
    const made = makeIngest(capturedFeed(), { authority: authority });
    await made.ingest.start(NOW);
    const packet = made.ingest.latest();
    expect(packet.oval === base.oval).toBe(true);
    expect(packet.geomagnetic.authority).toBe("kp");
    expect(packet.geomagnetic.activity).toBeCloseTo(3 / 9, 15);
    expect(auroraOvalIntensityScale(packet)).toBe(1);
    made.ingest.destroy();
    authority.destroy();
  });

  it("draws no oval the decision disowned", async function () {
    const authority = await realAuthority(undefined);
    const made = makeIngest(capturedFeed(), {
      authority: fixedAuthority(authority.latest(), "none"),
    });
    await made.ingest.start(NOW);
    expect(authority.latest().oval).toBeDefined();
    expect(made.ingest.latest().oval).toBeUndefined();
    expect(made.ingest.latest().geomagnetic.authority).toBe("rtsw");
    made.ingest.destroy();
    authority.destroy();
  });

  it("lets a flare change the flare channel and nothing else", async function () {
    const flaring = copy(xrays);
    flaring.forEach(function (row) {
      if (row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST) {
        row.flux = 5e-4;
      }
    });
    const quiet = makeIngest(capturedFeed()).ingest;
    const loudFeed = capturedFeed();
    loudFeed.set(URL_XRAY, flaring);
    const loud = makeIngest(loudFeed).ingest;
    await quiet.start(NOW);
    await loud.start(NOW);
    expect(loud.latest().flare.flareClass).toBe("X");
    expect(Object.assign({}, loud.latest().geomagnetic)).toEqual(
      Object.assign({}, quiet.latest().geomagnetic),
    );
    quiet.destroy();
    loud.destroy();
  });

  it("omits a flux the packet cannot carry and keeps the geomagnetic state", async function () {
    const extreme = copy(xrays);
    extreme.forEach(function (row) {
      if (row.energy === "0.1-0.8nm" && utc(row.time_tag) === XRAY_NEWEST) {
        row.flux = 1.2e-3;
      }
    });
    const transport = capturedFeed();
    transport.set(URL_XRAY, extreme);
    const made = makeIngest(transport);
    spyOn(console, "error");
    await made.ingest.start(NOW);
    expect(made.ingest.latest().flare).toBeUndefined();
    expect(made.ingest.latest().geomagnetic.authority).toBe("rtsw");
    expect(made.ingest.diagnostics.flareOmission).toBe(
      FlareOmission.INVALID_PACKET,
    );
    expect(console.error).toHaveBeenCalledTimes(1);
    made.ingest.destroy();
  });

  it("refuses an older payload and keeps the held series", async function () {
    const transport = capturedFeed();
    const made = makeIngest(transport);
    await made.ingest.start(NOW);
    spyOn(console, "error");
    transport.set(URL_MAG, asServedAt(mag, MAG_NEWEST - 60 * MINUTE));
    await made.ingest.refreshOnce(NOW + MINUTE);
    expect(made.ingest.diagnostics.lastFailure.code).toBe(
      SolarWindFlareIngestCode.TIME_REGRESSION,
    );
    expect(made.ingest.diagnostics.magnetometer.newest.timeTagMs).toBe(
      MAG_NEWEST,
    );
    made.ingest.destroy();
  });

  it("backs off on transport failure and resets on success", async function () {
    const transport = feed({});
    const made = makeIngest(transport);
    spyOn(console, "error");
    await made.ingest.start(NOW);
    await made.ingest.refreshOnce(NOW + MINUTE);
    expect(made.ingest.diagnostics.nextPollDelayMs).toBe(240000);
    transport.set(URL_WIND, wind);
    await made.ingest.refreshOnce(NOW + 2 * MINUTE);
    expect(made.ingest.diagnostics.nextPollDelayMs).toBe(60000);
    made.ingest.destroy();
  });

  it("re-composes on the poll tick and drops a stale solar wind", async function () {
    const transport = capturedFeed();
    const clock = { now: NOW };
    const made = makeIngest(transport, {
      nowFunction: function () {
        return clock.now;
      },
    });
    const events = [];
    made.ingest.addEventListener(function (event) {
      events.push(event);
    });
    await made.ingest.start(NOW);
    const never = function () {
      return new Promise(function () {});
    };
    transport.set(URL_MAG, never);
    transport.set(URL_WIND, never);
    transport.set(URL_XRAY, never);
    transport.set(URL_SOURCES, never);
    clock.now = WIND_NEWEST + 40 * MINUTE;
    const live = made.timers.filter(function (timer) {
      return !timer.cleared;
    });
    live[live.length - 1].handler();
    expect(made.ingest.latest()).toBeUndefined();
    expect(
      events
        .filter(function (event) {
          return (
            event.type === SolarWindFlareEventType.ACTIVITY_AUTHORITY_CHANGE
          );
        })
        .map(function (event) {
          return event.current;
        }),
    ).toEqual(["rtsw", "none"]);
    made.ingest.destroy();
  });

  it("applies the prompt products while one product's answer is still outstanding", async function () {
    const transport = capturedFeed();
    let answerWind;
    transport.set(URL_WIND, function () {
      return new Promise(function (resolve) {
        answerWind = resolve;
      });
    });
    const made = makeIngest(transport);
    const first = made.ingest.start(NOW);
    await new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
    expect(made.ingest.diagnostics.xray.newest.timeTagMs).toBe(XRAY_NEWEST);
    expect(made.ingest.diagnostics.magnetometer.newest.timeTagMs).toBe(
      MAG_NEWEST,
    );
    await made.ingest.refreshOnce(NOW + MINUTE);
    expect(
      transport.calls.filter(function (call) {
        return call.url === URL_WIND;
      }).length,
    ).toBe(1);
    answerWind(wind);
    await first;
    expect(made.ingest.latest().observedTimeMs).toBe(WIND_NEWEST);
    expect(made.ingest.diagnostics.payloadsRefused).toBe(0);
    made.ingest.destroy();
  });

  it("excludes a minute stamped ahead of the clock instead of refusing the day", async function () {
    const typo = copy(mag);
    const index = typo.findIndex(function (row) {
      return (
        row.active === true && utc(row.time_tag) === MAG_NEWEST - 30 * MINUTE
      );
    });
    typo[index].time_tag = typo[index].time_tag.replace(/^2026/, "2027");
    const transport = capturedFeed();
    transport.set(URL_MAG, typo);
    const made = makeIngest(transport);
    await made.ingest.start(NOW);
    expect(made.ingest.diagnostics.payloadsRefused).toBe(0);
    expect(made.ingest.diagnostics.magnetometer.newest.timeTagMs).toBe(
      MAG_NEWEST,
    );
    expect(
      made.ingest.diagnostics.magnetometer.excluded[
        RealTimeSolarWindExclusion.AHEAD_OF_CLOCK
      ],
    ).toBe(1);
    made.ingest.destroy();
  });

  it("leaves no packet behind when a listener destroys the ingest inside a publish", async function () {
    const made = makeIngest(capturedFeed());
    made.ingest.addEventListener(function (event) {
      if (event.type === SolarWindFlareEventType.FLARE_CLASS_CHANGE) {
        made.ingest.destroy();
      }
    });
    await made.ingest.start(NOW);
    expect(made.ingest.isDestroyed).toBe(true);
    expect(made.ingest.latest()).toBeUndefined();
    expect(made.ingest.diagnostics.activityAuthority).toBe("none");
  });

  it("destroy abandons the requests in flight and refuses to restart", async function () {
    const transport = capturedFeed();
    const made = makeIngest(transport);
    await made.ingest.start(NOW);
    let release;
    transport.set(URL_WIND, function () {
      return new Promise(function (resolve) {
        release = resolve;
      });
    });
    const inFlight = made.ingest.refreshOnce(NOW + MINUTE);
    made.ingest.destroy();
    release(wind);
    await inFlight;
    expect(made.ingest.latest()).toBeUndefined();
    const calls = transport.calls.length;
    await made.ingest.start(NOW + 2 * MINUTE);
    expect(transport.calls.length).toBe(calls);
  });

  it("publishes the prompt products before a slow product answers, without waiting for a tick", async function () {
    const transport = capturedFeed();
    let answerXray;
    transport.set(URL_XRAY, function () {
      return new Promise(function (resolve) {
        answerXray = resolve;
      });
    });
    const made = makeIngest(transport, { pollIntervalSeconds: 300 });
    const first = made.ingest.start(NOW);
    await new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
    const early = made.ingest.latest();
    expect(early).toBeDefined();
    expect(early.geomagnetic.authority).toBe("rtsw");
    expect(early.flare).toBeUndefined();
    expect(made.timers.length).toBe(1);
    answerXray(xrays);
    await first;
    expect(made.ingest.latest().flare.flareClass).toBe("B");
    made.ingest.destroy();
  });

  it("costs one unreadable row only that row", function () {
    const rows = copy(mag);
    const standby = rows.findIndex(function (row) {
      return row.active === false;
    });
    rows[standby] = null;
    const result = normalizeRealTimeSolarWindPayload(rows, "magnetometer");
    expect(result.status).toBe("ok");
    expect(result.series.readings.length).toBe(1435);
    expect(result.series.excluded[RealTimeSolarWindExclusion.ROW_SHAPE]).toBe(
      1,
    );
  });

  it("treats an authority packet that does not validate as absent and keeps the flare", async function () {
    const invalid = {
      version: 1,
      provenance: {
        sourceId: "noaa-planetary-kp",
        kind: "observed",
        validitySeconds: 10800,
      },
      observedTimeMs: NOW - 3600000,
      forecastTimeMs: NOW - 3600000,
      geomagnetic: { activity: 1.5, authority: "kp", kpIndex: 13.5 },
    };
    spyOn(console, "error");
    const made = makeIngest(capturedFeed(), {
      authority: fixedAuthority(invalid, "kp"),
    });
    await made.ingest.start(NOW);
    const packet = made.ingest.latest();
    expect(packet.geomagnetic.authority).toBe("rtsw");
    expect(packet.flare.flareClass).toBe("B");
    expect(made.ingest.diagnostics.lastFailure.product).toBe("oval-authority");
    expect(console.error).toHaveBeenCalledTimes(1);
    made.ingest.destroy();
  });
});
