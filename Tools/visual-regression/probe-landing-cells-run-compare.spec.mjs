// probe-landing-cells-run-compare.spec.mjs - runProbe, comparison and the offline query. Pure Node: no browser, no GPU.
// @purpose Drives runProbe on a stub browser and the comparison readers of probe-landing-cells: the clean and blocked exits (P4), the arm compare (P5), the comparison inputs (P6) and the page queries (P7).
// @status ACTIVE
//
// One part of the probe-landing-cells spec, split by concern (row DX-KIT-LANDING-SPECS-OVER-SIZE); the
// test names and bodies are unchanged. The fixtures it shares with its siblings live in
// fixtures/probe-landing-cells-support.mjs. Written from _lane-out/BEHAVIOUR_CELOS.md and the lead
// additions named on each test.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  PROBE_EXIT_CODES,
  ProbeRefusal,
  runProbe,
  sha256,
} from "./lib/probe-runtime.mjs";
import { makeFakeBrowser, makeSmallPng } from "./lib/landing-fake-browser.mjs";
import {
  compareArms,
  descriptor,
  readComparisonInputs,
} from "./probe-landing-cells.mjs";

// A per-run root under this lane's namespace: two runs of this spec at once
// (two lanes, or a lane and the seat) must not share, or delete, each other's
// fixtures.
let TEMP_ROOT = "";

before(() => {
  TEMP_ROOT = mkLaneTmp("probe-landing-cells-run-");
});

after(() => {
  removeLaneTmp(TEMP_ROOT);
});

// ---------------------------------------------------------------------------
// P4: runProbe integration with descriptor
// ---------------------------------------------------------------------------

test("P4: runProbe with clean stub returns exit code 0, array of cells, and receipt with arms key", async () => {
  const testDir = path.join(TEMP_ROOT, "p4-clean");
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const fakeBrowser = makeFakeBrowser(log);

  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
    ],
    launch: async () => fakeBrowser,
    preflight: async () => ({ ok: true, records: [] }),
  });

  assert.equal(code, PROBE_EXIT_CODES.OK, "clean stub run must exit 0");

  const reportPath = path.join(out, "landing-cells-report.json");
  assert.ok(
    fs.existsSync(reportPath),
    "landing-cells-report.json must be written",
  );
  const receipt = JSON.parse(fs.readFileSync(reportPath, "utf8"));

  assert.ok(Array.isArray(receipt.pages), "receipt pages must be an array");
  assert.equal(receipt.pages.length, 1);
  assert.ok(
    Object.hasOwn(receipt.arms, "E-O|webgpu|scene"),
    "receipt.arms must have key E-O|webgpu|scene",
  );
  assert.equal(receipt.arms["E-O|webgpu|scene"].runs, 1);
  assert.equal(receipt.arms["E-O|webgpu|scene"].notRun.length, 0);
});

test("P4: runProbe with unapplied non-water dial returns exit code 1", async () => {
  const testDir = path.join(TEMP_ROOT, "p4-unapplied");
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const fakeBrowser = makeFakeBrowser(log, { notApplied: ["msaaSamples"] });

  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
    ],
    launch: async () => fakeBrowser,
    preflight: async () => ({ ok: true, records: [] }),
  });

  assert.equal(code, 1, "unapplied dial run must exit 1");

  const reportPath = path.join(out, "landing-cells-report.json");
  assert.ok(fs.existsSync(reportPath));
  const receipt = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(receipt.arms["E-O|webgpu|scene"].notRun.length, 1);
});

// ---------------------------------------------------------------------------
// P5: compareArms
// ---------------------------------------------------------------------------

test("P5: compareArms reports base absent when arm key is missing in base", () => {
  const tipArms = {
    "E-O|webgpu|scene": {
      captures: [],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };
  const baseArms = {};
  const comparison = compareArms(tipArms, baseArms, {});
  assert.deepEqual(comparison["E-O|webgpu|scene"], { base: "absent" });
});

test("P5: compareArms diffs PNGs with tolerance 0 and reports changedPx === 0 for identical captures", () => {
  const testDir = path.join(TEMP_ROOT, "p5-identical");
  fs.mkdirSync(testDir, { recursive: true });
  const pngBase = path.join(testDir, "base.png");
  const pngTip = path.join(testDir, "tip.png");
  const buffer = makeSmallPng(4, 4, false);
  fs.writeFileSync(pngBase, buffer);
  fs.writeFileSync(pngTip, buffer);

  const key = "E-O|webgpu|scene";
  const tipArms = {
    [key]: {
      captures: [{ name: "tip-shot", path: pngTip }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };
  const baseArms = {
    [key]: {
      captures: [{ name: "base-shot", path: pngBase }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };

  const comparison = compareArms(tipArms, baseArms, {});
  const pixels = comparison[key].pixels;
  assert.ok(pixels);
  assert.equal(pixels.measured, true);
  assert.equal(pixels.tolerance, 0);
  assert.equal(pixels.changedPx, 0);
  assert.equal(pixels.base, "base-shot");
  assert.equal(pixels.tip, "tip-shot");
});

test("P5: compareArms diffs PNGs with tolerance 0 and reports changedPx > 0 for different captures", () => {
  const testDir = path.join(TEMP_ROOT, "p5-diff");
  fs.mkdirSync(testDir, { recursive: true });
  const pngBase = path.join(testDir, "base.png");
  const pngTip = path.join(testDir, "tip.png");
  fs.writeFileSync(pngBase, makeSmallPng(4, 4, false));
  fs.writeFileSync(pngTip, makeSmallPng(4, 4, true));

  const key = "E-O|webgpu|scene";
  const tipArms = {
    [key]: {
      captures: [{ name: "tip-shot", path: pngTip }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };
  const baseArms = {
    [key]: {
      captures: [{ name: "base-shot", path: pngBase }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };

  const comparison = compareArms(tipArms, baseArms, {});
  const pixels = comparison[key].pixels;
  assert.ok(pixels);
  assert.equal(pixels.measured, true);
  assert.equal(pixels.tolerance, 0);
  assert.equal(pixels.changedPx, 1);
});

test("P5: compareArms reports unmeasured when image dimensions differ", () => {
  const testDir = path.join(TEMP_ROOT, "p5-mismatch");
  fs.mkdirSync(testDir, { recursive: true });
  const pngBase = path.join(testDir, "base.png");
  const pngTip = path.join(testDir, "tip.png");
  fs.writeFileSync(pngBase, makeSmallPng(4, 4, false));
  fs.writeFileSync(pngTip, makeSmallPng(8, 8, false));

  const key = "E-O|webgpu|scene";
  const tipArms = {
    [key]: {
      captures: [{ name: "tip-shot", path: pngTip }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };
  const baseArms = {
    [key]: {
      captures: [{ name: "base-shot", path: pngBase }],
      inputs: { pf1: [], pf2: [], pf3: [], pf4: [] },
      deviceLoss: [],
    },
  };

  const comparison = compareArms(tipArms, baseArms, {});
  const pixels = comparison[key].pixels;
  assert.ok(pixels);
  assert.equal(pixels.measured, false);
  assert.match(pixels.reason, /size 4x4 vs 8x8/);
});

// ---------------------------------------------------------------------------
// P6: readComparisonInputs
// ---------------------------------------------------------------------------

test("P6: readComparisonInputs records bandsFile path and sha256", () => {
  const testDir = path.join(TEMP_ROOT, "p6-bands");
  fs.mkdirSync(testDir, { recursive: true });
  const bandsPath = path.join(testDir, "bands.json");
  const bandsData = JSON.stringify({ repeatFactor: 2.5 });
  fs.writeFileSync(bandsPath, bandsData);

  const result = readComparisonInputs({ bands: bandsPath });
  assert.ok(result.bandsFile);
  assert.equal(result.bandsFile.path, path.resolve(bandsPath));
  assert.equal(
    result.bandsFile.sha256,
    sha256(Buffer.from(bandsData)),
    "sha256 must match bytes of bands file",
  );
  assert.equal(result.bands.repeatFactor, 2.5);
});

test("P6: readComparisonInputs refuses base report with no arms with base-report-invalid", () => {
  const testDir = path.join(TEMP_ROOT, "p6-bad-base");
  fs.mkdirSync(testDir, { recursive: true });
  const baseReportPath = path.join(testDir, "bad-report.json");
  fs.writeFileSync(baseReportPath, JSON.stringify({ notArms: {} }));

  assert.throws(
    () => readComparisonInputs({ baseReport: baseReportPath }),
    (err) => {
      assert.ok(err instanceof ProbeRefusal);
      assert.equal(err.reason, "base-report-invalid");
      return true;
    },
  );
});

test("P6: readComparisonInputs parses valid base report and resolves bands", () => {
  const testDir = path.join(TEMP_ROOT, "p6-valid-base");
  fs.mkdirSync(testDir, { recursive: true });
  const baseReportPath = path.join(testDir, "valid-report.json");
  const baseReport = { arms: { "E-O|webgpu|scene": {} } };
  fs.writeFileSync(baseReportPath, JSON.stringify(baseReport));

  const result = readComparisonInputs({ baseReport: baseReportPath });
  assert.deepEqual(result.base, baseReport);
  assert.ok(result.bands);
  assert.equal(result.bandsFile, null);
});

// ---------------------------------------------------------------------------
// P7: page query parameters (ROUND 2)
// ---------------------------------------------------------------------------

test("P7: every page opened has renderer in its query", async () => {
  const testDir = path.join(TEMP_ROOT, "p7-renderer");
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const fakeBrowser = makeFakeBrowser(log);

  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
    ],
    launch: async () => fakeBrowser,
    preflight: async () => ({ ok: true, records: [] }),
  });

  assert.equal(code, PROBE_EXIT_CODES.OK);
  assert.ok(log.urls.length > 0, "at least one page navigation recorded");
  for (const pageUrl of log.urls) {
    const parsed = new URL(pageUrl);
    assert.equal(
      parsed.searchParams.get("renderer"),
      "webgpu",
      `query must have renderer=webgpu: ${pageUrl}`,
    );
  }
});

test("P7: (ROUND 2) every page opened has offline=true in its query", async () => {
  const testDir = path.join(TEMP_ROOT, "p7-offline");
  fs.mkdirSync(testDir, { recursive: true });
  const out = path.join(testDir, "out");
  const log = {
    events: [],
    scripts: [],
    urls: [],
    selectors: [],
    contexts: [],
  };
  const fakeBrowser = makeFakeBrowser(log);

  const code = await runProbe(descriptor, {
    argv: [
      "--repository-root",
      testDir,
      "--output",
      out,
      "--runs",
      "1",
      "--cells",
      "E-O",
      "--no-serve-built",
    ],
    launch: async () => fakeBrowser,
    preflight: async () => ({ ok: true, records: [] }),
  });

  assert.equal(code, PROBE_EXIT_CODES.OK);
  assert.ok(log.urls.length > 0, "at least one page navigation recorded");
  for (const pageUrl of log.urls) {
    const parsed = new URL(pageUrl);
    assert.equal(
      parsed.searchParams.get("offline"),
      "true",
      `query must include offline=true: ${pageUrl}`,
    );
  }
});
