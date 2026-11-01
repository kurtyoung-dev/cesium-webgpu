// landing-pf-prime-quiet.spec.mjs - the prime page repeats until the machine is quiet. Pure Node: no browser, no GPU, no sleep, no live CPU value.
// @purpose Asserts by what a receipt reader sees that lib/landing-pf-prime.mjs repeats its unmeasured prime page until the page's CPU, a short post-page sample and (with a base report) the base arm's mean all read quiet, stops at a bounded page budget, reads both thresholds from the bands, records every page's CPU and duration and why it stopped, takes no sample under --no-warm-up, and shows the same record in the receipt, the summary's Prime line and every PF verdict over the fake browser; each clause has an inertness mutant.
// @status ACTIVE
//
// The series under test are the spec's own: direct calls take a runPage that answers canned page records and an
// injected sampler and clock; the end-to-end case supplies them through the page-runner wrapper (the page record's
// CPU) and descriptor.warmUpDeps.prime (the sampler and the page-CPU reader). The fake browser's own seam answer
// (always quiet) is only asserted as the default that makes a fake run instant. liveSamplerReads() must not move.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import { INSTANT_WARM_UP, liveSamplerReads } from "./lib/cpu-warm-up.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  POST_PRIME_SAMPLES,
  PRIME_MAX_PAGES,
  primeBeforeFirstArm,
} from "./lib/landing-pf-prime.mjs";
import { descriptor, runLandingPage } from "./probe-landing-cells.mjs";
import { landingRunners } from "./fixtures/probe-landing-cells-support.mjs";

let TEMP_ROOT = "";
const liveReadsAtStart = liveSamplerReads();
before(() => {
  TEMP_ROOT = mkLaneTmp("landing-pf-prime-quiet-");
});
after(() => {
  removeLaneTmp(TEMP_ROOT);
});

const PRIME_MODULE = fileURLToPath(
  new URL("./lib/landing-pf-prime.mjs", import.meta.url),
);

const ENTRY = { cell: "E-ID-cv", renderer: "webgl", page: "scene" };
const KEY = "E-ID-cv|webgl|scene";
const PF = { perf: true };

/**
 * Drives `piece.primeBeforeFirstArm` over canned pages. `pages` is the CPU of
 * each prime page in order (the last repeats), `post` the sample series (the
 * last repeats), every page takes `pageMs` and every sample `sampleMs` of a
 * fake clock, so durations are exact and nothing sleeps.
 */
async function drive(
  piece,
  {
    pages,
    post = [10],
    pageMs = 100,
    sampleMs = 1000,
    options = PF,
    plan = [ENTRY],
    base,
    bands,
    pageCpu = true,
    pageRecord,
  } = {},
) {
  let time = 0;
  let loads = 0;
  let samples = 0;
  const record = await piece.primeBeforeFirstArm({
    options,
    plan,
    base,
    bands,
    runPage: async () => {
      const cpu = pages[Math.min(loads, pages.length - 1)];
      loads += 1;
      time += pageMs;
      return pageRecord ? pageRecord(cpu) : { cpu: { mean: cpu } };
    },
    deps: {
      sampleCpu: async () => {
        const value = post[Math.min(samples, post.length - 1)];
        samples += 1;
        time += sampleMs;
        return value;
      },
      ...(pageCpu ? { pageCpu: (page) => page?.cpu?.mean } : {}),
      now: () => time,
    },
  });
  return { record, loads, samples };
}

const REAL = { primeBeforeFirstArm };

test("a hot-then-quiet series stops at the first quiet page, listing every page's CPU and duration in order", async () => {
  const { record, loads, samples } = await drive(REAL, {
    pages: [83, 71, 30],
    post: [18.2],
  });
  assert.equal(loads, 3);
  assert.equal(record.status, "primed");
  assert.equal(record.stoppedBecause, "quiet");
  assert.deepEqual(
    record.pages.map((page) => page.cpuMean),
    [83, 71, 30],
  );
  assert.deepEqual(
    record.pages.map((page) => page.durationMs),
    [100, 100, 100],
  );
  assert.deepEqual(
    record.pages.map((page) => page.index),
    [0, 1, 2],
  );
  assert.deepEqual(
    record.pages.map((page) => page.quiet),
    [false, false, true],
  );
  // Only the quiet page took the post-page sample.
  assert.equal(samples, POST_PRIME_SAMPLES);
  assert.deepEqual(
    record.pages.map((page) => page.postSample.length),
    [0, 0, POST_PRIME_SAMPLES],
  );
  assert.match(record.pages[0].why[0], /^page CPU 83 % above 60 %$/);
  assert.deepEqual(record.pages[2].why, []);
  // The whole prime: three pages and the post samples.
  assert.equal(record.durationMs, 300 + POST_PRIME_SAMPLES * 1000);
  assert.equal(record.cpuMean, 30);
  assert.equal(record.cpuSource, "injected");
  assert.equal(record.sampler, "injected");
  assert.equal(
    record.note,
    `prime: 3 pages of E-ID-cv webgl scene, stopped quiet, last at 30 % CPU (post-prime peak 18.2 %)`,
  );
});

test("a quiet first page stops the prime at one page", async () => {
  const { record, loads } = await drive(REAL, { pages: [20] });
  assert.equal(loads, 1);
  assert.equal(record.stoppedBecause, "quiet");
  assert.match(record.note, /^prime: 1 page of E-ID-cv webgl scene, stopped/);
});

test("a never-quiet series stops at the page budget and says budget", async () => {
  const { record, loads, samples } = await drive(REAL, { pages: [90] });
  assert.equal(loads, PRIME_MAX_PAGES);
  assert.equal(record.pages.length, PRIME_MAX_PAGES);
  assert.equal(record.status, "primed");
  assert.equal(record.stoppedBecause, "budget");
  assert.equal(
    record.pages.every((page) => page.quiet === false),
    true,
  );
  assert.equal(samples, 0, "a hot page is followed by a load, not a sample");
  assert.match(
    record.note,
    new RegExp(
      `^prime: ${PRIME_MAX_PAGES} pages of E-ID-cv webgl scene, stopped budget, last at 90 % CPU$`,
    ),
  );
});

test("a quiet page whose post-prime sample is hot does not stop the prime", async () => {
  const { record, loads } = await drive(REAL, {
    pages: [30],
    post: [10, 75, 10, 10, 10, 10],
  });
  assert.equal(loads, 2);
  assert.equal(record.stoppedBecause, "quiet");
  assert.equal(record.pages[0].quiet, false);
  assert.deepEqual(record.pages[0].postSample, [10, 75, 10]);
  assert.deepEqual(record.pages[0].why, [
    "post-prime sample 1 75 % above 60 %",
  ]);
  assert.equal(record.pages[1].quiet, true);
});

test("a post-prime sample exactly at the threshold is quiet; one that was not read is not", async () => {
  const at = await drive(REAL, { pages: [30], post: [60] });
  assert.equal(
    at.loads,
    1,
    "the guard reads contended only above the threshold",
  );
  const unread = await drive(REAL, { pages: [30], post: [null] });
  assert.equal(unread.loads, PRIME_MAX_PAGES);
  assert.equal(unread.record.stoppedBecause, "budget");
  assert.deepEqual(unread.record.pages[0].postSample, [null, null, null]);
  assert.equal(unread.record.pages[0].why[0], "post-prime sample 0 not read");
});

test("a page whose CPU was not read is not quiet", async () => {
  const { record, loads } = await drive(REAL, {
    pages: [null],
    pageRecord: () => ({ cpu: null }),
  });
  assert.equal(loads, PRIME_MAX_PAGES);
  assert.equal(record.stoppedBecause, "budget");
  assert.equal(record.cpuMean, null);
  assert.deepEqual(record.pages[0].why, ["page CPU not read"]);
  assert.match(record.note, /last \(CPU not read\)$/);
});

test("with a base report, a page under the threshold but outside the arm delta does not stop; within the delta it does", async () => {
  const base = { arms: { [KEY]: { inputs: { cpu: [60, 60] } } } };
  const outside = await drive(REAL, { pages: [30, 30, 45], base });
  assert.equal(outside.loads, 3, "30 is 30 points from 60: not quiet");
  assert.equal(outside.record.stoppedBecause, "quiet");
  assert.match(
    outside.record.pages[0].why[0],
    /^page CPU 30 % is 30 points from the base arm's 60 %, more than 20$/,
  );
  assert.equal(outside.record.pages[2].cpuMean, 45);
  const within = await drive(REAL, { pages: [45], base });
  assert.equal(within.loads, 1, "45 is 15 points from 60: quiet");
  const exactly = await drive(REAL, { pages: [40], base });
  assert.equal(exactly.loads, 1, "the guard reads a delta above, not at, 20");
});

test("a base report that did not read the prime's arm adds no delta clause", async () => {
  const other = { arms: { "E-X|webgl|scene": { inputs: { cpu: [60, 60] } } } };
  const { loads } = await drive(REAL, { pages: [30], base: other });
  assert.equal(loads, 1);
  const noCpu = { arms: { [KEY]: { inputs: { cpu: [] } } } };
  assert.equal((await drive(REAL, { pages: [30], base: noCpu })).loads, 1);
});

test("a --bands override of the thresholds moves the decision: both are read, not restated", async () => {
  const tight = await drive(REAL, {
    pages: [30],
    bands: { contendedCpuPct: 25 },
  });
  assert.equal(tight.loads, PRIME_MAX_PAGES, "30 % is hot under a 25 % bar");
  assert.equal(tight.record.pages[0].why[0], "page CPU 30 % above 25 %");
  const loose = await drive(REAL, {
    pages: [70],
    bands: { contendedCpuPct: 80 },
  });
  assert.equal(loose.loads, 1, "70 % is quiet under an 80 % bar");
  const base = { arms: { [KEY]: { inputs: { cpu: [60, 60] } } } };
  const widened = await drive(REAL, {
    pages: [30],
    base,
    bands: { cpuArmDeltaPct: 35 },
  });
  assert.equal(widened.loads, 1, "30 points is inside a 35-point delta");
  const narrowed = await drive(REAL, {
    pages: [45],
    base,
    bands: { cpuArmDeltaPct: 10 },
  });
  assert.equal(narrowed.loads, PRIME_MAX_PAGES, "15 points is outside 10");
});

test("--no-warm-up loads no page and takes no sample; a non-PF run loads and samples nothing", async () => {
  const skipped = await drive(REAL, {
    pages: [20],
    options: { perf: true, noWarmUp: true },
  });
  assert.equal(skipped.loads, 0);
  assert.equal(skipped.samples, 0);
  assert.equal(skipped.record.status, "skipped");
  assert.equal(skipped.record.stoppedBecause, "skipped");
  assert.deepEqual(skipped.record.pages, []);
  assert.equal(skipped.record.note, "prime: skipped (--no-warm-up)");
  const notPf = await drive(REAL, { pages: [20], options: {} });
  assert.equal(notPf.loads, 0);
  assert.equal(notPf.samples, 0);
  assert.equal(notPf.record.status, "not-a-pf-run");
  assert.equal(notPf.record.stoppedBecause, "not-a-pf-run");
  assert.equal(notPf.record.note, "prime: not a PF run");
});

test("a page that throws or did not run stops the prime as failed after the pages already loaded, and never rejects", async () => {
  let loads = 0;
  const throwing = await primeBeforeFirstArm({
    options: PF,
    plan: [ENTRY],
    runPage: async () => {
      loads += 1;
      if (loads === 2) {
        throw new Error("the context was lost");
      }
      return { cpu: { mean: 90 } };
    },
    deps: { sampleCpu: async () => 10 },
  });
  assert.equal(throwing.status, "failed");
  assert.equal(throwing.stoppedBecause, "failed");
  assert.equal(loads, 2);
  assert.deepEqual(
    throwing.pages.map((page) => page.cpuMean),
    [90],
  );
  assert.match(
    throwing.note,
    /^prime: E-ID-cv webgl scene failed after \d+ ms: the context was lost$/,
  );
  const notRun = await primeBeforeFirstArm({
    options: PF,
    plan: [ENTRY],
    runPage: async () => ({ notRun: "the stage did not apply" }),
    deps: { sampleCpu: async () => 10 },
  });
  assert.equal(notRun.status, "failed");
  assert.equal(notRun.stoppedBecause, "failed");
  assert.match(notRun.note, /the stage did not apply$/);
});

test("without a pageCpu seam the page record's own CPU decides and the record says page", async () => {
  const { record } = await drive(REAL, { pages: [40], pageCpu: false });
  assert.equal(record.cpuSource, "page");
  assert.equal(record.cpuMean, 40);
  assert.equal(record.stoppedBecause, "quiet");
});

// Through the probe over the fake browser. -------------------------------------

const { p14Run } = landingRunners(() => TEMP_ROOT);
const PF_ARGS = ["--perf", "--cells", "E-D", "--no-wait-pipelines"];

/** Runs the probe with the spec's runner and warm-up deps, restoring both. */
async function probeWith(name, runner, warmUpDeps, extraArgs = []) {
  const hadRunner = Object.hasOwn(descriptor, "pageRunner");
  const hadDeps = Object.hasOwn(descriptor, "warmUpDeps");
  const previousRunner = descriptor.pageRunner;
  const previousDeps = descriptor.warmUpDeps;
  descriptor.pageRunner = runner;
  if (warmUpDeps) {
    descriptor.warmUpDeps = warmUpDeps;
  }
  try {
    const result = await p14Run(name, [...PF_ARGS, ...extraArgs]);
    const summary = fs.readFileSync(
      path.join(TEMP_ROOT, name, "out", "landing-cells-summary.md"),
      "utf8",
    );
    return { ...result, summary };
  } finally {
    if (hadRunner) {
      descriptor.pageRunner = previousRunner;
    } else {
      delete descriptor.pageRunner;
    }
    if (hadDeps) {
      descriptor.warmUpDeps = previousDeps;
    } else {
      delete descriptor.warmUpDeps;
    }
  }
}

/** The real page path, its prime loads answering the series' CPU in order. */
function seriesRunner(series) {
  const primes = [];
  const runner = async (inputs) => {
    const record = await runLandingPage(inputs);
    if (inputs.prime !== true) {
      return record;
    }
    const mean = series[Math.min(primes.length, series.length - 1)];
    primes.push(mean);
    return { ...record, cpu: { mean, samples: [] } };
  };
  return { runner, primes };
}

/** A base report whose E-D arms carry the given per-run CPU means. */
async function craftedBase(name, cpuByRenderer) {
  await probeWith(name, seriesRunner([0]).runner);
  const dir = path.join(TEMP_ROOT, name, "out");
  const report = JSON.parse(
    fs.readFileSync(path.join(dir, "landing-cells-report.json"), "utf8"),
  );
  report.pages = report.pages.flatMap((page) =>
    cpuByRenderer[page.renderer].map((mean, run) => ({
      ...page,
      run,
      cpu: { mean, samples: [] },
    })),
  );
  const file = path.join(dir, "crafted-base-report.json");
  fs.writeFileSync(file, JSON.stringify(report));
  return file;
}

test("through runProbe: the receipt lists the pages, the summary prints the Prime line and every PF verdict carries the note", async () => {
  // The webgl base arm reads 60 %, so the 30 % page is quiet by itself but 30 points from the base.
  const baseFile = await craftedBase("quiet-base", {
    webgl: [60, 60],
    webgpu: [20, 20],
  });
  const { runner, primes } = seriesRunner([83, 71, 30, 48]);
  const { report, verdicts, summary } = await probeWith(
    "quiet-e2e",
    runner,
    {
      ...INSTANT_WARM_UP,
      prime: { sampleCpu: async () => 12, pageCpu: (page) => page.cpu?.mean },
    },
    ["--base-report", baseFile],
  );
  assert.deepEqual(primes, [83, 71, 30, 48]);
  const { prime } = report;
  assert.equal(prime.status, "primed");
  assert.equal(prime.stoppedBecause, "quiet");
  assert.deepEqual(
    prime.pages.map((page) => page.cpuMean),
    [83, 71, 30, 48],
  );
  assert.match(prime.pages[2].why[0], /30 points from the base arm's 60 %/);
  assert.equal(prime.cpuSource, "injected");
  assert.equal(prime.sampler, "injected");
  const note =
    "prime: 4 pages of E-D webgl scene, stopped quiet, last at 48 % CPU (post-prime peak 12 %)";
  assert.equal(prime.note, note);
  assert.ok(
    summary.includes(
      "Prime: 4 pages of E-D webgl scene, stopped quiet, last at 48 % CPU (post-prime peak 12 %)",
    ),
    "the summary's Prime line carries the new note",
  );
  const pf = verdicts.filter((verdict) => /:PF-[1-4]$/.test(verdict.id));
  assert.ok(pf.length > 0, "the run produced PF verdicts");
  for (const verdict of pf) {
    assert.equal(verdict.prime, note, verdict.id);
  }
  assert.equal(liveSamplerReads(), liveReadsAtStart);
});

test("through runProbe on the fake browser's own seam: the prime is one instant page and no live reading decides", async () => {
  const { runner, primes } = seriesRunner([99]);
  const { report } = await probeWith("quiet-default", runner);
  assert.equal(primes.length, 1, "the fake's seam reads quiet at once");
  assert.equal(report.prime.stoppedBecause, "quiet");
  assert.equal(report.prime.cpuSource, "injected");
  assert.equal(report.prime.sampler, "injected");
  assert.equal(report.prime.pages.length, 1);
  assert.equal(liveSamplerReads(), liveReadsAtStart);
});

// Inertness mutants. ----------------------------------------------------------

const STOP_ANCHOR = "      if (quiet || index === PRIME_MAX_PAGES - 1) {";

test("mutant M1: a quiet page that no longer stops the loop turns the stop-at-quiet case red", async () => {
  const mutated = await importMutated(PRIME_MODULE, [
    [
      STOP_ANCHOR,
      "      if ((false && quiet) || index === PRIME_MAX_PAGES - 1) {",
    ],
  ]);
  const input = { pages: [83, 71, 30], post: [18.2] };
  assert.equal((await drive(REAL, input)).record.pages.length, 3);
  const { record } = await drive(mutated, input);
  assert.equal(
    record.pages.length,
    PRIME_MAX_PAGES,
    "the mutant never stops early",
  );
  assert.notEqual(record.pages.length, 3);
  const base = { arms: { [KEY]: { inputs: { cpu: [60, 60] } } } };
  assert.equal((await drive(mutated, { pages: [30, 30, 45], base })).loads, 4);
});

test("mutant M2: a prime that stops after its first page turns the repeat case red", async () => {
  const mutated = await importMutated(PRIME_MODULE, [
    [
      STOP_ANCHOR,
      "      if (true || quiet || index === PRIME_MAX_PAGES - 1) {",
    ],
  ]);
  const { record, loads } = await drive(mutated, { pages: [83, 71, 30] });
  assert.equal(loads, 1, "the mutant stops after one page");
  assert.notEqual(record.pages.length, 3);
});

test("mutant M3: a post-prime sample that is never taken turns the hot-sample case red", async () => {
  const mutated = await importMutated(PRIME_MODULE, [
    [
      "      if (pageOnly.length === 0) {",
      "      if (false && pageOnly.length === 0) {",
    ],
  ]);
  const input = { pages: [30], post: [10, 75, 10, 10, 10, 10] };
  assert.equal((await drive(REAL, input)).loads, 2);
  const { loads, samples } = await drive(mutated, input);
  assert.equal(samples, 0);
  assert.equal(loads, 1, "the mutant stops on the hot-sample page");
});

test("mutant M4: a delta clause made unreachable and a threshold restated both turn the band cases red", async () => {
  const base = { arms: { [KEY]: { inputs: { cpu: [60, 60] } } } };
  const noDelta = await importMutated(PRIME_MODULE, [
    [
      "    if (delta > basis.cpuArmDeltaPct) {",
      "    if (false && delta > basis.cpuArmDeltaPct) {",
    ],
  ]);
  assert.equal((await drive(noDelta, { pages: [30], base })).loads, 1);
  assert.equal(
    (await drive(REAL, { pages: [30], base })).loads,
    PRIME_MAX_PAGES,
  );
  const literal = await importMutated(PRIME_MODULE, [
    [
      "const thresholdPct = resolveBands(bands).contendedCpuPct;",
      "const thresholdPct = 60;",
    ],
  ]);
  const tight = { pages: [30], bands: { contendedCpuPct: 25 } };
  assert.equal((await drive(REAL, tight)).loads, PRIME_MAX_PAGES);
  assert.equal((await drive(literal, tight)).loads, 1);
});

test("mutant M5: the --no-warm-up skip made unreachable turns the no-sample case red", async () => {
  const mutated = await importMutated(PRIME_MODULE, [
    [
      "if (options?.noWarmUp === true) {",
      "if (false && options?.noWarmUp === true) {",
    ],
  ]);
  const { loads } = await drive(mutated, {
    pages: [20],
    options: { perf: true, noWarmUp: true },
  });
  assert.equal(loads, 1, "the mutant primes under --no-warm-up");
});

test("this spec leaves the descriptor as it found it and no live machine reading was taken", () => {
  assert.equal(descriptor.pageRunner, undefined);
  assert.equal(descriptor.warmUpDeps, undefined);
  assert.equal(liveSamplerReads(), liveReadsAtStart);
});
