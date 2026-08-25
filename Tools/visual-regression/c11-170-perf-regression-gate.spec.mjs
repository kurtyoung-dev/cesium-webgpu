// C11-170 gate policy tests. Pure Node: no browser, network, or probe process.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  adjudicatePerfRegressionGate,
  evaluateEvidenceFreshness,
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

function loadBankedReports() {
  const absent = Object.entries(REPORT_PATHS)
    .filter(([, file]) => !fs.existsSync(file))
    .map(([key, file]) => `${key}: ${file}`);
  if (absent.length > 0) {
    return { reports: null, absent };
  }
  return {
    reports: Object.fromEntries(
      Object.entries(REPORT_PATHS).map(([key, file]) => [key, readJson(file)]),
    ),
    absent: [],
  };
}

const BANKED = loadBankedReports();

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

test(
  "banked artifacts keep every A-F subject green while adjudicate-only is STRUCTURAL",
  {
    skip:
      BANKED.absent.length > 0
        ? `evidence absent: ${BANKED.absent.join("; ")}`
        : false,
  },
  () => {
    const result = adjudicate(clone(BANKED.reports), {
      mode: "adjudicate-only",
    });
    for (const entry of result.signals.filter((item) => item.id !== "G")) {
      assert.equal(entry.verdict, "PASS", `${entry.id}: ${entry.reason}`);
    }
    assert.equal(signal(result, "G").verdict, "NOT-PROVEN");
    assert.equal(result.status, "STRUCTURAL");
    assert.equal(result.exitCode, exitCodeForS5Status("STRUCTURAL"));
  },
);

test(
  "the banked derived bars remain bound to their source observations",
  {
    skip:
      BANKED.absent.length > 0
        ? `evidence absent: ${BANKED.absent.join("; ")}`
        : false,
  },
  () => {
    const result = adjudicate(clone(BANKED.reports), {
      mode: "adjudicate-only",
    });
    assert.equal(
      signal(result, "A-webgpu").bar,
      PERF_GATE_BARS.signalA.maxPctExclusive,
    );
    assert.equal(
      signal(result, "B").bar,
      ruleOfThreeBound(
        BANKED.reports.request.webgpu.laneA.pendingForegroundSeries.length,
      ),
    );
    assert.equal(
      signal(result, "E-1").bar,
      PERF_GATE_BARS.signalE.maxRatioInclusive,
    );
    assert.equal(
      result.recorded.coverageRatioMax,
      Math.max(
        ...BANKED.reports.frame.route.frameRecords.map(
          (record) => record.coverageRatio,
        ),
      ),
    );
  },
);

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

test(
  "A overbroad Buffer-suffix substring mutant reds the banked negative controls",
  {
    skip:
      BANKED.absent.length > 0
        ? `evidence absent: ${BANKED.absent.join("; ")}`
        : false,
  },
  async () => {
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
          reports: clone(BANKED.reports),
        });
        const controlRows = [
          "createCameraUniformBuffer",
          "createTileUniformBuffer",
        ].map((control) => {
          const row = BANKED.reports.cpu.webgpuTopSelfTime.find(
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
  },
);

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

test(
  "every frozen bar still equals the banked derivation it claims",
  {
    skip:
      BANKED.absent.length > 0
        ? `evidence absent: ${BANKED.absent.join("; ")}`
        : false,
  },
  () => {
    // A: the bar is the smallest pct the profile publishes — its visibility floor.
    assert.equal(
      PERF_GATE_BARS.signalA.maxPctExclusive,
      Math.min(...BANKED.reports.cpu.webgpuTopSelfTime.map((row) => row.pct)),
    );

    // A: the Batch-717 culprit must remain a family member by name.
    assert.ok(RESOURCE_WRITE_FAMILY.includes("copyExternalImageToTexture"));

    // B/C: at the banked trial count the bound must reject the third event and
    // tolerate the second — the Rule-of-Three shape, checked behaviourally.
    const n =
      BANKED.reports.request.webgpu.laneA.pendingForegroundSeries.length;
    const bound = ruleOfThreeBound(n);
    assert.equal(2 / n < bound, true);
    assert.equal(3 / n < bound, false);

    // E: the frozen observations must still be the banked measurements, and the
    // bar must still be max(subjects) scaled by the observed spread.
    const observed = PERF_GATE_BARS.signalE.observations.map(
      (entry) => entry.value,
    );
    assert.deepEqual(observed, [
      BANKED.reports.backend.verdicts.webgpu_over_webgl_render_ms_ratio,
      BANKED.reports.request.verdict.honest_render_ms.ratio,
      BANKED.reports.cpu.webgpu.medianRenderMs /
        BANKED.reports.cpu.webgl.medianRenderMs,
    ]);
    const subjects = PERF_GATE_BARS.signalE.observations
      .filter((entry) => entry.subject)
      .map((entry) => entry.value);
    assert.equal(
      PERF_GATE_BARS.signalE.maxRatioInclusive,
      Math.max(...subjects) * (Math.max(...observed) / Math.min(...observed)),
    );

    // D: the census bar is zero because the instrument is a census, not a sample.
    assert.equal(PERF_GATE_BARS.signalD.requiredWebglNonNull, 0);
  },
);

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
