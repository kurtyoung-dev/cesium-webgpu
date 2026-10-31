// clock-pin.spec.mjs — the opt-in --clock pin of the weather probes. Pure Node.
// @purpose Pins lib/clock-pin.mjs (ISO validation, pin and read-back, loud refusals for no viewer / module failure / mismatch / a clock that moved) and its wiring in probe-weather-map and probe-weather-ingest: the flag is declared and parses, the pin is never applied without it, the receipt cell records clockPin (or null), and a clock the run's own page work moves refuses.
// @status ACTIVE
//
// The page functions (`pageSetClock`, `pageReadClock`) run for real in Node over
// a fake `globalThis.viewer` and a data: URL standing in for the Cesium
// namespace, so the helper is tested through the code the page would run. The
// probes are driven through `runProbe` (the real runtime) with a
// stub browser; no number here is evidence about the engine. The ingest lane's
// own use of the instant (`frameTime`) runs in the page and is pinned by source
// text at the end, which is the weaker kind of pin.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import {
  CLOCK_OPTION,
  DAYLIGHT_CLOCK_ISO,
  assertClockHeld,
  clockFlagValue,
  pageReadClock,
  parseClockIso,
  pinClock,
  clockFlagExitCode,
} from "./lib/clock-pin.mjs";
import { pageSetClock } from "./lib/clock-steps.mjs";
import { makeSmallPng } from "./lib/landing-fake-browser.mjs";
import {
  PROBE_EXIT_CODES,
  ProbeRefusal,
  parseProbeArgs,
  runProbe,
} from "./lib/probe-runtime.mjs";
import {
  INGEST_MARKER,
  fakePage,
  ingestLane,
  readJson,
} from "./lib/weather-lane-fixtures.mjs";
import { descriptor as ingestDescriptor } from "./probe-weather-ingest.mjs";
import { descriptor as mapDescriptor } from "./probe-weather-map.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const cesiumModule = (toIsoBody) =>
  `data:text/javascript,${encodeURIComponent(
    `export const JulianDate = {
       fromIso8601: (s) => Date.parse(s),
       toIso8601: (ms) => ${toIsoBody},
     };`,
  )}`;
const FAKE_CESIUM = cesiumModule(
  `new Date(ms).toISOString().replace(".000Z", "Z")`,
);
const SKEWED_CESIUM = cesiumModule(
  `new Date(ms + 1000).toISOString().replace(".000Z", "Z")`,
);
const BROKEN_CESIUM = `data:text/javascript,${encodeURIComponent("throw new Error('no cesium');")}`;

/** Run `fn` with a fake viewer on globalThis, restoring whatever was there. */
async function withViewer(viewer, fn) {
  const had = Object.hasOwn(globalThis, "viewer");
  const before = globalThis.viewer;
  if (viewer === undefined) delete globalThis.viewer;
  else globalThis.viewer = viewer;
  try {
    return await fn();
  } finally {
    if (had) globalThis.viewer = before;
    else delete globalThis.viewer;
  }
}

const freshViewer = () => ({
  clock: { currentTime: Date.UTC(2020, 0, 1), shouldAnimate: true },
});

/** A page that runs the real page functions with a stand-in Cesium module. */
const directPage = (moduleOverride) => ({
  calls: [],
  async evaluate(fn, arg) {
    this.calls.push(fn.name);
    return fn({ ...arg, moduleUrl: moduleOverride ?? FAKE_CESIUM });
  },
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("parseClockIso: the daylight constant and offset spellings canonicalise to a UTC second", () => {
  assert.equal(parseClockIso(DAYLIGHT_CLOCK_ISO), DAYLIGHT_CLOCK_ISO);
  assert.equal(parseClockIso("2026-06-21T14:00:00-04:00"), DAYLIGHT_CLOCK_ISO);
  assert.equal(parseClockIso("2026-06-21T18:00:00.000Z"), DAYLIGHT_CLOCK_ISO);
});

test("parseClockIso: refuses what is not an ISO instant with a zone, to the second", () => {
  for (const bad of [
    "",
    "yesterday",
    "2026-06-21",
    "2026-06-21T18:00:00",
    "2026-06-21T18:00Z",
    "2026-02-31T00:00:00Z",
    "2026-06-21T25:00:00Z",
    "2026-06-21T18:00:00.5Z",
  ]) {
    assert.throws(() => parseClockIso(bad), TypeError, `"${bad}"`);
  }
});

test("clockFlagValue: null without the flag, the instant with it, TypeError for a missing or bad value", () => {
  assert.equal(clockFlagValue(["--port", "8094"]), null);
  assert.equal(
    clockFlagValue(["--clock", DAYLIGHT_CLOCK_ISO]),
    DAYLIGHT_CLOCK_ISO,
  );
  assert.throws(() => clockFlagValue(["--clock"]), /requires a value/);
  assert.throws(
    () => clockFlagValue(["--clock", "--port", "1"]),
    /requires a value/,
  );
  assert.throws(() => clockFlagValue(["--clock", "noon"]), TypeError);
});

// ---------------------------------------------------------------------------
// pinClock / assertClockHeld
// ---------------------------------------------------------------------------

test("pinClock: sets the frozen clock and returns {requested, observed}", () =>
  withViewer(freshViewer(), async () => {
    const page = directPage();
    const pin = await pinClock(page, "2026-06-21T14:00:00-04:00", FAKE_CESIUM);
    assert.deepEqual(pin, {
      requested: DAYLIGHT_CLOCK_ISO,
      observed: DAYLIGHT_CLOCK_ISO,
    });
    assert.equal(
      globalThis.viewer.clock.currentTime,
      Date.parse(DAYLIGHT_CLOCK_ISO),
    );
    assert.equal(globalThis.viewer.clock.shouldAnimate, false);
    assert.deepEqual(page.calls, ["pageSetClock"]);
  }));

test("pinClock: a page with no viewer refuses", () =>
  withViewer(undefined, async () => {
    await assert.rejects(
      pinClock(directPage(), DAYLIGHT_CLOCK_ISO, FAKE_CESIUM),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === "clock-pin-failed" &&
        /no viewer/.test(error.message),
    );
  }));

test("pinClock: a Cesium module that does not load refuses", () =>
  withViewer(freshViewer(), async () => {
    await assert.rejects(
      pinClock(directPage(BROKEN_CESIUM), DAYLIGHT_CLOCK_ISO, BROKEN_CESIUM),
      (error) =>
        error instanceof ProbeRefusal && /did not load/.test(error.message),
    );
  }));

test("pinClock: a clock that reads anything but the requested instant refuses", () =>
  withViewer(freshViewer(), async () => {
    await assert.rejects(
      pinClock(directPage(SKEWED_CESIUM), DAYLIGHT_CLOCK_ISO, SKEWED_CESIUM),
      (error) =>
        error instanceof ProbeRefusal &&
        error.reason === "clock-pin-failed" &&
        /not the requested/.test(error.message),
    );
  }));

test("pinClock: an unparseable instant is a TypeError and the page is never asked", async () => {
  const page = directPage();
  await assert.rejects(pinClock(page, "noon"), TypeError);
  assert.deepEqual(page.calls, []);
});

test("assertClockHeld: adds observedAtEnd while the clock holds, refuses (clock-pin-lost) once it moved", () =>
  withViewer(freshViewer(), async () => {
    const page = directPage();
    const pin = await pinClock(page, DAYLIGHT_CLOCK_ISO, FAKE_CESIUM);
    assert.deepEqual(await assertClockHeld(page, pin, FAKE_CESIUM), {
      ...pin,
      observedAtEnd: DAYLIGHT_CLOCK_ISO,
    });
    globalThis.viewer.clock.currentTime += 60_000;
    await assert.rejects(
      assertClockHeld(page, pin, FAKE_CESIUM),
      (error) => error.reason === "clock-pin-lost",
    );
  }));

// ---------------------------------------------------------------------------
// Wiring: the flag, and the probes' use of it
// ---------------------------------------------------------------------------

test("both weather probes declare the flag, and it parses", () => {
  for (const descriptor of [mapDescriptor, ingestDescriptor]) {
    assert.ok(
      descriptor.args.extraOptions.some((o) => o.flag === CLOCK_OPTION.flag),
      descriptor.name,
    );
    assert.equal(
      parseProbeArgs(["--clock", DAYLIGHT_CLOCK_ISO], descriptor.args).clock,
      DAYLIGHT_CLOCK_ISO,
    );
    assert.equal(parseProbeArgs([], descriptor.args).clock, undefined);
  }
});

test("a descriptor that declares CLOCK_OPTION rejects a bad --clock through parseProbeArgs alone, and normalizes a good one", () => {
  const args = { extraOptions: [CLOCK_OPTION] };
  for (const bad of ["noon", "2026-06-21T18:00:00", "2026-02-30T12:00:00Z"]) {
    assert.throws(
      () => parseProbeArgs(["--clock", bad], args),
      (error) =>
        error instanceof TypeError &&
        /--clock must be an ISO 8601 instant/.test(error.message),
      bad,
    );
  }
  assert.equal(
    parseProbeArgs(["--clock", "2026-06-21T14:00:00-04:00"], args).clock,
    DAYLIGHT_CLOCK_ISO,
  );
  assert.equal(parseProbeArgs([], args).clock, undefined);
});

const CLOCK_LANES = [
  {
    marker: "function pageSetClock",
    respond: (arg) => pageSetClock({ ...arg, moduleUrl: FAKE_CESIUM }),
  },
  {
    marker: "function pageReadClock",
    respond: (arg) => pageReadClock({ ...arg, moduleUrl: FAKE_CESIUM }),
  },
];

function probeDependencies(root, extraArgv, launch) {
  return {
    argv: [
      "--repository-root",
      root,
      "--output",
      path.join(root, "out"),
      "--no-serve-built",
      ...extraArgv,
    ],
    now: () => Date.UTC(2026, 8, 26, 23, 0, 0),
    launch,
  };
}

const stubBrowser = (log, page) => async () => {
  log.launches += 1;
  let connected = true;
  return {
    isConnected: () => connected,
    newPage: async () => page,
    close: async () => {
      connected = false;
    },
  };
};

/** The ingest probe through the real runtime with a stub browser. */
async function driveIngest(root, extraArgv, { laneHook } = {}) {
  const log = { calls: [], launches: 0, cfgs: [] };
  const healthy = ingestLane();
  const lanes = [
    ...CLOCK_LANES,
    {
      marker: INGEST_MARKER,
      respond: (cfg) => {
        log.cfgs.push(cfg);
        laneHook?.();
        return healthy(cfg);
      },
    },
  ];
  const code = await runProbe(
    ingestDescriptor,
    probeDependencies(root, extraArgv, stubBrowser(log, fakePage(log, lanes))),
  );
  return { code, out: path.join(root, "out"), log };
}

/** The map probe through the real runtime with a stub browser. */
async function driveMap(root, extraArgv, { viewHook } = {}) {
  const log = { calls: [], launches: 0 };
  const png = makeSmallPng();
  const page = fakePage(log, [
    ...CLOCK_LANES,
    { marker: "cloudWeatherMap = weatherOn", respond: () => viewHook?.() },
    {
      marker: ".cesium-navigation-help",
      respond: () => ({ removed: 1, leftovers: [] }),
    },
  ]);
  page.locator = () => ({ count: async () => 1, screenshot: async () => png });
  const code = await runProbe(
    mapDescriptor,
    probeDependencies(root, extraArgv, stubBrowser(log, page)),
  );
  return { code, out: path.join(root, "out"), log };
}

const clockCalls = (log) =>
  log.calls.filter((c) => /function page(Set|Read)Clock/.test(c));

test("ingest: without --clock no clock page function is evaluated, the lane keeps its own noon, clockPin is null", () =>
  withViewer(freshViewer(), () =>
    withLaneTmp("clock-pin-ingest-", async (root) => {
      const { code, out, log } = await driveIngest(root, []);
      assert.equal(code, PROBE_EXIT_CODES.OK);
      assert.deepEqual(clockCalls(log), []);
      assert.equal(log.cfgs[0].clockIso, null);
      assert.equal(
        globalThis.viewer.clock.shouldAnimate,
        true,
        "clock untouched",
      );
      assert.equal(
        readJson(path.join(out, "weather-ingest-report.json")).runs[0].clockPin,
        null,
      );
    }),
  ));

test("ingest: --clock pins before the lane, hands the instant to the lane and records the read-back at both ends", () =>
  withViewer(freshViewer(), () =>
    withLaneTmp("clock-pin-ingest-", async (root) => {
      const { code, out, log } = await driveIngest(root, [
        "--clock",
        DAYLIGHT_CLOCK_ISO,
      ]);
      assert.equal(code, PROBE_EXIT_CODES.OK);
      assert.equal(log.cfgs[0].clockIso, DAYLIGHT_CLOCK_ISO);
      const set = log.calls.indexOf("lane:function pageSetClock");
      const lane = log.calls.indexOf(`lane:${INGEST_MARKER}`);
      const read = log.calls.indexOf("lane:function pageReadClock");
      assert.ok(set !== -1 && set < lane && lane < read, "set, lane, read");
      assert.deepEqual(
        readJson(path.join(out, "weather-ingest-report.json")).runs[0].clockPin,
        {
          requested: DAYLIGHT_CLOCK_ISO,
          observed: DAYLIGHT_CLOCK_ISO,
          observedAtEnd: DAYLIGHT_CLOCK_ISO,
        },
      );
    }),
  ));

test("ingest: a lane that leaves the clock elsewhere is a refusal, clock-pin-lost", () =>
  withViewer(freshViewer(), () =>
    withLaneTmp("clock-pin-ingest-", async (root) => {
      const { code, out } = await driveIngest(
        root,
        ["--clock", DAYLIGHT_CLOCK_ISO],
        {
          laneHook: () => {
            globalThis.viewer.clock.currentTime = Date.UTC(2026, 5, 1, 17);
          },
        },
      );
      assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
      assert.equal(
        readJson(path.join(out, "weather-ingest-refusal.json")).refusal.reason,
        "clock-pin-lost",
      );
    }),
  ));

test("ingest: a page with no viewer under --clock is a refusal before the lane runs", () =>
  withViewer(undefined, () =>
    withLaneTmp("clock-pin-ingest-", async (root) => {
      const { code, log } = await driveIngest(root, [
        "--clock",
        DAYLIGHT_CLOCK_ISO,
      ]);
      assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
      assert.equal(log.cfgs.length, 0);
    }),
  ));

test("map: without --clock no clock page function is evaluated and clockPin is null", () =>
  withViewer(freshViewer(), () =>
    withLaneTmp("clock-pin-map-", async (root) => {
      const { code, out, log } = await driveMap(root, []);
      assert.notEqual(code, PROBE_EXIT_CODES.REFUSAL);
      assert.notEqual(code, PROBE_EXIT_CODES.ERROR);
      assert.deepEqual(clockCalls(log), []);
      assert.equal(
        readJson(path.join(out, "weather-map-report.json")).runs[0].clockPin,
        null,
      );
    }),
  ));

test("map: --clock pins right after the viewer wait, before the first view, and reads back after the captures", () =>
  withViewer(freshViewer(), () =>
    withLaneTmp("clock-pin-map-", async (root) => {
      const { out, log } = await driveMap(root, [
        "--clock",
        DAYLIGHT_CLOCK_ISO,
      ]);
      const view = "lane:cloudWeatherMap = weatherOn";
      const set = log.calls.indexOf("lane:function pageSetClock");
      const read = log.calls.indexOf("lane:function pageReadClock");
      assert.ok(
        set !== -1 && set < log.calls.indexOf(view),
        "set before views",
      );
      assert.ok(read > log.calls.lastIndexOf(view), "read after the last view");
      assert.deepEqual(
        readJson(path.join(out, "weather-map-report.json")).runs[0].clockPin,
        {
          requested: DAYLIGHT_CLOCK_ISO,
          observed: DAYLIGHT_CLOCK_ISO,
          observedAtEnd: DAYLIGHT_CLOCK_ISO,
        },
      );
    }),
  ));

test("map: a view change that moves the clock is a refusal, clock-pin-lost", () =>
  withViewer(freshViewer(), () =>
    withLaneTmp("clock-pin-map-", async (root) => {
      const { code, out } = await driveMap(
        root,
        ["--clock", DAYLIGHT_CLOCK_ISO],
        {
          viewHook: () => {
            globalThis.viewer.clock.currentTime = Date.UTC(2026, 5, 1, 3);
          },
        },
      );
      assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
      assert.equal(
        readJson(path.join(out, "weather-map-refusal.json")).refusal.reason,
        "clock-pin-lost",
      );
    }),
  ));

test("clockFlagExitCode: null for no flag or a good one, 2 with a stderr message for a bad one", () => {
  const write = process.stderr.write;
  const written = [];
  process.stderr.write = (chunk) => written.push(String(chunk)) > 0;
  try {
    assert.equal(clockFlagExitCode("p", []), null);
    assert.equal(clockFlagExitCode("p", ["--clock", DAYLIGHT_CLOCK_ISO]), null);
    assert.equal(
      clockFlagExitCode("p", ["--clock", "nope"]),
      PROBE_EXIT_CODES.ERROR,
    );
  } finally {
    process.stderr.write = write;
  }
  assert.match(written.join(""), /^p: --clock must be an ISO 8601 instant/);
});

test("an unparseable --clock makes each probe exit 2 from its own entry point, before the runtime (no server, no browser)", () =>
  withLaneTmp("clock-pin-entry-", (root) => {
    for (const file of ["probe-weather-map.mjs", "probe-weather-ingest.mjs"]) {
      const child = spawnSync(
        process.execPath,
        [
          path.join(HERE, file),
          "--clock",
          "not-a-date",
          "--port",
          "1",
          "--repository-root",
          root,
          "--output",
          path.join(root, "out"),
        ],
        { encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(
        child.status,
        PROBE_EXIT_CODES.ERROR,
        `${file}: ${child.stderr}`,
      );
      assert.match(child.stderr, /--clock must be an ISO 8601 instant/);
    }
  }));

test("source anchor (weaker than the tests above): the ingest lane renders at the requested instant, not only at its local noon", () => {
  const source = fs
    .readFileSync(path.join(HERE, "probe-weather-ingest.mjs"), "utf8")
    .replace(/\r\n/g, "\n");
  assert.match(
    source,
    /const frameTime = cfg\.clockIso\n\s+\? C\.JulianDate\.fromIso8601\(cfg\.clockIso\)\n\s+: pin\.localNoonAt\(C, cfg\.lon\);/,
  );
});
