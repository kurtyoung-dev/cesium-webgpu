// probe-water-cells-demo-1f.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Asserts waterVerdicts judges cell 1f after-vs-before on the first runs within its band, parity-as-before on the medians, and reports canvases of different sizes per renderer as NOT RUN naming both sizes.
// @status ACTIVE
//
// One subject of the water-cells spec, split out of probe-water-cells.spec.mjs (row DX-KIT-WATER-CELLS-SPEC-OVERSIZE);
// the shared stub browser, run frame and fixtures live in fixtures/probe-water-cells-support.mjs.

import assert from "node:assert/strict";
import test from "node:test";

import { summarizeWaterRecords, waterVerdicts } from "./probe-water-cells.mjs";
import {
  makeStore,
  cleanGate,
  verdict,
  verdictsWhere,
  flat,
  moved,
} from "./fixtures/probe-water-cells-support.mjs";

// 1f: AFTER-vs-BEFORE on captured PNGs.

function demoRecords(store, prefix, specs) {
  const out = [];
  for (const [renderer, run, img] of specs) {
    const rec = {
      run,
      cell: "1f",
      kind: "sandcastle2-demo",
      variant: "demo",
      rig: "sandcastle2-globe-materials-water-mask",
      renderer,
      notRun: null,
      gate: cleanGate,
    };
    if (img !== null) {
      rec.capture = store.put(`${prefix}/${renderer}/${run}`, img);
    }
    out.push(rec);
  }
  return out;
}

function judge1f({
  after,
  before,
  afterRepeat,
  beforeRepeat,
  afterParity,
  beforeParity,
}) {
  const store = makeStore();
  const afterRecords = demoRecords(store, "after", after);
  const beforeRecords = demoRecords(store, "before", before);
  const afterSummary = summarizeWaterRecords(afterRecords, {
    loadImage: store.loadImage,
  });
  const beforeSummary = summarizeWaterRecords(beforeRecords, {
    loadImage: store.loadImage,
  });
  if (afterRepeat) {
    Object.assign(afterSummary["1f"].repeatPct, afterRepeat);
  }
  if (beforeRepeat) {
    Object.assign(beforeSummary["1f"].repeatPct, beforeRepeat);
  }
  if (afterParity) {
    afterSummary["1f"].parityPct = afterParity;
  }
  if (beforeParity) {
    beforeSummary["1f"].parityPct = beforeParity;
  }
  return waterVerdicts(afterRecords, afterSummary, beforeSummary, {
    arm: "after",
    loadImage: store.loadImage,
  });
}

test("V9: 1f after-vs-before passes iff the first-run mismatch (tolerance 16) is at most max(0.05, 2 x the larger repeat)", () => {
  const same = [
    ["webgl", 0, flat()],
    ["webgpu", 0, flat()],
  ];
  const v = (count, extra = {}) =>
    judge1f({
      after: [
        ["webgl", 0, moved(count)],
        ["webgpu", 0, moved(count)],
      ],
      before: same,
      ...extra,
    });
  // 4 px = 0.04 percent <= 0.05
  assert.equal(verdict(v(4), "1f", ":after-vs-before:webgl").pass, true);
  assert.equal(verdict(v(4), "1f", ":after-vs-before:webgpu").pass, true);
  // 6 px = 0.06 percent > 0.05
  assert.equal(verdict(v(6), "1f", ":after-vs-before:webgl").pass, false);
  // a tolerance-16 difference is not a difference
  assert.equal(
    verdict(
      judge1f({
        after: [
          ["webgl", 0, moved(2000, 16)],
          ["webgpu", 0, moved(2000, 16)],
        ],
        before: same,
      }),
      "1f",
      ":after-vs-before:webgl",
    ).pass,
    true,
  );
  // the larger repeat of either tree widens the band: 2 x 0.04 = 0.08
  assert.equal(
    verdict(
      v(6, { afterRepeat: { webgl: 0.04, webgpu: 0.04 } }),
      "1f",
      ":after-vs-before:webgl",
    ).pass,
    true,
  );
  assert.equal(
    verdict(
      v(6, { beforeRepeat: { webgl: 0.04, webgpu: 0.04 } }),
      "1f",
      ":after-vs-before:webgl",
    ).pass,
    true,
  );
  assert.equal(
    verdict(
      v(9, { beforeRepeat: { webgl: 0.04, webgpu: 0.04 } }),
      "1f",
      ":after-vs-before:webgl",
    ).pass,
    false,
  );
});

test("V9: 1f after-vs-before compares the FIRST runs only", () => {
  const verdicts = judge1f({
    after: [
      ["webgl", 0, flat()],
      ["webgl", 1, moved(3000)],
      ["webgpu", 0, flat()],
      ["webgpu", 1, moved(3000)],
    ],
    before: [
      ["webgl", 0, flat()],
      ["webgl", 1, flat()],
      ["webgpu", 0, flat()],
      ["webgpu", 1, flat()],
    ],
    afterRepeat: { webgl: 0, webgpu: 0 },
  });
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgl").pass, true);
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgpu").pass, true);
});

test("V9: 1f with a capture missing on either side fails with notRun, for that renderer only", () => {
  const verdicts = judge1f({
    after: [
      ["webgl", 0, flat()],
      ["webgpu", 0, flat()],
    ],
    before: [
      ["webgl", 0, null],
      ["webgpu", 0, flat()],
    ],
  });
  const gl = verdict(verdicts, "1f", ":after-vs-before:webgl");
  assert.equal(gl.pass, false);
  assert.equal(gl.notRun, true);
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgpu").pass, true);
});

test("V9: parity-as-before compares the parity medians within the same band", () => {
  const same = [
    ["webgl", 0, flat()],
    ["webgpu", 0, flat()],
  ];
  const run = (afterParity, beforeParity, repeat) =>
    verdict(
      judge1f({
        after: same,
        before: same,
        afterParity,
        beforeParity,
        afterRepeat: repeat,
        beforeRepeat: repeat,
      }),
      "1f",
      ":parity-as-before",
    );
  assert.equal(run([0.5], [0.54]).pass, true);
  assert.equal(run([0.5], [0.6]).pass, false);
  assert.equal(run([0.6], [0.5]).pass, false);
  // repeat 0.04 on both renderers -> band 0.08
  assert.equal(run([0.5], [0.57], { webgl: 0.04, webgpu: 0.04 }).pass, true);
});

test("V9: 1f is not judged without a base or on the BEFORE arm", () => {
  const store = makeStore();
  const records = demoRecords(store, "a", [
    ["webgl", 0, flat()],
    ["webgpu", 0, flat()],
  ]);
  const summary = summarizeWaterRecords(records, {
    loadImage: store.loadImage,
  });
  for (const [base, arm] of [
    [null, "after"],
    [summary, "before"],
  ]) {
    const verdicts = waterVerdicts(records, summary, base, {
      arm,
      loadImage: store.loadImage,
    });
    assert.equal(verdictsWhere(verdicts, "1f", ":after-vs-before").length, 0);
    assert.equal(verdictsWhere(verdicts, "1f", ":parity-as-before").length, 0);
  }
});

// 1f parity with canvases of different sizes per renderer (A2-2; Edge round 2
// measured 1280x687 on WebGL and 1280x520 on WebGPU on both trees).

const sized = (width, height) => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(200),
});

test("V11 (A2-2): parity-as-before with different canvas sizes per renderer is NOT RUN, 'canvas size differs', naming both sizes; never a FAIL with null values", () => {
  const split = () => [
    ["webgl", 0, sized(1280, 687)],
    ["webgpu", 0, sized(1280, 520)],
    ["webgl", 1, sized(1280, 687)],
    ["webgpu", 1, sized(1280, 520)],
  ];
  const verdicts = judge1f({ after: split(), before: split() });
  const parity = verdict(verdicts, "1f", ":parity-as-before");
  assert.equal(parity.pass, false);
  assert.equal(parity.notRun, true, "NOT RUN, not a measured FAIL");
  assert.ok(
    parity.reason.startsWith("canvas size differs: "),
    String(parity.reason),
  );
  for (const text of ["AFTER", "BEFORE", "1280x687", "1280x520"]) {
    assert.ok(parity.reason.includes(text), `${text} in ${parity.reason}`);
  }
  assert.deepEqual(parity.sizes.after[0], {
    webgl: "1280x687",
    webgpu: "1280x520",
  });
  // The same-renderer terms still measure: each renderer's canvas is one size
  // on both trees.
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgl").pass, true);
  assert.equal(verdict(verdicts, "1f", ":after-vs-before:webgpu").pass, true);
});

test("V11 (A2-2): a size split on AFTER alone names AFTER's sizes, and a missing capture is named as such", () => {
  const verdicts = judge1f({
    after: [
      ["webgl", 0, sized(40, 30)],
      ["webgpu", 0, sized(40, 20)],
    ],
    before: [
      ["webgl", 0, sized(40, 30)],
      ["webgpu", 0, sized(40, 30)],
    ],
  });
  const parity = verdict(verdicts, "1f", ":parity-as-before");
  assert.equal(parity.notRun, true);
  assert.equal(
    parity.reason,
    "canvas size differs: AFTER webgl 40x30 vs webgpu 40x20",
  );
  const gap = verdict(
    judge1f({
      after: [
        ["webgl", 0, flat()],
        ["webgpu", 0, null],
      ],
      before: [
        ["webgl", 0, flat()],
        ["webgpu", 0, flat()],
      ],
    }),
    "1f",
    ":parity-as-before",
  );
  assert.equal(gap.notRun, true);
  assert.equal(
    gap.reason,
    "no WebGL and WebGPU capture pair of one size on AFTER",
  );
});

test("V11 (A2-2): canvases of one size still measure parity-as-before and record no reason", () => {
  const same = [
    ["webgl", 0, flat()],
    ["webgpu", 0, flat()],
  ];
  const parity = verdict(
    judge1f({ after: same, before: same }),
    "1f",
    ":parity-as-before",
  );
  assert.equal(parity.pass, true);
  assert.equal(parity.notRun, undefined);
  assert.equal(parity.reason, undefined);
});

test("V11 (A2-2): a BEFORE report written before paritySizes existed gives its sizes from its own captures", () => {
  const store = makeStore();
  const split = (prefix) =>
    demoRecords(store, prefix, [
      ["webgl", 0, sized(1280, 687)],
      ["webgpu", 0, sized(1280, 520)],
    ]);
  const afterRecords = split("after");
  const beforeRecords = split("before");
  const summarize = (records) =>
    summarizeWaterRecords(records, { loadImage: store.loadImage });
  const afterSummary = summarize(afterRecords);
  const beforeSummary = summarize(beforeRecords);
  delete beforeSummary["1f"].paritySizes;
  const parity = verdict(
    waterVerdicts(afterRecords, afterSummary, beforeSummary, {
      arm: "after",
      loadImage: store.loadImage,
    }),
    "1f",
    ":parity-as-before",
  );
  assert.equal(parity.notRun, true);
  assert.equal(
    parity.reason,
    "canvas size differs: AFTER webgl 1280x687 vs webgpu 1280x520; BEFORE webgl 1280x687 vs webgpu 1280x520",
  );
});
