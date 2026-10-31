// landing-startup-floor-origin.spec.mjs - the PF-3 startup band floor the probe's own comparison path reads, and where it came from.
//
// @purpose Asserts, through probe-landing-cells' own receipt() and verdicts() against a base report on disk, that a WebGL arm with no --bands file reads the 15 % WebGL PF-3 startup floor, that a --bands file naming startupBandFloor keeps its value on WebGL and WebGPU, that a WebGPU arm without one still reads 10 %, that pf3.startup.startupFloor names the floor used and its origin (floor, override, registered), and that the receipt's resolved bands and the other PF verdicts do not move.
// @status ACTIVE
//
// Written from the observable contract (row DX-KIT-PF3-WEBGL-FLOOR-INERT-IN-PROBE): the probe resolved the
// --bands file into a full set of seat defaults before comparing, and a resolved set always carries
// startupBandFloor, so the WebGL floor never applied on the probe's path. The pages are two same-build
// arms of the E-ID-cv identity cell, trimmed from a banked Edge report pair (fixtures/landing-startup-floor).
//
// RUN: node --test Tools/visual-regression/landing-startup-floor-origin.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { descriptor } from "./probe-landing-cells.mjs";
import { STARTUP_BAND_FLOOR_WEBGL } from "./lib/metrics/perf-band.mjs";

const FIXTURE = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "landing-startup-floor",
      "e-id-cv.json",
    ),
    "utf8",
  ),
);

const WEBGL = "E-ID-cv|webgl|scene";
const WEBGPU = "E-ID-cv|webgpu|scene";

let TEMP_ROOT = "";
let BASE_REPORT = "";

before(() => {
  TEMP_ROOT = mkLaneTmp("landing-startup-floor-origin-");
  BASE_REPORT = path.join(TEMP_ROOT, "base-report.json");
  fs.writeFileSync(
    BASE_REPORT,
    JSON.stringify({
      arms: {},
      pipelineWaitByCell: FIXTURE.base.pipelineWaitByCell,
      pages: FIXTURE.base.pages,
    }),
  );
});

after(() => {
  removeLaneTmp(TEMP_ROOT);
});

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  return sorted.length % 2 === 1
    ? sorted[Math.floor(mid)]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

const baseFirstFrameMedian = (renderer) =>
  median(
    FIXTURE.base.pages
      .filter((page) => page.renderer === renderer)
      .map((page) => page.startup.firstFrameAtMs),
  );

/** The fixture's tip pages, optionally with one renderer's first frame moved to `ratio` x the base median. */
function tipPages(scale = {}) {
  const pages = structuredClone(FIXTURE.tip.pages);
  for (const [renderer, ratio] of Object.entries(scale)) {
    const moved = baseFirstFrameMedian(renderer) * ratio;
    for (const page of pages.filter((p) => p.renderer === renderer)) {
      page.startup.firstFrameAtMs = moved;
      page.startup.tilesLoadedAtMs = moved;
      page.startup.stagedAtMs = moved - 10;
    }
  }
  return pages;
}

function writeBands(name, bands) {
  const file = path.join(TEMP_ROOT, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(bands));
  return file;
}

function optionsFor(bandsFile) {
  return {
    cells: "E-ID-cv",
    baseReport: BASE_REPORT,
    ...(bandsFile ? { bands: bandsFile } : {}),
  };
}

/** The probe's own receipt for `pages`, comparison and resolved bands included. */
function receiptFor(pages, bandsFile) {
  return descriptor.receipt(pages, {
    options: optionsFor(bandsFile),
    origin: "http://localhost:0",
  });
}

const startupOf = (receipt, key) => receipt.comparison[key].pf3.startup;

test("F1: a WebGL arm with no --bands file reads the 15 % WebGL floor and names it a renderer floor", () => {
  const startup = startupOf(receiptFor(tipPages()), WEBGL);
  assert.equal(startup.bandFraction, STARTUP_BAND_FLOOR_WEBGL);
  assert.equal(startup.bandSource, "startup-floor");
  assert.deepEqual(startup.startupFloor, { fraction: 0.15, origin: "floor" });
  assert.ok(
    Math.abs(startup.limit - baseFirstFrameMedian("webgl") * 1.15) < 1e-6,
  );
});

test("F2: a WebGPU arm with no --bands file still reads 10 % and names it registered", () => {
  const startup = startupOf(receiptFor(tipPages()), WEBGPU);
  assert.equal(startup.bandFraction, 0.1);
  assert.deepEqual(startup.startupFloor, {
    fraction: 0.1,
    origin: "registered",
  });
});

test("F3: a --bands file naming startupBandFloor keeps its value on WebGL and WebGPU, origin override", () => {
  for (const floor of [0.2, 0.1]) {
    const file = writeBands(`floor-${floor}`, { startupBandFloor: floor });
    const receipt = receiptFor(tipPages(), file);
    for (const key of [WEBGL, WEBGPU]) {
      const startup = startupOf(receipt, key);
      assert.equal(startup.bandFraction, floor, `${key} at ${floor}`);
      assert.deepEqual(startup.startupFloor, {
        fraction: floor,
        origin: "override",
      });
    }
  }
});

test("F4: a --bands file that names other bands leaves the WebGL floor at 15 %", () => {
  const file = writeBands("ceiling-only", { startupCeilingMs: 3000 });
  const receipt = receiptFor(tipPages(), file);
  assert.deepEqual(startupOf(receipt, WEBGL).startupFloor, {
    fraction: 0.15,
    origin: "floor",
  });
  assert.deepEqual(startupOf(receipt, WEBGPU).startupFloor, {
    fraction: 0.1,
    origin: "registered",
  });
  assert.equal(startupOf(receipt, WEBGL).bands.startupCeilingMs, 3000);
});

test("F5: the receipt's resolved bands and the other PF-3 fields keep the values they had", () => {
  const receipt = receiptFor(tipPages());
  assert.equal(receipt.bands.startupBandFloor, 0.1);
  assert.equal(receipt.bands.startupCeilingMs, 2500);
  assert.equal(receipt.bandsFile, null);
  for (const key of [WEBGL, WEBGPU]) {
    const pf3 = receipt.comparison[key].pf3;
    assert.equal(pf3.verdict, "within");
    assert.equal(pf3.compile.verdict, "within");
    assert.equal(pf3.compile.bands.floorFraction, 0.03);
  }
  const withFile = receiptFor(
    tipPages(),
    writeBands("both-floors", { startupBandFloor: 0.2, floorFraction: 0.05 }),
  );
  assert.equal(withFile.bands.startupBandFloor, 0.2);
  assert.equal(withFile.bands.floorFraction, 0.05);
  assert.equal(
    withFile.bandsFile.path,
    path.join(TEMP_ROOT, "both-floors.json"),
  );
});

test("F6: a WebGL move of 12 % reads within with no bands file and over under a pre-registered 10 % floor; the WebGPU arm reads over either way", () => {
  const pages = tipPages({ webgl: 1.12, webgpu: 1.12 });
  const verdictFor = (bandsFile, key) =>
    descriptor
      .verdicts(pages, { options: optionsFor(bandsFile) })
      .find((verdict) => verdict.id === `${key}:PF-3`);

  assert.equal(verdictFor(undefined, WEBGL).pass, true);
  assert.equal(verdictFor(undefined, WEBGL).verdict, "within");
  assert.equal(verdictFor(undefined, WEBGPU).pass, false);

  const registered = writeBands("seat-floor", { startupBandFloor: 0.1 });
  assert.equal(verdictFor(registered, WEBGL).pass, false);
  assert.equal(verdictFor(registered, WEBGL).verdict, "over");

  // The receipt agrees with the verdict list on the same pages.
  const receipt = receiptFor(pages);
  assert.equal(receipt.comparison[WEBGL].pf3.verdict, "within");
  assert.equal(receipt.comparison[WEBGPU].pf3.verdict, "over");
});

test("F7: the receipt's top level names each renderer's startup floor beside the resolved bands, so 0.10 there is not read as the WebGL floor", () => {
  const receipt = receiptFor(tipPages());
  assert.deepEqual(receipt.startupBandFloorByRenderer, {
    webgl: { fraction: STARTUP_BAND_FLOOR_WEBGL, origin: "floor" },
    webgpu: { fraction: 0.1, origin: "registered" },
  });
  const withFile = receiptFor(
    tipPages(),
    writeBands("floor-0.2", { startupBandFloor: 0.2 }),
  );
  assert.deepEqual(withFile.startupBandFloorByRenderer, {
    webgl: { fraction: 0.2, origin: "override" },
    webgpu: { fraction: 0.2, origin: "override" },
  });
});
