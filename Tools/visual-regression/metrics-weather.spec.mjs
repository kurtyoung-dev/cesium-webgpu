// metrics-weather.spec.mjs — the weather family's extracted metrics, driven with
// hand-computed frames and against the in-page code they were extracted from.
// @purpose Pins lib/metrics bright-fraction, sweep-stats, luma-regions and seam-pole-structure to hand-computed values, to the retired in-page reducers they replace, and bright-fraction to the pin harness's live in-page copy.
// @status ACTIVE
//
// Pure Node: no browser, no GPU, no network.
//
// TWO KINDS OF CHECK, ON PURPOSE. A hand-computed case says what the metric
// means. An ORACLE case says the extraction did not move a banked number: the
// arithmetic each probe ran before the harvest is quoted below verbatim (the
// `ORACLE_*` functions, each naming the probe it was lifted from; where the
// probe read a field such as `r.ring`, that field is the parameter), and the
// shared metric must reproduce it bit-for-bit on seeded inputs chosen where a
// slip would show: odd-length rows, asymmetric rings, off-centre hot pixels
// and sums whose fourth decimal decides the bar. The oracles exist only here;
// no probe calls them.
//
// THE HARNESS CASE IS LIVE, NOT QUOTED. `lib/weather-probe-pinning.mjs` keeps
// its own in-page `brightFraction` (the weather capture doctrine rebuilds that
// init script from exactly two template substitutions, so the shared function
// cannot be shipped through it without a doctrine change). This spec installs
// the REAL init script into a `vm` context and compares the reducer it defines
// with `metrics/bright-fraction.mjs`, so the two copies cannot drift apart
// without this file going red.

import assert from "node:assert/strict";
import test from "node:test";
import { createContext, Script } from "node:vm";

import { brightFraction } from "./lib/metrics/bright-fraction.mjs";
import {
  lumaRegionStats,
  meanAbsLumaDelta,
  rec601Luma,
} from "./lib/metrics/luma-regions.mjs";
import {
  centreHotSpot,
  columnStepStats,
  halfBalance,
  ringSpread,
} from "./lib/metrics/seam-pole-structure.mjs";
import { sweepDeltas, sweepStats } from "./lib/metrics/sweep-stats.mjs";
import { installWeatherPinHarnessOnPage } from "./lib/weather-probe-pinning.mjs";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** mulberry32: a seeded generator, so every "random" frame is reproducible. */
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blankFrame(width, height, rgb = [0, 0, 0]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width, height };
}

function randomFrame(width, height, seed) {
  const next = seeded(seed);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = (i & 3) === 3 ? 255 : Math.floor(next() * 256);
  }
  return { data, width, height };
}

function setPixel(frame, x, y, rgb) {
  const i = (y * frame.width + x) * 4;
  frame.data[i] = rgb[0];
  frame.data[i + 1] = rgb[1];
  frame.data[i + 2] = rgb[2];
}

// ---------------------------------------------------------------------------
// Oracles: the pre-harvest arithmetic, quoted verbatim from the probes
// ---------------------------------------------------------------------------

/** `probe-weather-presets.mjs` `skyStats`, the in-page body after decode. */
function ORACLE_PRESETS_SKY_STATS(frame) {
  const c = { width: frame.width, height: frame.height };
  const x0 = Math.floor(c.width * 0.42),
    x1 = Math.floor(c.width * 0.8),
    y0 = Math.floor(c.height * 0.42),
    y1 = Math.floor(c.height * 0.9);
  // getImageData(x0, y0, x1 - x0, y1 - y0).data, row by row
  const d = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * frame.width + x) * 4;
      d.push(frame.data[i], frame.data[i + 1], frame.data[i + 2], 255);
    }
  }
  let lum = 0,
    cloud = 0,
    n = 0;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    lum += 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b);
    if (0.299 * r + 0.587 * g + 0.114 * b > 130 && mx - mn < 40) {
      cloud++;
    }
    n++;
  }
  return {
    lum: +(lum / n).toFixed(1),
    cloudPct: +((100 * cloud) / n).toFixed(2),
  };
}

/** `probe-weather-inspector.mjs` `cloudStats`, the in-page body after decode. */
function ORACLE_INSPECTOR_CLOUD_STATS(frame) {
  const d = frame.data;
  let cloudPx = 0,
    sky = 0;
  const n = d.length / 4;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i],
      g = d[i + 1],
      b = d[i + 2];
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b);
    if (lum > 140 && mx - mn < 45) {
      cloudPx++;
    }
    if (b > r && b > 90) {
      sky++;
    }
  }
  return {
    cloudPct: +((100 * cloudPx) / n).toFixed(2),
    skyPct: +((100 * sky) / n).toFixed(2),
  };
}

/** The shared in-page `diff` of the presets and inspector probes. */
function ORACLE_DEMO_DIFF(a, b) {
  const da = a.data,
    db = b.data;
  let acc = 0;
  const n = da.length / 4;
  for (let i = 0; i < da.length; i += 4) {
    acc += Math.abs(
      0.299 * da[i] +
        0.587 * da[i + 1] +
        0.114 * da[i + 2] -
        (0.299 * db[i] + 0.587 * db[i + 1] + 0.114 * db[i + 2]),
    );
  }
  return +(acc / n).toFixed(3);
}

/** `probe-weather-map.mjs`'s inline reducer inside `cloudFracAt`. */
function ORACLE_MAP_CLOUD_FRAC(frame) {
  const px = frame.data,
    w = frame.width,
    h = frame.height;
  let cloud = 0,
    n = 0;
  for (let y = Math.floor(h * 0.2); y < h * 0.8; y += 3) {
    for (let x = Math.floor(w * 0.2); x < w * 0.8; x += 3) {
      const i = (y * w + x) * 4;
      const mx = Math.max(px[i], px[i + 1], px[i + 2]);
      if (mx > 120) cloud++;
      n++;
    }
  }
  return n ? cloud / n : 0;
}

/** `probe-weather-seam-poles.mjs` `stepStats`. */
function ORACLE_SEAM_STEP_STATS(cols) {
  const steps = [];
  for (let i = 1; i < cols.length; i++) {
    steps.push(Math.abs(cols[i] - cols[i - 1]));
  }
  const mid = Math.floor(steps.length / 2);
  const half = Math.floor(steps.length * 0.04);
  const centerMax = Math.max(...steps.slice(mid - half, mid + half));
  const rest = steps
    .slice(0, mid - half)
    .concat(steps.slice(mid + half))
    .sort((a, b) => a - b);
  const p95 = rest[Math.floor(rest.length * 0.95)];
  return { centerMax, p95 };
}

/** `probe-weather-channels.mjs` / `probe-weather-metar.mjs` `stats`. */
function ORACLE_SWEEP_STATS(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const variance =
    arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / arr.length;
  return {
    mean: +mean.toFixed(4),
    stddev: +Math.sqrt(variance).toFixed(4),
    range: +(Math.max(...arr) - Math.min(...arr)).toFixed(4),
  };
}

/**
 * `probe-weather-seam-poles.mjs` at `7e12d8f1d0`: the D-eq halves (`:481-484`)
 * and the wall ratio the gate compares with 3.0 (`:493`).
 */
function ORACLE_SEAM_HALVES(cols) {
  const mid = Math.floor(cols.length / 2);
  const meanOf = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const left = meanOf(cols.slice(0, mid)),
    right = meanOf(cols.slice(mid));
  const ratio = Math.max(left, right) / Math.max(1, Math.min(left, right));
  return { left, right, ratio };
}

/**
 * `probe-weather-seam-poles.mjs` at `7e12d8f1d0`, `:552-553`: the P-ring mean
 * and largest sector deviation (`r.ring` is the parameter here).
 */
function ORACLE_SEAM_RING(ring) {
  const mean = ring.reduce((a, b) => a + b, 0) / ring.length;
  const maxDev = Math.max(...ring.map((v) => Math.abs(v - mean)));
  return { mean, maxDev };
}

/**
 * `probe-weather-seam-poles.mjs` at `7e12d8f1d0`, `:563`: the P-centre maximum
 * (`r.center` is the parameter here), with the reference `Math.max(mean, 20)`
 * that the hot-cluster bar at `:564` multiplies by 3.
 */
function ORACLE_SEAM_CENTRE(center, mean) {
  const cMax = Math.max(...center);
  return { cMax, reference: Math.max(mean, 20) };
}

/**
 * `probe-weather-metar.mjs` at `7e12d8f1d0`, `:649` and `:651-653`: gate 4's
 * per-location deltas and the rounded sum it compares with 0.04.
 */
function ORACLE_METAR_ABS_DELTA_SUM(ch1Fr, ch0Fr) {
  const perLocDeltas = ch1Fr.map((f, i) => f - ch0Fr[i]);
  const absDeltaSum = +perLocDeltas
    .reduce((a, d) => a + Math.abs(d), 0)
    .toFixed(4);
  return { perLocDeltas, absDeltaSum };
}

// ---------------------------------------------------------------------------
// bright-fraction
// ---------------------------------------------------------------------------

test("brightFraction: a hand-computed 10x10 frame reads 2 of 4 samples bright", () => {
  // Window y in [2, 8) step 3 -> rows 2, 5; x likewise -> 4 samples.
  const frame = blankFrame(10, 10);
  setPixel(frame, 2, 2, [121, 0, 0]); // bright: 121 > 120
  setPixel(frame, 5, 2, [0, 120, 0]); // not: the bar is strict
  setPixel(frame, 2, 5, [0, 0, 200]); // bright
  setPixel(frame, 5, 5, [0, 0, 0]);
  assert.deepEqual(brightFraction(frame, 120, 3), {
    frac: 0.5,
    meanMax: 110.25,
    samples: 4,
  });
});

test("brightFraction: pixels off the strided window are never read", () => {
  const frame = blankFrame(10, 10, [255, 255, 255]);
  for (const [x, y] of [
    [2, 2],
    [5, 2],
    [2, 5],
    [5, 5],
  ]) {
    setPixel(frame, x, y, [10, 10, 10]);
  }
  assert.deepEqual(brightFraction(frame, 120, 3), {
    frac: 0,
    meanMax: 10,
    samples: 4,
  });
});

test("brightFraction: an absent or null stride is 3, and stride 1 reads the whole window", () => {
  const frame = randomFrame(10, 10, 7);
  assert.deepEqual(brightFraction(frame, 120), brightFraction(frame, 120, 3));
  assert.deepEqual(
    brightFraction(frame, 120, null),
    brightFraction(frame, 120, 3),
  );
  assert.equal(brightFraction(frame, 120, 1).samples, 36);
});

test("brightFraction: an empty frame reads zero samples, not NaN", () => {
  assert.deepEqual(brightFraction(blankFrame(0, 0), 120, 3), {
    frac: 0,
    meanMax: 0,
    samples: 0,
  });
});

test("brightFraction: reproduces probe-weather-map's inline reducer bit for bit", () => {
  for (const seed of [1, 2, 3, 99]) {
    const frame = randomFrame(97, 61, seed);
    assert.equal(
      brightFraction(frame, 120, 3).frac,
      ORACLE_MAP_CLOUD_FRAC(frame),
      `seed ${seed}`,
    );
  }
});

test("brightFraction: agrees with the pin harness's LIVE in-page reducer", async () => {
  let installed;
  await installWeatherPinHarnessOnPage({
    async addInitScript(options) {
      installed = options.content;
    },
  });
  const context = createContext({});
  new Script(installed).runInContext(context);
  const harnessReducer = context.__weatherPin.brightFraction;
  assert.equal(typeof harnessReducer, "function");
  for (const seed of [11, 12, 13]) {
    const frame = randomFrame(97, 61, seed);
    for (const threshold of [0, 16, 120, 254]) {
      for (const step of [undefined, 1, 2, 3, 5]) {
        assert.deepEqual(
          brightFraction(frame, threshold, step),
          { ...harnessReducer(frame, threshold, step) },
          `seed ${seed} threshold ${threshold} step ${step}`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// sweep-stats
// ---------------------------------------------------------------------------

test("sweepStats: hand-computed population statistics at four decimals", () => {
  // mean 0.25; squared deviations 0.0225+0.0025+0.0025+0.0225 = 0.05, /4 = 0.0125
  assert.deepEqual(sweepStats([0.1, 0.2, 0.3, 0.4]), {
    mean: 0.25,
    stddev: +Math.sqrt(0.0125).toFixed(4),
    range: 0.3,
  });
  assert.equal(sweepStats([0.1, 0.2, 0.3, 0.4]).stddev, 0.1118);
});

test("sweepStats: digits null returns the unrounded numbers", () => {
  const values = [0.123456, 0.654321, 0.5];
  const mean = (0.123456 + 0.654321 + 0.5) / 3;
  const stats = sweepStats(values, { digits: null });
  assert.equal(stats.mean, mean);
  assert.equal(stats.range, 0.654321 - 0.123456);
});

test("sweepStats: reproduces the channels/metar private stats() on seeded sweeps", () => {
  const next = seeded(5);
  for (let run = 0; run < 25; run++) {
    const sweep = Array.from({ length: 9 }, () => next());
    assert.deepEqual(sweepStats(sweep), ORACLE_SWEEP_STATS(sweep));
  }
});

test("sweepStats: an empty sweep is refused rather than reported as NaN", () => {
  assert.throws(() => sweepStats([]), RangeError);
});

test("sweepDeltas: per-location differences and their absolute sum", () => {
  const { deltas, absSum } = sweepDeltas([0.5, 0.2, 0.7], [0.4, 0.3, 0.7]);
  assert.equal(deltas.length, 3);
  assert.equal(deltas[0], 0.5 - 0.4);
  assert.equal(deltas[1], 0.2 - 0.3);
  assert.equal(deltas[2], 0);
  assert.equal(absSum, +(Math.abs(0.5 - 0.4) + Math.abs(0.2 - 0.3)).toFixed(4));
});

test("sweepDeltas: sweeps of different lengths are refused", () => {
  assert.throws(() => sweepDeltas([0.1, 0.2], [0.1]), RangeError);
});

test("sweepDeltas: reproduces metar gate 4's rounded sum, including where the fourth decimal decides the bar (ORACLE)", () => {
  // A summed |delta| of 0.0396 is below the unchanged 0.04 bar at four
  // decimals, and would read 0.04 (a pass) at three: the rounding is part of
  // the verdict, not presentation.
  const baseline = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
  const treated = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7396];
  const { absSum } = sweepDeltas(treated, baseline);
  assert.equal(absSum, 0.0396);
  assert.equal(
    absSum,
    ORACLE_METAR_ABS_DELTA_SUM(treated, baseline).absDeltaSum,
  );
  assert.ok(!(absSum >= 0.04), "0.0396 stays below the gate-4 bar");
  // Seeded seven-location sweeps (the calibrated band's width) whose sums
  // carry a nonzero fourth decimal.
  const next = seeded(59);
  for (let run = 0; run < 25; run++) {
    const ch0Fr = Array.from({ length: 7 }, () => next());
    const ch1Fr = ch0Fr.map((f) => f + (next() - 0.5) * 0.02);
    const oracle = ORACLE_METAR_ABS_DELTA_SUM(ch1Fr, ch0Fr);
    const got = sweepDeltas(ch1Fr, ch0Fr);
    assert.equal(got.absSum, oracle.absDeltaSum, `run ${run}`);
    assert.deepEqual(got.deltas, oracle.perLocDeltas, `run ${run}`);
  }
});

// ---------------------------------------------------------------------------
// luma-regions
// ---------------------------------------------------------------------------

test("lumaRegionStats: a hand-computed 2x2 frame", () => {
  const frame = blankFrame(2, 2);
  setPixel(frame, 0, 0, [200, 200, 200]); // luma 200, chroma 0 -> cloud
  setPixel(frame, 1, 0, [200, 200, 150]); // luma 194.3, chroma 50 -> not (>= 45)
  setPixel(frame, 0, 1, [40, 60, 200]); // blue sky: b > r and b > 90
  setPixel(frame, 1, 1, [10, 10, 10]);
  const expectedLum =
    (rec601Luma(200, 200, 200) +
      rec601Luma(200, 200, 150) +
      rec601Luma(40, 60, 200) +
      rec601Luma(10, 10, 10)) /
    4;
  assert.deepEqual(lumaRegionStats(frame), {
    lum: +expectedLum.toFixed(1),
    cloudPct: 25,
    skyPct: 25,
    samples: 4,
  });
});

test("lumaRegionStats: the cloud bars are strict on both luma and chroma", () => {
  const frame = blankFrame(1, 1);
  setPixel(frame, 0, 0, [140, 140, 140]); // luma exactly 140 -> not cloud
  assert.equal(lumaRegionStats(frame).cloudPct, 0);
  assert.equal(lumaRegionStats(frame, { cloudLumaAbove: 139.9 }).cloudPct, 100);
  setPixel(frame, 0, 0, [185, 160, 160]); // chroma exactly 25
  assert.equal(
    lumaRegionStats(frame, { cloudLumaAbove: 100, cloudChromaBelow: 25 })
      .cloudPct,
    0,
  );
});

test("lumaRegionStats: a fractional region reads floor-bounded, half-open pixel rows", () => {
  const stats = lumaRegionStats(blankFrame(100, 100), {
    region: { x0: 0.42, x1: 0.8, y0: 0.42, y1: 0.9 },
  });
  assert.equal(stats.samples, (80 - 42) * (90 - 42));
});

test("lumaRegionStats: reproduces the presets wedge and the inspector whole-frame reducers", () => {
  for (const seed of [21, 22, 23]) {
    const frame = randomFrame(103, 77, seed);
    const presets = lumaRegionStats(frame, {
      region: { x0: 0.42, x1: 0.8, y0: 0.42, y1: 0.9 },
      cloudLumaAbove: 130,
      cloudChromaBelow: 40,
    });
    assert.deepEqual(
      { lum: presets.lum, cloudPct: presets.cloudPct },
      ORACLE_PRESETS_SKY_STATS(frame),
      `presets seed ${seed}`,
    );
    const inspector = lumaRegionStats(frame, {
      cloudLumaAbove: 140,
      cloudChromaBelow: 45,
    });
    assert.deepEqual(
      { cloudPct: inspector.cloudPct, skyPct: inspector.skyPct },
      ORACLE_INSPECTOR_CLOUD_STATS(frame),
      `inspector seed ${seed}`,
    );
  }
});

test("lumaRegionStats: an empty region is refused", () => {
  assert.throws(
    () =>
      lumaRegionStats(blankFrame(10, 10), {
        region: { x0: 0.5, x1: 0.5, y0: 0, y1: 1 },
      }),
    RangeError,
  );
});

test("meanAbsLumaDelta: hand-computed, zero for identical frames, and the demo diff bit for bit", () => {
  const a = blankFrame(1, 2);
  const b = blankFrame(1, 2);
  setPixel(a, 0, 0, [100, 100, 100]);
  setPixel(b, 0, 0, [0, 0, 0]);
  // |100 - 0| on one pixel, 0 on the other, averaged over 2 pixels.
  assert.equal(
    meanAbsLumaDelta(a, b),
    +(rec601Luma(100, 100, 100) / 2).toFixed(3),
  );
  assert.equal(meanAbsLumaDelta(a, a), 0);
  for (const seed of [31, 32]) {
    const x = randomFrame(64, 48, seed);
    const y = randomFrame(64, 48, seed + 100);
    assert.equal(meanAbsLumaDelta(x, y), ORACLE_DEMO_DIFF(x, y));
  }
});

test("meanAbsLumaDelta: frames of different sizes are refused", () => {
  assert.throws(
    () => meanAbsLumaDelta(blankFrame(2, 2), blankFrame(2, 3)),
    RangeError,
  );
});

// ---------------------------------------------------------------------------
// seam-pole-structure
// ---------------------------------------------------------------------------

test("columnStepStats: a wall at the meridian is the centre maximum, not part of the p95", () => {
  // 101 columns -> 100 steps; mid 50, half 4 -> centre steps [46, 54).
  const columns = Array.from({ length: 101 }, (_, i) => (i <= 50 ? 10 : 90));
  // A 10/12 ripple over columns 0..20 puts 20 steps of 2 among the 92 steps
  // outside the centre band, so the sorted rest's element 87 (floor 0.95 * 92)
  // is a 2 and every other step there is 0.
  for (let i = 1; i < 20; i += 2) {
    columns[i] = 12;
  }
  const stats = columnStepStats(columns);
  assert.equal(stats.steps, 100);
  assert.equal(stats.centreMax, 80);
  assert.equal(stats.p95, 2);
});

test("columnStepStats: reproduces seam-poles' private stepStats on seeded rows", () => {
  const next = seeded(41);
  for (let run = 0; run < 20; run++) {
    const columns = Array.from({ length: 819 }, () => next() * 255);
    const oracle = ORACLE_SEAM_STEP_STATS(columns);
    const stats = columnStepStats(columns);
    assert.equal(stats.centreMax, oracle.centerMax);
    assert.equal(stats.p95, oracle.p95);
  }
});

test("columnStepStats: reproduces stepStats on other row lengths and at the centre band's edges (ORACLE)", () => {
  // The lane's 819 columns leave 754 rest steps, and 0.95 * 754 = 716.3, so
  // floor and round pick the same element there. These lengths include ones
  // where they do not (the fractional part of 0.95 * rest is at least 0.5).
  // Rows of 3 and 5 columns have no centre band at all (floor(0.04 * steps)
  // is 0); they are refused, as the next test pins.
  const lengths = [26, 27, 33, 101, 815, 819, 820, 829];
  const restOf = (length) => length - 1 - 2 * Math.floor((length - 1) * 0.04);
  assert.ok(
    lengths.some((length) => (restOf(length) * 0.95) % 1 >= 0.5),
    "at least one length separates floor from round",
  );
  const next = seeded(47);
  for (const length of lengths) {
    const steps = length - 1;
    const mid = Math.floor(steps / 2);
    const half = Math.floor(steps * 0.04);
    const rows = Array.from({ length: 5 }, () =>
      Array.from({ length }, () => next() * 255),
    );
    // A wall on the first step after the centre band and one on the last
    // step before it: each step is outside the band, so neither may become
    // the centre maximum, and a band one step wider would take it.
    for (const wallAt of [mid + half, mid - half - 1]) {
      rows.push(
        Array.from({ length }, (_, i) => next() * 20 + (i > wallAt ? 1000 : 0)),
      );
    }
    for (const [row, columns] of rows.entries()) {
      const oracle = ORACLE_SEAM_STEP_STATS(columns);
      const stats = columnStepStats(columns);
      assert.equal(stats.centreMax, oracle.centerMax, `${length}/${row}`);
      assert.equal(stats.p95, oracle.p95, `${length}/${row}`);
    }
  }
});

test("columnStepStats: too few columns to split is refused, not scored as -Infinity", () => {
  assert.throws(() => columnStepStats([1, 2, 3]), RangeError);
  assert.throws(() => columnStepStats([1, 2, 3, 4, 5]), RangeError);
});

test("halfBalance: the brighter half over the dimmer one, the dimmer floored at 1", () => {
  assert.deepEqual(halfBalance([10, 10, 40, 40]), {
    left: 10,
    right: 40,
    ratio: 4,
  });
  assert.equal(halfBalance([0, 0, 3, 3]).ratio, 3);
  assert.throws(() => halfBalance([5]), RangeError);
});

test("ringSpread: the mean and the largest sector deviation", () => {
  assert.deepEqual(ringSpread([10, 20, 30, 40]), { mean: 25, maxDev: 15 });
  assert.throws(() => ringSpread([]), RangeError);
});

test("centreHotSpot: the hottest centre value against the ring mean floored at 20", () => {
  assert.deepEqual(centreHotSpot([5, 250, 7], 10), {
    centreMax: 250,
    reference: 20,
    multiple: 12.5,
  });
  assert.equal(centreHotSpot([90], 45).reference, 45);
  assert.throws(() => centreHotSpot([], 10), RangeError);
});

test("halfBalance: reproduces seam-poles' D-eq halves and wall ratio on odd and even rows (ORACLE)", () => {
  // The real lane feeds 819 columns (floor(1024 * 0.1) .. floor(1024 * 0.9)),
  // an ODD count, so the split point is exactly where a floor/ceil slip shows.
  assert.deepEqual(halfBalance([10, 10, 40, 40, 40]), {
    left: 10,
    right: 40,
    ratio: 4,
  });
  const next = seeded(43);
  for (const length of [3, 5, 101, 819, 820]) {
    for (let run = 0; run < 5; run++) {
      const columns = Array.from({ length }, () => next() * 255);
      assert.deepEqual(
        halfBalance(columns),
        ORACLE_SEAM_HALVES(columns),
        `length ${length} run ${run}`,
      );
    }
  }
});

test("ringSpread: reproduces seam-poles' P-ring statistics on asymmetric rings (ORACLE)", () => {
  // One dark spoke on a bright ring: the largest deviation lies BELOW the
  // mean, so only an absolute deviation sees it.
  assert.deepEqual(ringSpread([...Array(11).fill(60), 0]), {
    mean: 55,
    maxDev: 55,
  });
  const next = seeded(47);
  for (let run = 0; run < 20; run++) {
    const ring = Array.from({ length: 12 }, () => 40 + next() * 40);
    ring[Math.floor(next() * 12)] = next() * 10;
    assert.deepEqual(ringSpread(ring), ORACLE_SEAM_RING(ring), `run ${run}`);
  }
});

test("centreHotSpot: reproduces seam-poles' P-centre maximum with the hot pixel off the centre (ORACLE)", () => {
  // A 9x9 block whose hottest pixel sits in a corner, not at index 40.
  const block = Array(81).fill(52);
  block[0] = 250;
  assert.deepEqual(centreHotSpot(block, 55), {
    centreMax: 250,
    reference: 55,
    multiple: 250 / 55,
  });
  const next = seeded(53);
  for (let run = 0; run < 20; run++) {
    const centre = Array.from({ length: 81 }, () => Math.floor(next() * 120));
    let hot = Math.floor(next() * 81);
    if (hot === 40) {
      hot = 0;
    }
    centre[hot] = 200 + Math.floor(next() * 56);
    const ringMean = next() * 80;
    const oracle = ORACLE_SEAM_CENTRE(centre, ringMean);
    const hotSpot = centreHotSpot(centre, ringMean);
    assert.equal(hotSpot.centreMax, oracle.cMax, `run ${run}`);
    assert.equal(hotSpot.reference, oracle.reference, `run ${run}`);
  }
});
