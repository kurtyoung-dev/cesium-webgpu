// landing-cross-renderer-band.spec.mjs — the pre-registered WebGPU-against-WebGL
// band of the 2D and Columbus-view identity cells, through the real PNG diff.
//
// @purpose Asserts that E-ID-2d and E-ID-cv are cross-renderer cells judged against their declared band (changed pixels at tolerance 0 within 4, the largest channel delta off the right map edge column within 1) and emit a real pass/fail verdict, that a cross-renderer cell without a declared band keeps its measured-only verdict, and that a missing capture or a diff without channel statistics is NOT RUN rather than a pass.
// @status ACTIVE
//
// Written from the observable contract: synthetic PNG pairs are written to a
// lane temp root, decoded and diffed by the real `pixelDiff`, and the entries and
// verdicts come from the real `crossRendererComparisons` / `crossPageVerdicts`.
// The band numbers are the P2D-ACCEPT Edge receipt's measurement (2 px on both
// rigs, max channel 1 in 2D and 32 on column x = 1274 in Columbus view).
//
// RUN: node --test Tools/visual-regression/landing-cross-renderer-band.spec.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { withLaneTmp } from "../lib/lane-tmp.mjs";
import { encodeRgbaPng } from "../lib/png-rgba.mjs";
import { LANDING_CELLS } from "./lib/landing-cell-table.mjs";
import {
  crossPageVerdicts,
  crossRendererBandVerdict,
  crossRendererComparisons,
} from "./lib/metrics/landing-cross-page.mjs";

const WIDTH = 1280;
const HEIGHT = 16;
const EDGE_COLUMN = 1274;

// A flat frame; `changes` raise the red channel of single pixels.
function writeFrame(file, changes = []) {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 40;
    pixels[i + 1] = 60;
    pixels[i + 2] = 80;
    pixels[i + 3] = 255;
  }
  for (const { x, y, delta } of changes) {
    pixels[(y * WIDTH + x) * 4] += delta;
  }
  fs.writeFileSync(file, encodeRgbaPng(pixels, WIDTH, HEIGHT));
  return file;
}

// The WebGL frame is flat; the WebGPU frame carries `changes`.
function pagesFor(dir, cell, changes) {
  const page = (renderer, file) => ({
    cell,
    run: 0,
    renderer,
    page: "scene",
    notRun: null,
    capture: { name: `${cell}-${renderer}`, path: file },
  });
  return [
    page("webgl", writeFrame(path.join(dir, `${cell}-webgl.png`))),
    page("webgpu", writeFrame(path.join(dir, `${cell}-webgpu.png`), changes)),
  ];
}

const judge = (cell, changes) =>
  withLaneTmp("landing-cross-band-", (dir) => {
    const comparisons = crossRendererComparisons(pagesFor(dir, cell, changes));
    return {
      entry: comparisons[0],
      verdict: crossPageVerdicts({ crossRenderer: comparisons })[0],
    };
  });

const pixels = (count, delta, x0 = 700) =>
  Array.from({ length: count }, (_, index) => ({
    x: x0 + index,
    y: 3,
    delta,
  }));

test("B1: both identity cells are cross-renderer cells declaring the measured band, and no other cell declares one", () => {
  const band = {
    tolerance: 0,
    maxChangedPx: 4,
    maxChannelOutsideExcluded: 1,
    excludedColumns: [EDGE_COLUMN],
  };
  for (const cell of ["E-ID-2d", "E-ID-cv"]) {
    assert.equal(LANDING_CELLS[cell].crossRenderer, true, cell);
    assert.deepEqual(
      LANDING_CELLS[cell].crossRendererBand,
      { ...band, scope: LANDING_CELLS[cell].crossRendererBand.scope },
      cell,
    );
    assert.ok(Object.isFrozen(LANDING_CELLS[cell].crossRendererBand), cell);
  }
  assert.deepEqual(
    Object.entries(LANDING_CELLS)
      .filter(([, cell]) => cell.crossRendererBand !== undefined)
      .map(([name]) => name),
    ["E-ID-2d", "E-ID-cv"],
  );
});

test("B2: two pixels off by one pass, with the band, both figures and the verdict reported", () => {
  const { entry, verdict } = judge("E-ID-2d", pixels(2, 1));
  assert.equal(entry.measured, true);
  assert.equal(entry.changedPx, 2);
  assert.equal(entry.maxChannelOutsideExcluded, 1);
  assert.equal(entry.bandVerdict.pass, true);
  assert.match(entry.band, /registered: changedPx <= 4 at tolerance 0/);
  assert.equal(verdict.id, "E-ID-2d:cross-renderer:run0:band");
  assert.equal(verdict.pass, true);
  assert.equal(verdict.changedPx, 2);
  assert.equal(verdict.maxChannelOutsideExcluded, 1);
  assert.equal(verdict.notRun, undefined);
});

test("B3: five changed pixels fail, four pass", () => {
  const five = judge("E-ID-2d", pixels(5, 1));
  assert.equal(five.verdict.pass, false);
  assert.equal(five.verdict.notRun, undefined);
  assert.match(five.verdict.reason, /5 px changed exceeds the band's 4/);
  assert.equal(judge("E-ID-2d", pixels(4, 1)).verdict.pass, true);
});

test("B4: a channel delta of 32 on the right map edge column passes, the same 32 anywhere else fails", () => {
  const edge = judge("E-ID-cv", [
    { x: EDGE_COLUMN, y: 2, delta: 32 },
    { x: EDGE_COLUMN, y: 9, delta: 32 },
  ]);
  assert.equal(edge.entry.changedPx, 2);
  assert.equal(edge.entry.maxChannel, 32);
  assert.equal(edge.entry.maxChannelOutsideExcluded, 0);
  assert.equal(edge.verdict.pass, true);
  assert.equal(edge.verdict.maxChannel, 32);

  const inside = judge("E-ID-cv", [
    { x: 1000, y: 2, delta: 32 },
    { x: 1000, y: 9, delta: 32 },
  ]);
  assert.equal(inside.entry.maxChannelOutsideExcluded, 32);
  assert.equal(inside.verdict.pass, false);
  assert.match(
    inside.verdict.reason,
    /max channel 32 outside column\(s\) 1274/,
  );
});

test("B5: a delta of 2 off the edge column fails the channel limit while the pixel count is within the band", () => {
  const { entry, verdict } = judge("E-ID-2d", pixels(2, 2));
  assert.equal(entry.changedPx, 2);
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /max channel 2/);
  assert.doesNotMatch(verdict.reason, /px changed/);
});

test("B6: the edge column's pixels still count toward the changed-pixel limit", () => {
  const { verdict } = judge(
    "E-ID-cv",
    Array.from({ length: 5 }, (_, y) => ({ x: EDGE_COLUMN, y, delta: 32 })),
  );
  assert.equal(verdict.pass, false);
  assert.match(verdict.reason, /5 px changed/);
});

test("B7: identical frames pass on both cells", () => {
  for (const cell of ["E-ID-2d", "E-ID-cv"]) {
    const { entry, verdict } = judge(cell, []);
    assert.equal(entry.changedPx, 0, cell);
    assert.equal(verdict.pass, true, cell);
  }
});

test("B8: a cross-renderer cell without a declared band keeps the measured-only verdict, whatever the diff", () => {
  const { entry, verdict } = judge("E-C-chukotka", [
    ...pixels(5, 32),
    { x: EDGE_COLUMN, y: 2, delta: 32 },
  ]);
  assert.equal(entry.band, "unregistered (first capture registers)");
  assert.equal(entry.bandSpec, undefined);
  assert.equal(entry.bandVerdict, undefined);
  assert.equal(entry.maxChannel, undefined);
  assert.equal(entry.changedPx, 6);
  assert.equal(verdict.id, "E-C-chukotka:cross-renderer:run0:measured");
  assert.equal(verdict.pass, true);
  assert.equal(verdict.band, "unregistered (first capture registers)");
});

test("B9: a banded cell with a missing capture is NOT RUN on the band verdict, never a pass", () => {
  const page = (renderer, capture) => ({
    cell: "E-ID-2d",
    run: 0,
    renderer,
    page: "scene",
    notRun: capture ? null : "the stage did not apply terrain",
    capture,
  });
  const comparisons = crossRendererComparisons([
    page("webgl", { name: "a", path: "unused.png" }),
    page("webgpu", null),
  ]);
  const [verdict] = crossPageVerdicts({ crossRenderer: comparisons });
  assert.equal(comparisons[0].measured, false);
  assert.equal(verdict.id, "E-ID-2d:cross-renderer:run0:band");
  assert.equal(verdict.pass, false);
  assert.equal(verdict.notRun, true);
  assert.match(verdict.reason, /no capture on webgpu/);
});

test("B10: a diff that reports no channel statistics cannot be judged against the band", () => {
  const page = (renderer) => ({
    cell: "E-ID-cv",
    run: 0,
    renderer,
    page: "scene",
    notRun: null,
    capture: { name: renderer, path: `${renderer}.png` },
  });
  const comparisons = crossRendererComparisons(
    [page("webgl"), page("webgpu")],
    {
      diff: () => ({
        measured: true,
        changedPx: 0,
        mismatchPct: 0,
        bbox: null,
      }),
    },
  );
  const [verdict] = crossPageVerdicts({ crossRenderer: comparisons });
  assert.equal(comparisons[0].measured, false);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.notRun, true);
});

test("B11: the band verdict reads both limits independently", () => {
  const band = {
    maxChangedPx: 4,
    maxChannelOutsideExcluded: 1,
    excludedColumns: [EDGE_COLUMN],
  };
  const read = (changedPx, maxChannelOutsideExcluded) =>
    crossRendererBandVerdict(band, { changedPx, maxChannelOutsideExcluded });
  assert.equal(read(4, 1).pass, true);
  assert.equal(read(5, 1).pass, false);
  assert.equal(read(4, 2).pass, false);
  assert.equal(read(5, 2).reasons.length, 2);
});
