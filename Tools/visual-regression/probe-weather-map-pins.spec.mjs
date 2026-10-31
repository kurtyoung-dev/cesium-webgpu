// probe-weather-map-pins.spec.mjs - the weather-map probe's readiness and opt-in pins. Pure Node.
// @purpose Pins probe-weather-map's first-frame readiness (the pipeline wait before the first capture, the black-frame re-settle and the first-frame-black refusal) and its opt-in --cloud-wind-speed / --cloud-quality / --offline-globe dials (flag parsing, URL, page-side application and read-back, dial-not-applied refusal), and that a run with no flag is the run it always was.
// @status ACTIVE
//
// The descriptor runs through the real `runProbe` with a stub browser whose
// `page.evaluate` is answered by the source of the function it is handed. The
// page-side `SET_VIEW` also runs for real, over a fake `window.viewer` and a
// data: URL standing in for the Cesium namespace, so the dial writes and the
// read-back are the code the page would run. No number here is evidence about
// the engine.
//
//   node --test Tools/visual-regression/probe-weather-map-pins.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { PIPELINE_WAIT_DEFAULTS } from "./lib/landing-cell-stage.mjs";
import {
  PROBE_EXIT_CODES,
  parseProbeArgs,
  runProbe,
} from "./lib/probe-runtime.mjs";
import {
  MAP_DIAL_OPTIONS,
  SET_VIEW,
  descriptor,
  judgeMapDials,
  mapPageUrl,
  planMapDials,
} from "./probe-weather-map.mjs";

const PAGE = "/Apps/CesiumViewer/index.html?renderer=webgpu";
const PIPELINE_MARKER = "function pageWaitForPendingPipelines";
const STRIP_MARKER = ".cesium-navigation-help";
const SET_VIEW_MARKER = "cloudWeatherMap = weatherOn";

const png = (value) =>
  Buffer.from(encodeRgbaPng(new Uint8Array(8 * 8 * 4).fill(value), 8, 8));
const LIT = png(180);
const BLACK = png(0);

const WAIT_RECORD = {
  requested: true,
  available: true,
  pendingAtStart: 4,
  pendingAtEnd: 0,
  framesWaited: 3,
  timedOut: false,
};

const echoReadback = (plan) => ({
  cloudWindSpeed: plan.cloudWindSpeed,
  cloudQuality: plan.cloudQuality,
  imageryLayerCount: 0,
  terrainIsEllipsoid: true,
});

/**
 * One run of the probe through the real runtime.
 *
 * @param {string} root Lane temp root.
 * @param {string[]} argv Probe flags.
 * @param {{shot?: (n: number) => Buffer, readback?: (plan: object,
 *   call: number) => unknown}} [script] `shot(n)` is the n-th canvas capture;
 *   `readback` is the page's answer to the n-th SET_VIEW when it was given dials.
 */
async function drive(
  root,
  argv,
  { shot = () => LIT, readback = echoReadback } = {},
) {
  const out = path.join(root, "out");
  const log = { urls: [], views: [], order: [], shots: 0 };
  const page = {
    on() {},
    async goto(url) {
      log.urls.push(url);
    },
    async waitForFunction() {},
    async close() {},
    locator() {
      return {
        count: async () => 1,
        screenshot: async () => {
          log.order.push("shot");
          return shot(log.shots++);
        },
      };
    },
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("__captureLiveness")) {
        return { gateArmed: true, deviceLost: null, frameNumber: 7 };
      }
      if (source.includes("__armWebGPUDevice")) {
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        return { errors: [], deviceLost: null, armedDevices: 1 };
      }
      if (source.includes(SET_VIEW_MARKER)) {
        log.order.push("view");
        log.views.push(arg);
        return arg.dials ? readback(arg.dials, log.views.length - 1) : null;
      }
      if (source.includes(PIPELINE_MARKER)) {
        log.order.push("wait");
        return WAIT_RECORD;
      }
      if (source.includes(STRIP_MARKER)) {
        log.order.push("strip");
        return { removed: 3, leftovers: [] };
      }
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 120)}`);
    },
  };
  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      root,
      "--output",
      out,
      "--no-serve-built",
      ...argv,
    ],
    now: () => Date.UTC(2026, 9, 31, 12, 0, 0),
    launch: async () => {
      let connected = true;
      return {
        isConnected: () => connected,
        async newPage() {
          return page;
        },
        async close() {
          connected = false;
        },
      };
    },
  });
  return { code, out, log };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const report = (out) => readJson(path.join(out, "weather-map-report.json"));
const refusal = (out) =>
  readJson(path.join(out, "weather-map-refusal.json")).refusal;

// ---------------------------------------------------------------------------
// Flags, plan, URL
// ---------------------------------------------------------------------------

test("flags: declared once, parse as numbers and a switch, reject a negative or missing value", () => {
  assert.deepEqual(
    MAP_DIAL_OPTIONS.map((o) => [o.flag, o.key]),
    [
      ["--cloud-wind-speed", "cloudWindSpeed"],
      ["--cloud-quality", "cloudQuality"],
      ["--offline-globe", "offlineGlobe"],
    ],
  );
  const none = parseProbeArgs([], descriptor.args);
  assert.equal(none.cloudWindSpeed, undefined);
  assert.equal(none.cloudQuality, undefined);
  assert.equal(none.offlineGlobe, undefined);
  const all = parseProbeArgs(
    ["--cloud-wind-speed", "0", "--cloud-quality", "32", "--offline-globe"],
    descriptor.args,
  );
  assert.equal(all.cloudWindSpeed, 0);
  assert.equal(all.cloudQuality, 32);
  assert.equal(all.offlineGlobe, true);
  assert.throws(
    () => parseProbeArgs(["--cloud-wind-speed", "-1"], descriptor.args),
    TypeError,
  );
  assert.throws(
    () => parseProbeArgs(["--cloud-quality"], descriptor.args),
    /requires a value/,
  );
});

test("planMapDials: no flag is no plan; a wind of 0 is a request, not an absence", () => {
  assert.equal(planMapDials({}), null);
  assert.equal(planMapDials({ offlineGlobe: false }), null);
  assert.deepEqual(planMapDials({ cloudWindSpeed: 0 }), { cloudWindSpeed: 0 });
  assert.deepEqual(
    planMapDials({ cloudWindSpeed: 0, cloudQuality: 32, offlineGlobe: true }),
    { cloudWindSpeed: 0, cloudQuality: 32, offlineGlobe: true },
  );
});

test("mapPageUrl: today's URL unless the offline globe is asked for", () => {
  assert.equal(mapPageUrl({}), PAGE);
  assert.equal(mapPageUrl({ cloudWindSpeed: 0, cloudQuality: 32 }), PAGE);
  assert.equal(mapPageUrl({ offlineGlobe: true }), `${PAGE}&offline=true`);
});

// ---------------------------------------------------------------------------
// The read-back decision
// ---------------------------------------------------------------------------

const GOOD = {
  cloudWindSpeed: 0,
  cloudQuality: 32,
  imageryLayerCount: 0,
  terrainIsEllipsoid: true,
};
const FULL_PLAN = { cloudWindSpeed: 0, cloudQuality: 32, offlineGlobe: true };

test("judgeMapDials: applied exactly when every requested dial reads back", () => {
  assert.deepEqual(judgeMapDials(FULL_PLAN, GOOD), {
    applied: true,
    mismatches: [],
  });
  assert.deepEqual(judgeMapDials(null, null), {
    applied: true,
    mismatches: [],
  });
  // Dials not requested are not checked, whatever the scene reads.
  assert.equal(
    judgeMapDials(
      { cloudWindSpeed: 0 },
      { cloudWindSpeed: 0, cloudQuality: 64 },
    ).applied,
    true,
  );
});

test("judgeMapDials: each dial that reads back differently is named with both values", () => {
  const cases = [
    [{ ...GOOD, cloudWindSpeed: 15 }, "cloudWindSpeed", 0, 15],
    [{ ...GOOD, cloudQuality: 64 }, "cloudQuality", 32, 64],
    [{ ...GOOD, imageryLayerCount: 1 }, "offlineGlobe.imageryLayerCount", 0, 1],
    [
      { ...GOOD, terrainIsEllipsoid: false },
      "offlineGlobe.terrainIsEllipsoid",
      true,
      false,
    ],
  ];
  for (const [observed, dial, requested, seen] of cases) {
    assert.deepEqual(judgeMapDials(FULL_PLAN, observed), {
      applied: false,
      mismatches: [{ dial, requested, observed: seen }],
    });
  }
});

test("judgeMapDials: no answer from the page is not applied", () => {
  const judged = judgeMapDials(FULL_PLAN, null);
  assert.equal(judged.applied, false);
  assert.equal(judged.mismatches.length, 4);
  assert.equal(judgeMapDials({ cloudWindSpeed: 0 }, {}).applied, false);
});

// ---------------------------------------------------------------------------
// SET_VIEW, the real page function over a fake scene
// ---------------------------------------------------------------------------

const FAKE_CESIUM = `data:text/javascript,${encodeURIComponent(`
  export const Color = { BLACK: "black", fromBytes: () => "base" };
  export const Cartesian3 = { fromDegrees: (...a) => a };
  export const Math = { toRadians: (x) => x };
  export class EllipsoidTerrainProvider {}
`)}`;

/** SET_VIEW with the Cesium import pointed at the stand-in, as the page would see it. */
// eslint-disable-next-line no-new-func
const pageSetView = new Function(
  `return (${String(SET_VIEW).replace("/Build/CesiumUnminified/index.js", FAKE_CESIUM)});`,
)();

async function runSetView(dials) {
  const writes = [];
  const volumetric = new Proxy(
    { cloudWindSpeed: 15, cloudQuality: 64 },
    {
      set(target, key, value) {
        writes.push(String(key));
        target[key] = value;
        return true;
      },
    },
  );
  const globe = {
    defaultCloudCollection: { volumetric },
    imageryLayers: {
      length: 2,
      removeAll() {
        this.length = 0;
        writes.push("imageryLayers.removeAll");
      },
    },
    terrainProvider: { streamed: true },
  };
  const scene = {
    globe,
    skyAtmosphere: {},
    sun: {},
    moon: {},
    skyBox: {},
    render() {},
  };
  const saved = [globalThis.window, globalThis.requestAnimationFrame];
  globalThis.window = { viewer: { scene, camera: { setView() {} } } };
  globalThis.requestAnimationFrame = (fn) => fn();
  try {
    const answer = await pageSetView({
      lon: 1,
      lat: 2,
      height: 3,
      weatherOn: true,
      frames: 2,
      dials,
    });
    return { answer, volumetric, globe, writes };
  } finally {
    [globalThis.window, globalThis.requestAnimationFrame] = saved;
  }
}

test("SET_VIEW: with no dials the wind, quality and globe are left alone and nothing is read back", async () => {
  const { answer, volumetric, globe } = await runSetView(null);
  assert.equal(answer, null);
  assert.equal(volumetric.cloudWindSpeed, 15);
  assert.equal(volumetric.cloudQuality, 64);
  assert.equal(globe.imageryLayers.length, 2);
  assert.deepEqual(globe.terrainProvider, { streamed: true });
});

test("SET_VIEW: the requested dials are written and read back from the scene", async () => {
  const { answer, globe } = await runSetView(FULL_PLAN);
  assert.deepEqual(answer, GOOD);
  assert.equal(globe.imageryLayers.length, 0);
  assert.equal(
    globe.terrainProvider.constructor.name,
    "EllipsoidTerrainProvider",
  );
});

test("SET_VIEW: only the requested dials are written", async () => {
  const { answer, volumetric, globe } = await runSetView({ cloudWindSpeed: 0 });
  assert.equal(answer.cloudWindSpeed, 0);
  assert.equal(volumetric.cloudQuality, 64, "quality untouched");
  assert.equal(
    answer.cloudQuality,
    64,
    "but still reported as the scene has it",
  );
  assert.equal(globe.imageryLayers.length, 2, "globe untouched");
});

// ---------------------------------------------------------------------------
// Through the runtime
// ---------------------------------------------------------------------------

test("no flag: today's URL, no dial in any view, no dial record - and the first frame still goes through the wait", () =>
  withLaneTmp("weather-map-pins-", async (root) => {
    const { code, out, log } = await drive(root, []);
    assert.notEqual(code, PROBE_EXIT_CODES.REFUSAL);
    assert.notEqual(code, PROBE_EXIT_CODES.ERROR);
    assert.ok(log.urls[0].endsWith(PAGE), log.urls[0]);
    assert.ok(!log.urls[0].includes("offline"));
    assert.equal(log.views.length, 22);
    assert.ok(log.views.every((v) => v.dials === null));
    const run = report(out).runs[0];
    assert.equal(run.dials, null);
    assert.deepEqual(run.firstFrame.pipelines, WAIT_RECORD);
    assert.equal(run.firstFrame.attempts.length, 1);
    assert.equal(log.order.filter((e) => e === "wait").length, 1);
  }));

test("first frame: the pipeline wait and the widget strip both precede the first capture, and the wait comes first", () =>
  withLaneTmp("weather-map-pins-", async (root) => {
    const { log } = await drive(root, []);
    const firstShot = log.order.indexOf("shot");
    const wait = log.order.indexOf("wait");
    const strip = log.order.indexOf("strip");
    assert.ok(wait !== -1 && strip !== -1 && firstShot !== -1);
    assert.ok(wait < strip && strip < firstShot, log.order.slice(0, 6).join());
  }));

test("first frame: a black first capture is re-settled and recaptured; the recapture is scored and the attempts are in the receipt", () =>
  withLaneTmp("weather-map-pins-", async (root) => {
    const { code, out, log } = await drive(root, [], {
      shot: (n) => (n === 0 ? BLACK : LIT),
    });
    assert.notEqual(code, PROBE_EXIT_CODES.REFUSAL);
    const run = report(out).runs[0];
    assert.deepEqual(
      run.firstFrame.attempts.map((a) => [a.attempt, a.name, a.black]),
      [
        [0, "located-off-lon-120-lat45", true],
        [1, "located-off-lon-120-lat45-retry1", false],
      ],
    );
    assert.equal(run.firstFrame.attempts[0].nonBlackPct, 0);
    assert.equal(run.firstFrame.attempts[1].nonBlackPct, 100);
    assert.deepEqual(run.firstFrame.attempts[1].resettleBefore, WAIT_RECORD);
    assert.equal(log.views.length, 23, "one extra settle");
    assert.equal(log.order.filter((e) => e === "wait").length, 2);
    // The black frame never reached the scored fractions: the first OFF
    // location was scored from the recapture, not from 0.
    assert.equal(run.scored.stats.offFracs.length, 10);
    assert.ok(run.scored.stats.offFracs[0] > 0);
  }));

test("first frame: black on every attempt is a first-frame-black refusal (exit 3), not a FAIL, and no scored report", () =>
  withLaneTmp("weather-map-pins-", async (root) => {
    const { code, out, log } = await drive(root, [], { shot: () => BLACK });
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const r = refusal(out);
    assert.equal(r.reason, "first-frame-black");
    assert.equal(r.details.attempts.length, 3);
    assert.ok(r.details.attempts.every((a) => a.nonBlackPct === 0));
    assert.equal(log.shots, 3, "no location beyond the first was captured");
    assert.equal(
      fs.existsSync(path.join(out, "weather-map-report.json")),
      false,
    );
  }));

test("dials: the flags reach every view, the URL goes offline, and the receipt records requested and observed", () =>
  withLaneTmp("weather-map-pins-", async (root) => {
    const { code, out, log } = await drive(root, [
      "--cloud-wind-speed",
      "0",
      "--cloud-quality",
      "32",
      "--offline-globe",
    ]);
    assert.notEqual(code, PROBE_EXIT_CODES.REFUSAL);
    assert.ok(log.urls[0].endsWith(`${PAGE}&offline=true`));
    assert.equal(log.views.length, 22);
    assert.ok(
      log.views.every(
        (v) => JSON.stringify(v.dials) === JSON.stringify(FULL_PLAN),
      ),
    );
    const dials = report(out).runs[0].dials;
    assert.deepEqual(dials.requested, FULL_PLAN);
    assert.deepEqual(dials.observed, GOOD);
    assert.deepEqual(dials.observedAtEnd, GOOD);
    assert.ok(dials.url.endsWith("&offline=true"));
  }));

test("dials: a scene that reads back a different wind is a dial-not-applied refusal (exit 3) before any capture", () =>
  withLaneTmp("weather-map-pins-", async (root) => {
    const { code, out, log } = await drive(root, ["--cloud-wind-speed", "0"], {
      readback: (plan) => ({ ...echoReadback(plan), cloudWindSpeed: 15 }),
    });
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const r = refusal(out);
    assert.equal(r.reason, "dial-not-applied");
    assert.deepEqual(r.details.mismatches, [
      { dial: "cloudWindSpeed", requested: 0, observed: 15 },
    ]);
    assert.equal(log.shots, 0);
  }));

test("dials: an offline globe that still has imagery is refused, naming the dial", () =>
  withLaneTmp("weather-map-pins-", async (root) => {
    const { code, out } = await drive(root, ["--offline-globe"], {
      readback: (plan) => ({ ...echoReadback(plan), imageryLayerCount: 1 }),
    });
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.match(refusal(out).message, /offlineGlobe\.imageryLayerCount/);
  }));

test("dials: a dial that takes at first and is dropped later refuses at the view that saw it", () =>
  withLaneTmp("weather-map-pins-", async (root) => {
    const { code, out, log } = await drive(root, ["--cloud-quality", "32"], {
      readback: (plan, call) => ({
        ...echoReadback(plan),
        cloudQuality: call < 5 ? 32 : 64,
      }),
    });
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(refusal(out).reason, "dial-not-applied");
    assert.equal(log.views.length, 6);
  }));

test("dials: a page that answers nothing for the requested dials is refused, not trusted", () =>
  withLaneTmp("weather-map-pins-", async (root) => {
    const { code, out } = await drive(root, ["--cloud-wind-speed", "0"], {
      readback: () => null,
    });
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(refusal(out).reason, "dial-not-applied");
  }));

test("work budget: still covers the 600 s base plus a pipeline wait for the first capture and for each of the re-settles", () => {
  assert.ok(
    descriptor.workBudgetMs() >=
      600_000 + 3 * PIPELINE_WAIT_DEFAULTS.deadlineMs,
  );
});
