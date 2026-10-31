// landing-weather-state.spec.mjs - the W3 E-W cells inside the kit. Pure Node: no browser, no GPU.
// @purpose Asserts that the four E-W landing cells resolve to rigs that carry the camera, clock, cloud dials and viewport the W3-DAYLIGHT Edge leg's banked stage records requested, that the weather-state page steps read the managed collection before and after the deck is switched off, that the E-W identity verdict reads the pre-registered claim (WebGPU state and provider defined with the deck on and undefined after, WebGL undefined throughout, an old tree absent, a missing read NOT RUN) on synthetic reads and on the banked TIP report's numbers, and that a PF-3 reading kept unmeasured by contention from an E-W cell carries the unmeasured marker and does not fail the run while a measured over still does.
// @status ACTIVE
//
// Written from the observable contract and the banked report
// (`F:/Dev/GH/cesium-webgpu-worker-archive/lanes-2026-10-31/round3/edge/w3-daylight-20261031/TIP/ew/landing-cells-report.json`,
// pages of run 0); the figures it pins are copied from that report as fixtures
// so the spec does not read the archive.
//
// RUN: node --test Tools/visual-regression/landing-weather-state.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { landingStagePayload } from "./lib/landing-cell-stage.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  pipelineWaitPlan,
  planLandingCells,
} from "./lib/landing-cell-table.mjs";
import { makeFakeBrowser } from "./lib/landing-fake-browser.mjs";
import { compareArms, landingVerdicts } from "./lib/landing-verdicts.mjs";
import { groupArms } from "./lib/metrics/merge-landing-reports.mjs";
import {
  PROBE_EXIT_CODES,
  exitCodeForOutcome,
  isMarkedUnmeasured,
} from "./lib/probe-refusal.mjs";
import { runProbe } from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";
import {
  WEATHER_STATE_DISABLE_FRAMES,
  pageDisableManagedDeck,
  pageReadWeatherState,
  runWeatherStateSteps,
  weatherStateVerdict,
} from "./lib/weather-state-steps.mjs";
import { pfRecord } from "./fixtures/probe-landing-cells-support.mjs";
import { descriptor } from "./probe-landing-cells.mjs";

const EW_CELLS = Object.freeze([
  "E-W-ground",
  "E-W-ground-hdr",
  "E-W-30km",
  "E-W-30km-hdr",
]);

// The stage records of the banked TIP report (pages of run 0): the camera each
// page requested, the clock, the cloud truth's config and the capture size.
const BANKED = Object.freeze({
  clock: "2026-06-21T18:00:00Z",
  config: {
    cloudWeatherMap: true,
    cloudCoverage: 0.55,
    cloudDensity: 0.8,
    cloudWindSpeed: 0,
  },
  viewport: { width: 1280, height: 720 },
  ground: {
    heading: 1.5707963267948966,
    pitch: 0.2792526803190927,
    roll: 0,
    lon: -95,
    lat: 39,
    height: 800,
  },
  km30: {
    heading: 1.5707963267948966,
    pitch: -0.5235987755982988,
    roll: 0,
    lon: -95,
    lat: 39,
    height: 30000,
  },
});

// The managed-collection blocks of the banked TIP pages (run 0).
const BANKED_READS = Object.freeze({
  webgpuOn: {
    rendererType: "webgpu",
    frameNumber: 327,
    managed: {
      show: true,
      renderMode: 1,
      enableVolumetric: true,
      hasWeatherStateField: true,
      weatherState: true,
      weatherProvider: true,
    },
  },
  webgpuOff: {
    rendererType: "webgpu",
    frameNumber: 332,
    managed: {
      show: true,
      renderMode: 0,
      enableVolumetric: false,
      hasWeatherStateField: true,
      weatherState: false,
      weatherProvider: false,
    },
  },
  webglOn: {
    rendererType: "webgl",
    frameNumber: 273,
    managed: {
      show: true,
      renderMode: 1,
      enableVolumetric: true,
      hasWeatherStateField: true,
      weatherState: false,
      weatherProvider: false,
    },
  },
  webglOff: {
    rendererType: "webgl",
    frameNumber: 278,
    managed: {
      show: true,
      renderMode: 0,
      enableVolumetric: false,
      hasWeatherStateField: true,
      weatherState: false,
      weatherProvider: false,
    },
  },
});

const DISABLED = { frames: 5, enableVolumetric: false, threw: null };

const record = (renderer, on, off, extra = {}) => ({
  renderer,
  weatherStateOn: on,
  weatherDisable: DISABLED,
  weatherStateOff: off,
  ...extra,
});

const clone = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------
// W1: the cell table resolves to rigs that carry the banked stage records
// ---------------------------------------------------------------------------

test("W1: the four E-W cells are weather-state cells on rigs of the registry, off by default, not identity cells and without a pipeline wait", async () => {
  const rigs = await loadRigs();
  const byId = new Map(rigs.map((rig) => [rig.id, rig]));
  const plan = planLandingCells({ cells: EW_CELLS.join(",") }, byId);
  assert.equal(plan.length, 8, "four cells on two renderers");
  for (const cell of EW_CELLS) {
    const entry = LANDING_CELLS[cell];
    assert.equal(entry.kind, "weather-state", cell);
    assert.notEqual(entry.identity, true, cell);
    assert.ok(!DEFAULT_CELLS.includes(cell), cell);
    assert.ok(byId.has(entry.rig), `${cell}: rig ${entry.rig} is registered`);
    const pages = plan.filter((p) => p.cell === cell);
    assert.deepEqual(
      pages.map((p) => p.renderer),
      ["webgl", "webgpu"],
      cell,
    );
    assert.deepEqual(
      [...new Set(pages.map((p) => p.rigId))],
      [entry.rig],
      `${cell}: both pages stage the cell's rig`,
    );
    assert.equal(
      pipelineWaitPlan({ cells: cell }).byCell[cell],
      false,
      `${cell} waits for no pipelines by default (the W3 job's pages carried no wait record)`,
    );
  }
  assert.deepEqual(
    EW_CELLS.map((cell) => LANDING_CELLS[cell].rig),
    ["w3-ew-ground", "w3-ew-ground-hdr", "w3-ew-30km", "w3-ew-30km-hdr"],
  );
});

test("W2: each E-W rig stages the camera, clock, cloud dials and viewport the banked stage records requested; the HDR sibling differs by the HDR dial alone and the 30 km one by the camera alone", async () => {
  const rigs = await loadRigs();
  const rigOf = (cell) =>
    rigs.find((rig) => rig.id === LANDING_CELLS[cell].rig);
  const cameraOf = {
    "E-W-ground": BANKED.ground,
    "E-W-ground-hdr": BANKED.ground,
    "E-W-30km": BANKED.km30,
    "E-W-30km-hdr": BANKED.km30,
  };
  for (const cell of EW_CELLS) {
    const rig = rigOf(cell);
    const payload = landingStagePayload(rig);
    assert.deepEqual(payload.camera, cameraOf[cell], `${cell} camera`);
    assert.equal(payload.clock, BANKED.clock, `${cell} clock`);
    assert.deepEqual(
      payload.volumetric,
      BANKED.config,
      `${cell} cloud dials (the banked cloud truth config)`,
    );
    assert.equal(payload.cloudsEnabled, true, cell);
    assert.deepEqual(rig.viewport, BANKED.viewport, `${cell} viewport`);
    assert.deepEqual(rig.renderers, ["webgl", "webgpu"], cell);
    assert.equal(
      payload.scene.highDynamicRange,
      cell.endsWith("-hdr") ? true : undefined,
      `${cell} HDR dial`,
    );
  }
  const strip = (rig) => {
    const { id, description, dials, camera, ...rest } = rig;
    const { highDynamicRange, ...otherDials } = dials;
    void id;
    void description;
    void highDynamicRange;
    return { rest, otherDials, camera };
  };
  for (const height of ["ground", "30km"]) {
    assert.deepEqual(
      strip(rigOf(`E-W-${height}-hdr`)),
      strip(rigOf(`E-W-${height}`)),
      `${height}: the HDR sibling differs by the HDR dial alone`,
    );
  }
  assert.deepEqual(
    rigOf("E-W-30km").dials,
    rigOf("E-W-ground").dials,
    "the 30 km sibling has the ground dials",
  );
});

// ---------------------------------------------------------------------------
// W3: the page steps, run against the real page functions
// ---------------------------------------------------------------------------

// A viewer whose managed collection mirrors CloudCollection._updateWeather:
// a render creates the weather state when the deck is on (WebGPU only) and
// destroys it otherwise.
function installFakeViewer({ renderer, provider = true, field = true }) {
  const collection = {
    show: true,
    volumetric: {
      cloudWeatherMap: true,
      cloudWeatherSeed: 1,
      cloudGeographicWind: false,
      cloudContributesIBL: false,
    },
    renderMode: 1,
    get enableVolumetric() {
      return this.renderMode === 1;
    },
    set enableVolumetric(value) {
      this.renderMode = value === true ? 1 : 0;
    },
  };
  if (field) {
    collection._weatherState = undefined;
  }
  const frameState = { frameNumber: 300 };
  const render = () => {
    frameState.frameNumber++;
    if (field && renderer === "webgpu" && collection.enableVolumetric) {
      collection._weatherState ??= provider ? { provider: {} } : {};
    } else if (field) {
      collection._weatherState = undefined;
    }
  };
  const viewer = {
    scene: {
      context: { rendererType: renderer, _cloudCache: { executeSerial: 241 } },
      globe: { defaultCloudCollection: collection },
      frameState,
      render,
    },
    clock: { currentTime: 0 },
  };
  const previous = {
    viewer: globalThis.viewer,
    raf: globalThis.requestAnimationFrame,
  };
  globalThis.viewer = viewer;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  // The deck is on and has been rendered before the first read.
  render();
  return () => {
    globalThis.viewer = previous.viewer;
    globalThis.requestAnimationFrame = previous.raf;
  };
}

const fakePage = {
  evaluate: async (fn, arg) => fn(arg),
};

test("W3: the steps read the managed collection with the deck on, switch it off, render five frames and read again (real page functions)", async () => {
  for (const renderer of ["webgpu", "webgl"]) {
    const restore = installFakeViewer({ renderer });
    try {
      const steps = await runWeatherStateSteps({ page: fakePage });
      assert.equal(steps.weatherStateOn.rendererType, renderer);
      assert.equal(steps.weatherStateOn.managed.enableVolumetric, true);
      assert.equal(steps.weatherStateOn.managed.hasWeatherStateField, true);
      assert.equal(
        steps.weatherStateOn.managed.weatherState,
        renderer === "webgpu",
        `${renderer} state with the deck on`,
      );
      assert.equal(
        steps.weatherStateOn.managed.weatherProvider,
        renderer === "webgpu",
      );
      assert.equal(steps.weatherDisable.frames, WEATHER_STATE_DISABLE_FRAMES);
      assert.equal(steps.weatherDisable.enableVolumetric, false);
      assert.equal(steps.weatherDisable.threw, null);
      assert.equal(steps.weatherStateOff.managed.enableVolumetric, false);
      assert.equal(steps.weatherStateOff.managed.weatherState, false);
      assert.equal(
        steps.weatherStateOff.frameNumber - steps.weatherStateOn.frameNumber,
        5,
        "five frames between the two reads",
      );
      assert.equal(
        steps.weatherStateOn.dials.cloudWeatherMap,
        true,
        "the staged volumetric dial is read back",
      );
      assert.equal(steps.weatherStateOn.cloudCache.executeSerial, 241);
      const verdict = weatherStateVerdict(`E-W-ground:${renderer}`, {
        renderer,
        ...steps,
      });
      assert.equal(verdict.pass, true, JSON.stringify(verdict));
    } finally {
      restore();
    }
  }
});

test("W3: a page with no managed collection reads null and the disable step says so instead of throwing", async () => {
  const previous = globalThis.viewer;
  globalThis.viewer = { scene: { globe: {}, context: {} }, clock: {} };
  try {
    assert.equal(pageReadWeatherState().managed, null);
    const disabled = await pageDisableManagedDeck({ frames: 5 });
    assert.equal(disabled.threw, "no managed collection");
    assert.equal(disabled.frames, 0);
  } finally {
    globalThis.viewer = previous;
  }
});

// ---------------------------------------------------------------------------
// W4: the verdict, on synthetic reads and on the banked report's numbers
// ---------------------------------------------------------------------------

test("W4: the banked TIP pages (WebGPU defined then undefined, WebGL undefined throughout) pass, on both renderers", () => {
  const webgpu = weatherStateVerdict(
    "E-W-ground:webgpu:scene:run0",
    record("webgpu", BANKED_READS.webgpuOn, BANKED_READS.webgpuOff),
  );
  assert.equal(webgpu.id, "E-W-ground:webgpu:scene:run0:weather-state");
  assert.equal(webgpu.pass, true);
  assert.deepEqual(webgpu.observed, {
    onState: true,
    onProvider: true,
    offState: false,
    deckOffAfterDisable: true,
  });
  const webgl = weatherStateVerdict(
    "E-W-ground:webgl:scene:run0",
    record("webgl", BANKED_READS.webglOn, BANKED_READS.webglOff),
  );
  assert.equal(webgl.pass, true);
  assert.deepEqual(webgl.observed, {
    onState: false,
    onProvider: false,
    offState: false,
  });
});

test("W4: a WebGPU page whose state is missing with the deck on, lacks the provider, or survives the disable fails with the observed values", () => {
  const cases = {
    "no state with the deck on": (on) => {
      on.managed.weatherState = false;
      on.managed.weatherProvider = false;
    },
    "state without a provider": (on) => {
      on.managed.weatherProvider = false;
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const on = clone(BANKED_READS.webgpuOn);
    mutate(on);
    const verdict = weatherStateVerdict(
      "x",
      record("webgpu", on, BANKED_READS.webgpuOff),
    );
    assert.equal(verdict.pass, false, name);
    assert.notEqual(verdict.notRun, true, name);
    assert.match(verdict.reason, /WebGPU weather state read/, name);
  }
  const survives = clone(BANKED_READS.webgpuOff);
  survives.managed.weatherState = true;
  const stuck = weatherStateVerdict(
    "x",
    record("webgpu", BANKED_READS.webgpuOn, survives),
  );
  assert.equal(stuck.pass, false);
  assert.equal(stuck.observed.offState, true);
  const deckStillOn = clone(BANKED_READS.webgpuOff);
  deckStillOn.managed.enableVolumetric = true;
  assert.equal(
    weatherStateVerdict(
      "x",
      record("webgpu", BANKED_READS.webgpuOn, deckStillOn),
    ).pass,
    false,
    "a disable that did not switch the deck off proves nothing about the state after it",
  );
});

test("W4: a WebGL page with a weather state on either read fails", () => {
  for (const which of ["on", "off"]) {
    const on = clone(BANKED_READS.webglOn);
    const off = clone(BANKED_READS.webglOff);
    (which === "on" ? on : off).managed.weatherState = true;
    const verdict = weatherStateVerdict("x", record("webgl", on, off));
    assert.equal(verdict.pass, false, which);
    assert.match(verdict.reason, /WebGL weather state read/, which);
  }
});

test("W4: a tree whose collection has no _weatherState field answers absent and passes; a missing or throwing step is NOT RUN, not a pass", () => {
  const field = (read) => {
    const out = clone(read);
    out.managed.hasWeatherStateField = false;
    return out;
  };
  const absent = weatherStateVerdict(
    "x",
    record(
      "webgpu",
      field(BANKED_READS.webgpuOn),
      field(BANKED_READS.webgpuOff),
    ),
  );
  assert.equal(absent.pass, true);
  assert.equal(absent.absent, true);

  for (const broken of [
    null,
    {},
    record("webgpu", { managed: null }, BANKED_READS.webgpuOff),
    record("webgpu", BANKED_READS.webgpuOn, { managed: null }),
  ]) {
    const verdict = weatherStateVerdict("x", broken);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.notRun, true);
    assert.equal(
      isMarkedUnmeasured(verdict),
      false,
      "an unread page is a fault of the run, not a condition outside it",
    );
  }
  const threw = weatherStateVerdict("x", {
    ...record("webgpu", BANKED_READS.webgpuOn, BANKED_READS.webgpuOff),
    weatherDisable: { frames: 5, enableVolumetric: null, threw: "boom" },
  });
  assert.equal(threw.notRun, true);
  assert.match(threw.reason, /boom/);
});

// ---------------------------------------------------------------------------
// W5: the verdicts of the landing probe and its exit fold
// ---------------------------------------------------------------------------

function ewPage(overrides) {
  return {
    ...pfRecord({ run: 0, ...overrides.pf }),
    cell: "E-W-ground",
    rig: "w3-ew-ground",
    kind: "weather-state",
    stage: { dials: {} },
    ...overrides.page,
  };
}

const reads = (renderer) =>
  renderer === "webgpu"
    ? record("webgpu", BANKED_READS.webgpuOn, BANKED_READS.webgpuOff)
    : record("webgl", BANKED_READS.webglOn, BANKED_READS.webglOff);

const exitOf = (verdicts) =>
  exitCodeForOutcome({ refusal: null, errored: false, verdicts });

test("W5: landingVerdicts reads the weather-state claim for a weather-state page, beside its stage and device-loss verdicts, and for no other kind", () => {
  const pages = [
    ewPage({ pf: { renderer: "webgl" }, page: reads("webgl") }),
    ewPage({ pf: { renderer: "webgpu" }, page: reads("webgpu") }),
    pfRecord({ run: 0 }),
  ];
  const verdicts = landingVerdicts(pages, null);
  const ids = verdicts.map((v) => v.id);
  assert.ok(ids.includes("E-W-ground:webgl:scene:run0:weather-state"));
  assert.ok(ids.includes("E-W-ground:webgpu:scene:run0:weather-state"));
  assert.ok(ids.includes("E-W-ground:webgpu:scene:run0:stage"));
  assert.ok(
    ids.includes("E-W-ground:webgpu:scene:run0:no-unexpected-device-loss"),
  );
  assert.ok(
    !ids.some((id) => id.startsWith("E-D:") && id.endsWith(":weather-state")),
  );
  assert.equal(exitOf(verdicts), PROBE_EXIT_CODES.OK);

  const broken = landingVerdicts(
    [
      ewPage({
        pf: { renderer: "webgpu" },
        page: {
          ...reads("webgpu"),
          weatherStateOff: BANKED_READS.webgpuOn,
        },
      }),
    ],
    null,
  );
  assert.equal(broken.find((v) => v.id.endsWith(":weather-state")).pass, false);
  assert.equal(exitOf(broken), PROBE_EXIT_CODES.FAILURE);
});

test("W5: a PF-3 reading the machine kept unmeasured, from an E-W cell, carries the unmeasured marker and does not fail the run; a measured over from the same cell still does", () => {
  // The banked TIP run: the tip arm's CPU means were 42.1 and 71.4 percent,
  // above the 60 percent guard on run 1.
  const base = groupArms(
    ["webgl", "webgpu"].flatMap((renderer) =>
      [0, 1].map((run) =>
        ewPage({
          pf: { run, renderer, cpu: 20 },
          page: { run, ...reads(renderer) },
        }),
      ),
    ),
  );
  const contendedTip = groupArms(
    ["webgl", "webgpu"].flatMap((renderer) =>
      [0, 1].map((run) =>
        ewPage({
          pf: { run, renderer, cpu: run === 1 ? 71.4 : 42.1 },
          page: { run, ...reads(renderer) },
        }),
      ),
    ),
  );
  const contended = compareArms(contendedTip, base, {});
  assert.equal(
    contended["E-W-ground|webgl|scene"].pf3.verdict,
    "unmeasured-contended",
  );
  const contendedVerdicts = landingVerdicts([], contended);
  const pf3 = contendedVerdicts.find(
    (v) => v.id === "E-W-ground|webgl|scene:PF-3",
  );
  assert.equal(pf3.pass, false);
  assert.equal(pf3.notRun, true);
  assert.equal(pf3.unmeasured, "contended");
  assert.equal(isMarkedUnmeasured(pf3), true);
  assert.equal(
    exitOf(contendedVerdicts),
    PROBE_EXIT_CODES.OK,
    "every PF reading of this run is unmeasured by contention: the run is not a failure",
  );

  // A quiet tip whose startup is 2 s slower than the base reads over.
  const slowTip = groupArms(
    [0, 1].map((run) =>
      ewPage({
        pf: { run, renderer: "webgpu", cpu: 20, firstFrameAtMs: 3500 },
        page: { run, ...reads("webgpu") },
      }),
    ),
  );
  const measured = compareArms(slowTip, base, {});
  assert.equal(measured["E-W-ground|webgpu|scene"].pf3.verdict, "over");
  const measuredVerdicts = landingVerdicts([], measured);
  const over = measuredVerdicts.find(
    (v) => v.id === "E-W-ground|webgpu|scene:PF-3",
  );
  assert.equal(over.pass, false);
  assert.equal(isMarkedUnmeasured(over), false);
  assert.equal(exitOf(measuredVerdicts), PROBE_EXIT_CODES.FAILURE);
  assert.equal(
    exitOf([...contendedVerdicts, ...measuredVerdicts]),
    PROBE_EXIT_CODES.FAILURE,
    "one measured over fails the run beside any number of contended readings",
  );
});

// ---------------------------------------------------------------------------
// W6: the probe runs the cell end to end on the shared runtime
// ---------------------------------------------------------------------------

// The kit's fake browser, with the two weather-state page functions answered
// from the state a real page would hold: the deck on until the disable step.
function weatherFakeBrowser(log, { stuckWebGPU = false } = {}) {
  const inner = makeFakeBrowser(log);
  const newContext = inner.newContext.bind(inner);
  inner.newContext = async (options) => {
    const context = await newContext(options);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      const evaluate = page.evaluate.bind(page);
      const goto = page.goto.bind(page);
      let renderer = "webgl";
      let disabled = false;
      page.goto = async (url, options) => {
        renderer = new URL(url).searchParams.get("renderer") ?? "webgl";
        return goto(url, options);
      };
      page.evaluate = async (fn, arg) => {
        if (fn.name === "pageReadWeatherState") {
          log.weatherReads?.push(disabled ? "off" : "on");
          const webgpu = renderer === "webgpu";
          return clone(
            webgpu
              ? disabled && !stuckWebGPU
                ? BANKED_READS.webgpuOff
                : BANKED_READS.webgpuOn
              : disabled
                ? BANKED_READS.webglOff
                : BANKED_READS.webglOn,
          );
        }
        if (fn.name === "pageDisableManagedDeck") {
          log.weatherDisables?.push(arg.frames);
          disabled = true;
          return DISABLED;
        }
        return evaluate(fn, arg);
      };
      return page;
    };
    return context;
  };
  return inner;
}

async function runCell(cells, fakeOptions) {
  return withLaneTmp("landing-weather-state-", async (dir) => {
    const out = path.join(dir, "out");
    const log = {
      events: [],
      scripts: [],
      urls: [],
      selectors: [],
      contexts: [],
      waits: [],
      weatherReads: [],
      weatherDisables: [],
    };
    const code = await runProbe(descriptor, {
      argv: [
        "--repository-root",
        dir,
        "--output",
        out,
        "--runs",
        "1",
        "--no-serve-built",
        "--cells",
        cells,
      ],
      launch: async () => weatherFakeBrowser(log, fakeOptions),
      preflight: async () => ({ ok: true, records: [] }),
    });
    const report = JSON.parse(
      fs.readFileSync(path.join(out, "landing-cells-report.json"), "utf8"),
    );
    return { code, report, log };
  });
}

test("W6: --cells E-W-ground runs both renderers through the probe, reads before and after the disable, and exits 0 on the claim", async () => {
  const { code, report, log } = await runCell("E-W-ground");
  assert.equal(code, PROBE_EXIT_CODES.OK);
  assert.deepEqual(log.weatherReads, ["on", "off", "on", "off"]);
  assert.deepEqual(log.weatherDisables, [5, 5]);
  const verdicts = report.verdicts ?? report.runtime?.verdicts ?? [];
  for (const renderer of ["webgl", "webgpu"]) {
    const verdict = verdicts.find(
      (v) => v.id === `E-W-ground:${renderer}:scene:run0:weather-state`,
    );
    assert.equal(verdict?.pass, true, renderer);
  }
  const page = report.pages.find((p) => p.renderer === "webgpu");
  assert.equal(page.kind, "weather-state");
  assert.equal(page.weatherStateOn.managed.weatherState, true);
  assert.equal(page.weatherStateOff.managed.weatherState, false);
  assert.equal(page.weatherDisable.frames, 5);
  assert.ok(page.capture, "the capture was taken before the steps");
});

test("W6: a WebGPU page whose weather state survives the disable fails the run", async () => {
  const { code, report } = await runCell("E-W-30km-hdr", {
    stuckWebGPU: true,
  });
  assert.equal(code, PROBE_EXIT_CODES.FAILURE);
  const verdicts = report.verdicts ?? report.runtime?.verdicts ?? [];
  const failed = verdicts.filter((v) => v.pass === false);
  assert.deepEqual(
    failed.map((v) => v.id),
    ["E-W-30km-hdr:webgpu:scene:run0:weather-state"],
  );
});
