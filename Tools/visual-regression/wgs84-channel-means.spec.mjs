// wgs84-channel-means.spec.mjs — the wgs84 family's extracted metric, held to
// the archived probe's own in-page loop. Pure Node: no browser, no GPU.
//
// @purpose Drives lib/metrics/wgs84-channel-means.mjs over hand-built and seeded frames, pins its channel-sum coverage boundary and its difference from frameStats, and executes the archived probe-wgs84-quick.mjs statistics loop over the same bytes so the extraction is checked against the original code rather than against a restatement of it.
// @status ACTIVE
//
// WHY THE ARCHIVED LOOP IS EXECUTED, NOT TRANSCRIBED. A spec written from the
// same reading as the metric inherits that reading's errors. The independent
// source here is the archived probe's text: the arrow function it handed to
// `page.evaluate` is cut out of `archive/probe-wgs84-quick.mjs` with the fleet
// contract's own `blankNonCode` / `matchBrace`, and run against a stub
// `document` whose 2-D context hands back the test frame's bytes. If the metric
// and that loop ever disagree on a frame, this spec says so.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { frameStats } from "../lib/png-decode.mjs";
import {
  CHANNEL_MEANS_PROVENANCE,
  NON_BLACK_SUM_THRESHOLD,
  frameChannelMeans,
} from "./lib/metrics/wgs84-channel-means.mjs";
import { blankNonCode, matchBrace } from "./lib/probe-fleet-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCHIVED_QUICK = join(HERE, "archive", "probe-wgs84-quick.mjs");

/** A frame from a list of [r, g, b] pixels, alpha 255, one row. */
function frameOf(pixels, width = pixels.length) {
  const data = new Uint8Array(pixels.length * 4);
  pixels.forEach(([r, g, b], i) => {
    data.set([r, g, b, 255], i * 4);
  });
  return { width, height: pixels.length / width, data };
}

/** mulberry32: a seeded generator, so a failing frame can be regenerated. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomFrame(seed, width, height) {
  const next = seeded(seed);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    // A third of the pixels near black, so the coverage boundary is exercised.
    const dark = next() < 1 / 3;
    for (let c = 0; c < 3; c++) {
      data[i + c] = dark ? Math.floor(next() * 9) : Math.floor(next() * 256);
    }
    data[i + 3] = 255;
  }
  return { width, height, data };
}

/** The archived probe's in-page statistics function, as source text. */
function archivedStatisticsSource() {
  const source = readFileSync(ARCHIVED_QUICK, "utf8").replaceAll("\r\n", "\n");
  const code = blankNonCode(source);
  const marker = source.indexOf("// Compute mean brightness of canvas");
  assert.ok(marker > 0, "the archived probe's statistics marker is gone");
  const call = code.indexOf("page.evaluate(() =>", marker);
  assert.ok(call > marker, "the archived probe's statistics evaluate is gone");
  const open = code.indexOf("{", call);
  const close = matchBrace(code, open);
  assert.ok(close > open, "the archived statistics body did not brace-match");
  return `() => ${source.slice(open, close + 1)}`;
}

/** Run the archived loop against a stub page holding `image`'s bytes. */
function runArchivedLoop(image) {
  const seen = { drawn: null, region: null };
  const canvas = { width: image.width, height: image.height };
  const fakeDocument = {
    querySelector: (selector) => (selector === "canvas" ? canvas : null),
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (source) => {
          seen.drawn = source;
        },
        getImageData: (x, y, w, h) => {
          seen.region = [x, y, w, h];
          return { data: Uint8ClampedArray.from(image.data) };
        },
      }),
    }),
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    "document",
    `return (${archivedStatisticsSource()});`,
  )(fakeDocument);
  const stats = fn();
  assert.equal(seen.drawn, canvas, "the archived loop did not draw the canvas");
  assert.deepEqual(seen.region, [0, 0, image.width, image.height]);
  return stats;
}

test("hand-built frame: exact means and coverage", () => {
  const image = frameOf([
    [0, 0, 0],
    [255, 255, 255],
    [10, 20, 30],
    [5, 5, 6],
  ]);
  const stats = frameChannelMeans(image);
  assert.equal(stats.pixels, 4);
  assert.equal(stats.meanR, (0 + 255 + 10 + 5) / 4);
  assert.equal(stats.meanG, (0 + 255 + 20 + 5) / 4);
  assert.equal(stats.meanB, (0 + 255 + 30 + 6) / 4);
  // (0,0,0) sums to 0; the other three exceed 15.
  assert.equal(stats.nonBlackPct, 75);
  assert.equal(stats.nonBlackSumThreshold, NON_BLACK_SUM_THRESHOLD);
  assert.equal(stats.provenance, CHANNEL_MEANS_PROVENANCE);
});

test("the coverage rule is a strict channel SUM above 15", () => {
  // Sum 15 is black, sum 16 is not — the archived `r + g + b > 15`.
  assert.equal(frameChannelMeans(frameOf([[5, 5, 5]])).nonBlackPct, 0);
  assert.equal(frameChannelMeans(frameOf([[5, 5, 6]])).nonBlackPct, 100);
  assert.equal(frameChannelMeans(frameOf([[15, 0, 0]])).nonBlackPct, 0);
  assert.equal(frameChannelMeans(frameOf([[16, 0, 0]])).nonBlackPct, 100);
  // The threshold is an option, read the same way.
  assert.equal(
    frameChannelMeans(frameOf([[5, 5, 6]]), { nonBlackSumThreshold: 16 })
      .nonBlackPct,
    0,
  );
});

test("the population differs from frameStats, which is why this is not frameStats", () => {
  // No channel of (5, 5, 6) exceeds 12, so frameStats calls it black; its sum
  // exceeds 15, so this metric does not. A consolidation that swapped one for
  // the other would move every banked coverage figure.
  const image = frameOf([[5, 5, 6]]);
  assert.equal(frameStats(image).nonBlackPct, 0);
  assert.equal(frameChannelMeans(image).nonBlackPct, 100);
});

test("uniform frames: black reads 0 %, white reads 100 %", () => {
  const black = frameOf(
    Array.from({ length: 6 }, () => [0, 0, 0]),
    3,
  );
  const white = frameOf(
    Array.from({ length: 6 }, () => [255, 255, 255]),
    3,
  );
  assert.deepEqual(
    [frameChannelMeans(black).nonBlackPct, frameChannelMeans(black).meanG],
    [0, 0],
  );
  assert.deepEqual(
    [frameChannelMeans(white).nonBlackPct, frameChannelMeans(white).meanB],
    [100, 255],
  );
});

test("the archived probe's own loop agrees on every seeded frame", () => {
  const frames = [
    frameOf([
      [0, 0, 0],
      [5, 5, 6],
      [5, 5, 5],
      [200, 100, 50],
    ]),
    randomFrame(1, 37, 23),
    randomFrame(2, 64, 64),
    randomFrame(56, 128, 72),
  ];
  for (const image of frames) {
    const archived = runArchivedLoop(image);
    const extracted = frameChannelMeans(image);
    assert.deepEqual(
      {
        width: extracted.width,
        height: extracted.height,
        meanR: extracted.meanR,
        meanG: extracted.meanG,
        meanB: extracted.meanB,
        nonBlackPct: extracted.nonBlackPct,
      },
      archived,
      `the extraction disagrees with the archived loop on a ${image.width}x${image.height} frame`,
    );
  }
});

test("a frame that cannot be read throws instead of reading as zeros", () => {
  assert.throws(
    () => frameChannelMeans({ width: 0, height: 4, data: new Uint8Array(0) }),
    /positive integer dimensions/,
  );
  assert.throws(
    () => frameChannelMeans({ width: 2, height: 2, data: new Uint8Array(15) }),
    /needs 16 RGBA bytes, got 15/,
  );
  // An over-long buffer is as unreadable as a short one: which 16 bytes?
  assert.throws(
    () => frameChannelMeans({ width: 2, height: 2, data: new Uint8Array(17) }),
    /needs 16 RGBA bytes, got 17/,
  );
  assert.throws(() => frameChannelMeans(null), /positive integer dimensions/);
  assert.throws(
    () =>
      frameChannelMeans(frameOf([[1, 2, 3]]), {
        nonBlackSumThreshold: Number.NaN,
      }),
    /finite non-negative/,
  );
});
