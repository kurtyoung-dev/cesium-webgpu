// probe-water-cells-summary.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Asserts mismatchPct and summarizeWaterRecords measure effect, parity and repeat percentages from synthetic captures at the right tolerances, and yield null (never 0) for a missing or NOT RUN capture.
// @status ACTIVE
//
// One subject of the water-cells spec, split out of probe-water-cells.spec.mjs (row DX-KIT-WATER-CELLS-SPEC-OVERSIZE);
// the shared stub browser, run frame and fixtures live in fixtures/probe-water-cells-support.mjs.

import assert from "node:assert/strict";
import test from "node:test";

import { mismatchPct, summarizeWaterRecords } from "./probe-water-cells.mjs";
import {
  SIZE,
  image,
  makeStore,
  record,
  near,
} from "./fixtures/probe-water-cells-support.mjs";

// ---------------------------------------------------------------------------
// S: summarizeWaterRecords, on synthetic captures
// ---------------------------------------------------------------------------

test("S0: mismatchPct is null for different sizes and counts channels beyond the tolerance only", () => {
  const a = image();
  assert.equal(mismatchPct(a, { ...a, width: SIZE - 1 }, 8), null);
  assert.equal(mismatchPct(null, a, 8), null);
  near(
    mismatchPct(a, image([{ count: 50, delta: 8 }]), 8),
    0,
    "delta 8 at tol 8",
  );
  near(
    mismatchPct(a, image([{ count: 50, delta: 9 }]), 8),
    0.5,
    "delta 9 at tol 8",
  );
});

test("S1: effectPct is the share of pixels with any channel more than 8/255 apart, OFF vs ON on one renderer, per run", () => {
  const store = makeStore();
  const off = image();
  // run 0: 200 px red +9, 100 px green +9 (any channel counts), 100 px red +8
  // (not counted) = 300 px = 3 percent.
  const on0 = image([
    { count: 200, channel: 0, delta: 9 },
    { count: 100, channel: 1, delta: 9 },
    { count: 100, channel: 0, delta: 8 },
  ]);
  // run 1: 500 px = 5 percent.
  const on1 = image([{ count: 500, channel: 2, delta: 40 }]);
  const records = [];
  for (const renderer of ["webgl", "webgpu"]) {
    records.push(record(store, "coast-50km", "off", renderer, 0, off));
    records.push(record(store, "coast-50km", "on", renderer, 0, on0));
    records.push(record(store, "coast-50km", "off", renderer, 1, off));
    records.push(record(store, "coast-50km", "on", renderer, 1, on1));
  }
  const entry = summarizeWaterRecords(records, { loadImage: store.loadImage })[
    "coast-50km"
  ];
  for (const renderer of ["webgl", "webgpu"]) {
    assert.equal(entry.effectPct[renderer].length, 2);
    near(entry.effectPct[renderer][0], 3, `${renderer} run 0`);
    near(entry.effectPct[renderer][1], 5, `${renderer} run 1`);
  }
});

test("S2: parityOnPct and parityOffPct are the WebGL-vs-WebGPU mismatch at tolerance 16, per run, in percent", () => {
  const store = makeStore();
  // 100 px at +16 are within the tolerance, 100 px at +17 are not: 1 percent.
  const gpuOn = image([
    { count: 100, delta: 16 },
    { count: 100, delta: 17 },
  ]);
  const records = [
    record(store, "orbit-disc", "on", "webgl", 0, image()),
    record(store, "orbit-disc", "on", "webgpu", 0, gpuOn),
    record(store, "orbit-disc", "off", "webgl", 0, image()),
    record(
      store,
      "orbit-disc",
      "off",
      "webgpu",
      0,
      image([{ count: 300, delta: 40 }]),
    ),
  ];
  const entry = summarizeWaterRecords(records, { loadImage: store.loadImage })[
    "orbit-disc"
  ];
  assert.equal(entry.parityOnPct.length, 1);
  near(entry.parityOnPct[0], 1, "parityOn");
  near(entry.parityOffPct[0], 3, "parityOff");
});

test("S3: offRepeatPct is OFF run 0 against OFF run 1 at tolerance 8 per renderer, and null with a single run", () => {
  const store = makeStore();
  const single = [];
  const double = [];
  for (const renderer of ["webgl", "webgpu"]) {
    const off0 = record(store, "great-lakes", "off", renderer, 0, image());
    const on0 = record(store, "great-lakes", "on", renderer, 0, image());
    single.push(off0, on0);
    // 100 px at +9 count, 100 px at +8 do not: 1 percent.
    const off1 = record(
      store,
      "great-lakes",
      "off",
      renderer,
      1,
      image([
        { count: 100, delta: 9 },
        { count: 100, delta: 8 },
      ]),
    );
    const on1 = record(store, "great-lakes", "on", renderer, 1, image());
    double.push(off0, on0, off1, on1);
  }
  const one = summarizeWaterRecords(single, { loadImage: store.loadImage })[
    "great-lakes"
  ];
  assert.equal(one.offRepeatPct.webgl, null);
  assert.equal(one.offRepeatPct.webgpu, null);
  const two = summarizeWaterRecords(double, { loadImage: store.loadImage })[
    "great-lakes"
  ];
  near(two.offRepeatPct.webgl, 1, "webgl");
  near(two.offRepeatPct.webgpu, 1, "webgpu");
});

test("S4: a missing or NOT RUN capture yields null, never 0", () => {
  const store = makeStore();
  const records = [
    record(store, "coast-50km", "off", "webgl", 0, image()),
    record(
      store,
      "coast-50km",
      "on",
      "webgl",
      0,
      image([{ count: 100, delta: 50 }]),
    ),
    // WebGPU ON page was NOT RUN: it has no capture.
    record(store, "coast-50km", "off", "webgpu", 0, image()),
    record(store, "coast-50km", "on", "webgpu", 0, null, {
      notRun: "the stage did not apply x",
    }),
  ];
  const entry = summarizeWaterRecords(records, { loadImage: store.loadImage })[
    "coast-50km"
  ];
  near(entry.effectPct.webgl[0], 1, "webgl effect");
  assert.equal(entry.effectPct.webgpu[0], null);
  assert.equal(entry.parityOnPct[0], null);
  near(entry.parityOffPct[0], 0, "off parity is measured");
  assert.equal(entry.notRun.length, 1);
});

test("S4: a capture on a page that is also marked NOT RUN is not measured", () => {
  const store = makeStore();
  const records = [
    record(store, "coast-50km", "off", "webgl", 0, image()),
    record(
      store,
      "coast-50km",
      "on",
      "webgl",
      0,
      image([{ count: 100, delta: 50 }]),
      {
        notRun: "late failure",
      },
    ),
  ];
  const entry = summarizeWaterRecords(records, { loadImage: store.loadImage })[
    "coast-50km"
  ];
  assert.equal(entry.effectPct.webgl[0], null);
});

test("S5: for 1f repeatPct is run 0 against run 1 at tolerance 16 (null with one run) and parityPct is per run", () => {
  const store = makeStore();
  const runs = (count) => {
    const out = [];
    for (let run = 0; run < count; run += 1) {
      out.push(
        record(
          store,
          "1f",
          "demo",
          "webgl",
          run,
          run === 0
            ? image()
            : image([
                { count: 100, delta: 16 },
                { count: 200, delta: 17 },
              ]),
        ),
        record(
          store,
          "1f",
          "demo",
          "webgpu",
          run,
          image([{ count: 400, delta: 30 }]),
        ),
      );
    }
    return out;
  };
  const one = summarizeWaterRecords(runs(1), { loadImage: store.loadImage })[
    "1f"
  ];
  assert.equal(one.repeatPct.webgl, null);
  assert.equal(one.repeatPct.webgpu, null);
  assert.equal(one.parityPct.length, 1);
  near(one.parityPct[0], 4, "parity run 0");
  const two = summarizeWaterRecords(runs(2), { loadImage: store.loadImage })[
    "1f"
  ];
  near(two.repeatPct.webgl, 2, "webgl repeat");
  near(two.repeatPct.webgpu, 0, "webgpu repeat");
  assert.equal(two.parityPct.length, 2);
  // run 1: the WebGL image is +16 on 100 px and +17 on 200 px, the WebGPU
  // image +30 on 400 px: 14 and 13 apart (within 16) and then 100 px that are
  // 30 apart, which is 1 percent.
  near(two.parityPct[1], 1, "parity run 1");
});
