// probe-water-cells-bands.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Asserts waterVerdicts applies the sheet's mask bands (stage, 2e, 2b, 2c with the orbit-disc floor, 2f, 2a against a base report) on the AFTER arm only, and that a page whose gate was never read is 2e NOT RUN with its refusal carried.
// @status ACTIVE
//
// One subject of the water-cells spec, split out of probe-water-cells.spec.mjs (row DX-KIT-WATER-CELLS-SPEC-OVERSIZE);
// the shared stub browser, run frame and fixtures live in fixtures/probe-water-cells-support.mjs.

import assert from "node:assert/strict";
import test from "node:test";

import {
  WATER_CELLS,
  WATER_DEMO_ID,
  summarizeWaterRecords,
  waterVerdicts,
} from "./probe-water-cells.mjs";
import {
  image,
  makeStore,
  record,
  cleanGate,
  verdict,
  verdictsWhere,
} from "./fixtures/probe-water-cells-support.mjs";

// ---------------------------------------------------------------------------
// V: waterVerdicts
// ---------------------------------------------------------------------------

function flatMaskRecords(store, cell, { absent = [] } = {}) {
  const out = [];
  for (const renderer of ["webgl", "webgpu"]) {
    for (const variant of ["off", "on"]) {
      out.push(
        record(store, cell, variant, renderer, 0, image(), {
          gate: cleanGate,
          waterDialsAbsent: variant === "on" ? absent : [],
        }),
      );
    }
  }
  return out;
}

/** A real summary structure with the measured numbers overlaid. */
function maskSummary(cell, { absent = [], overlay = {} } = {}) {
  const store = makeStore();
  const records = flatMaskRecords(store, cell, { absent });
  const summary = summarizeWaterRecords(records, {
    loadImage: store.loadImage,
  });
  Object.assign(summary[cell], overlay);
  return { summary, records, store };
}

test("V1: every page gets a :stage verdict that fails when the page was NOT RUN", () => {
  const store = makeStore();
  const ok = record(store, "coast-50km", "on", "webgl", 0, image(), {
    gate: cleanGate,
  });
  const bad = record(store, "coast-50km", "on", "webgpu", 0, null, {
    notRun: "the AFTER tree did not take globalWaterMask",
    gate: cleanGate,
  });
  const summary = summarizeWaterRecords([ok, bad], {
    loadImage: store.loadImage,
  });
  const verdicts = waterVerdicts([ok, bad], summary, null, { arm: "before" });
  const stageGl = verdicts.find(
    (v) => v.id.includes("webgl") && v.id.endsWith(":stage"),
  );
  const stageGpu = verdicts.find(
    (v) => v.id.includes("webgpu") && v.id.endsWith(":stage"),
  );
  assert.equal(stageGl.pass, true);
  assert.equal(stageGpu.pass, false);
  assert.equal(stageGpu.notRun, true);
});

test("V2: :2e-no-device-fault fails on a lost device, an uncaptured error or a page error, and passes clean", () => {
  const cases = [
    ["clean", cleanGate, true],
    [
      "device lost",
      { ...cleanGate, deviceLost: "device lost: reason=unknown" },
      false,
    ],
    [
      "uncaptured error",
      { ...cleanGate, errorCount: 1, errors: ["validation"] },
      false,
    ],
    ["page error", { ...cleanGate, pageErrorCount: 1 }, false],
  ];
  for (const [label, gate, pass] of cases) {
    const store = makeStore();
    const rec = record(store, "orbit-disc", "on", "webgpu", 0, image(), {
      gate,
    });
    const summary = summarizeWaterRecords([rec], {
      loadImage: store.loadImage,
    });
    const verdicts = waterVerdicts([rec], summary, null, { arm: "before" });
    const fault = verdicts.find((v) => v.id.endsWith(":2e-no-device-fault"));
    assert.ok(fault, `${label}: no 2e verdict`);
    assert.equal(fault.pass, pass, label);
  }
});

test("V2: a fault-free WebGPU page whose error gate armed no device fails 2e as NOT RUN; WebGL needs no armed device; a fault is a fault either way", () => {
  const cases = [
    // [label, renderer, gate, pass, notRun]
    [
      "webgpu, armed 0",
      "webgpu",
      { ...cleanGate, armedDevices: 0 },
      false,
      true,
    ],
    [
      "webgpu, armed missing",
      "webgpu",
      { ...cleanGate, armedDevices: undefined },
      false,
      true,
    ],
    ["webgpu, armed 1", "webgpu", cleanGate, true, undefined],
    [
      "webgl, armed 0",
      "webgl",
      { ...cleanGate, armedDevices: 0 },
      true,
      undefined,
    ],
    [
      "webgpu, armed 0, a page error",
      "webgpu",
      { ...cleanGate, armedDevices: 0, pageErrorCount: 1 },
      false,
      undefined,
    ],
  ];
  for (const [label, renderer, gate, pass, notRun] of cases) {
    const store = makeStore();
    const rec = record(store, "orbit-disc", "on", renderer, 0, image(), {
      gate,
    });
    const summary = summarizeWaterRecords([rec], {
      loadImage: store.loadImage,
    });
    const verdicts = waterVerdicts([rec], summary, null, { arm: "before" });
    const fault = verdicts.find((v) => v.id.endsWith(":2e-no-device-fault"));
    assert.equal(fault.pass, pass, label);
    assert.equal(fault.notRun, notRun, label);
    if (notRun) {
      assert.equal(fault.reason, "error gate not armed", label);
    }
  }
});

test("V3: the mask-effect bands (2b, 2c) are judged on the AFTER arm only", () => {
  const { summary, records } = maskSummary("coast-50km", {
    overlay: { effectPct: { webgl: [9], webgpu: [9] } },
  });
  const before = waterVerdicts(records, summary, null, { arm: "before" });
  assert.equal(
    verdict(before, "coast-50km", ":2b-effect-agreement"),
    undefined,
  );
  assert.equal(
    verdictsWhere(before, "coast-50km", ":2c-effect-floor").length,
    0,
  );
  const afterV = waterVerdicts(records, summary, null, { arm: "after" });
  assert.ok(verdict(afterV, "coast-50km", ":2b-effect-agreement"));
  assert.equal(
    verdictsWhere(afterV, "coast-50km", ":2c-effect-floor").length,
    2,
  );
});

test("V3: a cell with a water dial absent on the ON rig is not judged on 2b or 2c, even on AFTER", () => {
  const { summary, records } = maskSummary("coast-50km", {
    absent: ["globalWaterMask"],
    overlay: { effectPct: { webgl: [9], webgpu: [9] } },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  assert.equal(
    verdict(verdicts, "coast-50km", ":2b-effect-agreement"),
    undefined,
  );
  assert.equal(
    verdictsWhere(verdicts, "coast-50km", ":2c-effect-floor").length,
    0,
  );
});

function judge2b(gl, gpu) {
  const { summary, records } = maskSummary("coast-50km", {
    overlay: { effectPct: { webgl: [gl], webgpu: [gpu] } },
  });
  return verdict(
    waterVerdicts(records, summary, null, { arm: "after" }),
    "coast-50km",
    ":2b-effect-agreement",
  );
}

test("V4: 2b passes iff |gl - gpu| <= max(0.1 x the larger, 0.3 pp)", () => {
  // relative arm dominates: larger 10.9, allowed 1.09
  assert.equal(judge2b(10, 10.9).pass, true);
  assert.equal(judge2b(10, 11.2).pass, false);
  // absolute arm dominates: larger 0.75, 10 percent is 0.075, allowed 0.3
  assert.equal(judge2b(0.5, 0.75).pass, true);
  assert.equal(judge2b(0.5, 0.9).pass, false);
  // symmetric
  assert.equal(judge2b(10.9, 10).pass, true);
  assert.equal(judge2b(11.2, 10).pass, false);
});

test("V4: 2b uses the median over runs", () => {
  const { summary, records } = maskSummary("coast-50km", {
    overlay: { effectPct: { webgl: [10, 50, 10.5], webgpu: [10.2, 0, 10.4] } },
  });
  const v = verdict(
    waterVerdicts(records, summary, null, { arm: "after" }),
    "coast-50km",
    ":2b-effect-agreement",
  );
  assert.equal(v.pass, true);
});

function judge2c(cell, gl, gpu) {
  const { summary, records } = maskSummary(cell, {
    overlay: { effectPct: { webgl: [gl], webgpu: [gpu] } },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  return {
    webgl: verdict(verdicts, cell, ":2c-effect-floor:webgl"),
    webgpu: verdict(verdicts, cell, ":2c-effect-floor:webgpu"),
  };
}

test("V5: 2c passes iff the median effect is at least the cell's floor: 0.5 for great-lakes", () => {
  assert.equal(judge2c("great-lakes", 0.5, 0.49).webgl.pass, true);
  assert.equal(judge2c("great-lakes", 0.5, 0.49).webgpu.pass, false);
  assert.equal(judge2c("great-lakes", 0.49, 3).webgl.pass, false);
});

test("V5: 2c floor is 5 for coast-50km", () => {
  const cell = "coast-50km";
  assert.equal(judge2c(cell, 5, 4.9).webgl.pass, true, `${cell} 5.0`);
  assert.equal(judge2c(cell, 5, 4.9).webgpu.pass, false, `${cell} 4.9`);
  assert.equal(
    judge2c(cell, 0.5, 0.5).webgl.pass,
    false,
    `${cell} 0.5 is below 5`,
  );
});

test("V5 (A3-1, seat ruling S6): 2c floor is 2 for orbit-disc, so Edge round 2's 3.325 / 3.269 % pass on both renderers", () => {
  assert.equal(WATER_CELLS["orbit-disc"].effectFloorPct, 2);
  const measured = judge2c("orbit-disc", 3.325, 3.269);
  assert.equal(measured.webgl.pass, true, "3.325 % on WebGL");
  assert.equal(measured.webgpu.pass, true, "3.269 % on WebGPU");
  assert.equal(measured.webgl.floorPct, 2);
  const edge = judge2c("orbit-disc", 2, 1.99);
  assert.equal(edge.webgl.pass, true, "2.0 is at the floor");
  assert.equal(edge.webgpu.pass, false, "1.99 is below 2");
});

test("V5: 2c judges the median of the runs, not an extreme", () => {
  const { summary, records } = maskSummary("great-lakes", {
    overlay: { effectPct: { webgl: [100, 0.1, 0.6], webgpu: [0.6, 0.6, 0.6] } },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  assert.equal(
    verdict(verdicts, "great-lakes", ":2c-effect-floor:webgl").pass,
    true,
  );
  const low = maskSummary("great-lakes", {
    overlay: { effectPct: { webgl: [100, 0.1, 0.2], webgpu: [0.6, 0.6, 0.6] } },
  });
  const lowVerdicts = waterVerdicts(low.records, low.summary, null, {
    arm: "after",
  });
  assert.equal(
    verdict(lowVerdicts, "great-lakes", ":2c-effect-floor:webgl").pass,
    false,
  );
});

function judge2f(effect, offRepeat) {
  const { summary, records } = maskSummary("great-lakes-lakeonly", {
    overlay: {
      effectPct: { webgl: [effect], webgpu: [effect] },
      offRepeatPct: { webgl: offRepeat, webgpu: offRepeat },
    },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  return {
    webgl: verdict(
      verdicts,
      "great-lakes-lakeonly",
      ":2f-effect-ceiling:webgl",
    ),
    webgpu: verdict(
      verdicts,
      "great-lakes-lakeonly",
      ":2f-effect-ceiling:webgpu",
    ),
    verdicts,
  };
}

test("V6: 2f passes iff the median effect is at most the OFF repeat (0 when null) plus 0.05 pp", () => {
  assert.equal(judge2f(0.04, null).webgl.pass, true);
  assert.equal(judge2f(0.06, null).webgl.pass, false);
  assert.equal(judge2f(0.24, 0.2).webgl.pass, true);
  assert.equal(judge2f(0.26, 0.2).webgl.pass, false);
  assert.equal(judge2f(0.26, 0.2).webgpu.pass, false);
  assert.equal(judge2f(0, 0).webgl.pass, true);
});

test("V6: the lake-only cell emits 2f and no 2b or 2c", () => {
  const { verdicts } = judge2f(0.01, null);
  assert.equal(
    verdict(verdicts, "great-lakes-lakeonly", ":2b-effect-agreement"),
    undefined,
  );
  assert.equal(
    verdictsWhere(verdicts, "great-lakes-lakeonly", ":2c-effect-floor").length,
    0,
  );
});

test("V6: 2f is judged on AFTER only", () => {
  const { summary, records } = maskSummary("great-lakes-lakeonly", {
    overlay: { effectPct: { webgl: [5], webgpu: [5] } },
  });
  const before = waterVerdicts(records, summary, null, { arm: "before" });
  assert.equal(
    verdictsWhere(before, "great-lakes-lakeonly", ":2f-effect-ceiling").length,
    0,
  );
});

test("V6: a median effect that is null fails 2f and 2c", () => {
  const { summary, records } = maskSummary("great-lakes-lakeonly", {
    overlay: { effectPct: { webgl: [null], webgpu: [null] } },
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "after" });
  assert.equal(
    verdict(verdicts, "great-lakes-lakeonly", ":2f-effect-ceiling:webgl").pass,
    false,
  );
});

function judge2a(afterParity, beforeParity) {
  const after = maskSummary("orbit-disc", {
    overlay: { parityOnPct: afterParity },
  });
  const before = maskSummary("orbit-disc", {
    overlay: { parityOnPct: beforeParity },
  });
  return verdict(
    waterVerdicts(after.records, after.summary, before.summary, {
      arm: "after",
    }),
    "orbit-disc",
    ":2a-parity",
  );
}

test("V7: 2a passes iff the after median parity is at most BEFORE's median + 1.0 + 3 x the after spread", () => {
  assert.equal(judge2a([2.9], [2]).pass, true);
  assert.equal(judge2a([3.1], [2]).pass, false);
  // spread 0.5 -> bound 2 + 1 + 1.5 = 4.5; median of [3.5, 4.0] is 3.75
  assert.equal(judge2a([3.5, 4.0], [2]).pass, true);
  // spread 2 -> bound 2 + 1 + 6 = 9; median of [3.1, 5.1] is 4.1
  assert.equal(judge2a([3.1, 5.1], [2]).pass, true);
  // spread 0.2 -> bound 3.6; median of [3.8, 4.0] is 3.9
  assert.equal(judge2a([3.8, 4.0], [2]).pass, false);
});

test("V7: 2a is emitted only on AFTER with a base", () => {
  const after = maskSummary("orbit-disc", { overlay: { parityOnPct: [1] } });
  const before = maskSummary("orbit-disc", { overlay: { parityOnPct: [1] } });
  assert.equal(
    verdict(
      waterVerdicts(after.records, after.summary, null, { arm: "after" }),
      "orbit-disc",
      ":2a-parity",
    ),
    undefined,
  );
  assert.equal(
    verdict(
      waterVerdicts(after.records, after.summary, before.summary, {
        arm: "before",
      }),
      "orbit-disc",
      ":2a-parity",
    ),
    undefined,
  );
});

test("V8: a base report that never measured the cell yields <cell>:base-absent, failing with notRun", () => {
  const after = maskSummary("orbit-disc", { overlay: { parityOnPct: [1] } });
  const other = maskSummary("coast-50km", {});
  const verdicts = waterVerdicts(after.records, after.summary, other.summary, {
    arm: "after",
  });
  const absent = verdicts.find((v) => v.id === "orbit-disc:base-absent");
  assert.ok(absent, `verdicts: ${verdicts.map((v) => v.id).join(", ")}`);
  assert.equal(absent.pass, false);
  assert.equal(absent.notRun, true);
});

// 2e on a page whose gate was never read (A2-3).

test("V12 (A2-3): a fault-free page whose gate was never read is 2e NOT RUN, 'gate not read (page refused)', the refusal carried, on either renderer", () => {
  const store = makeStore();
  const refusalRecordOf = {
    reason: "demo-renderer-gate",
    message: "stub",
    details: { demoId: WATER_DEMO_ID },
  };
  const records = ["webgl", "webgpu"].map((renderer) => ({
    run: 0,
    cell: "1f",
    kind: "sandcastle2-demo",
    variant: "demo",
    rig: "sandcastle2-globe-materials-water-mask",
    renderer,
    notRun: "demo-renderer-gate: stub",
    refusal: refusalRecordOf,
    gate: {
      deviceLost: null,
      errorCount: 0,
      errors: [],
      armedDevices: 0,
      pageErrors: [],
      pageErrorCount: 0,
      notRead: "page refused",
    },
  }));
  const summary = summarizeWaterRecords(records, {
    loadImage: store.loadImage,
  });
  const verdicts = waterVerdicts(records, summary, null, { arm: "before" });
  for (const rec of records) {
    const fault = verdicts.find(
      (v) => v.id === `1f:demo:${rec.renderer}:run0:2e-no-device-fault`,
    );
    assert.equal(fault.pass, false, rec.renderer);
    assert.equal(fault.notRun, true);
    assert.equal(fault.reason, "gate not read (page refused)");
    assert.deepEqual(fault.refusal, refusalRecordOf);
  }
  // A page error is measured even when the gate was not: a fault, not NOT RUN.
  const faulty = {
    ...records[1],
    gate: { ...records[1].gate, pageErrors: ["x"], pageErrorCount: 1 },
  };
  const fault = waterVerdicts([faulty], summary, null, {
    arm: "before",
  }).find((v) => v.id.endsWith(":2e-no-device-fault"));
  assert.equal(fault.pass, false);
  assert.equal(fault.notRun, undefined);
});
