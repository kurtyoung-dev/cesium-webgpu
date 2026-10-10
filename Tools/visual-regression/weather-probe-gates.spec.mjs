// weather-probe-gates.spec.mjs — every scored gate of the five pinned weather
// probes fails on a fixture of its own. Pure Node.
// @purpose Drives the channels, coverage-sweep (edr-mock), ingest, metar and seam-poles descriptors through the real runProbe with one healthy lane answer and one perturbed answer per scored gate, asserting exit 1 and the exact set of failing gates, so a gate whose pass flag were stuck at true is a red test.
// @status ACTIVE
//
// WHY. `weather-probe-descriptors.spec.mjs` proves the migration: healthy runs
// exit 0, one representative failure per probe exits 1, refusals exit 3. It
// does not give every gate a failing input, so a gate made inert (its pass
// flag forced true) survived it for 24 of the 34 pinned gates. Each row here
// perturbs the healthy answer just enough to fail the gates it names and
// asserts the failing set EXACTLY: a stuck gate leaves its row's set short.
//
// The lane answers and the stub browser are `lib/weather-lane-fixtures.mjs`,
// the same ones the descriptor spec drives; `pageErrors` puts one uncaught
// page error in front of the probe so its `clean` gate has a failing input.
// No number here is evidence about the engine.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { PROBE_EXIT_CODES } from "./lib/probe-runtime.mjs";
import {
  CHANNELS_MARKER,
  COVERAGE_MARKER,
  INGEST_MARKER,
  METAR_SETUP_MARKER,
  METAR_SWEEPS_MARKER,
  SEAM_CAPTURE_MARKER,
  SEAM_SETUP_MARKER,
  channelsLane,
  coverageLane,
  drive,
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

/**
 * `lanes` with the answer of the lane carrying `marker` passed through
 * `mutate(answer, arg)` on a deep copy, so the healthy builder is untouched.
 */
function perturb(lanes, marker, mutate) {
  return lanes.map((lane) =>
    lane.marker !== marker
      ? lane
      : {
          marker,
          respond: (arg) => {
            const answer = structuredClone(lane.respond(arg));
            mutate(answer, arg);
            return answer;
          },
        },
  );
}

/** Force the WebGL fallback on a lane answer that carries the pins. */
function webglPins(answer) {
  answer.pins.rendererType = "webgl";
  answer.pins.isWebGPU = false;
}

const PAGE_ERROR = { pageErrors: ["TypeError: stub page error"] };

/**
 * Run one row and return its exit code, the verdict ids and the failing ids.
 */
async function runRow(descriptor, lanes, pageOptions = {}) {
  return withLaneTmp("weather-gates-", async (root) => {
    const { code, out } = await drive(descriptor, root, lanes, [], pageOptions);
    const runtimeFile = path.join(out, `${descriptor.name}-runtime.json`);
    const verdicts =
      code === PROBE_EXIT_CODES.REFUSAL ? [] : readJson(runtimeFile).verdicts;
    return {
      code,
      ids: verdicts.map((v) => v.id),
      failing: verdicts.filter((v) => v.pass !== true).map((v) => v.id),
    };
  });
}

/**
 * The healthy lanes exit 0; every row exits 1 failing exactly its gates; and
 * the rows between them name every gate the healthy run scored.
 */
async function assertGateTable(descriptor, healthy, rows) {
  const base = await runRow(descriptor, healthy);
  assert.equal(base.code, PROBE_EXIT_CODES.OK, "the healthy lanes");
  assert.deepEqual(base.failing, []);
  for (const [gates, lanes, pageOptions] of rows) {
    const row = await runRow(descriptor, lanes, pageOptions);
    assert.equal(
      row.code,
      PROBE_EXIT_CODES.FAILURE,
      `row ${gates.join(" + ")}`,
    );
    assert.deepEqual(row.failing, gates, `row ${gates.join(" + ")}`);
  }
  assert.deepEqual(
    [...new Set(rows.flatMap(([gates]) => gates))].sort(),
    [...base.ids].sort(),
    "every gate has a row",
  );
}

test("coverage sweep (edr-mock) gates: each fails on its own row", async () => {
  const healthy = [{ marker: COVERAGE_MARKER, respond: coverageLane() }];
  const edit = (mutate) => perturb(healthy, COVERAGE_MARKER, mutate);
  await assertGateTable(edrDescriptor, healthy, [
    [["backend-webgpu"], edit(webglPins)],
    [["url"], edit((a) => (a.sourceUrl = "http://elsewhere.invalid/x"))],
    [["fetched"], edit((a) => (a.providerState.hasData = false))],
    [["fetched"], edit((a) => (a.providerState.version = 0))],
    [["fetched"], edit((a) => (a.providerState.lastError = "fallback"))],
    [
      ["pattern"],
      [
        {
          marker: COVERAGE_MARKER,
          respond: coverageLane({ fracsA: Array(9).fill(0.5) }),
        },
      ],
    ],
    [["clean"], healthy, PAGE_ERROR],
  ]);
});

test("channels gates: each fails on its own row", async () => {
  const lanes = (options) => [
    { marker: CHANNELS_MARKER, respond: channelsLane(options) },
  ];
  const healthy = lanes();
  const edit = (mutate) => perturb(healthy, CHANNELS_MARKER, mutate);
  // Spread alone: the rich sweep's stddev (0.0283) sits under the R-only
  // control's (0.0199) plus the 0.01 margin, while west < east - 0.02 and the
  // gated leg (equal to the control) still collapse toward it.
  const flat = [0.48, 0.52, 0.48, 0.52, 0.48, 0.52, 0.48, 0.52, 0.48];
  await assertGateTable(channelsDescriptor, healthy, [
    [["backend-webgpu"], edit(webglPins)],
    [["deck"], edit((a) => (a.richState.hasData = false))],
    [["deck"], edit((a) => (a.richState.version = 0))],
    // Mean 0.0167 under the 0.02 bar; stddev 0.0333 still clears the spread.
    [["present"], lanes({ rich: [0, 0, 0, 0, 0, 0, 0, 0.05, 0.1] })],
    [
      ["spread"],
      lanes({
        rich: [0.44, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.56],
        neutral: flat,
        richOff: flat,
      }),
    ],
    [
      ["west-east"],
      lanes({ rich: [0.95, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.05] }),
    ],
    [
      ["gated"],
      lanes({ richOff: [0.05, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.95] }),
    ],
    [["clean"], healthy, PAGE_ERROR],
  ]);
});

test("ingest gates: each fails on its own row", async () => {
  const lanes = (options) => [
    { marker: INGEST_MARKER, respond: ingestLane(options) },
  ];
  const healthy = lanes();
  const edit = (mutate) => perturb(healthy, INGEST_MARKER, mutate);
  await assertGateTable(ingestDescriptor, healthy, [
    [["backend-webgpu"], edit(webglPins)],
    [["api"], edit((a) => (a.api.hasProvider = false))],
    [["api"], edit((a) => (a.api.hasEdr = false))],
    [["api"], edit((a) => (a.api.hasSynthetic = false))],
    [["api"], edit((a) => (a.api.hasPacker = false))],
    [
      ["edr-url"],
      edit((a) => (a.edrUrl = a.edrUrl.replace("/cube?", "/items?"))),
    ],
    [["fetched"], edit((a) => (a.states.hi.hasData = false))],
    [["fetched"], edit((a) => (a.states.hi.version = 0))],
    // A deck at or under the 5 % bar cannot clear by 5 points either.
    [["deck", "clears"], lanes({ hiA: 4, hiB: 4, lo: 2 })],
    [["clears"], lanes({ lo: 38 })],
    [["clean"], healthy, PAGE_ERROR],
  ]);
});

test("metar gates: each fails on its own row", async () => {
  const healthy = metarLanes();
  const setup = (mutate) => perturb(healthy, METAR_SETUP_MARKER, mutate);
  // The spatial pair: the cloudy station (lon 0, a saturation witness the
  // aim never scores) read as clear on both strength-1 sweeps, so the
  // determinism control still reproduces.
  const cloudyReadsClear = perturb(healthy, METAR_SWEEPS_MARKER, (a) => {
    for (const sweep of [a.sweeps.ch1A, a.sweeps.ch1B]) {
      for (const capture of sweep.captures) {
        if (capture.lon === 0) capture.frac = 0.02;
      }
    }
  });
  await assertGateTable(metarDescriptor, healthy, [
    [["backend-webgpu"], setup(webglPins)],
    [["caps"], setup((a) => (a.caps.capId = "metar:other"))],
    [["caps"], setup((a) => (a.caps.supportsTime = true))],
    [["fetched"], setup((a) => (a.providerState.hasData = false))],
    [["fetched"], setup((a) => (a.providerState.lastError = "fallback"))],
    [["spatial"], cloudyReadsClear],
    [["channels"], metarLanes({ bandOn: 0.5 })],
    [["clean"], healthy, PAGE_ERROR],
  ]);
});

test("seam-poles gates: each fails on its own row", async () => {
  const healthy = seamLanes();
  // The pre-fix pole signature on the SOUTH pole only: one dark sector on a
  // ring of 60 and a 250 hot pixel in the block's corner.
  const southSpoked = perturb(healthy, SEAM_CAPTURE_MARKER, (a, cfg) => {
    if (cfg.tag !== "spole") return;
    a.ring = [...Array(11).fill(60), 0];
    a.center = Array(81).fill(52);
    a.center[0] = 250;
  });
  await assertGateTable(seamDescriptor, healthy, [
    // The page error reaches both pages, so it fails both console gates.
    [["webgl-load", "webgpu-clean"], healthy, PAGE_ERROR],
    [["backend-webgpu"], perturb(healthy, SEAM_SETUP_MARKER, webglPins)],
    [["deq-wall", "deq-step"], seamLanes({ wall: true })],
    [["npole-ring", "npole-centre"], seamLanes({ spokes: true })],
    [["spole-ring", "spole-centre"], southSpoked],
  ]);
});
