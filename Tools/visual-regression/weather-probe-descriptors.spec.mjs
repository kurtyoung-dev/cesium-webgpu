// weather-probe-descriptors.spec.mjs — walks the migrated weather probes'
// runtime descriptors end to end with a stub browser. Pure Node.
// @purpose Drives each migrated probe-weather descriptor through the real runProbe with a stub browser whose page answers the probe's own page lanes with fixture results, asserting exit 0 / 1 / 3, the verdict ids, the evidence files and the refusal record.
// @status ACTIVE
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. The probes' page lanes run in Edge
// and nothing here renders; the fixture results below stand in for what a
// lane returns, and no number in this file is evidence about the engine. What
// it proves is that the MIGRATION holds: that `runProbe` reaches each probe's
// cells, that a healthy result exits 0, that a failed gate exits 1 on the
// gate it names, that a pin that did not take or a control that did not
// reproduce exits 3 as a refusal with no receipt, that evidence PNGs land
// under the runtime's output directory with their sha256 in the runtime
// receipt, and that a WebGPU-only leg asked for WebGL refuses before any page
// work. `probe-descriptor-cells-contract.spec.mjs` is the pattern this copies.
//
// The page answers `page.evaluate` by the source of the function it is handed:
// the error gate's two functions by their `__armWebGPUDevice` / `__webgpuGate`
// markers, the capture-liveness read by `__captureLiveness`, and each probe's
// page lane by a marker its own source carries. A call nothing here models
// throws, so an unmodelled page call is a red test rather than an undefined.
// The lane answers and the stub browser live in `lib/weather-lane-fixtures.mjs`
// so `weather-probe-gates.spec.mjs` drives the same lanes; the mutant loader is
// the shared `lib/import-mutated.mjs`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { PROBE_EXIT_CODES } from "./lib/probe-runtime.mjs";
import {
  CHANNEL_LONS,
  CHANNELS_MARKER,
  COVERAGE_MARKER,
  INGEST_MARKER,
  METAR_SWEEPS_MARKER,
  SWEEP_LONS,
  channelsLane,
  coverageLane,
  drive,
  healthyDials,
  healthyPins,
  ingestLane,
  metarLanes,
  readJson,
  seamLanes,
} from "./lib/weather-lane-fixtures.mjs";
import { descriptor as channelsDescriptor } from "./probe-weather-channels.mjs";
import { descriptor as edrDescriptor } from "./probe-weather-edr-mock.mjs";
import { descriptor as ingestDescriptor } from "./probe-weather-ingest.mjs";
import { descriptor as metarDescriptor } from "./probe-weather-metar.mjs";
import { descriptor as seamDescriptor } from "./probe-weather-seam-poles.mjs";
import { descriptor as wcsDescriptor } from "./probe-weather-wcs.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// The coverage sweep: edr-mock and its WCS declaration
// ---------------------------------------------------------------------------

test("edr-mock: a healthy sweep exits 0 with its five gates, its evidence and their digests", () =>
  withLaneTmp("weather-desc-edr-", async (root) => {
    const lane = coverageLane();
    let seenCfg;
    const { code, out, log } = await drive(edrDescriptor, root, [
      {
        marker: COVERAGE_MARKER,
        respond: (cfg) => {
          seenCfg = cfg;
          return lane(cfg);
        },
      },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.OK);
    assert.equal(log.launches, 1);
    assert.ok(
      log.calls.some((c) =>
        c.endsWith(
          "/Apps/CesiumViewer/index.html?renderer=webgpu&offline=true",
        ),
      ),
      "the page is the offline WebGPU viewer on the runtime's origin",
    );
    assert.equal(seenCfg.sourceClass, "EdrWeatherSource");
    assert.equal(seenCfg.collection, "mock-gfs");
    assert.ok(seenCfg.mockBase.endsWith("/mock-edr"));
    assert.deepEqual(seenCfg.lonSweep, SWEEP_LONS);
    const report = readJson(path.join(out, "weather-edr-mock-report.json"));
    assert.deepEqual(
      report.runs[0].scored.checks.map(([id]) => id),
      ["backend-webgpu", "url", "fetched", "pattern", "clean"],
    );
    const runtime = readJson(path.join(out, "weather-edr-mock-runtime.json"));
    assert.deepEqual(runtime.captures.map((c) => c.name).sort(), [
      "weather-edr-mock-east.png",
      "weather-edr-mock-west.png",
    ]);
    for (const capture of runtime.captures) {
      assert.match(capture.sha256, /^[0-9a-f]{64}$/);
      assert.ok(fs.existsSync(path.join(out, capture.name)));
    }
    assert.equal(
      report.runs[0].result.sweeps.sweepA.captures[0].png,
      undefined,
      "the receipt keeps numbers, not base64",
    );
  }));

test("edr-mock: a flat sweep fails the pattern gate and exits 1", () =>
  withLaneTmp("weather-desc-edr-", async (root) => {
    const flat = Array(9).fill(0.4);
    flat[8] = 0.41; // east - west = 0.01 < 0.03
    const { code, out } = await drive(edrDescriptor, root, [
      { marker: COVERAGE_MARKER, respond: coverageLane({ fracsA: flat }) },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const runtime = readJson(path.join(out, "weather-edr-mock-runtime.json"));
    assert.deepEqual(
      runtime.verdicts.filter((v) => v.pass !== true).map((v) => v.id),
      ["pattern"],
    );
  }));

test("edr-mock: a pin that did not take is STRUCTURAL — exit 3, a refusal record, no receipt", () =>
  withLaneTmp("weather-desc-edr-", async (root) => {
    const { code, out } = await drive(edrDescriptor, root, [
      {
        marker: COVERAGE_MARKER,
        respond: coverageLane({ dials: healthyDials({ cloudQuality: 64 }) }),
      },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(
      fs.existsSync(path.join(out, "weather-edr-mock-report.json")),
      false,
    );
    const refusal = readJson(path.join(out, "weather-edr-mock-refusal.json"));
    assert.equal(refusal.refusal.reason, "weather-structural");
    assert.match(refusal.refusal.message, /cloudQuality round trip failed/);
  }));

test("edr-mock: a sweep that does not reproduce is STRUCTURAL even when its gates would pass", () =>
  withLaneTmp("weather-desc-edr-", async (root) => {
    const fracsA = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
    const fracsB = fracsA.map((f) => f + 0.01); // > 0.005 per location
    const { code, out } = await drive(edrDescriptor, root, [
      { marker: COVERAGE_MARKER, respond: coverageLane({ fracsA, fracsB }) },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const refusal = readJson(path.join(out, "weather-edr-mock-refusal.json"));
    assert.match(refusal.refusal.message, /sweepA vs sweepB/);
  }));

test("edr-mock: a silent WebGL fallback hard-fails the backend gate", () =>
  withLaneTmp("weather-desc-edr-", async (root) => {
    const { code, out } = await drive(edrDescriptor, root, [
      {
        marker: COVERAGE_MARKER,
        respond: coverageLane({
          pins: healthyPins({ rendererType: "webgl", isWebGPU: false }),
        }),
      },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const runtime = readJson(path.join(out, "weather-edr-mock-runtime.json"));
    assert.deepEqual(
      runtime.verdicts.filter((v) => v.pass !== true).map((v) => v.id),
      ["backend-webgpu"],
    );
  }));

test("edr-mock: asked for WebGL only, the leg refuses before opening a page", () =>
  withLaneTmp("weather-desc-edr-", async (root) => {
    const { code, log } = await drive(
      edrDescriptor,
      root,
      [],
      ["--renderer", "webgl"],
    );
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.equal(log.calls.length, 0);
  }));

test("edr-mock: --runs 3 scores every run and names each verdict by its run", () =>
  withLaneTmp("weather-desc-edr-", async (root) => {
    const { code, out, log } = await drive(
      edrDescriptor,
      root,
      [{ marker: COVERAGE_MARKER, respond: coverageLane() }],
      ["--runs", "3"],
    );
    assert.equal(code, PROBE_EXIT_CODES.OK);
    assert.equal(log.launches, 3, "one browser per run");
    const runtime = readJson(path.join(out, "weather-edr-mock-runtime.json"));
    assert.equal(runtime.verdicts.length, 15);
    assert.ok(runtime.verdicts.every((v) => /^run[012]:/.test(v.id)));
  }));

test("edr-mock INERTNESS: with the STRUCTURAL refusal unreachable, a pin that did not take stops refusing", () =>
  withLaneTmp("weather-desc-edr-", async (root) => {
    const mutated = await importMutated(
      path.join(HERE, "probe-weather-edr-mock.mjs"),
      [
        [
          "if (scored.structural.length > 0) {",
          "if (false && scored.structural.length > 0) {",
        ],
      ],
    );
    const { code } = await drive(mutated.descriptor, root, [
      {
        marker: COVERAGE_MARKER,
        respond: coverageLane({ dials: healthyDials({ cloudQuality: 64 }) }),
      },
    ]);
    assert.notEqual(code, PROBE_EXIT_CODES.REFUSAL);
  }));

test("wcs: the declaration sweeps the WCS source through the shared lane and banks its own names", () =>
  withLaneTmp("weather-desc-wcs-", async (root) => {
    const lane = coverageLane();
    let seenCfg;
    const { code, out } = await drive(wcsDescriptor, root, [
      {
        marker: COVERAGE_MARKER,
        respond: (cfg) => {
          seenCfg = cfg;
          return lane(cfg);
        },
      },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.OK);
    assert.equal(seenCfg.sourceClass, "WcsCoveragesWeatherSource");
    assert.equal(seenCfg.collection, "gdps-cloud-cover");
    assert.ok(seenCfg.mockBase.endsWith("/mock-wcs"));
    const runtime = readJson(path.join(out, "weather-wcs-runtime.json"));
    assert.equal(runtime.probe, "weather-wcs");
    assert.deepEqual(runtime.captures.map((c) => c.name).sort(), [
      "weather-wcs-mock-east.png",
      "weather-wcs-mock-west.png",
    ]);
  }));

test("wcs: a URL without the coverage markers fails gate 1", () =>
  withLaneTmp("weather-desc-wcs-", async (root) => {
    const { code, out } = await drive(wcsDescriptor, root, [
      {
        marker: COVERAGE_MARKER,
        respond: coverageLane({
          urlSuffix: "/collections/gdps-cloud-cover/coverage?f=CoverageJSON",
        }),
      },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const runtime = readJson(path.join(out, "weather-wcs-runtime.json"));
    assert.deepEqual(
      runtime.verdicts.filter((v) => v.pass !== true).map((v) => v.id),
      ["url"],
    );
  }));

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

test("channels: a healthy run exits 0 with its seven gates and the two scored-end PNGs", () =>
  withLaneTmp("weather-desc-channels-", async (root) => {
    let seenCfg;
    const lane = channelsLane();
    const { code, out } = await drive(channelsDescriptor, root, [
      {
        marker: CHANNELS_MARKER,
        respond: (cfg) => {
          seenCfg = cfg;
          return lane(cfg);
        },
      },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.OK);
    assert.deepEqual(seenCfg.lonSweep, CHANNEL_LONS);
    const report = readJson(path.join(out, "weather-channels-report.json"));
    assert.deepEqual(
      report.runs[0].scored.checks.map(([id]) => id),
      [
        "backend-webgpu",
        "deck",
        "present",
        "spread",
        "west-east",
        "gated",
        "clean",
      ],
    );
    const runtime = readJson(path.join(out, "weather-channels-runtime.json"));
    assert.deepEqual(runtime.captures.map((c) => c.name).sort(), [
      "weather-channels-rich-lon-170.png",
      "weather-channels-rich-lon150.png",
    ]);
  }));

test("channels: a gated leg that does not collapse toward neutral fails gate 5", () =>
  withLaneTmp("weather-desc-channels-", async (root) => {
    const rich = [0.05, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.95];
    const { code, out } = await drive(channelsDescriptor, root, [
      {
        marker: CHANNELS_MARKER,
        respond: channelsLane({ richOff: rich }),
      },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const runtime = readJson(path.join(out, "weather-channels-runtime.json"));
    assert.deepEqual(
      runtime.verdicts.filter((v) => v.pass !== true).map((v) => v.id),
      ["gated"],
    );
  }));

test("channels: a gated leg whose slot 107 still reads 1 is STRUCTURAL", () =>
  withLaneTmp("weather-desc-channels-", async (root) => {
    const { code, out } = await drive(channelsDescriptor, root, [
      { marker: CHANNELS_MARKER, respond: channelsLane({ offStrength: 1 }) },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const refusal = readJson(path.join(out, "weather-channels-refusal.json"));
    assert.match(refusal.refusal.message, /weatherChannelStrength\(slot 107\)/);
  }));

// ---------------------------------------------------------------------------
// ingest
// ---------------------------------------------------------------------------

test("ingest: a healthy run exits 0 with its seven gates and both deck PNGs", () =>
  withLaneTmp("weather-desc-ingest-", async (root) => {
    const { code, out } = await drive(ingestDescriptor, root, [
      { marker: INGEST_MARKER, respond: ingestLane() },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.OK);
    const report = readJson(path.join(out, "weather-ingest-report.json"));
    assert.deepEqual(
      report.runs[0].scored.checks.map(([id]) => id),
      [
        "backend-webgpu",
        "api",
        "edr-url",
        "fetched",
        "deck",
        "clears",
        "clean",
      ],
    );
    const runtime = readJson(path.join(out, "weather-ingest-runtime.json"));
    assert.deepEqual(runtime.captures.map((c) => c.name).sort(), [
      "weather-ingest-uniform-hi.png",
      "weather-ingest-uniform-lo.png",
    ]);
  }));

test("ingest: a deck that does not clear at 0.0 fails gate 5", () =>
  withLaneTmp("weather-desc-ingest-", async (root) => {
    const { code, out } = await drive(ingestDescriptor, root, [
      { marker: INGEST_MARKER, respond: ingestLane({ lo: 38 }) },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const runtime = readJson(path.join(out, "weather-ingest-runtime.json"));
    assert.deepEqual(
      runtime.verdicts.filter((v) => v.pass !== true).map((v) => v.id),
      ["clears"],
    );
  }));

test("ingest: a bracketing control that drifts past one point is STRUCTURAL", () =>
  withLaneTmp("weather-desc-ingest-", async (root) => {
    const { code, out } = await drive(ingestDescriptor, root, [
      { marker: INGEST_MARKER, respond: ingestLane({ hiB: 42 }) },
    ]);
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const refusal = readJson(path.join(out, "weather-ingest-refusal.json"));
    assert.match(refusal.refusal.message, /hiA vs hiB/);
  }));

// ---------------------------------------------------------------------------
// metar — two page lanes with the aim between them, in Node
// ---------------------------------------------------------------------------

test("metar: a healthy run aims gate 4 from the ladder, scores it and banks its four PNGs", () =>
  withLaneTmp("weather-desc-metar-", async (root) => {
    const { code, out, log } = await drive(metarDescriptor, root, metarLanes());
    assert.equal(code, PROBE_EXIT_CODES.OK);
    assert.ok(log.calls.includes(`lane:${METAR_SWEEPS_MARKER}`));
    const report = readJson(path.join(out, "weather-metar-report.json"));
    const run = report.runs[0];
    assert.equal(run.result.aim.bandLons.length, 7);
    assert.ok(
      run.result.aim.bandLons.every((lon) => ![-60, 0, 60].includes(lon)),
      "a saturated witness was scored",
    );
    assert.deepEqual(
      run.scored.checks.map(([id]) => id),
      ["backend-webgpu", "caps", "fetched", "spatial", "channels", "clean"],
    );
    assert.equal(run.scored.stats.absDeltaSum, 0.7);
    const runtime = readJson(path.join(out, "weather-metar-runtime.json"));
    assert.deepEqual(runtime.captures.map((c) => c.name).sort(), [
      "weather-metar-channels-off.png",
      "weather-metar-channels-on.png",
      "weather-metar-clear.png",
      "weather-metar-ovc.png",
    ]);
  }));

test("metar: channels that do not move the deck fail gate 4", () =>
  withLaneTmp("weather-desc-metar-", async (root) => {
    const { code, out } = await drive(
      metarDescriptor,
      root,
      metarLanes({ bandOn: 0.5 }),
    );
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const runtime = readJson(path.join(out, "weather-metar-runtime.json"));
    assert.deepEqual(
      runtime.verdicts.filter((v) => v.pass !== true).map((v) => v.id),
      ["channels"],
    );
  }));

test("metar: a saturated ladder misses the aim — refused before the scored sweeps run", () =>
  withLaneTmp("weather-desc-metar-", async (root) => {
    const { code, out, log } = await drive(
      metarDescriptor,
      root,
      metarLanes({ calibrationFrac: 1 }),
    );
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.ok(!log.calls.includes(`lane:${METAR_SWEEPS_MARKER}`));
    const refusal = readJson(path.join(out, "weather-metar-refusal.json"));
    assert.equal(refusal.refusal.reason, "weather-aim-missed");
  }));

test("metar: a scored baseline that saturated since the aim is STRUCTURAL (P9 headroom)", () =>
  withLaneTmp("weather-desc-metar-", async (root) => {
    const { code, out } = await drive(
      metarDescriptor,
      root,
      metarLanes({ bandOff: 0.95, bandOn: 1 }),
    );
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    const refusal = readJson(path.join(out, "weather-metar-refusal.json"));
    assert.match(refusal.refusal.message, /gate 4 ch0 baseline/);
  }));

// ---------------------------------------------------------------------------
// seam-poles
// ---------------------------------------------------------------------------

test("seam-poles: a healthy run exits 0 with the WebGL arm and eight gates, banking all five views", () =>
  withLaneTmp("weather-desc-seam-", async (root) => {
    const { code, out, log } = await drive(seamDescriptor, root, seamLanes());
    assert.equal(code, PROBE_EXIT_CODES.OK);
    assert.ok(
      log.calls.some((c) => c.endsWith("index.html?renderer=webgl")),
      "the WebGL load arm ran",
    );
    const report = readJson(path.join(out, "weather-seam-poles-report.json"));
    assert.deepEqual(
      report.runs[0].scored.checks.map(([id]) => id),
      [
        "webgl-load",
        "backend-webgpu",
        "deq-wall",
        "deq-step",
        "npole-ring",
        "npole-centre",
        "spole-ring",
        "spole-centre",
        "webgpu-clean",
      ],
    );
    const runtime = readJson(path.join(out, "weather-seam-poles-runtime.json"));
    assert.deepEqual(runtime.captures.map((c) => c.name).sort(), [
      "dateline-eq-repeat.png",
      "dateline-eq.png",
      "npole-repeat.png",
      "npole.png",
      "spole.png",
    ]);
  }));

test("seam-poles: a meridian wall fails the two dateline gates", () =>
  withLaneTmp("weather-desc-seam-", async (root) => {
    const { code, out } = await drive(
      seamDescriptor,
      root,
      seamLanes({ wall: true }),
    );
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const runtime = readJson(path.join(out, "weather-seam-poles-runtime.json"));
    assert.deepEqual(
      runtime.verdicts.filter((v) => v.pass !== true).map((v) => v.id),
      ["deq-wall", "deq-step"],
    );
  }));

test("seam-poles: a pinwheel ring and an off-centre hot cluster at the north pole fail the two north-pole gates", () =>
  withLaneTmp("weather-desc-seam-", async (root) => {
    const { code, out } = await drive(
      seamDescriptor,
      root,
      seamLanes({ spokes: true }),
    );
    assert.equal(code, PROBE_EXIT_CODES.FAILURE);
    const runtime = readJson(path.join(out, "weather-seam-poles-runtime.json"));
    assert.deepEqual(
      runtime.verdicts.filter((v) => v.pass !== true).map((v) => v.id),
      ["npole-ring", "npole-centre"],
    );
  }));

test("seam-poles: a frame too clear to certify is STRUCTURAL, and --renderer webgpu skips the WebGL arm", () =>
  withLaneTmp("weather-desc-seam-", async (root) => {
    const { code, out, log } = await drive(
      seamDescriptor,
      root,
      seamLanes({ cloudFrac: 0.01 }),
      ["--renderer", "webgpu"],
    );
    assert.equal(code, PROBE_EXIT_CODES.REFUSAL);
    assert.ok(!log.calls.some((c) => c.endsWith("index.html?renderer=webgl")));
    const refusal = readJson(path.join(out, "weather-seam-poles-refusal.json"));
    assert.match(refusal.refusal.message, /too low to certify/);
  }));
