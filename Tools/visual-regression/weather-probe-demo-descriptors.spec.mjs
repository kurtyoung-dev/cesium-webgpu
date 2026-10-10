// weather-probe-demo-descriptors.spec.mjs — walks the migrated weather probes
// that capture through the runtime's element seam (map, presets, inspector)
// end to end with a stub browser. Pure Node.
// @purpose Drives the map, Weather Inspector preset and Weather Inspector control probes' runtime descriptors through the real runProbe with a stub browser whose canvas captures are fixture PNGs, asserting exit codes, verdict ids, that the Node-side metrics read the captured bytes, that the map probe strips the viewer chrome before its first capture, and that every scored gate of the three fails on a fixture of its own.
// @status ACTIVE
//
// The sibling `weather-probe-descriptors.spec.mjs` covers the pinned legs,
// whose page lanes capture in the page. These three take the runtime's
// element capture (`captureElement`) and reduce its PNG in Node, so here the
// stub page answers `locator(...).screenshot()` with a flat frame whose value
// the probe's own page calls chose: a lane records what the probe set on the
// page (the weather map on or off, the preset clicked, the slider moved), and
// the screenshot draws it. No number in this file is evidence about the
// engine; what is proved is that the probes reach their gates through the
// seam and the shared metrics.
//
// GATE INERTNESS. The last section calls each probe's exported scorer
// directly: one healthy input, then one row per scored gate whose input fails
// exactly the gates it names. A gate whose pass flag were stuck at true would
// leave its row's failing set short, so every gate has a test that notices.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";
import {
  descriptor as inspectorDescriptor,
  scoreInspector,
} from "./probe-weather-inspector.mjs";
import { descriptor as mapDescriptor, scoreMap } from "./probe-weather-map.mjs";
import {
  descriptor as presetsDescriptor,
  scorePresets,
} from "./probe-weather-presets.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SIZE = 20;

/**
 * A PNG whose rows above `brightRows` (a fraction of the height) carry
 * `value` and the rest `under`. Flat when the two agree.
 */
function framePng(value, { under = value, brightRows = 1 } = {}) {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    const v = y < SIZE * brightRows ? value : under;
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      pixels[i] = v;
      pixels[i + 1] = v;
      pixels[i + 2] = v;
      pixels[i + 3] = 255;
    }
  }
  return Buffer.from(encodeRgbaPng(pixels, SIZE, SIZE));
}

/**
 * @param {{calls: string[]}} log
 * @param {{lanes: Array<{marker: string, respond: Function}>,
 *   screenshot: Function}} setup Page functions by a marker their source
 *   carries, and `screenshot(state)` for an element capture of the canvas.
 */
function fakePage(log, { lanes, screenshot }) {
  const state = {};
  return {
    on() {},
    async addInitScript() {},
    async addStyleTag() {},
    async goto(url) {
      log.calls.push(`goto:${url}`);
    },
    async waitForFunction() {},
    async waitForTimeout() {},
    async close() {},
    locator(selector) {
      return {
        count: async () => 1,
        screenshot: async () => {
          log.calls.push(`shot:${selector}`);
          return screenshot(state);
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
      for (const lane of lanes) {
        if (source.includes(lane.marker)) {
          log.calls.push(`lane:${lane.marker}`);
          return lane.respond(arg, state);
        }
      }
      throw new Error(`unstubbed page.evaluate: ${source.slice(0, 160)}`);
    },
  };
}

async function drive(descriptor, root, setup) {
  const out = path.join(root, "out");
  const log = { calls: [], launches: 0 };
  const code = await runProbe(descriptor, {
    argv: ["--repository-root", root, "--output", out, "--no-serve-built"],
    now: () => Date.UTC(2026, 8, 26, 23, 0, 0),
    launch: async () => {
      log.launches += 1;
      let connected = true;
      return {
        isConnected: () => connected,
        async newPage() {
          return fakePage(log, setup);
        },
        async close() {
          connected = false;
        },
      };
    },
  });
  return { code, out, log };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function failing(verdicts) {
  return verdicts.filter((v) => v.pass !== true).map((v) => v.id);
}

// ---------------------------------------------------------------------------
// map
// ---------------------------------------------------------------------------

/** A selector only the widget-strip source carries. */
const STRIP_MARKER = ".cesium-navigation-help";

/** True when the widget strip ran, and ran before the first element capture. */
function stripPrecedesFirstShot(calls) {
  const strip = calls.indexOf(`lane:${STRIP_MARKER}`);
  const shot = calls.findIndex((c) => c.startsWith("shot:"));
  return strip !== -1 && shot !== -1 && strip < shot;
}

/**
 * Map OFF: the top 40% bright at every location (the 20x20 window reads rows
 * 4, 7, 10 and 13 — the bound `y < 0.8 * height` is exclusive — so two of
 * four rows: 0.5). Map ON: fully bright at even longitudes and dark at odd
 * ones, unless `onLikeOff`. The strip lane answers the widget removal the way
 * `lib/strip-viewer-widgets.mjs` reports it; `leftovers` names what it could
 * not clear.
 */
function mapSetup({ onLikeOff = false, leftovers = [] } = {}) {
  return {
    lanes: [
      {
        marker: "cloudWeatherMap = weatherOn",
        respond: (cfg, state) => {
          Object.assign(state, cfg);
        },
      },
      {
        marker: STRIP_MARKER,
        respond: () => ({ removed: 7, leftovers }),
      },
    ],
    screenshot: (state) => {
      if (!state.weatherOn || onLikeOff) {
        return framePng(200, { under: 30, brightRows: 0.4 });
      }
      return framePng(Math.abs(state.lon) % 2 === 0 ? 200 : 30);
    },
  };
}

test("map: a map that carves regions exits 0 on five gates, from twenty-two element captures", () =>
  withLaneTmp("weather-desc-map-", async (root) => {
    const { code, out, log } = await drive(mapDescriptor, root, mapSetup());
    assert.equal(code, PROBE_EXIT_CODES.OK);
    assert.ok(
      log.calls.some((c) =>
        c.endsWith("/Apps/CesiumViewer/index.html?renderer=webgpu"),
      ),
    );
    assert.equal(log.calls.filter((c) => c.startsWith("shot:")).length, 22);
    assert.ok(
      stripPrecedesFirstShot(log.calls),
      "the viewer widgets are stripped before the first element capture",
    );
    assert.equal(
      log.calls.filter((c) => c === `lane:${STRIP_MARKER}`).length,
      1,
      "once per run",
    );
    const report = readJson(path.join(out, "weather-map-report.json"));
    const run = report.runs[0];
    assert.equal(run.chromeRemoved, 7, "the strip's count is in the receipt");
    assert.deepEqual(run.chromeLeftovers, []);
    assert.deepEqual(
      run.scored.checks.map(([id]) => id),
      ["off-renders", "on-dense", "on-carves", "on-range", "clean"],
    );
    assert.ok(run.scored.stats.offFracs.every((f) => f === 0.5));
    const runtime = readJson(path.join(out, "weather-map-runtime.json"));
    assert.ok(
      runtime.captures.some((c) => c.name === "weather-map-wide-on"),
      "the wide views are banked through the seam",
    );
  }));

test("map: a map that changes nothing fails the carve and range gates", () =>
  withLaneTmp("weather-desc-map-", async (root) => {
    const { code, out } = await drive(
      mapDescriptor,
      root,
      mapSetup({ onLikeOff: true }),
    );
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const runtime = readJson(path.join(out, "weather-map-runtime.json"));
    assert.deepEqual(failing(runtime.verdicts), ["on-carves", "on-range"]);
  }));

test("map: chrome still over the canvas after the strip is a refusal, before any capture", () =>
  withLaneTmp("weather-desc-map-", async (root) => {
    const { code, out, log } = await drive(
      mapDescriptor,
      root,
      mapSetup({ leftovers: ["cesium-viewer-toolbar"] }),
    );
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(log.calls.filter((c) => c.startsWith("shot:")).length, 0);
    const refusal = readJson(path.join(out, "weather-map-refusal.json"));
    assert.equal(refusal.refusal.reason, "viewer-chrome-over-canvas");
    assert.match(refusal.refusal.message, /cesium-viewer-toolbar/);
  }));

test("map INERTNESS: with the strip call unreachable, the strip-before-capture order goes red", () =>
  withLaneTmp("weather-desc-map-", async (root) => {
    const mutated = await importMutated(
      path.join(HERE, "probe-weather-map.mjs"),
      [
        [
          "chrome = await page.evaluate(`(${STRIP_WIDGETS_SOURCE})()`);",
          "chrome = { removed: 0, leftovers: [] };",
        ],
      ],
    );
    const { code, log } = await drive(mutated.descriptor, root, mapSetup());
    assert.equal(code, PROBE_EXIT_CODES.OK, "the mutant still measures");
    assert.equal(log.calls.filter((c) => c.startsWith("shot:")).length, 22);
    assert.equal(stripPrecedesFirstShot(log.calls), false);
  }));

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

const PRESET_LUMA = {
  FEWcu: 158,
  SCTcu: 150,
  BKNsc: 146,
  OVCst: 130,
  Ns: 120,
  Cb: 110,
  Ci: 155,
  SKC: 160,
};

function presetsSetup({ boot = { ok: true }, luma = PRESET_LUMA } = {}) {
  return {
    lanes: [
      { marker: "window.startup", respond: () => boot },
      {
        marker: "el.click()",
        respond: (arg, state) => {
          state.preset = arg.id.replace("wi-preset-", "");
          return { ok: true };
        },
      },
    ],
    screenshot: (state) => framePng(luma[state.preset]),
  };
}

test("presets: the okta ladder exits 0 on seven gates from eight element captures", () =>
  withLaneTmp("weather-desc-presets-", async (root) => {
    const { code, out, log } = await drive(
      presetsDescriptor,
      root,
      presetsSetup(),
    );
    assert.equal(code, PROBE_EXIT_CODES.OK);
    assert.equal(log.calls.filter((c) => c.startsWith("shot:")).length, 8);
    const report = readJson(path.join(out, "weather-presets-report.json"));
    assert.equal(report.runs[0].stats.SKC.lum, 160);
    assert.equal(report.runs[0].diffs.skcOvc, 30);
    assert.deepEqual(
      report.verdicts.map((v) => v.id),
      [
        "skc-open",
        "ovc-darkens",
        "storm-darkest",
        "okta-ladder",
        "skc-vs-ovc",
        "few-vs-cb",
        "clean",
      ],
    );
    assert.ok(fs.existsSync(path.join(out, "weather-preset-skc.png")));
  }));

test("presets: a clear sky that reads dim fails the open-sky gate only", () =>
  withLaneTmp("weather-desc-presets-", async (root) => {
    const { code, out } = await drive(
      presetsDescriptor,
      root,
      presetsSetup({ luma: { ...PRESET_LUMA, SKC: 140 } }),
    );
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const report = readJson(path.join(out, "weather-presets-report.json"));
    assert.deepEqual(failing(report.verdicts), ["skc-open"]);
  }));

test("presets: a demo that does not boot is a refusal, not a measurement", () =>
  withLaneTmp("weather-desc-presets-", async (root) => {
    const { code, out, log } = await drive(
      presetsDescriptor,
      root,
      presetsSetup({ boot: { ok: false, err: "startup threw" } }),
    );
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(log.calls.filter((c) => c.startsWith("shot:")).length, 0);
    const refusal = readJson(path.join(out, "weather-presets-refusal.json"));
    assert.equal(refusal.refusal.reason, "demo-boot-failed");
  }));

// ---------------------------------------------------------------------------
// inspector
// ---------------------------------------------------------------------------

function inspectorSetup({ readBack = 0.98 } = {}) {
  return {
    lanes: [
      { marker: "window.startup", respond: () => ({ ok: true }) },
      {
        marker: "#weatherPanel .row",
        respond: () => ({ rows: 16, presets: 8, groups: 8 }),
      },
      {
        marker: 'dispatchEvent(new Event("input"',
        respond: (arg, state) => {
          state.coverage = arg.value;
          return { ok: true, value: String(arg.value) };
        },
      },
      {
        marker: "el.click()",
        respond: (arg, state) => {
          state.preset = arg.id;
          return { ok: true };
        },
      },
      { marker: "Number(el.value)", respond: () => readBack },
    ],
    screenshot: (state) =>
      framePng(state.preset ? 100 : state.coverage ? 150 : 200),
  };
}

test("inspector: the panel, the slider and the preset exit 0 on six gates", () =>
  withLaneTmp("weather-desc-inspector-", async (root) => {
    const { code, out } = await drive(
      inspectorDescriptor,
      root,
      inspectorSetup(),
    );
    assert.equal(code, PROBE_EXIT_CODES.OK);
    const report = readJson(path.join(out, "weather-inspector-report.json"));
    const run = report.runs[0];
    assert.equal(run.defStats.cloudPct, 100);
    assert.equal(run.covDiff, 50);
    assert.equal(run.stormyDiff, 100);
    assert.deepEqual(
      report.verdicts.map((v) => v.id),
      [
        "panel",
        "default-clouds",
        "coverage-slider",
        "ovc-changes-sky",
        "ovc-refreshes-ui",
        "clean",
      ],
    );
  }));

test("inspector: a preset that leaves the slider unrefreshed fails that gate only", () =>
  withLaneTmp("weather-desc-inspector-", async (root) => {
    const { code, out } = await drive(
      inspectorDescriptor,
      root,
      inspectorSetup({ readBack: 0.45 }),
    );
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const report = readJson(path.join(out, "weather-inspector-report.json"));
    assert.deepEqual(failing(report.verdicts), ["ovc-refreshes-ui"]);
  }));

// ---------------------------------------------------------------------------
// gate inertness: every scored gate fails on a fixture of its own
// ---------------------------------------------------------------------------

/** The ids of the checks whose pass flag is not true, in check order. */
function failingIds(checks) {
  return checks.filter(([, , pass]) => pass !== true).map(([id]) => id);
}

/**
 * Assert the healthy input fails nothing, each row fails exactly the gates it
 * names, and the rows between them name every gate the scorer emits.
 */
function assertGateTable(score, healthy, rows) {
  const ids = score(healthy).map(([id]) => id);
  assert.deepEqual(failingIds(score(healthy)), [], "the healthy input");
  for (const [gates, over] of rows) {
    assert.deepEqual(
      failingIds(score({ ...healthy, ...over })),
      gates,
      `row for ${gates.join(" + ")}`,
    );
  }
  assert.deepEqual(
    [...new Set(rows.flatMap(([gates]) => gates))].sort(),
    [...ids].sort(),
    "every gate has a row",
  );
}

const alternating = (a, b) =>
  Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b));

test("map gates: the healthy input passes all five, and each row fails exactly its own gate", () =>
  assertGateTable(
    ({ off, on, errors }) => scoreMap(off, on, errors).checks,
    { off: Array(10).fill(0.5), on: alternating(0.9, 0), errors: [] },
    [
      [["off-renders"], { off: Array(10).fill(0.08) }],
      [["on-dense"], { on: alternating(0.25, 0) }],
      [["on-carves"], { on: alternating(0.9, 0.3) }],
      [["on-range"], { off: alternating(0.11, 1), on: alternating(0.85, 0) }],
      [["clean"], { errors: ["GPUValidationError: stub"] }],
    ],
  ));

const PRESET_STATS = Object.fromEntries(
  Object.entries(PRESET_LUMA).map(([key, lum]) => [key, { lum, cloudPct: 0 }]),
);

/** Presets input with one preset's wedge luma replaced. */
const presetLum = (key, lum) => ({
  stats: { ...PRESET_STATS, [key]: { lum, cloudPct: 0 } },
});

test("presets gates: the healthy input passes all seven, and each row fails exactly its own gate", () =>
  assertGateTable(
    ({ stats, diffs, errors }) => scorePresets(stats, diffs, errors),
    { stats: PRESET_STATS, diffs: { skcOvc: 30, fewCb: 48 }, errors: [] },
    [
      [["skc-open"], presetLum("SKC", 145)],
      [["ovc-darkens"], presetLum("OVCst", 146)],
      [["storm-darkest"], presetLum("Ns", 141)],
      [["storm-darkest"], presetLum("Cb", 141)],
      // Each half of the ladder on its own: broken too close to clear, then
      // broken too close to the storm decks.
      [["okta-ladder"], presetLum("BKNsc", 155)],
      [["okta-ladder"], presetLum("BKNsc", 123)],
      [["skc-vs-ovc"], { diffs: { skcOvc: 3, fewCb: 48 } }],
      [["few-vs-cb"], { diffs: { skcOvc: 30, fewCb: 3 } }],
      [["clean"], { errors: ["GPUValidationError: stub"] }],
    ],
  ));

test("inspector gates: the healthy input passes all six, and each row fails exactly its own gate", () =>
  assertGateTable(
    scoreInspector,
    {
      panelInfo: { rows: 16, presets: 8, groups: 8 },
      defStats: { cloudPct: 10 },
      setCov: { ok: true },
      covDiff: 5,
      stormyDiff: 5,
      covAfterPreset: 0.98,
      errors: [],
    },
    [
      [["panel"], { panelInfo: { rows: 14, presets: 8, groups: 8 } }],
      [["panel"], { panelInfo: { rows: 16, presets: 7, groups: 8 } }],
      [["panel"], { panelInfo: { rows: 16, presets: 8, groups: 6 } }],
      [["default-clouds"], { defStats: { cloudPct: 2 } }],
      [["coverage-slider"], { setCov: { ok: false } }],
      [["coverage-slider"], { covDiff: 0.5 }],
      [["ovc-changes-sky"], { stormyDiff: 1 }],
      [["ovc-refreshes-ui"], { covAfterPreset: 0.9 }],
      [["ovc-refreshes-ui"], { covAfterPreset: null }],
      [["clean"], { errors: ["GPUValidationError: stub"] }],
    ],
  ));
