// probe-water-cells-descriptor-pages.spec.mjs - lane KT-2 (Nardol). Pure Node: no browser, no GPU.
//
// @purpose Asserts the descriptor refuses an undeclared arm and a bad base report, and that pages on a stub browser are NOT RUN under --arm after when a water dial they need did not apply, capture under --arm before, and cell 1f is NOT RUN under --no-ion.
// @status ACTIVE
//
// One subject of the water-cells spec, split out of probe-water-cells.spec.mjs (row DX-KIT-WATER-CELLS-SPEC-OVERSIZE);
// the shared stub browser, run frame and fixtures live in fixtures/probe-water-cells-support.mjs.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  descriptor,
  summarizeWaterRecords,
  waterVerdicts,
} from "./probe-water-cells.mjs";
import {
  TEMP_ROOT,
  refusal,
  makeFakeBrowser,
  byVariant,
} from "./fixtures/probe-water-cells-support.mjs";

// ---------------------------------------------------------------------------
// D: the descriptor's refusals
// ---------------------------------------------------------------------------

function cellsArgs(overrides = {}) {
  return {
    browser: null,
    run: 0,
    options: {
      arm: "before",
      cells: "coast-50km",
      renderers: ["webgl"],
      ...overrides.options,
    },
    origin: "http://localhost:8080",
    outputDirectory: overrides.outputDirectory ?? path.join(TEMP_ROOT, "d-out"),
    captures: [],
  };
}

test("D1: an undeclared or unknown arm refuses arm-undeclared", async () => {
  for (const arm of ["", undefined, "both", "BEFORE"]) {
    await assert.rejects(
      descriptor.cells(cellsArgs({ options: { arm } })),
      refusal("arm-undeclared"),
      `arm ${JSON.stringify(arm)}`,
    );
  }
});

test("D1: --base-report with --arm before refuses base-report-on-before-arm", async () => {
  await assert.rejects(
    descriptor.cells(
      cellsArgs({
        options: { arm: "before", baseReport: path.join(TEMP_ROOT, "x.json") },
      }),
    ),
    refusal("base-report-on-before-arm"),
  );
});

test("D1: a base report in the run's own output directory refuses base-report-same-output", async () => {
  const dir = path.join(TEMP_ROOT, "same-out");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "water-cells-report.json");
  fs.writeFileSync(file, JSON.stringify({ arm: "before", summary: {} }));
  await assert.rejects(
    descriptor.cells(
      cellsArgs({
        options: { arm: "after", baseReport: file },
        outputDirectory: dir,
      }),
    ),
    refusal("base-report-same-output"),
  );
});

test("D1: a base report that is not a BEFORE water-cells report refuses base-report-invalid", async () => {
  const dir = path.join(TEMP_ROOT, "invalid");
  fs.mkdirSync(dir, { recursive: true });
  const bodies = {
    "after-arm.json": { arm: "after", summary: {} },
    "no-summary.json": { arm: "before" },
    "array.json": [],
    "null.json": null,
  };
  for (const [name, body] of Object.entries(bodies)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(body));
    await assert.rejects(
      descriptor.cells(
        cellsArgs({
          options: { arm: "after", baseReport: file },
          outputDirectory: path.join(TEMP_ROOT, "invalid-out"),
        }),
      ),
      refusal("base-report-invalid"),
      name,
    );
  }
});

test("D1: a base report that cannot be read refuses base-report-unreadable", async () => {
  const dir = path.join(TEMP_ROOT, "unreadable");
  fs.mkdirSync(dir, { recursive: true });
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{not json");
  for (const file of [path.join(dir, "missing.json"), broken]) {
    await assert.rejects(
      descriptor.cells(
        cellsArgs({
          options: { arm: "after", baseReport: file },
          outputDirectory: path.join(TEMP_ROOT, "unreadable-out"),
        }),
      ),
      refusal("base-report-unreadable"),
      file,
    );
  }
});

// ---------------------------------------------------------------------------
// N: pages on a stub browser
// ---------------------------------------------------------------------------

async function runPages({ arm, cells, notApplied, noIon, outName }) {
  const log = { urls: [], contexts: 0 };
  const outputDirectory = path.join(TEMP_ROOT, outName);
  const records = await descriptor.cells({
    browser: makeFakeBrowser(log, { notApplied }),
    run: 0,
    options: { arm, cells, renderers: ["webgl"], noIon },
    origin: "http://localhost:8080",
    outputDirectory,
    captures: [],
  });
  return { records, log };
}

test("N1: under --arm after, an ON page whose true water dial did not apply is NOT RUN; its OFF twin still captures", async () => {
  const { records } = await runPages({
    arm: "after",
    cells: "coast-50km",
    outName: "n1",
    notApplied: (rigId) =>
      rigId === "water-coast-50km" ? ["globalWaterMask"] : [],
  });
  const on = byVariant(records, "on");
  const off = byVariant(records, "off");
  assert.equal(typeof on.notRun, "string");
  assert.ok(on.notRun.includes("globalWaterMask"), on.notRun);
  assert.ok(!on.capture, "a NOT RUN page captures nothing");
  assert.equal(off.notRun, null);
  assert.ok(off.capture);
});

test("N1: under --arm before the same ON page still captures", async () => {
  const { records } = await runPages({
    arm: "before",
    cells: "coast-50km",
    outName: "n1b",
    notApplied: (rigId) =>
      rigId === "water-coast-50km" ? ["globalWaterMask"] : [],
  });
  const on = byVariant(records, "on");
  assert.equal(on.notRun, null);
  assert.ok(on.capture);
  const summary = summarizeWaterRecords(records)["coast-50km"];
  assert.deepEqual(summary.waterDialsAbsent, ["globalWaterMask"]);
});

test("N1: a non-water dial that did not apply blocks the page under either arm", async () => {
  for (const arm of ["before", "after"]) {
    const { records } = await runPages({
      arm,
      cells: "coast-50km",
      outName: `n1c-${arm}`,
      notApplied: () => ["terrain"],
    });
    for (const rec of records) {
      assert.equal(typeof rec.notRun, "string", `${arm} ${rec.variant}`);
      assert.ok(rec.notRun.includes("terrain"), rec.notRun);
      assert.ok(!rec.capture);
    }
  }
});

test("N1: a water dial the rig set to false that did not apply neither blocks nor stops a capture, even under --arm after", async () => {
  const { records } = await runPages({
    arm: "after",
    cells: "coast-50km",
    outName: "n1d",
    notApplied: (rigId) =>
      rigId === "water-coast-50km-off"
        ? ["globalWaterMask", "enableEnhancedOcean"]
        : [],
  });
  const off = byVariant(records, "off");
  assert.equal(off.notRun, null);
  assert.ok(off.capture);
});

test("N1: a clean page opens the rig's page on the requested renderer and captures it", async () => {
  const { records, log } = await runPages({
    arm: "after",
    cells: "orbit-disc",
    outName: "n1e",
  });
  assert.equal(records.length, 2);
  assert.ok(records.every((r) => r.notRun === null && r.capture));
  assert.equal(log.urls.length, 2);
  assert.ok(
    log.urls.every((u) => u.includes("renderer=webgl")),
    log.urls.join("\n"),
  );
  assert.ok(fs.existsSync(records[0].capture.path));
});

test("N2: cell 1f with ion declared unavailable (--no-ion) is NOT RUN: ion on every renderer, opens no page and captures nothing", async () => {
  const log = { urls: [], contexts: 0 };
  const records = await descriptor.cells({
    browser: makeFakeBrowser(log),
    run: 0,
    options: {
      arm: "before",
      cells: "1f",
      renderers: ["webgl", "webgpu"],
      noIon: true,
    },
    origin: "http://localhost:8080",
    outputDirectory: path.join(TEMP_ROOT, "n2"),
    captures: [],
  });
  assert.equal(records.length, 2);
  for (const rec of records) {
    assert.equal(rec.notRun, "NOT_RUN: ion");
    assert.ok(!rec.capture);
    assert.equal(rec.demo.status, "NOT_RUN");
    assert.equal(
      rec.demo.record.demoId,
      "globe-materials-water-mask-elevation-map",
    );
    assert.equal(rec.demo.record.frames, 240);
    assert.equal(rec.demo.record.renderer, rec.renderer);
    assert.equal(rec.demo.record.origin, "http://localhost:8080");
  }
  assert.equal(log.urls.length, 0, "no page may be navigated");
  const summaryMap = summarizeWaterRecords(records);
  const summary = summaryMap["1f"];
  assert.equal(summary.notRun.length, 2);
  assert.equal(summary.repeatPct.webgl, null);
  const verdicts = waterVerdicts(records, summaryMap, null, { arm: "before" });
  assert.ok(
    verdicts
      .filter((v) => v.id.endsWith(":stage"))
      .every((v) => v.pass === false && v.notRun === true),
  );
});
