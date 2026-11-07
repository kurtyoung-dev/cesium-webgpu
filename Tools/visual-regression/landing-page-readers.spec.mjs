// landing-page-readers.spec.mjs - the opt-in page readers of the landing probe (--readers).
//
// @purpose Node spec for the landing probe's opt-in page readers: with every reader off the receipt, the summary, the capture manifest and the installed init scripts equal a golden captured from the tree before the readers existed; each reader reads the page's own value or NOT AVAILABLE naming its seam; and the keep-device holder's page functions run as written against a fake Cesium module.
// @status ACTIVE
//
// Every assertion runs the real descriptor over the fake browser
// (lib/landing-fake-browser.mjs); the fake page never answers a reader's seam
// unless a case hands it one, so a reader that invents a value goes red.
// The holder functions of lib/device-loss-steps.mjs run for real against a fake
// Cesium module (CesiumWidget.createAsync) and a fake page. Every in-spec mutant
// is run through the same behaviour assertion as the real module and must fail
// it with an AssertionError.
// Set LANDING_READERS_WRITE_GOLDEN=1 to rewrite the golden from the tree under
// test (done once, on a tree without the readers).

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";
import { descriptor } from "./probe-landing-cells.mjs";
import { BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE } from "./lib/bind-group-layout-census.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { makeFakeBrowser } from "./lib/landing-fake-browser.mjs";
import {
  DEFAULT_CELLS,
  LANDING_CELLS,
  pagesOfCell,
} from "./lib/landing-cell-table.mjs";
import {
  installReaderInitScripts,
  readReaderRecords,
} from "./lib/landing-init-scripts.mjs";
import { parseReaders } from "./lib/landing-page-readers.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";

const PROBE_MODULE = fileURLToPath(
  new URL("./probe-landing-cells.mjs", import.meta.url),
);
const INIT_SCRIPTS_MODULE = fileURLToPath(
  new URL("./lib/landing-init-scripts.mjs", import.meta.url),
);
const READERS_MODULE = fileURLToPath(
  new URL("./lib/landing-page-readers.mjs", import.meta.url),
);

const GOLDEN_FILE = fileURLToPath(
  new URL("./fixtures/landing-readers-off.golden.json", import.meta.url),
);
// A representative set: both renderers of the identity cell, the flight cell,
// an E-T device-loss cell (two pages) and the layout-census cell.
const GOLDEN_CELLS = "E-D,E-F,E-T-flight,E-BGL";

let tempRoot;
before(() => {
  tempRoot = mkLaneTmp("landing-readers-");
});
after(() => {
  removeLaneTmp(tempRoot);
});
const { p14Run } = landingRunners(() => tempRoot);

// Keys whose value legitimately differs between two runs of the same tree: the
// run clock (generatedAt, acquiredAt, capturedAt, startedAt, endedAt, at), the
// close timings and the machine CPU samples (cpu, cpuSeries, cpuSamples).
const CLOCK_KEYS = new Set([
  "generatedAt",
  "acquiredAt",
  "capturedAt",
  "startedAt",
  "endedAt",
  "at",
  "closeMs",
  "browserCloseMs",
  "elapsedMs",
]);
const CPU_KEYS = new Set(["cpu", "cpuSeries", "cpuSamples"]);
const VARIES = "<varies>";
// Receipt fields other pieces of the probe add, empty while their feature is
// off. An empty one is dropped from the comparison (any other new field, and a
// non-empty one, still fails it); the summary's list of receipt fields names
// them, so that line is masked.
const EMPTY_WHEN_OFF_FIELDS = ["weatherDial"];

/**
 * A copy of a receipt with the run-to-run fields masked and the run's temp root
 * replaced by a token.
 *
 * @param {*} value The parsed receipt.
 * @param {string} root The run's repository root (its temp path).
 * @returns {*}
 */
export function normaliseReceipt(value, root) {
  const forward = root.replaceAll("\\", "/");
  const walk = (node, key) => {
    if (CLOCK_KEYS.has(key) || CPU_KEYS.has(key)) {
      return VARIES;
    }
    if (typeof node === "string") {
      return node.replaceAll("\\", "/").replaceAll(forward, "<ROOT>");
    }
    if (Array.isArray(node)) {
      return node.map((item) => walk(item, key));
    }
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node).map(([k, v]) => [k, walk(v, k)]),
      );
    }
    return node;
  };
  return walk(value, "");
}

function withoutEmptyOffFields(report) {
  const kept = { ...report };
  for (const key of EMPTY_WHEN_OFF_FIELDS) {
    if (Array.isArray(kept[key]) && kept[key].length === 0) {
      delete kept[key];
    }
  }
  return kept;
}

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

/** The init scripts a page was given, as a digest per script. */
const scriptDigests = (log) =>
  log.scripts.map((script) =>
    sha(typeof script === "function" ? String(script) : String(script.content)),
  );

let runCount = 0;

/** One run of the probe (or a mutated copy of it) over the fake browser. */
async function run1(args, fakeOptions = {}, probe = descriptor) {
  const dir = path.join(tempRoot, `run${runCount++}`);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  let launched = 0;
  let stderr = "";
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    stderr += String(chunk);
    return write.call(process.stderr, chunk, ...rest);
  };
  let code;
  try {
    code = await runProbe(probe, {
      argv: [
        "--repository-root",
        dir,
        "--output",
        out,
        "--runs",
        "1",
        "--no-serve-built",
        ...args,
      ],
      launch: async () => {
        launched++;
        return makeFakeBrowser(log, fakeOptions);
      },
      preflight: async () => ({ ok: true, records: [] }),
    });
  } finally {
    process.stderr.write = write;
  }
  const read = (name) => {
    const file = path.join(out, name);
    return fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : null;
  };
  const refusalFile = fs.existsSync(out)
    ? fs.readdirSync(out).find((name) => name.includes("refusal"))
    : undefined;
  return {
    code,
    log,
    launched,
    stderr,
    report: read("landing-cells-report.json"),
    refusal: refusalFile ? read(refusalFile) : null,
  };
}

async function readersOffRun(name, extraArgs = []) {
  const run = await p14Run(name, ["--cells", GOLDEN_CELLS, ...extraArgs]);
  const out = path.join(tempRoot, name, "out");
  const root = path.join(tempRoot, name);
  const read = (file) => fs.readFileSync(path.join(out, file), "utf8");
  return {
    run,
    snapshot: {
      exitCode: run.code,
      report: withoutEmptyOffFields(normaliseReceipt(run.report, root)),
      // The summary prints the run clock on its "Generated:" line and lists
      // every cell of the table in its title, a list that grows with the table.
      summary: normaliseReceipt(read("landing-cells-summary.md"), root)
        .replace(/^Generated: .*$/m, "Generated: <varies>")
        .replace(/^# Landing cells - .*$/m, "# Landing cells - <title>")
        .replace(/^Receipt fields: .*$/m, "Receipt fields: <list>"),
      captureManifest: normaliseReceipt(
        JSON.parse(read("capture-manifest.json")),
        root,
      ),
      scriptCount: run.log.scripts.length,
      scriptDigests: scriptDigests(run.log),
    },
  };
}

test("readers off: the receipt, summary, manifest and init scripts equal the golden of the tree before the readers", async () => {
  const { snapshot } = await readersOffRun("readers-off");
  if (process.env.LANDING_READERS_WRITE_GOLDEN === "1") {
    fs.writeFileSync(GOLDEN_FILE, `${JSON.stringify(snapshot, null, 1)}\n`);
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN_FILE, "utf8"));
  assert.deepEqual(snapshot, golden);
});

// ---------------------------------------------------------------------------
// Worlds: what a fake page holds. A reader sees only these globals.
// ---------------------------------------------------------------------------

const noop = () => {};

/** A page whose renderer statistics carry the given volumetric block. */
const statsWorld = (volumetricClouds) => () => ({
  viewer: {
    scene: {
      context: {
        getRendererStatistics: () => ({
          pipelineCache: null,
          ...(volumetricClouds === undefined ? {} : { volumetricClouds }),
        }),
      },
    },
  },
});

const CLOUD_BLOCK = {
  frames: 731,
  culledFrames: 12,
  raymarch: {
    budgetApplied: true,
    marchBudget: 2.5,
    marchCost: 2.25,
    requestedMarchCost: 3.75,
    // A false and the flag words the tree publishes in the same block.
    budgetRefused: false,
    halfResActive: true,
    qualityFlags: 5,
    requestedQualityFlags: 13,
  },
};

/**
 * A page whose managed collection ticks its weather as often per frame as
 * `schedule` says (its frame loop calls the update that many times).
 */
function ticksWorld(schedule, handle = {}, { ownMethod = false } = {}) {
  return () => {
    let frame = 0;
    class Collection {
      _updateWeather() {
        this.realCalls = (this.realCalls ?? 0) + 1;
      }
    }
    const collection = new Collection();
    if (ownMethod) {
      collection._updateWeather = function ownUpdateWeather() {
        this.realCalls = (this.realCalls ?? 0) + 1;
      };
    }
    handle.collection = collection;
    handle.Collection = Collection;
    handle.ownMethod = collection._updateWeather;
    return {
      viewer: {
        clock: { currentTime: 7 },
        scene: {
          globe: { defaultCloudCollection: collection },
          initializeFrame: noop,
          render() {
            for (let i = 0; i < (schedule[frame] ?? 0); i++) {
              collection._updateWeather({});
            }
            frame++;
          },
        },
      },
    };
  };
}

/** A page with classes standing in for Worker, Blob and URL. */
const workerWorld = () => {
  class FakeBlob {
    constructor(parts) {
      this.parts = parts;
    }
  }
  class FakeWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.ended = false;
    }
    terminate() {
      this.ended = true;
    }
  }
  let blobs = 0;
  return {
    Worker: FakeWorker,
    Blob: FakeBlob,
    URL: { createObjectURL: () => `blob:null/${++blobs}` },
  };
};

const WEATHER_URL = "http://localhost:8094/Build/Workers/createCloudWeather.js";
const OTHER_URL = "http://localhost:8094/Build/Workers/createTerrain.js";
const CROSS_ORIGIN_SHIM = `import "http://cdn.example/Workers/createCloudWeather.js";`;
const EMBEDDED_SHIM = `importScripts("blob:null/embedded"); CesiumWorkers["createCloudWeather"]();`;

/** Page code: a direct weather worker, two blob-shim ones, an unrelated one. */
const WORKERS_PAGE_CODE = `
  const make = (script) =>
    new Worker(URL.createObjectURL(new Blob([script])), { type: "module" });
  globalThis.pageWorkers = {
    direct: new Worker(${JSON.stringify(WEATHER_URL)}, { type: "module" }),
    crossOrigin: make(${JSON.stringify(CROSS_ORIGIN_SHIM)}),
    embedded: make(${JSON.stringify(EMBEDDED_SHIM)}),
    other: new Worker(${JSON.stringify(OTHER_URL)}, { type: "module" }),
  };`;

/** A page with the pieces of a pipeline-creating device. */
const gpuWorld = () => {
  class GPUComputePipeline {
    getBindGroupLayout(index) {
      return { index };
    }
  }
  class GPURenderPipeline {
    getBindGroupLayout(index) {
      return { index };
    }
  }
  class GPUDevice {
    createShaderModule(descriptor) {
      return { label: descriptor.label };
    }
    createComputePipeline() {
      return new GPUComputePipeline();
    }
    createRenderPipeline() {
      return new GPURenderPipeline();
    }
    async createComputePipelineAsync() {
      return new GPUComputePipeline();
    }
    async createRenderPipelineAsync() {
      return new GPURenderPipeline();
    }
  }
  return { GPUDevice, GPUComputePipeline, GPURenderPipeline };
};

const COMPUTE_WGSL = `
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;
@group(1) @binding(0) var tex: texture_2d<f32>;
@group(1) @binding(1) var smp: sampler;
@binding(2) @group(1) var dst: texture_storage_2d<rgba8unorm, write>;
// @group(2) @binding(0) var<uniform> hidden: Params;
/* @group(3) @binding(0) var<storage, read> alsoHidden: array<f32>; */
`;
const VERTEX_WGSL = `@group(0) @binding(0) var<uniform> camera: Camera;`;
const FRAGMENT_WGSL = `
@group(0) @binding(1) var<storage, read> lights: array<vec4f>;
@group(1) @binding(0) var atlas: texture_depth_2d;
@group(1) @binding(1) var cmp: sampler_comparison;
@group(1) @binding(2) var video: texture_external;
`;

/** Page code: an auto compute pipeline, an explicit render one, an async auto one. */
const PIPELINES_PAGE_CODE = `
  const device = new GPUDevice();
  const compute = device.createShaderModule({ label: "W4 compute", code: ${JSON.stringify(COMPUTE_WGSL)} });
  const vertex = device.createShaderModule({ label: "v", code: ${JSON.stringify(VERTEX_WGSL)} });
  const fragment = device.createShaderModule({ label: "f", code: ${JSON.stringify(FRAGMENT_WGSL)} });
  const one = device.createComputePipeline({ label: "Cloud density cache refresh", layout: "auto", compute: { module: compute } });
  one.getBindGroupLayout(0);
  one.getBindGroupLayout(1);
  one.getBindGroupLayout(0);
  device.createComputePipeline({ label: "Cloud density cache refresh", layout: "auto", compute: { module: compute } });
  device.createRenderPipeline({ label: "Explicit draw", layout: { explicit: true }, vertex: { module: vertex }, fragment: { module: fragment } });
  globalThis.settled = device
    .createComputePipelineAsync({ label: "Async scan", layout: "auto", compute: { module: vertex } })
    .then((pipeline) => pipeline.getBindGroupLayout(0));`;

/** One fake page, for a reader called directly rather than through the probe. */
async function readerPage(fakeOptions = {}) {
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const browser = makeFakeBrowser(log, fakeOptions);
  const context = await browser.newContext({});
  return { page: await context.newPage(), log };
}

/** A page with the init scripts of `readers` installed, loaded, ready to read. */
async function loadedPage(readers, fakeOptions) {
  const made = await readerPage(fakeOptions);
  await installReaderInitScripts(made.page, { readers: readers.join(",") });
  await made.page.goto("http://localhost/");
  return made;
}

const inPage = (code) => (sandbox) => vm.runInContext(code, sandbox);

// ---------------------------------------------------------------------------
// Each reader's ON, NOT AVAILABLE and mutant checks, as functions of the
// reader module so the mutants run exactly the assertions the real module does.
// ---------------------------------------------------------------------------

async function checkCloudStatsOn(readers = READERS_MODULE_REAL) {
  const { page } = await readerPage({ readerWorld: statsWorld(CLOUD_BLOCK) });
  const read = await readers.readCaptureReaders(page, ["cloud-stats"]);
  assert.deepEqual(read.cloudStats, {
    available: true,
    frames: 731,
    culledFrames: 12,
    raymarch: {
      budgetApplied: true,
      marchBudget: 2.5,
      marchCost: 2.25,
      requestedMarchCost: 3.75,
      budgetRefused: false,
      halfResActive: true,
      qualityFlags: 5,
      requestedQualityFlags: 13,
    },
  });
}

async function checkWeatherTicksOn(readers = READERS_MODULE_REAL) {
  const schedule = [1, 1, 0, 2, 1, 1, 3, 1, 1, 1, 0, 1];
  const handle = {};
  const { page } = await readerPage({
    readerWorld: ticksWorld(schedule, handle),
  });
  const read = await readers.readCaptureReaders(page, ["weather-ticks"]);
  assert.deepEqual(read.weatherTicks, {
    available: true,
    frames: 12,
    perFrame: schedule,
    min: 0,
    max: 3,
    total: 13,
  });
  // The wrapper called through, and the method is the page's own again.
  assert.equal(handle.collection.realCalls, 13);
  assert.equal(Object.hasOwn(handle.collection, "_updateWeather"), false);
}

async function checkWorkerOn(readers = READERS_MODULE_REAL) {
  const { page } = await loadedPage(["weather-worker"], {
    readerWorld: workerWorld,
    onPageLoad: inPage(WORKERS_PAGE_CODE),
  });
  const read = await readers.readCaptureReaders(page, ["weather-worker"]);
  assert.ok(read.weatherWorker, "the weather-worker record was read");
  assert.equal(read.weatherWorker.available, true);
  assert.equal(read.weatherWorker.created, 3);
  assert.equal(read.weatherWorker.terminated, 0);
  assert.equal(read.weatherWorker.alive, true);
}

// The refresh label the page's lifetime count is read for, as a delta.
async function checkRefreshOn(readers = READERS_MODULE_REAL) {
  const read = await readers.readCaptureReaders(
    (await readerPage({ readerWorld: refreshWorld({ lifetime: true }) })).page,
    ["refresh-counters"],
  );
  assert.ok(read.refreshCounters, "the refresh-counters record was read");
  assert.equal(read.refreshCounters.available, true);
  assert.deepEqual(read.refreshCounters.labels["Cloud density cache refresh"], {
    before: 100,
    after: 103,
    delta: 3,
  });
}

const REFRESH_UNCOUNTED = (label) => ({
  available: false,
  reason: `NOT AVAILABLE: getRendererStatistics().volumetricClouds.lifetimePasses["${label}"] (no lifetime refresh counter is published; the compute refresh passes are not recorded by recordCloudPass, and volumetricClouds.passes is reset every frame)`,
});

// A page that follows the engine publishes no lifetime refresh count and its
// per-frame passes hold 0 for the five labels: every label reads NOT AVAILABLE
// (not that 0), and no frame is driven for a window with nothing to difference.
async function checkRefreshUncounted(readers = READERS_MODULE_REAL) {
  const handle = {};
  const { page } = await readerPage({
    readerWorld: refreshWorld({ handle }),
  });
  const read = await readers.readCaptureReaders(page, ["refresh-counters"]);
  const record = read.refreshCounters;
  assert.ok(record, "the refresh-counters record was read");
  assert.equal(record.available, true);
  for (const label of READERS_MODULE_REAL.REFRESH_PASS_LABELS) {
    assert.deepEqual(record.labels[label], REFRESH_UNCOUNTED(label), label);
  }
  assert.equal(record.frames, 0);
  assert.equal(handle.renders, 0, "no frame was driven");
}

async function checkAutoOn(readers = READERS_MODULE_REAL) {
  const { page } = await loadedPage(["auto-layouts"], {
    readerWorld: gpuWorld,
    onPageLoad: inPage(PIPELINES_PAGE_CODE),
  });
  const read = await readers.readCaptureReaders(page, ["auto-layouts"]);
  assert.ok(read.autoLayouts, "the auto-layouts record was read");
  assert.equal(read.autoLayouts.available, true);
  assert.equal(read.autoLayouts.pipelines, 4);
}

/**
 * A page whose cloud statistics follow the engine's: `passes` is the frame's
 * own count (every registered label present, the five compute refresh labels
 * never counted) and no lifetime refresh count is published. With
 * `lifetime: true` the block also publishes `lifetimePasses` (the field the
 * reader looks for), counts that only rise on a schedule. `handle.renders`
 * counts the frames the reader drove; the camera is still unless `moveCamera`.
 */
function refreshWorld({
  lifetime = false,
  moveCamera = false,
  occupancy = true,
  handle = {},
} = {}) {
  // occupancy: true or false is the page's flag; null is a page without the cache.
  return () => {
    let frame = 0;
    handle.renders = 0;
    const passes = Object.fromEntries(
      [...READERS_MODULE_REAL.REFRESH_PASS_LABELS, "ProceduralClouds pass"].map(
        (label) => [label, label === "ProceduralClouds pass" ? 1 : 0],
      ),
    );
    const lifetimePasses = {
      "Cloud density cache refresh": 100,
      "Cloud deep-shadow refresh": 40,
      "Cloud occupancy refresh": 7,
      "Cloud occupancy invalidation": 5,
      // "Cloud occupancy parent bounds" is not counted by this page.
    };
    const camera = {
      position: { x: 1, y: 2, z: 3 },
      direction: { x: 0, y: 0, z: -1 },
    };
    const context = {
      getRendererStatistics: () => ({
        volumetricClouds: {
          passes: { ...passes },
          ...(lifetime ? { lifetimePasses: { ...lifetimePasses } } : {}),
        },
      }),
    };
    if (occupancy !== null) {
      context._cloudCache = { spatialOccupancyActive: occupancy };
    }
    return {
      viewer: {
        clock: { currentTime: 7 },
        camera,
        scene: {
          context,
          initializeFrame: noop,
          render() {
            frame++;
            handle.renders++;
            // Density every 10th frame, deep shadow every 15th, the occupancy
            // refresh every frame, its invalidation never.
            if (frame % 10 === 0)
              lifetimePasses["Cloud density cache refresh"]++;
            if (frame % 15 === 0) lifetimePasses["Cloud deep-shadow refresh"]++;
            lifetimePasses["Cloud occupancy refresh"]++;
            if (moveCamera) camera.position.x += 1;
          },
        },
      },
    };
  };
}

const READERS_MODULE_REAL = await import("./lib/landing-page-readers.mjs");

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------

test("--readers: an unknown name is refused before any browser, naming the unknown ones", async () => {
  const refused = await run1([
    "--cells",
    "E-F",
    "--readers",
    "cloud-stats,bogus,nope",
  ]);
  assert.equal(refused.code, PROBE_EXIT_CODES.REFUSAL);
  assert.equal(refused.launched, 0, "no browser was launched");
  assert.equal(refused.log.contexts.length, 0, "no page was opened");
  assert.match(refused.stderr, /REFUSED [(]readers-unknown[)]/);
  assert.match(refused.stderr, /names bogus, nope, which are not a reader/);
});

test("--readers: a known list is parsed in registry order and recorded in the options", async () => {
  assert.deepEqual(parseReaders("auto-layouts, cloud-stats,cloud-stats"), [
    "cloud-stats",
    "auto-layouts",
  ]);
  assert.deepEqual(parseReaders(""), []);
  assert.deepEqual(parseReaders(undefined), []);
  const ran = await run1(["--cells", "E-F", "--readers", "cloud-stats"], {
    readerWorld: statsWorld(CLOUD_BLOCK),
  });
  assert.equal(ran.report.options.readers, "cloud-stats");
});

// ---------------------------------------------------------------------------
// The five readers through the real descriptor
// ---------------------------------------------------------------------------

const pageOf = (report, cell, page = "scene", renderer = "webgpu") =>
  report.pages.find(
    (p) => p.cell === cell && p.page === page && p.renderer === renderer,
  );

test("cloud-stats, weather-ticks and refresh-counters ON: the page record carries the page's values and no script is added", async () => {
  const schedule = [1, 1, 0, 2, 1, 1, 3, 1, 1, 1, 0, 1];
  const world = () => ({
    ...(() => {
      const ticks = ticksWorld(schedule)();
      const refresh = refreshWorld()();
      // One viewer answering all three: the statistics and camera of the
      // refresh page, the collection of the ticks page, a render doing both.
      const viewer = refresh.viewer;
      viewer.scene.globe = ticks.viewer.scene.globe;
      const refreshRender = viewer.scene.render;
      const ticksRender = ticks.viewer.scene.render;
      viewer.scene.render = () => {
        refreshRender();
        ticksRender();
      };
      const stats = viewer.scene.context.getRendererStatistics;
      viewer.scene.context.getRendererStatistics = () => ({
        volumetricClouds: {
          ...CLOUD_BLOCK,
          ...stats().volumetricClouds,
        },
      });
      return { viewer };
    })(),
  });
  const ran = await run1(
    [
      "--cells",
      "E-F",
      "--readers",
      "cloud-stats,weather-ticks,refresh-counters",
    ],
    { readerWorld: world },
  );
  assert.equal(ran.code, 0);
  const readers = pageOf(ran.report, "E-F").readers;
  assert.deepEqual(Object.keys(readers), [
    "cloudStats",
    "weatherTicks",
    "refreshCounters",
  ]);
  assert.equal(readers.cloudStats.frames, 731);
  assert.equal(readers.cloudStats.raymarch.marchCost, 2.25);
  assert.equal(readers.cloudStats.raymarch.budgetRefused, false);
  assert.equal(readers.cloudStats.raymarch.qualityFlags, 5);
  assert.deepEqual(readers.weatherTicks.perFrame, schedule);
  assert.equal(readers.weatherTicks.max, 3);
  // The page publishes no lifetime refresh count: not a zero, and no frames
  // driven for it.
  assert.deepEqual(
    readers.refreshCounters.labels["Cloud density cache refresh"],
    REFRESH_UNCOUNTED("Cloud density cache refresh"),
  );
  assert.equal(readers.refreshCounters.frames, 0);
  // Three always-on scripts and nothing for these three readers.
  assert.equal(ran.log.scripts.length, 3);
});

test("refresh-counters: a page with no lifetime refresh count reads the five labels NOT AVAILABLE naming the seam, drives no frame and keeps the occupancy read", async () => {
  await checkRefreshUncounted();
  const handle = {};
  const record = (
    await readCaptureOnce("refresh-counters", {
      readerWorld: refreshWorld({ handle }),
    })
  ).refreshCounters;
  // No window was run, so the camera answer is not a claim about one.
  assert.equal(record.cameraUnchanged, null);
  assert.equal(record.occupancyRead.available, true);
  assert.equal(record.occupancyRead.consultedAfter, true);
  assert.match(
    record.occupancyRead.skippedSamples.reason,
    /^NOT AVAILABLE: .*skipped/,
  );
  const noCache = await readCaptureOnce("refresh-counters", {
    readerWorld: refreshWorld({ occupancy: null }),
  });
  assert.equal(noCache.refreshCounters.occupancyRead.available, false);
  assert.match(
    noCache.refreshCounters.occupancyRead.reason,
    /^NOT AVAILABLE: scene\.context\._cloudCache\.spatialOccupancyActive$/,
  );
  const off = await readCaptureOnce("refresh-counters", {
    readerWorld: refreshWorld({ occupancy: false }),
  });
  assert.equal(off.refreshCounters.occupancyRead.consultedAfter, false);
});

test("refresh-counters: a page that publishes a lifetime refresh count reads its delta over the window per label, the unpublished label NOT AVAILABLE", async () => {
  const handle = {};
  const still = await readCaptureOnce("refresh-counters", {
    readerWorld: refreshWorld({ lifetime: true, handle }),
  });
  const record = still.refreshCounters;
  assert.equal(record.frames, 30);
  assert.equal(handle.renders, 30);
  assert.equal(record.cameraUnchanged, true);
  assert.deepEqual(record.labels["Cloud density cache refresh"], {
    before: 100,
    after: 103,
    delta: 3,
  });
  assert.deepEqual(record.labels["Cloud deep-shadow refresh"], {
    before: 40,
    after: 42,
    delta: 2,
  });
  assert.deepEqual(record.labels["Cloud occupancy refresh"], {
    before: 7,
    after: 37,
    delta: 30,
  });
  assert.deepEqual(record.labels["Cloud occupancy invalidation"], {
    before: 5,
    after: 5,
    delta: 0,
  });
  assert.deepEqual(
    record.labels["Cloud occupancy parent bounds"],
    REFRESH_UNCOUNTED("Cloud occupancy parent bounds"),
  );
  const moved = await readCaptureOnce("refresh-counters", {
    readerWorld: refreshWorld({ lifetime: true, moveCamera: true }),
  });
  assert.equal(moved.refreshCounters.cameraUnchanged, false);
});

async function readCaptureOnce(reader, fakeOptions) {
  const { page } = await loadedPage([reader], fakeOptions);
  return READERS_MODULE_REAL.readCaptureReaders(page, [reader]);
}

// The three flag fields beside the budget ones, each the page's own value: a
// zero word and a false flag are values, a field the block lacks is NOT
// AVAILABLE naming it.
async function checkCloudStatsFlags(readers = READERS_MODULE_REAL) {
  const read = async (raymarch) => {
    const { page } = await readerPage({
      readerWorld: statsWorld({ ...CLOUD_BLOCK, raymarch }),
    });
    return (await readers.readCaptureReaders(page, ["cloud-stats"])).cloudStats
      .raymarch;
  };
  const published = await read(CLOUD_BLOCK.raymarch);
  assert.equal(published.halfResActive, true);
  assert.equal(published.qualityFlags, 5);
  assert.equal(published.requestedQualityFlags, 13);
  const zero = await read({
    ...CLOUD_BLOCK.raymarch,
    halfResActive: false,
    qualityFlags: 0,
    requestedQualityFlags: 0,
  });
  assert.equal(zero.halfResActive, false);
  assert.equal(zero.qualityFlags, 0);
  assert.equal(zero.requestedQualityFlags, 0);
  // A block that lacks `qualityFlags` alone: that field names itself, the
  // other two are still the page's values.
  const { qualityFlags: _dropped, ...withoutQualityFlags } =
    CLOUD_BLOCK.raymarch;
  const missing = await read(withoutQualityFlags);
  assert.deepEqual(missing.qualityFlags, {
    available: false,
    reason:
      "NOT AVAILABLE: getRendererStatistics().volumetricClouds.raymarch.qualityFlags",
  });
  assert.equal(missing.halfResActive, true);
  assert.equal(missing.requestedQualityFlags, 13);
}

test("cloud-stats: the budget and the quality flag fields are the page's values, field by field", async () => {
  await checkCloudStatsFlags();
  // A page whose block lacks the budget refusal (a tree that predates it).
  const { budgetRefused: _refused, ...withoutRefused } = CLOUD_BLOCK.raymarch;
  const noRefusal = await readCaptureOnce("cloud-stats", {
    readerWorld: statsWorld({ ...CLOUD_BLOCK, raymarch: withoutRefused }),
  });
  assert.equal(
    noRefusal.cloudStats.raymarch.budgetRefused.reason,
    "NOT AVAILABLE: getRendererStatistics().volumetricClouds.raymarch.budgetRefused",
  );
  const partial = await readCaptureOnce("cloud-stats", {
    readerWorld: statsWorld({ frames: 4 }),
  });
  assert.equal(partial.cloudStats.frames, 4);
  assert.equal(
    partial.cloudStats.culledFrames.reason,
    "NOT AVAILABLE: getRendererStatistics().volumetricClouds.culledFrames",
  );
  for (const field of [
    "marchBudget",
    "halfResActive",
    "qualityFlags",
    "requestedQualityFlags",
  ]) {
    assert.equal(
      partial.cloudStats.raymarch[field].reason,
      `NOT AVAILABLE: getRendererStatistics().volumetricClouds.raymarch.${field}`,
    );
  }
});

test("weather-ticks: restores an instance method the page had of its own", async () => {
  const handle = {};
  await readCaptureOnce("weather-ticks", {
    readerWorld: ticksWorld([1, 1, 1], handle, { ownMethod: true }),
  });
  assert.equal(handle.collection._updateWeather, handle.ownMethod);
  assert.equal(Object.hasOwn(handle.collection, "_updateWeather"), true);
});

test("weather-worker ON: created, terminated and alive after destroy are the page's, with blob shims attributed by their text", async () => {
  const destroyListed = (names) =>
    inPage(
      `${names.map((n) => `globalThis.pageWorkers.${n}.terminate();`).join("")}`,
    );
  const ran = await run1(
    ["--cells", "E-T-flight", "--readers", "weather-worker"],
    {
      readerWorld: workerWorld,
      onPageLoad: inPage(WORKERS_PAGE_CODE),
      onViewerDestroy: destroyListed(["direct", "other"]),
    },
  );
  assert.equal(ran.code, 0);
  const teardown = pageOf(ran.report, "E-T-flight", "teardown").readers;
  assert.deepEqual(
    {
      created: teardown.weatherWorker.created,
      terminated: teardown.weatherWorker.terminated,
      alive: teardown.weatherWorker.alive,
    },
    { created: 3, terminated: 0, alive: true },
  );
  assert.deepEqual(
    teardown.weatherWorker.workers.map((w) => w.attributedBy),
    ["url", "blob-shim-text", "blob-shim-text"],
  );
  assert.deepEqual(
    {
      created: teardown.weatherWorkerAfterDestroy.created,
      terminated: teardown.weatherWorkerAfterDestroy.terminated,
      aliveAfterDestroy: teardown.weatherWorkerAfterDestroy.aliveAfterDestroy,
    },
    { created: 3, terminated: 1, aliveAfterDestroy: true },
  );
  // The forced-loss page never destroys its viewer: no after-destroy read.
  const lost = pageOf(ran.report, "E-T-flight", "forced-loss").readers;
  assert.deepEqual(Object.keys(lost), ["weatherWorker"]);
  // One census script per page, on top of the three always-on ones.
  assert.equal(ran.log.scripts.length, 2 * 4);

  const gone = await run1(
    ["--cells", "E-T-flight", "--readers", "weather-worker"],
    {
      readerWorld: workerWorld,
      onPageLoad: inPage(WORKERS_PAGE_CODE),
      onViewerDestroy: destroyListed([
        "direct",
        "crossOrigin",
        "embedded",
        "other",
      ]),
    },
  );
  const after = pageOf(gone.report, "E-T-flight", "teardown").readers
    .weatherWorkerAfterDestroy;
  assert.deepEqual(
    [after.created, after.terminated, after.aliveAfterDestroy],
    [3, 3, false],
  );
});

test("weather-worker: no weather worker says so, and a blob worker that cannot be attributed is counted", async () => {
  const code = `
    new Worker(${JSON.stringify(OTHER_URL)}, { type: "module" });
    new Worker(URL.createObjectURL({}));`;
  const { page } = await loadedPage(["weather-worker"], {
    readerWorld: workerWorld,
    onPageLoad: inPage(code),
  });
  const read = await READERS_MODULE_REAL.readCaptureReaders(page, [
    "weather-worker",
  ]);
  assert.equal(read.weatherWorker.available, true);
  assert.equal(read.weatherWorker.created, 0);
  assert.equal(
    read.weatherWorker.note,
    "no weather worker was created on this page",
  );
  assert.equal(read.weatherWorker.workersSeen, 2);
  assert.equal(read.weatherWorker.unattributedBlobWorkers, 1);
  assert.equal(read.weatherWorker.alive, false);
});

test("auto-layouts ON: per label the kind, layout, groups read back and the declared bindings as an upper bound", async () => {
  const ran = await run1(["--cells", "E-BGL", "--readers", "auto-layouts"], {
    readerWorld: gpuWorld,
    onPageLoad: async (sandbox) => {
      vm.runInContext(PIPELINES_PAGE_CODE, sandbox);
      await sandbox.settled;
    },
  });
  assert.equal(ran.code, 0);
  const record = pageOf(ran.report, "E-BGL").readers.autoLayouts;
  assert.equal(record.available, true);
  assert.match(record.note, /UPPER BOUND/);
  assert.deepEqual(
    [
      record.pipelines,
      record.auto,
      record.explicit,
      record.compute,
      record.render,
    ],
    [4, 3, 1, 3, 1],
  );
  const row = (label) => record.rows.find((r) => r.label === label);
  assert.deepEqual(row("Cloud density cache refresh"), {
    label: "Cloud density cache refresh",
    kind: "compute",
    layout: "auto",
    created: 2,
    groupsRead: [0, 1],
    declaredGroups: [0, 1],
    declaredUpperBound: {
      sampledTextures: 1,
      uniformBuffers: 1,
      storageBuffers: 1,
      samplers: 1,
      storageTextures: 1,
      externalTextures: 0,
    },
    modulesKnown: 1,
    modulesGiven: 1,
  });
  assert.deepEqual(row("Explicit draw").declaredUpperBound, {
    sampledTextures: 1,
    uniformBuffers: 1,
    storageBuffers: 1,
    samplers: 1,
    storageTextures: 0,
    externalTextures: 1,
  });
  assert.equal(row("Explicit draw").layout, "explicit");
  assert.equal(row("Explicit draw").kind, "render");
  assert.deepEqual(row("Explicit draw").groupsRead, []);
  assert.deepEqual(row("Async scan").groupsRead, [0]);
  // The layout census keeps its own script and its own record.
  const census = ran.log.scripts.filter((s) =>
    s.content?.includes?.("__bindGroupLayoutCensus"),
  );
  assert.equal(census.length, 1);
  assert.equal(census[0].content, BIND_GROUP_LAYOUT_CENSUS_INIT_SOURCE);
  assert.ok(pageOf(ran.report, "E-BGL").layoutCensus);
});

test("every reader on a page without its seam reads NOT AVAILABLE naming the seam, never a zero", async () => {
  const ran = await run1(
    [
      "--cells",
      "E-F",
      "--readers",
      "cloud-stats,weather-ticks,weather-worker,refresh-counters,auto-layouts",
    ],
    {},
  );
  assert.equal(ran.code, 0);
  const r = pageOf(ran.report, "E-F").readers;
  const na = (seam) => ({ available: false, reason: `NOT AVAILABLE: ${seam}` });
  assert.deepEqual(
    r.cloudStats,
    na("viewer.scene.context.getRendererStatistics"),
  );
  assert.deepEqual(
    r.weatherTicks,
    na("viewer.scene.globe.defaultCloudCollection"),
  );
  assert.deepEqual(r.weatherWorker, na("globalThis.Worker"));
  assert.deepEqual(
    r.refreshCounters,
    na("viewer.scene.context.getRendererStatistics"),
  );
  assert.deepEqual(r.autoLayouts, na("GPUDevice.prototype.createShaderModule"));
  // A page that has statistics but no cloud block, and one with no collection method.
  const noBlock = await readCaptureOnce("cloud-stats", {
    readerWorld: statsWorld(undefined),
  });
  assert.deepEqual(
    noBlock.cloudStats,
    na("getRendererStatistics().volumetricClouds"),
  );
  const noMethod = await readCaptureOnce("weather-ticks", {
    readerWorld: () => ({
      viewer: { scene: { globe: { defaultCloudCollection: {} } } },
    }),
  });
  assert.deepEqual(noMethod.weatherTicks, na("CloudCollection#_updateWeather"));
  // A reader whose init script never ran names the script as the missing seam.
  const bare = await readerPage({});
  const noInit = await READERS_MODULE_REAL.readCaptureReaders(bare.page, [
    "weather-worker",
    "auto-layouts",
  ]);
  assert.match(
    noInit.weatherWorker.reason,
    /^NOT AVAILABLE: the Worker census init script/,
  );
  assert.match(
    noInit.autoLayouts.reason,
    /^NOT AVAILABLE: the automatic-layout census init script/,
  );
});

test("readers off: an unnamed reader installs no script and reads nothing", async () => {
  const ran = await run1(["--cells", "E-F", "--readers", "cloud-stats"], {
    readerWorld: statsWorld(CLOUD_BLOCK),
  });
  assert.equal(ran.log.scripts.length, 3);
  const keys = Object.keys(pageOf(ran.report, "E-F").readers);
  assert.deepEqual(keys, ["cloudStats"]);
  const off = await run1(["--cells", "E-F"], {
    readerWorld: statsWorld(CLOUD_BLOCK),
  });
  assert.equal(off.log.scripts.length, 3);
  assert.equal(pageOf(off.report, "E-F").readers, undefined);
  assert.equal(off.report.options.readers, undefined);
});

// ---------------------------------------------------------------------------
// Inertness mutants: each rule made unreachable. Every mutant test first runs
// the real behaviour assertion on the real module, then runs the SAME
// assertion on the mutant and requires an AssertionError (a mutant that crashes
// the check some other way is not a red the assertion produced).
// ---------------------------------------------------------------------------

const mutateReaders = (replacements) =>
  importMutated(READERS_MODULE, replacements);

/** Run `check` on the real module and on `mutant`; the mutant's run must fail by assertion. */
async function realPassesMutantRed(check, real, mutant) {
  await check(real);
  await assert.rejects(async () => check(mutant), assert.AssertionError);
}

for (const [name, check, anchor] of [
  ["cloud-stats", checkCloudStatsOn, `if (readers.includes("cloud-stats")) {`],
  [
    "weather-ticks",
    checkWeatherTicksOn,
    `if (readers.includes("weather-ticks")) {`,
  ],
  [
    "weather-worker",
    checkWorkerOn,
    `if (readers.includes("weather-worker")) {
    out.weatherWorker = buildWorkerRecord(`,
  ],
  [
    "refresh-counters",
    checkRefreshOn,
    `if (readers.includes("refresh-counters")) {`,
  ],
  [
    "auto-layouts",
    checkAutoOn,
    `if (readers.includes("auto-layouts")) {
    out.autoLayouts`,
  ],
]) {
  test(`mutant ${name}: the real reader satisfies its ON check and the unreachable read does not`, async () => {
    const mutated = await mutateReaders([
      [anchor, anchor.replace("if (", "if (false && ")],
    ]);
    await realPassesMutantRed(check, READERS_MODULE_REAL, mutated);
  });
}

test("mutant refresh-counters: the NOT AVAILABLE branch dropped, and the per-frame passes read in place of a lifetime count, each lose the uncounted check", async () => {
  const noUnavailableBranch = await mutateReaders([
    [`typeof before === "number" && typeof after === "number"`, `true`],
  ]);
  await realPassesMutantRed(
    checkRefreshUncounted,
    READERS_MODULE_REAL,
    noUnavailableBranch,
  );
  // The reader that reads the per-frame `passes` publishes 0 for the five
  // labels the engine never counts there.
  const readsPasses = await mutateReaders([
    [`const counts = block[lifetimeField];`, `const counts = block.passes;`],
  ]);
  await realPassesMutantRed(
    checkRefreshUncounted,
    READERS_MODULE_REAL,
    readsPasses,
  );
});

test("mutant cloud-stats: a flag field dropped from the field list, and one dropped from the page copy, each lose the flags check", async () => {
  const noListedField = await mutateReaders([
    [
      `  "halfResActive",
  "qualityFlags",
  "requestedQualityFlags",
]);`,
      `  "halfResActive",
  "requestedQualityFlags",
]);`,
    ],
  ]);
  await realPassesMutantRed(
    checkCloudStatsFlags,
    READERS_MODULE_REAL,
    noListedField,
  );
  const noCopiedField = await mutateReaders([
    [`        qualityFlags: copy(march.qualityFlags),\n`, ``],
  ]);
  await realPassesMutantRed(
    checkCloudStatsFlags,
    READERS_MODULE_REAL,
    noCopiedField,
  );
});

test("mutant: the worker and layout init sources made unreachable lose their ON checks", async () => {
  const noWorkerInit = await mutateReaders([
    [
      `if (readers.includes("weather-worker")) {
    sources.push(`,
      `if (false && readers.includes("weather-worker")) {
    sources.push(`,
    ],
  ]);
  // The installer reads the sources through the module the init-scripts piece
  // imports, so the module's own sources list is what is checked here.
  const checkWorkerSource = (readers) =>
    assert.deepEqual(readers.readerInitSources(["weather-worker"]), [
      READERS_MODULE_REAL.WORKER_CENSUS_INIT_SOURCE,
    ]);
  await realPassesMutantRed(
    checkWorkerSource,
    READERS_MODULE_REAL,
    noWorkerInit,
  );
  const noAutoInit = await mutateReaders([
    [
      `if (readers.includes("auto-layouts")) {
    sources.push(`,
      `if (false && readers.includes("auto-layouts")) {
    sources.push(`,
    ],
  ]);
  const checkAutoSource = (readers) =>
    assert.deepEqual(readers.readerInitSources(["auto-layouts"]), [
      READERS_MODULE_REAL.AUTO_LAYOUT_INIT_SOURCE,
    ]);
  await realPassesMutantRed(checkAutoSource, READERS_MODULE_REAL, noAutoInit);
});

test("mutant: the capture-time read gate in the init-scripts piece made unreachable drops every record", async () => {
  const mutated = await importMutated(INIT_SCRIPTS_MODULE, [
    ["return readers.length > 0", "return false && readers.length > 0"],
  ]);
  const checkReadGate = async (initScripts) => {
    const { page } = await loadedPage(["cloud-stats"], {
      readerWorld: statsWorld(CLOUD_BLOCK),
    });
    const record = await initScripts.readReaderRecords(page, {
      readers: "cloud-stats",
    });
    assert.equal(record.readers?.cloudStats?.frames, 731);
  };
  await realPassesMutantRed(checkReadGate, { readReaderRecords }, mutated);
});

// The after-destroy read is gated on the page's terminal action: a page whose
// viewer was never destroyed (the provoking steps ended the run, or the
// terminal action was a device loss) is NOT AVAILABLE, never labelled
// after-destroy; a caller that names no action is not gated.
async function checkTeardownGate(readers = READERS_MODULE_REAL) {
  const read = async (terminal) => {
    const { page, log } = await loadedPage(["weather-worker"], {
      readerWorld: workerWorld,
      onPageLoad: inPage(WORKERS_PAGE_CODE),
    });
    log.readerReads = [];
    const out = await readers.readTeardownReaders(
      page,
      ["weather-worker"],
      terminal,
    );
    return { record: out.weatherWorkerAfterDestroy, reads: log.readerReads };
  };
  const destroyed = await read({ terminalAction: "viewer.destroy" });
  assert.equal(destroyed.record.available, true);
  assert.equal(destroyed.record.phase, "after-destroy");
  assert.equal(destroyed.record.aliveAfterDestroy, true);
  const skipped = await read({ terminalAction: null });
  assert.equal(skipped.record.available, false);
  assert.match(
    skipped.record.reason,
    /^NOT AVAILABLE: the viewer was not destroyed on this page \(record\.deviceLoss\.terminal\.action was null, not "viewer\.destroy"\)$/,
  );
  assert.equal(skipped.record.aliveAfterDestroy, undefined);
  assert.deepEqual(skipped.reads, [], "the census was not read");
  const lost = await read({ terminalAction: "GPUDevice.destroy" });
  assert.equal(lost.record.available, false);
  assert.match(lost.record.reason, /action was "GPUDevice\.destroy"/);
  assert.equal(lost.record.aliveAfterDestroy, undefined);
  const ungated = await read(undefined);
  assert.equal(ungated.record.available, true);
  assert.equal(ungated.record.phase, "after-destroy");
}

test("weather-worker after destroy: read and labelled only when the terminal action was viewer.destroy", async () => {
  const mutated = await mutateReaders([
    [`Object.hasOwn(terminal, "terminalAction") &&`, `false &&`],
  ]);
  await realPassesMutantRed(checkTeardownGate, READERS_MODULE_REAL, mutated);
});

test("mutant: the probe's option pass-through, after-destroy read and refusal each lose their check", async () => {
  const destroyAll = inPage(
    "for (const w of Object.values(globalThis.pageWorkers)) w.terminate();",
  );
  const fake = {
    readerWorld: workerWorld,
    onPageLoad: inPage(WORKERS_PAGE_CODE),
    onViewerDestroy: destroyAll,
  };
  const args = ["--cells", "E-T-flight", "--readers", "weather-worker"];
  const checkPassThrough = async (probe) => {
    const ran = await run1(args, fake, probe.descriptor);
    assert.equal(
      pageOf(ran.report, "E-T-flight", "teardown").readers.weatherWorker
        .available,
      true,
      "without the pass-through the census script is never installed",
    );
  };
  const checkAfterDestroy = async (probe) => {
    const ran = await run1(args, fake, probe.descriptor);
    assert.ok(
      pageOf(ran.report, "E-T-flight", "teardown").readers
        .weatherWorkerAfterDestroy,
      "the teardown page carries the after-destroy read",
    );
  };
  const checkRefusal = async (probe) => {
    const ran = await run1(
      ["--cells", "E-F", "--readers", "bogus"],
      {},
      probe.descriptor,
    );
    assert.equal(ran.launched, 0, "no browser is launched for a bogus reader");
    assert.equal(ran.code, PROBE_EXIT_CODES.REFUSAL);
  };
  const real = { descriptor };
  const noPassThrough = await importMutated(PROBE_MODULE, [
    [
      "await installReaderInitScripts(page, options);",
      "await installReaderInitScripts(page, {});",
    ],
  ]);
  await realPassesMutantRed(checkPassThrough, real, noPassThrough);
  const noAfterDestroy = await importMutated(PROBE_MODULE, [
    [
      `if (entry.page === "teardown" && readersOf(options).length > 0) {`,
      `if (false && entry.page === "teardown" && readersOf(options).length > 0) {`,
    ],
  ]);
  await realPassesMutantRed(checkAfterDestroy, real, noAfterDestroy);
  const noRefusal = await importMutated(PROBE_MODULE, [
    [
      "parseReaders(parsed.readers);",
      "if (false) parseReaders(parsed.readers);",
    ],
  ]);
  await realPassesMutantRed(checkRefusal, real, noRefusal);
});

// ---------------------------------------------------------------------------
// The existing suites' page functions are untouched by the readers.
// ---------------------------------------------------------------------------

test("the readers' page functions are self-contained: each serialises and runs in an empty context", async () => {
  for (const [name, fn] of Object.entries(
    READERS_MODULE_REAL.READER_PAGE_FUNCTIONS,
  )) {
    const sandbox = vm.createContext({ requestAnimationFrame: noop });
    const answer = await vm.runInContext(
      `(${String(fn)})`,
      sandbox,
    )({
      frames: 1,
      labels: [],
    });
    assert.ok(
      typeof answer?.seam === "string",
      `${name} names its missing seam on an empty page, not a zero`,
    );
  }
});

// ---------------------------------------------------------------------------
// The keep-device teardown (lib/device-loss-steps.mjs, E-T-*-keep cells)
// ---------------------------------------------------------------------------

const DEVICE_LOSS_MODULE = fileURLToPath(
  new URL("./lib/device-loss-steps.mjs", import.meta.url),
);

/** A census whose rows are the given `{label, created, destroyed, freedByDevice}`. */
const censusOf = (rows) => ({
  byLabel: Object.fromEntries(
    rows.map((row) => [
      `buffer:${row.label}`,
      { kind: "buffer", liveBytes: 0, freedByDevice: 0, ...row },
    ]),
  ),
});

const KEEP_OWNERS = ["Owner A", "Owner B", "Owner C", "Owner D"];

/** The three censuses of a keep-device run, in the order the step reads them. */
function keepCensuses() {
  const reads = [
    // before: A, B and D exist, C was never created.
    censusOf([
      { label: "Owner A", created: 1, destroyed: 0 },
      { label: "Owner B", created: 1, destroyed: 0 },
      { label: "Owner D", created: 1, destroyed: 0 },
    ]),
    // after the viewer is destroyed (device still held): A destroyed.
    censusOf([
      { label: "Owner A", created: 1, destroyed: 1 },
      { label: "Owner B", created: 1, destroyed: 0 },
      { label: "Owner D", created: 1, destroyed: 0 },
    ]),
    // after the holder is released: B freed with the device, D never.
    censusOf([
      { label: "Owner A", created: 1, destroyed: 1 },
      { label: "Owner B", created: 1, destroyed: 0, freedByDevice: 1 },
      { label: "Owner D", created: 1, destroyed: 0 },
    ]),
  ];
  let index = 0;
  return async () => reads[Math.min(index++, reads.length - 1)];
}

async function keepDeviceStep(loadedModule, fakeOptions = {}) {
  const { page, log } = await readerPage({ ...fakeOptions });
  log.deviceLossCalls = [];
  const result = await loadedModule.runDeviceLossSteps({
    page,
    rig: { dials: {} },
    settle: async () => {},
    mode: "teardown-keep-device",
    readCensus: keepCensuses(),
    ownerLabels: KEEP_OWNERS,
  });
  return { result, log };
}

const classOf = (keepDevice, label) =>
  keepDevice.owners.find((row) => row.label === label)?.classification;

test("keep-device: per owner, released at teardown, only with the device, never, or not seen", async () => {
  const real = await import("./lib/device-loss-steps.mjs");
  const { result, log } = await keepDeviceStep(real);
  const keep = result.keepDevice;
  assert.equal(keep.available, true);
  assert.equal(classOf(keep, "Owner A"), "released at teardown");
  assert.equal(classOf(keep, "Owner B"), "released only with the device");
  assert.equal(classOf(keep, "Owner C"), "not seen");
  assert.equal(classOf(keep, "Owner D"), "never");
  const b = keep.owners.find((row) => row.label === "Owner B");
  assert.deepEqual(
    [b.liveAtTeardown, b.liveAfterRelease, b.freedByDeviceAfterRelease],
    [1, 0, 1],
  );
  // The holder is made before the viewer is destroyed and released after.
  assert.deepEqual(log.deviceLossCalls, [
    "pageHoldDevice",
    "pageDestroyViewer",
    "pageReleaseDeviceHolder",
  ]);
  assert.equal(result.mode, "teardown-keep-device");
  assert.equal(result.terminal.keepDevice, true);
  // The other modes' records carry no such field.
  const plain = await real.runDeviceLossSteps({
    page: (await readerPage({})).page,
    rig: { dials: {} },
    settle: async () => {},
    mode: "teardown",
    readCensus: keepCensuses(),
    ownerLabels: KEEP_OWNERS,
  });
  assert.equal(plain.keepDevice, undefined);
});

test("keep-device: a holder on a different device, or none at all, reads NOT AVAILABLE naming why", async () => {
  const real = await import("./lib/device-loss-steps.mjs");
  const other = await keepDeviceStep(real, {
    deviceHolder: { held: true, sameDevice: false },
  });
  assert.equal(other.result.keepDevice.available, false);
  assert.match(
    other.result.keepDevice.reason,
    /^NOT AVAILABLE: the holder's device is not the viewer's device/,
  );
  assert.equal(other.result.keepDevice.owners, undefined);
  // The holder was made, so it is released even though it did not count.
  assert.ok(other.log.deviceLossCalls.includes("pageReleaseDeviceHolder"));

  const none = await keepDeviceStep(real, {
    deviceHolder: { held: false, reason: "CesiumWidget.createAsync" },
  });
  assert.equal(
    none.result.keepDevice.reason,
    "NOT AVAILABLE: a second holder of the viewer's device (CesiumWidget.createAsync)",
  );
  assert.equal(
    none.log.deviceLossCalls.includes("pageReleaseDeviceHolder"),
    false,
  );
});

// ---------------------------------------------------------------------------
// The holder's page functions, run as written against a fake Cesium module
// ---------------------------------------------------------------------------

const DEVICE_LOSS_REAL = await import("./lib/device-loss-steps.mjs");

const dataModule = (source) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
// A module whose only factory is the engine's `CesiumWidget.createAsync`; the
// widget it builds is whatever the case's world hands back.
const CREATE_ASYNC_MODULE = dataModule(
  "export const CesiumWidget = { createAsync: (container, options) => globalThis.__holderWorld.createAsync(container, options) };",
);
// A module with a factory of another name (the call this page must not make).
const CREATE_ONLY_MODULE = dataModule(
  'export const CesiumWidget = { create() { throw new Error("not the engine\'s factory"); } };',
);
const BROKEN_MODULE = dataModule("export const = ;");

/** A widget standing on `device`, counting its `destroy` calls. */
const deviceWidget = (device, { destroyThrows = false } = {}) => ({
  scene: { context: { _device: device } },
  destroyed: 0,
  destroy() {
    this.destroyed++;
    if (destroyThrows) {
      throw new Error("widget destroy failed");
    }
  },
});

/**
 * Run `fn(world)` with the page globals the holder functions read: a viewer on
 * `viewerDevice` (none when undefined), a `document` that hands out recorded
 * containers, and a module world whose `createAsync` builds `makeWidget(world)`
 * or throws `createThrows`. The globals are put back afterwards.
 */
async function withHolderPage(
  { viewerDevice, makeWidget = () => null, createThrows = null },
  fn,
) {
  const root = globalThis;
  const saved = {
    viewer: root.viewer,
    document: root.document,
    world: root.__holderWorld,
    holder: root.__landingDeviceHolder,
  };
  const world = { created: [], containers: [], widgets: [] };
  world.createAsync = async (container, options) => {
    world.created.push({ container, options });
    if (createThrows !== null) {
      throw new Error(createThrows);
    }
    const widget = makeWidget(world);
    world.widgets.push(widget);
    return widget;
  };
  root.viewer = {
    scene: {
      context: viewerDevice === undefined ? {} : { _device: viewerDevice },
    },
  };
  root.document = {
    createElement: () => {
      const element = {
        style: {},
        attached: false,
        removed: 0,
        remove() {
          this.removed++;
        },
      };
      world.containers.push(element);
      return element;
    },
    body: {
      appendChild(element) {
        element.attached = true;
      },
    },
  };
  root.__holderWorld = world;
  root.__landingDeviceHolder = undefined;
  try {
    return await fn(world);
  } finally {
    root.viewer = saved.viewer;
    root.document = saved.document;
    root.__holderWorld = saved.world;
    root.__landingDeviceHolder = saved.holder;
  }
}

// A holder made by `CesiumWidget.createAsync` is held, says whether it stands
// on the viewer's device, and is destroyed, removed and forgotten on release.
async function checkHoldDevice(steps = DEVICE_LOSS_REAL) {
  const viewerDevice = { name: "the viewer's device" };
  await withHolderPage(
    { viewerDevice, makeWidget: () => deviceWidget(viewerDevice) },
    async (world) => {
      const answer = await steps.pageHoldDevice({
        moduleUrl: CREATE_ASYNC_MODULE,
      });
      assert.deepEqual(answer, { held: true, sameDevice: true });
      assert.equal(world.created.length, 1);
      assert.equal(world.created[0].container, world.containers[0]);
      assert.equal(world.containers[0].attached, true);
      assert.equal(world.created[0].options.contextOptions.renderer, "webgpu");
      assert.equal(
        globalThis.__landingDeviceHolder?.widget,
        world.widgets[0],
        "the page holds the widget",
      );
      const released = await steps.pageReleaseDeviceHolder();
      assert.deepEqual(released, { released: true, threw: null });
      assert.equal(world.widgets[0].destroyed, 1, "the widget was destroyed");
      assert.equal(world.containers[0].removed, 1);
      assert.equal(globalThis.__landingDeviceHolder, undefined);
    },
  );
  const otherDevice = { name: "a device of the holder's own" };
  await withHolderPage(
    { viewerDevice, makeWidget: () => deviceWidget(otherDevice) },
    async () => {
      const answer = await steps.pageHoldDevice({
        moduleUrl: CREATE_ASYNC_MODULE,
      });
      assert.deepEqual(answer, { held: true, sameDevice: false });
    },
  );
}

// Every way the holder cannot be made reads NOT AVAILABLE naming its seam, and
// leaves no widget, container or page holder behind.
async function checkHoldDeviceNotAvailable(steps = DEVICE_LOSS_REAL) {
  const viewerDevice = { name: "the viewer's device" };
  const classified = (hold) =>
    DEVICE_LOSS_REAL.classifyKeepDeviceOwners({
      hold,
      afterTeardown: [],
      afterRelease: [],
    }).reason;
  await withHolderPage(
    { viewerDevice: undefined, makeWidget: () => deviceWidget(viewerDevice) },
    async (world) => {
      const answer = await steps.pageHoldDevice({
        moduleUrl: CREATE_ASYNC_MODULE,
      });
      assert.deepEqual(answer, {
        held: false,
        reason: "viewer.scene.context._device",
      });
      assert.equal(world.created.length, 0, "no widget was made");
      assert.equal(globalThis.__landingDeviceHolder, undefined);
    },
  );
  await withHolderPage(
    { viewerDevice, makeWidget: () => deviceWidget(viewerDevice) },
    async (world) => {
      const answer = await steps.pageHoldDevice({
        moduleUrl: CREATE_ONLY_MODULE,
      });
      assert.deepEqual(answer, {
        held: false,
        reason: "CesiumWidget.createAsync",
      });
      assert.equal(world.containers.length, 0);
      assert.equal(
        classified(answer),
        "NOT AVAILABLE: a second holder of the viewer's device (CesiumWidget.createAsync)",
      );
    },
  );
  await withHolderPage(
    { viewerDevice, createThrows: "pool exhausted" },
    async (world) => {
      const answer = await steps.pageHoldDevice({
        moduleUrl: CREATE_ASYNC_MODULE,
      });
      assert.equal(answer.held, false);
      assert.equal(
        answer.reason,
        "CesiumWidget.createAsync threw: pool exhausted",
      );
      assert.match(classified(answer), /^NOT AVAILABLE: .*createAsync threw/);
      assert.equal(world.containers[0].removed, 1, "the container was removed");
      assert.equal(globalThis.__landingDeviceHolder, undefined);
    },
  );
  await withHolderPage(
    { viewerDevice, makeWidget: () => deviceWidget(viewerDevice) },
    async () => {
      const answer = await steps.pageHoldDevice({ moduleUrl: BROKEN_MODULE });
      assert.equal(answer.held, false);
      assert.match(answer.reason, /could not be imported/);
    },
  );
}

// Releasing: nothing held answers released false; a widget that throws on
// destroy is reported, and the holder is forgotten and its container removed.
async function checkReleaseDeviceHolder(steps = DEVICE_LOSS_REAL) {
  await withHolderPage({ viewerDevice: {} }, async () => {
    assert.deepEqual(await steps.pageReleaseDeviceHolder(), {
      released: false,
      threw: null,
    });
  });
  const viewerDevice = {};
  await withHolderPage(
    {
      viewerDevice,
      makeWidget: () => deviceWidget(viewerDevice, { destroyThrows: true }),
    },
    async (world) => {
      await steps.pageHoldDevice({ moduleUrl: CREATE_ASYNC_MODULE });
      const released = await steps.pageReleaseDeviceHolder();
      assert.deepEqual(released, {
        released: false,
        threw: "widget destroy failed",
      });
      assert.equal(world.widgets[0].destroyed, 1);
      assert.equal(world.containers[0].removed, 1);
      assert.equal(globalThis.__landingDeviceHolder, undefined);
    },
  );
}

test("pageHoldDevice and pageReleaseDeviceHolder, run as written: same device, another device, and the release", async () => {
  await checkHoldDevice();
  await checkReleaseDeviceHolder();
});

test("pageHoldDevice: no viewer device, a module without createAsync, a factory that throws and a module that does not load each read NOT AVAILABLE naming the seam", async () => {
  await checkHoldDeviceNotAvailable();
});

test("holder mutants: the device comparison, the factory name, the viewer-device guard and the release each lose a behaviour case", async () => {
  const holder = (replacements) =>
    importMutated(DEVICE_LOSS_MODULE, replacements);
  // The comparison made unconditionally true: another device reads as the same.
  await realPassesMutantRed(
    checkHoldDevice,
    DEVICE_LOSS_REAL,
    await holder([
      ["holderDevice === device", "(true || holderDevice === device)"],
    ]),
  );
  // The factory name reverted to `create`, which the module does not export.
  await realPassesMutantRed(
    checkHoldDevice,
    DEVICE_LOSS_REAL,
    await holder([
      [
        'typeof Cesium?.CesiumWidget?.createAsync !== "function"',
        'typeof Cesium?.CesiumWidget?.create !== "function"',
      ],
      [
        "await Cesium.CesiumWidget.createAsync(container, {",
        "await Cesium.CesiumWidget.create(container, {",
      ],
    ]),
  );
  // The guard on the viewer's device made unreachable.
  await realPassesMutantRed(
    checkHoldDeviceNotAvailable,
    DEVICE_LOSS_REAL,
    await holder([["if (!device) {", "if (false && !device) {"]]),
  );
  // The guard on the factory made unreachable.
  await realPassesMutantRed(
    checkHoldDeviceNotAvailable,
    DEVICE_LOSS_REAL,
    await holder([
      [
        'if (typeof Cesium?.CesiumWidget?.createAsync !== "function") {',
        'if (false && typeof Cesium?.CesiumWidget?.createAsync !== "function") {',
      ],
    ]),
  );
  // The widget's destroy and the holder's clearing each skipped.
  await realPassesMutantRed(
    checkReleaseDeviceHolder,
    DEVICE_LOSS_REAL,
    await holder([["holder.widget.destroy();", "void holder.widget;"]]),
  );
  await realPassesMutantRed(
    checkHoldDevice,
    DEVICE_LOSS_REAL,
    await holder([
      [
        "/** @type {any} */ (globalThis).__landingDeviceHolder = undefined;",
        "void 0;",
      ],
    ]),
  );
});

test("keep-device mutants: the classification, the sameDevice check, the holder's release and the mode each lose their check", async () => {
  const mutate = (replacements) =>
    importMutated(DEVICE_LOSS_MODULE, replacements);
  const checkClassification = async (steps) => {
    const { result } = await keepDeviceStep(steps);
    assert.equal(
      classOf(result.keepDevice, "Owner B"),
      "released only with the device",
    );
  };
  await realPassesMutantRed(
    checkClassification,
    DEVICE_LOSS_REAL,
    await mutate([
      [
        "} else if (final !== null && final.live === 0) {",
        "} else if (false && final !== null && final.live === 0) {",
      ],
    ]),
  );
  const checkSameDeviceRefusal = async (steps) => {
    const { result } = await keepDeviceStep(steps, {
      deviceHolder: { held: true, sameDevice: false },
    });
    assert.equal(
      result.keepDevice.available,
      false,
      "a holder on another device does not classify",
    );
  };
  await realPassesMutantRed(
    checkSameDeviceRefusal,
    DEVICE_LOSS_REAL,
    await mutate([
      [
        "if (hold.sameDevice !== true) {",
        "if (false && hold.sameDevice !== true) {",
      ],
    ]),
  );
  const checkRelease = async (steps) => {
    const { log } = await keepDeviceStep(steps);
    assert.equal(log.deviceLossCalls.includes("pageReleaseDeviceHolder"), true);
  };
  await realPassesMutantRed(
    checkRelease,
    DEVICE_LOSS_REAL,
    await mutate([
      [
        "hold?.held === true ? await page.evaluate(pageReleaseDeviceHolder) : null",
        "false ? await page.evaluate(pageReleaseDeviceHolder) : null",
      ],
    ]),
  );
  const checkMode = async (steps) => {
    const { log } = await keepDeviceStep(steps);
    assert.equal(log.deviceLossCalls.includes("pageHoldDevice"), true);
  };
  await realPassesMutantRed(
    checkMode,
    DEVICE_LOSS_REAL,
    await mutate([
      [
        "} else if (mode === KEEP_DEVICE_MODE) {",
        "} else if (false && mode === KEEP_DEVICE_MODE) {",
      ],
    ]),
  );
});

test("E-T-flight-keep and E-T-on-keep: a plain and a keep-device teardown page each on their rigs, right after E-T-on, outside the defaults", async () => {
  const names = Object.keys(LANDING_CELLS);
  assert.equal(names[names.indexOf("E-T-on") + 1], "E-T-flight-keep");
  assert.equal(names[names.indexOf("E-T-on") + 2], "E-T-on-keep");
  assert.equal(
    LANDING_CELLS["E-T-flight-keep"].rig,
    "cloud-flight-multideck-hdr-1080p",
  );
  assert.equal(
    LANDING_CELLS["E-T-on-keep"].rig,
    "cloud-flight-multideck-hdr-1080p-eon",
  );
  assert.equal(DEFAULT_CELLS.includes("E-T-flight-keep"), false);
  assert.equal(DEFAULT_CELLS.includes("E-T-on-keep"), false);
  assert.deepEqual(pagesOfCell(LANDING_CELLS["E-T-flight"]), [
    "teardown",
    "forced-loss",
  ]);
  assert.deepEqual(pagesOfCell(LANDING_CELLS["E-T-flight-keep"]), [
    "teardown",
    "teardown-keep-device",
  ]);
  const ran = await run1(
    ["--cells", "E-T-flight-keep,E-T-on-keep", "--owner-labels", "Owner A"],
    { deviceHolder: { held: true, sameDevice: false } },
  );
  assert.equal(ran.code, 0);
  assert.deepEqual(
    ran.report.pages.map((p) => [p.cell, p.page]),
    [
      ["E-T-flight-keep", "teardown"],
      ["E-T-flight-keep", "teardown-keep-device"],
      ["E-T-on-keep", "teardown"],
      ["E-T-on-keep", "teardown-keep-device"],
    ],
  );
  // The plain teardown page carries no keep-device record.
  assert.equal(ran.report.pages[0].deviceLoss.keepDevice, undefined);
  const keep = ran.report.pages[1].deviceLoss.keepDevice;
  assert.equal(keep.available, false);
  assert.match(keep.reason, /^NOT AVAILABLE: /);
});

// The probe hands the page's terminal action to the after-teardown read: a
// teardown page whose provoking steps lost the device never destroyed its
// viewer, so its worker read is NOT AVAILABLE, not an after-destroy read.
async function behaviourTeardownGateThroughProbe(probe) {
  const ran = await run1(
    ["--cells", "E-T-wx", "--readers", "weather-worker"],
    {
      readerWorld: workerWorld,
      onPageLoad: inPage(WORKERS_PAGE_CODE),
      // Alive at the capture's liveness read (the page's first), lost by the
      // time the clock step reads the gate.
      gateDeviceLost: ({ gateReads }) =>
        gateReads >= 1
          ? { reason: "destroyed", message: "lost in the steps" }
          : null,
    },
    probe,
  );
  const page = pageOf(ran.report, "E-T-wx", "teardown");
  assert.equal(page.deviceLoss.terminal.action, null);
  const after = page.readers.weatherWorkerAfterDestroy;
  assert.ok(after, "the teardown page carries the after-destroy slot");
  assert.equal(after.available, false);
  assert.match(after.reason, /the viewer was not destroyed on this page/);
  assert.equal(Object.hasOwn(after, "aliveAfterDestroy"), false);
}

test("R-6 through the probe: a teardown page that lost its device before the destroy reads NOT AVAILABLE after it", async () => {
  await behaviourTeardownGateThroughProbe(descriptor);
});

test("R-6 (mutant): the probe passing no terminal action labels the read after-destroy anyway", async () => {
  const mutated = await importMutated(PROBE_MODULE, [
    [
      "terminalAction: record.deviceLoss?.terminal?.action ?? null,",
      'terminalAction: "viewer.destroy",',
    ],
  ]);
  await assert.rejects(
    behaviourTeardownGateThroughProbe(mutated.descriptor),
    assert.AssertionError,
  );
});
