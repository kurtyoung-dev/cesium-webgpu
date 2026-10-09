// metrics-clustered.spec.mjs — the clustered family's two metric modules, held to the loops they replaced.
//
// @purpose Holds lib/metrics/channel-sum-brightness.mjs and lib/metrics/cluster-light-counts.mjs equal to verbatim reference copies of the in-page loops the clustered-lighting probes ran before the probe-kit harvest, over synthetic frames and readbacks that reach every branch, and pins their fail-closed refusals.
// @status ACTIVE
//
// THE REFERENCE COPIES ARE THE ORIGINALS, NOT A RESTATEMENT. Each `reference*`
// function below wraps a loop body copied token for token from the probe at
// `a5b71fc17b` (the file and line range are named on each one); only the
// enclosing function was added and the indentation re-flowed. Two known edits
// are named where they happen: the renaming of `A.counts` / `B.counts` to two
// array parameters, and per-frame's overlap, which assigns `totalOverlap` and
// `max` where the reference declares them with `let` (see
// `referenceOverlap`). A reviewer can diff each body against
// `git show a5b71fc17b:<probe>` with whitespace ignored. The decoded frames the
// originals read were `{w, h, data}` from an in-page canvas; the fixtures here
// hand the same layout to the reference and `{width, height, data}` to the
// module.
//
// THE FIXTURES REACH EVERY BRANCH ON PURPOSE. A frame pair in which every
// pixel changed by 40 would agree under any threshold rule. The pair built
// here carries pixels whose sum changes by exactly 5 (not counted) and 6
// (counted), darkened pixels (a negative signed delta), and hue shifts at
// constant sum (counted by a sum-of-absolute-differences rule, not by this
// one), at sizes where `width * 0.3` is not an integer, so a floor/truncation
// slip or a `>=` for `>` changes an asserted number.
//
// Pure Node: no browser, no GPU, no I/O.

import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SUM_CHANGE_THRESHOLD,
  channelSumChange,
  fractionalRoi,
} from "./lib/metrics/channel-sum-brightness.mjs";
import {
  CLUSTER_GRID,
  clusterCellsThatDiffer,
  summariseClusterLightCounts,
} from "./lib/metrics/cluster-light-counts.mjs";

// ---------------------------------------------------------------------------
// Reference copies (verbatim loop bodies, a5b71fc17b)
// ---------------------------------------------------------------------------

/** probe-clustered-demo-scene.mjs:194-216, verbatim. */
function referenceDemoScene(off, on) {
  let so = 0,
    sn = 0,
    n = 0,
    ch = 0,
    md = 0;
  for (let i = 0; i < off.data.length; i += 4) {
    const a = off.data[i] + off.data[i + 1] + off.data[i + 2];
    const b = on.data[i] + on.data[i + 1] + on.data[i + 2];
    so += a;
    sn += b;
    n++;
    const dd = Math.abs(b - a);
    if (dd > 5) ch++;
    if (dd > md) md = dd;
  }
  return {
    meanOff: so / n,
    meanOn: sn / n,
    delta: (sn - so) / n,
    changedPx: ch,
    maxDelta: md,
    n,
  };
}

/** probe-clustered-litmat.mjs:209-240, verbatim. */
function referenceLitmat(off, on) {
  const x0 = Math.floor(off.w * 0.3);
  const x1 = Math.floor(off.w * 0.7);
  const y0 = Math.floor(off.h * 0.3);
  const y1 = Math.floor(off.h * 0.7);
  let sumOff = 0,
    sumOn = 0,
    n = 0,
    changed = 0,
    maxDelta = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * off.w + x) * 4;
      const sOff = off.data[i] + off.data[i + 1] + off.data[i + 2];
      const sOn = on.data[i] + on.data[i + 1] + on.data[i + 2];
      sumOff += sOff;
      sumOn += sOn;
      n += 1;
      const d = Math.abs(sOn - sOff);
      if (d > 5) changed += 1;
      if (d > maxDelta) maxDelta = d;
    }
  }
  return {
    w: off.w,
    h: off.h,
    n,
    meanOff: sumOff / n,
    meanOn: sumOn / n,
    delta: (sumOn - sumOff) / n,
    changedPx: changed,
    maxDelta,
  };
}

/** probe-clustered-multifrustum.mjs:216-249, verbatim. */
function referenceMultifrustum(off, on) {
  const x0 = Math.floor(off.w * 0.3);
  const x1 = Math.floor(off.w * 0.7);
  const y0 = Math.floor(off.h * 0.35);
  const y1 = Math.floor(off.h * 0.75);
  let sumOff = 0,
    sumOn = 0,
    n = 0,
    changed = 0,
    maxDelta = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * off.w + x) * 4;
      const sOff = off.data[i] + off.data[i + 1] + off.data[i + 2];
      const sOn = on.data[i] + on.data[i + 1] + on.data[i + 2];
      sumOff += sOff;
      sumOn += sOn;
      n += 1;
      const d = Math.abs(sOn - sOff);
      if (d > 5) changed += 1;
      if (d > maxDelta) maxDelta = d;
    }
  }
  return {
    w: off.w,
    h: off.h,
    boxX: [x0, x1],
    boxY: [y0, y1],
    n,
    meanOff: sumOff / n,
    meanOn: sumOn / n,
    delta: (sumOn - sumOff) / n,
    changedPx: changed,
    maxDelta,
  };
}

/** probe-clustered-phong.mjs:167-195, verbatim (note the `| 0` truncation). */
function referencePhong(off, on) {
  const x0 = (off.w * 0.3) | 0,
    x1 = (off.w * 0.7) | 0,
    y0 = (off.h * 0.3) | 0,
    y1 = (off.h * 0.7) | 0;
  let so = 0,
    sn = 0,
    n = 0,
    ch = 0,
    md = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * off.w + x) * 4;
      const a = off.data[i] + off.data[i + 1] + off.data[i + 2];
      const b = on.data[i] + on.data[i + 1] + on.data[i + 2];
      so += a;
      sn += b;
      n++;
      const dd = Math.abs(b - a);
      if (dd > 5) ch++;
      if (dd > md) md = dd;
    }
  return {
    meanOff: so / n,
    meanOn: sn / n,
    delta: (sn - so) / n,
    changedPx: ch,
    maxDelta: md,
    n,
  };
}

/** probe-clustered-visible.mjs:233-268, verbatim. */
function referenceVisible(off, on) {
  const x0 = Math.floor(off.w * 0.25);
  const x1 = Math.floor(off.w * 0.75);
  const y0 = Math.floor(off.h * 0.25);
  const y1 = Math.floor(off.h * 0.75);
  let sumOff = 0,
    sumOn = 0,
    n = 0;
  // Also count pixels that changed meaningfully — robust to camera
  // jitter (entire-frame delta).
  let changed = 0;
  let maxDelta = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * off.w + x) * 4;
      const sOff = off.data[i] + off.data[i + 1] + off.data[i + 2];
      const sOn = on.data[i] + on.data[i + 1] + on.data[i + 2];
      sumOff += sOff;
      sumOn += sOn;
      n += 1;
      const d = Math.abs(sOn - sOff);
      if (d > 5) changed += 1;
      if (d > maxDelta) maxDelta = d;
    }
  }
  return {
    w: off.w,
    h: off.h,
    boxX: [x0, x1],
    boxY: [y0, y1],
    n,
    meanOff: sumOff / n,
    meanOn: sumOn / n,
    delta: (sumOn - sumOff) / n,
    changedPx: changed,
    maxDelta,
  };
}

/**
 * probe-clustered-dispatcher.mjs:186-191, verbatim. probe-clustered-per-frame.mjs:
 * 136-141 runs the identical loop over `TOTAL`, but assigns `totalOverlap = 0;
 * max = 0;` (declared at :116-117) where this copy, like dispatcher, declares
 * them with `let`.
 */
function referenceOverlap(counts, TOTAL) {
  let totalOverlap = 0;
  let max = 0;
  for (let i = 0; i < TOTAL; i++) {
    totalOverlap += counts[i];
    if (counts[i] > max) max = counts[i];
  }
  return { totalOverlap, max };
}

/** probe-clustered-lights-resize.mjs:145-150, verbatim. */
function referenceTotalOccupied(counts) {
  let total = 0;
  let occupied = 0;
  for (let i = 0; i < counts.length; i++) {
    total += counts[i];
    if (counts[i] > 0) occupied++;
  }
  return { total, occupied };
}

/** probe-clustered-lights-resize.mjs:162-165, verbatim, with `A`/`B` as arrays. */
function referenceDiffCells(Acounts, Bcounts, TOTAL) {
  let diffCells = 0;
  for (let i = 0; i < TOTAL; i++) {
    if (Acounts[i] !== Bcounts[i]) diffCells++;
  }
  return diffCells;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A deterministic OFF/ON pair. OFF is a bounded arithmetic texture; ON adds a
 * brightened disc, a darkened band, a column of hue shifts at constant sum,
 * and a sprinkle of pixels whose sum moves by exactly 5 and exactly 6.
 *
 * @returns {{off: object, on: object, legacyOff: object, legacyOn: object}}
 */
function makePair(width, height) {
  const off = new Uint8ClampedArray(width * height * 4);
  const on = new Uint8ClampedArray(width * height * 4);
  const cx = width * 0.52;
  const cy = height * 0.48;
  const r = Math.min(width, height) * 0.22;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const base = [
        40 + ((x * 7 + y * 13) % 150),
        40 + ((x * 11 + y * 5) % 150),
        40 + ((x * 3 + y * 17) % 150),
      ];
      off[i] = base[0];
      off[i + 1] = base[1];
      off[i + 2] = base[2];
      off[i + 3] = 255;
      let lit = [...base];
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy < r * r) {
        const bump = 3 + ((x + y) % 38);
        lit = lit.map((value) => value + bump);
      } else if (y % 17 === 3) {
        lit = lit.map((value) => value - 9);
      } else if (x % 23 === 7) {
        lit = [lit[0] + 10, lit[1] - 10, lit[2]];
      } else if ((x * 31 + y * 7) % 29 === 0) {
        lit = [lit[0] + 2, lit[1] + 2, lit[2] + 1];
      } else if ((x * 13 + y * 19) % 31 === 0) {
        lit = [lit[0] + 2, lit[1] + 2, lit[2] + 2];
      }
      on[i] = lit[0];
      on[i + 1] = lit[1];
      on[i + 2] = lit[2];
      on[i + 3] = 255;
    }
  }
  return {
    off: { width, height, data: off },
    on: { width, height, data: on },
    legacyOff: { w: width, h: height, data: off },
    legacyOn: { w: width, h: height, data: on },
  };
}

/** The five probes' boxes, as `fractionalRoi` boxes. */
const BOXES = Object.freeze({
  demoScene: {},
  litmat: { left: 0.3, right: 0.7, top: 0.3, bottom: 0.7 },
  multifrustum: { left: 0.3, right: 0.7, top: 0.35, bottom: 0.75 },
  phong: { left: 0.3, right: 0.7, top: 0.3, bottom: 0.7 },
  visible: { left: 0.25, right: 0.75, top: 0.25, bottom: 0.75 },
});

const REFERENCES = Object.freeze({
  demoScene: referenceDemoScene,
  litmat: referenceLitmat,
  multifrustum: referenceMultifrustum,
  phong: referencePhong,
  visible: referenceVisible,
});

/** The sizes the probes ran at (800x600, demo-scene 1000x700) plus an odd one. */
const SIZES = Object.freeze([
  [800, 600],
  [1000, 700],
  [37, 23],
]);

function project(result) {
  return {
    n: result.countedPx,
    meanOff: result.meanBefore,
    meanOn: result.meanAfter,
    delta: result.delta,
    changedPx: result.changedPx,
    maxDelta: result.maxDelta,
  };
}

function projectReference(reference) {
  return {
    n: reference.n,
    meanOff: reference.meanOff,
    meanOn: reference.meanOn,
    delta: reference.delta,
    changedPx: reference.changedPx,
    maxDelta: reference.maxDelta,
  };
}

// ---------------------------------------------------------------------------
// channel-sum-brightness
// ---------------------------------------------------------------------------

test("channelSumChange over fractionalRoi equals each of the five original loops, bit for bit", () => {
  for (const [width, height] of SIZES) {
    const pair = makePair(width, height);
    for (const [name, box] of Object.entries(BOXES)) {
      const roi = fractionalRoi(width, height, box);
      const actual = project(channelSumChange(pair.off, pair.on, { roi }));
      const expected = projectReference(
        REFERENCES[name](pair.legacyOff, pair.legacyOn),
      );
      assert.deepEqual(actual, expected, `${name} at ${width}x${height}`);
      // Non-vacuity: the box both changed and held unchanged pixels, and the
      // largest change is far above the bar, so a dropped count would show.
      assert.ok(
        actual.changedPx > 0 && actual.changedPx < actual.n,
        `${name} at ${width}x${height}: the fixture did not straddle the bar`,
      );
    }
  }
});

test("fractionalRoi reproduces each original's box arithmetic, including phong's | 0", () => {
  for (const [width, height] of SIZES) {
    assert.deepEqual(fractionalRoi(width, height, BOXES.litmat), {
      x0: Math.floor(width * 0.3),
      y0: Math.floor(height * 0.3),
      x1: Math.floor(width * 0.7),
      y1: Math.floor(height * 0.7),
    });
    assert.deepEqual(fractionalRoi(width, height, BOXES.phong), {
      x0: (width * 0.3) | 0,
      y0: (height * 0.3) | 0,
      x1: (width * 0.7) | 0,
      y1: (height * 0.7) | 0,
    });
    assert.deepEqual(fractionalRoi(width, height, BOXES.multifrustum), {
      x0: Math.floor(width * 0.3),
      y0: Math.floor(height * 0.35),
      x1: Math.floor(width * 0.7),
      y1: Math.floor(height * 0.75),
    });
    assert.deepEqual(fractionalRoi(width, height, BOXES.demoScene), {
      x0: 0,
      y0: 0,
      x1: width,
      y1: height,
    });
  }
  // 37 * 0.3 = 11.1: the floor is 11, a rounding slip would say 11 or 12
  // depending on the rule, and 37 * 0.7 = 25.9 separates floor from round.
  assert.deepEqual(fractionalRoi(37, 23, BOXES.litmat), {
    x0: 11,
    y0: 6,
    x1: 25,
    y1: 16,
  });
});

test("the threshold is strict: a sum change of exactly 5 is not counted, 6 is", () => {
  const off = new Uint8ClampedArray([10, 10, 10, 255, 10, 10, 10, 255]);
  const on = new Uint8ClampedArray([12, 12, 11, 255, 12, 12, 12, 255]);
  const result = channelSumChange(
    { width: 2, height: 1, data: off },
    { width: 2, height: 1, data: on },
  );
  assert.equal(DEFAULT_SUM_CHANGE_THRESHOLD, 5);
  assert.equal(result.changedPx, 1);
  assert.equal(result.maxDelta, 6);
  assert.equal(result.delta, 5.5);
});

test("a hue shift at constant brightness is no change; darkening gives a negative delta", () => {
  const off = new Uint8ClampedArray([100, 100, 100, 255, 100, 100, 100, 255]);
  const on = new Uint8ClampedArray([110, 90, 100, 255, 90, 90, 90, 255]);
  const result = channelSumChange(
    { width: 2, height: 1, data: off },
    { width: 2, height: 1, data: on },
  );
  assert.equal(result.changedPx, 1, "only the darkened pixel changed");
  assert.equal(result.maxDelta, 30);
  assert.equal(result.delta, -15);
});

test("two frames of different sizes throw — a size mismatch can never let a check pass", () => {
  const a = makePair(8, 6).off;
  const b = makePair(8, 7).on;
  assert.throws(() => channelSumChange(a, b), {
    name: "RangeError",
    message: /frame size mismatch 8x6 vs 8x7/,
  });
  assert.throws(() => channelSumChange(b, a), { name: "RangeError" });
});

test("malformed inputs and regions fail closed", () => {
  const { off, on } = makePair(10, 10);
  assert.throws(() => channelSumChange(null, on), { name: "TypeError" });
  assert.throws(
    () =>
      channelSumChange({ width: 10, height: 10, data: new Uint8Array(4) }, on),
    { name: "TypeError" },
  );
  for (const roi of [
    { x0: 0, y0: 0, x1: 11, y1: 10 },
    { x0: 5, y0: 0, x1: 5, y1: 10 },
    { x0: 0.5, y0: 0, x1: 4, y1: 4 },
    { x0: -1, y0: 0, x1: 4, y1: 4 },
  ]) {
    assert.throws(() => channelSumChange(off, on, { roi }), {
      name: "RangeError",
    });
  }
  assert.throws(() => channelSumChange(off, on, { threshold: Number.NaN }), {
    name: "TypeError",
  });
  assert.throws(() => fractionalRoi(10, 10, { left: 0.7, right: 0.3 }), {
    name: "RangeError",
  });
  assert.throws(() => fractionalRoi(10, 10, { left: -0.1 }), {
    name: "RangeError",
  });
  assert.throws(() => fractionalRoi(10.5, 10), { name: "RangeError" });
  assert.throws(() => fractionalRoi(3, 3, { left: 0.4, right: 0.6 }), {
    name: "RangeError",
  });
});

// ---------------------------------------------------------------------------
// cluster-light-counts
// ---------------------------------------------------------------------------

/** A readback with a directional baseline of 1 everywhere and a point-light lobe. */
function makeReadback(seed) {
  const counts = new Uint32Array(CLUSTER_GRID.cells);
  for (let i = 0; i < counts.length; i++) {
    counts[i] = (i * 7 + seed) % 11 === 0 ? 0 : 1;
    if ((i + seed) % 97 < 9) {
      counts[i] += 1 + ((i + seed) % 3);
    }
  }
  return counts;
}

test("CLUSTER_GRID is the probes' 16 x 9 x 24", () => {
  assert.equal(CLUSTER_GRID.cells, 16 * 9 * 24);
  assert.equal(
    CLUSTER_GRID.cells,
    CLUSTER_GRID.x * CLUSTER_GRID.y * CLUSTER_GRID.z,
  );
});

test("summariseClusterLightCounts equals the original totalOverlap/max and total/occupied loops", () => {
  for (const seed of [0, 3, 41]) {
    const counts = makeReadback(seed);
    const summary = summariseClusterLightCounts(counts);
    const overlap = referenceOverlap(counts, 16 * 9 * 24);
    const occupancy = referenceTotalOccupied(counts);
    assert.equal(summary.cells, 16 * 9 * 24);
    assert.equal(summary.total, overlap.totalOverlap);
    assert.equal(summary.max, overlap.max);
    assert.equal(summary.total, occupancy.total);
    assert.equal(summary.occupied, occupancy.occupied);
    assert.ok(summary.occupied > 0 && summary.occupied < summary.cells);
    assert.ok(summary.max > 1);
  }
});

test("clusterCellsThatDiffer equals the original diffCells loop and is zero for a self-comparison", () => {
  const a = makeReadback(0);
  const b = makeReadback(5);
  const expected = referenceDiffCells(a, b, 16 * 9 * 24);
  assert.ok(expected > 0, "the fixture pair must differ somewhere");
  assert.equal(clusterCellsThatDiffer(a, b), expected);
  assert.equal(clusterCellsThatDiffer(a, Uint32Array.from(a)), 0);
  assert.equal(clusterCellsThatDiffer([1, 2, 3], [1, 0, 3]), 1);
});

test("cluster readbacks fail closed: empty, non-integer, negative, mismatched lengths", () => {
  assert.throws(() => summariseClusterLightCounts([]), { name: "TypeError" });
  assert.throws(() => summariseClusterLightCounts(null), { name: "TypeError" });
  assert.throws(() => summariseClusterLightCounts([1, Number.NaN]), {
    name: "TypeError",
  });
  assert.throws(() => summariseClusterLightCounts([1, -1]), {
    name: "TypeError",
  });
  assert.throws(() => summariseClusterLightCounts([1, 1.5]), {
    name: "TypeError",
  });
  assert.throws(() => clusterCellsThatDiffer([1, 2], [1, 2, 3]), {
    name: "RangeError",
    message: /length mismatch 2 vs 3/,
  });
});
