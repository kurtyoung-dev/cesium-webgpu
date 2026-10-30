// cpu-profile-delta.spec.mjs - Pure Node contract spec for lib/metrics/cpu-profile-delta.mjs (no browser).
// @purpose Asserts lib/metrics/cpu-profile-delta.mjs crops self time to a page-time window through the calibration mark, keys functions by bundled module (never bundle line), refuses an uncalibrated profile, ranks AFTER-minus-BEFORE deltas with per-run values, and that the window clause is live (inertness mutant).
// @status ACTIVE

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as metric from "./lib/metrics/cpu-profile-delta.mjs";
import { importMutated } from "./lib/import-mutated.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_URL = "http://localhost:8094/Build/CesiumUnminified/index.js";
const BUNDLE = [
  "// prelude",
  "// packages/engine/Source/Scene/Globe.js",
  "function Globe() {}",
  "// packages/engine/Source/Scene/GlobeWater.js",
  "function GlobeWater() {}",
].join("\n");

// Page time 0 maps to profile time 1,000,000 us. One sample per 1 ms:
//   page 0-9 ms Globe (line 2); 10-19 ms GlobeWater (line 4);
//   20-29 ms (idle); 30-35 ms the calibration mark (and `now` under it).
function profileWith() {
  const frame = (functionName, url, lineNumber) => ({
    functionName,
    url,
    lineNumber,
  });
  const nodes = [
    { id: 1, callFrame: frame("(root)", "", -1), children: [2, 3, 4, 5] },
    { id: 2, callFrame: frame("Globe", BUNDLE_URL, 2) },
    { id: 3, callFrame: frame("GlobeWater", BUNDLE_URL, 4) },
    { id: 4, callFrame: frame("(idle)", "", -1) },
    { id: 5, callFrame: frame("__cpuProfileClockMark", "", 0), children: [6] },
    { id: 6, callFrame: frame("now", "", -1) },
  ];
  const samples = [];
  for (let ms = 0; ms < 36; ms++) {
    samples.push(ms < 10 ? 2 : ms < 20 ? 3 : ms < 30 ? 4 : ms % 2 ? 6 : 5);
  }
  const timeDeltas = samples.map((_, i) => (i === 0 ? 0 : 1000));
  return { nodes, samples, timeDeltas, startTime: 1000000, endTime: 1036000 };
}
const calibration = {
  functionName: "__cpuProfileClockMark",
  pageStartMs: 30,
  pageEndMs: 35,
};
const moduleIndexByPath = {
  "Build/CesiumUnminified/index.js": metric.bundleModuleIndex(BUNDLE),
};

test("the window keeps only the samples inside it, through the calibration offset", () => {
  const r = metric.selfTimeInWindow(profileWith(), {
    calibration,
    windowStartMs: 10,
    windowEndMs: 20,
    moduleIndexByPath,
  });
  assert.equal(r.calibrated, true);
  assert.ok(Math.abs(r.offsetUs - 1000000) <= 500, String(r.offsetUs));
  assert.equal(Math.round(r.totalMs), 10);
  assert.deepEqual(Object.keys(r.byFunction), [
    "GlobeWater @ packages/engine/Source/Scene/GlobeWater.js",
  ]);
  assert.equal(
    Math.round(r.byModule["packages/engine/Source/Scene/GlobeWater.js"]),
    10,
  );
});

test("function keys carry the module, not the bundle line; idle is its own category", () => {
  const r = metric.selfTimeInWindow(profileWith(), {
    calibration,
    windowStartMs: 0,
    windowEndMs: 30,
    moduleIndexByPath,
  });
  assert.ok(r.byFunction["Globe @ packages/engine/Source/Scene/Globe.js"] > 9);
  assert.ok(r.byCategory["(idle)"] > 9);
  assert.ok(!Object.keys(r.byFunction).some((key) => /:\d+$/.test(key)));
});

test("a module esbuild marks relative to the bundle root starts its own module", () => {
  const index = metric.bundleModuleIndex(
    [
      "// packages/engine/Source/DataSources/CallbackPositionProperty.js",
      "function a() {}",
      "// ../cesium-webgpu/node_modules/dompurify/dist/purify.es.mjs",
      "function createDOMPurify() {}",
    ].join("\n"),
  );
  assert.equal(
    metric.moduleForLine(index, 3),
    "node_modules/dompurify/dist/purify.es.mjs",
  );
});

test("an uncalibrated profile is refused, never read against a guessed origin", () => {
  const r = metric.selfTimeInWindow(profileWith(), {
    calibration: null,
    windowStartMs: 0,
    windowEndMs: 20,
  });
  assert.equal(r.calibrated, false);
});

test("top deltas rank by |delta| and carry per-run values and consistency", () => {
  const run = (g, w) => ({ byModule: { G: g, W: w } });
  const rows = metric.topDeltas({
    before: [run(10, 1), run(12, 1)],
    after: [run(11, 30), run(11, 40)],
    level: "byModule",
    limit: 2,
  });
  assert.equal(rows[0].key, "W");
  assert.equal(rows[0].deltaMs, 34);
  assert.deepEqual(rows[0].afterRuns, [30, 40]);
  assert.equal(rows[0].consistent, "2/2");
});

test("INERTNESS: with the window clause unreachable the crop assertions go red", async () => {
  const mutated = await importMutated(
    path.join(here, "lib/metrics/cpu-profile-delta.mjs"),
    [
      [
        "if (at < startUs || at >= endUs) {",
        "if (false && (at < startUs || at >= endUs)) {",
      ],
    ],
  );
  const r = mutated.selfTimeInWindow(profileWith(), {
    calibration,
    windowStartMs: 10,
    windowEndMs: 20,
    moduleIndexByPath,
  });
  assert.notEqual(Math.round(r.totalMs), 10);
  assert.notDeepEqual(Object.keys(r.byFunction), [
    "GlobeWater @ packages/engine/Source/Scene/GlobeWater.js",
  ]);
});
