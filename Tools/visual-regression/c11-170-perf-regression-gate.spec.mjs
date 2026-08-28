// C11-170 gate policy tests. Pure Node: no browser, network, or probe process.

import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

import {
  adjudicateMultiMetricGate,
  adjudicatePerfRegressionGate,
  assertBaselineIsolation,
  assertLiveWriteTarget,
  baselineCollisions,
  derivationViolations,
  evaluateEvidenceFreshness,
  LIVE_WRITE_PATHS,
  NOISE_FIXTURE_PATH,
  PERF_GATE_BARS,
  RESOURCE_WRITE_FAMILY,
  ruleOfThreeBound,
} from "./probe-perf-regression-gate.mjs";
import {
  adjudicateMetricVector,
  allocationMetrics,
  churnBound,
  memoryMetrics,
  metricBarViolations,
  metricVector,
  minimumAchievablePValue,
  noiseViolations,
  PERF_METRIC_BARS,
  PERF_METRIC_NOISE,
  rankTestMinimumRunsPerArm,
  RESOURCE_WRITE_SUBFAMILIES,
  selfTimeMetrics,
} from "./lib/perf-metric-vector.mjs";
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

const MAIN_METRIC_SIGNAL_IDS = Object.freeze([
  "M1-webgpu",
  "M1-webgl",
  "M2-webgpu",
  "M2-webgl",
  "M3",
  "M4-webgpu",
  "M4-webgl",
  "M5-webgpu",
  "M5-webgl",
]);

function redirectOutputDirectory(source, outputDirectory) {
  return replaceExactlyOnce(
    source,
    'const OUTPUT_DIRECTORY = path.join(__dirname, "output", "performance");',
    `const OUTPUT_DIRECTORY = ${JSON.stringify(outputDirectory)};`,
  );
}

function revertProductionMetricSeam(source) {
  return replaceExactlyOnce(
    source,
    "    const adjudication = adjudicateMultiMetricGate({",
    "    const adjudication = adjudicatePerfRegressionGate({",
  );
}

function inertProductionMetricSeam(source) {
  return replaceExactlyOnce(
    source,
    "    const adjudication = adjudicateMultiMetricGate({",
    `    const adjudication = (false
      ? adjudicateMultiMetricGate
      : adjudicatePerfRegressionGate)({`,
  );
}

async function withSandboxedMain(transform, use) {
  const prefix = "c11-170-main-seam-";
  const outputDirectory = fs.mkdtempSync(path.join(tmpdir(), prefix));
  const previousExitCode = process.exitCode;
  let mainCompleted = false;
  try {
    const result = await withMutant(
      (source) => transform(redirectOutputDirectory(source, outputDirectory)),
      async (mutant) => {
        assert.deepEqual(
          mutant.baselineCollisions(),
          [],
          "redirected writes must remain isolated from the baseline",
        );
        for (const target of mutant.LIVE_WRITE_PATHS.slice(0, 2)) {
          assert.equal(path.dirname(target), outputDirectory);
          assert.doesNotThrow(() => mutant.assertLiveWriteTarget(target));
        }
        const artifact = await mutant.main(["--adjudicate-only"]);
        return use(artifact);
      },
    );
    mainCompleted = true;
    return result;
  } finally {
    process.exitCode = previousExitCode;
    if (mainCompleted) {
      assert.equal(
        fs.existsSync(
          path.join(outputDirectory, "c11-170-perf-regression-gate.json"),
        ),
        true,
        "main() did not write its redirected artifact",
      );
    }
    const tempRelative = path.relative(path.resolve(tmpdir()), outputDirectory);
    assert.ok(
      tempRelative !== "" &&
        !tempRelative.startsWith("..") &&
        !path.isAbsolute(tempRelative) &&
        path.basename(outputDirectory).startsWith(prefix),
      `refusing unsafe test cleanup target ${outputDirectory}`,
    );
    fs.rmSync(outputDirectory, { recursive: true });
    assert.equal(
      fs.existsSync(outputDirectory),
      false,
      `${outputDirectory} survived cleanup`,
    );
  }
}

function assertMainMetricSeam(artifact) {
  assert.ok(artifact.metricVector, "main() omitted metricVector");
  assert.ok(artifact.metricBars, "main() omitted metricBars");
  assert.ok(artifact.metricNoise, "main() omitted metricNoise");
  const metricIds = artifact.signals
    .filter((entry) => entry.id.startsWith("M"))
    .map((entry) => entry.id);
  assert.deepEqual(metricIds, MAIN_METRIC_SIGNAL_IDS);
  assert.deepEqual(
    [...new Set(metricIds.map((id) => id.split("-", 1)[0]))],
    ["M1", "M2", "M3", "M4", "M5"],
  );
}

function assertMainMetricSeamAbsent(artifact) {
  assert.equal(artifact.metricVector, null);
  assert.deepEqual(
    artifact.signals.filter((entry) => entry.id.startsWith("M")),
    [],
  );
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

test("production tooth: main() reaches the multi-metric seam, and absent or inert seams do not", async () => {
  await withSandboxedMain(
    (source) => source,
    async (artifact) => assertMainMetricSeam(artifact),
  );

  for (const [label, transform] of [
    ["absent", revertProductionMetricSeam],
    ["inert", inertProductionMetricSeam],
  ]) {
    await withSandboxedMain(transform, async (artifact) => {
      assert.throws(
        () => assertMainMetricSeam(artifact),
        (error) => error?.code === "ERR_ASSERTION",
        `${label} production seam still carried the metric vector`,
      );
      assertMainMetricSeamAbsent(artifact);
    });
  }
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

// ---------------------------------------------------------------------------
// THE MULTI-METRIC VECTOR (maintainer ruling, 2026-08-25).
//
// "Focusing on one metric might be misleading." The C11-170 gate scored a
// re-upload regression on the resource-write family's share of SELF TIME, and
// the clean-build control that day showed that number moving about 2x between
// identical runs purely with idle share. The ruling is BOTH: keep Signal A,
// and carry counts, timings, allocation and memory beside it.
//
// Every tooth below EXECUTES the adjudicator or the derivation predicate. None
// of them reads source text for a shape. Each family also carries an INERTNESS
// form -- the fix is made unreachable with `false &&` rather than deleted --
// because deleting code is the easy mutation and most specs survive it.
// ---------------------------------------------------------------------------

const METRIC_LIB_PATH = path.join(HERE, "lib", "perf-metric-vector.mjs");

function normalizedMetricSource() {
  return fs.readFileSync(METRIC_LIB_PATH, "utf8").replaceAll("\r\n", "\n");
}

async function withMetricMutant(transform, use) {
  const file = path.join(HERE, `${TEMP_PREFIX}${randomUUID()}.mjs`);
  const source = normalizedMetricSource();
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

function loadNoiseFixture() {
  return readJson(NOISE_FIXTURE_PATH);
}

function metricSignalsFor(reports, options = {}) {
  const vector = metricVector(reports, RESOURCE_WRITE_FAMILY);
  return adjudicateMetricVector(
    { mode: options.mode ?? "acquire", reports, vector },
    {
      reportProblem: options.reportProblem ?? (() => null),
      ruleOfThreeNumerator:
        options.numerator ?? PERF_GATE_BARS.ruleOfThree.numerator,
    },
  );
}

function metricSignal(signals, id) {
  const found = signals.find((entry) => entry.id === id);
  assert.ok(found, `missing metric signal ${id}`);
  return found;
}

function multiMetric(reports, options = {}) {
  const mode = options.mode ?? "acquire";
  return adjudicateMultiMetricGate({
    mode,
    reports,
    freshness: options.freshness ?? (mode === "acquire" ? allFresh() : {}),
    reportProblems: options.reportProblems ?? {},
    harnessErrors: options.harnessErrors ?? [],
    structuralReasons: options.structuralReasons ?? [],
  });
}

/**
 * A report set in which EVERY axis of the vector is measured. Nothing else in
 * this spec can produce a PASS from the multi-metric gate, which is the point:
 * a gate blind on an axis must not claim a performance verdict.
 *
 * @returns {object} The four reports with counts, allocation and memory present.
 */
function completeMetricReports() {
  const reports = minimalReports();
  const frames = trialCount() * 3;
  reports.cpu.frames = frames;
  reports.cpu.webgpuTopSelfTime = [
    { fn: "(idle) @ fixture:0", pct: 60, ms: 600 },
    { fn: "(program) @ fixture:1", pct: 20, ms: 200 },
    { fn: "createTileCommands @ fixture:2", pct: 0.5, ms: 5 },
    { fn: "(garbage collector) @ fixture:3", pct: 0.2, ms: 2 },
  ];
  reports.cpu.webglTopSelfTime = [
    { fn: "(idle) @ fixture:0", pct: 62, ms: 620 },
    { fn: "(program) @ fixture:1", pct: 18, ms: 180 },
    { fn: "continueDraw @ fixture:2", pct: 0.4, ms: 4 },
    { fn: "(garbage collector) @ fixture:3", pct: 0.25, ms: 2.5 },
  ];
  for (const backend of ["webgpu", "webgl"]) {
    reports.cpu[backend].allocation = {
      gcSelfMs: 2,
      gcSelfPct: 0.2,
      source: "full-aggregate",
    };
    reports.cpu[backend].memory = {
      jsHeapUsedBytesBefore: 100000000,
      jsHeapUsedBytesAfter: 100500000,
      jsHeapTotalBytesAfter: 180000000,
    };
    reports.request[backend].laneA.renderMs = Array.from(
      { length: frames },
      (unused, index) => 1 + (index % 3) * 0.1,
    );
    reports.request[backend].laneB = {
      requestRenderMode: false,
      renderMs: Array.from(
        { length: frames },
        (unused, index) => 0.9 + (index % 3) * 0.1,
      ),
    };
  }
  for (const lane of reports.backend.lanes) {
    if (lane.name === "split") {
      continue;
    }
    lane.frameMs = {
      n: frames,
      median: 1,
      p95: 1.2,
      min: 0.8,
      max: 2,
      mean: 1.05,
    };
    lane.resourceWrites = {
      frames,
      warmupFrames: 60,
      textureCallsTotal: 0,
      textureFramesNonZero: 0,
      bufferCallsTotal: frames * 2,
      bufferFramesNonZero: frames,
      bufferPerFrame: Array.from({ length: frames }, () => 2),
      texturePerFrame: Array.from({ length: frames }, () => 0),
      totals: { writeBuffer: frames * 2 },
      wrapped: ["GPUQueue.writeBuffer", "GPUQueue.copyExternalImageToTexture"],
      unwrappable: RESOURCE_WRITE_SUBFAMILIES.texture.slice(1),
    };
  }
  return reports;
}

test("the vector publishes every axis the ruling names, scored or not", () => {
  const vector = metricVector(baselineReports(), RESOURCE_WRITE_FAMILY);
  assert.deepEqual(Object.keys(vector).sort(), [
    "allocation",
    "churn",
    "dispersion",
    "memory",
    "selfTime",
  ]);
  // Counts, timings, memory and allocation, together -- the ruling's own list.
  const signals = metricSignalsFor(baselineReports());
  assert.deepEqual(
    signals.map((entry) => entry.id),
    [
      "M1-webgpu",
      "M1-webgl",
      "M2-webgpu",
      "M2-webgl",
      "M3",
      "M4-webgpu",
      "M4-webgl",
      "M5-webgpu",
      "M5-webgl",
    ],
  );
});

test("every metric bar states its own noise behaviour and how many runs a verdict needs", () => {
  const noiseByMetric = [
    ["churn", PERF_METRIC_NOISE.churnCounts],
    ["normalizedSelfTime", PERF_METRIC_NOISE.selfTimeShare],
    ["dispersion", PERF_METRIC_NOISE.dispersion],
    ["allocation", PERF_METRIC_NOISE.allocation],
    ["memory", PERF_METRIC_NOISE.memory],
  ];
  for (const [key, noise] of noiseByMetric) {
    const bar = PERF_METRIC_BARS[key];
    assert.ok(bar, `no bar record for ${key}`);
    assert.ok(bar.derivation.length > 80, `${key} bar has no derivation`);
    assert.ok(Array.isArray(bar.sourceRows) && bar.sourceRows.length > 0, key);
    assert.ok(noise.behaviour.length > 40, `${key} noise is not characterised`);
    assert.ok(noise.runsForVerdict.length > 10, `${key} names no run count`);
    assert.ok(Array.isArray(noise.evidence) && noise.evidence.length > 0, key);
  }
  // Each adjudicated signal carries its metric's noise statement with it, so a
  // reader of the artifact never sees a bar without its noise behaviour.
  for (const entry of metricSignalsFor(baselineReports())) {
    assert.equal(typeof entry.noise, "string", `${entry.id} has no noise note`);
    assert.ok(entry.noise.length > 40, `${entry.id} noise note is empty`);
  }
});

test("M1 churn: the bound comes from the run's own frame count, and a storm reds it", () => {
  const clean = completeMetricReports();
  const cleanSignal = metricSignal(metricSignalsFor(clean), "M1-webgpu");
  assert.equal(cleanSignal.verdict, "PASS");
  assert.equal(
    cleanSignal.bar,
    churnBound(
      clean.backend.lanes[0].resourceWrites.frames,
      PERF_GATE_BARS.ruleOfThree.numerator,
    ),
  );
  assert.equal(cleanSignal.observed.rate, 0);

  // The Batch-717 signature is a COUNT: one texture write per frame in a
  // settled scene. It must red even though its self-time share may be zero.
  const storm = completeMetricReports();
  const lane = storm.backend.lanes.find(
    (entry) => entry.name === "webgpu-solo",
  );
  lane.resourceWrites.textureFramesNonZero = lane.resourceWrites.frames;
  lane.resourceWrites.textureCallsTotal = lane.resourceWrites.frames;
  const stormSignal = metricSignal(metricSignalsFor(storm), "M1-webgpu");
  assert.equal(stormSignal.verdict, "FAIL");
  assert.equal(
    metricSignal(metricSignalsFor(storm), "M1-webgl").verdict,
    "PASS",
  );
  // Signal A is untouched by the storm: the count sees what the share cannot.
  assert.equal(signal(adjudicate(storm), "A-webgpu").verdict, "PASS");
  assert.equal(multiMetric(storm).status, "FAIL");
});

test("M1 coverage: zero wrapped texture members is STRUCTURAL, while one wrapped member scores", () => {
  const blindReports = completeMetricReports();
  const blindLane = blindReports.backend.lanes.find(
    (entry) => entry.name === "webgpu-solo",
  );
  blindLane.resourceWrites.wrapped = ["GPUQueue.writeBuffer"];
  blindLane.resourceWrites.unwrappable = [
    ...RESOURCE_WRITE_SUBFAMILIES.texture,
  ];
  const blind = metricSignal(metricSignalsFor(blindReports), "M1-webgpu");
  assert.equal(blind.verdict, "STRUCTURAL");
  assert.match(blind.reason, /instrument-blind/);
  assert.deepEqual(blind.observed.wrapped, ["GPUQueue.writeBuffer"]);
  assert.deepEqual(blind.observed.wrappedTextureMembers, []);
  assert.deepEqual(
    blind.observed.unwrappableTextureMembers,
    RESOURCE_WRITE_SUBFAMILIES.texture,
  );
  assert.equal(multiMetric(blindReports).status, "STRUCTURAL");

  const measuredReports = clone(blindReports);
  const measuredLane = measuredReports.backend.lanes.find(
    (entry) => entry.name === "webgpu-solo",
  );
  measuredLane.resourceWrites.wrapped.push("GPUQueue.writeTexture");
  measuredLane.resourceWrites.unwrappable =
    measuredLane.resourceWrites.unwrappable.filter(
      (name) => name !== "writeTexture",
    );
  const measured = metricSignal(metricSignalsFor(measuredReports), "M1-webgpu");
  assert.equal(measured.verdict, "PASS");
  assert.equal(measured.observed.rate, 0);
  assert.deepEqual(measured.observed.wrappedTextureMembers, ["writeTexture"]);
});

test("M1 coverage tooth: an inert observability guard lets total texture blindness pass", async () => {
  const blindReports = completeMetricReports();
  const blindLane = blindReports.backend.lanes.find(
    (entry) => entry.name === "webgpu-solo",
  );
  blindLane.resourceWrites.wrapped = ["GPUQueue.writeBuffer"];
  blindLane.resourceWrites.unwrappable = [
    ...RESOURCE_WRITE_SUBFAMILIES.texture,
  ];
  const guardBlock = [
    "  if (wrappedTextureMembers.length === 0) {",
    "    reasons.push(",
    "      `${laneName}.resourceWrites wrapped no texture sub-family member: the churn census is instrument-blind even if it reports a zero rate`,",
    "    );",
    "  }",
  ].join("\n");
  for (const [label, transform] of [
    ["absent", (source) => replaceExactlyOnce(source, guardBlock, "")],
    [
      "inert",
      (source) =>
        replaceExactlyOnce(
          source,
          "  if (wrappedTextureMembers.length === 0) {",
          "  if (false && wrappedTextureMembers.length === 0) {",
        ),
    ],
  ]) {
    await withMetricMutant(transform, async (mutant) => {
      const vector = mutant.metricVector(blindReports, RESOURCE_WRITE_FAMILY);
      const signals = mutant.adjudicateMetricVector(
        { mode: "acquire", reports: blindReports, vector },
        {
          reportProblem: () => null,
          ruleOfThreeNumerator: PERF_GATE_BARS.ruleOfThree.numerator,
        },
      );
      const escaped = metricSignal(signals, "M1-webgpu");
      assert.equal(escaped.verdict, "PASS", label);
      assert.equal(escaped.observed.rate, 0, label);
      assert.deepEqual(escaped.observed.wrappedTextureMembers, [], label);
    });
  }

  const measuredReports = clone(blindReports);
  const measuredLane = measuredReports.backend.lanes.find(
    (entry) => entry.name === "webgpu-solo",
  );
  measuredLane.resourceWrites.wrapped.push("GPUQueue.writeTexture");
  measuredLane.resourceWrites.unwrappable =
    measuredLane.resourceWrites.unwrappable.filter(
      (name) => name !== "writeTexture",
    );
  await withMetricMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        '  return fn.split(" @ ", 1)[0].split(".").at(-1);',
        '  return fn.split(" @ ", 1)[0];',
      ),
    async (mutant) => {
      const vector = mutant.metricVector(
        measuredReports,
        RESOURCE_WRITE_FAMILY,
      );
      const signals = mutant.adjudicateMetricVector(
        { mode: "acquire", reports: measuredReports, vector },
        {
          reportProblem: () => null,
          ruleOfThreeNumerator: PERF_GATE_BARS.ruleOfThree.numerator,
        },
      );
      assert.equal(
        metricSignal(signals, "M1-webgpu").verdict,
        "STRUCTURAL",
        "reverting final-component normalisation did not kill the positive control",
      );
    },
  );
});

test("M1 churn: three storm frames red, two do not -- the Rule-of-Three shape", () => {
  for (const [nonZero, expected] of [
    [2, "PASS"],
    [3, "FAIL"],
  ]) {
    const reports = completeMetricReports();
    const lane = reports.backend.lanes.find(
      (entry) => entry.name === "webgpu-solo",
    );
    lane.resourceWrites.frames = PERF_GATE_BARS.ruleOfThree.numerator;
    lane.resourceWrites.textureFramesNonZero = nonZero;
    lane.resourceWrites.textureCallsTotal = nonZero;
    lane.resourceWrites.bufferPerFrame = [1, 1, 1];
    lane.resourceWrites.texturePerFrame = [1, 1, 1];
    assert.equal(
      metricSignal(metricSignalsFor(reports), "M1-webgpu").verdict,
      expected,
      `${nonZero} of ${PERF_GATE_BARS.ruleOfThree.numerator}`,
    );
  }
});

test("M1 churn tooth: an inert comparison lets a per-frame storm through", async () => {
  const storm = completeMetricReports();
  const lane = storm.backend.lanes.find(
    (entry) => entry.name === "webgpu-solo",
  );
  lane.resourceWrites.textureFramesNonZero = lane.resourceWrites.frames;
  lane.resourceWrites.textureCallsTotal = lane.resourceWrites.frames;
  await withMetricMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "    const pass = rate < bound;",
        "    const pass = true || rate < bound;",
      ),
    async (mutant) => {
      const vector = mutant.metricVector(storm, RESOURCE_WRITE_FAMILY);
      const signals = mutant.adjudicateMetricVector(
        { mode: "acquire", reports: storm, vector },
        {
          reportProblem: () => null,
          ruleOfThreeNumerator: PERF_GATE_BARS.ruleOfThree.numerator,
        },
      );
      assert.throws(
        () =>
          assert.equal(
            metricSignal(signals, "M1-webgpu").verdict,
            "FAIL",
            "the churn comparison stayed live after it was made unreachable",
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    },
  );
});

test("M1 derivation: the sub-families partition the resource-write family exactly", () => {
  const union = [
    ...RESOURCE_WRITE_SUBFAMILIES.texture,
    ...RESOURCE_WRITE_SUBFAMILIES.buffer,
  ];
  assert.equal(new Set(union).size, union.length);
  assert.deepEqual([...union].sort(), [...RESOURCE_WRITE_FAMILY].sort());
  assert.deepEqual(
    metricBarViolations(
      baselineReports(),
      PERF_METRIC_BARS,
      RESOURCE_WRITE_SUBFAMILIES,
      RESOURCE_WRITE_FAMILY,
    ),
    [],
  );
});

test("M1 derivation tooth: a dropped family member is named, and an inert check hides it", async () => {
  const dropMember = (source) =>
    replaceExactlyOnce(source, '    "writeTexture",\n', "");
  await withMetricMutant(dropMember, async (mutant) => {
    const violations = mutant.metricBarViolations(
      baselineReports(),
      mutant.PERF_METRIC_BARS,
      mutant.RESOURCE_WRITE_SUBFAMILIES,
      RESOURCE_WRITE_FAMILY,
    );
    assert.ok(
      violations.some((entry) => entry.startsWith("M1:")),
      `dropping a family member produced no M1 violation: ${violations.join("; ")}`,
    );
  });
  await withMetricMutant(
    (source) =>
      replaceExactlyOnce(
        dropMember(source),
        "    if (missing.length > 0) {",
        "    if (false && missing.length > 0) {",
      ),
    async (mutant) => {
      const violations = mutant.metricBarViolations(
        baselineReports(),
        mutant.PERF_METRIC_BARS,
        mutant.RESOURCE_WRITE_SUBFAMILIES,
        RESOURCE_WRITE_FAMILY,
      );
      assert.throws(
        () =>
          assert.ok(
            violations.some((entry) => entry.startsWith("M1:")),
            "the partition check stayed live after it was made unreachable",
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    },
  );
});

test("M2 normalisation: the idle term is removed, and the banked numbers prove why it matters", () => {
  const leaf = selfTimeMetrics(
    baselineReports().cpu,
    "webgpu",
    RESOURCE_WRITE_FAMILY,
  );
  assert.equal(leaf.available, true);
  assert.equal(leaf.idlePct, 68.688);
  assert.equal(leaf.programPct, 16.417);
  assert.equal(leaf.namedWorkPct, 100 - 68.688 - 16.417);
  // The visibility floor Signal A is frozen against is 1.30 % of named work,
  // not 0.193 % of it. Publishing both is the whole point of the ruling.
  assert.equal(
    leaf.visibilityFloorNormalizedPct,
    (leaf.visibilityFloorPct / leaf.namedWorkPct) * 100,
  );
});

test("M2 blindness: a profile with no (idle) row is STRUCTURAL, never a skip", () => {
  const reports = completeMetricReports();
  reports.cpu.webgpuTopSelfTime = reports.cpu.webgpuTopSelfTime.filter(
    (row) => !row.fn.startsWith("(idle)"),
  );
  const entry = metricSignal(metricSignalsFor(reports), "M2-webgpu");
  assert.equal(entry.verdict, "STRUCTURAL");
  assert.match(entry.reason, /publishes no \(idle\) row/);
  assert.equal(multiMetric(reports).status, "STRUCTURAL");
});

test("M2 blindness tooth: an inert idle check reports a normalisation that cannot exist", async () => {
  const reports = completeMetricReports();
  reports.cpu.webgpuTopSelfTime = reports.cpu.webgpuTopSelfTime.filter(
    (row) => !row.fn.startsWith("(idle)"),
  );
  await withMetricMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "  if (!idleRow) {",
        "  if (false && !idleRow) {",
      ),
    async (mutant) => {
      const vector = mutant.metricVector(reports, RESOURCE_WRITE_FAMILY);
      const signals = mutant.adjudicateMetricVector(
        { mode: "acquire", reports, vector },
        {
          reportProblem: () => null,
          ruleOfThreeNumerator: PERF_GATE_BARS.ruleOfThree.numerator,
        },
      );
      assert.throws(
        () =>
          assert.equal(
            metricSignal(signals, "M2-webgpu").verdict,
            "STRUCTURAL",
            "the idle-row blindness check stayed live after it was made unreachable",
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    },
  );
});

test("M3 dispersion: the provisional bound is the Signal E construction over the banked lanes", () => {
  const vector = metricVector(baselineReports(), RESOURCE_WRITE_FAMILY);
  const leaf = vector.dispersion;
  assert.equal(leaf.available, true);
  assert.equal(leaf.scored, false);
  const all = leaf.observations.map((entry) => entry.ratio);
  const subjects = leaf.observations
    .filter((entry) => entry.subject)
    .map((entry) => entry.ratio);
  assert.equal(
    leaf.provisionalBound,
    Math.max(...subjects) * (Math.max(...all) / Math.min(...all)),
  );
  // Published, never scored: the verdict must not depend on the bound.
  const entry = metricSignal(metricSignalsFor(baselineReports()), "M3");
  assert.equal(entry.kind, "observability");
  assert.equal(entry.verdict, "PASS");
  assert.match(entry.reason, /PROVISIONAL, unscored/);
});

test("M3 derivation tooth: a widened bound is named, and an inert check hides it", async () => {
  const widen = (source) =>
    replaceExactlyOnce(
      source,
      "    provisionalMaxRatioInclusive: 1.9151785715284921,",
      `    provisionalMaxRatioInclusive: ${justAbove(1.9151785715284921)},`,
    );
  await withMetricMutant(widen, async (mutant) => {
    const violations = mutant.metricBarViolations(
      baselineReports(),
      mutant.PERF_METRIC_BARS,
      mutant.RESOURCE_WRITE_SUBFAMILIES,
      RESOURCE_WRITE_FAMILY,
    );
    assert.ok(
      violations.some((entry) => entry.startsWith("M3:")),
      `widened bound produced no M3 violation: ${violations.join("; ")}`,
    );
  });
  await withMetricMutant(
    (source) =>
      replaceExactlyOnce(
        widen(source),
        "    if (bars.dispersion.provisionalMaxRatioInclusive !== derived) {",
        "    if (false && bars.dispersion.provisionalMaxRatioInclusive !== derived) {",
      ),
    async (mutant) => {
      const violations = mutant.metricBarViolations(
        baselineReports(),
        mutant.PERF_METRIC_BARS,
        mutant.RESOURCE_WRITE_SUBFAMILIES,
        RESOURCE_WRITE_FAMILY,
      );
      assert.throws(
        () =>
          assert.ok(
            violations.some((entry) => entry.startsWith("M3:")),
            "the dispersion derivation stayed live after it was made unreachable",
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    },
  );
});

test("M4 allocation: censoring is reported as censoring, with the bound that proves it cannot discriminate", () => {
  const reports = baselineReports();
  // WebGPU publishes the row; WebGL does not, and the difference is the finding.
  assert.equal(allocationMetrics(reports.cpu, "webgpu").censored, false);
  const censored = allocationMetrics(reports.cpu, "webgl");
  assert.equal(censored.censored, true);
  assert.equal(censored.available, false);
  assert.equal(censored.upperBoundPct, censored.censoringFloorPct);
  assert.ok(censored.upperBoundMsPerFrame > 0);
  assert.equal(
    metricSignal(metricSignalsFor(reports), "M4-webgl").verdict,
    "STRUCTURAL",
  );

  // The producer's uncensored field is what repairs the axis.
  const repaired = clone(reports);
  repaired.cpu.webgl.allocation = {
    gcSelfMs: 1,
    gcSelfPct: 0.04,
    source: "full-aggregate",
  };
  const entry = metricSignal(metricSignalsFor(repaired), "M4-webgl");
  assert.equal(entry.verdict, "PASS");
  assert.equal(entry.observed.source, "producer-allocation-field");
  assert.equal(entry.observed.gcMsPerFrame, 1 / repaired.cpu.frames);
});

test("M4 allocation tooth: an inert censoring branch turns a blind axis into a pass", async () => {
  const reports = baselineReports();
  await withMetricMutant(
    (source) =>
      replaceExactlyOnce(source, "  if (gcRow) {", "  if (false && gcRow) {"),
    async (mutant) => {
      const vector = mutant.metricVector(reports, RESOURCE_WRITE_FAMILY);
      const signals = mutant.adjudicateMetricVector(
        { mode: "adjudicate-only", reports, vector },
        {
          reportProblem: () => null,
          ruleOfThreeNumerator: PERF_GATE_BARS.ruleOfThree.numerator,
        },
      );
      assert.throws(
        () =>
          assert.equal(
            metricSignal(signals, "M4-webgpu").verdict,
            "PASS",
            "the published-row branch stayed live after it was made unreachable",
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    },
  );
});

test("M5 memory: absent is blindness, present is published and still not scored", () => {
  assert.equal(memoryMetrics(baselineReports().cpu, "webgpu").available, false);
  const blind = metricSignal(metricSignalsFor(baselineReports()), "M5-webgpu");
  assert.equal(blind.verdict, "STRUCTURAL");
  assert.match(blind.reason, /no banked report in this fleet carries a heap/);

  const measured = metricSignal(
    metricSignalsFor(completeMetricReports()),
    "M5-webgpu",
  );
  assert.equal(measured.verdict, "PASS");
  assert.equal(measured.kind, "observability");
  assert.equal(measured.bar, null);
  assert.equal(measured.observed.deltaBytes, 500000);
});

test("M5 derivation tooth: a banked heap observation makes the no-bar claim stale, and an inert check hides it", async () => {
  const withHeap = baselineReports();
  withHeap.cpu.webgpu.memory = {
    jsHeapUsedBytesBefore: 1,
    jsHeapUsedBytesAfter: 2,
  };
  assert.ok(
    metricBarViolations(
      withHeap,
      PERF_METRIC_BARS,
      RESOURCE_WRITE_SUBFAMILIES,
      RESOURCE_WRITE_FAMILY,
    ).some((entry) => entry.startsWith("M5:")),
  );
  await withMetricMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "    if (memoryMetrics(reports?.cpu, backend).available) {",
        "    if (false && memoryMetrics(reports?.cpu, backend).available) {",
      ),
    async (mutant) => {
      const violations = mutant.metricBarViolations(
        withHeap,
        mutant.PERF_METRIC_BARS,
        mutant.RESOURCE_WRITE_SUBFAMILIES,
        RESOURCE_WRITE_FAMILY,
      );
      assert.throws(
        () =>
          assert.ok(
            violations.some((entry) => entry.startsWith("M5:")),
            "the memory derivation stayed live after it was made unreachable",
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    },
  );
});

test("the noise characterisation is re-derived from a checked-in fixture, not asserted", () => {
  const fixture = loadNoiseFixture();
  assert.equal(fixture.immutable, true);
  assert.deepEqual(noiseViolations(fixture, PERF_METRIC_NOISE), []);
  // The control could not have decided its own question: 2 against 4 cannot
  // reach alpha = 0.05 even with perfect separation, and the arms overlapped.
  assert.equal(fixture.derived.armsOverlap, true);
  assert.ok(
    fixture.derived.minimumAchievablePValue > PERF_METRIC_NOISE.rankTest.alpha,
  );
  assert.equal(minimumAchievablePValue(2, 4), 1 / 15);
  assert.equal(rankTestMinimumRunsPerArm(0.05), 3);
  assert.equal(PERF_METRIC_NOISE.rankTest.minimumRunsPerArm, 3);
});

for (const key of [
  "selfTimeShare",
  "churnCounts",
  "dispersion",
  "allocation",
  "memory",
]) {
  test(`noise binding ${key}: contradiction and missing figure are named, while absent or inert checks let them through`, async () => {
    const fixture = loadNoiseFixture();
    const contradicted = clone(PERF_METRIC_NOISE);
    contradicted[key].behaviour =
      "This metric never moves between identical runs.";
    const missingFigure = clone(PERF_METRIC_NOISE);
    delete missingFigure[key].claim.figure;
    const namesKey = (violations) =>
      violations.some((entry) => entry.startsWith(`${key}:`));

    assert.equal(namesKey(noiseViolations(fixture, contradicted)), true);
    assert.equal(namesKey(noiseViolations(fixture, missingFigure)), true);

    await withMetricMutant(
      (source) =>
        replaceExactlyOnce(
          source,
          "  if (!figureMatches || !behaviourQuotes) {",
          "  if (!figureMatches) {",
        ),
      async (mutant) => {
        const mutantNoise = clone(mutant.PERF_METRIC_NOISE);
        mutantNoise[key].behaviour =
          "This metric never moves between identical runs.";
        assert.equal(
          namesKey(mutant.noiseViolations(fixture, mutantNoise)),
          false,
          `${key} contradiction did not escape the absent behaviour check`,
        );
      },
    );

    await withMetricMutant(
      (source) =>
        replaceExactlyOnce(
          source,
          "  if (!figureMatches || !behaviourQuotes) {",
          "  if (!behaviourQuotes) {",
        ),
      async (mutant) => {
        const mutantNoise = clone(mutant.PERF_METRIC_NOISE);
        delete mutantNoise[key].claim.figure;
        assert.equal(
          namesKey(mutant.noiseViolations(fixture, mutantNoise)),
          false,
          `${key} missing figure did not escape the absent figure check`,
        );
      },
    );

    await withMetricMutant(
      (source) =>
        replaceExactlyOnce(
          source,
          "  if (!figureMatches || !behaviourQuotes) {",
          "  if (false && (!figureMatches || !behaviourQuotes)) {",
        ),
      async (mutant) => {
        const mutantNoise = clone(mutant.PERF_METRIC_NOISE);
        mutantNoise[key].behaviour =
          "This metric never moves between identical runs.";
        delete mutantNoise[key].claim.figure;
        assert.equal(
          namesKey(mutant.noiseViolations(fixture, mutantNoise)),
          false,
          `${key} contradiction survived the inertness mutation`,
        );
      },
    );
  });
}

test("noise tooth: a perturbed arm is named, and an inert mean check hides it", async () => {
  const perturbed = loadNoiseFixture();
  perturbed.derived.cleanMean += 0.1;
  assert.ok(
    noiseViolations(perturbed, PERF_METRIC_NOISE).some((entry) =>
      entry.includes("cleanMean"),
    ),
    "a perturbed fixture must be detected, or the check is restating itself",
  );
  await withMetricMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "    if (derived.cleanMean !== mean(clean)) {",
        "    if (false && derived.cleanMean !== mean(clean)) {",
      ),
    async (mutant) => {
      const violations = mutant.noiseViolations(
        perturbed,
        mutant.PERF_METRIC_NOISE,
      );
      assert.throws(
        () =>
          assert.ok(
            violations.some((entry) => entry.includes("cleanMean")),
            "the noise derivation stayed live after it was made unreachable",
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    },
  );
});

test("noise tooth: the ABSOLUTE cost swing is checked too, and an inert check hides it", async () => {
  const perturbed = loadNoiseFixture();
  perturbed.derived.msSwingRatio += 0.5;
  assert.ok(
    noiseViolations(perturbed, PERF_METRIC_NOISE).some((entry) =>
      entry.includes("msSwingRatio"),
    ),
    "a perturbed absolute-cost swing must be detected",
  );
  await withMetricMutant(
    (source) =>
      replaceExactlyOnce(
        source,
        "    if (derived.msSwingRatio !== msSwing) {",
        "    if (false && derived.msSwingRatio !== msSwing) {",
      ),
    async (mutant) => {
      const violations = mutant.noiseViolations(
        perturbed,
        mutant.PERF_METRIC_NOISE,
      );
      assert.throws(
        () =>
          assert.ok(
            violations.some((entry) => entry.includes("msSwingRatio")),
            "the absolute-cost check stayed live after it was made unreachable",
          ),
        (error) => error?.code === "ERR_ASSERTION",
      );
    },
  );
});

test("normalising the share is not by itself the cure: the absolute cost swings at least as far", () => {
  const fixture = loadNoiseFixture();
  // If only the SHARE were recorded, a reader could conclude the idle term is
  // the whole story. It is not: writeBuffer's own milliseconds move further
  // than its share does, and sampledTotalMs barely moves between runs.
  assert.ok(
    fixture.derived.msSwingRatio >= fixture.derived.spreadRatio,
    `ms swing ${fixture.derived.msSwingRatio} is below share swing ${fixture.derived.spreadRatio}`,
  );
  assert.deepEqual(noiseViolations(fixture, PERF_METRIC_NOISE), []);
});

test("the banked evidence exonerates the suspected lane: no texture write is published at all", () => {
  // Re-derived from the fixture, not restated. The Batch-717 signature is a
  // TEXTURE re-upload; the banked profile publishes no member of that
  // sub-family on either backend, so the elevated Signal A reading cannot be
  // that defect returning.
  const reports = baselineReports();
  for (const backend of ["webgpu", "webgl"]) {
    const published = reports.cpu[`${backend}TopSelfTime`].map(
      (row) => row.fn.split(" @ ", 1)[0],
    );
    for (const name of RESOURCE_WRITE_SUBFAMILIES.texture) {
      assert.equal(
        published.includes(name),
        false,
        `${backend} publishes texture-write ${name}`,
      );
    }
  }
  const fixture = loadNoiseFixture();
  assert.match(fixture.soleCarrier.consequence, /exonerated/);
  assert.equal(
    fixture.familySelfMsObservations.some(
      (entry) => entry.provenance === "ARTIFACT-BACKED",
    ),
    true,
    "the sole-carrier claim must rest on at least one artifact-backed observation",
  );
});

test("the noise fixture separates what is artifact-backed from what is only reported", () => {
  const fixture = loadNoiseFixture();
  const labels = new Set(Object.keys(fixture.provenanceLabels));
  const rows = [
    ...fixture.controlArms,
    ...fixture.artifactBackedArms,
    ...fixture.familySelfMsObservations,
  ];
  for (const row of rows) {
    assert.ok(
      labels.has(row.provenance),
      `unlabelled provenance on ${JSON.stringify(row).slice(0, 80)}`,
    );
  }
  // Every control arm is honestly marked unrecoverable, and the fixture says
  // why in its own text rather than leaving the reader to discover it.
  assert.equal(
    fixture.controlArms.every(
      (row) => row.provenance === "REPORTED-NOT-ARTIFACT-BACKED",
    ),
    true,
  );
  assert.ok(fixture.notRecovered.length >= 3);
});

test("the noise fixture is checked in and is never a live-run output path", () => {
  assert.equal(fs.existsSync(NOISE_FIXTURE_PATH), true);
  const fixture = path.resolve(NOISE_FIXTURE_PATH);
  const outputRoot = path.resolve(path.join(HERE, "output"));
  assert.equal(fixture.startsWith(`${outputRoot}${path.sep}`), false);
  for (const live of [...LIVE_WRITE_PATHS, ...Object.values(REPORT_PATHS)]) {
    assert.notEqual(path.resolve(live), fixture);
  }
  assert.deepEqual(baselineCollisions(), []);
  assert.throws(() => assertLiveWriteTarget(NOISE_FIXTURE_PATH), RangeError);
});

test("the metric derivation reads the fixture: perturb the banked reports and it speaks up", () => {
  // The counterpart of derivation tooth 3. If this stayed silent against a
  // perturbed baseline it would be asserting the bars equal themselves.
  const perturbed = baselineReports();
  const lane = perturbed.backend.lanes.find(
    (entry) => entry.name === "webgpu-solo",
  );
  lane.frameMs.p95 = lane.frameMs.p95 * 2;
  perturbed.cpu.webgpuTopSelfTime.push({
    fn: "writeTexture @ fixture:99",
    pct: 0.5,
    ms: 12,
  });
  const violations = metricBarViolations(
    perturbed,
    PERF_METRIC_BARS,
    RESOURCE_WRITE_SUBFAMILIES,
    RESOURCE_WRITE_FAMILY,
  );
  assert.ok(
    violations.some((entry) => entry.startsWith("M3:")),
    `no M3 violation: ${violations.join("; ")}`,
  );
  assert.ok(
    violations.some((entry) => entry.startsWith("M1:")),
    `no M1 violation: ${violations.join("; ")}`,
  );
});

test("the multi-metric gate composes AROUND the core and never edits its verdicts", () => {
  const reports = completeMetricReports();
  const core = adjudicate(clone(reports));
  const multi = multiMetric(clone(reports));
  assert.deepEqual(multi.signals.slice(0, core.signals.length), core.signals);
  assert.equal(multi.signals.length, core.signals.length + 9);
  assert.equal(
    signal(multi, "A-webgpu").bar,
    PERF_GATE_BARS.signalA.maxPctExclusive,
  );
  assert.equal(multi.bars, PERF_GATE_BARS);
  assert.equal(multi.metricBars, PERF_METRIC_BARS);
  assert.equal(multi.metricNoise, PERF_METRIC_NOISE);
  assert.ok(multi.metricVector);
});

test("a gate blind on any axis cannot reach PASS", () => {
  const complete = completeMetricReports();
  assert.equal(multiMetric(complete).status, "PASS");
  for (const blind of [
    (reports) => delete reports.cpu.webgpu.memory,
    (reports) => {
      // Blind means BOTH sources gone: the producer field AND the published
      // row. Deleting only the field leaves the censored top-list fallback,
      // which is still an observation.
      delete reports.cpu.webgpu.allocation;
      reports.cpu.webgpuTopSelfTime = reports.cpu.webgpuTopSelfTime.filter(
        (row) => !row.fn.startsWith("(garbage collector)"),
      );
    },
    (reports) => {
      for (const lane of reports.backend.lanes) delete lane.resourceWrites;
    },
    (reports) => {
      for (const lane of reports.backend.lanes) delete lane.frameMs;
    },
  ]) {
    const reports = completeMetricReports();
    blind(reports);
    const result = multiMetric(reports);
    assert.notEqual(result.status, "PASS");
    assert.equal(result.exitCode, exitCodeForS5Status(result.status));
  }
});

test("no metric axis is ever skipped: an empty evidence set is STRUCTURAL on every one", () => {
  const signals = metricSignalsFor({});
  assert.equal(signals.length, 9);
  for (const entry of signals) {
    assert.equal(entry.verdict, "STRUCTURAL", `${entry.id}: ${entry.reason}`);
    assert.ok(entry.reason.length > 0);
  }
  const result = multiMetric({});
  assert.equal(result.status, "STRUCTURAL");
  assert.ok(
    result.structuralReasons.some((entry) => entry.startsWith("M1-webgpu:")),
  );
});

test("a stale or unreadable report makes its metric axes STRUCTURAL, not PASS", () => {
  const reports = completeMetricReports();
  const signals = metricSignalsFor(reports, {
    reportProblem: (key) =>
      key === "cpu" ? "cpu report freshness was not proved" : null,
  });
  for (const id of ["M2-webgpu", "M4-webgpu", "M5-webgpu"]) {
    assert.equal(metricSignal(signals, id).verdict, "STRUCTURAL", id);
  }
  assert.equal(metricSignal(signals, "M1-webgpu").verdict, "PASS");
});

test("PERF_METRIC_BARS and PERF_METRIC_NOISE are frozen all the way down", () => {
  const walk = (value, trail) => {
    if (value === null || typeof value !== "object") {
      return;
    }
    assert.equal(Object.isFrozen(value), true, `${trail} is not frozen`);
    for (const [key, child] of Object.entries(value)) {
      walk(child, `${trail}.${key}`);
    }
  };
  walk(PERF_METRIC_BARS, "PERF_METRIC_BARS");
  walk(PERF_METRIC_NOISE, "PERF_METRIC_NOISE");
  walk(RESOURCE_WRITE_SUBFAMILIES, "RESOURCE_WRITE_SUBFAMILIES");
});

test("churnBound refuses a trial count it cannot bound", () => {
  assert.throws(() => churnBound(0, 3), RangeError);
  assert.throws(() => churnBound(90, 0), RangeError);
  assert.equal(churnBound(90, PERF_GATE_BARS.ruleOfThree.numerator), 3 / 90);
  // The bound is the run's own, so a shorter run is bounded less tightly.
  assert.ok(churnBound(30, 3) > churnBound(90, 3));
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
