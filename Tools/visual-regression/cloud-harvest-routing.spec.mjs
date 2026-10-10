// cloud-harvest-routing.spec.mjs — the six cloud probes the probe-kit harvest
// (cloud family, round 1) moved onto the runtime. Pure Node: no browser, no
// network, no GPU.
//
// @purpose Drives the six harvested cloud probes (phase, ambient, tod, aerial, special, features) through runProbe on a stub browser whose canvas reads and element screenshots are hand-painted PNGs, so each descriptor is known to stage its rigs, take its origin from the runtime, measure the canvas in Node with the kit metrics and bind every clause to the exit code before an Edge slot is spent on it; the demo probes' own page functions run against a stub window, so their dials are seen to reach the cloud collection.
// @status ACTIVE
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. Every frame below is painted so a
// clause lands on a known side of its bar; no number here is evidence about
// the renderer, and none of the six has run on Edge in its harvested form.
// What it does prove is the chain: argv -> preflight -> slot -> cells (rig
// staging, captures under their banked names, Node-side measurement) ->
// verdicts -> receipt -> exit code, plus the three properties the harvest
// set on purpose: every cloud dial goes through the harness (the D1/D2 probe
// defects; for the demo probes B4 runs their real page functions, pass-2
// finding R-B), the W-series gates stage the rigs they import, and all six
// measure the canvas, so DOM chrome that an element screenshot would take
// cannot pass a cloudless frame (B6; finding R1 of pass 1 for the W-series,
// R-A of pass 2 for the demo pair).
//
// THE MUTATION CONTROLS make five assertions non-decorative: an inert clause
// (`pass: true`) turns a failing fixture green, a probe that re-hard-codes
// port 8080 is caught by the origin assertion, a phase gate (C3) or a demo
// probe (C5) put back on an element screenshot passes B6's cloudless
// fixture, and a demo probe that writes its toggles onto the globe again
// (C4) fails B4.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isUnderTmpdir, mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { deriveLifecycleDeadline } from "./lib/probe-lifecycle-run.mjs";
import { CLOUD_RIG_READ_PATH } from "./lib/cloud-rig-stage.mjs";
import { PROBE_EXIT_CODES, runProbe } from "./lib/probe-runtime.mjs";
import { loadRigs } from "./lib/rig-registry.mjs";

import { descriptor as aerial } from "./probe-cloud-aerial.mjs";
import { descriptor as ambient } from "./probe-cloud-ambient.mjs";
import { descriptor as features } from "./probe-cloud-features.mjs";
import { descriptor as phase } from "./probe-cloud-phase.mjs";
import { descriptor as special } from "./probe-cloud-special.mjs";
import { descriptor as tod } from "./probe-cloud-tod.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Small frames: every bar in these probes is a count, a ratio or a mean. */
const W = 160;
const H = 100;

/**
 * Paint a W x H frame and encode it as the PNG a screenshot would return.
 *
 * @param {(x: number, y: number) => number[]} painter RGB for a pixel.
 * @returns {Buffer} PNG bytes.
 */
function png(painter) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      data.set([...painter(x, y), 255], (y * W + x) * 4);
    }
  }
  return Buffer.from(encodeRgbaPng(data, W, H));
}

const inBand = (y) => y < Math.floor(H * 0.6);
const inDeck = (x, y) =>
  x >= Math.floor(W * 0.42) &&
  x < Math.floor(W * 0.95) &&
  y >= Math.floor(H * 0.08) &&
  y < Math.floor(H * 0.86);

// W1: a backlit band with a bright rim (p95/median 250/100) and a flat
// frontlit band (contrast 1).
const RIMMED = png((x, y) =>
  inBand(y) ? (x % 10 < 7 ? [100, 100, 100] : [250, 250, 250]) : [0, 0, 0],
);
const FLAT = png((x, y) => (inBand(y) ? [120, 120, 120] : [0, 0, 0]));

// A canvas with no cloud on it: the frame a gate must fail on, whatever an
// element screenshot of the same page would add.
const CLOUDLESS = png(() => [0, 0, 0]);

// W2: p10 40 (0.157 of 255) and p90 200.
const SIDELIT = png((x, y) =>
  inBand(y) ? (x % 5 === 0 ? [40, 40, 40] : [200, 200, 210]) : [0, 0, 0],
);
// A blown-out band: p10 220 is above the 0.5 ceiling and p90 - p10 is 0. (The
// floor of 18 makes a p10 below 0.06 of 255 unreachable, so the ceiling is
// the side a shadow-floor failure can be shown on.)
const BLOWN = png((x, y) => (inBand(y) ? [220, 220, 220] : [0, 0, 0]));

// W3: warm (R/B 1.67) and neutral (1.0) bands.
const WARM = png((x, y) => (inBand(y) ? [200, 150, 120] : [0, 0, 0]));
const NEUTRAL = png((x, y) => (inBand(y) ? [150, 150, 150] : [0, 0, 0]));

// W4: the reference at the stubbed 60 degree sun is (0.62, 0.72, 0.85); the
// near deck moves 10 % of the way toward it, the far deck 50 %.
const REF = [0.62 * 255, 0.72 * 255, 0.85 * 255];
const toward = (fraction) =>
  png(() => [0, 1, 2].map((c) => Math.round(100 + (REF[c] - 100) * fraction)));
const DECK_OFF = toward(0);
const NEAR_ON = toward(0.1);
const FAR_ON = toward(0.5);

// E3 / B611: a grey deck, and treated decks inside the deck region only.
const deckFrame = (inside, outside = [120, 120, 120]) =>
  png((x, y) => (inDeck(x, y) ? inside : outside));
const GREY_DECK = deckFrame([150, 150, 150], [0, 0, 0]);
const NOCTILUCENT = deckFrame([120, 140, 240]);
const NACREOUS = deckFrame([200, 150, 170]);
const SPECIAL_OFF = deckFrame([120, 120, 120]);
const THINNED = png((x, y) =>
  inDeck(x, y) ? (y % 2 === 0 ? [150, 150, 150] : [0, 0, 0]) : [0, 0, 0],
);
const THINNED_MORE = png((x, y) =>
  inDeck(x, y) ? (y % 4 === 0 ? [150, 150, 150] : [0, 0, 0]) : [0, 0, 0],
);
const shaped = (grey) => deckFrame([grey, grey, grey], [0, 0, 0]);

// Pass-3 advisory A4: fixtures whose MEASURED values sit where a fidelity
// constant decides them.
//
// W1 with dim band pixels: of every ten columns, six are (100, 100, 100), one
// is (20, 20, 20) (max channel 20, under the cloud floor of 24) and three are
// (250, 250, 250). Over the 60 band rows that is 96 x 60 + 48 x 60 = 8,640
// cloud pixels; a floor that admitted the dim column would count 9,600.
const RIMMED_DIM = png((x, y) =>
  inBand(y)
    ? x % 10 < 6
      ? [100, 100, 100]
      : x % 10 === 6
        ? [20, 20, 20]
        : [250, 250, 250]
    : [0, 0, 0],
);
// E3 just above a bar: a 73 x 20 block (x 70-142, y 10-29, inside the deck
// region x 67-151, y 8-85) moves from (120, 120, 120) to (120, 120, 220).
// Each moved pixel's luma moves 0.114 x 100 = 11.4, so the whole-frame mean
// is 1,460 x 11.4 / 16,000 = 1.04025: 1.04 at three places, which clears
// "> 1.0", and 1.0 at one place, which does not.
const inNlcBlock = (x, y) => x >= 70 && x < 143 && y >= 10 && y < 30;
const NLC_NEAR_BAR = png((x, y) =>
  inNlcBlock(x, y) ? [120, 120, 220] : [120, 120, 120],
);
// The same block, plus a 10 x 10 red shift OUTSIDE the deck region (x 0-9,
// y 0-9): luma 0.299 x 100 = 29.9 moves past the bar of 10 there, so a cool
// shift read over the whole frame would count it. Over the deck region the
// cool shift is the block's alone: dr 0, db 100, cool 100, n 1,460.
const NLC_OUTSIDE_RED = png((x, y) =>
  inNlcBlock(x, y)
    ? [120, 120, 220]
    : x < 10 && y < 10
      ? [220, 120, 120]
      : [120, 120, 120],
);

/**
 * The six probes. `frames` is the screenshot series in capture order; a
 * `failing` series flips the named clauses.
 */
const PROBES = [
  {
    descriptor: phase,
    file: "probe-cloud-phase.mjs",
    captures: ["cloud-phase-toward-sun", "cloud-phase-away-sun"],
    rigs: ["cloud-phase-backlit", "cloud-phase-frontlit"],
    verdicts: 3,
    populated: "clouds-render/run0",
    frames: [RIMMED, FLAT],
    failing: { frames: [FLAT, RIMMED], ids: ["silver-lining/run0"] },
  },
  {
    descriptor: ambient,
    file: "probe-cloud-ambient.mjs",
    captures: ["cloud-ambient"],
    rigs: ["cloud-ambient-sidelit"],
    verdicts: 4,
    populated: "clouds-render/run0",
    frames: [SIDELIT],
    failing: {
      frames: [BLOWN],
      ids: ["shadow-lifted/run0", "form-preserved/run0"],
    },
  },
  {
    descriptor: tod,
    file: "probe-cloud-tod.mjs",
    captures: ["cloud-tod-dawn", "cloud-tod-noon", "cloud-tod-dusk"],
    rigs: ["cloud-tod-dawn", "cloud-tod-noon", "cloud-tod-dusk"],
    verdicts: 5,
    populated: "clouds-render/run0",
    frames: [WARM, NEUTRAL, WARM],
    failing: {
      frames: [NEUTRAL, NEUTRAL, WARM],
      ids: ["dawn-warm/run0", "noon-less-warm/run0"],
    },
  },
  {
    descriptor: aerial,
    file: "probe-cloud-aerial.mjs",
    captures: [
      "cloud-aerial-near-off",
      "cloud-aerial-near",
      "cloud-aerial-far-off",
      "cloud-aerial-far",
      "cloud-aerial-beauty",
    ],
    rigs: [
      "cloud-aerial-near-deck",
      "cloud-aerial-near-deck",
      "cloud-aerial-far-deck",
      "cloud-aerial-far-deck",
      "cloud-aerial-dusk-beauty",
    ],
    verdicts: 5,
    populated: "decks-populated/run0",
    frames: [DECK_OFF, NEAR_ON, DECK_OFF, FAR_ON, FAR_ON],
    failing: {
      frames: [DECK_OFF, FAR_ON, DECK_OFF, NEAR_ON, FAR_ON],
      ids: ["far-blends/run0", "distance-graded/run0", "near-less-hazed/run0"],
    },
  },
  {
    descriptor: special,
    file: "probe-cloud-special.mjs",
    demo: true,
    toggles: { key: "cloudSpecial", values: ["noctilucent", "nacreous"] },
    populated: "noctilucent-changes-render/run0",
    captures: [
      "special-off",
      "special-off2",
      "special-noctilucent",
      "special-nacreous",
      "special-off-restored",
    ],
    verdicts: 7,
    frames: [SPECIAL_OFF, SPECIAL_OFF, NOCTILUCENT, NACREOUS, SPECIAL_OFF],
    failing: {
      frames: [SPECIAL_OFF, SPECIAL_OFF, SPECIAL_OFF, NACREOUS, NACREOUS],
      ids: [
        "noctilucent-changes-render/run0",
        "noctilucent-cools/run0",
        "restore-returns-to-baseline/run0",
      ],
    },
  },
  {
    descriptor: features,
    file: "probe-cloud-features.mjs",
    demo: true,
    toggles: {
      key: "cloudFeature",
      values: ["asperitas", "fluctus", "arcus", "virga", "praecipitatio"],
    },
    populated: "asperitas-changes-render/run0",
    captures: [
      "features-off",
      "features-off2",
      "features-asperitas",
      "features-fluctus",
      "features-arcus",
      "features-virga",
      "features-praecipitatio",
      "features-off-restored",
    ],
    verdicts: 9,
    frames: [
      GREY_DECK,
      GREY_DECK,
      shaped(200),
      shaped(180),
      shaped(100),
      THINNED,
      THINNED_MORE,
      GREY_DECK,
    ],
    failing: {
      frames: [
        GREY_DECK,
        GREY_DECK,
        shaped(200),
        shaped(180),
        shaped(100),
        GREY_DECK,
        GREY_DECK,
        GREY_DECK,
      ],
      ids: [
        "virga-changes-render/run0",
        "virga-thins-deck/run0",
        "praecipitatio-differs/run0",
      ],
    },
  },
];

/**
 * The demo page's `window` as the demo probes' page functions see it: a
 * viewer whose globe holds the default cloud collection, and the cloud probe
 * harness's `configure` as a spy that records each call and applies its dials
 * to the collection's volumetric object, as the real harness does.
 */
function demoWindow(log) {
  const collection = { cloudType: undefined, volumetric: {} };
  const scene = {
    globe: { defaultCloudCollection: collection },
    requestRender() {},
  };
  return {
    viewer: { scene, clock: { shouldAnimate: true } },
    __cloudProbe: {
      configure(options) {
        log.configured.push(options);
        Object.assign(collection.volumetric, options.volumetric);
        return {
          ok: true,
          config: { ...options.volumetric },
          rendererType: "webgpu",
        };
      },
    },
  };
}

/**
 * Run one of a probe's own page functions with `window` bound to the stub, so
 * what it writes lands where the stub can see it. The functions are
 * synchronous; the global is restored before anything else runs.
 */
function runInWindow(win, fn, arg) {
  const saved = globalThis.window;
  globalThis.window = win;
  try {
    return fn(arg);
  } finally {
    if (saved === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = saved;
    }
  }
}

/**
 * A stub page. Each in-page call is answered by the text of the function the
 * probe handed `page.evaluate`, so a rewritten page helper reaches the
 * `unstubbed` branch and fails loudly. The demo probes' collection and
 * volumetric functions are not answered by their text: they are identified
 * by it and then EXECUTED against `demoWindow`, so B4 sees what they write.
 *
 * `frames` is the series the page's pixels come from, in capture order: a
 * canvas read (`settleCloudRigInPage` returns it as a PNG data URL).
 * `element`, when given, is a separate series that ONLY an element
 * screenshot returns — the shape of DOM chrome, which an element screenshot
 * takes and a canvas read does not.
 */
function fakePage(
  frames,
  log,
  { boot = { ok: true }, element, gateErrors = [] } = {},
) {
  let shots = 0;
  let elementShots = 0;
  let frameNumber = 0;
  const win = demoWindow(log);
  log.window = win;
  const nextFrame = () => {
    const frame = frames[Math.min(shots, frames.length - 1)];
    shots += 1;
    log.shots += 1;
    return frame;
  };
  return {
    on() {},
    async addInitScript(fn) {
      log.initScripts.push(String(fn).slice(0, 60));
    },
    async addStyleTag() {},
    async goto(url) {
      log.gotos.push(url);
    },
    async waitForFunction() {},
    async waitForTimeout(ms) {
      log.waits.push(ms);
    },
    async evaluate(fn, arg) {
      const source = String(fn);
      if (source.includes("__captureLiveness")) {
        frameNumber += 1;
        return { gateArmed: true, deviceLost: null, frameNumber };
      }
      if (source.includes("window.startup")) {
        log.calls.push("boot");
        return boot;
      }
      if (source.includes("__armWebGPUDevice")) {
        log.calls.push("arm");
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        log.calls.push("gate");
        return { errors: [...gateErrors], deviceLost: null, armedDevices: 1 };
      }
      if (source.includes("stageCloudRigInPage")) {
        log.staged.push(arg);
        return {
          rigId: arg.rigId,
          config: arg.volumetric,
          rendererType: "webgpu",
          headingRadians: arg.camera.heading,
          sunHeadingDeg: 12.5,
          sunElevationDeg: 7.5,
        };
      }
      if (source.includes("settleCloudRigInPage")) {
        log.settled.push(arg);
        frameNumber += 1;
        return {
          frames: arg.frames,
          sunElevationDeg: 60,
          frameNumber,
          png: `data:image/png;base64,${nextFrame().toString("base64")}`,
        };
      }
      if (source.includes("collectionCloudType")) {
        log.collection.push(arg);
        return runInWindow(win, fn, arg);
      }
      if (source.includes("__undef__")) {
        log.volumetric.push(arg);
        return runInWindow(win, fn, arg);
      }
      log.calls.push("unstubbed");
      return undefined;
    },
    locator(selector) {
      log.selectors.push(selector);
      return {
        async count() {
          return 1;
        },
        async screenshot() {
          if (element) {
            const frame = element[Math.min(elementShots, element.length - 1)];
            elementShots += 1;
            log.elementShots += 1;
            return frame;
          }
          return nextFrame();
        },
      };
    },
  };
}

function fakeLaunch(frames, log, options) {
  return async () => {
    log.launches += 1;
    let connected = true;
    return {
      async newPage(pageOptions) {
        log.viewports.push(pageOptions?.viewport ?? null);
        return fakePage(frames, log, options);
      },
      async close() {
        log.closes += 1;
        connected = false;
      },
      isConnected: () => connected,
    };
  };
}

/**
 * Run one descriptor end to end in a sandbox under `os.tmpdir()`.
 */
async function drive(entry, { frames, argv = [], page, descriptor } = {}) {
  // One lane temp root (Tools/lib/lane-tmp.mjs), so a killed run leaves one
  // sweepable directory rather than a sandbox at the Temp root.
  const root = mkLaneTmp("cloud-harvest-routing-");
  assert.ok(isUnderTmpdir(root), "the sandbox must live under tmpdir");
  const out = path.join(root, "out");
  const log = {
    calls: [],
    gotos: [],
    waits: [],
    selectors: [],
    viewports: [],
    initScripts: [],
    staged: [],
    settled: [],
    collection: [],
    volumetric: [],
    configured: [],
    window: null,
    shots: 0,
    elementShots: 0,
    launches: 0,
    closes: 0,
  };
  let code = null;
  let thrown = null;
  try {
    code = await runProbe(descriptor ?? entry.descriptor, {
      argv: [
        "--repository-root",
        root,
        "--output",
        out,
        "--no-serve-built",
        "--renderer",
        "webgpu",
        ...argv,
      ],
      now: () => Date.UTC(2026, 8, 26, 22, 0, 0),
      launch: fakeLaunch(frames ?? entry.frames, log, page),
    });
  } catch (error) {
    thrown = error;
  }
  return { code, thrown, root, out, log };
}

const cleanup = (root) => removeLaneTmp(root);

const report = (out, entry) =>
  JSON.parse(
    readFileSync(
      path.join(out, `${entry.descriptor.name}-report.json`),
      "utf8",
    ),
  );

// ===========================================================================
// A. The descriptors
// ===========================================================================

test("A1: every harvested descriptor keeps its file's name, its banked capture folder and a usable lifecycle budget", () => {
  for (const entry of PROBES) {
    const d = entry.descriptor;
    assert.equal(`probe-${d.name}.mjs`, entry.file);
    assert.equal(d.outputSubdirectory, "", `${entry.file}: capture folder`);
    assert.equal(d.receiptEnvelope, "runtime", `${entry.file}: envelope`);
    assert.ok(Array.isArray(d.servedArtifacts) && d.servedArtifacts.length > 0);
    assert.ok(
      d.servedArtifacts.includes("Build/CesiumUnminified/index.js"),
      `${entry.file}: the module every harvested page imports is not preflighted`,
    );
    const options = { runs: 1, timeoutMs: 120000 };
    const budget = d.workBudgetMs(options);
    assert.ok(Number.isSafeInteger(budget) && budget >= 60_000, entry.file);
    assert.ok(deriveLifecycleDeadline(options, d) > budget, entry.file);
  }
  assert.equal(PROBES.length, 6, "round 1 routed six probes");
});

// ===========================================================================
// B. Executed on the stub browser
// ===========================================================================

for (const entry of PROBES) {
  test(`B1 ${entry.descriptor.name}: all clauses pass on the pass fixture, every capture keeps its banked name, the browser closes`, async () => {
    const { code, thrown, root, out, log } = await drive(entry);
    try {
      assert.equal(thrown, null, String(thrown?.stack ?? thrown));
      assert.equal(code, PROBE_EXIT_CODES.OK, `${entry.file}: exit ${code}`);
      assert.equal(log.launches, 1);
      assert.equal(log.closes, 1);
      assert.ok(!log.calls.includes("unstubbed"), "a page call was unstubbed");
      assert.equal(log.shots, entry.captures.length);
      // All six read the canvas and never ask for an element screenshot.
      assert.deepEqual(log.selectors, [], `${entry.file}: element capture`);
      assert.equal(log.elementShots, 0, `${entry.file}: element capture`);
      if (entry.demo) {
        // A demo leg is one more render at the viewer's own clock and a read
        // in that task: no rig stage, no settle frames, no camera.
        assert.equal(log.staged.length, 0, entry.file);
        assert.equal(log.settled.length, entry.captures.length, entry.file);
        for (const settle of log.settled) {
          assert.equal(settle.timeSource, "viewer-clock", entry.file);
          assert.equal(settle.frames, 0, entry.file);
          assert.equal(settle.clock, null, entry.file);
          assert.equal(settle.camera, null, entry.file);
        }
      }
      const receipt = report(out, entry);
      for (const capture of receipt.captures) {
        assert.equal(capture.readPath, CLOUD_RIG_READ_PATH, capture.name);
      }
      assert.deepEqual(
        receipt.captures.map((capture) => capture.name),
        entry.captures,
      );
      assert.equal(receipt.verdicts.length, entry.verdicts);
      for (const verdict of receipt.verdicts) {
        assert.equal(verdict.pass, true, `${verdict.id}: ${verdict.claim}`);
      }
      assert.deepEqual(
        readdirSync(out).sort(),
        [
          ...entry.captures.map((name) => `${name}.png`),
          `${entry.descriptor.name}-report.json`,
          `${entry.descriptor.name}-summary.md`,
        ].sort(),
      );
      // The harness is installed before the page loads, so every dial the
      // probe sets goes through its round trip.
      assert.ok(
        log.initScripts.some((text) =>
          text.includes("installCloudProbeHarness"),
        ),
        `${entry.file}: the cloud probe harness is not installed`,
      );
    } finally {
      cleanup(root);
    }
  });

  test(`B2 ${entry.descriptor.name}: a failing fixture fails exactly the named clauses and exits 1`, async () => {
    const { code, root, out } = await drive(entry, {
      frames: entry.failing.frames,
    });
    try {
      assert.equal(code, PROBE_EXIT_CODES.FAILURE);
      const failed = report(out, entry)
        .verdicts.filter((verdict) => verdict.pass !== true)
        .map((verdict) => verdict.id)
        .sort();
      assert.deepEqual(failed, [...entry.failing.ids].sort());
    } finally {
      cleanup(root);
    }
  });
}

test("B3: the W-series gates stage exactly the rigs they import, each with its cloud dials in the stage payload and at its rig's instant (S4 in cloud-rig-stage.spec pins that the payload reaches configure, S7 that the settle renders at the clock it is handed)", async () => {
  const clockOf = new Map((await loadRigs()).map((rig) => [rig.id, rig.clock]));
  // The time-of-day and aerial rigs declare instants; phase and ambient
  // declare the page's own clock (null). Both are the rig's instant.
  for (const id of ["cloud-tod-dawn", "cloud-aerial-near-deck"]) {
    assert.equal(typeof clockOf.get(id), "string", id);
  }
  for (const entry of PROBES.filter((probe) => !probe.demo)) {
    const { root, log } = await drive(entry);
    try {
      // Pass-3 advisory A1: every arm is staged AND settled at its rig's
      // instant, so a gate that hands the stager `clock: null` (or a stager
      // that drops the clock on its way to the settle) renders at the wall
      // clock and fails here.
      assert.equal(log.settled.length, log.staged.length, entry.file);
      log.staged.forEach((payload, index) => {
        const expected = clockOf.get(entry.rigs[index]);
        assert.ok(clockOf.has(entry.rigs[index]), entry.rigs[index]);
        assert.equal(
          payload.clock,
          expected,
          `${entry.file}: arm ${index} (${payload.rigId}) staged off its rig's instant`,
        );
        assert.equal(
          log.settled[index].clock,
          expected,
          `${entry.file}: arm ${index} (${payload.rigId}) settled off its rig's instant`,
        );
      });
      assert.deepEqual(
        log.staged.map((payload) => payload.rigId),
        entry.rigs,
        entry.file,
      );
      for (const payload of log.staged) {
        // The D1 defect's shape, made impossible: the coverage dial is IN the
        // payload the harness receives, not behind a guard on the globe.
        assert.ok(
          "cloudCoverage" in payload.volumetric,
          `${entry.file}: ${payload.rigId} stages no coverage`,
        );
      }
      assert.equal(log.settled.length, entry.rigs.length);
      assert.equal(log.gotos.length, 1);
      assert.match(
        log.gotos[0],
        /\/Apps\/CesiumViewer\/index\.html\?renderer=webgpu$/,
      );
    } finally {
      cleanup(root);
    }
  }
  // The aerial OFF arms are the ON rigs with the strength overridden to 0.
  const aerialEntry = PROBES.find((probe) => probe.descriptor === aerial);
  const { root, log } = await drive(aerialEntry);
  try {
    assert.deepEqual(
      log.staged.map((payload) => payload.volumetric.cloudAerialStrength),
      [0, 1, 0, 1, 1],
    );
  } finally {
    cleanup(root);
  }
});

/**
 * B4's assertion, over one demo run's stub window and log: what the probe's
 * own page functions wrote. A function, so C4 can show it fails on the H-2
 * defect.
 */
function assertDemoDialsReachTheCollection(entry, log) {
  const viewer = log.window.viewer;
  const globe = viewer.scene.globe;
  // The collection function ran: the deck's genus and the frozen clock.
  assert.equal(log.collection.length, 1, entry.file);
  assert.equal(globe.defaultCloudCollection.cloudType, 10, entry.file);
  assert.equal(viewer.clock.shouldAnimate, false, entry.file);
  // One volumetric page call for the deck and one per toggled leg, and each
  // reached the harness's configure with exactly the dials handed to the
  // page ("__undef__" standing for undefined).
  assert.equal(log.volumetric.length, entry.captures.length, entry.file);
  assert.equal(log.configured.length, log.volumetric.length, entry.file);
  // Pass-3 advisory A3: the first configure is the deck's, at the rig's own
  // dials (weather-inspector-cumulonimbus-deck: coverage 0.85, density 0.5),
  // stated here as numbers rather than read back from what the probe sent.
  assert.equal(
    log.configured[0]?.volumetric.cloudCoverage,
    0.85,
    `${entry.file}: deck coverage`,
  );
  assert.equal(
    log.configured[0]?.volumetric.cloudDensity,
    0.5,
    `${entry.file}: deck density`,
  );
  log.configured.forEach((options, index) => {
    const expected = Object.fromEntries(
      Object.entries(log.volumetric[index]).map(([key, value]) => [
        key,
        value === "__undef__" ? undefined : value,
      ]),
    );
    assert.deepEqual(options.volumetric, expected, `${entry.file}: ${index}`);
    for (const key of Object.keys(options.volumetric)) {
      assert.match(key, /^cloud[A-Z]/, `${entry.file}: ${key}`);
    }
  });
  // The legs' own toggles are among them, in leg order.
  assert.deepEqual(
    log.configured
      .map((options) => options.volumetric[entry.toggles.key])
      .filter((value) => entry.toggles.values.includes(value)),
    entry.toggles.values,
    entry.file,
  );
  // And not one dial landed on the globe, where no cloud dial is read from.
  assert.deepEqual(
    Object.keys(globe).filter((key) => /^cloud/i.test(key)),
    [],
    `${entry.file}: cloud dials written onto the globe`,
  );
}

test("B4: the demo probes' own page functions hand every toggle to the harness's configure, and nothing lands on the globe", async () => {
  // Pass-2 finding R-B: the stub used to answer these functions by their
  // text and never ran them, so a probe that wrote its toggles onto the globe
  // again (the H-2 defect) stayed green. They run here against `demoWindow`.
  for (const entry of PROBES.filter((probe) => probe.demo)) {
    const { root, log } = await drive(entry);
    try {
      assertDemoDialsReachTheCollection(entry, log);
      assert.match(
        log.gotos[0],
        /\/Apps\/Sandcastle\/gallery\/WebGPU%20Weather%20Inspector\.html$/,
      );
    } finally {
      cleanup(root);
    }
  }
});

test("B5: the origin comes from the runtime, and a demo that does not boot refuses", async () => {
  for (const entry of PROBES) {
    const { root, log } = await drive(entry, { argv: ["--port", "8137"] });
    try {
      assert.ok(log.gotos[0].startsWith("http://localhost:8137/"), entry.file);
    } finally {
      cleanup(root);
    }
  }
  // Both demo probes, not only the first (pass-2 advisory A3).
  for (const demo of PROBES.filter((probe) => probe.demo)) {
    const { code, root, out, log } = await drive(demo, {
      page: { boot: { ok: false, err: "window.startup not defined" } },
    });
    try {
      assert.equal(code, PROBE_EXIT_CODES.REFUSAL, demo.file);
      assert.equal(log.shots, 0, demo.file);
      assert.deepEqual(readdirSync(out), [
        `${demo.descriptor.name}-refusal.json`,
      ]);
    } finally {
      cleanup(root);
    }
  }
});

/** B6's run: a cloudless canvas, a cloud-filled element. */
const chromeOverCloudless = (entry, descriptor) =>
  drive(entry, {
    frames: entry.captures.map(() => CLOUDLESS),
    page: { element: entry.frames },
    descriptor,
  });

test("B6: all six measure the canvas, so pixels only an element screenshot carries (DOM chrome) cannot pass a cloudless frame", async () => {
  // Reviewer finding R1 of pass 1: an element screenshot of the CesiumViewer
  // canvas takes the toolbar, the navigation help, the credits, the clock and
  // the timeline, and on a banked Edge frame that chrome alone cleared every
  // W-series "clouds render" bar. Finding R-A of pass 2: the Weather
  // Inspector demo lays its translucent panels over the canvas, so the demo
  // pair's element captures carried them into every leg's number. Here the
  // element series is each probe's passing fixture and the canvas is black:
  // a probe that measured the element would pass its populated clause, a
  // probe that measures the canvas fails it.
  for (const entry of PROBES) {
    const { code, root, out, log } = await chromeOverCloudless(entry);
    try {
      assert.equal(code, PROBE_EXIT_CODES.FAILURE, entry.file);
      const populated = report(out, entry).verdicts.find(
        (verdict) => verdict.id === entry.populated,
      );
      assert.equal(populated?.pass, false, `${entry.file}: ${entry.populated}`);
      assert.equal(log.elementShots, 0, `${entry.file}: element screenshot`);
      assert.deepEqual(log.selectors, [], entry.file);
    } finally {
      cleanup(root);
    }
  }
});

/** The non-ignored and the ignored error B7 injects into the page's gate. */
const NEW_DEVICE_ERROR = "GPUValidationError: injected by B7 (not ignored)";
const IGNORED_DEVICE_ERROR = "Atmosphere LUT compute pass: injected by B7";

test("B7: each of the six fails its device clause on a new device error, filters the ignored one, and passes when only the ignored one is present", async () => {
  // Pass-3 advisory A2: the stub gate used to answer `errors: []` always, so
  // a device clause made inert stayed green. Here the gate carries one error
  // each probe must count and one each probe must filter.
  for (const entry of PROBES) {
    const both = await drive(entry, {
      page: { gateErrors: [NEW_DEVICE_ERROR, IGNORED_DEVICE_ERROR] },
    });
    try {
      assert.equal(both.code, PROBE_EXIT_CODES.FAILURE, entry.file);
      const verdicts = report(both.out, entry).verdicts;
      assert.deepEqual(
        verdicts.filter((verdict) => verdict.pass !== true).map((v) => v.id),
        ["device-errors/run0"],
        entry.file,
      );
      const device = verdicts.find((v) => v.id === "device-errors/run0");
      assert.equal(device.claim, "no NEW device errors (1)", entry.file);
      assert.deepEqual(device.detail.errors, [NEW_DEVICE_ERROR], entry.file);
    } finally {
      cleanup(both.root);
    }
    const ignored = await drive(entry, {
      page: { gateErrors: [IGNORED_DEVICE_ERROR] },
    });
    try {
      assert.equal(ignored.code, PROBE_EXIT_CODES.OK, entry.file);
      const device = report(ignored.out, entry).verdicts.find(
        (v) => v.id === "device-errors/run0",
      );
      assert.equal(device.pass, true, entry.file);
      assert.equal(device.claim, "no NEW device errors (0)", entry.file);
    } finally {
      cleanup(ignored.root);
    }
  }
});

test("B8: the receipts' measured values sit where the fidelity constants put them, not only the verdicts", async () => {
  // Pass-3 advisory A4. W1: the dim column (max channel 20) is under the
  // cloud floor of 24 and is not counted.
  const phaseEntry = PROBES.find((probe) => probe.descriptor === phase);
  const w1 = await drive(phaseEntry, { frames: [RIMMED_DIM, FLAT] });
  try {
    assert.equal(w1.code, PROBE_EXIT_CODES.OK);
    const toward = report(w1.out, phaseEntry).cells[0].toward;
    assert.deepEqual(toward, {
      cloud: 8640,
      median: 100,
      p95: 250,
      contrast: 2.5,
    });
  } finally {
    cleanup(w1.root);
  }
  // E3: a noctilucent diff of 1.04025 is reported at three places (1.04)
  // and clears "> 1.0"; at one place it would read 1.0 and fail.
  const specialEntry = PROBES.find((probe) => probe.descriptor === special);
  const nearBar = await drive(specialEntry, {
    frames: [SPECIAL_OFF, SPECIAL_OFF, NLC_NEAR_BAR, NACREOUS, SPECIAL_OFF],
  });
  try {
    const receipt = report(nearBar.out, specialEntry);
    assert.equal(receipt.cells[0].diff.noctilucent, 1.04);
    const changes = receipt.verdicts.find(
      (v) => v.id === "noctilucent-changes-render/run0",
    );
    assert.equal(changes.pass, true, changes.claim);
    assert.equal(nearBar.code, PROBE_EXIT_CODES.OK);
  } finally {
    cleanup(nearBar.root);
  }
  // E3: a chroma change OUTSIDE the deck region does not move the cool
  // shift, which reads the deck region only.
  const outside = await drive(specialEntry, {
    frames: [SPECIAL_OFF, SPECIAL_OFF, NLC_OUTSIDE_RED, NACREOUS, SPECIAL_OFF],
  });
  try {
    const receipt = report(outside.out, specialEntry);
    assert.deepEqual(receipt.cells[0].coolNoctilucent, {
      dr: 0,
      db: 100,
      cool: 100,
      n: 1460,
    });
  } finally {
    cleanup(outside.root);
  }
});

// ===========================================================================
// C. Mutation controls
// ===========================================================================

async function importMutatedProbe(file, mutate) {
  const source = readFileSync(path.join(HERE, file), "utf8").replaceAll(
    "\r\n",
    "\n",
  );
  const loadable = source.replace(
    /from "(\.\.?\/[^"]+)"/g,
    (whole, specifier) =>
      `from ${JSON.stringify(new URL(specifier, import.meta.url).href)}`,
  );
  const mutated = mutate(loadable);
  assert.notEqual(mutated, loadable, "the mutation did not apply");
  return import(
    `data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}`
  );
}

test("C1 MUTATION control: an inert silver-lining clause turns the failing fixture green", async () => {
  const entry = PROBES[0];
  const mutant = await importMutatedProbe(entry.file, (source) =>
    source.replace("pass: toward.contrast > away.contrast,", "pass: true,"),
  );
  const mutated = await drive(entry, {
    frames: entry.failing.frames,
    descriptor: mutant.descriptor,
  });
  try {
    assert.equal(
      mutated.code,
      PROBE_EXIT_CODES.OK,
      "the inert mutant still failed, so B2 is not pinning the clause body",
    );
  } finally {
    cleanup(mutated.root);
  }
});

test("C2 MUTATION control: a probe that re-hard-codes port 8080 is caught by B5's origin assertion", async () => {
  const entry = PROBES.find((probe) => probe.descriptor === tod);
  const anchor =
    "await page.goto(`${origin}/Apps/CesiumViewer/index.html?renderer=webgpu`";
  const mutant = await importMutatedProbe(entry.file, (source) => {
    assert.equal(source.split(anchor).length - 1, 1);
    return source.replace(
      anchor,
      "await page.goto(`http://localhost:8080/Apps/CesiumViewer/index.html?renderer=webgpu`",
    );
  });
  const { root, log } = await drive(entry, {
    argv: ["--port", "8137"],
    descriptor: mutant.descriptor,
  });
  try {
    assert.ok(
      log.gotos[0].includes(":8080"),
      "the mutation did not reach goto",
    );
    assert.throws(() =>
      assert.ok(log.gotos[0].startsWith("http://localhost:8137/")),
    );
  } finally {
    cleanup(root);
  }
});

/**
 * Rewrite a probe's source so the frame at `anchor` comes from an element
 * screenshot again, decoded by the kit's decoder as `decodeElementShot`.
 */
function onElementScreenshot(source, anchor, replacement) {
  assert.equal(source.split(anchor).length - 1, 1, anchor);
  const decoder = new URL("../lib/png-decode.mjs", import.meta.url).href;
  // The decoder import goes after the shebang, which must stay line one.
  const [shebang, ...rest] = source.split("\n");
  const body = rest.join("\n").replace(anchor, replacement);
  return `${shebang}\nimport { decodePng as decodeElementShot } from ${JSON.stringify(decoder)};\n${body}`;
}

const ELEMENT_SHOT =
  'decodeElementShot(await page.locator(".cesium-widget canvas").screenshot())';

test("C3 MUTATION control: a phase gate that measures an element screenshot again (the R1 regression) passes B6's cloudless fixture, so B6 catches it", async () => {
  const entry = PROBES.find((probe) => probe.descriptor === phase);
  const mutant = await importMutatedProbe(entry.file, (source) =>
    onElementScreenshot(
      source,
      "cell[leg.key] = measurePhaseBand(arm.image);",
      `cell[leg.key] = measurePhaseBand(${ELEMENT_SHOT});`,
    ),
  );
  const { code, root, out, log } = await chromeOverCloudless(
    entry,
    mutant.descriptor,
  );
  try {
    assert.equal(log.elementShots, 2, "the mutation did not reach the capture");
    const populated = report(out, entry).verdicts.find(
      (verdict) => verdict.id === entry.populated,
    );
    // B6 requires this clause to FAIL; the mutant passes it on the element.
    assert.equal(populated.pass, true);
    assert.equal(code, PROBE_EXIT_CODES.OK);
  } finally {
    cleanup(root);
  }
});

test("C4 MUTATION control: a demo probe that writes its toggles onto the globe again (the H-2 defect) fails B4", async () => {
  const anchor = "const truth = window.__cloudProbe.configure({ volumetric });";
  for (const entry of PROBES.filter((probe) => probe.demo)) {
    const mutant = await importMutatedProbe(entry.file, (source) => {
      assert.equal(source.split(anchor).length - 1, 1, entry.file);
      return source.replace(
        anchor,
        "for (const [k, v] of Object.entries(volumetric)) { window.viewer.scene.globe[k] = v; } const truth = { ok: true };",
      );
    });
    const { root, log } = await drive(entry, { descriptor: mutant.descriptor });
    try {
      assert.ok(
        Object.keys(log.window.viewer.scene.globe).some((key) =>
          key.startsWith("cloud"),
        ),
        `${entry.file}: the mutation did not reach the globe`,
      );
      assert.throws(
        () => assertDemoDialsReachTheCollection(entry, log),
        assert.AssertionError,
        `${entry.file}: B4 passed a probe that writes onto the globe`,
      );
    } finally {
      cleanup(root);
    }
  }
});

test("C5 MUTATION control: a demo probe that measures an element screenshot again (the R-A regression) passes B6's cloudless fixture, so B6 catches it", async () => {
  for (const entry of PROBES.filter((probe) => probe.demo)) {
    const mutant = await importMutatedProbe(entry.file, (source) =>
      onElementScreenshot(
        source,
        "frames[leg.key] = shot.image;",
        `frames[leg.key] = ${ELEMENT_SHOT};`,
      ),
    );
    const { code, root, out, log } = await chromeOverCloudless(
      entry,
      mutant.descriptor,
    );
    try {
      assert.equal(
        log.elementShots,
        entry.captures.length,
        `${entry.file}: the mutation did not reach the capture`,
      );
      const populated = report(out, entry).verdicts.find(
        (verdict) => verdict.id === entry.populated,
      );
      // B6 requires this clause to FAIL; the mutant passes it on the element.
      assert.equal(populated.pass, true, entry.file);
      assert.equal(code, PROBE_EXIT_CODES.OK, entry.file);
    } finally {
      cleanup(root);
    }
  }
});
