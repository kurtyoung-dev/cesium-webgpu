// clustered-probe-chrome.spec.mjs — the clustered family's viewer-chrome refusal, driven against a fake page.
//
// @purpose Drives each clustered-lighting probe that captures the CesiumViewer canvas against a fake page whose widget strip leaves an element over the canvas at one capture at a time, and requires a viewer-chrome-over-canvas refusal at exactly that capture, a strip taken after the scene step and directly before every capture, and a record-only disposition for the lights-resize record frame that no verdict reads.
// @status ACTIVE
//
// WHY A DRIVE, NOT A GREP. An element capture composites whatever is stacked
// over the canvas, so a probe that scores a capture of the CesiumViewer canvas,
// or banks one as evidence, strips the viewer's widgets
// (`lib/strip-viewer-widgets.mjs`) and refuses if anything is left. A source
// grep would show only that the refusal is written; the cases below run each
// descriptor's Node side and show it is reached, at the capture it guards. A
// clean strip on the same fake page runs to the end and passes every verdict,
// so a refusal is the strip's doing and nothing else's.
//
// Pure Node: no browser, no GPU. The page-side functions never run; the fake
// page answers each page step by name. The frames it returns are written under
// the lane's temp root and removed.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { CLUSTER_GRID } from "./lib/metrics/cluster-light-counts.mjs";
import { ProbeRefusal } from "./lib/probe-runtime.mjs";
import * as demoScene from "./probe-clustered-demo-scene.mjs";
import * as lightsResize from "./probe-clustered-lights-resize.mjs";
import * as litmat from "./probe-clustered-litmat.mjs";
import * as matsweep from "./probe-clustered-matsweep.mjs";
import * as multifrustum from "./probe-clustered-multifrustum.mjs";
import * as phong from "./probe-clustered-phong.mjs";
import * as visible from "./probe-clustered-visible.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// ---------------------------------------------------------------------------
// Viewer chrome over the canvas: refused before every scored capture
// ---------------------------------------------------------------------------

const CLEAN_STRIP = Object.freeze({ removed: 7, leftovers: [] });
const LEFT_OVER = Object.freeze({
  removed: 7,
  leftovers: ["loadingIndicator"],
});

/** Plausible answers for the page steps; the page-side functions never run. */
const PAGE_STEP_ANSWERS = Object.freeze({
  pageSetup: {
    primReady: true,
    modelReady: true,
    bsRadius: 4,
    numFrustumsOff: 3,
    farToNearRatio: 2,
    tilesLoadedOff: true,
    sceneLightCount: 6,
  },
  pageLightOn: {
    lastActive: 1,
    clusteredActive: true,
    stashKeys: "a,b",
    paramsActiveCount: 1,
    numFrustumsOn: 3,
    tilesLoadedOn: true,
  },
  pageClusteredOn: { lastActive: 6, clusteredActive: true },
  pageSweep: { lastActive: 1, clusteredActive: true, perType: {} },
  pageResize: {
    aActive: 1,
    bActive: 1,
    aCounts: Array.from({ length: CLUSTER_GRID.cells }, (_, i) =>
      i < 5 ? 1 : 0,
    ),
    bCounts: Array.from({ length: CLUSTER_GRID.cells }, (_, i) =>
      i < 9 ? 1 : 0,
    ),
    b2Counts: Array.from({ length: CLUSTER_GRID.cells }, (_, i) =>
      i < 9 ? 1 : 0,
    ),
  },
});

function flatFrame(value) {
  const width = 40;
  const height = 30;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = value;
    pixels[i + 1] = value;
    pixels[i + 2] = value;
    pixels[i + 3] = 255;
  }
  // A Buffer, as a Playwright screenshot is.
  return Buffer.from(encodeRgbaPng(pixels, width, height));
}

/** Odd captures are an OFF frame, even captures a brighter ON frame. */
const FRAMES = Object.freeze([flatFrame(60), flatFrame(140)]);

/**
 * A fake browser whose page answers the widget strip (the only string the
 * probes evaluate) from `strips` in order, then with a clean strip.
 */
function fakeBrowser(strips) {
  const queue = [...strips];
  // `events` is the order of page steps, strips and captures, so a case can
  // require each capture to follow a strip that follows the scene's settle.
  const calls = { strips: 0, shots: 0, closed: 0, events: [] };
  const page = {
    on() {},
    off() {},
    async addInitScript() {},
    async goto() {},
    async waitForFunction() {},
    async evaluate(step) {
      if (typeof step === "string") {
        calls.strips += 1;
        calls.events.push("strip");
        return queue.length > 0 ? queue.shift() : CLEAN_STRIP;
      }
      const source = String(step);
      if (source.includes("__captureLiveness")) {
        return { gateArmed: true, deviceLost: null, frameNumber: calls.shots };
      }
      if (source.includes("__armWebGPUDevice")) {
        return { armed: 1, found: 1, total: 1 };
      }
      if (source.includes("__webgpuGate")) {
        return { errors: [], deviceLost: null, armedDevices: 1 };
      }
      if (Object.hasOwn(PAGE_STEP_ANSWERS, step.name)) {
        calls.events.push(step.name);
        return PAGE_STEP_ANSWERS[step.name];
      }
      throw new Error(`no fake answer for page step ${step.name}`);
    },
    locator() {
      return {
        async count() {
          return 1;
        },
        async screenshot() {
          calls.shots += 1;
          calls.events.push("shot");
          return FRAMES[(calls.shots - 1) % 2];
        },
      };
    },
  };
  const browser = {
    async newContext() {
      return {
        async newPage() {
          return page;
        },
        async close() {
          calls.closed += 1;
        },
      };
    },
  };
  return { browser, calls };
}

function driveCells(module, strips, outputDirectory) {
  const fake = fakeBrowser(strips);
  const pending = module.descriptor.cells({
    browser: fake.browser,
    run: 0,
    options: { renderers: ["webgpu"] },
    origin: "http://localhost:8094",
    outputDirectory,
    repositoryRoot: REPO_ROOT,
    captures: [],
  });
  return { calls: fake.calls, pending };
}

const OFF_ON_ORDER = Object.freeze([
  "pageSetup",
  "strip",
  "shot",
  "pageLightOn",
  "strip",
  "shot",
]);

/**
 * The probes that score or bank a canvas capture: their captures in order,
 * and the order of page steps, strips and captures on a clean drive. Each
 * capture directly follows a strip, and each strip follows a scene step.
 */
const CHROME_REFUSING = Object.freeze([
  [
    "demo-scene",
    demoScene,
    ["off", "on"],
    ["pageSetup", "strip", "shot", "pageClusteredOn", "strip", "shot"],
  ],
  ["litmat", litmat, ["off", "on"], OFF_ON_ORDER],
  ["phong", phong, ["off", "on"], OFF_ON_ORDER],
  ["visible", visible, ["off", "on"], OFF_ON_ORDER],
  ["multifrustum", multifrustum, ["off", "on"], OFF_ON_ORDER],
  ["matsweep", matsweep, ["on"], ["pageSweep", "strip", "shot"]],
]);

for (const [name, module, captures, order] of CHROME_REFUSING) {
  test(`${name}: viewer chrome left over the canvas at a capture refuses that capture`, () =>
    withLaneTmp("clustered-chrome-", async (directory) => {
      const clean = driveCells(module, [], path.join(directory, "clean"));
      const [cell] = await clean.pending;
      assert.equal(
        clean.calls.strips,
        captures.length,
        "one strip per capture",
      );
      assert.equal(clean.calls.shots, captures.length, "every capture taken");
      assert.deepEqual(
        clean.calls.events,
        order,
        "each capture directly follows a strip taken after the scene step",
      );
      assert.equal(cell.chromeRemoved, CLEAN_STRIP.removed * captures.length);
      assert.ok(
        module.descriptor.verdicts([cell]).every((verdict) => verdict.pass),
        "the clean drive passes, so a refusal below is the strip's doing",
      );
      for (const [index, capture] of captures.entries()) {
        for (const report of [LEFT_OVER, null]) {
          const strips = captures.map((_, i) =>
            i === index ? report : CLEAN_STRIP,
          );
          const drive = driveCells(
            module,
            strips,
            path.join(
              directory,
              `${capture}-${report === null ? "none" : "left"}`,
            ),
          );
          await assert.rejects(
            drive.pending,
            (error) =>
              error instanceof ProbeRefusal &&
              error.reason === "viewer-chrome-over-canvas" &&
              error.details?.capture === capture,
            `${capture} strip ${report === null ? "with no report" : "with a leftover"}`,
          );
          assert.equal(
            drive.calls.shots,
            index,
            "no capture at or after the refused one",
          );
          assert.equal(drive.calls.closed, 1, "the context still closes");
        }
      }
    }));
}

test("lights-resize records the chrome over its record frame and does not refuse: no verdict reads that frame", () =>
  withLaneTmp("clustered-chrome-", async (directory) => {
    const drive = driveCells(lightsResize, [LEFT_OVER], directory);
    const [cell] = await drive.pending;
    assert.equal(drive.calls.strips, 1);
    assert.deepEqual(drive.calls.events, ["pageResize", "strip", "shot"]);
    assert.deepEqual(cell.chrome, LEFT_OVER);
    assert.equal(cell.chromeRemoved, LEFT_OVER.removed);
    assert.ok(
      lightsResize.descriptor.verdicts([cell]).every((verdict) => verdict.pass),
    );
  }));
