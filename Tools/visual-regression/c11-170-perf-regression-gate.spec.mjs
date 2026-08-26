// C11-170 gate policy tests. Pure Node: no browser, network, or probe process.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import {
  adjudicatePerfRegressionGate,
  assertBaselineIsolation,
  assertLiveWriteTarget,
  baselineCollisions,
  derivationViolations,
  evaluateEvidenceFreshness,
  LIVE_WRITE_PATHS,
  PERF_GATE_BARS,
  RESOURCE_WRITE_FAMILY,
  ruleOfThreeBound,
} from "./probe-perf-regression-gate.mjs";
import {
  S5_STATUS_EXIT_CODES as EXIT_CODE,
  exitCodeForS5Status,
} from "./lib/verdict-exit-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = path.join(HERE, "probe-perf-regression-gate.mjs");
const TEMP_PREFIX = ".tmp-c11-170-mutant-";
const REPORT_PATHS = Object.freeze({
  cpu: path.join(HERE, "output", "cpu-sampling-profile.json"),
  request: path.join(HERE, "output", "request-render-asymmetry-report.json"),
  backend: path.join(HERE, "output", "backend-isolation-report.json"),
  frame: path.join(
    HERE,
    "output",
    "performance",
    "c11-169-whole-frame-phase-attribution.json",
  ),
});

function clone(value) {
  return structuredClone(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const BASELINE_FIXTURE_PATH = path.join(
  HERE,
  "fixtures",
  "c11-170",
  "perf-gate-derivation-baseline.json",
);

// WHY THIS IS A FIXTURE AND NOT A REPORT PATH. Until 2026-08-25 these tests read
// the banked evidence back from `REPORT_PATHS` -- the very four files the gate
// rewrites on every acquire run. The first acquire run therefore overwrote the
// baseline its own bars were derived from, and two tests went red for the sole
// reason that the gate had been run. That is the same defect class as a spec
// that certifies source text instead of behaviour: the control was not
// independent of the thing under test.
//
// The derivation baseline is now a checked-in immutable fixture outside the
// gitignored output tree. There is deliberately NO `skip`: a clean checkout used
// to skip four tests silently, which made them vacuous everywhere but this
// machine. A missing or malformed fixture is now a failure, not an excuse.
function loadDerivationBaseline() {
  const problems = [];
  let fixture;
  try {
    fixture = readJson(BASELINE_FIXTURE_PATH);
  } catch (error) {
    problems.push(
      `${BASELINE_FIXTURE_PATH}: ${String(error?.message ?? error)}`,
    );
    return { fixture: null, reports: null, problems };
  }
  for (const key of ["cpu", "request", "backend", "frame"]) {
    if (
      fixture?.reports?.[key] === null ||
      typeof fixture?.reports?.[key] !== "object"
    ) {
      problems.push(`reports.${key} is absent or not an object`);
    }
    if (
      fixture?.provenance?.[key] === null ||
      typeof fixture?.provenance?.[key] !== "object"
    ) {
      problems.push(`provenance.${key} is absent or not an object`);
    }
  }
  return { fixture, reports: fixture?.reports ?? null, problems };
}

const BASELINE = loadDerivationBaseline();

function baselineReports() {
  assert.deepEqual(
    BASELINE.problems,
    [],
    "the checked-in derivation baseline must load",
  );
  return clone(BASELINE.reports);
}

function digest(text) {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function trialCount() {
  return PERF_GATE_BARS.ruleOfThree.numerator * 10;
}

function zeroSeries() {
  return Array.from({ length: trialCount() }, () => 0);
}

function minimalReports() {
  const series = zeroSeries();
  return {
    cpu: {
      probe: "cpu-sampling-profile",
      date: new Date().toISOString(),
      frames: trialCount(),
      webgpu: { medianRenderMs: 1, sampledTotalMs: 1 },
      webgl: { medianRenderMs: 1, sampledTotalMs: 1 },
      webgpuTopSelfTime: [
        { fn: "createCameraUniformBuffer @ fixture:1", pct: 0, ms: 0 },
        { fn: "(idle) @ fixture:2", pct: 100, ms: 1 },
      ],
      webglTopSelfTime: [
        { fn: "createTileUniformBuffer @ fixture:1", pct: 0, ms: 0 },
        { fn: "(idle) @ fixture:2", pct: 100, ms: 1 },
      ],
    },
    request: {
      probe: "request-render-asymmetry",
      date: new Date().toISOString(),
      verdict: {
        honest_render_ms: {
          ratio: PERF_GATE_BARS.signalE.maxRatioInclusive / 2,
        },
      },
      webgpu: {
        ok: true,
        laneA: {
          asyncResourcesPresent: true,
          pendingForegroundSeries: clone(series),
          pendingForegroundNonZeroFrames: 0,
          renderRequestedFrames: 0,
        },
      },
      webgl: {
        ok: true,
        laneA: {
          asyncResourcesPresent: false,
          pendingForegroundSeries: clone(series),
          pendingForegroundNonZeroFrames: 0,
          renderRequestedFrames: 0,
        },
      },
    },
    backend: {
      probe: "backend-isolation",
      date: new Date().toISOString(),
      verdicts: {
        Q1_webgl_running_in_webgpu_mode:
          "NO — zero WebGL getContext calls in webgpu mode",
        Q2_split_vs_solo: "UNKNOWN",
        webgpu_over_webgl_render_ms_ratio:
          PERF_GATE_BARS.signalE.maxRatioInclusive / 2,
      },
      lanes: [
        {
          name: "webgpu-solo",
          ok: true,
          contexts: {
            totalGetContextCalls: 1,
            byKind: {
              webgpu: { count: 1, nonNull: 1, types: {}, samples: [] },
            },
          },
          consoleErrors: [],
        },
        {
          name: "webgl-solo",
          ok: true,
          contexts: {
            totalGetContextCalls: 1,
            byKind: {
              webgl: { count: 1, nonNull: 1, types: {}, samples: [] },
            },
          },
          consoleErrors: [],
        },
        { name: "split", ok: false, consoleErrors: [] },
      ],
    },
    frame: {
      probe: "c11-169-webgpu-whole-frame-phase-attribution",
      generatedAt: new Date().toISOString(),
      status: "PASS",
      exitCode: exitCodeForS5Status("PASS"),
      pass: true,
      incomplete: false,
      failures: [],
      setup: { profiler: { available: true } },
      route: { frameRecords: [{ coverageRatio: 1 / 7 }] },
      errors: { console: [], page: [] },
    },
  };
}

function allFresh() {
  return Object.fromEntries(
    Object.keys(REPORT_PATHS).map((key) => [key, { fresh: true, reasons: [] }]),
  );
}

function adjudicate(reports, options = {}) {
  const mode = options.mode ?? "acquire";
  return adjudicatePerfRegressionGate({
    mode,
    reports,
    freshness: options.freshness ?? (mode === "acquire" ? allFresh() : {}),
    reportProblems: options.reportProblems ?? {},
    harnessErrors: options.harnessErrors ?? [],
    structuralReasons: options.structuralReasons ?? [],
  });
}

function signal(result, id) {
  const found = result.signals.find((entry) => entry.id === id);
  assert.ok(found, `missing signal ${id}`);
  return found;
}

function justAbove(value) {
  return value + Math.max(Number.EPSILON, Math.abs(value) * Number.EPSILON * 2);
}

function stormFor(id) {
  const reports = minimalReports();
  switch (id) {
    case "A-webgpu":
      reports.cpu.webgpuTopSelfTime.push({
        fn: `${RESOURCE_WRITE_FAMILY[0]} @ fixture:3`,
        pct: justAbove(PERF_GATE_BARS.signalA.maxPctExclusive),
        ms: 1,
      });
      break;
    case "A-webgl":
      reports.cpu.webglTopSelfTime.push({
        fn: `${RESOURCE_WRITE_FAMILY[0]} @ fixture:3`,
        pct: justAbove(PERF_GATE_BARS.signalA.maxPctExclusive),
        ms: 1,
      });
      break;
    case "B":
      reports.request.webgpu.laneA.pendingForegroundNonZeroFrames =
        PERF_GATE_BARS.ruleOfThree.numerator;
      break;
    case "C":
      reports.request.webgpu.laneA.renderRequestedFrames =
        PERF_GATE_BARS.ruleOfThree.numerator;
      break;
    case "D":
      reports.backend.lanes[0].contexts.byKind.webgl = {
        count: 1,
        nonNull: 1,
        types: { webgl2: 1 },
        samples: [],
      };
      reports.backend.verdicts.Q1_webgl_running_in_webgpu_mode =
        "YES — 1 live WebGL context(s) created from 1 call(s)";
      break;
    case "E-1":
      reports.backend.verdicts.webgpu_over_webgl_render_ms_ratio = justAbove(
        PERF_GATE_BARS.signalE.maxRatioInclusive,
      );
      break;
    case "E-2":
      reports.request.verdict.honest_render_ms.ratio = justAbove(
        PERF_GATE_BARS.signalE.maxRatioInclusive,
      );
      break;
    case "F":
      reports.frame.status = "FAIL";
      reports.frame.exitCode = exitCodeForS5Status("FAIL");
      reports.frame.pass = false;
      reports.frame.failures = ["fixture frame-accounting failure"];
      break;
    case "G":
      reports.backend.lanes[0].consoleErrors.push(
        "[WebGPU:TextureUpload] RE-UPLOAD STORM: fixture",
      );
      break;
    default:
      assert.fail(`unknown storm signal ${id}`);
  }
  return reports;
}

function removeFieldFor(id) {
  const reports = minimalReports();
  switch (id) {
    case "A-webgpu":
      delete reports.cpu.webgpuTopSelfTime;
      break;
    case "A-webgl":
      delete reports.cpu.webglTopSelfTime;
      break;
    case "B":
      delete reports.request.webgpu.laneA.pendingForegroundNonZeroFrames;
      break;
    case "C":
      delete reports.request.webgl.laneA.renderRequestedFrames;
      break;
    case "D":
      delete reports.backend.lanes[0].contexts;
      break;
    case "E-1":
      delete reports.backend.verdicts.webgpu_over_webgl_render_ms_ratio;
      break;
    case "E-2":
      delete reports.request.verdict.honest_render_ms.ratio;
      break;
    case "F":
      delete reports.frame.setup.profiler.available;
      break;
    case "G":
      delete reports.backend.lanes[0].consoleErrors;
      delete reports.backend.lanes[1].consoleErrors;
      delete reports.backend.lanes[2].consoleErrors;
      delete reports.frame.errors.console;
      delete reports.frame.errors.page;
      break;
    default:
      assert.fail(`unknown field-absence signal ${id}`);
  }
  return reports;
}

function normalizedRunnerSource() {
  return fs.readFileSync(RUNNER_PATH, "utf8").replaceAll("\r\n", "\n");
}

function replaceExactlyOnce(source, anchor, replacement) {
  const count = source.split(anchor).length - 1;
  assert.equal(count, 1, `mutation anchor count for ${JSON.stringify(anchor)}`);
  const mutated = source.replace(anchor, replacement);
  assert.notEqual(mutated, source, "mutation did not change source");
  return mutated;
}

async function withMutant(transform, use) {
  const file = path.join(HERE, `${TEMP_PREFIX}${randomUUID()}.mjs`);
  const source = normalizedRunnerSource();
  const mutated = transform(source);
  assert.notEqual(mutated, source, "mutant source is byte-identical");
  try {
    fs.writeFileSync(file, mutated, { flag: "wx" });
    const module = await import(
      `${pathToFileURL(file).href}?mutation=${randomUUID()}`
    );
    return await use(module);
  } finally {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      assert.equal(
        error?.code,
        "ENOENT",
        `mutant cleanup failed: ${String(error)}`,
      );
    }
    assert.equal(fs.existsSync(file), false, `${file} survived cleanup`);
  }
}

function barWidenTransform(id, reports) {
  return (source) => {
    if (id === "A-webgpu" || id === "A-webgl") {
      const current = PERF_GATE_BARS.signalA.maxPctExclusive;
      const widened = justAbove(signal(adjudicate(reports), id).observed);
      return replaceExactlyOnce(
        source,
        `maxPctExclusive: ${current},`,
        `maxPctExclusive: ${widened},`,
      );
    }
    if (id === "B" || id === "C") {
      const current = PERF_GATE_BARS.ruleOfThree.numerator;
      return replaceExactlyOnce(
        source,
        `numerator: ${current},`,
        `numerator: ${current + 1},`,
      );
    }
    if (id === "D") {
      const current = PERF_GATE_BARS.signalD.requiredWebglNonNull;
      const widened = signal(adjudicate(reports), id).observed.webglNonNull;
      return replaceExactlyOnce(
        source,
        `requiredWebglNonNull: ${current},`,
        `requiredWebglNonNull: ${widened},`,
      );
    }
    if (id === "E-1" || id === "E-2") {
      const current = PERF_GATE_BARS.signalE.maxRatioInclusive;
      const widened = justAbove(signal(adjudicate(reports), id).observed);
      return replaceExactlyOnce(
        source,
        `maxRatioInclusive: ${current},`,
        `maxRatioInclusive: ${widened},`,
      );
    }
    if (id === "F") {
      return replaceExactlyOnce(
        source,
        'const verdict = mapped === EXIT_CODE.PASS ? "PASS" : "FAIL";',
        'const verdict = mapped === EXIT_CODE.PASS || mapped === EXIT_CODE.FAIL ? "PASS" : "FAIL";',
      );
    }
    if (id === "G") {
      return replaceExactlyOnce(
        source,
        'message.includes("RE-UPLOAD STORM")',
        'message.includes("RE-UPLOAD STORM MUTANT-WIDENED")',
      );
    }
    assert.fail(`unknown bar-widen signal ${id}`);
  };
}

// Point the gate's live output directory straight at the read-only baseline.
// This is the shape the 2026-08-25 defect actually had: one tree serving as both
// the evidence and the destination.
function collideOutputDirectory(source) {
  return replaceExactlyOnce(
    source,
    'const OUTPUT_DIRECTORY = path.join(__dirname, "output", "performance");',
    'const OUTPUT_DIRECTORY = path.join(__dirname, "fixtures", "c11-170");',
  );
}

function widenSignalABar(source) {
  return replaceExactlyOnce(
    source,
    `maxPctExclusive: ${PERF_GATE_BARS.signalA.maxPctExclusive},`,
    `maxPctExclusive: ${justAbove(PERF_GATE_BARS.signalA.maxPctExclusive)},`,
  );
}

function inertTransform(id) {
  return (source) => {
    if (id === "A-webgpu" || id === "A-webgl") {
      return replaceExactlyOnce(
        source,
        "const pass = observed < PERF_GATE_BARS.signalA.maxPctExclusive;",
        "const pass = !(false && observed >= PERF_GATE_BARS.signalA.maxPctExclusive);",
      );
    }
    if (id === "B") {
      return replaceExactlyOnce(
        source,
        "const pass = rate < bound;",
        "const pass = !(false && rate >= bound);",
      );
    }
    if (id === "C") {
      return replaceExactlyOnce(
        source,
        'verdict: failed.length === 0 ? "PASS" : "FAIL",',
        'verdict: false && failed.length > 0 ? "FAIL" : "PASS",',
      );
    }
    if (id === "D") {
      return replaceExactlyOnce(
        source,
        "const pass = webglNonNull === PERF_GATE_BARS.signalD.requiredWebglNonNull;",
        "const pass = !(false && webglNonNull !== PERF_GATE_BARS.signalD.requiredWebglNonNull);",
      );
    }
    if (id === "E-1" || id === "E-2") {
      return replaceExactlyOnce(
        source,
        "const pass = ratio <= PERF_GATE_BARS.signalE.maxRatioInclusive;",
        "const pass = !(false && ratio > PERF_GATE_BARS.signalE.maxRatioInclusive);",
      );
    }
    if (id === "F") {
      return replaceExactlyOnce(
        source,
        'const verdict = mapped === EXIT_CODE.PASS ? "PASS" : "FAIL";',
        'const verdict = false && mapped === EXIT_CODE.FAIL ? "FAIL" : "PASS";',
      );
    }
    if (id === "G") {
      return replaceExactlyOnce(
        source,
        'verdict: matches.length > 0 ? "FAIL" : "NOT-PROVEN",',
        'verdict: false && matches.length > 0 ? "FAIL" : "NOT-PROVEN",',
      );
    }
    assert.fail(`unknown inertness signal ${id}`);
  };
}

test("banked artifacts keep every A-F subject green while adjudicate-only is STRUCTURAL", () => {
  const result = adjudicate(baselineReports(), {
    mode: "adjudicate-only",
  });
  for (const entry of result.signals.filter((item) => item.id !== "G")) {
    assert.equal(entry.verdict, "PASS", `${entry.id}: ${entry.reason}`);
  }
  assert.equal(signal(result, "G").verdict, "NOT-PROVEN");
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, exitCodeForS5Status("STRUCTURAL"));
});

test("the banked derived bars remain bound to their source observations", () => {
  const reports = baselineReports();
  const result = adjudicate(clone(reports), {
    mode: "adjudicate-only",
  });
  assert.equal(
    signal(result, "A-webgpu").bar,
    PERF_GATE_BARS.signalA.maxPctExclusive,
  );
  assert.equal(
    signal(result, "B").bar,
    ruleOfThreeBound(
      reports.request.webgpu.laneA.pendingForegroundSeries.length,
    ),
  );
  assert.equal(
    signal(result, "E-1").bar,
    PERF_GATE_BARS.signalE.maxRatioInclusive,
  );
  assert.equal(
    result.recorded.coverageRatioMax,
    Math.max(
      ...reports.frame.route.frameRecords.map((record) => record.coverageRatio),
    ),
  );
});

for (const id of [
  "A-webgpu",
  "A-webgl",
  "B",
  "C",
  "D",
  "E-1",
  "E-2",
  "F",
  "G",
]) {
  test(`${id} tooth 1: trigger just beyond the frozen policy makes the real signal red`, () => {
    const result = adjudicate(stormFor(id));
    assert.equal(signal(result, id).verdict, "FAIL");
    assert.equal(result.status, "FAIL");
  });

  test(`${id} tooth 2: widening the real runner mirror lets the same trigger escape`, async () => {
    const reports = stormFor(id);
    await withMutant(barWidenTransform(id, reports), async (mutant) => {
      const result = mutant.adjudicatePerfRegressionGate({
        mode: "acquire",
        reports,
        freshness: allFresh(),
      });
      assert.notEqual(
        signal(result, id).verdict,
        "FAIL",
        `${id} constant/policy widening did not bite`,
      );
    });
  });

  test(`${id} tooth 3: required field absence never becomes PASS`, () => {
    const result = adjudicate(removeFieldFor(id));
    assert.equal(signal(result, id).verdict, "STRUCTURAL");
  });

  test(`${id} tooth 4: an executable inert predicate mirror makes the original red assertion fail`, async () => {
    const reports = stormFor(id);
    await withMutant(inertTransform(id), async (mutant) => {
      const result = mutant.adjudicatePerfRegressionGate({
        mode: "acquire",
        reports,
        freshness: allFresh(),
      });
      assert.throws(
        () =>
          assert.equal(
            signal(result, id).verdict,
            "FAIL",
            `${id} stayed live after its predicate was made unreachable`,
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    });
  });
}

test("A exact equality keeps named uniform-buffer negative controls green", () => {
  const result = adjudicate(minimalReports());
  assert.equal(signal(result, "A-webgpu").verdict, "PASS");
  assert.equal(signal(result, "A-webgl").verdict, "PASS");
});

test("A overbroad Buffer-suffix substring mutant reds the banked negative controls", async () => {
  const reports = baselineReports();
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "family.has(functionNameComponent(row.fn))",
        '[...family].some((member) => functionNameComponent(row.fn).includes(member.startsWith("create") ? member.slice("create".length) : member))',
      ),
    async (mutant) => {
      const result = mutant.adjudicatePerfRegressionGate({
        mode: "adjudicate-only",
        reports: clone(reports),
      });
      const controlRows = [
        "createCameraUniformBuffer",
        "createTileUniformBuffer",
      ].map((control) => {
        const row = reports.cpu.webgpuTopSelfTime.find(
          (entry) => entry.fn.split(" @ ", 1)[0] === control,
        );
        assert.ok(row, `banked negative control ${control} is absent`);
        return row;
      });
      const namedControlContribution = controlRows.reduce(
        (sum, row) => sum + row.pct,
        0,
      );
      assert.equal(signal(result, "A-webgpu").verdict, "FAIL");
      assert.ok(
        signal(result, "A-webgpu").observed >= namedControlContribution,
      );
    },
  );
});

test("A distinguishes an empty profile from a measured non-match", () => {
  const empty = minimalReports();
  empty.cpu.webgpuTopSelfTime = [];
  assert.equal(signal(adjudicate(empty), "A-webgpu").verdict, "STRUCTURAL");

  const errored = minimalReports();
  errored.cpu.webgpu.error = "fixture profiler failure";
  assert.equal(signal(adjudicate(errored), "A-webgpu").verdict, "STRUCTURAL");

  const measuredZero = minimalReports();
  assert.equal(signal(adjudicate(measuredZero), "A-webgpu").observed, 0);
  assert.equal(signal(adjudicate(measuredZero), "A-webgpu").verdict, "PASS");
});

test("B asyncResourcesPresent false is STRUCTURAL rather than PASS", () => {
  const reports = minimalReports();
  reports.request.webgpu.laneA.asyncResourcesPresent = false;
  assert.equal(signal(adjudicate(reports), "B").verdict, "STRUCTURAL");
});

test("D sparse-zero is fenced by WebGPU liveness", () => {
  const reports = minimalReports();
  delete reports.backend.lanes[0].contexts.byKind.webgpu;
  assert.equal(signal(adjudicate(reports), "D").verdict, "STRUCTURAL");
});

test("D sparse-zero must agree with the producer Q1 prefix", () => {
  const reports = minimalReports();
  reports.backend.verdicts.Q1_webgl_running_in_webgpu_mode =
    "YES — 2 live WebGL context(s) created from 2 call(s)";
  assert.equal(signal(adjudicate(reports), "D").verdict, "STRUCTURAL");
});

test("D attempted-but-null is recorded and remains PASS", () => {
  const reports = minimalReports();
  reports.backend.lanes[0].contexts.byKind.webgl = {
    count: 1,
    nonNull: 0,
    types: { webgl2: 1 },
    samples: [],
  };
  reports.backend.verdicts.Q1_webgl_running_in_webgpu_mode =
    "ATTEMPTED-BUT-NULL — 1 webgl getContext call(s), all returned null";
  const result = adjudicate(reports);
  assert.equal(signal(result, "D").verdict, "PASS");
  assert.equal(result.recorded.backendAttemptedButNull, true);
});

test("D rejects an attempted-null Q1 prefix without the producer's em dash", () => {
  const reports = minimalReports();
  reports.backend.lanes[0].contexts.byKind.webgl = {
    count: 1,
    nonNull: 0,
    types: { webgl2: 1 },
    samples: [],
  };
  reports.backend.verdicts.Q1_webgl_running_in_webgpu_mode =
    "ATTEMPTED-BUT-NULL bogus";
  assert.equal(signal(adjudicate(reports), "D").verdict, "STRUCTURAL");
});

test("D never adjudicates a failed split lane", () => {
  const reports = minimalReports();
  reports.backend.lanes[2] = {
    name: "split",
    ok: false,
    error: "fixture timeout",
  };
  const result = adjudicate(reports);
  assert.equal(signal(result, "D").verdict, "PASS");
  assert.equal(result.recorded.splitLaneAdjudicated, false);
});

test("F unknown RUNNING and WAT statuses both route canonically to STRUCTURAL", () => {
  for (const status of ["RUNNING", "WAT"]) {
    const reports = minimalReports();
    reports.frame.status = status;
    reports.frame.exitCode = EXIT_CODE.ERROR;
    reports.frame.incomplete = true;
    assert.equal(signal(adjudicate(reports), "F").verdict, "STRUCTURAL");
  }
});

test("F rejects contradictory final verdict envelopes as STRUCTURAL", () => {
  const mutations = [
    (frame) => {
      frame.exitCode = EXIT_CODE.FAIL;
    },
    (frame) => {
      frame.pass = false;
    },
    (frame) => {
      frame.incomplete = true;
    },
  ];
  for (const mutate of mutations) {
    const reports = minimalReports();
    mutate(reports.frame);
    assert.equal(signal(adjudicate(reports), "F").verdict, "STRUCTURAL");
  }
});

test("F records coverage context without adjudicating it", () => {
  const reports = minimalReports();
  delete reports.frame.route;
  const result = adjudicate(reports);
  assert.equal(signal(result, "F").verdict, "PASS");
  assert.equal(result.recorded.coverageRatioMax, null);
});

test("G sentinel text in any retained console array flips NOT-PROVEN to FAIL", () => {
  const reports = minimalReports();
  assert.equal(signal(adjudicate(reports), "G").verdict, "NOT-PROVEN");
  reports.frame.errors.page.push("RE-UPLOAD STORM fixture page error");
  assert.equal(signal(adjudicate(reports), "G").verdict, "FAIL");
});

for (const key of Object.keys(REPORT_PATHS)) {
  test(`global empty-report mutant: ${key} = {} is STRUCTURAL`, () => {
    const reports = minimalReports();
    reports[key] = {};
    assert.equal(adjudicate(reports).status, "STRUCTURAL");
  });
}

test("global all-reports-missing mutant is STRUCTURAL", () => {
  assert.equal(adjudicate({}).status, "STRUCTURAL");
});

test("global stale acquire report is STRUCTURAL", () => {
  const reports = minimalReports();
  const gateStartMs = Date.parse("2026-08-24T12:00:00.000Z");
  reports.cpu.date = new Date(gateStartMs - 1).toISOString();
  const freshness = allFresh();
  freshness.cpu = evaluateEvidenceFreshness(
    {
      relativePath: "Tools/visual-regression/output/cpu-sampling-profile.json",
      timestampField: "date",
    },
    {
      exists: true,
      byteLength: 1,
      sha256: "a".repeat(64),
    },
    {
      exists: true,
      byteLength: 2,
      sha256: "b".repeat(64),
    },
    reports.cpu,
    gateStartMs,
  );
  assert.equal(freshness.cpu.fresh, false);
  assert.match(freshness.cpu.reasons.join("\n"), /predates gate start/u);
  assert.equal(adjudicate(reports, { freshness }).status, "STRUCTURAL");
});

test("freshness never mistakes an unreadable prior snapshot for ENOENT", () => {
  const gateStartMs = Date.parse("2026-08-24T12:00:00.000Z");
  const report = { date: new Date(gateStartMs).toISOString() };
  const result = evaluateEvidenceFreshness(
    { relativePath: "fixture.json", timestampField: "date" },
    {
      exists: false,
      byteLength: null,
      sha256: null,
      error: "EACCES",
    },
    {
      exists: true,
      byteLength: 1,
      sha256: "c".repeat(64),
    },
    report,
    gateStartMs,
  );
  assert.equal(result.changed, true);
  assert.equal(result.fresh, false);
  assert.match(result.reasons.join("\n"), /integrity is unverifiable/u);
});

test("G does not give a stale-only sentinel standing in acquire mode", () => {
  for (const staleKey of ["backend", "frame"]) {
    const reports = minimalReports();
    const sentinel = "[WebGPU:TextureUpload] RE-UPLOAD STORM: stale fixture";
    if (staleKey === "backend") {
      reports.backend.lanes[0].consoleErrors.push(sentinel);
    } else {
      reports.frame.errors.page.push(sentinel);
    }
    const freshness = allFresh();
    freshness[staleKey] = {
      fresh: false,
      reasons: ["fixture source predates the gate"],
    };
    const result = adjudicate(reports, { freshness });
    assert.equal(signal(result, "G").verdict, "STRUCTURAL");
    assert.ok(signal(result, "G").observed.untrustedMatches.length > 0);
    assert.equal(result.status, "STRUCTURAL");
  }
});

test("G is STRUCTURAL when freshness is blind and no sentinel is retained", () => {
  const reports = minimalReports();
  const freshness = allFresh();
  freshness.backend = {
    fresh: false,
    reasons: ["fixture backend source predates the gate"],
  };
  const result = adjudicate(reports, { freshness });
  assert.equal(signal(result, "G").verdict, "STRUCTURAL");
  assert.equal(result.status, "STRUCTURAL");
});

test("G retains a fresh positive when its sibling source is stale", () => {
  const reports = minimalReports();
  reports.frame.errors.page.push(
    "[WebGPU:TextureUpload] RE-UPLOAD STORM: fresh fixture",
  );
  const freshness = allFresh();
  freshness.backend = {
    fresh: false,
    reasons: ["fixture backend source predates the gate"],
  };
  const result = adjudicate(reports, { freshness });
  assert.equal(signal(result, "G").verdict, "FAIL");
  assert.ok(signal(result, "G").structuralSubreasons.length > 0);
  assert.equal(result.status, "FAIL");
});

test("C retains a complete backend red when the other backend is blind", () => {
  const reports = stormFor("C");
  delete reports.request.webgl.laneA.renderRequestedFrames;
  const result = adjudicate(reports);
  assert.equal(signal(result, "C").verdict, "FAIL");
  assert.ok(signal(result, "C").structuralSubreasons.length > 0);
  assert.equal(result.status, "FAIL");
});

test("global precedence: FAIL outranks STRUCTURAL", () => {
  const reports = stormFor("A-webgpu");
  delete reports.request.webgpu.laneA.pendingForegroundNonZeroFrames;
  const result = adjudicate(reports);
  assert.equal(signal(result, "A-webgpu").verdict, "FAIL");
  assert.equal(signal(result, "B").verdict, "STRUCTURAL");
  assert.equal(result.status, "FAIL");
});

test("global precedence: adjudicate-only ceiling outranks an otherwise clean run", () => {
  const result = adjudicate(minimalReports(), { mode: "adjudicate-only" });
  assert.equal(result.status, "STRUCTURAL");
  assert.equal(result.exitCode, EXIT_CODE.STRUCTURAL);
});

test("global precedence: ERROR outranks FAIL", () => {
  const reports = stormFor("A-webgpu");
  reports.frame.status = "ERROR";
  delete reports.frame.setup;
  delete reports.frame.route;
  const result = adjudicate(reports);
  assert.equal(signal(result, "A-webgpu").verdict, "FAIL");
  assert.equal(signal(result, "F").verdict, "ERROR");
  assert.equal(result.status, "ERROR");
});

test("PERF_GATE_BARS and every nested bar record are frozen", () => {
  assert.equal(Object.isFrozen(PERF_GATE_BARS), true);
  for (const value of Object.values(PERF_GATE_BARS)) {
    assert.equal(Object.isFrozen(value), true);
  }
  const reports = stormFor("A-webgpu");
  const before = adjudicate(reports);
  assert.throws(() => {
    PERF_GATE_BARS.signalA.maxPctExclusive = justAbove(
      PERF_GATE_BARS.signalA.maxPctExclusive,
    );
  }, TypeError);
  const after = adjudicate(reports);
  assert.equal(signal(before, "A-webgpu").verdict, "FAIL");
  assert.equal(signal(after, "A-webgpu").verdict, "FAIL");
  assert.equal(signal(after, "A-webgpu").bar, signal(before, "A-webgpu").bar);
});

test("runner source assertions normalize both EOL forms before matching", () => {
  const lf = normalizedRunnerSource();
  const crlfMirror = lf.replaceAll("\n", "\r\n");
  assert.equal(crlfMirror.replaceAll("\r\n", "\n"), lf);
  assert.match(lf, /export function adjudicatePerfRegressionGate/u);
});

test("all executable mutant modules were removed", () => {
  const leftovers = fs
    .readdirSync(HERE)
    .filter((name) => name.startsWith(TEMP_PREFIX) && name.endsWith(".mjs"));
  assert.deepEqual(leftovers, []);
});

test("every frozen bar still equals the banked derivation it claims", () => {
  // The derivation lives in the runner so it can be mutated like any other
  // predicate; this test supplies the immutable fixture and requires silence.
  assert.deepEqual(
    derivationViolations(
      baselineReports(),
      PERF_GATE_BARS,
      RESOURCE_WRITE_FAMILY,
    ),
    [],
  );
});

test("the derivation baseline is a checked-in fixture, never a live-run output path", () => {
  assert.deepEqual(BASELINE.problems, []);
  assert.equal(fs.existsSync(BASELINE_FIXTURE_PATH), true);
  assert.equal(BASELINE.fixture.immutable, true);

  const fixture = path.resolve(BASELINE_FIXTURE_PATH);
  const fixtureDirectory = path.resolve(path.dirname(BASELINE_FIXTURE_PATH));
  const outputRoot = path.resolve(path.join(HERE, "output"));
  assert.equal(fixture.startsWith(`${outputRoot}${path.sep}`), false);

  // Nothing this gate or its children write may be the fixture, or live under
  // the fixture directory. This is the tooth the 2026-08-25 overwrite needed.
  const liveTargets = [...LIVE_WRITE_PATHS, ...Object.values(REPORT_PATHS)].map(
    (entry) => path.resolve(entry),
  );
  for (const live of liveTargets) {
    assert.notEqual(live, fixture, `${live} is the baseline fixture`);
    assert.equal(
      live.startsWith(`${fixtureDirectory}${path.sep}`),
      false,
      `${live} lives under the baseline directory`,
    );
  }
  assert.deepEqual(baselineCollisions(), []);
  assert.doesNotThrow(() => assertBaselineIsolation());
});

test("the fixture records what was recovered verbatim and what was projected", () => {
  assert.deepEqual(BASELINE.problems, []);
  for (const key of ["cpu", "request", "backend"]) {
    const record = BASELINE.fixture.provenance[key];
    assert.equal(record.recovery, "RECOVERED-VERBATIM", key);
    assert.equal(record.selfVerifiable, true, key);
    assert.equal(record.serialization, "JSON.stringify(report, null, 2)", key);
    assert.equal(
      digest(JSON.stringify(BASELINE.reports[key], null, 2)),
      record.sourceSha256,
      `${key} no longer hashes to the banked artifact it claims to be`,
    );
  }

  // The frame report is embedded as a LOSSY projection, so its full-file digest
  // is recorded but NOT re-derivable here. The fixture has to say so in its own
  // text rather than look clean.
  const frame = BASELINE.fixture.provenance.frame;
  assert.equal(frame.recovery, "RECOVERED-PROJECTED");
  assert.equal(frame.selfVerifiable, false);
  assert.equal(typeof frame.notSelfVerifiableBecause, "string");
  assert.ok(frame.notSelfVerifiableBecause.length > 0);
  assert.notEqual(frame.projectionSha256, frame.sourceSha256);
  assert.equal(
    digest(JSON.stringify(BASELINE.reports.frame, null, 2)),
    frame.projectionSha256,
  );
  assert.ok(frame.droppedTopLevelKeys.length > 0);
  assert.ok(
    frame.retainedFieldPaths.includes("route.frameRecords[].coverageRatio"),
  );

  // Honesty about provenance is the point: the unrecoverable and the merely
  // unverified are both named in the fixture, not implied by its absence.
  assert.ok(BASELINE.fixture.notRecovered.length > 0);
  assert.ok(BASELINE.fixture.openObservations.length > 0);
});

test("write guard: the gate refuses any destination outside its frozen live-write set", () => {
  assert.throws(() => assertLiveWriteTarget(BASELINE_FIXTURE_PATH), RangeError);
  assert.throws(
    () =>
      assertLiveWriteTarget(
        path.join(path.dirname(BASELINE_FIXTURE_PATH), "anything.json"),
      ),
    RangeError,
  );
  for (const live of LIVE_WRITE_PATHS) {
    assert.doesNotThrow(() => assertLiveWriteTarget(live));
  }
});

test("collision tooth 1: a live output directory inside the baseline directory is refused", async () => {
  await withMutant(collideOutputDirectory, async (mutant) => {
    assert.ok(
      mutant.baselineCollisions().length > 0,
      "the injected collision must be detected",
    );
    assert.throws(() => mutant.assertBaselineIsolation(), RangeError);
    // The refusal must land BEFORE the run writes anything at all.
    await assert.rejects(() => mutant.main([]), RangeError);
  });
});

test("collision tooth 2: an inert collision predicate makes the original refusal assertion fail", async () => {
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        collideOutputDirectory(source),
        `  const collisions = baselineCollisions();
  if (collisions.length > 0) {`,
        `  const collisions = baselineCollisions();
  if (false && collisions.length > 0) {`,
      ),
    async (mutant) => {
      assert.ok(
        mutant.baselineCollisions().length > 0,
        "the collision itself must survive the inertness mutation",
      );
      assert.throws(
        () => assert.throws(() => mutant.assertBaselineIsolation(), RangeError),
        (error) => error?.code === "ERR_ASSERTION",
        "the isolation guard stayed live after its predicate was made unreachable",
      );
    },
  );
});

test("write-guard tooth: an inert permit check lets a baseline destination through", async () => {
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "  if (!permitted) {",
        "  if (false && !permitted) {",
      ),
    async (mutant) => {
      assert.throws(
        () =>
          assert.throws(
            () => mutant.assertLiveWriteTarget(BASELINE_FIXTURE_PATH),
            RangeError,
          ),
        (error) => error?.code === "ERR_ASSERTION",
        "the write guard stayed live after its permit check was made unreachable",
      );
    },
  );
});

test("derivation tooth 1: a widened Signal A bar stops equalling the fixture's visibility floor", async () => {
  const reports = baselineReports();
  await withMutant(widenSignalABar, async (mutant) => {
    const violations = mutant.derivationViolations(
      clone(reports),
      mutant.PERF_GATE_BARS,
      mutant.RESOURCE_WRITE_FAMILY,
    );
    assert.ok(
      violations.some((entry) => entry.startsWith("A:")),
      `widened bar produced no A violation: ${violations.join("; ")}`,
    );
  });
});

test("derivation tooth 2: an inert A comparison makes the original violation assertion fail", async () => {
  const reports = baselineReports();
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        widenSignalABar(source),
        "  if (bars.signalA.maxPctExclusive !== minPublished) {",
        "  if (false && bars.signalA.maxPctExclusive !== minPublished) {",
      ),
    async (mutant) => {
      const violations = mutant.derivationViolations(
        clone(reports),
        mutant.PERF_GATE_BARS,
        mutant.RESOURCE_WRITE_FAMILY,
      );
      assert.throws(
        () =>
          assert.ok(
            violations.some((entry) => entry.startsWith("A:")),
            "A stayed live after its comparison was made unreachable",
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    },
  );
});

test("derivation tooth 3: the check reads the fixture, it does not restate the constants", () => {
  // If this went green against a perturbed baseline it would be asserting the
  // bar equals itself -- exactly the failure that let the overwrite through.
  const perturbed = baselineReports();
  perturbed.cpu.webgpuTopSelfTime.push({
    fn: "(derivation liveness probe) @ fixture:1",
    pct: PERF_GATE_BARS.signalA.maxPctExclusive / 2,
    ms: 0,
  });
  const aViolations = derivationViolations(perturbed);
  assert.ok(
    aViolations.some((entry) => entry.startsWith("A:")),
    `perturbed profile produced no A violation: ${aViolations.join("; ")}`,
  );

  const shifted = baselineReports();
  shifted.backend.verdicts.webgpu_over_webgl_render_ms_ratio += 1;
  const eViolations = derivationViolations(shifted);
  assert.ok(
    eViolations.some((entry) => entry.startsWith("E:")),
    `perturbed backend ratio produced no E violation: ${eViolations.join("; ")}`,
  );

  // The B/C and D legs CANNOT be fixture-live, and saying so is the point:
  // 2/n < 3/n holds and 3/n < 3/n fails for every positive n, so shortening the
  // banked series moves nothing, and D's bar is the constant 0. Those two legs
  // are properties of the numerator and of the census argument, so they are
  // mutation-tested against the runner below instead of pretended to be checked
  // here.
  const shortened = baselineReports();
  shortened.request.webgpu.laneA.pendingForegroundSeries =
    shortened.request.webgpu.laneA.pendingForegroundSeries.slice(0, 2);
  assert.deepEqual(
    derivationViolations(shortened).filter((entry) => entry.startsWith("B/C:")),
    [],
    "the Rule-of-Three leg is n-independent by construction",
  );
});

test("derivation tooth 4: the n-independent legs are still mutation-tested at the runner", async () => {
  const reports = baselineReports();
  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        `numerator: ${PERF_GATE_BARS.ruleOfThree.numerator},`,
        `numerator: ${PERF_GATE_BARS.ruleOfThree.numerator + 1},`,
      ),
    async (mutant) => {
      const violations = mutant.derivationViolations(
        clone(reports),
        mutant.PERF_GATE_BARS,
        mutant.RESOURCE_WRITE_FAMILY,
      );
      assert.ok(
        violations.some((entry) => entry.startsWith("B/C:")),
        `widened numerator produced no B/C violation: ${violations.join("; ")}`,
      );
    },
  );

  await withMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        `requiredWebglNonNull: ${PERF_GATE_BARS.signalD.requiredWebglNonNull},`,
        `requiredWebglNonNull: ${PERF_GATE_BARS.signalD.requiredWebglNonNull + 1},`,
      ),
    async (mutant) => {
      const violations = mutant.derivationViolations(
        clone(reports),
        mutant.PERF_GATE_BARS,
        mutant.RESOURCE_WRITE_FAMILY,
      );
      assert.ok(
        violations.some((entry) => entry.startsWith("D:")),
        `moved census bar produced no D violation: ${violations.join("; ")}`,
      );
    },
  );
});

test("the three network-dependent children are pinned to the deterministic offline scene", () => {
  const source = normalizedRunnerSource();
  // Tile count moves with the network, and Signal A judges a share of self time
  // against a frozen bar, so the scene those children boot has to be pinned.
  assert.match(source, /const OFFLINE_ENV_KEY = "PROBE_VIEWER_OFFLINE";/u);
  assert.equal(
    (source.match(/offlinePin: "gate-env",/gu) ?? []).length,
    3,
    "exactly the three CesiumViewer children carry the gate-set pin",
  );
  assert.equal(
    (source.match(/offlinePin: "self",/gu) ?? []).length,
    1,
    "the frame probe pins offline=true in its own URL",
  );
  assert.match(source, /\[OFFLINE_ENV_KEY\]: "1"/u);

  for (const probe of [
    "probe-backend-isolation.mjs",
    "probe-request-render-asymmetry.mjs",
    "probe-cpu-sampling-profile.mjs",
  ]) {
    const probeSource = fs
      .readFileSync(path.join(HERE, probe), "utf8")
      .replaceAll("\r\n", "\n");
    assert.match(
      probeSource,
      /process\.env\.PROBE_VIEWER_OFFLINE === "1" \? "&offline=true" : ""/u,
      `${probe} does not honour the offline pin`,
    );
    assert.match(
      probeSource,
      /index\.html\?renderer=\$\{[a-z]+\}\$\{VIEWER_OFFLINE_QUERY\}`|index\.html\?renderer=webgpu\$\{VIEWER_OFFLINE_QUERY\}`/u,
      `${probe} does not append the pin to its viewer URL`,
    );
  }
  assert.match(
    fs
      .readFileSync(path.join(HERE, "probe-webgpu-frame-breakdown.mjs"), "utf8")
      .replaceAll("\r\n", "\n"),
    /index\.html\?renderer=webgpu&offline=true/u,
  );
});

test("acquisition consumes each probe as a sequential child process, never by import", () => {
  // Three of the four probes execute on import, so consuming one as a module
  // would launch Edge inside this process; concurrent Edge instances are a
  // recorded machine-safety hazard. This is a source-shape guard, not a
  // behavioural one: the acquisition loop is unreachable without a dev server.
  const source = normalizedRunnerSource();
  assert.match(source, /spawn\(process\.execPath,/u);
  assert.match(source, /const child = await spawnProbe\(/u);
  assert.equal(/Promise\.(?:all|allSettled|race|any)\b/u.test(source), false);
  assert.equal(/await import\(/u.test(source), false);
});
