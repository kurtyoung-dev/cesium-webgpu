// landing-report-frame-paths.spec.mjs - Behaviour spec for lib/report-frame-paths.mjs and its three call sites (no browser).
// @purpose Asserts that a landing report stores each frame path relative to its own folder (POSIX), that a base report and a --merge-reports prior are read with their frames resolved against THEIR folder (an existing absolute path is accepted), that a report written in one folder, copied whole to another and read from there as --base-report measures 0 changed pixels, that a base frame that is not on disk reads pixels {measured false, verdict not-run, reason base-frames-missing} with the path and original error kept and the exit and verdicts unchanged, and that the resolver, both probe call sites and the classification are live (inertness mutants).
// @status ACTIVE
//
// The runs go through the real `runProbe` over the fake browser (a report
// written to disk, the frames beside it, the capture manifest validated), so the
// round trip is the one an Edge leg makes: write a report, move the folder, read
// it back as `--base-report`.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";

import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { PROBE_EXIT_CODES, exitCodeForOutcome } from "./lib/probe-refusal.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import { compareArms, landingVerdicts } from "./lib/landing-verdicts.mjs";
import { isRelativePosixPath } from "./lib/relative-path.mjs";
import * as frames from "./lib/report-frame-paths.mjs";
import {
  descriptor,
  groupArms,
  pagesWithMergedRuns,
  readComparisonInputs,
  readMergeReports,
} from "./probe-landing-cells.mjs";
import {
  landingRunners,
  pfRecord,
  reportOf,
  writePng,
} from "./fixtures/probe-landing-cells-support.mjs";

let TEMP_ROOT = "";

before(() => {
  TEMP_ROOT = mkLaneTmp("landing-report-frame-paths-");
});

after(() => {
  removeLaneTmp(TEMP_ROOT);
});

const { p14Run } = landingRunners(() => TEMP_ROOT);

const here = path.dirname(fileURLToPath(import.meta.url));
const PIECE = path.join(here, "lib/report-frame-paths.mjs");
const PROBE = path.join(here, "probe-landing-cells.mjs");
const VERDICTS = path.join(here, "lib/landing-verdicts.mjs");

const REPORT = "landing-cells-report.json";
const RUN_ARGS = ["--cells", "E-D", "--no-wait-pipelines"];

/** A run of the real probe over the fake browser; its folder is `<name>/out`. */
async function produce(name, extraArgs = [], probe = descriptor) {
  const result = await p14Run(name, [...RUN_ARGS, ...extraArgs], {}, probe);
  return { ...result, out: path.join(TEMP_ROOT, name, "out") };
}

/** `comparison[arm].pixels` of a report, keyed by arm. */
const pixelsOf = (report) =>
  Object.fromEntries(
    Object.entries(report.comparison).map(([arm, entry]) => [
      arm,
      entry.pixels,
    ]),
  );

/** The verdicts that carry the pass/fail of a run, without any wall-clock field. */
const verdictSummary = (verdicts) =>
  verdicts.map(({ id, pass, notRun }) => [id, pass, notRun === true]);

/** Copy a report folder whole to a new place and delete the original. */
function moveFolder(from, to) {
  fs.cpSync(from, to, { recursive: true });
  fs.rmSync(from, { recursive: true, force: true });
}

/** A one-arm landing report in `dir` whose frame is `frameName`, written beside it. */
function writeBaseReport(dir, { frameName = "base.png", recordedPath } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = writePng(path.join(dir, frameName), 0);
  const capture = {
    name: "base",
    path: recordedPath ?? frameName,
    sha256: "0".repeat(64),
  };
  const report = reportOf([pfRecord({ run: 0, capture })]);
  const reportFile = path.join(dir, REPORT);
  fs.writeFileSync(reportFile, JSON.stringify(report));
  return { reportFile, frameFile: file };
}

/** The tip's arms: one run whose first capture is a real PNG in `dir`. */
function tipArmsIn(dir, changed = 0) {
  fs.mkdirSync(dir, { recursive: true });
  const tipFile = writePng(path.join(dir, "tip.png"), changed);
  return groupArms([
    pfRecord({ run: 0, capture: { name: "tip", path: tipFile } }),
  ]);
}

const ARM = "E-D|webgpu|scene";

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

test("R1: a report written by the probe stores every frame path relative to its own folder, and the frames and the capture manifest are there", async () => {
  const run = await produce("r1");
  assert.equal(run.code, 0);
  const recorded = [
    ...run.report.pages.flatMap((page) => [page.capture?.path]),
    ...Object.values(run.report.arms).flatMap((arm) =>
      arm.captures.map((capture) => capture.path),
    ),
  ];
  assert.equal(recorded.length, 4, "two pages and two arms");
  for (const file of recorded) {
    assert.equal(
      isRelativePosixPath(file),
      true,
      `${file} is a relative POSIX path`,
    );
    assert.equal(
      fs.existsSync(path.join(run.out, file)),
      true,
      `${file} resolves beside the report`,
    );
  }
  assert.equal(run.report.captureManifest.written, true);
  assert.deepEqual(run.report.captureManifest.violations, []);
});

test("R2: relativizeFramePaths leaves a frame outside the folder absolute and never changes its input", () => {
  const inside = path.join(TEMP_ROOT, "r2", "report", "a.png");
  const outside = path.join(TEMP_ROOT, "r2", "elsewhere", "b.png");
  const pages = [
    pfRecord({ run: 0, capture: { name: "a", path: inside } }),
    pfRecord({ run: 1, capture: { name: "b", path: outside } }),
  ];
  const before = structuredClone(pages);
  const written = frames.relativizeFramePaths(
    pages,
    path.join(TEMP_ROOT, "r2", "report"),
  );
  assert.equal(written[0].capture.path, "a.png");
  assert.equal(written[1].capture.path, outside);
  assert.deepEqual(pages, before);
});

// ---------------------------------------------------------------------------
// The readers
// ---------------------------------------------------------------------------

test("R3: a base report's relative frame resolves against the base report's folder, not the working directory or the tip's", () => {
  const dir = path.join(TEMP_ROOT, "r3");
  const { reportFile, frameFile } = writeBaseReport(dir);
  const { base } = readComparisonInputs({
    baseReport: reportFile,
    noWaitPipelines: true,
  });
  assert.equal(base.pages[0].capture.path, path.resolve(frameFile));
  assert.equal(base.arms[ARM].captures[0].path, path.resolve(frameFile));
  const comparison = compareArms(
    tipArmsIn(path.join(dir, "tip")),
    base.arms,
    {},
  );
  assert.equal(comparison[ARM].pixels.measured, true);
  assert.equal(comparison[ARM].pixels.changedPx, 0);
});

test("R4: an absolute frame path that exists is accepted as written (a report banked before this change)", () => {
  const frameDir = path.join(TEMP_ROOT, "r4-frames");
  fs.mkdirSync(frameDir, { recursive: true });
  const frameFile = writePng(path.join(frameDir, "old.png"), 0);
  const { reportFile } = writeBaseReport(path.join(TEMP_ROOT, "r4-report"), {
    recordedPath: frameFile,
  });
  const { base } = readComparisonInputs({
    baseReport: reportFile,
    noWaitPipelines: true,
  });
  assert.equal(base.arms[ARM].captures[0].path, frameFile);
  const comparison = compareArms(
    tipArmsIn(path.join(TEMP_ROOT, "r4-tip"), 2),
    base.arms,
    {},
  );
  assert.equal(comparison[ARM].pixels.measured, true);
  assert.equal(comparison[ARM].pixels.changedPx, 2);
});

test("R5: a --merge-reports prior's relative frames resolve against the prior's folder", () => {
  const dir = path.join(TEMP_ROOT, "r5");
  const { reportFile, frameFile } = writeBaseReport(dir);
  const prior = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  prior.preflight = { ok: true, records: [] };
  fs.writeFileSync(reportFile, JSON.stringify(prior));
  const options = {
    mergeReports: reportFile,
    repositoryRoot: dir,
    frames: 120,
    warmup: 30,
    passFrames: 60,
    perf: true,
    runs: 1,
    noWaitPipelines: true,
  };
  const priors = readMergeReports(options);
  assert.equal(priors[0].report.pages[0].capture.path, path.resolve(frameFile));
  const merged = pagesWithMergedRuns([pfRecord({ run: 0 })], options, priors);
  assert.equal(merged[0].capture.path, path.resolve(frameFile));
  assert.equal(fs.existsSync(merged[0].capture.path), true);
});

// ---------------------------------------------------------------------------
// The round trip and the missing frame
// ---------------------------------------------------------------------------

test("R6: a report written in folder A, copied whole to B and A deleted, read from B as --base-report measures 0 changed pixels on every arm", async () => {
  const written = await produce("r6-a");
  moveFolder(written.out, path.join(TEMP_ROOT, "r6-moved"));
  assert.equal(fs.existsSync(written.out), false);
  const tip = await produce("r6-tip", [
    "--base-report",
    path.join(TEMP_ROOT, "r6-moved", REPORT),
  ]);
  const pixels = pixelsOf(tip.report);
  assert.deepEqual(Object.keys(pixels).sort(), [
    "E-D|webgl|scene",
    "E-D|webgpu|scene",
  ]);
  for (const entry of Object.values(pixels)) {
    assert.equal(entry.measured, true);
    assert.equal(entry.changedPx, 0);
    assert.equal(entry.verdict, "within");
  }
  assert.equal(tip.report.captureManifest.written, true);
  assert.deepEqual(tip.report.captureManifest.violations, []);
});

test("R7: a base frame that is not on disk reads base-frames-missing with the path and the original error kept, and the run's exit and verdicts are those of a measured base", async () => {
  const written = await produce("r7-a");
  const measuredBase = path.join(TEMP_ROOT, "r7-measured");
  fs.cpSync(written.out, measuredBase, { recursive: true });
  const reportOnly = path.join(TEMP_ROOT, "r7-report-only");
  fs.mkdirSync(reportOnly, { recursive: true });
  fs.copyFileSync(
    path.join(written.out, REPORT),
    path.join(reportOnly, REPORT),
  );

  const measured = await produce("r7-measured-tip", [
    "--base-report",
    path.join(measuredBase, REPORT),
  ]);
  const missing = await produce("r7-missing-tip", [
    "--base-report",
    path.join(reportOnly, REPORT),
  ]);

  for (const [arm, entry] of Object.entries(pixelsOf(missing.report))) {
    assert.equal(entry.measured, false, arm);
    assert.equal(entry.verdict, "not-run", arm);
    assert.equal(entry.reason, "base-frames-missing", arm);
    assert.equal(
      entry.detail.path,
      path.join(reportOnly, `${arm.split("|").slice(0, 2).join("-")}-run0.png`),
    );
    assert.match(entry.detail.error, /ENOENT/);
    assert.equal(entry.changedPx, undefined);
  }
  // The exit code also carries the PF verdicts, which read the live machine
  // CPU and differ between two runs on a busy machine; R8 pins the exit.
  assert.deepEqual(
    verdictSummary(missing.verdicts),
    verdictSummary(measured.verdicts),
  );
  assert.equal(
    missing.verdicts.some((verdict) => /pixel/i.test(verdict.id)),
    false,
  );
});

test("R8: a not-run pixel comparison adds no verdict and a run that is otherwise clean still exits 0", () => {
  const notRun = {
    measured: false,
    verdict: "not-run",
    reason: "base-frames-missing",
  };
  const arm = { pf1: { metric: "PF-1", verdict: "within" } };
  const clean = landingVerdicts([], { [ARM]: arm });
  const withNotRun = landingVerdicts([], { [ARM]: { ...arm, pixels: notRun } });
  assert.deepEqual(withNotRun, clean);
  assert.equal(
    exitCodeForOutcome({ refusal: null, errored: false, verdicts: withNotRun }),
    PROBE_EXIT_CODES.OK,
  );
});

test("R9: a frame the base report names absolutely into a folder that is gone is base-frames-missing, and a frame that cannot be read for another reason is not relabelled", () => {
  const gone = path.join(TEMP_ROOT, "r9", "deleted-clone", "frame.png");
  const result = frames.baseFrameMissing({ name: "x", path: gone });
  assert.equal(result.reason, "base-frames-missing");
  assert.equal(result.detail.path, gone);
  assert.equal(frames.baseFrameMissing({ name: "x" }), null);
  const denied = Object.assign(new Error("EACCES: denied"), {
    code: "EACCES",
  });
  assert.equal(
    frames.baseFrameMissing({ path: gone }, () => {
      throw denied;
    }),
    null,
  );
});

// ---------------------------------------------------------------------------
// Inertness mutants
// ---------------------------------------------------------------------------

/** What each mutant is observed through: a base report in its own folder. */
function observeRead(module) {
  const dir = path.join(
    TEMP_ROOT,
    `obs-${Math.random().toString(36).slice(2)}`,
  );
  const { reportFile } = writeBaseReport(dir);
  const { base } = module.readComparisonInputs({
    baseReport: reportFile,
    noWaitPipelines: true,
  });
  return fs.existsSync(base.arms[ARM].captures[0].path);
}

test("INERTNESS: with the report-folder resolution unreachable a relative frame is not found beside its report", async () => {
  const mutated = await importMutated(PIECE, [
    [
      'if (typeof recorded === "string" && isRelativePosixPath(recorded)) {',
      'if (false && typeof recorded === "string" && isRelativePosixPath(recorded)) {',
    ],
  ]);
  const dir = path.join(TEMP_ROOT, "m1");
  const { reportFile } = writeBaseReport(dir);
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  const resolved = (module) =>
    fs.existsSync(
      module.resolveFramePaths(report, reportFile).pages[0].capture.path,
    );
  assert.equal(resolved(frames), true);
  assert.equal(resolved(mutated), false);
});

test("INERTNESS: with the probe's base-report resolution skipped a relative base frame is not found", async () => {
  const mutated = await importMutated(PROBE, [
    [
      "base = resolveFramePaths(base, path.resolve(options.baseReport));",
      "base = base;",
    ],
  ]);
  assert.equal(observeRead({ readComparisonInputs }), true);
  assert.equal(observeRead(mutated), false);
});

test("INERTNESS: with the probe's report relativization skipped the report holds absolute frame paths", async () => {
  const mutated = await importMutated(PROBE, [
    [
      "      pages: reportPages,\n      arms: groupArms(reportPages),",
      "      pages,\n      arms,",
    ],
  ]);
  const real = await produce("m3-real");
  const broken = await produce("m3-broken", [], mutated.descriptor);
  assert.equal(isRelativePosixPath(real.report.pages[0].capture.path), true);
  assert.equal(isRelativePosixPath(broken.report.pages[0].capture.path), false);
});

test("INERTNESS: with the missing-frame classification unreachable in compareArms the pixel record is the ENOENT message", async () => {
  const mutated = await importMutated(VERDICTS, [
    [
      "const diff = baseFrameMissing(baseShot) ?? pixelDiff(baseShot, tipShot);",
      "const diff = pixelDiff(baseShot, tipShot);",
    ],
  ]);
  const base = groupArms([
    pfRecord({
      run: 0,
      capture: { name: "gone", path: path.join(TEMP_ROOT, "m4", "gone.png") },
    }),
  ]);
  const tip = tipArmsIn(path.join(TEMP_ROOT, "m4-tip"));
  assert.equal(
    compareArms(tip, base, {})[ARM].pixels.reason,
    "base-frames-missing",
  );
  assert.notEqual(
    mutated.compareArms(tip, base, {})[ARM].pixels.reason,
    "base-frames-missing",
  );
});

test("INERTNESS: with the missing-code test unreachable in the piece a missing base frame is not classified", async () => {
  const mutated = await importMutated(PIECE, [
    ["if (!MISSING_CODES.has(error?.code)) {", "if (true) {"],
  ]);
  const shot = { name: "x", path: path.join(TEMP_ROOT, "m5", "gone.png") };
  assert.equal(frames.baseFrameMissing(shot).reason, "base-frames-missing");
  assert.equal(mutated.baseFrameMissing(shot), null);
});

test("R10: a report that carries arms and no pages (a reader that does not regroup) has its arms' frames resolved against its own folder", () => {
  const dir = path.join(TEMP_ROOT, "r10-report");
  const reportFile = path.join(dir, "landing-cells-report.json");
  const report = {
    arms: {
      [ARM]: {
        captures: [
          { name: "a-run0", path: "a-run0.png" },
          { name: "b-run1", path: "nested/b-run1.png" },
        ],
      },
    },
  };
  const resolved = frames.resolveFramePaths(report, reportFile);
  assert.deepEqual(
    resolved.arms[ARM].captures.map((capture) => capture.path),
    [path.resolve(dir, "a-run0.png"), path.resolve(dir, "nested/b-run1.png")],
  );
  // A copy: the parsed report keeps what it read.
  assert.equal(report.arms[ARM].captures[0].path, "a-run0.png");
});
