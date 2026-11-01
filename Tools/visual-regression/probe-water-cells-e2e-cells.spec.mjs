// probe-water-cells-e2e-cells.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Asserts, through descriptor.cells on the stub browser and a stub Sandcastle 2 run frame, that an unsettled leg-2 page, chrome left over the canvas and a demo-capture refusal are each a cell-level NOT RUN that leaves the arm's other pages, that a device fault or page error reaches 2e, and that an origin breach still ends the arm.
// @status ACTIVE
//
// One subject of the water-cells spec, split out of probe-water-cells.spec.mjs (row DX-KIT-WATER-CELLS-SPEC-OVERSIZE);
// the shared stub browser, run frame and fixtures live in fixtures/probe-water-cells-support.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { OriginRewriteRefusal } from "./lib/sandcastle2-origin-rewrite.mjs";
import { WATER_DEMO_ID, descriptor } from "./probe-water-cells.mjs";
import {
  byVariant,
  runE,
  pageVerdict,
} from "./fixtures/probe-water-cells-support.mjs";

// ---------------------------------------------------------------------------
// E: the stop rules end to end - stub pages through descriptor.cells, judged
// by waterVerdicts (Ravenhill pass 1, B1 to B3)
// ---------------------------------------------------------------------------

test("E1: a leg-2 page whose settle answers tilesSettled false is NOT RUN, captures nothing and fails :stage", async () => {
  const { records, verdicts } = await runE({
    outName: "e1-unsettled",
    cells: "orbit-disc",
    hooks: {
      settle: (rigId, arg) =>
        rigId === "water-orbit-disc"
          ? {
              tilesSettled: false,
              tileFrames: 6000,
              frames: arg.frames,
              tilesLoaded: false,
              datasetPending: false,
              elapsedMs: 180000,
            }
          : null,
    },
  });
  const on = byVariant(records, "on");
  const off = byVariant(records, "off");
  assert.ok(on.notRun?.includes("did not settle"), String(on.notRun));
  assert.ok(!on.capture, "an unsettled page captures nothing");
  const stage = pageVerdict(verdicts, on, "stage");
  assert.equal(stage.pass, false);
  assert.equal(stage.notRun, true);
  assert.equal(off.notRun, null);
  assert.ok(off.capture, "the settled twin still captures");
});

test("E1: a leg-2 page that settled its tiles but drew fewer than readiness.frames is NOT RUN", async () => {
  const { records, verdicts } = await runE({
    outName: "e1-short",
    cells: "coast-50km",
    hooks: {
      settle: (rigId, arg) =>
        rigId === "water-coast-50km"
          ? {
              tilesSettled: true,
              tileFrames: 40,
              frames: arg.frames - 1,
              tilesLoaded: true,
              datasetPending: false,
              elapsedMs: 180000,
            }
          : null,
    },
  });
  const on = byVariant(records, "on");
  assert.ok(on.notRun?.includes("did not settle"), String(on.notRun));
  assert.ok(!on.capture);
  assert.equal(pageVerdict(verdicts, on, "stage").pass, false);
});

const LEG2_FAULTS = [
  [
    "an uncaptured GPU error",
    { gate: () => ({ errors: ["[webgpu] uncaptured GPU error: E-STUB"] }) },
    (fault) =>
      assert.deepEqual(fault.gate.errors, [
        "[webgpu] uncaptured GPU error: E-STUB",
      ]),
  ],
  [
    "a lost device",
    { gate: () => ({ deviceLost: "[webgpu] device lost: reason=unknown" }) },
    (fault) =>
      assert.equal(
        fault.gate.deviceLost,
        "[webgpu] device lost: reason=unknown",
      ),
  ],
  [
    "a page error",
    { pageError: () => "E-STUB page exception" },
    (fault) => {
      assert.equal(fault.gate.pageErrorCount, 1);
      assert.ok(fault.gate.pageErrors[0].includes("E-STUB page exception"));
    },
  ],
];

test("E2: a clean WebGPU leg-2 page arms its device and passes 2e on what the gate read", async () => {
  const { records, verdicts } = await runE({
    outName: "e2-clean",
    cells: "orbit-disc",
  });
  assert.equal(records.length, 2);
  for (const rec of records) {
    assert.ok(rec.capture);
    assert.equal(
      rec.gate.armedDevices,
      1,
      "the page's arming reached the gate",
    );
    const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
    assert.equal(fault.pass, true, rec.variant);
    assert.equal(fault.notRun, undefined);
  }
});

for (const [label, hooks, check] of LEG2_FAULTS) {
  test(`E2: ${label} on a WebGPU leg-2 page fails 2e through descriptor.cells`, async () => {
    const { records, verdicts } = await runE({
      outName: `e2-${label.replaceAll(" ", "-")}`,
      cells: "orbit-disc",
      hooks,
    });
    for (const rec of records) {
      const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
      assert.equal(fault.pass, false, `${label} ${rec.variant}`);
      assert.equal(fault.notRun, undefined, "a fault is measured, not NOT RUN");
      check(fault);
    }
  });
}

test("E2: a WebGL leg-2 page passes 2e with no armed device, and still fails on a page error", async () => {
  const clean = await runE({
    outName: "e2-webgl-clean",
    cells: "orbit-disc",
    renderers: ["webgl"],
  });
  for (const rec of clean.records) {
    assert.equal(rec.gate.armedDevices, 0);
    assert.equal(
      pageVerdict(clean.verdicts, rec, "2e-no-device-fault").pass,
      true,
    );
  }
  const faulty = await runE({
    outName: "e2-webgl-pageerror",
    cells: "orbit-disc",
    renderers: ["webgl"],
    hooks: { pageError: () => "E-STUB webgl exception" },
  });
  for (const rec of faulty.records) {
    assert.equal(
      pageVerdict(faulty.verdicts, rec, "2e-no-device-fault").pass,
      false,
    );
  }
});

test("E3: a clean 1f page on WebGPU is captured through the piece, its run-frame gate armed, and passes 2e", async () => {
  const { records, verdicts, log } = await runE({
    outName: "e3-clean",
    cells: "1f",
  });
  assert.equal(records.length, 1);
  const [rec] = records;
  assert.equal(rec.notRun, null);
  assert.ok(rec.capture && fs.existsSync(rec.capture.path));
  assert.equal(log.opened[0].id, WATER_DEMO_ID);
  assert.equal(rec.gate.armedDevices, 1, "the piece's arming reached the gate");
  const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
  assert.equal(fault.pass, true);
});

const DEMO_FAULTS = [
  [
    "an uncaptured GPU error in the run frame",
    { gateErrors: ["[webgpu] uncaptured GPU error: D-STUB"] },
    (fault) =>
      assert.deepEqual(fault.gate.errors, [
        "[webgpu] uncaptured GPU error: D-STUB",
      ]),
  ],
  [
    "a lost device in the run frame",
    { deviceLost: "[webgpu] device lost: reason=unknown D-STUB" },
    (fault) =>
      assert.equal(
        fault.gate.deviceLost,
        "[webgpu] device lost: reason=unknown D-STUB",
      ),
  ],
  [
    "a page error while the demo opens",
    { pageError: "D-STUB demo exception" },
    (fault) => {
      assert.equal(fault.gate.pageErrorCount, 1);
      assert.ok(fault.gate.pageErrors[0].includes("D-STUB demo exception"));
    },
  ],
];

for (const [label, demo, check] of DEMO_FAULTS) {
  test(`E3: ${label} fails 1f's 2e through descriptor.cells`, async () => {
    const { records, verdicts } = await runE({
      outName: `e3-${label.replaceAll(" ", "-")}`,
      cells: "1f",
      demo,
    });
    const [rec] = records;
    assert.ok(rec.capture, "the fault does not stop the capture");
    const fault = pageVerdict(verdicts, rec, "2e-no-device-fault");
    assert.equal(fault.pass, false, label);
    assert.equal(fault.notRun, undefined, "a fault is measured, not NOT RUN");
    check(fault);
  });
}

const DEMO_REFUSALS = [
  ["demo-renderer-gate", { contextRenderer: "webgl" }],
  [
    "demo-not-settled",
    {
      settle: {
        outcome: "frame-cap",
        frames: 12000,
        settledFrames: 3,
        frameNumber: 12000,
        tilesLoaded: false,
      },
    },
  ],
];

for (const [reason, demo] of DEMO_REFUSALS) {
  test(`E4: a 1f refusal (${reason}) is a cell-level NOT RUN with its reason; the arm's leg-2 pages keep their records`, async () => {
    const { records, verdicts } = await runE({
      outName: `e4-${reason}`,
      cells: "orbit-disc,1f",
      demo,
    });
    assert.equal(records.length, 3, "two leg-2 pages and the 1f page");
    const leg2 = records.filter((r) => r.cell === "orbit-disc");
    assert.ok(leg2.every((r) => r.notRun === null && r.capture));
    const demoRecord = records.find((r) => r.cell === "1f");
    assert.ok(
      demoRecord.notRun.startsWith(`${reason}: `),
      String(demoRecord.notRun),
    );
    assert.equal(demoRecord.refusal.reason, reason);
    assert.equal(typeof demoRecord.refusal.message, "string");
    assert.ok(demoRecord.refusal.details, "the refusal's details are kept");
    assert.ok(!demoRecord.capture);
    const stage = pageVerdict(verdicts, demoRecord, "stage");
    assert.equal(stage.pass, false);
    assert.equal(stage.notRun, true);
    const fault = pageVerdict(verdicts, demoRecord, "2e-no-device-fault");
    if (reason === "demo-not-settled") {
      // A2-3: the piece read the gate before refusing; 2e is judged on it.
      assert.ok(
        demoRecord.refusal.details.gate,
        "the refusal carries the gate",
      );
      assert.equal(demoRecord.gate.armedDevices, 1);
      assert.equal(demoRecord.gate.notRead, undefined);
      assert.equal(fault.pass, true, "a clean gate read before the refusal");
      assert.equal(fault.notRun, undefined);
    } else {
      // A2-3: the gate was never read - NOT RUN with that reason, the
      // refusal carried, never "error gate not armed".
      assert.equal(fault.pass, false);
      assert.equal(fault.notRun, true, "an unread gate is no measurement");
      assert.equal(fault.reason, "gate not read (page refused)");
      assert.equal(fault.refusal.reason, reason);
    }
    const receipt = descriptor.receipt(records, {
      options: { arm: "before", cells: "orbit-disc,1f" },
    });
    assert.equal(receipt.pages.length, 3);
    assert.equal(receipt.summary["orbit-disc"].captures.length, 2);
    assert.equal(receipt.summary["1f"].notRun.length, 1);
  });
}

test("E4: an origin breach is not a cell-level refusal: it still ends the arm", async () => {
  await assert.rejects(
    runE({
      outName: "e4-breach",
      cells: "orbit-disc,1f",
      demo: { originBreach: true },
    }),
    (error) => error instanceof OriginRewriteRefusal,
  );
});

test("E5: chrome the strip could not remove makes the page NOT RUN (capture-chrome-over-canvas), not a voided arm", async () => {
  const { records, verdicts } = await runE({
    outName: "e5-chrome",
    cells: "orbit-disc",
    hooks: {
      leftovers: (rigId) =>
        rigId === "water-orbit-disc" ? [".cesium-viewer-toolbar"] : [],
    },
  });
  const on = byVariant(records, "on");
  const off = byVariant(records, "off");
  assert.ok(
    on.notRun?.startsWith("capture-chrome-over-canvas: "),
    String(on.notRun),
  );
  assert.equal(on.refusal.reason, "capture-chrome-over-canvas");
  assert.deepEqual(on.refusal.details.widgets.leftovers, [
    ".cesium-viewer-toolbar",
  ]);
  assert.ok(!on.capture, "chrome over the canvas is never captured");
  assert.equal(pageVerdict(verdicts, on, "stage").pass, false);
  assert.equal(off.notRun, null);
  assert.ok(off.capture);
});
