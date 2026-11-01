// landing-pf-prime.spec.mjs - the unmeasured prime page and the contention basis of a landing PF run. Pure Node: no browser, no GPU, no sleep, no live CPU value asserted.
// @purpose Asserts lib/landing-pf-prime.mjs by what a receipt reader sees: through runProbe over the fake browser, a PF run loads its first PF page once more than it plans (counted at the page-runner seam, the real page path behind it), the prime captures and writes nothing, --no-warm-up and a non-PF run load no prime, a failing prime never stops the run, and a paired run's receipt and PF verdicts carry the base arm's recorded CPU and the guard's clause threshold; each clause has an inertness mutant.
// @status ACTIVE
//
// The page runner is the seam (descriptor.pageRunner): the spec wraps the real runLandingPage, so every load
// goes through the page code the Edge run uses (navigation, stage, startup, settle) over the fake browser, and
// the wrapper counts and, for the failure cases, throws. No spec value is a live machine reading: the prime's
// CPU mean is asserted to be a number or null, or set by the wrapper (the wrapper does not answer the
// behaviour under test: whether and when the prime loads).

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { mkLaneTmp, removeLaneTmp } from "../lib/lane-tmp.mjs";
import {
  INSTANT_WARM_UP,
  liveSamplerReads,
  markPfVerdicts,
} from "./lib/cpu-warm-up.mjs";
import { importMutated } from "./lib/import-mutated.mjs";
import {
  contentionBasisOf,
  firstPfEntry,
  primeBeforeFirstArm,
} from "./lib/landing-pf-prime.mjs";
import { descriptor, runLandingPage } from "./probe-landing-cells.mjs";
import {
  landingRunners,
  withDiveGateAnswers,
} from "./fixtures/probe-landing-cells-support.mjs";

let TEMP_ROOT = "";
before(() => {
  TEMP_ROOT = mkLaneTmp("landing-pf-prime-");
});
after(() => {
  removeLaneTmp(TEMP_ROOT);
});

const { p14Run } = landingRunners(() => TEMP_ROOT);

const PRIME_MODULE = fileURLToPath(
  new URL("./lib/landing-pf-prime.mjs", import.meta.url),
);
const WARM_UP_MODULE = fileURLToPath(
  new URL("./lib/cpu-warm-up.mjs", import.meta.url),
);
const PROBE_MODULE = fileURLToPath(
  new URL("./probe-landing-cells.mjs", import.meta.url),
);

/**
 * A page runner over the real page path that counts every load. `onPrime`
 * may replace a prime load's answer (or throw); measured loads are never
 * touched.
 */
function countingRunner(onPrime = null) {
  const loads = [];
  const primes = [];
  const runner = async (inputs) => {
    const capturesBefore = inputs.captures.length;
    loads.push({
      cell: inputs.entry.cell,
      renderer: inputs.entry.renderer,
      page: inputs.entry.page,
      prime: inputs.prime === true,
    });
    const record = await runLandingPage(inputs);
    if (inputs.prime === true) {
      primes.push({
        record,
        capturesAdded: inputs.captures.length - capturesBefore,
      });
    }
    return inputs.prime === true && onPrime ? onPrime(record) : record;
  };
  return { runner, loads, primes };
}

/** Runs the probe with `runner` as the descriptor's page runner, restoring it. */
async function probeWith(name, args, runner, probe = descriptor, wrap) {
  const had = Object.hasOwn(probe, "pageRunner");
  const previous = probe.pageRunner;
  probe.pageRunner = runner;
  try {
    return await p14Run(name, args, {}, probe, wrap);
  } finally {
    if (had) {
      probe.pageRunner = previous;
    } else {
      delete probe.pageRunner;
    }
  }
}

const PF_ARGS = ["--perf", "--cells", "E-D", "--no-wait-pipelines"];

/** Every file under `dir`, relative, sorted. */
function listing(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        out.push(path.relative(dir, full).replaceAll("\\", "/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

// The load count and what the prime is. ---------------------------------------

test("a --perf run loads one page more than it plans, and the first load is the prime of the first PF page", async () => {
  const { runner, loads } = countingRunner();
  const { code, report, log } = await probeWith("count", PF_ARGS, runner);
  assert.equal(code, 0);
  const planned = report.pages.length;
  assert.ok(planned >= 2, "E-D plans a page on each renderer");
  assert.equal(loads.length, planned + 1);
  assert.equal(loads[0].prime, true);
  assert.deepEqual(
    loads.slice(1).map((load) => load.prime),
    new Array(planned).fill(false),
    "every later load is a measured page",
  );
  // The prime is the first planned page: same cell, renderer, page.
  const first = report.pages[0];
  assert.deepEqual(
    [loads[0].cell, loads[0].renderer, loads[0].page],
    [first.cell, first.renderer, first.page],
  );
  assert.deepEqual(
    loads.slice(1).map((load) => [load.cell, load.renderer, load.page]),
    report.pages.map((page) => [page.cell, page.renderer, page.page]),
  );
  // The fake browser saw the pages the runner loaded: the prime opened a real page.
  assert.equal(log.urls.length, planned + 1);
  assert.equal(log.contexts.length, planned + 1);
  assert.equal(liveSamplerReads(), 0);

  const { prime } = report;
  assert.equal(prime.status, "primed");
  assert.deepEqual(
    [prime.cell, prime.renderer, prime.page],
    [first.cell, first.renderer, first.page],
  );
  assert.equal(typeof prime.durationMs, "number");
  assert.ok(prime.cpuMean === null || typeof prime.cpuMean === "number");
  // On the fake browser the seam reads quiet at once, so the prime is one page.
  assert.equal(prime.stoppedBecause, "quiet");
  assert.equal(prime.pages.length, 1);
  assert.match(
    prime.note,
    new RegExp(
      `^prime: 1 page of ${first.cell} ${first.renderer} ${first.page}, stopped quiet, last (\\(CPU not read\\)|at [\\d.]+ % CPU)( \\(post-prime peak [\\d.]+ %\\))?$`,
    ),
  );
});

test("the prime's CPU mean is read from the prime page's own record into the receipt and its note", async () => {
  const { runner } = countingRunner((record) => ({
    ...record,
    cpu: { mean: 48.2, samples: [] },
  }));
  // The fake's seam answers the page CPU itself; the spec reads the wrapper's record instead.
  descriptor.warmUpDeps = {
    ...INSTANT_WARM_UP,
    prime: { ...INSTANT_WARM_UP.prime, pageCpu: (page) => page.cpu?.mean },
  };
  try {
    const { report } = await probeWith("cpu-note", PF_ARGS, runner);
    assert.equal(report.prime.cpuMean, 48.2);
    assert.match(report.prime.note, /, stopped quiet, last at 48\.2 % CPU/);
  } finally {
    delete descriptor.warmUpDeps;
  }
});

test("the prime captures nothing: the same run with no prime has the same captures, pages, arms and files", async () => {
  const withPrime = countingRunner();
  const a = await probeWith("same-a", PF_ARGS, withPrime.runner);
  const without = countingRunner();
  const b = await probeWith(
    "same-b",
    [...PF_ARGS, "--no-warm-up"],
    without.runner,
  );
  assert.equal(a.report.prime.status, "primed");
  assert.equal(b.report.prime.status, "skipped");
  assert.equal(withPrime.loads.length, without.loads.length + 1);

  const names = (report) =>
    report.pages.map((page) => page.capture?.name ?? null);
  assert.deepEqual(names(a.report), names(b.report));
  assert.ok(
    names(a.report).every((name) => typeof name === "string"),
    "every measured page captured",
  );
  assert.deepEqual(
    [
      a.report.captureManifest.written,
      a.report.captureManifest.violations,
      a.report.captureManifest.files,
    ],
    [
      b.report.captureManifest.written,
      b.report.captureManifest.violations,
      b.report.captureManifest.files,
    ],
  );
  assert.deepEqual(
    Object.entries(a.report.arms).map(([key, arm]) => [
      key,
      arm.runs,
      arm.captures.length,
    ]),
    Object.entries(b.report.arms).map(([key, arm]) => [
      key,
      arm.runs,
      arm.captures.length,
    ]),
  );
  assert.deepEqual(
    listing(path.join(TEMP_ROOT, "same-a", "out")),
    listing(path.join(TEMP_ROOT, "same-b", "out")),
    "the prime left no file in the output directory",
  );
  assert.deepEqual(
    a.verdicts.map((v) => v.id),
    b.verdicts.map((v) => v.id),
  );
  assert.equal(
    a.report.pages.some((page) => page.prime !== undefined),
    false,
    "the prime's record never entered the pages",
  );
});

test("the prime page returns after its settle: no capture, no PF window, no census, nothing added to the capture list", async () => {
  const { runner, primes } = countingRunner();
  const { report } = await probeWith("returns", PF_ARGS, runner);
  assert.equal(primes.length, 1);
  const [{ record, capturesAdded }] = primes;
  assert.equal(capturesAdded, 0);
  for (const key of ["capture", "perf", "census", "gate", "console"]) {
    assert.equal(key in record, false, `the prime record has no ${key}`);
  }
  assert.ok(
    record.startup,
    "the prime measured startup, as a measured page does",
  );
  assert.ok(record.pages === undefined);
  // The measured pages carry all of them.
  for (const page of report.pages) {
    assert.ok(page.capture && page.perf && page.census, page.renderer);
  }
});

test("--no-warm-up skips the prime with the warm-up: no extra load, status skipped", async () => {
  const { runner, loads } = countingRunner();
  const { report } = await probeWith(
    "skip",
    [...PF_ARGS, "--no-warm-up"],
    runner,
  );
  assert.equal(loads.length, report.pages.length);
  assert.equal(
    loads.some((load) => load.prime),
    false,
  );
  assert.equal(report.prime.status, "skipped");
  assert.equal(report.prime.note, "prime: skipped (--no-warm-up)");
  assert.equal(report.warmUp.status, "skipped");
});

test("a run with no PF window loads no prime: no --perf, or only dive-gate pages under --perf", async () => {
  const plain = countingRunner();
  const a = await probeWith(
    "no-perf",
    ["--cells", "E-O", "--no-wait-pipelines"],
    plain.runner,
  );
  assert.equal(plain.loads.length, a.report.pages.length);
  assert.equal(a.report.prime.status, "not-a-pf-run");
  assert.equal(a.report.prime.note, "prime: not a PF run");
  assert.equal(a.report.prime.cell, null);

  const dive = countingRunner();
  const b = await probeWith(
    "dive-perf",
    ["--perf", "--cells", "E-DG-ellipsoid"],
    dive.runner,
    descriptor,
    (browser) => withDiveGateAnswers(browser, { globeHeight: 0 }),
  );
  assert.equal(dive.loads.length, b.report.pages.length);
  assert.equal(b.report.prime.status, "not-a-pf-run");
  assert.equal(
    dive.loads.some((load) => load.prime),
    false,
  );
});

test("a prime that throws reads failed with its message, and the measured pages still run", async () => {
  const control = countingRunner();
  const ok = await probeWith("throw-control", PF_ARGS, control.runner);
  const { runner, loads } = countingRunner(() => {
    throw new Error("the prime page lost its context");
  });
  const { code, report } = await probeWith("throws", PF_ARGS, runner);
  assert.equal(code, 0);
  assert.equal(report.prime.status, "failed");
  assert.match(
    report.prime.note,
    /^prime: E-D \w+ scene failed after \d+ ms: /,
  );
  assert.match(report.prime.note, /the prime page lost its context$/);
  assert.equal(report.pages.length, ok.report.pages.length);
  assert.equal(loads.length, ok.report.pages.length + 1);
  assert.deepEqual(
    report.pages.map((page) => page.capture?.name),
    ok.report.pages.map((page) => page.capture?.name),
  );
});

test("a prime whose stage did not apply reads failed with the reason", async () => {
  const { runner } = countingRunner((record) => ({
    ...record,
    notRun: "the stage did not apply cloudsEnabled",
  }));
  const { code, report } = await probeWith("not-run", PF_ARGS, runner);
  assert.equal(code, 0);
  assert.equal(report.prime.status, "failed");
  assert.match(report.prime.note, /the stage did not apply cloudsEnabled$/);
});

test("the piece alone: no PF page in the plan names no page; a plan of PF pages names the first", async () => {
  const entries = [
    {
      cell: "E-DG-ellipsoid",
      kind: "dive-gate",
      renderer: "webgpu",
      page: "d",
    },
    { cell: "E-D", kind: "capture", renderer: "webgl", page: "scene" },
    { cell: "E-D", kind: "capture", renderer: "webgpu", page: "scene" },
  ];
  assert.equal(firstPfEntry({ perf: true }, entries), entries[1]);
  assert.equal(firstPfEntry({}, entries), null);
  assert.equal(firstPfEntry({ perf: true }, [entries[0]]), null);
  const calls = [];
  const record = await primeBeforeFirstArm({
    options: { perf: true },
    plan: entries,
    runPage: async (entry) => {
      calls.push(entry);
      return { cpu: { mean: 12.345 } };
    },
    deps: { sampleCpu: async () => 8 },
    now: (() => {
      let t = 100;
      return () => (t += 50);
    })(),
  });
  assert.deepEqual(calls, [entries[1]]);
  assert.deepEqual(record, {
    status: "primed",
    stoppedBecause: "quiet",
    cell: "E-D",
    renderer: "webgl",
    page: "scene",
    durationMs: 150,
    cpuMean: 12.345,
    sampler: "injected",
    cpuSource: "page",
    pages: [
      {
        index: 0,
        durationMs: 50,
        cpuMean: 12.345,
        postSample: [8, 8, 8],
        quiet: true,
        why: [],
      },
    ],
    note: "prime: 1 page of E-D webgl scene, stopped quiet, last at 12.35 % CPU (post-prime peak 8 %)",
  });
});

test("this spec leaves the descriptor as it found it", () => {
  assert.equal(descriptor.pageRunner, undefined);
  assert.equal(liveSamplerReads(), 0);
});

// The contention basis. --------------------------------------------------------

/** Base report on disk: E-D's arms with the CPU means of its runs set per arm. */
async function craftedBase(name, cpuByRenderer) {
  const { runner } = countingRunner();
  const first = await probeWith(name, PF_ARGS, runner);
  const dir = path.join(TEMP_ROOT, name, "out");
  const report = JSON.parse(
    fs.readFileSync(path.join(dir, "landing-cells-report.json"), "utf8"),
  );
  const pages = [];
  for (const page of report.pages) {
    const means = cpuByRenderer[page.renderer];
    means.forEach((mean, run) =>
      pages.push({ ...page, run, cpu: { mean, samples: [] } }),
    );
  }
  report.pages = pages;
  const file = path.join(dir, "crafted-base-report.json");
  fs.writeFileSync(file, JSON.stringify(report));
  return { file, first };
}

const PF_ID = /:PF-[1-4]$/;
const armOf = (id) => id.replace(PF_ID, "");

test("a paired run's receipt and every PF verdict carry the base arm's recorded mean CPU and the clause threshold", async () => {
  const { file } = await craftedBase("basis-base", {
    webgl: [40, 50],
    webgpu: [20, 30],
  });
  const { runner } = countingRunner();
  const { report, verdicts } = await probeWith(
    "basis-tip",
    [...PF_ARGS, "--base-report", file],
    runner,
  );
  assert.deepEqual(report.contentionBasis.arms, {
    "E-D|webgl|scene": { baseMeanCpu: 45 },
    "E-D|webgpu|scene": { baseMeanCpu: 25 },
  });
  assert.equal(report.contentionBasis.cpuArmDeltaPct, 20);
  assert.equal(report.contentionBasis.contendedCpuPct, 60);
  assert.equal(
    report.contentionBasis.note,
    "contention basis: the tip arm's mean CPU must stay within 20 points of the base arm's (E-D|webgl|scene 45 %, E-D|webgpu|scene 25 %) and under 60 %",
  );
  assert.match(report.prime.note, /^prime: /);
  const pf = verdicts.filter((v) => PF_ID.test(v.id));
  assert.ok(pf.length >= 4, "the paired run produced PF verdicts");
  for (const verdict of pf) {
    assert.deepEqual(
      verdict.contentionBasis,
      {
        baseMeanCpu: armOf(verdict.id).includes("|webgl|") ? 45 : 25,
        cpuArmDeltaPct: 20,
      },
      verdict.id,
    );
    assert.equal(verdict.prime, report.prime.note, verdict.id);
    assert.ok(verdict.warmUp, `${verdict.id} keeps its warm-up notes`);
  }
  for (const verdict of verdicts.filter((v) => !PF_ID.test(v.id))) {
    assert.equal("contentionBasis" in verdict, false, verdict.id);
    assert.equal("prime" in verdict, false, verdict.id);
  }
});

test("a --bands override that moves cpuArmDeltaPct moves the basis in the receipt and on every PF verdict", async () => {
  const { file } = await craftedBase("override-base", {
    webgl: [40, 50],
    webgpu: [20, 30],
  });
  const bandsFile = path.join(TEMP_ROOT, "override-bands.json");
  fs.writeFileSync(
    bandsFile,
    JSON.stringify({ cpuArmDeltaPct: 7, contendedCpuPct: 55 }),
  );
  const { runner } = countingRunner();
  const { report, verdicts } = await probeWith(
    "override-tip",
    [...PF_ARGS, "--base-report", file, "--bands", bandsFile],
    runner,
  );
  assert.equal(report.contentionBasis.cpuArmDeltaPct, 7);
  assert.equal(report.contentionBasis.contendedCpuPct, 55);
  assert.match(
    report.contentionBasis.note,
    /must stay within 7 points of the base arm's .* and under 55 %$/,
  );
  const pf = verdicts.filter((v) => PF_ID.test(v.id));
  assert.ok(pf.length >= 4);
  for (const verdict of pf) {
    assert.equal(verdict.contentionBasis.cpuArmDeltaPct, 7, verdict.id);
  }
});

test("without a base report the receipt's contentionBasis is null and no verdict carries one", async () => {
  const { runner } = countingRunner();
  const { report, verdicts } = await probeWith("no-base", PF_ARGS, runner);
  assert.equal(report.contentionBasis, null);
  assert.equal(
    verdicts.some((v) => "contentionBasis" in v),
    false,
  );
  assert.equal(contentionBasisOf(null), null);
  assert.equal(contentionBasisOf({}), null);
});

test("an arm of the base report with no CPU reading is left out of the basis, and a null mean prints n/a", () => {
  const basis = contentionBasisOf({
    arms: {
      "A|webgpu|scene": { inputs: { cpu: [30, 50] } },
      "B|webgpu|scene": { inputs: { cpu: [] } },
      "C|webgpu|scene": { inputs: { cpu: [30, null] } },
    },
  });
  assert.deepEqual(basis.arms, {
    "A|webgpu|scene": { baseMeanCpu: 40 },
    "C|webgpu|scene": { baseMeanCpu: null },
  });
  assert.match(
    basis.note,
    /\(A\|webgpu\|scene 40 %, C\|webgpu\|scene n\/a %\)/,
  );
});

test("markPfVerdicts adds the prime note and the arm basis to PF verdicts only, and nothing when they are not supplied", () => {
  const verdicts = [
    { id: "X|webgpu|scene:PF-1", pass: true },
    { id: "Y|webgl|scene:PF-3", pass: true },
    { id: "X|webgpu|scene:stage", pass: true },
  ];
  const basis = {
    cpuArmDeltaPct: 9,
    arms: { "X|webgpu|scene": { baseMeanCpu: 33.3 } },
  };
  const marked = markPfVerdicts(verdicts, {
    tip: { note: "warm-up: t" },
    base: { note: "warm-up: b" },
    prime: { note: "prime: p" },
    basis,
  });
  assert.equal(marked[0].prime, "prime: p");
  assert.deepEqual(marked[0].contentionBasis, {
    baseMeanCpu: 33.3,
    cpuArmDeltaPct: 9,
  });
  assert.deepEqual(
    marked[1].contentionBasis,
    { baseMeanCpu: null, cpuArmDeltaPct: 9 },
    "an arm the base report lacks reads null, never another arm's figure",
  );
  assert.deepEqual(marked[2], verdicts[2]);
  const plain = markPfVerdicts(verdicts, {
    tip: { note: "warm-up: t" },
    base: null,
  });
  assert.equal("prime" in plain[0], false);
  assert.equal("contentionBasis" in plain[0], false);
});

// Inertness mutants. ----------------------------------------------------------

test("mutant M1: the prime call made unreachable turns the load-count case red", async () => {
  const real = countingRunner();
  await probeWith("m1-real", PF_ARGS, real.runner);
  assert.equal(
    real.loads.some((load) => load.prime),
    true,
    "the real probe primes",
  );
  const mutated = await importMutated(PROBE_MODULE, [
    [
      "    if (run === 0) {\n      // Unmeasured loads",
      "    if (false && run === 0) {\n      // Unmeasured loads",
    ],
  ]);
  const mutant = countingRunner();
  const { report } = await probeWith(
    "m1-mutant",
    PF_ARGS,
    mutant.runner,
    mutated.descriptor,
  );
  assert.equal(mutant.loads.length, report.pages.length, "no prime load");
  assert.notEqual(mutant.loads.length, real.loads.length);
  assert.notEqual(report.prime?.status, "primed");
});

test("mutant M2: the --no-warm-up skip of the prime made unreachable turns the skip case red", async () => {
  const skipCase = async (piece) => {
    let loads = 0;
    const record = await piece.primeBeforeFirstArm({
      options: { perf: true, noWarmUp: true },
      plan: [
        { cell: "E-D", kind: "capture", renderer: "webgpu", page: "scene" },
      ],
      runPage: async () => {
        loads += 1;
        return { cpu: { mean: 0 } };
      },
      deps: { sampleCpu: async () => 0 },
    });
    return { loads, status: record.status };
  };
  assert.deepEqual(await skipCase({ primeBeforeFirstArm }), {
    loads: 0,
    status: "skipped",
  });
  const mutated = await importMutated(PRIME_MODULE, [
    [
      "if (options?.noWarmUp === true) {",
      "if (false && options?.noWarmUp === true) {",
    ],
  ]);
  const result = await skipCase(mutated);
  assert.equal(result.loads, 1, "the mutant primes under --no-warm-up");
  assert.notEqual(result.status, "skipped");
});

test("mutant M3: a basis threshold read from a literal, or a basis dropped from the verdicts, turns the override case red", async () => {
  const base = { arms: { "E-D|webgl|scene": { inputs: { cpu: [40, 50] } } } };
  const overrideCase = (piece) =>
    piece.contentionBasisOf(base, { cpuArmDeltaPct: 7 });
  assert.equal(overrideCase({ contentionBasisOf }).cpuArmDeltaPct, 7);

  const literal = await importMutated(PRIME_MODULE, [
    [
      "const { cpuArmDeltaPct, contendedCpuPct } = resolveBands(overrides);",
      "const { cpuArmDeltaPct, contendedCpuPct } = { ...resolveBands(overrides), cpuArmDeltaPct: 20 };",
    ],
  ]);
  assert.equal(
    overrideCase(literal).cpuArmDeltaPct,
    20,
    "the mutant ignores the override",
  );

  const dropped = await importMutated(WARM_UP_MODULE, [
    ["    if (basis) {", "    if (false && basis) {"],
  ]);
  const verdicts = [{ id: "E-D|webgl|scene:PF-1", pass: true }];
  const input = {
    tip: null,
    base: null,
    prime: { note: "prime: p" },
    basis: overrideCase({ contentionBasisOf }),
  };
  assert.equal(
    markPfVerdicts(verdicts, input)[0].contentionBasis.cpuArmDeltaPct,
    7,
  );
  assert.equal(
    "contentionBasis" in dropped.markPfVerdicts(verdicts, input)[0],
    false,
    "the mutant leaves the verdict without a basis",
  );
});

test("mutant M4: a prime page that does not return after its settle captures and measures, and the no-capture case goes red", async () => {
  const mutated = await importMutated(PROBE_MODULE, [
    [
      "      if (prime) {\n        return record;\n      }",
      "      if (false && prime) {\n        return record;\n      }",
    ],
  ]);
  const primes = [];
  // The mutated page runner runs the mutated page path.
  const mutantRunner = async (inputs) => {
    const before = inputs.captures.length;
    const record = await mutated.runLandingPage(inputs);
    if (inputs.prime === true) {
      primes.push({ record, capturesAdded: inputs.captures.length - before });
    }
    return record;
  };
  await probeWith("m4-mutant", PF_ARGS, mutantRunner);
  assert.equal(primes.length, 1);
  assert.ok(primes[0].record.capture, "the mutant's prime captured a frame");
  assert.ok(primes[0].record.perf, "and ran a PF window");
  assert.ok(primes[0].capturesAdded > 0);
});
